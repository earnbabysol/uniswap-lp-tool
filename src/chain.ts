import { defineChain, type Address, type Chain } from 'viem'
import { mainnet, xLayer } from 'viem/chains'

export type SupportedChainId = 1 | 196 | 4663 | 8453 | 5042 | 56

/** 同链上额外的 Uniswap-V3 兼容 DEX（如 BSC Pancake） */
export type V3DexFactory = {
  key: string
  label: string
  factory: Address
  /** 仓位 NFT 管理器；缺省则仅用于搜池，不扫仓位 */
  npm?: Address
}

export type ChainContracts = {
  /**
   * 包装原生币（WETH / WBNB）。Arc 无包装原生币，此处为 Uniswap 部署时的 UnsupportedProtocol 占位，
   * 且 `hasWrappedNative === false` 时不得当包装原生币用。
   */
  weth: Address
  /** 稳定币：Robinhood=USDG，其它链多为 USDC */
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
  key: 'ethereum' | 'xlayer' | 'robinhood' | 'base' | 'arc' | 'bsc'
  label: string
  shortLabel: string
  chain: Chain
  defaultRpcUrls: string[]
  explorerUrl: string
  /** Blockscout / explorer API 根（日志、NFT 扫描） */
  explorerApi: string
  /**
   * 是否可用 Blockscout 风格 `/api/v2/...` NFT 索引。
   * BSC 的 bsc.blockscout.com 常 404，开启会白白多等几秒再落入慢路径。
   * 缺省 true；显式 false 则跳过 explorer NFT 列表。
   */
  supportsBlockscoutNftApi?: boolean
  contracts: ChainContracts
  knownTokens: Record<string, { symbol: string; decimals: number }>
  v3PoolInitCodeHash: `0x${string}`
  /** 开仓页默认交易对 */
  defaultTokenA: Address
  defaultTokenB: Address
  /** 是否有可 wrap 的原生币（Arc 为 false：gas=USDC，无 WETH） */
  hasWrappedNative: boolean
  /** 额外按 $1 计价的稳定币（如 BSC/ETH 的 USDT）；默认含 contracts.stable */
  usdStables?: Address[]
  /** BSC 等：额外扫 Pancake 等 V3 工厂 */
  altV3Factories?: V3DexFactory[]
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

export const ethereum = mainnet
export const xlayer = xLayer

/**
 * Ethereum 主网 Uniswap 官方部署：
 * V3 https://docs.uniswap.org/contracts/v3/reference/deployments/ethereum-deployments
 * V4 https://developers.uniswap.org/docs/protocols/v4/deployments
 */
const ETHEREUM_CONTRACTS: ChainContracts = {
  weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  stable: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  usdg: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  v3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  v3Npm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  v3SwapRouter: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', // SwapRouter02
  v3Quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', // QuoterV2
  v3QuoterIsV2: true,
  v4PoolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
  v4PositionManager: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
  v4StateView: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
  v4Quoter: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  universalRouter: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af',
}

const ETHEREUM_USDT: Address = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

/**
 * X Layer 主网 Uniswap 官方部署：
 * V3 https://developers.uniswap.org/docs/protocols/v3/deployments/v3-xlayer-deployments
 * V4 https://developers.uniswap.org/docs/protocols/v4/deployments
 */
const XLAYER_CONTRACTS: ChainContracts = {
  weth: '0xe538905cf8410324e03A5A23C1c177a474D59b2b', // WOKB
  stable: '0x74b7F16337b8972027F6196A17a631aC6dE26d22', // USDC
  usdg: '0x74b7F16337b8972027F6196A17a631aC6dE26d22',
  v3Factory: '0x4B2ab38DBF28D31D467aA8993f6c2585981D6804',
  v3Npm: '0x315e413A11AB0df498eF83873012430ca36638Ae',
  v3SwapRouter: '0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca', // SwapRouter02
  v3Quoter: '0xd1b797d92d87b688193a2b976efc8d577d204343', // QuoterV2
  v3QuoterIsV2: true,
  v4PoolManager: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
  v4PositionManager: '0xcf1eafc6928dc385a342e7c6491d371d2871458b',
  v4StateView: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990',
  v4Quoter: '0x8928074ca1b241d8ec02815881c1af11e8bc5219',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  // V4 文档 Universal Router 2.1.1（支持 V4_SWAP）
  universalRouter: '0x8b844f885672f333bc0042cb669255f93a4c1e6b',
}

/** OKX 官方 tokenlist：USD₮0 */
const XLAYER_USDT0: Address = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736'

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
  v3Quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  v3QuoterIsV2: true,
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
  // Uniswap contracts/deployments/56.md，2025-11-20 更新的 Universal Router
  universalRouter: '0x91bf3bfaef8d771a74e1a8fe460b3ee646b2e588',
}

