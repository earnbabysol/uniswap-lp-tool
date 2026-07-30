/** Uniswap V4 PositionManager write helpers (modifyLiquidities + Permit2). */
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  maxUint160,
  maxUint48,
  zeroAddress,
  type Address,
  type WalletClient,
} from 'viem'
import { CONTRACTS, chainHasWrappedNative } from './chain'
import { erc20Abi, permit2Abi, v4PositionManagerAbi } from './abis'
import {
  getAmount0ForLiquidity,
  getAmount1ForLiquidity,
  getAmountsForPosition,
  getLiquidityForAmounts,
  nearestUsableTick,
  pairAmountForRange,
  priceToClosestTick,
  priceToSqrtPriceX96,
  rangeFromPercent,
  tickToSqrtRatioX96,
} from './math'
import type { PoolInfo, PositionRow } from './lp'
import { publicClient } from './wallet'

export const NATIVE_ETH = zeroAddress

export const V4_ACTIONS = {
  INCREASE_LIQUIDITY: 0x00,
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  SETTLE_PAIR: 0x0d,
  TAKE_PAIR: 0x11,
  SWEEP: 0x14,
} as const

const FEE_SPACINGS: Record<number, number[]> = {
  100: [1],
  500: [10],
  3000: [60],
  10000: [200],
}

/** 按费率建议 tickSpacing；自定义费率时按档位近似 */
export function suggestV4TickSpacing(fee: number): number {
  if (fee <= 100) return 1
  if (fee <= 500) return 10
  if (fee <= 3000) return 60
  if (fee <= 10000) return 200
  return 200
}

export function v4SpacingsForFee(fee: number): number[] {
  return FEE_SPACINGS[fee] ?? [suggestV4TickSpacing(fee), 1, 10, 60, 200].filter(
    (v, i, a) => a.indexOf(v) === i,
  )
}

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

export type V4PoolKey = {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

export function isNativeCurrency(addr: Address) {
  return addr.toLowerCase() === NATIVE_ETH.toLowerCase()
}

export function isEthLikeCurrency(addr: Address) {
  if (isNativeCurrency(addr)) return true
  if (!chainHasWrappedNative()) return false
  return addr.toLowerCase() === CONTRACTS.weth.toLowerCase()
}

export function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]
}

export function poolKeyFromPool(pool: PoolInfo): V4PoolKey {
  if (pool.version !== 'v4') throw new Error('需要 V4 池')
  const [currency0, currency1] = sortCurrencies(pool.token0.address, pool.token1.address)
  return {
    currency0,
    currency1,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hooks ?? NATIVE_ETH,
  }
}

export function poolKeyFromPosition(position: PositionRow): V4PoolKey {
  if (position.version !== 'v4') throw new Error('需要 V4 仓位')
  const [currency0, currency1] = sortCurrencies(position.token0.address, position.token1.address)
  return {
    currency0,
    currency1,
    fee: position.fee,
    tickSpacing: position.tickSpacing,
    hooks: position.hooks ?? NATIVE_ETH,
  }
}

function encodeActions(actions: number[]): `0x${string}` {
  return encodePacked(
    actions.map(() => 'uint8' as const),
    actions.map((a) => a),
  )
}

function encodeUnlockData(actions: number[], params: `0x${string}`[]): `0x${string}` {
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [encodeActions(actions), params],
  )
}

function encodeMintParams(
  key: V4PoolKey,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
  amount0Max: bigint,
  amount1Max: bigint,
  recipient: Address,
): `0x${string}` {
  return encodeAbiParameters(
    [
      poolKeyAbi,
      { type: 'int24' },
      { type: 'int24' },
      { type: 'uint256' },
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'address' },
      { type: 'bytes' },
    ],
    [key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, recipient, '0x'],
  )
}

function encodeModifyLiqParams(
  tokenId: bigint,
  liquidity: bigint,
  amount0Limit: bigint,
  amount1Limit: bigint,
): `0x${string}` {
  return encodeAbiParameters(
    [
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'bytes' },
    ],
    [tokenId, liquidity, amount0Limit, amount1Limit, '0x'],
  )
}

function encodeBurnParams(tokenId: bigint, amount0Min: bigint, amount1Min: bigint): `0x${string}` {
  return encodeAbiParameters(
    [
      { type: 'uint256' },
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'bytes' },
    ],
    [tokenId, amount0Min, amount1Min, '0x'],
  )
}

