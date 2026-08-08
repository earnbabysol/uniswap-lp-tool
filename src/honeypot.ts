import type { Address } from 'viem'
import { CHAIN_CONFIGS, type SupportedChainId } from './chain'

const CACHE_KEY = 'rangedesk.honeypot.v1'
const CACHE_TTL_MS = 45 * 60_000

type CacheEntry = { ok: boolean; at: number; reason?: string }

function readCache(): Record<string, CacheEntry> {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, CacheEntry>
  } catch {
    return {}
  }
}

function writeCache(all: Record<string, CacheEntry>) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(all))
  } catch {
    /* ignore */
  }
}

function cacheKey(chainId: number, token: Address) {
  return `${chainId}:${token.toLowerCase()}`
}

/** 已知安全币：稳定币 / 包装原生 / Robinhood 股票代币等（按目标链，不依赖当前 UI 链） */
export function isHoneypotWhitelisted(chainId: SupportedChainId, token: Address): boolean {
  const cfg = CHAIN_CONFIGS[chainId]
  const t = token.toLowerCase()
  if (t === cfg.contracts.weth.toLowerCase()) return true
  if (t === cfg.contracts.stable.toLowerCase()) return true
  for (const s of cfg.usdStables ?? []) {
    if (t === s.toLowerCase()) return true
  }
  if (cfg.knownTokens[t]) return true
  if (chainId === 56) {
    if (
      t === '0x55d398326f99059ff775485246999027b3197955'
      || t === '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
      || t === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'
      || t === '0xe9e7cea3dedca5984780bafc599bd69add087d56'
    ) {
      return true
    }
  }
  return false
}

/**
 * 查询转账税（bps）。GoPlus 的 buy_tax/sell_tax 是小数（0.01=1%）。
 * 失败返回 null；稳定币/白名单应跳过调用。
 */
export async function fetchTransferTaxBps(
  chainId: number,
  token: Address,
): Promise<number | null> {
  if (chainId !== 56 && chainId !== 1) return null
  if (isHoneypotWhitelisted(chainId as SupportedChainId, token)) return 0
  const url =
    `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${token.toLowerCase()}`
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8_000)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    const json = (await res.json()) as {
      code?: number
      result?: Record<string, { buy_tax?: string; sell_tax?: string }>
    }
    if (json.code !== 1 || !json.result) return null
    const row = json.result[token.toLowerCase()]
    if (!row) return null
    const buy = Number(row.buy_tax ?? 0)
    const sell = Number(row.sell_tax ?? 0)
    const frac = Math.max(
      Number.isFinite(buy) ? buy : 0,
      Number.isFinite(sell) ? sell : 0,
    )
    if (!(frac > 0)) return 0
    // 转成 bps，再加 5bps 缓冲（舍入 / 动态税）
    return Math.min(5_000, Math.ceil(frac * 10_000) + 5)
  } catch {
    return null
  }
}

/**
 * GoPlus token_security。返回 true = 可通过（非貔貅）。
 * 网络失败时返回 null（调用方决定是否放行）。
 */
async function goPlusCheck(chainId: number, token: Address): Promise<boolean | null> {
  // GoPlus：1=ETH 56=BSC；Robinhood 无官方链码，跳过
  if (chainId !== 56 && chainId !== 1) return null
  const url =
    `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${token.toLowerCase()}`
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8_000)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    const json = (await res.json()) as {
      code?: number
      result?: Record<string, {
        is_honeypot?: string
        cannot_sell_all?: string
        can_take_back_ownership?: string
        honeypot_with_same_creator?: string
        buy_tax?: string
        sell_tax?: string
        is_open_source?: string
      }>
    }
    if (json.code !== 1 || !json.result) return null
    const row = json.result[token.toLowerCase()]
    if (!row) return null
    if (row.is_honeypot === '1') return false
    if (row.cannot_sell_all === '1') return false
    const sellTax = Number(row.sell_tax ?? 0)
    const buyTax = Number(row.buy_tax ?? 0)
    if (Number.isFinite(sellTax) && sellTax >= 0.25) return false
    if (Number.isFinite(buyTax) && buyTax >= 0.25) return false
    return true
  } catch {
    return null
  }
}

/**
 * 判断代币是否可展示（非貔貅）。
 * 白名单直接 true；GoPlus 判定貔貅则 false；查不到时默认放行（避免 Robinhood 全灭）。
 */
export async function checkTokenSafe(
  chainId: SupportedChainId,
  token: Address,
): Promise<{ ok: boolean; reason?: string }> {
  if (isHoneypotWhitelisted(chainId, token)) return { ok: true, reason: 'whitelist' }

  const key = cacheKey(chainId, token)
  const cached = readCache()[key]
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ok: cached.ok, reason: cached.reason }
  }

  const gp = await goPlusCheck(chainId, token)
  let result: CacheEntry
  if (gp === false) {
    result = { ok: false, at: Date.now(), reason: 'honeypot' }
  } else if (gp === true) {
    result = { ok: true, at: Date.now(), reason: 'goplus' }
  } else {
    // 查不到：Robinhood 等链默认放行；BSC 也放行但标 unknown（避免误杀）
    result = { ok: true, at: Date.now(), reason: 'unknown' }
  }

  const all = readCache()
  all[key] = result
  // 简单裁剪
  const keys = Object.keys(all)
  if (keys.length > 800) {
    keys
      .sort((a, b) => (all[a].at ?? 0) - (all[b].at ?? 0))
      .slice(0, keys.length - 600)
      .forEach((k) => {
        delete all[k]
      })
  }
  writeCache(all)
  return { ok: result.ok, reason: result.reason }
}

/** 池子两侧都安全才通过 */
export async function checkPoolTokensSafe(
  chainId: SupportedChainId,
  token0: Address,
  token1: Address,
): Promise<boolean> {
  const [a, b] = await Promise.all([
    checkTokenSafe(chainId, token0),
    checkTokenSafe(chainId, token1),
  ])
  return a.ok && b.ok
}
