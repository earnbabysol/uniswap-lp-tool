import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { getCoinQuote, ticksFromCoinPrices, type PoolDepth, type PoolInfo } from './lp'
import { formatPrice } from './math'

export type RangeDepthChartProps = {
  pool: PoolInfo
  depth: PoolDepth | null
  loading?: boolean
  error?: string | null
  /** 当前选中的币价区间（与开仓 UI 一致） */
  coinLower: number | null
  coinUpper: number | null
  /** 全区间时隐藏拖拽手柄 */
  fullRange?: boolean
  /** 拖拽或点击改区间时回调（已 snap） */
  onRangeChange: (range: { coinLower: number; coinUpper: number }) => void
}

type DragSide = 'lo' | 'hi'

const MIN_SPAN_MULT = 0.15
const MAX_SPAN_MULT = 12

function clamp(n: number, a: number, b: number) {
  return Math.min(b, Math.max(a, n))
}

function getCoinSpot(pool: PoolInfo): number {
  const s = getCoinQuote(pool).spot
  return s > 0 ? s : 1
}

export function RangeDepthChart({
  pool,
  depth,
  loading,
  error,
  coinLower,
  coinUpper,
  fullRange,
  onRangeChange,
}: RangeDepthChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const chartRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<DragSide | null>(null)
  const dragRef = useRef<DragSide | null>(null)
  const liveLo = useRef(coinLower)
  const liveHi = useRef(coinUpper)
  /** 横轴可视跨度倍率：>1 放宽（看更远），<1 收窄（看更细） */
  const [viewSpanMult, setViewSpanMult] = useState(1)

  const poolKey = pool.poolAddress ?? pool.poolId ?? `${pool.token0.address}-${pool.token1.address}-${pool.fee}`

  useEffect(() => {
    liveLo.current = coinLower
    liveHi.current = coinUpper
  }, [coinLower, coinUpper])

  useEffect(() => {
    setViewSpanMult(1)
  }, [poolKey])

  const W = 640
  const H = 168
  const padL = 8
  const padR = 8
  const padT = 10
  const padB = 28
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  const baseXDomain = useMemo(() => {
    const spot = depth?.currentCoinPrice ?? getCoinQuote(pool).spot ?? 1
    const candidates = [spot]
    if (coinLower != null && coinLower > 0) candidates.push(coinLower)
    if (coinUpper != null && coinUpper > 0) candidates.push(coinUpper)
    if (depth?.bars.length) {
      for (const b of depth.bars) {
        if (b.coinPrice > 0) candidates.push(b.coinPrice)
      }
    }
    let min = Math.min(...candidates)
    let max = Math.max(...candidates)
    if (!(max > min)) {
      min = spot * 0.9
      max = spot * 1.1
    }
    const span = Math.max(max - min, max * 0.02, 1e-18)
    const pad = span * 0.12
    return {
      min: Math.max(1e-18, min - pad),
      max: max + pad,
      center: spot,
    }
  }, [depth, pool, coinLower, coinUpper])

  const xDomain = useMemo(() => {
    const baseSpan = Math.max(baseXDomain.max - baseXDomain.min, 1e-18)
    const span = baseSpan * clamp(viewSpanMult, MIN_SPAN_MULT, MAX_SPAN_MULT)
    const center = baseXDomain.center
    return {
      min: Math.max(1e-18, center - span / 2),
      max: center + span / 2,
    }
  }, [baseXDomain, viewSpanMult])

  const maxLiq = useMemo(() => {
    if (!depth?.bars.length) return 1
    return Math.max(1, ...depth.bars.map((b) => b.liquidity))
  }, [depth])

  const xOf = useCallback(
    (coin: number) => {
      const t = (coin - xDomain.min) / (xDomain.max - xDomain.min || 1)
      return padL + clamp(t, 0, 1) * plotW
    },
    [xDomain, plotW],
  )

  const coinOf = useCallback(
    (x: number) => {
      const t = clamp((x - padL) / plotW, 0, 1)
      return xDomain.min + t * (xDomain.max - xDomain.min)
    },
    [xDomain, plotW],
  )

  const pointerToCoin = useCallback(
    (clientX: number) => {
      const svg = svgRef.current
      if (!svg) return null
      const rect = svg.getBoundingClientRect()
      const x = ((clientX - rect.left) / rect.width) * W
      return coinOf(x)
    },
    [coinOf],
  )

  const applyDrag = useCallback(
    (side: DragSide, clientX: number) => {
      if (fullRange) return
      const raw = pointerToCoin(clientX)
      if (raw == null || !(raw > 0)) return
      const spot = depth?.currentCoinPrice ?? getCoinSpot(pool)
      let lo = liveLo.current ?? spot * 0.95
      let hi = liveHi.current ?? spot * 1.05
      if (side === 'lo') {
        lo = Math.min(raw, hi * 0.999999)
      } else {
        hi = Math.max(raw, lo * 1.000001)
      }
      try {
        const t = ticksFromCoinPrices(pool, lo, hi)
        liveLo.current = t.coinPriceLower
        liveHi.current = t.coinPriceUpper
        onRangeChange({ coinLower: t.coinPriceLower, coinUpper: t.coinPriceUpper })
      } catch {
        // 拖拽中间态区间无效时忽略
      }
    },
    [depth, fullRange, onRangeChange, pointerToCoin, pool],
  )

  useEffect(() => {
    if (!drag) return
    const onMove = (e: PointerEvent) => {
      if (dragRef.current) applyDrag(dragRef.current, e.clientX)
    }
    const onUp = () => {
      dragRef.current = null
      setDrag(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [drag, applyDrag])

  const startDrag = (side: DragSide, e: ReactPointerEvent) => {
    if (fullRange) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = side
    setDrag(side)
    applyDrag(side, e.clientX)
  }

  const adjustViewZoom = useCallback((factor: number) => {
    setViewSpanMult((m) => clamp(m * factor, MIN_SPAN_MULT, MAX_SPAN_MULT))
  }, [])

  // React onWheel 默认 passive，preventDefault 无效；需非 passive 监听才能拦住页面滚动
  useEffect(() => {
    const el = chartRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const step = Math.exp(e.deltaY * 0.001)
      adjustViewZoom(clamp(step, 0.88, 1.14))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [adjustViewZoom])

  const status = loading
    ? '深度加载中…'
    : error
      ? error
      : !depth
        ? '暂无深度'
        : !depth.hasLiquidityProfile
          ? '暂无流动性剖面（仍可拖拽区间）'
          : null

  const lo = coinLower
  const hi = coinUpper
  const showRange = lo != null && hi != null && lo > 0 && hi > lo && !fullRange

  const zoomLabel = useMemo(() => {
    if (Math.abs(viewSpanMult - 1) < 0.05) return '100%'
    return viewSpanMult > 1
      ? `${Math.round(viewSpanMult * 100)}% 宽`
      : `${Math.round(100 / viewSpanMult)}% 细`
  }, [viewSpanMult])

  const spotX = depth ? xOf(depth.currentCoinPrice) : padL + plotW / 2
  const loX = showRange ? xOf(lo!) : 0
  const hiX = showRange ? xOf(hi!) : 0

  const visibleBars = depth?.bars.filter(
    (b) => b.coinPrice >= xDomain.min * 0.999 && b.coinPrice <= xDomain.max * 1.001,
  ) ?? []
  const barW = visibleBars.length
    ? Math.max(1.5, Math.min(18, (plotW / visibleBars.length) * 0.82))
    : 2

  return (
    <div className="depth-chart" ref={chartRef}>
      <div className="depth-chart-meta">
        <span>流动性深度</span>
        {depth && (
          <span className="muted">
            {depth.quoteSymbol} / {depth.coinSymbol}
            {depth.hasLiquidityProfile ? '' : ' · 占位轴'}
          </span>
        )}
        <div className="depth-width-controls">
          <span className="depth-width-label">视图</span>
          <button
            type="button"
            className="depth-width-btn"
            aria-label="放宽视野"
            title="放宽视野（看更远）"
            onClick={() => adjustViewZoom(1.2)}
          >
            −
          </button>
          <span className="depth-width-val" title="横轴缩放">
            {zoomLabel}
          </span>
          <button
            type="button"
            className="depth-width-btn"
            aria-label="收窄视野"
            title="收窄视野（柱子更粗）"
            onClick={() => adjustViewZoom(1 / 1.2)}
          >
            +
          </button>
          {Math.abs(viewSpanMult - 1) > 0.05 && (
            <button
              type="button"
              className="depth-zoom-reset"
              onClick={() => setViewSpanMult(1)}
            >
              重置
            </button>
          )}
        </div>
      </div>
      {status && <p className="depth-chart-status muted">{status}</p>}
      <svg
        ref={svgRef}
        className="depth-chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="流动性深度与价格区间"
      >
        <rect x={0} y={0} width={W} height={H} className="depth-chart-bg" rx={8} />

        {visibleBars.map((b) => {
          const x = xOf(b.coinPrice) - barW / 2
          const h = depth!.hasLiquidityProfile
            ? (b.liquidity / maxLiq) * plotH
            : plotH * 0.12
          const y = padT + plotH - h
          return (
            <rect
              key={b.tick}
              x={x}
              y={y}
              width={barW}
              height={Math.max(0.5, h)}
              className="depth-bar"
              opacity={depth!.hasLiquidityProfile ? 0.85 : 0.25}
            />
          )
        })}

        {showRange && (
          <rect
            x={loX}
            y={padT}
            width={Math.max(0, hiX - loX)}
            height={plotH}
            className="depth-range-fill"
          />
        )}

        <line x1={spotX} y1={padT} x2={spotX} y2={padT + plotH} className="depth-spot-line" />
        <text x={spotX + 4} y={padT + 12} className="depth-spot-label">
          现价 {formatPrice(depth?.currentCoinPrice ?? 0)}
        </text>

        {showRange && (
          <>
            <line x1={loX} y1={padT} x2={loX} y2={padT + plotH} className="depth-handle-line" />
            <line x1={hiX} y1={padT} x2={hiX} y2={padT + plotH} className="depth-handle-line" />
            <g
              className={`depth-handle ${drag === 'lo' ? 'active' : ''}`}
              onPointerDown={(e) => startDrag('lo', e)}
              style={{ cursor: 'ew-resize' }}
            >
              <rect x={loX - 6} y={padT + plotH / 2 - 16} width={12} height={32} rx={3} />
              <text x={loX} y={H - 8} textAnchor="middle" className="depth-handle-caption">
                下限
              </text>
            </g>
            <g
              className={`depth-handle ${drag === 'hi' ? 'active' : ''}`}
              onPointerDown={(e) => startDrag('hi', e)}
              style={{ cursor: 'ew-resize' }}
            >
              <rect x={hiX - 6} y={padT + plotH / 2 - 16} width={12} height={32} rx={3} />
              <text x={hiX} y={H - 8} textAnchor="middle" className="depth-handle-caption">
                上限
              </text>
            </g>
          </>
        )}

        {fullRange && (
          <text x={W / 2} y={padT + plotH / 2} textAnchor="middle" className="depth-full-hint">
            全区间 · 不显示拖拽手柄
          </text>
        )}
      </svg>
      <p className="depth-chart-hint muted">
        滚轮或 ± 调节深度图视野（不影响 LP 区间）；拖动手柄调上下限。
      </p>
    </div>
  )
}