function encodeSettlePair(c0: Address, c1: Address): `0x${string}` {
  return encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [c0, c1])
}

function encodeTakePair(c0: Address, c1: Address, recipient: Address): `0x${string}` {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    [c0, c1, recipient],
  )
}

function encodeSweep(currency: Address, to: Address): `0x${string}` {
  return encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [currency, to])
}

function clampUint128(n: bigint): bigint {
  const max = (1n << 128n) - 1n
  if (n < 0n) return 0n
  return n > max ? max : n
}

/** 按 UI 滑点抬高上限；默认至少 3%，避免 1% 硬编码在价动时 MaximumAmountExceeded */
function bumpAmountMax(amount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(300, Math.min(Math.floor(slippageBps) || 300, 5_000)))
  return clampUint128(amount + (amount * bps) / 10_000n + 1n)
}

/**
 * Mint/加仓的 amount0Max/amount1Max：
 * 用该 liquidity 在区间内「最坏情况」所需量 + 滑点，避免：
 * 1) 硬编码 1% 缓冲太紧
 * 2) 单边时另一侧 max=1，等签名期间价格走进区间直接 MaximumAmountExceeded
 */
function maxAmountsForLiquidity(opts: {
  sqrtPriceX96: bigint
  tickLower: number
  tickUpper: number
  liquidity: bigint
  slippageBps: number
}): { amount0: bigint; amount1: bigint; amount0Max: bigint; amount1Max: bigint } {
  const { sqrtPriceX96, tickLower, tickUpper, liquidity, slippageBps } = opts
  const needed = getAmountsForPosition(sqrtPriceX96, tickLower, tickUpper, liquidity)
  const sqrtA = tickToSqrtRatioX96(tickLower)
  const sqrtB = tickToSqrtRatioX96(tickUpper)
  const worst0 = getAmount0ForLiquidity(sqrtA, sqrtB, liquidity)
  const worst1 = getAmount1ForLiquidity(sqrtA, sqrtB, liquidity)
  return {
    amount0: needed.amount0,
    amount1: needed.amount1,
    amount0Max: bumpAmountMax(worst0 > 0n ? worst0 : needed.amount0, slippageBps),
    amount1Max: bumpAmountMax(worst1 > 0n ? worst1 : needed.amount1, slippageBps),
  }
}

async function ensurePermit2(
  walletClient: WalletClient,
  token: Address,
  owner: Address,
  amount: bigint,
) {
  if (isNativeCurrency(token) || amount <= 0n) return

  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, CONTRACTS.permit2],
  })
  if (allowance < amount) {
    const hash = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [CONTRACTS.permit2, (1n << 256n) - 1n],
      chain: walletClient.chain,
      account: owner,
    })
    await publicClient.waitForTransactionReceipt({ hash })
  }

  const now = Math.floor(Date.now() / 1000)
  const existing = await publicClient.readContract({
    address: CONTRACTS.permit2,
    abi: permit2Abi,
    functionName: 'allowance',
    args: [owner, token, CONTRACTS.v4PositionManager],
  })
  const [allowedAmount, expiration] = existing as readonly [bigint, number, number]
  if (allowedAmount >= amount && Number(expiration) > now + 60) return

  const hash2 = await walletClient.writeContract({
    address: CONTRACTS.permit2,
    abi: permit2Abi,
    functionName: 'approve',
    args: [token, CONTRACTS.v4PositionManager, maxUint160, Number(maxUint48)],
    chain: walletClient.chain,
    account: owner,
  })
  await publicClient.waitForTransactionReceipt({ hash: hash2 })
}

async function writeModifyLiquidities(opts: {
  walletClient: WalletClient
  owner: Address
  unlockData: `0x${string}`
  value?: bigint
  action: string
}) {
  const { walletClient, owner, unlockData, value = 0n, action } = opts
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
  const data = encodeFunctionData({
    abi: v4PositionManagerAbi,
    functionName: 'modifyLiquidities',
    args: [unlockData, deadline],
  })
  let gas: bigint
  try {
    gas = await publicClient.estimateGas({
      account: owner,
      to: CONTRACTS.v4PositionManager,
      data,
      value: value > 0n ? value : undefined,
    })
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    if (/MaximumAmountExceeded/i.test(raw)) {
      throw new Error(
        `${action} 失败：滑点保护触发（MaximumAmountExceeded）。把顶部滑点调大一点，两边数量按现价重新配平后再试。`,
      )
    }
    throw new Error(`${action} 失败：${raw.slice(0, 220)}`)
  }
  return walletClient.writeContract({
    address: CONTRACTS.v4PositionManager,
    abi: v4PositionManagerAbi,
    functionName: 'modifyLiquidities',
    args: [unlockData, deadline],
    value: value > 0n ? value : undefined,
    gas: (gas * 130n) / 100n,
    chain: walletClient.chain,
    account: owner,
  })
}

