/*
 * Ports the host application supplies (authorizer-spec.md §3).
 *
 * The service core is transport-free and storage-free: no HTTP, no database, no
 * key material, no chain client. A host (lotto-api, or any other) implements
 * these against whatever it already runs, and the quarantine state machine stays
 * testable with plain fakes.
 *
 * Hex conventions, fixed once here because getting them wrong is silent:
 *   - Ethereum values (depositId, tx hashes, addresses, r/s) are 0x-prefixed hex.
 *   - eCash txids are the conventional big-endian display form, no 0x prefix.
 *   - hash160s are 40 hex chars, no 0x prefix.
 * Buffers are used where the value is fed to a hasher or a script, strings where
 * it is only ever an identifier.
 */
import type { DepositState } from './states'

/* ------------------------------------------------------------------ Ethereum */

export interface DepositLockedEvent {
  type: 'DepositLocked'
  depositId: string
  depositor: string
  netAmount: bigint
  /** HASH160 of the recipient's XEC public key, 40 hex chars. */
  xecRecipient: string
  blockNumber: number
}

export interface RefundRequestedEvent {
  type: 'RefundRequested'
  depositId: string
  requestedAtBlock: number
  blockNumber: number
}

export interface RefundRequestCancelledEvent {
  type: 'RefundRequestCancelled'
  depositId: string
  blockNumber: number
}

export interface DepositRefundedEvent {
  type: 'DepositRefunded'
  depositId: string
  blockNumber: number
}

export interface DepositConfirmedEvent {
  type: 'DepositConfirmed'
  depositId: string
  utxoTxid: string
  utxoIndex: number
  blockNumber: number
}

export type BridgeEvent =
  | DepositLockedEvent
  | RefundRequestedEvent
  | RefundRequestCancelledEvent
  | DepositRefundedEvent
  | DepositConfirmedEvent

export type OnChainDepositStatus = 'pending' | 'confirmed' | 'refunded' | 'unknown'

export interface OnChainDeposit {
  depositor: string
  netAmount: bigint
  xecRecipient: string
  status: OnChainDepositStatus
}

export interface EthereumReader {
  getBlockNumber(): Promise<number>
  /** Inclusive range. Ordering within a block must match log index. */
  getLogs(fromBlock: number, toBlock: number): Promise<BridgeEvent[]>
  getDeposit(depositId: string): Promise<OnChainDeposit>
  getTransactionReceipt(txHash: string): Promise<{ blockNumber: number; status: number } | null>
  /**
   * Collateral the Lock Contract currently holds, in the Ethereum token's own
   * decimals (authorizer-spec.md §6.1).
   *
   * Must be the live balance, not a cumulative deposit total: a cumulative figure
   * never decreases while withdrawals do reduce supply, so headroom computed from it
   * would grow every time a user exits.
   */
  getLockedCollateral(): Promise<bigint>

  /**
   * Current fee conditions, wei (authorizer-spec.md §9.1).
   *
   * `baseFeePerGas` must come from the chain head rather than from an average: it is
   * compounded forward to price a confirmation against worst-case growth, and a
   * backward-looking figure would price against conditions that have already passed.
   */
  getFeeData(): Promise<{ baseFeePerGas: bigint; maxPriorityFeePerGas: bigint }>
}

export interface EthereumWriter {
  /**
   * Reserves the next Ethereum nonce for a confirmation, without sending anything.
   *
   * Exists because the transaction hash cannot be persisted before the transaction
   * is sent, leaving an unavoidable crash window between send and persist. The nonce
   * is knowable beforehand, so persisting it first lets a restart resolve what that
   * nonce actually did instead of resubmitting blind (authorizer-spec.md §4.3).
   */
  reserveNonce(): Promise<number>

