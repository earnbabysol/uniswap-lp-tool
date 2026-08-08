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
import { withTimeout } from './async'
import { erc20Abi, permit2Abi, v4PositionManagerAbi } from './abis'
import {
  getAmountsForPosition,
  getLiquidityForAmounts,
  nearestUsableTick,
  resolvePairedMintAmounts,
  priceToClosestTick,
  priceToSqrtPriceX96,
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
  SETTLE: 0x0b,
  SETTLE_PAIR: 0x0d,
  TAKE: 0x0e,
  TAKE_PAIR: 0x11,
  SWEEP: 0x14,
} as const

/** PositionManager：amount=0 表示用全部 open delta */
const OPEN_DELTA = 0n

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

/** 把 WETH / 原生 ETH 视为同一侧，按目标池 token0/1 重排数量 */
export function remapAmountsAcrossPools(
  from0: Address,
  from1: Address,
  to0: Address,
  to1: Address,
  amount0: bigint,
  amount1: bigint,
): { amount0: bigint; amount1: bigint } {
  const keyOf = (addr: Address) =>
    isEthLikeCurrency(addr) || isNativeCurrency(addr) ? '__eth__' : addr.toLowerCase()
  const k0 = keyOf(from0)
  const k1 = keyOf(from1)
  const t0 = keyOf(to0)
  const t1 = keyOf(to1)
  const out0 = t0 === k0 ? amount0 : t0 === k1 ? amount1 : 0n
  const out1 = t1 === k0 ? amount0 : t1 === k1 ? amount1 : 0n
  return { amount0: out0, amount1: out1 }
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

/** SETTLE：payerIsUser=true 时从用户钱包经 Permit2 转入 PoolManager */
function encodeSettle(currency: Address, amount: bigint, payerIsUser: boolean): `0x${string}` {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }],
    [currency, amount, payerIsUser],
  )
}

function encodeTake(currency: Address, recipient: Address, amount: bigint): `0x${string}` {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [currency, recipient, amount],
  )
}

function encodeTakePair(c0: Address, c1: Address, recipient: Address): `0x${string}` {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    [c0, c1, recipient],
  )
}

/**
 * 转账税垫付：PoolManager.settle 按「实际到账」冲债务。
 * 税币 transfer(X) 只到账 X*(1-t)，必须多转 ceil(debt/(1-t))。
 */
export function grossUpForTransferTax(amount: bigint, taxBps: number): bigint {
  if (amount <= 0n) return 0n
  const bps = Math.min(5_000, Math.max(0, Math.floor(taxBps) || 0))
  if (bps <= 0) return amount
  const keep = 10_000n - BigInt(bps)
  // ceil(amount * 10000 / keep)；不再 +1wei，避免 Max 满余额时差 1 失败
  return (amount * 10_000n + keep - 1n) / keep
}

/** 从「钱包愿付」扣税，得到可用于算流动性的净到账量 */
export function netAfterTransferTax(amount: bigint, taxBps: number): bigint {
  if (amount <= 0n) return 0n
  const bps = Math.min(5_000, Math.max(0, Math.floor(taxBps) || 0))
  if (bps <= 0) return amount
  return (amount * (10_000n - BigInt(bps))) / 10_000n
}

/**
 * 组装 settle：无税走 SETTLE_PAIR；有税则逐币 SETTLE 垫付，并 TAKE 退回多到账的 credit。
 * PoolManager.settle() 按「实际到账」冲债务，税币必须多转。
 * 返回还需 Permit2 的额度（含税垫付）。
 */
