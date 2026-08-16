import assert from 'node:assert/strict'
import {
  classifyRpcError,
  mapWithConcurrency,
  readLogsAdaptive,
  resetRpcScheduler,
  rpcBackoffMs,
  shouldSplitLogRange,
} from '../src/rpcScheduler.ts'

assert.equal(classifyRpcError(new Error('HTTP 429 Too Many Requests')), 'rate-limit')
assert.equal(classifyRpcError(new Error('Request exceeds defined limit')), 'range-limit')
assert.equal(classifyRpcError(new Error('An unknown RPC error occurred.')), 'unknown-rpc')
assert.equal(classifyRpcError(new Error('plain revert')), 'other')
assert.equal(shouldSplitLogRange(new Error('Request exceeds defined limit')), true)
assert.equal(shouldSplitLogRange(new Error('HTTP 429')), false)
assert.equal(rpcBackoffMs(56, 0, 'rate-limit', 0), 1105)
assert.equal(rpcBackoffMs(4663, 1, 'network', 0), 700)

resetRpcScheduler()
const requested = []
const blocks = await readLogsAdaptive({
  chainId: 4663,
  fromBlock: 0n,
  toBlock: 7n,
  maxSpan: 8n,
  minSpan: 1n,
  request: async (from, to) => {
    requested.push([from, to])
    if (to - from + 1n > 2n) throw new Error('Request exceeds defined limit')
    return Array.from({ length: Number(to - from + 1n) }, (_, i) => from + BigInt(i))
  },
})
assert.deepEqual(blocks, [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n])
assert.ok(requested.some(([from, to]) => from === 0n && to === 7n))

let active = 0
let peak = 0
await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
  active += 1
  peak = Math.max(peak, active)
  await new Promise((resolve) => setTimeout(resolve, 5))
  active -= 1
  return value * 2
})
assert.equal(peak, 2)

console.log('rpc scheduler tests passed')
