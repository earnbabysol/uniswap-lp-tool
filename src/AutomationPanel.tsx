/**
 * 自动化面板：配置 + 演练 + 运行日志。只在本地私钥解锁时可操作。
 * 真正的调度循环放在 App.tsx（那边才有 positions / walletClient / toast）。
 */

import { useCallback, useState } from 'react'
import {
  clearAutoLog,
  loadAutoLog,
  resetAutoState,
  txCountToday,
  type AutoConfig,
  type AutoLogEntry,
  type Plan,
} from './automation'
import { explorerTx } from './wallet'
import { InfoHint } from './ui'

type Props = {
  cfg: AutoConfig
  onCfg: (next: AutoConfig) => void
  unlocked: boolean
  running: boolean
  lastRunAt: number | null
  nextRunIn: number | null
  plan: Plan | null
  onDryRun: () => void
  onRunNow: () => void
  busy: boolean
}

function Num({
  value,
  onChange,
  step = 1,
  min = 0,
  suffix,
  width = 72,
}: {
  value: number
  onChange: (n: number) => void
  step?: number
  min?: number
  suffix?: string
  width?: number
}) {
  return (
    <span className="num-field">
      <input
        className="input"
        type="number"
        value={value}
        step={step}
        min={min}
        style={{ width }}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) onChange(Math.max(min, n))
        }}
      />
      {suffix && <span className="num-suffix">{suffix}</span>}
    </span>
  )
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

