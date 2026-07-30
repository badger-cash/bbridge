/*
 * Withdrawal postage co-signing (authorizer-spec.md §5).
 *
 * The service appends one stamp input and signs it. That signature is not a
 * convenience -- BridgeLock.release() verifies it against the contract's immutable
 * `authorizer` address, so no other party can supply postage and a refusal here
 * blocks the withdrawal outright. Two consequences run through this whole module:
 * every check must be one we are willing to block a real user on, and the checks
 * that guard collateral must never be skipped to unblock one.
 *
 * Step order is load-bearing and matches §5: validate, then claim, then sign. The
 * dedup claim must precede signing, because Section IV.6 identifies two concurrent
 * honest stamps for one declaration as sufficient for a second full release.
 */
import { Script, TX, bcrypto } from '@hansekontor/checkout-components'
import type { AuthorizerConfig } from '../config'
import { BroadcastRejectedError } from '../ports'
import type { Coin, EcashClient, Logger, SlpValidator, StampSource, Store } from '../ports'
import { assetIdForAddress, parseBurnOpReturn } from './burnOpReturn'
import type { BurnOpReturn } from './burnOpReturn'

export class PostageError extends Error {
  constructor(readonly code: PostageRefusal, message: string) {
    super(message)
  }
}

export type PostageRefusal =
  | 'MALFORMED'
  | 'WRONG_DEPLOYMENT'
  | 'BAD_BURN_INPUT'
  | 'BAD_BURN_OUTPUTS'
  | 'SCHNORR_SIGNATURE'
  | 'UNKNOWN_PREVOUT'
  | 'SLP_INVALID'
  | 'BELOW_MINIMUM'
  | 'ALREADY_STAMPED'
  | 'NO_STAMP_AVAILABLE'
  | 'REJECTED'

export interface PostageDeps {
  config: AuthorizerConfig
  ecash: EcashClient
  slp: SlpValidator
  stamps: StampSource
  store: Store
  logger: Logger
}

export interface PostageResult {
  /**
   * The broadcast transaction's id. Deliberately NOT the raw bytes: a stamped burn
   * that XEC would reject is as useful to an attacker as one it accepts, so the
   * completed transaction never leaves this service unbroadcast (SPEC.md IV.2.1).
   */
  txid: string
  burnQuantity: bigint
  stamp: Coin
}

/** SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_ANYONECANPAY, required on the burn input. */
const BURN_SIGHASH = 0x01 | 0x40 | 0x80

/** Bytes a P2PKH input adds: 32 txid + 4 index + 1 len + ~107 scriptSig + 4 sequence. */
const P2PKH_INPUT_SIZE = 148

/** The BURN OP_RETURN at index 0, plus one change output. See assertBurnOutputs. */
const MAX_BURN_OUTPUTS = 2

/**
 * Validates a user-submitted burn and returns it with the Authorizer's stamp
 * attached and signed.
 *
 * Throws PostageError on every refusal. A caller may report the code and message
 * back to the user: none of them leak anything the user did not already submit.
 */
export async function coSignPostage(deps: PostageDeps, rawTxHex: string): Promise<PostageResult> {
  const { config, ecash, slp, stamps, store, logger } = deps

  const tx = parseTransaction(rawTxHex)
  const burn = parseOutputZero(tx)

  assertMatchesDeployment(config, burn)
  assertBurnOutputs(tx)
  assertValidBurnInput(tx, burn)
  await assertBurnInputSpendable(ecash, tx)
  await assertSlpValid(slp, config, rawTxHex, burn)
  assertAboveMinimum(config, burn)

  // §5 step 7: claim BEFORE signing, atomically. A check after signing does not
  // close the honest-key double-stamp of Section IV.6.
  const outpoint = burnOutpoint(tx)
  const opReturnHex = tx.outputs[0].script.toRaw().toString('hex')
  if (!(await store.claimBurnDeclaration(outpoint, opReturnHex)))
    throw new PostageError(
      'ALREADY_STAMPED',
      `Burn declaration ${outpoint} has already been stamped; a second stamp would ` +
      'permit a second release of the same burn'
    )

  const stamp = await stamps.fetchStamp(requiredStampSats(config, tx))
  if (!stamp) {
    // Safe to release: nothing has been signed, so no stamp for this declaration can
    // exist anywhere and the requester may retry once the pool refills.
    await store.releaseBurnDeclaration(outpoint)
    throw new PostageError('NO_STAMP_AVAILABLE', 'No stamp coin large enough is available')
  }

  let stampedHex: string
  try {
    stampedHex = await stamps.appendAndSignStamp(rawTxHex, stamp)
  } catch (error) {
    // The coin goes back, but the claim does NOT: we cannot prove no signature was
    // produced, and a stamp that exists anywhere is enough for a release.
    await stamps.releaseStamp(stamp)
    throw error
  }

  // The service broadcasts; the stamped bytes are never handed back. SPEC.md IV.2.1 --
  // a stamp over a burn XEC would reject is enough for a full release under a
  // self-mined header, and consensus rejecting it at the node is what keeps it out of
  // an attacker's hands. This call owns its own cleanup.
  const txid = await broadcastOrRelease(deps, stampedHex, outpoint, stamp)

  logger.info('postage co-signed and broadcast', {
    outpoint,
    txid,
    burnQuantity: burn.burnQuantity.toString()
  })
  return { txid, burnQuantity: burn.burnQuantity, stamp }
}

