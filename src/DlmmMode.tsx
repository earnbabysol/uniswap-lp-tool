import { useEffect, useMemo, useState } from 'react'
import type { Address } from 'viem'
import { getNativeSymbol } from './chain'
import {
  formatAmount,
  getCoinQuote,
  isEthLikeCurrency,
  pairHasWeth,
  type DiscoveredPool,
  type PoolInfo,
} from './lp'
import { formatAmountExact, formatPrice, formatUsd, parseAmount } from './math'
import { shortAddr } from './wallet'
import {
  allocateDlmmAmount,
  buildEvmDlmmPlan,
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

const RANGE_PRESETS: Array<{
  key: Exclude<FriendlyRangePreset, 'custom'>
  label: string
  note: string
  nearPct: number
  bidFarPct: number
  askFarPct: number
}> = [
  { key: 'near', label: '贴近现价', note: '更快开始成交', nearPct: 0, bidFarPct: 10, askFarPct: 10 },
  { key: 'balanced', label: '均衡区间', note: '新手推荐', nearPct: 1, bidFarPct: 30, askFarPct: 30 },
  { key: 'deep', label: '等待波动', note: '更远价格成交', nearPct: 3, bidFarPct: 60, askFarPct: 60 },
  { key: 'wide', label: '极宽覆盖', note: '覆盖极端行情', nearPct: 10, bidFarPct: 80, askFarPct: 120 },
]

function clampInt(raw: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.floor(raw)))
}

function pctFromSpot(price: number, spot: number): string {
  if (!(price > 0) || !(spot > 0)) return '—'
  const pct = ((price / spot) - 1) * 100
  return (pct >= 0 ? '+' : '') + pct.toFixed(Math.abs(pct) >= 100 ? 0 : 2) + '%'
}

function binsForPercent(side: DlmmSide, tickSpacing: number, percent: number): number {
  if (!(percent > 0)) return 0
  const stepLog = Math.max(1, tickSpacing) * Math.log(1.0001)
  const ratioLog = side === 'bid'
    ? -Math.log(Math.max(0.000001, 1 - Math.min(99.9999, percent) / 100))
    : Math.log(1 + percent / 100)
  return Math.max(0, Math.ceil(ratioLog / stepLog))
}

