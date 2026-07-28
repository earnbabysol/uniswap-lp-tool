/** Uniswap V3/V4 tick & price helpers (Q64.96) */

import { getSqrtRatioAtTick } from './tickMath'

export const Q96 = 2n ** 96n
export const Q128 = 2n ** 128n

export const tickToSqrtRatioX96 = getSqrtRatioAtTick

export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  return (a * b) / denominator
}

export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1)
}

/** 去掉小数尾部多余 0，保留真实有效数字 */
function trimPriceZeros(s: string): string {
  if (!s.includes('.')) return s
  const trimmed = s.replace(/0+$/, '').replace(/\.$/, '')
  return trimmed.length ? trimmed : '0'
}

/** Human price — 大数缩写，避免天文数字把 UI 撑爆 */
export function formatPrice(price: number, _digits = 6): string {
  if (!Number.isFinite(price) || price <= 0) return '—'
  // ≥ 1e12：科学计数（全区间上限常见）
  if (price >= 1e12) {
    return price.toExponential(2).replace('e+', 'e')
  }
  if (price >= 1e9) return `${trimPriceZeros((price / 1e9).toFixed(2))}B`
  if (price >= 1e6) return `${trimPriceZeros((price / 1e6).toFixed(2))}M`
  if (price >= 1000) {
    return price.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }
  /*
   * 1 ~ 1000 这一段以前直接给 6 位小数，于是 169.889103 —— 三位整数配六位小数
   * 是九位有效数字，价格区间读起来全是噪声。按量级继续往下铺台阶：
   *   ≥100 → 2 位（169.89）      ≥10 → 3 位（22.418）
   * 1 ~ 10 仍留 6 位，因为稳定币对就在这一段，1.000001 和 1.0 的差别不能被抹掉。
   */
  if (price >= 100) {
    return trimPriceZeros(price.toFixed(2))
  }
  if (price >= 10) {
    return trimPriceZeros(price.toFixed(3))
  }
  if (price >= 1) {
    return trimPriceZeros(price.toFixed(6))
  }
  // < 1：保证约 4 位有效数字的固定小数，例如 0.00008495
  const exp = Math.floor(Math.log10(price))
  const decimals = Math.min(18, Math.max(4, -exp + 3))
  return trimPriceZeros(price.toFixed(decimals))
}

export function priceToClosestTick(price: number, decimals0: number, decimals1: number): number {
  if (price <= 0) throw new Error('price must be > 0')
  const adjusted = price / Math.pow(10, decimals0 - decimals1)
  return Math.floor(Math.log(adjusted) / Math.log(1.0001))
}

/** 人类可读价（token1 per token0）→ Q64.96 sqrtPriceX96 */
export function priceToSqrtPriceX96(price: number, decimals0: number, decimals1: number): bigint {
  if (!(price > 0) || !Number.isFinite(price)) throw new Error('初始价格必须 > 0')
  const tick = priceToClosestTick(price, decimals0, decimals1)
  const clamped = Math.max(-887272, Math.min(887272, tick))
  return getSqrtRatioAtTick(clamped)
}

export function nearestUsableTick(tick: number, tickSpacing: number): number {
  const rounded = Math.round(tick / tickSpacing) * tickSpacing
  if (rounded < -887272) return Math.ceil(-887272 / tickSpacing) * tickSpacing
  if (rounded > 887272) return Math.floor(887272 / tickSpacing) * tickSpacing
  return rounded
}

/** Uniswap V3/V4 全区间（按 tickSpacing 对齐的最小/最大可用 tick） */
export function fullRangeTicks(tickSpacing: number): { tickLower: number; tickUpper: number } {
  const spacing = Math.max(1, Math.floor(Number(tickSpacing) || 1))
  const tickLower = nearestUsableTick(-887272, spacing)
  const tickUpper = nearestUsableTick(887272, spacing)
  if (tickLower >= tickUpper) throw new Error('tickSpacing 无效，无法构成全区间')
  return { tickLower, tickUpper }
}

/**
 * 相对现价设区间（有符号 %）：
 * - percentLower：下限相对市价，如 -70 → ×0.30；+5 → ×1.05
 * - percentUpper：上限相对市价，如 -3 → ×0.97；+10 → ×1.10
 * - 只传一个参数时：对称 ±pct（兼容旧调用）
 * - 整段低于市价 → 单边 token1；整段高于市价 → 单边 token0
 */
