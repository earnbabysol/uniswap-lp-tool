import {
  CHAIN_CONFIGS,
  getActiveChainId,
  type SupportedChainId,
} from './chain'

const CHAIN_KEY_PREFIX = 'rangedesk.customRpc.v1.'

export function defaultRpcUrl(chainId: SupportedChainId = getActiveChainId()): string {
  // 这里必须按传入的 chainId 取配置。动向页会同时读取两条链；若使用当前 UI
  // 活跃链，BSC client 可能实际连到 Robinhood RPC（反之亦然），且普通读请求
  // 仍会“成功”，导致 fallback 永远不会纠正到目标链。
  const fromCfg = CHAIN_CONFIGS[chainId].defaultRpcUrls[0]
  if (fromCfg) return fromCfg
  if (chainId === 1) return 'https://ethereum.publicnode.com'
  if (chainId === 196) return 'https://xlayerrpc.okx.com'
  if (chainId === 8453) return 'https://mainnet.base.org'
  if (chainId === 42161) return 'https://arb1.arbitrum.io/rpc'
  if (chainId === 5042) return 'https://5042.rpc.thirdweb.com'
  if (chainId === 56) return 'https://bsc-dataseed.binance.org'
  return 'https://rpc.mainnet.chain.robinhood.com'
}

/** @deprecated 用 defaultRpcUrl() */
export const DEFAULT_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com'

function storageKey(chainId: SupportedChainId = getActiveChainId()) {
  return `${CHAIN_KEY_PREFIX}${chainId}`
}

export function loadCustomRpcUrl(chainId: SupportedChainId = getActiveChainId()): string | null {
  try {
    const raw = localStorage.getItem(storageKey(chainId))?.trim()
    if (raw) return raw
    // 兼容旧版单链（Robinhood）自定义 RPC
    if (chainId === 4663) {
      const legacy = localStorage.getItem('rangedesk.customRpc.v1')?.trim()
      if (legacy) {
        localStorage.setItem(storageKey(4663), legacy)
        return legacy
      }
    }
    return null
  } catch {
    return null
  }
}

export function validateRpcUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) throw new Error('RPC 地址不能为空')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('RPC 地址格式无效')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('RPC 须为 http:// 或 https:// 地址')
  }
  return trimmed.replace(/\/$/, '')
}

/** 保存自定义 RPC；传空字符串则清除并回到默认 */
export function saveCustomRpcUrl(
  url: string,
  chainId: SupportedChainId = getActiveChainId(),
): string | null {
  const trimmed = url.trim()
  if (!trimmed) {
    localStorage.removeItem(storageKey(chainId))
    return null
  }
  const valid = validateRpcUrl(trimmed)
  localStorage.setItem(storageKey(chainId), valid)
  return valid
}

export function getActiveRpcUrl(chainId: SupportedChainId = getActiveChainId()): string {
  return loadCustomRpcUrl(chainId) ?? defaultRpcUrl(chainId)
}

export function describeActiveRpc(chainId: SupportedChainId = getActiveChainId()): string {
  const custom = loadCustomRpcUrl(chainId)
  if (custom) return `自定义 · ${shortRpc(custom)}`
  return `默认 · ${shortRpc(defaultRpcUrl(chainId))}`
}

function shortRpc(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname
    return host.length > 28 ? `${host.slice(0, 12)}…${host.slice(-8)}` : host
  } catch {
    return url.length > 32 ? `${url.slice(0, 14)}…` : url
  }
}

export async function testRpcLatency(url: string): Promise<{ latencyMs: number; blockNumber: bigint }> {
  const target = url.trim() || defaultRpcUrl()
  validateRpcUrl(target)
  const start = performance.now()
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { result?: string; error?: { message?: string } }
  if (data.error?.message) throw new Error(data.error.message)
  if (!data.result) throw new Error('RPC 未返回区块高度')
  return {
    latencyMs: Math.round(performance.now() - start),
    blockNumber: BigInt(data.result),
  }
}
