import { defineChain, type Address, type Chain } from 'viem'

export type SupportedChainId = 4663 | 8453 | 5042 | 56

export type ChainContracts = {
  /**
   * 包装原生币（WETH / WBNB）。Arc 无包装原生币，此处为 Uniswap 部署时的 UnsupportedProtocol 占位，
   * 且 `hasWrappedNative === false` 时不得当包装原生币用。
   */
  weth: Address
  /** 稳定币：Robinhood=USDG，Base/Arc/BSC=USDC */
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
  /** Quoter V1 或 QuoterV2 地址（BSC 为 QuoterV2） */
  v3Quoter: Address
  /** true = QuoterV2（struct 入参）；缺省 / false = Quoter V1 */
  v3QuoterIsV2?: boolean
  v4PoolManager: Address
  v4PositionManager: Address
  v4StateView: Address
  v4Quoter: Address
  permit2: Address
  universalRouter: Address
}

export type AppChainConfig = {
  id: SupportedChainId
  key: 'robinhood' | 'base' | 'arc' | 'bsc'
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
  /** 是否有可 wrap 的原生币（Arc 为 false：gas=USDC，无 WETH） */
  hasWrappedNative: boolean
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

/** Circle Arc 主网：原生 gas 为 USDC（18 位内部精度），无 WETH */
export const arc = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://5042.rpc.thirdweb.com'] },
  },
  blockExplorers: {
    default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' },
  },
})