function buildMintSettlePlan(opts: {
  currency0: Address
  currency1: Address
  /** mint 侧 amountMax（债务上限） */
  amount0Max: bigint
  amount1Max: bigint
  taxBps0: number
  taxBps1: number
  recipient: Address
  /** 税币侧钱包实付（用户填的数量）；优先于对 amountMax 做 grossUp */
  pay0?: bigint
  pay1?: bigint
}): {
  actions: number[]
  params: `0x${string}`[]
  permit0: bigint
  permit1: bigint
} {
  const tax0 = isNativeCurrency(opts.currency0) ? 0 : Math.max(0, Math.floor(opts.taxBps0) || 0)
  const tax1 = isNativeCurrency(opts.currency1) ? 0 : Math.max(0, Math.floor(opts.taxBps1) || 0)
  if (tax0 <= 0 && tax1 <= 0) {
    return {
      actions: [V4_ACTIONS.SETTLE_PAIR],
      params: [encodeSettlePair(opts.currency0, opts.currency1)],
      permit0: opts.amount0Max,
      permit1: opts.amount1Max,
    }
  }
  const pay0 =
    tax0 > 0
      ? (opts.pay0 != null && opts.pay0 > 0n
        ? opts.pay0
        : grossUpForTransferTax(opts.amount0Max, tax0))
      : OPEN_DELTA
  const pay1 =
    tax1 > 0
      ? (opts.pay1 != null && opts.pay1 > 0n
        ? opts.pay1
        : grossUpForTransferTax(opts.amount1Max, tax1))
      : OPEN_DELTA
  return {
    actions: [
      V4_ACTIONS.SETTLE,
      V4_ACTIONS.SETTLE,
      V4_ACTIONS.TAKE,
      V4_ACTIONS.TAKE,
    ],
    params: [
      encodeSettle(opts.currency0, pay0, true),
      encodeSettle(opts.currency1, pay1, true),
      encodeTake(opts.currency0, opts.recipient, OPEN_DELTA),
      encodeTake(opts.currency1, opts.recipient, OPEN_DELTA),
    ],
    permit0: tax0 > 0 ? pay0 : opts.amount0Max,
    permit1: tax1 > 0 ? pay1 : opts.amount1Max,
  }
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
 * Mint/加仓的 amount0Max/amount1Max。
 *
 * 必须用「现价所需 + 滑点」，不能用全区间 worst-case：
 * Rabby 等钱包模拟时常按 amountMax 检查余额/授权，worst-case 往往远超钱包余额，
 * 会误报「授权额度不足或代币余额不足」，网络费显示 --。
 *
 * 新建池（同笔 initialize）现价即初始价，更不需要 worst-case。
 * 单边仓另一侧 needed=0 时给极小垫值，防签名期间价格擦边。
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
  let amount0Max = needed.amount0 > 0n ? bumpAmountMax(needed.amount0, slippageBps) : 0n
  let amount1Max = needed.amount1 > 0n ? bumpAmountMax(needed.amount1, slippageBps) : 0n
  // 单边：另一侧留 1 wei 垫，避免部分路由把 max=0 当成未设置
  if (liquidity > 0n && amount0Max === 0n && amount1Max > 0n) amount0Max = 1n
  if (liquidity > 0n && amount1Max === 0n && amount0Max > 0n) amount1Max = 1n
  return {
    amount0: needed.amount0,
    amount1: needed.amount1,
    amount0Max,
    amount1Max,
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 会话内已确认的授权，避免 Arc RPC 读不到 allowance 时反复卡死 */
const sessionErc20Permit2Ok = new Set<string>()
const sessionPermit2PmOk = new Set<string>()

function erc20Permit2Key(token: Address, owner: Address) {
  return `${token.toLowerCase()}:${owner.toLowerCase()}:p2`
}
function permit2PmKey(token: Address, owner: Address) {
  return `${token.toLowerCase()}:${owner.toLowerCase()}:pm`
}

/** 优先走钱包 eth_getTransactionReceipt（Arc 公共 RPC 经常读不到） */
async function getReceiptViaWallet(hash: `0x${string}`): Promise<{ status: 'success' | 'reverted' } | null> {
  const eth = typeof window !== 'undefined' ? window.ethereum : undefined
  if (!eth?.request) return null
  try {
    const raw = (await eth.request({
      method: 'eth_getTransactionReceipt',
      params: [hash],
    })) as { status?: string } | null
    if (!raw) return null
    const s = (raw.status ?? '').toLowerCase()
    if (s === '0x1' || s === '1') return { status: 'success' }
    if (s === '0x0' || s === '0') return { status: 'reverted' }
    // 有些节点有 receipt 但无 status 字段，当作已上链成功
    return { status: 'success' }
  } catch {
    return null
  }
}

/** 软等 receipt：失败不抛，Arc 上 receipt 经常读不到 */
async function waitTxReceiptSoft(hash: `0x${string}`, timeoutMs = 20_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const viaWallet = await getReceiptViaWallet(hash)
    if (viaWallet) {
      if (viaWallet.status === 'reverted') {
        throw new Error(`交易失败（已回滚）${hash.slice(0, 10)}…`)
      }
      return viaWallet
    }
    try {
      const r = await publicClient.getTransactionReceipt({ hash })
      if (r) {
        if (r.status === 'reverted') throw new Error(`交易失败（已回滚）${hash.slice(0, 10)}…`)
        return r
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/回滚|reverted/i.test(msg)) throw e
    }
    await sleep(500)
  }
  return null
}

/** Arc 等慢/烂 RPC：等 receipt；超时抛带 hash 的提示（用于最终业务交易） */
async function waitTxReceipt(hash: `0x${string}`, label = '等待上链') {
  const soft = await waitTxReceiptSoft(hash, 60_000)
  if (soft) return soft
  throw new Error(
    `${label}超时（${hash.slice(0, 10)}…）。交易可能已发出，请到区块浏览器确认后再刷新。`,
  )
}

/**
 * 授权确认：receipt（钱包优先）或链上状态任一成功即继续。
 * 超过 softMs 仍无信号也返回 false（调用方会继续下一步，避免卡死）。
 */
async function waitApprovalReady(opts: {
  hash: `0x${string}`
  label: string
  onStatus?: (msg: string) => void
  check: () => Promise<boolean>
  /** 硬等上限；超时返回 false，由调用方乐观继续 */
  timeoutMs?: number
}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 12_000
  const start = Date.now()
  let n = 0
  opts.onStatus?.(`${opts.label}…`)

  while (Date.now() - start < timeoutMs) {
    n += 1
    if (n === 1 || n % 4 === 0) opts.onStatus?.(`${opts.label}…`)

    const viaWallet = await getReceiptViaWallet(opts.hash)
    if (viaWallet?.status === 'reverted') {
      throw new Error(`授权交易失败（已回滚）${opts.hash.slice(0, 10)}…`)
    }
    if (viaWallet?.status === 'success') {
      try {
        if (await opts.check()) return true
      } catch {
        /* ignore */
      }
      await sleep(300)
      return true
    }

    try {
      if (await opts.check()) return true
    } catch {
      /* RPC 抖一下 */
    }

    try {
      const r = await publicClient.getTransactionReceipt({ hash: opts.hash })
      if (r?.status === 'reverted') {
        throw new Error(`授权交易失败（已回滚）${opts.hash.slice(0, 10)}…`)
      }
      if (r?.status === 'success') {
        try {
          if (await opts.check()) return true
        } catch {
          /* ignore */
        }
        await sleep(300)
        return true
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/回滚|reverted/i.test(msg)) throw e
    }

    await sleep(400)
  }

  try {
    if (await opts.check()) return true
  } catch {
    /* ignore */
  }
  return false
}

/** estimateGas 超过 raceMs 就用 fallback，避免 Arc 上一直卡在「创建中」 */
async function estimateGasQuick(opts: {
  account: Address
  to: Address
  data: `0x${string}`
  value?: bigint
  fallback: bigint
  raceMs?: number
}): Promise<bigint> {
  const { account, to, data, value, fallback, raceMs = 1500 } = opts
  try {
    const estimated = await Promise.race([
      publicClient
        .estimateGas({
          account,
          to,
          data,
          value: value && value > 0n ? value : undefined,
        })
        .then((g) => (g * 130n) / 100n),
      new Promise<bigint>((resolve) => {
        setTimeout(() => resolve(fallback), raceMs)
      }),
    ])
    return estimated < 21_000n ? fallback : estimated
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    if (/MaximumAmountExceeded/i.test(raw)) throw e
    return fallback
  }
}

async function readErc20Allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  return withTimeout(
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, spender],
    }),
    4_000,
    '读取授权',
  )
}

