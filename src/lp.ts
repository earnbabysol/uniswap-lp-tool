import {
  encodeFunctionData,
  encodeAbiParameters,
  keccak256,
  parseAbiItem,
  type Address,
  type WalletClient,
} from 'viem'
import { CONTRACTS, FEE_TIERS, KNOWN_TOKENS } from './chain'
import { erc20Abi, v3FactoryAbi, v3NpmAbi, v3PoolAbi, v4PositionManagerAbi, v4StateViewAbi } from './abis'
import {
  decodeV4PositionInfo,
  formatAmount,
  formatAmountExact,
  getAmountsForPosition,
  MAX_UINT128,
  mulDiv,
  Q128,
  nearestUsableTick,
  pairAmountForRange,
  priceToClosestTick,
  priceToSqrtPriceX96,
  rangeFromPercent,
  rawToNumber,
  sqrtPriceX96ToPrice,
  tickToPrice,
} from './math'
import { publicClient } from './wallet'
import {
  registerV4Deps,
  mintV4Position,
  claimV4,
  increaseV4Liquidity,
  removeV4Liquidity,
  findV4Pool,
  scanV4Pools,
  isEthLikeCurrency,
  isNativeCurrency,
} from './v4'

export {
  mintV4Position,
  claimV4,
  increaseV4Liquidity,
  removeV4Liquidity,
  findV4Pool,
  scanV4Pools,
  isEthLikeCurrency,
  isNativeCurrency,
}

export type TokenMeta = { address: Address; symbol: string; decimals: number }

export type PoolInfo = {
  version: 'v3' | 'v4'
  poolAddress?: Address
  poolId?: `0x${string}`
  token0: TokenMeta
  token1: TokenMeta
  fee: number
  tickSpacing: number
  tick: number
  sqrtPriceX96: bigint
  price: number
  liquidity: bigint
  hooks?: Address
}

export type PositionRow = {
  version: 'v3' | 'v4'
  tokenId: bigint
  token0: TokenMeta
  token1: TokenMeta
  fee: number
  tickLower: number
  tickUpper: number
  liquidity: bigint
  tick: number
  inRange: boolean
  /** token1 per token0 */
  priceLower: number
  priceUpper: number
  price: number
  amount0: bigint
  amount1: bigint
  fees0: bigint
  fees1: bigint
  amount0Usd: number
  amount1Usd: number
  fees0Usd: number
  fees1Usd: number
  totalUsd: number
  pct0: number
  pct1: number
  /** 已领取手续费（链上 Collect，扣除同笔撤出本金） */
  claimed0: bigint
  claimed1: bigint
  claimedFeesUsd: number
  /** 累计手续费 = 未领 + 已领 */
  totalFeesUsd: number
  /** 按现价：存入 - 取出 的本金成本 */
  costBasisUsd: number
  /** PnL = 当前本金 + 未领费 + 已领费 + 已取出本金 - 存入本金 */
  pnlUsd: number
  poolAddress?: Address
  poolId?: `0x${string}`
  tickSpacing: number
  hooks?: Address
  sqrtPriceX96: bigint
}

async function resolveToken(address: Address): Promise<TokenMeta> {
  if (address.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    return { address, symbol: 'ETH', decimals: 18 }
  }
  const known = KNOWN_TOKENS[address.toLowerCase()]
  if (known) return { address, ...known }
  try {
    const [symbol, decimals] = await Promise.all([
      publicClient.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
      publicClient.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    ])
    return { address, symbol, decimals }
  } catch {
    return { address, symbol: address.slice(0, 6), decimals: 18 }
  }
}

export async function resolveTokenMeta(address: Address): Promise<TokenMeta> {
  return resolveToken(address)
}

export async function getErc20Balance(token: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
}

export async function getNativeBalance(owner: Address): Promise<bigint> {
  return publicClient.getBalance({ address: owner })
}

export async function loadV3Pool(poolAddress: Address): Promise<PoolInfo> {
  const [token0Addr, token1Addr, fee, tickSpacing, slot0, liquidity] = await Promise.all([
    publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'token0' }),
    publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'token1' }),
    publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'fee' }),
    publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'tickSpacing' }),
    publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'slot0' }),
    publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'liquidity' }),
  ])
  const [token0, token1] = await Promise.all([resolveToken(token0Addr), resolveToken(token1Addr)])
  const sqrtPriceX96 = slot0[0]
  const tick = slot0[1]
  return {
    version: 'v3',
    poolAddress,
    token0,
    token1,
    fee,
    tickSpacing,
    tick,
    sqrtPriceX96,
    price: sqrtPriceX96ToPrice(sqrtPriceX96, token0.decimals, token1.decimals),
    liquidity,
  }
}

export async function findV3Pool(tokenA: Address, tokenB: Address, fee: number): Promise<Address | null> {
  const pool = await publicClient.readContract({
    address: CONTRACTS.v3Factory,
    abi: v3FactoryAbi,
    functionName: 'getPool',
    args: [tokenA, tokenB, fee],
  })
  if (pool === '0x0000000000000000000000000000000000000000') return null
  return pool
}

export async function scanV3Pools(tokenA: Address, tokenB: Address): Promise<PoolInfo[]> {
  const found = await Promise.all(
    FEE_TIERS.map(async (f) => {
      const addr = await findV3Pool(tokenA, tokenB, f)
      if (!addr) return null
      try {
        const p = await loadV3Pool(addr)
        // 未 initialize 的池不当作可用池
        if (p.sqrtPriceX96 === 0n) return null
        return p
      } catch {
        return null
      }
    }),
  )
  return found.filter((p): p is PoolInfo => p !== null)
}

function sortTokenAddresses(a: Address, b: Address): [Address, Address] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]
}

/** 把「B per A」转成池子排序后的 token1 per token0 */
export function toSortedPrice(
  priceBPerA: number,
  tokenA: Address,
  tokenB: Address,
): number {
  if (!(priceBPerA > 0) || !Number.isFinite(priceBPerA)) throw new Error('初始价格必须 > 0')
  const [t0] = sortTokenAddresses(tokenA, tokenB)
  if (t0.toLowerCase() === tokenA.toLowerCase()) return priceBPerA
  return 1 / priceBPerA
}

/**
 * 创建并初始化 V3 池（若不存在 / 未 initialize）。
 * 优先走 NPM.createAndInitializePoolIfNecessary；失败则 Factory.createPool + Pool.initialize。
 * 若池已存在且已初始化，直接返回（hash=null）。
 */
