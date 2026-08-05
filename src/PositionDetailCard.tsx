import { useMemo, type ReactNode } from 'react'
import { getPositionCoinPrices, getPositionUsdRange, type PositionRow } from './lp'
import { formatAge, formatPrice, formatUsd } from './math'
import { PositionLegs } from './PositionLegs'

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
  onCompound: () => void
  onClose: () => void
  onRebalance: () => void
  onCopyId?: () => void
  /** V3 池合约地址或 V4 poolId，供展示与一键复制 */
  poolRef?: string | null
  onCopyPool?: () => void
  poolHref?: string | null
}

function shortPoolRef(ref: string): string {
  if (ref.length <= 18) return ref
  return `${ref.slice(0, 10)}…${ref.slice(-8)}`
}

export function PositionDetailCard({
  position: p,
  busy,
  children,
  onCollect,
  onCompound,
  onClose,
  onRebalance,
  onCopyId,
  poolRef,
  onCopyPool,
  poolHref,
}: PositionDetailCardProps) {
  const cq = useMemo(() => getPositionCoinPrices(p), [p])
  const usdRange = useMemo(() => getPositionUsdRange(p), [p])
  const unclaimedRaw = p.fees0 + p.fees1
  const hasUnclaimed = unclaimedRaw > 0n
  const unclaimedUsd = p.fees0Usd + p.fees1Usd
  const principalUsd = p.amount0Usd + p.amount1Usd
  // 已存入 = 锁定成本，勿回退到持仓市值（否则会随币价飘）
  const deposited = p.costBasisUsd > 0 ? p.costBasisUsd : 0
  const pnlBasis = Math.max(p.costBasisUsd, principalUsd, 1e-9)
  const pnlReady = Boolean(p.pnlReady) && (p.costBasisUsd > 0 || Math.abs(p.pnlUsd) > 1e-9)
  const pnlPct = pnlReady ? formatPnlPct(p.pnlUsd, pnlBasis) : ''
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
    ? `区间内 · 距下限 ${Math.max(0, toLowerPct).toFixed(1)}% · 距上限 ${Math.max(0, toUpperPct).toFixed(1)}%`
    : spot < lo
      ? `已出区间 · 低于下限 ${formatPrice(lo)}`
      : `已出区间 · 高于上限 ${formatPrice(hi)}`

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
              复制编号
            </button>
          )}
        </div>
      </div>

      {poolRef && (
        <div className="pdc-pool">
          <span className="pdc-pool-label">{p.version === 'v4' ? 'poolId' : '池地址'}</span>
          <code className="pdc-pool-ref mono" title={poolRef}>{shortPoolRef(poolRef)}</code>
          {onCopyPool && (
            <button type="button" className="btn ghost tight" onClick={onCopyPool}>
              复制
            </button>
          )}
          {poolHref && (
            <a className="btn ghost tight" href={poolHref} target="_blank" rel="noreferrer">
              浏览器 ↗
            </a>
          )}
        </div>
      )}

      <div className="pdc-badges">
        <span
          className={`pdc-badge pnl ${!pnlReady ? '' : pnlUp ? 'up' : 'down'}`}
          title={
            pnlReady
              ? `盈亏 = 现价本金 + 未领 + 已领 − 净存入。净存入约 $${deposited.toFixed(2)}（扫链锁定，山寨币池价失真时会偏）`
              : '补扫存取记录后显示盈亏'
          }
        >
          {pnlReady
            ? `${pnlUp ? '▲' : '▼'} ${formatPnlAmount(p.pnlUsd)}${pnlPct ? ` (${pnlPct})` : ''}`
            : '盈亏 —'}
        </span>
        <span className={`pdc-badge range ${p.inRange ? 'in' : 'out'}`}>
          <i className="pdc-dot" />
          {p.inRange ? '区间内' : '已出区间'}
        </span>
      </div>

      <div className={`pdc-range ${p.inRange ? 'in' : 'out'}`}>
        {/*
         * 这条是价格轴，不是配比条。分段只表示现价把区间切在哪儿（左＝已走过），
         * 曾经这里挂着 token0/token1 的图例 + 代币色，于是 152–181 里现价 178.9
         * 的仓位被画成「26/28 段是 token0」，而真实配比是 5/95 —— 正好反过来。
         * 配比是另一回事，放在下面 .pdc-mix 单独一行。
         */}
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
                className={`pdc-seg ${i < splitAt ? 'past' : 'ahead'}`}
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
        {usdRange && (
          <div className="pdc-range-ends pdc-range-usd" title="U 本位（$ / 币）">
            <span className="mono">${formatPrice(usdRange.usdLower)}</span>
            <span className="pdc-unit">$/{cq.coin.symbol}</span>
            <span className="mono right">${formatPrice(usdRange.usdUpper)}</span>
          </div>
        )}
        <p className="pdc-range-hint">{rangeHint}</p>
      </div>

      {/*
       * 这里原来是单独一行配比（条 + token0/token1 两个图例）。删了：条和图例都并进了
       * 下面的逐币明细，那张表每行本来就有色点、代币名、百分比 —— 留着就是同一组数字
       * 在一张卡上印两遍，而且顺序还不一样（这里按 pct0/pct1，明细按标题的 coin/quote）。
       */}
      {/*
       * 指标条：一排五格，不再是 2 列 × 4 行的格子墙。
       *
       * 原来八个格子铺在 1118px 宽的卡上，每格 528px 而里面的数只有 48~135px 宽 ——
       * 量出来每格空着 393~480px，「持仓价值」和它右边的「未领手续费」之间隔了小半个屏幕，
       * 竖着还占四行。八个数横过来一排，每格 210px 左右，正好装得下最长的 US$118.00。
       *
       * 同时删掉三个本来就在屏幕上的格子：
       *   - 下限价 / 上限价：上面价格轴的两端已经印了 0.0002941 和 0.000339，
       *     单位也标了（探针数出这两串各出现两次），隔 150px 再印一遍没有新信息。
       *   - 盈亏：卡头的徽章已经是「▲ +$4.02 (+3.41%)」，还带涨跌色，比灰底格子显眼。
       */}
      <div className="pdc-stats">
        <div className="pdc-stat">
          <span className="pdc-k">持仓价值</span>
          <span className="pdc-v">{formatUsd(p.totalUsd)}</span>
        </div>
        <div className="pdc-stat">
          <span className="pdc-k">未领手续费</span>
          <span className="pdc-v ok">{formatUsd(unclaimedUsd)}</span>
        </div>
        <div className="pdc-stat">
          <span className="pdc-k" title="按领取时价格锁定，不随市值重估；未领仍用现价">已领手续费</span>
          <span className="pdc-v ok">{formatUsd(p.claimedFeesUsd)}</span>
        </div>
        <div className="pdc-stat">
          <span className="pdc-k" title="未领(现价) + 已领(锁定)">累计手续费</span>
          <span className="pdc-v ok">{formatUsd(p.totalFeesUsd)}</span>
        </div>
        <div className="pdc-stat">
          <span className="pdc-k" title="净存入 = 链上存入−取出的代币，按记账时币价换成 USD 后锁定。盈亏用它做成本，不是钱包已实现盈亏。">已存入</span>
          <span className="pdc-v">{deposited > 0 ? formatUsd(deposited) : '—'}</span>
        </div>
        <div className="pdc-stat">
          <span className="pdc-k">手续费年化</span>
          <span className={`pdc-v ${p.feeAprPct != null ? 'ok' : ''}`}>
            {p.feeAprPct != null && Number.isFinite(p.feeAprPct)
              ? `${p.feeAprPct >= 100 ? Math.round(p.feeAprPct) : p.feeAprPct.toFixed(1)}%`
              : '—'}
          </span>
        </div>
        <div className="pdc-stat">
          <span className="pdc-k">持仓时长</span>
          <span className="pdc-v">{formatAge(p.ageDays)}</span>
        </div>
      </div>

      {/*
       * 逐币明细。原来这里是 pdc-grid 里两个孤立的格子（只有 token0 / token1 的数量，
       * 没有对应的美元值），而手续费只有一个合并的「未领手续费 US$xx」——
       * 领出来会拿到几个 NVDA、几个 USDG，卡上答不出来。
       * 拆成一张表：本金数量 / 本金价值 / 未领费数量 / 未领费价值，四列对齐。
       */}
      <PositionLegs position={p} variant="detail" />

      <div className="pdc-actions">
        <button type="button" className="btn pdc-rebal" disabled={busy} onClick={onRebalance}>
          重设区间
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !hasUnclaimed}
          onClick={onCollect}
          title={!hasUnclaimed ? '暂无未领手续费' : undefined}
        >
          领取手续费
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !hasUnclaimed}
          onClick={onCompound}
          title={
            !hasUnclaimed
              ? '暂无未领手续费'
              : '仅用未领手续费加回本仓；配不平的一边留在钱包；复投失败时手续费仍在钱包'
          }
        >
          领取并复投
        </button>
        <button type="button" className="btn danger-outline" disabled={busy} onClick={onClose}>
          关闭仓位
        </button>
      </div>

      {children && (
        <div className="pdc-manage">
          {children}
        </div>
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
