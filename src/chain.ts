import { defineChain, type Address, type Chain } from 'viem'

export type SupportedChainId = 4663 | 8453

export type ChainContracts = {
  weth: Address
  /** 稳定币：Robinhood=USDG，Base=USDC */
  stable: Address
  /** @deprecated 兼容旧代码，等同 stable */
  usdg: Address
  aapl?: Address
  nvda?: Address
  tsla?: Address
  qqq?: Address
  v3Factory: Address
  v3Npm: Address
  v3SwapRouter: Address
  v3Quoter: Address
  v4PoolManager: Address
  v4PositionManager: Address
  v4StateView: Address
  v4Quoter: Address
  permit2: Address
  universalRouter: Address
}

export type AppChainConfig = {
  id: SupportedChainId
  key: 'robinhood' | 'base'
  label: string
  shortLabel: string
  chain: Chain
  defaultRpcUrls: string[]
  explorerUrl: string
  /** Blockscout / explorer API 根（日志、NFT 扫描） */
  explorerApi: string
  contracts: ChainContracts
  knownTokens: Record<string, { symbol: string; decimals: number }>
  v3PoolInitCodeHash: `0x${string}`
  /** 开仓页默认交易对 */
  defaultTokenA: Address
  defaultTokenB: Address
}

export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
})

export const base = defineChain({
  id: 8453,
  name: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://mainnet.base.org'] },
  },
  blockExplorers: {
    default: { name: 'Basescan', url: 'https://basescan.org' },
  },
})

const ROBINHOOD_CONTRACTS: ChainContracts = {
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  stable: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  aapl: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
  nvda: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  tsla: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d',
  qqq: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68',
  v3Factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  v3Npm: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
  v3SwapRouter: '0xcaf681a66d020601342297493863e78c959e5cb2',
  v3Quoter: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  v4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  v4PositionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  v4StateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
}

const BASE_CONTRACTS: ChainContracts = {
  weth: '0x4200000000000000000000000000000000000006',
  stable: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  usdg: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  v3Factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  v3Npm: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
  v3SwapRouter: '0x2626664c2603336E57B271c5C0b26F421741e481',
  v3Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
  v4PoolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
  v4PositionManager: '0x7C5f5A4bBd8fD63184577525326123B519429bDc',
  v4StateView: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
  v4Quoter: '0x0d5e0f971ed27fbff6c2837bf31316121532048d',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  universalRouter: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
}

function tokensFromContracts(c: ChainContracts, extras: Record<string, { symbol: string; decimals: number }> = {}) {
  const out: Record<string, { symbol: string; decimals: number }> = {
    [c.weth.toLowerCase()]: { symbol: 'WETH', decimals: 18 },
    ...extras,
  }
  return out
}

