/**
 * 自动化引擎：只在本地私钥解锁时可用（插件钱包每笔都要人点确认，没法无人值守）。
 *
 * 设计原则：
 *  - 纯决策 + 执行分离：planActions() 只读链上快照算出「该做什么」，不发交易；
 *    UI 可以先看 plan（演练模式）再决定要不要真发。
 *  - 每一层都有刹车：全局开关、单条规则开关、冷却时间、每日次数上限、gas 价格上限、
 *    最小 ETH 余额、以及「必须先演练成功过一次」的软提示。
 *  - 所有动作都写日志（含 tx hash），刷新页面不丢。
 */

import { formatGwei, type Address, type WalletClient } from 'viem'
import { publicClient } from './wallet'
import { readPref, writePref } from './prefs'
import {
  claimAndCompound,
  rebalanceV3,
  getPositionCoinPrices,
  type PositionRow,
} from './lp'

export type AutoAction = 'compound' | 'rebalance'

export type AutoConfig = {
  /** 总开关 */
  enabled: boolean
  /** 演练模式：只算不发交易 */
  dryRun: boolean
  /** 每轮检查间隔（秒） */
  intervalSecs: number

  compound: {
    enabled: boolean
    /** 未领手续费达到多少 USD 才复投 */
    minFeesUsd: number
    /** 同一个仓位两次复投最小间隔（分钟） */
    cooldownMins: number
  }

  rebalance: {
    enabled: boolean
    /** 触发条件：'out' 已越界 / 'near' 距边界小于 nearPct% */
    trigger: 'out' | 'near'
    nearPct: number
    /** 需要连续满足条件多少分钟才动手，避免插针误触发 */
    dwellMins: number
    /** 新区间半宽 %：0 = 沿用原区间宽度 */
    widthPct: number
    cooldownMins: number
  }

  guards: {
    /** gas 价格上限（gwei），超了跳过这轮 */
    maxGasGwei: number
    /** 原生币余额低于此值（ETH）就停手，留着付 gas */
    minEthBalance: number
    /** 每天最多执行多少笔自动交易 */
    maxTxPerDay: number
    /** 单个仓位价值低于此 USD 不自动操作（省 gas） */
    minPositionUsd: number
  }
}

export const DEFAULT_AUTO_CONFIG: AutoConfig = {
  enabled: false,
  dryRun: true,
  intervalSecs: 180,
  compound: { enabled: true, minFeesUsd: 5, cooldownMins: 180 },
  rebalance: {
    enabled: false,
    trigger: 'out',
    nearPct: 2,
    dwellMins: 10,
    widthPct: 0,
    cooldownMins: 60,
  },
  guards: { maxGasGwei: 5, minEthBalance: 0.002, maxTxPerDay: 20, minPositionUsd: 20 },
}

const CFG_KEY = 'autoConfig.v1'
const STATE_KEY = 'autoState.v1'
const LOG_KEY = 'autoLog.v1'

export function loadAutoConfig(): AutoConfig {
  const raw = readPref<Partial<AutoConfig>>(CFG_KEY, {})
  // 深合并，保证新增字段有默认值
  return {
    ...DEFAULT_AUTO_CONFIG,
    ...raw,
    compound: { ...DEFAULT_AUTO_CONFIG.compound, ...(raw.compound ?? {}) },
    rebalance: { ...DEFAULT_AUTO_CONFIG.rebalance, ...(raw.rebalance ?? {}) },
    guards: { ...DEFAULT_AUTO_CONFIG.guards, ...(raw.guards ?? {}) },
  }
}

export function saveAutoConfig(cfg: AutoConfig) {
  writePref(CFG_KEY, cfg)
}

/* ───────────────────────── 运行时状态 ───────────────────────── */

type PositionState = {
  /** 上次复投时间 */
  lastCompoundAt?: number
  /** 上次 rebalance 时间 */
  lastRebalanceAt?: number
  /** 首次满足 rebalance 条件的时间（用于 dwell 判定） */
  triggerSince?: number
  /** 该仓位被自动化排除 */
  excluded?: boolean
}