  /**
   * Submits confirmDeposit() at the given nonce. Resolves with the transaction hash
   * once accepted by the node -- NOT once mined.
   *
   * Re-sending at the same nonce is how a stalled confirmation is fee-bumped. The
   * signature is reused verbatim: it covers the authorization message, never the
   * Ethereum transaction carrying it, so gas and nonce are outside the signed
   * content. Never re-sign to bump (authorizer-spec.md §9.1).
   *
   * The fees are supplied rather than left to the implementation, and must be sent as
   * given. A replacement has to exceed the pending transaction's fees by the node's
   * price-bump margin on both fields; an implementation that substituted its own
   * estimate would decide that margin by accident and the replacement would be
   * refused.
   */
  sendConfirmDeposit(args: {
    nonce: number
    depositId: string
    utxoTxid: string
    utxoIndex: number
    v: number
    r: string
    s: string
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
  }): Promise<string>

  /** Resolves what a reserved nonce did, for crash recovery from CONFIRM_SENT. */
  getTransactionByNonce(nonce: number): Promise<{ txHash: string; blockNumber: number | null } | null>
}

/* ---------------------------------------------------------------------- eCash */

export interface Coin {
  txid: string
  index: number
  value: number
  script: string
}

/**
 * Thrown by EcashClient.broadcast when the node *definitively refused* the
 * transaction, as distinct from the outcome being unknown.
 *
 * The distinction decides whether it is safe to release a dedup claim after signing
 * (authorizer-spec.md §5.3), so an implementation must only throw this when the
 * refusal is certain. Against a bcash node, `POST /broadcast` maps as follows:
 *
 *   - An HTTP error body (bcurl surfaces it as an Error carrying `type`/`code`,
 *     typically type 'VerifyError') means `sendTX(tx, false)` re-threw and the
 *     transaction was NOT relayed. Definitive refusal -- throw this.
 *   - A connection failure, timeout, or any unrecognised error is ambiguous. Throw
 *     something else, so the caller holds the claim and the stamp coin.
 *
 * CAUTION: an HTTP 200 does not prove acceptance into the mempool. bcash's
 * `sendTX` treats a transaction whose inputs are missing as an *orphan*: it relays
 * it and returns success (`lib/node/fullnode.js`). That is why the burn's previous
 * output must be checked, via getOutput, BEFORE signing -- a coin that is spent or
 * nonexistent would otherwise be orphaned, relayed, and thereby exposed.
 */
export class BroadcastRejectedError extends Error {}

export interface EcashClient {
  getUtxos(address: string): Promise<Coin[]>
  /**
   * A specific previous output, or null if unknown.
   *
   * Needed to verify a withdrawal burn's input 0 (authorizer-spec.md §5): the value
   * is required to reconstruct the BIP143 sighash, and the script is what proves the
   * signing key actually owns the coin. BridgeLock.release() cannot do either --
   * Section IV.4 says so outright, "this contract has no way to look up input 0's
   * real previous output" -- so it delegates the check here.
   *
   * MUST return null for a SPENT output, not merely a nonexistent one. This is what
   * stops a burn whose coin is already gone from being stamped, orphaned by the node,
   * and relayed anyway (see BroadcastRejectedError). bcash's `GET /coin/:hash/:index`
   * has exactly these semantics: `getCoin` consults the mempool, then
   * `mempool.isSpent`, then the chain, and 404s if the coin is spent in either.
   */
  getOutput(txid: string, index: number): Promise<{ value: number; script: string } | null>
  /** Must be idempotent: re-broadcasting an already-accepted tx resolves, not throws. */
  broadcast(rawTxHex: string): Promise<string>
  getTx(txid: string): Promise<{ confirmations: number } | null>
}

/* --------------------------------------------------------------- ReserveWallet */

export interface FundingTx {
  /**
   * The signed transaction's raw bytes. Persisted verbatim and never rebuilt: the
   * authorization signature binds the txid, which is the hash of exactly these bytes
   * (authorizer-spec.md §4.3).
   */
  rawTxHex: string
  /** Conventional big-endian display form. */
  txid: string
  vaultOutputIndex: number
}