/** Binance-Peg USDT（BSC 上常用） */
const BSC_USDT: Address = '0x55d398326f99059fF775485246999027B3197955'
/** PancakeSwap V3（BSC 主流 LP 所在） */
const PANCAKE_V3_FACTORY: Address = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'
const PANCAKE_V3_NPM: Address = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364'

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
  1: {
    id: 1,
    key: 'ethereum',
    label: 'Ethereum',
    shortLabel: 'ETH',
    chain: ethereum,
    defaultRpcUrls: [
      'https://ethereum.publicnode.com',
      'https://rpc.ankr.com/eth',
      'https://eth.drpc.org',
      'https://cloudflare-eth.com',
    ],
    explorerUrl: 'https://etherscan.io',
    explorerApi: 'https://eth.blockscout.com',
    contracts: ETHEREUM_CONTRACTS,
    knownTokens: tokensFromContracts(ETHEREUM_CONTRACTS, {
      [ETHEREUM_CONTRACTS.stable.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
      [ETHEREUM_USDT.toLowerCase()]: { symbol: 'USDT', decimals: 6 },
    }),
    v3PoolInitCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
    defaultTokenA: ETHEREUM_CONTRACTS.stable,
    defaultTokenB: ETHEREUM_CONTRACTS.weth,
    hasWrappedNative: true,
    usdStables: [ETHEREUM_USDT],
  },
  196: {
    id: 196,
    key: 'xlayer',
    label: 'X Layer',
    shortLabel: 'X Layer',
    chain: xlayer,
    defaultRpcUrls: [
      'https://xlayerrpc.okx.com',
      'https://rpc.xlayer.tech',
      'https://xlayer.drpc.org',
    ],
    explorerUrl: 'https://www.oklink.com/xlayer',
    explorerApi: 'https://www.oklink.com/api/v5/explorer/xlayer/api',
    supportsBlockscoutNftApi: false,
    contracts: XLAYER_CONTRACTS,
    knownTokens: tokensFromContracts(
      XLAYER_CONTRACTS,
      {
        [XLAYER_CONTRACTS.stable.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
        [XLAYER_USDT0.toLowerCase()]: { symbol: 'USDT0', decimals: 6 },
      },
      { wrappedSymbol: 'WOKB' },
    ),
    v3PoolInitCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
    defaultTokenA: XLAYER_CONTRACTS.stable,
    defaultTokenB: XLAYER_CONTRACTS.weth,
    hasWrappedNative: true,
    usdStables: [XLAYER_USDT0],
  },
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
    // 官方 dataseed 优先；publicnode/drpc 易慢或 429，仅作垫底
    defaultRpcUrls: [
      'https://bsc-dataseed.binance.org',
      'https://bsc-dataseed1.bnbchain.org',
      'https://bsc-dataseed2.bnbchain.org',
      'https://bsc-dataseed3.defibit.io',
      'https://bsc.publicnode.com',
    ],
    explorerUrl: 'https://bscscan.com',
    explorerApi: 'https://bsc.blockscout.com',
    supportsBlockscoutNftApi: false,
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
    usdStables: [BSC_USDT],
    altV3Factories: [
      {
        key: 'pancake',
        label: 'PancakeSwap',
        factory: PANCAKE_V3_FACTORY,
        npm: PANCAKE_V3_NPM,
      },
    ],
  },
}

