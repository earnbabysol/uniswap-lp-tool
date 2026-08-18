import assert from 'node:assert/strict'
import {
  chooseDlmmAutoNftCount,
  mergeEvmDlmmTranches,
} from '../src/dlmm.ts'

assert.equal(chooseDlmmAutoNftCount({ version: 'v3', visualBinCount: 40 }), 12)
assert.equal(chooseDlmmAutoNftCount({ version: 'v4', visualBinCount: 40 }), 10)
assert.equal(chooseDlmmAutoNftCount({
  version: 'v3',
  visualBinCount: 40,
  gasPriceWei: 100_000_000n,
}), 16)
assert.equal(chooseDlmmAutoNftCount({
  version: 'v3',
  visualBinCount: 40,
  gasPriceWei: 20_000_000_000n,
}), 8)
assert.equal(chooseDlmmAutoNftCount({ version: 'v4', visualBinCount: 6 }), 6)

const token0 = { address: '0x1111111111111111111111111111111111111111', symbol: 'COIN', decimals: 18 }
const token1 = { address: '0x2222222222222222222222222222222222222222', symbol: 'USD', decimals: 6 }
const pool = {
  version: 'v3',
  poolAddress: '0x3333333333333333333333333333333333333333',
  token0,
  token1,
  fee: 3000,
  tickSpacing: 10,
  tick: -10,
  sqrtPriceX96: 1n,
  price: 1,
  liquidity: 1n,
}
const visual = Array.from({ length: 40 }, (_, index) => ({
  index,
  tickLower: index * 10,
  tickUpper: (index + 1) * 10,
  coinPriceLower: index + 1,
  coinPriceUpper: index + 2,
  virtualBinStart: index + 1,
  virtualBinEnd: index + 1,
  virtualBinCount: 1,
  distanceFromSpot: index,
  liquiditySide: 0,
  weightUnits: index + 1,
  weightPct: (index + 1) / 8.2,
}))
const allocations = visual.map((_, index) => ({
  amount0: BigInt(index + 1),
  amount1: BigInt((index + 1) * 2),
}))
const merged = mergeEvmDlmmTranches(pool, visual, allocations, 12)
assert.equal(merged.tranches.length, 12)
assert.equal(merged.allocations.length, 12)
assert.equal(merged.tranches[0].tickLower, 0)
assert.equal(merged.tranches.at(-1).tickUpper, 400)
for (let index = 1; index < merged.tranches.length; index += 1) {
  assert.equal(merged.tranches[index - 1].tickUpper, merged.tranches[index].tickLower)
}
assert.equal(
  merged.allocations.reduce((sum, row) => sum + row.amount0, 0n),
  allocations.reduce((sum, row) => sum + row.amount0, 0n),
)
assert.equal(
  merged.allocations.reduce((sum, row) => sum + row.amount1, 0n),
  allocations.reduce((sum, row) => sum + row.amount1, 0n),
)

const exact = mergeEvmDlmmTranches(pool, visual, allocations, 40)
assert.equal(exact.tranches.length, 40)
assert.deepEqual(exact.allocations, allocations)

console.log('dlmm layout tests passed')
