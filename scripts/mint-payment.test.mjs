import assert from 'node:assert/strict'
import { chooseWrappedPoolPayment } from '../src/mintPayment.ts'

const choose = (overrides = {}) => chooseWrappedPoolPayment({
  nativeBalance: 0n,
  wrappedBalance: 0n,
  nativeStatus: 'ready',
  wrappedStatus: 'ready',
  gasReserve: 1_000_000_000_000_000n,
  ...overrides,
})

assert.equal(choose({ nativeBalance: 2_000_000_000_000_000n }), 'native')
assert.equal(choose({ wrappedBalance: 5n }), 'wrapped')
assert.equal(choose({ nativeBalance: 1n, wrappedBalance: 5n }), 'wrapped')
assert.equal(choose({ nativeStatus: 'error', wrappedBalance: 5n }), 'wrapped')
assert.equal(choose({ wrappedStatus: 'error' }), 'native')
assert.equal(choose(), 'native')
assert.equal(choose({ wrappedStatus: 'loading', wrappedBalance: 5n }), null)
assert.equal(choose({ nativeStatus: 'loading', nativeBalance: 5n }), null)

console.log('mint payment tests passed')
