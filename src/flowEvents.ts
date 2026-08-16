/**
 * LP 资金动向：Uniswap V3 + V4（BSC / Robinhood）。
 * V3：Subgraph 可选 + NPM 日志；V4：PoolManager.ModifyLiquidity。
 * The Graph API Key 非必须。
 */
import {
  createPublicClient,
  decodeEventLog,
  fallback,
  http,
  pad,
  parseAbiItem,
  slice,
  toEventSelector,
  zeroAddress,
  type AbiEvent,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem'
import {
  erc20Abi,
  v3FactoryAbi,
  v3NpmAbi,
  v3PoolAbi,
  v4PositionManagerAbi,
  v4StateViewAbi,
} from './abis'
import { fetchJson } from './async'
import { CHAIN_CONFIGS, type SupportedChainId } from './chain'
import { loadGraphApiKey } from './graphSettings'
import { checkPoolTokensSafe, isHoneypotWhitelisted } from './honeypot'
import { Q96, getAmountsForPosition, rawToNumber, tickToPrice } from './math'
import { loadCustomRpcUrl } from './rpcSettings'
import { classifyRpcError, readLogsAdaptive, runRpcTask } from './rpcScheduler'
import { takeFlowPoolEvents } from './flowSelection'

export { takeFlowPoolEvents } from './flowSelection'

/** 动向支持的链 */
export type FlowChainId = 56 | 4663

export type FlowSide = 'in' | 'out'
export type FlowVersion = 'v3' | 'v4'

export type FlowEvent = {
  id: string
  chainId: FlowChainId
  version: FlowVersion
  side: FlowSide
  timestamp: number
  /**
   * 可验证的锚定资金：只统计稳定币和包装原生币的实际数量。
   * 不使用池内新币的自报价，避免新池用极小对手盘伪造“大额”动向。
   */
  amountUsd: number
  /** V3 池地址；V4 无池合约，填 zeroAddress，用 poolId */
  poolAddress: Address
  poolId?: `0x${string}`
  token0: Address
  token1: Address
  symbol0: string
  symbol1: string
  fee: number
  txHash: Hash
  blockNumber?: bigint
  /** V3 为事件原始数量，V4 为按流动性变化与池价推算的数量 */
  amount0?: number
  amount1?: number
  amountEstimated?: boolean
  owner?: Address
  tokenId?: string
  source: 'subgraph' | 'logs'
  /** 最近窗口内、仅按稳定币或 WETH/WBNB 锚定的 Swap 成交额。 */
  windowSwapUsd?: number
  /** 最近窗口内按每笔实际费率估算的 LP 手续费。 */
  windowFeeUsd?: number
  /** 用于年化计算的流动性 USD 基数。 */
  aprLiquidityUsd?: number
  /** 简单年化（APR），不是复利 APY。 */
  feeAprPct?: number
  /** 窗口内可锚定的 Swap 笔数。 */
  aprSwapCount?: number
  /** APR 样本窗口；DexScreener 为 24h，链上精算回退为当前动向窗口。 */
  aprWindowMinutes?: number
  /** 成交额加权后的实际费率，单位为 1e-6。 */
  effectiveFeePips?: number
  /** 年化分母来源。 */
  aprBasis?: 'pool-balance' | 'active-liquidity' | 'dexscreener-liquidity'
  /** 山寨侧代币地址（非稳定币 / 非包装原生币） */
  coinAddress?: Address
  coinSymbol?: string
  /** DexScreener 市值（USD）；无则回退 FDV */
  marketCapUsd?: number
  /** 代币/交易对开盘时间（unix 秒，来自 pairCreatedAt） */
  tokenCreatedAt?: number
}

/** 复制 / 开仓用的池引用 */
export function flowPoolRef(e: FlowEvent): string {
  if (e.version === 'v4' && e.poolId) return e.poolId
  return e.poolAddress
}

export type FlowFetchOpts = {
  chainIds: FlowChainId[]
  minUsd?: number
  /** 默认 true */
  filterHoneypot?: boolean
  /** 池发现完成后先发布首屏；风险、市值与年化随后补齐。 */
  onBaseEvents?: (result: { events: FlowEvent[]; notices: FlowNotice[] }) => void
  /** 最大池数，而不是事件条数。 */
  limit?: number
}

export type FlowNotice = {
  level: 'warning' | 'error'
  message: string
}

// The Graph Explorer 上仍在索引的 BSC V3 deployment。Subgraph 只是可选加速层，
// 无 Key、过期、空结果或查询失败时都会回到链上日志。
const BSC_V3_SUBGRAPH_ID = '7XgdLW3bts4HktCYsu9dy8bEnuiNeZuftcuK3Aj4JXYV'
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

const INC_EVENT = parseAbiItem(
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
)
const DEC_EVENT = parseAbiItem(
  'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
)
const V3_POOL_MINT = parseAbiItem(
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
)
const V3_POOL_BURN = parseAbiItem(
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
)
const V4_MODIFY = parseAbiItem(
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
)
const V3_SWAP = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
)
const V4_SWAP = parseAbiItem(
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
)

export const FLOW_WINDOW_MINUTES = 45
const EVENT_TTL_MS = FLOW_WINDOW_MINUTES * 60_000
const WETH_USD_TTL_MS = 5 * 60_000
/** 年化依赖 Swap getLogs，TTL 拉长减轻公共 RPC / 主线程压力 */
const APR_TTL_MS = 180_000
/** DexScreener 精确池批量查询覆盖完整可见榜单。 */
const APR_POOL_LIMIT = 60
/** 模块级 Map 上限，防止长挂动向页缓涨内存 */
const POS_CACHE_CAP = 800
const POOL_CACHE_CAP = 600
const META_CACHE_CAP = 1_200
const V4_POOL_CACHE_CAP = 600

/**
 * 约 45 分钟的初次窗口。两条链当前都不是传统的 2~3 秒块：实测 BSC 约
 * 0.45s、Robinhood 约 0.1s。时间戳会再用窗口首尾区块动态校准。
 */
const LOG_SCAN: Record<FlowChainId, { lookback: bigint; span: bigint; reorg: bigint }> = {
  56: { lookback: 7_000n, span: 5_000n, reorg: 24n },
  4663: { lookback: 30_000n, span: 30_000n, reorg: 120n },
}

// Swap 比 NPM/ModifyLiquidity 密集几个数量级，不能沿用普通动向日志的大跨度；
// 否则公共 RPC 会把“结果过多”也当成 429。小块串行更稳定。
const APR_LOG_SPAN: Record<FlowChainId, bigint> = {
  56: 1_500n,
  4663: 5_000n,
}

type PosRow = {
  token0: Address
  token1: Address
  fee: number
  pool: Address
  symbol0: string
  symbol1: string
  decimals0: number
  decimals1: number
  price1Per0: number
}

type ChainLogCache = {
  tip: bigint
  events: FlowEvent[]
  pos: Map<string, PosRow>
  pools: Map<string, PosRow>
  meta: Map<string, { symbol: string; decimals: number }>
  metaPending: Map<string, Promise<{ symbol: string; decimals: number }>>
  wethUsd: number
  wethUsdAt: number
  wethUsdPromise: Promise<number> | null
  client: PublicClient | null
  clientKey: string
}

const logCaches: Record<FlowChainId, ChainLogCache> = {
  56: {
    tip: 0n,
    events: [],
    pos: new Map(),
    pools: new Map(),
    meta: new Map(),
    metaPending: new Map(),
    wethUsd: 0,
    wethUsdAt: 0,
    wethUsdPromise: null,
    client: null,
    clientKey: '',
  },
  4663: {
    tip: 0n,
    events: [],
    pos: new Map(),
    pools: new Map(),
    meta: new Map(),
    metaPending: new Map(),
    wethUsd: 0,
    wethUsdAt: 0,
    wethUsdPromise: null,
    client: null,
    clientKey: '',
  },
}

const receiptCaches: Record<FlowChainId, Map<string, Promise<TransactionReceipt>>> = {
  56: new Map(),
  4663: new Map(),
}

type V4PoolRow = {
  poolId: `0x${string}`
  token0: Address
  token1: Address
  symbol0: string
  symbol1: string
  decimals0: number
  decimals1: number
  fee: number
  sqrtPriceX96: bigint
  price1Per0: number
}

type V4Cache = {
  tip: bigint
  events: FlowEvent[]
  pools: Map<string, V4PoolRow>
}

const v4Caches: Record<FlowChainId, V4Cache> = {
  56: { tip: 0n, events: [], pools: new Map() },
  4663: { tip: 0n, events: [], pools: new Map() },
}

type StoredFlowEvent = Omit<FlowEvent, 'blockNumber'> & { blockNumber?: string }
type StoredFlowSnapshot = {
  version: 1 | 2
  savedAt: number
  v3Tip: string
  v4Tip: string
  v3Events: StoredFlowEvent[]
  v4Events: StoredFlowEvent[]
}

const FLOW_SNAPSHOT_LIMIT = 600
const hydratedFlowChains = new Set<FlowChainId>()

function flowSnapshotKey(chainId: FlowChainId): string {
  return `rangedesk.flow-scan.v2.${chainId}`
}

function storeFlowEvent(event: FlowEvent): StoredFlowEvent {
  const { blockNumber, ...rest } = event
  return { ...rest, blockNumber: blockNumber?.toString() }
}

function restoreFlowEvent(value: StoredFlowEvent, chainId: FlowChainId): FlowEvent | null {
  if (
    !value
    || value.chainId !== chainId
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

function hydrateFlowSnapshot(chainId: FlowChainId): void {
  if (hydratedFlowChains.has(chainId)) return
  hydratedFlowChains.add(chainId)
  if (typeof localStorage === 'undefined') return
  try {
    // v1 may contain a sparse list from the old event-count quota. Show those
    // rows immediately, but never restore its cursor: the v2 full pool scan
    // still runs and replaces it with the expanded list.
    const raw = localStorage.getItem(flowSnapshotKey(chainId))
      ?? localStorage.getItem(`rangedesk.flow-scan.v1.${chainId}`)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<StoredFlowSnapshot>
    if (parsed.version !== 1 && parsed.version !== 2) return
    const restoreList = (items: StoredFlowEvent[] | undefined, version: FlowVersion) => (
      Array.isArray(items)
        ? items
            .map((item) => restoreFlowEvent(item, chainId))
            .filter((event): event is FlowEvent => (
              event != null && event.version === version && isRecentTimestamp(event.timestamp)
            ))
        : []
    )
    logCaches[chainId].events = restoreList(parsed.v3Events, 'v3')
    v4Caches[chainId].events = restoreList(parsed.v4Events, 'v4')
    if (parsed.version === 2) {
      if (/^\d+$/.test(parsed.v3Tip ?? '')) logCaches[chainId].tip = BigInt(parsed.v3Tip!)
      if (/^\d+$/.test(parsed.v4Tip ?? '')) v4Caches[chainId].tip = BigInt(parsed.v4Tip!)
    }
  } catch {
    // Corrupt or old browser data is simply ignored; a fresh chain scan repairs it.
  }
}

function persistFlowSnapshot(chainId: FlowChainId): void {
  if (typeof localStorage === 'undefined') return
  try {
    const snapshot: StoredFlowSnapshot = {
      version: 2,
      savedAt: Date.now(),
      v3Tip: logCaches[chainId].tip.toString(),
      v4Tip: v4Caches[chainId].tip.toString(),
      v3Events: logCaches[chainId].events.slice(0, FLOW_SNAPSHOT_LIMIT).map(storeFlowEvent),
      v4Events: v4Caches[chainId].events.slice(0, FLOW_SNAPSHOT_LIMIT).map(storeFlowEvent),
    }
    localStorage.setItem(flowSnapshotKey(chainId), JSON.stringify(snapshot))
  } catch {
    // Storage quota/privacy mode must never make live monitoring fail.
  }
}

type FlowAprMetric = {
  windowSwapUsd: number
  windowFeeUsd: number
  aprLiquidityUsd?: number
  feeAprPct?: number
  aprSwapCount: number
  aprWindowMinutes?: number
  effectiveFeePips?: number
  aprBasis: 'pool-balance' | 'active-liquidity' | 'dexscreener-liquidity'
}

type FlowAprCacheEntry = {
  at: number
  metric: FlowAprMetric
}

const flowAprCache = new Map<string, FlowAprCacheEntry>()

type FlowMarketMeta = {
  coinAddress: Address
  coinSymbol: string
  marketCapUsd?: number
  tokenCreatedAt?: number
}

type FlowMarketCacheEntry = {
  at: number
  meta: FlowMarketMeta
}

const FLOW_MARKET_TTL_MS = 5 * 60_000
const FLOW_MARKET_CACHE_CAP = 800
const flowMarketCache = new Map<string, FlowMarketCacheEntry>()

function flowAprKey(chainId: FlowChainId, version: FlowVersion, poolRef: string): string {
  return `${chainId}:${version}:${poolRef.toLowerCase()}`
}

function flowMarketKey(chainId: FlowChainId, token: Address): string {
  return `${chainId}:${token.toLowerCase()}`
}

function dexScreenerChain(chainId: FlowChainId): string {
  return chainId === 56 ? 'bsc' : 'robinhood'
}

/** 动向对里的「山寨侧」：非稳定币、非 WETH/原生 */
function flowCoinSide(event: FlowEvent): { address: Address; symbol: string } | null {
  const cfg = CHAIN_CONFIGS[event.chainId]
  const stables = new Set(
    [cfg.contracts.stable, ...(cfg.usdStables ?? [])].map((x) => x.toLowerCase()),
  )
  const weth = cfg.contracts.weth.toLowerCase()
  const isAnchor = (addr: Address) => {
    const lower = addr.toLowerCase()
    return lower === weth || lower === zeroAddress || stables.has(lower)
  }
  const a0 = isAnchor(event.token0)
  const a1 = isAnchor(event.token1)
  if (a0 && !a1) return { address: event.token1, symbol: event.symbol1 }
  if (a1 && !a0) return { address: event.token0, symbol: event.symbol0 }
  // 两边都是山寨时取 token0，方便至少能挂上一条市值
  if (!a0 && !a1) return { address: event.token0, symbol: event.symbol0 }
  return null
}

function clearFlowAprCache(chainId: FlowChainId): void {
  const prefix = `${chainId}:`
  for (const key of flowAprCache.keys()) {
    if (key.startsWith(prefix)) flowAprCache.delete(key)
  }
}

/** Map 过大时删最早插入的一批（JS Map 保插入序） */
function pruneMapSize<K, V>(map: Map<K, V>, cap: number): void {
  if (map.size <= cap) return
  const keep = Math.floor(cap * 0.75)
  const drop = map.size - keep
  let i = 0
  for (const key of map.keys()) {
    map.delete(key)
    if (++i >= drop) break
  }
}

function pruneChainCaches(chainId: FlowChainId): void {
  const c = logCaches[chainId]
  pruneMapSize(c.pos, POS_CACHE_CAP)
  pruneMapSize(c.pools, POOL_CACHE_CAP)
  pruneMapSize(c.meta, META_CACHE_CAP)
  pruneMapSize(v4Caches[chainId].pools, V4_POOL_CACHE_CAP)
}

function asErc20(chainId: FlowChainId, currency: Address): Address {
  if (currency === zeroAddress || currency.toLowerCase() === zeroAddress) {
    return CHAIN_CONFIGS[chainId].contracts.weth
  }
  return currency
}

function clampUsd(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0
  if (n > 1e12) return 1e12
  return n
}

function makeClient(chainId: FlowChainId): PublicClient {
  const cfg = CHAIN_CONFIGS[chainId]
  const custom = loadCustomRpcUrl(chainId)
  // Binance dataseed 当前会对 eth_getLogs 直接返回 “Request exceeds defined
  // limit”，哪怕只查 10 个块。动向扫描优先使用支持日志的 PublicNode；普通
  // 合约读取仍可由 fallback 中的官方 dataseed 承担。
  const defaults = chainId === 56
    ? ['https://bsc.publicnode.com', ...cfg.defaultRpcUrls]
    : [...cfg.defaultRpcUrls]
  const urls = [...new Set([...(custom ? [custom] : []), ...defaults])]
  return createPublicClient({
    chain: cfg.chain,
    transport: fallback(
      urls.map((url, i) =>
        http(url, {
          // BSC PublicNode 批量调用稳定；Robinhood 公共节点对 batch 很容易
          // 429，逐请求配合下方并发上限反而更快。
          batch: chainId === 56 ? { batchSize: 20, wait: 12 } : false,
          timeout: chainId === 56 ? (i === 0 ? 8_000 : 7_000) : i === 0 ? 8_000 : 10_000,
          retryCount: 0,
        }),
      ),
      { rank: false },
    ),
  })
}

function getClient(chainId: FlowChainId): PublicClient {
  hydrateFlowSnapshot(chainId)
  const c = logCaches[chainId]
  const clientKey = loadCustomRpcUrl(chainId) ?? '<default>'
  // 设置页修改 RPC 后不需要刷新整个页面。
  if (!c.client || c.clientKey !== clientKey) {
    c.client = makeClient(chainId)
    c.clientKey = clientKey
    clearFlowAprCache(chainId)
  }
  return c.client
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const out = new Array<R>(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx]!)
    }
  })
  await Promise.all(workers)
  return out
}

