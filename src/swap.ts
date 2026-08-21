/** 本池单跳 Swap：激活冷池 / 换边配平 */
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  maxUint48,
  maxUint160,
  zeroAddress,
  type Address,
  type Hash,
  type WalletClient,
} from 'viem'
import {
  erc20Abi,
  permit2Abi,
  universalRouterAbi,
  v3QuoterAbi,
  v3QuoterV2Abi,
  v3SwapRouterAbi,
  v4QuoterAbi,
} from './abis'
import { CONTRACTS, chainHasWrappedNative, chainUsesV3QuoterV2 } from './chain'
import type { PositionRow } from './lp'
import {
  isNativeCurrency,
  poolKeyFromPosition,
  type V4PoolKey,
} from './v4'
import { publicClient } from './wallet'

const UR_V4_SWAP = 0x10
const V4_SWAP_EXACT_IN_SINGLE = 0x06
const V4_SETTLE_ALL = 0x0c
const V4_TAKE_ALL = 0x0f

const poolKeyAbi = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
} as const

function clampUint128(n: bigint): bigint {
  const max = (1n << 128n) - 1n
  if (n < 0n) return 0n
  return n > max ? max : n
}

function applySlippageMin(amountOut: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(9_900, slippageBps)))
  return (amountOut * (10_000n - bps)) / 10_000n
}

/** 用现价粗估 amountOut（Quoter 失败时的兜底） */
function estimateOutMid(
  amountIn: bigint,
  sqrtPriceX96: bigint,
  zeroForOne: boolean,
  feePips: number,
): bigint {
  if (amountIn <= 0n || sqrtPriceX96 <= 0n) return 0n
  const Q96 = 1n << 96n
  const Q192 = Q96 * Q96
  const raw = zeroForOne
    ? (amountIn * sqrtPriceX96 * sqrtPriceX96) / Q192
    : (amountIn * Q192) / (sqrtPriceX96 * sqrtPriceX96)
  const afterFee = (raw * BigInt(1_000_000 - Math.min(feePips, 999_999))) / 1_000_000n
  // 再打 0.5% 安全折，避免兜底报价过乐观
  return (afterFee * 995n) / 1000n
}

export type PoolSwapQuote = {
  amountIn: bigint
  amountOut: bigint
  amountOutMin: bigint
  zeroForOne: boolean
  tokenIn: Address
  tokenOut: Address
  tokenInSymbol: string
  tokenOutSymbol: string
  tokenInDecimals: number
  tokenOutDecimals: number
  quoted: boolean
}

function resolveSwapSides(position: PositionRow, zeroForOne: boolean) {
  const tokenIn = zeroForOne ? position.token0.address : position.token1.address
  const tokenOut = zeroForOne ? position.token1.address : position.token0.address
  return {
    tokenIn,
    tokenOut,
    tokenInSymbol: zeroForOne ? position.token0.symbol : position.token1.symbol,
    tokenOutSymbol: zeroForOne ? position.token1.symbol : position.token0.symbol,
    tokenInDecimals: zeroForOne ? position.token0.decimals : position.token1.decimals,
    tokenOutDecimals: zeroForOne ? position.token1.decimals : position.token0.decimals,
  }
}

async function quoteV3ExactIn(opts: {
  tokenIn: Address
  tokenOut: Address
  fee: number
  amountIn: bigint
}): Promise<bigint | null> {
  try {
    if (chainUsesV3QuoterV2()) {
      const { result } = await publicClient.simulateContract({
        address: CONTRACTS.v3Quoter,
        abi: v3QuoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [{
          tokenIn: opts.tokenIn,
          tokenOut: opts.tokenOut,
          amountIn: opts.amountIn,
          fee: opts.fee,
          sqrtPriceLimitX96: 0n,
        }],
      })
      return result[0]
    }
    const { result } = await publicClient.simulateContract({
      address: CONTRACTS.v3Quoter,
      abi: v3QuoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [opts.tokenIn, opts.tokenOut, opts.fee, opts.amountIn, 0n],
    })
    return result as bigint
  } catch {
    return null
  }
}

