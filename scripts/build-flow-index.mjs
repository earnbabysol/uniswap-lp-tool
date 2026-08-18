import fs from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const cacheDir = path.join(root, '.index-cache')
const storageFile = path.join(cacheDir, 'localStorage.json')
const flowFile = path.join(root, 'public', 'index', 'flow.json')
const poolsFile = path.join(root, 'public', 'index', 'pools.json')

class FileLocalStorage {
  #data

  constructor(data) {
    this.#data = new Map(Object.entries(data ?? {}).map(([key, value]) => [key, String(value)]))
  }

  get length() { return this.#data.size }
  key(index) { return [...this.#data.keys()][index] ?? null }
  getItem(key) { return this.#data.get(String(key)) ?? null }
  setItem(key, value) { this.#data.set(String(key), String(value)) }
  removeItem(key) { this.#data.delete(String(key)) }
  clear() { this.#data.clear() }
  toJSON() { return Object.fromEntries(this.#data) }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

await fs.mkdir(cacheDir, { recursive: true })
await fs.mkdir(path.dirname(flowFile), { recursive: true })
const localStorage = new FileLocalStorage(await readJson(storageFile, {}))
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorage,
  configurable: true,
})

const previous = await readJson(flowFile, null)
const { FLOW_CHAIN_IDS, FLOW_WINDOW_MINUTES, fetchFlowEvents, flowPoolRef } = await import('../src/flowEvents.ts')

let result
try {
  result = await Promise.race([
    fetchFlowEvents({
      chainIds: [...FLOW_CHAIN_IDS],
      minUsd: 0,
      filterHoneypot: true,
      limit: 100,
      preferSharedIndex: false,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('shared index build timed out')), 5 * 60_000)),
  ])
} catch (error) {
  if (Array.isArray(previous?.events) && previous.events.length > 0) {
    console.warn(`index scan failed, preserving previous snapshot: ${error instanceof Error ? error.message : error}`)
    result = null
  } else {
    throw error
  }
} finally {
  await fs.writeFile(storageFile, JSON.stringify(localStorage.toJSON()), 'utf8')
}

if (result) {
  const generatedAt = Date.now()
  const serialize = (_key, value) => typeof value === 'bigint' ? value.toString() : value
  const snapshot = {
    version: 1,
    generatedAt,
    windowMinutes: FLOW_WINDOW_MINUTES,
    events: result.events,
    notices: result.notices,
  }
  await fs.writeFile(flowFile, JSON.stringify(snapshot, serialize), 'utf8')

  const byPool = new Map()
  for (const event of result.events) {
    const ref = flowPoolRef(event)
    const key = `${event.chainId}:${event.version}:${ref.toLowerCase()}`
    const previousRow = byPool.get(key)
    if (previousRow && previousRow.updatedAt >= event.timestamp) continue
    byPool.set(key, {
      chainId: event.chainId,
      version: event.version,
      ref,
      token0: event.token0,
      token1: event.token1,
      symbol0: event.symbol0,
      symbol1: event.symbol1,
      fee: event.fee,
      updatedAt: event.timestamp,
      liquidityUsd: event.aprLiquidityUsd,
      marketCapUsd: event.marketCapUsd,
    })
  }
  const pools = [...byPool.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  await fs.writeFile(poolsFile, JSON.stringify({ version: 1, generatedAt, pools }), 'utf8')
  console.log(`shared flow index: ${result.events.length} events, ${pools.length} pools`)
}