/**
 * Spends one reserve coin into one vault output (authorizer-spec.md §4.1).
 *
 * Behind a port because it needs the reserve key. The transaction it returns is
 * NOT broadcast -- the caller persists it and holds it until the corresponding
 * confirmation reaches finality. An implementation that broadcasts here breaks
 * quarantine (SPEC.md Section III.7).
 */
export interface ReserveWallet {
  buildVaultFundingTx(args: {
    reserveCoin: Coin
    vaultAddress: string
    vaultValue: number
  }): Promise<FundingTx>
}

/* --------------------------------------------------------------- SlpValidator */

export interface BurnValidity {
  /**
   * True only if every token input resolves to a genuine SLP UTXO of the requested
   * token, each input's lineage is SLP-valid back to GENESIS, and the summed input
   * quantity covers the declared burn. Anything ambiguous is false.
   */
  valid: boolean
  /** Summed token quantity genuinely being burned, in XEC-side base units. */
  burnedQuantity: bigint
  /** Why validation failed, for logging. Never used to soften a false verdict. */
  reason?: string
}

/**
 * SLP validity oracle (authorizer-spec.md §5.2). Part of the trusted computing base.
 *
 * SLP is an overlay protocol -- miners do not validate it, so a transaction declaring
 * a billion tokens while spending one confirms on XEC perfectly normally. And
 * BridgeLock.release() pays out the quantity the OP_RETURN *declares*, having no way
 * to check it. The Authorizer's postage signature is the only thing in the entire
 * system that attests a burn is real.
 *
 * An implementation MUST fail closed: unreachable, syncing, lagging the chain tip, or
 * ambiguous all mean valid=false. Refusing a good burn delays one user; stamping a
 * bad one releases collateral that was never burned, and nothing on-chain catches it.
 *
 * A bcash node with `slpindex` enabled satisfies this natively, and does so in a shape
 * that makes failing closed the default rather than a discipline: the indexer writes
 * records only for transactions it has already found valid
 * (`lib/indexer/slpindexer.js` -- `if (toAdd[key].isValid)` gates every write), and
 * validity is transitive, since a parent's amount counts toward the input total only
 * when `parent.isValid`, with GENESIS automatically valid. A record's *presence* is
 * therefore proof of valid lineage back to GENESIS, and absence -- for any reason,
 * including an unsynced index -- reads as invalid.
 *
 * Practical mapping: query each token input via `GET /coin/:hash/:index?slp=true` and
 * sum the amounts, then compare against the declared burn quantity.
 *
 * `slp=true` ANNOTATES, it does not filter. `addSlpInfoToCoin` returns the coin
 * whether or not it is SLP, attaching `coin.slp` only when the index holds a record
 * for that exact vout -- so an explicit check is required and three outcomes must be
 * distinguished:
 *
 *   - 404               -> spent or nonexistent. Refuse.
 *   - coin, no `slp`    -> unspent, but not a valid SLP output of any token. Refuse.
 *   - coin with `slp`   -> lineage-valid. Still verify tokenId and version match this
 *                          deployment's wrapped token before counting the amount.
 *
 * Treating a returned coin as SLP-valid because the query asked for SLP data would
 * accept ordinary XEC as though it were wrapped tokens.
 *
 * A lagging index causes false refusals, never false acceptances -- but the host
 * should still compare `slpindex.height` (exposed on `GET /`) against the chain tip,
 * since silently refusing every withdrawal is its own kind of outage.
 */
export interface SlpValidator {
  validateBurn(rawTxHex: string, tokenId: Buffer): Promise<BurnValidity>
  /**
   * Circulating supply of the wrapped token, in XEC-side base units, net of every
   * burn -- withdrawal burns and raw burns alike (authorizer-spec.md §6.1).
   */
  getCirculatingSupply(tokenId: Buffer): Promise<bigint>
}

/* --------------------------------------------------------------------- Signer */

export interface EcdsaSignature {
  v: number
  r: string
  s: string
}

/**
 * Signing only. Never sees a transaction, never broadcasts, holds no funds --
 * which is what allows a deployment to put this behind a KMS or HSM.
 */
