/*
 * Minimal ambient declarations for the untyped @hansekontor/checkout-components.
 *
 * Deliberately narrow, and only grown when a call site actually needs a member:
 * key handling and transaction construction live behind ports (ports.ts), so this
 * package only needs read-only transaction inspection plus the vault's P2SH address.
 * packages/sdk carries its own, fuller copy for the same reason -- neither is a
 * shared type package, and neither should grow beyond what its own source calls.
 */
declare module '@hansekontor/checkout-components' {
  export class Address {
    static fromScripthash(hash: Buffer): Address
    toString(): string
  }

  export class Script {
    constructor()
    static fromRaw(data: Buffer): Script
    static fromAddress(address: Address): Script
    static fromPubkeyhash(hash: Buffer): Script
    static fromNulldata(data: Buffer): Script
    static hashType: { ALL: number; ANYONECANPAY: number; SIGHASH_FORKID: number }
    /** Parsed opcodes; `data` is present on pushdata items. */
    readonly code: Array<{ data?: Buffer; value: number }>
    /** HASH160 of the serialized script -- the P2SH scripthash. */
    hash160(): Buffer
    isPubkeyhash(): boolean
    getPubkeyhash(): Buffer | null
    pushData(data: Buffer): this
    compile(): this
    toRaw(): Buffer
  }

  export class Outpoint {
    hash: Buffer
    index: number
    /** Conventional big-endian display form. */
    txid(): string
  }

  export class Input {
    prevout: Outpoint
    script: Script
    sequence: number
  }

  export class Output {
    value: number
    script: Script
  }

  export class TX {
    static fromRaw(data: Buffer): TX
    inputs: Input[]
    outputs: Output[]
    hash(): Buffer
    getSize(): number
    toRaw(): Buffer
    /**
     * Verifies one input's signature. Handles both Schnorr and DER encodings and,
     * with the default flags, takes the FORKID/BIP143 sighash path that commits the
     * previous output's value.
     */
    checksig(index: number, prev: Script, value: number, sig: Buffer, key: Buffer, flags?: number): boolean
    signatureHash(index: number, prev: Script, value: number, type: number, flags?: number): Buffer
  }

  export class Coin {
    constructor(options: { hash: Buffer; index: number; value: number; script: Script })
  }

  export class MTX {
    constructor()
    inputs: Input[]
    addCoin(coin: Coin): void
    addOutput(script: Script, value: number): void
    signatureHash(index: number, prev: Script, value: number, type: number, flags?: number): Buffer
    toRaw(): Buffer
  }

  export class KeyRing {
    static generate(): KeyRing
    getPublicKey(): Buffer
    getPrivateKey(): Buffer
    getAddress(): Address
  }

  export const bcrypto: {
    Hash160: { digest(data: Buffer): Buffer }
    secp256k1: {
      signDER(msg: Buffer, key: Buffer): Buffer
      verifyDER(msg: Buffer, sig: Buffer, key: Buffer): boolean
    }
  }
}
