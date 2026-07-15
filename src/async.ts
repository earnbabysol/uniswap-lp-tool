/** Promise 超时包装；用于刷新/索引，避免 RPC 挂死拖住 UI */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时 (${Math.round(ms / 1000)}s)`)), ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export async function fetchJson<T>(url: string, ms = 12_000): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}
