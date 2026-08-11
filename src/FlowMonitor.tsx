import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Address } from 'viem'
import {
  FLOW_WINDOW_MINUTES,
  fetchFlowEvents,
  flowChainLabel,
  flowExplorerTx,
  flowPoolRef,
  type FlowChainId,
  type FlowEvent,
  type FlowNotice,
  type FlowSide,
  type FlowVersion,
} from './flowEvents'
import { shortAddr } from './wallet'

type ChainFilter = 'both' | FlowChainId
type SideFilter = 'all' | FlowSide
type VersionFilter = 'all' | FlowVersion
type SortMode = 'apr' | 'inflow' | 'net' | 'volume' | 'latest'

type FlowPoolRow = {
  key: string
  latest: FlowEvent
  eventCount: number
  inflow: number
  outflow: number
  net: number
  feeAprPct?: number
  windowSwapUsd?: number
  windowFeeUsd?: number
  aprLiquidityUsd?: number
  aprSwapCount?: number
  effectiveFeePips?: number
  aprBasis?: FlowEvent['aprBasis']
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${sign}$${Math.round(abs).toLocaleString('en-US')}`
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const now = Date.now()
  const diff = Math.max(0, now - d.getTime())
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s 前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m 前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h 前`
  return d.toLocaleString()
}

function formatTokenAmount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n === 0) return '0'
  if (n >= 1_000_000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
  if (n >= 0.0001) return n.toLocaleString('en-US', { maximumFractionDigits: 6 })
  return n.toExponential(3)
}

function formatApr(n: number | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—'
  if (n >= 100_000) return `${Math.round(n).toLocaleString('en-US')}%`
  if (n >= 1_000) return `${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}%`
  if (n >= 100) return `${n.toFixed(1)}%`
  return `${n.toFixed(2)}%`
}

function formatFee(event: FlowEvent, effectiveFeePips?: number): string {
  const dynamic = event.version === 'v4' && (event.fee & 0x800000) !== 0
  const pips = effectiveFeePips ?? (dynamic ? undefined : event.fee)
  if (pips == null || !Number.isFinite(pips)) return dynamic ? '动态费率' : '费率 —'
  const percent = pips / 10_000
  const digits = percent < 0.01 ? 4 : percent < 0.1 ? 3 : 2
  return `${dynamic ? '均费 ' : ''}${percent.toFixed(digits)}%`
}

function isReliableApr(row: FlowPoolRow): boolean {
  const windowFeeYield = (row.windowFeeUsd ?? 0) / Math.max(1, row.aprLiquidityUsd ?? 0)
  return row.feeAprPct != null
    && (row.aprLiquidityUsd ?? 0) >= 1_000
    && (row.aprSwapCount ?? 0) >= 2
    && windowFeeYield <= 0.1
}