/**
 * Broadcasts the stamped transaction, distinguishing a clean rejection from an
 * ambiguous failure (authorizer-spec.md §5.3).
 *
 * A *rejected* broadcast is the one case where releasing a claim after signing is
 * safe: XEC is Bitcoin-family, so a rejected transaction never enters a mempool and
 * reaches nobody -- consensus has established that these signed bytes can never be
 * mined, so the requester may retry.
 *
 * An *ambiguous* failure -- timeout, unreachable node -- must not release anything.
 * The transaction may have propagated, and a second stamp over a declaration that is
 * already live is exactly the honest-key double-release of Section IV.6.
 */
async function broadcastOrRelease(
  deps: PostageDeps,
  stampedHex: string,
  outpoint: string,
  stamp: Coin
): Promise<string> {
  try {
    return await deps.ecash.broadcast(stampedHex)
  } catch (error) {
    if (isRejection(error)) {
      await deps.stamps.releaseStamp(stamp)
      await deps.store.releaseBurnDeclaration(outpoint)
      throw new PostageError(
        'REJECTED',
        `XEC rejected this burn, so it can never be mined and nothing was exposed: ${String(error)}`
      )
    }

    // Neither the claim nor the stamp coin is released. The transaction may have
    // propagated, in which case the coin is genuinely spent and returning it to the
    // pool would hand it to a second postage as a double-spend.
    deps.logger.error('postage broadcast outcome unknown; holding claim and stamp', { outpoint })
    throw error
  }
}

/**
 * Only a definitive refusal permits the cleanup above, so the decision is delegated
 * to the EcashClient implementation rather than guessed at from an error string:
 * the host knows its node's API, and misclassifying an ambiguous failure as a
 * rejection releases a claim for a transaction that may be propagating.
 */
function isRejection(error: unknown): boolean {
  return error instanceof BroadcastRejectedError
}

function parseTransaction(rawTxHex: string): TX {
  try {
    return TX.fromRaw(Buffer.from(rawTxHex, 'hex'))
  } catch (error) {
    throw new PostageError('MALFORMED', `Not a parseable transaction: ${String(error)}`)
  }
}

function parseOutputZero(tx: TX): BurnOpReturn {
  if (tx.outputs.length === 0)
    throw new PostageError('MALFORMED', 'Transaction has no outputs')
  try {
    return parseBurnOpReturn(tx.outputs[0].script.toRaw())
  } catch (error) {
    throw new PostageError('MALFORMED', String((error as Error).message))
  }
}

/**
 * The BURN OP_RETURN, and at most one output beyond it.
 *
 * A burn destroys the tokens, so there is nothing for a second, third or hundredth
 * output to carry except leftover satoshis -- one change output covers that. The
 * limit exists because `release()` parses the whole raw transaction on chain:
 * `EcashTx.parse` walks every output and copies its script byte by byte, and the
 * sighash reconstruction serialises the output set a second time. Gas grows with the
 * transaction, and nothing in the contract bounds it, so a burner spending a
 * well-funded UTXO into a long output list can produce a burn that costs more to
 * release than it pays out, or cannot be released within a block at all -- with the
 * tokens already destroyed by the time they find out.
 *
 * `requiredStampSats` bounds the transaction's size too, since the stamp pays the
 * whole fee and `fetchStamp` refuses when no coin is large enough. That is a real
 * backstop but a poor primary check: it moves with the fee rate and the pool's
 * denomination, it is invisible to anyone reading this file, and it reports itself as
 * NO_STAMP_AVAILABLE -- which tells the requester to retry later, when in truth no
 * retry of those bytes can ever succeed.
 */
function assertBurnOutputs(tx: TX): void {
  if (tx.outputs.length > MAX_BURN_OUTPUTS)
    throw new PostageError(
      'BAD_BURN_OUTPUTS',
      `A burn may carry the BURN OP_RETURN and at most one change output, found ` +
      `${tx.outputs.length}. release() parses every output on chain, so a longer ` +
      'output list raises the gas to release this burn without changing what it pays.'
    )
}