type UnknownCallResult =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error: unknown }

async function readBatch(
  client: PublicClient,
  contracts: readonly unknown[],
): Promise<UnknownCallResult[]> {
  if (contracts.length === 0) return []
  // Robinhood 的公共 RPC 对超大 eth_call / batch 很容易 429。Multicall3 仍然
  // 批量读，但按固定大小拆包；mapPool 保持原顺序，调用方可继续按下标配对。
  const isRobinhood = client.chain?.id === 4663
  const chunkSize = isRobinhood ? 60 : 160
  const chunks: Array<readonly unknown[]> = []
  for (let i = 0; i < contracts.length; i += chunkSize) {
    chunks.push(contracts.slice(i, i + chunkSize))
  }
  const nested = await mapPool(chunks, isRobinhood ? 1 : 2, async (chunk) => (
    client.multicall({
      allowFailure: true,
      contracts: chunk as never,
      multicallAddress: MULTICALL3,
    }) as unknown as Promise<UnknownCallResult[]>
  ))
  return nested.flat()
}

type ScanHead = {
  latest: bigint
  latestTs: number
  windowStart: bigint
  windowStartTs: number
  secondsPerBlock: number
}

const scanHeadCaches: Record<FlowChainId, { at: number; promise: Promise<ScanHead> | null }> = {
  56: { at: 0, promise: null },
  4663: { at: 0, promise: null },
}

/** V3/V4 同轮刷新共享链头，并用真实首尾时间校准高频出块链。 */
async function getScanHead(client: PublicClient, chainId: FlowChainId): Promise<ScanHead> {
  const cached = scanHeadCaches[chainId]
  if (cached.promise && Date.now() - cached.at < 5_000) return cached.promise
  const promise = (async () => {
    const latest = await client.getBlockNumber()
    const latestBlock = await client.getBlock({ blockNumber: latest })
    const lookback = LOG_SCAN[chainId].lookback
    const windowStart = latest > lookback ? latest - lookback : 0n
    const firstBlock = windowStart === latest
      ? latestBlock
      : await client.getBlock({ blockNumber: windowStart })
    const latestTs = Number(latestBlock.timestamp)
    const windowStartTs = Number(firstBlock.timestamp)
    const blockCount = Number(latest - windowStart)
    const measured = blockCount > 0 ? (latestTs - windowStartTs) / blockCount : 0
    return {
      latest,
      latestTs,
      windowStart,
      windowStartTs,
      secondsPerBlock: Number.isFinite(measured) && measured > 0 ? measured : 1,
    }
  })()
  cached.at = Date.now()
  cached.promise = promise
  try {
    return await promise
  } catch (e) {
    if (cached.promise === promise) cached.promise = null
    throw e
  }
}

function estimatedBlockTimestamp(head: ScanHead, blockNumber: bigint): number {
  if (blockNumber <= head.windowStart) return head.windowStartTs
  if (blockNumber >= head.latest) return head.latestTs
  const ageBlocks = Number(head.latest - blockNumber)
  return Math.round(head.latestTs - ageBlocks * head.secondsPerBlock)
}

function isRecentTimestamp(timestamp: number, now = Date.now()): boolean {
  const age = now - timestamp * 1000
  return Number.isFinite(age) && age >= -120_000 && age <= EVENT_TTL_MS
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isRateLimitError(error: unknown): boolean {
  return classifyRpcError(error) === 'rate-limit'
}

async function retryRateLimited<T>(chainId: FlowChainId, run: () => Promise<T>): Promise<T> {
  return runRpcTask({ chainId, lane: 'read', task: run })
}

function friendlyErrorText(error: unknown): string {
  const full = errorText(error)
  const lower = full.toLowerCase()
  if (lower.includes('429') || lower.includes('rate limit')) return 'RPC 请求过于频繁（429），已保留上次数据'
  if (lower.includes('request exceeds defined limit')) return 'RPC 不支持该日志查询范围，请更换 RPC'
  if (lower.includes('missing trie node')) return 'RPC 不支持所需的历史状态读取'
  if (lower.includes('timed out') || lower.includes('timeout')) return 'RPC 响应超时，已保留上次数据'
  if (lower.includes('failed to fetch') || lower.includes('http request failed')) return 'RPC 网络请求失败'
  const firstLine = full.split(/\r?\n/, 1)[0]?.trim() || '未知错误'
  return firstLine.length > 220 ? `${firstLine.slice(0, 217)}…` : firstLine
}

type IndexedTopicPosition = 1 | 2 | 3

type FlowDecodedLog<TArgs> = {
  address: Address
  args: TArgs
  transactionHash: Hash
  logIndex: number
  blockNumber: bigint
}

type BlockscoutV2Log = {
  address?: string | { hash?: string }
  block_number?: number
  data?: string
  index?: number
  topics?: Array<string | null>
  transaction_hash?: string
}

type BlockscoutV2LogsResponse = {
  items?: BlockscoutV2Log[]
  next_page_params?: Record<string, string | number | null> | null
}

type BlockscoutRpcLog = {
  address?: string
  blockNumber?: string
  data?: string
  logIndex?: string
  topics?: Array<string | null>
  transactionHash?: string
}

type BlockscoutRpcLogsResponse = {
  status?: string
  message?: string
  result?: BlockscoutRpcLog[] | string
}

function addressTopic(address: Address): Hex {
  return pad(address, { size: 32 })
}

/**
 * Robinhood's public RPC is rate limited and explicitly not intended for a
 * production log indexer. Blockscout exposes the already-indexed logs via its
 * paginated v2 API, so historical V3/V4 scans do not need eth_getLogs at all.
 */
async function readRobinhoodV2Logs<TArgs>(opts: {
  event: AbiEvent
  address: Address
  indexedTopics?: Partial<Record<IndexedTopicPosition, Hex>>
  fromBlock: bigint
  toBlock: bigint
  label: string
}): Promise<FlowDecodedLog<TArgs>[]> {
  const cfg = CHAIN_CONFIGS[4663]
  const topic0 = toEventSelector(opts.event)
  // The v2 endpoint can match a topic in any indexed position. Prefer the
  // most selective indexed filter (pool id / sender); otherwise use topic0.
  const queryTopic = ([3, 2, 1] as const)
    .map((position) => opts.indexedTopics?.[position])
    .find((topic): topic is Hex => Boolean(topic)) ?? topic0
  const output: FlowDecodedLog<TArgs>[] = []
  let pageParams: Record<string, string | number | null> = { topic: queryTopic }

  for (let page = 0; page < 250; page += 1) {
    const url = new URL(`${cfg.explorerApi}/api/v2/addresses/${opts.address}/logs`)
    for (const [key, value] of Object.entries(pageParams)) {
      if (value != null) url.searchParams.set(key, String(value))
    }
    const payload = await runRpcTask({
      chainId: 4663,
      lane: 'indexer',
      label: `${opts.label} (Blockscout)`,
      task: () => fetchJson<BlockscoutV2LogsResponse>(url.toString(), 15_000),
    })
    if (!Array.isArray(payload.items)) throw new Error('Blockscout 日志响应格式异常')
    let reachedWindowStart = false
    for (const raw of payload.items) {
      const blockNumber = BigInt(raw.block_number ?? 0)
      if (blockNumber > opts.toBlock) continue
      if (blockNumber < opts.fromBlock) {
        reachedWindowStart = true
        continue
      }
      const topics = (raw.topics ?? [])
        .filter((topic): topic is Hex => typeof topic === 'string' && topic.startsWith('0x'))
      if (topics[0]?.toLowerCase() !== topic0.toLowerCase()) continue
      const indexedMatch = ([1, 2, 3] as const).every((position) => {
        const expected = opts.indexedTopics?.[position]
        return !expected || topics[position]?.toLowerCase() === expected.toLowerCase()
      })
      if (!indexedMatch) continue
      const address = typeof raw.address === 'string' ? raw.address : raw.address?.hash
      if (topics.length === 0 || !raw.data || !address || !raw.transaction_hash) {
        throw new Error('Blockscout 返回了不完整的日志')
      }
      const decoded = decodeEventLog({
        abi: [opts.event],
        data: raw.data as Hex,
        topics: topics as [Hex, ...Hex[]],
        strict: false,
      })
      output.push({
        address: address as Address,
        args: decoded.args as TArgs,
        transactionHash: raw.transaction_hash as Hash,
        logIndex: raw.index ?? 0,
        blockNumber,
      })
    }
    if (
      reachedWindowStart
      || !payload.next_page_params
      || Object.keys(payload.next_page_params).length === 0
    ) return output
    pageParams = payload.next_page_params
  }
  throw new Error(`Blockscout ${opts.label} 分页超过安全上限`)
}

type RobinhoodEventLogCache = {
  fromBlock: bigint
  toBlock: bigint
  logs: FlowDecodedLog<unknown>[]
}

const robinhoodEventLogCaches = new Map<string, RobinhoodEventLogCache>()

function decodeRobinhoodLogs<TArgs>(opts: {
  logs: BlockscoutV2Log[]
  event: AbiEvent
  indexedTopics?: Partial<Record<IndexedTopicPosition, Hex>>
  fromBlock: bigint
  toBlock: bigint
}): FlowDecodedLog<TArgs>[] {
  const topic0 = toEventSelector(opts.event).toLowerCase()
  const output: FlowDecodedLog<TArgs>[] = []
  for (const raw of opts.logs) {
    const blockNumber = BigInt(raw.block_number ?? 0)
    if (blockNumber < opts.fromBlock || blockNumber > opts.toBlock) continue
    const topics = (raw.topics ?? [])
      .filter((topic): topic is Hex => typeof topic === 'string' && topic.startsWith('0x'))
    if (topics[0]?.toLowerCase() !== topic0) continue
    const indexedMatch = ([1, 2, 3] as const).every((position) => {
      const expected = opts.indexedTopics?.[position]
      return !expected || topics[position]?.toLowerCase() === expected.toLowerCase()
    })
    if (!indexedMatch) continue
    const address = typeof raw.address === 'string' ? raw.address : raw.address?.hash
    if (!raw.data || !address || !raw.transaction_hash) continue
    const decoded = decodeEventLog({
      abi: [opts.event],
      data: raw.data as Hex,
      topics: topics as [Hex, ...Hex[]],
      strict: false,
    })
    output.push({
      address: address as Address,
      args: decoded.args as TArgs,
      transactionHash: raw.transaction_hash as Hash,
      logIndex: raw.index ?? 0,
      blockNumber,
    })
  }
  return output
}

function blockscoutQuantity(value: string | undefined): bigint {
  if (!value || value === '0x') return 0n
  try {
    return BigInt(value)
  } catch {
    return 0n
  }
}

/**
 * Blockscout's Etherscan-compatible log endpoint accepts address + indexed
 * topics + an exact block range and returns up to 1,000 rows. It is much
 * faster for movement discovery than exporting every PoolManager log to CSV.
 * When the cap is reached, bisect the block range so no rows are truncated.
 */
async function readRobinhoodRpcApiLogs<TArgs>(opts: {
  event: AbiEvent
  address: Address
  indexedTopics?: Partial<Record<IndexedTopicPosition, Hex>>
  fromBlock: bigint
  toBlock: bigint
  label: string
}): Promise<FlowDecodedLog<TArgs>[]> {
  const cfg = CHAIN_CONFIGS[4663]
  const topic0 = toEventSelector(opts.event)

  const readRange = async (fromBlock: bigint, toBlock: bigint): Promise<BlockscoutV2Log[]> => {
    const url = new URL(`${cfg.explorerApi}/api`)
    url.searchParams.set('module', 'logs')
    url.searchParams.set('action', 'getLogs')
    url.searchParams.set('fromBlock', fromBlock.toString())
    url.searchParams.set('toBlock', toBlock.toString())
    url.searchParams.set('address', opts.address)
    url.searchParams.set('topic0', topic0)
    for (const position of [1, 2, 3] as const) {
      const topic = opts.indexedTopics?.[position]
      if (!topic) continue
      url.searchParams.set(`topic${position}`, topic)
      url.searchParams.set(`topic0_${position}_opr`, 'and')
    }
    const payload = await runRpcTask({
      chainId: 4663,
      lane: 'indexer',
      label: `${opts.label} (Blockscout getLogs)`,
      // Robinhood Blockscout's anonymous quota is tiny. A 429 is not a
      // transient RPC hiccup: retrying it three times used to leave the page
      // blank for 20-30 seconds and consumed the next quota window as well.
      retries: 0,
      task: () => fetchJson<BlockscoutRpcLogsResponse>(url.toString(), 15_000),
    })
    if (!Array.isArray(payload.result)) {
      const message = `${payload.message ?? ''} ${String(payload.result ?? '')}`.trim()
      if (/no (logs|records) found/i.test(message)) return []
      throw new Error(message || 'Blockscout getLogs 响应格式异常')
    }
    const rows = payload.result.map((raw): BlockscoutV2Log => ({
      address: raw.address,
      block_number: Number(blockscoutQuantity(raw.blockNumber)),
      data: raw.data,
      index: Number(blockscoutQuantity(raw.logIndex)),
      topics: raw.topics,
      transaction_hash: raw.transactionHash,
    }))
    if (rows.length >= 1_000 && fromBlock < toBlock) {
      const middle = fromBlock + (toBlock - fromBlock) / 2n
      const [left, right] = await Promise.all([
        readRange(fromBlock, middle),
        readRange(middle + 1n, toBlock),
      ])
      return [...left, ...right]
    }
    return rows
  }

  const logs = await readRange(opts.fromBlock, opts.toBlock)
  return decodeRobinhoodLogs<TArgs>({
    logs,
    event: opts.event,
    indexedTopics: opts.indexedTopics,
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock,
  })
}

async function readRobinhoodIndexedLogs<TArgs>(opts: {
  event: AbiEvent
  address: Address
  indexedTopics?: Partial<Record<IndexedTopicPosition, Hex>>
  fromBlock: bigint
  toBlock: bigint
  label: string
}): Promise<FlowDecodedLog<TArgs>[]> {
  const addressKey = opts.address.toLowerCase()
  const topicKey = ([1, 2, 3] as const)
    .map((position) => opts.indexedTopics?.[position]?.toLowerCase() ?? '')
    .join(':')
  const cacheKey = `${addressKey}:${toEventSelector(opts.event).toLowerCase()}:${topicKey}`

  const readRange = async (fromBlock: bigint, toBlock: bigint) => {
    const rangeOpts = { ...opts, fromBlock, toBlock }
    try {
      return await readRobinhoodRpcApiLogs<TArgs>(rangeOpts)
    } catch (error) {
      // Both API versions share the instance quota. Falling straight into a
      // 50-row paginated crawl after a 429 only turns an APR miss into a
      // minute-long refresh. Preserve the base list and retry next cycle.
      if (classifyRpcError(error) === 'rate-limit') throw error
      if (import.meta.env.DEV) {
        console.debug(`[flow] ${opts.label} getLogs 降级到 v2 分页：${friendlyErrorText(error)}`)
      }
      return readRobinhoodV2Logs<TArgs>(rangeOpts)
    }
  }

  let eventCache = robinhoodEventLogCaches.get(cacheKey)
  if (!eventCache || opts.fromBlock < eventCache.fromBlock) {
    const logs = await readRange(opts.fromBlock, opts.toBlock)
    eventCache = {
      fromBlock: opts.fromBlock,
      toBlock: opts.toBlock,
      logs: logs as FlowDecodedLog<unknown>[],
    }
    robinhoodEventLogCaches.set(cacheKey, eventCache)
    if (robinhoodEventLogCaches.size > 200) {
      const oldest = robinhoodEventLogCaches.keys().next().value as string | undefined
      if (oldest) robinhoodEventLogCaches.delete(oldest)
    }
  }

  if (opts.toBlock > eventCache.toBlock) {
    const deltaFrom = eventCache.toBlock + 1n
    const delta = await readRange(deltaFrom, opts.toBlock)
    const merged = new Map<string, FlowDecodedLog<unknown>>()
    for (const log of eventCache.logs) {
      merged.set(`${log.transactionHash}:${log.logIndex}`, log)
    }
    for (const log of delta) {
      merged.set(`${log.transactionHash}:${log.logIndex}`, log as FlowDecodedLog<unknown>)
    }
    eventCache.logs = [...merged.values()]
    eventCache.toBlock = opts.toBlock
  }

  return eventCache.logs
    .filter((log) => log.blockNumber >= opts.fromBlock && log.blockNumber <= opts.toBlock)
    .map((log) => log as FlowDecodedLog<TArgs>)
}

/** Prefer Robinhood's indexed API, with RPC as a compatibility fallback. */
async function readFlowLogs<TArgs>(opts: {
  chainId: FlowChainId
  event: AbiEvent
  explorerAddress?: Address
  explorerIndexedTopics?: Partial<Record<IndexedTopicPosition, Hex>>
  fromBlock: bigint
  toBlock: bigint
  maxSpan: bigint
  label: string
  /** Movement discovery may use small public-RPC chunks when Blockscout is out of quota. */
  allowPublicRpcFallback?: boolean
  /** Private-RPC APR fallback can bypass Blockscout to preserve indexer quota. */
  preferIndexer?: boolean
  request: (fromBlock: bigint, toBlock: bigint) => Promise<readonly FlowDecodedLog<TArgs>[]>
}): Promise<FlowDecodedLog<TArgs>[]> {
  if (opts.chainId === 4663 && opts.explorerAddress && opts.preferIndexer !== false) {
    try {
      return await readRobinhoodIndexedLogs<TArgs>({
        event: opts.event,
        address: opts.explorerAddress,
        indexedTopics: opts.explorerIndexedTopics,
        fromBlock: opts.fromBlock,
        toBlock: opts.toBlock,
        label: opts.label,
      })
    } catch (error) {
      const customRpc = loadCustomRpcUrl(4663)
      if (import.meta.env.DEV) {
        const target = customRpc
          ? '自定义 RPC'
          : opts.allowPublicRpcFallback ? '小分片公共 RPC' : '缓存保护'
        console.debug(`[flow] ${opts.label} Blockscout 转入${target}：${friendlyErrorText(error)}`)
      }
      // Swap/APR scans remain indexer-or-custom-RPC only. The three selective
      // movement topics are safe to fall back to small public-RPC chunks, so a
      // fresh browser still gets pools when Blockscout's hourly quota is full.
      if (!customRpc && !opts.allowPublicRpcFallback) throw error
    }
  }
  const fallbackSpan = opts.chainId === 4663 && opts.allowPublicRpcFallback
    ? (opts.maxSpan < 10_000n ? opts.maxSpan : 10_000n)
    : opts.maxSpan
  return readLogsAdaptive({
    chainId: opts.chainId,
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock,
    maxSpan: fallbackSpan,
    label: opts.label,
    request: opts.request,
  })
}

async function timedSource<T>(label: string, promise: Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    return await promise
  } finally {
    if (import.meta.env.DEV) {
      console.debug(`[flow] ${label}: ${Math.round(performance.now() - started)}ms`)
    }
  }
}

