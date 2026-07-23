import * as crypto from 'crypto'
import { Coin, Script, Address } from '@hansekontor/checkout-components'
import { BridgeAssetConfig } from '../src/oracle'

export const testConfig: BridgeAssetConfig = {
  networkId: 'ETH',
  assetId: 'dac17f958d2ee523a2206206994597c13d831ec7'
}

export function randomHash(): Buffer {
  return crypto.randomBytes(32)
}

export function coinForAddress(address: Address, value: number, hash: Buffer = randomHash(), index = 0): Coin {
  return new Coin({
    hash,
    index,
    value,
    script: Script.fromAddress(address)
  })
}
