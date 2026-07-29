/*
 * In-memory port fakes.
 *
 * The point of the port design is that the pipeline can be driven to any state
 * without a chain, a database or a key -- these are what make that true. The one
 * fake that carries real weight is FakeEcash: it records every broadcast alongside
 * the deposit state at the time, which is how the quarantine tests assert a negative
 * ("this was never broadcast early") rather than just a positive.
 */
import type {
  BridgeEvent,
  Coin,
  DepositRecord,
  EcashClient,
  EcdsaSignature,
  EthereumReader,
  EthereumWriter,
  FundingTx,
  Logger,
  OnChainDeposit,
  ReserveWallet,
  Signer,
  Store
} from '../src/ports'
import type { DepositState } from '../src/states'
import type { AuthorizerConfig } from '../src/config'
import { dollarMinBurnAmount } from '../src/config'
import type { DepositPipelineDeps } from '../src/deposit/pipeline'

/** A real compressed secp256k1 point -- mintCovenantV2 embeds it, so it must parse. */
export const AUTH_PUBKEY = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)

export const DEPOSIT_ID = '0x' + '11'.repeat(32)
export const XEC_RECIPIENT = 'aa'.repeat(20)

export function testConfig(overrides: Partial<AuthorizerConfig> = {}): AuthorizerConfig {
  return {
    lockContractAddress: '0x' + '22'.repeat(20),
    chainId: 1n,
    xecTokenId: Buffer.alloc(32, 3),
    xecDecimals: 6,
    tokenDecimals: 6,
    confirmationDepth: 12,
    finalityDepth: 64,
    reserveAddress: 'ecash:qreserve',
    reservePoolMin: 4,
    minBurnAmount: dollarMinBurnAmount(6),
    convenienceMinting: false,
    allowDiscretionaryIssuance: false,
    headroomReconcileIntervalMs: 60_000,
    pollIntervalMs: 1000,
    feeRateSatsPerKb: 1000,
    ...overrides
  }
}

export class FakeStore implements Store {
  deposits = new Map<string, DepositRecord>()
  pool: Coin[] = []
  reservations = new Map<string, Coin>()
  cursor = 0
  burnClaims = new Map<string, string>()

  async getDeposit(depositId: string) {
    return this.deposits.get(depositId) ?? null
  }
  async findDepositsByState(states: readonly DepositState[]) {
    return [...this.deposits.values()].filter(d => states.includes(d.state))
  }
  async saveDeposit(record: DepositRecord) {
    this.deposits.set(record.depositId, { ...record })
  }
  async reserveCoin(depositId: string) {
    const existing = this.reservations.get(depositId)
    if (existing)
      return existing
    const coin = this.pool.shift()
    if (!coin)
      return null
    this.reservations.set(depositId, coin)
    return coin
  }
  async releaseCoin(depositId: string) {
    const coin = this.reservations.get(depositId)
    if (!coin)
      return
    this.reservations.delete(depositId)
    this.pool.unshift(coin)
  }
  async getScanCursor() {
    return this.cursor
  }
  async setScanCursor(blockNumber: number) {
    this.cursor = blockNumber
  }
  async claimBurnDeclaration(outpoint: string, opReturnHex: string) {
    if (this.burnClaims.has(outpoint))
      return false
    this.burnClaims.set(outpoint, opReturnHex)
    return true
  }

  async releaseBurnDeclaration(outpoint: string) {
    this.burnClaims.delete(outpoint)
  }

  headroom = 0n
  headroomReservations = new Map<string, bigint>()

  async getHeadroom() {
    return this.headroom
  }
  /** Atomic compare-and-decrement, idempotent per issuanceId (see Store). */
  async reserveHeadroom(issuanceId: string, amount: bigint) {
    if (this.headroomReservations.has(issuanceId))
      return true
    if (amount > this.headroom)
      return false
    this.headroom -= amount
    this.headroomReservations.set(issuanceId, amount)
    return true
  }
  async releaseHeadroom(issuanceId: string, amount: bigint) {
    if (!this.headroomReservations.delete(issuanceId))
      return
    this.headroom += amount
  }
  async setHeadroom(amount: bigint) {
    this.headroom = amount
  }
}

export class FakeEth implements EthereumReader {
  head = 0
  logs: BridgeEvent[] = []
  deposits = new Map<string, OnChainDeposit>()

  async getBlockNumber() {
    return this.head
  }
  async getLogs(fromBlock: number, toBlock: number) {
    return this.logs.filter(e => e.blockNumber >= fromBlock && e.blockNumber <= toBlock)
  }
  async getDeposit(depositId: string): Promise<OnChainDeposit> {
    return (
      this.deposits.get(depositId) ?? {
        depositor: '0x' + '00'.repeat(20),
        netAmount: 0n,
        xecRecipient: XEC_RECIPIENT,
        status: 'unknown'
      }
    )
  }
  async getTransactionReceipt() {
    return null
  }
  /** Live collateral, not a cumulative deposit total -- see EthereumReader. */
  collateral = 0n
  async getLockedCollateral() {
    return this.collateral
  }
}

