/**
 * 本地私钥签名器。
 *
 * 安全边界（改动此文件前请先读完）：
 *  1. 私钥/助记词明文只存在于本模块的模块级闭包 SECRETS 里，永不进 React state、
 *     永不进 localStorage（除非用户显式设密码加密成 vault）、永不写 console、
 *     永不出现在任何 fetch/RPC 请求体里（只有签名后的 rawTx 会发出去）。
 *  2. UI 层只能拿到 KeyCandidate（id + address + 来源标签），拿不到明文。
 *  3. lock() 会把明文覆写并清空；页面刷新即丢失（vault 除外）。
 *  4. 加密 vault 用 WebCrypto PBKDF2-SHA256(600k) + AES-256-GCM，密码不落盘。
 *
 * 这是「热钱包」模型：浏览器里的私钥安全性天然低于硬件钱包/插件钱包。
 * 只建议放做 LP 的小额资金。UI 必须持续显示这个警告。
 */

import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts'
import type { Address, PrivateKeyAccount } from 'viem'
import type { HDAccount } from 'viem/accounts'

export type LocalAccount = PrivateKeyAccount | HDAccount

export type KeyKind = 'privateKey' | 'mnemonic'

/** 交给 UI 的候选项：只有可公开的信息 */
export type KeyCandidate = {
  id: string
  address: Address
  kind: KeyKind
  /** 来源说明，如「文件第 3 行」「JSON 字段 pk」 */
  source: string
  /** 助记词派生路径序号 */
  index?: number
}

type Secret = { kind: KeyKind; material: string; account: LocalAccount; addressIndex?: number }

/** 明文只在这里。不要 export，不要挂到 window。 */
const SECRETS = new Map<string, Secret>()

let candSeq = 1

let active: { id: string; address: Address; kind: KeyKind } | null = null

/** 解锁状态变化订阅（UI 用） */
type Listener = () => void
const listeners = new Set<Listener>()

export function subscribeSigner(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit() {
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      /* ignore */
    }
  }
}

const HEX64 = /^(0x)?[0-9a-fA-F]{64}$/

