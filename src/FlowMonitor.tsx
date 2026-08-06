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
import { getActiveChainId, shortAddr } from './wallet'

type ChainFilter = 'both' | FlowChainId
type SideFilter = 'all' | FlowSide
type VersionFilter = 'all' | FlowVersion

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
  const [chainFilter, setChainFilter] = useState<ChainFilter>(() => {
    const active = getActiveChainId()
    return active === 56 || active === 4663 ? active : 'both'
  })
  const [sideFilter, setSideFilter] = useState<SideFilter>('all')
  const [versionFilter, setVersionFilter] = useState<VersionFilter>('all')
  const [minUsd, setMinUsd] = useState(100)
  const [minUsdDraft, setMinUsdDraft] = useState('100')
  const [filterHp, setFilterHp] = useState(true)
  const [auto, setAuto] = useState(true)
  const [busy, setBusy] = useState(false)
  const [events, setEvents] = useState<FlowEvent[]>([])
  const [notices, setNotices] = useState<FlowNotice[]>([])
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
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
        // 补跑同条件请求。普通 20s 定时器撞上在途请求时直接跳过。
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
      const { events: rows, notices: nextNotices } = await fetchFlowEvents({
        chainIds,
        minUsd: options.minUsd,
        filterHoneypot: options.filterHp,
        limit: 30,
      })
      if (!mountedRef.current || gen !== genRef.current) return
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
    }, 20_000)
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

  const visible = useMemo(() => {
    return events.filter((e) => {
      if (sideFilter !== 'all' && e.side !== sideFilter) return false
      if (versionFilter !== 'all' && e.version !== versionFilter) return false
      return true
    })
  }, [events, sideFilter, versionFilter])

  const summary = useMemo(() => {
    let inflow = 0
    let outflow = 0
    for (const event of visible) {
      if (event.side === 'in') inflow += event.amountUsd
      else outflow += event.amountUsd
    }
    return { inflow, outflow, net: inflow - outflow }
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
            金额只统计稳定币与 WETH/WBNB 的实际进出，不采信新币自己的池价。
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
            <option value="in">仅流入</option>
            <option value="out">仅流出</option>
          </select>
        </label>
        <div className="inline-setting flow-min-setting">
          <span>最低锚定 USD</span>
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
        <label className="inline-setting check" title="仅过滤风险接口明确判定的 BSC 貔貅；未知代币不会误杀，Robinhood 暂无对应检测服务">
          <input type="checkbox" checked={filterHp} onChange={(e) => setFilterHp(e.target.checked)} />
          过滤已确认貔貅
        </label>
        <label className="inline-setting check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          自动刷新 20s
        </label>
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

      {(updatedAt || visible.length > 0) && (
        <div className="flow-summary" aria-label="当前筛选汇总">
          <div className="flow-summary-item">
            <span className="muted">记录</span>
            <strong>{visible.length}</strong>
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

      {busy && visible.length === 0 ? (
        <p className="muted flow-empty">
          正在扫描最近 {FLOW_WINDOW_MINUTES} 分钟链上日志，首次可能需要 10–30 秒…
        </p>
      ) : visible.length === 0 ? (
        <p className="muted flow-empty">
          {errorMessages.length > 0
            ? '当前数据源暂不可用，请检查上方错误或在设置中更换 RPC 后重试'
            : '最近窗口暂无符合条件的锚定资金记录（可调低金额或关闭貔貅过滤重试）'}
        </p>
      ) : (
        <div className="flow-list">
          {visible.map((e) => {
            const poolRef = flowPoolRef(e)
            return (
              <article key={e.id} className={`flow-card ${e.side}`}>
                <div className="flow-card-top">
                  <span className={`flow-side ${e.side}`}>{e.side === 'in' ? '流入' : '流出'}</span>
                  <span className={`flow-ver ${e.version}`}>{e.version.toUpperCase()}</span>
                  <span className="flow-chain">{flowChainLabel(e.chainId)}</span>
                  <span className="flow-source">{e.source === 'subgraph' ? 'Graph' : '链上'}</span>
                  <span className="muted mono">{formatTime(e.timestamp)}</span>
                  <span className="flow-usd" title="稳定币与 WETH/WBNB 的锚定资金">
                    {e.amountEstimated ? '≈' : ''}{formatUsd(e.amountUsd)}
                  </span>
                </div>
                <div className="flow-pair">
                  <span className="flow-pair-name">
                    {e.symbol0} / {e.symbol1}
                    <span className="muted"> · {(e.fee / 10000).toFixed(2)}%</span>
                  </span>
                  <span className="flow-copy-group">
                    <CopyBtn label={`CA ${e.symbol0}`} value={e.token0} title={`复制 ${e.symbol0}：${e.token0}`} />
                    <CopyBtn label={`CA ${e.symbol1}`} value={e.token1} title={`复制 ${e.symbol1}：${e.token1}`} />
                    <CopyBtn
                      label={e.version === 'v4' ? '复制 poolId' : '复制池'}
                      value={poolRef}
                      title={e.version === 'v4' ? `复制 V4 poolId：${poolRef}` : `复制池地址：${poolRef}`}
                    />
                  </span>
                </div>
                {e.amount0 != null && e.amount1 != null && (
                  <div className="flow-token-amounts">
                    <span className="muted">{e.amountEstimated ? '按当前池状态估算数量' : '事件数量'}</span>
                    <strong>{formatTokenAmount(e.amount0)} {e.symbol0}</strong>
                    <span className="muted">+</span>
                    <strong>{formatTokenAmount(e.amount1)} {e.symbol1}</strong>
                  </div>
                )}
                <div className="flow-card-foot">
                  <code className="mono muted" title={poolRef}>
                    {e.version === 'v4' ? 'poolId' : '池'} {shortAddr(poolRef as Address)}
                  </code>
                  {e.tokenId && (
                    <span className="mono muted flow-token-id" title={`NFT #${e.tokenId}`}>
                      NFT #{e.tokenId.length > 10 ? `${e.tokenId.slice(0, 6)}…${e.tokenId.slice(-4)}` : e.tokenId}
                    </span>
                  )}
                  <a
                    className="btn ghost tight"
                    href={flowExplorerTx(e.chainId, e.txHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    交易 ↗
                  </a>
                  <button
                    type="button"
                    className="btn primary tight"
                    onClick={() =>
                      onOpenPool({
                        chainId: e.chainId,
                        version: e.version,
                        poolAddress: e.version === 'v3' ? e.poolAddress : undefined,
                        poolId: e.poolId,
                      })
                    }
                  >
                    用此池开仓
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