export interface Signer {
  /** Compressed secp256k1 public key, 33 bytes. The covenant is parameterized by it. */
  getPublicKey(): Promise<Buffer>
  /**
   * Signs a 32-byte digest.
   *
   * MUST return a canonical low-S signature. BridgeLock.confirmDeposit() rejects
   * s > secp256k1n/2 with MalleableSignature, and eCash consensus mandates
   * strict-DER low-S for the covenant's OP_CHECKDATASIGVERIFY. A high-S signature
   * satisfies neither, and per SPEC.md Section III.3 can strand a deposit
   * permanently rather than merely failing.
   */
  signDigest(digest: Buffer): Promise<EcdsaSignature>
}

/* ---------------------------------------------------------------------- Store */

export interface DepositRecord {
  depositId: string
  state: DepositState
  lockedAtBlock: number
  depositor: string
  netAmount: bigint
  xecRecipient: string
  /** Set by RefundRequested, cleared by RefundRequestCancelled (authorizer-spec.md §4.4). */
  refundRequested: boolean

  /* Set on entry to FUNDING_PREPARED, atomically, together with the reservation. */
  reserveCoin?: Coin
  /**
   * The funding transaction's raw serialized bytes, verbatim.
   *
   * Persisted rather than rebuilt because the authorization signature binds
   * utxoTxid, and a txid is the hash of exactly these bytes. A rebuild differing by
   * so much as DER padding yields a different txid and an authorization nothing can
   * satisfy (authorizer-spec.md §4.3).
   */
  fundingTxRaw?: string
  fundingTxid?: string
  vaultOutputIndex?: number
  xecAmount?: bigint

  /* Set on entry to AUTHORIZED. */
  signature?: EcdsaSignature

  /* Set on entry to CONFIRM_SENT / CONFIRMED_FINAL. */
  /**
   * Reserved and persisted BEFORE the confirmation is sent.
   *
   * The transaction hash does not exist until after sending, leaving a crash window
   * a restart cannot otherwise interpret. The nonce is knowable in advance, so it is
   * what recovery resolves against (authorizer-spec.md §4.3).
   */
  confirmNonce?: number
  confirmTxHash?: string
  confirmedAtBlock?: number

  /*
   * Fee-bump bookkeeping for a confirmation that has not mined (authorizer-spec.md §9.1).
   *
   * All three are persisted BEFORE each send, for the same reason the nonce is: a
   * crash between sending and recording would otherwise leave the next attempt pricing
   * against figures lower than what actually reached the mempool, and a replacement
   * that does not exceed the pending transaction is refused rather than sent. Writing
   * the intended values first makes the recorded price an upper bound on the sent one,
   * which is the direction that still works.
   */

  /**
   * Ethereum block height at which the pending confirmation was last sent.
   *
   * The bump policy's only clock. `lockedAtBlock` is not a substitute -- it predates
   * the confirmation-depth wait and the finality wait, so blocks elapsed since it say
   * nothing about how long this transaction has been pending.
   */
  confirmSentAtBlock?: number
  /**
   * What the pending confirmation was sent at.
   *
   * Required, not merely useful: the replacement margin is defined relative to the
   * pending transaction's own fees, and they cannot be read back. Resolving a nonce
   * yields no transaction hash while it is pending, since a hash is not recoverable
   * from a nonce over the standard JSON-RPC surface.
   */
  confirmMaxFeePerGas?: bigint
  confirmMaxPriorityFeePerGas?: bigint
  /** Sends so far, the original included. Bounds runaway bumping and is worth logging. */
  confirmAttempts?: number
}

/**
 * Durable state. Every method must be individually atomic; the two marked below
 * additionally carry a claim that must not be observable as half-applied.
 */
