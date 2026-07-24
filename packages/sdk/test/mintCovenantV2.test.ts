import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { Address, Coin, KeyRing, Output, Script } from '@hansekontor/checkout-components'
import { PreimageMTX } from '../src/preimage'
import { buildAuthorizationMessage, buildMintOpReturnV2, buildMintV2TxOutputs, mintCovenantV2, mintCovenantV2Ops } from '../src/script'
import { SLP_DUST_SATS } from '../src/constants'
import { hash256, runCovenant, signDER } from '../src/covenantInterpreter'

type StackItem = Buffer

interface Scenario {
  authorizer: InstanceType<typeof KeyRing>
  minter: InstanceType<typeof KeyRing>
  covenantScript: Script
  coin: InstanceType<typeof Coin>
  tx: PreimageMTX
  sigHashType: number
  flags: number
  preimage: Buffer
  minterSig: Buffer
  realSighash: Buffer
  tokenId: Buffer
  xecAmount: number
  xecRecipientHash160: Buffer
  depositId: Buffer
  chainId: bigint
  utxoTxid: Buffer
  utxoIndex: number
}

/** Builds a realistic mint spend: a real PreimageMTX spending a real Coin at the covenant address, with a real minter signature/preimage -- everything OP_CHECKSIG and the preimage-slicing stages actually operate on. */
function buildScenario(): Scenario {
  const authorizer = KeyRing.generate()
  const minter = KeyRing.generate()
  const tokenId = crypto.randomBytes(32)
  const xecAmount = 123_456
  const xecRecipientHash160 = crypto.randomBytes(20)
  const depositId = crypto.randomBytes(32)
  const chainId = 1n
  const utxoTxid = crypto.randomBytes(32)
  const utxoIndex = 0

  const covenantScript = mintCovenantV2(authorizer.getPublicKey())

  const coin = new Coin({
    hash: utxoTxid,
    index: utxoIndex,
    script: Script.fromAddress(Address.fromScripthash(covenantScript.hash160())),
    value: 1000
  })

  const mintOutput = new Output({ script: buildMintOpReturnV2(tokenId, [xecAmount]), value: 0 })
  const recipientOutput = new Output({ address: Address.fromPubkeyhash(xecRecipientHash160), value: SLP_DUST_SATS })

  const tx = new PreimageMTX()
  tx.addCoin(coin)
  tx.outputs = [mintOutput, recipientOutput]

  const sigHashType = Script.hashType.ALL | Script.hashType.SIGHASH_FORKID
  const flags = Script.flags.STANDARD_VERIFY_FLAGS
  tx.template(minter)

  const preimage = tx.getPreimage(0, covenantScript, coin.value, sigHashType, false)
  const realSighash = tx.signatureHash(0, covenantScript, coin.value, sigHashType, flags)
  // Deliberately not tx.signature(...) -- that wrapper defaults to Schnorr (64-byte)
  // signatures (contracts-spec.md `8.`'s documented gotcha). The covenant script
  // itself doesn't care which scheme minterSig uses (the real interpreter's
  // OP_CHECKDATASIG/OP_CHECKSIG both auto-detect by length), but forcing ECDSA here
  // matches the established, deliberate pattern elsewhere in this SDK
  // (fundOracleTx) rather than relying on that default.
  const minterSig = Buffer.concat([signDER(realSighash, minter.privateKey), Buffer.from([sigHashType])])

  return {
    authorizer,
    minter,
    covenantScript,
    coin,
    tx,
    sigHashType,
    flags,
    preimage,
    minterSig,
    realSighash,
    tokenId,
    xecAmount,
    xecRecipientHash160,
    depositId,
    chainId,
    utxoTxid,
    utxoIndex
  }
}

function signAuthorization(s: Scenario, authorizerKeyring = s.authorizer): { message: Buffer; authSig: Buffer } {
  const message = buildAuthorizationMessage(s.depositId, s.chainId, s.utxoTxid, s.utxoIndex, s.tokenId, s.xecAmount, s.xecRecipientHash160)
  const authSig = signDER(hash256(message), authorizerKeyring.privateKey)
  return { message, authSig }
}

function run(s: Scenario, message: Buffer, authSig: Buffer, preimage = s.preimage, minterSig = s.minterSig): boolean {
  const initialStack: StackItem[] = [minterSig, s.minter.getPublicKey(), preimage, authSig, message]
  return runCovenant(mintCovenantV2Ops(s.authorizer.getPublicKey()), initialStack, { realSighash: s.realSighash })
}