/**
 * §5 step 2. Mirrors release()'s own checks so a mismatch is a clean refusal here
 * rather than a burn that confirms on XEC and then reverts on Ethereum -- which
 * would destroy the user's tokens with no release.
 */
function assertMatchesDeployment(config: AuthorizerConfig, burn: BurnOpReturn): void {
  if (!burn.tokenId.equals(config.xecTokenId))
    throw new PostageError(
      'WRONG_DEPLOYMENT',
      `Burn names token ${burn.tokenId.toString('hex')}, not this deployment's wrapped token`
    )

  if (!burn.assetId.equals(assetIdForAddress(config.lockContractAddress)))
    throw new PostageError(
      'WRONG_DEPLOYMENT',
      `Burn names asset ${burn.assetId.toString('hex')}, not this Lock Contract`
    )

  if (burn.chainId !== config.chainId)
    throw new PostageError(
      'WRONG_DEPLOYMENT',
      `Burn names chain ${burn.chainId}, not this deployment's chain ${config.chainId}`
    )
}

/**
 * §5 step 4. Input 0 must be a standard P2PKH spend signed
 * SIGHASH_ALL|FORKID|ANYONECANPAY, and the key that signed it must hash to the
 * OP_RETURN's attested recipient.
 *
 * That last check is what stops the recipient-substitution attack of Section IV.4:
 * the Authorizer's own postage signature commits to every output but never to input
 * 0's scriptSig, so without it an observer could swap input 0's signature for one
 * under their own key and redirect the release.
 */
function assertValidBurnInput(tx: TX, burn: BurnOpReturn): void {
  // Exactly one, not merely at least one. release() reads the burn from inputs[0] and
  // the postage from inputs[1] by index, so §5 step 8's "exactly one stamp input, at
  // index 1" only holds if the requester supplied exactly one of their own -- a second
  // token input pushes the stamp to index 2 and leaves _verifyStampInput checking the
  // requester's own input for the Authorizer's signature.
  //
  // Checked here, in the structural pass, rather than left to the StampSource's own
  // guard. That one runs after the dedup claim, and the claim is deliberately held
  // rather than released when appending fails, because a stamp that may exist anywhere
  // is enough for a release (Section IV.6). So a structurally impossible transaction
  // would mark its outpoint stamped for good and every corrected retry would come back
  // ALREADY_STAMPED -- recoverable only by moving the coin to a fresh outpoint, which
  // is a transaction the requester should not have to pay for to fix a 400.
  if (tx.inputs.length !== 1)
    throw new PostageError(
      'BAD_BURN_INPUT',
      `A burn must have exactly one input, found ${tx.inputs.length}. The Authorizer's ` +
      'stamp is appended at index 1, so token UTXOs have to be consolidated in a ' +
      'separate transaction before the burn is built.'
    )

  const code = tx.inputs[0].script.code
  if (code.length !== 2 || !code[0].data || !code[1].data)
    throw new PostageError(
      'BAD_BURN_INPUT',
      'Input 0 is not a standard P2PKH <signature> <pubkey> spend'
    )

  const [signature, pubkey] = [code[0].data, code[1].data]

  const sighashType = signature[signature.length - 1]
  if (sighashType !== BURN_SIGHASH)
    throw new PostageError(
      'BAD_BURN_INPUT',
      `Input 0 must be signed SIGHASH_ALL|FORKID|ANYONECANPAY (0x${BURN_SIGHASH.toString(16)}), ` +
      `got 0x${sighashType.toString(16)}. Without ANYONECANPAY the stamp cannot be appended.`
    )

  const signerHash160 = bcrypto.Hash160.digest(pubkey)
  if (!signerHash160.equals(burn.recipientHash160))
    throw new PostageError(
      'BAD_BURN_INPUT',
      `Input 0 was signed by ${signerHash160.toString('hex')} but the OP_RETURN attests ` +
      `${burn.recipientHash160.toString('hex')}; release() would reject this`
    )
}