async function readPermit2Allowance(
  owner: Address,
  token: Address,
): Promise<readonly [bigint, number, number]> {
  return withTimeout(
    publicClient.readContract({
      address: CONTRACTS.permit2,
      abi: permit2Abi,
      functionName: 'allowance',
      args: [owner, token, CONTRACTS.v4PositionManager],
    }),
    4_000,
    '读取 Permit2',
  ) as Promise<readonly [bigint, number, number]>
}

/**
 * V4 授权：ERC20→Permit2，再 Permit2→PositionManager。
 * Arc：钱包 receipt 优先；会话缓存已授权，避免 RPC 读不到 allowance 时卡死/点三次。
 */
async function ensurePermit2(
  walletClient: WalletClient,
  token: Address,
  owner: Address,
  amount: bigint,
  onStatus?: (msg: string) => void,
) {
  if (isNativeCurrency(token) || amount <= 0n) return

  const eKey = erc20Permit2Key(token, owner)
  const pKey = permit2PmKey(token, owner)

  let allowance = 0n
  if (!sessionErc20Permit2Ok.has(eKey)) {
    try {
      allowance = await readErc20Allowance(token, owner, CONTRACTS.permit2)
    } catch {
      allowance = 0n
    }
  } else {
    allowance = amount // 本会话已确认过
  }

  if (allowance < amount) {
    onStatus?.('需要授权代币给 Permit2，请在钱包确认…')
    const hash = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [CONTRACTS.permit2, (1n << 256n) - 1n],
      gas: 100_000n,
      chain: walletClient.chain,
      account: owner,
    })
    onStatus?.(`代币授权已提交 ${hash.slice(0, 10)}…，确认生效中`)
    const ok = await waitApprovalReady({
      hash,
      label: '确认代币授权生效',
      onStatus,
      timeoutMs: 14_000,
      check: async () => (await readErc20Allowance(token, owner, CONTRACTS.permit2)) >= amount,
    })
    // 即使用户钱包已确认，Arc 也可能读不到 receipt/allowance —— 缓存并继续弹下一笔
    sessionErc20Permit2Ok.add(eKey)
    onStatus?.(ok ? '代币授权已生效' : '代币授权已提交，继续 Permit2…')
    // 给节点一点传播时间，再弹下一笔，降低「授权未生效」失败率
    if (!ok) await sleep(1200)
  } else {
    sessionErc20Permit2Ok.add(eKey)
  }

  const now = Math.floor(Date.now() / 1000)
  let needPermit2 = !sessionPermit2PmOk.has(pKey)
  if (needPermit2) {
    try {
      const [allowedAmount, expiration] = await readPermit2Allowance(owner, token)
      if (allowedAmount >= amount && Number(expiration) > now + 60) {
        needPermit2 = false
        sessionPermit2PmOk.add(pKey)
      }
    } catch {
      /* 读失败则走授权 */
    }
  }
  if (!needPermit2) return

  onStatus?.('需要 Permit2 授权 PositionManager，请在钱包确认…')
  const hash2 = await walletClient.writeContract({
    address: CONTRACTS.permit2,
    abi: permit2Abi,
    functionName: 'approve',
    args: [token, CONTRACTS.v4PositionManager, maxUint160, Number(maxUint48)],
    gas: 120_000n,
    chain: walletClient.chain,
    account: owner,
  })
  onStatus?.(`Permit2 授权已提交 ${hash2.slice(0, 10)}…，确认生效中`)
  const ok2 = await waitApprovalReady({
    hash: hash2,
    label: '确认 Permit2 授权生效',
    onStatus,
    timeoutMs: 14_000,
    check: async () => {
      const [amt, exp] = await readPermit2Allowance(owner, token)
      return amt >= amount && Number(exp) > Math.floor(Date.now() / 1000) + 30
    },
  })
  sessionPermit2PmOk.add(pKey)
  onStatus?.(ok2 ? 'Permit2 授权已生效' : 'Permit2 已提交，继续交易…')
  if (!ok2) await sleep(1200)
}

