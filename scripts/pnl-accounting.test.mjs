import assert from 'node:assert/strict'
import { buildV3AccountingLedger, computePositionPnlUsd } from '../src/pnlAccounting.ts'

const event = (kind, amount0, blockNumber, logIndex) => ({
  kind,
  amount0: BigInt(amount0),
  amount1: 0n,
  blockNumber: BigInt(blockNumber),
  logIndex,
})

// 已领取的手续费不能被后发生、尚未 Collect 的减仓倒扣。
{
  const row = buildV3AccountingLedger([
    event('collect', 10, 1, 1),
    event('decrease', 100, 2, 1),
  ])
  assert.equal(row.claimedFees0, 10n)
  assert.equal(row.outstandingPrincipal0, 100n)
  assert.equal(row.collected0, 10n)
}

// Decrease 后 Collect：先归还本金，超出部分才是已领取手续费。
{
  const row = buildV3AccountingLedger([
    event('collect', 110, 2, 2),
    event('decrease', 100, 2, 1),
  ])
  assert.equal(row.claimedFees0, 10n)
  assert.equal(row.outstandingPrincipal0, 0n)
  assert.equal(row.collects[0].principal0, 100n)
}

// 部分 Collect 后，剩余减仓本金仍属于当前资产，不是未领手续费。
{
  const row = buildV3AccountingLedger([
    event('decrease', 100, 1, 1),
    event('collect', 40, 2, 1),
  ])
  assert.equal(row.claimedFees0, 0n)
  assert.equal(row.outstandingPrincipal0, 60n)
}

// 复投：Collect 与 Increase 同时入账后，美元盈亏保持不变。
assert.equal(computePositionPnlUsd(110, 0, 100), 10)
assert.equal(computePositionPnlUsd(110, 10, 110), 10)

// 单纯领取：资产从仓位转到 cashOut，盈亏也保持不变。
assert.equal(computePositionPnlUsd(100, 10, 100), 10)

// Decrease 后未 Collect 的本金仍是当前资产；Collect 后移到 cashOut，总盈亏不变。
assert.equal(computePositionPnlUsd(100, 0, 100), 0)
assert.equal(computePositionPnlUsd(0, 100, 100), 0)

console.log('pnl accounting tests passed')