export async function createV3Pool(opts: {
  walletClient: WalletClient
  owner: Address
  tokenA: Address
  tokenB: Address
  fee: number
  /** 人类价：Token B per Token A（与界面选择一致） */
  initialPriceBPerA: number
}): Promise<{ pool: PoolInfo; hash: `0x${string}` | null; created: boolean }> {
  const { walletClient, owner, tokenA, tokenB, fee, initialPriceBPerA } = opts
  if (tokenA.toLowerCase() === tokenB.toLowerCase()) throw new Error('两个 Token 不能相同')

  const spacing = await publicClient.readContract({
    address: CONTRACTS.v3Factory,
    abi: v3FactoryAbi,
    functionName: 'feeAmountTickSpacing',
    args: [fee],
  })
  if (spacing === 0) throw new Error(`Factory 未启用该 Fee tier（${(fee / 10000).toFixed(2)}%）`)

  const [token0Addr, token1Addr] = sortTokenAddresses(tokenA, tokenB)
  const [token0, token1] = await Promise.all([resolveToken(token0Addr), resolveToken(token1Addr)])
  const sortedPrice = toSortedPrice(initialPriceBPerA, tokenA, tokenB)
  const sqrtPriceX96 = priceToSqrtPriceX96(sortedPrice, token0.decimals, token1.decimals)

  const existing = await findV3Pool(token0Addr, token1Addr, fee)
  if (existing) {
    const slot0 = await publicClient.readContract({
      address: existing,
      abi: v3PoolAbi,
      functionName: 'slot0',
    })
    if (slot0[0] > 0n) {
      return { pool: await loadV3Pool(existing), hash: null, created: false }
    }
    // 已创建未初始化
    const data = encodeFunctionData({
      abi: v3PoolAbi,
      functionName: 'initialize',
      args: [sqrtPriceX96],
    })
    let gas: bigint
    try {
      gas = await publicClient.estimateGas({ account: owner, to: existing, data })
    } catch (e) {
      throw new Error(friendlyTxError(e, '初始化池'))
    }
    const hash = await walletClient.writeContract({
      address: existing,
      abi: v3PoolAbi,
      functionName: 'initialize',
      args: [sqrtPriceX96],
      gas: (gas * 130n) / 100n,
      chain: walletClient.chain,
      account: owner,
    })
    await publicClient.waitForTransactionReceipt({ hash })
    return { pool: await loadV3Pool(existing), hash, created: true }
  }

  // 优先 NPM 一键创建+初始化
  try {
    const data = encodeFunctionData({
      abi: v3NpmAbi,
      functionName: 'createAndInitializePoolIfNecessary',
      args: [token0Addr, token1Addr, fee, sqrtPriceX96],
    })
    const gas = await publicClient.estimateGas({
      account: owner,
      to: CONTRACTS.v3Npm,
      data,
    })
    const hash = await walletClient.writeContract({
      address: CONTRACTS.v3Npm,
      abi: v3NpmAbi,
      functionName: 'createAndInitializePoolIfNecessary',
      args: [token0Addr, token1Addr, fee, sqrtPriceX96],
      gas: (gas * 130n) / 100n,
      chain: walletClient.chain,
      account: owner,
    })
    await publicClient.waitForTransactionReceipt({ hash })
    const addr = await findV3Pool(token0Addr, token1Addr, fee)
    if (!addr) throw new Error('创建成功但未读到池地址，请稍后「按 Fee 加载」')
    return { pool: await loadV3Pool(addr), hash, created: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/user rejected|denied|已取消/i.test(msg)) throw e instanceof Error ? e : new Error(msg)
    // 继续尝试 Factory 路径
  }

  // Factory.createPool → Pool.initialize
  {
    const data = encodeFunctionData({
      abi: v3FactoryAbi,
      functionName: 'createPool',
      args: [token0Addr, token1Addr, fee],
    })
    let gas: bigint
    try {
      gas = await publicClient.estimateGas({ account: owner, to: CONTRACTS.v3Factory, data })
    } catch (e) {
      throw new Error(friendlyTxError(e, '创建池'))
    }
    const createHash = await walletClient.writeContract({
      address: CONTRACTS.v3Factory,
      abi: v3FactoryAbi,
      functionName: 'createPool',
      args: [token0Addr, token1Addr, fee],
      gas: (gas * 130n) / 100n,
      chain: walletClient.chain,
      account: owner,
    })
    await publicClient.waitForTransactionReceipt({ hash: createHash })
    const addr = await findV3Pool(token0Addr, token1Addr, fee)
    if (!addr) throw new Error('createPool 后未找到池地址')

    const initData = encodeFunctionData({
      abi: v3PoolAbi,
      functionName: 'initialize',
      args: [sqrtPriceX96],
    })
    let initGas: bigint
    try {
      initGas = await publicClient.estimateGas({ account: owner, to: addr, data: initData })
    } catch (e) {
      throw new Error(friendlyTxError(e, '初始化池'))
    }
    const hash = await walletClient.writeContract({
      address: addr,
      abi: v3PoolAbi,
      functionName: 'initialize',
      args: [sqrtPriceX96],
      gas: (initGas * 130n) / 100n,
      chain: walletClient.chain,
      account: owner,
    })
    await publicClient.waitForTransactionReceipt({ hash })
    return { pool: await loadV3Pool(addr), hash, created: true }
  }
}



export function v4PoolId(key: {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  )
}

export async function loadV4Pool(key: {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}): Promise<PoolInfo> {
  const [c0, c1] = key.currency0.toLowerCase() < key.currency1.toLowerCase()
    ? [key.currency0, key.currency1]
    : [key.currency1, key.currency0]
  const sorted = { ...key, currency0: c0, currency1: c1 }
  const poolId = v4PoolId(sorted)
  const [slot0, liquidity] = await Promise.all([
    publicClient.readContract({
      address: CONTRACTS.v4StateView,
      abi: v4StateViewAbi,
      functionName: 'getSlot0',
      args: [poolId],
    }),
    publicClient.readContract({
      address: CONTRACTS.v4StateView,
      abi: v4StateViewAbi,
      functionName: 'getLiquidity',
      args: [poolId],
    }),
  ])
  const [token0, token1] = await Promise.all([resolveToken(c0), resolveToken(c1)])
  const sqrtPriceX96 = slot0[0]
  const tick = slot0[1]
  return {
    version: 'v4',
    poolId,
    token0,
    token1,
    fee: key.fee,
    tickSpacing: key.tickSpacing,
    tick,
    sqrtPriceX96,
    price: sqrtPriceX96ToPrice(sqrtPriceX96, token0.decimals, token1.decimals),
    liquidity,
    hooks: key.hooks,
  }
}

async function getWethUsdPrice(): Promise<number> {
  try {
    // Prefer 0.05% WETH/USDG pool
    const poolAddr = await findV3Pool(CONTRACTS.weth, CONTRACTS.usdg, 500)
      ?? await findV3Pool(CONTRACTS.weth, CONTRACTS.usdg, 3000)
    if (!poolAddr) return 0
    const pool = await loadV3Pool(poolAddr)
    // price = token1 per token0. If token0=USDG token1=WETH → price is WETH per USDG (invert)
    // If token0=WETH token1=USDG → price is USDG per WETH
    if (pool.token0.address.toLowerCase() === CONTRACTS.weth.toLowerCase()) return pool.price
    if (pool.token1.address.toLowerCase() === CONTRACTS.weth.toLowerCase()) return pool.price > 0 ? 1 / pool.price : 0
    return 0
  } catch {
    return 0
  }
}

