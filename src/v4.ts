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
import { CONTRACTS } from './chain'
import { erc20Abi, permit2Abi, v4PositionManagerAbi } from './abis'
import {
  getLiquidityForAmounts,
  nearestUsableTick,
  pairAmountForRange,
  rangeFromPercent,
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
  return isNativeCurrency(addr) || addr.toLowerCase() === CONTRACTS.weth.toLowerCase()
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

function currencyVariants(token: Address): Address[] {
  const weth = CONTRACTS.weth.toLowerCase()
  if (token.toLowerCase() === weth || isNativeCurrency(token)) {
    return [CONTRACTS.weth, NATIVE_ETH]
  }
  return [token]
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
): Promise<PoolInfo | null> {
  const spacings = FEE_SPACINGS[fee] ?? [1, 10, 60, 200]
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
}) {
  const { walletClient, owner, pool } = opts
  if (pool.version !== 'v4' || !pool.poolId) throw new Error('需要 V4 池')
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

  if (!nativeIs0 && !nativeIs1) {
    await ensureWethBalance({
      walletClient,
      owner,
      currency0: key.currency0,
      currency1: key.currency1,
      amount0,
      amount1,
      useNativeEth: Boolean(opts.useNativeEth),
    })
  }

  await ensurePermit2(walletClient, key.currency0, owner, amount0)
  await ensurePermit2(walletClient, key.currency1, owner, amount1)

  const liquidity = getLiquidityForAmounts(live.sqrtPriceX96, tickLower, tickUpper, amount0, amount1)
  if (liquidity <= 0n) throw new Error('算出的流动性为 0，请检查数量与区间')

  const amount0Max = clampUint128(amount0 + amount0 / 100n + 1n)
  const amount1Max = clampUint128(amount1 + amount1 / 100n + 1n)

  const actions: number[] = [V4_ACTIONS.MINT_POSITION, V4_ACTIONS.SETTLE_PAIR]
  const params: `0x${string}`[] = [
    encodeMintParams(key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner),
    encodeSettlePair(key.currency0, key.currency1),
  ]

  let value = 0n
  if (nativeIs0) value = amount0Max
  if (nativeIs1) value = amount1Max
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

export async function increaseV4Liquidity(opts: {
  walletClient: WalletClient
  owner: Address
  position: PositionRow
  amount0: bigint
  amount1: bigint
  useNativeEth?: boolean
}) {
  const { walletClient, owner, position } = opts
  if (position.version !== 'v4') throw new Error('需要 V4 仓位')
  const key = poolKeyFromPosition(position)
  const live = await loadV4Pool(key)

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

  const nativeIs0 = isNativeCurrency(key.currency0)
  const nativeIs1 = isNativeCurrency(key.currency1)
  if (!nativeIs0 && !nativeIs1) {
    await ensureWethBalance({
      walletClient,
      owner,
      currency0: key.currency0,
      currency1: key.currency1,
      amount0,
      amount1,
      useNativeEth: Boolean(opts.useNativeEth),
    })
  }

  await ensurePermit2(walletClient, key.currency0, owner, amount0)
  await ensurePermit2(walletClient, key.currency1, owner, amount1)

  const liquidity = getLiquidityForAmounts(
    live.sqrtPriceX96,
    position.tickLower,
    position.tickUpper,
    amount0,
    amount1,
  )
  if (liquidity <= 0n) throw new Error('算出的流动性为 0')

  const amount0Max = clampUint128(amount0 + amount0 / 100n + 1n)
  const amount1Max = clampUint128(amount1 + amount1 / 100n + 1n)

  const actions: number[] = [V4_ACTIONS.INCREASE_LIQUIDITY, V4_ACTIONS.SETTLE_PAIR]
  const params: `0x${string}`[] = [
    encodeModifyLiqParams(position.tokenId, liquidity, amount0Max, amount1Max),
    encodeSettlePair(key.currency0, key.currency1),
  ]
  let value = 0n
  if (nativeIs0) value = amount0Max
  if (nativeIs1) value = amount1Max
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