export interface Store {
  getDeposit(depositId: string): Promise<DepositRecord | null>
  /** Deposits in the given states, for the pipeline to advance. */
  findDepositsByState(states: readonly DepositState[]): Promise<DepositRecord[]>
  /**
   * Persists the record's field updates and its new state together.
   * ATOMIC: a crash must leave the record wholly in the old state or wholly in the new.
   */
  saveDeposit(record: DepositRecord): Promise<void>

  /**
   * Reserves one confirmed reserve coin exclusively to this deposit, or returns null
   * if the pool is empty.
   *
   * ATOMIC and exclusive. Two funding transactions spending the same reserve coin are
   * mutually exclusive on XEC; whichever loses names a vault UTXO that can never exist,
   * and its confirmation has already foreclosed refund() (authorizer-spec.md §4.1).
   */
  reserveCoin(depositId: string): Promise<Coin | null>
  releaseCoin(depositId: string): Promise<void>

  /** Last Ethereum block whose logs have been fully processed. */
  getScanCursor(): Promise<number>
  setScanCursor(blockNumber: number): Promise<void>

  /**
   * Records a burn declaration as stamped, keyed on input 0's outpoint. Returns false
   * if it was already claimed.
   *
   * ATOMIC test-and-set, and it must be called BEFORE signing. Section IV.6 identifies
   * two concurrent honest stamps for one declaration as sufficient for a second full
   * release; a check performed after signing does not close that.
   */
  claimBurnDeclaration(outpoint: string, opReturnHex: string): Promise<boolean>

  /**
   * Releases a claim, permitting the declaration to be stamped later.
   *
   * ONLY safe when no signature could possibly have been produced for it -- e.g. the
   * claim succeeded but no stamp coin was available. Once signing has been attempted,
   * the declaration must stay claimed forever even if the attempt appeared to fail:
   * a stamp signature that exists anywhere is enough for a release, so permitting a
   * second one reopens the honest-key double-stamp of SPEC.md Section IV.6.
   */
  releaseBurnDeclaration(outpoint: string): Promise<void>

  /* ------------------------------------------------- issuance headroom (§6.3) */

  /** The durable headroom balance, in XEC-side base units. */
  getHeadroom(): Promise<bigint>

  /**
   * Atomically decrements headroom by `amount` for `issuanceId`, returning false if
   * the balance would go negative.
   *
   * ATOMIC compare-and-decrement, called BEFORE signing. Reading getHeadroom() and
   * then deciding is not equivalent and is not safe: two concurrent issuances read
   * the same balance, both find it sufficient, and together exceed it. The indexer's
   * lag behind the chain widens that window well past request timing alone, which is
   * why the bound lives in a durable balance rather than a fresh computation.
   *
   * Idempotent per issuanceId: a retry after an ambiguous failure must not decrement
   * twice.
   */
  reserveHeadroom(issuanceId: string, amount: bigint): Promise<boolean>

  /**
   * Returns previously reserved headroom, for an issuance that demonstrably did not
   * happen.
   *
   * "Demonstrably" is load-bearing. A signed authorization stays valid forever and can
   * be broadcast by anyone at any time, exactly as a deposit authorization can
   * (SPEC.md Section III.7) -- so releasing on a broadcast timeout, or because the
   * transaction has not appeared yet, hands back headroom that a live authorization
   * can still consume. Release only when the outcome is settled: the authorization was
   * never signed, or the vault UTXO it names has been spent by something else.
   *
   * Re-spending the vault UTXO is how that second condition is reached deliberately,
   * as a MINT of quantity zero. Zero is a valid mint amount, so this keeps the
   * ordinary shape and builder path while issuing nothing -- and therefore without
   * consuming the very headroom being reclaimed.
   */
  releaseHeadroom(issuanceId: string, amount: bigint): Promise<void>

  /**
   * Overwrites the durable balance with a value reconciled against both chains.
   *
   * The durable balance is a projection and drifts -- failed broadcasts, reorgs,
   * issuances that never confirmed. §6.3 requires periodic correction from the Lock
   * Contract and the indexer.
   */
  setHeadroom(amount: bigint): Promise<void>

