import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem'
import {
  getActiveChainConfig,
  getActiveChainId,
  isSupportedChainId,
  setActiveChainId,
  type SupportedChainId,
} from './chain'
import { loadCustomRpcUrl } from './rpcSettings'

function getReadRpcUrls(): string[] {
  const cfg = getActiveChainConfig()
  const custom = loadCustomRpcUrl(cfg.id)
  if (custom) return [custom]
  return [...cfg.defaultRpcUrls]
}

function makeReadTransport() {
  return fallback(
    getReadRpcUrls().map((url) =>
      http(url, {
        timeout: 30_000,
        retryCount: 2,
      }),
    ),
    { rank: false },
  )
}

const clientBox: { current: PublicClient } = {
  current: createPublicClient({
    chain: getActiveChainConfig().chain,
    transport: makeReadTransport(),
  }),
}

/** 始终指向最新 PublicClient */
export const publicClient: PublicClient = new Proxy({} as PublicClient, {
  get(_target, prop, _receiver) {
    const value = Reflect.get(clientBox.current, prop, clientBox.current)
    return typeof value === 'function' ? value.bind(clientBox.current) : value
  },
})

/** 切换链或自定义 RPC 后重建只读客户端 */
export function refreshPublicClient() {
  const cfg = getActiveChainConfig()
  clientBox.current = createPublicClient({
    chain: cfg.chain,
    transport: makeReadTransport(),
  })
}

export function getExplorerBase(): string {
  return getActiveChainConfig().explorerUrl
}

/** @deprecated 用 getExplorerBase() */
export const EXPLORER = getActiveChainConfig().explorerUrl

export function explorerTx(hash: string) {
  return `${getExplorerBase()}/tx/${hash}`
}

export function explorerAddress(addr: string) {
  return `${getExplorerBase()}/address/${addr}`
}

export function explorerToken(addr: string) {
  return `${getExplorerBase()}/token/${addr}`
}

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
      on?: (event: string, cb: (...args: unknown[]) => void) => void
      removeListener?: (event: string, cb: (...args: unknown[]) => void) => void
    }
  }
}

export async function ensureActiveChain(): Promise<void> {
  if (!window.ethereum) throw new Error('请安装 MetaMask / Rabby')
  const cfg = getActiveChainConfig()
  const customRpc = loadCustomRpcUrl(cfg.id)
  const rpcUrls = customRpc ? [customRpc, ...cfg.defaultRpcUrls] : [...cfg.defaultRpcUrls]
  const chainIdHex = `0x${cfg.id.toString(16)}`
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    })
  } catch (e: unknown) {
    const err = e as { code?: number }
    if (err.code === 4902) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: chainIdHex,
          chainName: cfg.label,
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls,
          blockExplorerUrls: [cfg.explorerUrl],
        }],
      })
    } else {
      throw e
    }
  }
}

/** @deprecated 用 ensureActiveChain */
export const ensureRobinhoodChain = ensureActiveChain

export async function connectWallet(): Promise<{ address: Address; walletClient: WalletClient }> {
  if (!window.ethereum) throw new Error('请安装 MetaMask / Rabby')
  await ensureActiveChain()
  refreshPublicClient()
  const accounts = (await window.ethereum.request({ method: 'eth_requestAccounts' })) as string[]
  if (!accounts[0]) throw new Error('未获取到账户')
  const walletClient = createWalletClient({
    chain: getActiveChainConfig().chain,
    transport: custom(window.ethereum),
    account: accounts[0] as Address,
  })
  return { address: accounts[0] as Address, walletClient }
}

export function makeWalletClient(address: Address): WalletClient {
  if (!window.ethereum) throw new Error('请安装 MetaMask / Rabby')
  refreshPublicClient()
  return createWalletClient({
    chain: getActiveChainConfig().chain,
    transport: custom(window.ethereum),
    account: address,
  })
}

/** 切换应用活跃链（并刷新 RPC 客户端）；钱包需另行 ensureActiveChain */
export function switchAppChain(id: SupportedChainId) {
  setActiveChainId(id)
  refreshPublicClient()
  return getActiveChainConfig()
}

export function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export { getActiveChainId, isSupportedChainId }