function rangeBinsForPreset(
  side: DlmmSide,
  tickSpacing: number,
  preset: Exclude<FriendlyRangePreset, 'custom'>,
): { gapBins: number; binCount: number } {
  const config = RANGE_PRESETS.find((row) => row.key === preset) ?? RANGE_PRESETS[1]!
  const gapBins = Math.min(1_399, binsForPercent(side, tickSpacing, config.nearPct))
  const farPct = side === 'bid' ? config.bidFarPct : config.askFarPct
  const farBins = Math.min(1_400, Math.max(gapBins + 1, binsForPercent(side, tickSpacing, farPct)))
  return { gapBins, binCount: Math.max(1, farBins - gapBins) }
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
  const [binCount, setBinCount] = usePersistentState('dlmmBinCount', 69)
  const [gapBins, setGapBins] = usePersistentState('dlmmGapBins', 0)
  const [rangePreset, setRangePreset] = usePersistentState<FriendlyRangePreset>('dlmmRangePreset', 'balanced')
  const [amount, setAmount] = useState('')
  const [showPoolPicker, setShowPoolPicker] = useState(!pool)
  const [formError, setFormError] = useState('')

  const poolKey = pool
    ? pool.version + ':' + (pool.poolAddress ?? pool.poolId ?? '') + ':' + pool.fee + ':' + pool.tickSpacing
    : ''

  useEffect(() => {
    setShowPoolPicker(!poolKey)
    setAmount('')
    setFormError('')
  }, [poolKey])

  useEffect(() => {
    if (!pool || rangePreset === 'custom') return
    const next = rangeBinsForPreset(side, pool.tickSpacing, rangePreset)
    setGapBins(next.gapBins)
    setBinCount(next.binCount)
  }, [poolKey, pool, rangePreset, setBinCount, setGapBins, side])

  useEffect(() => {
    setAmount('')
    setFormError('')
  }, [side])

  const planState = useMemo(() => {
    if (!pool) return { plan: null, error: '' }
    try {
      return { plan: buildEvmDlmmPlan(pool, side, binCount, gapBins), error: '' }
    } catch (error) {
      return { plan: null, error: error instanceof Error ? error.message : String(error) }
    }
  }, [pool, side, binCount, gapBins])
  const plan = planState.plan
  const tranches = useMemo(() => {
    if (!pool || !plan) return []
    return buildEvmDlmmTranches(pool, plan, shape, trancheCount)
  }, [pool, plan, shape, trancheCount])

  const quote = pool ? getCoinQuote(pool) : null
  const pairUsesNative = pool ? pairHasWeth(pool.token0.address, pool.token1.address) : false
  const depositIndex = plan?.depositTokenIndex ?? 0
  const depositMeta = plan?.depositToken ?? pool?.token0 ?? null
  const nativeDeposit = Boolean(
    pool && depositMeta && useNativeEth && pairUsesNative && isEthLikeCurrency(depositMeta.address),
  )
  const tokenBalance = depositIndex === 0 ? balance0 : balance1
  const displayBalance = nativeDeposit ? nativeBalance : tokenBalance
  const gasReserve = 10n ** 15n
  const spendableBalance = nativeDeposit
    ? (nativeBalance > gasReserve ? nativeBalance - gasReserve : 0n)
    : tokenBalance
  const depositLabel = depositMeta ? (nativeDeposit ? getNativeSymbol() : depositMeta.symbol) : ''
  const amountRaw = depositMeta ? parseAmount(amount || '0', depositMeta.decimals) : 0n
  const trancheAmounts = useMemo(
    () => allocateDlmmAmount(amountRaw, tranches),
    [amountRaw, tranches],
  )
  const amountShort = amountRaw > spendableBalance
  const multiAmountsReady = executionMode === 'single'
    || (tranches.length >= 2 && trancheAmounts.every((value) => value > 0n))
  const canExecute = Boolean(
    pool && plan && address && walletReady && !busy && amountRaw > 0n && !amountShort && multiAmountsReady,
  )

  const previewCount = Math.min(36, Math.max(1, plan?.binCount ?? binCount))
  const hiddenBins = Math.max(0, (plan?.binCount ?? binCount) - previewCount)
  const maxTrancheWeight = Math.max(1, ...tranches.map((row) => row.weightUnits))
  const visualBars = Array.from({ length: previewCount }, (_, index) => {
    const totalBins = plan?.binCount ?? binCount
    const virtualBin = Math.floor((index * totalBins) / previewCount) + 1
    const tranche = tranches.find(
      (row) => virtualBin >= row.virtualBinStart && virtualBin <= row.virtualBinEnd,
    )
    return {
      virtualBin,
      tranche,
      heightPct: executionMode === 'single' || !tranche
        ? 68
        : 25 + (tranche.weightUnits / maxTrancheWeight) * 68,
    }
  })

  const addressForPool = pool?.poolAddress ?? pool?.poolId
  const nearPrice = plan ? (side === 'bid' ? plan.coinPriceUpper : plan.coinPriceLower) : 0
  const farPrice = plan ? (side === 'bid' ? plan.coinPriceLower : plan.coinPriceUpper) : 0
  const actionTitle = side === 'bid'
    ? '用 ' + (plan?.quote.symbol ?? quote?.quote.symbol ?? '') + ' 分批买入 ' + (plan?.coin.symbol ?? quote?.coin.symbol ?? '')
    : '分批卖出 ' + (plan?.coin.symbol ?? quote?.coin.symbol ?? '')
  const actionDescription = side === 'bid'
    ? '只投入 ' + (depositLabel || plan?.quote.symbol || '') + '；价格下跌进入区间后逐步换成 ' + (plan?.coin.symbol ?? '')
    : '只投入 ' + (depositLabel || plan?.coin.symbol || '') + '；价格上涨进入区间后逐步换成 ' + (plan?.quote.symbol ?? '')

  const fillAmount = (pct: number) => {
    if (!depositMeta) return
    const raw = (spendableBalance * BigInt(pct)) / 100n
    setAmount(formatAmountExact(raw, depositMeta.decimals))
    setFormError('')
  }

  const setCustomGap = (value: number) => {
    setRangePreset('custom')
    setGapBins(clampInt(value, 0, 1_400, 0))
  }

  const setCustomWidth = (value: number) => {
    setRangePreset('custom')
    setBinCount(clampInt(value, 1, 1_400, 69))
  }

  const submit = () => {
    if (!pool || !plan || !depositMeta) return
    if (!address) return setFormError('请先连接钱包')
    if (!walletReady) return setFormError('签名钱包未就绪，请重新连接或解锁本地私钥')
    if (amountRaw <= 0n) return setFormError('请输入 ' + depositLabel + ' 数量')
    if (amountShort) return setFormError(depositLabel + ' 余额不足')
    if (!multiAmountsReady) return setFormError('数量太小，无法分配到每个链上档位；请减少档位或增加数量')
    setFormError('')
    onExecute({
      side,
      executionMode,
      shape,
      trancheCount: tranches.length,
      plan,
      amount0: plan.depositTokenIndex === 0 ? amount : '0',
      amount1: plan.depositTokenIndex === 1 ? amount : '0',
    })
  }

  return (
    <section className="page-dlmm dlmm-easy-page">
      <div className="dlmm-page-head dlmm-easy-head">
        <div>
          <div className="dlmm-kicker"><span>EVM DLMM</span> 单边分批成交</div>
          <h2>像挂限价单一样做 LP</h2>
          <p className="muted">选低价买入或分批卖出，再确定金额和价格范围；不懂 tick 和 NFT 也能完成。</p>
        </div>
        <button className="btn" type="button" onClick={onOpenClassic}>切到经典建仓</button>
      </div>

      <div className="dlmm-pool-card dlmm-easy-pool">
        <div className="dlmm-pool-main">
          {pool && quote ? (
            <>
              <span className={'tag ' + pool.version}>{pool.version.toUpperCase()}</span>
              <strong>{quote.coin.symbol} / {quote.quote.symbol}</strong>
              <span className="dlmm-pool-price">{formatPrice(quote.spot)} {quote.quote.symbol}</span>
              <span className="muted">手续费 {(pool.fee / 10_000).toFixed(2)}%</span>
              {addressForPool && <span className="mono muted">{shortAddr(addressForPool as Address)}</span>}
            </>
          ) : (
            <strong>第一步：选择一个 V3 / V4 池</strong>
          )}
        </div>
        <div className="dlmm-pool-actions">
          {pool && (
            <button className="btn" type="button" disabled={busy} onClick={onRefreshPool}>刷新现价</button>
          )}
          <button
            className={'btn ' + (showPoolPicker ? 'active' : '')}
            type="button"
            aria-expanded={showPoolPicker}
            onClick={() => setShowPoolPicker((value) => !value)}
          >
            {pool ? '选择其他池' : '选择池'}
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
              <button className="btn" type="button" onClick={onOpenClassic}>打开完整选池器</button>
            </div>
            <p className="muted small">池地址会直接加载；代币合约会同时扫描可用的 V3 与 V4 池。</p>

            {discovered && discovered.length > 0 && (
              <div className="dlmm-discovered">
                {discovered.slice(0, 8).map((row) => {
                  const rowQuote = getCoinQuote(row.pool)
                  const key = row.pool.version + ':' + (row.pool.poolAddress ?? row.pool.poolId) + ':' + row.pool.fee + ':' + row.pool.tickSpacing
                  return (
                    <button key={key} className="dlmm-pool-option" type="button" onClick={() => onPickPool(row.pool)}>
                      <span className={'tag ' + row.pool.version}>{row.pool.version.toUpperCase()}</span>
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
          <h3>先选择你要交易的池</h3>
          <p className="muted">选好后，页面会自动判断应该投入哪一种币，并用真实价格展示成交范围。</p>
          <button className="btn primary" type="button" onClick={() => setShowPoolPicker(true)}>选择池</button>
        </div>
      ) : (
        <div className="dlmm-terminal dlmm-easy-terminal">
          <div className="dlmm-market dlmm-easy-market">
            <div className="dlmm-market-head">
              <div>
                <span className="muted small">当前池价格</span>
                <strong className="dlmm-spot">{formatPrice(plan?.coinSpot ?? quote.spot)}</strong>
                <span className="muted"> {quote.quote.symbol}/{quote.coin.symbol}</span>
              </div>
              <span className={'dlmm-intent-badge ' + side}>
                {side === 'bid' ? '低价买入' : '分批卖出'}
              </span>
            </div>

            <div className="dlmm-intent-summary">
              <div className={'dlmm-intent-icon ' + side} aria-hidden>{side === 'bid' ? '↓' : '↑'}</div>
              <div>
                <span className="muted small">你的计划</span>
                <strong>{actionTitle}</strong>
                <p>{actionDescription}</p>
              </div>
              <div className="dlmm-intent-count">
                <strong>{executionMode === 'multi' ? tranches.length : 1}</strong>
                <span>个链上仓位</span>
              </div>
            </div>

            <div className={'dlmm-ladder ' + side}>
              <div className="dlmm-ladder-axis">
                {side === 'bid' ? (
                  <>
                    <span>最远 {plan ? formatPrice(farPrice) : '—'}</span>
                    <span>最近 {plan ? formatPrice(nearPrice) : '—'}</span>
                    <span className="current">现价 {plan ? formatPrice(plan.coinSpot) : '—'}</span>
                  </>
                ) : (
                  <>
                    <span className="current">现价 {plan ? formatPrice(plan.coinSpot) : '—'}</span>
                    <span>最近 {plan ? formatPrice(nearPrice) : '—'}</span>
                    <span>最远 {plan ? formatPrice(farPrice) : '—'}</span>
                  </>
                )}
              </div>
              <div className="dlmm-bars" aria-label={(side === 'bid' ? '买入' : '卖出') + '价格分布预览'}>
                {side === 'ask' && <i className="dlmm-current-line" title="当前价" />}
                {visualBars.map((bar, index) => (
                  <span
                    key={index}
                    className="dlmm-bar"
                    style={{ height: bar.heightPct + '%' }}
                    title={bar.tranche
                      ? '链上档位 ' + (bar.tranche.index + 1) + ' · 分配 ' + bar.tranche.weightPct.toFixed(1) + '%'
                      : '价格刻度 ' + bar.virtualBin}
                  />
                ))}
                {side === 'bid' && <i className="dlmm-current-line" title="当前价" />}
              </div>
              <div className="dlmm-ladder-note">
                <span>{side === 'bid' ? plan?.quote.symbol + ' 买入区间' : plan?.coin.symbol + ' 卖出区间'}</span>
                <span>
                  {executionMode === 'multi' ? tranches.length + ' 档分批成交' : '单一连续区间'}
                  {hiddenBins > 0 ? ' · 图表已压缩显示' : ''}
                </span>
              </div>
            </div>

            <div className="dlmm-range-facts dlmm-friendly-facts">
              <div>
                <span>{side === 'bid' ? '最低买入价' : '开始卖出价'}</span>
                <strong className="mono">{plan ? formatPrice(plan.coinPriceLower) : '—'}</strong>
                <small>{plan ? pctFromSpot(plan.coinPriceLower, plan.coinSpot) : '—'}</small>
              </div>
              <div>
                <span>{side === 'bid' ? '开始买入价' : '最高卖出价'}</span>
                <strong className="mono">{plan ? formatPrice(plan.coinPriceUpper) : '—'}</strong>
                <small>{plan ? pctFromSpot(plan.coinPriceUpper, plan.coinSpot) : '—'}</small>
              </div>
              <div>
                <span>只需投入</span>
                <strong>{depositLabel}</strong>
                <small>无需准备两种币</small>
              </div>
            </div>

            <div className="dlmm-outcome-row">
              <div><i>1</i><span><strong>价格未进入</strong>资金保持为 {depositLabel}</span></div>
              <div><i>2</i><span><strong>价格穿过区间</strong>逐档换成另一种币</span></div>
              <div><i>3</i><span><strong>随时退出</strong>取回本金与已赚手续费</span></div>
            </div>

            {executionMode === 'multi' && tranches.length > 0 && (
              <details className="dlmm-band-details">
                <summary>查看 {tranches.length} 档具体价格与资金分配</summary>
                <div className="dlmm-tranche-table" aria-label="链上多档分配预览">
                  <div className="dlmm-tranche-head">
                    <strong>档位</strong>
                    <span>成交价格</span>
                    <span>比例</span>
                    <span>预计投入</span>
                  </div>
                  {tranches.map((row, index) => (
                    <div className="dlmm-tranche-row" key={row.tickLower + ':' + row.tickUpper}>
                      <strong>#{index + 1}{row.distanceFromSpot === 0 ? ' · 最近' : ''}</strong>
                      <span className="mono">
                        {formatPrice(row.coinPriceLower)} – {formatPrice(row.coinPriceUpper)}
                      </span>
                      <span>{row.weightPct.toFixed(1)}%</span>
                      <span className="mono">
                        {depositMeta ? formatAmount(trancheAmounts[index] ?? 0n, depositMeta.decimals, 6) : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>

          <aside className="dlmm-order dlmm-easy-order">
            <div className="dlmm-order-summary">
              <span>创建计划</span>
              <strong>{actionTitle}</strong>
              <small>完成下面 4 步即可提交</small>
            </div>

            <section className="dlmm-easy-step">
              <div className="dlmm-easy-step-head">
                <i className="dlmm-step-number">1</i>
                <div><strong>你想做什么？</strong><span>先选交易方向</span></div>
              </div>
              <div className="dlmm-side-tabs dlmm-friendly-side" role="tablist" aria-label="交易方向">
                <button
                  type="button"
                  role="tab"
                  aria-selected={side === 'bid'}
                  className={side === 'bid' ? 'active bid' : ''}
                  onClick={() => setSide('bid')}
                >
                  <strong>低价买入 <b>Bid</b></strong>
                  <span>只投入 {quote.quote.symbol}</span>
                  <em>币价下跌时分批买 {quote.coin.symbol}</em>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={side === 'ask'}
                  className={side === 'ask' ? 'active ask' : ''}
                  onClick={() => setSide('ask')}
                >
                  <strong>分批卖出 <b>Ask</b></strong>
                  <span>只投入 {quote.coin.symbol}</span>
                  <em>币价上涨时分批换成 {quote.quote.symbol}</em>
                </button>
              </div>
            </section>

            <section className="dlmm-easy-step">
              <div className="dlmm-easy-step-head">
                <i className="dlmm-step-number">2</i>
                <div><strong>投入多少？</strong><span>本次只需要一种币</span></div>
                <span className="dlmm-step-balance">
                  余额 {depositMeta ? formatAmount(displayBalance, depositMeta.decimals, 6) : '—'} {depositLabel}
                </span>
              </div>
              <label className={'dlmm-amount ' + (amountShort ? 'short' : '')}>
                <input
                  value={amount}
                  inputMode="decimal"
                  placeholder="0.00"
                  onChange={(event) => {
                    setAmount(event.target.value)
                    setFormError('')
                  }}
                />
                <strong>{depositLabel}</strong>
              </label>
              {amountShort && <p className="dlmm-error">余额不足</p>}
              <div className="dlmm-pct-row" role="group" aria-label="按余额填入">
                {[25, 50, 75, 100].map((pct) => (
                  <button key={pct} type="button" disabled={!address || spendableBalance === 0n} onClick={() => fillAmount(pct)}>
                    {pct === 100 ? '全部' : pct + '%'}
                  </button>
                ))}
              </div>
            </section>

            <section className="dlmm-easy-step">
              <div className="dlmm-easy-step-head">
                <i className="dlmm-step-number">3</i>
                <div><strong>资金怎么分？</strong><span>选择各价格档的资金比例</span></div>
              </div>
              <div className="dlmm-friendly-strategies" role="group" aria-label="资金分配策略">
                {([
                  ['spot', '平均分配', '每档金额相同'],
                  ['curve', '近价更多', '优先在现价附近成交'],
                  ['bid-ask', '远价更多', '大波动时投入更多'],
                ] as const).map(([value, label, note]) => (
                  <button
                    key={value}
                    type="button"
                    className={shape === value && executionMode === 'multi' ? 'active' : ''}
                    onClick={() => {
                      setExecutionMode('multi')
                      setShape(value)
                    }}
                  >
                    <span className={'dlmm-strategy-bars ' + value} aria-hidden>
                      {[0, 1, 2, 3, 4].map((bar) => <i key={bar} />)}
                    </span>
                    <strong>{label}</strong>
                    <em>{note}</em>
                  </button>
                ))}
              </div>
            </section>

            <section className="dlmm-easy-step">
              <div className="dlmm-easy-step-head">
                <i className="dlmm-step-number">4</i>
                <div><strong>希望在哪些价格成交？</strong><span>先选预设，也可以拖动微调</span></div>
              </div>
              <div className="dlmm-friendly-presets" role="group" aria-label="价格范围预设">
                {RANGE_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    className={rangePreset === preset.key ? 'active' : ''}
                    onClick={() => setRangePreset(preset.key)}
                  >
                    <strong>{preset.label}</strong>
                    <span>{preset.note}</span>
                  </button>
                ))}
              </div>

              <div className="dlmm-friendly-range">
                <label>
                  <span><strong>从哪里开始成交</strong><b>{plan ? pctFromSpot(nearPrice, plan.coinSpot) : '—'}</b></span>
                  <input
                    type="range"
                    min={0}
                    max={1_399}
                    value={gapBins}
                    onChange={(event) => setCustomGap(Number(event.target.value))}
                  />
                  <small>靠左更接近现价，靠右需要更大波动</small>
                </label>
                <label>
                  <span><strong>成交到多远</strong><b>{plan ? pctFromSpot(farPrice, plan.coinSpot) : '—'}</b></span>
                  <input
                    type="range"
                    min={1}
                    max={1_400}
                    value={binCount}
                    onChange={(event) => setCustomWidth(Number(event.target.value))}
                  />
                  <small>靠右覆盖更远价格，但资金会更分散</small>
                </label>
              </div>

              <div className="dlmm-friendly-endpoints">
                <div>
                  <span>{side === 'bid' ? '最先买入' : '最先卖出'}</span>
                  <strong>{plan ? formatPrice(nearPrice) : '—'}</strong>
                  <small>{quote.quote.symbol}/{quote.coin.symbol}</small>
                </div>
                <i>→</i>
                <div>
                  <span>{side === 'bid' ? '最深买入' : '最高卖出'}</span>
                  <strong>{plan ? formatPrice(farPrice) : '—'}</strong>
                  <small>{quote.quote.symbol}/{quote.coin.symbol}</small>
                </div>
              </div>
              {planState.error && <p className="dlmm-error">{planState.error}</p>}
            </section>

            <div className="dlmm-safety-summary">
              <span>✓ 只投入 {depositLabel}</span>
              <span>✓ 提交前刷新现价</span>
              <span>✓ 任一档失败整笔回滚</span>
            </div>

            <details className="dlmm-advanced">
              <summary>
                <span><strong>高级设置</strong><small>链上仓位数量、精确刻度、代币兼容</small></span>
                <b>展开</b>
              </summary>
              <div className="dlmm-advanced-body">
                <div className="dlmm-section-title">
                  <span>链上仓位模式</span>
                  <InfoHint text="多档模式会在一笔交易里创建多个独立 NFT，便于分档领取与退出；单仓模式只创建一个覆盖完整区间的 NFT。" />
                </div>
                <div className="dlmm-mode-tabs" role="group" aria-label="链上仓位模式">
                  <button
                    type="button"
                    className={executionMode === 'multi' ? 'active' : ''}
                    onClick={() => setExecutionMode('multi')}
                  >
                    <strong>分档仓位</strong>
                    <span>{tranches.length || Math.min(trancheCount, binCount)} 个独立 NFT</span>
                  </button>
                  <button
                    type="button"
                    className={executionMode === 'single' ? 'active' : ''}
                    onClick={() => setExecutionMode('single')}
                  >
                    <strong>单一仓位</strong>
                    <span>1 个连续区间 NFT</span>
                  </button>
                </div>

                {executionMode === 'multi' && (
                  <div className="dlmm-band-count">
                    <span>链上分成几档</span>
                    <div className="dlmm-band-preset" role="group" aria-label="链上档位数">
                      {[3, 5, 8, 12].map((count) => (
                        <button
                          type="button"
                          key={count}
                          className={trancheCount === count ? 'active' : ''}
                          disabled={count > binCount}
                          onClick={() => setTrancheCount(count)}
                        >
                          {count}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="dlmm-technical-range">
                  <label>
                    <span>起点刻度</span>
                    <input
                      type="number"
                      min={0}
                      max={1_400}
                      value={gapBins}
                      onChange={(event) => setCustomGap(Number(event.target.value))}
                    />
                  </label>
                  <label>
                    <span>覆盖刻度</span>
                    <input
                      type="number"
                      min={1}
                      max={1_400}
                      value={binCount}
                      onChange={(event) => setCustomWidth(Number(event.target.value))}
                    />
                  </label>
                  <div>
                    <span>池 tick spacing</span>
                    <strong>{pool.tickSpacing}</strong>
                  </div>
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
                    <input
                      type="number"
                      min={0}
                      max={5_000}
                      value={transferTaxBps}
                      onChange={(event) => onTransferTaxBps(clampInt(Number(event.target.value), 0, 5_000, 0))}
                    />
                    <small>{(transferTaxBps / 100).toFixed(2)}%</small>
                  </label>
                )}

                <div className="dlmm-compat-note">
                  <strong>与 Meteora 的真实差异</strong>
                  <span>
                    这里把体验映射到 Uniswap V3/V4 集中流动性。每档实际是一个可用 tick 区间，
                    成交曲线、手续费和滑点仍由原池决定，不冒充 Solana DLMM 的独立 bin、常数和曲线或动态费率。
                  </span>
                </div>
              </div>
            </details>

            {formError && <p className="dlmm-error submit">{formError}</p>}
            <button className={'btn dlmm-submit ' + side} type="button" disabled={!canExecute} onClick={submit}>
              {!address
                ? '先连接钱包'
                : !walletReady
                  ? '钱包未就绪'
                  : busy
                    ? '正在创建…'
                    : executionMode === 'multi'
                      ? '创建 ' + tranches.length + ' 档' + (side === 'bid' ? '买入' : '卖出') + '仓位'
                      : '创建' + (side === 'bid' ? '买入' : '卖出') + '仓位'}
            </button>
            <p className="dlmm-submit-note muted">
              钱包只需确认一笔创建交易；提交前会刷新价格并再次校验单边方向。
            </p>
          </aside>
        </div>
      )}
    </section>
  )
}