function normalizePk(raw: string): `0x${string}` | null {
  const t = raw.trim().replace(/^["']|["']$/g, '')
  if (!HEX64.test(t)) return null
  const hex = t.startsWith('0x') ? t.slice(2) : t
  // 全 0 / 超出 secp256k1 阶的私钥无效
  if (/^0+$/.test(hex)) return null
  return `0x${hex.toLowerCase()}` as `0x${string}`
}

function looksLikeMnemonic(raw: string): boolean {
  const words = raw.trim().toLowerCase().split(/\s+/)
  if (![12, 15, 18, 21, 24].includes(words.length)) return false
  return words.every((w) => /^[a-z]{3,8}$/.test(w))
}

/** 把明文字符串抹掉（尽力而为：JS 字符串不可变，只能解引用） */
function wipe(s: Secret) {
  // 覆写引用，交给 GC；无法真正抹掉 JS 字符串内存
  s.material = ''
}

/**
 * 解析私钥文件/粘贴内容，返回候选账户列表。
 * 支持：
 *  - 纯 hex（一行或多行，带不带 0x 都行）
 *  - dotenv：PRIVATE_KEY=0x…  / PK=…
 *  - JSON：{"privateKey":"0x…"} / {"pk":…} / {"key":…} / 数组
 *  - BIP39 助记词（默认派生前 5 个地址）
 * 注意：不支持 geth keystore（需要 scrypt + 密码，本工具不做）。
 */
export function parseKeyMaterial(text: string, opts?: { mnemonicCount?: number }): KeyCandidate[] {
  const out: KeyCandidate[] = []
  const seen = new Set<string>()
  const mnemonicCount = Math.max(1, Math.min(20, opts?.mnemonicCount ?? 5))

  const addPk = (raw: string, source: string) => {
    const pk = normalizePk(raw)
    if (!pk) return
    if (seen.has(pk)) return
    let account: PrivateKeyAccount
    try {
      account = privateKeyToAccount(pk)
    } catch {
      return
    }
    seen.add(pk)
    const id = `k${candSeq++}`
    SECRETS.set(id, { kind: 'privateKey', material: pk, account })
    out.push({ id, address: account.address, kind: 'privateKey', source })
  }

  const addMnemonic = (phrase: string, source: string) => {
    const norm = phrase.trim().toLowerCase().replace(/\s+/g, ' ')
    if (seen.has(norm)) return
    seen.add(norm)
    for (let i = 0; i < mnemonicCount; i++) {
      let account: HDAccount
      try {
        account = mnemonicToAccount(norm, { addressIndex: i })
      } catch {
        return
      }
      const id = `k${candSeq++}`
      SECRETS.set(id, { kind: 'mnemonic', material: norm, account, addressIndex: i })
      out.push({
        id,
        address: account.address,
        kind: 'mnemonic',
        source: `${source} · m/44'/60'/0'/0/${i}`,
        index: i,
      })
    }
  }

  const trimmed = text.trim()

  // 1) 整体是 JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const json: unknown = JSON.parse(trimmed)
      const visit = (node: unknown, path: string) => {
        if (typeof node === 'string') {
          if (normalizePk(node)) addPk(node, `JSON ${path}`)
          else if (looksLikeMnemonic(node)) addMnemonic(node, `JSON ${path}`)
          return
        }
        if (Array.isArray(node)) {
          node.forEach((v, i) => visit(v, `${path}[${i}]`))
          return
        }
        if (node && typeof node === 'object') {
          for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            visit(v, path ? `${path}.${k}` : k)
          }
        }
      }
      visit(json, '')
      if (out.length) return out
    } catch {
      /* 不是合法 JSON，继续按文本解析 */
    }
  }

  // 2) 按行解析
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    const raw = line.trim()
    if (!raw || raw.startsWith('#') || raw.startsWith('//')) return
    const eq = raw.indexOf('=')
    const value = eq >= 0 ? raw.slice(eq + 1).trim() : raw
    const nameHint = eq >= 0 ? raw.slice(0, eq).trim() : ''
    const label = nameHint ? `字段 ${nameHint}` : `第 ${i + 1} 行`
    if (normalizePk(value)) {
      addPk(value, label)
      return
    }
    if (looksLikeMnemonic(value)) addMnemonic(value, label)
  })

  // 3) 整体当成助记词（多行折行的情况）
  if (!out.length && looksLikeMnemonic(trimmed.replace(/\s+/g, ' '))) {
    addMnemonic(trimmed.replace(/\s+/g, ' '), '助记词')
  }

  return out
}

/** 丢弃所有未选中的候选明文（选完账户后立刻调用，缩小暴露面） */
export function dropCandidates(keepId?: string) {
  for (const [id, s] of SECRETS) {
    if (id === keepId) continue
    wipe(s)
    SECRETS.delete(id)
  }
}

export function selectCandidate(id: string): { address: Address; kind: KeyKind } {
  const s = SECRETS.get(id)
  if (!s) throw new Error('候选私钥已失效，请重新加载')
  dropCandidates(id)
  active = { id, address: s.account.address, kind: s.kind }
  emit()
  return { address: s.account.address, kind: s.kind }
}

/** 取当前解锁的 viem Account；只给 wallet.ts 用来建 walletClient */
export function getActiveAccount(): LocalAccount | null {
  if (!active) return null
  return SECRETS.get(active.id)?.account ?? null
}

export function getActiveLocal(): { address: Address; kind: KeyKind } | null {
  return active ? { address: active.address, kind: active.kind } : null
}

export function isUnlocked(): boolean {
  return active != null && SECRETS.has(active.id)
}

export function lock() {
  for (const [, s] of SECRETS) wipe(s)
  SECRETS.clear()
  active = null
  stopAutoLock()
  emit()
}

/* ───────────────────────── 自动锁定 ───────────────────────── */

let autoLockTimer: ReturnType<typeof setTimeout> | null = null
let autoLockMs = 0
let onAutoLock: (() => void) | null = null

function stopAutoLock() {
  if (autoLockTimer != null) {
    clearTimeout(autoLockTimer)
    autoLockTimer = null
  }
}

