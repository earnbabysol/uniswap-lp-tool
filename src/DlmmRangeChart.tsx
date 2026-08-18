import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  const H = 250
  const padL = 12
  const padR = 12
  const padT = 20
  const candleBottom = 164
  const binBottom = 226
  const plotW = W - padL - padR
  const marketCap = rangeUnit === 'market-cap' && Boolean(coinSupply)
  const shown = (price: number) => marketCap ? price * (coinSupply ?? 1) : price

  const computedDomain = useMemo(() => {
    const prices = [plan.coinSpot, plan.coinPriceLower, plan.coinPriceUpper]
    for (const candle of candles.slice(-96)) prices.push(candle.low, candle.high)
    const safe = prices.filter((value) => value > 0 && Number.isFinite(value))
    let min = Math.min(...safe)
    let max = Math.max(...safe)
    if (!(max > min)) {
      min = plan.coinSpot * 0.8
      max = plan.coinSpot * 1.2
    }
    const logMin = Math.log(Math.max(min, 1e-30))
    const logMax = Math.log(Math.max(max, min * 1.000001))
    const pad = Math.max((logMax - logMin) * 0.09, 0.025)
    return { min: Math.exp(logMin - pad), max: Math.exp(logMax + pad) }
  }, [candles, plan.coinPriceLower, plan.coinPriceUpper, plan.coinSpot])
  const domain = dragDomain ?? computedDomain

  const xOf = useCallback((price: number) => {
    const min = Math.log(Math.max(domain.min, 1e-30))
    const max = Math.log(Math.max(domain.max, domain.min * 1.000001))
    const value = Math.log(Math.max(price, 1e-30))
    return padL + clamp((value - min) / (max - min), 0, 1) * plotW
  }, [domain, plotW])

  const priceOf = useCallback((x: number) => {
    const t = clamp((x - padL) / plotW, 0, 1)
    const min = Math.log(Math.max(domain.min, 1e-30))
    const max = Math.log(Math.max(domain.max, domain.min * 1.000001))
    return Math.exp(min + t * (max - min))
  }, [domain, plotW])

  const pointerToPrice = useCallback((clientX: number) => {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    if (!(rect.width > 0)) return null
    return priceOf(((clientX - rect.left) / rect.width) * W)
  }, [priceOf])

  const applyDrag = useCallback((which: DragSide, clientX: number) => {
    const price = pointerToPrice(clientX)
    if (price == null || !(price > 0) || !(plan.coinSpot > 0)) return
    let pct = ((price / plan.coinSpot) - 1) * 100
    if (which === 'lower') {
      const ceiling = side === 'both' ? -0.05 : side === 'bid' ? plan.rangeUpperPct - 0.05 : plan.rangeUpperPct - 0.05
      const floor = side === 'ask' ? 0.05 : -99.5
      pct = clamp(pct, floor, ceiling)
    } else {
      const floor = side === 'both' ? 0.05 : side === 'ask' ? plan.rangeLowerPct + 0.05 : plan.rangeLowerPct + 0.05
      const ceiling = side === 'bid' ? -0.05 : 1_000_000
      pct = clamp(pct, floor, ceiling)
    }
    onBoundaryPct(which, pct)
  }, [onBoundaryPct, plan.coinSpot, plan.rangeLowerPct, plan.rangeUpperPct, pointerToPrice, side])

  useEffect(() => {
    if (!drag) return
    const onMove = (event: PointerEvent) => {
      if (dragRef.current) applyDrag(dragRef.current, event.clientX)
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

  const startDrag = (which: DragSide, event: ReactPointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setDragDomain(computedDomain)
    dragRef.current = which
    setDrag(which)
  }

  const candleDomain = useMemo(() => {
    const visible = candles.filter((row) => row.high >= domain.min && row.low <= domain.max)
    if (visible.length === 0) return { min: plan.coinSpot * 0.98, max: plan.coinSpot * 1.02 }
    let min = Math.min(...visible.map((row) => row.low))
    let max = Math.max(...visible.map((row) => row.high))
    if (!(max > min)) {
      min *= 0.99
      max *= 1.01
    }
    const pad = (max - min) * 0.08
    return { min: Math.max(1e-30, min - pad), max: max + pad }
  }, [candles, domain, plan.coinSpot])
  const yOf = (price: number) => (
    padT + (1 - clamp(
      (price - candleDomain.min) / (candleDomain.max - candleDomain.min || 1),
      0,
      1,
    )) * (candleBottom - padT)
  )

  const visibleCandles = candles.filter((row) => row.high >= domain.min && row.low <= domain.max).slice(-96)
  const candleW = Math.max(2, Math.min(8, plotW / Math.max(1, visibleCandles.length) * 0.62))
  const maxWeight = Math.max(1, ...visualTranches.map((row) => row.weightUnits))
  const lowerX = xOf(plan.coinPriceLower)
  const upperX = xOf(plan.coinPriceUpper)
  const spotX = xOf(plan.coinSpot)

  const status = candleState === 'loading'
    ? 'K 线载入中…'
    : candleState === 'error'
      ? 'K 线暂不可用，Bin 与拖拽仍可使用'
      : candleState === 'empty'
        ? '该池暂无 K 线，Bin 与拖拽仍可使用'
        : `${visibleCandles.length} 根 1h K 线`

  return (
    <div className="dlmm-range-chart">
      <div className="dlmm-range-chart-meta">
        <strong>价格 / 市值与资金分布</strong>
        <span>{status}</span>
      </div>
      <svg
        ref={svgRef}
        className="dlmm-range-chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="价格 K 线、视觉 Bin 和可拖动建仓范围"
      >
        <rect className="dlmm-range-chart-bg" x="0" y="0" width={W} height={H} rx="12" />
        <rect
          className="dlmm-range-selected"
          x={lowerX}
          y={padT}
          width={Math.max(1, upperX - lowerX)}
          height={binBottom - padT}
        />

        {visibleCandles.map((candle) => {
          const x = xOf(candle.close)
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

        <line className="dlmm-chart-spot-line" x1={spotX} x2={spotX} y1={padT} y2={binBottom} />
        <text className="dlmm-chart-spot-text" x={clamp(spotX + 5, 8, W - 78)} y={padT + 12}>现价</text>

        {visualTranches.map((row) => {
          const x0 = xOf(row.coinPriceLower)
          const x1 = xOf(row.coinPriceUpper)
          const height = 12 + (row.weightUnits / maxWeight) * 48
          const visualSide = row.coinPriceUpper <= plan.coinSpot
            ? 'bid'
            : row.coinPriceLower >= plan.coinSpot
              ? 'ask'
              : 'both'
          return (
            <rect
              key={`${row.tickLower}:${row.tickUpper}`}
              className={`dlmm-visual-bin ${visualSide}`}
              x={x0 + 0.6}
              y={binBottom - height}
              width={Math.max(1.2, x1 - x0 - 1.2)}
              height={height}
              rx="1.5"
            >
              <title>{formatAxis(shown(row.coinPriceLower), marketCap)} – {formatAxis(shown(row.coinPriceUpper), marketCap)} · {row.weightPct.toFixed(1)}%</title>
            </rect>
          )
        })}

        {(['lower', 'upper'] as const).map((which) => {
          const x = which === 'lower' ? lowerX : upperX
          const label = which === 'lower' ? '下限' : '上限'
          const value = shown(which === 'lower' ? plan.coinPriceLower : plan.coinPriceUpper)
          return (
            <g
              key={which}
              className={`dlmm-drag-handle ${drag === which ? 'active' : ''}`}
              onPointerDown={(event) => startDrag(which, event)}
              style={{ cursor: 'ew-resize' }}
            >
              <line className="dlmm-drag-hit" x1={x} x2={x} y1={padT} y2={binBottom + 3} />
              <line x1={x} x2={x} y1={padT} y2={binBottom + 3} />
              <rect x={x - 20} y={2} width={40} height={18} rx={8} />
              <text x={x} y={15} textAnchor="middle">{label}</text>
              <title>{label} {formatAxis(value, marketCap)}，左右拖动调整</title>
            </g>
          )
        })}

        <text className="dlmm-chart-axis-label" x={padL} y={H - 8}>
          {formatAxis(shown(domain.min), marketCap)}
        </text>
        <text className="dlmm-chart-axis-label" x={W - padR} y={H - 8} textAnchor="end">
          {formatAxis(shown(domain.max), marketCap)}
        </text>
      </svg>
      <p className="muted dlmm-range-chart-hint">拖动“下限 / 上限”直接改范围；K 线来自共享市场索引，彩色柱是 {visualTranches.length} 个视觉 Bin。</p>
    </div>
  )
}
