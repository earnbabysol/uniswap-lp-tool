import type { Address } from 'viem'
import type { SupportedChainId } from './chain'

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2'
const API_VERSION = '20230203'
const CACHE_TTL_MS = 5 * 60_000

export type IndexedPoolRef = {
  ref: Address | `0x${string}`
  version: 'v3' | 'v4'
  name: string
  tvlUsd: number | null
  baseToken?: Address
  quoteToken?: Address
  baseSymbol?: string
  quoteSymbol?: string
  basePriceQuote?: number
}

export type MarketCandle = {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volumeUsd: number
}

type GeckoResource = {
  id?: string
  type?: string
  attributes?: Record<string, unknown>
  relationships?: Record<string, { data?: { id?: string; type?: string } | null }>
}

type GeckoResponse = {
  data?: GeckoResource | GeckoResource[]
  included?: GeckoResource[]
  meta?: {
    base?: { address?: string }
    quote?: { address?: string }
  }
}

type CachedValue = { at: number; value: unknown }
const memoryCache = new Map<string, CachedValue>()

type StaticPoolRow = {
  chainId: SupportedChainId
  version: 'v3' | 'v4'
  ref: string
  token0: Address
  token1: Address
  symbol0: string
  symbol1: string
  liquidityUsd?: number
}