async function quoteV4ExactIn(opts: {
  key: V4PoolKey
  zeroForOne: boolean
  amountIn: bigint
}): Promise<bigint | null> {
  try {
    const { result } = await publicClient.simulateContract({
      address: CONTRACTS.v4Quoter,
      abi: v4QuoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [{
        poolKey: opts.key,
        zeroForOne: opts.zeroForOne,
        exactAmount: clampUint128(opts.amountIn),
        hookData: '0x',
      }],
    })
    return result[0]
  } catch {
    return null
  }
}

export async function quotePoolSwap(opts: {
  position: PositionRow
  /** true = token0 → token1 */
  zeroForOne: boolean
  amountIn: bigint
  slippageBps?: number
}): Promise<PoolSwapQuote> {
  const { position, zeroForOne } = opts
  const amountIn = opts.amountIn
  const slippageBps = opts.slippageBps ?? 300
  if (amountIn <= 0n) throw new Error('请输入兑换数量')
  if (position.version === 'v3' && position.dex && position.dex !== 'uniswap' && position.dex !== 'unknown') {
    throw new Error(
      `${position.dexLabel ?? position.dex} 池暂不支持本工具内 Swap（Router 未接入），请用站外兑换或 Uniswap 池`,
    )
  }

  const sides = resolveSwapSides(position, zeroForOne)
  let amountOut: bigint | null = null
  let quoted = false

  if (position.version === 'v4') {
    const key = poolKeyFromPosition(position)
    // 校验方向与 PoolKey 一致（token0/1 应已排序）
    const zfo =
      sides.tokenIn.toLowerCase() === key.currency0.toLowerCase()
    amountOut = await quoteV4ExactIn({ key, zeroForOne: zfo, amountIn })
  } else {
    // V3：原生币侧用 WETH 地址报价
    let tokenIn = sides.tokenIn
    let tokenOut = sides.tokenOut
    if (isNativeCurrency(tokenIn)) tokenIn = CONTRACTS.weth
    if (isNativeCurrency(tokenOut)) tokenOut = CONTRACTS.weth
    amountOut = await quoteV3ExactIn({
      tokenIn,
      tokenOut,
      fee: position.fee,
      amountIn,
    })
  }

  if (amountOut != null && amountOut > 0n) {
    quoted = true
  } else {
    if (
      position.version === 'v4'
      && position.hooks
      && position.hooks.toLowerCase() !== zeroAddress.toLowerCase()
    ) {
      throw new Error('自定义 Hook 池报价失败：为避免漏算买卖税，已拒绝使用不含 Hook 的现价估算')
    }
    amountOut = estimateOutMid(amountIn, position.sqrtPriceX96, zeroForOne, position.fee)
    if (amountOut <= 0n) throw new Error('报价失败：池价或流动性异常')
  }

  return {
    amountIn,
    amountOut,
    amountOutMin: applySlippageMin(amountOut, slippageBps),
    zeroForOne,
    ...sides,
    quoted,
  }
}

async function ensureErc20Allowance(
  walletClient: WalletClient,
  token: Address,
  owner: Address,
  spender: Address,
  amount: bigint,
  onStatus?: (msg: string) => void,
) {
  if (isNativeCurrency(token) || amount <= 0n) return
  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  })
  if (allowance >= amount) return
  onStatus?.('需要授权代币，请在钱包确认…')
  const hash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, (1n << 256n) - 1n],
    gas: 100_000n,
    chain: walletClient.chain,
    account: owner,
  })
  onStatus?.(`授权已提交 ${hash.slice(0, 10)}…`)
  // 软等，避免 Arc 卡死
  const start = Date.now()
  while (Date.now() - start < 20_000) {
    try {
      const a = await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [owner, spender],
      })
      if (a >= amount) return
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 600))
  }
}