function tokenUsd(
  address: Address,
  amount: bigint,
  decimals: number,
  poolPriceToken1PerToken0: number,
  token0: Address,
  token1: Address,
  wethUsd: number,
): number {
  const qty = rawToNumber(amount, decimals)
  const addr = address.toLowerCase()
  if (addr === CONTRACTS.usdg.toLowerCase()) return qty
  if (addr === CONTRACTS.weth.toLowerCase() || addr === '0x0000000000000000000000000000000000000000') return qty * wethUsd
  // price other token via pool vs WETH or USDG
  if (token0.toLowerCase() === CONTRACTS.weth.toLowerCase() && addr === token1.toLowerCase()) {
    // token1 per WETH = poolPrice → 1 token1 = wethUsd / poolPrice
    return poolPriceToken1PerToken0 > 0 ? qty * (wethUsd / poolPriceToken1PerToken0) : 0
  }
  if (token1.toLowerCase() === CONTRACTS.weth.toLowerCase() && addr === token0.toLowerCase()) {
    // poolPrice = WETH per token0 → token0 USD = poolPrice * wethUsd
    return qty * poolPriceToken1PerToken0 * wethUsd
  }
  if (token0.toLowerCase() === CONTRACTS.usdg.toLowerCase() && addr === token1.toLowerCase()) {
    return poolPriceToken1PerToken0 > 0 ? qty / poolPriceToken1PerToken0 : 0
  }
  if (token1.toLowerCase() === CONTRACTS.usdg.toLowerCase() && addr === token0.toLowerCase()) {
    return qty * poolPriceToken1PerToken0
  }
  // generic: value token0 in token1 terms then hope token1 is known
  if (addr === token0.toLowerCase()) {
    const inToken1 = qty * poolPriceToken1PerToken0
    if (token1.toLowerCase() === CONTRACTS.usdg.toLowerCase()) return inToken1
    if (token1.toLowerCase() === CONTRACTS.weth.toLowerCase()) return inToken1 * wethUsd
  }
  if (addr === token1.toLowerCase()) {
    if (token0.toLowerCase() === CONTRACTS.usdg.toLowerCase()) return qty * (poolPriceToken1PerToken0 > 0 ? 1 : 0) // wrong
    // token1 amount: convert via 1/price to token0 if token0 is WETH/USDG
    if (token0.toLowerCase() === CONTRACTS.weth.toLowerCase() && poolPriceToken1PerToken0 > 0) {
      return (qty / poolPriceToken1PerToken0) * wethUsd
    }
    if (token0.toLowerCase() === CONTRACTS.usdg.toLowerCase() && poolPriceToken1PerToken0 > 0) {
      return qty / poolPriceToken1PerToken0
    }
  }
  return 0
}

async function computeV3Fees(opts: {
  pool: Address
  tick: number
  tickLower: number
  tickUpper: number
  liquidity: bigint
  feeGrowthInside0LastX128: bigint
  feeGrowthInside1LastX128: bigint
  tokensOwed0: bigint
  tokensOwed1: bigint
}): Promise<{ fees0: bigint; fees1: bigint }> {
  const { pool, tick, tickLower, tickUpper, liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1 } = opts
  if (liquidity === 0n) return { fees0: tokensOwed0, fees1: tokensOwed1 }

  const [fg0, fg1, lower, upper] = await Promise.all([
    publicClient.readContract({ address: pool, abi: v3PoolAbi, functionName: 'feeGrowthGlobal0X128' }),
    publicClient.readContract({ address: pool, abi: v3PoolAbi, functionName: 'feeGrowthGlobal1X128' }),
    publicClient.readContract({ address: pool, abi: v3PoolAbi, functionName: 'ticks', args: [tickLower] }),
    publicClient.readContract({ address: pool, abi: v3PoolAbi, functionName: 'ticks', args: [tickUpper] }),
  ])

  const lowerOutside0 = lower[2]
  const lowerOutside1 = lower[3]
  const upperOutside0 = upper[2]
  const upperOutside1 = upper[3]

  const sub = (a: bigint, b: bigint) => ((a - b) & ((1n << 256n) - 1n))

  let feeGrowthBelow0 = lowerOutside0
  let feeGrowthBelow1 = lowerOutside1
  if (tick < tickLower) {
    feeGrowthBelow0 = sub(fg0, lowerOutside0)
    feeGrowthBelow1 = sub(fg1, lowerOutside1)
  }

  let feeGrowthAbove0 = upperOutside0
  let feeGrowthAbove1 = upperOutside1
  if (tick >= tickUpper) {
    feeGrowthAbove0 = sub(fg0, upperOutside0)
    feeGrowthAbove1 = sub(fg1, upperOutside1)
  }

  const feeGrowthInside0 = sub(sub(fg0, feeGrowthBelow0), feeGrowthAbove0)
  const feeGrowthInside1 = sub(sub(fg1, feeGrowthBelow1), feeGrowthAbove1)

  const delta0 = sub(feeGrowthInside0, feeGrowthInside0LastX128)
  const delta1 = sub(feeGrowthInside1, feeGrowthInside1LastX128)

  const fees0 = mulDiv(liquidity, delta0, Q128) + tokensOwed0
  const fees1 = mulDiv(liquidity, delta1, Q128) + tokensOwed1
  return { fees0, fees1 }
}

function enrichUsd(
  amount0: bigint,
  amount1: bigint,
  fees0: bigint,
  fees1: bigint,
  pool: PoolInfo,
  wethUsd: number,
) {
  const amount0Usd = tokenUsd(pool.token0.address, amount0, pool.token0.decimals, pool.price, pool.token0.address, pool.token1.address, wethUsd)
  const amount1Usd = tokenUsd(pool.token1.address, amount1, pool.token1.decimals, pool.price, pool.token0.address, pool.token1.address, wethUsd)
  const fees0Usd = tokenUsd(pool.token0.address, fees0, pool.token0.decimals, pool.price, pool.token0.address, pool.token1.address, wethUsd)
  const fees1Usd = tokenUsd(pool.token1.address, fees1, pool.token1.decimals, pool.price, pool.token0.address, pool.token1.address, wethUsd)
  const principal = amount0Usd + amount1Usd
  const totalUsd = principal + fees0Usd + fees1Usd
  const pct0 = principal > 0 ? (amount0Usd / principal) * 100 : 50
  const pct1 = principal > 0 ? (amount1Usd / principal) * 100 : 50
  return { amount0Usd, amount1Usd, fees0Usd, fees1Usd, totalUsd, pct0, pct1 }
}

type Cashflow = {
  deposited0: bigint
  deposited1: bigint
  withdrawn0: bigint
  withdrawn1: bigint
  claimed0: bigint
  claimed1: bigint
}

