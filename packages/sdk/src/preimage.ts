import { Script, consensus, MTX, bcrypto } from '@hansekontor/checkout-components'
import * as bio from 'bufio'
import { I64 } from 'n64'

const hashType = Script.hashType
const hash256 = bcrypto.Hash256

/**
 * MTX subclass exposing a custom, standalone getPreimage — needed so callers can
 * compute a BIP143-style sighash preimage buffer directly (e.g. to embed as a witness
 * item for the self-mint covenant's OP_CHECKDATASIGVERIFY check), rather than only
 * getting back a finished signature.
 */
export class PreimageMTX extends MTX {
  /**
   * Compute a sighash preimage.
   * @param index index of the input being signed
   * @param prev the previous output's script (or redeem script, for P2SH)
   * @param value value of the input being spent
   * @param type sighash type
   * @param json when true, return the preimage components unhashed, as an object
   */
  getPreimage(index: number, prev: Script, value: number, type: number, json: false): Buffer
  getPreimage(index: number, prev: Script, value: number, type: number, json: true): Record<string, unknown>
  getPreimage(index: number, prev: Script, value: number, type: number, json: boolean): Buffer | Record<string, unknown> {
    const input = this.inputs[index]
    let prevouts: Buffer = consensus.ZERO_HASH
    let sequences: Buffer = consensus.ZERO_HASH
    let outputs: Buffer = consensus.ZERO_HASH

    if (!(type & hashType.ANYONECANPAY)) {
      if (this._hashPrevouts) {
        prevouts = this._hashPrevouts
      } else {
        const bw = bio.pool(this.inputs.length * 36)

        for (const input of this.inputs) input.prevout.toWriter(bw)

        if (json) {
          const rawPrevouts = this.inputs.map((input) => input.prevout.toRaw())
          prevouts = Buffer.concat(rawPrevouts)
        } else {
          prevouts = hash256.digest(bw.render())
        }

        if (!this.mutable && !json) this._hashPrevouts = prevouts
      }
    }

    if (!(type & hashType.ANYONECANPAY) && (type & 0x1f) !== hashType.SINGLE && (type & 0x1f) !== hashType.NONE) {
      if (this._hashSequence) {
        sequences = this._hashSequence
      } else {
        const bw = bio.pool(this.inputs.length * 4)

        for (const input of this.inputs) bw.writeU32(input.sequence)

        if (json) sequences = bw.render()
        else sequences = hash256.digest(bw.render())

        if (!this.mutable && !json) this._hashSequence = sequences
      }
    }

    if ((type & 0x1f) !== hashType.SINGLE && (type & 0x1f) !== hashType.NONE) {
      if (this._hashOutputs) {
        outputs = this._hashOutputs
      } else {
        let size = 0

        for (const output of this.outputs) size += output.getSize()

        const bw = bio.pool(size)

        for (const output of this.outputs) output.toWriter(bw)

        if (json) {
          const rawOutputs = this.outputs.map((output) => output.toRaw())
          outputs = Buffer.concat(rawOutputs)
        } else {
          outputs = hash256.digest(bw.render())
        }

        if (!this.mutable && !json) this._hashOutputs = outputs
      }
    } else if ((type & 0x1f) === hashType.SINGLE) {
      if (index < this.outputs.length) {
        const output = this.outputs[index]
        outputs = json ? output.toRaw() : hash256.digest(output.toRaw())
      }
    }

    if (json) {
      const locktimeBuf = Buffer.alloc(4)
      locktimeBuf.writeUInt32LE(this.locktime)
      const typeBuf = Buffer.alloc(4)
      typeBuf.writeUInt32LE(type)
      return {
        version: this.version,
        prevouts,
        sequences,
        outpoint: input.prevout.toRaw(),
        scriptCode: prev.toRaw(),
        inputValue: I64.fromInt(value).toLE(Buffer),
        inputSequence: input.sequence,
        outputs,
        locktime: locktimeBuf,
        type: typeBuf
      }
    }

    const size = 156 + prev.getVarSize()
    const bw = bio.pool(size)

    bw.writeU32(this.version)
    bw.writeBytes(prevouts)
    bw.writeBytes(sequences)
    bw.writeHash(input.prevout.hash)
    bw.writeU32(input.prevout.index)
    bw.writeVarBytes(prev.toRaw())
    bw.writeI64(value)
    bw.writeU32(input.sequence)
    bw.writeBytes(outputs)
    bw.writeU32(this.locktime)
    bw.writeU32(type)

    return bw.render()
  }
}