async function readTokenBalance(token: Address, owner: Address): Promise<bigint> {
  if (isNativeCurrency(token)) {
    return withTimeout(publicClient.getBalance({ address: owner }), 8_000, '读取原生余额')
  }
  return withTimeout(
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    }),
    8_000,
    '读取代币余额',
  )
}

/** 注入前检查钱包余额；原生侧还要留 gas */
async function assertV4SeedBalances(opts: {
  owner: Address
  currency0: Address
  currency1: Address
  need0: bigint
  need1: bigint
  value: bigint
}) {
  const { owner, currency0, currency1, need0, need1, value } = opts
  const gasReserve = 10n ** 15n // 0.001 原生币留作 gas
  const [bal0, bal1] = await Promise.all([
    readTokenBalance(currency0, owner),
    readTokenBalance(currency1, owner),
  ])

  const check = (currency: Address, need: bigint, bal: bigint, side: '0' | '1') => {
    if (need <= 0n) return
    if (isNativeCurrency(currency)) {
      const needNative = value > need ? value : need
      const total = needNative + gasReserve
      if (bal < total) {
        throw new Error(
          `BNB/原生币不足：注入约需 ${(Number(needNative) / 1e18).toPrecision(6)}，另留 gas，当前余额 ${(Number(bal) / 1e18).toPrecision(6)}。请减少注入或取消「用原生 BNB」。`,
        )
      }
      return
    }
    if (bal < need) {
      throw new Error(
        `代币${side} 余额不足：需要 ${need.toString()}（最小单位），钱包只有 ${bal.toString()}。请减少注入数量或先买入该代币。`,
      )
    }
  }
  check(currency0, need0, bal0, '0')
  check(currency1, need1, bal1, '1')
}

/** V4 必须 ERC20→Permit2→PositionManager；缺一不可 */
async function assertPermit2Ready(owner: Address, token: Address, amount: bigint) {
  if (isNativeCurrency(token) || amount <= 0n) return
  try {
    const erc20 = await readErc20Allowance(token, owner, CONTRACTS.permit2)
    if (erc20 < amount) {
      sessionErc20Permit2Ok.delete(erc20Permit2Key(token, owner))
      throw new Error(
        '代币尚未授权给 Permit2（或授权未上链）。请重新点创建，先完成「授权给 Permit2」那一笔。',
      )
    }
    const [allowed, expiration] = await readPermit2Allowance(owner, token)
    const now = Math.floor(Date.now() / 1000)
    if (allowed < amount || Number(expiration) <= now + 30) {
      sessionPermit2PmOk.delete(permit2PmKey(token, owner))
      throw new Error(
        'Permit2 尚未授权 PositionManager（或已过期）。V4 需要两步授权：①代币→Permit2 ②Permit2→仓位管理。请重新操作并确认两笔授权。',
      )
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/Permit2|授权/.test(msg)) throw e instanceof Error ? e : new Error(msg)
    // 读失败不硬挡（部分 RPC 抖），交给链上/钱包
  }
}

