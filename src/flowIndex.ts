import type {
  FlowChainId,
  FlowEvent,
  FlowFetchOpts,
  FlowNotice,
} from './flowEvents'

type StoredFlowEvent = Omit<FlowEvent, 'blockNumber'> & { blockNumber?: string }

type SharedFlowIndex = {
  version: 1
  generatedAt: number
  windowMinutes: number
  events: StoredFlowEvent[]
  notices?: FlowNotice[]
}

export type SharedFlowResult = {
  events: FlowEvent[]
  notices: FlowNotice[]
  source: 'shared-index'
  generatedAt: number
}

// Scheduled Actions can occasionally start a few minutes late. Keep the last
// valid snapshot authoritative for up to two hours so a delayed deployment
// never sends every open browser back to the same rate-limited public RPC.
const MAX_INDEX_AGE_MS = 2 * 60 * 60_000
let rawIndexCache: { at: number; value: Partial<SharedFlowIndex> } | null = null
let rawIndexRequest: Promise<Partial<SharedFlowIndex> | null> | null = null

function restoreEvent(value: StoredFlowEvent): FlowEvent | null {
  if (
    !value
    || (value.chainId !== 56 && value.chainId !== 4663 && value.chainId !== 8453)
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
      index.version !== 1
      || !Number.isFinite(index.generatedAt)
      || Date.now() - Number(index.generatedAt) > MAX_INDEX_AGE_MS
      || !Array.isArray(index.events)
    ) return null
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