function isInvalidTokenIdError(error: unknown): boolean {
  const message = errorText(error).toLowerCase()
  return message.includes('invalid token id') || message.includes('nonexistent token')
}

async function tokenMeta(
  client: PublicClient,
  chainId: FlowChainId,
  addr: Address,
): Promise<{ symbol: string; decimals: number }> {
  const resolved = asErc20(chainId, addr)
  const key = resolved.toLowerCase()
  const known = CHAIN_CONFIGS[chainId].knownTokens[key]
  if (known) return known
  const cache = logCaches[chainId]
  const hit = cache.meta.get(key)
  if (hit) return hit
  const inFlight = cache.metaPending.get(key)
  if (inFlight) return inFlight
  const pending = (async () => {
    const [symbolResult, decimalsResult] = await Promise.allSettled([
      client.readContract({ address: resolved, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: resolved, abi: erc20Abi, functionName: 'decimals' }),
    ])
    // symbol 不规范很常见，可以降级；decimals 错了会把 $100 显示成数万亿，
    // 因此读取失败时让本轮重试，绝不默认为 18 后继续推进扫描游标。
    if (decimalsResult.status === 'rejected') {
      throw new Error(`读取代币精度失败：${resolved}`)
    }
    const decimals = Number(decimalsResult.value)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
      throw new Error(`代币精度异常：${resolved}`)
    }
    const rawSymbol = symbolResult.status === 'fulfilled' ? String(symbolResult.value).trim() : ''
    const symbol = rawSymbol ? rawSymbol.slice(0, 32) : `${resolved.slice(0, 6)}…`
    const row = { symbol, decimals }
    cache.meta.set(key, row)
    return row
  })()
  cache.metaPending.set(key, pending)
  try {
    return await pending
  } finally {
    if (cache.metaPending.get(key) === pending) cache.metaPending.delete(key)
  }
}

async function tokenMetaBatch(
  client: PublicClient,
  chainId: FlowChainId,
  addresses: Address[],
): Promise<Map<string, { symbol: string; decimals: number }>> {
  const cfg = CHAIN_CONFIGS[chainId]
  const cache = logCaches[chainId]
  const resolved = addresses.map((address) => asErc20(chainId, address))
  const unique = resolved.filter((address, i, all) =>
    all.findIndex((item) => item.toLowerCase() === address.toLowerCase()) === i)
  const out = new Map<string, { symbol: string; decimals: number }>()
  const missing: Address[] = []
  for (const address of unique) {
    const key = address.toLowerCase()
    const known = cfg.knownTokens[key] ?? cache.meta.get(key)
    if (known) out.set(key, known)
    else missing.push(address)
  }
  if (missing.length === 0) return out

  const calls = missing.flatMap((address) => [
    { address, abi: erc20Abi, functionName: 'symbol' },
    { address, abi: erc20Abi, functionName: 'decimals' },
  ])
  const results = await readBatch(client, calls)
  for (let i = 0; i < missing.length; i += 1) {
    const address = missing[i]!
    const symbolResult = results[i * 2]
    const decimalsResult = results[i * 2 + 1]
    // 非标准/恶意 token 若连 decimals 都不给，不显示该池，避免错误 USD；
    // 单个 token 失败不应拖垮整条链。
    if (decimalsResult?.status !== 'success') continue
    const decimals = Number(decimalsResult.result)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) continue
    const rawSymbol = symbolResult?.status === 'success' ? String(symbolResult.result).trim() : ''
    const symbol = rawSymbol ? rawSymbol.slice(0, 32) : `${address.slice(0, 6)}…`
    const meta = { symbol, decimals }
    const key = address.toLowerCase()
    cache.meta.set(key, meta)
    out.set(key, meta)
  }
  return out
}

async function fetchWethUsdOnChain(client: PublicClient, chainId: FlowChainId): Promise<number> {
  const cache = logCaches[chainId]
  if (cache.wethUsd > 0 && Date.now() - cache.wethUsdAt < WETH_USD_TTL_MS) {
    return cache.wethUsd
  }
  const cfg = CHAIN_CONFIGS[chainId]
  const weth = cfg.contracts.weth
  const stables = [cfg.contracts.stable, ...(cfg.usdStables ?? [])]
  const stableSet = new Set(stables.map((s) => s.toLowerCase()))
  const factories = [
    cfg.contracts.v3Factory,
    ...(cfg.altV3Factories ?? []).map((dex) => dex.factory),
  ].filter((factory, i, all) => all.findIndex((x) => x.toLowerCase() === factory.toLowerCase()) === i)
  const fees = [100, 500, 2_500, 3_000, 10_000]
  const jobs = factories.flatMap((factory) =>
    fees.flatMap((fee) => stables.map((stable) => ({ factory, fee, stable }))))
  const poolResults = await readBatch(client, jobs.map((job) => ({
    address: job.factory,
    abi: v3FactoryAbi,
    functionName: 'getPool',
    args: [weth, job.stable, job.fee],
  })))
  const seenPools = new Set<string>()
  const pools: Address[] = []
  for (const result of poolResults) {
    if (result?.status !== 'success') continue
    const pool = result.result as Address
    if (!pool || pool === zeroAddress || seenPools.has(pool.toLowerCase())) continue
    seenPools.add(pool.toLowerCase())
    pools.push(pool)
  }
  const results = await mapPool(pools, chainId === 4663 ? 1 : chainId === 56 ? 3 : 5, async (pool) => {
    try {
      const detailResults = await readBatch(client, [
        { address: pool, abi: v3PoolAbi, functionName: 'slot0' },
        { address: pool, abi: v3PoolAbi, functionName: 'token0' },
        { address: pool, abi: v3PoolAbi, functionName: 'token1' },
        { address: pool, abi: v3PoolAbi, functionName: 'liquidity' },
      ])
      const slotResult = detailResults[0]
      const token0Result = detailResults[1]
      const token1Result = detailResults[2]
      const liquidityResult = detailResults[3]
      if (
        slotResult?.status !== 'success'
        || token0Result?.status !== 'success'
        || token1Result?.status !== 'success'
        || liquidityResult?.status !== 'success'
      ) return null
      const slot0 = slotResult.result as readonly unknown[]
      const token0 = token0Result.result as Address
      const token1 = token1Result.result as Address
      const liquidity = BigInt(liquidityResult.result as bigint)
      const [m0, m1] = await Promise.all([
        tokenMeta(client, chainId, token0),
        tokenMeta(client, chainId, token1),
      ])
      const price1Per0 = tickToPrice(Number(slot0[1]), m0.decimals, m1.decimals)
      if (!(price1Per0 > 0)) return null
      const t0 = token0.toLowerCase()
      const t1 = token1.toLowerCase()
      const w = weth.toLowerCase()
      const usd = t0 === w && stableSet.has(t1)
        ? price1Per0
        : t1 === w && stableSet.has(t0)
          ? 1 / price1Per0
          : 0
      if (!(usd >= 1 && usd <= 1_000_000)) return null
      return { usd, liquidity }
    } catch {
      return null
    }
  })
  // 同一交易对优先采用流动性最大的池，避免一个几美元的异常池把整页 USD
  // 金额带偏；BSC 也可借 Pancake 深池给 Uniswap 事件做 WBNB 计价。
  const best = results
    .filter((x): x is { usd: number; liquidity: bigint } => x != null)
    .sort((a, b) => (a.liquidity === b.liquidity ? 0 : a.liquidity > b.liquidity ? -1 : 1))[0]
  const usd = best?.usd ?? cache.wethUsd
  if (usd > 0) {
    cache.wethUsd = usd
    cache.wethUsdAt = Date.now()
  }
  return usd
}

async function wethUsdOnChain(client: PublicClient, chainId: FlowChainId): Promise<number> {
  const cache = logCaches[chainId]
  if (cache.wethUsd > 0 && Date.now() - cache.wethUsdAt < WETH_USD_TTL_MS) {
    return cache.wethUsd
  }
  if (cache.wethUsdPromise) return cache.wethUsdPromise
  const pending = fetchWethUsdOnChain(client, chainId)
  cache.wethUsdPromise = pending
  try {
    return await pending
  } finally {
    if (cache.wethUsdPromise === pending) cache.wethUsdPromise = null
  }
}

function anchoredUsdFromUnits(opts: {
  amount0: number
  amount1: number
  token0: Address
  token1: Address
  weth: Address
  stables: Address[]
  wethUsd: number
}): number {
  const w = opts.weth.toLowerCase()
  const stables = new Set(opts.stables.map((s) => s.toLowerCase()))
  const usdOf = (token: Address, amount: number): number => {
    if (!(amount > 0) || !Number.isFinite(amount)) return 0
    const address = token.toLowerCase()
    if (stables.has(address)) return amount
    if (address === w && opts.wethUsd > 0) return amount * opts.wethUsd
    return 0
  }
  return clampUsd(usdOf(opts.token0, opts.amount0) + usdOf(opts.token1, opts.amount1))
}

function amountUsdSimple(opts: {
  amount0: bigint
  amount1: bigint
  decimals0: number
  decimals1: number
  token0: Address
  token1: Address
  weth: Address
  stables: Address[]
  wethUsd: number
}): number {
  const q0 = rawToNumber(opts.amount0, opts.decimals0)
  const q1 = rawToNumber(opts.amount1, opts.decimals1)
  return anchoredUsdFromUnits({
    amount0: q0,
    amount1: q1,
    token0: opts.token0,
    token1: opts.token1,
    weth: opts.weth,
    stables: opts.stables,
    wethUsd: opts.wethUsd,
  })
}

function isGraphAuthError(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes('api key')
    || m.includes('auth')
    || m.includes('unauthorized')
    || m.includes('forbidden')
    || m.includes('401')
    || m.includes('403')
  )
}

type GraphV3FlowRow = {
  id: string
  timestamp: string
  amountUSD: string
  amount0?: string
  amount1?: string
  owner?: string
  pool: {
    id: string
    feeTier: string
    token0: { id: string; symbol: string; decimals?: string }
    token1: { id: string; symbol: string; decimals?: string }
  }
  transaction: { id: string }
}

async function fetchBscSubgraph(opts: {
  minUsd: number
  limit: number
}): Promise<{ events: FlowEvent[]; error?: string; authFailed?: boolean }> {
  const key = loadGraphApiKey()
  if (!key) {
    return { events: [], error: undefined }
  }
  const endpoint =
    `https://gateway.thegraph.com/api/${encodeURIComponent(key)}/subgraphs/id/${BSC_V3_SUBGRAPH_ID}`
  const min = String(opts.minUsd)
  const take = Math.min(1_000, Math.max(200, opts.limit * 20))
  const query = `{
    mints(first: ${take}, orderBy: timestamp, orderDirection: desc, where: { amountUSD_gte: "${min}" }) {
      id timestamp amountUSD amount0 amount1 owner
      pool { id feeTier token0 { id symbol decimals } token1 { id symbol decimals } }
      transaction { id }
    }
    burns(first: ${take}, orderBy: timestamp, orderDirection: desc, where: { amountUSD_gte: "${min}" }) {
      id timestamp amountUSD amount0 amount1 owner
      pool { id feeTier token0 { id symbol decimals } token1 { id symbol decimals } }
      transaction { id }
    }
  }`
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    let res: Response
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const msg = body || `BSC Subgraph HTTP ${res.status}`
      return {
        events: [],
        error: msg.slice(0, 180),
        authFailed: res.status === 401 || res.status === 403 || isGraphAuthError(msg),
      }
    }
    const json = (await res.json()) as {
      errors?: Array<{ message?: string }>
      data?: {
        mints?: GraphV3FlowRow[]
        burns?: GraphV3FlowRow[]
      }
    }
    if (json.errors?.length) {
      const msg = json.errors[0]?.message || 'Subgraph 查询失败'
      return { events: [], error: msg, authFailed: isGraphAuthError(msg) }
    }
    const cfg = CHAIN_CONFIGS[56]
    const stables = [cfg.contracts.stable, ...(cfg.usdStables ?? [])]
    const wethUsd = await wethUsdOnChain(getClient(56), 56).catch(() => 0)
    const out: FlowEvent[] = []
    const push = (side: FlowSide, row: GraphV3FlowRow) => {
      const amount0 = Number(row.amount0 ?? 0)
      const amount1 = Number(row.amount1 ?? 0)
      const amountUsd = anchoredUsdFromUnits({
        amount0,
        amount1,
        token0: row.pool.token0.id as Address,
        token1: row.pool.token1.id as Address,
        weth: cfg.contracts.weth,
        stables,
        wethUsd,
      })
      const timestamp = Number(row.timestamp)
      if (!(amountUsd >= opts.minUsd) || !isRecentTimestamp(timestamp)) return
      const tx = row.transaction.id as Hash
      out.push({
        id: `56-v3-${side}-${row.id}`,
        chainId: 56,
        version: 'v3',
        side,
        timestamp,
        amountUsd,
        poolAddress: row.pool.id as Address,
        token0: row.pool.token0.id as Address,
        token1: row.pool.token1.id as Address,
        symbol0: row.pool.token0.symbol || '?',
        symbol1: row.pool.token1.symbol || '?',
        fee: Number(row.pool.feeTier),
        txHash: tx.startsWith('0x') ? tx : (`0x${tx}` as Hash),
        amount0,
        amount1,
        amountEstimated: false,
        owner: row.owner as Address | undefined,
        source: 'subgraph',
      })
    }
    for (const m of json.data?.mints ?? []) push('in', m)
    for (const b of json.data?.burns ?? []) push('out', b)
    return { events: out }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { events: [], error: msg, authFailed: isGraphAuthError(msg) }
  }
}

