declare module '@hansekontor/checkout-components' {
  export class Address {
    static fromPubkeyhash(hash: Buffer): Address
    static fromScripthash(hash: Buffer): Address
    toString(): string
  }

  export class Script {
    static hashType: {
      ALL: number
      NONE: number
      SINGLE: number
      ANYONECANPAY: number
      SIGHASH_FORKID: number
      [key: string]: number
    }
    static flags: {
      STANDARD_VERIFY_FLAGS: number
      [key: string]: number
    }
    static fromAddress(address: Address): Script
    static fromRaw(data: Buffer): Script
    static fromNulldata(data: Buffer): Script

    readonly length: number

    pushSym(sym: string): this
    pushData(data: Buffer): this
    pushPush(data: Buffer): this
    pushInt(n: number): this
    compile(): this
    clone(): Script
    toRaw(): Buffer
    getVarSize(): number
    hash160(): Buffer
    fromItems(items: Buffer[]): this
    popSym(): string
    popData(): Buffer
    getSym(index: number): string
    getData(index: number): Buffer
    getInt(index: number): number
  }

  export class Output {
    constructor(options: { script?: Script; value: number; address?: Address })
    value: number
    script: Script
    address?: Address
    toWriter(bw: unknown): void
    toRaw(): Buffer
    getSize(): number
    static fromReader(br: unknown): Output
  }

  export class Coin {
    constructor(options: { hash: Buffer; index: number; value: number; script: Script })
    static fromTX(tx: MTX, index: number, height: number): Coin
    value: number
    script: Script
    hash: Buffer
    index: number
  }

  export class Outpoint {
    constructor(hash: Buffer, index: number)
    hash: Buffer
    index: number
  }

  export class KeyRing {
    static generate(): KeyRing
    static fromSecret(wif: string): KeyRing
    static fromPrivate(key: Buffer, compressed?: boolean): KeyRing
    privateKey: Buffer
    script: Script
    getPrivateKey(): Buffer
    getPublicKey(): Buffer
    getAddress(): Address
    toSecret(): string
  }

  export interface MTXInput {
    prevout: {
      hash: Buffer
      index: number
      toWriter(bw: unknown): void
      toRaw(): Buffer
    }
    sequence: number
    script: Script
  }

  export class MTX {
    constructor()
    version: number
    locktime: number
    mutable: boolean
    height?: number
    inputs: MTXInput[]
    outputs: Output[]
    view: unknown
    _hashPrevouts?: Buffer
    _hashSequence?: Buffer
    _hashOutputs?: Buffer
    addCoin(coin: Coin): void
    addOutput(script: Script | Address, value: number): void
    template(keyring: KeyRing): void
    signature(index: number, prev: Script, value: number, key: Buffer, type: number, flags: number): Buffer
    signatureHash(index: number, prev: Script, value: number, type: number, flags: number): Buffer
    toRaw(): Buffer
    check(flags?: number): void
  }

  export class TX {
    static fromRaw(data: Buffer): TX
    hash(): Buffer
    toRaw(): Buffer
  }

  export class Block {
    constructor(options?: {
      version: number
      prevBlock: Buffer
      merkleRoot: Buffer
      time: number
      bits: number
      nonce: number
      txs?: TX[]
    })
    static fromRaw(data: Buffer): Block
    txs: TX[]
    merkleRoot: Buffer
    createMerkleRoot(): Buffer | null
    toRaw(): Buffer
  }

  export const consensus: {
    ZERO_HASH: Buffer
  }

  export interface MerkleAlgorithm {
    root(left: Buffer, right: Buffer): Buffer
    zero: Buffer
  }

  export const bcrypto: {
    secp256k1: {
      publicKeyConvert(pubkey: Buffer, compressed: boolean): Buffer
      signRecoverableDER(hash: Buffer, privateKey: Buffer): [Buffer, number]
      verifyDER(sig: Buffer, hash: Buffer, pubkey: Buffer): boolean
    }
    Hash160: {
      digest(data: Buffer): Buffer
    }
    Hash256: MerkleAlgorithm & {
      digest(data: Buffer): Buffer
    }
    Keccak: {
      digest(data: Buffer, bits: number): Buffer
    }
    merkle: {
      createTree(alg: MerkleAlgorithm, leaves: Buffer[]): [Buffer[], boolean]
      createRoot(alg: MerkleAlgorithm, leaves: Buffer[]): [Buffer, boolean]
      createBranch(alg: MerkleAlgorithm, index: number, leaves: Buffer[]): Buffer[]
      deriveRoot(alg: MerkleAlgorithm, hash: Buffer, branch: Buffer[], index: number): Buffer
    }
  }
}

declare module 'bufio' {
  export interface BufferWriter {
    writeBytes(data: Buffer): BufferWriter
    writeU8(n: number): BufferWriter
    writeU32(n: number): BufferWriter
    writeI64(n: number): BufferWriter
    writeHash(data: Buffer): BufferWriter
    writeVarBytes(data: Buffer): BufferWriter
    render(): Buffer
  }
  export interface BufferReader {
    readBytes(n: number): Buffer
    left(): number
  }
  export function write(size?: number): BufferWriter
  export function pool(size: number): BufferWriter
  export function read(data: Buffer): BufferReader
}

declare module 'bsert' {
  function assert(value: unknown, message?: string): asserts value
  export = assert
}

declare module 'n64' {
  export class I64 {
    static fromInt(n: number): I64
    toLE(ctor: BufferConstructor): Buffer
  }
  export class U64 {
    static fromInt(n: number): U64
    /** Unlike fromInt (which truncates values above 32 bits -- silently drops the high word), fromString parses the full 64-bit value from a decimal string. Use this for real SLP quantities, which routinely exceed 32 bits. */
    static fromString(s: string): U64
    toBE(ctor: BufferConstructor): Buffer
    toLE(ctor: BufferConstructor): Buffer
  }
}
