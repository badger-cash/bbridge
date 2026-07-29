import crypto from 'node:crypto'
import { bcrypto } from '@hansekontor/checkout-components'
import { CovenantOp } from './script'

const { secp256k1 } = bcrypto

export function sha256(buf: Buffer): Buffer {
  return crypto.createHash('sha256').update(buf).digest()
}

export function hash256(buf: Buffer): Buffer {
  return sha256(sha256(buf))
}

// secp256k1's .d.ts (from @hansekontor/checkout-components) only declares
// signRecoverableDER, not the plain signDER the runtime also exposes -- the
// recovery id isn't needed here (verifyDER doesn't use it), so just discard it.
export function signDER(hash: Buffer, privateKey: Buffer): Buffer {
  const [sig] = secp256k1.signRecoverableDER(hash, privateKey)
  return sig
}

// Matches the real interpreter's own verifySignature dispatch (script.js): a 64-byte
// signature is Schnorr, anything else is DER-encoded ECDSA. tx.signature() defaults
// to Schnorr in this library -- see contracts-spec.md `8.`'s note on this -- so any
// signature check that might see either scheme needs this same dispatch, not just
// verifyDER. secp256k1's .d.ts doesn't declare schnorrVerify either (same gap as
// signDER above).
const secp256k1Untyped = secp256k1 as unknown as { schnorrVerify(hash: Buffer, sig: Buffer, key: Buffer): boolean }

export function verifySignature(hash: Buffer, sig: Buffer, key: Buffer): boolean {
  if (sig.length === 64) return secp256k1Untyped.schnorrVerify(hash, sig, key)
  return secp256k1.verifyDER(hash, sig, key)
}

export interface CovenantCtx {
  /** What OP_CHECKSIG would internally compute for the real transaction (tx.signatureHash's own result) -- independent of whatever `preimage` witness bytes are on the stack, exactly like the real opcode (see script.js: OP_CHECKSIG never reads the "preimage" stack item at all). */
  realSighash: Buffer
}

export type StackItem = Buffer

/**
 * There is no eCash script VM available in this repo to execute a compiled
 * covenant Script's bytecode against. This is what stands in for one: a small
 * interpreter covering exactly the opcodes mintCovenantV2Ops uses, built from the
 * *same* CovenantOp[] array the real Script is compiled from (see script.ts), so the
 * two can't silently drift apart. Executed against real cryptographic primitives and
 * a real, PreimageMTX-constructed transaction's own preimage/sighash -- not a
 * structural mock. Verified against the actual opcode implementations in
 * node_modules/@hansekontor/checkout-components/lib/script/script.js (stack argument
 * order for OP_ROT/OP_SPLIT/OP_CAT/OP_CHECKDATASIG etc.), not just inferred.
 *
 * Shared between the SDK's own covenant unit tests (test/mintCovenantV2.test.ts) and
 * packages/contracts' cross-chain end-to-end test, so both exercise identical opcode
 * semantics rather than two hand-maintained copies.
 */
export function runCovenant(ops: CovenantOp[], initialStack: StackItem[], ctx: CovenantCtx): boolean {
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
