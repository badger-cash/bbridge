export { GENESIS_TX_SATS, ORACLE_TX_SATS, STAMP_TX_SATS, SLP_DUST_SATS, TOKEN_INFO } from './constants'
export type { TokenMetadata } from './constants'

export {
  buildInOracle,
  parseInOracle,
  buildOutOracle,
  parseOutOracle,
  parseOracle,
  buildInOpReturn,
  buildOutOpReturn,
  buildMintOpReturnV2,
  buildGenesisOpReturnV2,
  buildPreImage,
  mintOutscript,
  // Deposit-authorization surface, required by @bbridge/authorizer: the message
  // BridgeLock._authorizationDigest signs, the output list it commits to, and the
  // covenant whose P2SH address the vault UTXO must be funded to.
  buildAuthorizationMessage,
  buildMintV2TxOutputs,
  mintCovenantV2
} from './script'
export type { InOracleContent, OutOracleContent, OracleContent, PreImageResult } from './script'

export { PreimageMTX } from './preimage'

export { buildMerkleProof, verifyMerkleProof } from './merkle'
export type { MerkleProof } from './merkle'

export {
  buildOracleInTx,
  buildOracleOutTx,
  fundOracleTx,
  buildOracleTx,
  toOracleRing,
  getOracleScriptType,
  getOracleRingType,
  parseOracleTx,
  buildMintTx,
  buildGenesisTx
} from './oracle'
export type {
  OracleMessageType,
  OracleScriptType,
  BridgeAssetConfig,
  OracleAttestationData,
  ParsedOracleTx,
  ParsedOracleInAttestation,
  ParsedOracleOutAttestation
} from './oracle'
