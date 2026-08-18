import { fullRangeTicks, neededMintSide, tickToPrice } from './math'
import {
  getCoinQuote,
  poolPriceToCoinPrice,
  ticksFromCoinPrices,
  type PoolInfo,
  type TokenMeta,
} from './lp'
import { distributeIntegerAmount, dlmmShapeWeight } from './dlmmDistribution'

export type DlmmSide = 'bid' | 'ask' | 'both'
export type DlmmShape = 'spot' | 'curve' | 'bid-ask'
export type DlmmExecutionMode = 'single' | 'multi'

/**
 * EVM 版 DLMM 映射：一个「Bin」等于一个可用 tickSpacing 区间。
 *
 * Uniswap V3/V4 并不是 Meteora 的离散 constant-sum bin，因此这里不会伪造
 * 动态费率或零滑点语义；它只负责把相同的 Bid / Ask 操作方式安全映射成
 * 一个或多个 V3/V4 集中流动性仓位。只填报价币时是 Bid，只填标的币
 * 时是 Ask；两边都填时允许范围跨过现价。
 */
export type EvmDlmmPlan = {
  side: DlmmSide
  tickLower: number
  tickUpper: number
  coinPriceLower: number
  coinPriceUpper: number
  coinSpot: number
  coin: TokenMeta
  quote: TokenMeta
  depositToken: TokenMeta | null
  depositTokenIndex: 0 | 1 | 'both'
  binCount: number
  gapBins: number
  rangeLowerPct: number
  rangeUpperPct: number
  /** 一个 tickSpacing 对应的近似价格步长（bps） */
  effectiveBinStepBps: number
}

/**
 * One on-chain NFT band. A band may group several visual bins so a 69-bin
 * strategy does not create 69 NFTs and exceed practical block gas limits.
 */
export type EvmDlmmTranche = {
  index: number
  tickLower: number
  tickUpper: number
  coinPriceLower: number
  coinPriceUpper: number
  virtualBinStart: number
  virtualBinEnd: number
  virtualBinCount: number
  distanceFromSpot: number
  liquiditySide: 0 | 1 | 'both'
  weightUnits: number
  weightPct: number
}

function tokenIndex(pool: PoolInfo, token: TokenMeta): 0 | 1 {
  return pool.token0.address.toLowerCase() === token.address.toLowerCase() ? 0 : 1
}

function finiteInt(raw: number, min: number, max: number): number {
  if (!Number.isFinite(raw)) return min
  return Math.min(max, Math.max(min, Math.floor(raw)))
}

function planFromTicks(
  pool: PoolInfo,
  tickLower: number,
  tickUpper: number,
  expectedSide?: DlmmSide,
  requestedBinCount?: number,
  requestedGapBins?: number,
): EvmDlmmPlan {
  const spacing = Math.max(1, Math.floor(pool.tickSpacing || 1))
  const usable = fullRangeTicks(spacing)
  if (
    tickLower < usable.tickLower
    || tickUpper > usable.tickUpper
    || tickLower >= tickUpper
    || tickLower % spacing !== 0
    || tickUpper % spacing !== 0
  ) throw new Error('价格范围没有对齐池的可用 tick')

  const cq = getCoinQuote(pool)
  if (!(cq.spot > 0) || !Number.isFinite(cq.spot)) throw new Error('当前池价不可用')
  const quoteIndex = tokenIndex(pool, cq.quote)
  const need = neededMintSide(pool.tick, tickLower, tickUpper)
  const side: DlmmSide = need === 'both'
    ? 'both'
    : need === quoteIndex
      ? 'bid'
      : 'ask'
  if (expectedSide && side !== expectedSide) {
    if (expectedSide === 'bid') throw new Error('Bid 价格范围必须完整位于现价下方')
    if (expectedSide === 'ask') throw new Error('Ask 价格范围必须完整位于现价上方')
    throw new Error('双边价格范围必须覆盖当前价格')
  }

  const rawLower = tickToPrice(tickLower, pool.token0.decimals, pool.token1.decimals)
  const rawUpper = tickToPrice(tickUpper, pool.token0.decimals, pool.token1.decimals)
  const displayA = poolPriceToCoinPrice(rawLower, cq.invert)
  const displayB = poolPriceToCoinPrice(rawUpper, cq.invert)
  const coinPriceLower = Math.min(displayA, displayB)
  const coinPriceUpper = Math.max(displayA, displayB)
  const actualBins = Math.max(1, Math.round((tickUpper - tickLower) / spacing))
  // A user-selected price range can span far more than 1,400 raw Uniswap
  // tickSpacing steps (especially a 1-tick pool). We still group it into at
  // most 12 on-chain NFTs, so retaining the full span does not create a huge
  // transaction or a large in-memory array.
  const binCount = requestedBinCount == null
    ? actualBins
    : finiteInt(requestedBinCount, 1, 1_400)
  const gapBins = finiteInt(
    requestedGapBins ?? (need === 'both'
      ? 0
      : need === 0
        ? Math.max(0, Math.floor((tickLower - pool.tick) / spacing))
        : Math.max(0, Math.floor((pool.tick - tickUpper) / spacing))),
    0,
    1_400,
  )
  const rangeLowerPct = ((coinPriceLower / cq.spot) - 1) * 100
  const rangeUpperPct = ((coinPriceUpper / cq.spot) - 1) * 100

  return {
    side,
    tickLower,
    tickUpper,
    coinPriceLower,
    coinPriceUpper,
    coinSpot: cq.spot,
    coin: cq.coin,
    quote: cq.quote,
    depositToken: side === 'both' ? null : side === 'bid' ? cq.quote : cq.coin,
    depositTokenIndex: side === 'both' ? 'both' : need,
    binCount,
    gapBins,
    rangeLowerPct,
    rangeUpperPct,
    effectiveBinStepBps: Math.expm1(spacing * Math.log(1.0001)) * 10_000,
  }
}