test('mintCovenantV2 accepts a correctly authorized, correctly constructed mint spend', () => {
  const s = buildScenario()
  const { message, authSig } = signAuthorization(s)
  assert.equal(run(s, message, authSig), true)
})

test('mintCovenantV2 rejects an authorization signed by a key other than the Authorizer', () => {
  const s = buildScenario()
  const impostor = KeyRing.generate()
  const { message, authSig } = signAuthorization(s, impostor)
  assert.throws(() => run(s, message, authSig), /checkdatasigverify failed/)
})

test('mintCovenantV2 rejects a message authorizing a different utxoIndex than the coin actually being spent', () => {
  const s = buildScenario()
  const wrongIndexMessage = buildAuthorizationMessage(s.depositId, s.chainId, s.utxoTxid, s.utxoIndex + 1, s.tokenId, s.xecAmount, s.xecRecipientHash160)
  const authSig = signDER(hash256(wrongIndexMessage), s.authorizer.privateKey)
  assert.throws(() => run(s, wrongIndexMessage, authSig), /equalverify failed/)
})

test('mintCovenantV2 rejects a message authorizing a different xecAmount than the real mint output actually pays', () => {
  const s = buildScenario()
  const wrongAmountMessage = buildAuthorizationMessage(s.depositId, s.chainId, s.utxoTxid, s.utxoIndex, s.tokenId, s.xecAmount + 1, s.xecRecipientHash160)
  const authSig = signDER(hash256(wrongAmountMessage), s.authorizer.privateKey)
  assert.throws(() => run(s, wrongAmountMessage, authSig), /equalverify failed/)
})

test('mintCovenantV2 rejects a message authorizing a different recipient than the real output actually pays', () => {
  const s = buildScenario()
  const wrongRecipientMessage = buildAuthorizationMessage(
    s.depositId,
    s.chainId,
    s.utxoTxid,
    s.utxoIndex,
    s.tokenId,
    s.xecAmount,
    crypto.randomBytes(20)
  )
  const authSig = signDER(hash256(wrongRecipientMessage), s.authorizer.privateKey)
  assert.throws(() => run(s, wrongRecipientMessage, authSig), /equalverify failed/)
})

test('mintCovenantV2 tolerates any depositId -- it is opaque, dropped, never checked', () => {
  const s = buildScenario()
  s.depositId = crypto.randomBytes(32) // different depositId, everything else identical
  const { message, authSig } = signAuthorization(s)
  assert.equal(run(s, message, authSig), true)
})

test('mintCovenantV2 tolerates any chainId -- it is opaque, dropped, never checked (2026-07 review)', () => {
  // chainId's protective value is entirely on the Ethereum side (stops one
  // BridgeLock deployment's signature from verifying against another's digest,
  // see BridgeLock.sol's chainId doc comment) -- the covenant itself has no chain
  // concept to check it against, exactly like depositId above.
  const s = buildScenario()
  s.chainId = 999999n // different chainId, everything else identical
  const { message, authSig } = signAuthorization(s)
  assert.equal(run(s, message, authSig), true)
})

test('mintCovenantV2 rejects a real authorization replayed against a substituted preimage from a different spend', () => {
  // The core security property (see mintCovenantV2Ops's doc comment): minterSig is
  // reused for both the CHECKDATASIGVERIFY-over-preimage check and the final
  // OP_CHECKSIG. Swapping in a preimage from a *different* transaction, while
  // keeping the same minterSig (produced for the *real* one), must fail --
  // proving the preimage witness item can't just be fabricated independently of
  // what's actually being broadcast.
  const s = buildScenario()
  const other = buildScenario()
  const { message, authSig } = signAuthorization(s)
  assert.throws(() => run(s, message, authSig, other.preimage), /checkdatasigverify failed/)
})

test('mintCovenantV2 rejects a spend signed by a key other than the one presented as minterPubkey', () => {
  const s = buildScenario()
  const { message, authSig } = signAuthorization(s)
  const impostorSig = Buffer.concat([signDER(s.realSighash, KeyRing.generate().privateKey), Buffer.from([s.sigHashType])])
  assert.throws(() => run(s, message, authSig, s.preimage, impostorSig), /checkdatasigverify failed|false/)
})