function currencyVariants(token: Address, preferNative = true): Address[] {
  const weth = CONTRACTS.weth.toLowerCase()
  if (token.toLowerCase() === weth || isNativeCurrency(token)) {
    // 默认优先原生 ETH，这样勾选「付 ETH」时可直接 msg.value，不必先 Wrap
    return preferNative ? [NATIVE_ETH, CONTRACTS.weth] : [CONTRACTS.weth, NATIVE_ETH]
  }
  return [token]
}

/**
 * 勾选付 ETH 时：若当前是 WETH 池，尝试切到同 fee/spacing/hooks 的原生 ETH 池，
 * 以便 Mint/加仓一笔直接带 value（与 V3 NPM 体验一致）。
 */
async function resolvePoolForEthPayment(pool: PoolInfo, useNativeEth: boolean): Promise<PoolInfo> {
  if (!useNativeEth) return pool
  const c0 = pool.token0.address
  const c1 = pool.token1.address
  const weth0 = c0.toLowerCase() === CONTRACTS.weth.toLowerCase()
  const weth1 = c1.toLowerCase() === CONTRACTS.weth.toLowerCase()
  if (!weth0 && !weth1) return pool // 已是原生或非 ETH 对
  if (isNativeCurrency(c0) || isNativeCurrency(c1)) return pool

  const nativeKey = {
    currency0: weth0 ? NATIVE_ETH : c0,
    currency1: weth1 ? NATIVE_ETH : c1,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hooks ?? NATIVE_ETH,
  }
  try {
    const nativePool = await loadV4Pool(nativeKey)
    if (nativePool.sqrtPriceX96 > 0n) return nativePool
  } catch {
    /* 无原生池 */
  }
  return pool
}

type LoadV4PoolFn = (key: {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}) => Promise<PoolInfo>

type WrapEthFn = (opts: {
  walletClient: WalletClient
  owner: Address
  amount: bigint
}) => Promise<`0x${string}`>

let _loadV4Pool: LoadV4PoolFn | null = null
let _wrapEth: WrapEthFn | null = null

/** Avoid circular import: lp.ts registers these after defining them. */
export function registerV4Deps(deps: { loadV4Pool: LoadV4PoolFn; wrapEth: WrapEthFn }) {
  _loadV4Pool = deps.loadV4Pool
  _wrapEth = deps.wrapEth
}

function loadV4Pool(key: Parameters<LoadV4PoolFn>[0]) {
  if (!_loadV4Pool) throw new Error('V4 deps not registered')
  return _loadV4Pool(key)
}

async function wrapEth(opts: Parameters<WrapEthFn>[0]) {
  if (!_wrapEth) throw new Error('V4 deps not registered')
  return _wrapEth(opts)
}

export async function findV4Pool(
  tokenA: Address,
  tokenB: Address,
  fee: number,
  hooks: Address = NATIVE_ETH,
  preferTickSpacing?: number,
): Promise<PoolInfo | null> {
  const base = v4SpacingsForFee(fee)
  const spacings =
    preferTickSpacing != null && base.includes(preferTickSpacing)
      ? [preferTickSpacing, ...base.filter((s) => s !== preferTickSpacing)]
      : base
  for (const a of currencyVariants(tokenA)) {
    for (const b of currencyVariants(tokenB)) {
      if (a.toLowerCase() === b.toLowerCase()) continue
      for (const tickSpacing of spacings) {
        try {
          const pool = await loadV4Pool({
            currency0: a,
            currency1: b,
            fee,
            tickSpacing,
            hooks,
          })
          if (pool.sqrtPriceX96 > 0n) return pool
        } catch {
          /* try next */
        }
      }
    }
  }
  return null
}

