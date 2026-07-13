import { defineChain } from 'viem'

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

export const CONTRACTS = {
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as const,
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const,
  aapl: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' as const,
  nvda: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as const,
  tsla: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d' as const,
  qqq: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68' as const,
  // Uniswap V3
  v3Factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' as const,
  v3Npm: '0x73991a25c818bf1f1128deaab1492d45638de0d3' as const,
  v3SwapRouter: '0xcaf681a66d020601342297493863e78c959e5cb2' as const,
  v3Quoter: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7' as const,
  // Uniswap V4
  v4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951' as const,
  v4PositionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7' as const,
  v4StateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' as const,
  v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as const,
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const,
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904' as const,
}

export const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [CONTRACTS.weth.toLowerCase()]: { symbol: 'WETH', decimals: 18 },
  [CONTRACTS.usdg.toLowerCase()]: { symbol: 'USDG', decimals: 6 },
  [CONTRACTS.aapl.toLowerCase()]: { symbol: 'AAPL', decimals: 18 },
  [CONTRACTS.nvda.toLowerCase()]: { symbol: 'NVDA', decimals: 18 },
  [CONTRACTS.tsla.toLowerCase()]: { symbol: 'TSLA', decimals: 18 },
  [CONTRACTS.qqq.toLowerCase()]: { symbol: 'QQQ', decimals: 18 },
}

export const FEE_TIERS = [100, 500, 3000, 10000] as const