type RawLog = {
  args: { tokenId?: bigint; amount0?: bigint; amount1?: bigint }
  transactionHash: Hash
  logIndex: number
  blockNumber: bigint
  side: FlowSide
}

type RawV3PoolLog = {
  pool: Address
  amount0: bigint
  amount1: bigint
  transactionHash: Hash
  logIndex: number
  side: FlowSide
}

async function fetchNpmLogsRange(
  client: PublicClient,
  chainId: FlowChainId,
  npm: Address,
  fromBlock: bigint,
  toBlock: bigint,
  span: bigint,
): Promise<RawLog[]> {
  if (fromBlock > toBlock) return []
  try {
    const readIncs = () => readFlowLogs<{ tokenId?: bigint; amount0?: bigint; amount1?: bigint }>({
      chainId,
      event: INC_EVENT,
      explorerAddress: npm,
      fromBlock,
      toBlock,
      maxSpan: span,
      label: 'V3 IncreaseLiquidity logs',
      allowPublicRpcFallback: true,
      request: (from, to) => client.getLogs({
        address: npm,
        event: INC_EVENT,
        fromBlock: from,
        toBlock: to,
      }),
    })
    const readDecs = () => readFlowLogs<{ tokenId?: bigint; amount0?: bigint; amount1?: bigint }>({
      chainId,
      event: DEC_EVENT,
      explorerAddress: npm,
      fromBlock,
      toBlock,
      maxSpan: span,
      label: 'V3 DecreaseLiquidity logs',
      allowPublicRpcFallback: true,
      request: (from, to) => client.getLogs({
        address: npm,
        event: DEC_EVENT,
        fromBlock: from,
        toBlock: to,
      }),
    })
    // Robinhood movement logs use the independent Blockscout indexer lane, so
    // both selective queries can run together. Keep BSC RPC streams serial to
    // avoid recreating its 429 burst.
    const [incs, decs] = chainId === 4663
      ? await Promise.all([readIncs(), readDecs()])
      : [await readIncs(), await readDecs()]
    const rows: RawLog[] = []
    for (const l of incs) {
      rows.push({
        args: l.args as { tokenId?: bigint; amount0?: bigint; amount1?: bigint },
        transactionHash: l.transactionHash,
        logIndex: l.logIndex ?? 0,
        blockNumber: l.blockNumber ?? 0n,
        side: 'in',
      })
    }
    for (const l of decs) {
      rows.push({
        args: l.args as { tokenId?: bigint; amount0?: bigint; amount1?: bigint },
        transactionHash: l.transactionHash,
        logIndex: l.logIndex ?? 0,
        blockNumber: l.blockNumber ?? 0n,
        side: 'out',
      })
    }
    return rows
  } catch (error) {
    // Never advance the outer scan cursor after a partial RPC failure.
    throw new Error(
      `V3 日志 ${fromBlock.toString()}–${toBlock.toString()}：${friendlyErrorText(error)}`,
      { cause: error },
    )
  }
}

/**
 * 同窗读取 V3 Pool 的 Mint/Burn。owner=NPM 是 indexed topic，所以即使不传
 * pool address 也只会返回由官方 PositionManager 发起的池事件。它让已销毁
 * NFT 也能批量恢复池地址，不必逐笔拉 transaction receipt。
 *
 * 这是加速索引：节点若不允许 address-less getLogs，则返回空数组，后面仍会
 * 使用 positions()/receipt 的兼容路径，不影响正确性。
 */
async function fetchV3PoolLogsRange(
  client: PublicClient,
  chainId: FlowChainId,
  npm: Address,
  fromBlock: bigint,
  toBlock: bigint,
  span: bigint,
): Promise<RawV3PoolLog[]> {
  if (fromBlock > toBlock) return []
  // Blockscout v2 requires an address and pool addresses are not known yet.
  // This index is optional; position/receipt resolution below remains the
  // authoritative path without an address-less Robinhood eth_getLogs call.
  if (chainId === 4663) return []
  try {
    const mints = await readFlowLogs<{ amount0?: bigint; amount1?: bigint }>({
      chainId,
      event: V3_POOL_MINT,
      explorerIndexedTopics: { 1: addressTopic(npm) },
      fromBlock,
      toBlock,
      maxSpan: span,
      label: 'V3 pool Mint logs',
      request: (from, to) => client.getLogs({
        event: V3_POOL_MINT,
        args: { owner: npm },
        fromBlock: from,
        toBlock: to,
      }),
    })
    const burns = await readFlowLogs<{ amount0?: bigint; amount1?: bigint }>({
      chainId,
      event: V3_POOL_BURN,
      explorerIndexedTopics: { 1: addressTopic(npm) },
      fromBlock,
      toBlock,
      maxSpan: span,
      label: 'V3 pool Burn logs',
      request: (from, to) => client.getLogs({
        event: V3_POOL_BURN,
        args: { owner: npm },
        fromBlock: from,
        toBlock: to,
      }),
    })
    const rows: RawV3PoolLog[] = []
    for (const log of mints) {
      rows.push({
        pool: log.address,
        amount0: log.args.amount0 ?? 0n,
        amount1: log.args.amount1 ?? 0n,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex ?? 0,
        side: 'in',
      })
    }
    for (const log of burns) {
      rows.push({
        pool: log.address,
        amount0: log.args.amount0 ?? 0n,
        amount1: log.args.amount1 ?? 0n,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex ?? 0,
        side: 'out',
      })
    }
    return rows
  } catch (error) {
    if (import.meta.env.DEV) {
      console.debug(`[flow] V3 pool 日志索引不可用：${friendlyErrorText(error)}`)
    }
    return []
  }
}

async function resolvePos(
  client: PublicClient,
  chainId: FlowChainId,
  tokenId: bigint,
): Promise<PosRow | null> {
  const cache = logCaches[chainId]
  const k = tokenId.toString()
  const hit = cache.pos.get(k)
  if (hit) return hit
  const cfg = CHAIN_CONFIGS[chainId]
  const npm = cfg.contracts.v3Npm
  let pos: Awaited<ReturnType<typeof client.readContract>>
  try {
    pos = await client.readContract({
      address: npm,
      abi: v3NpmAbi,
      functionName: 'positions',
      args: [tokenId],
    })
  } catch (e) {
    if (!isInvalidTokenIdError(e)) throw e
    return null
  }
  const typedPos = pos as readonly unknown[]
  const token0 = typedPos[2] as Address
  const token1 = typedPos[3] as Address
  const fee = Number(typedPos[4])
  // 已 burn 且被清空的 position 是确定性空值；RPC/metadata 错误则向上抛出，
  // 下次刷新会重试，不能永久写入负缓存。
  if (token0 === zeroAddress || token1 === zeroAddress || fee <= 0) return null
  const pool = await client.readContract({
    address: cfg.contracts.v3Factory,
    abi: v3FactoryAbi,
    functionName: 'getPool',
    args: [token0, token1, fee],
  })
  if (!pool || pool === zeroAddress) {
    return null
  }
  const [slot0, m0, m1] = await Promise.all([
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: 'slot0' }),
    tokenMeta(client, chainId, token0),
    tokenMeta(client, chainId, token1),
  ])
  const row: PosRow = {
    token0,
    token1,
    fee,
    pool,
    symbol0: m0.symbol,
    symbol1: m1.symbol,
    decimals0: m0.decimals,
    decimals1: m1.decimals,
    price1Per0: tickToPrice(Number(slot0[1]), m0.decimals, m1.decimals),
  }
  cache.pos.set(k, row)
  cache.pools.set(pool.toLowerCase(), row)
  return row
}

async function getCachedReceipt(
  client: PublicClient,
  chainId: FlowChainId,
  hash: Hash,
): Promise<TransactionReceipt> {
  const cache = receiptCaches[chainId]
  const key = hash.toLowerCase()
  let pending = cache.get(key)
  if (!pending) {
    if (cache.size > 400) cache.clear()
    pending = client.getTransactionReceipt({ hash })
    cache.set(key, pending)
  }
  try {
    return await pending
  } catch (e) {
    cache.delete(key)
    throw e
  }
}

async function resolveV3PoolsBatch(
  client: PublicClient,
  chainId: FlowChainId,
  addresses: Address[],
): Promise<Map<string, PosRow | null>> {
  const cfg = CHAIN_CONFIGS[chainId]
  const cache = logCaches[chainId]
  const unique = addresses.filter((address, i, all) =>
    all.findIndex((item) => item.toLowerCase() === address.toLowerCase()) === i)
  const out = new Map<string, PosRow | null>()
  const unresolved: Address[] = []
  for (const address of unique) {
    const key = address.toLowerCase()
    const hit = cache.pools.get(key)
    if (hit) out.set(key, hit)
    else unresolved.push(address)
  }
  if (unresolved.length === 0) return out

  const poolResults = await readBatch(client, unresolved.flatMap((address) => [
    { address, abi: v3PoolAbi, functionName: 'token0' },
    { address, abi: v3PoolAbi, functionName: 'token1' },
    { address, abi: v3PoolAbi, functionName: 'fee' },
    { address, abi: v3PoolAbi, functionName: 'slot0' },
  ]))
  const candidates: Array<{
    pool: Address
    token0: Address
    token1: Address
    fee: number
    slot0: readonly unknown[]
  }> = []
  for (let i = 0; i < unresolved.length; i += 1) {
    const token0Result = poolResults[i * 4]
    const token1Result = poolResults[i * 4 + 1]
    const feeResult = poolResults[i * 4 + 2]
    const slotResult = poolResults[i * 4 + 3]
    if (
      token0Result?.status !== 'success'
      || token1Result?.status !== 'success'
      || feeResult?.status !== 'success'
      || slotResult?.status !== 'success'
    ) {
      continue
    }
    const token0 = token0Result.result as Address
    const token1 = token1Result.result as Address
    const fee = Number(feeResult.result)
    const slot0 = slotResult.result as readonly unknown[]
    if (!token0 || !token1 || token0 === zeroAddress || token1 === zeroAddress || fee <= 0) continue
    candidates.push({ pool: unresolved[i]!, token0, token1, fee, slot0 })
  }

  const [canonicalResults, metas] = await Promise.all([
    readBatch(client, candidates.map((candidate) => ({
      address: cfg.contracts.v3Factory,
      abi: v3FactoryAbi,
      functionName: 'getPool',
      args: [candidate.token0, candidate.token1, candidate.fee],
    }))),
    tokenMetaBatch(client, chainId, candidates.flatMap((candidate) => [candidate.token0, candidate.token1])),
  ])
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]!
    const canonicalResult = canonicalResults[i]
    if (canonicalResult?.status !== 'success') continue
    const canonical = canonicalResult.result as Address
    if (!canonical || canonical.toLowerCase() !== candidate.pool.toLowerCase()) {
      out.set(candidate.pool.toLowerCase(), null)
      continue
    }
    const m0 = metas.get(candidate.token0.toLowerCase())
    const m1 = metas.get(candidate.token1.toLowerCase())
    if (!m0 || !m1) continue
    const row: PosRow = {
      token0: candidate.token0,
      token1: candidate.token1,
      fee: candidate.fee,
      pool: candidate.pool,
      symbol0: m0.symbol,
      symbol1: m1.symbol,
      decimals0: m0.decimals,
      decimals1: m1.decimals,
      price1Per0: tickToPrice(Number(candidate.slot0[1]), m0.decimals, m1.decimals),
    }
    cache.pools.set(candidate.pool.toLowerCase(), row)
    out.set(candidate.pool.toLowerCase(), row)
  }
  return out
}

function v3PoolMatchKey(
  side: FlowSide,
  transactionHash: Hash,
  amount0: bigint,
  amount1: bigint,
): string {
  return `${side}:${transactionHash.toLowerCase()}:${amount0.toString()}:${amount1.toString()}`
}

async function seedV3PositionsFromPoolLogs(
  client: PublicClient,
  chainId: FlowChainId,
  actions: RawLog[],
  poolLogs: RawV3PoolLog[],
): Promise<void> {
  if (actions.length === 0 || poolLogs.length === 0) return
  const candidates = new Map<string, RawV3PoolLog[]>()
  for (const log of poolLogs) {
    const key = v3PoolMatchKey(log.side, log.transactionHash, log.amount0, log.amount1)
    const rows = candidates.get(key) ?? []
    rows.push(log)
    candidates.set(key, rows)
  }

  const used = new Set<string>()
  const matches: Array<{ tokenId: string; pool: Address }> = []
  for (const action of actions) {
    const tokenId = action.args.tokenId?.toString()
    if (!tokenId || logCaches[chainId].pos.has(tokenId)) continue
    const key = v3PoolMatchKey(
      action.side,
      action.transactionHash,
      action.args.amount0 ?? 0n,
      action.args.amount1 ?? 0n,
    )
    const choices = (candidates.get(key) ?? [])
      .filter((log) => !used.has(`${log.transactionHash}:${log.logIndex}`))
      .sort((a, b) => Math.abs(a.logIndex - action.logIndex) - Math.abs(b.logIndex - action.logIndex))
    const match = choices[0]
    if (!match) continue
    used.add(`${match.transactionHash}:${match.logIndex}`)
    matches.push({ tokenId, pool: match.pool })
  }
  if (matches.length === 0) return

  const pools = await resolveV3PoolsBatch(client, chainId, matches.map((match) => match.pool))
  const cache = logCaches[chainId]
  for (const match of matches) {
    const row = pools.get(match.pool.toLowerCase())
    if (row) cache.pos.set(match.tokenId, row)
  }
}

async function resolveV3PoolAddress(
  client: PublicClient,
  chainId: FlowChainId,
  pool: Address,
): Promise<PosRow | null> {
  const cached = logCaches[chainId].pools.get(pool.toLowerCase())
  if (cached) return cached
  const cfg = CHAIN_CONFIGS[chainId]
  const [token0, token1, rawFee, slot0] = await Promise.all([
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: 'token0' }),
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: 'token1' }),
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: 'fee' }),
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: 'slot0' }),
  ])
  const fee = Number(rawFee)
  const canonical = await client.readContract({
    address: cfg.contracts.v3Factory,
    abi: v3FactoryAbi,
    functionName: 'getPool',
    args: [token0, token1, fee],
  })
  if (!canonical || canonical.toLowerCase() !== pool.toLowerCase()) return null
  const [m0, m1] = await Promise.all([
    tokenMeta(client, chainId, token0),
    tokenMeta(client, chainId, token1),
  ])
  const row: PosRow = {
    token0,
    token1,
    fee,
    pool,
    symbol0: m0.symbol,
    symbol1: m1.symbol,
    decimals0: m0.decimals,
    decimals1: m1.decimals,
    price1Per0: tickToPrice(Number(slot0[1]), m0.decimals, m1.decimals),
  }
  logCaches[chainId].pools.set(pool.toLowerCase(), row)
  return row
}

/**
 * 全撤后 NFT 常在同一交易 burn，latest 的 positions(tokenId) 会 revert。交易
 * receipt 里同时存在 V3 Pool 的 Mint/Burn，按两侧数量匹配即可恢复池地址，
 * 不依赖公共 RPC 的 archive state。
 */
