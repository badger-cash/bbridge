/*
 * The mint vault: where a deposit's authorized tokens are minted from.
 *
 * The vault is the self-mint covenant's own P2SH address, parameterized by the
 * Authorizer's public key (SPEC.md Section II). Every vault UTXO is created on
 * demand by a quarantined funding transaction -- there is no standing pool at this
 * address, and a coin sitting here in advance could never legitimately back a
 * confirmation (authorizer-spec.md §4.1).
 */
import { mintCovenantV2, SLP_DUST_SATS } from '@bbridge/sdk'
import { Address } from '@hansekontor/checkout-components'

/**
 * The vault's P2SH address for a given Authorizer public key.
 *
 * This must equal the `mint_vault_scripthash` committed in the token's GENESIS
 * transaction. It is derived rather than configured so it cannot drift from the
 * key the service actually signs with -- a mismatch would produce mints that XEC
 * accepts but no SLP indexer credits, which is worse than an outright failure.
 */
export function deriveVaultAddress(authPublicKey: Buffer): string {
  return Address.fromScripthash(mintCovenantV2(authPublicKey).hash160()).toString()
}

/**
 * Sats to put in the vault output.
 *
 * The mint spending it produces no change (SPEC.md Section III.6 step 4) and has no
 * other input, so this single value is the entire budget for both the dust output
 * paying the recipient and the mint's own miner fee. Underfunding produces a
 * confirmed, irreversible deposit whose mint cannot pay its own way.
 *
 * `mintFeeSats` is a configured estimate rather than something computable here: the
 * covenant spend's witness carries the BIP143 preimage, the authorization message and
 * two signatures, so it is far larger than a P2PKH input and its size depends on
 * deployment-specific script parameters.
 */
export function vaultOutputValue(mintFeeSats: number): number {
  return SLP_DUST_SATS + mintFeeSats
}
