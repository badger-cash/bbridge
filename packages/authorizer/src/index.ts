export {
  DEPOSIT_STATES,
  vaultUtxoMayExist,
  authorizationMayExist,
  refundForeclosed,
  canTransition,
  assertTransition
} from './states'
export type { DepositState } from './states'

export { validateConfig, ConfigError, dollarMinBurnAmount } from './config'
export type { AuthorizerConfig } from './config'

export { deriveVaultAddress, vaultOutputValue } from './deposit/vault'
export {
  hash256,
  toXecAmount,
  txidToInternal,
  buildAuthorization,
  signAuthorization,
  assertLowS
} from './deposit/authorization'
export type { Authorization, AuthorizationInput, SignedAuthorization } from './deposit/authorization'

export {
  collateralToXecUnits,
  computeHeadroom,
  assertHeadroomSolvent,
  assertIssuanceAllowed,
  issuanceFits,
  reserveIssuance,
  reconcileHeadroom,
  HeadroomError,
  InsolventError
} from './issuance/headroom'

export { parseBurnOpReturn, assetIdForAddress, BurnFormatError } from './withdrawal/burnOpReturn'
export type { BurnOpReturn } from './withdrawal/burnOpReturn'

export { coSignPostage, requiredStampSats, PostageError } from './withdrawal/postage'
export type { PostageDeps, PostageResult, PostageRefusal } from './withdrawal/postage'

export {
  applyEvent,
  scan,
  tick,
  advanceObserved,
  advanceDepthMet,
  advanceFundingPrepared,
  advanceAuthorized,
  advanceConfirmSent,
  advanceConfirmedFinal,
  advanceFundingBroadcast
} from './deposit/pipeline'
export type { DepositPipelineDeps } from './deposit/pipeline'

export { BroadcastRejectedError } from './ports'

export type {
  BridgeEvent,
  DepositLockedEvent,
  RefundRequestedEvent,
  RefundRequestCancelledEvent,
  DepositRefundedEvent,
  DepositConfirmedEvent,
  OnChainDeposit,
  OnChainDepositStatus,
  EthereumReader,
  EthereumWriter,
  Coin,
  EcashClient,
  BurnValidity,
  SlpValidator,
  EcdsaSignature,
  Signer,
  DepositRecord,
  Store,
  StampSource,
  ReserveWallet,
  FundingTx,
  Minter,
  Logger
} from './ports'