export const CHAIN_CONFIGS: Record<SupportedChainId, AppChainConfig> = {
  4663: {
    id: 4663,
    key: 'robinhood',
    label: 'Robinhood Chain',
    shortLabel: 'Robinhood',
    chain: robinhood,
    defaultRpcUrls: [
      'https://rpc.mainnet.chain.robinhood.com',
      'https://robinhoodchain.blockscout.com/api/eth-rpc',
    ],
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    explorerApi: 'https://robinhoodchain.blockscout.com',
    contracts: ROBINHOOD_CONTRACTS,
    knownTokens: tokensFromContracts(ROBINHOOD_CONTRACTS, {
      [ROBINHOOD_CONTRACTS.stable.toLowerCase()]: { symbol: 'USDG', decimals: 6 },
      [ROBINHOOD_CONTRACTS.aapl!.toLowerCase()]: { symbol: 'AAPL', decimals: 18 },
      [ROBINHOOD_CONTRACTS.nvda!.toLowerCase()]: { symbol: 'NVDA', decimals: 18 },
      [ROBINHOOD_CONTRACTS.tsla!.toLowerCase()]: { symbol: 'TSLA', decimals: 18 },
      [ROBINHOOD_CONTRACTS.qqq!.toLowerCase()]: { symbol: 'QQQ', decimals: 18 },
    }),
    v3PoolInitCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
    defaultTokenA: ROBINHOOD_CONTRACTS.stable,
    defaultTokenB: ROBINHOOD_CONTRACTS.weth,
  },
  8453: {
    id: 8453,
    key: 'base',
    label: 'Base',
    shortLabel: 'Base',
    chain: base,
    defaultRpcUrls: [
      'https://mainnet.base.org',
      'https://base-rpc.publicnode.com',
      'https://base.drpc.org',
    ],
    explorerUrl: 'https://basescan.org',
    explorerApi: 'https://base.blockscout.com',
    contracts: BASE_CONTRACTS,
    knownTokens: tokensFromContracts(BASE_CONTRACTS, {
      [BASE_CONTRACTS.stable.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
    }),
    v3PoolInitCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
    defaultTokenA: BASE_CONTRACTS.stable,
    defaultTokenB: BASE_CONTRACTS.weth,
  },
}

export const SUPPORTED_CHAINS = Object.values(CHAIN_CONFIGS)

const CHAIN_KEY = 'rangedesk.activeChain.v1'

function readSavedChainId(): SupportedChainId {
  try {
    const raw = localStorage.getItem(CHAIN_KEY)
    const id = Number(raw)
    if (id === 4663 || id === 8453) return id
  } catch {
    /* ignore */
  }
  return 4663
}

let activeChainId: SupportedChainId =
  typeof localStorage !== 'undefined' ? readSavedChainId() : 4663

export function getActiveChainId(): SupportedChainId {
  return activeChainId
}

export function getActiveChainConfig(): AppChainConfig {
  return CHAIN_CONFIGS[activeChainId]
}

export function setActiveChainId(id: SupportedChainId): AppChainConfig {
  if (!CHAIN_CONFIGS[id]) throw new Error(`不支持的链: ${id}`)
  activeChainId = id
  try {
    localStorage.setItem(CHAIN_KEY, String(id))
  } catch {
    /* ignore */
  }
  return CHAIN_CONFIGS[id]
}

export function isSupportedChainId(id: number): id is SupportedChainId {
  return id === 4663 || id === 8453
}

/** 当前链合约（随 setActiveChainId 切换） */
export const CONTRACTS: ChainContracts = new Proxy({} as ChainContracts, {
  get(_t, prop: string | symbol) {
    if (typeof prop !== 'string') return undefined
    return CHAIN_CONFIGS[activeChainId].contracts[prop as keyof ChainContracts]
  },
})

export const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = new Proxy(
  {} as Record<string, { symbol: string; decimals: number }>,
  {
    get(_t, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined
      return CHAIN_CONFIGS[activeChainId].knownTokens[prop]
    },
    ownKeys() {
      return Reflect.ownKeys(CHAIN_CONFIGS[activeChainId].knownTokens)
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (typeof prop !== 'string') return undefined
      const v = CHAIN_CONFIGS[activeChainId].knownTokens[prop]
      if (v === undefined) return undefined
      return { configurable: true, enumerable: true, value: v }
    },
  },
)

export const FEE_TIERS = [100, 500, 3000, 10000] as const

/** V4 常用费率（百分之一 bp，100 = 0.01%）；也可在 UI 自填 */
export const V4_FEE_PRESETS = [100, 500, 2500, 3000, 5000, 7500, 10000, 20000] as const

/** 直接取当前 hash */
export function getV3PoolInitCodeHash(): `0x${string}` {
  return CHAIN_CONFIGS[activeChainId].v3PoolInitCodeHash
}

export function getExplorerApi(): string {
  return CHAIN_CONFIGS[activeChainId].explorerApi
}

export function getStableAddress(): Address {
  return CHAIN_CONFIGS[activeChainId].contracts.stable
}

export function listKnownTokens(): Array<{ address: Address; symbol: string; decimals: number }> {
  return Object.entries(CHAIN_CONFIGS[activeChainId].knownTokens).map(([address, t]) => ({
    address: address as Address,
    symbol: t.symbol,
    decimals: t.decimals,
  }))
}