async function resolvePosFromReceipt(
  client: PublicClient,
  chainId: FlowChainId,
  tokenId: bigint,
  rawLog: RawLog,
): Promise<PosRow | null> {
  const receipt = await getCachedReceipt(client, chainId, rawLog.transactionHash)
  const event = rawLog.side === 'in' ? V3_POOL_MINT : V3_POOL_BURN
  const amount0 = rawLog.args.amount0 ?? 0n
  const amount1 = rawLog.args.amount1 ?? 0n
  const npm = CHAIN_CONFIGS[chainId].contracts.v3Npm.toLowerCase()
  const matches: Array<{ pool: Address; distance: number }> = []
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === npm) continue
    try {
      const decoded = decodeEventLog({ abi: [event], data: log.data, topics: log.topics })
      const args = decoded.args as { amount0?: bigint; amount1?: bigint }
      if (args.amount0 !== amount0 || args.amount1 !== amount1) continue
      matches.push({
        pool: log.address,
        distance: Math.abs(Number(log.logIndex ?? 0) - rawLog.logIndex),
      })
    } catch {
      // receipt 中绝大多数日志不是目标事件
    }
  }
  matches.sort((a, b) => a.distance - b.distance)
  for (const match of matches) {
    const row = await resolveV3PoolAddress(client, chainId, match.pool)
    if (!row) continue
    logCaches[chainId].pos.set(tokenId.toString(), row)
    return row
  }
  return null
}

type PositionRef = { id: string; log: RawLog }

async function resolvePositionsBatch(
  client: PublicClient,
  chainId: FlowChainId,
  refs: PositionRef[],
): Promise<Map<string, PosRow | null>> {
  const cfg = CHAIN_CONFIGS[chainId]
  const cache = logCaches[chainId]
  const out = new Map<string, PosRow | null>()
  const unresolved: PositionRef[] = []
  for (const ref of refs) {
    const hit = cache.pos.get(ref.id)
    if (hit) out.set(ref.id, hit)
    else unresolved.push(ref)
  }
  if (unresolved.length === 0) return out

  const positionResults = await readBatch(client, unresolved.map((ref) => ({
    address: cfg.contracts.v3Npm,
    abi: v3NpmAbi,
    functionName: 'positions',
    args: [BigInt(ref.id)],
  })))
  const invalidIds = new Set<string>()
  const fallbackRefs = new Map<string, PositionRef>()
  const candidates: Array<{
    ref: PositionRef
    token0: Address
    token1: Address
    fee: number
  }> = []
  for (let i = 0; i < unresolved.length; i += 1) {
    const ref = unresolved[i]!
    const result = positionResults[i]
    if (result?.status !== 'success') {
      if (result?.status === 'failure' && isInvalidTokenIdError(result.error)) invalidIds.add(ref.id)
      fallbackRefs.set(ref.id, ref)
      continue
    }
    const pos = result.result as readonly unknown[]
    const token0 = pos[2] as Address
    const token1 = pos[3] as Address
    const fee = Number(pos[4])
    if (!token0 || !token1 || token0 === zeroAddress || token1 === zeroAddress || fee <= 0) {
      out.set(ref.id, null)
      continue
    }
    candidates.push({ ref, token0, token1, fee })
  }

  const poolResults = await readBatch(client, candidates.map((candidate) => ({
    address: cfg.contracts.v3Factory,
    abi: v3FactoryAbi,
    functionName: 'getPool',
    args: [candidate.token0, candidate.token1, candidate.fee],
  })))
  const poolCandidates: Array<(typeof candidates)[number] & { pool: Address }> = []
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]!
    const result = poolResults[i]
    if (result?.status !== 'success') {
      fallbackRefs.set(candidate.ref.id, candidate.ref)
      continue
    }
    const pool = result.result as Address
    if (!pool || pool === zeroAddress) {
      out.set(candidate.ref.id, null)
      continue
    }
    poolCandidates.push({ ...candidate, pool })
  }

  const pools = poolCandidates
    .map((candidate) => candidate.pool)
    .filter((pool, i, all) => all.findIndex((item) => item.toLowerCase() === pool.toLowerCase()) === i)
  const [slotResults, metas] = await Promise.all([
    readBatch(client, pools.map((pool) => ({
      address: pool,
      abi: v3PoolAbi,
      functionName: 'slot0',
    }))),
    tokenMetaBatch(client, chainId, poolCandidates.flatMap((candidate) => [candidate.token0, candidate.token1])),
  ])
  const slots = new Map<string, readonly unknown[]>()
  for (let i = 0; i < pools.length; i += 1) {
    const result = slotResults[i]
    if (result?.status === 'success') slots.set(pools[i]!.toLowerCase(), result.result as readonly unknown[])
  }
  for (const candidate of poolCandidates) {
    const slot0 = slots.get(candidate.pool.toLowerCase())
    if (!slot0) {
      fallbackRefs.set(candidate.ref.id, candidate.ref)
      continue
    }
    const m0 = metas.get(candidate.token0.toLowerCase())
    const m1 = metas.get(candidate.token1.toLowerCase())
    if (!m0 || !m1) {
      out.set(candidate.ref.id, null)
      continue
    }
    const row: PosRow = {
      token0: candidate.token0,
      token1: candidate.token1,
      fee: candidate.fee,
      pool: candidate.pool,
      symbol0: m0.symbol,
      symbol1: m1.symbol,
      decimals0: m0.decimals,
      decimals1: m1.decimals,
      price1Per0: tickToPrice(Number(slot0[1]), m0.decimals, m1.decimals),
    }
    cache.pos.set(candidate.ref.id, row)
    cache.pools.set(candidate.pool.toLowerCase(), row)
    out.set(candidate.ref.id, row)
  }

  await mapPool([...fallbackRefs.values()], chainId === 4663 ? 1 : chainId === 56 ? 3 : 4, async (ref) => {
    if (out.has(ref.id)) return
    const tokenId = BigInt(ref.id)
    const current = invalidIds.has(ref.id) ? null : await resolvePos(client, chainId, tokenId)
    const row = current ?? await resolvePosFromReceipt(client, chainId, tokenId, ref.log)
    out.set(ref.id, row)
  })
  return out
}

async function fetchNpmFlowLogs(
  chainId: FlowChainId,
  opts: { minUsd: number; limit: number },
): Promise<{ events: FlowEvent[]; error?: string }> {
  const cfg = CHAIN_CONFIGS[chainId]
  const client = getClient(chainId)
  const npm = cfg.contracts.v3Npm
  const cache = logCaches[chainId]
  const scan = LOG_SCAN[chainId]
  try {
    const head = await retryRateLimited(chainId, () => getScanHead(client, chainId))
    const { latest, windowStart } = head

    let from: bigint
    if (cache.tip > 0n && cache.tip >= windowStart && cache.tip < latest) {
      const overlapStart = cache.tip > scan.reorg ? cache.tip - scan.reorg + 1n : 0n
      from = overlapStart > windowStart ? overlapStart : windowStart
    } else if (cache.tip >= latest) {
      const kept = cache.events.filter((e) => e.amountUsd >= opts.minUsd && isRecentTimestamp(e.timestamp))
      kept.sort((a, b) => b.timestamp - a.timestamp)
      return { events: takeFlowPoolEvents(kept, [chainId], opts.limit) }
    } else {
      from = windowStart
      if (cache.tip === 0n || cache.tip < windowStart) {
        cache.events = []
      }
    }

    const rawLogs = from <= latest
      ? await timedSource(`${flowChainLabel(chainId)} V3 movement logs`,
        fetchNpmLogsRange(client, chainId, npm, from, latest, scan.span))
      : []
    const poolLogs = rawLogs.length > 0
      ? await fetchV3PoolLogsRange(client, chainId, npm, from, latest, scan.span)
      : []
    const stables = [cfg.contracts.stable, ...(cfg.usdStables ?? [])]

    rawLogs.sort((a, b) => Number(b.blockNumber - a.blockNumber))
    // 完整处理 45 分钟窗口；上限只用于防御异常节点返回无限量垃圾日志。
    const useful = rawLogs.slice(0, 10_000)
    try {
      await retryRateLimited(chainId, () =>
        seedV3PositionsFromPoolLogs(client, chainId, useful, poolLogs))
    } catch (error) {
      if (import.meta.env.DEV) {
        console.debug(`[flow] V3 pool 批量解析降级：${friendlyErrorText(error)}`)
      }
    }
    const tokenRefs = new Map<string, { id: string; log: RawLog }>()
    // A busy NPM window can contain hundreds of tokenIds concentrated in the
    // same handful of pools. Resolving every NFT before showing 60 pools made
    // first paint wait ~25s. Keep the newest bounded candidate set; all events
    // for those tokenIds are still parsed below, so their net flow stays exact.
    const maxPositionRefs = Math.min(600, Math.max(240, opts.limit * 4))
    for (const log of useful) {
      const id = log.args.tokenId?.toString()
      if (!id) continue
      const current = tokenRefs.get(id)
      if (!current && tokenRefs.size >= maxPositionRefs) continue
      if (!current || (log.side === 'out' && current.log.side !== 'out')) {
        tokenRefs.set(id, { id, log })
      }
    }
    const wethUsd = await retryRateLimited(chainId, () => wethUsdOnChain(client, chainId))
    const positions = await timedSource(`${flowChainLabel(chainId)} V3 pool metadata`,
      retryRateLimited(chainId, () =>
        resolvePositionsBatch(client, chainId, [...tokenRefs.values()])))
    const parsed = useful.map((l) => {
      const tokenId = l.args.tokenId
      if (tokenId == null) return null
      const info = positions.get(tokenId.toString())
      if (!info) return null
      const rawAmount0 = l.args.amount0 ?? 0n
      const rawAmount1 = l.args.amount1 ?? 0n
      const amountUsd = amountUsdSimple({
        amount0: rawAmount0,
        amount1: rawAmount1,
        decimals0: info.decimals0,
        decimals1: info.decimals1,
        token0: info.token0,
        token1: info.token1,
        weth: cfg.contracts.weth,
        stables,
        wethUsd,
      })
      if (!(amountUsd > 0)) return null
      const timestamp = estimatedBlockTimestamp(head, l.blockNumber)
      const ev: FlowEvent = {
        id: `${chainId}-v3-${l.side}-${l.transactionHash}-${l.logIndex}`,
        chainId,
        version: 'v3',
        side: l.side,
        timestamp,
        amountUsd,
        poolAddress: info.pool,
        token0: info.token0,
        token1: info.token1,
        symbol0: info.symbol0,
        symbol1: info.symbol1,
        fee: info.fee,
        txHash: l.transactionHash,
        blockNumber: l.blockNumber,
        amount0: rawToNumber(rawAmount0, info.decimals0),
        amount1: rawToNumber(rawAmount1, info.decimals1),
        amountEstimated: false,
        tokenId: tokenId.toString(),
        source: 'logs',
      }
      return ev
    })

    const fresh = parsed.filter((e): e is FlowEvent => e != null)
    const byId = new Map<string, FlowEvent>()
    for (const e of cache.events) byId.set(e.id, e)
    for (const e of fresh) byId.set(e.id, e)

    const now = Date.now()
    const merged = [...byId.values()]
      .filter((e) => isRecentTimestamp(e.timestamp, now))
      .sort((a, b) => b.timestamp - a.timestamp)

    cache.events = merged.slice(0, 5_000)
    cache.tip = latest
    persistFlowSnapshot(chainId)
    pruneChainCaches(chainId)
    return {
      events: takeFlowPoolEvents(
        cache.events.filter((e) => e.amountUsd >= opts.minUsd),
        [chainId],
        opts.limit,
      ),
    }
  } catch (e) {
    if (cache.events.length) {
      return {
        events: takeFlowPoolEvents(
          cache.events.filter((e) => e.amountUsd >= opts.minUsd && isRecentTimestamp(e.timestamp)),
          [chainId],
          opts.limit,
        ),
        error: friendlyErrorText(e),
      }
    }
    return { events: [], error: friendlyErrorText(e) }
  }
}

async function resolveV4Pool(
  client: PublicClient,
  chainId: FlowChainId,
  poolId: `0x${string}`,
): Promise<V4PoolRow | null> {
  const cache = v4Caches[chainId]
  const key = poolId.toLowerCase()
  const hit = cache.pools.get(key)
  if (hit) return hit
  const cfg = CHAIN_CONFIGS[chainId]
  const id25 = slice(poolId, 0, 25)
  const raw = await client.readContract({
    address: cfg.contracts.v4PositionManager,
    abi: v4PositionManagerAbi,
    functionName: 'poolKeys',
    args: [id25],
  })
  const row = raw as unknown as Address[] & {
    currency0?: Address
    currency1?: Address
    fee?: number | bigint
    tickSpacing?: number | bigint
    hooks?: Address
  }
  const currency0 = (row.currency0 ?? row[0]) as Address
  const currency1 = (row.currency1 ?? row[1]) as Address
  const fee = Number(row.fee ?? row[2])
  const hooks = (row.hooks ?? row[4]) as Address
  if (
    !currency0
    || !currency1
    || (
      currency0 === zeroAddress
      && currency1 === zeroAddress
      && fee === 0
      && hooks === zeroAddress
    )
  ) {
    return null
  }
  const token0 = asErc20(chainId, currency0)
  const token1 = asErc20(chainId, currency1)
  const [slot0, m0, m1] = await Promise.all([
    client.readContract({
      address: cfg.contracts.v4StateView,
      abi: v4StateViewAbi,
      functionName: 'getSlot0',
      args: [poolId],
    }),
    tokenMeta(client, chainId, token0),
    tokenMeta(client, chainId, token1),
  ])
  const sqrtPriceX96 = slot0[0] as bigint
  const tick = Number(slot0[1])
  if (!(sqrtPriceX96 > 0n)) return null
  const out: V4PoolRow = {
    poolId,
    token0,
    token1,
    symbol0: m0.symbol,
    symbol1: m1.symbol,
    decimals0: m0.decimals,
    decimals1: m1.decimals,
    fee,
    sqrtPriceX96,
    price1Per0: tickToPrice(tick, m0.decimals, m1.decimals),
  }
  cache.pools.set(key, out)
  return out
}

