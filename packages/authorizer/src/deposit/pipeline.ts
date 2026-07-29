/*
 * The deposit pipeline (authorizer-spec.md §4).
 *
 * Each state gets its own step function, and `tick` runs them in a deliberate order.
 * Splitting them this way is not decoration: crash recovery is defined per edge
 * (§4.3), so each edge has to be independently reachable and independently testable
 * with a record parked in the state before it.
 *
 * The one rule that outranks everything else here: the funding transaction is
 * broadcast in exactly one place, `advanceConfirmedFinal`. Nothing else in this file
 * calls `ecash.broadcast` on it, and `assertTransition` will throw if a future edit
 * tries to reach FUNDING_BROADCAST by another route (SPEC.md Section III.7).
 */
import type { AuthorizerConfig } from '../config'
import type {
  BridgeEvent,
  DepositRecord,
  EcashClient,
  EthereumReader,
  EthereumWriter,
  Logger,
  Minter,
  ReserveWallet,
  Signer,
  Store
} from '../ports'
import { assertTransition, refundForeclosed } from '../states'
import type { DepositState } from '../states'
import { buildAuthorization, signAuthorization, txidToInternal } from './authorization'
import { deriveVaultAddress, vaultOutputValue } from './vault'

export interface DepositPipelineDeps {
  config: AuthorizerConfig
  /** Sats to leave in the vault output for the mint's own fee. See vaultOutputValue. */
  mintFeeSats: number
  eth: EthereumReader
  ethWriter: EthereumWriter
  ecash: EcashClient
  reserve: ReserveWallet
  signer: Signer
  store: Store
  minter?: Minter
  logger: Logger
}

/** Persists a record into a new state, refusing any edge the machine does not define. */
async function transition(
  deps: DepositPipelineDeps,
  record: DepositRecord,
  to: DepositState,
  fields: Partial<DepositRecord> = {}
): Promise<DepositRecord> {
  assertTransition(record.state, to)
  const next: DepositRecord = { ...record, ...fields, state: to }
  await deps.store.saveDeposit(next)
  deps.logger.info('deposit transition', { depositId: record.depositId, from: record.state, to })
  return next
}

/* ------------------------------------------------------------------- scanning */

/**
 * Applies one Ethereum log to stored state.
 *
 * Refund signals only set a flag; they never advance or abort a deposit by
 * themselves. What that flag means depends on how far the deposit has travelled, and
 * that judgement lives in the step functions (§4.4).
 */
export async function applyEvent(deps: DepositPipelineDeps, event: BridgeEvent): Promise<void> {
  const { store, logger } = deps
  const existing = await store.getDeposit(event.depositId)

  switch (event.type) {
    case 'DepositLocked': {
      if (existing)
        return
      await store.saveDeposit({
        depositId: event.depositId,
        state: 'OBSERVED',
        lockedAtBlock: event.blockNumber,
        depositor: event.depositor,
        netAmount: event.netAmount,
        xecRecipient: event.xecRecipient,
        refundRequested: false
      })
      logger.info('deposit observed', { depositId: event.depositId })
      return
    }

    case 'RefundRequested':
      if (existing && !refundForeclosed(existing.state))
        await store.saveDeposit({ ...existing, refundRequested: true })
      return

    case 'RefundRequestCancelled':
      if (existing && !refundForeclosed(existing.state))
        await store.saveDeposit({ ...existing, refundRequested: false })
      return

    case 'DepositRefunded': {
      if (!existing)
        return
      // Reaching this while the deposit is already past CONFIRMED_FINAL would mean
      // the contract let a confirmed deposit refund, which it does not. Treat the
      // contradiction as something a human needs to look at rather than acting on it.
      if (refundForeclosed(existing.state)) {
        await transition(deps, existing, 'HALTED')
        logger.error('refund observed for a deposit past the point of no return', {
          depositId: event.depositId,
          state: existing.state
        })
        return
      }
      await store.releaseCoin(event.depositId)
      await transition(deps, existing, 'ABANDONED_REFUNDED')
      return
    }

    case 'DepositConfirmed':
      if (existing && existing.state === 'CONFIRM_SENT')
        await store.saveDeposit({ ...existing, confirmedAtBlock: event.blockNumber })
      return
  }
}

/** Scans new logs up to the head and advances the durable cursor. */
export async function scan(deps: DepositPipelineDeps): Promise<number> {
  const { eth, store } = deps
  const head = await eth.getBlockNumber()
  const cursor = await store.getScanCursor()
  if (head <= cursor)
    return cursor

  for (const event of await eth.getLogs(cursor + 1, head))
    await applyEvent(deps, event)

  await store.setScanCursor(head)
  return head
}

/* ---------------------------------------------------------------- state steps */