export function rangeFromPercent(
  currentTick: number,
  percentOrLower: number,
  tickSpacing: number,
  percentUpper?: number,
): { tickLower: number; tickUpper: number } {
  let loPct: number
  let hiPct: number
  if (percentUpper === undefined) {
    const p = Math.min(Math.max(Math.abs(Number(percentOrLower) || 5), 0.01), 99.9)
    loPct = -p
    hiPct = p
  } else {
    loPct = Number(percentOrLower)
    hiPct = Number(percentUpper)
    if (!Number.isFinite(loPct)) loPct = -5
    if (!Number.isFinite(hiPct)) hiPct = 5
  }
  loPct = Math.min(Math.max(loPct, -99.9), 1_000_000)
  hiPct = Math.min(Math.max(hiPct, -99.9), 1_000_000)
  if (hiPct <= loPct) hiPct = Math.min(loPct + 0.01, 1_000_000)

  const lowerFactor = Math.max(1 + loPct / 100, 1e-12)
  const upperFactor = Math.max(1 + hiPct / 100, 1e-12)
  const lowerTicks = Math.log(lowerFactor) / Math.log(1.0001)
  const upperTicks = Math.log(upperFactor) / Math.log(1.0001)
  let tickLower = nearestUsableTick(currentTick + Math.floor(lowerTicks), tickSpacing)
  let tickUpper = nearestUsableTick(currentTick + Math.ceil(upperTicks), tickSpacing)
  if (tickLower >= tickUpper) {
    tickUpper = tickLower + tickSpacing
  }
  return { tickLower, tickUpper }
}

export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  // price = (sqrtP / 2^96)^2 * 10^(dec0-dec1)
  // use string path for better precision on large ratios
  const sqrt = Number(sqrtPriceX96) / Number(Q96)
  return sqrt * sqrt * Math.pow(10, decimals0 - decimals1)
}

export function getAmount0ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  let a = sqrtA
  let b = sqrtB
  if (a > b) [a, b] = [b, a]
  if (a === 0n) return 0n
  return mulDiv(liquidity << 96n, b - a, b) / a
}

export function getAmount1ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  let a = sqrtA
  let b = sqrtB
  if (a > b) [a, b] = [b, a]
  return mulDiv(liquidity, b - a, Q96)
}

export function getLiquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  let a = sqrtA
  let b = sqrtB
  if (a > b) [a, b] = [b, a]
  if (a === 0n || b <= a || amount0 === 0n) return 0n
  const intermediate = mulDiv(a, b, Q96)
  return mulDiv(amount0, intermediate, b - a)
}

export function getLiquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  let a = sqrtA
  let b = sqrtB
  if (a > b) [a, b] = [b, a]
  if (b <= a || amount1 === 0n) return 0n
  return mulDiv(amount1, Q96, b - a)
}

/** Max liquidity that fits both token amounts at current price (Uniswap LiquidityAmounts). */
export function getLiquidityForAmounts(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  amount0: bigint,
  amount1: bigint,
): bigint {
  const sqrtA = tickToSqrtRatioX96(tickLower)
  const sqrtB = tickToSqrtRatioX96(tickUpper)
  if (sqrtPriceX96 <= sqrtA) return getLiquidityForAmount0(sqrtA, sqrtB, amount0)
  if (sqrtPriceX96 >= sqrtB) return getLiquidityForAmount1(sqrtA, sqrtB, amount1)
  const liq0 = getLiquidityForAmount0(sqrtPriceX96, sqrtB, amount0)
  const liq1 = getLiquidityForAmount1(sqrtA, sqrtPriceX96, amount1)
  return liq0 < liq1 ? liq0 : liq1
}

/**
 * Given one side's amount + current price + range, compute the paired amount (Uniswap 同款).
 * side: which field the user just edited.
 */
export function pairAmountForRange(opts: {
  sqrtPriceX96: bigint
  tickLower: number
  tickUpper: number
  amount: bigint
  side: 0 | 1
}): { amount0: bigint; amount1: bigint; singleSided: 'none' | 'token0' | 'token1' } {
  const { sqrtPriceX96, tickLower, tickUpper, amount, side } = opts
  const sqrtA = tickToSqrtRatioX96(tickLower)
  const sqrtB = tickToSqrtRatioX96(tickUpper)

  if (sqrtPriceX96 <= sqrtA) {
    // below range → only token0
    if (side === 0) return { amount0: amount, amount1: 0n, singleSided: 'token0' }
    return { amount0: 0n, amount1: 0n, singleSided: 'token0' }
  }

  if (sqrtPriceX96 >= sqrtB) {
    // above range → only token1
    if (side === 1) return { amount0: 0n, amount1: amount, singleSided: 'token1' }
    return { amount0: 0n, amount1: 0n, singleSided: 'token1' }
  }

  // in range
  if (amount === 0n) return { amount0: 0n, amount1: 0n, singleSided: 'none' }
  if (side === 0) {
    const L = getLiquidityForAmount0(sqrtPriceX96, sqrtB, amount)
    const amount1 = getAmount1ForLiquidity(sqrtA, sqrtPriceX96, L)
    return { amount0: amount, amount1, singleSided: 'none' }
  }
  const L = getLiquidityForAmount1(sqrtA, sqrtPriceX96, amount)
  const amount0 = getAmount0ForLiquidity(sqrtPriceX96, sqrtB, L)
  return { amount0, amount1: amount, singleSided: 'none' }
}

