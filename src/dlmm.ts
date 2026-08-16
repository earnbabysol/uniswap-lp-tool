import { fullRangeTicks, neededMintSide, tickToPrice } from './math'
import {
  getCoinQuote,
  poolPriceToCoinPrice,
  type PoolInfo,
  type TokenMeta,
} from './lp'
import { distributeIntegerAmount, dlmmShapeWeight } from './dlmmDistribution'

export type DlmmSide = 'bid' | 'ask'
export type DlmmShape = 'spot' | 'curve' | 'bid-ask'
export type DlmmExecutionMode = 'single' | 'multi'

/**
 * EVM 版 DLMM 映射：一个「Bin」等于一个可用 tickSpacing 区间。
 *
 * Uniswap V3/V4 并不是 Meteora 的离散 constant-sum bin，因此这里不会伪造
 * 动态费率或零滑点语义；它只负责把相同的 Bid / Ask 操作方式安全映射成
 * 一个完全位于现价下方或上方的单边集中流动性仓位。
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
  depositToken: TokenMeta
  depositTokenIndex: 0 | 1
  binCount: number
  gapBins: number
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

export function buildEvmDlmmPlan(
  pool: PoolInfo,
  side: DlmmSide,
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

  const rawLower = tickToPrice(tickLower, pool.token0.decimals, pool.token1.decimals)
  const rawUpper = tickToPrice(tickUpper, pool.token0.decimals, pool.token1.decimals)
  const displayA = poolPriceToCoinPrice(rawLower, cq.invert)
  const displayB = poolPriceToCoinPrice(rawUpper, cq.invert)
  const effectiveBinStepBps = Math.expm1(spacing * Math.log(1.0001)) * 10_000

  return {
    side,
    tickLower,
    tickUpper,
    coinPriceLower: Math.min(displayA, displayB),
    coinPriceUpper: Math.max(displayA, displayB),
    coinSpot: cq.spot,
    coin: cq.coin,
    quote: cq.quote,
    depositToken,
    depositTokenIndex,
    binCount,
    gapBins,
    effectiveBinStepBps,
  }
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
    const distanceFromSpot = plan.depositTokenIndex === 0
      ? index
      : trancheCount - 1 - index
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
      distanceFromSpot,
      weightUnits: dlmmShapeWeight(shape, distanceFromSpot, trancheCount),
      weightPct: 0,
    })
  }

  const totalWeight = rows.reduce((sum, row) => sum + row.weightUnits, 0)
  return rows.map((row) => ({
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
