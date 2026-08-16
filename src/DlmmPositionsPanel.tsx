import { getPositionCoinPrices, type PositionRow } from './lp'
import { formatPrice, formatUsd } from './math'
import type { DlmmPositionGroup } from './dlmmGroups'
import { InfoHint } from './ui'

type Props = {
  groups: readonly DlmmPositionGroup[]
  busy: boolean
  onSelectPosition: (position: PositionRow) => void
  onCollect: (group: DlmmPositionGroup) => void
  onClose: (group: DlmmPositionGroup) => void
  onReopen: (group: DlmmPositionGroup) => void
  onForget: (group: DlmmPositionGroup) => void
}

function groupSide(group: DlmmPositionGroup): 'bid' | 'ask' | 'mixed' {
  if (group.record) return group.record.side
  const prices = group.positions.map(getPositionCoinPrices)
  if (prices.length === 0) return 'mixed'
  const spot = prices[0]!.coinPrice
  if (prices.every((price) => price.coinPriceUpper < spot)) return 'bid'
  if (prices.every((price) => price.coinPriceLower > spot)) return 'ask'
  return 'mixed'
}

function strategyLabel(group: DlmmPositionGroup): string {
  if (!group.record) return '自动识别'
  if (group.record.shape === 'spot') return 'Spot'
  if (group.record.shape === 'curve') return 'Curve'
  return 'Bid-Ask'
}

function rangeFacts(group: DlmmPositionGroup) {
  const rows = group.positions.map(getPositionCoinPrices)
  if (rows.length === 0) return null
  return {
    lower: Math.min(...rows.map((row) => row.coinPriceLower)),
    upper: Math.max(...rows.map((row) => row.coinPriceUpper)),
    spot: rows[0]!.coinPrice,
    coin: rows[0]!.coin.symbol,
    quote: rows[0]!.quote.symbol,
  }
}