type AutoState = {
  positions: Record<string, PositionState>
  /** yyyy-mm-dd → 当天已执行笔数 */
  daily: Record<string, number>
}

function loadState(): AutoState {
  const s = readPref<AutoState>(STATE_KEY, { positions: {}, daily: {} })
  return { positions: s.positions ?? {}, daily: s.daily ?? {} }
}

function saveState(s: AutoState) {
  // 只留最近 7 天的计数
  const days = Object.keys(s.daily).sort().slice(-7)
  const daily: Record<string, number> = {}
  for (const d of days) daily[d] = s.daily[d]
  writePref(STATE_KEY, { positions: s.positions, daily })
}

export function posKey(p: PositionRow): string {
  return `${p.version}-${p.tokenId}`
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function txCountToday(): number {
  return loadState().daily[today()] ?? 0
}

function bumpTxCount() {
  const s = loadState()
  const d = today()
  s.daily[d] = (s.daily[d] ?? 0) + 1
  saveState(s)
}

export function isExcluded(p: PositionRow): boolean {
  return Boolean(loadState().positions[posKey(p)]?.excluded)
}

export function setExcluded(p: PositionRow, excluded: boolean) {
  const s = loadState()
  const k = posKey(p)
  s.positions[k] = { ...s.positions[k], excluded }
  saveState(s)
}

export function resetAutoState() {
  writePref(STATE_KEY, { positions: {}, daily: {} })
}

/* ───────────────────────── 日志 ───────────────────────── */

export type AutoLogEntry = {
  at: number
  action: AutoAction | 'skip' | 'error'
  pair: string
  tokenId: string
  detail: string
  hash?: string
  dryRun?: boolean
}

export function loadAutoLog(): AutoLogEntry[] {
  return readPref<AutoLogEntry[]>(LOG_KEY, [])
}

export function pushAutoLog(e: AutoLogEntry): AutoLogEntry[] {
  const list = [e, ...loadAutoLog()].slice(0, 200)
  writePref(LOG_KEY, list)
  return list
}

export function clearAutoLog() {
  writePref(LOG_KEY, [])
}

/* ───────────────────────── 决策 ───────────────────────── */

export type PlannedAction = {
  action: AutoAction
  position: PositionRow
  reason: string
  /** rebalance 用：目标半宽 % */
  widthPct?: number
}

export type SkipReason = { position: PositionRow; reason: string }

export type Plan = {
  actions: PlannedAction[]
  skips: SkipReason[]
  /** 整轮被拦下的原因（gas 太贵、余额不足等） */
  blocked: string | null
  gasGwei: number | null
}

/** 距最近边界还有多少 %（已越界 = 0） */
function proximityPct(p: PositionRow): number | null {
  if (!p.inRange) return 0
  const { priceLower: lo, priceUpper: hi, price: spot } = p
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(spot) || spot <= 0) return null
  if (!(hi > lo)) return null
  const near = Math.min(((spot - lo) / spot) * 100, ((hi - spot) / spot) * 100)
  return Number.isFinite(near) ? Math.max(0, near) : null
}

/** 沿用原区间宽度时用的对称半宽 % */
export function currentHalfWidthPct(p: PositionRow): number {
  try {
    const cq = getPositionCoinPrices(p)
    const spot = cq.coinPrice
    if (!(spot > 0)) return 10
    const loPct = Math.abs((cq.coinPriceLower / spot - 1) * 100)
    const hiPct = Math.abs((cq.coinPriceUpper / spot - 1) * 100)
    const avg = (loPct + hiPct) / 2
    if (!Number.isFinite(avg) || avg < 0.5) return 10
    return Math.min(99.9, Math.max(0.5, avg))
  } catch {
    return 10
  }
}

/**
 * 只读地算出这一轮该做什么。不发交易、不改状态（dwell 计时除外）。
 */
