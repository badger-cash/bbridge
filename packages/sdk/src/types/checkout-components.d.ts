/*
 * Ambient declarations for the untyped @hansekontor/checkout-components.
 *
 * This is the single declaration for the whole monorepo, and it ships with the
 * package (see scripts/copy-ambient-types.js). packages/authorizer used to carry
 * its own narrower copy; that stopped being viable once this one was published,
 * because two `declare module` blocks for one specifier do not merge - one simply
 * wins, and which one is not something either package controls. The symptom was
 * the authorizer failing to compile against members its own copy declared.
 *
 * So it is deliberately a superset of what any package here calls, rather than
 * minimal. Grow it when a call site needs a member; do not add speculative ones,
 * since nothing checks these against the real runtime.
 *
 * That last point is not hypothetical: `verifyDER` was declared here for a while as
 * `(sig, hash, pubkey)` while the runtime takes `(msg, sig, key)`. Every parameter
 * is a Buffer, so TypeScript could not tell the difference and never complained.
 * Verify against the real module before trusting an argument order in here.
 */
declare module '@hansekontor/checkout-components' {
  export class Address {
    static fromPubkeyhash(hash: Buffer): Address
    static fromScripthash(hash: Buffer): Address
    static fromString(address: string): Address
    toString(): string
  }

  export class Script {
    constructor()
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
      VERIFY_SIGHASH_FORKID: number
      [key: string]: number
    }
    static fromAddress(address: Address): Script
    static fromRaw(data: Buffer): Script
    static fromPubkeyhash(hash: Buffer): Script
    static fromNulldata(data: Buffer): Script

    readonly length: number
    /** Parsed opcodes; `data` is present on pushdata items. */
    readonly code: Array<{ data?: Buffer; value: number }>

    pushSym(sym: string): this
    pushData(data: Buffer): this
    pushPush(data: Buffer): this
    pushInt(n: number): this
    compile(): this
    clone(): Script
    toRaw(): Buffer
    toJSON(): string
    getVarSize(): number
    /** HASH160 of the serialized script -- the P2SH scripthash. */
    hash160(): Buffer
    isPubkeyhash(): boolean
    getPubkeyhash(): Buffer | null
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
    getAddress(): Address | null
    static fromReader(br: unknown): Output
  }

  export class Coin {
    constructor(options: { hash: Buffer; index: number; value: number; script: Script })
    static fromTX(tx: MTX, index: number, height: number): Coin
    static fromJSON(json: Record<string, unknown>): Coin
    value: number
    script: Script
    hash: Buffer
    index: number
  }

  export class Outpoint {
    constructor(hash: Buffer, index: number)
    hash: Buffer
    index: number
    /** Conventional big-endian display form. */
    txid(): string
    toWriter(bw: unknown): void
    toRaw(): Buffer
  }

  export class Input {
    prevout: Outpoint
    script: Script
    sequence: number
  }

  export class KeyRing {
    static generate(): KeyRing
    static fromSecret(wif: string): KeyRing
    static fromPrivate(key: Buffer, compressed?: boolean): KeyRing
    privateKey: Buffer
    script: Script
    getPrivateKey(): Buffer
    getPublicKey(): Buffer
    getKeyHash(): Buffer
    getAddress(): Address
    toSecret(): string
  }

  export class TX {
    static fromRaw(data: Buffer): TX
    inputs: Input[]
    outputs: Output[]
    hash(): Buffer
    /** Conventional big-endian display form. */
    txid(): string
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

  export class MTX {
    constructor()
    static fromRaw(data: Buffer): MTX
    version: number
    locktime: number
    mutable: boolean
    height?: number
    inputs: Input[]
    outputs: Output[]
    view: unknown
    _hashPrevouts?: Buffer
    _hashSequence?: Buffer
    _hashOutputs?: Buffer
    addCoin(coin: Coin): void
    addOutput(script: Script | Address, value: number): void
    template(keyring: KeyRing): void
    /**
     * Prefers Schnorr: the implementation takes the Schnorr branch whenever it is
     * available, which is always. Anything that has to cross to Ethereum or satisfy
     * EcashTx.parseDER must sign via signatureHash + secp256k1.signDER instead.
     */
    signature(index: number, prev: Script, value: number, key: Buffer, type: number, flags?: number): Buffer
    // flags is genuinely optional: the runtime defaults it to STANDARD_VERIFY_FLAGS,
    // which already carries VERIFY_SIGHASH_FORKID and so takes the BIP143 path.
    signatureHash(index: number, prev: Script, value: number, type: number, flags?: number): Buffer
    scriptInput(index: number, coin: Coin, keyring: KeyRing): boolean
    signInput(index: number, coin: Coin, keyring: KeyRing, type?: number): boolean
    sign(keyring: KeyRing, type?: number): number
    txid(): string
    toTX(): TX
    toRaw(): Buffer
    check(flags?: number): void
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
      publicKeyCreate(privateKey: Buffer, compressed?: boolean): Buffer
      publicKeyConvert(pubkey: Buffer, compressed: boolean): Buffer
      /** Message first. See this file's own header before changing this order. */
      signDER(msg: Buffer, key: Buffer): Buffer
      signRecoverable(hash: Buffer, privateKey: Buffer): [Buffer, number]
      signRecoverableDER(hash: Buffer, privateKey: Buffer): [Buffer, number]
      /** Message first, then signature, then key -- NOT (sig, msg, key). */
      verifyDER(msg: Buffer, sig: Buffer, key: Buffer): boolean
      recover(msg: Buffer, sig: Buffer, param: number, compressed?: boolean): Buffer
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
