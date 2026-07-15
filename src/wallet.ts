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
import { robinhood } from './chain'

/** 官方 RPC + Blockscout 备用（只读走 HTTP，避免钱包 eth_call 缓存导致刷新不变） */
export const RPC_URLS = [
  'https://rpc.mainnet.chain.robinhood.com',
  'https://robinhoodchain.blockscout.com/api/eth-rpc',
] as const

function makeReadTransport() {
  return fallback(
    RPC_URLS.map((url) =>
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
    chain: robinhood,
    transport: makeReadTransport(),
  }),
}

/** 始终指向最新 PublicClient（连接钱包后会切换到钱包 RPC） */
export const publicClient: PublicClient = new Proxy({} as PublicClient, {
  get(_target, prop, _receiver) {
    const value = Reflect.get(clientBox.current, prop, clientBox.current)
    return typeof value === 'function' ? value.bind(clientBox.current) : value
  },
})

/** 连接/切换钱包后调用，切到「钱包 RPC → HTTP 备用」 */
export function refreshPublicClient() {
  clientBox.current = createPublicClient({
    chain: robinhood,
    transport: makeReadTransport(),
  })
}

export const EXPLORER = robinhood.blockExplorers.default.url

export function explorerTx(hash: string) {
  return `${EXPLORER}/tx/${hash}`
}

export function explorerAddress(addr: string) {
  return `${EXPLORER}/address/${addr}`
}

export function explorerToken(addr: string) {
  return `${EXPLORER}/token/${addr}`
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

export async function ensureRobinhoodChain(): Promise<void> {
  if (!window.ethereum) throw new Error('请安装 MetaMask / Rabby')
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x1237' }],
    })
  } catch (e: unknown) {
    const err = e as { code?: number }
    if (err.code === 4902) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: '0x1237',
          chainName: 'Robinhood Chain',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [...RPC_URLS],
          blockExplorerUrls: [EXPLORER],
        }],
      })
    } else {
      throw e
    }
  }
}

export async function connectWallet(): Promise<{ address: Address; walletClient: WalletClient }> {
  if (!window.ethereum) throw new Error('请安装 MetaMask / Rabby')
  await ensureRobinhoodChain()
  refreshPublicClient()
  const accounts = (await window.ethereum.request({ method: 'eth_requestAccounts' })) as string[]
  if (!accounts[0]) throw new Error('未获取到账户')
  const walletClient = createWalletClient({
    chain: robinhood,
    transport: custom(window.ethereum),
    account: accounts[0] as Address,
  })
  return { address: accounts[0] as Address, walletClient }
}

export function makeWalletClient(address: Address): WalletClient {
  if (!window.ethereum) throw new Error('请安装 MetaMask / Rabby')
  refreshPublicClient()
  return createWalletClient({
    chain: robinhood,
    transport: custom(window.ethereum),
    account: address,
  })
}

export function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}