function aprSampleLabel(row: FlowPoolRow): string {
  if (row.feeAprPct == null) return '缺少锚定基数'
  if ((row.aprSwapCount ?? 0) === 0) return '窗口无成交'
  if ((row.aprLiquidityUsd ?? 0) < 1_000) return '小基数 · 高波动'
  if ((row.aprSwapCount ?? 0) < 2) return '单笔样本 · 高波动'
  if ((row.windowFeeUsd ?? 0) / Math.max(1, row.aprLiquidityUsd ?? 0) > 0.1) {
    return '异常费收 · 谨慎'
  }
  return `${FLOW_WINDOW_MINUTES}m 短窗估算`
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

function CopyBtn({ label, value, title }: { label: string; value: string; title?: string }) {
  const [flash, setFlash] = useState(false)
  return (
    <button
      type="button"
      className={`btn ghost tight flow-copy ${flash ? 'copied' : ''}`}
      title={title ?? value}
      onClick={() => {
        void copyText(value).then((ok) => {
          if (!ok) return
          setFlash(true)
          window.setTimeout(() => setFlash(false), 1200)
        })
      }}
    >
      {flash ? '已复制' : label}
    </button>
  )
}

export type OpenFlowPoolArgs = {
  chainId: FlowChainId
  version: FlowVersion
  poolAddress?: Address
  poolId?: `0x${string}`
}

export type FlowMonitorProps = {
  onOpenPool: (args: OpenFlowPoolArgs) => void
}

export default function FlowMonitor({ onOpenPool }: FlowMonitorProps) {
  const [chainFilter, setChainFilter] = useState<ChainFilter>('both')
  const [sideFilter, setSideFilter] = useState<SideFilter>('all')
  const [versionFilter, setVersionFilter] = useState<VersionFilter>('all')
  const [sortMode, setSortMode] = useState<SortMode>('apr')
  const [search, setSearch] = useState('')
  const [minAprDraft, setMinAprDraft] = useState('0')
  const [reliableOnly, setReliableOnly] = useState(false)
  const [minUsd, setMinUsd] = useState(100)
  const [minUsdDraft, setMinUsdDraft] = useState('100')
  const [filterHp, setFilterHp] = useState(true)
  const [auto, setAuto] = useState(true)
  const [busy, setBusy] = useState(false)
  const [events, setEvents] = useState<FlowEvent[]>([])
  const [notices, setNotices] = useState<FlowNotice[]>([])
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
  const eventsRef = useRef<FlowEvent[]>([])
  const genRef = useRef(0)
  const mountedRef = useRef(true)
  const runningRef = useRef(false)
  const runningKeyRef = useRef('')
  const runningGenRef = useRef(0)
  const rerunRef = useRef(false)
  const loadRef = useRef<() => Promise<void>>(async () => {})
  const optionsRef = useRef({ chainFilter, minUsd, filterHp })
  optionsRef.current = { chainFilter, minUsd, filterHp }

  const load = useCallback(async () => {
    const options = optionsRef.current
    const key = `${options.chainFilter}:${options.minUsd}:${options.filterHp}`
    if (runningRef.current) {
      // 定时器/连点不叠加同一请求；筛选条件变了则废弃旧结果，结束后补跑最新条件。
      if (key !== runningKeyRef.current) {
        genRef.current += 1
        rerunRef.current = true
      } else if (genRef.current !== runningGenRef.current) {
        // React StrictMode 的挂载自检会作废首个 generation；只在这种情况下
        // 补跑同条件请求。普通 45s 定时器撞上在途请求时直接跳过。
        rerunRef.current = true
      }
      return
    }
    const gen = ++genRef.current
    runningRef.current = true
    runningKeyRef.current = key
    runningGenRef.current = gen
    setBusy(true)
    const t0 = performance.now()
    const chainIds: FlowChainId[] =
      options.chainFilter === 'both' ? [56, 4663] : [options.chainFilter]
    try {
      let rows: FlowEvent[]
      let nextNotices: FlowNotice[]
      if (chainIds.length === 1) {
        const result = await fetchFlowEvents({
          chainIds,
          minUsd: options.minUsd,
          filterHoneypot: options.filterHp,
          limit: 30,
        })
        rows = result.events
        nextNotices = result.notices
      } else {
        // 双链首次扫描时 BSC 往往更慢；哪个链先完成就先把该链榜单展示出来，
        // 不让用户盯着空白页等最慢的数据源。
        const previousRows = eventsRef.current
        const results = new Map<FlowChainId, { events: FlowEvent[]; notices: FlowNotice[] }>()
        const publishPartial = () => {
          if (!mountedRef.current || gen !== genRef.current) return
          const combined = chainIds.flatMap((chainId) =>
            results.get(chainId)?.events
            ?? previousRows.filter((event) => event.chainId === chainId))
          combined.sort((a, b) => b.timestamp - a.timestamp)
          eventsRef.current = combined
          setEvents(combined)
          setNotices([...results.values()].flatMap((result) => result.notices))
        }
        await Promise.all(chainIds.map(async (chainId) => {
          try {
            const result = await fetchFlowEvents({
              chainIds: [chainId],
              minUsd: options.minUsd,
              filterHoneypot: options.filterHp,
              limit: 20,
            })
            results.set(chainId, result)
          } catch (error) {
            results.set(chainId, {
              events: [],
              notices: [{
                level: 'error',
                message: `${flowChainLabel(chainId)}：${error instanceof Error ? error.message : String(error)}`,
              }],
            })
          }
          publishPartial()
        }))
        rows = chainIds.flatMap((chainId) => results.get(chainId)?.events ?? [])
        rows.sort((a, b) => b.timestamp - a.timestamp)
        nextNotices = [...results.values()].flatMap((result) => result.notices)
      }
      if (!mountedRef.current || gen !== genRef.current) return
      eventsRef.current = rows
      setEvents(rows)
      setNotices(nextNotices)
      setUpdatedAt(Date.now())
      setElapsedMs(Math.round(performance.now() - t0))
    } catch (e) {
      if (!mountedRef.current || gen !== genRef.current) return
      setNotices([{
        level: 'error',
        message: e instanceof Error ? e.message : String(e),
      }])
    } finally {
      runningRef.current = false
      if (rerunRef.current && mountedRef.current) {
        rerunRef.current = false
        queueMicrotask(() => void loadRef.current())
      } else if (mountedRef.current) {
        setBusy(false)
      }
    }
  }, [])
  loadRef.current = load

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    void load()
  }, [chainFilter, minUsd, filterHp, load])

  useEffect(() => {
    if (!auto) return
    const t = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void load()
    }, 45_000)
    return () => window.clearInterval(t)
  }, [auto, load])

  useEffect(() => {
    if (!auto) return
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [auto, load])

  const pools = useMemo(() => {
    const grouped = new Map<string, FlowPoolRow>()
    for (const event of events) {
      if (versionFilter !== 'all' && event.version !== versionFilter) continue
      const poolRef = flowPoolRef(event)
      const key = `${event.chainId}:${event.version}:${poolRef.toLowerCase()}`
      const previous = grouped.get(key)
      const inflow = event.side === 'in' ? event.amountUsd : 0
      const outflow = event.side === 'out' ? event.amountUsd : 0
      if (!previous) {
        grouped.set(key, {
          key,
          latest: event,
          eventCount: 1,
          inflow,
          outflow,
          net: inflow - outflow,
          feeAprPct: event.feeAprPct,
          windowSwapUsd: event.windowSwapUsd,
          windowFeeUsd: event.windowFeeUsd,
          aprLiquidityUsd: event.aprLiquidityUsd,
          aprSwapCount: event.aprSwapCount,
          effectiveFeePips: event.effectiveFeePips,
          aprBasis: event.aprBasis,
        })
        continue
      }
      previous.eventCount += 1
      previous.inflow += inflow
      previous.outflow += outflow
      previous.net = previous.inflow - previous.outflow
      if (event.timestamp > previous.latest.timestamp) previous.latest = event
      if (previous.feeAprPct == null && event.feeAprPct != null) {
        previous.feeAprPct = event.feeAprPct
        previous.windowSwapUsd = event.windowSwapUsd
        previous.windowFeeUsd = event.windowFeeUsd
        previous.aprLiquidityUsd = event.aprLiquidityUsd
        previous.aprSwapCount = event.aprSwapCount
        previous.effectiveFeePips = event.effectiveFeePips
        previous.aprBasis = event.aprBasis
      }
    }
    return [...grouped.values()]
  }, [events, versionFilter])

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    const parsedMinApr = Number(minAprDraft.replace(/,/g, '').trim())
    const minApr = Number.isFinite(parsedMinApr) ? Math.max(0, parsedMinApr) : 0
    const rows = pools.filter((row) => {
      if (sideFilter === 'in' && !(row.net > 0)) return false
      if (sideFilter === 'out' && !(row.net < 0)) return false
      if (minApr > 0 && !(row.feeAprPct != null && row.feeAprPct >= minApr)) return false
      if (reliableOnly && !isReliableApr(row)) return false
      if (query) {
        const event = row.latest
        const haystack = [
          event.symbol0,
          event.symbol1,
          event.token0,
          event.token1,
          flowPoolRef(event),
          flowChainLabel(event.chainId),
          event.version,
        ].join(' ').toLowerCase()
        if (!haystack.includes(query)) return false
      }
      return true
    })
    rows.sort((a, b) => {
      if (sortMode === 'apr') {
        const aApr = a.feeAprPct
        const bApr = b.feeAprPct
        if (aApr == null && bApr != null) return 1
        if (aApr != null && bApr == null) return -1
        if (aApr != null && bApr != null && aApr !== bApr) return bApr - aApr
      } else if (sortMode === 'inflow' && a.inflow !== b.inflow) {
        return b.inflow - a.inflow
      } else if (sortMode === 'net' && a.net !== b.net) {
        return b.net - a.net
      } else if (sortMode === 'volume') {
        const delta = (b.windowSwapUsd ?? -1) - (a.windowSwapUsd ?? -1)
        if (delta !== 0) return delta
      }
      if (a.latest.timestamp !== b.latest.timestamp) return b.latest.timestamp - a.latest.timestamp
      return a.key.localeCompare(b.key)
    })
    return rows
  }, [minAprDraft, pools, reliableOnly, search, sideFilter, sortMode])

  const summary = useMemo(() => {
    let inflow = 0
    let outflow = 0
    let withApr = 0
    for (const row of visible) {
      inflow += row.inflow
      outflow += row.outflow
      if (row.feeAprPct != null) withApr += 1
    }
    return { inflow, outflow, net: inflow - outflow, withApr }
  }, [visible])

  const applyMinUsd = () => {
    const parsed = Number(minUsdDraft.replace(/,/g, '').trim())
    const next = Number.isFinite(parsed) ? Math.min(1e12, Math.max(0, parsed)) : minUsd
    setMinUsdDraft(String(next))
    setMinUsd(next)
  }

  const warningMessages = notices.filter((notice) => notice.level === 'warning')
  const errorMessages = notices.filter((notice) => notice.level === 'error')

  return (
    <section className="page-flow">
      <div className="flow-page-head">
        <div>
          <h2 className="pos-page-title">LP 资金动向</h2>
          <p className="muted pos-page-sub">
            最近 {FLOW_WINDOW_MINUTES} 分钟 · Uniswap V3 + V4 · BSC / Robinhood 开/加仓与撤出
          </p>
          <p className="flow-trust-note">
            默认按手续费年化从高到低。年化 = 近 {FLOW_WINDOW_MINUTES} 分钟锚定 Swap 手续费 ÷ 流动性基数 × 365；
            短窗口只用于发现，不代表未来收益。
            <span className="flow-trust-note-extra">
              V3 取池合约余额；V4 按当前活跃流动性深度估算，仅采用稳定币与 WETH/WBNB 锚点。
            </span>
          </p>
        </div>
        <div className="pos-page-actions">
          <button
            type="button"
            className={`btn primary ${busy ? 'active' : ''}`}
            disabled={busy}
            aria-busy={busy}
            onClick={() => void load()}
          >
            {busy ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>

      <div className="flow-filters">
        <label className="inline-setting">
          链
          <select
            value={chainFilter === 'both' ? 'both' : String(chainFilter)}
            onChange={(e) => {
              const v = e.target.value
              setChainFilter(v === 'both' ? 'both' : (Number(v) as FlowChainId))
            }}
          >
            <option value="both">BSC + Robinhood</option>
            <option value="56">BSC</option>
            <option value="4663">Robinhood</option>
          </select>
        </label>
        <label className="inline-setting">
          协议
          <select value={versionFilter} onChange={(e) => setVersionFilter(e.target.value as VersionFilter)}>
            <option value="all">V3 + V4</option>
            <option value="v3">仅 V3</option>
            <option value="v4">仅 V4</option>
          </select>
        </label>
        <label className="inline-setting">
          方向
          <select value={sideFilter} onChange={(e) => setSideFilter(e.target.value as SideFilter)}>
            <option value="all">全部</option>
            <option value="in">净流入</option>
            <option value="out">净流出</option>
          </select>
        </label>
        <label className="inline-setting">
          排序
          <select
            aria-label="排序方式"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
          >
            <option value="apr">手续费年化：高到低</option>
            <option value="inflow">流入资金：高到低</option>
            <option value="net">净流入：高到低</option>
            <option value="volume">Swap 成交额：高到低</option>
            <option value="latest">最近动向</option>
          </select>
        </label>
        <details className="flow-more-filters">
          <summary className="btn ghost tight">金额与样本筛选</summary>
          <div className="flow-more-panel">
            <div className="inline-setting flow-min-setting">
              <span>单笔动向 ≥ USD</span>
              <input
                className="flow-min-input"
                type="number"
                min={0}
                step={50}
                value={minUsdDraft}
                aria-label="最低锚定 USD 金额"
                onChange={(e) => setMinUsdDraft(e.target.value)}
                onBlur={applyMinUsd}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyMinUsd()
                  if (e.key === 'Escape') setMinUsdDraft(String(minUsd))
                }}
              />
              <button
                type="button"
                className="btn ghost tight flow-min-apply"
                disabled={minUsdDraft === String(minUsd)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={applyMinUsd}
              >
                应用
              </button>
            </div>
            <label className="inline-setting flow-apr-min-setting">
              最低年化 %
              <input
                className="flow-min-input"
                type="number"
                min={0}
                step={10}
                value={minAprDraft}
                aria-label="最低手续费年化百分比"
                onChange={(e) => setMinAprDraft(e.target.value)}
              />
            </label>
            <label
              className="inline-setting check"
              title="至少 2 笔可锚定 Swap、年化基数不低于 1,000 美元，且窗口手续费不超过基数的 10%"
            >
              <input
                type="checkbox"
                checked={reliableOnly}
                onChange={(e) => setReliableOnly(e.target.checked)}
              />
              仅看有效样本
            </label>
            <label className="inline-setting check" title="仅过滤风险接口明确判定的 BSC 貔貅；未知代币不会误杀，Robinhood 暂无对应检测服务">
              <input type="checkbox" checked={filterHp} onChange={(e) => setFilterHp(e.target.checked)} />
              过滤已确认貔貅
            </label>
            <label className="inline-setting check">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              自动刷新 45s
            </label>
          </div>
        </details>
        {updatedAt && (
          <span className="muted flow-updated">
            更新于 {new Date(updatedAt).toLocaleTimeString()}
            {elapsedMs != null ? ` · ${elapsedMs}ms` : ''}
            {busy ? ' · 增量中…' : ''}
          </span>
        )}
      </div>

      {warningMessages.length > 0 && (
        <p className="flow-banner warn">
          {warningMessages.map((notice) => notice.message).join(' · ')}
        </p>
      )}
      {errorMessages.length > 0 && (
        <p className="flow-banner err">
          {errorMessages.map((notice) => notice.message).join(' · ')}
        </p>
      )}

      <div className="flow-overview">
        <div className="flow-discovery-bar">
          <input
            type="search"
            value={search}
            aria-label="搜索动向池"
            placeholder="搜索币种 / CA / 池地址"
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="muted">显示 {visible.length} / {pools.length} 个池</span>
        </div>

        {(updatedAt || visible.length > 0) && (
          <div className="flow-summary" aria-label="当前筛选汇总">
            <div className="flow-summary-item">
              <span className="muted">池子</span>
              <strong>{visible.length}</strong>
            </div>
            <div className="flow-summary-item apr">
              <span className="muted">可算年化</span>
              <strong>{summary.withApr}</strong>
            </div>
            <div className="flow-summary-item in">
              <span className="muted">流入</span>
              <strong>{formatUsd(summary.inflow)}</strong>
            </div>
            <div className="flow-summary-item out">
              <span className="muted">流出</span>
              <strong>{formatUsd(summary.outflow)}</strong>
            </div>
            <div className={`flow-summary-item ${summary.net >= 0 ? 'in' : 'out'}`}>
              <span className="muted">净流</span>
              <strong>{summary.net > 0 ? '+' : ''}{formatUsd(summary.net)}</strong>
            </div>
          </div>
        )}
      </div>

      {busy && events.length === 0 ? (
        <p className="muted flow-empty">
          正在扫描最近 {FLOW_WINDOW_MINUTES} 分钟链上日志并计算池级年化，首次可能需要 10–30 秒…
        </p>
      ) : visible.length === 0 ? (
        <p className="muted flow-empty">
          {errorMessages.length > 0
            ? '当前数据源暂不可用，请检查上方错误或在设置中更换 RPC 后重试'
            : pools.length > 0
              ? '没有池子符合当前年化、方向或搜索条件，请放宽筛选后重试'
              : '最近窗口暂无符合条件的锚定资金记录（可调低金额或关闭貔貅过滤重试）'}
        </p>
      ) : (
        <div className="flow-table">
          <div className="flow-table-head" aria-hidden="true">
            <span>池子 / 网络</span>
            <span>手续费年化</span>
            <span>流入资金</span>
            <span>流出资金</span>
            <span>净流</span>
            <span>{FLOW_WINDOW_MINUTES}m Swap</span>
            <span>最近动向 / 操作</span>
          </div>
          <div className="flow-list">
            {visible.map((row, index) => {
              const e = row.latest
              const poolRef = flowPoolRef(e)
              const direction: FlowSide = row.net >= 0 ? 'in' : 'out'
              const reliable = isReliableApr(row)
              const expanded = expandedKey === row.key
              const detailId = `flow-pool-detail-${index}`
              const pairLabel = `${e.symbol0} / ${e.symbol1}`
              const basisLabel = row.aprBasis === 'active-liquidity'
                ? 'V4 当前活跃流动性深度（估算）'
                : 'V3 当前池合约余额（锚定侧估值）'
              return (
                <article
                  key={row.key}
                  className={`flow-card ${direction} ${expanded ? 'expanded' : ''}`}
                  data-testid="flow-pool-card"
                  data-apr={row.feeAprPct == null ? '' : String(row.feeAprPct)}
                  data-inflow={String(row.inflow)}
                >
                  <div className="flow-row">
                    <div className="flow-pool-cell">
                      <div className="flow-pair-line">
                        <span className="flow-rank" aria-label={`列表第 ${index + 1} 名`}>#{index + 1}</span>
                        <strong className="flow-pair-name" title={pairLabel}>{pairLabel}</strong>
                      </div>
                      <div className="flow-pool-meta">
                        <span className={`flow-side ${direction}`}>
                          {row.net > 0 ? '净流入' : row.net < 0 ? '净流出' : '持平'}
                        </span>
                        <span className={`flow-ver ${e.version}`}>{e.version.toUpperCase()}</span>
                        <span className="flow-chain">{flowChainLabel(e.chainId)}</span>
                        <span className="muted">{formatFee(e, row.effectiveFeePips)}</span>
                      </div>
                    </div>

                    <div
                      className={`flow-row-metric flow-row-apr ${reliable ? 'reliable' : 'volatile'}`}
                      title={`近 ${FLOW_WINDOW_MINUTES} 分钟手续费 ÷ ${basisLabel} × 365，简单年化、不复利`}
                    >
                      <span className="flow-mobile-label">手续费年化</span>
                      <strong data-testid="flow-apr-value">{formatApr(row.feeAprPct)}</strong>
                      <em>{aprSampleLabel(row)}</em>
                    </div>
                    <div className="flow-row-metric flow-row-inflow">
                      <span className="flow-mobile-label">流入</span>
                      <strong>{formatUsd(row.inflow)}</strong>
                    </div>
                    <div className="flow-row-metric flow-row-outflow">
                      <span className="flow-mobile-label">流出</span>
                      <strong>{formatUsd(row.outflow)}</strong>
                    </div>
                    <div className={`flow-row-metric flow-row-net ${row.net >= 0 ? 'positive' : 'negative'}`}>
                      <span className="flow-mobile-label">净流</span>
                      <strong>{row.net > 0 ? '+' : ''}{formatUsd(row.net)}</strong>
                    </div>
                    <div className="flow-row-metric flow-row-volume">
                      <span className="flow-mobile-label">{FLOW_WINDOW_MINUTES}m Swap</span>
                      <strong>{row.windowSwapUsd == null ? '—' : formatUsd(row.windowSwapUsd)}</strong>
                    </div>
                    <div className="flow-row-actions">
                      <div className="flow-row-time">
                        <strong>{formatTime(e.timestamp)}</strong>
                        <span>{row.eventCount} 笔动向</span>
                      </div>
                      <div className="flow-row-buttons">
                        <button
                          type="button"
                          className="btn ghost tight"
                          aria-expanded={expanded}
                          aria-controls={detailId}
                          aria-label={`${expanded ? '收起' : '查看'} ${pairLabel} 详情`}
                          onClick={() => setExpandedKey(expanded ? null : row.key)}
                        >
                          {expanded ? '收起' : '详情'}
                        </button>
                        <button
                          type="button"
                          className="btn primary tight"
                          title={`用 ${pairLabel} 池开仓`}
                          aria-label={`用 ${pairLabel} 池开仓`}
                          onClick={() =>
                            onOpenPool({
                              chainId: e.chainId,
                              version: e.version,
                              poolAddress: e.version === 'v3' ? e.poolAddress : undefined,
                              poolId: e.poolId,
                            })
                          }
                        >
                          开仓
                        </button>
                      </div>
                    </div>
                  </div>

                  {expanded && (
                    <div className="flow-card-detail" id={detailId}>
                      <div className="flow-detail-stats">
                        <div>
                          <span className="muted">{FLOW_WINDOW_MINUTES}m Swap</span>
                          <strong>{row.windowSwapUsd == null ? '—' : formatUsd(row.windowSwapUsd)}</strong>
                        </div>
                        <div>
                          <span className="muted">{FLOW_WINDOW_MINUTES}m 手续费</span>
                          <strong>{row.windowFeeUsd == null ? '—' : formatUsd(row.windowFeeUsd)}</strong>
                        </div>
                        <div title={basisLabel}>
                          <span className="muted">年化基数 {e.version === 'v4' ? '≈' : ''}</span>
                          <strong>{row.aprLiquidityUsd == null ? '—' : formatUsd(row.aprLiquidityUsd)}</strong>
                        </div>
                        <div>
                          <span className="muted">锚定 Swap</span>
                          <strong>{row.aprSwapCount == null ? '—' : `${row.aprSwapCount} 笔`}</strong>
                        </div>
                        <div>
                          <span className="muted">最近一笔 {e.side === 'in' ? '流入' : '流出'}</span>
                          <strong>{e.amountEstimated ? '≈' : ''}{formatUsd(e.amountUsd)}</strong>
                        </div>
                        <div>
                          <span className="muted">数据 / 大额动向</span>
                          <strong>{e.source === 'subgraph' ? 'Graph' : '链上'} · {row.eventCount} 笔</strong>
                        </div>
                      </div>
                      {e.amount0 != null && e.amount1 != null && (
                        <div className="flow-token-amounts flow-latest-action">
                          <span className="muted">最近数量 {e.amountEstimated ? '（估算）' : ''}</span>
                          <strong>{formatTokenAmount(e.amount0)} {e.symbol0}</strong>
                          <span className="muted">+</span>
                          <strong>{formatTokenAmount(e.amount1)} {e.symbol1}</strong>
                        </div>
                      )}
                      <div className="flow-detail-foot">
                        <code className="mono muted" title={poolRef}>
                          {e.version === 'v4' ? 'poolId' : '池'} {shortAddr(poolRef as Address)}
                        </code>
                        <span className="flow-copy-group">
                          <CopyBtn label={`CA ${e.symbol0}`} value={e.token0} title={`复制 ${e.symbol0}：${e.token0}`} />
                          <CopyBtn label={`CA ${e.symbol1}`} value={e.token1} title={`复制 ${e.symbol1}：${e.token1}`} />
                          <CopyBtn
                            label={e.version === 'v4' ? '复制 poolId' : '复制池'}
                            value={poolRef}
                            title={e.version === 'v4' ? `复制 V4 poolId：${poolRef}` : `复制池地址：${poolRef}`}
                          />
                        </span>
                        <a
                          className="btn ghost tight"
                          href={flowExplorerTx(e.chainId, e.txHash)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          最近交易 ↗
                        </a>
                      </div>
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