export const SUPPORTED_CHAINS = Object.values(CHAIN_CONFIGS)

const CHAIN_KEY = 'rangedesk.activeChain.v1'

function readSavedChainId(): SupportedChainId {
  try {
    const raw = localStorage.getItem(CHAIN_KEY)
    const id = Number(raw)
    if (id === 1 || id === 196 || id === 4663 || id === 8453 || id === 5042 || id === 56) return id
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
  return id === 1 || id === 196 || id === 4663 || id === 8453 || id === 5042 || id === 56
}

/** 当前链是否有可 wrap 的原生币（WETH / WBNB） */
export function chainHasWrappedNative(): boolean {
  return CHAIN_CONFIGS[activeChainId].hasWrappedNative
}

/** 原生 gas 币符号：ETH / BNB / USDC(Arc) */
export function getNativeSymbol(chainId: SupportedChainId = activeChainId): string {
  return CHAIN_CONFIGS[chainId].chain.nativeCurrency.symbol
}

/** 包装原生币符号：WETH / WBNB / WOKB */
export function getWrappedNativeSymbol(chainId: SupportedChainId = activeChainId): string {
  if (!CHAIN_CONFIGS[chainId].hasWrappedNative) return getNativeSymbol(chainId)
  return CHAIN_CONFIGS[chainId].knownTokens[CHAIN_CONFIGS[chainId].contracts.weth.toLowerCase()]?.symbol
    ?? (chainId === 56 ? 'WBNB' : chainId === 196 ? 'WOKB' : 'WETH')
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

/** 当前链是否可走 Blockscout `/api/v2` NFT 索引 */
export function chainSupportsBlockscoutNftApi(chainId: SupportedChainId = activeChainId): boolean {
  return CHAIN_CONFIGS[chainId].supportsBlockscoutNftApi !== false
}

/** 当前链要扫的全部 V3 工厂：主 Uniswap + 备用 DEX */
export function getV3DexFactories(): Array<V3DexFactory & { isPrimary: boolean }> {
  const cfg = CHAIN_CONFIGS[activeChainId]
  const primary: V3DexFactory & { isPrimary: boolean } = {
    key: 'uniswap',
    label: 'Uniswap',
    factory: cfg.contracts.v3Factory,
    npm: cfg.contracts.v3Npm,
    isPrimary: true,
  }
  const alts = (cfg.altV3Factories ?? []).map((d) => ({ ...d, isPrimary: false }))
  return [primary, ...alts]
}

export function labelV3Factory(factory: Address): string {
  const f = factory.toLowerCase()
  for (const d of getV3DexFactories()) {
    if (d.factory.toLowerCase() === f) return d.label
  }
  return 'V3'
}

export function getStableAddress(): Address {
  return CHAIN_CONFIGS[activeChainId].contracts.stable
}

/** 当前链按 1 USD 计价的稳定币列表（含主稳定币） */
export function getUsdStableAddresses(): Address[] {
  const cfg = CHAIN_CONFIGS[activeChainId]
  const list = [cfg.contracts.stable, ...(cfg.usdStables ?? [])]
  const seen = new Set<string>()
  const out: Address[] = []
  for (const a of list) {
    const k = a.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(a)
  }
  return out
}

export function isUsdStable(token: Address): boolean {
  const addr = token.toLowerCase()
  return getUsdStableAddresses().some((s) => s.toLowerCase() === addr)
}

export function listKnownTokens(): Array<{ address: Address; symbol: string; decimals: number }> {
  return Object.entries(CHAIN_CONFIGS[activeChainId].knownTokens).map(([address, t]) => ({
    address: address as Address,
    symbol: t.symbol,
    decimals: t.decimals,
  }))
}