async function loadPositionCashflow(tokenId: bigint): Promise<Cashflow> {
  const empty: Cashflow = {
    deposited0: 0n, deposited1: 0n,
    withdrawn0: 0n, withdrawn1: 0n,
    claimed0: 0n, claimed1: 0n,
  }
  try {
    const latest = await publicClient.getBlockNumber()
    const incEvent = parseAbiItem('event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)')
    const decEvent = parseAbiItem('event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)')
    const colEvent = parseAbiItem('event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)')
    const [inc, dec, col] = await Promise.all([
      publicClient.getLogs({
        address: CONTRACTS.v3Npm,
        event: incEvent,
        args: { tokenId },
        fromBlock: 0n,
        toBlock: latest,
      }),
      publicClient.getLogs({
        address: CONTRACTS.v3Npm,
        event: decEvent,
        args: { tokenId },
        fromBlock: 0n,
        toBlock: latest,
      }),
      publicClient.getLogs({
        address: CONTRACTS.v3Npm,
        event: colEvent,
        args: { tokenId },
        fromBlock: 0n,
        toBlock: latest,
      }),
    ])

    let deposited0 = 0n
    let deposited1 = 0n
    for (const l of inc) {
      deposited0 += l.args.amount0 ?? 0n
      deposited1 += l.args.amount1 ?? 0n
    }

    let withdrawn0 = 0n
    let withdrawn1 = 0n
    const decByTx = new Map<string, { a0: bigint; a1: bigint }>()
    for (const l of dec) {
      const a0 = l.args.amount0 ?? 0n
      const a1 = l.args.amount1 ?? 0n
      withdrawn0 += a0
      withdrawn1 += a1
      const prev = decByTx.get(l.transactionHash) ?? { a0: 0n, a1: 0n }
      decByTx.set(l.transactionHash, { a0: prev.a0 + a0, a1: prev.a1 + a1 })
    }

    let claimed0 = 0n
    let claimed1 = 0n
    for (const l of col) {
      const c0 = l.args.amount0 ?? 0n
      const c1 = l.args.amount1 ?? 0n
      const d = decByTx.get(l.transactionHash)
      if (d) {
        claimed0 += c0 > d.a0 ? c0 - d.a0 : 0n
        claimed1 += c1 > d.a1 ? c1 - d.a1 : 0n
      } else {
        claimed0 += c0
        claimed1 += c1
      }
    }

    return { deposited0, deposited1, withdrawn0, withdrawn1, claimed0, claimed1 }
  } catch (e) {
    console.warn('cashflow load failed', tokenId.toString(), e)
    return empty
  }
}

function enrichPnl(
  pool: PoolInfo,
  wethUsd: number,
  principalUsd: number,
  unclaimedFeesUsd: number,
  cf: Cashflow,
) {
  const depositedUsd =
    tokenUsd(pool.token0.address, cf.deposited0, pool.token0.decimals, pool.price, pool.token0.address, pool.token1.address, wethUsd)
    + tokenUsd(pool.token1.address, cf.deposited1, pool.token1.decimals, pool.price, pool.token0.address, pool.token1.address, wethUsd)
  const withdrawnUsd =
    tokenUsd(pool.token0.address, cf.withdrawn0, pool.token0.decimals, pool.price, pool.token0.address, pool.token1.address, wethUsd)
    + tokenUsd(pool.token1.address, cf.withdrawn1, pool.token1.decimals, pool.price, pool.token0.address, pool.token1.address, wethUsd)
  const claimedFeesUsd =
    tokenUsd(pool.token0.address, cf.claimed0, pool.token0.decimals, pool.price, pool.token0.address, pool.token1.address, wethUsd)
    + tokenUsd(pool.token1.address, cf.claimed1, pool.token1.decimals, pool.price, pool.token0.address, pool.token1.address, wethUsd)
  const costBasisUsd = depositedUsd - withdrawnUsd
  const totalFeesUsd = unclaimedFeesUsd + claimedFeesUsd
  // 现价口径：当前仓位 + 已领手续费 + 已取出本金 - 累计存入
  const pnlUsd = principalUsd + unclaimedFeesUsd + claimedFeesUsd + withdrawnUsd - depositedUsd
  return {
    claimed0: cf.claimed0,
    claimed1: cf.claimed1,
    claimedFeesUsd,
    totalFeesUsd,
    costBasisUsd,
    pnlUsd,
  }
}

export async function loadV3Positions(owner: Address): Promise<PositionRow[]> {
  const wethUsd = await getWethUsdPrice()
  const bal = await publicClient.readContract({
    address: CONTRACTS.v3Npm,
    abi: v3NpmAbi,
    functionName: 'balanceOf',
    args: [owner],
  })
  const n = Number(bal)
  const rows: PositionRow[] = []
  for (let i = 0; i < n; i++) {
    const tokenId = await publicClient.readContract({
      address: CONTRACTS.v3Npm,
      abi: v3NpmAbi,
      functionName: 'tokenOfOwnerByIndex',
      args: [owner, BigInt(i)],
    })
    const pos = await publicClient.readContract({
      address: CONTRACTS.v3Npm,
      abi: v3NpmAbi,
      functionName: 'positions',
      args: [tokenId],
    })
    const [, , token0Addr, token1Addr, fee, tickLower, tickUpper, liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1] = pos
    if (liquidity === 0n && tokensOwed0 === 0n && tokensOwed1 === 0n) continue
    const poolAddr = await findV3Pool(token0Addr, token1Addr, fee)
    if (!poolAddr) continue
    const pool = await loadV3Pool(poolAddr)
    const { amount0, amount1 } = getAmountsForPosition(pool.sqrtPriceX96, tickLower, tickUpper, liquidity)
    const { fees0, fees1 } = await computeV3Fees({
      pool: poolAddr,
      tick: pool.tick,
      tickLower,
      tickUpper,
      liquidity,
      feeGrowthInside0LastX128,
      feeGrowthInside1LastX128,
      tokensOwed0,
      tokensOwed1,
    })
    const usd = enrichUsd(amount0, amount1, fees0, fees1, pool, wethUsd)
    const cf = await loadPositionCashflow(tokenId)
    const pnl = enrichPnl(pool, wethUsd, usd.amount0Usd + usd.amount1Usd, usd.fees0Usd + usd.fees1Usd, cf)
    rows.push({
      version: 'v3',
      tokenId,
      token0: pool.token0,
      token1: pool.token1,
      fee,
      tickLower,
      tickUpper,
      liquidity,
      tick: pool.tick,
      inRange: pool.tick >= tickLower && pool.tick < tickUpper,
      priceLower: tickToPrice(tickLower, pool.token0.decimals, pool.token1.decimals),
      priceUpper: tickToPrice(tickUpper, pool.token0.decimals, pool.token1.decimals),
      price: pool.price,
      amount0,
      amount1,
      fees0,
      fees1,
      ...usd,
      ...pnl,
      poolAddress: poolAddr,
      tickSpacing: pool.tickSpacing,
      sqrtPriceX96: pool.sqrtPriceX96,
    })
  }
  return rows
}