/** 无操作 N 分钟后自动 lock()；0 = 关闭 */
export function configureAutoLock(minutes: number, cb?: () => void) {
  autoLockMs = Math.max(0, minutes) * 60_000
  onAutoLock = cb ?? null
  touchAutoLock()
}

export function touchAutoLock() {
  stopAutoLock()
  if (!autoLockMs || !isUnlocked()) return
  autoLockTimer = setTimeout(() => {
    lock()
    onAutoLock?.()
  }, autoLockMs)
}

/* ───────────────────────── 加密保险箱（可选） ───────────────────────── */

const VAULT_KEY = 'rangedesk.vault.v1'
const PBKDF2_ITER = 600_000

export type VaultEntry = {
  address: Address
  kind: KeyKind
  label: string
  savedAt: number
  /** base64 */
  salt: string
  iv: string
  data: string
}

export function cryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle
}

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function unb64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export function listVault(): VaultEntry[] {
  try {
    const raw = localStorage.getItem(VAULT_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as VaultEntry[]) : []
  } catch {
    return []
  }
}

function writeVault(list: VaultEntry[]) {
  try {
    localStorage.setItem(VAULT_KEY, JSON.stringify(list))
  } catch {
    throw new Error('无法写入本地存储（隐私模式或空间不足）')
  }
}

/** 把当前解锁的私钥加密存起来。密码不保存，忘了只能删。 */
export async function saveActiveToVault(password: string, label: string): Promise<VaultEntry> {
  if (!cryptoAvailable()) throw new Error('当前环境不支持 WebCrypto，无法加密保存（需 https 或 localhost）')
  if (!active) throw new Error('尚未解锁私钥')
  if (password.length < 8) throw new Error('密码至少 8 位')
  const s = SECRETS.get(active.id)
  if (!s) throw new Error('私钥已失效')

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt)
  const payload = JSON.stringify({
    kind: s.kind,
    material: s.material,
    addressIndex: s.addressIndex,
  })
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(payload),
  )
  const entry: VaultEntry = {
    address: s.account.address,
    kind: s.kind,
    label: label.trim() || `账户 ${s.account.address.slice(0, 6)}`,
    savedAt: Date.now(),
    salt: b64(salt),
    iv: b64(iv),
    data: b64(cipher),
  }
  const list = listVault().filter((e) => e.address.toLowerCase() !== entry.address.toLowerCase())
  list.push(entry)
  writeVault(list)
  return entry
}

/** 用密码解开 vault 条目并解锁（成功后立即可签名） */
export async function unlockFromVault(
  address: Address,
  password: string,
): Promise<{ address: Address; kind: KeyKind }> {
  if (!cryptoAvailable()) throw new Error('当前环境不支持 WebCrypto')
  const entry = listVault().find((e) => e.address.toLowerCase() === address.toLowerCase())
  if (!entry) throw new Error('未找到该账户的加密备份')
  const key = await deriveKey(password, unb64(entry.salt))
  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(entry.iv) as unknown as BufferSource },
      key,
      unb64(entry.data) as unknown as BufferSource,
    )
  } catch {
    throw new Error('密码错误或数据已损坏')
  }
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as {
    kind: KeyKind
    material: string
    addressIndex?: number
  }
  // 助记词要派生到存的那个 index 才能对上地址，多派生几个兜底
  const count = parsed.kind === 'mnemonic' ? Math.max(1, (parsed.addressIndex ?? 0) + 1) : 1
  const cands = parseKeyMaterial(parsed.material, { mnemonicCount: count })
  const hit = cands.find((c) => c.address.toLowerCase() === address.toLowerCase())
  if (!hit) throw new Error('备份内容与地址不匹配，请删除后重新导入')
  return selectCandidate(hit.id)
}

export function removeFromVault(address: Address) {
  writeVault(listVault().filter((e) => e.address.toLowerCase() !== address.toLowerCase()))
}

export function clearVault() {
  try {
    localStorage.removeItem(VAULT_KEY)
  } catch {
    /* ignore */
  }
}