async function ensurePermit2ForRouter(
  walletClient: WalletClient,
  token: Address,
  owner: Address,
  amount: bigint,
  onStatus?: (msg: string) => void,
) {
  if (isNativeCurrency(token) || amount <= 0n) return
  await ensureErc20Allowance(walletClient, token, owner, CONTRACTS.permit2, amount, onStatus)

  const now = Math.floor(Date.now() / 1000)
  const existing = await publicClient.readContract({
    address: CONTRACTS.permit2,
    abi: permit2Abi,
    functionName: 'allowance',
    args: [owner, token, CONTRACTS.universalRouter],
  })
  const [allowed, expiration] = existing as readonly [bigint, number, number]
  if (allowed >= amount && Number(expiration) > now + 60) return

  onStatus?.('需要 Permit2 授权 Universal Router，请在钱包确认…')
  const hash = await walletClient.writeContract({
    address: CONTRACTS.permit2,
    abi: permit2Abi,
    functionName: 'approve',
    args: [token, CONTRACTS.universalRouter, maxUint160, Number(maxUint48)],
    gas: 120_000n,
    chain: walletClient.chain,
    account: owner,
  })
  onStatus?.(`Permit2 已提交 ${hash.slice(0, 10)}…`)
  const start = Date.now()
  while (Date.now() - start < 20_000) {
    try {
      const cur = await publicClient.readContract({
        address: CONTRACTS.permit2,
        abi: permit2Abi,
        functionName: 'allowance',
        args: [owner, token, CONTRACTS.universalRouter],
      })
      const [amt, exp] = cur as readonly [bigint, number, number]
      if (amt >= amount && Number(exp) > Math.floor(Date.now() / 1000) + 30) return
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 600))
  }
}

function encodeV4ExactInSingle(opts: {
  key: V4PoolKey
  zeroForOne: boolean
  amountIn: bigint
  amountOutMin: bigint
}): `0x${string}` {
  const { key, zeroForOne, amountIn, amountOutMin } = opts
  const tokenIn = zeroForOne ? key.currency0 : key.currency1
  const tokenOut = zeroForOne ? key.currency1 : key.currency0
  const actions = encodePacked(
    ['uint8', 'uint8', 'uint8'],
    [V4_SWAP_EXACT_IN_SINGLE, V4_SETTLE_ALL, V4_TAKE_ALL],
  )
  const params: `0x${string}`[] = [
    encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            // 必须带 name：对象入参靠 component.name 取字段，缺 name 会读到 undefined.currency0
            { name: 'poolKey', ...poolKeyAbi },
            { name: 'zeroForOne', type: 'bool' },
            { name: 'amountIn', type: 'uint128' },
            { name: 'amountOutMinimum', type: 'uint128' },
            { name: 'hookData', type: 'bytes' },
          ],
        },
      ],
      [{
        poolKey: key,
        zeroForOne,
        amountIn: clampUint128(amountIn),
        amountOutMinimum: clampUint128(amountOutMin),
        hookData: '0x',
      }],
    ),
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint128' }],
      [tokenIn, clampUint128(amountIn)],
    ),
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint128' }],
      [tokenOut, clampUint128(amountOutMin)],
    ),
  ]
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, params],
  )
}