export async function loadV4Positions(owner: Address): Promise<PositionRow[]> {
  try {
    const wethUsd = await getWethUsdPrice()
    const bal = await publicClient.readContract({
      address: CONTRACTS.v4PositionManager,
      abi: v4PositionManagerAbi,
      functionName: 'balanceOf',
      args: [owner],
    })
    const n = Number(bal)
    const rows: PositionRow[] = []
    for (let i = 0; i < n; i++) {
      const tokenId = await publicClient.readContract({
        address: CONTRACTS.v4PositionManager,
        abi: v4PositionManagerAbi,
        functionName: 'tokenOfOwnerByIndex',
        args: [owner, BigInt(i)],
      })
      const [poolKey, info] = await publicClient.readContract({
        address: CONTRACTS.v4PositionManager,
        abi: v4PositionManagerAbi,
        functionName: 'getPoolAndPositionInfo',
        args: [tokenId],
      })
      const liquidity = await publicClient.readContract({
        address: CONTRACTS.v4PositionManager,
        abi: v4PositionManagerAbi,
        functionName: 'getPositionLiquidity',
        args: [tokenId],
      })
      if (liquidity === 0n) continue
      const { tickLower, tickUpper } = decodeV4PositionInfo(info)
      const pool = await loadV4Pool({
        currency0: poolKey.currency0,
        currency1: poolKey.currency1,
        fee: poolKey.fee,
        tickSpacing: poolKey.tickSpacing,
        hooks: poolKey.hooks,
      })
      const { amount0, amount1 } = getAmountsForPosition(pool.sqrtPriceX96, tickLower, tickUpper, liquidity)
      const fees0 = 0n
      const fees1 = 0n
      const usd = enrichUsd(amount0, amount1, fees0, fees1, pool, wethUsd)
      rows.push({
        version: 'v4',
        tokenId,
        token0: pool.token0,
        token1: pool.token1,
        fee: poolKey.fee,
        tickLower,
        tickUpper,
        liquidity,
        tick: pool.tick,
        inRange: pool.tick >= tickLower && pool.tick < tickUpper,
        priceLower: tickToPrice(tickLower, pool.token0.decimals, pool.token1.decimals),
        priceUpper: tickToPrice(tickUpper, pool.token0.decimals, pool.token1.decimals),
        price: pool.price,
        amount0,
        amount1,
        fees0,
        fees1,
        ...usd,
        claimed0: 0n,
        claimed1: 0n,
        claimedFeesUsd: 0,
        totalFeesUsd: usd.fees0Usd + usd.fees1Usd,
        costBasisUsd: usd.amount0Usd + usd.amount1Usd,
        pnlUsd: 0,
        poolId: pool.poolId,
        tickSpacing: poolKey.tickSpacing,
        hooks: poolKey.hooks,
        sqrtPriceX96: pool.sqrtPriceX96,
      })
    }
    return rows
  } catch (e) {
    console.warn('V4 positions load failed', e)
    return []
  }
}

async function ensureAllowance(
  walletClient: WalletClient,
  token: Address,
  owner: Address,
  spender: Address,
  amount: bigint,
) {
  if (amount === 0n) return
  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  })
  if (allowance >= amount) return
  // 默认无限授权，避免每次加仓都再签一次 approve
  const MAX_UINT256 = 2n ** 256n - 1n
  const hash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, MAX_UINT256],
    chain: walletClient.chain,
    account: owner,
  })
  await publicClient.waitForTransactionReceipt({ hash })
}

function isWeth(addr: Address) {
  return addr.toLowerCase() === CONTRACTS.weth.toLowerCase()
}

function isNativeEth(addr: Address) {
  return addr.toLowerCase() === '0x0000000000000000000000000000000000000000'
}

export function pairHasWeth(token0: Address, token1: Address) {
  return isWeth(token0) || isWeth(token1) || isNativeEth(token0) || isNativeEth(token1)
}

function friendlyTxError(e: unknown, action: string): string {
  const raw = e instanceof Error ? e.message : String(e)
  const lower = raw.toLowerCase()
  if (lower.includes('slippage') || lower.includes('price slippage') || lower.includes('stf') || lower.includes('too little')) {
    return `${action} 失败：滑点保护触发。把顶部滑点调到 5%–10% 再试；若刚配对完数量，也可点一次刷新池价后重新输入。`
  }
  if (lower.includes('insufficient') && (lower.includes('fund') || lower.includes('balance'))) {
    return `${action} 失败：余额不足（用 ETH 组仓时 value + gas 都要从 ETH 扣）。`
  }
  if (lower.includes('user rejected') || lower.includes('denied')) {
    return `${action} 已取消`
  }
  if (lower.includes('allowance') || lower.includes('transfer amount exceeds') || lower.includes('exceeds balance')) {
    return `${action} 失败：代币余额不足或授权未生效。`
  }
  if (lower.includes('execution reverted') || lower.includes('estimate')) {
    return `${action} 失败：链上预检未通过（常见：数量比例与现价不符、滑点过紧、或 ETH 不够）。请重新输入一边数量自动配对，滑点调到 5%+ 后再试。原文：${raw.slice(0, 160)}`
  }
  return `${action} 失败：${raw.slice(0, 220)}`
}

async function writeMintOrIncrease(opts: {
  walletClient: WalletClient
  owner: Address
  functionName: 'mint' | 'increaseLiquidity'
  args: readonly unknown[]
  value: bigint
  action: string
}) {
  const { walletClient, owner, functionName, args, value, action } = opts
  const data = encodeFunctionData({
    abi: v3NpmAbi,
    functionName,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: args as any,
  })

  // 先在本地估 gas：失败就不弹钱包（避免 Rabby 确认键灰掉、费用显示 --）
  let gas: bigint
  try {
    gas = await publicClient.estimateGas({
      account: owner,
      to: CONTRACTS.v3Npm,
      data,
      value: value > 0n ? value : undefined,
    })
  } catch (e) {
    throw new Error(friendlyTxError(e, action))
  }
  const gasWithBuffer = (gas * 130n) / 100n

  // 直接调 mint/increaseLiquidity（带 value），避免 multicall 被 Rabby 标成「未知交易类型」
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hash = await walletClient.writeContract({
    address: CONTRACTS.v3Npm,
    abi: v3NpmAbi,
    functionName,
    args: args as any,
    value: value > 0n ? value : undefined,
    gas: gasWithBuffer,
    chain: walletClient.chain,
    account: owner,
  })

  // 退回多余 ETH（若有）
  if (value > 0n) {
    await publicClient.waitForTransactionReceipt({ hash })
    try {
      const refundGas = await publicClient.estimateGas({
        account: owner,
        to: CONTRACTS.v3Npm,
        data: encodeFunctionData({ abi: v3NpmAbi, functionName: 'refundETH' }),
      })
      await walletClient.writeContract({
        address: CONTRACTS.v3Npm,
        abi: v3NpmAbi,
        functionName: 'refundETH',
        gas: (refundGas * 130n) / 100n,
        chain: walletClient.chain,
        account: owner,
      })
    } catch {
      /* 无多余 ETH 时可忽略 */
    }
  }

  return hash
}

