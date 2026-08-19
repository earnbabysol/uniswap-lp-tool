/**
 * Shared RPC pressure control for every data source in the app.
 *
 * BSC public endpoints are particularly sensitive to bursts of eth_getLogs.
 * Keeping the queue here means Flow, APR and PnL cannot unknowingly flood the
 * same chain from three independent call sites.
 */

export type RpcLane = 'logs' | 'read' | 'indexer' | 'balance'

export type RpcErrorKind =
  | 'rate-limit'
  | 'range-limit'
  | 'timeout'
  | 'network'
  | 'unknown-rpc'
  | 'other'

type QueueWaiter = () => void

type LaneState = {
  active: number
  nextStartAt: number
  waiters: QueueWaiter[]
}

const laneStates = new Map<string, LaneState>()

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms)
})

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = 'cause' in error && error.cause ? ` ${errorMessage(error.cause)}` : ''
    return `${error.message}${cause}`
  }
  return String(error)
}

export function classifyRpcError(error: unknown): RpcErrorKind {
  const text = errorMessage(error).toLowerCase()
  if (
    text.includes('429')
    || text.includes('rate limit')
    || text.includes('too many requests')
    || text.includes('compute units per second')
  ) return 'rate-limit'
  if (
    text.includes('request exceeds defined limit')
    || text.includes('query returned more than')
    || text.includes('response size exceeded')
    || text.includes('log response size exceeded')
    || text.includes('block range') && text.includes('limit')
    || text.includes('too many results')
  ) return 'range-limit'
  if (
    text.includes('timed out')
    || text.includes('timeout')
    || text.includes('aborterror')
    || text.includes('aborted')
  ) return 'timeout'
  if (
    text.includes('failed to fetch')
    || text.includes('http request failed')
    || text.includes('networkerror')
    || text.includes('socket hang up')
    || text.includes('econnreset')
    || text.includes('http 500')
    || text.includes('http 501')
    || text.includes('502')
    || text.includes('503')
    || text.includes('504')
  ) return 'network'
  if (
    text.includes('unknown rpc error')
    || text.includes('internal json-rpc error')
    || text.includes('internal error')
    || text.includes('server error')
    || text.includes('missing response')
  ) return 'unknown-rpc'
  return 'other'
}

export function isTransientRpcError(error: unknown): boolean {
  return classifyRpcError(error) !== 'other'
}

export function shouldSplitLogRange(error: unknown): boolean {
  const kind = classifyRpcError(error)
  return kind === 'range-limit' || kind === 'timeout' || kind === 'unknown-rpc'
}

export function rpcBackoffMs(
  chainId: number,
  attempt: number,
  kind: RpcErrorKind,
  jitter = Math.random(),
): number {
  // Robinhood's official public endpoint is intentionally rate limited. A
  // short retry only creates another 429, so give it a materially longer
  // cooldown while keeping range/network recovery reasonably quick.
  const base = chainId === 4663 || chainId === 8453
    ? (kind === 'rate-limit' ? 1_500 : 500)
    : chainId === 56 ? 650 : 350
  const kindMultiplier = kind === 'rate-limit'
    ? (chainId === 4663 || chainId === 8453 ? 1.5 : 1.7)
    : 1
  const cappedAttempt = Math.max(0, Math.min(attempt, 5))
  const exponential = base * (2 ** cappedAttempt) * kindMultiplier
  const cap = chainId === 4663 || chainId === 8453 ? 12_000 : 8_000
  return Math.round(Math.min(cap, exponential) + Math.max(0, Math.min(jitter, 1)) * 250)
}

function laneConfig(chainId: number, lane: RpcLane): { concurrency: number; intervalMs: number } {
  if (chainId === 1 && lane === 'indexer') {
    // Ethereum 动向优先走 Blockscout。顺序处理高选择性日志，避免 NPM 与
    // PoolManager 同时消耗匿名配额；普通主网 RPC 读取仍走下方默认并发。
    return { concurrency: 1, intervalMs: 180 }
  }
  if (chainId === 56) {
    return lane === 'logs'
      ? { concurrency: 1, intervalMs: 220 }
      : { concurrency: 2, intervalMs: 70 }
  }
  if (chainId === 4663) {
    // Blockscout's free instance starts returning 429 around short 4 req/s
    // bursts. Two workers at ~2.8 req/s keep selective getLogs fast without
    // exhausting the quota before APR enrichment starts.
    if (lane === 'indexer') return { concurrency: 2, intervalMs: 350 }
    // Wallet-facing balances must not wait behind getLogs / 动向扫描。
    if (lane === 'balance') return { concurrency: 2, intervalMs: 80 }
    // All Robinhood reads share one public quota. Serializing logs and calls
    // together prevents V3, V4 and APR refreshes from stampeding the endpoint.
    return { concurrency: 1, intervalMs: 350 }
  }
  if (chainId === 8453) {
    // Base official RPC + Blockscout both choke on V3/V4 parallel bursts.
    // Share one lane for logs/reads; keep indexer slightly paced.
    if (lane === 'indexer') return { concurrency: 1, intervalMs: 280 }
    if (lane === 'balance') return { concurrency: 2, intervalMs: 60 }
    return { concurrency: 1, intervalMs: 260 }
  }
  return lane === 'logs'
    ? { concurrency: 2, intervalMs: 35 }
    : { concurrency: 4, intervalMs: 15 }
}

