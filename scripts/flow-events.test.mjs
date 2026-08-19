import assert from 'node:assert/strict'
import {
  FLOW_SELECTABLE_CHAIN_IDS,
  parseFlowChainSelection,
  takeFlowPoolEvents,
  toggleFlowChainSelection,
} from '../src/flowSelection.ts'
import {
  FLOW_SHARED_INDEX_FRESH_MS,
  isSharedFlowIndexFresh,
} from '../src/flowIndex.ts'
import {
  FLOW_DEFAULT_MIN_APR,
  FLOW_DEFAULT_MIN_USD,
  FLOW_LIVE_REFRESH_COOLDOWN_MS,
  shouldThrottleAutomaticLiveRefresh,
} from '../src/flowMonitorConfig.ts'

const address = (suffix) => `0x${suffix.padStart(40, '0')}`
const hash = (suffix) => `0x${suffix.padStart(64, '0')}`
const makeEvent = ({ id, chainId = 4663, version = 'v3', pool, timestamp, amountUsd = 100 }) => ({
  id,
  chainId,
  version,
  side: 'in',
  timestamp,
  amountUsd,
  poolAddress: pool,
  poolId: version === 'v4' ? hash(pool.slice(-4)) : undefined,
  token0: address('a'),
  token1: address('b'),
  symbol0: 'A',
  symbol1: 'B',
  fee: 500,
  txHash: hash(id),
  source: 'logs',
})

const busyPool = address('1')
const events = Array.from({ length: 10 }, (_, index) => makeEvent({
  id: String(index + 1),
  pool: busyPool,
  timestamp: 100 - index,
}))
events.push(makeEvent({ id: '20', pool: address('2'), timestamp: 99 }))
events.push(makeEvent({ id: '30', pool: address('3'), timestamp: 98 }))

const selected = takeFlowPoolEvents(events, [4663], 2)
assert.equal(new Set(selected.map((event) => event.poolAddress)).size, 2)
assert.equal(selected.length, 11, 'all events for each selected pool must remain for net-flow aggregation')

const dual = [
  ...[1, 2, 3].map((n) => makeEvent({ id: `56${n}`, chainId: 56, pool: address(`56${n}`), timestamp: 200 - n })),
  ...[1, 2, 3].map((n) => makeEvent({ id: `46${n}`, chainId: 4663, pool: address(`46${n}`), timestamp: 100 - n })),
]
const balanced = takeFlowPoolEvents(dual, [56, 4663], 4)
assert.equal(balanced.filter((event) => event.chainId === 56).length, 2)
assert.equal(balanced.filter((event) => event.chainId === 4663).length, 2)

const fourChains = [
  ...[1, 2, 3].map((n) => makeEvent({ id: `e${n}`, chainId: 1, pool: address(`41${n}`), timestamp: 400 - n })),
  ...[1, 2, 3].map((n) => makeEvent({ id: `b${n}`, chainId: 56, pool: address(`156${n}`), timestamp: 300 - n })),
  ...[1, 2, 3].map((n) => makeEvent({ id: `r${n}`, chainId: 4663, pool: address(`246${n}`), timestamp: 200 - n })),
  ...[1, 2, 3].map((n) => makeEvent({ id: `a${n}`, chainId: 8453, pool: address(`384${n}`), timestamp: 100 - n })),
]
const allChains = takeFlowPoolEvents(fourChains, [...FLOW_SELECTABLE_CHAIN_IDS], 8)
assert.equal(allChains.filter((event) => event.chainId === 1).length, 2)
assert.equal(allChains.filter((event) => event.chainId === 56).length, 2)
assert.equal(allChains.filter((event) => event.chainId === 4663).length, 2)
assert.equal(allChains.filter((event) => event.chainId === 8453).length, 2)
const baseOnly = takeFlowPoolEvents(fourChains, [8453], 10)
assert.equal(baseOnly.length, 3)
assert.ok(baseOnly.every((event) => event.chainId === 8453))
assert.deepEqual(takeFlowPoolEvents(fourChains, [], 10), [])

assert.deepEqual(parseFlowChainSelection('[8453,1,1,999]'), [1, 8453])
assert.deepEqual(parseFlowChainSelection('bad json'), [1, 56, 4663, 8453])
assert.deepEqual(toggleFlowChainSelection([1, 8453], 1), [8453])
assert.deepEqual(toggleFlowChainSelection([8453], 8453), [8453], 'the last selected chain is retained')
assert.deepEqual(toggleFlowChainSelection([56], 1), [1, 56])

const now = 1_800_000_000_000
assert.equal(isSharedFlowIndexFresh(now - FLOW_SHARED_INDEX_FRESH_MS, now), true)
assert.equal(isSharedFlowIndexFresh(now - FLOW_SHARED_INDEX_FRESH_MS - 1, now), false)
assert.equal(isSharedFlowIndexFresh(Number.NaN, now), false)

assert.equal(FLOW_DEFAULT_MIN_USD, 30)
assert.equal(FLOW_DEFAULT_MIN_APR, 300)
assert.equal(shouldThrottleAutomaticLiveRefresh(null, now), false)
assert.equal(shouldThrottleAutomaticLiveRefresh(now - FLOW_LIVE_REFRESH_COOLDOWN_MS + 1, now), true)
assert.equal(shouldThrottleAutomaticLiveRefresh(now - FLOW_LIVE_REFRESH_COOLDOWN_MS, now), false)

console.log('flow event selection tests passed')
