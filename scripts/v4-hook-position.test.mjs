import assert from 'node:assert/strict'
import { zeroAddress } from 'viem'
import { poolKeyFromPosition, v4PoolKeysEqual } from '../src/v4.ts'

const hook = '0x4C4a6A14589dEbb95E57b0b38c8374D759eBa044'
const position = {
  version: 'v4',
  tokenId: 123n,
  token0: { address: zeroAddress, symbol: 'ETH', decimals: 18 },
  token1: {
    address: '0xFfFfFfFFfFFfFFfFFfFFFFFffFFFffffFfFFFfF',
    symbol: 'TOKEN',
    decimals: 18,
  },
  fee: 3_000,
  tickSpacing: 60,
  hooks: hook,
}

const key = poolKeyFromPosition(position)
assert.equal(key.hooks, hook, 'the NFT PoolKey must preserve its Hook address')
assert.equal(key.fee, 3_000, 'the NFT PoolKey must preserve its LP fee')
assert.equal(v4PoolKeysEqual(key, { ...key }), true)
assert.equal(
  v4PoolKeysEqual(key, { ...key, hooks: zeroAddress }),
  false,
  'a hookless PoolKey must be rejected for a Hook position',
)
assert.equal(
  v4PoolKeysEqual(key, { ...key, fee: 0 }),
  false,
  'a different LP fee must be rejected for the same position',
)

console.log('V4 Hook position PoolKey lock tests passed')
