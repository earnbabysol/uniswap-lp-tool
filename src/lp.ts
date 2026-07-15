import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  encodeAbiParameters,
  encodePacked,
  getContractAddress,
  keccak256,
  parseAbiItem,
  encodeEventTopics,
  decodeAbiParameters,
  isAddress,
  type Address,
  type WalletClient,
  type Hash,
} from 'viem'
import { CONTRACTS, FEE_TIERS, KNOWN_TOKENS, V3_POOL_INIT_CODE_HASH } from './chain'
import { erc20Abi, v3FactoryAbi, v3NpmAbi, v3PoolAbi, v4PositionManagerAbi, v4StateViewAbi } from './abis'
import {
  decodeV4PositionInfo,
  poolIdPrefixFromV4Info,
  formatAmount,
  formatAmountExact,
  getAmountsForPosition,
  MAX_UINT128,
  mulDiv,
  Q128,
  fullRangeTicks,
  nearestUsableTick,
  pairAmountForRange,
  priceToClosestTick,
  priceToSqrtPriceX96,
  rangeFromPercent,
  rawToNumber,
  tickToPrice,
} from './math'
import { fetchJson, withTimeout } from './async'
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
  createV4PoolAndSeed,
  suggestV4TickSpacing,
  v4SpacingsForFee,
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
  createV4PoolAndSeed,
  suggestV4TickSpacing,
  v4SpacingsForFee,
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
  /** 历史已领手续费（含复投后重新加仓的部分；high-water 本地缓存） */
  claimed0: bigint
  claimed1: bigint
  claimedFeesUsd: number
  /** 累计手续费 = 未领 + 已领/复投 */
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

/** 缓存池子静态元数据，刷新时只重读 slot0/liquidity */
const v3PoolMetaCache = new Map<string, {
  token0: TokenMeta
  token1: TokenMeta
  fee: number
  tickSpacing: number
}>()

export async function loadV3Pool(poolAddress: Address): Promise<PoolInfo> {
  const key = poolAddress.toLowerCase()
  let meta = v3PoolMetaCache.get(key)
  if (!meta) {
    const [token0Addr, token1Addr, fee, tickSpacing] = await Promise.all([
      publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'token0' }),
      publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'token1' }),
      publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'fee' }),
      publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'tickSpacing' }),
    ])
    const [token0, token1] = await Promise.all([resolveToken(token0Addr), resolveToken(token1Addr)])
    meta = { token0, token1, fee, tickSpacing }
    v3PoolMetaCache.set(key, meta)
  }
  const [slot0, liquidity] = await Promise.all([
    publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'slot0' }),
    publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: 'liquidity' }),
  ])
  const sqrtPriceX96 = slot0[0]
  const tick = slot0[1]
  return {
    version: 'v3',
    poolAddress,
    token0: meta.token0,
    token1: meta.token1,
    fee: meta.fee,
    tickSpacing: meta.tickSpacing,
    tick,
    sqrtPriceX96,
    price:
      sqrtPriceX96 > 0n
        ? tickToPrice(tick, meta.token0.decimals, meta.token1.decimals)
        : 0,
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

/** 预测 V3 池 CREATE2 地址（用于创建+mint 同笔 multicall） */
export function predictV3PoolAddress(token0: Address, token1: Address, fee: number): Address {
  const [t0, t1] = sortTokenAddresses(token0, token1)
  const salt = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }],
      [t0, t1, fee],
    ),
  )
  return getContractAddress({
    from: CONTRACTS.v3Factory,
    opcode: 'CREATE2',
    bytecodeHash: V3_POOL_INIT_CODE_HASH,
    salt,
  })
}

/**
 * 创建并初始化 V3 池；若给了 amount 则同笔 multicall 注入首仓（createAndInitialize + mint）。
 */
