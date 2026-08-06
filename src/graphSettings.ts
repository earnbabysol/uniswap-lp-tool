/** The Graph API Key（可选：加速 BSC 动向；无效时自动降级扫链） */
const GRAPH_KEY = 'rangedesk.theGraphApiKey.v1'

/** 去掉引号、Bearer、空白，避免粘贴格式导致 auth error */
function normalizeGraphKey(raw: string): string {
  let k = raw.trim()
  if (
    (k.startsWith('"') && k.endsWith('"'))
    || (k.startsWith("'") && k.endsWith("'"))
  ) {
    k = k.slice(1, -1).trim()
  }
  if (/^bearer\s+/i.test(k)) k = k.replace(/^bearer\s+/i, '').trim()
  // 偶发整段 URL 粘贴
  const m = k.match(/gateway\.thegraph\.com\/api\/([^/]+)\//i)
  if (m?.[1]) k = decodeURIComponent(m[1]).trim()
  return k
}

export function loadGraphApiKey(): string | null {
  try {
    const raw = localStorage.getItem(GRAPH_KEY)
    if (!raw) return null
    const k = normalizeGraphKey(raw)
    return k || null
  } catch {
    return null
  }
}

/** 空字符串清除 */
export function saveGraphApiKey(key: string): string | null {
  const trimmed = normalizeGraphKey(key)
  try {
    if (!trimmed) {
      localStorage.removeItem(GRAPH_KEY)
      return null
    }
    localStorage.setItem(GRAPH_KEY, trimmed)
    return trimmed
  } catch {
    throw new Error('无法保存 API Key（隐私模式？）')
  }
}

export function describeGraphApiKey(): string {
  const k = loadGraphApiKey()
  if (!k) return '未配置（可选）'
  if (k.length <= 10) return '已配置'
  return `已配置 · ${k.slice(0, 4)}…${k.slice(-4)}`
}
