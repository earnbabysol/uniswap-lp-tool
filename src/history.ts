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
