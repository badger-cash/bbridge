export interface TokenMetadata {
  tokenTicker: string
  tokenName: string
  tokenUrl: string
  tokenDocHash: Buffer
  decimals: number
  genesisQuantity: number
}

/** Sats required to fund a genesis transaction's input at the oracle's "in"/"genesis" address. */
export const GENESIS_TX_SATS = 4800

/** Sats required to fund an oracle "in" attestation's input at the oracle's "in" address. */
export const ORACLE_TX_SATS = 4300

/** Sats of the covenant-locked "stamp" output an oracle "in" attestation creates for the minter to spend. */
export const STAMP_TX_SATS = 3700

/** Standard SLP dust value for a token-carrying output (matches BridgeLock.sol's SLP_DUST_SATS). */
export const SLP_DUST_SATS = 546

export const TOKEN_INFO: Record<string, TokenMetadata> = {
  USDT: {
    tokenTicker: 'USDT',
    tokenName: 'Tether USD',
    tokenUrl: 'https://tether.to',
    tokenDocHash: Buffer.from('2f1c5c2b44f771e942a8506148e256f94f1a464babc938ae0690c6e34cd79190', 'hex'),
    decimals: 6,
    genesisQuantity: 0
  },
  USDC: {
    tokenTicker: 'USDC',
    tokenName: 'USD Coin',
    tokenUrl: 'https://www.circle.com/usdc',
    tokenDocHash: Buffer.from('e7e0fe390354509cd08c9a0168536938600ddc552b3f7cb96030ebef62e75895', 'hex'),
    decimals: 6,
    genesisQuantity: 0
  }
}