export function buildEvmDlmmPlan(
  pool: PoolInfo,
  side: Exclude<DlmmSide, 'both'>,
  rawBinCount: number,
  rawGapBins: number,
): EvmDlmmPlan {
  const spacing = Math.max(1, Math.floor(pool.tickSpacing || 1))
  // Meteora Dynamic Position 的交互上限是 1,400 bins；EVM 侧仍会再受
  // Uniswap min/max usable tick 约束，超界时给出明确错误。
  const binCount = finiteInt(rawBinCount, 1, 1_400)
  const gapBins = finiteInt(rawGapBins, 0, 1_400)
  const cq = getCoinQuote(pool)
  if (!(cq.spot > 0) || !Number.isFinite(cq.spot)) throw new Error('当前池价不可用')

  // Bid 用报价币在现价下方接标的；Ask 用标的币在现价上方卖出。
  const depositToken = side === 'bid' ? cq.quote : cq.coin
  const depositTokenIndex = tokenIndex(pool, depositToken)
  const activeFloor = Math.floor(pool.tick / spacing) * spacing

  let tickLower: number
  let tickUpper: number
  if (depositTokenIndex === 0) {
    // 现价低于区间时，V3/V4 仓位全部是 token0。
    tickLower = activeFloor + (gapBins + 1) * spacing
    tickUpper = tickLower + binCount * spacing
  } else {
    // 现价高于（或等于）区间时，V3/V4 仓位全部是 token1。
    tickUpper = activeFloor - gapBins * spacing
    tickLower = tickUpper - binCount * spacing
  }

  const usable = fullRangeTicks(spacing)
  if (tickLower < usable.tickLower || tickUpper > usable.tickUpper) {
    throw new Error('所选 Bin 范围超出协议可用价格边界，请减少 Bin 数或起点距离')
  }
  if (tickLower >= tickUpper) throw new Error('Bin 范围无效')

  const need = neededMintSide(pool.tick, tickLower, tickUpper)
  if (need !== depositTokenIndex) {
    throw new Error('区间取整后不再是单边仓位，请增加 1 个起点距离 Bin')
  }

  return planFromTicks(pool, tickLower, tickUpper, side, binCount, gapBins)
}

/** Build a fixed price range in the user's coin/quote orientation. */
export function buildEvmDlmmPricePlan(
  pool: PoolInfo,
  coinPriceLower: number,
  coinPriceUpper: number,
  expectedSide?: DlmmSide,
): EvmDlmmPlan {
  const cq = getCoinQuote(pool)
  if (expectedSide === 'bid' && coinPriceUpper >= cq.spot) {
    throw new Error('Bid 价格范围必须完整位于现价下方')
  }
  if (expectedSide === 'ask' && coinPriceLower <= cq.spot) {
    throw new Error('Ask 价格范围必须完整位于现价上方')
  }
  if (expectedSide === 'both' && !(coinPriceLower < cq.spot && coinPriceUpper > cq.spot)) {
    throw new Error('双边价格范围必须覆盖当前价格')
  }

  const ticks = ticksFromCoinPrices(pool, coinPriceLower, coinPriceUpper)
  const spacing = Math.max(1, Math.floor(pool.tickSpacing || 1))
  const activeFloor = Math.floor(pool.tick / spacing) * spacing
  const quoteIndex = tokenIndex(pool, cq.quote)
  let tickLower = ticks.tickLower
  let tickUpper = ticks.tickUpper

  // A 0.1% near edge can round onto the active tick in a wide-spacing pool.
  // Nudge only the aligned boundary (never the user's raw side choice) so the
  // resulting Bid/Ask remains genuinely single-sided.
  if (expectedSide === 'both') {
    tickLower = Math.min(tickLower, activeFloor)
    tickUpper = Math.max(tickUpper, activeFloor + spacing)
  } else if (expectedSide) {
    const required = expectedSide === 'bid' ? quoteIndex : quoteIndex === 0 ? 1 : 0
    if (required === 0) tickLower = Math.max(tickLower, activeFloor + spacing)
    else tickUpper = Math.min(tickUpper, activeFloor)
    if (tickLower >= tickUpper) {
      if (required === 0) tickUpper = tickLower + spacing
      else tickLower = tickUpper - spacing
    }
  }
  return planFromTicks(pool, tickLower, tickUpper, expectedSide)
}