async function resolveV4PoolsBatch(
  client: PublicClient,
  chainId: FlowChainId,
  poolIds: `0x${string}`[],
): Promise<Map<string, V4PoolRow | null>> {
  const cfg = CHAIN_CONFIGS[chainId]
  const cache = v4Caches[chainId]
  const out = new Map<string, V4PoolRow | null>()
  const unresolved: `0x${string}`[] = []
  for (const poolId of poolIds) {
    const key = poolId.toLowerCase()
    const hit = cache.pools.get(key)
    if (hit) out.set(key, hit)
    else unresolved.push(poolId)
  }
  if (unresolved.length === 0) return out

  const keyResults = await readBatch(client, unresolved.map((poolId) => ({
    address: cfg.contracts.v4PositionManager,
    abi: v4PositionManagerAbi,
    functionName: 'poolKeys',
    args: [slice(poolId, 0, 25)],
  })))
  const fallbackIds = new Set<`0x${string}`>()
  const candidates: Array<{
    poolId: `0x${string}`
    token0: Address
    token1: Address
    fee: number
  }> = []
  for (let i = 0; i < unresolved.length; i += 1) {
    const poolId = unresolved[i]!
    const result = keyResults[i]
    if (result?.status !== 'success') {
      fallbackIds.add(poolId)
      continue
    }
    const raw = result.result as Address[] & {
      currency0?: Address
      currency1?: Address
      fee?: number | bigint
      hooks?: Address
    }
    const currency0 = (raw.currency0 ?? raw[0]) as Address
    const currency1 = (raw.currency1 ?? raw[1]) as Address
    const fee = Number(raw.fee ?? raw[2])
    const hooks = (raw.hooks ?? raw[4]) as Address
    if (
      !currency0
      || !currency1
      || (currency0 === zeroAddress && currency1 === zeroAddress && fee === 0 && hooks === zeroAddress)
    ) {
      out.set(poolId.toLowerCase(), null)
      continue
    }
    candidates.push({
      poolId,
      token0: asErc20(chainId, currency0),
      token1: asErc20(chainId, currency1),
      fee,
    })
  }

  const [slotResults, metas] = await Promise.all([
    readBatch(client, candidates.map((candidate) => ({
      address: cfg.contracts.v4StateView,
      abi: v4StateViewAbi,
      functionName: 'getSlot0',
      args: [candidate.poolId],
    }))),
    tokenMetaBatch(client, chainId, candidates.flatMap((candidate) => [candidate.token0, candidate.token1])),
  ])
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]!
    const slotResult = slotResults[i]
    if (slotResult?.status !== 'success') {
      fallbackIds.add(candidate.poolId)
      continue
    }
    const slot0 = slotResult.result as readonly unknown[]
    const sqrtPriceX96 = slot0[0] as bigint
    const tick = Number(slot0[1])
    if (!(sqrtPriceX96 > 0n)) {
      out.set(candidate.poolId.toLowerCase(), null)
      continue
    }
    const m0 = metas.get(candidate.token0.toLowerCase())
    const m1 = metas.get(candidate.token1.toLowerCase())
    if (!m0 || !m1) {
      out.set(candidate.poolId.toLowerCase(), null)
      continue
    }
    const row: V4PoolRow = {
      poolId: candidate.poolId,
      token0: candidate.token0,
      token1: candidate.token1,
      symbol0: m0.symbol,
      symbol1: m1.symbol,
      decimals0: m0.decimals,
      decimals1: m1.decimals,
      fee: candidate.fee,
      sqrtPriceX96,
      price1Per0: tickToPrice(tick, m0.decimals, m1.decimals),
    }
    cache.pools.set(candidate.poolId.toLowerCase(), row)
    out.set(candidate.poolId.toLowerCase(), row)
  }

  await mapPool([...fallbackIds], chainId === 4663 ? 1 : chainId === 56 ? 3 : 4, async (poolId) => {
    if (out.has(poolId.toLowerCase())) return
    out.set(poolId.toLowerCase(), await resolveV4Pool(client, chainId, poolId))
  })
  return out
}

async function fetchV4ModifyRange(
  client: PublicClient,
  chainId: FlowChainId,
  poolManager: Address,
  positionManager: Address,
  fromBlock: bigint,
  toBlock: bigint,
  span: bigint,
): Promise<Array<{
  poolId: `0x${string}`
  tickLower: number
  tickUpper: number
  liquidityDelta: bigint
  salt: `0x${string}`
  transactionHash: Hash
  logIndex: number
  blockNumber: bigint
}>> {
  if (fromBlock > toBlock) return []
  try {
    const logs = await readFlowLogs<{
      id?: Hex
      tickLower?: number
      tickUpper?: number
      liquidityDelta?: bigint
      salt?: Hex
    }>({
      chainId,
      event: V4_MODIFY,
      explorerAddress: poolManager,
      explorerIndexedTopics: { 2: addressTopic(positionManager) },
      fromBlock,
      toBlock,
      maxSpan: span,
      label: 'V4 ModifyLiquidity logs',
      allowPublicRpcFallback: true,
      request: (from, to) => client.getLogs({
        address: poolManager,
        event: V4_MODIFY,
        args: { sender: positionManager },
        fromBlock: from,
        toBlock: to,
      }),
    })
    return logs.map((log) => ({
      poolId: log.args.id as `0x${string}`,
      tickLower: Number(log.args.tickLower),
      tickUpper: Number(log.args.tickUpper),
      liquidityDelta: log.args.liquidityDelta ?? 0n,
      salt: (log.args.salt || '0x') as `0x${string}`,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex ?? 0,
      blockNumber: log.blockNumber ?? 0n,
    }))
  } catch (error) {
    throw new Error(
      `V4 日志 ${fromBlock.toString()}–${toBlock.toString()}：${friendlyErrorText(error)}`,
      { cause: error },
    )
  }
}

/** Uniswap V4：扫 PoolManager.ModifyLiquidity（经 PositionManager） */
async function fetchV4FlowLogs(
  chainId: FlowChainId,
  opts: { minUsd: number; limit: number },
): Promise<{ events: FlowEvent[]; error?: string }> {
  const cfg = CHAIN_CONFIGS[chainId]
  const client = getClient(chainId)
  const cache = v4Caches[chainId]
  const scan = LOG_SCAN[chainId]
  try {
    const head = await retryRateLimited(chainId, () => getScanHead(client, chainId))
    const { latest, windowStart } = head

    let from: bigint
    if (cache.tip > 0n && cache.tip >= windowStart && cache.tip < latest) {
      const overlapStart = cache.tip > scan.reorg ? cache.tip - scan.reorg + 1n : 0n
      from = overlapStart > windowStart ? overlapStart : windowStart
    } else if (cache.tip >= latest) {
      const kept = cache.events.filter((e) => e.amountUsd >= opts.minUsd && isRecentTimestamp(e.timestamp))
      kept.sort((a, b) => b.timestamp - a.timestamp)
      return { events: takeFlowPoolEvents(kept, [chainId], opts.limit) }
    } else {
      from = windowStart
      if (cache.tip === 0n || cache.tip < windowStart) cache.events = []
    }

    const raw =
      from <= latest
        ? await timedSource(`${flowChainLabel(chainId)} V4 movement logs`, fetchV4ModifyRange(
          client,
          chainId,
          cfg.contracts.v4PoolManager,
          cfg.contracts.v4PositionManager,
          from,
          latest,
          scan.span,
        ))
        : []

    const stables = [cfg.contracts.stable, ...(cfg.usdStables ?? [])]

    // 跳过领费（delta=0），按块新旧裁剪
    const useful = raw
      .filter((l) => l.liquidityDelta !== 0n && l.poolId)
      .sort((a, b) => Number(b.blockNumber - a.blockNumber))
      .slice(0, 10_000)
    // Resolve only enough recent pool ids to fill the visible pool quota. The
    // old path resolved every active V4 pool in the window before first paint.
    const maxPoolCandidates = Math.min(240, Math.max(80, opts.limit * 2))
    const poolIds = [...new Map(useful.map((log) => [log.poolId.toLowerCase(), log.poolId])).values()]
      .slice(0, maxPoolCandidates)
    const selectedPoolIds = new Set(poolIds.map((poolId) => poolId.toLowerCase()))
    const selectedLogs = useful.filter((log) => selectedPoolIds.has(log.poolId.toLowerCase()))
    const wethUsd = await retryRateLimited(chainId, () => wethUsdOnChain(client, chainId))
    const pools = await timedSource(`${flowChainLabel(chainId)} V4 pool metadata`,
      retryRateLimited(chainId, () =>
        resolveV4PoolsBatch(client, chainId, poolIds)))
    const parsed = selectedLogs.map((l) => {
      const info = pools.get(l.poolId.toLowerCase())
      if (!info) return null
      const absLiq = l.liquidityDelta < 0n ? -l.liquidityDelta : l.liquidityDelta
      const { amount0, amount1 } = getAmountsForPosition(
        info.sqrtPriceX96,
        l.tickLower,
        l.tickUpper,
        absLiq,
      )
      const amountUsd = amountUsdSimple({
        amount0,
        amount1,
        decimals0: info.decimals0,
        decimals1: info.decimals1,
        token0: info.token0,
        token1: info.token1,
        weth: cfg.contracts.weth,
        stables,
        wethUsd,
      })
      if (!(amountUsd > 0)) return null
      const timestamp = estimatedBlockTimestamp(head, l.blockNumber)
      const tokenId = l.salt.length > 2 ? BigInt(l.salt).toString() : undefined
      const side: FlowSide = l.liquidityDelta > 0n ? 'in' : 'out'
      const ev: FlowEvent = {
        id: `${chainId}-v4-${side}-${l.transactionHash}-${l.logIndex}`,
        chainId,
        version: 'v4',
        side,
        timestamp,
        amountUsd,
        poolAddress: zeroAddress,
        poolId: info.poolId,
        token0: info.token0,
        token1: info.token1,
        symbol0: info.symbol0,
        symbol1: info.symbol1,
        fee: info.fee,
        txHash: l.transactionHash,
        blockNumber: l.blockNumber,
        amount0: rawToNumber(amount0, info.decimals0),
        amount1: rawToNumber(amount1, info.decimals1),
        amountEstimated: true,
        tokenId,
        source: 'logs',
      }
      return ev
    })

    const fresh = parsed.filter((e): e is FlowEvent => e != null)
    const byId = new Map<string, FlowEvent>()
    for (const e of cache.events) byId.set(e.id, e)
    for (const e of fresh) byId.set(e.id, e)
    const now = Date.now()
    const merged = [...byId.values()]
      .filter((e) => isRecentTimestamp(e.timestamp, now))
      .sort((a, b) => b.timestamp - a.timestamp)
    cache.events = merged.slice(0, 5_000)
    cache.tip = latest
    persistFlowSnapshot(chainId)
    pruneChainCaches(chainId)
    return {
      events: takeFlowPoolEvents(
        cache.events.filter((e) => e.amountUsd >= opts.minUsd),
        [chainId],
        opts.limit,
      ),
    }
  } catch (e) {
    if (cache.events.length) {
      return {
        events: takeFlowPoolEvents(
          cache.events.filter((e) => e.amountUsd >= opts.minUsd && isRecentTimestamp(e.timestamp)),
          [chainId],
          opts.limit,
        ),
        error: friendlyErrorText(e),
      }
    }
    return { events: [], error: friendlyErrorText(e) }
  }
}

/** BSC：优先 Subgraph；无 Key / 鉴权失败 / 空结果带错误 → 链上日志 */
async function fetchBscFlow(opts: {
  minUsd: number
  limit: number
}): Promise<{ events: FlowEvent[]; error?: string; note?: string }> {
  const key = loadGraphApiKey()
  if (key) {
    const g = await fetchBscSubgraph(opts)
    if (g.events.length > 0) return { events: g.events }
    const logs = await fetchNpmFlowLogs(56, opts)
    if (g.authFailed) {
      return {
        events: logs.events,
        note: 'The Graph Key 无效，已改用 BSC 链上扫描（无需 Key）',
        error: logs.error,
      }
    }
    if (g.error && !g.authFailed) {
      return {
        events: logs.events,
        note: 'Subgraph 不可用，已改用 BSC 链上扫描',
        error: logs.error || g.error,
      }
    }
    // Key 有效但索引延迟或窗口内没有结果，也要查链，不能把“Subgraph 空”
    // 误判为“链上没有动向”。
    return logs
  }

  return fetchNpmFlowLogs(56, opts)
}

async function filterHoneypotFast(events: FlowEvent[]): Promise<FlowEvent[]> {
  const pairOk = new Map<string, boolean>()
  const uniq: Array<{ key: string; chainId: SupportedChainId; t0: Address; t1: Address }> = []
  for (const e of events) {
    const key = `${e.chainId}:${e.token0.toLowerCase()}:${e.token1.toLowerCase()}`
    if (pairOk.has(key)) continue
    const t0 = asErc20(e.chainId, e.token0)
    const t1 = asErc20(e.chainId, e.token1)
    if (
      isHoneypotWhitelisted(e.chainId as SupportedChainId, t0)
      && isHoneypotWhitelisted(e.chainId as SupportedChainId, t1)
    ) {
      pairOk.set(key, true)
      continue
    }
    if (e.chainId === 4663) {
      pairOk.set(key, true)
      continue
    }
    uniq.push({
      key,
      chainId: e.chainId as SupportedChainId,
      t0,
      t1,
    })
  }

  await mapPool(uniq, 10, async (u) => {
    const ok = await checkPoolTokensSafe(u.chainId, u.t0, u.t1)
    pairOk.set(u.key, ok)
    return ok
  })

  return events.filter((e) => {
    const key = `${e.chainId}:${e.token0.toLowerCase()}:${e.token1.toLowerCase()}`
    return pairOk.get(key) !== false
  })
}

function absBigint(value: bigint): bigint {
  return value < 0n ? -value : value
}

function anchorUnitUsd(
  token: Address,
  weth: Address,
  stableSet: Set<string>,
  wethUsd: number,
): number {
  const address = token.toLowerCase()
  if (stableSet.has(address)) return 1
  if (address === weth.toLowerCase() && wethUsd > 0) return wethUsd
  return 0
}

/**
 * Swap 的正数侧是池子收到的输入；优先用输入侧作为成交额。若输入不是锚定
 * 资产，则用输出侧近似成交额。两边都可锚定时只取一边，避免翻倍。
 */
function anchoredSwapNotionalUsd(opts: {
  amount0: bigint
  amount1: bigint
  decimals0: number
  decimals1: number
  token0: Address
  token1: Address
  weth: Address
  stableSet: Set<string>
  wethUsd: number
}): number {
  const unit0 = anchorUnitUsd(opts.token0, opts.weth, opts.stableSet, opts.wethUsd)
  const unit1 = anchorUnitUsd(opts.token1, opts.weth, opts.stableSet, opts.wethUsd)
  const usd0 = unit0 > 0 ? rawToNumber(absBigint(opts.amount0), opts.decimals0) * unit0 : 0
  const usd1 = unit1 > 0 ? rawToNumber(absBigint(opts.amount1), opts.decimals1) * unit1 : 0
  const input0 = opts.amount0 > 0n ? usd0 : 0
  const input1 = opts.amount1 > 0n ? usd1 : 0
  const input = Math.max(input0, input1)
  return clampUsd(input > 0 ? input : Math.max(usd0, usd1))
}

/**
 * 只用可验证的锚定侧估值。若仅一侧可锚定，以该侧 x2 近似双边价值；这不会
 * 采信新币自己的池价，并会在 UI 明确标为估算基数。
 */
function anchoredLiquidityUsd(opts: {
  amount0: bigint
  amount1: bigint
  decimals0: number
  decimals1: number
  token0: Address
  token1: Address
  weth: Address
  stableSet: Set<string>
  wethUsd: number
}): number {
  const unit0 = anchorUnitUsd(opts.token0, opts.weth, opts.stableSet, opts.wethUsd)
  const unit1 = anchorUnitUsd(opts.token1, opts.weth, opts.stableSet, opts.wethUsd)
  const usd0 = unit0 > 0 ? rawToNumber(absBigint(opts.amount0), opts.decimals0) * unit0 : 0
  const usd1 = unit1 > 0 ? rawToNumber(absBigint(opts.amount1), opts.decimals1) * unit1 : 0
  if (unit0 > 0 && unit1 > 0) return clampUsd(usd0 + usd1)
  if (unit0 > 0) return clampUsd(usd0 * 2)
  if (unit1 > 0) return clampUsd(usd1 * 2)
  return 0
}

function annualizedFeePct(
  windowFeeUsd: number,
  liquidityUsd: number,
  windowMinutes = FLOW_WINDOW_MINUTES,
): number | undefined {
  if (!(windowFeeUsd >= 0) || !(liquidityUsd > 0)) return undefined
  const windowsPerYear = (365 * 24 * 60) / Math.max(1, windowMinutes)
  const apr = (windowFeeUsd / liquidityUsd) * windowsPerYear * 100
  if (!Number.isFinite(apr) || apr < 0) return undefined
  // 防止极端小池把 Infinity/指数级数字带进排序与布局；仍保留足够高的风险信号。
  return Math.min(apr, 1_000_000_000)
}

function blockRanges(head: ScanHead, span: bigint): Array<{ from: bigint; to: bigint }> {
  const ranges: Array<{ from: bigint; to: bigint }> = []
  for (let from = head.windowStart; from <= head.latest; from += span) {
    const to = from + span - 1n > head.latest ? head.latest : from + span - 1n
    ranges.push({ from, to })
  }
  return ranges
}

type V3AprSwap = {
  pool: Address
  amount0: bigint
  amount1: bigint
  blockNumber: bigint
}