export async function scanV4Pools(
  tokenA: Address,
  tokenB: Address,
  hooks: Address = NATIVE_ETH,
): Promise<PoolInfo[]> {
  const fees = [100, 500, 3000, 10000]
  const out: PoolInfo[] = []
  for (const fee of fees) {
    const p = await findV4Pool(tokenA, tokenB, fee, hooks)
    if (p) out.push(p)
  }
  return out
}

async function ensureWethBalance(opts: {
  walletClient: WalletClient
  owner: Address
  currency0: Address
  currency1: Address
  amount0: bigint
  amount1: bigint
  useNativeEth: boolean
}) {
  const { walletClient, owner, currency0, currency1, amount0, amount1, useNativeEth } = opts
  if (!useNativeEth) return
  let need = 0n
  if (currency0.toLowerCase() === CONTRACTS.weth.toLowerCase()) need = amount0
  if (currency1.toLowerCase() === CONTRACTS.weth.toLowerCase() && amount1 > need) need = amount1
  if (need <= 0n) return
  const bal = await publicClient.readContract({
    address: CONTRACTS.weth,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  })
  if (bal >= need) return
  const hash = await wrapEth({ walletClient, owner, amount: need - bal })
  await publicClient.waitForTransactionReceipt({ hash })
}

export async function mintV4Position(opts: {
  walletClient: WalletClient
  owner: Address
  pool: PoolInfo
  amount0: bigint
  amount1: bigint
  tickLower?: number
  tickUpper?: number
  percent?: number
  useNativeEth?: boolean
  slippageBps?: number
}) {
  const { walletClient, owner } = opts
  const slippageBps = opts.slippageBps ?? 300
  const useNativeEth = Boolean(opts.useNativeEth)
  if (opts.pool.version !== 'v4' || !opts.pool.poolId) throw new Error('需要 V4 池')

  // 优先原生 ETH 池：一笔 msg.value 入金，无需先 Wrap → WETH
  const pool = await resolvePoolForEthPayment(opts.pool, useNativeEth)
  const live = await loadV4Pool({
    currency0: pool.token0.address,
    currency1: pool.token1.address,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hooks ?? NATIVE_ETH,
  })
  let tickLower = opts.tickLower
  let tickUpper = opts.tickUpper
  if (tickLower == null || tickUpper == null) {
    const r = rangeFromPercent(live.tick, opts.percent ?? 5, live.tickSpacing)
    tickLower = r.tickLower
    tickUpper = r.tickUpper
  }
  tickLower = nearestUsableTick(tickLower, live.tickSpacing)
  tickUpper = nearestUsableTick(tickUpper, live.tickSpacing)
  if (tickLower >= tickUpper) throw new Error('区间无效')

  const from0 = opts.amount0 > 0n
    ? pairAmountForRange({
      sqrtPriceX96: live.sqrtPriceX96,
      tickLower,
      tickUpper,
      amount: opts.amount0,
      side: 0,
    })
    : null
  const from1 = opts.amount1 > 0n
    ? pairAmountForRange({
      sqrtPriceX96: live.sqrtPriceX96,
      tickLower,
      tickUpper,
      amount: opts.amount1,
      side: 1,
    })
    : null
  let amount0 = opts.amount0
  let amount1 = opts.amount1
  if (from0 && from0.amount0 > 0n) {
    amount0 = from0.amount0
    amount1 = from0.amount1
  } else if (from1 && from1.amount1 > 0n) {
    amount0 = from1.amount0
    amount1 = from1.amount1
  }
  if (amount0 <= 0n && amount1 <= 0n) throw new Error('数量必须 > 0')

  const key = poolKeyFromPool(live)
  const nativeIs0 = isNativeCurrency(key.currency0)
  const nativeIs1 = isNativeCurrency(key.currency1)
  const wethIs0 = key.currency0.toLowerCase() === CONTRACTS.weth.toLowerCase()
  const wethIs1 = key.currency1.toLowerCase() === CONTRACTS.weth.toLowerCase()

  // 仅当池子本身是 WETH（无原生兄弟池）时才不得不 Wrap；原生池走 msg.value
  if (useNativeEth && (wethIs0 || wethIs1) && !nativeIs0 && !nativeIs1) {
    await ensureWethBalance({
      walletClient,
      owner,
      currency0: key.currency0,
      currency1: key.currency1,
      amount0,
      amount1,
      useNativeEth: true,
    })
  }

  const liquidity = getLiquidityForAmounts(live.sqrtPriceX96, tickLower, tickUpper, amount0, amount1)
  if (liquidity <= 0n) throw new Error('算出的流动性为 0，请检查数量与区间')

  const { amount0: need0, amount1: need1, amount0Max, amount1Max } = maxAmountsForLiquidity({
    sqrtPriceX96: live.sqrtPriceX96,
    tickLower,
    tickUpper,
    liquidity,
    slippageBps,
  })

  // 原生 ETH 侧不走 Permit2
  await ensurePermit2(walletClient, key.currency0, owner, nativeIs0 ? 0n : amount0Max)
  await ensurePermit2(walletClient, key.currency1, owner, nativeIs1 ? 0n : amount1Max)

  const actions: number[] = [V4_ACTIONS.MINT_POSITION, V4_ACTIONS.SETTLE_PAIR]
  const params: `0x${string}`[] = [
    encodeMintParams(key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner),
    encodeSettlePair(key.currency0, key.currency1),
  ]

  let value = 0n
  if (nativeIs0) value = bumpAmountMax(need0, slippageBps)
  if (nativeIs1) value = bumpAmountMax(need1, slippageBps)
  if (nativeIs0 || nativeIs1) {
    actions.push(V4_ACTIONS.SWEEP)
    params.push(encodeSweep(NATIVE_ETH, owner))
  }

  return writeModifyLiquidities({
    walletClient,
    owner,
    unlockData: encodeUnlockData(actions, params),
    value,
    action: 'Mint V4',
  })
}

