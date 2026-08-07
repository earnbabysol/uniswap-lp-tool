export type V3AccountingEvent<T = unknown> = {
  kind: 'decrease' | 'collect'
  amount0: bigint
  amount1: bigint
  blockNumber: bigint
  logIndex?: number
  source?: T
}

export type V3CollectBreakdown<T = unknown> = {
  source?: T
  principal0: bigint
  principal1: bigint
  fee0: bigint
  fee1: bigint
}

/** Position-level cashflow return; claimed fees are already inside cashOut and must not be added twice. */
export function computePositionPnlUsd(
  currentAssetsUsd: number,
  cashOutUsd: number,
  cashInUsd: number,
): number {
  return currentAssetsUsd + cashOutUsd - cashInUsd
}

/**
 * Uniswap V3 的 Decrease 只把本金记入 tokensOwed；Collect 才把资产移出仓位。
 * 这里按链上日志顺序消费「待领取本金」，避免用全历史 ΣCollect−ΣDecrease 时，
 * 后发生的减仓错误地倒扣先前已经领取的手续费。
 */
export function buildV3AccountingLedger<T>(events: V3AccountingEvent<T>[]) {
  const ordered = [...events].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1
    return (a.logIndex ?? Number.MAX_SAFE_INTEGER) - (b.logIndex ?? Number.MAX_SAFE_INTEGER)
  })

  let collected0 = 0n
  let collected1 = 0n
  let outstandingPrincipal0 = 0n
  let outstandingPrincipal1 = 0n
  let claimedFees0 = 0n
  let claimedFees1 = 0n
  const collects: V3CollectBreakdown<T>[] = []

  for (const event of ordered) {
    if (event.kind === 'decrease') {
      outstandingPrincipal0 += event.amount0
      outstandingPrincipal1 += event.amount1
      continue
    }

    collected0 += event.amount0
    collected1 += event.amount1
    const principal0 = event.amount0 < outstandingPrincipal0
      ? event.amount0
      : outstandingPrincipal0
    const principal1 = event.amount1 < outstandingPrincipal1
      ? event.amount1
      : outstandingPrincipal1
    outstandingPrincipal0 -= principal0
    outstandingPrincipal1 -= principal1
    const fee0 = event.amount0 - principal0
    const fee1 = event.amount1 - principal1
    claimedFees0 += fee0
    claimedFees1 += fee1
    collects.push({ source: event.source, principal0, principal1, fee0, fee1 })
  }

  return {
    collected0,
    collected1,
    outstandingPrincipal0,
    outstandingPrincipal1,
    claimedFees0,
    claimedFees1,
    collects,
  }
}
