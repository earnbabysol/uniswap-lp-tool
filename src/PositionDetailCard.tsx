import { useMemo, type ReactNode } from 'react'
import { formatAmount, getPositionCoinPrices, type PositionRow } from './lp'
import { formatPrice, formatUsd } from './math'

function formatPnlAmount(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) > 1e11) return '—'
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  const abs = Math.abs(n)
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatPnlPct(pnl: number, basis: number): string {
  if (!(basis > 0) || !Number.isFinite(pnl)) return ''
  const pct = (pnl / basis) * 100
  if (!Number.isFinite(pct) || Math.abs(pct) > 1e6) return ''
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : ''
  return `${sign}${Math.abs(pct).toFixed(2)}%`
}

const SEGMENTS = 28

export type PositionDetailCardProps = {
  position: PositionRow
  busy?: boolean
  children?: ReactNode
  onCollect: () => void
  onClose: () => void
  onRebalance: () => void
  onCopyId?: () => void
  poolHref?: string | null
}

export function PositionDetailCard({
  position: p,
  busy,
  children,
  onCollect,
  onClose,
  onRebalance,
  onCopyId,
  poolHref,
}: PositionDetailCardProps) {
  const cq = useMemo(() => getPositionCoinPrices(p), [p])
  const unclaimedUsd = p.fees0Usd + p.fees1Usd
  const principalUsd = p.amount0Usd + p.amount1Usd
  const deposited = p.costBasisUsd > 0 ? p.costBasisUsd : principalUsd > 0 ? principalUsd : 0
  const pnlBasis = Math.max(p.costBasisUsd, principalUsd, 1e-9)
  const pnlPct = formatPnlPct(p.pnlUsd, pnlBasis)
  const pnlUp = p.pnlUsd >= 0

  const lo = cq.coinPriceLower
  const hi = cq.coinPriceUpper
  const spot = cq.coinPrice
  const span = Math.max(hi - lo, 1e-18)
  const rawMarker = ((spot - lo) / span) * 100
  const markerPct = p.inRange
    ? Math.max(2, Math.min(98, rawMarker))
    : spot < lo
      ? -4
      : 104

  const toLowerPct = spot > 0 ? ((spot - lo) / spot) * 100 : 0
  const toUpperPct = spot > 0 ? ((hi - spot) / spot) * 100 : 0

  const rangeHint = p.inRange
    ? `in range · ${Math.max(0, toLowerPct).toFixed(1)}% to lower · ${Math.max(0, toUpperPct).toFixed(1)}% to upper`
    : spot < lo
      ? `out of range · 低于下限 ${formatPrice(lo)}`
      : `out of range · 高于上限 ${formatPrice(hi)}`

  // 现价左侧偏 quote（更像 token1/稳定币侧），右侧偏 coin——与列表 bar-a/b 一致用 token0/token1 色
  const splitAt = Math.max(0, Math.min(SEGMENTS, Math.round((markerPct / 100) * SEGMENTS)))

  return (
    <div className="pdc" id="position-detail-card">
      <div className="pdc-head">
        <div className="pdc-title-row">
          <h3 className="pdc-pair">
            {cq.coin.symbol} / {cq.quote.symbol}
          </h3>
          <span className={`pdc-pill ver`}>{p.version}</span>
          <span className="pdc-pill">{(p.fee / 10000).toFixed(2)}%</span>
          <span className="pdc-pill">#{p.tokenId.toString()}</span>
        </div>
        <div className="pdc-head-actions">
          {onCopyId && (
            <button type="button" className="btn ghost tight" onClick={onCopyId}>
              复制 ID
            </button>
          )}
          {poolHref && (
            <a className="btn ghost tight" href={poolHref} target="_blank" rel="noreferrer">
              池子 ↗
            </a>
          )}
        </div>
      </div>

      <div className="pdc-badges">
        <span className={`pdc-badge pnl ${pnlUp ? 'up' : 'down'}`}>
          {pnlUp ? '▲' : '▼'} {formatPnlAmount(p.pnlUsd)}
          {pnlPct ? ` (${pnlPct})` : ''}
        </span>
        <span className={`pdc-badge range ${p.inRange ? 'in' : 'out'}`}>
          <i className="pdc-dot" />
          {p.inRange ? 'in range' : 'out of range'}
        </span>
      </div>

      <div className={`pdc-range ${p.inRange ? 'in' : 'out'}`}>
        <div className="pdc-range-legend">
          <span>
            <i className="dot a" />
            {p.token0.symbol}
          </span>
          <span>
            <i className="dot b" />
            {p.token1.symbol}
          </span>
        </div>
        <div className="pdc-seg-wrap">
          <div
            className="pdc-spot-tag"
            style={{ left: `${Math.max(0, Math.min(100, markerPct))}%` }}
          >
            {formatPrice(spot)}
          </div>
          <div className="pdc-seg-bar" aria-hidden>
            {Array.from({ length: SEGMENTS }, (_, i) => (
              <span
                key={i}
                className={`pdc-seg ${i < splitAt ? 'a' : 'b'}`}
              />
            ))}
          </div>
          <div
            className="pdc-spot-line"
            style={{ left: `${Math.max(0, Math.min(100, markerPct))}%` }}
          />
        </div>
        <div className="pdc-range-ends">
          <span className="mono">{formatPrice(lo)}</span>
          <span className="pdc-unit">{cq.priceUnit}</span>
          <span className="mono right">{formatPrice(hi)}</span>
        </div>
        <p className="pdc-range-hint">{rangeHint}</p>
      </div>

      <div className="pdc-grid">
        <div className="pdc-cell">
          <span className="pdc-k">Value</span>
          <span className="pdc-v">{formatUsd(p.totalUsd)}</span>
        </div>
        <div className="pdc-cell">
          <span className="pdc-k">Unclaimed fees</span>
          <span className="pdc-v ok">{formatUsd(unclaimedUsd)}</span>
        </div>
        <div className="pdc-cell">
          <span className="pdc-k">PnL</span>
          <span className={`pdc-v ${pnlUp ? 'ok' : 'bad'}`}>{formatPnlAmount(p.pnlUsd)}{pnlPct ? ` (${pnlPct})` : ''}</span>
        </div>
        <div className="pdc-cell">
          <span className="pdc-k">Deposited</span>
          <span className="pdc-v">{deposited > 0 ? formatUsd(deposited) : '—'}</span>
        </div>
        <div className="pdc-cell">
          <span className="pdc-k">{p.token0.symbol}</span>
          <span className="pdc-v mono">{formatAmount(p.amount0, p.token0.decimals, 4)}</span>
        </div>
        <div className="pdc-cell">
          <span className="pdc-k">{p.token1.symbol}</span>
          <span className="pdc-v mono">{formatAmount(p.amount1, p.token1.decimals, 4)}</span>
        </div>
        <div className="pdc-cell">
          <span className="pdc-k">Min price ({cq.priceUnit})</span>
          <span className="pdc-v mono">{formatPrice(lo)}</span>
        </div>
        <div className="pdc-cell">
          <span className="pdc-k">Max price ({cq.priceUnit})</span>
          <span className="pdc-v mono">{formatPrice(hi)}</span>
        </div>
      </div>

      <div className="pdc-actions">
        <button type="button" className="btn primary pdc-rebal" disabled={busy} onClick={onRebalance}>
          Rebalance
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCollect}>
          Collect fees
        </button>
        <button type="button" className="btn danger-outline" disabled={busy} onClick={onClose}>
          Close
        </button>
      </div>

      {children && (
        <details className="pdc-more">
          <summary>加仓 / 部分撤出</summary>
          <div className="pdc-more-body">{children}</div>
        </details>
      )}
    </div>
  )
}

/** 估算 rebalanceV3 用的对称半宽 %（相对现价） */
export function estimateRebalanceHalfPercent(p: PositionRow): number {
  const cq = getPositionCoinPrices(p)
  const spot = cq.coinPrice
  if (!(spot > 0)) return 10
  const loPct = Math.abs((cq.coinPriceLower / spot - 1) * 100)
  const hiPct = Math.abs((cq.coinPriceUpper / spot - 1) * 100)
  const avg = (loPct + hiPct) / 2
  if (!Number.isFinite(avg) || avg < 0.5) return 10
  return Math.min(99.9, Math.max(0.5, avg))
}