export async function mintV3Position(opts: {
  walletClient: WalletClient
  owner: Address
  pool: PoolInfo
  amount0: bigint
  amount1: bigint
  percent?: number
  tickLower?: number
  tickUpper?: number
  slippageBps?: number
  /** 用原生 ETH 代替 WETH（Uniswap 同款：msg.value） */
  useNativeEth?: boolean
}) {
  const { walletClient, owner, pool, amount0, amount1 } = opts
  void opts.slippageBps
  if (pool.version !== 'v3' || !pool.poolAddress) throw new Error('需要 V3 池')
  let tickLower = opts.tickLower
  let tickUpper = opts.tickUpper
  if (tickLower == null || tickUpper == null) {
    const pct = opts.percent ?? 5
    const r = rangeFromPercent(pool.tick, pct, pool.tickSpacing)
    tickLower = r.tickLower
    tickUpper = r.tickUpper
  }
  if (tickLower >= tickUpper) throw new Error('区间无效：下限必须小于上限')
  if (tickLower % pool.tickSpacing !== 0 || tickUpper % pool.tickSpacing !== 0) {
    throw new Error(`区间 tick 未对齐 spacing=${pool.tickSpacing}`)
  }

  const live = await loadV3Pool(pool.poolAddress)
  const usePool = live

  const useNative = Boolean(opts.useNativeEth) && pairHasWeth(usePool.token0.address, usePool.token1.address)
  const wethIs0 = isWeth(usePool.token0.address)
  const wethIs1 = isWeth(usePool.token1.address)

  // 提交前用现价按单边锚点重算两边，避免 UI 截断导致 desired 比例失真 → Price slippage check
  const from0 = amount0 > 0n
    ? pairAmountForRange({
      sqrtPriceX96: usePool.sqrtPriceX96,
      tickLower,
      tickUpper,
      amount: amount0,
      side: 0,
    })
    : null
  const from1 = amount1 > 0n
    ? pairAmountForRange({
      sqrtPriceX96: usePool.sqrtPriceX96,
      tickLower,
      tickUpper,
      amount: amount1,
      side: 1,
    })
    : null

  let use0 = 0n
  let use1 = 0n
  if (from0 && from1 && from0.singleSided === 'none') {
    // 优先保留用户手填的 token1（meme），若 ETH 输入被截断则 from1.amount0 可能略大于输入框
    if (from1.amount0 <= amount0 || amount0 === 0n) {
      use0 = from1.amount0
      use1 = from1.amount1
    } else {
      use0 = from0.amount0
      use1 = from0.amount1
    }
  } else if (from1) {
    use0 = from1.amount0
    use1 = from1.amount1
  } else if (from0) {
    use0 = from0.amount0
    use1 = from0.amount1
  } else {
    throw new Error('数量不能都为 0')
  }

  if (use0 === 0n && use1 === 0n) throw new Error('当前区间下组仓数量为 0，请调整区间')

  const nativeValueFinal = useNative ? (wethIs0 ? use0 : wethIs1 ? use1 : 0n) : 0n
  if (useNative && nativeValueFinal > 0n) {
    const ethBal = await publicClient.getBalance({ address: owner })
    if (ethBal < nativeValueFinal + 10n ** 15n) {
      throw new Error(`ETH 不足：需要约 ${formatAmountExact(nativeValueFinal, 18)} ETH + gas`)
    }
  }

  if (!(useNative && wethIs0) && use0 > 0n) {
    await ensureAllowance(walletClient, usePool.token0.address, owner, CONTRACTS.v3Npm, use0)
  }
  if (!(useNative && wethIs1) && use1 > 0n) {
    await ensureAllowance(walletClient, usePool.token1.address, owner, CONTRACTS.v3Npm, use1)
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
  // 数量已与链上公式对齐：amountMin 用 0，杜绝假滑点；多余 desired 不会被多扣
  const mintArgs = [{
    token0: usePool.token0.address,
    token1: usePool.token1.address,
    fee: usePool.fee,
    tickLower,
    tickUpper,
    amount0Desired: use0,
    amount1Desired: use1,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: owner,
    deadline,
  }] as const

  try {
    const hash = await writeMintOrIncrease({
      walletClient,
      owner,
      functionName: 'mint',
      args: mintArgs,
      value: nativeValueFinal,
      action: 'Mint',
    })
    return { hash, tickLower, tickUpper, amount0: use0, amount1: use1 }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Mint')) throw e
    throw new Error(friendlyTxError(e, 'Mint'))
  }
}

export async function increaseV3Liquidity(opts: {
  walletClient: WalletClient
  owner: Address
  position: PositionRow
  amount0: bigint
  amount1: bigint
  slippageBps?: number
  useNativeEth?: boolean
}) {
  const { walletClient, owner, position, amount0, amount1, slippageBps = 300 } = opts
  if (position.version !== 'v3') throw new Error('需要 V3 仓位')
  if (amount0 === 0n && amount1 === 0n) throw new Error('数量不能都为 0')

  const useNative = Boolean(opts.useNativeEth) && pairHasWeth(position.token0.address, position.token1.address)
  const wethIs0 = isWeth(position.token0.address)
  const wethIs1 = isWeth(position.token1.address)
  const nativeValue = useNative ? (wethIs0 ? amount0 : wethIs1 ? amount1 : 0n) : 0n

  if (useNative && nativeValue > 0n) {
    const ethBal = await publicClient.getBalance({ address: owner })
    if (ethBal < nativeValue + 10n ** 15n) {
      throw new Error('ETH 余额不足以支付加仓金额 + gas')
    }
  }

  if (!(useNative && wethIs0) && amount0 > 0n) {
    await ensureAllowance(walletClient, position.token0.address, owner, CONTRACTS.v3Npm, amount0)
  }
  if (!(useNative && wethIs1) && amount1 > 0n) {
    await ensureAllowance(walletClient, position.token1.address, owner, CONTRACTS.v3Npm, amount1)
  }

  const effectiveSlip = Math.max(slippageBps, 100)
  const amount0Min = 0n
  const amount1Min = 0n
  void effectiveSlip
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
  const increaseArgs = [{
    tokenId: position.tokenId,
    amount0Desired: amount0,
    amount1Desired: amount1,
    amount0Min,
    amount1Min,
    deadline,
  }] as const

  try {
    return await writeMintOrIncrease({
      walletClient,
      owner,
      functionName: 'increaseLiquidity',
      args: increaseArgs,
      value: nativeValue,
      action: '加仓',
    })
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('加仓')) throw e
    throw new Error(friendlyTxError(e, '加仓'))
  }
}

/** Collect fees; if unwrapEth + WETH pair, collect to NPM then unwrapWETH9 → native ETH. */
export async function claimV3(opts: {
  walletClient: WalletClient
  owner: Address
  tokenId: bigint
  unwrapEth?: boolean
  token0?: Address
  token1?: Address
}) {
  const { walletClient, owner, tokenId, unwrapEth, token0, token1 } = opts
  const wantEth = Boolean(unwrapEth) && token0 && token1 && pairHasWeth(token0, token1)

  if (!wantEth) {
    const hash = await walletClient.writeContract({
      address: CONTRACTS.v3Npm,
      abi: v3NpmAbi,
      functionName: 'collect',
      args: [{
        tokenId,
        recipient: owner,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      }],
      chain: walletClient.chain,
      account: owner,
    })
    return hash
  }

  const other = isWeth(token0!) ? token1! : token0!
  const calls: `0x${string}`[] = [
    encodeFunctionData({
      abi: v3NpmAbi,
      functionName: 'collect',
      args: [{
        tokenId,
        recipient: CONTRACTS.v3Npm,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      }],
    }),
    encodeFunctionData({
      abi: v3NpmAbi,
      functionName: 'unwrapWETH9',
      args: [0n, owner],
    }),
    encodeFunctionData({
      abi: v3NpmAbi,
      functionName: 'sweepToken',
      args: [other, 0n, owner],
    }),
  ]
  const hash = await walletClient.writeContract({
    address: CONTRACTS.v3Npm,
    abi: v3NpmAbi,
    functionName: 'multicall',
    args: [calls],
    chain: walletClient.chain,
    account: owner,
  })
  return hash
}