/** OBSERVED -> DEPTH_MET, once the contract's confirmation-depth threshold is met. */
export async function advanceObserved(deps: DepositPipelineDeps, record: DepositRecord, head: number): Promise<void> {
  if (record.refundRequested)
    return
  if (head - record.lockedAtBlock < deps.config.confirmationDepth)
    return
  await transition(deps, record, 'DEPTH_MET')
}

/**
 * DEPTH_MET -> FUNDING_PREPARED.
 *
 * Reserves a coin exclusively, builds the funding transaction, and persists its raw
 * bytes together with the reservation. The transaction is NOT broadcast; it will not
 * be until its confirmation is final.
 */
export async function advanceDepthMet(deps: DepositPipelineDeps, record: DepositRecord): Promise<void> {
  const { store, reserve, signer, logger } = deps

  if (record.refundRequested)
    return

  const coin = await store.reserveCoin(record.depositId)
  if (!coin) {
    // Not an error: deposits wait, and none already in flight is endangered (§8).
    logger.warn('reserve pool exhausted; deposit waiting', { depositId: record.depositId })
    return
  }

  try {
    const vaultAddress = deriveVaultAddress(await signer.getPublicKey())
    const funding = await reserve.buildVaultFundingTx({
      reserveCoin: coin,
      vaultAddress,
      vaultValue: vaultOutputValue(deps.mintFeeSats)
    })

    await transition(deps, record, 'FUNDING_PREPARED', {
      reserveCoin: coin,
      fundingTxRaw: funding.rawTxHex,
      fundingTxid: funding.txid,
      vaultOutputIndex: funding.vaultOutputIndex
    })
  } catch (error) {
    // The coin must not stay reserved against a deposit that never got a transaction
    // built, or the pool leaks a coin per failure until it starves.
    await store.releaseCoin(record.depositId)
    throw error
  }
}

/** FUNDING_PREPARED -> AUTHORIZED. Signs the message binding that exact funding txid. */
export async function advanceFundingPrepared(deps: DepositPipelineDeps, record: DepositRecord): Promise<void> {
  if (record.refundRequested)
    return

  const signed = await signAuthorization(deps.config, deps.signer, {
    depositId: record.depositId,
    fundingTxid: record.fundingTxid!,
    vaultOutputIndex: record.vaultOutputIndex!,
    netAmount: record.netAmount,
    xecRecipient: record.xecRecipient
  })

  await transition(deps, record, 'AUTHORIZED', {
    signature: signed.signature,
    xecAmount: signed.xecAmount
  })
}

/**
 * AUTHORIZED -> CONFIRM_SENT.
 *
 * The nonce is reserved and persisted before the send, so a crash in the window
 * between sending and recording the hash is recoverable: the restart resolves what
 * that nonce did rather than resubmitting blind (§4.3).
 */
export async function advanceAuthorized(deps: DepositPipelineDeps, record: DepositRecord): Promise<void> {
  const { ethWriter, store } = deps

  const nonce = record.confirmNonce ?? (await ethWriter.reserveNonce())
  if (record.confirmNonce === undefined)
    await store.saveDeposit({ ...record, confirmNonce: nonce })

  const txHash = await ethWriter.sendConfirmDeposit({
    nonce,
    depositId: record.depositId,
    utxoTxid: '0x' + txidToInternal(record.fundingTxid!).toString('hex'),
    utxoIndex: record.vaultOutputIndex!,
    v: record.signature!.v,
    r: record.signature!.r,
    s: record.signature!.s
  })

  await transition(deps, { ...record, confirmNonce: nonce }, 'CONFIRM_SENT', { confirmTxHash: txHash })
}

/**
 * CONFIRM_SENT -> CONFIRMED_FINAL, or aborts if refund won the race.
 *
 * Resolves the reserved nonce rather than resubmitting, then requires the
 * confirmation to sit at the service's own finality depth before advancing. That
 * depth gates the irreversible broadcast in the next step, so it is checked here
 * and nowhere else.
 */
export async function advanceConfirmSent(
  deps: DepositPipelineDeps,
  record: DepositRecord,
  head: number
): Promise<void> {
  const { eth, ethWriter, config, logger } = deps

  const onChain = await eth.getDeposit(record.depositId)
  if (onChain.status === 'refunded') {
    await deps.store.releaseCoin(record.depositId)
    await transition(deps, record, 'ABANDONED_REFUNDED')
    return
  }

  const sent = record.confirmNonce === undefined ? null : await ethWriter.getTransactionByNonce(record.confirmNonce)

  if (!sent) {
    // The nonce never landed a transaction: the crash happened before the send took
    // effect. Go back and send at that same nonce rather than reserving a new one.
    await transition(deps, record, 'AUTHORIZED')
    return
  }

  if (sent.blockNumber === null)
    return // still pending; confirmGasPolicy decides when to bump (§8.1)

  if (onChain.status !== 'confirmed') {
    // Mined, but the deposit is not confirmed and not refunded -- the call reverted
    // for a reason this pipeline did not anticipate. Do not retry into it blindly.
    await transition(deps, record, 'HALTED')
    logger.error('confirmation mined without confirming the deposit', {
      depositId: record.depositId,
      txHash: sent.txHash,
      status: onChain.status
    })
    return
  }

  if (head - sent.blockNumber < config.finalityDepth)
    return

  await transition(deps, record, 'CONFIRMED_FINAL', { confirmedAtBlock: sent.blockNumber })
}

