import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Address } from 'viem'
import { isAddress } from 'viem'
import { resolveTokenMeta } from './lp'
import { shortAddr } from './wallet'

export type TokenOption = {
  addr: Address
  symbol: string
  decimals: number
}

type TokenPickerProps = {
  label: string
  hint?: string
  value: Address
  options: TokenOption[]
  disabled?: boolean
  onChange: (addr: Address, meta?: TokenOption) => void
}

const CUSTOM = '__custom__'

export function TokenPicker({ label, hint, value, options, disabled, onChange }: TokenPickerProps) {
  const matched = useMemo(
    () => options.find((o) => o.addr.toLowerCase() === value?.toLowerCase()),
    [options, value],
  )
  const inList = Boolean(matched)
  const [mode, setMode] = useState<'list' | 'custom'>(inList ? 'list' : 'custom')
  const [custom, setCustom] = useState(inList ? '' : value || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [resolved, setResolved] = useState<{ symbol: string; decimals: number } | null>(
    matched ? { symbol: matched.symbol, decimals: matched.decimals } : null,
  )

  useEffect(() => {
    if (inList && matched) {
      setMode('list')
      setCustom('')
      setErr(null)
      setResolved({ symbol: matched.symbol, decimals: matched.decimals })
    }
  }, [inList, matched, value])

  const selectValue = inList && mode === 'list' ? (matched?.addr ?? value) : CUSTOM

  const applyCustom = async () => {
    const raw = custom.trim()
    if (!isAddress(raw)) {
      setErr('请输入有效合约地址')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const meta = await resolveTokenMeta(raw as Address)
      const opt: TokenOption = {
        addr: raw as Address,
        symbol: meta.symbol,
        decimals: meta.decimals,
      }
      setResolved({ symbol: meta.symbol, decimals: meta.decimals })
      onChange(raw as Address, opt)
      setMode('custom')
    } catch (e) {
      setErr(e instanceof Error ? e.message : '解析代币失败')
    } finally {
      setBusy(false)
    }
  }

  const displaySym = matched?.symbol ?? resolved?.symbol

  return (
    <label className="token-picker">
      <span className="lbl">
        {label}
        {hint && <span className="token-picker-hint">{hint}</span>}
      </span>
      <select
        disabled={disabled}
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value
          if (v === CUSTOM) {
            setMode('custom')
            return
          }
          setMode('list')
          setErr(null)
          const opt = options.find((o) => o.addr === v)
          if (opt) setResolved({ symbol: opt.symbol, decimals: opt.decimals })
          onChange(v as Address, opt)
        }}
      >
        {options.map((t) => (
          <option key={t.addr} value={t.addr}>{t.symbol}</option>
        ))}
        <option value={CUSTOM}>自定义合约…</option>
      </select>
      {(mode === 'custom' || !inList) && (
        <Row className="token-picker-custom">
          <input
            disabled={disabled || busy}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="0x… 粘贴代币合约"
            spellCheck={false}
          />
          <button type="button" className="btn tight" disabled={disabled || busy} onClick={() => void applyCustom()}>
            {busy ? '解析中…' : '确认'}
          </button>
        </Row>
      )}
      {value && isAddress(value) && displaySym && (
        <span className="token-picker-resolved muted">
          {displaySym} · {shortAddr(value)}
        </span>
      )}
      {err && <span className="token-picker-err">{err}</span>}
    </label>
  )
}

function Row({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={className}>{children}</div>
}