async function fetchV3AprSwaps(
  client: PublicClient,
  chainId: FlowChainId,
  pools: Address[],
  head: ScanHead,
): Promise<V3AprSwap[]> {
  if (pools.length === 0) return []
  const addressChunks: Address[][] = []
  const addressChunkSize = chainId === 4663 ? 1 : 6
  for (let i = 0; i < pools.length; i += addressChunkSize) {
    addressChunks.push(pools.slice(i, i + addressChunkSize))
  }
  const ranges = chainId === 4663
    ? [{ from: head.windowStart, to: head.latest }]
    : blockRanges(head, APR_LOG_SPAN[chainId])
  const jobs = addressChunks.flatMap((addresses) =>
    ranges.map((range) => ({ addresses, ...range })))
  const nested = await mapPool(jobs, 2, async (job) => {
    const address = job.addresses.length === 1 ? job.addresses[0]! : job.addresses
    try {
      const logs = await readFlowLogs<{ amount0?: bigint; amount1?: bigint }>({
        chainId,
        event: V3_SWAP,
        explorerAddress: job.addresses.length === 1 ? job.addresses[0] : undefined,
        fromBlock: job.from,
        toBlock: job.to,
        maxSpan: APR_LOG_SPAN[chainId],
        label: 'V3 Swap logs',
        preferIndexer: false,
        request: (from, to) => client.getLogs({
          address,
          event: V3_SWAP,
          fromBlock: from,
          toBlock: to,
        }),
      })
      return logs.map((log) => ({
        pool: log.address,
        amount0: log.args.amount0 ?? 0n,
        amount1: log.args.amount1 ?? 0n,
        blockNumber: log.blockNumber ?? 0n,
      }))
    } catch (error) {
      // 少数 RPC 不接受 address 数组，退回逐池查询；仍保持块范围受控。
      if (job.addresses.length === 1 || isRateLimitError(error)) throw error
      const fallbackLogs = await mapPool(job.addresses, 3, async (pool) => (
        readLogsAdaptive({
          chainId,
          fromBlock: job.from,
          toBlock: job.to,
          maxSpan: APR_LOG_SPAN[chainId],
          label: 'V3 per-pool Swap logs',
          request: (from, to) => client.getLogs({
            address: pool,
            event: V3_SWAP,
            fromBlock: from,
            toBlock: to,
          }),
        })
      ))
      return fallbackLogs.flat().map((log) => ({
        pool: log.address,
        amount0: log.args.amount0 ?? 0n,
        amount1: log.args.amount1 ?? 0n,
        blockNumber: log.blockNumber ?? 0n,
      }))
    }
  })
  return nested.flat().filter((log) =>
    isRecentTimestamp(estimatedBlockTimestamp(head, log.blockNumber)))
}

type V4AprSwap = {
  poolId: `0x${string}`
  amount0: bigint
  amount1: bigint
  feePips: number
  blockNumber: bigint
}

async function fetchV4AprSwaps(
  client: PublicClient,
  chainId: FlowChainId,
  poolIds: `0x${string}`[],
  head: ScanHead,
): Promise<V4AprSwap[]> {
  if (poolIds.length === 0) return []
  const cfg = CHAIN_CONFIGS[chainId]
  const idChunks: Array<`0x${string}`[]> = []
  const idChunkSize = chainId === 4663 ? 1 : 10
  for (let i = 0; i < poolIds.length; i += idChunkSize) {
    idChunks.push(poolIds.slice(i, i + idChunkSize))
  }
  const ranges = chainId === 4663
    ? [{ from: head.windowStart, to: head.latest }]
    : blockRanges(head, APR_LOG_SPAN[chainId])
  const jobs = idChunks.flatMap((ids) =>
    ranges.map((range) => ({ ids, ...range })))
  const nested = await mapPool(jobs, 2, async (job) => {
    const id = job.ids.length === 1 ? job.ids[0]! : job.ids
    try {
      const logs = await readFlowLogs<{
        id?: Hex
        amount0?: bigint
        amount1?: bigint
        fee?: number
      }>({
        chainId,
        event: V4_SWAP,
        explorerAddress: cfg.contracts.v4PoolManager,
        explorerIndexedTopics: job.ids.length === 1 ? { 1: job.ids[0] } : undefined,
        fromBlock: job.from,
        toBlock: job.to,
        maxSpan: APR_LOG_SPAN[chainId],
        label: 'V4 Swap logs',
        preferIndexer: false,
        request: (from, to) => client.getLogs({
          address: cfg.contracts.v4PoolManager,
          event: V4_SWAP,
          args: { id },
          fromBlock: from,
          toBlock: to,
        }),
      })
      return logs.map((log) => ({
        poolId: log.args.id as `0x${string}`,
        amount0: log.args.amount0 ?? 0n,
        amount1: log.args.amount1 ?? 0n,
        feePips: Number(log.args.fee ?? 0),
        blockNumber: log.blockNumber ?? 0n,
      }))
    } catch (error) {
      if (job.ids.length === 1 || isRateLimitError(error)) throw error
      const fallbackLogs = await mapPool(job.ids, 3, async (poolId) => (
        readLogsAdaptive({
          chainId,
          fromBlock: job.from,
          toBlock: job.to,
          maxSpan: APR_LOG_SPAN[chainId],
          label: 'V4 per-pool Swap logs',
          request: (from, to) => client.getLogs({
            address: cfg.contracts.v4PoolManager,
            event: V4_SWAP,
            args: { id: poolId },
            fromBlock: from,
            toBlock: to,
          }),
        })
      ))
      return fallbackLogs.flat().map((log) => ({
        poolId: log.args.id as `0x${string}`,
        amount0: log.args.amount0 ?? 0n,
        amount1: log.args.amount1 ?? 0n,
        feePips: Number(log.args.fee ?? 0),
        blockNumber: log.blockNumber ?? 0n,
      }))
    }
  })
  return nested.flat().filter((log) =>
    isRecentTimestamp(estimatedBlockTimestamp(head, log.blockNumber)))
}

async function fetchV3AprMetrics(
  chainId: FlowChainId,
  events: FlowEvent[],
): Promise<Map<string, FlowAprMetric>> {
  const client = getClient(chainId)
  const refs = [...new Map(events.map((event) => [
    event.poolAddress.toLowerCase(),
    event.poolAddress,
  ])).values()]
  let head: ScanHead
  let wethUsd: number
  let poolRows: Map<string, PosRow | null>
  try {
    head = await retryRateLimited(chainId, () => getScanHead(client, chainId))
  } catch (error) {
    throw new Error(`链头：${friendlyErrorText(error)}`)
  }
  try {
    wethUsd = await retryRateLimited(chainId, () => wethUsdOnChain(client, chainId))
  } catch (error) {
    throw new Error(`锚定价格：${friendlyErrorText(error)}`)
  }
  try {
    poolRows = await retryRateLimited(chainId, () => resolveV3PoolsBatch(client, chainId, refs))
  } catch (error) {
    throw new Error(`池元数据：${friendlyErrorText(error)}`)
  }
  const candidates = refs.flatMap((pool) => {
    const row = poolRows.get(pool.toLowerCase())
    return row ? [{ pool, row }] : []
  })
  // Robinhood 公共 RPC 对并发 eth_getLogs + eth_call 很容易 429；两步串行只多
  // 一个 RTT，却能让 V3 年化稳定落地。
  let swaps: V3AprSwap[]
  try {
    swaps = await fetchV3AprSwaps(client, chainId, candidates.map(({ pool }) => pool), head)
  } catch (error) {
    throw new Error(`Swap 日志：${friendlyErrorText(error)}`)
  }
  let balanceResults: UnknownCallResult[]
  try {
    balanceResults = await retryRateLimited(chainId, () =>
      readBatch(client, candidates.flatMap(({ pool, row }) => [
        { address: row.token0, abi: erc20Abi, functionName: 'balanceOf', args: [pool] },
        { address: row.token1, abi: erc20Abi, functionName: 'balanceOf', args: [pool] },
      ])))
  } catch (error) {
    throw new Error(`池余额：${friendlyErrorText(error)}`)
  }
  const swapsByPool = new Map<string, V3AprSwap[]>()
  for (const swap of swaps) {
    const key = swap.pool.toLowerCase()
    const rows = swapsByPool.get(key) ?? []
    rows.push(swap)
    swapsByPool.set(key, rows)
  }

  const cfg = CHAIN_CONFIGS[chainId]
  const stableSet = new Set([cfg.contracts.stable, ...(cfg.usdStables ?? [])].map((x) => x.toLowerCase()))
  const out = new Map<string, FlowAprMetric>()
  for (let i = 0; i < candidates.length; i += 1) {
    const { pool, row } = candidates[i]!
    let windowSwapUsd = 0
    let windowFeeUsd = 0
    let aprSwapCount = 0
    for (const swap of swapsByPool.get(pool.toLowerCase()) ?? []) {
      const notional = anchoredSwapNotionalUsd({
        amount0: swap.amount0,
        amount1: swap.amount1,
        decimals0: row.decimals0,
        decimals1: row.decimals1,
        token0: row.token0,
        token1: row.token1,
        weth: cfg.contracts.weth,
        stableSet,
        wethUsd,
      })
      if (!(notional > 0)) continue
      windowSwapUsd += notional
      windowFeeUsd += notional * Math.min(1_000_000, Math.max(0, row.fee)) / 1_000_000
      aprSwapCount += 1
    }
    const balance0Result = balanceResults[i * 2]
    const balance1Result = balanceResults[i * 2 + 1]
    const balance0 = balance0Result?.status === 'success' ? BigInt(balance0Result.result as bigint) : 0n
    const balance1 = balance1Result?.status === 'success' ? BigInt(balance1Result.result as bigint) : 0n
    const aprLiquidityUsd = anchoredLiquidityUsd({
      amount0: balance0,
      amount1: balance1,
      decimals0: row.decimals0,
      decimals1: row.decimals1,
      token0: row.token0,
      token1: row.token1,
      weth: cfg.contracts.weth,
      stableSet,
      wethUsd,
    })
    out.set(flowAprKey(chainId, 'v3', pool), {
      windowSwapUsd: clampUsd(windowSwapUsd),
      windowFeeUsd: clampUsd(windowFeeUsd),
      aprLiquidityUsd: aprLiquidityUsd > 0 ? aprLiquidityUsd : undefined,
      feeAprPct: annualizedFeePct(windowFeeUsd, aprLiquidityUsd),
      aprSwapCount,
      effectiveFeePips: row.fee,
      aprBasis: 'pool-balance',
    })
  }
  return out
}

async function fetchV4AprMetrics(
  chainId: FlowChainId,
  events: FlowEvent[],
): Promise<Map<string, FlowAprMetric>> {
  const client = getClient(chainId)
  const poolIds = [...new Map(events.flatMap((event) => event.poolId
    ? [[event.poolId.toLowerCase(), event.poolId] as const]
    : [])).values()]
  // Keep state reads behind the same lane as V3. Robinhood's quota is shared,
  // so three individually-retried promises in parallel still form a burst.
  const head = await retryRateLimited(chainId, () => getScanHead(client, chainId))
  const wethUsd = await retryRateLimited(chainId, () => wethUsdOnChain(client, chainId))
  const poolRows = await retryRateLimited(chainId, () =>
    resolveV4PoolsBatch(client, chainId, poolIds))
  const candidates = poolIds.flatMap((poolId) => {
    const row = poolRows.get(poolId.toLowerCase())
    return row ? [{ poolId, row }] : []
  })
  const cfg = CHAIN_CONFIGS[chainId]
  const swaps = await fetchV4AprSwaps(client, chainId, candidates.map(({ poolId }) => poolId), head)
  const stateResults = await retryRateLimited(chainId, () =>
    readBatch(client, candidates.flatMap(({ poolId }) => [
      {
        address: cfg.contracts.v4StateView,
        abi: v4StateViewAbi,
        functionName: 'getSlot0',
        args: [poolId],
      },
      {
        address: cfg.contracts.v4StateView,
        abi: v4StateViewAbi,
        functionName: 'getLiquidity',
        args: [poolId],
      },
    ])))
  const swapsByPool = new Map<string, V4AprSwap[]>()
  for (const swap of swaps) {
    const key = swap.poolId.toLowerCase()
    const rows = swapsByPool.get(key) ?? []
    rows.push(swap)
    swapsByPool.set(key, rows)
  }
  const stableSet = new Set([cfg.contracts.stable, ...(cfg.usdStables ?? [])].map((x) => x.toLowerCase()))
  const out = new Map<string, FlowAprMetric>()
  for (let i = 0; i < candidates.length; i += 1) {
    const { poolId, row } = candidates[i]!
    let windowSwapUsd = 0
    let windowFeeUsd = 0
    let aprSwapCount = 0
    for (const swap of swapsByPool.get(poolId.toLowerCase()) ?? []) {
      const notional = anchoredSwapNotionalUsd({
        amount0: swap.amount0,
        amount1: swap.amount1,
        decimals0: row.decimals0,
        decimals1: row.decimals1,
        token0: row.token0,
        token1: row.token1,
        weth: cfg.contracts.weth,
        stableSet,
        wethUsd,
      })
      if (!(notional > 0)) continue
      const feePips = Math.min(1_000_000, Math.max(0, swap.feePips))
      windowSwapUsd += notional
      windowFeeUsd += notional * feePips / 1_000_000
      aprSwapCount += 1
    }

    const slotResult = stateResults[i * 2]
    const liquidityResult = stateResults[i * 2 + 1]
    const slot0 = slotResult?.status === 'success'
      ? slotResult.result as readonly unknown[]
      : undefined
    const sqrtPriceX96 = slot0?.[0] as bigint | undefined
    const liquidity = liquidityResult?.status === 'success'
      ? BigInt(liquidityResult.result as bigint)
      : 0n
    if (sqrtPriceX96 && sqrtPriceX96 > 0n) {
      row.sqrtPriceX96 = sqrtPriceX96
    }
    const amount0 = sqrtPriceX96 && sqrtPriceX96 > 0n
      ? (liquidity * Q96) / sqrtPriceX96
      : 0n
    const amount1 = sqrtPriceX96 && sqrtPriceX96 > 0n
      ? (liquidity * sqrtPriceX96) / Q96
      : 0n
    const aprLiquidityUsd = anchoredLiquidityUsd({
      amount0,
      amount1,
      decimals0: row.decimals0,
      decimals1: row.decimals1,
      token0: row.token0,
      token1: row.token1,
      weth: cfg.contracts.weth,
      stableSet,
      wethUsd,
    })
    out.set(flowAprKey(chainId, 'v4', poolId), {
      windowSwapUsd: clampUsd(windowSwapUsd),
      windowFeeUsd: clampUsd(windowFeeUsd),
      aprLiquidityUsd: aprLiquidityUsd > 0 ? aprLiquidityUsd : undefined,
      feeAprPct: annualizedFeePct(windowFeeUsd, aprLiquidityUsd),
      aprSwapCount,
      effectiveFeePips: windowSwapUsd > 0 ? (windowFeeUsd / windowSwapUsd) * 1_000_000 : undefined,
      aprBasis: 'active-liquidity',
    })
  }
  return out
}