  /**
   * Total quantity burned on XEC whose collateral has not yet left Ethereum, in
   * XEC-side base units.
   *
   * Subtracted from headroom, and it closes a real hole rather than refining a figure.
   * A withdrawal destroys tokens at one moment and `release()` removes the matching
   * collateral at another, and `release()` is permissionless and user-submitted -- so
   * the burner decides how far apart those moments are. In between, `collateral -
   * supply` reads high by the burn amount, and issuing against that inflated figure
   * before submitting the release proof leaves supply backed by less collateral than
   * before. Every individual step is valid, so nothing else catches it.
   *
   * The service can answer this: postage is a hard gate (§5), so it stamps every burn
   * that can ever be released and already records them for deduplication. The released
   * side is observable two ways -- `BridgeLock` emits `WithdrawalReleased`, indexed on
   * the burn txid this service itself broadcast, and `burnUtxoConsumedBy` is a public
   * mapping keyed on the burn's input 0 outpoint, so the state can be read directly
   * without depending on log retention.
   *
   * A burn that is never released holds its quantity here indefinitely. That is
   * correct, not a leak: its collateral has not moved either.
   */
  getUnreleasedBurnQuantity(): Promise<bigint>

  /**
   * Total reserved for issuances that are signed but not yet observable in supply.
   *
   * Subtracted at reconcile time. Without it, a reconcile landing between signing and
   * confirmation writes a balance computed from a supply figure that does not include
   * the pending mint, overwriting the reservation and handing the same capacity out
   * twice -- undoing what reserveHeadroom's atomicity exists to guarantee.
   *
   * "Not yet observable in supply" is the sound reading of outstanding: a reservation
   * stays counted until the vault UTXO its authorization names is seen spent. Counting
   * one for too long understates available headroom, which is the safe direction;
   * dropping one too early is the failure this exists to prevent.
   */
  getOutstandingReservations(): Promise<bigint>
}

/* --------------------------------------------------------------- StampSource */

/**
 * Withdrawal postage only. These coins pay miner fees; they are not vault funding,
 * and they are unrelated to the reserve pool the deposit side draws on.
 */
export interface StampSource {
  /**
   * One coin worth at least requiredSats, or null if none is available.
   *
   * Deliberately singular. BridgeLock.release() reads the postage input from
   * inputs[1] by index and verifies only that one, so the stamp must be a single
   * coin covering the whole fee -- not several fixed-denomination coins
   * (authorizer-spec.md §5).
   */
  fetchStamp(requiredSats: number): Promise<Coin | null>
  releaseStamp(coin: Coin): Promise<void>
  /**
   * Appends the stamp as input 1 and signs it SIGHASH_ALL | FORKID.
   *
   * Must not touch input 0 or any output: the user's ANYONECANPAY signature over
   * input 0 survives appended inputs, but re-signing or reordering would invalidate
   * it, and the OP_RETURN is committed to by both signatures.
   */
  appendAndSignStamp(rawTxHex: string, stamp: Coin): Promise<string>
}

/* --------------------------------------------------------------------- Minter */

/**
 * Optional convenience minting (authorizer-spec.md §4.5).
 *
 * The mint is permissionless and its outputs are fixed by the authorization the
 * covenant enforces, so this holds no custody and can redirect nothing -- a wrong
 * output set produces an invalid transaction, not a misdirected one. Supplied only
 * when config.convenienceMinting is on.
 */
export interface Minter {
  /**
   * Builds and signs the mint spending the vault UTXO, returning raw tx hex.
   *
   * The minter key is generated randomly per call and discarded. Nothing binds the
   * minter's public key to any identity, the mint has no change output, and so the
   * key never receives or controls anything -- there is no key to persist, rotate,
   * or lose. Implementations should not accept one as a parameter or read one from
   * config.
   */
  buildAndSignMint(args: {
    vaultCoin: Coin
    authorizationMessage: Buffer
    authorizerSignature: EcdsaSignature
  }): Promise<string>
}

/* --------------------------------------------------------------------- Logger */

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}
