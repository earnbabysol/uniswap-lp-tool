import {
  createPublicClient,
  fallback,
  http,
  type PublicClient,
} from 'viem'
import {
  CHAIN_CONFIGS,
  SUPPORTED_CHAINS,
  type SupportedChainId,
} from './chain'
import { v4StateViewAbi } from './abis'
import { withTimeout } from './async'
import { loadCustomRpcUrl } from './rpcSettings'

export type V4PoolChainMatch = {
  chainId: SupportedChainId
  label: string
  shortLabel: string
}

type ProbeClientCache = {
  key: string
  client: PublicClient
}

type DetectionCache = {
  at: number
  match: V4PoolChainMatch | null
}

const probeClients = new Map<SupportedChainId, ProbeClientCache>()
const detectionCache = new Map<string, DetectionCache>()
const FOUND_CACHE_MS = 30 * 60_000
const MISS_CACHE_MS = 20_000

function getProbeClient(chainId: SupportedChainId): PublicClient {
  const cfg = CHAIN_CONFIGS[chainId]
  const customUrl = loadCustomRpcUrl(chainId)
  const urls = [...new Set([...(customUrl ? [customUrl] : []), ...cfg.defaultRpcUrls])]
  const key = urls.join('|')
  const cached = probeClients.get(chainId)
  if (cached?.key === key) return cached.client

  const client = createPublicClient({
    chain: cfg.chain,
    transport: fallback(
      urls.map((url) => http(url, {
        batch: false,
        retryCount: 0,
        timeout: 3_500,
      })),
      { rank: false },
    ),
  })
  probeClients.set(chainId, { key, client })
  return client
}

async function poolExistsOnChain(
  poolId: `0x${string}`,
  chainId: SupportedChainId,
): Promise<boolean> {
  const cfg = CHAIN_CONFIGS[chainId]
  try {
    const slot0 = await withTimeout(
      getProbeClient(chainId).readContract({
        address: cfg.contracts.v4StateView,
        abi: v4StateViewAbi,
        functionName: 'getSlot0',
        args: [poolId],
      }),
      5_500,
      `${cfg.label} V4 poolId 探测`,
    )
    return (slot0[0] as bigint) > 0n
  } catch {
    return false
  }
}

function matchFor(chainId: SupportedChainId): V4PoolChainMatch {
  const cfg = CHAIN_CONFIGS[chainId]
  return { chainId, label: cfg.label, shortLabel: cfg.shortLabel }
}

async function firstPoolMatch(
  poolId: `0x${string}`,
  chainIds: SupportedChainId[],
): Promise<V4PoolChainMatch | null> {
  if (chainIds.length === 0) return null
  return new Promise((resolve) => {
    let pending = chainIds.length
    let settled = false
    for (const chainId of chainIds) {
      void poolExistsOnChain(poolId, chainId).then((exists) => {
        if (!settled && exists) {
          settled = true
          resolve(matchFor(chainId))
        }
      }).finally(() => {
        pending -= 1
        if (!settled && pending === 0) {
          settled = true
          resolve(null)
        }
      })
    }
  })
}

/**
 * V4 poolId 本身不带 chainId。先查当前网络；不存在时并行探测其余受支持网络，
 * 避免把“池在另一条链”误报成“poolId 不存在”。
 */
export async function detectV4PoolChain(
  poolId: `0x${string}`,
  preferredChainId: SupportedChainId,
): Promise<V4PoolChainMatch | null> {
  const id = poolId.toLowerCase() as `0x${string}`
  const cached = detectionCache.get(id)
  if (cached) {
    const ttl = cached.match ? FOUND_CACHE_MS : MISS_CACHE_MS
    if (Date.now() - cached.at < ttl) {
      if (!cached.match || cached.match.chainId === preferredChainId) return cached.match
      // 同一个 PoolKey 可能被部署到多条链；当前链永远优先于旧的跨链命中。
      if (await poolExistsOnChain(id, preferredChainId)) {
        const preferredMatch = matchFor(preferredChainId)
        detectionCache.set(id, { at: Date.now(), match: preferredMatch })
        return preferredMatch
      }
      return cached.match
    }
    detectionCache.delete(id)
  }

  if (await poolExistsOnChain(id, preferredChainId)) {
    const match = matchFor(preferredChainId)
    detectionCache.set(id, { at: Date.now(), match })
    return match
  }

  const otherChainIds = SUPPORTED_CHAINS
    .map((cfg) => cfg.id)
    .filter((chainId) => chainId !== preferredChainId)
  const match = await firstPoolMatch(id, otherChainIds)
  detectionCache.set(id, { at: Date.now(), match })
  if (detectionCache.size > 200) {
    const oldest = detectionCache.keys().next().value as string | undefined
    if (oldest) detectionCache.delete(oldest)
  }
  return match
}
