/**
 * 通用 UI 原件：Toast 通知栈、确认弹窗、骨架屏。
 * 目的：把「一行 status 覆盖式提示」换成可堆叠、可追溯的反馈。
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

export type ToastKind = 'info' | 'pending' | 'success' | 'error'

export type Toast = {
  id: number
  kind: ToastKind
  title: string
  detail?: string
  /** 交易哈希对应的浏览器链接 */
  href?: string
  /** pending 不自动消失 */
  sticky?: boolean
}

let toastSeq = 1

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const t = timers.current.get(id)
    if (t) {
      clearTimeout(t)
      timers.current.delete(id)
    }
  }, [])

  const schedule = useCallback(
    (id: number, ms: number) => {
      const existing = timers.current.get(id)
      if (existing) clearTimeout(existing)
      timers.current.set(
        id,
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id))
          timers.current.delete(id)
        }, ms),
      )
    },
    [],
  )

  /** 新建一条通知，返回 id 供后续 update */
  const push = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = toastSeq++
      setToasts((prev) => {
        const next = [...prev, { ...t, id }]
        if (next.length <= 6) return next
        // 优先丢掉已结束的旧通知，尽量保留 pending，避免「进行中」被挤掉后无法 update
        const dropIdx = next.findIndex((x) => x.kind !== 'pending')
        if (dropIdx >= 0) {
          next.splice(dropIdx, 1)
          return next
        }
        return next.slice(-6)
      })
      if (!t.sticky && t.kind !== 'pending') schedule(id, t.kind === 'error' ? 9000 : 5000)
      return id
    },
    [schedule],
  )

  /**
   * 就地更新（pending → success/error）。
   * 若该 id 已被挤出栈，返回 false，调用方应再 push 一条，避免永久停在「进行中…」。
   */
  const update = useCallback(
    (id: number, patch: Partial<Omit<Toast, 'id'>>): boolean => {
      let found = false
      setToasts((prev) => {
        found = prev.some((t) => t.id === id)
        if (!found) return prev
        return prev.map((t) => (t.id === id ? { ...t, ...patch } : t))
      })
      const kind = patch.kind
      if (found && kind && kind !== 'pending' && !patch.sticky) {
        schedule(id, kind === 'error' ? 9000 : 5000)
      }
      return found
    },
    [schedule],
  )

  useEffect(
    () => () => {
      for (const t of timers.current.values()) clearTimeout(t)
      timers.current.clear()
    },
    [],
  )

  return { toasts, push, update, dismiss }
}

const KIND_ICON: Record<ToastKind, string> = {
  info: 'i',
  pending: '',
  success: '✓',
  error: '!',
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[]
  onDismiss: (id: number) => void
}) {
  if (!toasts.length) return null
  return (
    <div className="toast-stack" role="region" aria-label="通知" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="toast-icon" aria-hidden>
            {t.kind === 'pending' ? <i className="toast-spin" /> : KIND_ICON[t.kind]}
          </span>
          <div className="toast-body">
            <strong className="toast-title">{t.title}</strong>
            {t.detail && <span className="toast-detail">{t.detail}</span>}
            {t.href && (
              <a className="toast-link" href={t.href} target="_blank" rel="noreferrer">
                查看交易 ↗
              </a>
            )}
          </div>
          <button
            type="button"
            className="toast-close"
            aria-label="关闭通知"
            onClick={() => onDismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

export type ConfirmRequest = {
  title: string
  /** 分行展示的说明 */
  lines?: string[]
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
}

/** 替代 window.confirm：可展示结构化明细，支持 Esc / Enter */
export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest | null
  onClose: () => void
}) {
  const okRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!request) return
    okRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        request.onConfirm()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, onClose])

  if (!request) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal-title">{request.title}</h3>
        {request.lines?.length ? (
          <ul className="modal-lines">
            {request.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            {request.cancelLabel ?? '取消'}
          </button>
          <button
            ref={okRef}
            type="button"
            className={`btn ${request.danger ? 'danger' : 'primary'}`}
            onClick={() => {
              request.onConfirm()
              onClose()
            }}
          >
            {request.confirmLabel ?? '确认'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function PositionSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="pos-grid" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div className="pos-card skeleton" key={i}>
          <div className="sk-line w40" />
          <div className="sk-line w70 tall" />
          <div className="sk-line w50" />
          <div className="sk-bar" />
          <div className="sk-line w60" />
          <div className="sk-block" />
        </div>
      ))}
    </div>
  )
}

/** 小型信息气泡，用于解释 APR / 风险等口径 */
export function InfoHint({ text, children }: { text: string; children?: ReactNode }) {
  const id = useId()
  return (
    <span className="info-hint" tabIndex={0} aria-describedby={id}>
      {children ?? <span className="info-hint-mark" aria-hidden>?</span>}
      <span className="info-hint-pop" role="tooltip" id={id}>
        {text}
      </span>
    </span>
  )
}
