import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { getActiveChainId } from './chain'
import type { DlmmSide, EvmDlmmPlan, EvmDlmmTranche } from './dlmm'
import type { PoolInfo } from './lp'
import { formatPrice, formatUsd } from './math'
import { fetchPoolCandles, type MarketCandle } from './marketIndexer'

type DragSide = 'lower' | 'upper'

export type DlmmRangeChartProps = {
  pool: PoolInfo
  plan: EvmDlmmPlan
  visualTranches: readonly EvmDlmmTranche[]
  side: DlmmSide
  rangeUnit: 'price' | 'market-cap'
  coinSupply: number | null
  onBoundaryPct: (which: DragSide, pct: number) => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function formatAxis(value: number, marketCap: boolean): string {
  return marketCap ? formatUsd(value) : formatPrice(value)
}

function edgeLabel(side: DlmmSide, which: DragSide): string {
  if (side === 'bid') return which === 'lower' ? '最低买价' : '最高买价'
  if (side === 'ask') return which === 'lower' ? '最低卖价' : '最高卖价'
  return which === 'lower' ? '范围下限' : '范围上限'
}

function signedPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(Math.abs(value) >= 100 ? 0 : 1)}%`
}

export function DlmmRangeChart({
  pool,
  plan,
  visualTranches,
  side,
  rangeUnit,
  coinSupply,
  onBoundaryPct,
}: DlmmRangeChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<DragSide | null>(null)
  const [drag, setDrag] = useState<DragSide | null>(null)
  const [dragDomain, setDragDomain] = useState<{ min: number; max: number } | null>(null)
  const [candles, setCandles] = useState<MarketCandle[]>([])
  const [candleState, setCandleState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')

  const poolRef = pool.poolAddress ?? pool.poolId ?? ''
  useEffect(() => {
    let alive = true
    if (!poolRef) {
      setCandles([])
      setCandleState('empty')
      return () => { alive = false }
    }
    setCandleState('loading')
    void fetchPoolCandles({
      chainId: getActiveChainId(),
      poolRef,
      coinAddress: plan.coin.address,
      limit: 120,
    }).then((rows) => {
      if (!alive) return
      setCandles(rows)
      setCandleState(rows.length > 0 ? 'ready' : 'empty')
    }).catch(() => {
      if (!alive) return
      setCandles([])
      setCandleState('error')
    })
    return () => { alive = false }
  }, [plan.coin.address, poolRef])

  const W = 760
  const H = 310
  const padL = 14
  const padR = 128
  const padT = 24
  const plotBottom = 264
  const plotW = W - padL - padR
  const plotH = plotBottom - padT
  const marketCap = rangeUnit === 'market-cap' && Boolean(coinSupply)
  const shown = (price: number) => marketCap ? price * (coinSupply ?? 1) : price
  const visibleCandles = candles.slice(-96)

  const computedDomain = useMemo(() => {
    const prices = [plan.coinSpot, plan.coinPriceLower, plan.coinPriceUpper]
    for (const candle of visibleCandles) prices.push(candle.low, candle.high)
    const safe = prices.filter((value) => value > 0 && Number.isFinite(value))
    let min = Math.min(...safe)
    let max = Math.max(...safe)
    if (!(max > min)) {
      min = plan.coinSpot * 0.8
      max = plan.coinSpot * 1.2
    }
    const logMin = Math.log(Math.max(min, 1e-30))
    const logMax = Math.log(Math.max(max, min * 1.000001))
    const pad = Math.max((logMax - logMin) * 0.08, 0.02)
    return { min: Math.exp(logMin - pad), max: Math.exp(logMax + pad) }
  }, [plan.coinPriceLower, plan.coinPriceUpper, plan.coinSpot, visibleCandles])
  const domain = dragDomain ?? computedDomain

  const yOf = useCallback((price: number) => {
    const min = Math.log(Math.max(domain.min, 1e-30))
    const max = Math.log(Math.max(domain.max, domain.min * 1.000001))
    const value = Math.log(Math.max(price, 1e-30))
    return padT + (1 - clamp((value - min) / (max - min), 0, 1)) * plotH
  }, [domain, plotH])

  const priceOf = useCallback((y: number) => {
    const t = 1 - clamp((y - padT) / plotH, 0, 1)
    const min = Math.log(Math.max(domain.min, 1e-30))
    const max = Math.log(Math.max(domain.max, domain.min * 1.000001))
    return Math.exp(min + t * (max - min))
  }, [domain, plotH])

  const clampBoundaryPct = useCallback((which: DragSide, rawPct: number) => {
    if (which === 'lower') {
      const floor = side === 'ask' ? 0.05 : -99.5
      const sideCeiling = side === 'ask' ? 1_000_000 : -0.05
      return clamp(rawPct, floor, Math.min(sideCeiling, plan.rangeUpperPct - 0.05))
    }
    const sideFloor = side === 'bid' ? -99.5 : 0.05
    const ceiling = side === 'bid' ? -0.05 : 1_000_000
    return clamp(rawPct, Math.max(sideFloor, plan.rangeLowerPct + 0.05), ceiling)
  }, [plan.rangeLowerPct, plan.rangeUpperPct, side])

  const pointerToPrice = useCallback((clientY: number) => {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    if (!(rect.height > 0)) return null
    return priceOf(((clientY - rect.top) / rect.height) * H)
  }, [priceOf])

  const applyDrag = useCallback((which: DragSide, clientY: number) => {
    const price = pointerToPrice(clientY)
    if (price == null || !(price > 0) || !(plan.coinSpot > 0)) return
    const pct = ((price / plan.coinSpot) - 1) * 100
    onBoundaryPct(which, clampBoundaryPct(which, pct))
  }, [clampBoundaryPct, onBoundaryPct, plan.coinSpot, pointerToPrice])

  useEffect(() => {
    if (!drag) return
    const onMove = (event: PointerEvent) => {
      if (dragRef.current) applyDrag(dragRef.current, event.clientY)
    }
    const onUp = () => {
      dragRef.current = null
      setDrag(null)
      setDragDomain(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [applyDrag, drag])

  const startDrag = (which: DragSide, event: ReactPointerEvent<SVGGElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setDragDomain(computedDomain)
    dragRef.current = which
    setDrag(which)
  }

  const nudgeBoundary = (which: DragSide, event: ReactKeyboardEvent<SVGGElement>) => {
    const direction = event.key === 'ArrowUp' || event.key === 'PageUp'
      ? 1
      : event.key === 'ArrowDown' || event.key === 'PageDown'
        ? -1
        : 0
    if (direction === 0) return
    event.preventDefault()
    const step = event.shiftKey || event.key.startsWith('Page') ? 5 : 0.5
    const current = which === 'lower' ? plan.rangeLowerPct : plan.rangeUpperPct
    onBoundaryPct(which, clampBoundaryPct(which, current + direction * step))
  }

  const candleW = Math.max(2, Math.min(7, plotW / Math.max(1, visibleCandles.length) * 0.64))
  const xForCandle = (index: number) => (
    padL + (visibleCandles.length <= 1 ? 0.5 : index / (visibleCandles.length - 1)) * plotW
  )
  const maxWeight = Math.max(1, ...visualTranches.map((row) => row.weightUnits))
  const lowerY = yOf(plan.coinPriceLower)
  const upperY = yOf(plan.coinPriceUpper)
  const spotY = yOf(plan.coinSpot)
  const gridPrices = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const min = Math.log(Math.max(domain.min, 1e-30))
    const max = Math.log(Math.max(domain.max, domain.min * 1.000001))
    return Math.exp(max - ratio * (max - min))
  })

  const status = candleState === 'loading'
    ? 'K 线载入中…'
    : candleState === 'error'
      ? 'K 线暂不可用，范围设置仍可使用'
      : candleState === 'empty'
        ? '该池暂无 K 线，范围设置仍可使用'
        : `${visibleCandles.length} 根 1h K 线`

  return (
    <div className={`dlmm-range-chart ${drag ? 'is-dragging' : ''}`}>
      <div className="dlmm-range-chart-meta">
        <div>
          <strong>价格走势与建仓范围</strong>
          <small>彩色区域就是资金会工作的价格区间</small>
        </div>
        <span>{status}</span>
      </div>
      <div className="dlmm-range-chart-tip">
        <b>不用拖也能设置：</b>
        <span>直接选“近价 / 均衡 / 深度”，或在价格框里输入；拖横线只用于微调。</span>
      </div>
      <svg
        ref={svgRef}
        className="dlmm-range-chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="时间价格 K 线、视觉 Bin 和可上下拖动的建仓范围"
      >
        <rect className="dlmm-range-chart-bg" x="0" y="0" width={W} height={H} rx="12" />

        {gridPrices.map((price) => {
          const y = yOf(price)
          return (
            <g className="dlmm-chart-grid" key={price}>
              <line x1={padL} x2={W - padL} y1={y} y2={y} />
              <text x={padL + 5} y={clamp(y - 4, 11, H - 7)}>{formatAxis(shown(price), marketCap)}</text>
            </g>
          )
        })}

        <rect
          className={`dlmm-range-selected ${side}`}
          x={padL}
          y={upperY}
          width={W - padL * 2}
          height={Math.max(1, lowerY - upperY)}
        />

        {visibleCandles.map((candle, index) => {
          const x = xForCandle(index)
          const up = candle.close >= candle.open
          const top = yOf(Math.max(candle.open, candle.close))
          const bottom = yOf(Math.min(candle.open, candle.close))
          return (
            <g key={candle.timestamp} className={`dlmm-candle ${up ? 'up' : 'down'}`}>
              <line x1={x} x2={x} y1={yOf(candle.high)} y2={yOf(candle.low)} />
              <rect x={x - candleW / 2} y={top} width={candleW} height={Math.max(1.2, bottom - top)} rx="0.8" />
            </g>
          )
        })}

        <g className="dlmm-bin-profile" aria-label={`${visualTranches.length} 个视觉 Bin`}>
          <text x={W - 16} y={15} textAnchor="end">资金权重</text>
          {visualTranches.map((row) => {
            const y0 = yOf(row.coinPriceUpper)
            const y1 = yOf(row.coinPriceLower)
            const width = 12 + (row.weightUnits / maxWeight) * 82
            const visualSide = row.coinPriceUpper <= plan.coinSpot
              ? 'bid'
              : row.coinPriceLower >= plan.coinSpot
                ? 'ask'
                : 'both'
            return (
              <rect
                key={`${row.tickLower}:${row.tickUpper}`}
                className={`dlmm-visual-bin ${visualSide}`}
                x={W - 16 - width}
                y={y0 + 0.45}
                width={width}
                height={Math.max(1.2, y1 - y0 - 0.9)}
                rx="1.5"
              >
                <title>{formatAxis(shown(row.coinPriceLower), marketCap)} – {formatAxis(shown(row.coinPriceUpper), marketCap)} · {row.weightPct.toFixed(1)}%</title>
              </rect>
            )
          })}
        </g>

        <line className="dlmm-chart-spot-line" x1={padL} x2={W - padL} y1={spotY} y2={spotY} />
        <g className="dlmm-chart-spot-pill" transform={`translate(${padL + 5} ${clamp(spotY - 18, 3, H - 26)})`}>
          <rect width="88" height="23" rx="8" />
          <text x="8" y="15">现价 {formatAxis(shown(plan.coinSpot), marketCap)}</text>
        </g>

        {(['lower', 'upper'] as const).map((which) => {
          const y = which === 'lower' ? lowerY : upperY
          const price = which === 'lower' ? plan.coinPriceLower : plan.coinPriceUpper
          const pct = which === 'lower' ? plan.rangeLowerPct : plan.rangeUpperPct
          const label = edgeLabel(side, which)
          const pillY = clamp(y - 17, 2, H - 36)
          return (
            <g
              key={which}
              className={`dlmm-drag-handle ${which} ${drag === which ? 'active' : ''}`}
              onPointerDown={(event) => startDrag(which, event)}
              onKeyDown={(event) => nudgeBoundary(which, event)}
              role="slider"
              tabIndex={0}
              aria-label={label}
              aria-valuenow={price}
              aria-valuetext={`${label} ${formatAxis(shown(price), marketCap)}，距离现价 ${signedPct(pct)}`}
            >
              <line className="dlmm-drag-hit" x1={padL} x2={W - padL} y1={y} y2={y} />
              <line x1={padL} x2={W - padL} y1={y} y2={y} />
              <g className="dlmm-drag-pill" transform={`translate(${W - 124} ${pillY})`}>
                <rect width="110" height="34" rx="10" />
                <text className="label" x="9" y="14">↕ {label}</text>
                <text className="value" x="9" y="27">{formatAxis(shown(price), marketCap)} · {signedPct(pct)}</text>
              </g>
              <title>{label}：上下拖动，或聚焦后按 ↑ / ↓ 调整</title>
            </g>
          )
        })}

        <text className="dlmm-chart-time-label" x={padL} y={H - 10}>较早</text>
        <text className="dlmm-chart-time-label" x={padL + plotW} y={H - 10} textAnchor="end">现在</text>
      </svg>
      <div className="dlmm-range-chart-legend" aria-label="图表图例">
        <span><i className="candles" />K 线</span>
        <span><i className={`range ${side}`} />建仓区间</span>
        <span><i className="bins" />{visualTranches.length} 个价格档</span>
      </div>
      <p className="muted dlmm-range-chart-hint">精调：抓住右侧大标签上下拖动；键盘 ↑/↓ 调 0.5%，Shift + ↑/↓ 调 5%。提交前仍会读取链上现价复检。</p>
    </div>
  )
}
