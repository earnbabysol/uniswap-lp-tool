import assert from 'node:assert/strict'
import { distributeIntegerAmount, dlmmShapeWeight } from '../src/dlmmDistribution.ts'

assert.deepEqual(
  [0, 1, 2].map((distance) => dlmmShapeWeight('spot', distance, 2)),
  [1_000_000, 1_000_000, 1_000_000],
)
assert.deepEqual(
  [0, 1, 2].map((distance) => dlmmShapeWeight('curve', distance, 2)),
  [1_000_000, 666_667, 333_333],
)
assert.deepEqual(
  [0, 1, 2].map((distance) => dlmmShapeWeight('bid-ask', distance, 2)),
  [20_000, 500_000, 1_000_000],
)

const equal = distributeIntegerAmount(100n, [1, 1, 1])
assert.deepEqual(equal, [33n, 33n, 34n])
assert.equal(equal.reduce((sum, amount) => sum + amount, 0n), 100n)

const bidAsk = distributeIntegerAmount(10_000n, [20_000, 500_000, 1_000_000])
assert.equal(bidAsk.reduce((sum, amount) => sum + amount, 0n), 10_000n)
assert.ok(bidAsk[2] > bidAsk[1] && bidAsk[1] > bidAsk[0])

console.log('dlmm distribution tests passed')