/** Remove liquidity (partial or full) + collect. Optionally burn empty NFT when 100%. */
export async function removeV3Liquidity(opts: {
  walletClient: WalletClient
  owner: Address
  position: PositionRow
  /** 1–100, default 100 */
  percent?: number
  burnEmpty?: boolean
  slippageBps?: number
  /** WETH 侧收成原生 ETH */
  unwrapEth?: boolean
}) {
  const { walletClient, owner, position, percent = 100, burnEmpty = true, slippageBps = 50, unwrapEth } = opts
  if (position.version !== 'v3') throw new Error('需要 V3 仓位')
  const pct = Math.min(100, Math.max(1, percent))
  const liq =
    pct >= 100
      ? position.liquidity
      : (position.liquidity * BigInt(Math.floor(pct * 100))) / 10000n
  const wantEth = Boolean(unwrapEth) && pairHasWeth(position.token0.address, position.token1.address)

  if (liq === 0n && position.liquidity === 0n) {
    const hash = await claimV3({
      walletClient,
      owner,
      tokenId: position.tokenId,
      unwrapEth: wantEth,
      token0: position.token0.address,
      token1: position.token1.address,
    })
    if (burnEmpty) {
      try {
        await walletClient.writeContract({
          address: CONTRACTS.v3Npm,
          abi: v3NpmAbi,
          functionName: 'burn',
          args: [position.tokenId],
          chain: walletClient.chain,
          account: owner,
        })
      } catch {
        /* empty NFT may already be burned or have dust */
      }
    }
    return hash
  }
  if (liq === 0n) throw new Error('撤出流动性过小')

  // estimate mins from current amounts * pct * (1 - slippage)
  const est0 = (position.amount0 * BigInt(Math.floor(pct * 100))) / 10000n
  const est1 = (position.amount1 * BigInt(Math.floor(pct * 100))) / 10000n
  const amount0Min = est0 - (est0 * BigInt(slippageBps)) / 10000n
  const amount1Min = est1 - (est1 * BigInt(slippageBps)) / 10000n

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
  const collectRecipient = wantEth ? CONTRACTS.v3Npm : owner
  const calls: `0x${string}`[] = [
    encodeFunctionData({
      abi: v3NpmAbi,
      functionName: 'decreaseLiquidity',
      args: [{
        tokenId: position.tokenId,
        liquidity: liq,
        amount0Min: amount0Min > 0n ? amount0Min : 0n,
        amount1Min: amount1Min > 0n ? amount1Min : 0n,
        deadline,
      }],
    }),
    encodeFunctionData({
      abi: v3NpmAbi,
      functionName: 'collect',
      args: [{
        tokenId: position.tokenId,
        recipient: collectRecipient,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      }],
    }),
  ]
  if (wantEth) {
    const other = isWeth(position.token0.address) ? position.token1.address : position.token0.address
    calls.push(
      encodeFunctionData({
        abi: v3NpmAbi,
        functionName: 'unwrapWETH9',
        args: [0n, owner],
      }),
      encodeFunctionData({
        abi: v3NpmAbi,
        functionName: 'sweepToken',
        args: [other, 0n, owner],
      }),
    )
  }

  const hash = await walletClient.writeContract({
    address: CONTRACTS.v3Npm,
    abi: v3NpmAbi,
    functionName: 'multicall',
    args: [calls],
    chain: walletClient.chain,
    account: owner,
  })

  if (burnEmpty && pct >= 100) {
    await publicClient.waitForTransactionReceipt({ hash })
    try {
      await walletClient.writeContract({
        address: CONTRACTS.v3Npm,
        abi: v3NpmAbi,
        functionName: 'burn',
        args: [position.tokenId],
        chain: walletClient.chain,
        account: owner,
      })
    } catch {
      /* dust / already burned — ignore */
    }
  }
  return hash
}

export async function wrapEth(opts: {
  walletClient: WalletClient
  owner: Address
  amount: bigint
}) {
  const { walletClient, owner, amount } = opts
  if (amount <= 0n) throw new Error('数量必须 > 0')
  const hash = await walletClient.writeContract({
    address: CONTRACTS.weth,
    abi: erc20Abi,
    functionName: 'deposit',
    args: [],
    value: amount,
    chain: walletClient.chain,
    account: owner,
  })
  return hash
}

export async function unwrapWeth(opts: {
  walletClient: WalletClient
  owner: Address
  amount: bigint
}) {
  const { walletClient, owner, amount } = opts
  if (amount <= 0n) throw new Error('数量必须 > 0')
  const hash = await walletClient.writeContract({
    address: CONTRACTS.weth,
    abi: erc20Abi,
    functionName: 'withdraw',
    args: [amount],
    chain: walletClient.chain,
    account: owner,
  })
  return hash
}