export async function planActions(
  positions: PositionRow[],
  cfg: AutoConfig,
  owner: Address,
): Promise<Plan> {
  const actions: PlannedAction[] = []
  const skips: SkipReason[] = []
  let gasGwei: number | null = null

  // 全局刹车
  if (cfg.guards.maxGasGwei > 0) {
    try {
      const gp = await publicClient.getGasPrice()
      gasGwei = Number(formatGwei(gp))
      if (gasGwei > cfg.guards.maxGasGwei) {
        return {
          actions: [],
          skips: [],
          blocked: `gas ${gasGwei.toFixed(2)} gwei 高于上限 ${cfg.guards.maxGasGwei} gwei`,
          gasGwei,
        }
      }
    } catch {
      /* 拿不到 gas 就不拦 */
    }
  }

  try {
    const bal = await publicClient.getBalance({ address: owner })
    const eth = Number(bal) / 1e18
    if (eth < cfg.guards.minEthBalance) {
      return {
        actions: [],
        skips: [],
        blocked: `原生币余额 ${eth.toFixed(4)} 低于下限 ${cfg.guards.minEthBalance}`,
        gasGwei,
      }
    }
  } catch {
    /* ignore */
  }

  const used = txCountToday()
  if (used >= cfg.guards.maxTxPerDay) {
    return { actions: [], skips: [], blocked: `今日已执行 ${used} 笔，达到上限`, gasGwei }
  }

  const state = loadState()
  const now = Date.now()
  let mutated = false

  for (const p of positions) {
    const k = posKey(p)
    const ps = state.positions[k] ?? {}

    if (ps.excluded) {
      skips.push({ position: p, reason: '已手动排除' })
      continue
    }
    if (p.liquidity === 0n) {
      skips.push({ position: p, reason: '空仓位' })
      continue
    }
    if (p.totalUsd < cfg.guards.minPositionUsd) {
      skips.push({ position: p, reason: `价值 ${p.totalUsd.toFixed(2)} 低于门槛` })
      continue
    }

    /* ── 复投 ── */
    if (cfg.compound.enabled) {
      const unclaimed = p.fees0Usd + p.fees1Usd
      const cooled =
        !ps.lastCompoundAt || now - ps.lastCompoundAt >= cfg.compound.cooldownMins * 60_000
      if (unclaimed >= cfg.compound.minFeesUsd && cooled && p.inRange) {
        actions.push({
          action: 'compound',
          position: p,
          reason: `未领手续费 $${unclaimed.toFixed(2)} ≥ $${cfg.compound.minFeesUsd}`,
        })
        continue // 一个仓位一轮只做一件事
      }
      if (unclaimed >= cfg.compound.minFeesUsd && !cooled) {
        const mins = Math.ceil((cfg.compound.cooldownMins * 60_000 - (now - ps.lastCompoundAt!)) / 60_000)
        skips.push({ position: p, reason: `复投冷却中，还剩 ${mins} 分钟` })
      }
    }

    /* ── Rebalance ── */
    if (cfg.rebalance.enabled) {
      const prox = proximityPct(p)
      const hit =
        cfg.rebalance.trigger === 'out'
          ? !p.inRange
          : prox != null && prox <= cfg.rebalance.nearPct

      if (!hit) {
        if (ps.triggerSince) {
          state.positions[k] = { ...ps, triggerSince: undefined }
          mutated = true
        }
        continue
      }

      const since = ps.triggerSince ?? now
      if (!ps.triggerSince) {
        state.positions[k] = { ...ps, triggerSince: now }
        mutated = true
      }
      const dwellMs = cfg.rebalance.dwellMins * 60_000
      if (now - since < dwellMs) {
        const left = Math.ceil((dwellMs - (now - since)) / 60_000)
        skips.push({ position: p, reason: `已触发，观察期还剩 ${left} 分钟` })
        continue
      }
      const cooled =
        !ps.lastRebalanceAt || now - ps.lastRebalanceAt >= cfg.rebalance.cooldownMins * 60_000
      if (!cooled) {
        const mins = Math.ceil(
          (cfg.rebalance.cooldownMins * 60_000 - (now - ps.lastRebalanceAt!)) / 60_000,
        )
        skips.push({ position: p, reason: `Rebalance 冷却中，还剩 ${mins} 分钟` })
        continue
      }
      const width = cfg.rebalance.widthPct > 0 ? cfg.rebalance.widthPct : currentHalfWidthPct(p)
      actions.push({
        action: 'rebalance',
        position: p,
        reason:
          cfg.rebalance.trigger === 'out'
            ? `已越界，重开 ±${width.toFixed(1)}%`
            : `距边界 ${prox?.toFixed(2)}% ≤ ${cfg.rebalance.nearPct}%，重开 ±${width.toFixed(1)}%`,
        widthPct: width,
      })
    }
  }

  if (mutated) saveState(state)

  // 别一轮把额度打满
  const room = Math.max(0, cfg.guards.maxTxPerDay - used)
  return { actions: actions.slice(0, room), skips, blocked: null, gasGwei }
}

