import { useEffect, useMemo, useRef, useState } from 'react'
import type { Address } from 'viem'
import { getActiveChainId, getNativeSymbol } from './chain'
import {
  formatAmount,
  getCoinQuote,
  isEthLikeCurrency,
  pairHasWeth,
  type DiscoveredPool,
  type PoolInfo,
  type TokenMeta,
} from './lp'
import { formatAmountExact, formatPrice, formatUsd, parseAmount, rawToNumber } from './math'
import { publicClient, shortAddr } from './wallet'
import {
  allocateDlmmAmounts,
  buildEvmDlmmPercentPlan,
  buildEvmDlmmTranches,
  type DlmmExecutionMode,
  type DlmmShape,
  type DlmmSide,
  type EvmDlmmPlan,
} from './dlmm'
import { usePersistentState } from './prefs'
import { InfoHint } from './ui'

export type DlmmMintRequest = {
  side: DlmmSide
  executionMode: DlmmExecutionMode
  shape: DlmmShape
  trancheCount: number
  plan: EvmDlmmPlan
  amount0: string
  amount1: string
}

type Props = {
  pool: PoolInfo | null
  poolInput: string
  discovered: DiscoveredPool[] | null
  discovering: boolean
  busy: boolean
  address: Address | null
  walletReady: boolean
  balance0: bigint
  balance1: bigint
  nativeBalance: bigint
  useNativeEth: boolean
  transferTaxBps: number
  onPoolInput: (value: string) => void
  onLoadPool: () => void
  onPickPool: (pool: PoolInfo) => void
  onRefreshPool: () => void
  onUseNativeEth: (value: boolean) => void
  onTransferTaxBps: (value: number) => void
  onOpenClassic: () => void
  onExecute: (request: DlmmMintRequest) => void
}

type FriendlyRangePreset = 'near' | 'balanced' | 'deep' | 'wide' | 'custom'
type RangeUnit = 'price' | 'market-cap'

const RANGE_PRESETS: Array<{
  key: Exclude<FriendlyRangePreset, 'custom'>
  label: string
  note: string
  ranges: Record<DlmmSide, readonly [number, number]>
}> = [
  {
    key: 'near',
    label: '近价',
    note: '更快成交',
    ranges: { bid: [-10, -0.1], ask: [0.1, 10], both: [-10, 10] },
  },
  {
    key: 'balanced',
    label: '均衡',
    note: '推荐',
    ranges: { bid: [-30, -0.1], ask: [0.1, 40], both: [-30, 40] },
  },
  {
    key: 'deep',
    label: '深度',
    note: '等待波动',
    ranges: { bid: [-60, -2], ask: [2, 80], both: [-50, 80] },
  },
  {
    key: 'wide',
    label: '极宽',
    note: '覆盖极端',
    ranges: { bid: [-85, -5], ask: [5, 160], both: [-75, 160] },
  },
]

const totalSupplyAbi = [{
  type: 'function',
  name: 'totalSupply',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ type: 'uint256' }],
}] as const

const supplyCache = new Map<string, number | null>()

function clamp(raw: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, raw))
}

function clampInt(raw: number, min: number, max: number, fallback: number): number {
  return Math.floor(clamp(raw, min, max, fallback))
}