function getLane(chainId: number, lane: RpcLane): LaneState {
  const key = (chainId === 4663 || chainId === 8453) && lane !== 'indexer' && lane !== 'balance'
    ? `${chainId}:shared`
    : `${chainId}:${lane}`
  let state = laneStates.get(key)
  if (!state) {
    state = { active: 0, nextStartAt: 0, waiters: [] }
    laneStates.set(key, state)
  }
  return state
}

function deferLane(chainId: number, lane: RpcLane, delayMs: number): void {
  const state = getLane(chainId, lane)
  state.nextStartAt = Math.max(state.nextStartAt, Date.now() + delayMs)
}

async function acquireLane(chainId: number, lane: RpcLane): Promise<() => void> {
  const config = laneConfig(chainId, lane)
  const state = getLane(chainId, lane)
  if (state.active >= config.concurrency) {
    await new Promise<void>((resolve) => state.waiters.push(resolve))
  }
  state.active += 1

  const delay = Math.max(0, state.nextStartAt - Date.now())
  if (delay > 0) await sleep(delay)
  state.nextStartAt = Date.now() + config.intervalMs

  let released = false
  return () => {
    if (released) return
    released = true
    state.active = Math.max(0, state.active - 1)
    state.waiters.shift()?.()
  }
}

export async function runRpcTask<T>(opts: {
  chainId: number
  lane?: RpcLane
  label?: string
  retries?: number
  task: () => Promise<T>
}): Promise<T> {
  const lane = opts.lane ?? 'read'
  const retries = opts.retries ?? (opts.chainId === 4663 ? 3 : opts.chainId === 56 ? 2 : 1)
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const release = await acquireLane(opts.chainId, lane)
    try {
      return await opts.task()
    } catch (error) {
      lastError = error
      const kind = classifyRpcError(error)
      if (kind === 'rate-limit') {
        // Cool down the shared lane before waking queued work. This protects
        // unrelated V3/V4 tasks as well as the request that was rejected.
        deferLane(opts.chainId, lane, rpcBackoffMs(opts.chainId, attempt, kind, 0))
      }
    } finally {
      release()
    }

    const kind = classifyRpcError(lastError)
    // A deterministic provider range cap will not improve after waiting; let
    // readLogsAdaptive bisect it immediately.
    if (kind === 'other' || kind === 'range-limit' || attempt >= retries) throw lastError
    await sleep(rpcBackoffMs(opts.chainId, attempt, kind))
  }

  throw lastError ?? new Error(`${opts.label ?? 'RPC request'} failed`)
}

export async function readLogsAdaptive<T>(opts: {
  chainId: number
  fromBlock: bigint
  toBlock: bigint
  maxSpan: bigint
  minSpan?: bigint
  label?: string
  request: (fromBlock: bigint, toBlock: bigint) => Promise<readonly T[]>
}): Promise<T[]> {
  if (opts.fromBlock > opts.toBlock) return []
  const minSpan = opts.minSpan ?? (opts.chainId === 56 ? 25n : 100n)

  const readRange = async (fromBlock: bigint, toBlock: bigint): Promise<T[]> => {
    try {
      const result = await runRpcTask({
        chainId: opts.chainId,
        lane: 'logs',
        label: opts.label,
        task: () => opts.request(fromBlock, toBlock),
      })
      return [...result]
    } catch (error) {
      const blockCount = toBlock - fromBlock + 1n
      if (!shouldSplitLogRange(error) || blockCount <= minSpan || fromBlock >= toBlock) {
        throw error
      }
      const middle = fromBlock + (toBlock - fromBlock) / 2n
      const left = await readRange(fromBlock, middle)
      const right = await readRange(middle + 1n, toBlock)
      return [...left, ...right]
    }
  }

  const output: T[] = []
  for (let from = opts.fromBlock; from <= opts.toBlock; from += opts.maxSpan) {
    const candidate = from + opts.maxSpan - 1n
    const to = candidate > opts.toBlock ? opts.toBlock : candidate
    output.push(...await readRange(from, to))
  }
  return output
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const output = new Array<R>(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      output[index] = await fn(items[index]!, index)
    }
  }
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length)
  await Promise.all(Array.from({ length: workerCount }, worker))
  return output
}

/** Test/dev helper; never required by production callers. */
export function resetRpcScheduler(): void {
  laneStates.clear()
}