async function enrichFlowApr(events: FlowEvent[]): Promise<{
  events: FlowEvent[]
  notices: FlowNotice[]
}> {
  const now = Date.now()
  const metrics = new Map<string, FlowAprMetric>()
  /** 待新算的池：key → 代表事件（取金额最大的一条） */
  const pendingPools = new Map<string, FlowEvent>()

  for (const event of events) {
    const key = flowAprKey(event.chainId, event.version, flowPoolRef(event))
    const hit = flowAprCache.get(key)
    if (hit && now - hit.at < APR_TTL_MS) {
      metrics.set(key, hit.metric)
      continue
    }
    const prev = pendingPools.get(key)
    if (!prev || event.amountUsd > prev.amountUsd) pendingPools.set(key, event)
  }

  // Exact pair ids are batched by DexScreener, so this covers the complete
  // visible list without dozens of per-pool eth_getLogs calls.
  const ranked = [...pendingPools.entries()]
    .sort((a, b) => b[1].amountUsd - a[1].amountUsd)
    .slice(0, APR_POOL_LIMIT)
  const pending = new Map<string, FlowEvent[]>()
  for (const [key, sample] of ranked) {
    const groupKey = `${sample.chainId}:${sample.version}`
    const rows = pending.get(groupKey) ?? []
    rows.push(sample)
    pending.set(groupKey, rows)
    // stale 缓存：新算前先挂上，避免榜单闪空
    const stale = flowAprCache.get(key)
    if (stale) metrics.set(key, stale.metric)
  }

  const notices: FlowNotice[] = []
  const pendingByChain = new Map<FlowChainId, Array<{ version: FlowVersion; rows: FlowEvent[] }>>()
  for (const [groupKey, rows] of pending) {
    const [rawChainId, version] = groupKey.split(':') as [string, FlowVersion]
    const chainId = Number(rawChainId) as FlowChainId
    const groups = pendingByChain.get(chainId) ?? []
    groups.push({ version, rows })
    pendingByChain.set(chainId, groups)
  }
  // 不同链可并行；同一条链的 V3/V4 串行，避免把公共 RPC 瞬间打到 429。
  await Promise.all([...pendingByChain.entries()].map(async ([chainId, groups]) => {
    groups.sort((a, b) => a.version.localeCompare(b.version))
    for (const { version, rows } of groups) {
      try {
        const canUseOnchain = chainId === 56 || Boolean(loadCustomRpcUrl(chainId))
        const fetchOnchain = () => version === 'v3'
          ? timedSource(`${flowChainLabel(chainId)} V3 on-chain APR`, fetchV3AprMetrics(chainId, rows))
          : timedSource(`${flowChainLabel(chainId)} V4 on-chain APR`, fetchV4AprMetrics(chainId, rows))
        let next: Map<string, FlowAprMetric>
        try {
          next = await timedSource(
            `${flowChainLabel(chainId)} ${version.toUpperCase()} DexScreener APR`,
            fetchDexScreenerAprMetrics(chainId, version, rows),
          )
          if (next.size === 0 && canUseOnchain) next = await fetchOnchain()
        } catch (dexError) {
          // Robinhood's public RPC is intentionally not an APR fallback: its
          // log quota is needed for movement discovery. A configured private
          // RPC (or BSC) may still use the exact on-chain calculation.
          if (!canUseOnchain) throw dexError
          next = await fetchOnchain()
        }
        for (const [key, metric] of next) {
          metrics.set(key, metric)
          flowAprCache.set(key, { at: Date.now(), metric })
        }
      } catch (error) {
        notices.push({
          level: 'warning',
          message: `${flowChainLabel(chainId)} ${version.toUpperCase()} 年化暂不可用：${friendlyErrorText(error)}`,
        })
      }
    }
    pruneChainCaches(chainId)
  }))

  if (flowAprCache.size > 600) {
    for (const [key, entry] of flowAprCache) {
      if (now - entry.at >= APR_TTL_MS * 3) flowAprCache.delete(key)
    }
  }
  return {
    events: events.map((event) => {
      const metric = metrics.get(flowAprKey(event.chainId, event.version, flowPoolRef(event)))
      return metric ? { ...event, ...metric } : event
    }),
    notices,
  }
}

type DexScreenerPair = {
  chainId?: string
  dexId?: string
  pairAddress?: string
  labels?: string[] | null
  liquidity?: { usd?: number }
  volume?: Record<string, number | undefined>
  txns?: Record<string, { buys?: number; sells?: number } | undefined>
  marketCap?: number
  fdv?: number
  pairCreatedAt?: number
  baseToken?: { address?: string; symbol?: string }
  quoteToken?: { address?: string; symbol?: string }
}

/**
 * Exact-pair 24h APR. One request carries many pool addresses/ids, avoiding
 * per-pool Swap scans and preserving Blockscout's tiny anonymous quota for the
 * actual movement feed.
 */
async function fetchDexScreenerAprMetrics(
  chainId: FlowChainId,
  version: FlowVersion,
  events: FlowEvent[],
): Promise<Map<string, FlowAprMetric>> {
  const byRef = new Map<string, FlowEvent>()
  for (const event of events) {
    const ref = flowPoolRef(event).toLowerCase()
    const previous = byRef.get(ref)
    if (!previous || event.amountUsd > previous.amountUsd) byRef.set(ref, event)
  }
  const refs = [...byRef.keys()]
  const chunks: string[][] = []
  for (let i = 0; i < refs.length; i += 30) chunks.push(refs.slice(i, i + 30))
  const chainSlug = dexScreenerChain(chainId)
  const responses = await Promise.all(chunks.map(async (chunk) => {
    const url = `https://api.dexscreener.com/latest/dex/pairs/${chainSlug}/${chunk.join(',')}`
    const json = await fetchJson<{ pairs?: DexScreenerPair[] | null }>(url, 8_000)
    return Array.isArray(json.pairs) ? json.pairs : []
  }))

  const out = new Map<string, FlowAprMetric>()
  for (const pair of responses.flat()) {
    if ((pair.chainId ?? '').toLowerCase() !== chainSlug) continue
    if (pair.dexId && pair.dexId.toLowerCase() !== 'uniswap') continue
    const pairRef = pair.pairAddress?.toLowerCase()
    if (!pairRef) continue
    const event = byRef.get(pairRef)
    if (!event) continue
    const versionLabels = (pair.labels ?? []).map((label) => label.toLowerCase())
    if (versionLabels.some((label) => label === 'v3' || label === 'v4') && !versionLabels.includes(version)) {
      continue
    }
    // Dynamic-fee V4 pools need per-swap fee data; do not invent a fee just to
    // populate the leaderboard.
    if (version === 'v4' && (event.fee & 0x800000) !== 0) continue
    const feePips = Math.min(1_000_000, Math.max(0, event.fee & 0x7fffff))
    const volume24h = clampUsd(Number(pair.volume?.h24) || 0)
    const liquidityUsd = clampUsd(Number(pair.liquidity?.usd) || 0)
    if (!(liquidityUsd > 0)) continue
    const fee24h = clampUsd(volume24h * feePips / 1_000_000)
    const h24 = pair.txns?.h24
    const swapCount = Math.max(0, Math.floor((Number(h24?.buys) || 0) + (Number(h24?.sells) || 0)))
    out.set(flowAprKey(chainId, version, pairRef), {
      windowSwapUsd: volume24h,
      windowFeeUsd: fee24h,
      aprLiquidityUsd: liquidityUsd,
      feeAprPct: annualizedFeePct(fee24h, liquidityUsd, 24 * 60),
      aprSwapCount: swapCount,
      aprWindowMinutes: 24 * 60,
      effectiveFeePips: feePips,
      aprBasis: 'dexscreener-liquidity',
    })
  }
  return out
}

async function fetchDexScreenerTokenMetas(
  chainId: FlowChainId,
  tokens: Array<{ address: Address; symbol: string }>,
): Promise<Map<string, FlowMarketMeta>> {
  const out = new Map<string, FlowMarketMeta>()
  if (tokens.length === 0) return out
  const chainSlug = dexScreenerChain(chainId)
  const chunks: Array<Array<{ address: Address; symbol: string }>> = []
  for (let i = 0; i < tokens.length; i += 30) chunks.push(tokens.slice(i, i + 30))

  for (const chunk of chunks) {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.map((t) => t.address).join(',')}`
    let pairs: DexScreenerPair[] = []
    try {
      const json = await fetchJson<{ pairs?: DexScreenerPair[] | null }>(url, 8_000)
      pairs = Array.isArray(json.pairs) ? json.pairs : []
    } catch {
      continue
    }
    const bestByToken = new Map<string, { liq: number; meta: FlowMarketMeta }>()
    for (const pair of pairs) {
      if ((pair.chainId || '').toLowerCase() !== chainSlug) continue
      const liq = Number(pair.liquidity?.usd) || 0
      const mcapRaw = Number(pair.marketCap)
      const fdvRaw = Number(pair.fdv)
      const marketCapUsd = mcapRaw > 0 ? mcapRaw : fdvRaw > 0 ? fdvRaw : undefined
      const createdMs = Number(pair.pairCreatedAt)
      const tokenCreatedAt =
        Number.isFinite(createdMs) && createdMs > 1_000_000_000_000
          ? Math.floor(createdMs / 1000)
          : Number.isFinite(createdMs) && createdMs > 1_000_000_000
            ? Math.floor(createdMs)
            : undefined
      for (const side of [pair.baseToken, pair.quoteToken]) {
        const addr = side?.address?.toLowerCase()
        if (!addr) continue
        if (!chunk.some((t) => t.address.toLowerCase() === addr)) continue
        const prev = bestByToken.get(addr)
        if (prev && prev.liq >= liq) continue
        const known = chunk.find((t) => t.address.toLowerCase() === addr)
        bestByToken.set(addr, {
          liq,
          meta: {
            coinAddress: (known?.address ?? side!.address!) as Address,
            coinSymbol: known?.symbol || side?.symbol || 'TOKEN',
            marketCapUsd,
            tokenCreatedAt,
          },
        })
      }
    }
    for (const [addr, row] of bestByToken) out.set(addr, row.meta)
    // 没命中的也写入空壳，避免每轮重打
    for (const token of chunk) {
      const key = token.address.toLowerCase()
      if (!out.has(key)) {
        out.set(key, {
          coinAddress: token.address,
          coinSymbol: token.symbol,
        })
      }
    }
  }
  return out
}

async function enrichFlowMarketMeta(events: FlowEvent[]): Promise<FlowEvent[]> {
  const now = Date.now()
  const pendingByChain = new Map<FlowChainId, Map<string, { address: Address; symbol: string }>>()
  const resolved = new Map<string, FlowMarketMeta>()

  for (const event of events) {
    const coin = flowCoinSide(event)
    if (!coin) continue
    const key = flowMarketKey(event.chainId, coin.address)
    const hit = flowMarketCache.get(key)
    if (hit && now - hit.at < FLOW_MARKET_TTL_MS) {
      resolved.set(key, hit.meta)
      continue
    }
    const bucket = pendingByChain.get(event.chainId) ?? new Map()
    bucket.set(coin.address.toLowerCase(), coin)
    pendingByChain.set(event.chainId, bucket)
  }

  await Promise.all([...pendingByChain.entries()].map(async ([chainId, tokens]) => {
    try {
      const fetched = await fetchDexScreenerTokenMetas(chainId, [...tokens.values()])
      for (const [addr, meta] of fetched) {
        const key = flowMarketKey(chainId, meta.coinAddress)
        flowMarketCache.set(key, { at: Date.now(), meta })
        resolved.set(key, meta)
        // 兼容用小写地址查
        resolved.set(flowMarketKey(chainId, addr as Address), meta)
      }
    } catch {
      /* DexScreener 失败不挡主列表 */
    }
  }))

  pruneMapSize(flowMarketCache, FLOW_MARKET_CACHE_CAP)

  return events.map((event) => {
    const coin = flowCoinSide(event)
    if (!coin) return event
    const meta = resolved.get(flowMarketKey(event.chainId, coin.address))
      ?? flowMarketCache.get(flowMarketKey(event.chainId, coin.address))?.meta
    if (!meta) {
      return {
        ...event,
        coinAddress: coin.address,
        coinSymbol: coin.symbol,
      }
    }
    return {
      ...event,
      coinAddress: meta.coinAddress,
      coinSymbol: meta.coinSymbol || coin.symbol,
      marketCapUsd: meta.marketCapUsd,
      tokenCreatedAt: meta.tokenCreatedAt,
    }
  })
}

export async function fetchFlowEvents(opts: FlowFetchOpts): Promise<{
  events: FlowEvent[]
  notices: FlowNotice[]
}> {
  const requestedMin = opts.minUsd ?? 100
  const minUsd = Number.isFinite(requestedMin) ? Math.max(0, requestedMin) : 100
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 30)))
  const filterHp = opts.filterHoneypot !== false
  const notices: FlowNotice[] = []
  const parts: FlowEvent[] = []
  const publishBase = (events: FlowEvent[], currentNotices: FlowNotice[] = notices) => {
    if (!opts.onBaseEvents || events.length === 0) return
    try {
      opts.onBaseEvents({ events, notices: [...currentNotices] })
    } catch {
      // UI progress callbacks must never break data collection.
    }
  }
  const publishCollectedParts = () => {
    const seen = new Set<string>()
    const collected = parts.filter((event) => {
      if (seen.has(event.id)) return false
      seen.add(event.id)
      return event.amountUsd >= minUsd && isRecentTimestamp(event.timestamp)
    })
    collected.sort((a, b) => b.timestamp - a.timestamp)
    publishBase(takeFlowPoolEvents(collected, opts.chainIds, limit))
  }

  // A returning visitor gets the recent persisted list synchronously while
  // the reorg overlap is refreshed in the background.
  for (const chainId of opts.chainIds) hydrateFlowSnapshot(chainId)
  const cached = opts.chainIds.flatMap((chainId) => [
    ...logCaches[chainId].events,
    ...v4Caches[chainId].events,
  ]).filter((event) => event.amountUsd >= minUsd && isRecentTimestamp(event.timestamp))
  publishBase(takeFlowPoolEvents(cached, opts.chainIds, limit), [])

  const jobs: Promise<void>[] = []
  if (opts.chainIds.includes(56)) {
    jobs.push(
      timedSource('BSC V3', fetchBscFlow({ minUsd, limit })).then((r) => {
        if (r.note) notices.push({ level: 'warning', message: r.note })
        if (r.error) notices.push({ level: 'error', message: `BSC V3：${r.error}` })
        parts.push(...r.events)
        publishCollectedParts()
      }),
    )
    jobs.push(
      timedSource('BSC V4', fetchV4FlowLogs(56, { minUsd, limit })).then((r) => {
        if (r.error) notices.push({ level: 'error', message: `BSC V4：${r.error}` })
        parts.push(...r.events)
        publishCollectedParts()
      }),
    )
  }
  if (opts.chainIds.includes(4663)) {
    // V4 needs only one selective log stream and much less metadata than V3.
    // Start it first so a useful pool list can paint while V3 NFTs resolve.
    jobs.push(
      timedSource('Robinhood V4', fetchV4FlowLogs(4663, { minUsd, limit })).then((result) => {
        if (result.error) notices.push({ level: 'error', message: `Robinhood V4：${result.error}` })
        parts.push(...result.events)
        publishCollectedParts()
      }),
    )
    jobs.push(
      timedSource('Robinhood V3', fetchNpmFlowLogs(4663, { minUsd, limit })).then((result) => {
        if (result.error) notices.push({ level: 'error', message: `Robinhood V3：${result.error}` })
        parts.push(...result.events)
        publishCollectedParts()
      }),
    )
  }
  await Promise.all(jobs)

  const seen = new Set<string>()
  let events = parts.filter((e) => {
    if (seen.has(e.id)) return false
    seen.add(e.id)
    return e.amountUsd >= minUsd && isRecentTimestamp(e.timestamp)
  })

  events.sort((a, b) => b.timestamp - a.timestamp)
  // Do not hold the first useful list behind GoPlus or batched market/APR
  // enrichment. Those sources update the same rows below.
  publishBase(takeFlowPoolEvents(events, opts.chainIds, limit))

  if (filterHp && events.length) {
    try {
      events = await filterHoneypotFast(events)
    } catch (e) {
      notices.push({ level: 'warning', message: `风险检查暂不可用：${friendlyErrorText(e)}` })
    }
  }

  events.sort((a, b) => b.timestamp - a.timestamp)
  const balanced = takeFlowPoolEvents(events, opts.chainIds, limit)
  const [apr, withMarket] = await Promise.all([
    enrichFlowApr(balanced),
    enrichFlowMarketMeta(balanced),
  ])
  notices.push(...apr.notices)
  // APR 与市值并行；按 id 合并，避免互相覆盖
  const marketById = new Map(withMarket.map((event) => [event.id, event]))
  const merged = apr.events.map((event) => {
    const market = marketById.get(event.id)
    if (!market) return event
    return {
      ...event,
      coinAddress: market.coinAddress,
      coinSymbol: market.coinSymbol,
      marketCapUsd: market.marketCapUsd,
      tokenCreatedAt: market.tokenCreatedAt,
    }
  })
  const uniqueNotices = [...new Map(notices.map((notice) => [
    `${notice.level}:${notice.message}`,
    notice,
  ])).values()]
  return {
    events: merged,
    notices: uniqueNotices,
  }
}

export function flowExplorerTx(chainId: FlowChainId, hash: Hash): string {
  return `${CHAIN_CONFIGS[chainId].explorerUrl}/tx/${hash}`
}

export function flowChainLabel(chainId: FlowChainId): string {
  return CHAIN_CONFIGS[chainId].shortLabel
}