function networkSlug(chainId: SupportedChainId): string | null {
  if (chainId === 1) return 'eth'
  if (chainId === 56) return 'bsc'
  if (chainId === 196) return 'x-layer'
  if (chainId === 4663) return 'robinhood'
  if (chainId === 8453) return 'base'
  if (chainId === 42161) return 'arbitrum'
  return null
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function appBaseUrl(): string {
  const configured = import.meta.env?.BASE_URL || '/'
  return configured.endsWith('/') ? configured : `${configured}/`
}

async function readStaticPools(): Promise<StaticPoolRow[]> {
  if (typeof window === 'undefined') return []
  const key = 'static:pools'
  const cached = memoryCache.get(key)
  if (cached && Date.now() - cached.at < 60_000) return cached.value as StaticPoolRow[]
  try {
    const bucket = Math.floor(Date.now() / 60_000)
    const response = await fetch(`${appBaseUrl()}index/pools.json?v=${bucket}`, { cache: 'no-store' })
    if (!response.ok) return []
    const json = await response.json() as { pools?: StaticPoolRow[] }
    const pools = Array.isArray(json.pools) ? json.pools : []
    memoryCache.set(key, { at: Date.now(), value: pools })
    return pools
  } catch {
    return []
  }
}

function staticToIndexed(row: StaticPoolRow): IndexedPoolRef {
  return {
    ref: row.ref as Address | `0x${string}`,
    version: row.version,
    name: `${row.symbol0} / ${row.symbol1}`,
    tvlUsd: finiteNumber(row.liquidityUsd),
    baseToken: row.token0,
    quoteToken: row.token1,
    baseSymbol: row.symbol0,
    quoteSymbol: row.symbol1,
  }
}

function mergePoolRefs(...lists: IndexedPoolRef[][]): IndexedPoolRef[] {
  const seen = new Set<string>()
  return lists.flat().filter((row) => {
    const key = `${row.version}:${row.ref.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function fetchGecko<T extends GeckoResponse>(path: string): Promise<T> {
  const cached = memoryCache.get(path)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value as T
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), 10_000)
  try {
    const response = await fetch(`${GECKO_BASE}${path}`, {
      headers: { Accept: `application/json;version=${API_VERSION}` },
      signal: ctrl.signal,
    })
    if (!response.ok) throw new Error(`市场索引 HTTP ${response.status}`)
    const value = await response.json() as T
    memoryCache.set(path, { at: Date.now(), value })
    if (memoryCache.size > 80) memoryCache.delete(memoryCache.keys().next().value ?? '')
    return value
  } finally {
    window.clearTimeout(timer)
  }
}

function tokenInfo(included: GeckoResource[] | undefined, id: string | undefined) {
  if (!id) return null
  const resource = included?.find((row) => row.type === 'token' && row.id === id)
  if (!resource) return null
  const address = resource.attributes?.address
  const symbol = resource.attributes?.symbol
  return {
    address: typeof address === 'string' ? address as Address : undefined,
    symbol: typeof symbol === 'string' ? symbol : undefined,
  }
}

function parsePoolRefs(json: GeckoResponse): IndexedPoolRef[] {
  const resources = Array.isArray(json.data) ? json.data : json.data ? [json.data] : []
  const out: IndexedPoolRef[] = []
  for (const resource of resources) {
    if (resource.type !== 'pool') continue
    const dexId = resource.relationships?.dex?.data?.id?.toLowerCase() ?? ''
    const version = dexId.includes('uniswap-v4')
      ? 'v4'
      : dexId.includes('uniswap-v3')
        ? 'v3'
        : null
    if (!version) continue
    const address = resource.attributes?.address
    if (typeof address !== 'string' || !/^0x[0-9a-f]{40}([0-9a-f]{24})?$/i.test(address)) continue
    const base = tokenInfo(json.included, resource.relationships?.base_token?.data?.id)
    const quote = tokenInfo(json.included, resource.relationships?.quote_token?.data?.id)
    out.push({
      ref: address as Address | `0x${string}`,
      version,
      name: typeof resource.attributes?.name === 'string' ? resource.attributes.name : 'Uniswap 池',
      tvlUsd: finiteNumber(resource.attributes?.reserve_in_usd),
      baseToken: base?.address,
      quoteToken: quote?.address,
      baseSymbol: base?.symbol,
      quoteSymbol: quote?.symbol,
      basePriceQuote: finiteNumber(resource.attributes?.base_token_price_quote_token) ?? undefined,
    })
  }
  const seen = new Set<string>()
  return out.filter((row) => {
    const key = `${row.version}:${row.ref.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function findIndexedPoolsByToken(
  chainId: SupportedChainId,
  token: Address,
): Promise<IndexedPoolRef[]> {
  const network = networkSlug(chainId)
  if (!network) return []
  const tokenLower = token.toLowerCase()
  const [local, json] = await Promise.all([
    readStaticPools(),
    fetchGecko<GeckoResponse>(
      `/networks/${network}/tokens/${tokenLower}/pools?page=1&include=base_token%2Cquote_token%2Cdex`,
    ),
  ])
  const localMatches = local
    .filter((row) => row.chainId === chainId && (
      row.token0.toLowerCase() === tokenLower || row.token1.toLowerCase() === tokenLower
    ))
    .map(staticToIndexed)
  return mergePoolRefs(localMatches, parsePoolRefs(json))
}

export async function searchIndexedPools(
  chainId: SupportedChainId,
  query: string,
): Promise<IndexedPoolRef[]> {
  const network = networkSlug(chainId)
  if (!network || !query.trim()) return []
  const needle = query.trim().toLowerCase()
  const [local, json] = await Promise.all([
    readStaticPools(),
    fetchGecko<GeckoResponse>(
      `/search/pools?query=${encodeURIComponent(query.trim())}&network=${network}&page=1&include=base_token%2Cquote_token%2Cdex`,
    ),
  ])
  const localMatches = local
    .filter((row) => row.chainId === chainId && [
      row.ref,
      row.token0,
      row.token1,
      row.symbol0,
      row.symbol1,
    ].some((value) => value.toLowerCase().includes(needle)))
    .map(staticToIndexed)
  return mergePoolRefs(localMatches, parsePoolRefs(json))
}

export async function fetchPoolCandles(opts: {
  chainId: SupportedChainId
  poolRef: string
  coinAddress: Address
  limit?: number
}): Promise<MarketCandle[]> {
  const network = networkSlug(opts.chainId)
  if (!network || !opts.poolRef) return []
  const limit = Math.min(240, Math.max(24, Math.floor(opts.limit ?? 120)))
  const json = await fetchGecko<GeckoResponse>(
    `/networks/${network}/pools/${opts.poolRef.toLowerCase()}/ohlcv/hour?aggregate=1&limit=${limit}&currency=token`,
  )
  const data = Array.isArray(json.data) ? json.data[0] : json.data
  const list = data?.attributes?.ohlcv_list
  if (!Array.isArray(list)) return []
  const base = json.meta?.base?.address?.toLowerCase()
  const quote = json.meta?.quote?.address?.toLowerCase()
  const coin = opts.coinAddress.toLowerCase()
  const invert = base !== coin && quote === coin

  const rows: MarketCandle[] = []
  for (const raw of list) {
    if (!Array.isArray(raw) || raw.length < 6) continue
    const timestamp = Number(raw[0])
    const openRaw = Number(raw[1])
    const highRaw = Number(raw[2])
    const lowRaw = Number(raw[3])
    const closeRaw = Number(raw[4])
    const volumeUsd = Math.max(0, Number(raw[5]) || 0)
    if (
      !Number.isFinite(timestamp)
      || !(openRaw > 0)
      || !(highRaw > 0)
      || !(lowRaw > 0)
      || !(closeRaw > 0)
    ) continue
    rows.push(invert
      ? {
        timestamp,
        open: 1 / openRaw,
        high: 1 / lowRaw,
        low: 1 / highRaw,
        close: 1 / closeRaw,
        volumeUsd,
      }
      : {
        timestamp,
        open: openRaw,
        high: highRaw,
        low: lowRaw,
        close: closeRaw,
        volumeUsd,
      })
  }
  rows.sort((a, b) => a.timestamp - b.timestamp)
  return rows
}