/**
 * 创建并初始化 V4 池；若提供 amount0/amount1 则同笔 multicall 注入首仓。
 * ETH 侧默认用原生币（currency = address(0)），可勾选 useNativeEth=false 改用 WETH。
 */
export async function createV4PoolAndSeed(opts: {
  walletClient: WalletClient
  owner: Address
  tokenA: Address
  tokenB: Address
  fee: number
  tickSpacing: number
  /** 人类价：tokenB per tokenA */
  initialPriceBPerA: number
  amount0?: bigint
  amount1?: bigint
  tickLower?: number
  tickUpper?: number
  useNativeEth?: boolean
  hooks?: Address
  slippageBps?: number
  onStatus?: (msg: string) => void
}): Promise<{ pool: PoolInfo; hash: `0x${string}`; seeded: boolean }> {
  const {
    walletClient,
    owner,
    fee,
    tickSpacing,
    initialPriceBPerA,
    onStatus,
  } = opts
  const slippageBps = opts.slippageBps ?? 300
  if (!(fee > 0) || fee > 1_000_000) throw new Error('V4 费率无效（单位：百分之一 bp，如 3000=0.30%）')
  if (!(tickSpacing > 0) || tickSpacing > 16384) throw new Error('tickSpacing 无效')
  if (!(initialPriceBPerA > 0)) throw new Error('初始价格必须 > 0')

  const useNative = opts.useNativeEth !== false
  const resolveSide = (t: Address): Address => {
    if (!isEthLikeCurrency(t)) return t
    return useNative ? NATIVE_ETH : CONTRACTS.weth
  }
  const rawA = resolveSide(opts.tokenA)
  const rawB = resolveSide(opts.tokenB)
  if (rawA.toLowerCase() === rawB.toLowerCase()) throw new Error('两个 Currency 不能相同')

  const [currency0, currency1] = sortCurrencies(rawA, rawB)
  const key: V4PoolKey = {
    currency0,
    currency1,
    fee,
    tickSpacing,
    hooks: opts.hooks ?? NATIVE_ETH,
  }

  // 小数位：原生 ETH 按 18
  const decOf = async (c: Address) => {
    if (isNativeCurrency(c)) return 18
    return Number(
      await publicClient.readContract({ address: c, abi: erc20Abi, functionName: 'decimals' }),
    )
  }
  const [dec0, dec1] = await Promise.all([decOf(currency0), decOf(currency1)])

  // B per A → token1 per token0
  let sortedPrice = initialPriceBPerA
  if (currency0.toLowerCase() !== rawA.toLowerCase()) sortedPrice = 1 / initialPriceBPerA
  const sqrtPriceX96 = priceToSqrtPriceX96(sortedPrice, dec0, dec1)
  const initTick = priceToClosestTick(sortedPrice, dec0, dec1)

  // 已存在且已初始化 → 只走 mint（如有数量）
  const existing = await loadV4Pool(key).catch(() => null)
  if (existing && existing.sqrtPriceX96 > 0n) {
    if ((opts.amount0 ?? 0n) <= 0n && (opts.amount1 ?? 0n) <= 0n) {
      throw new Error('该 V4 池已存在；请到下方直接加仓，或更换 Fee / spacing')
    }
    onStatus?.('池已存在，改为注入流动性…')
    const hash = await mintV4Position({
      walletClient,
      owner,
      pool: existing,
      amount0: opts.amount0 ?? 0n,
      amount1: opts.amount1 ?? 0n,
      tickLower: opts.tickLower,
      tickUpper: opts.tickUpper,
      useNativeEth: useNative,
      slippageBps,
    })
    return { pool: await loadV4Pool(key), hash, seeded: true }
  }

  const wantSeed = (opts.amount0 ?? 0n) > 0n || (opts.amount1 ?? 0n) > 0n
  let tickLower = opts.tickLower
  let tickUpper = opts.tickUpper
  let amount0 = opts.amount0 ?? 0n
  let amount1 = opts.amount1 ?? 0n
  let liquidity = 0n
  let amount0Max = 0n
  let amount1Max = 0n
  let value = 0n

  if (wantSeed) {
    if (tickLower == null || tickUpper == null) {
      const r = rangeFromPercent(initTick, 5, tickSpacing)
      tickLower = r.tickLower
      tickUpper = r.tickUpper
    }
    tickLower = nearestUsableTick(tickLower, tickSpacing)
    tickUpper = nearestUsableTick(tickUpper, tickSpacing)
    if (tickLower >= tickUpper) throw new Error('区间无效')

    const from0 = amount0 > 0n
      ? pairAmountForRange({ sqrtPriceX96, tickLower, tickUpper, amount: amount0, side: 0 })
      : null
    const from1 = amount1 > 0n
      ? pairAmountForRange({ sqrtPriceX96, tickLower, tickUpper, amount: amount1, side: 1 })
      : null
    if (from0 && from0.amount0 > 0n) {
      amount0 = from0.amount0
      amount1 = from0.amount1
    } else if (from1 && from1.amount1 > 0n) {
      amount0 = from1.amount0
      amount1 = from1.amount1
    }
    if (amount0 <= 0n && amount1 <= 0n) throw new Error('注入数量必须 > 0')

    if (!isNativeCurrency(currency0) && !isNativeCurrency(currency1)) {
      await ensureWethBalance({
        walletClient,
        owner,
        currency0,
        currency1,
        amount0,
        amount1,
        useNativeEth: useNative,
      })
    }

    liquidity = getLiquidityForAmounts(sqrtPriceX96, tickLower, tickUpper, amount0, amount1)
    if (liquidity <= 0n) throw new Error('算出的流动性为 0，请检查数量与区间')
    const maxed = maxAmountsForLiquidity({
      sqrtPriceX96,
      tickLower,
      tickUpper,
      liquidity,
      slippageBps,
    })
    amount0Max = maxed.amount0Max
    amount1Max = maxed.amount1Max
    await ensurePermit2(walletClient, currency0, owner, amount0Max)
    await ensurePermit2(walletClient, currency1, owner, amount1Max)
    if (isNativeCurrency(currency0)) value = bumpAmountMax(maxed.amount0, slippageBps)
    if (isNativeCurrency(currency1)) value = bumpAmountMax(maxed.amount1, slippageBps)
  }

  onStatus?.(wantSeed ? '创建 V4 池并注入流动性…' : '创建并初始化 V4 池…')

  const initData = encodeFunctionData({
    abi: v4PositionManagerAbi,
    functionName: 'initializePool',
    args: [key, sqrtPriceX96],
  })

  let calls: `0x${string}`[] = [initData]
  if (wantSeed && tickLower != null && tickUpper != null) {
    const actions: number[] = [V4_ACTIONS.MINT_POSITION, V4_ACTIONS.SETTLE_PAIR]
    const params: `0x${string}`[] = [
      encodeMintParams(key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner),
      encodeSettlePair(currency0, currency1),
    ]
    if (isNativeCurrency(currency0) || isNativeCurrency(currency1)) {
      actions.push(V4_ACTIONS.SWEEP)
      params.push(encodeSweep(NATIVE_ETH, owner))
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
    const mintData = encodeFunctionData({
      abi: v4PositionManagerAbi,
      functionName: 'modifyLiquidities',
      args: [encodeUnlockData(actions, params), deadline],
    })
    calls = [initData, mintData]
  }

  const data = encodeFunctionData({
    abi: v4PositionManagerAbi,
    functionName: 'multicall',
    args: [calls],
  })
  let gas: bigint
  try {
    gas = await publicClient.estimateGas({
      account: owner,
      to: CONTRACTS.v4PositionManager,
      data,
      value: value > 0n ? value : undefined,
    })
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    throw new Error(`创建 V4 失败：${raw.slice(0, 220)}`)
  }

  const hash = await walletClient.writeContract({
    address: CONTRACTS.v4PositionManager,
    abi: v4PositionManagerAbi,
    functionName: 'multicall',
    args: [calls],
    value: value > 0n ? value : undefined,
    gas: (gas * 130n) / 100n,
    chain: walletClient.chain,
    account: owner,
  })
  await publicClient.waitForTransactionReceipt({ hash })
  const pool = await loadV4Pool(key)
  if (!(pool.sqrtPriceX96 > 0n)) throw new Error('创建成功但尚未读到池价，请稍后刷新')
  return { pool, hash, seeded: wantSeed }
}

export async function increaseV4Liquidity(opts: {
  walletClient: WalletClient
  owner: Address
  position: PositionRow
  amount0: bigint
  amount1: bigint
  useNativeEth?: boolean
  slippageBps?: number
  /**
   * 手续费复投：两边数量都是上限，不再按单边配平放大另一侧，
   * 且 amountMax 不超过提供量，避免 SETTLE 从钱包多扣本金。
   */
  capToProvided?: boolean
}) {
  const { walletClient, owner, position } = opts
  const slippageBps = opts.slippageBps ?? 300
  if (position.version !== 'v4') throw new Error('需要 V4 仓位')
  const key = poolKeyFromPosition(position)
  const live = await loadV4Pool(key)

  let amount0 = opts.amount0
  let amount1 = opts.amount1
  if (!opts.capToProvided) {
    const from0 = opts.amount0 > 0n
      ? pairAmountForRange({
        sqrtPriceX96: live.sqrtPriceX96,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        amount: opts.amount0,
        side: 0,
      })
      : null
    const from1 = opts.amount1 > 0n
      ? pairAmountForRange({
        sqrtPriceX96: live.sqrtPriceX96,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        amount: opts.amount1,
        side: 1,
      })
      : null
    if (from0 && from0.amount0 > 0n) {
      amount0 = from0.amount0
      amount1 = from0.amount1
    } else if (from1 && from1.amount1 > 0n) {
      amount0 = from1.amount0
      amount1 = from1.amount1
    }
  }
  if (amount0 <= 0n && amount1 <= 0n) throw new Error('数量必须 > 0')

  const nativeIs0 = isNativeCurrency(key.currency0)
  const nativeIs1 = isNativeCurrency(key.currency1)
  const wethIs0 = key.currency0.toLowerCase() === CONTRACTS.weth.toLowerCase()
  const wethIs1 = key.currency1.toLowerCase() === CONTRACTS.weth.toLowerCase()
  // 仓位绑死了 PoolKey：原生仓直接付 ETH；WETH 仓只能 Wrap（无法改 Key）
  if (Boolean(opts.useNativeEth) && (wethIs0 || wethIs1) && !nativeIs0 && !nativeIs1) {
    await ensureWethBalance({
      walletClient,
      owner,
      currency0: key.currency0,
      currency1: key.currency1,
      amount0,
      amount1,
      useNativeEth: true,
    })
  }

  const liquidity = getLiquidityForAmounts(
    live.sqrtPriceX96,
    position.tickLower,
    position.tickUpper,
    amount0,
    amount1,
  )
  if (liquidity <= 0n) throw new Error('算出的流动性为 0')

  let amount0Max: bigint
  let amount1Max: bigint
  let need0: bigint
  let need1: bigint
  if (opts.capToProvided) {
    // 只花提供量：价动导致需要更多时直接失败，由上层软降级，绝不从钱包多扣
    need0 = amount0
    need1 = amount1
    amount0Max = amount0
    amount1Max = amount1
  } else {
    const maxed = maxAmountsForLiquidity({
      sqrtPriceX96: live.sqrtPriceX96,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      liquidity,
      slippageBps,
    })
    need0 = maxed.amount0
    need1 = maxed.amount1
    amount0Max = maxed.amount0Max
    amount1Max = maxed.amount1Max
  }

  await ensurePermit2(walletClient, key.currency0, owner, nativeIs0 ? 0n : amount0Max)
  await ensurePermit2(walletClient, key.currency1, owner, nativeIs1 ? 0n : amount1Max)

  const actions: number[] = [V4_ACTIONS.INCREASE_LIQUIDITY, V4_ACTIONS.SETTLE_PAIR]
  const params: `0x${string}`[] = [
    encodeModifyLiqParams(position.tokenId, liquidity, amount0Max, amount1Max),
    encodeSettlePair(key.currency0, key.currency1),
  ]
  let value = 0n
  if (nativeIs0) value = opts.capToProvided ? amount0 : bumpAmountMax(need0, slippageBps)
  if (nativeIs1) value = opts.capToProvided ? amount1 : bumpAmountMax(need1, slippageBps)
  if (nativeIs0 || nativeIs1) {
    actions.push(V4_ACTIONS.SWEEP)
    params.push(encodeSweep(NATIVE_ETH, owner))
  }

  return writeModifyLiquidities({
    walletClient,
    owner,
    unlockData: encodeUnlockData(actions, params),
    value,
    action: '加仓 V4',
  })
}

export async function claimV4(opts: {
  walletClient: WalletClient
  owner: Address
  position: PositionRow
}) {
  const { walletClient, owner, position } = opts
  if (position.version !== 'v4') throw new Error('需要 V4 仓位')
  const key = poolKeyFromPosition(position)
  const actions: number[] = [V4_ACTIONS.DECREASE_LIQUIDITY, V4_ACTIONS.TAKE_PAIR]
  const params: `0x${string}`[] = [
    encodeModifyLiqParams(position.tokenId, 0n, 0n, 0n),
    encodeTakePair(key.currency0, key.currency1, owner),
  ]
  if (isNativeCurrency(key.currency0) || isNativeCurrency(key.currency1)) {
    actions.push(V4_ACTIONS.SWEEP)
    params.push(encodeSweep(NATIVE_ETH, owner))
  }
  return writeModifyLiquidities({
    walletClient,
    owner,
    unlockData: encodeUnlockData(actions, params),
    action: 'Claim V4',
  })
}

export async function removeV4Liquidity(opts: {
  walletClient: WalletClient
  owner: Address
  position: PositionRow
  percent?: number
  burnEmpty?: boolean
}) {
  const { walletClient, owner, position, percent = 100, burnEmpty = true } = opts
  if (position.version !== 'v4') throw new Error('需要 V4 仓位')
  const pct = Math.min(100, Math.max(1, percent))
  const key = poolKeyFromPosition(position)

  if (position.liquidity === 0n) {
    return claimV4({ walletClient, owner, position })
  }

  const liq =
    pct >= 100
      ? position.liquidity
      : (position.liquidity * BigInt(Math.floor(pct * 100))) / 10000n
  if (liq === 0n) throw new Error('撤出流动性过小')

  if (burnEmpty && pct >= 100) {
    const actions: number[] = [V4_ACTIONS.BURN_POSITION, V4_ACTIONS.TAKE_PAIR]
    const params: `0x${string}`[] = [
      encodeBurnParams(position.tokenId, 0n, 0n),
      encodeTakePair(key.currency0, key.currency1, owner),
    ]
    if (isNativeCurrency(key.currency0) || isNativeCurrency(key.currency1)) {
      actions.push(V4_ACTIONS.SWEEP)
      params.push(encodeSweep(NATIVE_ETH, owner))
    }
    return writeModifyLiquidities({
      walletClient,
      owner,
      unlockData: encodeUnlockData(actions, params),
      action: '移除 V4',
    })
  }

  const actions: number[] = [V4_ACTIONS.DECREASE_LIQUIDITY, V4_ACTIONS.TAKE_PAIR]
  const params: `0x${string}`[] = [
    encodeModifyLiqParams(position.tokenId, liq, 0n, 0n),
    encodeTakePair(key.currency0, key.currency1, owner),
  ]
  if (isNativeCurrency(key.currency0) || isNativeCurrency(key.currency1)) {
    actions.push(V4_ACTIONS.SWEEP)
    params.push(encodeSweep(NATIVE_ETH, owner))
  }
  return writeModifyLiquidities({
    walletClient,
    owner,
    unlockData: encodeUnlockData(actions, params),
    action: '撤出 V4',
  })
}
