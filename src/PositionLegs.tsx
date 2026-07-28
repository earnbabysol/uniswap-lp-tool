import { getPositionLegs, type PositionRow } from './lp'
import { formatAmount, formatAmountCompact, formatAmountExact, formatUsd } from './math'

function amountText(raw: bigint, decimals: number, digits: number, compact: boolean): string {
  if (raw === 0n) return '0'
  if (compact) return formatAmountCompact(raw, decimals)
  const shown = formatAmount(raw, decimals, digits)
  const zero = /^0(\.0*)?$/.test(shown)
  return zero ? `<0.${'0'.repeat(Math.max(0, digits - 1))}1` : shown
}

export function PositionLegs({
  position: p,
  variant = 'card',
}: {
  position: PositionRow
  variant?: 'card' | 'detail'
}) {
  const legs = getPositionLegs(p)
  const digits = variant === 'detail' ? 6 : 4
  const anyFees = legs.some((l) => l.fees > 0n)

  if (variant === 'card') {
    return (
      <div className="legs card">
        <div className="legs-bar" aria-hidden>
          {legs.map((l) => (
            <i
              key={l.token.address + String(l.slot)}
              className={l.slot === 0 ? 'a' : 'b'}
              style={{ width: `${Math.max(0, Math.min(100, l.pct))}%` }}
            />
          ))}
        </div>
        <div className="legs-legend">
          {legs.map((l) => (
            <span key={l.token.address + String(l.slot)} className="legs-legend-item">
              <i className={`legs-dot ${l.slot === 0 ? 'a' : 'b'}`} />
              {l.token.symbol} {l.pct.toFixed(2)}%
            </span>
          ))}
        </div>
        <div className="legs-alps">
          {legs.map((l) => (
            <div className="legs-alps-row" key={l.token.address + String(l.slot)}>
              <span className="legs-alps-usd">
                <i className={`legs-dot ${l.slot === 0 ? 'a' : 'b'}`} />
                {formatUsd(l.amountUsd)}
              </span>
              <span
                className="legs-alps-amt mono"
                title={`${formatAmountExact(l.amount, l.token.decimals)} ${l.token.symbol}`}
              >
                {amountText(l.amount, l.token.decimals, digits, true)} {l.token.symbol}
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={`legs ${variant}`}>
      <div className="legs-bar" aria-hidden>
        {legs.map((l) => (
          <i
            key={l.token.address + String(l.slot)}
            className={l.slot === 0 ? 'a' : 'b'}
            style={{ width: `${Math.max(0, Math.min(100, l.pct))}%` }}
          />
        ))}
      </div>
      <div className="legs-head" aria-hidden>
        <span>代币</span>
        <span className="num">持有数量</span>
        <span className="num">价值</span>
        <span className="num">未领手续费</span>
        <span className="num">费价值</span>
      </div>
      {legs.map((l) => (
        <div className="legs-row" key={l.token.address + String(l.slot)}>
          <span className="legs-tk">
            <i className={`legs-dot ${l.slot === 0 ? 'a' : 'b'}`} />
            <span className="legs-sym">{l.token.symbol}</span>
            <span className="legs-pct">{Math.round(l.pct)}%</span>
          </span>
          <span
            className="num mono legs-amt"
            data-k="持有数量"
            title={`${formatAmountExact(l.amount, l.token.decimals)} ${l.token.symbol}`}
          >
            {amountText(l.amount, l.token.decimals, digits, false)}
          </span>
          <span className="num mono legs-usd" data-k="价值">{formatUsd(l.amountUsd)}</span>
          <span
            className={`num mono legs-fee ${l.fees > 0n ? 'on' : ''}`}
            data-k="未领手续费"
            title={`${formatAmountExact(l.fees, l.token.decimals)} ${l.token.symbol}`}
          >
            {amountText(l.fees, l.token.decimals, digits, false)}
          </span>
          <span className={`num mono legs-fee-usd ${l.fees > 0n ? 'on' : ''}`} data-k="费价值">
            {formatUsd(l.feesUsd)}
          </span>
        </div>
      ))}
      {!anyFees && <p className="legs-note">这个仓位当前没有未领手续费。</p>}
    </div>
  )
}