export const bsc = defineChain({
  id: 56,
  name: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://bsc-dataseed.binance.org'] },
  },
  blockExplorers: {
    default: { name: 'BscScan', url: 'https://bscscan.com' },
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

/**
 * BSC Uniswap 官方部署：
 * V3 https://developers.uniswap.org/docs/protocols/v3/deployments/v3-bnb-deployments
 * V4 https://developers.uniswap.org/docs/protocols/v4/deployments
 */
const BSC_CONTRACTS: ChainContracts = {
  weth: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
  // Binance-Peg USDC（18 位）；流动性深，作默认稳定币
  stable: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  usdg: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  v3Factory: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',
  v3Npm: '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613',
  v3SwapRouter: '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2',
  v3Quoter: '0x78D78E420Da98ad378D7799bE8f4AF69033EB077', // QuoterV2
  v3QuoterIsV2: true,
  v4PoolManager: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',
  v4PositionManager: '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b',
  v4StateView: '0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4',
  v4Quoter: '0x9f75dd27d6664c475b90e105573e550ff69437b0',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  universalRouter: '0x1906c1d672b88cd1b9ac7593301ca990f94eae07',
}

/** Binance-Peg USDT（BSC 上常用） */
const BSC_USDT: Address = '0x55d398326f99059fF775485246999027B3197955'

/** Uniswap contracts @ https://github.com/Uniswap/contracts/blob/main/deployments/5042.md */
const ARC_CONTRACTS: ChainContracts = {
  // UnsupportedProtocol stub（非真 WETH）；池子用原生/ERC-20 USDC
  weth: '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f',
  stable: '0x3600000000000000000000000000000000000000',
  usdg: '0x3600000000000000000000000000000000000000',
  v3Factory: '0xf0db7b58379503491d857db50ac9ece64c653918',
  v3Npm: '0x39654a85a4c05127f5fd6ed22caec077a0fb1377',
  v3SwapRouter: '0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77',
  v3Quoter: '0x7dfd4f31be6814d2906bde155c3e1b146eac1468',
  v4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  v4PositionManager: '0x6049c9a0e26405c0985f9e3685c87d0ae917f82b',
  v4StateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  universalRouter: '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1',
}

/** Circle EURC（与 testnet 同址常见；若主网不同可在 TokenPicker 自定义） */
const ARC_EURC: Address = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'

function tokensFromContracts(
  c: ChainContracts,
  extras: Record<string, { symbol: string; decimals: number }> = {},
  opts?: { includeWeth?: boolean; wrappedSymbol?: string },
) {
  const out: Record<string, { symbol: string; decimals: number }> = { ...extras }
  if (opts?.includeWeth !== false) {
    out[c.weth.toLowerCase()] = { symbol: opts?.wrappedSymbol ?? 'WETH', decimals: 18 }
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
    hasWrappedNative: true,
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
    hasWrappedNative: true,
  },
  5042: {
    id: 5042,
    key: 'arc',
    label: 'Arc',
    shortLabel: 'Arc',
    chain: arc,
    // 主网公共 RPC 基本不可用；读取优先走钱包节点（见 wallet.makeReadTransport）。
    // 这里只作 wallet_addEthereumChain 的占位，建议在设置里填 Alchemy/QuickNode 等私有 RPC。
    defaultRpcUrls: [
      'https://rpc.mainnet.arc.io',
      'https://5042.rpc.thirdweb.com',
    ],
    explorerUrl: 'https://explorer.arc.io',
    explorerApi: 'https://explorer.arc.io',
    contracts: ARC_CONTRACTS,
    knownTokens: tokensFromContracts(
      ARC_CONTRACTS,
      {
        // ERC-20 接口 USDC（6 位）；原生 gas 也是 USDC
        [ARC_CONTRACTS.stable.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
        [ARC_EURC.toLowerCase()]: { symbol: 'EURC', decimals: 6 },
      },
      { includeWeth: false },
    ),
    v3PoolInitCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
    defaultTokenA: ARC_EURC,
    defaultTokenB: ARC_CONTRACTS.stable,
    hasWrappedNative: false,
  },
  56: {
    id: 56,
    key: 'bsc',
    label: 'BNB Smart Chain',
    shortLabel: 'BSC',
    chain: bsc,
    defaultRpcUrls: [
      'https://bsc-dataseed.binance.org',
      'https://bsc-dataseed.bnbchain.org',
      'https://bsc.publicnode.com',
      'https://bsc.drpc.org',
    ],
    explorerUrl: 'https://bscscan.com',
    explorerApi: 'https://bsc.blockscout.com',
    contracts: BSC_CONTRACTS,
    knownTokens: tokensFromContracts(
      BSC_CONTRACTS,
      {
        [BSC_CONTRACTS.stable.toLowerCase()]: { symbol: 'USDC', decimals: 18 },
        [BSC_USDT.toLowerCase()]: { symbol: 'USDT', decimals: 18 },
      },
      { wrappedSymbol: 'WBNB' },
    ),
    v3PoolInitCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
    defaultTokenA: BSC_CONTRACTS.stable,
    defaultTokenB: BSC_CONTRACTS.weth,
    hasWrappedNative: true,
  },
}

export const SUPPORTED_CHAINS = Object.values(CHAIN_CONFIGS)

const CHAIN_KEY = 'rangedesk.activeChain.v1'

function readSavedChainId(): SupportedChainId {
  try {
    const raw = localStorage.getItem(CHAIN_KEY)
    const id = Number(raw)
    if (id === 4663 || id === 8453 || id === 5042 || id === 56) return id
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
  return id === 4663 || id === 8453 || id === 5042 || id === 56
}

/** 当前链是否有可 wrap 的原生币（WETH / WBNB） */
export function chainHasWrappedNative(): boolean {
  return CHAIN_CONFIGS[activeChainId].hasWrappedNative
}

/** 原生 gas 币符号：ETH / BNB / USDC(Arc) */
export function getNativeSymbol(chainId: SupportedChainId = activeChainId): string {
  return CHAIN_CONFIGS[chainId].chain.nativeCurrency.symbol
}

/** 包装原生币符号：WETH / WBNB */
export function getWrappedNativeSymbol(chainId: SupportedChainId = activeChainId): string {
  if (!CHAIN_CONFIGS[chainId].hasWrappedNative) return getNativeSymbol(chainId)
  return CHAIN_CONFIGS[chainId].knownTokens[CHAIN_CONFIGS[chainId].contracts.weth.toLowerCase()]?.symbol
    ?? (chainId === 56 ? 'WBNB' : 'WETH')
}

/** 当前链 V3 Quoter 是否为 QuoterV2 */
export function chainUsesV3QuoterV2(chainId: SupportedChainId = activeChainId): boolean {
  return Boolean(CHAIN_CONFIGS[chainId].contracts.v3QuoterIsV2)
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
