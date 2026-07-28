export type TxRecord = {
  id: string
  label: string
  hash: string
  at: number
  pair?: string
}

const KEY = 'rangedesk.txHistory.v1'
const MAX = 40

export function loadTxHistory(): TxRecord[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as TxRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function pushTxHistory(entry: Omit<TxRecord, 'id' | 'at'> & { at?: number }): TxRecord[] {
  const next: TxRecord = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: entry.at ?? Date.now(),
    label: entry.label,
    hash: entry.hash,
    pair: entry.pair,
  }
  const list = [next, ...loadTxHistory()].slice(0, MAX)
  localStorage.setItem(KEY, JSON.stringify(list))
  return list
}

export function clearTxHistory() {
  localStorage.removeItem(KEY)
}

/*
 * 相对时间。交易记录看的是「多久以前」，不是「几点几分」。
 *
 * 原来这一列直接渲染 toLocaleString()，出来是 2026/7/27 02:56:00 —— 想知道这笔是刚发的
 * 还是前天的，得先看一眼系统时间再心算。日志类列表里绝对时间是查证用的次要信息，
 * 放到 title 里（见调用处），列上只留一眼能读的量级。
 *
 * 一分钟内说「刚刚」：秒级精度对已上链的交易没有意义，跳秒还会让这一列不停抖动。
 */
export function relTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return '刚刚'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo} 个月前`
  return `${Math.floor(mo / 12)} 年前`
}
