import assert from 'node:assert/strict'
import {
  CHAIN_CONFIGS,
  SUPPORTED_CHAINS,
  isSupportedChainId,
} from '../src/chain.ts'
import { FLOW_CHAIN_IDS } from '../src/flowEvents.ts'

const arbitrum = CHAIN_CONFIGS[42161]

assert.equal(isSupportedChainId(42161), true)
assert.equal(arbitrum.key, 'arbitrum')
assert.equal(arbitrum.label, 'Arbitrum One')
assert.equal(arbitrum.chain.nativeCurrency.symbol, 'ETH')
assert.equal(
  arbitrum.contracts.v3Npm.toLowerCase(),
  '0xc36442b4a4522e871399cd717abdd847ab11fe88',
)
assert.equal(
  arbitrum.contracts.v4PoolManager.toLowerCase(),
  '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
)
assert.equal(
  arbitrum.contracts.v4PositionManager.toLowerCase(),
  '0xd88f38f930b7952f2db2432cb002e7abbf3dd869',
)
assert.equal(
  arbitrum.defaultTokenA.toLowerCase(),
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
)
assert.ok(SUPPORTED_CHAINS.some((chain) => chain.id === 42161))

assert.deepEqual([...FLOW_CHAIN_IDS], [56, 4663, 8453])
assert.equal(FLOW_CHAIN_IDS.includes(42161), false)

console.log('chain configuration tests passed')
