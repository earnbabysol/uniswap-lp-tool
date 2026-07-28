/**
 * 本地偏好设置：主题、刷新间隔、列表排序等。
 * 统一走 rangedesk.pref.* 命名空间，避免和 lp.ts 的缓存键冲突。
 */

import { useCallback, useEffect, useState } from 'react'

const PREFIX = 'rangedesk.pref.'

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw == null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writePref<T>(key: string, value: T) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    /* 隐私模式 / 配额满：忽略 */
  }
}

/** useState 但自动持久化到 localStorage */
export function usePersistentState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => readPref(key, fallback))
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        writePref(key, resolved)
        return resolved
      })
    },
    [key],
  )
  return [value, set] as const
}

export type ThemeMode = 'auto' | 'light' | 'dark'

const THEME_KEY = 'theme'

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'auto') return systemPrefersDark() ? 'dark' : 'light'
  return mode
}

function applyTheme(mode: ThemeMode) {
  const resolved = resolveTheme(mode)
  const root = document.documentElement
  root.dataset.theme = resolved
  root.style.colorScheme = resolved
}

/** 读取初始主题并立即应用，避免首屏闪白 */
/**
 * 默认深色而不是跟随系统：这套配色是照深色设计的，浅色是次要皮肤。
 * 用户显式切换过就一直尊重他的选择（写在 pref 里），auto 也仍然可选。
 */
export function initTheme(): ThemeMode {
  const mode = readPref<ThemeMode>(THEME_KEY, 'dark')
  applyTheme(mode)
  return mode
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => readPref<ThemeMode>(THEME_KEY, 'dark'))

  useEffect(() => {
    applyTheme(mode)
    writePref(THEME_KEY, mode)
  }, [mode])

  // auto 模式跟随系统切换
  useEffect(() => {
    if (mode !== 'auto') return
    let mq: MediaQueryList
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)')
    } catch {
      return
    }
    const onChange = () => applyTheme('auto')
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [mode])

  return [mode, setMode] as const
}
