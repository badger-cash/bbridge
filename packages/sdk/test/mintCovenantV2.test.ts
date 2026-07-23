import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { Address, Coin, KeyRing, Output, Script, bcrypto } from '@hansekontor/checkout-components'
import { PreimageMTX } from '../src/preimage'
import { CovenantOp, buildAuthorizationMessage, buildMintOpReturnV2, buildMintV2TxOutputs, mintCovenantV2, mintCovenantV2Ops } from '../src/script'
import { SLP_DUST_SATS } from '../src/constants'

const { secp256k1 } = bcrypto

// There is no eCash script VM available in this repo to execute mintCovenantV2's
// compiled bytecode against. This is what stands in for one: a small interpreter
// covering exactly the opcodes mintCovenantV2Ops uses, built from the *same*
// mintCovenantV2Ops() array the real Script is compiled from (see script.ts), so the
// two can't silently drift apart. Verified against the actual opcode implementations
// in node_modules/@hansekontor/checkout-components/lib/script/script.js (stack
// argument order for OP_ROT/OP_SPLIT/OP_CAT/OP_CHECKDATASIG etc.), not just inferred.

function sha256(buf: Buffer): Buffer {
  return crypto.createHash('sha256').update(buf).digest()
}

function hash256(buf: Buffer): Buffer {
  return sha256(sha256(buf))
}

// secp256k1's .d.ts (from @hansekontor/checkout-components) only declares
// signRecoverableDER, not the plain signDER the runtime also exposes -- the
// recovery id isn't needed here (verifyDER doesn't use it), so just discard it.
function signDER(hash: Buffer, privateKey: Buffer): Buffer {
  const [sig] = secp256k1.signRecoverableDER(hash, privateKey)
  return sig
}

// Matches the real interpreter's own verifySignature dispatch (script.js): a 64-byte
// signature is Schnorr, anything else is DER-encoded ECDSA. tx.signature() (used for
// minterSig below) defaults to Schnorr -- see contracts-spec.md `8.`'s note on this --
// so both signature checks in the covenant need this same dispatch, not just verifyDER.
// secp256k1's .d.ts doesn't declare schnorrVerify either (same gap as signDER above).
const secp256k1Untyped = secp256k1 as unknown as { schnorrVerify(hash: Buffer, sig: Buffer, key: Buffer): boolean }

function verifySignature(hash: Buffer, sig: Buffer, key: Buffer): boolean {
  if (sig.length === 64) return secp256k1Untyped.schnorrVerify(hash, sig, key)
  return secp256k1.verifyDER(hash, sig, key)
}

interface Ctx {
  /** What OP_CHECKSIG would internally compute for the real transaction (tx.signatureHash's own result) -- independent of whatever `preimage` witness bytes are on the stack, exactly like the real opcode (see script.js: OP_CHECKSIG never reads the "preimage" stack item at all). */
  realSighash: Buffer
}

type StackItem = Buffer

function runCovenant(ops: CovenantOp[], initialStack: StackItem[], ctx: Ctx): boolean {
  const stack: StackItem[] = [...initialStack]
  const altstack: StackItem[] = []
  const numStack: number[] = [] // parallel "is this a pushed int" tracker isn't needed -- ints are only ever consumed immediately by size/sub/split, so track them as a separate small stack pushed by 'int' ops and popped by the ops that need them.

  const pop = (): StackItem => {
    if (stack.length === 0) throw new Error('stack underflow')
    return stack.pop() as StackItem
  }
  const popNum = (): number => {
    if (numStack.length === 0) throw new Error('num stack underflow')
    return numStack.pop() as number
  }

  for (const step of ops) {
    if (step.op === 'data') {
      stack.push(step.data)
      continue
    }
    if (step.op === 'int') {
      numStack.push(step.value)
      continue
    }
    switch (step.sym) {
      case 'dup':
        stack.push(stack[stack.length - 1])
        break
      case 'swap': {
        const a = pop()
        const b = pop()
        stack.push(a)
        stack.push(b)
        break
      }
      case 'rot': {
        const c = pop()
        const b = pop()
        const a = pop()
        stack.push(b)
        stack.push(c)
        stack.push(a)
        break
      }
      case '3dup': {
        const a = stack[stack.length - 3]
        const b = stack[stack.length - 2]
        const c = stack[stack.length - 1]
        stack.push(a)
        stack.push(b)
        stack.push(c)
        break
      }
      case 'sha256':
        stack.push(sha256(pop()))
        break
      case 'hash256':
        stack.push(hash256(pop()))
        break
      case 'size':
        numStack.push(stack[stack.length - 1].length)
        break
      case 'sub': {
        const n2 = popNum()
        const n1 = popNum()
        numStack.push(n1 - n2)
        break
      }
      case 'split': {
        const pos = popNum()
        const x = pop()
        if (pos < 0 || pos > x.length) throw new Error('split position out of range')
        stack.push(x.subarray(0, pos))
        stack.push(x.subarray(pos))
        break
      }
      case 'nip': {
        const top = pop()
        pop()
        stack.push(top)
        break
      }
      case 'drop':
        pop()
        break
      case 'cat': {
        const b = pop()
        const a = pop()
        stack.push(Buffer.concat([a, b]))
        break
      }
      case 'toaltstack':
        altstack.push(pop())
        break
      case 'fromaltstack':
        if (altstack.length === 0) throw new Error('altstack underflow')
        stack.push(altstack.pop() as StackItem)
        break
      case 'equalverify': {
        const b = pop()
        const a = pop()
        if (!a.equals(b)) throw new Error('equalverify failed')
        break
      }
      case 'checkdatasigverify': {
        const key = pop()
        const message = pop()
        const sig = pop()
        const ok = verifySignature(sha256(message), sig, key)
        if (!ok) throw new Error('checkdatasigverify failed')
        break
      }
      case 'checksig': {
        const key = pop()
        const sigWithType = pop()
        const sig = sigWithType.subarray(0, sigWithType.length - 1)
        return verifySignature(ctx.realSighash, sig, key)
      }
      default:
        throw new Error('unimplemented op: ' + step.sym)
    }
  }
  throw new Error('script ended without a final checksig result')
}

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
    utxoTxid,
    utxoIndex
  }
}

function signAuthorization(s: Scenario, authorizerKeyring = s.authorizer): { message: Buffer; authSig: Buffer } {
  const message = buildAuthorizationMessage(s.depositId, s.utxoTxid, s.utxoIndex, s.tokenId, s.xecAmount, s.xecRecipientHash160)
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
  const wrongIndexMessage = buildAuthorizationMessage(s.depositId, s.utxoTxid, s.utxoIndex + 1, s.tokenId, s.xecAmount, s.xecRecipientHash160)
  const authSig = signDER(hash256(wrongIndexMessage), s.authorizer.privateKey)
  assert.throws(() => run(s, wrongIndexMessage, authSig), /equalverify failed/)
})

test('mintCovenantV2 rejects a message authorizing a different xecAmount than the real mint output actually pays', () => {
  const s = buildScenario()
  const wrongAmountMessage = buildAuthorizationMessage(s.depositId, s.utxoTxid, s.utxoIndex, s.tokenId, s.xecAmount + 1, s.xecRecipientHash160)
  const authSig = signDER(hash256(wrongAmountMessage), s.authorizer.privateKey)
  assert.throws(() => run(s, wrongAmountMessage, authSig), /equalverify failed/)
})

test('mintCovenantV2 rejects a message authorizing a different recipient than the real output actually pays', () => {
  const s = buildScenario()
  const wrongRecipientMessage = buildAuthorizationMessage(
    s.depositId,
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