/* ───────────────────────── 执行 ───────────────────────── */

function pairOf(p: PositionRow) {
  return `${p.token0.symbol}/${p.token1.symbol}`
}

/**
 * 执行单个动作。dryRun 时只记日志。
 * 返回 tx hash（rebalance 返回 mint 的那笔）。
 */
export async function executeAction(
  plan: PlannedAction,
  opts: {
    walletClient: WalletClient
    owner: Address
    slippageBps: number
    dryRun: boolean
  },
): Promise<{ hash?: string; note: string }> {
  const { walletClient, owner, slippageBps, dryRun } = opts
  const p = plan.position

  if (dryRun) {
    pushAutoLog({
      at: Date.now(),
      action: plan.action,
      pair: pairOf(p),
      tokenId: p.tokenId.toString(),
      detail: `[演练] ${plan.reason}`,
      dryRun: true,
    })
    return { note: '演练，未发交易' }
  }

  const state = loadState()
  const k = posKey(p)

  if (plan.action === 'compound') {
    let hash: string | undefined
    const r = await claimAndCompound({
      walletClient,
      owner,
      position: p,
      slippageBps,
    })
    hash = (r.increaseHash ?? r.claimHash) as string
    const note = r.note
    state.positions[k] = { ...state.positions[k], lastCompoundAt: Date.now() }
    saveState(state)
    bumpTxCount()
    pushAutoLog({
      at: Date.now(),
      action: 'compound',
      pair: pairOf(p),
      tokenId: p.tokenId.toString(),
      detail: `${note} · ${plan.reason}`,
      hash,
    })
    return { hash, note }
  }

  // rebalance：只有 V3 能一键完成（撤 + 重开）
  if (p.version !== 'v3') {
    pushAutoLog({
      at: Date.now(),
      action: 'skip',
      pair: pairOf(p),
      tokenId: p.tokenId.toString(),
      detail: 'V4 不支持自动 Rebalance（需手动确认新区间）',
    })
    return { note: 'V4 已跳过' }
  }

  const r = await rebalanceV3({
    walletClient,
    owner,
    position: p,
    percent: plan.widthPct ?? currentHalfWidthPct(p),
    slippageBps,
  })
  state.positions[k] = {
    ...state.positions[k],
    lastRebalanceAt: Date.now(),
    triggerSince: undefined,
  }
  saveState(state)
  bumpTxCount()
  pushAutoLog({
    at: Date.now(),
    action: 'rebalance',
    pair: pairOf(p),
    tokenId: p.tokenId.toString(),
    detail: `已重开 ticks [${r.tickLower}, ${r.tickUpper}] · ${plan.reason}`,
    hash: r.mintHash as string,
  })
  return { hash: r.mintHash as string, note: '已重开区间' }
}
