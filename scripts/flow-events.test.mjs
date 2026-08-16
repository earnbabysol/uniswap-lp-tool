import assert from 'node:assert/strict'
import { takeFlowPoolEvents } from '../src/flowSelection.ts'

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

console.log('flow event selection tests passed')