async function swapV4(opts: {
  walletClient: WalletClient
  owner: Address
  position: PositionRow
  zeroForOne: boolean
  amountIn: bigint
  amountOutMin: bigint
  onStatus?: (msg: string) => void
}): Promise<Hash> {
  const { walletClient, owner, position, amountIn, amountOutMin, onStatus } = opts
  const key = poolKeyFromPosition(position)
  const sides = resolveSwapSides(position, opts.zeroForOne)
  const zfo = sides.tokenIn.toLowerCase() === key.currency0.toLowerCase()
  const tokenIn = zfo ? key.currency0 : key.currency1
  const nativeIn = isNativeCurrency(tokenIn)

  if (!nativeIn) {
    await ensurePermit2ForRouter(walletClient, tokenIn, owner, amountIn, onStatus)
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
  const v4Input = encodeV4ExactInSingle({
    key,
    zeroForOne: zfo,
    amountIn,
    amountOutMin,
  })
  const commands = encodePacked(['uint8'], [UR_V4_SWAP])

  onStatus?.('请在钱包确认本池 Swap…')
  return walletClient.writeContract({
    address: CONTRACTS.universalRouter,
    abi: universalRouterAbi,
    functionName: 'execute',
    args: [commands, [v4Input], deadline],
    value: nativeIn ? amountIn : undefined,
    gas: 800_000n,
    chain: walletClient.chain,
    account: owner,
  })
}

async function swapV3(opts: {
  walletClient: WalletClient
  owner: Address
  position: PositionRow
  zeroForOne: boolean
  amountIn: bigint
  amountOutMin: bigint
  useNativeEth?: boolean
  onStatus?: (msg: string) => void
}): Promise<Hash> {
  const { walletClient, owner, position, amountIn, amountOutMin, onStatus } = opts
  const sides = resolveSwapSides(position, opts.zeroForOne)
  let tokenIn = sides.tokenIn
  let tokenOut = sides.tokenOut
  const useNative = Boolean(opts.useNativeEth) && chainHasWrappedNative()

  const inIsEthLike =
    isNativeCurrency(tokenIn) ||
    (chainHasWrappedNative() && tokenIn.toLowerCase() === CONTRACTS.weth.toLowerCase())
  const outIsEthLike =
    isNativeCurrency(tokenOut) ||
    (chainHasWrappedNative() && tokenOut.toLowerCase() === CONTRACTS.weth.toLowerCase())

  // Router 始终用 WETH 地址
  if (isNativeCurrency(tokenIn) || (useNative && inIsEthLike)) tokenIn = CONTRACTS.weth
  if (isNativeCurrency(tokenOut) || (useNative && outIsEthLike)) tokenOut = CONTRACTS.weth

  const payNative = useNative && inIsEthLike
  const unwrapOut = useNative && outIsEthLike

  if (!payNative) {
    await ensureErc20Allowance(
      walletClient,
      tokenIn,
      owner,
      CONTRACTS.v3SwapRouter,
      amountIn,
      onStatus,
    )
  }

  const swapData = encodeFunctionData({
    abi: v3SwapRouterAbi,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn,
      tokenOut,
      fee: position.fee,
      recipient: unwrapOut ? CONTRACTS.v3SwapRouter : owner,
      amountIn,
      amountOutMinimum: amountOutMin,
      sqrtPriceLimitX96: 0n,
    }],
  })

  onStatus?.('请在钱包确认本池 Swap…')
  if (unwrapOut) {
    const unwrapData = encodeFunctionData({
      abi: v3SwapRouterAbi,
      functionName: 'unwrapWETH9',
      args: [amountOutMin, owner],
    })
    const refundData = encodeFunctionData({
      abi: v3SwapRouterAbi,
      functionName: 'refundETH',
    })
    return walletClient.writeContract({
      address: CONTRACTS.v3SwapRouter,
      abi: v3SwapRouterAbi,
      functionName: 'multicall',
      args: [[swapData, unwrapData, refundData]],
      value: payNative ? amountIn : undefined,
      gas: 500_000n,
      chain: walletClient.chain,
      account: owner,
    })
  }

  return walletClient.writeContract({
    address: CONTRACTS.v3SwapRouter,
    abi: v3SwapRouterAbi,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn,
      tokenOut,
      fee: position.fee,
      recipient: owner,
      amountIn,
      amountOutMinimum: amountOutMin,
      sqrtPriceLimitX96: 0n,
    }],
    value: payNative ? amountIn : undefined,
    gas: 400_000n,
    chain: walletClient.chain,
    account: owner,
  })
}

/** 在仓位所属池内单跳 exact-in swap */
export async function swapInPool(opts: {
  walletClient: WalletClient
  owner: Address
  position: PositionRow
  zeroForOne: boolean
  amountIn: bigint
  slippageBps?: number
  useNativeEth?: boolean
  onStatus?: (msg: string) => void
}): Promise<Hash> {
  const quote = await quotePoolSwap({
    position: opts.position,
    zeroForOne: opts.zeroForOne,
    amountIn: opts.amountIn,
    slippageBps: opts.slippageBps,
  })
  opts.onStatus?.(
    quote.quoted ? '报价完成，准备交易…' : '现价估算报价，准备交易…',
  )

  if (opts.position.version === 'v4') {
    return swapV4({
      walletClient: opts.walletClient,
      owner: opts.owner,
      position: opts.position,
      zeroForOne: opts.zeroForOne,
      amountIn: quote.amountIn,
      amountOutMin: quote.amountOutMin,
      onStatus: opts.onStatus,
    })
  }
  return swapV3({
    walletClient: opts.walletClient,
    owner: opts.owner,
    position: opts.position,
    zeroForOne: opts.zeroForOne,
    amountIn: quote.amountIn,
    amountOutMin: quote.amountOutMin,
    useNativeEth: opts.useNativeEth,
    onStatus: opts.onStatus,
  })
}

/** 方便 UI：零地址占位 */
export const NATIVE_PLACEHOLDER = zeroAddress
