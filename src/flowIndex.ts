import type {
  FlowChainId,
  FlowEvent,
  FlowFetchOpts,
  FlowNotice,
} from './flowEvents'
import { isFlowSelectableChainId } from './flowSelection'

type StoredFlowEvent = Omit<FlowEvent, 'blockNumber'> & { blockNumber?: string }

type SharedFlowIndex = {
  version: 1 | 2
  generatedAt: number
  windowMinutes: number
  /** v2 explicitly records quiet/error chains so the browser knows coverage. */
  chainIds?: number[]
  events: StoredFlowEvent[]
  notices?: FlowNotice[]
}

export type SharedFlowResult = {
  events: FlowEvent[]
  notices: FlowNotice[]
  source: 'shared-index'
  generatedAt: number
}

// GitHub 的 schedule 是 best-effort，偶尔会漏跑几十分钟。快照超过这个
// 时限后不再伪装成“已刷新”，浏览器会保留旧列表并转入节流的实时补刷。
export const FLOW_SHARED_INDEX_FRESH_MS = 18 * 60_000
let rawIndexCache: { at: number; value: Partial<SharedFlowIndex> } | null = null
let rawIndexRequest: Promise<Partial<SharedFlowIndex> | null> | null = null

export function isSharedFlowIndexFresh(
  generatedAt: number,
  now = Date.now(),
  maxAgeMs = FLOW_SHARED_INDEX_FRESH_MS,
): boolean {
  if (!Number.isFinite(generatedAt) || !Number.isFinite(now) || !(maxAgeMs > 0)) return false
  const age = now - generatedAt
  return age >= -60_000 && age <= maxAgeMs
}

function restoreEvent(value: StoredFlowEvent): FlowEvent | null {
  if (
    !value
    || !isFlowSelectableChainId(value.chainId)
    || (value.version !== 'v3' && value.version !== 'v4')
    || (value.side !== 'in' && value.side !== 'out')
    || typeof value.id !== 'string'
    || !Number.isFinite(value.timestamp)
    || !Number.isFinite(value.amountUsd)
  ) return null
  try {
    return {
      ...value,
      blockNumber: value.blockNumber == null ? undefined : BigInt(value.blockNumber),
    }
  } catch {
    return null
  }
}

function baseUrl(): string {
  const configured = import.meta.env?.BASE_URL || '/'
  return configured.endsWith('/') ? configured : `${configured}/`
}

async function readRawIndex(): Promise<Partial<SharedFlowIndex> | null> {
  if (rawIndexCache && Date.now() - rawIndexCache.at < 90_000) return rawIndexCache.value
  if (rawIndexRequest) return rawIndexRequest
  rawIndexRequest = (async () => {
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => ctrl.abort(), 5_000)
    try {
      const bucket = Math.floor(Date.now() / 60_000)
      const response = await fetch(`${baseUrl()}index/flow.json?v=${bucket}`, {
        cache: 'no-store',
        signal: ctrl.signal,
      })
      if (!response.ok) return null
      const value = await response.json() as Partial<SharedFlowIndex>
      rawIndexCache = { at: Date.now(), value }
      return value
    } catch {
      return null
    } finally {
      window.clearTimeout(timer)
      rawIndexRequest = null
    }
  })()
  return rawIndexRequest
}

/**
 * Read the Pages-hosted snapshot produced by the scheduled index job. A fresh
 * snapshot completely replaces browser-side log scans; stale/missing data
 * returns null so the existing adaptive RPC path remains a safe fallback.
 */
export async function loadSharedFlowIndex(opts: FlowFetchOpts): Promise<SharedFlowResult | null> {
  if (typeof window === 'undefined') return null
  try {
    const index = await readRawIndex()
    if (!index) return null
    if (
      (index.version !== 1 && index.version !== 2)
      || !Number.isFinite(index.generatedAt)
      || !isSharedFlowIndexFresh(
        Number(index.generatedAt),
        Date.now(),
        opts.maxSharedIndexAgeMs ?? FLOW_SHARED_INDEX_FRESH_MS,
      )
      || !Array.isArray(index.events)
    ) return null
    const coveredChains = index.version === 2 && Array.isArray(index.chainIds)
      ? index.chainIds.filter(isFlowSelectableChainId)
      : [56, 4663, 8453]
    if (!opts.chainIds.every((chainId) => coveredChains.includes(chainId))) return null
    const chainSet = new Set<FlowChainId>(opts.chainIds)
    const minUsd = Math.max(0, Number.isFinite(opts.minUsd) ? Number(opts.minUsd) : 100)
    const cutoff = Date.now() / 1000 - Math.max(1, Number(index.windowMinutes) || 45) * 60
    const events = index.events
      .map(restoreEvent)
      .filter((event): event is FlowEvent => (
        event != null
        && chainSet.has(event.chainId)
        && event.amountUsd >= minUsd
        && event.timestamp >= cutoff
      ))
      .sort((a, b) => b.timestamp - a.timestamp)
    // An empty filtered result is still a successful index response. Falling
    // back to RPC here would recreate the Base/BSC 429 storm for quiet pools or
    // a high minimum-amount filter.
    return {
      events,
      notices: Array.isArray(index.notices) ? index.notices : [],
      source: 'shared-index',
      generatedAt: Number(index.generatedAt),
    }
  } catch {
    return null
  }
}
