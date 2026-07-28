/*
 * 设计夹具 —— 只在 dev 下、且 URL 带 ?design=1 时启用。
 *
 * 为什么要有这个文件：没连钱包时整个 App 都是空态，仓位网格、KPI 数字、详情卡、
 * 手续费年化、风险色这些真正需要打磨的密集布局全看不到。想调版式就得先有数据。
 * 生产构建里 import.meta.env.DEV 为 false，这个模块会被 tree-shake 掉。
 *
 * 覆盖的状态是刻意凑的，每一条都对应一种视觉分支：
 *   1. 正常 in-range、盈利、年化健康
 *   2. 贴近边界（触发 risk-warn 描边）
 *   3. 已出区间、亏损（risk-high + 负 PnL 配色）
 *   4. V4 + hooks（版本标签分叉）
 *   5. 极小额仓位（数字位数少，验证等宽对齐）
 *   6. 出区间且单边归零（pct0/pct1 = 0/100 的配比条）
 *   7. 建仓 < 6h（feeAprPct 为 undefined 的「—」分支）
 */
import type { Address } from 'viem'
import type { PoolInfo, PositionRow, TokenMeta } from './lp'
import type { TxRecord } from './history'
import { priceToClosestTick, priceToSqrtPriceX96 } from './math'

const USDG: TokenMeta = { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', decimals: 6 }
const WETH: TokenMeta = { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', symbol: 'WETH', decimals: 18 }
const AAPL: TokenMeta = { address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', symbol: 'AAPL', decimals: 18 }
const NVDA: TokenMeta = { address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', symbol: 'NVDA', decimals: 18 }
const TSLA: TokenMeta = { address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', symbol: 'TSLA', decimals: 18 }
const QQQ: TokenMeta = { address: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68', symbol: 'QQQ', decimals: 18 }

/* 必须是合法的 EIP-55 校验和地址，否则 viem 在详情卡里读余额时会直接抛 */
export const FIXTURE_ADDRESS = '0x7a16fF8270133F063aAb6C9977183D9e72835428' as Address

const DAY = 86_400
const now = () => Math.floor(Date.now() / 1000)

/** 把人类可读的数量转成最小单位 */
const u = (n: number, d: number) => BigInt(Math.round(n * 10 ** Math.min(d, 6))) * 10n ** BigInt(Math.max(0, d - 6))

type Spec = {
  id: number
  version: 'v3' | 'v4'
  t0: TokenMeta
  t1: TokenMeta
  fee: number
  /** 人类可读：当前价 / 区间下沿 / 上沿（token1 per token0） */
  price: number
  lower: number
  upper: number
  amt0: number
  amt1: number
  fee0: number
  fee1: number
  claimed: number
  cost: number
  pnl: number
  ageDays?: number
  apr?: number
  hooks?: Address
}

const SPECS: Spec[] = [
  // 1 正常 in-range，盈利，年化健康
  { id: 18442, version: 'v3', t0: AAPL, t1: USDG, fee: 3000, price: 232.4, lower: 214, upper: 252,
    amt0: 41.28, amt1: 9_612.4, fee0: 0.842, fee1: 196.3, claimed: 412.66, cost: 18_400, pnl: 1_243.82,
    ageDays: 63.4, apr: 21.7 },
  // 2 贴近上边界 —— risk-warn 描边
  { id: 18507, version: 'v3', t0: NVDA, t1: USDG, fee: 3000, price: 178.9, lower: 152, upper: 181,
    amt0: 8.14, amt1: 26_140.2, fee0: 0.213, fee1: 88.7, claimed: 1_206.4, cost: 27_900, pnl: 842.15,
    ageDays: 121.8, apr: 14.2 },
  // 3 已出区间 + 亏损 —— risk-high、负 PnL
  { id: 17994, version: 'v3', t0: TSLA, t1: USDG, fee: 10000, price: 291.7, lower: 305, upper: 348,
    amt0: 0, amt1: 12_880.6, fee0: 0, fee1: 24.1, claimed: 96.2, cost: 14_600, pnl: -1_599.1,
    ageDays: 38.2, apr: 3.1 },
  // 4 V4 + hooks
  { id: 4412, version: 'v4', t0: QQQ, t1: USDG, fee: 500, price: 486.2, lower: 452, upper: 519,
    amt0: 12.06, amt1: 5_902.8, fee0: 0.318, fee1: 142.6, claimed: 288.9, cost: 11_200, pnl: 612.44,
    ageDays: 27.6, apr: 18.9, hooks: '0x4A8c1D9f2b3E5A7C6D8f0e1B2C3d4E5f6A7B8C9d' as Address },
  // 5 极小额 —— 验证少位数时的等宽对齐
  { id: 19003, version: 'v3', t0: WETH, t1: USDG, fee: 500, price: 3_142.8, lower: 2_950, upper: 3_400,
    amt0: 0.0184, amt1: 42.16, fee0: 0.00021, fee1: 0.62, claimed: 1.44, cost: 118, pnl: 4.02,
    ageDays: 9.1, apr: 6.8 },
  // 6 出区间且单边归零 —— 配比条 0 / 100
  { id: 16820, version: 'v3', t0: AAPL, t1: WETH, fee: 3000, price: 0.0741, lower: 0.0612, upper: 0.0698,
    amt0: 96.42, amt1: 0, fee0: 1.86, fee1: 0.0042, claimed: 62.8, cost: 21_800, pnl: 318.6,
    ageDays: 204.5, apr: 9.4 },
  // 7 建仓不足 6h —— feeAprPct undefined，走「—」分支
  { id: 19104, version: 'v4', t0: NVDA, t1: WETH, fee: 3000, price: 0.0568, lower: 0.0521, upper: 0.0614,
    amt0: 18.9, amt1: 0.482, fee0: 0.0008, fee1: 0.00002, claimed: 0, cost: 4_960, pnl: -12.4 },
]

function build(s: Spec): PositionRow {
  const inRange = s.price >= s.lower && s.price <= s.upper
  // token1 计价的美元换算：稳定币按 1，其余按当前价折算，够画面用
  const usdPer1 = s.t1.symbol === 'USDG' ? 1 : s.t1.symbol === 'WETH' ? 3_142.8 : 1
  const usdPer0 = s.price * usdPer1
  const amount0Usd = s.amt0 * usdPer0
  const amount1Usd = s.amt1 * usdPer1
  const fees0Usd = s.fee0 * usdPer0
  const fees1Usd = s.fee1 * usdPer1
  const totalUsd = amount0Usd + amount1Usd
  const sum = amount0Usd + amount1Usd || 1
  const tickOf = (p: number) => Math.round(Math.log(p) / Math.log(1.0001))
  return {
    version: s.version,
    tokenId: BigInt(s.id),
    token0: s.t0,
    token1: s.t1,
    fee: s.fee,
    tickLower: tickOf(s.lower),
    tickUpper: tickOf(s.upper),
    liquidity: u(totalUsd * 3.4, 18),
    tick: tickOf(s.price),
    inRange,
    priceLower: s.lower,
    priceUpper: s.upper,
    price: s.price,
    amount0: u(s.amt0, s.t0.decimals),
    amount1: u(s.amt1, s.t1.decimals),
    fees0: u(s.fee0, s.t0.decimals),
    fees1: u(s.fee1, s.t1.decimals),
    amount0Usd,
    amount1Usd,
    fees0Usd,
    fees1Usd,
    totalUsd,
    pct0: (amount0Usd / sum) * 100,
    pct1: (amount1Usd / sum) * 100,
    claimed0: u(s.claimed / usdPer0, s.t0.decimals),
    claimed1: 0n,
    claimedFeesUsd: s.claimed,
    totalFeesUsd: fees0Usd + fees1Usd + s.claimed,
    costBasisUsd: s.cost,
    pnlUsd: s.pnl,
    openedAt: s.ageDays ? now() - Math.round(s.ageDays * DAY) : now() - 3_600 * 2,
    ageDays: s.ageDays ?? 0.083,
    feeAprPct: s.apr,
    poolAddress:
      s.version === 'v3'
        ? (`0x${(s.id * 7919).toString(16).padStart(40, 'b3f1a')}`.slice(0, 42) as Address)
        : undefined,
    poolId:
      s.version === 'v4'
        ? (`0x${(s.id * 104729).toString(16).padStart(64, 'd4e2c')}`.slice(0, 66) as `0x${string}`)
        : undefined,
    tickSpacing: s.fee === 500 ? 10 : s.fee === 3000 ? 60 : 200,
    hooks: s.hooks,
    sqrtPriceX96: 0n,
  }
}

export const FIXTURE_POSITIONS: PositionRow[] = SPECS.map(build)

/*
 * 建仓页的「已选池」夹具。
 *
 * 没有它，?design=1 下建仓页永远停在第一步（选池），第二步「定区间」和第三步
 * 「配数量」整段 `pool && (...)` 都渲染不出来 —— 而那两步恰好是被吐槽
 * 「输入完价格还要手动算数量」的地方。sqrtPriceX96 由 price 反推，
 * 保证 tick / price / sqrtPrice 三者自洽，深度图和配平预览才不会算出 NaN。
 */
export const FIXTURE_POOL: PoolInfo = {
  version: 'v3',
  poolAddress: '0x9C21123D94b93361a29B2C2EFB3d5CD8B17e0A9e' as Address,
  token0: NVDA,
  token1: USDG,
  fee: 500,
  tickSpacing: 10,
  tick: priceToClosestTick(178.9, NVDA.decimals, USDG.decimals),
  sqrtPriceX96: priceToSqrtPriceX96(178.9, NVDA.decimals, USDG.decimals),
  price: 178.9,
  liquidity: 4_182_665_004_112_889_431n,
}

export const FIXTURE_HISTORY: TxRecord[] = [
  { id: 'f1', label: '领取手续费', hash: '0x9c1f4a2b6d8e0f3a5c7b9d1e2f4a6c8b0d2e4f6a8c0b2d4e6f8a0c2b4d6e8f01', at: Date.now() - 1_000 * 60 * 4, pair: 'AAPL / USDG' },
  { id: 'f2', label: 'Rebalance（关仓 + 重开）', hash: '0x3e5a7c9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c', at: Date.now() - 1_000 * 60 * 47, pair: 'NVDA / USDG' },
  { id: 'f3', label: '复投手续费', hash: '0x7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d', at: Date.now() - 1_000 * 60 * 60 * 3.2, pair: 'QQQ / USDG' },
  { id: 'f4', label: '建仓 Mint', hash: '0x1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c', at: Date.now() - 1_000 * 60 * 60 * 26, pair: 'WETH / USDG' },
  { id: 'f5', label: '增加流动性', hash: '0x5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e', at: Date.now() - 1_000 * 60 * 60 * 52, pair: 'AAPL / WETH' },
]

/** dev + ?design=1 才开 */
export function designMode(): boolean {
  if (!import.meta.env.DEV) return false
  try {
    return new URLSearchParams(window.location.search).has('design')
  } catch {
    return false
  }
}

/*
 * 设计模式下要模拟哪一种签名通道。?design=1 → 插件钱包，?design=local → 本地私钥。
 *
 * 需要这个开关是因为「自动化」整页和「工具」页的一部分都挂在 signerMode === 'local'
 * 上，而两种通道互斥：夹具连了插件钱包，自动化面板就永远是那块「自动化需要本地私钥」
 * 的占位，改不到里面的版式。注意这里只切 UI 状态，signer.ts 的 SECRETS 闭包始终是空的
 * —— 没有任何明文私钥参与，也没有真实签名能力。
 */
export function designSignerMode(): 'wallet' | 'local' {
  if (!import.meta.env.DEV) return 'wallet'
  try {
    return new URLSearchParams(window.location.search).get('design') === 'local'
      ? 'local'
      : 'wallet'
  } catch {
    return 'wallet'
  }
}