function pctFromSpot(price: number, spot: number): string {
  if (!(price > 0) || !(spot > 0)) return '—'
  const pct = ((price / spot) - 1) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(Math.abs(pct) >= 100 ? 0 : 2)}%`
}

function tokenIndex(pool: PoolInfo, token: TokenMeta): 0 | 1 {
  return pool.token0.address.toLowerCase() === token.address.toLowerCase() ? 0 : 1
}

function inputNumber(value: number): string {
  if (!(value > 0) || !Number.isFinite(value)) return ''
  if (value >= 1e12 || value < 1e-8) return value.toExponential(6)
  return String(Number(value.toPrecision(9)))
}

function parseAmountSafe(input: string, decimals: number): bigint {
  try {
    return parseAmount(input, decimals)
  } catch {
    return 0n
  }
}

function sideLabel(side: DlmmSide): string {
  if (side === 'bid') return 'Bid 低价买入'
  if (side === 'ask') return 'Ask 高价卖出'
  return '双边做市'
}

function sideShort(side: DlmmSide): string {
  if (side === 'bid') return 'Bid'
  if (side === 'ask') return 'Ask'
  return '双边'
}

export default function DlmmMode(props: Props) {
  const {
    pool,
    poolInput,
    discovered,
    discovering,
    busy,
    address,
    walletReady,
    balance0,
    balance1,
    nativeBalance,
    useNativeEth,
    transferTaxBps,
    onPoolInput,
    onLoadPool,
    onPickPool,
    onRefreshPool,
    onUseNativeEth,
    onTransferTaxBps,
    onOpenClassic,
    onExecute,
  } = props

  const [side, setSide] = usePersistentState<DlmmSide>('dlmmSide', 'bid')
  const [executionMode, setExecutionMode] = usePersistentState<DlmmExecutionMode>('dlmmExecutionMode', 'multi')
  const [shape, setShape] = usePersistentState<DlmmShape>('dlmmShape', 'bid-ask')
  const [trancheCount, setTrancheCount] = usePersistentState('dlmmTrancheCount', 8)
  const [rangePreset, setRangePreset] = usePersistentState<FriendlyRangePreset>('dlmmRangePreset', 'balanced')
  const [lowerPct, setLowerPct] = usePersistentState('dlmmRangeLowerPct', -30)
  const [upperPct, setUpperPct] = usePersistentState('dlmmRangeUpperPct', -0.1)
  const [amountCoin, setAmountCoin] = useState('')
  const [amountQuote, setAmountQuote] = useState('')
  const [showPoolPicker, setShowPoolPicker] = useState(!pool)
  const [formError, setFormError] = useState('')
  const [rangeUnit, setRangeUnit] = useState<RangeUnit>('price')
  const [coinSupply, setCoinSupply] = useState<number | null>(null)
  const [supplyLoading, setSupplyLoading] = useState(false)
  const supplyRequestKey = useRef('')

  const poolKey = pool
    ? `${pool.version}:${pool.poolAddress ?? pool.poolId ?? ''}:${pool.fee}:${pool.tickSpacing}`
    : ''
  const quote = useMemo(() => (pool ? getCoinQuote(pool) : null), [pool])
  const pairUsesNative = pool ? pairHasWeth(pool.token0.address, pool.token1.address) : false
  const coinIndex = pool && quote ? tokenIndex(pool, quote.coin) : 0
  const quoteIndex = pool && quote ? tokenIndex(pool, quote.quote) : 1
  const gasReserve = 10n ** 15n

  const usesNative = (token: TokenMeta | null): boolean => Boolean(
    token && useNativeEth && pairUsesNative && isEthLikeCurrency(token.address),
  )
  const displaySymbol = (token: TokenMeta | null): string => (
    token ? (usesNative(token) ? getNativeSymbol() : token.symbol) : ''
  )
  const balanceFor = (index: 0 | 1, token: TokenMeta | null): bigint => {
    if (usesNative(token)) return nativeBalance
    return index === 0 ? balance0 : balance1
  }
  const spendableFor = (index: 0 | 1, token: TokenMeta | null): bigint => {
    const balance = balanceFor(index, token)
    return usesNative(token) ? (balance > gasReserve ? balance - gasReserve : 0n) : balance
  }

  const coinRaw = quote ? parseAmountSafe(amountCoin || '0', quote.coin.decimals) : 0n
  const quoteRaw = quote ? parseAmountSafe(amountQuote || '0', quote.quote.decimals) : 0n
  const inferredSide: DlmmSide = coinRaw > 0n && quoteRaw > 0n
    ? 'both'
    : quoteRaw > 0n
      ? 'bid'
      : coinRaw > 0n
        ? 'ask'
        : side

  const applyPreset = (
    nextSide: DlmmSide,
    preset: Exclude<FriendlyRangePreset, 'custom'> = 'balanced',
  ) => {
    const config = RANGE_PRESETS.find((row) => row.key === preset) ?? RANGE_PRESETS[1]!
    const [lower, upper] = config.ranges[nextSide]
    setSide(nextSide)
    setRangePreset(preset)
    setLowerPct(lower)
    setUpperPct(upper)
    setFormError('')
  }

  useEffect(() => {
    setShowPoolPicker(!poolKey)
    setAmountCoin('')
    setAmountQuote('')
    setFormError('')
    if (rangePreset !== 'custom') applyPreset(side, rangePreset)
    // A pool change clears amounts; a custom relative range is intentionally reusable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolKey])

  useEffect(() => {
    if ((coinRaw > 0n || quoteRaw > 0n) && inferredSide !== side) {
      applyPreset(inferredSide, 'balanced')
    }
    // Only amount-side transitions should trigger the automatic Delta-style range.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inferredSide])

  useEffect(() => {
    setCoinSupply(null)
    setSupplyLoading(false)
    setRangeUnit('price')
    if (!quote || isEthLikeCurrency(quote.coin.address)) {
      supplyRequestKey.current = ''
      return
    }
    const key = `${getActiveChainId()}:${quote.coin.address.toLowerCase()}`
    supplyRequestKey.current = key
    if (supplyCache.has(key)) setCoinSupply(supplyCache.get(key) ?? null)
  }, [poolKey, quote])

  const enableMarketCap = async () => {
    if (!quote || isEthLikeCurrency(quote.coin.address)) return
    if (coinSupply) {
      setRangeUnit('market-cap')
      return
    }
    const key = `${getActiveChainId()}:${quote.coin.address.toLowerCase()}`
    supplyRequestKey.current = key
    setSupplyLoading(true)
    try {
      const raw = await publicClient.readContract({
        address: quote.coin.address,
        abi: totalSupplyAbi,
        functionName: 'totalSupply',
      })
      const supply = rawToNumber(raw, quote.coin.decimals)
      const safe = Number.isFinite(supply) && supply > 0 ? supply : null
      supplyCache.set(key, safe)
      if (supplyRequestKey.current === key) {
        setCoinSupply(safe)
        if (safe) setRangeUnit('market-cap')
        else setFormError('无法读取代币总供应量，市值模式暂不可用')
      }
    } catch {
      supplyCache.set(key, null)
      if (supplyRequestKey.current === key) {
        setCoinSupply(null)
        setFormError('无法读取代币总供应量，市值模式暂不可用')
      }
    } finally {
      if (supplyRequestKey.current === key) setSupplyLoading(false)
    }
  }

  useEffect(() => {
    if (rangeUnit === 'market-cap' && !coinSupply) setRangeUnit('price')
  }, [coinSupply, rangeUnit])

  const planState = useMemo(() => {
    if (!pool) return { plan: null, error: '' }
    try {
      return {
        plan: buildEvmDlmmPercentPlan(pool, lowerPct, upperPct, inferredSide),
        error: '',
      }
    } catch (error) {
      return { plan: null, error: error instanceof Error ? error.message : String(error) }
    }
  }, [pool, lowerPct, upperPct, inferredSide])
  const plan = planState.plan
  const tranches = useMemo(() => {
    if (!pool || !plan) return []
    return buildEvmDlmmTranches(pool, plan, shape, trancheCount)
  }, [pool, plan, shape, trancheCount])

  const amount0Raw = coinIndex === 0 ? coinRaw : quoteRaw
  const amount1Raw = coinIndex === 1 ? coinRaw : quoteRaw
  const allocations = useMemo(
    () => allocateDlmmAmounts(amount0Raw, amount1Raw, tranches),
    [amount0Raw, amount1Raw, tranches],
  )
  const amount0 = coinIndex === 0 ? amountCoin : amountQuote
  const amount1 = coinIndex === 1 ? amountCoin : amountQuote
  const coinSpendable = quote ? spendableFor(coinIndex, quote.coin) : 0n
  const quoteSpendable = quote ? spendableFor(quoteIndex, quote.quote) : 0n
  const coinShort = coinRaw > coinSpendable
  const quoteShort = quoteRaw > quoteSpendable
  const allocationsReady = executionMode === 'single' || (
    tranches.length >= 2
    && allocations.every((amount, index) => {
      const required = tranches[index]?.liquiditySide
      if (required === 0) return amount.amount0 > 0n
      if (required === 1) return amount.amount1 > 0n
      return amount.amount0 > 0n && amount.amount1 > 0n
    })
  )
  const hasAmount = coinRaw > 0n || quoteRaw > 0n
  const canExecute = Boolean(
    pool && plan && address && walletReady && !busy && hasAmount
    && !coinShort && !quoteShort && allocationsReady,
  )

  const sortedTranches = useMemo(
    () => [...tranches].sort((a, b) => a.coinPriceLower - b.coinPriceLower),
    [tranches],
  )
  const maxWeight = Math.max(1, ...tranches.map((row) => row.weightUnits))
  const addressForPool = pool?.poolAddress ?? pool?.poolId
  const spotPct = plan && plan.coinPriceUpper > plan.coinPriceLower
    ? clamp(
      ((plan.coinSpot - plan.coinPriceLower) / (plan.coinPriceUpper - plan.coinPriceLower)) * 100,
      0,
      100,
      50,
    )
    : 50

  const actionTitle = inferredSide === 'bid'
    ? `用 ${displaySymbol(quote?.quote ?? null)} 分批买入 ${quote?.coin.symbol ?? ''}`
    : inferredSide === 'ask'
      ? `分批卖出 ${quote?.coin.symbol ?? ''}`
      : `${quote?.coin.symbol ?? ''} / ${displaySymbol(quote?.quote ?? null)} 双边做市`
  const actionDescription = inferredSide === 'bid'
    ? '只填报价币，区间会自动锁在现价下方。'
    : inferredSide === 'ask'
      ? '只填标的币，区间会自动锁在现价上方。'
      : '两种币都填，价格范围覆盖现价并同时向两侧铺单。'

  const rangeValue = (price: number): number => (
    rangeUnit === 'market-cap' && coinSupply ? price * coinSupply : price
  )
  const valueToPrice = (value: number): number => (
    rangeUnit === 'market-cap' && coinSupply ? value / coinSupply : value
  )
  const rangeUnitLabel = rangeUnit === 'market-cap'
    ? `${quote?.quote.symbol ?? ''} FDV`
    : `${quote?.quote.symbol ?? ''}/${quote?.coin.symbol ?? ''}`

  const setPriceBoundary = (which: 'lower' | 'upper', raw: string) => {
    if (!quote) return
    const value = Number(raw)
    const price = valueToPrice(value)
    if (!(price > 0) || !Number.isFinite(price)) return
    const pct = ((price / quote.spot) - 1) * 100
    setRangePreset('custom')
    if (which === 'lower') setLowerPct(clamp(pct, -99.9, upperPct - 0.01, lowerPct))
    else setUpperPct(clamp(pct, lowerPct + 0.01, 1_000_000, upperPct))
  }

  const setPctBoundary = (which: 'lower' | 'upper', value: number) => {
    setRangePreset('custom')
    if (which === 'lower') setLowerPct(Math.min(value, upperPct - 0.1))
    else setUpperPct(Math.max(value, lowerPct + 0.1))
  }

  const fillAmount = (kind: 'coin' | 'quote', pct: number) => {
    if (!quote) return
    const token = kind === 'coin' ? quote.coin : quote.quote
    const available = kind === 'coin' ? coinSpendable : quoteSpendable
    const raw = (available * BigInt(pct)) / 100n
    if (kind === 'coin') setAmountCoin(formatAmountExact(raw, token.decimals))
    else setAmountQuote(formatAmountExact(raw, token.decimals))
    setFormError('')
  }

  const pickIntent = (next: DlmmSide) => {
    if (next === 'bid') setAmountCoin('')
    if (next === 'ask') setAmountQuote('')
    if (next === 'both' && (coinRaw <= 0n || quoteRaw <= 0n)) {
      setAmountCoin('')
      setAmountQuote('')
    }
    applyPreset(next, 'balanced')
  }

  const submit = () => {
    if (!pool || !plan || !quote) return
    if (!address) return setFormError('请先连接钱包')
    if (!walletReady) return setFormError('签名钱包未就绪，请重新连接或解锁本地私钥')
    if (!hasAmount) return setFormError('至少输入一种代币数量')
    if (coinShort) return setFormError(`${displaySymbol(quote.coin)} 余额不足`)
    if (quoteShort) return setFormError(`${displaySymbol(quote.quote)} 余额不足`)
    if (!allocationsReady) return setFormError('数量太小，无法覆盖全部链上档位；请减少档位或增加数量')
    setFormError('')
    onExecute({
      side: inferredSide,
      executionMode,
      shape,
      trancheCount: tranches.length,
      plan,
      amount0,
      amount1,
    })
  }

  const lowerSlider = inferredSide === 'ask' ? 0.1 : -95
  const lowerSliderMax = inferredSide === 'ask' ? 250 : inferredSide === 'bid' ? -0.1 : -0.1
  const upperSliderMin = inferredSide === 'bid' ? -94.9 : 0.1
  const upperSliderMax = 300

  return (
    <section className="page-dlmm dlmm-easy-page dlmm-delta-page">
      <div className="dlmm-page-head dlmm-easy-head">
        <div>
          <div className="dlmm-kicker"><span>EVM DLMM</span> V3 / V4 分档流动性</div>
          <h2>填金额，自动铺 Bid / Ask</h2>
          <p className="muted">只填一边自动单边挂单；两边都填自动跨现价做市。一笔交易创建全部价格档。</p>
        </div>
        <button className="btn" type="button" onClick={onOpenClassic}>经典建仓</button>
      </div>

      <div className="dlmm-pool-card dlmm-easy-pool">
        <div className="dlmm-pool-main">
          {pool && quote ? (
            <>
              <span className={`tag ${pool.version}`}>{pool.version.toUpperCase()}</span>
              <strong>{quote.coin.symbol} / {quote.quote.symbol}</strong>
              <span className="dlmm-pool-price">{formatPrice(quote.spot)} {quote.quote.symbol}</span>
              <span className="muted">手续费 {(pool.fee / 10_000).toFixed(2)}%</span>
              {addressForPool && <span className="mono muted">{shortAddr(addressForPool as Address)}</span>}
            </>
          ) : (
            <strong>先选择一个 V3 / V4 池</strong>
          )}
        </div>
        <div className="dlmm-pool-actions">
          {pool && <button className="btn" type="button" disabled={busy} onClick={onRefreshPool}>刷新现价</button>}
          <button
            className={`btn ${showPoolPicker ? 'active' : ''}`}
            type="button"
            aria-expanded={showPoolPicker}
            onClick={() => setShowPoolPicker((value) => !value)}
          >
            {pool ? '换池' : '选择池'}
          </button>
        </div>

        {showPoolPicker && (
          <div className="dlmm-pool-picker">
            <div className="inline">
              <input
                value={poolInput}
                onChange={(event) => onPoolInput(event.target.value)}
                placeholder="粘贴池地址、Uniswap 链接或代币合约"
                aria-label="池地址或代币合约"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onLoadPool()
                }}
              />
              <button className="btn primary" type="button" disabled={busy || discovering || !poolInput.trim()} onClick={onLoadPool}>
                {discovering ? '正在查找…' : busy ? '加载中…' : '查找池'}
              </button>
              <button className="btn" type="button" onClick={onOpenClassic}>完整选池器</button>
            </div>
            <p className="muted small">池地址会直接加载；代币合约会同时扫描可用的 V3 与 V4 池。</p>
            {discovered && discovered.length > 0 && (
              <div className="dlmm-discovered">
                {discovered.slice(0, 8).map((row) => {
                  const rowQuote = getCoinQuote(row.pool)
                  const key = `${row.pool.version}:${row.pool.poolAddress ?? row.pool.poolId}:${row.pool.fee}:${row.pool.tickSpacing}`
                  return (
                    <button key={key} className="dlmm-pool-option" type="button" onClick={() => onPickPool(row.pool)}>
                      <span className={`tag ${row.pool.version}`}>{row.pool.version.toUpperCase()}</span>
                      <strong>{rowQuote.coin.symbol}/{rowQuote.quote.symbol}</strong>
                      <span>{(row.pool.fee / 10_000).toFixed(2)}%</span>
                      <span className="mono">{formatPrice(row.coinPrice)} {row.quoteSymbol}</span>
                      <span className="muted">{row.tvlUsd == null ? '链上池' : formatUsd(row.tvlUsd)}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {!pool || !quote ? (
        <div className="dlmm-empty">
          <div className="dlmm-empty-mark" aria-hidden>1</div>
          <h3>先选择你要铺单的池</h3>
          <p className="muted">选好后会自动识别标的币与报价币，并按真实池价生成 V3 / V4 档位。</p>
          <button className="btn primary" type="button" onClick={() => setShowPoolPicker(true)}>选择池</button>
        </div>
      ) : (
        <div className="dlmm-terminal dlmm-delta-terminal">
          <div className="dlmm-market dlmm-delta-market">
            <div className="dlmm-market-head dlmm-delta-market-head">
              <div>
                <span className="muted small">当前价格</span>
                <strong className="dlmm-spot">{formatPrice(plan?.coinSpot ?? quote.spot)}</strong>
                <span className="muted"> {quote.quote.symbol}/{quote.coin.symbol}</span>
              </div>
              <div className="dlmm-range-unit" role="group" aria-label="价格显示单位">
                <button type="button" className={rangeUnit === 'price' ? 'active' : ''} onClick={() => setRangeUnit('price')}>价格</button>
                <button
                  type="button"
                  className={rangeUnit === 'market-cap' ? 'active' : ''}
                  disabled={supplyLoading || isEthLikeCurrency(quote.coin.address)}
                  title="按代币总供应量估算报价币 FDV；仅在点击时读取一次链上数据"
                  onClick={() => void enableMarketCap()}
                >{supplyLoading ? '读取中…' : '市值'}</button>
              </div>
            </div>

            <div className="dlmm-delta-chart" aria-label="价格档位分布预览">
              <div className="dlmm-chart-scale">
                <span>{plan ? formatPrice(plan.coinPriceLower) : '—'}</span>
                <strong>资金分布</strong>
                <span>{plan ? formatPrice(plan.coinPriceUpper) : '—'}</span>
              </div>
              <div className="dlmm-chart-bars">
                {sortedTranches.map((row) => {
                  const visualSide = row.coinPriceUpper <= quote.spot
                    ? 'bid'
                    : row.coinPriceLower >= quote.spot
                      ? 'ask'
                      : 'both'
                  return (
                    <span
                      key={`${row.tickLower}:${row.tickUpper}`}
                      className={`dlmm-chart-bar ${visualSide}`}
                      style={{ height: `${24 + (row.weightUnits / maxWeight) * 72}%` }}
                      title={`${formatPrice(row.coinPriceLower)} – ${formatPrice(row.coinPriceUpper)} · ${row.weightPct.toFixed(1)}%`}
                    />
                  )
                })}
                <i className="dlmm-chart-spot" style={{ left: `${spotPct}%` }}>
                  <b>现价</b>
                </i>
              </div>
              <div className="dlmm-chart-legend">
                <span><i className="bid" />Bid 买入档</span>
                <span><i className="both" />现价档</span>
                <span><i className="ask" />Ask 卖出档</span>
              </div>
            </div>

            <div className="dlmm-intent-summary dlmm-delta-summary">
              <div className={`dlmm-intent-icon ${inferredSide}`} aria-hidden>
                {inferredSide === 'bid' ? '↓' : inferredSide === 'ask' ? '↑' : '↔'}
              </div>
              <div>
                <span className="muted small">自动识别为</span>
                <strong>{actionTitle}</strong>
                <p>{actionDescription}</p>
              </div>
              <div className="dlmm-intent-count">
                <strong>{executionMode === 'multi' ? tranches.length : 1}</strong>
                <span>个链上仓位</span>
              </div>
            </div>

            <div className="dlmm-range-facts dlmm-delta-facts">
              <div>
                <span>价格下限</span>
                <strong className="mono">{plan ? formatPrice(plan.coinPriceLower) : '—'}</strong>
                <small>{plan ? pctFromSpot(plan.coinPriceLower, plan.coinSpot) : '—'}</small>
              </div>
              <div>
                <span>当前价格</span>
                <strong className="mono">{formatPrice(quote.spot)}</strong>
                <small>{inferredSide === 'both' ? '范围内' : '范围外等待成交'}</small>
              </div>
              <div>
                <span>价格上限</span>
                <strong className="mono">{plan ? formatPrice(plan.coinPriceUpper) : '—'}</strong>
                <small>{plan ? pctFromSpot(plan.coinPriceUpper, plan.coinSpot) : '—'}</small>
              </div>
            </div>

            {executionMode === 'multi' && tranches.length > 0 && (
              <details className="dlmm-band-details">
                <summary>查看 {tranches.length} 个链上档位与实际分配</summary>
                <div className="dlmm-tranche-table" aria-label="链上多档分配预览">
                  <div className="dlmm-tranche-head dlmm-tranche-head-dual">
                    <strong>档位</strong><span>价格</span><span>{displaySymbol(quote.coin)}</span><span>{displaySymbol(quote.quote)}</span>
                  </div>
                  {sortedTranches.map((row) => {
                    const originalIndex = tranches.indexOf(row)
                    const allocation = allocations[originalIndex] ?? { amount0: 0n, amount1: 0n }
                    const allocatedCoin = coinIndex === 0 ? allocation.amount0 : allocation.amount1
                    const allocatedQuote = quoteIndex === 0 ? allocation.amount0 : allocation.amount1
                    return (
                      <div className="dlmm-tranche-row dlmm-tranche-row-dual" key={`${row.tickLower}:${row.tickUpper}`}>
                        <strong>#{originalIndex + 1}{row.distanceFromSpot === 0 ? ' · 锚点' : ''}</strong>
                        <span className="mono">{formatPrice(row.coinPriceLower)} – {formatPrice(row.coinPriceUpper)}</span>
                        <span className="mono">{formatAmount(allocatedCoin, quote.coin.decimals, 6)}</span>
                        <span className="mono">{formatAmount(allocatedQuote, quote.quote.decimals, 6)}</span>
                      </div>
                    )
                  })}
                </div>
              </details>
            )}
          </div>

          <aside className="dlmm-order dlmm-delta-order">
            <div className="dlmm-order-summary dlmm-delta-order-head">
              <div><span>创建流动性</span><strong>{sideLabel(inferredSide)}</strong></div>
              <span className={`dlmm-intent-badge ${inferredSide}`}>自动</span>
            </div>

            <section className="dlmm-delta-section">
              <div className="dlmm-section-title">
                <span>投入金额</span>
                <InfoHint text={`只填 ${displaySymbol(quote.quote)} 自动变成 Bid；只填 ${displaySymbol(quote.coin)} 自动变成 Ask；两边都填自动变成双边做市。`} />
              </div>
              <div className="dlmm-dual-amounts">
                <div className={`dlmm-token-amount ${coinShort ? 'short' : ''}`}>
                  <div className="dlmm-token-amount-head">
                    <strong>{displaySymbol(quote.coin)}</strong>
                    <span>余额 {formatAmount(balanceFor(coinIndex, quote.coin), quote.coin.decimals, 6)}</span>
                  </div>
                  <input
                    value={amountCoin}
                    inputMode="decimal"
                    placeholder="0.00"
                    aria-label={`${displaySymbol(quote.coin)} 数量`}
                    onChange={(event) => { setAmountCoin(event.target.value); setFormError('') }}
                  />
                  <div className="dlmm-mini-pcts">
                    {[25, 50, 100].map((pct) => (
                      <button key={pct} type="button" disabled={!address || coinSpendable === 0n} onClick={() => fillAmount('coin', pct)}>{pct === 100 ? 'MAX' : `${pct}%`}</button>
                    ))}
                  </div>
                </div>
                <div className={`dlmm-token-amount ${quoteShort ? 'short' : ''}`}>
                  <div className="dlmm-token-amount-head">
                    <strong>{displaySymbol(quote.quote)}</strong>
                    <span>余额 {formatAmount(balanceFor(quoteIndex, quote.quote), quote.quote.decimals, 6)}</span>
                  </div>
                  <input
                    value={amountQuote}
                    inputMode="decimal"
                    placeholder="0.00"
                    aria-label={`${displaySymbol(quote.quote)} 数量`}
                    onChange={(event) => { setAmountQuote(event.target.value); setFormError('') }}
                  />
                  <div className="dlmm-mini-pcts">
                    {[25, 50, 100].map((pct) => (
                      <button key={pct} type="button" disabled={!address || quoteSpendable === 0n} onClick={() => fillAmount('quote', pct)}>{pct === 100 ? 'MAX' : `${pct}%`}</button>
                    ))}
                  </div>
                </div>
              </div>
              {(coinShort || quoteShort) && <p className="dlmm-error">输入数量超过可用余额</p>}
              <div className="dlmm-auto-rules">
                <button type="button" className={inferredSide === 'bid' ? 'active bid' : ''} onClick={() => pickIntent('bid')}><b>Bid</b><span>只填 {displaySymbol(quote.quote)}</span></button>
                <button type="button" className={inferredSide === 'both' ? 'active both' : ''} onClick={() => pickIntent('both')}><b>双边</b><span>两种都填</span></button>
                <button type="button" className={inferredSide === 'ask' ? 'active ask' : ''} onClick={() => pickIntent('ask')}><b>Ask</b><span>只填 {displaySymbol(quote.coin)}</span></button>
              </div>
            </section>

            <section className="dlmm-delta-section">
              <div className="dlmm-section-title"><span>资金分布</span><small>每个价格档的权重</small></div>
              <div className="dlmm-friendly-strategies dlmm-delta-strategies" role="group" aria-label="资金分配策略">
                {([
                  ['spot', 'Spot', '平均'],
                  ['curve', 'Curve', '近价多'],
                  ['bid-ask', 'Bid-Ask', '两端多'],
                ] as const).map(([value, label, note]) => (
                  <button
                    key={value}
                    type="button"
                    className={shape === value && executionMode === 'multi' ? 'active' : ''}
                    onClick={() => { setExecutionMode('multi'); setShape(value) }}
                  >
                    <span className={`dlmm-strategy-bars ${value}`} aria-hidden>{[0, 1, 2, 3, 4].map((bar) => <i key={bar} />)}</span>
                    <strong>{label}</strong><em>{note}</em>
                  </button>
                ))}
              </div>
            </section>

            <section className="dlmm-delta-section">
              <div className="dlmm-section-title">
                <span>价格范围</span>
                <small>{rangeUnitLabel}</small>
              </div>
              <div className="dlmm-friendly-presets dlmm-delta-presets" role="group" aria-label="价格范围预设">
                {RANGE_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    className={rangePreset === preset.key ? 'active' : ''}
                    onClick={() => applyPreset(inferredSide, preset.key)}
                  ><strong>{preset.label}</strong><span>{preset.note}</span></button>
                ))}
              </div>
              <div className="dlmm-range-inputs">
                <label>
                  <span>最低</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={inputNumber(rangeValue(quote.spot * (1 + lowerPct / 100)))}
                    onChange={(event) => setPriceBoundary('lower', event.target.value)}
                  />
                  <small>{lowerPct >= 0 ? '+' : ''}{lowerPct.toFixed(2)}%</small>
                </label>
                <i>—</i>
                <label>
                  <span>最高</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={inputNumber(rangeValue(quote.spot * (1 + upperPct / 100)))}
                    onChange={(event) => setPriceBoundary('upper', event.target.value)}
                  />
                  <small>{upperPct >= 0 ? '+' : ''}{upperPct.toFixed(2)}%</small>
                </label>
              </div>
              <div className="dlmm-range-sliders">
                <label>
                  <span>下限</span>
                  <input type="range" min={lowerSlider} max={lowerSliderMax} step={0.1} value={lowerPct} onChange={(event) => setPctBoundary('lower', Number(event.target.value))} />
                </label>
                <label>
                  <span>上限</span>
                  <input type="range" min={upperSliderMin} max={upperSliderMax} step={0.1} value={upperPct} onChange={(event) => setPctBoundary('upper', Number(event.target.value))} />
                </label>
              </div>
              {planState.error && <p className="dlmm-error">{planState.error}</p>}
            </section>

            <details className="dlmm-advanced dlmm-delta-advanced">
              <summary><span><strong>高级设置</strong><small>仓位数量、原生币与税币</small></span><b>展开</b></summary>
              <div className="dlmm-advanced-body">
                <div className="dlmm-mode-tabs" role="group" aria-label="链上仓位模式">
                  <button type="button" className={executionMode === 'multi' ? 'active' : ''} onClick={() => setExecutionMode('multi')}>
                    <strong>分档仓位</strong><span>一笔创建多个 NFT</span>
                  </button>
                  <button type="button" className={executionMode === 'single' ? 'active' : ''} onClick={() => setExecutionMode('single')}>
                    <strong>单一仓位</strong><span>一个连续区间</span>
                  </button>
                </div>
                {executionMode === 'multi' && (
                  <div className="dlmm-band-count">
                    <span>链上档位数</span>
                    <div className="dlmm-band-preset" role="group" aria-label="链上档位数">
                      {[4, 6, 8, 12].map((count) => (
                        <button type="button" key={count} className={trancheCount === count ? 'active' : ''} disabled={count > (plan?.binCount ?? 1)} onClick={() => setTrancheCount(count)}>{count}</button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="dlmm-technical-range">
                  <div><span>虚拟价格刻度</span><strong>{plan?.binCount ?? '—'}</strong></div>
                  <div><span>tick spacing</span><strong>{pool.tickSpacing}</strong></div>
                  <div><span>实际 ticks</span><strong>{plan ? `${plan.tickLower} – ${plan.tickUpper}` : '—'}</strong></div>
                </div>
                {pairUsesNative && (
                  <label className="dlmm-check">
                    <input type="checkbox" checked={useNativeEth} onChange={(event) => onUseNativeEth(event.target.checked)} />
                    直接使用 {getNativeSymbol()}（自动处理 Wrap）
                  </label>
                )}
                {pool.version === 'v4' && (
                  <label className="dlmm-tax">
                    <span>转账税 bps</span>
                    <input type="number" min={0} max={5_000} value={transferTaxBps} onChange={(event) => onTransferTaxBps(clampInt(Number(event.target.value), 0, 5_000, 0))} />
                    <small>{(transferTaxBps / 100).toFixed(2)}%</small>
                  </label>
                )}
                <div className="dlmm-compat-note">
                  <strong>EVM 实际执行方式</strong>
                  <span>每档是一个真实 Uniswap V3/V4 NFT；V4 使用一条 modifyLiquidities 动作序列，V3 使用 PositionManager multicall。最多 12 档是为了控制 gas，不伪装成 Solana 的独立 DLMM bin。</span>
                </div>
              </div>
            </details>

            <div className="dlmm-safety-summary dlmm-delta-safety">
              <span>✓ 只使用已填写币种</span><span>✓ 提交前刷新现价</span><span>✓ 任一档失败整笔回滚</span>
            </div>
            {formError && <p className="dlmm-error submit">{formError}</p>}
            <button className={`btn dlmm-submit ${inferredSide}`} type="button" disabled={!canExecute} onClick={submit}>
              {!address
                ? '先连接钱包'
                : !walletReady
                  ? '钱包未就绪'
                  : busy
                    ? '正在创建…'
                    : `创建 ${executionMode === 'multi' ? `${tranches.length} 档 ` : ''}${sideShort(inferredSide)} 仓位`}
            </button>
            <p className="dlmm-submit-note muted">钱包确认一笔创建交易；不会部署新币或转走范围外资产。</p>
          </aside>
        </div>
      )}
    </section>
  )
}