export class FakeEthWriter implements EthereumWriter {
  nextNonce = 0
  sent: Array<{ nonce: number; depositId: string; utxoTxid: string; blockNumber: number | null }> = []
  /** Set to drop the send after it has taken effect, simulating a crash mid-window. */
  swallowSend = false

  async reserveNonce() {
    return this.nextNonce++
  }
  async sendConfirmDeposit(args: { nonce: number; depositId: string; utxoTxid: string }) {
    this.sent.push({ nonce: args.nonce, depositId: args.depositId, utxoTxid: args.utxoTxid, blockNumber: null })
    if (this.swallowSend)
      throw new Error('simulated crash after send, before persist')
    return '0x' + 'ee'.repeat(32)
  }
  async getTransactionByNonce(nonce: number) {
    const tx = this.sent.find(t => t.nonce === nonce)
    return tx ? { txHash: '0x' + 'ee'.repeat(32), blockNumber: tx.blockNumber } : null
  }
  /** Mines whatever was sent at this nonce. */
  mine(nonce: number, blockNumber: number) {
    const tx = this.sent.find(t => t.nonce === nonce)
    if (tx)
      tx.blockNumber = blockNumber
  }
}

export class FakeEcash implements EcashClient {
  broadcasts: string[] = []
  /** Deposit state observed at each broadcast, for the quarantine assertions. */
  broadcastStates: Array<DepositState | undefined> = []
  private store?: FakeStore

  watch(store: FakeStore) {
    this.store = store
  }
  async getUtxos() {
    return []
  }
  async getOutput() {
    return null
  }
  async broadcast(rawTxHex: string) {
    this.broadcasts.push(rawTxHex)
    this.broadcastStates.push(this.store?.deposits.get(DEPOSIT_ID)?.state)
    return 'broadcast-' + this.broadcasts.length
  }
  async getTx() {
    return null
  }
}

export class FakeReserve implements ReserveWallet {
  built = 0
  fail = false

  async buildVaultFundingTx(args: { reserveCoin: Coin; vaultAddress: string; vaultValue: number }): Promise<FundingTx> {
    if (this.fail)
      throw new Error('simulated funding build failure')
    this.built++
    // Deterministic in the reserve coin, so a rebuild for the same coin yields the
    // same txid -- which is what makes the "re-sign after crash" test meaningful.
    const txid = Buffer.from(`${args.reserveCoin.txid}:${args.reserveCoin.index}`.padEnd(32, '.')).toString('hex')
    return { rawTxHex: 'ff' + txid, txid, vaultOutputIndex: 0 }
  }
}

export class FakeSigner implements Signer {
  calls = 0
  async getPublicKey() {
    return AUTH_PUBKEY
  }
  async signDigest(digest: Buffer): Promise<EcdsaSignature> {
    this.calls++
    // Not a real signature -- the pipeline only moves it around. It is deliberately
    // varied by digest so a test can tell two signings apart, and deliberately low-S
    // so assertLowS passes (a high-S value is exercised separately).
    return { v: 27, r: '0x' + digest.toString('hex'), s: '0x' + '11'.repeat(32) }
  }
}

export class FakeLogger implements Logger {
  entries: Array<{ level: string; message: string }> = []
  info(message: string) {
    this.entries.push({ level: 'info', message })
  }
  warn(message: string) {
    this.entries.push({ level: 'warn', message })
  }
  error(message: string) {
    this.entries.push({ level: 'error', message })
  }
  has(level: string, fragment: string) {
    return this.entries.some(e => e.level === level && e.message.includes(fragment))
  }
}

export interface Harness extends DepositPipelineDeps {
  store: FakeStore
  eth: FakeEth
  ethWriter: FakeEthWriter
  ecash: FakeEcash
  reserve: FakeReserve
  signer: FakeSigner
  logger: FakeLogger
}

export function harness(configOverrides: Partial<AuthorizerConfig> = {}): Harness {
  const store = new FakeStore()
  const ecash = new FakeEcash()
  ecash.watch(store)

  store.pool = Array.from({ length: 3 }, (_, i) => ({
    txid: 'c0'.repeat(32),
    index: i,
    value: 10_000,
    script: 'reserve'
  }))

  return {
    config: testConfig(configOverrides),
    mintFeeSats: 1200,
    store,
    eth: new FakeEth(),
    ethWriter: new FakeEthWriter(),
    ecash,
    reserve: new FakeReserve(),
    signer: new FakeSigner(),
    logger: new FakeLogger()
  }
}

/** A DepositLocked event at the given block. */
export function lockedEvent(blockNumber = 100, netAmount = 5_000_000n): BridgeEvent {
  return {
    type: 'DepositLocked',
    depositId: DEPOSIT_ID,
    depositor: '0x' + '44'.repeat(20),
    netAmount,
    xecRecipient: XEC_RECIPIENT,
    blockNumber
  }
}