export function AutomationPanel({
  cfg,
  onCfg,
  unlocked,
  running,
  lastRunAt,
  nextRunIn,
  plan,
  onDryRun,
  onRunNow,
  busy,
}: Props) {
  const [log, setLog] = useState<AutoLogEntry[]>(() => loadAutoLog())
  const [showLog, setShowLog] = useState(false)

  const patch = useCallback((p: Partial<AutoConfig>) => onCfg({ ...cfg, ...p }), [cfg, onCfg])
  const patchCompound = useCallback(
    (p: Partial<AutoConfig['compound']>) => onCfg({ ...cfg, compound: { ...cfg.compound, ...p } }),
    [cfg, onCfg],
  )
  const patchRebalance = useCallback(
    (p: Partial<AutoConfig['rebalance']>) =>
      onCfg({ ...cfg, rebalance: { ...cfg.rebalance, ...p } }),
    [cfg, onCfg],
  )
  const patchGuards = useCallback(
    (p: Partial<AutoConfig['guards']>) => onCfg({ ...cfg, guards: { ...cfg.guards, ...p } }),
    [cfg, onCfg],
  )

  if (!unlocked) {
    return (
      <div className="auto-panel locked">
        <div className="auto-locked-msg">
          <strong>自动化需要本地私钥</strong>
          插件钱包每笔交易都要手动确认，没法无人值守。请先在上方导入并解锁本地私钥。
        </div>
      </div>
    )
  }

  const usedToday = txCountToday()

  return (
    <div className="auto-panel">
      <div className="auto-head">
        <label className="switch">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span className="switch-track" />
          <span className="switch-label">{cfg.enabled ? '自动化运行中' : '自动化已停止'}</span>
        </label>

        <label className="switch">
          <input
            type="checkbox"
            checked={cfg.dryRun}
            onChange={(e) => patch({ dryRun: e.target.checked })}
          />
          <span className="switch-track" />
          <span className="switch-label">
            演练模式
            <InfoHint text="只计算并记录「本来会做什么」，不发任何交易。建议先跑一天演练确认策略再关掉。" />
          </span>
        </label>

        <div className="auto-status">
          {cfg.enabled && !cfg.dryRun && (
            <span className="badge live">
              <span className="dot-live" />
              实盘
            </span>
          )}
          {cfg.enabled && cfg.dryRun && <span className="badge">演练</span>}
          <span className="muted small">
            今日 {usedToday}/{cfg.guards.maxTxPerDay} 笔
            {lastRunAt ? ` · 上次检查 ${new Date(lastRunAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}
            {running ? ' · 检查中…' : nextRunIn != null ? ` · ${nextRunIn}s 后再查` : ''}
          </span>
        </div>
      </div>

      <div className="auto-grid">
        {/* ── 自动复投 ── */}
        <div className={`auto-card ${cfg.compound.enabled ? 'on' : ''}`}>
          <div className="auto-card-head">
            <label className="switch">
              <input
                type="checkbox"
                checked={cfg.compound.enabled}
                onChange={(e) => patchCompound({ enabled: e.target.checked })}
              />
              <span className="switch-track" />
              <span className="switch-label">自动复投</span>
            </label>
          </div>
          <p className="auto-card-desc">
            未领手续费到阈值就领出来加回同一区间，费再生费。只对在区间内的仓位动手。
          </p>
          <div className="auto-field">
            <span>手续费阈值</span>
            <Num
              value={cfg.compound.minFeesUsd}
              onChange={(n) => patchCompound({ minFeesUsd: n })}
              step={1}
              suffix="USD"
            />
          </div>
          <div className="auto-field">
            <span>
              冷却
              <InfoHint text="同一仓位两次复投的最小间隔，避免小额高频操作把收益全花在 gas 上。" />
            </span>
            <Num
              value={cfg.compound.cooldownMins}
              onChange={(n) => patchCompound({ cooldownMins: n })}
              step={30}
              suffix="分钟"
            />
          </div>
          <div className="auto-note">V4 需要两笔交易（领取 + 加仓），gas 更贵，阈值建议设高一点。</div>
        </div>

        {/* ── 自动 Rebalance ── */}
        <div className={`auto-card ${cfg.rebalance.enabled ? 'on' : ''}`}>
          <div className="auto-card-head">
            <label className="switch">
              <input
                type="checkbox"
                checked={cfg.rebalance.enabled}
                onChange={(e) => patchRebalance({ enabled: e.target.checked })}
              />
              <span className="switch-track" />
              <span className="switch-label">自动 Rebalance</span>
            </label>
          </div>
          <p className="auto-card-desc">
            价格跑出区间（或逼近边界）就撤仓重开。会实现无常损失，行情单边时可能反复挨刀。
          </p>
          <div className="auto-field">
            <span>触发条件</span>
            <div className="chip-row">
              <button
                className={`chip ${cfg.rebalance.trigger === 'out' ? 'on' : ''}`}
                onClick={() => patchRebalance({ trigger: 'out' })}
              >
                已越界
              </button>
              <button
                className={`chip ${cfg.rebalance.trigger === 'near' ? 'on' : ''}`}
                onClick={() => patchRebalance({ trigger: 'near' })}
              >
                逼近边界
              </button>
            </div>
          </div>
          {cfg.rebalance.trigger === 'near' && (
            <div className="auto-field">
              <span>距边界</span>
              <Num
                value={cfg.rebalance.nearPct}
                onChange={(n) => patchRebalance({ nearPct: n })}
                step={0.5}
                suffix="%"
              />
            </div>
          )}
          <div className="auto-field">
            <span>
              观察期
              <InfoHint text="连续满足条件多久才动手。防止一根插针把你的仓位来回搬。" />
            </span>
            <Num
              value={cfg.rebalance.dwellMins}
              onChange={(n) => patchRebalance({ dwellMins: n })}
              step={5}
              suffix="分钟"
            />
          </div>
          <div className="auto-field">
            <span>
              新区间半宽
              <InfoHint text="0 = 沿用原区间的宽度。填了就固定用这个 ±% 重开。" />
            </span>
            <Num
              value={cfg.rebalance.widthPct}
              onChange={(n) => patchRebalance({ widthPct: n })}
              step={1}
              suffix="%"
            />
          </div>
          <div className="auto-field">
            <span>冷却</span>
            <Num
              value={cfg.rebalance.cooldownMins}
              onChange={(n) => patchRebalance({ cooldownMins: n })}
              step={15}
              suffix="分钟"
            />
          </div>
          <div className="auto-note">目前只支持 V3 自动 Rebalance；V4 会跳过并记日志。</div>
        </div>

        {/* ── 安全阀 ── */}
        <div className="auto-card guards">
          <div className="auto-card-head">
            <span className="auto-card-title">安全阀</span>
          </div>
          <p className="auto-card-desc">任何一条不满足就整轮跳过，宁可不做也不乱做。</p>
          <div className="auto-field">
            <span>gas 上限</span>
            <Num
              value={cfg.guards.maxGasGwei}
              onChange={(n) => patchGuards({ maxGasGwei: n })}
              step={0.5}
              suffix="gwei"
            />
          </div>
          <div className="auto-field">
            <span>最低原生币余额</span>
            <Num
              value={cfg.guards.minEthBalance}
              onChange={(n) => patchGuards({ minEthBalance: n })}
              step={0.001}
              suffix="ETH"
              width={88}
            />
          </div>
          <div className="auto-field">
            <span>每日交易上限</span>
            <Num
              value={cfg.guards.maxTxPerDay}
              onChange={(n) => patchGuards({ maxTxPerDay: n })}
              step={1}
              suffix="笔"
            />
          </div>
          <div className="auto-field">
            <span>忽略小仓位</span>
            <Num
              value={cfg.guards.minPositionUsd}
              onChange={(n) => patchGuards({ minPositionUsd: n })}
              step={10}
              suffix="USD"
            />
          </div>
          <div className="auto-field">
            <span>检查间隔</span>
            <Num
              value={cfg.intervalSecs}
              onChange={(n) => patch({ intervalSecs: Math.max(60, n) })}
              step={30}
              min={60}
              suffix="秒"
            />
          </div>
        </div>
      </div>

      <div className="auto-toolbar">
        <button className="btn ghost sm" disabled={busy} onClick={onDryRun}>
          立即演算一次
        </button>
        <button className="btn sm" disabled={busy || cfg.dryRun} onClick={onRunNow}>
          立即执行一轮
        </button>
        {/*
         * 灰掉就得说为什么。开着演练模式时这个按钮永远点不动，
         * 而那个开关在面板最顶上、离这里大半屏，没人会自己把两件事连起来。
         */}
        {!busy && cfg.dryRun && (
          <span className="btn-reason">演练模式开着，不会真发交易</span>
        )}
        <button
          className="btn ghost sm"
          onClick={() => {
            setLog(loadAutoLog())
            setShowLog((v) => !v)
          }}
        >
          {showLog ? '收起日志' : `运行日志（${log.length}）`}
        </button>
        <button
          className="btn ghost sm danger"
          onClick={() => {
            resetAutoState()
            clearAutoLog()
            setLog([])
          }}
        >
          重置冷却与日志
        </button>
      </div>

      {plan && (
        <div className="auto-plan">
          {plan.blocked ? (
            <div className="auto-plan-blocked">整轮跳过：{plan.blocked}</div>
          ) : plan.actions.length === 0 ? (
            <div className="muted small">
              本轮无需操作
              {plan.gasGwei != null ? ` · gas ${plan.gasGwei.toFixed(2)} gwei` : ''}
            </div>
          ) : (
            <>
              <div className="auto-plan-head">
                计划 {plan.actions.length} 个动作
                {plan.gasGwei != null ? ` · gas ${plan.gasGwei.toFixed(2)} gwei` : ''}
              </div>
              {plan.actions.map((a, i) => (
                <div key={i} className="auto-plan-row">
                  <span className={`tag ${a.action}`}>
                    {a.action === 'compound' ? '复投' : 'Rebalance'}
                  </span>
                  <code>
                    {a.position.token0.symbol}/{a.position.token1.symbol} #
                    {a.position.tokenId.toString()}
                  </code>
                  <span className="muted small">{a.reason}</span>
                </div>
              ))}
            </>
          )}
          {plan.skips.length > 0 && (
            <details className="auto-skips">
              <summary>跳过 {plan.skips.length} 个仓位</summary>
              {plan.skips.map((s, i) => (
                <div key={i} className="auto-plan-row">
                  <code>
                    {s.position.token0.symbol}/{s.position.token1.symbol} #
                    {s.position.tokenId.toString()}
                  </code>
                  <span className="muted small">{s.reason}</span>
                </div>
              ))}
            </details>
          )}
        </div>
      )}

      {showLog && (
        <div className="auto-log">
          {log.length === 0 ? (
            <div className="muted small">还没有记录</div>
          ) : (
            log.map((e, i) => (
              <div key={i} className={`auto-log-row ${e.action}`}>
                <span className="muted small">{fmtTime(e.at)}</span>
                <span className={`tag ${e.action}`}>
                  {e.action === 'compound'
                    ? '复投'
                    : e.action === 'rebalance'
                      ? 'Rebalance'
                      : e.action === 'error'
                        ? '失败'
                        : '跳过'}
                </span>
                <code>
                  {e.pair} #{e.tokenId}
                </code>
                <span className="small">{e.detail}</span>
                {e.hash && (
                  <a href={explorerTx(e.hash)} target="_blank" rel="noreferrer" className="small">
                    浏览器 ↗
                  </a>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