/**
 * CONFIRMED_FINAL -> FUNDING_BROADCAST. The only place the funding transaction is
 * ever broadcast.
 *
 * Failure here is unrecoverable in a way no other step is: refund() is already
 * foreclosed and the published authorization names a vault UTXO that only these
 * exact bytes can create. So this retries rather than aborting, and a record whose
 * bytes are missing halts loudly instead of being dropped.
 */
export async function advanceConfirmedFinal(deps: DepositPipelineDeps, record: DepositRecord): Promise<void> {
  const { ecash, logger } = deps

  if (!record.fundingTxRaw) {
    await transition(deps, record, 'HALTED')
    logger.error(
      'CONFIRMED_FINAL with no funding transaction bytes: the deposit can neither mint nor refund',
      { depositId: record.depositId }
    )
    return
  }

  await ecash.broadcast(record.fundingTxRaw)
  await transition(deps, record, 'FUNDING_BROADCAST')
}

/**
 * FUNDING_BROADCAST -> MINTED. Optional convenience minting (§4.5).
 *
 * Best-effort by contract: the mint is permissionless, so a failure here costs
 * nothing that the recipient's own client cannot do instead. It must never block the
 * pipeline, which is why the error is logged rather than thrown.
 */
export async function advanceFundingBroadcast(deps: DepositPipelineDeps, record: DepositRecord): Promise<void> {
  const { minter, config, ecash, logger } = deps
  if (!config.convenienceMinting || !minter)
    return

  try {
    // Rebuilt rather than stored: every input is already persisted on the record, and
    // the covenant verifies this message against the signature it was produced for,
    // so a rebuild that drifted would fail loudly at the mint rather than mislead.
    const { message } = buildAuthorization(config, {
      depositId: record.depositId,
      fundingTxid: record.fundingTxid!,
      vaultOutputIndex: record.vaultOutputIndex!,
      netAmount: record.netAmount,
      xecRecipient: record.xecRecipient
    })

    const rawTxHex = await minter.buildAndSignMint({
      vaultCoin: {
        txid: record.fundingTxid!,
        index: record.vaultOutputIndex!,
        value: vaultOutputValue(deps.mintFeeSats),
        script: deriveVaultAddress(await deps.signer.getPublicKey())
      },
      authorizationMessage: message,
      authorizerSignature: record.signature!
    })
    await ecash.broadcast(rawTxHex)
    await transition(deps, record, 'MINTED')
  } catch (error) {
    logger.warn('convenience mint failed; recipient can still mint', {
      depositId: record.depositId,
      error: String(error)
    })
  }
}

/* ----------------------------------------------------------------------- tick */

/**
 * One pass over every actionable deposit.
 *
 * CONFIRMED_FINAL is drained first, before scanning or anything else: §4.3 requires a
 * restart to re-attempt that broadcast ahead of other work, because it is the only
 * edge whose failure cannot be undone.
 */
export async function tick(deps: DepositPipelineDeps): Promise<void> {
  for (const record of await deps.store.findDepositsByState(['CONFIRMED_FINAL']))
    await advanceConfirmedFinal(deps, record)

  const head = await scan(deps)

  for (const record of await deps.store.findDepositsByState(['OBSERVED']))
    await advanceObserved(deps, record, head)

  for (const record of await deps.store.findDepositsByState(['DEPTH_MET']))
    await advanceDepthMet(deps, record)

  for (const record of await deps.store.findDepositsByState(['FUNDING_PREPARED']))
    await advanceFundingPrepared(deps, record)

  for (const record of await deps.store.findDepositsByState(['AUTHORIZED']))
    await advanceAuthorized(deps, record)

  for (const record of await deps.store.findDepositsByState(['CONFIRM_SENT']))
    await advanceConfirmSent(deps, record, head)

  for (const record of await deps.store.findDepositsByState(['CONFIRMED_FINAL']))
    await advanceConfirmedFinal(deps, record)

  for (const record of await deps.store.findDepositsByState(['FUNDING_BROADCAST']))
    await advanceFundingBroadcast(deps, record)
}