/** Rebalance V3: decrease all + collect + mint new ±% range with collected amounts */
export async function rebalanceV3(opts: {
  walletClient: WalletClient
  owner: Address
  position: PositionRow
  percent: number
  slippageBps?: number
}) {
  const { walletClient, owner, position, percent, slippageBps = 150 } = opts
  if (position.version !== 'v3' || !position.poolAddress) throw new Error('需要 V3 仓位')
  const pool = await loadV3Pool(position.poolAddress)
  const { tickLower, tickUpper } = rangeFromPercent(pool.tick, percent, pool.tickSpacing)

  const exitHash = await removeV3Liquidity({
    walletClient,
    owner,
    position,
    percent: 100,
    burnEmpty: false,
    slippageBps,
  })
  await publicClient.waitForTransactionReceipt({ hash: exitHash })

  const [bal0, bal1] = await Promise.all([
    publicClient.readContract({ address: position.token0.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
    publicClient.readContract({ address: position.token1.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
  ])
  if (bal0 === 0n && bal1 === 0n) throw new Error('撤仓后余额为 0，无法复投')

  await ensureAllowance(walletClient, position.token0.address, owner, CONTRACTS.v3Npm, bal0)
  await ensureAllowance(walletClient, position.token1.address, owner, CONTRACTS.v3Npm, bal1)

  const amount0Min = bal0 - (bal0 * BigInt(slippageBps)) / 10000n
  const amount1Min = bal1 - (bal1 * BigInt(slippageBps)) / 10000n

  const mintHash = await walletClient.writeContract({
    address: CONTRACTS.v3Npm,
    abi: v3NpmAbi,
    functionName: 'mint',
    args: [{
      token0: position.token0.address,
      token1: position.token1.address,
      fee: position.fee,
      tickLower,
      tickUpper,
      amount0Desired: bal0,
      amount1Desired: bal1,
      amount0Min: amount0Min > 0n ? amount0Min / 2n : 0n,
      amount1Min: amount1Min > 0n ? amount1Min / 2n : 0n,
      recipient: owner,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
    }],
    chain: walletClient.chain,
    account: owner,
  })
  return { exitHash, mintHash, tickLower, tickUpper }
}

export async function claimAndCompoundV3(opts: {
  walletClient: WalletClient
  owner: Address
  position: PositionRow
}) {
  const { walletClient, owner, position } = opts
  if (position.version !== 'v3') throw new Error('需要 V3 仓位')
  const claimHash = await claimV3({ walletClient, owner, tokenId: position.tokenId })
  await publicClient.waitForTransactionReceipt({ hash: claimHash })

  const [bal0, bal1] = await Promise.all([
    publicClient.readContract({ address: position.token0.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
    publicClient.readContract({ address: position.token1.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
  ])
  // Prefer compounding only the claimed fee amounts (not entire wallet balance)
  const use0 = position.fees0 > 0n ? position.fees0 : 0n
  const use1 = position.fees1 > 0n ? position.fees1 : 0n
  const amount0 = use0 <= bal0 ? use0 : bal0
  const amount1 = use1 <= bal1 ? use1 : bal1
  if (amount0 === 0n && amount1 === 0n) return { claimHash, increaseHash: null as `0x${string}` | null }

  await ensureAllowance(walletClient, position.token0.address, owner, CONTRACTS.v3Npm, amount0)
  await ensureAllowance(walletClient, position.token1.address, owner, CONTRACTS.v3Npm, amount1)

  const increaseHash = await walletClient.writeContract({
    address: CONTRACTS.v3Npm,
    abi: v3NpmAbi,
    functionName: 'increaseLiquidity',
    args: [{
      tokenId: position.tokenId,
      amount0Desired: amount0,
      amount1Desired: amount1,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
    }],
    chain: walletClient.chain,
    account: owner,
  })
  return { claimHash, increaseHash }
}

export function ticksFromPrices(
  pool: PoolInfo,
  priceLower: number,
  priceUpper: number,
): { tickLower: number; tickUpper: number; priceLower: number; priceUpper: number } {
  if (!(priceLower > 0) || !(priceUpper > 0) || priceLower >= priceUpper) {
    throw new Error('请输入有效的价格下限 < 上限')
  }
  let tickLower = nearestUsableTick(
    priceToClosestTick(priceLower, pool.token0.decimals, pool.token1.decimals),
    pool.tickSpacing,
  )
  let tickUpper = nearestUsableTick(
    priceToClosestTick(priceUpper, pool.token0.decimals, pool.token1.decimals),
    pool.tickSpacing,
  )
  if (tickLower >= tickUpper) {
    tickUpper = tickLower + pool.tickSpacing
  }
  return {
    tickLower,
    tickUpper,
    priceLower: tickToPrice(tickLower, pool.token0.decimals, pool.token1.decimals),
    priceUpper: tickToPrice(tickUpper, pool.token0.decimals, pool.token1.decimals),
  }
}

/**
 * 界面「币价」：用 ETH 给非 ETH 代币计价。
 * 若 ETH 是 token0（池价 = 币/ETH），则币价 = 1/池价，区间换算需取反。
 */
export function getCoinQuote(pool: PoolInfo): {
  invert: boolean
  coin: TokenMeta
  quote: TokenMeta
  spot: number
} {
  const t0 = pool.token0
  const t1 = pool.token1
  const eth0 = isEthLikeCurrency(t0.address)
  const eth1 = isEthLikeCurrency(t1.address)
  if (eth0 && !eth1) {
    return {
      invert: true,
      coin: t1,
      quote: { ...t0, symbol: 'ETH' },
      spot: pool.price > 0 ? 1 / pool.price : 0,
    }
  }
  if (eth1 && !eth0) {
    return {
      invert: false,
      coin: t0,
      quote: { ...t1, symbol: 'ETH' },
      spot: pool.price,
    }
  }
  // 无 ETH：按 token1 per token0 原样
  return { invert: false, coin: t0, quote: t1, spot: pool.price }
}

export function poolPriceToCoinPrice(poolPrice: number, invert: boolean): number {
  if (!(poolPrice > 0)) return 0
  return invert ? 1 / poolPrice : poolPrice
}

export function coinPriceToPoolPrice(coinPrice: number, invert: boolean): number {
  if (!(coinPrice > 0)) throw new Error('币价必须 > 0')
  return invert ? 1 / coinPrice : coinPrice
}

/** 按「币价」相对市价的 % 设区间（用户视角；内部自动换算池方向） */
export function describeRange(pool: PoolInfo, percentLower: number, percentUpper?: number) {
  const quote = getCoinQuote(pool)
  let loPct: number
  let hiPct: number
  if (percentUpper === undefined) {
    const p = Math.min(Math.max(Math.abs(Number(percentLower) || 5), 0.01), 99.9)
    loPct = -p
    hiPct = p
  } else {
    loPct = Number(percentLower)
    hiPct = Number(percentUpper)
    if (!Number.isFinite(loPct)) loPct = -5
    if (!Number.isFinite(hiPct)) hiPct = 5
  }
  loPct = Math.min(Math.max(loPct, -99.9), 1_000_000)
  hiPct = Math.min(Math.max(hiPct, -99.9), 1_000_000)
  if (hiPct <= loPct) hiPct = Math.min(loPct + 0.01, 1_000_000)

  if (!(quote.spot > 0)) throw new Error('无法读取币价')
  const coinLo = quote.spot * (1 + loPct / 100)
  const coinHi = quote.spot * (1 + hiPct / 100)
  if (!(coinLo > 0) || !(coinHi > coinLo)) throw new Error('币价区间无效')

  const pLo = coinPriceToPoolPrice(coinLo, quote.invert)
  const pHi = coinPriceToPoolPrice(coinHi, quote.invert)
  const sortedLo = Math.min(pLo, pHi)
  const sortedHi = Math.max(pLo, pHi)

  const t = ticksFromPrices(pool, sortedLo, sortedHi)
  const coinPriceLower = poolPriceToCoinPrice(t.priceLower, quote.invert)
  const coinPriceUpper = poolPriceToCoinPrice(t.priceUpper, quote.invert)
  const displayLo = Math.min(coinPriceLower, coinPriceUpper)
  const displayHi = Math.max(coinPriceLower, coinPriceUpper)
  return {
    tickLower: t.tickLower,
    tickUpper: t.tickUpper,
    priceLower: t.priceLower,
    priceUpper: t.priceUpper,
    coinPriceLower: displayLo,
    coinPriceUpper: displayHi,
    coinSpot: quote.spot,
    coinSymbol: quote.coin.symbol,
    quoteSymbol: quote.quote.symbol,
    invert: quote.invert,
    inRangePreview: pool.tick >= t.tickLower && pool.tick < t.tickUpper,
  }
}

/** 自定义币价上下限 → ticks */
export function ticksFromCoinPrices(pool: PoolInfo, coinLower: number, coinUpper: number) {
  if (!(coinLower > 0) || !(coinUpper > 0) || coinLower >= coinUpper) {
    throw new Error('请输入有效的币价下限 < 上限')
  }
  const quote = getCoinQuote(pool)
  const pLo = coinPriceToPoolPrice(coinLower, quote.invert)
  const pHi = coinPriceToPoolPrice(coinUpper, quote.invert)
  const sortedLo = Math.min(pLo, pHi)
  const sortedHi = Math.max(pLo, pHi)
  const t = ticksFromPrices(pool, sortedLo, sortedHi)
  const coinPriceLower = poolPriceToCoinPrice(t.priceLower, quote.invert)
  const coinPriceUpper = poolPriceToCoinPrice(t.priceUpper, quote.invert)
  return {
    ...t,
    coinPriceLower: Math.min(coinPriceLower, coinPriceUpper),
    coinPriceUpper: Math.max(coinPriceLower, coinPriceUpper),
    coinSpot: quote.spot,
    coinSymbol: quote.coin.symbol,
    quoteSymbol: quote.quote.symbol,
    invert: quote.invert,
    inRangePreview: pool.tick >= t.tickLower && pool.tick < t.tickUpper,
  }
}

export { formatAmount, formatAmountExact, rangeFromPercent }

registerV4Deps({ loadV4Pool, wrapEth })