export async function createV3PoolAndSeed(opts: {
  walletClient: WalletClient
  owner: Address
  tokenA: Address
  tokenB: Address
  fee: number
  initialPriceBPerA: number
  amount0?: bigint
  amount1?: bigint
  tickLower?: number
  tickUpper?: number
  useNativeEth?: boolean
  onStatus?: (msg: string) => void
}): Promise<{ pool: PoolInfo; hash: `0x${string}` | null; created: boolean; seeded: boolean }> {
  const { walletClient, owner, tokenA, tokenB, fee, initialPriceBPerA, onStatus } = opts
  const wantSeed = (opts.amount0 ?? 0n) > 0n || (opts.amount1 ?? 0n) > 0n

  if (!wantSeed) {
    const r = await createV3Pool({
      walletClient,
      owner,
      tokenA,
      tokenB,
      fee,
      initialPriceBPerA,
    })
    return { ...r, seeded: false }
  }

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
  const initTick = priceToClosestTick(sortedPrice, token0.decimals, token1.decimals)

  let tickLower = opts.tickLower
  let tickUpper = opts.tickUpper
  if (tickLower == null || tickUpper == null) {
    const r = rangeFromPercent(initTick, 5, spacing)
    tickLower = r.tickLower
    tickUpper = r.tickUpper
  }
  tickLower = nearestUsableTick(tickLower, spacing)
  tickUpper = nearestUsableTick(tickUpper, spacing)
  if (tickLower >= tickUpper) throw new Error('区间无效')

  let amount0 = opts.amount0 ?? 0n
  let amount1 = opts.amount1 ?? 0n
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

  const useNative = Boolean(opts.useNativeEth) && pairHasWeth(token0Addr, token1Addr)
  const poolAddr = predictV3PoolAddress(token0Addr, token1Addr, fee)

  // 授权（非原生侧）
  if (!(useNative && isWeth(token0Addr)) && amount0 > 0n) {
    await ensureAllowance(walletClient, token0Addr, owner, CONTRACTS.v3Npm, amount0, onStatus)
  }
  if (!(useNative && isWeth(token1Addr)) && amount1 > 0n) {
    await ensureAllowance(walletClient, token1Addr, owner, CONTRACTS.v3Npm, amount1, onStatus)
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
  const amount0Min = 0n
  const amount1Min = 0n
  const createData = encodeFunctionData({
    abi: v3NpmAbi,
    functionName: 'createAndInitializePoolIfNecessary',
    args: [token0Addr, token1Addr, fee, sqrtPriceX96],
  })
  const mintData = encodeFunctionData({
    abi: v3NpmAbi,
    functionName: 'mint',
    args: [{
      token0: token0Addr,
      token1: token1Addr,
      fee,
      tickLower,
      tickUpper,
      amount0Desired: amount0,
      amount1Desired: amount1,
      amount0Min,
      amount1Min,
      recipient: owner,
      deadline,
    }],
  })

  let value = 0n
  if (useNative && isWeth(token0Addr)) value = amount0
  if (useNative && isWeth(token1Addr)) value = amount1

  onStatus?.('创建 V3 池并注入流动性…')
  const data = encodeFunctionData({
    abi: v3NpmAbi,
    functionName: 'multicall',
    args: [[createData, mintData]],
  })
  let gas: bigint
  try {
    gas = await publicClient.estimateGas({
      account: owner,
      to: CONTRACTS.v3Npm,
      data,
      value: value > 0n ? value : undefined,
    })
  } catch (e) {
    // 若 multicall 失败（例如池已存在），降级：先 create 再 mint
    onStatus?.('同笔创建失败，改为分步…')
    const created = await createV3Pool({
      walletClient,
      owner,
      tokenA,
      tokenB,
      fee,
      initialPriceBPerA,
    })
    const mintHash = await mintV3Position({
      walletClient,
      owner,
      pool: created.pool,
      amount0,
      amount1,
      tickLower,
      tickUpper,
      useNativeEth: useNative,
      onStatus,
    })
    return {
      pool: await loadV3Pool(created.pool.poolAddress!),
      hash: mintHash,
      created: created.created,
      seeded: true,
    }
  }

  const hash = await walletClient.writeContract({
    address: CONTRACTS.v3Npm,
    abi: v3NpmAbi,
    functionName: 'multicall',
    args: [[createData, mintData]],
    value: value > 0n ? value : undefined,
    gas: (gas * 130n) / 100n,
    chain: walletClient.chain,
    account: owner,
  })
  await publicClient.waitForTransactionReceipt({ hash })
  void poolAddr
  const pool = await loadV3Pool(
    (await findV3Pool(token0Addr, token1Addr, fee)) ?? predictV3PoolAddress(token0Addr, token1Addr, fee),
  )
  return { pool, hash, created: true, seeded: true }
}


/** V4 PositionManager: salt = bytes32(tokenId), owner = PositionManager */
export function v4PositionKey(
  positionManager: Address,
  tickLower: number,
  tickUpper: number,
  tokenId: bigint,
): `0x${string}` {
  const salt = `0x${tokenId.toString(16).padStart(64, '0')}` as `0x${string}`
  return keccak256(
    encodePacked(
      ['address', 'int24', 'int24', 'bytes32'],
      [positionManager, tickLower, tickUpper, salt],
    ),
  )
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

/** 从地址 / poolId / 浏览器或 Uniswap 链接里提取 V3 地址或 V4 poolId */
export function parsePoolInput(raw: string): { kind: 'v3'; address: Address } | { kind: 'v4'; poolId: `0x${string}` } | null {
  const s = raw.trim()
  if (!s) return null
  const matches = [...s.matchAll(/0x([a-fA-F0-9]{40}|[a-fA-F0-9]{64})\b/g)]
  const as64 = matches.map((m) => m[0]).find((h) => h.length === 66)
  const as40 = matches.map((m) => m[0]).find((h) => h.length === 42)
  // 链接里常同时带合约地址与 poolId：优先 V4 poolId
  if (as64) return { kind: 'v4', poolId: as64.toLowerCase() as `0x${string}` }
  if (as40 && isAddress(as40)) return { kind: 'v3', address: as40 as Address }
  const bare = s.replace(/^0x/i, '')
  if (/^[a-fA-F0-9]{64}$/.test(bare)) return { kind: 'v4', poolId: (`0x${bare.toLowerCase()}`) as `0x${string}` }
  if (/^[a-fA-F0-9]{40}$/.test(bare) && isAddress(`0x${bare}`)) {
    return { kind: 'v3', address: (`0x${bare}`) as Address }
  }
  return null
}

const V4_INITIALIZE = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
)

async function resolveV4PoolKeyFromId(poolId: `0x${string}`): Promise<{
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}> {
  const id = poolId.toLowerCase() as `0x${string}`

  try {
    const logs = await publicClient.getLogs({
      address: CONTRACTS.v4PoolManager,
      event: V4_INITIALIZE,
      args: { id },
      fromBlock: 0n,
      toBlock: 'latest',
    })
    if (logs.length) {
      const log = logs[0]
      return {
        currency0: log.args.currency0 as Address,
        currency1: log.args.currency1 as Address,
        fee: Number(log.args.fee),
        tickSpacing: Number(log.args.tickSpacing),
        hooks: log.args.hooks as Address,
      }
    }
  } catch (e) {
    console.warn('RPC V4 Initialize lookup failed', e)
  }

  // Blockscout module=logs 备用
  try {
    const topics = encodeEventTopics({
      abi: [V4_INITIALIZE],
      eventName: 'Initialize',
      args: { id },
    })
    const t0 = topics[0]
    const t1 = topics[1]
    if (t0 && t1) {
      const res = await fetch(
        `https://robinhoodchain.blockscout.com/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest` +
          `&address=${CONTRACTS.v4PoolManager}&topic0=${t0}&topic1=${t1}&topic0_1_opr=and`,
      )
      if (res.ok) {
        const json = (await res.json()) as {
          status?: string
          result?: Array<{ data: string; topics: string[] }>
        }
        if (json.status === '1' && json.result?.length) {
          const log = json.result[0]
          const decoded = decodeAbiParameters(
            [
              { type: 'uint24' },
              { type: 'int24' },
              { type: 'address' },
              { type: 'uint160' },
              { type: 'int24' },
            ],
            log.data as `0x${string}`,
          )
          return {
            currency0: (`0x${log.topics[2].slice(-40)}`) as Address,
            currency1: (`0x${log.topics[3].slice(-40)}`) as Address,
            fee: Number(decoded[0]),
            tickSpacing: Number(decoded[1]),
            hooks: decoded[2] as Address,
          }
        }
      }
    }
  } catch (e) {
    console.warn('Blockscout V4 Initialize lookup failed', e)
  }

  throw new Error('未找到该 V4 poolId（检查链接/Id 是否来自 Robinhood Chain）')
}

export async function loadV4PoolById(poolId: `0x${string}`): Promise<PoolInfo> {
  const key = await resolveV4PoolKeyFromId(poolId)
  const pool = await loadV4Pool(key)
  if (pool.poolId?.toLowerCase() !== poolId.toLowerCase()) {
    throw new Error('poolId 与还原的 PoolKey 不匹配')
  }
  if (!(pool.sqrtPriceX96 > 0n)) throw new Error('该 V4 池尚未初始化')
  return pool
}

/** 粘贴 V3 池地址、V4 poolId，或含二者的链接 */
export async function loadPoolFromInput(raw: string): Promise<PoolInfo> {
  const parsed = parsePoolInput(raw)
  if (!parsed) throw new Error('请粘贴 V3 池地址、V4 poolId，或含二者的链接')
  if (parsed.kind === 'v3') return loadV3Pool(parsed.address)
  return loadV4PoolById(parsed.poolId)
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
    price:
      sqrtPriceX96 > 0n
        ? tickToPrice(tick, token0.decimals, token1.decimals)
        : 0,
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

function clampUsd(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0
  if (n > 1e11) return 0 // > $100B 视为计价异常
  return n
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
  if (amount === 0n) return 0
  // 未领取手续费/数量不可能超过 ~1e12 枚（人类单位），超过即 feeGrowth 算炸
  const maxWhole = 10n ** 12n
  if (amount / (10n ** BigInt(Math.max(0, decimals))) > maxWhole) return 0

  const qty = rawToNumber(amount, decimals)
  if (!Number.isFinite(qty) || qty < 0) return 0
  if (!(wethUsd > 0) || !Number.isFinite(wethUsd)) wethUsd = 0

  const addr = address.toLowerCase()
  const t0 = token0.toLowerCase()
  const t1 = token1.toLowerCase()
  const eth0 = isEthLikeCurrency(token0)
  const eth1 = isEthLikeCurrency(token1)
  const usdg0 = t0 === CONTRACTS.usdg.toLowerCase()
  const usdg1 = t1 === CONTRACTS.usdg.toLowerCase()
  const isEth = isEthLikeCurrency(address)
  const isUsdg = addr === CONTRACTS.usdg.toLowerCase()

  if (!(poolPriceToken1PerToken0 > 0) || !Number.isFinite(poolPriceToken1PerToken0)) {
    if (isUsdg) return clampUsd(qty)
    if (isEth && wethUsd > 0) return clampUsd(qty * wethUsd)
    return 0
  }

  let usd = 0
  if (isUsdg) {
    usd = qty
  } else if (isEth && wethUsd > 0) {
    usd = qty * wethUsd
  } else if (eth0 && addr === t1 && wethUsd > 0) {
    // price = token1 per ETH → 1 token1 = wethUsd / price
    usd = qty * (wethUsd / poolPriceToken1PerToken0)
  } else if (eth1 && addr === t0 && wethUsd > 0) {
    // price = ETH per token0 → token0 值 = qty * price * ethUsd
    usd = qty * poolPriceToken1PerToken0 * wethUsd
  } else if (usdg0 && addr === t1) {
    // price = token1 per USDG → 1 token1 = 1/price USD
    usd = qty / poolPriceToken1PerToken0
  } else if (usdg1 && addr === t0) {
    // price = USDG per token0
    usd = qty * poolPriceToken1PerToken0
  } else if (addr === t0) {
    const inToken1 = qty * poolPriceToken1PerToken0
    if (usdg1) usd = inToken1
    else if (eth1 && wethUsd > 0) usd = inToken1 * wethUsd
  } else if (addr === t1) {
    if (eth0 && wethUsd > 0) usd = (qty / poolPriceToken1PerToken0) * wethUsd
    else if (usdg0) usd = qty / poolPriceToken1PerToken0
  }
  return clampUsd(usd)
}

/**
 * 未领手续费：先模拟 decreaseLiquidity(0)+collect（最准），
 * 失败再回退 feeGrowth 计算。仅 tokensOwed 不会随交易增长。
 */
async function _readV3UnclaimedFees(
  tokenId: bigint,
  owner: Address,
  fallback: () => Promise<{ fees0: bigint; fees1: bigint }>,
): Promise<{ fees0: bigint; fees1: bigint }> {
  try {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
    const decData = encodeFunctionData({
      abi: v3NpmAbi,
      functionName: 'decreaseLiquidity',
      args: [{ tokenId, liquidity: 0n, amount0Min: 0n, amount1Min: 0n, deadline }],
    })
    const colData = encodeFunctionData({
      abi: v3NpmAbi,
      functionName: 'collect',
      args: [{ tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
    })
    const { result } = await publicClient.simulateContract({
      address: CONTRACTS.v3Npm,
      abi: v3NpmAbi,
      functionName: 'multicall',
      args: [[decData, colData]],
      account: owner,
    })
    if (!result?.[1]) throw new Error('empty multicall result')
    const decoded = decodeFunctionResult({
      abi: v3NpmAbi,
      functionName: 'collect',
      data: result[1],
    })
    const fees0 = decoded[0] as bigint
    const fees1 = decoded[1] as bigint
    if (fees0 < 0n || fees1 < 0n || fees0 > MAX_UINT128 || fees1 > MAX_UINT128) {
      throw new Error('insane collect amounts')
    }
    return { fees0, fees1 }
  } catch (e) {
    console.warn('simulate collect fees failed', tokenId.toString(), e)
    return fallback()
  }
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

  let fees0 = mulDiv(liquidity, delta0, Q128) + tokensOwed0
  let fees1 = mulDiv(liquidity, delta1, Q128) + tokensOwed1
  // feeGrowth 在未初始化 tick / 异常池上会算出天文数字；回退到 tokensOwed
  const sane = (v: bigint) => v <= MAX_UINT128 && v >= 0n
  if (!sane(fees0) || !sane(fees1)) {
    return { fees0: tokensOwed0, fees1: tokensOwed1 }
  }
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
  let fees0Usd = tokenUsd(pool.token0.address, fees0, pool.token0.decimals, pool.price, pool.token0.address, pool.token1.address, wethUsd)
  let fees1Usd = tokenUsd(pool.token1.address, fees1, pool.token1.decimals, pool.price, pool.token0.address, pool.token1.address, wethUsd)
  const principal = amount0Usd + amount1Usd
  // 仅拦截天文数字 USD（feeGrowth 算炸）；勿用相对本金阈值，否则小本金仓位手续费会被清零
  if (fees0Usd + fees1Usd > 1e9) {
    fees0Usd = 0
    fees1Usd = 0
  }
  const totalUsd = clampUsd(principal + fees0Usd + fees1Usd)
  const pct0 = principal > 0 ? (amount0Usd / principal) * 100 : 50
  const pct1 = principal > 0 ? (amount1Usd / principal) * 100 : 50
  return { amount0Usd, amount1Usd, fees0Usd, fees1Usd, totalUsd, pct0, pct1 }
}

async function computeV4Fees(opts: {
  poolId: `0x${string}`
  tokenId: bigint
  tickLower: number
  tickUpper: number
  liquidity: bigint
}): Promise<{ fees0: bigint; fees1: bigint }> {
  const { poolId, tokenId, tickLower, tickUpper, liquidity } = opts
  if (liquidity === 0n) return { fees0: 0n, fees1: 0n }

  const positionId = v4PositionKey(CONTRACTS.v4PositionManager, tickLower, tickUpper, tokenId)
  const sub = (a: bigint, b: bigint) => ((a - b) & ((1n << 256n) - 1n))

  try {
    const [posInfo, feeGrowthInside] = await Promise.all([
      publicClient.readContract({
        address: CONTRACTS.v4StateView,
        abi: v4StateViewAbi,
        functionName: 'getPositionInfo',
        args: [poolId, positionId],
      }),
      publicClient.readContract({
        address: CONTRACTS.v4StateView,
        abi: v4StateViewAbi,
        functionName: 'getFeeGrowthInside',
        args: [poolId, tickLower, tickUpper],
      }),
    ])
    const [, feeGrowthInside0LastX128, feeGrowthInside1LastX128] = posInfo
    const [feeGrowthInside0X128, feeGrowthInside1X128] = feeGrowthInside
    const delta0 = sub(feeGrowthInside0X128, feeGrowthInside0LastX128)
    const delta1 = sub(feeGrowthInside1X128, feeGrowthInside1LastX128)
    let fees0 = mulDiv(liquidity, delta0, Q128)
    let fees1 = mulDiv(liquidity, delta1, Q128)
    const sane = (v: bigint) => v <= MAX_UINT128 && v >= 0n
    if (!sane(fees0)) fees0 = 0n
    if (!sane(fees1)) fees1 = 0n
    return { fees0, fees1 }
  } catch (e) {
    console.warn('computeV4Fees failed', tokenId.toString(), e)
    return { fees0: 0n, fees1: 0n }
  }
}

type Cashflow = {
  deposited0: bigint
  deposited1: bigint
  withdrawn0: bigint
  withdrawn1: bigint
  claimed0: bigint
  claimed1: bigint
}

const FEE_CACHE_KEY = 'uniswap-lp-lifetime-fees-v1'

type FeeCacheEntry = {
  claimed0: string
  claimed1: string
  claimedFeesUsd: number
  updatedAt: number
}

function readFeeCache(): Record<string, FeeCacheEntry> {
  try {
    const raw = localStorage.getItem(FEE_CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, FeeCacheEntry>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeFeeCacheEntry(key: string, entry: FeeCacheEntry) {
  try {
    const all = readFeeCache()
    const prev = all[key]
    // 只升不降：复投后链上「在外余额」为 0 也不能把历史已领清零
    if (
      prev
      && BigInt(prev.claimed0) >= BigInt(entry.claimed0)
      && BigInt(prev.claimed1) >= BigInt(entry.claimed1)
      && prev.claimedFeesUsd >= entry.claimedFeesUsd
    ) {
      return
    }
    all[key] = {
      claimed0: (prev && BigInt(prev.claimed0) > BigInt(entry.claimed0) ? prev.claimed0 : entry.claimed0),
      claimed1: (prev && BigInt(prev.claimed1) > BigInt(entry.claimed1) ? prev.claimed1 : entry.claimed1),
      claimedFeesUsd: Math.max(prev?.claimedFeesUsd ?? 0, entry.claimedFeesUsd),
      updatedAt: Date.now(),
    }
    localStorage.setItem(FEE_CACHE_KEY, JSON.stringify(all))
  } catch {
    /* private mode */
  }
}

function mergeCachedLifetimeFees(row: PositionRow, unclaimedFeesUsd: number): PositionRow {
  const key = `${row.version}-${row.tokenId.toString()}`
  const cached = readFeeCache()[key]
  if (!cached) return row
  const c0 = BigInt(cached.claimed0)
  const c1 = BigInt(cached.claimed1)
  const claimed0 = c0 > row.claimed0 ? c0 : row.claimed0
  const claimed1 = c1 > row.claimed1 ? c1 : row.claimed1
  const claimedFeesUsd = Math.max(cached.claimedFeesUsd, row.claimedFeesUsd)
  return {
    ...row,
    claimed0,
    claimed1,
    claimedFeesUsd: clampUsd(claimedFeesUsd),
    totalFeesUsd: clampUsd(unclaimedFeesUsd + claimedFeesUsd),
  }
}

function persistLifetimeFees(row: PositionRow) {
  writeFeeCacheEntry(`${row.version}-${row.tokenId.toString()}`, {
    claimed0: row.claimed0.toString(),
    claimed1: row.claimed1.toString(),
    claimedFeesUsd: row.claimedFeesUsd,
    updatedAt: Date.now(),
  })
}

/** 分块拉日志，避免 fromBlock=0 一次扫挂死 */
async function getLogsChunked<T>(opts: {
  address: Address
  event: ReturnType<typeof parseAbiItem>
  args?: Record<string, unknown>
  fromBlock: bigint
  toBlock: bigint
  span?: bigint
}): Promise<T[]> {
  const span = opts.span ?? 120_000n
  const out: T[] = []
  for (let from = opts.fromBlock; from <= opts.toBlock; from += span) {
    const to = from + span - 1n > opts.toBlock ? opts.toBlock : from + span - 1n
    try {
      const logs = await publicClient.getLogs({
        address: opts.address,
        event: opts.event,
        args: opts.args as never,
        fromBlock: from,
        toBlock: to,
      })
      out.push(...(logs as T[]))
    } catch (e) {
      console.warn('getLogsChunked fail', from.toString(), e)
    }
  }
  return out
}

export async function loadPositionCashflow(tokenId: bigint): Promise<Cashflow> {
  const empty: Cashflow = {
    deposited0: 0n, deposited1: 0n,
    withdrawn0: 0n, withdrawn1: 0n,
    claimed0: 0n, claimed1: 0n,
  }
  try {
    const latest = await publicClient.getBlockNumber()
    // 全链回扫太慢；保留足够长窗口覆盖多数仓位生命周期
    const fromBlock = latest > 3_000_000n ? latest - 3_000_000n : 0n
    const incEvent = parseAbiItem('event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)')
    const decEvent = parseAbiItem('event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)')
    const colEvent = parseAbiItem('event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)')

    type LogA = { args: { amount0?: bigint; amount1?: bigint }; transactionHash: Hash }
    const [inc, dec, col] = await Promise.all([
      getLogsChunked<LogA>({
        address: CONTRACTS.v3Npm,
        event: incEvent,
        args: { tokenId },
        fromBlock,
        toBlock: latest,
      }),
      getLogsChunked<LogA>({
        address: CONTRACTS.v3Npm,
        event: decEvent,
        args: { tokenId },
        fromBlock,
        toBlock: latest,
      }),
      getLogsChunked<LogA>({
        address: CONTRACTS.v3Npm,
        event: colEvent,
        args: { tokenId },
        fromBlock,
        toBlock: latest,
      }),
    ])

    let deposited0 = 0n
    let deposited1 = 0n
    const incByTx = new Map<string, { a0: bigint; a1: bigint }>()
    for (const l of inc) {
      const a0 = l.args.amount0 ?? 0n
      const a1 = l.args.amount1 ?? 0n
      deposited0 += a0
      deposited1 += a1
      const prev = incByTx.get(l.transactionHash) ?? { a0: 0n, a1: 0n }
      incByTx.set(l.transactionHash, { a0: prev.a0 + a0, a1: prev.a1 + a1 })
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

    /**
     * 历史已领（含复投）：
     * - 纯 Claim：全部 Collect
     * - 撤出+Collect：Collect 减掉同笔 Decrease 本金
     * - 复投（Collect + Increase）：仍计满 Collect，即使币又加回仓位
     */
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

export function enrichPnl(
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
  const costBasisUsd = clampUsd(depositedUsd - withdrawnUsd)
  const totalFeesUsd = clampUsd(unclaimedFeesUsd + claimedFeesUsd)
  // 现价口径：当前仓位 + 已领手续费 + 已取出本金 - 累计存入
  const pnlUsdRaw = principalUsd + unclaimedFeesUsd + claimedFeesUsd + withdrawnUsd - depositedUsd
  const pnlUsd = Number.isFinite(pnlUsdRaw) && Math.abs(pnlUsdRaw) <= 1e11 ? pnlUsdRaw : 0
  return {
    claimed0: cf.claimed0,
    claimed1: cf.claimed1,
    claimedFeesUsd: clampUsd(claimedFeesUsd),
    totalFeesUsd,
    costBasisUsd,
    pnlUsd,
  }
}

/** 已撤出且无未领费的 V3 仓位（NFT 可能仍在钱包） */
export function isVacantV3Position(
  liquidity: bigint,
  tokensOwed0: bigint,
  tokensOwed1: bigint,
): boolean {
  return liquidity === 0n && tokensOwed0 === 0n && tokensOwed1 === 0n
}

async function listV3TokenIds(owner: Address): Promise<bigint[]> {
  const bal = await publicClient.readContract({
    address: CONTRACTS.v3Npm,
    abi: v3NpmAbi,
    functionName: 'balanceOf',
    args: [owner],
  })
  const n = Number(bal)
  if (n === 0) return []
  return Promise.all(
    Array.from({ length: n }, (_, i) =>
      publicClient.readContract({
        address: CONTRACTS.v3Npm,
        abi: v3NpmAbi,
        functionName: 'tokenOfOwnerByIndex',
        args: [owner, BigInt(i)],
      }),
    ),
  )
}

/** 列出可销毁的空 V3 NFT（流动性=0 且无未领费） */
export async function listVacantV3TokenIds(owner: Address): Promise<bigint[]> {
  const tokenIds = await listV3TokenIds(owner)
  if (!tokenIds.length) return []
  const settled = await Promise.all(
    tokenIds.map(async (tokenId) => {
      const pos = await publicClient.readContract({
        address: CONTRACTS.v3Npm,
        abi: v3NpmAbi,
        functionName: 'positions',
        args: [tokenId],
      })
      const [, , , , , , , liquidity, , , tokensOwed0, tokensOwed1] = pos
      return isVacantV3Position(liquidity, tokensOwed0, tokensOwed1) ? tokenId : null
    }),
  )
  return settled.filter((id): id is bigint => id !== null)
}

/** 批量销毁空 V3 NFT，清理撤出后残留的 Position NFT */
export async function burnVacantV3Nfts(opts: {
  walletClient: WalletClient
  owner: Address
  onStatus?: (msg: string) => void
}): Promise<{ burned: bigint[]; failed: bigint[] }> {
  const { walletClient, owner, onStatus } = opts
  const ids = await listVacantV3TokenIds(owner)
  const burned: bigint[] = []
  const failed: bigint[] = []
  for (const tokenId of ids) {
    onStatus?.(`销毁空 NFT #${tokenId.toString()}…`)
    try {
      const hash = await walletClient.writeContract({
        address: CONTRACTS.v3Npm,
        abi: v3NpmAbi,
        functionName: 'burn',
        args: [tokenId],
        chain: walletClient.chain,
        account: owner,
      })
      await publicClient.waitForTransactionReceipt({ hash })
      burned.push(tokenId)
    } catch {
      failed.push(tokenId)
    }
  }
  return { burned, failed }
}

export async function loadV3Positions(owner: Address): Promise<PositionRow[]> {
  const wethUsd = await getWethUsdPrice()
  const tokenIds = await listV3TokenIds(owner)
  if (!tokenIds.length) return []

  // 同池只加载一次
  const poolMemo = new Map<string, Promise<PoolInfo>>()
  const getPool = (addr: Address) => {
    const k = addr.toLowerCase()
    let p = poolMemo.get(k)
    if (!p) {
      p = loadV3Pool(addr)
      poolMemo.set(k, p)
    }
    return p
  }

  const factoryMemo = new Map<string, Promise<Address | null>>()
  const getPoolAddr = (t0: Address, t1: Address, fee: number) => {
    const k = `${t0.toLowerCase()}-${t1.toLowerCase()}-${fee}`
    let p = factoryMemo.get(k)
    if (!p) {
      p = findV3Pool(t0, t1, fee)
      factoryMemo.set(k, p)
    }
    return p
  }

  const settled = await Promise.all(
    tokenIds.map(async (tokenId) => {
      try {
        const pos = await publicClient.readContract({
          address: CONTRACTS.v3Npm,
          abi: v3NpmAbi,
          functionName: 'positions',
          args: [tokenId],
        })
        const [, , token0Addr, token1Addr, fee, tickLower, tickUpper, liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1] = pos
        if (isVacantV3Position(liquidity, tokensOwed0, tokensOwed1)) return null
        let poolAddr = await getPoolAddr(token0Addr, token1Addr, fee)
        if (!poolAddr) {
          // Factory 偶发读失败时用 CREATE2 预测地址，避免整仓漏掉
          poolAddr = predictV3PoolAddress(token0Addr, token1Addr, fee)
        }
        const pool = await getPool(poolAddr)
        const { amount0, amount1 } = getAmountsForPosition(pool.sqrtPriceX96, tickLower, tickUpper, liquidity)
        // Fast path only: feeGrowth. simulate/getLogs were hanging refresh.
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
        if (
          liquidity === 0n &&
          amount0 === 0n &&
          amount1 === 0n &&
          fees0 === 0n &&
          fees1 === 0n
        ) {
          return null
        }
        const unclaimedFeesUsd = usd.fees0Usd + usd.fees1Usd
        // 现金流放后台 enrichPositionsLifetimeFees，这里先套本地 high-water 缓存
        const pnlFields = {
          claimed0: 0n,
          claimed1: 0n,
          claimedFeesUsd: 0,
          totalFeesUsd: unclaimedFeesUsd,
          costBasisUsd: 0,
          pnlUsd: 0,
        }
        const row: PositionRow = mergeCachedLifetimeFees({
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
          ...pnlFields,
          poolAddress: poolAddr,
          tickSpacing: pool.tickSpacing,
          sqrtPriceX96: pool.sqrtPriceX96,
        }, unclaimedFeesUsd)
        return row
      } catch (e) {
        console.warn('skip V3 position', tokenId.toString(), e)
        return null
      }
    }),
  )
  return settled.filter((r): r is PositionRow => r !== null)
}

/** V4 PositionManager 非 ERC721Enumerable：多源合并列 NFT（Blockscout + 日志 + 近端 ownerOf） */
async function listV4TokenIds(
  owner: Address,
  opts?: { deep?: boolean; onStatus?: (msg: string) => void },
): Promise<bigint[]> {
  const deep = Boolean(opts?.deep)
  const npm = CONTRACTS.v4PositionManager.toLowerCase()
  const own = owner.toLowerCase()
  const ids = new Set<string>()
  const add = (id: bigint | string | undefined | null) => {
    if (id == null || id === '') return
    ids.add(typeof id === 'bigint' ? id.toString() : String(id))
  }

  let balance = 0n
  try {
    balance = await publicClient.readContract({
      address: CONTRACTS.v4PositionManager,
      abi: v4PositionManagerAbi,
      functionName: 'balanceOf',
      args: [owner],
    })
  } catch (e) {
    console.warn('V4 balanceOf failed', e)
  }
  opts?.onStatus?.(
    balance > 0n
      ? `链上 V4 NFT 余额 ${balance.toString()}，正在扫描…`
      : '扫描 V4 NFT…',
  )

  // 1) 针对 PositionManager 的实例列表（比全量 /nft 小得多）
  try {
    let url: string | null =
      `https://robinhoodchain.blockscout.com/api/v2/tokens/${CONTRACTS.v4PositionManager}/instances?holder_address_hash=${owner}`
    for (let page = 0; page < (deep ? 20 : 10) && url; page++) {
      const json = await fetchJson<{
        items?: Array<{ id?: string; token_id?: string }>
        next_page_params?: Record<string, string | number>
      }>(url, deep ? 14_000 : 10_000)
      for (const it of json.items ?? []) add(it.id ?? it.token_id)
      if (json.next_page_params) {
        const q = new URLSearchParams(
          Object.entries(json.next_page_params).map(([k, v]) => [k, String(v)]),
        ).toString()
        url = `https://robinhoodchain.blockscout.com/api/v2/tokens/${CONTRACTS.v4PositionManager}/instances?holder_address_hash=${owner}&${q}`
      } else {
        url = null
      }
    }
  } catch (e) {
    console.warn('Blockscout V4 instances failed', e)
  }

  // 2) 全量 NFT 页兜底（只在条数仍不足时）
  if (ids.size < Number(balance) || (ids.size === 0 && balance === 0n)) {
    try {
      let url: string | null =
        `https://robinhoodchain.blockscout.com/api/v2/addresses/${owner}/nft?type=ERC-721`
      for (let page = 0; page < (deep ? 12 : 6) && url; page++) {
        const json = await fetchJson<{
          items?: Array<{ id?: string; token?: { address_hash?: string; address?: string } }>
          next_page_params?: Record<string, string>
        }>(url, 8_000)
        for (const it of json.items ?? []) {
          const addr = (it.token?.address_hash || it.token?.address || '').toLowerCase()
          if (addr === npm && it.id) add(it.id)
        }
        if (json.next_page_params) {
          const q = new URLSearchParams(json.next_page_params as Record<string, string>).toString()
          url = `https://robinhoodchain.blockscout.com/api/v2/addresses/${owner}/nft?type=ERC-721&${q}`
        } else {
          url = null
        }
      }
    } catch (e) {
      console.warn('Blockscout V4 NFT list failed', e)
    }
  }

  // 3) 近端 ownerOf：捕捉 Blockscout 尚未索引的新 mint
  try {
    const nextId = await publicClient.readContract({
      address: CONTRACTS.v4PositionManager,
      abi: v4PositionManagerAbi,
      functionName: 'nextTokenId',
    })
    const probe = deep ? 800n : 300n
    const start = nextId > probe ? nextId - probe : 1n
    opts?.onStatus?.(`校验近 ${probe.toString()} 个 V4 tokenId…`)
    const batch = 40n
    for (let from = start; from < nextId; from += batch) {
      const to = from + batch > nextId ? nextId : from + batch
      const checks: Promise<void>[] = []
      for (let id = from; id < to; id++) {
        const tokenId = id
        checks.push(
          (async () => {
            try {
              const who = await publicClient.readContract({
                address: CONTRACTS.v4PositionManager,
                abi: v4PositionManagerAbi,
                functionName: 'ownerOf',
                args: [tokenId],
              })
              if (who.toLowerCase() === own) add(tokenId)
            } catch {
              /* burned / nonexistent */
            }
          })(),
        )
      }
      await Promise.all(checks)
      if (!deep && ids.size >= Number(balance) && balance > 0n) break
    }
  } catch (e) {
    console.warn('V4 ownerOf probe failed', e)
  }

  // 4) Transfer 日志：始终合并（不再因 Blockscout 有结果就跳过）
  const needMore = balance > 0n && BigInt(ids.size) < balance
  const lookback = deep || needMore ? 1_500_000n : 400_000n
  try {
    opts?.onStatus?.(`扫链上 Transfer（回溯 ${lookback.toString()} 块）…`)
    const fromLogs = await withTimeout(
      scanV4TokenIdsByLogs(owner, lookback),
      deep ? 60_000 : 25_000,
      'V4 事件索引',
    )
    for (const id of fromLogs) add(id)
  } catch (e) {
    console.warn('V4 event scan failed or timed out', e)
  }

  opts?.onStatus?.(`已找到 ${ids.size} 个 V4 NFT（链上余额 ${balance.toString()}）`)
  return [...ids].map((x) => BigInt(x)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

async function scanV4TokenIdsByLogs(owner: Address, lookbackBlocks: bigint): Promise<bigint[]> {
  const transfer = parseAbiItem(
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  )
  const latest = await publicClient.getBlockNumber()
  const owned = new Set<string>()
  const span = 40_000n
  const start = latest > lookbackBlocks ? latest - lookbackBlocks : 0n
  for (let from = start; from <= latest; from += span) {
    const to = from + span - 1n > latest ? latest : from + span - 1n
    try {
      const [ins, outs] = await Promise.all([
        publicClient.getLogs({
          address: CONTRACTS.v4PositionManager,
          event: transfer,
          args: { to: owner },
          fromBlock: from,
          toBlock: to,
        }),
        publicClient.getLogs({
          address: CONTRACTS.v4PositionManager,
          event: transfer,
          args: { from: owner },
          fromBlock: from,
          toBlock: to,
        }),
      ])
      for (const l of ins) if (l.args.tokenId != null) owned.add(l.args.tokenId.toString())
      for (const l of outs) if (l.args.tokenId != null) owned.delete(l.args.tokenId.toString())
    } catch (e) {
      console.warn('V4 Transfer chunk fail', from.toString(), e)
    }
  }
  return [...owned].map((x) => BigInt(x))
}

const V4_MODIFY_LIQUIDITY = parseAbiItem(
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
)
const ERC20_TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)

function v4Salt(tokenId: bigint): `0x${string}` {
  return `0x${tokenId.toString(16).padStart(64, '0')}` as `0x${string}`
}

/** Blockscout：该 V4 NFT 的铸造块（扫现金流起点） */
async function v4MintBlock(tokenId: bigint): Promise<bigint | null> {
  try {
    const json = await fetchJson<{
      items?: Array<{ block_number?: number; from?: { hash?: string } }>
    }>(
      `https://robinhoodchain.blockscout.com/api/v2/tokens/${CONTRACTS.v4PositionManager}/instances/${tokenId.toString()}/transfers`,
      8_000,
    )
    const mint = (json.items ?? []).find(
      (it) => (it.from?.hash || '').toLowerCase() === '0x0000000000000000000000000000000000000000',
    )
    if (mint?.block_number != null) return BigInt(mint.block_number)
    const any = json.items?.[json.items.length - 1]
    if (any?.block_number != null) return BigInt(any.block_number)
  } catch (e) {
    console.warn('v4MintBlock failed', tokenId.toString(), e)
  }
  return null
}

async function collectV4ModifyLogs(opts: {
  poolId: `0x${string}`
  tokenId: bigint
  fromBlock: bigint
}): Promise<Array<{
  blockNumber: bigint
  transactionHash: Hash
  tickLower: number
  tickUpper: number
  liquidityDelta: bigint
}>> {
  const { poolId, tokenId, fromBlock } = opts
  const salt = v4Salt(tokenId).toLowerCase()
  const latest = await publicClient.getBlockNumber()
  const span = 25_000n
  const out: Array<{
    blockNumber: bigint
    transactionHash: Hash
    tickLower: number
    tickUpper: number
    liquidityDelta: bigint
  }> = []
  for (let from = fromBlock; from <= latest; from += span) {
    const to = from + span - 1n > latest ? latest : from + span - 1n
    try {
      const logs = await publicClient.getLogs({
        address: CONTRACTS.v4PoolManager,
        event: V4_MODIFY_LIQUIDITY,
        args: { id: poolId, sender: CONTRACTS.v4PositionManager },
        fromBlock: from,
        toBlock: to,
      })
      for (const l of logs) {
        if ((l.args.salt || '').toLowerCase() !== salt) continue
        out.push({
          blockNumber: l.blockNumber ?? from,
          transactionHash: l.transactionHash,
          tickLower: Number(l.args.tickLower),
          tickUpper: Number(l.args.tickUpper),
          liquidityDelta: l.args.liquidityDelta ?? 0n,
        })
      }
    } catch (e) {
      console.warn('V4 ModifyLiquidity chunk fail', from.toString(), e)
    }
  }
  return out
}

/** 从领取类交易收据里抽 token0/token1：进 owner / 进 PositionManager（复投常不经过钱包） */
async function feeTokenMovesInTx(
  txHash: Hash,
  owner: Address,
  token0: Address,
  token1: Address,
): Promise<{ toOwner0: bigint; toOwner1: bigint; toPm0: bigint; toPm1: bigint }> {
  let toOwner0 = 0n
  let toOwner1 = 0n
  let toPm0 = 0n
  let toPm1 = 0n
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
    const own = owner.toLowerCase()
    const pm = CONTRACTS.v4PositionManager.toLowerCase()
    const t0 = token0.toLowerCase()
    const t1 = token1.toLowerCase()
    const weth = CONTRACTS.weth.toLowerCase()
    const match0 = (token: string) =>
      token === t0 || (t0 === '0x0000000000000000000000000000000000000000' && token === weth)
    const match1 = (token: string) =>
      token === t1 || (t1 === '0x0000000000000000000000000000000000000000' && token === weth)
    for (const log of receipt.logs) {
      try {
        const d = decodeEventLog({
          abi: [ERC20_TRANSFER],
          data: log.data,
          topics: log.topics,
        })
        const to = (d.args.to as string).toLowerCase()
        const token = log.address.toLowerCase()
        const v = d.args.value as bigint
        if (match0(token)) {
          if (to === own) toOwner0 += v
          if (to === pm) toPm0 += v
        } else if (match1(token)) {
          if (to === own) toOwner1 += v
          if (to === pm) toPm1 += v
        }
      } catch {
        /* not ERC20 Transfer */
      }
    }
  } catch (e) {
    console.warn('feeTokenMovesInTx fail', txHash, e)
  }
  return { toOwner0, toOwner1, toPm0, toPm1 }
}

async function transfersToOwnerInTx(
  txHash: Hash,
  owner: Address,
  token0: Address,
  token1: Address,
): Promise<{ amount0: bigint; amount1: bigint }> {
  const m = await feeTokenMovesInTx(txHash, owner, token0, token1)
  return { amount0: m.toOwner0, amount1: m.toOwner1 }
}

/**
 * V4 现金流：扫 PoolManager.ModifyLiquidity（salt=tokenId），
 * 用历史 slot0 把 liquidityDelta 还原成存/取币量；delta=0 的交易再扫 Transfer 作已领费。
 */
export async function loadV4PositionCashflow(opts: {
  owner: Address
  tokenId: bigint
  poolId: `0x${string}`
  tickLower: number
  tickUpper: number
  token0: Address
  token1: Address
}): Promise<Cashflow> {
  const empty: Cashflow = {
    deposited0: 0n, deposited1: 0n,
    withdrawn0: 0n, withdrawn1: 0n,
    claimed0: 0n, claimed1: 0n,
  }
  const { owner, tokenId, poolId, tickLower, tickUpper, token0, token1 } = opts
  try {
    let fromBlock = await v4MintBlock(tokenId)
    if (fromBlock == null) {
      const latest = await publicClient.getBlockNumber()
      fromBlock = latest > 1_500_000n ? latest - 1_500_000n : 0n
    }
    const mods = await collectV4ModifyLogs({ poolId, tokenId, fromBlock })
    if (!mods.length) return empty

    let deposited0 = 0n
    let deposited1 = 0n
    let withdrawn0 = 0n
    let withdrawn1 = 0n
    let claimed0 = 0n
    let claimed1 = 0n
    const claimedTx = new Set<string>()

    for (const m of mods) {
      if (m.liquidityDelta === 0n) {
        // Claim / 复投收手续费：进钱包或先打进 PositionManager 再加仓
        const got = await feeTokenMovesInTx(m.transactionHash, owner, token0, token1)
        const a0 = got.toOwner0 > 0n ? got.toOwner0 : got.toPm0
        const a1 = got.toOwner1 > 0n ? got.toOwner1 : got.toPm1
        claimed0 += a0
        claimed1 += a1
        claimedTx.add(m.transactionHash)
        continue
      }
      const absLiq = m.liquidityDelta < 0n ? -m.liquidityDelta : m.liquidityDelta
      let sqrt = 0n
      try {
        const slot0 = await publicClient.readContract({
          address: CONTRACTS.v4StateView,
          abi: v4StateViewAbi,
          functionName: 'getSlot0',
          args: [poolId],
          blockNumber: m.blockNumber,
        })
        sqrt = slot0[0]
      } catch {
        continue
      }
      if (sqrt === 0n) continue
      const tl = m.tickLower || tickLower
      const tu = m.tickUpper || tickUpper
      const { amount0, amount1 } = getAmountsForPosition(sqrt, tl, tu, absLiq)
      if (m.liquidityDelta > 0n) {
        deposited0 += amount0
        deposited1 += amount1
        // 复投且手续费先进钱包：同笔 Transfer→owner 计为历史已领（不要把打进 PM 的加仓本金当手续费）
        if (!claimedTx.has(m.transactionHash)) {
          const got = await feeTokenMovesInTx(m.transactionHash, owner, token0, token1)
          if (got.toOwner0 > 0n || got.toOwner1 > 0n) {
            claimed0 += got.toOwner0
            claimed1 += got.toOwner1
            claimedTx.add(m.transactionHash)
          }
        }
      } else {
        withdrawn0 += amount0
        withdrawn1 += amount1
        if (!claimedTx.has(m.transactionHash)) {
          const got = await transfersToOwnerInTx(m.transactionHash, owner, token0, token1)
          if (got.amount0 > amount0) claimed0 += got.amount0 - amount0
          if (got.amount1 > amount1) claimed1 += got.amount1 - amount1
          claimedTx.add(m.transactionHash)
        }
      }
    }

    return { deposited0, deposited1, withdrawn0, withdrawn1, claimed0, claimed1 }
  } catch (e) {
    console.warn('loadV4PositionCashflow failed', tokenId.toString(), e)
    return empty
  }
}

/**
 * 后台补齐历史已领手续费（含复投）。不阻塞首屏列表。
 * 结果做 high-water 本地缓存，刷新暂时失败也不会把「已领」打回 0。
 */
export async function enrichPositionsLifetimeFees(
  rows: PositionRow[],
  owner: Address,
  opts?: { onRow?: (row: PositionRow) => void },
): Promise<PositionRow[]> {
  if (!rows.length) return rows
  const wethUsd = await getWethUsdPrice()
  const out = [...rows]

  await Promise.all(
    rows.map(async (row, idx) => {
      const unclaimedFeesUsd = row.fees0Usd + row.fees1Usd
      let next = mergeCachedLifetimeFees(row, unclaimedFeesUsd)
      try {
        const principalUsd = row.amount0Usd + row.amount1Usd
        if (row.version === 'v3') {
          const cf = await withTimeout(
            loadPositionCashflow(row.tokenId),
            45_000,
            `V3 fees #${row.tokenId}`,
          )
          const pool: PoolInfo = {
            version: 'v3',
            poolAddress: row.poolAddress,
            token0: row.token0,
            token1: row.token1,
            fee: row.fee,
            tickSpacing: row.tickSpacing,
            tick: row.tick,
            sqrtPriceX96: row.sqrtPriceX96 ?? 0n,
            price: row.price,
            liquidity: row.liquidity,
          }
          const pnl = enrichPnl(pool, wethUsd, principalUsd, unclaimedFeesUsd, cf)
          next = mergeCachedLifetimeFees({ ...row, ...pnl }, unclaimedFeesUsd)
        } else if (row.version === 'v4' && row.poolId) {
          const cf = await withTimeout(
            loadV4PositionCashflow({
              owner,
              tokenId: row.tokenId,
              poolId: row.poolId,
              tickLower: row.tickLower,
              tickUpper: row.tickUpper,
              token0: row.token0.address,
              token1: row.token1.address,
            }),
            45_000,
            `V4 fees #${row.tokenId}`,
          )
          const pool: PoolInfo = {
            version: 'v4',
            poolId: row.poolId,
            token0: row.token0,
            token1: row.token1,
            fee: row.fee,
            tickSpacing: row.tickSpacing,
            tick: row.tick,
            sqrtPriceX96: row.sqrtPriceX96 ?? 0n,
            price: row.price,
            liquidity: row.liquidity,
            hooks: row.hooks,
          }
          const pnl = enrichPnl(pool, wethUsd, principalUsd, unclaimedFeesUsd, cf)
          next = mergeCachedLifetimeFees({ ...row, ...pnl }, unclaimedFeesUsd)
        }
      } catch (e) {
        console.warn('enrich lifetime fees fail', row.tokenId.toString(), e)
        next = mergeCachedLifetimeFees(row, unclaimedFeesUsd)
      }
      persistLifetimeFees(next)
      out[idx] = next
      opts?.onRow?.(next)
    }),
  )
  return out
}

export async function loadV4Positions(
  owner: Address,
  opts?: { deep?: boolean; skipPnl?: boolean; onStatus?: (msg: string) => void },
): Promise<PositionRow[]> {
  const skipPnl = opts?.skipPnl !== false // 默认跳过慢速 PnL，避免整批超时漏仓
  const wethUsd = await getWethUsdPrice()
  const tokenIds = await listV4TokenIds(owner, { deep: opts?.deep, onStatus: opts?.onStatus })

  const poolMemo = new Map<string, Promise<PoolInfo>>()
  const getPool = (key: {
    currency0: Address
    currency1: Address
    fee: number
    tickSpacing: number
    hooks: Address
  }) => {
    const k = `${key.currency0.toLowerCase()}-${key.currency1.toLowerCase()}-${key.fee}-${key.tickSpacing}-${key.hooks.toLowerCase()}`
    let p = poolMemo.get(k)
    if (!p) {
      p = loadV4Pool(key)
      poolMemo.set(k, p)
    }
    return p
  }

  opts?.onStatus?.(`解析 ${tokenIds.length} 个 V4 仓位…`)
  const settled = await Promise.all(
    tokenIds.map(async (tokenId) => {
      try {
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
        if (liquidity === 0n) return null
        const { tickLower, tickUpper } = decodeV4PositionInfo(info)
        const pool = await getPool({
          currency0: poolKey.currency0,
          currency1: poolKey.currency1,
          fee: Number(poolKey.fee),
          tickSpacing: Number(poolKey.tickSpacing),
          hooks: poolKey.hooks,
        })
        if (pool.poolId && !pool.poolId.toLowerCase().startsWith(poolIdPrefixFromV4Info(info).toLowerCase())) {
          console.warn('V4 poolId mismatch for', tokenId.toString(), pool.poolId, poolIdPrefixFromV4Info(info))
        }
        const poolReady = pool.sqrtPriceX96 > 0n
        const { amount0, amount1 } = getAmountsForPosition(pool.sqrtPriceX96, tickLower, tickUpper, liquidity)
        const { fees0, fees1 } = pool.poolId && poolReady
          ? await computeV4Fees({ poolId: pool.poolId, tokenId, tickLower, tickUpper, liquidity })
          : { fees0: 0n, fees1: 0n }
        const usd = enrichUsd(amount0, amount1, fees0, fees1, pool, wethUsd)
        const unclaimedFeesUsd = usd.fees0Usd + usd.fees1Usd
        const principalUsd = usd.amount0Usd + usd.amount1Usd
        const pnlFields = {
          claimed0: 0n,
          claimed1: 0n,
          claimedFeesUsd: 0,
          totalFeesUsd: unclaimedFeesUsd,
          costBasisUsd: principalUsd,
          pnlUsd: 0,
        }
        const row: PositionRow = mergeCachedLifetimeFees({
          version: 'v4',
          tokenId,
          token0: pool.token0,
          token1: pool.token1,
          fee: Number(poolKey.fee),
          tickLower,
          tickUpper,
          liquidity,
          tick: pool.tick,
          inRange: poolReady && liquidity > 0n && pool.tick >= tickLower && pool.tick < tickUpper,
          priceLower: tickToPrice(tickLower, pool.token0.decimals, pool.token1.decimals),
          priceUpper: tickToPrice(tickUpper, pool.token0.decimals, pool.token1.decimals),
          price: pool.price,
          amount0,
          amount1,
          fees0,
          fees1,
          ...usd,
          ...pnlFields,
          poolId: pool.poolId,
          tickSpacing: Number(poolKey.tickSpacing),
          hooks: poolKey.hooks,
          sqrtPriceX96: pool.sqrtPriceX96,
        }, unclaimedFeesUsd)
        return row
      } catch (e) {
        console.warn('skip V4 position', tokenId.toString(), e)
        return null
      }
    }),
  )
  return settled.filter((r): r is PositionRow => r !== null)
}

async function ensureAllowance(
  walletClient: WalletClient,
  token: Address,
  owner: Address,
  spender: Address,
  amount: bigint,
  onStatus?: (msg: string) => void,
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
  onStatus?.('需要授权代币，请在钱包确认…')
  const MAX_UINT256 = 2n ** 256n - 1n
  const hash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, MAX_UINT256],
    // 跳过 estimateGas，加快弹窗
    gas: 80_000n,
    chain: walletClient.chain,
    account: owner,
  })
  onStatus?.('等待授权上链…')
  await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    pollingInterval: 400,
    timeout: 60_000,
  })
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
  onStatus?: (msg: string) => void
}) {
  const { walletClient, owner, functionName, args, value, action, onStatus } = opts
  const data = encodeFunctionData({
    abi: v3NpmAbi,
    functionName,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: args as any,
  })

  // 竞速：RPC estimateGas 超过 1.2s 就用固定 gas，优先尽快弹钱包
  const fallbackGas = functionName === 'mint' ? 1_200_000n : 800_000n
  onStatus?.('准备交易…')
  let gasWithBuffer = fallbackGas
  try {
    const estimated = await Promise.race([
      publicClient.estimateGas({
        account: owner,
        to: CONTRACTS.v3Npm,
        data,
        value: value > 0n ? value : undefined,
      }).then((g) => (g * 130n) / 100n),
      new Promise<bigint>((resolve) => {
        setTimeout(() => resolve(fallbackGas), 1200)
      }),
    ])
    gasWithBuffer = estimated < 21000n ? fallbackGas : estimated
  } catch (e) {
    // 预检失败仍用固定 gas 尝试弹窗；真正失败由钱包/链上回报
    const msg = e instanceof Error ? e.message : String(e)
    if (/insufficient|exceeds balance|transfer amount/i.test(msg)) {
      throw new Error(friendlyTxError(e, action))
    }
    gasWithBuffer = fallbackGas
  }

  onStatus?.(`请在钱包确认 ${action}…`)
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
  onStatus?: (msg: string) => void
}) {
  const { walletClient, owner, pool, amount0, amount1, onStatus } = opts
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

  const useNative = Boolean(opts.useNativeEth) && pairHasWeth(pool.token0.address, pool.token1.address)
  const wethIs0 = isWeth(pool.token0.address)
  const wethIs1 = isWeth(pool.token1.address)

  // 快路径：只拉 slot0（+可选余额），复用 UI 已有 token 元数据，避免 6~8 次慢 RPC
  onStatus?.('读取最新池价…')
  const [slot0, ethBal] = await Promise.all([
    publicClient.readContract({
      address: pool.poolAddress,
      abi: v3PoolAbi,
      functionName: 'slot0',
    }),
    useNative ? publicClient.getBalance({ address: owner }) : Promise.resolve(0n),
  ])
  const sqrtPriceX96 = slot0[0]
  const tick = slot0[1]
  const usePool: PoolInfo = {
    ...pool,
    tick,
    sqrtPriceX96,
    price:
      sqrtPriceX96 > 0n
        ? tickToPrice(tick, pool.token0.decimals, pool.token1.decimals)
        : 0,
  }

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
    if (ethBal < nativeValueFinal + 10n ** 15n) {
      throw new Error(`ETH 不足：需要约 ${formatAmountExact(nativeValueFinal, 18)} ETH + gas`)
    }
  }

  // 授权并行；纯 ETH 单边通常可跳过
  await Promise.all([
    (!(useNative && wethIs0) && use0 > 0n)
      ? ensureAllowance(walletClient, usePool.token0.address, owner, CONTRACTS.v3Npm, use0, onStatus)
      : Promise.resolve(),
    (!(useNative && wethIs1) && use1 > 0n)
      ? ensureAllowance(walletClient, usePool.token1.address, owner, CONTRACTS.v3Npm, use1, onStatus)
      : Promise.resolve(),
  ])

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
      onStatus,
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
/** 仓位行转 PoolInfo，供 getCoinQuote / 币价展示复用 */
export function positionAsPool(p: PositionRow): PoolInfo {
  return {
    version: p.version,
    poolAddress: p.poolAddress,
    poolId: p.poolId,
    token0: p.token0,
    token1: p.token1,
    fee: p.fee,
    tickSpacing: p.tickSpacing,
    tick: p.tick,
    sqrtPriceX96: p.sqrtPriceX96,
    price: p.price,
    liquidity: p.liquidity,
    hooks: p.hooks,
  }
}

/** 持仓卡片用：与建仓页一致的币/报价方向与区间价 */
export function getPositionCoinPrices(p: PositionRow) {
  const quote = getCoinQuote(positionAsPool(p))
  const coinPrice = poolPriceToCoinPrice(p.price, quote.invert)
  const rawLo = poolPriceToCoinPrice(p.priceLower, quote.invert)
  const rawHi = poolPriceToCoinPrice(p.priceUpper, quote.invert)
  return {
    ...quote,
    coinPrice,
    coinPriceLower: Math.min(rawLo, rawHi),
    coinPriceUpper: Math.max(rawLo, rawHi),
    priceUnit: `${quote.quote.symbol}/${quote.coin.symbol}`,
  }
}

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

/**
 * 「单边 ETH」预设：相对币价 -75% ~ -3%（区间在市价下方）。
 * 无论 ETH 是 token0 还是 token1，在 getCoinQuote 口径下都只要 ETH：
 * - ETH=token1：区间低于池价 → tick 在区间上方 → 只收 token1
 * - ETH=token0：币价取反后区间低于币价 ↔ 池价区间高于市价 → tick 在区间下方 → 只收 token0
 */
export function oneSidedEthPercents(): { percentLower: number; percentUpper: number } {
  return { percentLower: -75, percentUpper: -3 }
}

/** V3/V4 全区间（min/max usable tick） */
export function describeFullRange(pool: PoolInfo) {
  const { tickLower, tickUpper } = fullRangeTicks(pool.tickSpacing)
  const quote = getCoinQuote(pool)
  const priceLower = tickToPrice(tickLower, pool.token0.decimals, pool.token1.decimals)
  const priceUpper = tickToPrice(tickUpper, pool.token0.decimals, pool.token1.decimals)
  const coinPriceLower = poolPriceToCoinPrice(priceLower, quote.invert)
  const coinPriceUpper = poolPriceToCoinPrice(priceUpper, quote.invert)
  return {
    tickLower,
    tickUpper,
    priceLower,
    priceUpper,
    coinPriceLower: Math.min(coinPriceLower, coinPriceUpper),
    coinPriceUpper: Math.max(coinPriceLower, coinPriceUpper),
    coinSpot: quote.spot,
    coinSymbol: quote.coin.symbol,
    quoteSymbol: quote.quote.symbol,
    invert: quote.invert,
    inRangePreview: pool.tick >= tickLower && pool.tick < tickUpper,
    fullRange: true as const,
  }
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
