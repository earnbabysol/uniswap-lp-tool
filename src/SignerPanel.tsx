/**
 * 本地私钥面板。UI 层只拿得到 KeyCandidate（地址 + 来源标签），拿不到明文。
 * 明文的生命周期全部由 signer.ts 管理，见那边的文件头注释。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import {
  clearVault,
  configureAutoLock,
  cryptoAvailable,
  dropCandidates,
  listVault,
  lock,
  parseKeyMaterial,
  removeFromVault,
  saveActiveToVault,
  selectCandidate,
  unlockFromVault,
  type KeyCandidate,
  type VaultEntry,
} from './signer'
import { shortAddr } from './wallet'
import { InfoHint } from './ui'

type Props = {
  /** 当前已解锁的本地地址 */
  active: Address | null
  /** 插件钱包是否已连接（互斥提示用） */
  walletConnected: boolean
  onUnlocked: (address: Address) => void
  onLocked: () => void
  onError: (msg: string) => void
  autoLockMins: number
  onAutoLockMins: (n: number) => void
}

const AUTOLOCK_OPTIONS = [0, 5, 15, 30, 60] as const

export function SignerPanel({
  active,
  walletConnected,
  onUnlocked,
  onLocked,
  onError,
  autoLockMins,
  onAutoLockMins,
}: Props) {
  const [text, setText] = useState('')
  const [cands, setCands] = useState<KeyCandidate[]>([])
  const [vault, setVault] = useState<VaultEntry[]>(() => (cryptoAvailable() ? listVault() : []))
  const [pw, setPw] = useState('')
  const [pwTarget, setPwTarget] = useState<Address | 'save' | null>(null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    configureAutoLock(autoLockMins, () => onLocked())
  }, [autoLockMins, onLocked])

  // 插件钱包一连上，就把待选的候选和输入框里的明文都丢掉，别留在内存里等着被点
  useEffect(() => {
    if (!walletConnected) return
    dropCandidates()
    setCands([])
    setText('')
    setPw('')
    setPwTarget(null)
  }, [walletConnected])

  const refreshVault = useCallback(() => {
    setVault(cryptoAvailable() ? listVault() : [])
  }, [])

  const pick = useCallback(
    (c: KeyCandidate) => {
      // 互斥兜底：解析完候选后用户又去顶栏连了插件钱包，这里必须拦住
      if (walletConnected) {
        onError('已连接插件钱包，请先断开再用本地私钥')
        return
      }
      try {
        const r = selectCandidate(c.id)
        setCands([])
        setText('')
        onUnlocked(r.address)
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e))
      }
    },
    [onError, onUnlocked, walletConnected],
  )

  const parse = useCallback(
    (raw: string, sourceHint?: string) => {
      const trimmed = raw.trim()
      if (!trimmed) return
      try {
        const found = parseKeyMaterial(trimmed, { mnemonicCount: 5 })
        if (!found.length) {
          onError('没识别出私钥或助记词。支持裸 hex / .env / JSON / BIP39 助记词')
          return
        }
        setCands(
          sourceHint ? found.map((c) => ({ ...c, source: `${sourceHint} · ${c.source}` })) : found,
        )
        // 只有一个就直接选中，省一步点击
        if (found.length === 1) pick(found[0])
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e))
      }
    },
    [onError, pick],
  )

  const onFile = useCallback(
    async (f: File | null | undefined) => {
      if (!f) return
      if (f.size > 512 * 1024) {
        onError('文件太大（> 512KB），大概不是密钥文件')
        return
      }
      try {
        const raw = await f.text()
        parse(raw, f.name)
      } catch {
        onError('读取文件失败')
      }
    },
    [onError, parse],
  )

  const doLock = useCallback(() => {
    lock()
    dropCandidates()
    setCands([])
    setText('')
    setPw('')
    setPwTarget(null)
    onLocked()
  }, [onLocked])

  const doSave = useCallback(async () => {
    if (!pw) return
    setBusy(true)
    try {
      await saveActiveToVault(pw, label.trim() || '本地钱包')
      setPw('')
      setLabel('')
      setPwTarget(null)
      refreshVault()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [pw, label, onError, refreshVault])

  const doUnlockVault = useCallback(
    async (addr: Address) => {
      if (!pw) return
      if (walletConnected) {
        onError('已连接插件钱包，请先断开再用本地私钥')
        return
      }
      setBusy(true)
      try {
        const r = await unlockFromVault(addr, pw)
        setPw('')
        setPwTarget(null)
        onUnlocked(r.address)
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [pw, onError, onUnlocked, walletConnected],
  )

  const secure = cryptoAvailable()

  return (
    <div className="signer-panel">
      <div className="signer-warn">
        <strong>热钱包风险</strong>
        私钥放在浏览器里，安全性低于硬件钱包和插件钱包。只导入你愿意承担损失的小额地址，
        别用主钱包。明文只存在内存里，刷新即丢；加密备份需要你自己设密码。
      </div>

      {active ? (
        // 解锁态原来是三个平级兄弟（地址行 + 自动锁定 chips + 加密保存按钮），
        // 外层 .panel 去掉后它们直接散在页面底色上，看着像三条没归属的浮动控件。
        // 收进一个容器里 —— 它们本来就是同一件事：这条签名通道的当前状态和设置。
        <div className="signer-live">
          <div className="signer-active">
            <span className="dot-live" />
            <div className="signer-active-main">
              <code>{shortAddr(active)}</code>
              <span className="muted">本地私钥已解锁，交易本地签名后直接广播</span>
            </div>
            <button className="btn ghost sm" onClick={doLock}>
              锁定
            </button>
          </div>

          <div className="signer-row">
            <label className="signer-label">
              闲置自动锁定
              <InfoHint text="超过这个时间没有任何操作就清空内存里的私钥。0 = 不自动锁定。" />
            </label>
            <div className="chip-row">
              {AUTOLOCK_OPTIONS.map((m) => (
                <button
                  key={m}
                  className={`chip ${autoLockMins === m ? 'on' : ''}`}
                  onClick={() => onAutoLockMins(m)}
                >
                  {m === 0 ? '关闭' : `${m} 分钟`}
                </button>
              ))}
            </div>
          </div>

          {secure && (
            <div className="signer-row">
              {pwTarget === 'save' ? (
                <div className="signer-pw">
                  <input
                    className="input"
                    placeholder="备注名"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                  <input
                    className="input"
                    type="password"
                    placeholder="加密密码（至少 8 位）"
                    value={pw}
                    onChange={(e) => setPw(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && doSave()}
                  />
                  <button className="btn sm" disabled={busy || pw.length < 8} onClick={doSave}>
                    加密保存
                  </button>
                  <button className="btn ghost sm" onClick={() => (setPwTarget(null), setPw(''))}>
                    取消
                  </button>
                </div>
              ) : (
                <button className="btn ghost sm" onClick={() => setPwTarget('save')}>
                  加密保存到本机（下次输密码即可解锁）
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          {walletConnected && (
            <div className="signer-lockout">
              已连接插件钱包。要用本地私钥，请先断开钱包 —— 两者不能同时使用。
            </div>
          )}

          <div className={`signer-input ${walletConnected ? 'disabled' : ''}`}>
            <textarea
              className="input mono"
              rows={3}
              placeholder={'粘贴私钥 0x… / 助记词 / .env 内容 / JSON，或拖入密钥文件'}
              value={text}
              disabled={walletConnected}
              onChange={(e) => setText(e.target.value)}
              onDrop={(e) => {
                e.preventDefault()
                const f = e.dataTransfer?.files?.[0]
                if (f) void onFile(f)
              }}
              onDragOver={(e) => e.preventDefault()}
              spellCheck={false}
              autoComplete="off"
            />
            <div className="signer-actions">
              <button
                className="btn sm"
                disabled={walletConnected || !text.trim()}
                onClick={() => parse(text)}
              >
                解析
              </button>
              <button
                className="btn ghost sm"
                disabled={walletConnected}
                onClick={() => fileRef.current?.click()}
              >
                选择文件
              </button>
              <input
                ref={fileRef}
                type="file"
                hidden
                accept=".txt,.env,.json,.key,text/*,application/json"
                onChange={(e) => {
                  void onFile(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
              {text && (
                <button className="btn ghost sm" onClick={() => (setText(''), setCands([]))}>
                  清空
                </button>
              )}
            </div>
            <div className="signer-formats">
              支持：裸私钥（可多行）· PRIVATE_KEY=0x… · JSON 任意字段 · BIP39 助记词（派生前 5 个地址）。
              不支持 geth keystore（需要 scrypt 解密）。
            </div>
          </div>

          {cands.length > 0 && (
            <div className="signer-cands">
              <div className="signer-cands-head">识别到 {cands.length} 个地址，选一个使用</div>
              {cands.map((c) => (
                <button key={c.id} className="signer-cand" onClick={() => pick(c)}>
                  <code>{shortAddr(c.address)}</code>
                  <span className="tag">{c.kind === 'mnemonic' ? '助记词' : '私钥'}</span>
                  <span className="muted small">{c.source}</span>
                </button>
              ))}
            </div>
          )}

          {vault.length > 0 && (
            <div className="signer-vault">
              <div className="signer-cands-head">本机加密备份</div>
              {vault.map((v) => (
                <div key={v.address} className="signer-vault-row">
                  <code>{shortAddr(v.address)}</code>
                  <span className="muted small">{v.label}</span>
                  {pwTarget === v.address ? (
                    <div className="signer-pw inline">
                      <input
                        className="input"
                        type="password"
                        placeholder="密码"
                        value={pw}
                        autoFocus
                        onChange={(e) => setPw(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && doUnlockVault(v.address)}
                      />
                      <button
                        className="btn sm"
                        disabled={busy || !pw}
                        onClick={() => doUnlockVault(v.address)}
                      >
                        解锁
                      </button>
                      <button className="btn ghost sm" onClick={() => (setPwTarget(null), setPw(''))}>
                        取消
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        className="btn ghost sm"
                        disabled={walletConnected}
                        onClick={() => setPwTarget(v.address)}
                      >
                        解锁
                      </button>
                      <button
                        className="btn ghost sm danger"
                        onClick={() => {
                          removeFromVault(v.address)
                          refreshVault()
                        }}
                      >
                        删除
                      </button>
                    </>
                  )}
                </div>
              ))}
              <button
                className="btn ghost sm danger"
                onClick={() => {
                  clearVault()
                  refreshVault()
                }}
              >
                清空全部备份
              </button>
            </div>
          )}

          {!secure && (
            <div className="signer-lockout">
              当前不是安全上下文（需要 https 或 localhost），加密备份不可用。
            </div>
          )}
        </>
      )}
    </div>
  )
}
