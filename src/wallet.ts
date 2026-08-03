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
import { getActiveAccount, type LocalAccount } from './signer'

function getReadRpcUrls(): string[] {
  const cfg = getActiveChainConfig()
  const custom = loadCustomRpcUrl(cfg.id)
  if (custom) return [custom]
  return [...cfg.defaultRpcUrls]
}

/**
 * 只读 transport。
 * Arc 主网几乎没有可用公共 RPC（thirdweb 只能 eth_chainId），所以有钱包时优先走
 * window.ethereum（用钱包里已配好的节点），公共 URL 短超时垫底。
 */
function makeReadTransport() {
  const cfg = getActiveChainConfig()
  const customUrl = loadCustomRpcUrl(cfg.id)
  const httpUrls = customUrl ? [customUrl] : [...cfg.defaultRpcUrls]
  const httpTimeout = customUrl
    ? 30_000
    : cfg.key === 'arc'
      ? 6_000
      : cfg.key === 'bsc' || cfg.key === 'ethereum'
        ? 12_000
        : 20_000
  const httpTransports = httpUrls.map((url) =>
    http(url, {
      timeout: httpTimeout,
      retryCount: customUrl ? 2 : 1,
    }),
  )

  const walletTransport =
    typeof window !== 'undefined' && window.ethereum
      ? custom(window.ethereum)
      : null

  // Arc：钱包 RPC 优先；其它链：HTTP 优先，钱包垫底
  const transports =
    cfg.key === 'arc' && walletTransport
      ? customUrl
        ? [...httpTransports, walletTransport]
        : [walletTransport, ...httpTransports]
      : walletTransport
        ? [...httpTransports, walletTransport]
        : httpTransports

  if (transports.length === 0) {
    return http('http://127.0.0.1:8545', { timeout: 5_000 })
  }
  return fallback(transports, { rank: false })
}

const clientBox: { current: PublicClient } = {
  current: createPublicClient({
    chain: getActiveChainConfig().chain,
    transport: makeReadTransport(),
    batch: { multicall: true },
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
    batch: { multicall: true },
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
          nativeCurrency: {
            name: cfg.chain.nativeCurrency.name,
            symbol: cfg.chain.nativeCurrency.symbol,
            decimals: cfg.chain.nativeCurrency.decimals,
          },
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

/**
 * 本地私钥钱包客户端。
 *
 * lp.ts / v4.ts 里 32 处写调用都传 `account: owner`（一个 Address 字符串）。
 * viem 看到字符串 account 会当成 JSON-RPC 账户走 eth_sendTransaction —— 本地私钥没有
 * 可解锁账户，必然失败。这里用 Proxy 包一层：凡是传进来的 account 是字符串且等于本地
 * 地址，就替换成真正的 Account 对象，于是本地签名 + eth_sendRawTransaction。
 * 这样上层链上逻辑一行都不用改。
 */
function wrapLocalClient(base: WalletClient, account: LocalAccount): WalletClient {
  const sameAddr = (v: unknown) =>
    typeof v === 'string' && v.toLowerCase() === account.address.toLowerCase()

  const fix = (args: unknown) => {
    if (!args || typeof args !== 'object') return args
    const o = args as Record<string, unknown>
    if (sameAddr(o.account) || o.account == null) return { ...o, account }
    return o
  }

  return new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      // 所有写入类方法的第一个参数都是 options 对象
      if (
        prop === 'writeContract'
        || prop === 'sendTransaction'
        || prop === 'signTypedData'
        || prop === 'signMessage'
        || prop === 'deployContract'
      ) {
        return (args: unknown, ...rest: unknown[]) =>
          (value as (...a: unknown[]) => unknown).call(target, fix(args), ...rest)
      }
      return (value as (...a: unknown[]) => unknown).bind(target)
    },
  }) as WalletClient
}

/** 用已解锁的本地私钥建 walletClient；transport 走只读 RPC（自建节点优先） */
export function makeLocalWalletClient(): { address: Address; walletClient: WalletClient } {
  const account = getActiveAccount()
  if (!account) throw new Error('本地私钥未解锁')
  refreshPublicClient()
  const base = createWalletClient({
    account,
    chain: getActiveChainConfig().chain,
    transport: makeReadTransport(),
  })
  return { address: account.address, walletClient: wrapLocalClient(base, account) }
}

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