/** Build from percentages around the current displayed coin price. */
export function buildEvmDlmmPercentPlan(
  pool: PoolInfo,
  lowerPct: number,
  upperPct: number,
  expectedSide?: DlmmSide,
): EvmDlmmPlan {
  const cq = getCoinQuote(pool)
  if (!(cq.spot > 0)) throw new Error('当前池价不可用')
  const lower = cq.spot * (1 + lowerPct / 100)
  const upper = cq.spot * (1 + upperPct / 100)
  if (!(lower > 0) || !(upper > lower)) throw new Error('请输入有效的价格下限和上限')
  return buildEvmDlmmPricePlan(pool, lower, upper, expectedSide)
}

/** Keep the chosen absolute range while refreshing the live pool price. */
export function refreshEvmDlmmPlan(pool: PoolInfo, previous: EvmDlmmPlan): EvmDlmmPlan {
  return planFromTicks(pool, previous.tickLower, previous.tickUpper, previous.side)
}

export function buildEvmDlmmTranches(
  pool: PoolInfo,
  plan: EvmDlmmPlan,
  shape: DlmmShape,
  rawTrancheCount: number,
): EvmDlmmTranche[] {
  const spacing = Math.max(1, Math.floor(pool.tickSpacing || 1))
  const trancheCount = finiteInt(rawTrancheCount, 1, Math.min(12, plan.binCount))
  const cq = getCoinQuote(pool)
  const rows: EvmDlmmTranche[] = []

  for (let index = 0; index < trancheCount; index += 1) {
    const startBin = Math.floor((index * plan.binCount) / trancheCount)
    const endBin = Math.floor(((index + 1) * plan.binCount) / trancheCount)
    const tickLower = plan.tickLower + startBin * spacing
    const tickUpper = plan.tickLower + endBin * spacing
    if (tickUpper <= tickLower) continue
    const rawLower = tickToPrice(tickLower, pool.token0.decimals, pool.token1.decimals)
    const rawUpper = tickToPrice(tickUpper, pool.token0.decimals, pool.token1.decimals)
    const displayLower = poolPriceToCoinPrice(rawLower, cq.invert)
    const displayUpper = poolPriceToCoinPrice(rawUpper, cq.invert)
    rows.push({
      index,
      tickLower,
      tickUpper,
      coinPriceLower: Math.min(displayLower, displayUpper),
      coinPriceUpper: Math.max(displayLower, displayUpper),
      virtualBinStart: startBin + 1,
      virtualBinEnd: endBin,
      virtualBinCount: endBin - startBin,
      distanceFromSpot: 0,
      liquiditySide: neededMintSide(pool.tick, tickLower, tickUpper),
      weightUnits: 0,
      weightPct: 0,
    })
  }

  const containing = rows.findIndex((row) => row.liquiditySide === 'both')
  const anchor = containing >= 0
    ? containing
    : pool.tick < (rows[0]?.tickLower ?? pool.tick)
      ? 0
      : Math.max(0, rows.length - 1)
  const maxDistance = Math.max(anchor, rows.length - 1 - anchor, 1)
  const weighted = rows.map((row, index) => {
    const distanceFromSpot = Math.abs(index - anchor)
    return {
      ...row,
      distanceFromSpot,
      weightUnits: dlmmShapeWeight(shape, distanceFromSpot, maxDistance),
    }
  })
  const totalWeight = weighted.reduce((sum, row) => sum + row.weightUnits, 0)
  return weighted.map((row) => ({
    ...row,
    weightPct: totalWeight > 0 ? (row.weightUnits / totalWeight) * 100 : 0,
  }))
}

/** Exact integer allocation: all tranche amounts add back to total. */
export function allocateDlmmAmount(
  total: bigint,
  tranches: readonly EvmDlmmTranche[],
): bigint[] {
  return distributeIntegerAmount(total, tranches.map((row) => row.weightUnits))
}

/**
 * Allocate token0 and token1 independently, exactly like a ladder builder:
 * each token is shared only between bands that can currently accept it.
 */
export function allocateDlmmAmounts(
  total0: bigint,
  total1: bigint,
  tranches: readonly EvmDlmmTranche[],
): Array<{ amount0: bigint; amount1: bigint }> {
  const amount0 = distributeIntegerAmount(
    total0,
    tranches.map((row) => (row.liquiditySide === 0 || row.liquiditySide === 'both' ? row.weightUnits : 0)),
  )
  const amount1 = distributeIntegerAmount(
    total1,
    tranches.map((row) => (row.liquiditySide === 1 || row.liquiditySide === 'both' ? row.weightUnits : 0)),
  )
  return tranches.map((_, index) => ({
    amount0: amount0[index] ?? 0n,
    amount1: amount1[index] ?? 0n,
  }))
}