export default function DlmmPositionsPanel(props: Props) {
  const { groups, busy, onSelectPosition, onCollect, onClose, onReopen, onForget } = props
  if (groups.length === 0) return null

  return (
    <section className="dlmm-groups" aria-label="DLMM 组合仓位">
      <div className="dlmm-groups-head">
        <div>
          <h3>我的分批策略</h3>
          <p>同一次创建的价格档会自动合成一组，可以整组领取手续费、复制或退出。</p>
        </div>
        <span className="dlmm-groups-count">
          {groups.length} 组
          <InfoHint text="批量领取和退出只会组合相同池、相同版本、相同 PositionManager 的 NFT。V3 使用 multicall；V4 使用一条 modifyLiquidities 动作序列，任意一档失败会整笔回滚。" />
        </span>
      </div>

      <div className="dlmm-group-grid">
        {groups.map((group) => {
          const totalUsd = group.positions.reduce((sum, position) => sum + position.totalUsd, 0)
          const feesUsd = group.positions.reduce(
            (sum, position) => sum + position.fees0Usd + position.fees1Usd,
            0,
          )
          const pnlReady = group.positions.length > 0 && group.positions.every((position) => position.pnlReady)
          const pnlUsd = group.positions.reduce((sum, position) => sum + position.pnlUsd, 0)
          const inRange = group.positions.filter((position) => position.inRange).length
          const side = groupSide(group)
          const range = rangeFacts(group)
          const sorted = [...group.positions].sort((a, b) => a.tickLower - b.tickLower)
          const tickLower = sorted[0]?.tickLower ?? 0
          const tickUpper = sorted[sorted.length - 1]?.tickUpper ?? tickLower + 1
          const tickSpan = Math.max(1, tickUpper - tickLower)
          const spotTick = sorted[0]?.tick ?? tickLower
          const spotPct = Math.max(0, Math.min(100, ((spotTick - tickLower) / tickSpan) * 100))
          const hasPositions = group.positions.length >= 2

          return (
            <article className={`dlmm-group-card ${side} ${group.state}`} key={group.id}>
              <div className="dlmm-group-top">
                <div className="dlmm-group-title">
                  <span className={`tag ${group.version}`}>{group.version.toUpperCase()}</span>
                  <strong>{group.pair}</strong>
                  <span className={`dlmm-group-side ${side}`}>
                    {side === 'bid' ? 'Bid' : side === 'ask' ? 'Ask' : 'Multi-Bin'}
                  </span>
                </div>
                <div className="dlmm-group-meta">
                  <span>{strategyLabel(group)}</span>
                  <span>{(group.fee / 10_000).toFixed(2)}%</span>
                  <span>{group.plannedBandCount} 档</span>
                </div>
              </div>

              {group.state === 'pending' ? (
                <div className="dlmm-group-pending">
                  <strong>等待仓位上链或索引刷新</strong>
                  <span>交易 {group.record?.txHash.slice(0, 12)}… · 点顶部“刷新仓位”即可恢复 NFT 编号</span>
                </div>
              ) : (
                <>
                  <div className="dlmm-group-kpis">
                    <div><span>组合价值</span><strong>{formatUsd(totalUsd)}</strong></div>
                    <div><span>未领手续费</span><strong className="ok-text">{formatUsd(feesUsd)}</strong></div>
                    <div>
                      <span>组合盈亏</span>
                      <strong className={pnlReady && pnlUsd < 0 ? 'bad-text' : pnlReady ? 'ok-text' : ''}>
                        {pnlReady ? `${pnlUsd >= 0 ? '+' : '−'}${formatUsd(Math.abs(pnlUsd))}` : '—'}
                      </strong>
                    </div>
                    <div><span>正在成交</span><strong>{inRange}/{group.positions.length}</strong></div>
                  </div>

                  <div className="dlmm-group-range">
                    <div className="dlmm-group-range-head">
                      <span>
                        {range
                          ? `${formatPrice(range.lower)} – ${formatPrice(range.upper)} ${range.quote}/${range.coin}`
                          : '价格带读取中'}
                      </span>
                      <span>{range ? `现价 ${formatPrice(range.spot)}` : ''}</span>
                    </div>
                    <div className="dlmm-group-band-track">
                      {sorted.map((position) => (
                        <button
                          type="button"
                          key={`${position.version}:${position.tokenId}`}
                          className={position.inRange ? 'in' : 'out'}
                          style={{ flexGrow: Math.max(1, position.tickUpper - position.tickLower) }}
                          title={`#${position.tokenId} · ticks ${position.tickLower}–${position.tickUpper}`}
                          onClick={() => onSelectPosition(position)}
                        >
                          <span>#{position.tokenId.toString()}</span>
                        </button>
                      ))}
                      <i className="dlmm-group-spot" style={{ left: `${spotPct}%` }} />
                    </div>
                    <div className="dlmm-group-band-note">
                      <span>近价</span>
                      <span>
                        {group.state === 'partial'
                          ? `已识别 ${group.positions.length}/${group.plannedBandCount} 档`
                          : `${group.positions.length} 个链上仓位`}
                      </span>
                      <span>远价</span>
                    </div>
                  </div>
                </>
              )}

              <div className="dlmm-group-actions">
                <button className="btn" type="button" disabled={busy || !hasPositions} onClick={() => onCollect(group)}>
                  领取全部手续费
                </button>
                <button className="btn" type="button" disabled={busy || group.positions.length === 0} onClick={() => onReopen(group)}>
                  复制策略并重挂
                </button>
                <button className="btn danger" type="button" disabled={busy || !hasPositions} onClick={() => onClose(group)}>
                  退出全部 {group.positions.length} 档
                </button>
                {group.source === 'saved' && (
                  <button className="btn ghost dlmm-group-forget" type="button" disabled={busy} onClick={() => onForget(group)}>
                    忽略记录
                  </button>
                )}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
