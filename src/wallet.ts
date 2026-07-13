import { createPublicClient, createWalletClient, custom, http, type Address, type WalletClient } from 'viem'
import { robinhood } from './chain'

export const publicClient = createPublicClient({
  chain: robinhood,
  transport: http('https://rpc.mainnet.chain.robinhood.com'),
})

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
          rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
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
  return createWalletClient({
    chain: robinhood,
    transport: custom(window.ethereum),
    account: address,
  })
}

export function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}