/**
 * Verifies input 0 against its real previous output.
 *
 * BridgeLock.release() cannot do this -- Section IV.4 is explicit that "this contract
 * has no way to look up input 0's real previous output, so on its own it cannot verify
 * that key is actually the burned coin's real owner". The Authorizer can, using the
 * same indexer §5.2 already requires, so the check belongs here.
 *
 * Two things are established:
 *
 *   1. The signing key genuinely owns the burned coin -- the previous output must be
 *      a P2PKH to that key's hash160, not merely a key whose hash matches the
 *      OP_RETURN's self-declared recipient.
 *   2. The signature actually verifies, using the previous output's value. Without
 *      this, a burn with a malformed signature would be stamped, fail to confirm on
 *      XEC, and -- because the dedup claim survives -- leave that UTXO permanently
 *      unwithdrawable. Running before the claim is what keeps a bad signature a
 *      retryable mistake rather than a bricked coin.
 *
 * Schnorr is rejected outright. XEC consensus accepts it, but Ethereum's ecrecover is
 * ECDSA-only and release() parses DER, so a Schnorr-signed burn would confirm on XEC
 * and then be unreleasable -- destroying the user's tokens with no payout.
 */
async function assertBurnInputSpendable(ecash: EcashClient, tx: TX): Promise<void> {
  const [signature, pubkey] = [tx.inputs[0].script.code[0].data!, tx.inputs[0].script.code[1].data!]

  // A bare signature is DER plus a trailing sighash byte; Schnorr is a flat 64.
  if (signature.length - 1 === 64)
    throw new PostageError(
      'SCHNORR_SIGNATURE',
      'Input 0 is Schnorr-signed. release() verifies via ecrecover, which is ECDSA-only, ' +
      'so this burn would confirm on XEC and then be permanently unreleasable. Re-sign with ECDSA.'
    )

  const prevout = tx.inputs[0].prevout
  const previous = await ecash.getOutput(prevout.txid(), prevout.index)
  if (!previous)
    throw new PostageError(
      'UNKNOWN_PREVOUT',
      `Input 0 spends ${prevout.txid()}:${prevout.index}, which the indexer does not know. ` +
      'Refusing rather than assuming -- this may be indexer lag, so it is retryable.'
    )

  const previousScript = Script.fromRaw(Buffer.from(previous.script, 'hex'))
  const owner = previousScript.isPubkeyhash() ? previousScript.getPubkeyhash() : null
  if (!owner || !owner.equals(bcrypto.Hash160.digest(pubkey)))
    throw new PostageError(
      'BAD_BURN_INPUT',
      'Input 0 is not signed by the owner of the coin it spends'
    )

  if (!tx.checksig(0, previousScript, previous.value, signature, pubkey))
    throw new PostageError('BAD_BURN_INPUT', 'Input 0 signature does not verify')
}

/**
 * §5.2, and the check nothing else in the system performs.
 *
 * release() pays out the quantity the OP_RETURN *declares* and has no way to verify
 * it. SLP is an overlay protocol with no consensus validation, so a transaction
 * declaring a billion tokens while spending one confirms on XEC perfectly normally.
 * Fails closed: any verdict short of an affirmative "valid" is a refusal.
 */
async function assertSlpValid(
  slp: SlpValidator,
  config: AuthorizerConfig,
  rawTxHex: string,
  burn: BurnOpReturn
): Promise<void> {
  const verdict = await slp.validateBurn(rawTxHex, config.xecTokenId)

  if (!verdict.valid)
    throw new PostageError(
      'SLP_INVALID',
      `SLP validation refused this burn: ${verdict.reason ?? 'no reason given'}`
    )

  if (verdict.burnedQuantity < burn.burnQuantity)
    throw new PostageError(
      'SLP_INVALID',
      `Burn declares ${burn.burnQuantity} but only ${verdict.burnedQuantity} is genuinely ` +
      'being burned; release() would pay out the declared amount'
    )
}

/** §5.1. A floor on the declaration, not on any single UTXO -- dust consolidates. */
function assertAboveMinimum(config: AuthorizerConfig, burn: BurnOpReturn): void {
  if (burn.burnQuantity < config.minBurnAmount)
    throw new PostageError(
      'BELOW_MINIMUM',
      `Burn of ${burn.burnQuantity} is below the ${config.minBurnAmount} minimum. ` +
      'Consolidate token UTXOs into a single larger burn.'
    )
}

/** Keyed on input 0's outpoint, matching release()'s own burnUtxoConsumedBy. */
function burnOutpoint(tx: TX): string {
  return `${tx.inputs[0].prevout.txid()}:${tx.inputs[0].prevout.index}`
}

/**
 * Sats the stamp must carry.
 *
 * The stamp pays the whole fee by itself and no change output may be added: the
 * user's SIGHASH_ALL signature commits to the output set, so appending change would
 * invalidate it. Any excess over the fee is therefore donated to miners, which is
 * why StampSource is asked for a coin of at least this size rather than exactly it.
 */
export function requiredStampSats(config: AuthorizerConfig, tx: TX): number {
  const finalSize = tx.getSize() + P2PKH_INPUT_SIZE
  return Math.ceil((finalSize * config.feeRateSatsPerKb) / 1000)
}