async function writeModifyLiquidities(opts: {
  walletClient: WalletClient
  owner: Address
  unlockData: `0x${string}`
  value?: bigint
  action: string
  onStatus?: (msg: string) => void
}) {
  const { walletClient, owner, unlockData, value = 0n, action, onStatus } = opts
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
  const data = encodeFunctionData({
    abi: v4PositionManagerAbi,
    functionName: 'modifyLiquidities',
    args: [unlockData, deadline],
  })
  onStatus?.(`准备 ${action}…`)
  let gas: bigint
  try {
    gas = await estimateGasQuick({
      account: owner,
      to: CONTRACTS.v4PositionManager,
      data,
      value,
      fallback: 1_800_000n,
    })
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    if (/MaximumAmountExceeded/i.test(raw)) {
      throw new Error(
        `${action} 失败：滑点保护触发（MaximumAmountExceeded）。把顶部滑点调大一点，两边数量按现价重新配平后再试。`,
      )
    }
    if (/STF|transfer|TRANSFER|delta|CurrencyNotSettled|not settled/i.test(raw)) {
      throw new Error(
        `${action} 失败：疑似带转账税/到账不足。请在新建仓填写「转账税 bps」（0.25%=25，约 1%=100）后重试。原始：${raw.slice(0, 160)}`,
      )
    }
    throw new Error(`${action} 失败：${raw.slice(0, 220)}`)
  }
  onStatus?.(`请在钱包确认 ${action}…`)
  return walletClient.writeContract({
    address: CONTRACTS.v4PositionManager,
    abi: v4PositionManagerAbi,
    functionName: 'modifyLiquidities',
    args: [unlockData, deadline],
    value: value > 0n ? value : undefined,
    gas,
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
 * 注意：0x0 永远最小，切池后 token0/1 顺序可能翻转，调用方必须 remapAmountsAcrossPools。
 */
async function resolvePoolForEthPayment(pool: PoolInfo, useNativeEth: boolean): Promise<PoolInfo> {
  if (!useNativeEth) return pool
  const c0 = pool.token0.address
  const c1 = pool.token1.address
  if (isNativeCurrency(c0) || isNativeCurrency(c1)) return pool
  const weth0 = c0.toLowerCase() === CONTRACTS.weth.toLowerCase()
  const weth1 = c1.toLowerCase() === CONTRACTS.weth.toLowerCase()
  if (!weth0 && !weth1) return pool

  const other = weth0 ? c1 : c0
  const [currency0, currency1] = sortCurrencies(NATIVE_ETH, other)
  try {
    const nativePool = await loadV4Pool({
      currency0,
      currency1,
      fee: pool.fee,
      tickSpacing: pool.tickSpacing,
      hooks: pool.hooks ?? NATIVE_ETH,
    })
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
  if (!useNativeEth || !chainHasWrappedNative()) return
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
  await waitTxReceipt(hash, 'Wrap ETH 确认')
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
  /**
   * 代币转账税（bps）。对非原生侧生效。
   * 例：25 = 0.25%，99 ≈ 0.99%。带税币必须垫付 settle，否则 PoolManager 到账不足会 revert。
   */
  transferTaxBps0?: number
  transferTaxBps1?: number
  onStatus?: (msg: string) => void
}) {
  const { walletClient, owner, onStatus } = opts
  const slippageBps = opts.slippageBps ?? 300
  const useNativeEth = Boolean(opts.useNativeEth)
  if (opts.pool.version !== 'v4' || !opts.pool.poolId) throw new Error('需要 V4 池')

  // 优先原生 ETH 池：一笔 msg.value 入金，无需先 Wrap → WETH
  const srcPool = opts.pool
  const pool = await resolvePoolForEthPayment(srcPool, useNativeEth)
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

  // WETH→原生池时 token 顺序可能翻转，先按币种对齐再配平
  const aligned = remapAmountsAcrossPools(
    srcPool.token0.address,
    srcPool.token1.address,
    live.token0.address,
    live.token1.address,
    opts.amount0,
    opts.amount1,
  )
  const taxFor = (currency: Address): number => {
    if (isNativeCurrency(currency) || isEthLikeCurrency(currency)) return 0
    const c = currency.toLowerCase()
    if (c === srcPool.token0.address.toLowerCase()) return Math.max(0, opts.transferTaxBps0 ?? 0)
    if (c === srcPool.token1.address.toLowerCase()) return Math.max(0, opts.transferTaxBps1 ?? 0)
    if (c === live.token0.address.toLowerCase()) return Math.max(0, opts.transferTaxBps0 ?? 0)
    if (c === live.token1.address.toLowerCase()) return Math.max(0, opts.transferTaxBps1 ?? 0)
    return 0
  }
  const taxBps0 = taxFor(live.token0.address)
  const taxBps1 = taxFor(live.token1.address)
  // 用户填的是钱包愿付；扣税后净额才是能进池的量
  const user0 = aligned.amount0
  const user1 = aligned.amount1
  const net0 = netAfterTransferTax(user0, taxBps0)
  const net1 = netAfterTransferTax(user1, taxBps1)

  const paired = resolvePairedMintAmounts({
    sqrtPriceX96: live.sqrtPriceX96,
    tickLower,
    tickUpper,
    amount0: net0,
    amount1: net1,
  })
  let amount0 = paired.amount0
  let amount1 = paired.amount1
  if (amount0 <= 0n && amount1 <= 0n) throw new Error('数量必须 > 0（若填了转账税，请加大数量）')

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

  const maxed = maxAmountsForLiquidity({
    sqrtPriceX96: live.sqrtPriceX96,
    tickLower,
    tickUpper,
    liquidity,
    slippageBps,
  })
  // 税币：债务上限不能超过「用户支付能到账的净额」，settle 按用户实付
  let amount0Max = maxed.amount0Max
  let amount1Max = maxed.amount1Max
  if (taxBps0 > 0 && !nativeIs0 && amount0Max > net0) amount0Max = net0
  if (taxBps1 > 0 && !nativeIs1 && amount1Max > net1) amount1Max = net1
  if (maxed.amount0 > amount0Max || maxed.amount1 > amount1Max) {
    throw new Error('转账税占用后不足以覆盖滑点缓冲，请减少约 3–5% 数量后重试')
  }
  const need0 = maxed.amount0
  const need1 = maxed.amount1

  const settle = buildMintSettlePlan({
    currency0: key.currency0,
    currency1: key.currency1,
    amount0Max,
    amount1Max,
    taxBps0: nativeIs0 ? 0 : taxBps0,
    taxBps1: nativeIs1 ? 0 : taxBps1,
    recipient: owner,
    pay0: taxBps0 > 0 && !nativeIs0 ? user0 : undefined,
    pay1: taxBps1 > 0 && !nativeIs1 ? user1 : undefined,
  })
  if (taxBps0 > 0 || taxBps1 > 0) {
    onStatus?.(
      `已按转账税垫付 settle（${taxBps0 || taxBps1} bps），否则带税币 V4 会因到账不足失败…`,
    )
  }

  // 原生 ETH 侧不走 Permit2；税币侧按垫付额度授权
  await ensurePermit2(walletClient, key.currency0, owner, nativeIs0 ? 0n : settle.permit0, onStatus)
  await ensurePermit2(walletClient, key.currency1, owner, nativeIs1 ? 0n : settle.permit1, onStatus)

  const actions: number[] = [V4_ACTIONS.MINT_POSITION, ...settle.actions]
  const params: `0x${string}`[] = [
    encodeMintParams(key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner),
    ...settle.params,
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
    onStatus,
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
  /**
   * 与 tokenA / tokenB 对齐的注入数量（推荐）。
   * 勿按 WBNB 地址排序后再当 amount0/1 传入——原生 BNB 在 V4 是 0x0，排序与 WBNB 不同。
   */
  amountA?: bigint
  amountB?: bigint
  /** @deprecated 已按 currency0/1 排好的数量；若同时给了 amountA/B 则忽略 */
  amount0?: bigint
  amount1?: bigint
  tickLower?: number
  tickUpper?: number
  useNativeEth?: boolean
  hooks?: Address
  slippageBps?: number
  /** 与 tokenA / tokenB 对齐的转账税 bps */
  transferTaxBpsA?: number
  transferTaxBpsB?: number
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
  const taxA = Math.max(0, opts.transferTaxBpsA ?? 0)
  const taxB = Math.max(0, opts.transferTaxBpsB ?? 0)
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

  // tokenA/B 数量 → 排序后的 amount0/1（原生=0x0，切勿用 WBNB 地址参与排序）
  const mapAbTo01 = (amtA: bigint, amtB: bigint): { amount0: bigint; amount1: bigint } => {
    if (currency0.toLowerCase() === rawA.toLowerCase()) return { amount0: amtA, amount1: amtB }
    return { amount0: amtB, amount1: amtA }
  }
  const tax01 = mapAbTo01(BigInt(taxA), BigInt(taxB))
  const taxBps0 = Number(tax01.amount0)
  const taxBps1 = Number(tax01.amount1)
  const key: V4PoolKey = {
    currency0,
    currency1,
    fee,
    tickSpacing,
    hooks: opts.hooks ?? NATIVE_ETH,
  }

  onStatus?.('读取代币精度与池状态…')
  // 小数位：原生币按链原生精度（Arc USDC 内部 18）
  const decOf = async (c: Address) => {
    if (isNativeCurrency(c)) return 18
    return Number(
      await withTimeout(
        publicClient.readContract({ address: c, abi: erc20Abi, functionName: 'decimals' }),
        15_000,
        '读取 decimals',
      ),
    )
  }
  const [dec0, dec1] = await Promise.all([decOf(currency0), decOf(currency1)])

  // B per A → token1 per token0
  let sortedPrice = initialPriceBPerA
  if (currency0.toLowerCase() !== rawA.toLowerCase()) sortedPrice = 1 / initialPriceBPerA
  const sqrtPriceX96 = priceToSqrtPriceX96(sortedPrice, dec0, dec1)
  const initTick = priceToClosestTick(sortedPrice, dec0, dec1)

  const seedFromAb = opts.amountA != null || opts.amountB != null
  const seedMapped = seedFromAb
    ? mapAbTo01(opts.amountA ?? 0n, opts.amountB ?? 0n)
    : { amount0: opts.amount0 ?? 0n, amount1: opts.amount1 ?? 0n }

  // 已存在且已初始化 → 只走 mint（如有数量）
  const existing = await loadV4Pool(key).catch(() => null)
  if (existing && existing.sqrtPriceX96 > 0n) {
    if (seedMapped.amount0 <= 0n && seedMapped.amount1 <= 0n) {
      throw new Error('该 V4 池已存在；请到下方直接加仓，或更换 Fee / spacing')
    }
    onStatus?.('池已存在，改为注入流动性…')
    const hash = await mintV4Position({
      walletClient,
      owner,
      pool: existing,
      amount0: seedMapped.amount0,
      amount1: seedMapped.amount1,
      tickLower: opts.tickLower,
      tickUpper: opts.tickUpper,
      useNativeEth: useNative,
      slippageBps,
      transferTaxBps0: taxBps0,
      transferTaxBps1: taxBps1,
      onStatus,
    })
    return { pool: await loadV4Pool(key), hash, seeded: true }
  }

  const wantSeed = seedMapped.amount0 > 0n || seedMapped.amount1 > 0n
  let tickLower = opts.tickLower
  let tickUpper = opts.tickUpper
  let amount0 = seedMapped.amount0
  let amount1 = seedMapped.amount1
  let liquidity = 0n
  let amount0Max = 0n
  let amount1Max = 0n
  let value = 0n
  let settlePlan: ReturnType<typeof buildMintSettlePlan> | null = null

  if (wantSeed) {
    if (tickLower == null || tickUpper == null) {
      const r = rangeFromPercent(initTick, 5, tickSpacing)
      tickLower = r.tickLower
      tickUpper = r.tickUpper
    }
    tickLower = nearestUsableTick(tickLower, tickSpacing)
    tickUpper = nearestUsableTick(tickUpper, tickSpacing)
    if (tickLower >= tickUpper) throw new Error('区间无效')

    const user0 = amount0
    const user1 = amount1
    const net0 = netAfterTransferTax(user0, taxBps0)
    const net1 = netAfterTransferTax(user1, taxBps1)
    const paired = resolvePairedMintAmounts({
      sqrtPriceX96,
      tickLower,
      tickUpper,
      amount0: net0,
      amount1: net1,
    })
    amount0 = paired.amount0
    amount1 = paired.amount1
    if (amount0 <= 0n && amount1 <= 0n) throw new Error('注入数量必须 > 0')

    if (chainHasWrappedNative() && !isNativeCurrency(currency0) && !isNativeCurrency(currency1)) {
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
    const seedTax0 = isNativeCurrency(currency0) ? 0 : taxBps0
    const seedTax1 = isNativeCurrency(currency1) ? 0 : taxBps1
    if (seedTax0 > 0 && amount0Max > net0) amount0Max = net0
    if (seedTax1 > 0 && amount1Max > net1) amount1Max = net1
    if (maxed.amount0 > amount0Max || maxed.amount1 > amount1Max) {
      throw new Error('转账税占用后不足以覆盖滑点缓冲，请减少约 3–5% 数量后重试')
    }
    if (isNativeCurrency(currency0)) value = bumpAmountMax(maxed.amount0, slippageBps)
    if (isNativeCurrency(currency1)) value = bumpAmountMax(maxed.amount1, slippageBps)

    settlePlan = buildMintSettlePlan({
      currency0,
      currency1,
      amount0Max,
      amount1Max,
      taxBps0: seedTax0,
      taxBps1: seedTax1,
      recipient: owner,
      pay0: seedTax0 > 0 ? user0 : undefined,
      pay1: seedTax1 > 0 ? user1 : undefined,
    })

    // 弹钱包前预检：余额 / Permit2（税币按垫付额度）
    await assertV4SeedBalances({
      owner,
      currency0,
      currency1,
      need0: settlePlan.permit0 > amount0Max ? settlePlan.permit0 : maxed.amount0,
      need1: settlePlan.permit1 > amount1Max ? settlePlan.permit1 : maxed.amount1,
      value,
    })

    await ensurePermit2(walletClient, currency0, owner, settlePlan.permit0, onStatus)
    await ensurePermit2(walletClient, currency1, owner, settlePlan.permit1, onStatus)
    await assertPermit2Ready(owner, currency0, settlePlan.permit0)
    await assertPermit2Ready(owner, currency1, settlePlan.permit1)
  }

  const initData = encodeFunctionData({
    abi: v4PositionManagerAbi,
    functionName: 'initializePool',
    args: [key, sqrtPriceX96],
  })

  let calls: `0x${string}`[] = [initData]
  if (wantSeed && tickLower != null && tickUpper != null && settlePlan) {
    const actions: number[] = [V4_ACTIONS.MINT_POSITION, ...settlePlan.actions]
    const params: `0x${string}`[] = [
      encodeMintParams(key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner),
      ...settlePlan.params,
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

  onStatus?.(wantSeed ? '准备创建 V4 池并注入…' : '准备创建并初始化 V4 池…')
  const gas = await estimateGasQuick({
    account: owner,
    to: CONTRACTS.v4PositionManager,
    data,
    value,
    // init + mint 较重；估 gas 卡住时用此值尽快弹钱包
    fallback: wantSeed ? 3_500_000n : 800_000n,
    raceMs: 1500,
  })

  onStatus?.(wantSeed ? '请在钱包确认：创建 V4 池并注入流动性…' : '请在钱包确认：创建 V4 池…')
  const hash = await walletClient.writeContract({
    address: CONTRACTS.v4PositionManager,
    abi: v4PositionManagerAbi,
    functionName: 'multicall',
    args: [calls],
    value: value > 0n ? value : undefined,
    gas,
    chain: walletClient.chain,
    account: owner,
  })
  onStatus?.(`创建交易已提交 ${hash.slice(0, 10)}…，确认上链中`)
  const receipt = await waitTxReceiptSoft(hash, 60_000)
  // Arc 上 receipt 常读不到：轮询池是否已初始化
  const waitPoolMs = receipt ? 15_000 : 75_000
  const poolStart = Date.now()
  let poolReady = false
  let n = 0
  while (Date.now() - poolStart < waitPoolMs) {
    n += 1
    if (n === 1 || n % 4 === 0) onStatus?.('确认池已创建…')
    try {
      const p = await loadV4Pool(key)
      if (p && p.sqrtPriceX96 > 0n) {
        poolReady = true
        return { pool: p, hash, seeded: wantSeed }
      }
    } catch {
      /* RPC 抖一下 */
    }
    await sleep(700)
  }
  const pool = await loadV4Pool(key).catch(() => null)
  if (!pool || !(pool.sqrtPriceX96 > 0n)) {
    throw new Error(
      poolReady
        ? '创建成功但尚未读到池价，请稍后刷新'
        : `创建交易已发出（${hash.slice(0, 10)}…）但尚未读到池状态。请到浏览器确认成功后刷新再加仓。`,
    )
  }
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
  transferTaxBps0?: number
  transferTaxBps1?: number
  /**
   * 手续费复投：两边数量都是上限，不再按单边配平放大另一侧，
   * 且 amountMax 不超过提供量，避免 SETTLE 从钱包多扣本金。
   */
  capToProvided?: boolean
  onStatus?: (msg: string) => void
}) {
  const { walletClient, owner, position, onStatus } = opts
  const slippageBps = opts.slippageBps ?? 300
  if (position.version !== 'v4') throw new Error('需要 V4 仓位')
  const key = poolKeyFromPosition(position)
  const live = await loadV4Pool(key)
  const taxBps0 = isNativeCurrency(key.currency0) ? 0 : Math.max(0, opts.transferTaxBps0 ?? 0)
  const taxBps1 = isNativeCurrency(key.currency1) ? 0 : Math.max(0, opts.transferTaxBps1 ?? 0)
  const user0 = opts.amount0
  const user1 = opts.amount1
  const net0 = netAfterTransferTax(user0, taxBps0)
  const net1 = netAfterTransferTax(user1, taxBps1)

  let amount0 = user0
  let amount1 = user1
  if (!opts.capToProvided) {
    const paired = resolvePairedMintAmounts({
      sqrtPriceX96: live.sqrtPriceX96,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      amount0: net0,
      amount1: net1,
    })
    amount0 = paired.amount0
    amount1 = paired.amount1
  } else {
    amount0 = net0
    amount1 = net1
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
    if (taxBps0 > 0 && amount0Max > net0) amount0Max = net0
    if (taxBps1 > 0 && amount1Max > net1) amount1Max = net1
    if (need0 > amount0Max || need1 > amount1Max) {
      throw new Error('转账税占用后不足以覆盖滑点缓冲，请减少约 3–5% 数量后重试')
    }
  }

  const settle = buildMintSettlePlan({
    currency0: key.currency0,
    currency1: key.currency1,
    amount0Max,
    amount1Max,
    taxBps0,
    taxBps1,
    recipient: owner,
    pay0: taxBps0 > 0 ? user0 : undefined,
    pay1: taxBps1 > 0 ? user1 : undefined,
  })

  await ensurePermit2(walletClient, key.currency0, owner, nativeIs0 ? 0n : settle.permit0, onStatus)
  await ensurePermit2(walletClient, key.currency1, owner, nativeIs1 ? 0n : settle.permit1, onStatus)

  const actions: number[] = [V4_ACTIONS.INCREASE_LIQUIDITY, ...settle.actions]
  const params: `0x${string}`[] = [
    encodeModifyLiqParams(position.tokenId, liquidity, amount0Max, amount1Max),
    ...settle.params,
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
    onStatus,
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