/** Token amounts currently held by a V3/V4 position */
export function getAmountsForPosition(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  if (liquidity === 0n) return { amount0: 0n, amount1: 0n }
  const sqrtA = tickToSqrtRatioX96(tickLower)
  const sqrtB = tickToSqrtRatioX96(tickUpper)
  if (sqrtPriceX96 <= sqrtA) {
    return { amount0: getAmount0ForLiquidity(sqrtA, sqrtB, liquidity), amount1: 0n }
  }
  if (sqrtPriceX96 < sqrtB) {
    return {
      amount0: getAmount0ForLiquidity(sqrtPriceX96, sqrtB, liquidity),
      amount1: getAmount1ForLiquidity(sqrtA, sqrtPriceX96, liquidity),
    }
  }
  return { amount0: 0n, amount1: getAmount1ForLiquidity(sqrtA, sqrtB, liquidity) }
}

export function decodeV4PositionInfo(info: bigint): { tickLower: number; tickUpper: number } {
  const tickLower = Number((info >> 8n) & 0xffffffn)
  const tickUpper = Number((info >> 32n) & 0xffffffn)
  const toSigned = (n: number) => (n >= 0x800000 ? n - 0x1000000 : n)
  return { tickLower: toSigned(tickLower), tickUpper: toSigned(tickUpper) }
}

/** NFT info 高 25 字节与 poolId 前缀一致，用于校验池子是否配对 */
export function poolIdPrefixFromV4Info(info: bigint): `0x${string}` {
  const hex = info.toString(16).padStart(64, '0').slice(0, 50)
  return `0x${hex}` as `0x${string}`
}

export function formatAmount(raw: bigint, decimals: number, digits = 6): string {
  if (raw === 0n) return '0'
  const neg = raw < 0n
  const v = neg ? -raw : raw
  const base = 10n ** BigInt(decimals)
  const whole = v / base
  const frac = v % base
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, digits).replace(/0+$/, '')
  const wholeStr = whole.toLocaleString('en-US')
  return `${neg ? '-' : ''}${wholeStr}${fracStr ? '.' + fracStr : ''}`
}

/** 列表卡用：大数量缩写成 K/M/B，避免一行被撑开 */
export function formatAmountCompact(raw: bigint, decimals: number): string {
  if (raw === 0n) return '0'
  const n = rawToNumber(raw, decimals)
  if (!Number.isFinite(n)) return formatAmount(raw, decimals, 2)
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1e9) return `${sign}${trimPriceZeros((abs / 1e9).toFixed(2))}B`
  if (abs >= 1e6) return `${sign}${trimPriceZeros((abs / 1e6).toFixed(2))}M`
  if (abs >= 1e4) return `${sign}${trimPriceZeros((abs / 1e3).toFixed(2))}K`
  if (abs >= 100) return `${sign}${trimPriceZeros(abs.toFixed(2))}`
  if (abs >= 1) return `${sign}${trimPriceZeros(abs.toFixed(4))}`
  return formatAmount(raw, decimals, 4)
}

/** 输入框/配对用：完整精度、无千分位，避免截断导致 Mint 滑点误杀 */
export function formatAmountExact(raw: bigint, decimals: number): string {
  if (raw === 0n) return '0'
  const neg = raw < 0n
  const v = neg ? -raw : raw
  const base = 10n ** BigInt(decimals)
  const whole = v / base
  const frac = v % base
  if (frac === 0n) return `${neg ? '-' : ''}${whole.toString()}`
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole.toString()}.${fracStr}`
}

export function rawToNumber(raw: bigint, decimals: number): number {
  if (raw === 0n) return 0
  if (raw < 0n) return -rawToNumber(-raw, decimals)
  const base = 10n ** BigInt(decimals)
  const whole = raw / base
  // 超过 Number 安全整数的数量按异常值处理，避免天价 USD
  if (whole > 10n ** 15n) return Number.NaN
  const frac = Number(raw % base) / Number(base)
  return Number(whole) + frac
}

export function parseAmount(input: string, decimals: number): bigint {
  const t = input.trim()
  if (!t || t === '.') return 0n
  const [w, f = ''] = t.split('.')
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals)
  return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0')
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  // 明显异常的天文数字（fee growth 算炸）不展示
  if (n > 1e11) return '—'
  /*
   * 前缀是 `$` 不是 `US$`。两个原因，宽度那个是硬的：
   *   · 等宽体下「US$26,140.20」要 94px，「$26,140.20」只要 78px。逐币明细在
   *     1024 单列卡里那一格最多给到 91.5px —— 带 US 的版本必被省略号切掉，
   *     而金额被截是错的信息，不是难看而已。
   *   · Uniswap / Meteora / Raydium 印的都是 `$`。全站只有一种计价货币，
   *     「US」这两个字符不携带任何信息。
   */
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * 持仓时长。列表卡和详情卡共用 —— 之前详情卡自己搓了一套 `122d`，
 * 同一个仓位在两个地方显示成「4.0 个月」和「122d」。
 */
export function formatAge(days?: number): string {
  if (days == null || !Number.isFinite(days) || days < 0) return '—'
  if (days < 1 / 24) return '刚建仓'
  if (days < 1) return `${Math.round(days * 24)} 小时`
  if (days < 60) return `${days < 10 ? days.toFixed(1) : Math.round(days)} 天`
  return `${(days / 30.44).toFixed(1)} 个月`
}

export const MAX_UINT128 = 2n ** 128n - 1n
