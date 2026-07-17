import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Address, WalletClient } from 'viem'
import { isAddress } from 'viem'
import {
  CONTRACTS,
  FEE_TIERS,
  V4_FEE_PRESETS,
  KNOWN_TOKENS,
  SUPPORTED_CHAINS,
  getActiveChainConfig,
  getActiveChainId,
  listKnownTokens,
  type SupportedChainId,
} from './chain'
import {
  claimV3,
  claimV4,
  createV3PoolAndSeed,
  createV4PoolAndSeed,
  describeFullRange,
  describeRange,
  findV3Pool,
  findV4Pool,
  formatAmount,
  getErc20Balance,
  getNativeBalance,
  increaseV3Liquidity,
  increaseV4Liquidity,
  isEthLikeCurrency,
  isNativeCurrency,
  loadPoolFromInput,
  loadV3Pool,
  loadV4Pool,
  burnVacantV3Nfts,
  listVacantV3TokenIds,
  loadV3Positions,
  loadV4Positions,
  enrichPositionsLifetimeFees,
  mintV3Position,
  mintV4Position,
  pairHasWeth,
  removeV3Liquidity,
  removeV4Liquidity,
  resolveTokenMeta,
  scanV3Pools,
  scanV4Pools,
  ticksFromCoinPrices,
  getCoinQuote,
  getPositionCoinPrices,
  oneSidedEthPercents,
  suggestV4TickSpacing,
  unwrapWeth,
  wrapEth,
  type PoolInfo,
  type PositionRow,
} from './lp'
import { parseAmount, formatPrice, formatUsd, pairAmountForRange, formatAmountExact, priceToClosestTick, priceToSqrtPriceX96, tickToPrice } from './math'
import { withTimeout } from './async'
import {
  connectWallet,
  ensureActiveChain,
  explorerAddress,
  explorerTx,
  makeWalletClient,
  refreshPublicClient,
  shortAddr,
  switchAppChain,
} from './wallet'
import {
  defaultRpcUrl,
  describeActiveRpc,
  loadCustomRpcUrl,
  saveCustomRpcUrl,
  testRpcLatency,
} from './rpcSettings'
import { clearTxHistory, loadTxHistory, pushTxHistory, type TxRecord } from './history'
import './App.css'

type SortKey = 'value' | 'fees' | 'pnl' | 'pair'
type FilterKey = 'all' | 'in' | 'out' | 'v3' | 'v4'
type RangeMode = 'percent' | 'custom' | 'full'

function formatPnl(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) > 1e11) return '—'
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  const abs = Math.abs(n)
  return `${sign}US$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function extractHash(r: unknown): string | null {
  if (typeof r === 'string' && r.startsWith('0x') && r.length === 66) return r
  if (r && typeof r === 'object') {
    if ('hash' in r && typeof (r as { hash: unknown }).hash === 'string') return (r as { hash: string }).hash
    if ('exitHash' in r && typeof (r as { exitHash: unknown }).exitHash === 'string') return (r as { exitHash: string }).exitHash
    if ('mintHash' in r && typeof (r as { mintHash: unknown }).mintHash === 'string') return (r as { mintHash: string }).mintHash
  }
  return null
}

function copyText(text: string) {
  void navigator.clipboard?.writeText(text)
}

function applyDefaultCoinRange(
  info: PoolInfo,
  setLo: (v: string) => void,
  setHi: (v: string) => void,
) {
  const q = getCoinQuote(info)
  if (!(q.spot > 0)) return
  setLo(formatPrice(q.spot * 0.95))
  setHi(formatPrice(q.spot * 1.05))
}

/** 允许清空、中间态的数字输入，避免 number 框删不干净 */
function SoftNumberInput(props: {
  value: number
  onCommit: (n: number) => void
  min?: number
  max?: number
  disabled?: boolean
}) {
  const { value, onCommit, min, max, disabled } = props
  const [text, setText] = useState(() => String(value))
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) setText(String(value))
  }, [value, focused])

  const clamp = (n: number) => {
    let v = n
    if (min != null) v = Math.max(min, v)
    if (max != null) v = Math.min(max, v)
    return v
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      disabled={disabled}
      value={text}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        const raw = e.target.value
        if (raw === '' || raw === '-' || raw === '.' || raw === '-.' || /^-?\d*\.?\d*$/.test(raw)) {
          setText(raw)
          if (raw !== '' && raw !== '-' && raw !== '.' && raw !== '-.' && Number.isFinite(Number(raw))) {
            onCommit(clamp(Number(raw)))
          }
        }
      }}
      onBlur={() => {
        setFocused(false)
        if (text === '' || text === '-' || text === '.' || text === '-.') {
          setText(String(value))
          return
        }
        const n = Number(text)
        if (!Number.isFinite(n)) {
          setText(String(value))
          return
        }
        const c = clamp(n)
        onCommit(c)
        setText(String(c))
      }}
    />
  )
}

export default function App() {
  const [address, setAddress] = useState<Address | null>(null)
  const [wallet, setWallet] = useState<WalletClient | null>(null)
  const [status, setStatus] = useState('')
  const [statusHash, setStatusHash] = useState<string | null>(null)
  const [refreshStatus, setRefreshStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null)
  const [ethBal, setEthBal] = useState<bigint>(0n)
  const [wethBal, setWethBal] = useState<bigint>(0n)

  const [tab, setTab] = useState<'positions' | 'mint' | 'tools' | 'history'>('positions')
  const [positions, setPositions] = useState<PositionRow[]>([])
  const [percentLower, setPercentLower] = useState(-5)
  const [percentUp, setPercentUp] = useState(5)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [slippageBps, setSlippageBps] = useState(300)
  const [sortKey, setSortKey] = useState<SortKey>('value')
  const [filterKey, setFilterKey] = useState<FilterKey>('all')
  const [removePct, setRemovePct] = useState(100)
  const [add0, setAdd0] = useState('')
  const [add1, setAdd1] = useState('')
  const [addBal0, setAddBal0] = useState<bigint>(0n)
  const [addBal1, setAddBal1] = useState<bigint>(0n)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [txHistory, setTxHistory] = useState<TxRecord[]>(() => loadTxHistory())
  const [rpcInput, setRpcInput] = useState(() => loadCustomRpcUrl() ?? '')
  const [activeRpcLabel, setActiveRpcLabel] = useState(() => describeActiveRpc())
  const [rpcLatency, setRpcLatency] = useState<number | null>(null)
  const [rpcBlock, setRpcBlock] = useState<bigint | null>(null)
  const [rpcBusy, setRpcBusy] = useState(false)
  const [chainId, setChainId] = useState<SupportedChainId>(() => getActiveChainId())
  const chainCfg = getActiveChainConfig()

  const [tokenA, setTokenA] = useState<Address>(() => getActiveChainConfig().defaultTokenA)
  const [tokenB, setTokenB] = useState<Address>(() => getActiveChainConfig().defaultTokenB)
  const [customToken, setCustomToken] = useState('')
  const [fee, setFee] = useState(500)
  const [pool, setPool] = useState<PoolInfo | null>(null)
  const [scannedPools, setScannedPools] = useState<PoolInfo[]>([])
  const [amount0, setAmount0] = useState('')
  const [amount1, setAmount1] = useState('')
  const [bal0, setBal0] = useState<bigint>(0n)
  const [bal1, setBal1] = useState<bigint>(0n)
  const [poolInput, setPoolInput] = useState('')
  const [rangeMode, setRangeMode] = useState<RangeMode>('percent')
  const [priceLo, setPriceLo] = useState('')
  const [priceHi, setPriceHi] = useState('')
  const [useNativeEth, setUseNativeEth] = useState(true)
  const [mintProtocol, setMintProtocol] = useState<'v3' | 'v4'>('v3')
  const [initPrice, setInitPrice] = useState('')
  const [showCreatePool, setShowCreatePool] = useState(false)
  const [v4TickSpacing, setV4TickSpacing] = useState(200)
  const [customFeeInput, setCustomFeeInput] = useState('')
  const [seedOnCreate, setSeedOnCreate] = useState(true)
  const [seedAmtA, setSeedAmtA] = useState('')
  const [seedAmtB, setSeedAmtB] = useState('')
  const [createSeedBalA, setCreateSeedBalA] = useState<bigint>(0n)
  const [createSeedBalB, setCreateSeedBalB] = useState<bigint>(0n)
  /** 创建时初仓区间预设 */
  const [createRangePreset, setCreateRangePreset] = useState<'onesided-eth' | 'full' | number>('onesided-eth')

  const [wrapAmt, setWrapAmt] = useState('')
  const [vacantV3Ids, setVacantV3Ids] = useState<bigint[] | null>(null)

  const tabRef = useRef(tab)
  useEffect(() => {
    tabRef.current = tab
  }, [tab])

  const selected = useMemo(
    () => positions.find((p) => `${p.version}-${p.tokenId}` === selectedId) ?? null,
    [positions, selectedId],
  )

  const summary = useMemo(() => {
    const totalUsd = positions.reduce((s, p) => s + p.totalUsd, 0)
    const feesUsd = positions.reduce((s, p) => s + p.totalFeesUsd, 0)
    const unclaimedUsd = positions.reduce((s, p) => s + p.fees0Usd + p.fees1Usd, 0)
    const claimedUsd = positions.reduce((s, p) => s + p.claimedFeesUsd, 0)
    const pnlUsd = positions.reduce((s, p) => s + p.pnlUsd, 0)
    const inRange = positions.filter((p) => p.inRange).length
    return { totalUsd, feesUsd, unclaimedUsd, claimedUsd, pnlUsd, inRange, n: positions.length }
  }, [positions])

  const filteredPositions = useMemo(() => {
    let list = [...positions]
    if (filterKey === 'in') list = list.filter((p) => p.inRange)
    if (filterKey === 'out') list = list.filter((p) => !p.inRange)
    if (filterKey === 'v3') list = list.filter((p) => p.version === 'v3')
    if (filterKey === 'v4') list = list.filter((p) => p.version === 'v4')
    list.sort((a, b) => {
      if (sortKey === 'fees') return b.totalFeesUsd - a.totalFeesUsd
      if (sortKey === 'pnl') return b.pnlUsd - a.pnlUsd
      if (sortKey === 'pair') return `${a.token0.symbol}/${a.token1.symbol}`.localeCompare(`${b.token0.symbol}/${b.token1.symbol}`)
      return b.totalUsd - a.totalUsd
    })
    return list
  }, [positions, filterKey, sortKey])

  const refreshBalances = useCallback(async (addr: Address) => {
    try {
      const [eth, weth] = await Promise.all([
        getNativeBalance(addr),
        getErc20Balance(CONTRACTS.weth, addr),
      ])
      setEthBal(eth)
      setWethBal(weth)
    } catch {
      /* ignore */
    }
  }, [])

  const connect = async () => {
    try {
      setBusy(true)
      setStatus('连接中…')
      const { address: addr, walletClient } = await connectWallet()
      setAddress(addr)
      setWallet(walletClient)
      setStatus(`已连接 ${shortAddr(addr)}`)
      setStatusHash(null)
      await refreshBalances(addr)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = () => {
    setAddress(null)
    setWallet(null)
    setPositions([])
    setSelectedId(null)
    setStatus('已断开连接')
    setStatusHash(null)
  }

  const testRpc = async () => {
    try {
      setRpcBusy(true)
      setRpcLatency(null)
      setRpcBlock(null)
      const { latencyMs, blockNumber } = await testRpcLatency(rpcInput.trim() || defaultRpcUrl())
      setRpcLatency(latencyMs)
      setRpcBlock(blockNumber)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
      setStatusHash(null)
    } finally {
      setRpcBusy(false)
    }
  }

  const saveRpc = () => {
    try {
      setRpcBusy(true)
      const saved = saveCustomRpcUrl(rpcInput)
      refreshPublicClient()
      setRpcInput(saved ?? '')
      setActiveRpcLabel(describeActiveRpc())
      setRpcLatency(null)
      setRpcBlock(null)
      setStatus(saved ? `已保存自定义 RPC：${saved}` : `已恢复默认 RPC（${defaultRpcUrl()}）`)
      setStatusHash(null)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
      setStatusHash(null)
    } finally {
      setRpcBusy(false)
    }
  }

  const onSwitchChain = async (nextId: SupportedChainId) => {
    if (nextId === chainId) return
    try {
      setBusy(true)
      const cfg = switchAppChain(nextId)
      setChainId(nextId)
      setTokenA(cfg.defaultTokenA)
      setTokenB(cfg.defaultTokenB)
      setCustomToken('')
      setPool(null)
      setScannedPools([])
      setPositions([])
      setSelectedId(null)
      setPoolInput('')
      setAmount0('')
      setAmount1('')
      setInitPrice('')
      setRpcInput(loadCustomRpcUrl(nextId) ?? '')
      setActiveRpcLabel(describeActiveRpc(nextId))
      setRpcLatency(null)
      setRpcBlock(null)
      setStatus(`已切换到 ${cfg.label}`)
      setStatusHash(null)
      if (address) {
        try {
          await ensureActiveChain()
          setWallet(makeWalletClient(address))
          setStatus(`已切换到 ${cfg.label}，正在刷新仓位…`)
          await refreshPositions({ silent: false })
        } catch (e) {
          setStatus(
            `应用已切到 ${cfg.label}，请在钱包中切换网络后点连接：${e instanceof Error ? e.message : String(e)}`,
          )
        }
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const refreshingRef = useRef(false)
  const refreshPositions = useCallback(async (opts?: { silent?: boolean; deep?: boolean }) => {
    if (!address) return
    const silent = opts?.silent ?? tabRef.current !== 'positions'
    const deep = Boolean(opts?.deep)
    if (refreshingRef.current) {
      if (!silent) setRefreshStatus('仍在刷新中，请稍候…')
      return
    }
    refreshingRef.current = true
    setRefreshing(true)
    if (!silent) {
      setRefreshStatus(deep ? '深度扫描仓位…' : '刷新 V3 仓位…')
    }
    const started = Date.now()
    const partial: string[] = []
    let v3: PositionRow[] | null = null
    let v4: PositionRow[] | null = null
    try {
      if (!silent) setRefreshStatus(deep ? '深度扫描仓位…' : '刷新 V3 / V4 仓位…')

      const v3P = withTimeout(loadV3Positions(address), deep ? 90_000 : 35_000, 'V3 仓位')
        .then((rows) => {
          v3 = rows
          setPositions((prev) => {
            const keepV4 = prev.filter((p) => p.version === 'v4')
            return [...rows, ...keepV4]
          })
          return rows
        })
        .catch((e) => {
          partial.push(e instanceof Error ? e.message : String(e))
          console.warn('loadV3Positions failed', e)
          return null
        })

      const v4P = withTimeout(
        loadV4Positions(address, {
          deep,
          skipPnl: true,
          onStatus: silent ? undefined : setRefreshStatus,
        }),
        deep ? 90_000 : 35_000,
        'V4 仓位',
      )
        .then((rows) => {
          v4 = rows
          setPositions((prev) => {
            const keepV3 = prev.filter((p) => p.version === 'v3')
            return [...keepV3, ...rows]
          })
          return rows
        })
        .catch((e) => {
          partial.push(e instanceof Error ? e.message : String(e))
          console.warn('loadV4Positions failed', e)
          return null
        })

      await Promise.all([v3P, v4P])

      setPositions((prev) => {
        const nextV3 = v3 ?? prev.filter((p) => p.version === 'v3')
        const nextV4 = v4 ?? prev.filter((p) => p.version === 'v4')
        return [...nextV3, ...nextV4]
      })
      const at = Date.now()
      setLastRefreshAt(at)
      const stamp = new Date(at).toLocaleTimeString()
      const n3 = v3?.length
      const n4 = v4?.length
      const keepNote = partial.length ? ' · 失败侧保留旧列表' : ''
      const msg = partial.length
        ? `${stamp} · V3 ${n3 ?? '旧'} / V4 ${n4 ?? '旧'}${keepNote} · ${partial.join('；')}`
        : `${stamp} · 共 ${(n3 ?? 0) + (n4 ?? 0)} 个仓位（V3 ${n3} / V4 ${n4}）${deep ? ' · 深度扫描' : ''} · ${((at - started) / 1000).toFixed(1)}s`
      if (!silent || tabRef.current === 'positions') setRefreshStatus(msg)
      setSelectedId((prev) => {
        const mergedHint = [...(v3 ?? []), ...(v4 ?? [])]
        if (prev && (mergedHint.some((p) => `${p.version}-${p.tokenId}` === prev) || partial.length > 0)) {
          return prev
        }
        return mergedHint.length ? `${mergedHint[0].version}-${mergedHint[0].tokenId}` : prev
      })
      void refreshBalances(address)

      // 后台补齐历史已领手续费（含复投），不挡列表；逐条写回 UI
      const feeBase = [
        ...(v3 ?? []),
        ...(v4 ?? []),
      ]
      if (feeBase.length && address) {
        if (!silent) setRefreshStatus((s) => `${s} · 补扫历史手续费…`)
        void enrichPositionsLifetimeFees(feeBase, address, {
          onRow: (row) => {
            setPositions((prev) => {
              const i = prev.findIndex(
                (p) => p.version === row.version && p.tokenId === row.tokenId,
              )
              if (i < 0) return prev
              const copy = [...prev]
              copy[i] = row
              return copy
            })
          },
        }).then((rows) => {
          setPositions((prev) => {
            const map = new Map(rows.map((r) => [`${r.version}-${r.tokenId}`, r]))
            return prev.map((p) => map.get(`${p.version}-${p.tokenId}`) ?? p)
          })
          if (!silent || tabRef.current === 'positions') {
            const claimed = rows.reduce((s, p) => s + p.claimedFeesUsd, 0)
            const total = rows.reduce((s, p) => s + p.totalFeesUsd, 0)
            setRefreshStatus(
              (s) =>
                `${s.split(' · 补扫')[0]} · 手续费已领 ${formatUsd(claimed)} / 合计 ${formatUsd(total)}`,
            )
          }
        }).catch((e) => console.warn('lifetime fees enrich failed', e))
      }
    } catch (e) {
      if (!silent || tabRef.current === 'positions') {
        setRefreshStatus(e instanceof Error ? e.message : String(e))
      }
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }, [address, refreshBalances])

  useEffect(() => {
    if (address) void refreshPositions({ silent: true })
  }, [address]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!window.ethereum) return
    const onAccounts = (accounts: unknown) => {
      const list = accounts as string[]
      if (!list?.length) {
        disconnect()
        return
      }
      const next = list[0] as Address
      setAddress(next)
      try {
        setWallet(makeWalletClient(next))
      } catch {
        /* */
      }
      setStatus(`已切换账户 ${shortAddr(next)}`)
    }
    const onChain = (chainIdHex: unknown) => {
      const id = Number(chainIdHex as string)
      const want = getActiveChainId()
      if (id !== want) {
        setStatus(`钱包不在 ${getActiveChainConfig().label}（${want}），请切换网络`)
      }
    }
    window.ethereum.on?.('accountsChanged', onAccounts)
    window.ethereum.on?.('chainChanged', onChain)
    return () => {
      window.ethereum?.removeListener?.('accountsChanged', onAccounts)
      window.ethereum?.removeListener?.('chainChanged', onChain)
    }
  }, [])

  useEffect(() => {
    if (!autoRefresh || !address) return
    const t = setInterval(() => void refreshPositions({ silent: true }), 60_000)
    return () => clearInterval(t)
  }, [autoRefresh, address, refreshPositions])

  useEffect(() => {
    if (!address || !selected) return
    void (async () => {
      const [b0, b1] = await Promise.all([
        isNativeCurrency(selected.token0.address) ? getNativeBalance(address) : getErc20Balance(selected.token0.address, address),
        isNativeCurrency(selected.token1.address) ? getNativeBalance(address) : getErc20Balance(selected.token1.address, address),
      ])
      setAddBal0(b0)
      setAddBal1(b1)
    })()
  }, [address, selected])

  useEffect(() => {
    if (!address || !pool) return
    void (async () => {
      const [b0, b1] = await Promise.all([
        isNativeCurrency(pool.token0.address) ? getNativeBalance(address) : getErc20Balance(pool.token0.address, address),
        isNativeCurrency(pool.token1.address) ? getNativeBalance(address) : getErc20Balance(pool.token1.address, address),
      ])
      setBal0(b0)
      setBal1(b1)
    })()
  }, [address, pool])

  const loadPoolByPair = async () => {
    setBusy(true)
    setStatus(mintProtocol === 'v4' ? '查找 V4 池…' : '查找 V3 池…')
    try {
      if (mintProtocol === 'v4') {
        const info = await findV4Pool(tokenA, tokenB, fee)
        if (!info) {
          setPool(null)
          setShowCreatePool(true)
          setV4TickSpacing(suggestV4TickSpacing(fee))
          setStatus('该 Fee 尚无 V4 池 — 可在下方创建并注入初仓')
          return
        }
        setPool(info)
        setShowCreatePool(false)
        setV4TickSpacing(info.tickSpacing)
        applyDefaultCoinRange(info, setPriceLo, setPriceHi)
        setStatus(`已加载 V4 · fee ${(info.fee / 10000).toFixed(2)}% · spacing ${info.tickSpacing} · 币价 ${formatPrice(getCoinQuote(info).spot)}`)
        return
      }
      const addr = await findV3Pool(tokenA, tokenB, fee)
      if (!addr) {
        setPool(null)
        setShowCreatePool(true)
        setStatus('该 Fee 尚无 V3 池 — 可在下方创建并初始化')
        return
      }
      const info = await loadV3Pool(addr)
      if (info.sqrtPriceX96 === 0n) {
        setPool(null)
        setShowCreatePool(true)
        setStatus('池已部署但未初始化 — 填写初始价后创建/初始化')
        return
      }
      setPool(info)
      setShowCreatePool(false)
      applyDefaultCoinRange(info, setPriceLo, setPriceHi)
      setStatus(`已加载 ${shortAddr(addr)} · 币价 ${formatPrice(getCoinQuote(info).spot)} ${getCoinQuote(info).quote.symbol}/${getCoinQuote(info).coin.symbol}`)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const scanPools = async () => {
    setBusy(true)
    setStatus(mintProtocol === 'v4' ? '扫描 V4 Fee…' : '扫描全部 Fee tier…')
    try {
      const list = mintProtocol === 'v4'
        ? await scanV4Pools(tokenA, tokenB)
        : await scanV3Pools(tokenA, tokenB)
      setScannedPools(list)
      if (!list.length) {
        setPool(null)
        setShowCreatePool(mintProtocol === 'v3')
        setStatus(mintProtocol === 'v4' ? '未找到任何 V4 池' : '未找到任何 V3 池 — 可在下方创建')
        return
      }
      setPool(list[0])
      setShowCreatePool(false)
      setFee(list[0].fee)
      applyDefaultCoinRange(list[0], setPriceLo, setPriceHi)
      setStatus(`找到 ${list.length} 个${mintProtocol.toUpperCase()} 池，默认 ${(list[0].fee / 10000).toFixed(2)}%`)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const loadPoolByAddress = async () => {
    if (!poolInput.trim()) return
    setBusy(true)
    setStatus('解析并加载池子…')
    try {
      const info = await loadPoolFromInput(poolInput)
      setPool(info)
      {
        const q = getCoinQuote(info)
        setTokenA(q.coin.address)
        setTokenB(q.quote.address)
      }
      setFee(info.fee)
      applyDefaultCoinRange(info, setPriceLo, setPriceHi)
      const q = getCoinQuote(info)
      const tag = info.version === 'v4'
        ? `V4 · poolId ${info.poolId ? shortAddr(info.poolId) : ''}`
        : `V3 · ${info.poolAddress ? shortAddr(info.poolAddress) : ''}`
      setStatus(`已加载 ${tag} · ${q.coin.symbol}/${q.quote.symbol} · 币价 ${formatPrice(q.spot)} ${q.quote.symbol}/${q.coin.symbol}`)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const refreshPoolPrice = async () => {
    if (pool?.version === 'v4') {
      setBusy(true)
      try {
        const info = pool.hooks != null && pool.tickSpacing
          ? await loadV4Pool({
              currency0: pool.token0.address,
              currency1: pool.token1.address,
              fee: pool.fee,
              tickSpacing: pool.tickSpacing,
              hooks: pool.hooks,
            })
          : await findV4Pool(pool.token0.address, pool.token1.address, pool.fee)
        if (!info) throw new Error('刷新 V4 池失败')
        setPool(info)
        setStatus(`V4 价格已刷新 · 币价 ${formatPrice(getCoinQuote(info).spot)}`)
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
      return
    }
    if (!pool?.poolAddress) return
    setBusy(true)
    setStatus('刷新池价中…')
    try {
      const info = await loadV3Pool(pool.poolAddress)
      setPool(info)
      setScannedPools((prev) => prev.map((p) => (p.poolAddress === info.poolAddress ? info : p)))

      let ticks: { tickLower: number; tickUpper: number } | null = null
      try {
        if (rangeMode === 'full') {
          ticks = describeFullRange(info)
        } else if (rangeMode === 'percent') {
          ticks = describeRange(info, percentLower, percentUp)
        } else {
          const lo = Number(priceLo)
          const hi = Number(priceHi)
          if (lo > 0 && hi > 0) ticks = ticksFromCoinPrices(info, lo, hi)
        }
      } catch {
        ticks = null
      }

      if (ticks) {
        const a0 = parseAmount(amount0 || '0', info.token0.decimals)
        const a1 = parseAmount(amount1 || '0', info.token1.decimals)
        if (a0 > 0n) {
          const paired = pairAmountForRange({
            sqrtPriceX96: info.sqrtPriceX96,
            tickLower: ticks.tickLower,
            tickUpper: ticks.tickUpper,
            amount: a0,
            side: 0,
          })
          setAmount1(formatAmountExact(paired.amount1, info.token1.decimals))
        } else if (a1 > 0n) {
          const paired = pairAmountForRange({
            sqrtPriceX96: info.sqrtPriceX96,
            tickLower: ticks.tickLower,
            tickUpper: ticks.tickUpper,
            amount: a1,
            side: 1,
          })
          setAmount0(formatAmountExact(paired.amount0, info.token0.decimals))
        }
      }

      const q = getCoinQuote(info)
      setStatus(`价格已刷新 · 币价 ${formatPrice(q.spot)} ${q.quote.symbol}/${q.coin.symbol} · tick ${info.tick}`)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const addCustomToken = async () => {
    const raw = customToken.trim()
    if (!isAddress(raw)) {
      setStatus('无效的 token 地址')
      return
    }
    try {
      const meta = await resolveTokenMeta(raw as Address)
      setTokenA(meta.address)
      // 报价侧默认保持 / 纠正为 ETH，避免误做成 USDG 对
      if (!isEthLikeCurrency(tokenB)) setTokenB(CONTRACTS.weth)
      setStatus(`已设币 = ${meta.symbol}，报价 = ETH`)
      setCustomToken('')
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    }
  }

  const run = async (label: string, fn: () => Promise<unknown>, pair?: string) => {
    if (!wallet || !address) return setStatus('请先连接钱包')
    setBusy(true)
    setStatus(`${label} 进行中…`)
    setStatusHash(null)
    try {
      const r = await fn()
      const hash = extractHash(r)
      if (hash) {
        setStatusHash(hash)
        setTxHistory(pushTxHistory({ label, hash, pair }))
        setStatus(`${label} 已完成`)
      } else {
        setStatus(`${label} 已完成`)
      }
      await refreshPositions({ silent: true })
      if (address) await refreshBalances(address)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const rangePreview = useMemo(() => {
    if (!pool) return null
    try {
      if (rangeMode === 'full') return describeFullRange(pool)
      if (rangeMode === 'percent') return describeRange(pool, percentLower, percentUp)
      const lo = Number(priceLo.replace(/,/g, ''))
      const hi = Number(priceHi.replace(/,/g, ''))
      if (!(lo > 0) || !(hi > 0)) return null
      return ticksFromCoinPrices(pool, lo, hi)
    } catch {
      return null
    }
  }, [pool, percentLower, percentUp, rangeMode, priceLo, priceHi])

  // 切到单边区间时清掉不需要的那一侧输入
  useEffect(() => {
    if (!pool || !rangePreview) return
    if (pool.tick >= rangePreview.tickUpper) setAmount0('0')
    else if (pool.tick < rangePreview.tickLower) setAmount1('0')
  }, [pool, rangePreview])


  const tokenOptions = useMemo(() => {
    const weth = CONTRACTS.weth.toLowerCase()
    const zero = '0x0000000000000000000000000000000000000000'
    const base = listKnownTokens().map((t) => ({
      addr: t.address,
      symbol: t.address.toLowerCase() === weth ? 'ETH' : t.symbol,
      decimals: t.decimals,
    }))
    const extra: { addr: Address; symbol: string; decimals: number }[] = []
    const pushExtra = (addr: Address) => {
      if (!addr || KNOWN_TOKENS[addr.toLowerCase()]) return
      if (extra.some((e) => e.addr.toLowerCase() === addr.toLowerCase())) return
      if (addr.toLowerCase() === zero || addr.toLowerCase() === weth) {
        extra.push({ addr, symbol: 'ETH', decimals: 18 })
        return
      }
      extra.push({ addr, symbol: shortAddr(addr), decimals: 18 })
    }
    pushExtra(tokenA)
    pushExtra(tokenB)
    return [...base, ...extra]
  }, [tokenA, tokenB, chainId])

  const tokenLabel = (addr: Address) => {
    if (isNativeCurrency(addr) || addr.toLowerCase() === CONTRACTS.weth.toLowerCase()) return 'ETH'
    return tokenOptions.find((x) => x.addr.toLowerCase() === addr.toLowerCase())?.symbol ?? shortAddr(addr)
  }

  /** V3 链上永远是 WETH；V4 可选原生 ETH */
  const chainCurrency = (addr: Address) => {
    if (!isEthLikeCurrency(addr)) return addr
    if (mintProtocol === 'v3') return CONTRACTS.weth
    return useNativeEth ? '0x0000000000000000000000000000000000000000' as Address : CONTRACTS.weth
  }

  /** 根据初始价 + 区间预设，预览创建池（用于初仓数量自动配平） */
  const createSynth = useMemo(() => {
    const price = Number(initPrice.replace(/,/g, ''))
    if (!(price > 0) || !Number.isFinite(price)) return null

    const ethA = isEthLikeCurrency(tokenA)
    const ethB = isEthLikeCurrency(tokenB)
    let initialPriceBPerA = price
    if (ethA && !ethB) initialPriceBPerA = 1 / price
    else if (ethB && !ethA) initialPriceBPerA = price
    if (!(initialPriceBPerA > 0) || !Number.isFinite(initialPriceBPerA)) return null

    let useFee = fee
    if (mintProtocol === 'v4' && customFeeInput.trim()) {
      const pct = Number(customFeeInput.replace(/%/g, '').trim())
      if (pct > 0 && Number.isFinite(pct)) useFee = Math.round(pct * 10000)
    }

    const rawA = chainCurrency(tokenA)
    const rawB = chainCurrency(tokenB)
    const sortedAFirst = rawA.toLowerCase() < rawB.toLowerCase()
    const t0 = sortedAFirst ? rawA : rawB
    const t1 = sortedAFirst ? rawB : rawA
    const decA = tokenOptions.find((x) => x.addr === tokenA)?.decimals ?? 18
    const decB = tokenOptions.find((x) => x.addr === tokenB)?.decimals ?? 18
    const d0 = sortedAFirst ? decA : decB
    const d1 = sortedAFirst ? decB : decA
    const sym0 = sortedAFirst ? tokenLabel(tokenA) : tokenLabel(tokenB)
    const sym1 = sortedAFirst ? tokenLabel(tokenB) : tokenLabel(tokenA)

    let sortedPrice = initialPriceBPerA
    if (t0.toLowerCase() !== rawA.toLowerCase()) sortedPrice = 1 / initialPriceBPerA

    const spacing =
      mintProtocol === 'v4'
        ? v4TickSpacing
        : useFee === 100 ? 1 : useFee === 500 ? 10 : useFee === 3000 ? 60 : 200

    const sqrt = priceToSqrtPriceX96(sortedPrice, d0, d1)
    const tick = priceToClosestTick(sortedPrice, d0, d1)
    const synth: PoolInfo = {
      version: mintProtocol,
      token0: { address: t0, symbol: sym0, decimals: d0 },
      token1: { address: t1, symbol: sym1, decimals: d1 },
      fee: useFee,
      tickSpacing: spacing,
      tick,
      sqrtPriceX96: sqrt,
      price: tickToPrice(tick, d0, d1),
      liquidity: 0n,
    }

    const pct =
      createRangePreset === 'onesided-eth' && (ethA || ethB)
        ? oneSidedEthPercents()
        : typeof createRangePreset === 'number'
          ? { percentLower: -createRangePreset, percentUpper: createRangePreset }
          : { percentLower, percentUpper: percentUp }
    const range =
      createRangePreset === 'full'
        ? describeFullRange(synth)
        : describeRange(synth, pct.percentLower, pct.percentUpper)

    return { synth, range, sortedAFirst, rawA, rawB, initialPriceBPerA, useFee, decA, decB }
  }, [
    initPrice,
    tokenA,
    tokenB,
    fee,
    mintProtocol,
    v4TickSpacing,
    customFeeInput,
    useNativeEth,
    createRangePreset,
    percentLower,
    percentUp,
    tokenOptions,
  ])

  const onCreateSeedSide = (side: 'A' | 'B', raw: string) => {
    if (side === 'A') setSeedAmtA(raw)
    else setSeedAmtB(raw)
    if (!createSynth || !seedOnCreate) return

    const { synth, range, sortedAFirst, decA, decB } = createSynth
    const ethA = isEthLikeCurrency(tokenA)
    const ethB = isEthLikeCurrency(tokenB)
    if (createRangePreset === 'onesided-eth' && ethA && side === 'B') return
    if (createRangePreset === 'onesided-eth' && ethB && side === 'A') return

    const dec = side === 'A' ? decA : decB
    const amount = parseAmount(raw || '0', dec)
    if (amount <= 0n) {
      if (side === 'A') setSeedAmtB('')
      else setSeedAmtA('')
      return
    }

    const poolSide: 0 | 1 = (side === 'A') === sortedAFirst ? 0 : 1
    const paired = pairAmountForRange({
      sqrtPriceX96: synth.sqrtPriceX96,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      amount,
      side: poolSide,
    })

    if (paired.singleSided === 'token0') {
      if (sortedAFirst) {
        setSeedAmtA(formatAmountExact(paired.amount0, decA))
        setSeedAmtB('0')
      } else {
        setSeedAmtB(formatAmountExact(paired.amount0, decB))
        setSeedAmtA('0')
      }
      return
    }
    if (paired.singleSided === 'token1') {
      if (sortedAFirst) {
        setSeedAmtB(formatAmountExact(paired.amount1, decB))
        setSeedAmtA('0')
      } else {
        setSeedAmtA(formatAmountExact(paired.amount1, decA))
        setSeedAmtB('0')
      }
      return
    }

    if (sortedAFirst) {
      if (side === 'A') setSeedAmtB(formatAmountExact(paired.amount1, decB))
      else setSeedAmtA(formatAmountExact(paired.amount0, decA))
    } else if (side === 'A') {
      setSeedAmtB(formatAmountExact(paired.amount0, decB))
    } else {
      setSeedAmtA(formatAmountExact(paired.amount1, decA))
    }
  }

  useEffect(() => {
    if (!address || !showCreatePool) return
    void (async () => {
      const gas = 10n ** 15n
      const balEth = ethBal > gas ? ethBal - gas : 0n
      const balA = isEthLikeCurrency(tokenA)
        ? (useNativeEth ? balEth : wethBal)
        : await getErc20Balance(tokenA, address)
      const balB = isEthLikeCurrency(tokenB)
        ? (useNativeEth ? balEth : wethBal)
        : await getErc20Balance(tokenB, address)
      setCreateSeedBalA(balA)
      setCreateSeedBalB(balB)
    })()
  }, [address, showCreatePool, tokenA, tokenB, ethBal, wethBal, useNativeEth])

  const fillCreateSeedBalances = (pct = 100) => {
    if (!createSynth) return
    const { synth, range, sortedAFirst, decA, decB } = createSynth
    const f = BigInt(Math.floor(pct * 100))
    const availA = (createSeedBalA * f) / 10000n
    const availB = (createSeedBalB * f) / 10000n
    const wethA = isEthLikeCurrency(tokenA)
    const wethB = isEthLikeCurrency(tokenB)

    const apply = (a0: bigint, a1: bigint) => {
      if (sortedAFirst) {
        setSeedAmtA(formatAmountExact(a0, decA))
        setSeedAmtB(formatAmountExact(a1, decB))
      } else {
        setSeedAmtA(formatAmountExact(a1, decA))
        setSeedAmtB(formatAmountExact(a0, decB))
      }
    }

    const trySide = (side: 0 | 1, avail: bigint) => {
      const paired = pairAmountForRange({
        sqrtPriceX96: synth.sqrtPriceX96,
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        amount: avail,
        side,
      })
      apply(paired.amount0, paired.amount1)
    }

    if (createRangePreset === 'onesided-eth' && (wethA || wethB)) {
      if (wethA) trySide(sortedAFirst ? 0 : 1, availA)
      else trySide(sortedAFirst ? 1 : 0, availB)
      return
    }

    const from0 = pairAmountForRange({
      sqrtPriceX96: synth.sqrtPriceX96,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      amount: sortedAFirst ? availA : availB,
      side: sortedAFirst ? 0 : 1,
    })
    if (from0.singleSided === 'token0' || from0.amount1 <= (sortedAFirst ? availB : availA)) {
      trySide(sortedAFirst ? 0 : 1, sortedAFirst ? availA : availB)
      return
    }
    trySide(sortedAFirst ? 1 : 0, sortedAFirst ? availB : availA)
  }

  const createPool = async () => {
    if (!address || !wallet) {
      setStatus('请先连接钱包')
      return
    }
    if (tokenA.toLowerCase() === tokenB.toLowerCase()) {
      setStatus('两个 Token 不能相同')
      return
    }
    const price = Number(initPrice.replace(/,/g, ''))
    if (!(price > 0)) {
      setStatus('请填写有效的初始币价')
      return
    }
    if (seedOnCreate && !createSynth) {
      setStatus('初始价格无效，无法计算注入数量')
      return
    }

    const ethA = isEthLikeCurrency(tokenA)
    const ethB = isEthLikeCurrency(tokenB)
    const initialPriceBPerA = createSynth?.initialPriceBPerA ?? price
    const useFee = createSynth?.useFee ?? fee
    const decA = createSynth?.decA ?? tokenOptions.find((x) => x.addr === tokenA)?.decimals ?? 18
    const decB = createSynth?.decB ?? tokenOptions.find((x) => x.addr === tokenB)?.decimals ?? 18

    let amountA = 0n
    let amountB = 0n
    if (seedOnCreate) {
      amountA = parseAmount(seedAmtA || '0', decA)
      amountB = parseAmount(seedAmtB || '0', decB)
      if (createRangePreset === 'onesided-eth' && (ethA || ethB)) {
        if (ethA) amountB = 0n
        else amountA = 0n
      }
      if (amountA <= 0n && amountB <= 0n) {
        setStatus('请填写至少一侧注入数量，或取消「同时注入初仓」')
        return
      }
    }

    const rawA = chainCurrency(tokenA)
    const rawB = chainCurrency(tokenB)
    const sortedAFirst = rawA.toLowerCase() < rawB.toLowerCase()
    const amount0 = sortedAFirst ? amountA : amountB
    const amount1 = sortedAFirst ? amountB : amountA

    let tickLower: number | undefined
    let tickUpper: number | undefined
    if (seedOnCreate && createSynth) {
      tickLower = createSynth.range.tickLower
      tickUpper = createSynth.range.tickUpper
    }

    if (mintProtocol === 'v4' && customFeeInput.trim()) {
      const pct = Number(customFeeInput.replace(/%/g, '').trim())
      if (!(pct > 0) || !Number.isFinite(pct)) {
        setStatus('自定义费率无效，例如填 0.3 表示 0.30%')
        return
      }
      const f = Math.round(pct * 10000)
      if (f < 1 || f > 1_000_000) {
        setStatus('自定义费率超出范围')
        return
      }
    }

    setBusy(true)
    setStatusHash(null)
    setStatus(
      seedOnCreate
        ? `创建 ${mintProtocol.toUpperCase()} 池并注入流动性…`
        : `创建 / 初始化 ${mintProtocol.toUpperCase()} 池…`,
    )
    try {
      if (mintProtocol === 'v4') {
        const { pool: info, hash, seeded } = await createV4PoolAndSeed({
          walletClient: wallet,
          owner: address,
          tokenA,
          tokenB,
          fee: useFee,
          tickSpacing: v4TickSpacing,
          initialPriceBPerA,
          amount0: seedOnCreate ? amount0 : undefined,
          amount1: seedOnCreate ? amount1 : undefined,
          tickLower,
          tickUpper,
          useNativeEth,
          slippageBps,
          onStatus: setStatus,
        })
        setPool(info)
        setFee(useFee)
        setShowCreatePool(false)
        applyDefaultCoinRange(info, setPriceLo, setPriceHi)
        const q = getCoinQuote(info)
        setStatusHash(hash)
        setTxHistory(pushTxHistory({
          label: seeded ? '创建 V4 池+初仓' : '创建 V4 池',
          hash,
          pair: `${q.coin.symbol}/${q.quote.symbol}`,
        }))
        setStatus(
          `V4 池已就绪 · fee ${(useFee / 10000).toFixed(2)}% · spacing ${v4TickSpacing} · 币价 ${formatPrice(q.spot)}`,
        )
        void refreshPositions({ silent: true })
      } else {
        const { pool: info, hash, created, seeded } = await createV3PoolAndSeed({
          walletClient: wallet,
          owner: address,
          tokenA,
          tokenB,
          fee: useFee,
          initialPriceBPerA,
          amount0: seedOnCreate ? amount0 : undefined,
          amount1: seedOnCreate ? amount1 : undefined,
          tickLower,
          tickUpper,
          useNativeEth,
          onStatus: setStatus,
        })
        setPool(info)
        setShowCreatePool(false)
        applyDefaultCoinRange(info, setPriceLo, setPriceHi)
        const q = getCoinQuote(info)
        if (hash) {
          setStatusHash(hash)
          setTxHistory(pushTxHistory({
            label: seeded ? '创建 V3 池+初仓' : created ? '创建 V3 池' : '初始化 V3 池',
            hash,
            pair: `${q.coin.symbol}/${q.quote.symbol}`,
          }))
        }
        setStatus(
          `V3 池已就绪 · ${q.coin.symbol}/${q.quote.symbol} · 币价 ${formatPrice(q.spot)} ${q.quote.symbol}/${q.coin.symbol}`,
        )
        if (seeded) void refreshPositions({ silent: true })
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const mintTicks = rangePreview
    ? { tickLower: rangePreview.tickLower, tickUpper: rangePreview.tickUpper }
    : null

  const fillBalances = (pct = 100) => {
    if (!pool || !mintTicks) return
    const f = BigInt(Math.floor(pct * 100))
    const gasReserve = 10n ** 15n
    const weth0 = pool.token0.address.toLowerCase() === CONTRACTS.weth.toLowerCase()
    const weth1 = pool.token1.address.toLowerCase() === CONTRACTS.weth.toLowerCase()
    let avail0 = bal0
    let avail1 = bal1
    if (useNativeEth && weth0) avail0 = ethBal > gasReserve ? ethBal - gasReserve : 0n
    if (useNativeEth && weth1) avail1 = ethBal > gasReserve ? ethBal - gasReserve : 0n
    avail0 = (avail0 * f) / 10000n
    avail1 = (avail1 * f) / 10000n

    const apply = (a0: bigint, a1: bigint) => {
      setAmount0(formatAmountExact(a0, pool.token0.decimals))
      setAmount1(formatAmountExact(a1, pool.token1.decimals))
    }

    const from0 = pairAmountForRange({
      sqrtPriceX96: pool.sqrtPriceX96,
      tickLower: mintTicks.tickLower,
      tickUpper: mintTicks.tickUpper,
      amount: avail0,
      side: 0,
    })
    if (from0.singleSided === 'token0' || from0.amount1 <= avail1) {
      apply(from0.amount0, from0.amount1)
      return
    }
    const from1 = pairAmountForRange({
      sqrtPriceX96: pool.sqrtPriceX96,
      tickLower: mintTicks.tickLower,
      tickUpper: mintTicks.tickUpper,
      amount: avail1,
      side: 1,
    })
    apply(from1.amount0, from1.amount1)
  }

  const onMintSide = (side: 0 | 1, raw: string) => {
    if (side === 0) setAmount0(raw)
    else setAmount1(raw)
    if (!pool || !mintTicks) return
    const dec = side === 0 ? pool.token0.decimals : pool.token1.decimals
    const amount = parseAmount(raw || '0', dec)
    const paired = pairAmountForRange({
      sqrtPriceX96: pool.sqrtPriceX96,
      tickLower: mintTicks.tickLower,
      tickUpper: mintTicks.tickUpper,
      amount,
      side,
    })
    if (side === 0) {
      setAmount1(formatAmountExact(paired.amount1, pool.token1.decimals))
    } else {
      setAmount0(formatAmountExact(paired.amount0, pool.token0.decimals))
    }
  }

  const onAddSide = (side: 0 | 1, raw: string) => {
    if (!selected) return
    if (side === 0) setAdd0(raw)
    else setAdd1(raw)
    const dec = side === 0 ? selected.token0.decimals : selected.token1.decimals
    const amount = parseAmount(raw || '0', dec)
    const paired = pairAmountForRange({
      sqrtPriceX96: selected.sqrtPriceX96,
      tickLower: selected.tickLower,
      tickUpper: selected.tickUpper,
      amount,
      side,
    })
    if (side === 0) {
      setAdd1(formatAmountExact(paired.amount1, selected.token1.decimals))
    } else {
      setAdd0(formatAmountExact(paired.amount0, selected.token0.decimals))
    }
  }

  const poolUsesWeth = pool ? pairHasWeth(pool.token0.address, pool.token1.address) : false
  const mintUseEth = useNativeEth && poolUsesWeth
  const label0 = pool
    ? (mintUseEth && isEthLikeCurrency(pool.token0.address) ? 'ETH' : pool.token0.symbol)
    : ''
  const label1 = pool
    ? (mintUseEth && isEthLikeCurrency(pool.token1.address) ? 'ETH' : pool.token1.symbol)
    : ''
  const showBal0 = pool
    ? (mintUseEth && isEthLikeCurrency(pool.token0.address) ? ethBal : bal0)
    : 0n
  const showBal1 = pool
    ? (mintUseEth && isEthLikeCurrency(pool.token1.address) ? ethBal : bal1)
    : 0n

  const selectedUsesWeth = selected ? pairHasWeth(selected.token0.address, selected.token1.address) : false
  const addUseEth = useNativeEth && selectedUsesWeth
  const addLabel0 = selected
    ? (addUseEth && isEthLikeCurrency(selected.token0.address) ? 'ETH' : selected.token0.symbol)
    : ''
  const addLabel1 = selected
    ? (addUseEth && isEthLikeCurrency(selected.token1.address) ? 'ETH' : selected.token1.symbol)
    : ''
  const addShow0 = selected
    ? (addUseEth && isEthLikeCurrency(selected.token0.address) ? ethBal : addBal0)
    : 0n
  const addShow1 = selected
    ? (addUseEth && isEthLikeCurrency(selected.token1.address) ? ethBal : addBal1)
    : 0n

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="brand">RangeDesk</p>
          <h1>Uniswap LP · {chainCfg.shortLabel}</h1>
          <p className="sub">半自动 · V3/V4 Claim / 加仓 / 撤出 / Mint</p>
        </div>
        <div className="wallet-box">
          {address ? (
            <>
              <div className="wallet-meta">
                <a className="wallet-link" href={explorerAddress(address)} target="_blank" rel="noreferrer">
                  {shortAddr(address)}
                </a>
                <span className="wallet-bals mono">
                  {formatAmount(ethBal, 18, 4)} ETH · {formatAmount(wethBal, 18, 4)} WETH
                </span>
              </div>
              <div className="btn-row tight">
                <button className="btn" disabled={refreshing} onClick={() => void refreshPositions({ silent: false })}>{refreshing ? '刷新中…' : '刷新'}</button>
                <button className="btn" disabled={refreshing || !address} onClick={() => void refreshPositions({ silent: false, deep: true })} title="扩大回溯 + ownerOf 校验，较慢">深度扫描</button>
                <button className="btn" onClick={disconnect}>断开</button>
              </div>
              {refreshStatus && (
                <p className="wallet-refresh-note muted">{refreshStatus}</p>
              )}
            </>
          ) : (
            <button className="btn primary" disabled={busy} onClick={() => void connect()}>连接钱包</button>
          )}
        </div>
      </header>

      <div className={`status-bar ${busy ? 'busy' : ''}`}>
        <span>{status || (tab === 'positions' && refreshStatus) || `连接钱包（MetaMask/Rabby），切到 ${chainCfg.label}（${chainCfg.id}）`}</span>
        {tab === 'positions' && lastRefreshAt && !refreshing && !refreshStatus && (
          <span className="muted" style={{ marginLeft: 8 }}>
            上次 {new Date(lastRefreshAt).toLocaleTimeString()}
          </span>
        )}
        {statusHash && (
          <a href={explorerTx(statusHash)} target="_blank" rel="noreferrer">查看交易 ↗</a>
        )}
      </div>

      <div className="settings-row">
        <label className="inline-setting">
          网络
          <select
            value={chainId}
            disabled={busy || refreshing}
            onChange={(e) => void onSwitchChain(Number(e.target.value) as SupportedChainId)}
          >
            {SUPPORTED_CHAINS.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="inline-setting">
          滑点
          <select value={slippageBps} onChange={(e) => setSlippageBps(Number(e.target.value))}>
            <option value={50}>0.5%</option>
            <option value={100}>1%</option>
            <option value={150}>1.5%</option>
            <option value={300}>3%</option>
            <option value={500}>5%</option>
            <option value={1000}>10%</option>
          </select>
        </label>
        <label className="inline-setting check">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          每 60s 自动刷新
        </label>
      </div>

      <div className="rpc-panel">
        <div className="rpc-panel-head">
          <strong>{chainCfg.shortLabel} RPC</strong>
          <span className="muted">{activeRpcLabel}</span>
        </div>
        <div className="rpc-panel-row">
          <input
            className="rpc-input mono"
            type="url"
            value={rpcInput}
            placeholder={`默认 ${defaultRpcUrl()}`}
            onChange={(e) => {
              setRpcInput(e.target.value)
              setRpcLatency(null)
              setRpcBlock(null)
            }}
          />
          <button className="btn" type="button" disabled={rpcBusy} onClick={() => void testRpc()}>
            {rpcBusy ? '测试中…' : '测延迟'}
          </button>
          <button className="btn primary" type="button" disabled={rpcBusy} onClick={saveRpc}>
            保存
          </button>
        </div>
        <p className="rpc-panel-note muted">
          留空并保存即恢复当前链默认 RPC。测延迟会请求输入框地址；未填写则测默认节点。
          {rpcLatency != null && (
            <span className="rpc-latency ok-text">
              {' '}
              延迟 {rpcLatency} ms
              {rpcBlock != null ? ` · 区块 #${rpcBlock.toString()}` : ''}
            </span>
          )}
        </p>
      </div>

      <nav className="tabs">
        <button className={tab === 'positions' ? 'active' : ''} onClick={() => setTab('positions')}>仓位</button>
        <button className={tab === 'mint' ? 'active' : ''} onClick={() => setTab('mint')}>新建仓</button>
        <button className={tab === 'tools' ? 'active' : ''} onClick={() => setTab('tools')}>工具</button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>交易历史</button>
      </nav>

      {tab === 'positions' && (
        <section className="panel">
          <div className="summary-strip">
            <div><span className="sum-label">总价值</span><strong>{formatUsd(summary.totalUsd)}</strong></div>
            <div><span className="sum-label">累计手续费</span><strong className="ok-text">{formatUsd(summary.feesUsd)}</strong></div>
            <div><span className="sum-label">其中已领/复投</span><strong>{formatUsd(summary.claimedUsd)}</strong></div>
            <div><span className="sum-label">PnL</span><strong className={summary.pnlUsd >= 0 ? 'ok-text' : 'bad-text'}>{formatPnl(summary.pnlUsd)}</strong></div>
            <div><span className="sum-label">In range</span><strong>{summary.inRange}/{summary.n}</strong></div>
          </div>

          <div className="row between wrap">
            <h2>仓位列表</h2>
            <div className="filters">
              <select value={filterKey} onChange={(e) => setFilterKey(e.target.value as FilterKey)}>
                <option value="all">全部</option>
                <option value="in">In range</option>
                <option value="out">Out of range</option>
                <option value="v3">仅 V3</option>
                <option value="v4">仅 V4</option>
              </select>
              <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                <option value="value">按价值</option>
                <option value="fees">按手续费</option>
                <option value="pnl">按 PnL</option>
                <option value="pair">按交易对</option>
              </select>
            </div>
          </div>

          {filteredPositions.length === 0 ? (
            <p className="muted">暂无仓位。可在「新建仓」里 Mint 一个 V3 仓。</p>
          ) : (
            <div className="pos-grid">
              {filteredPositions.map((p) => {
                const id = `${p.version}-${p.tokenId}`
                const selectedRow = selectedId === id
                const cq = getPositionCoinPrices(p)
                const feeUsd = p.fees0Usd + p.fees1Usd
                const hasFees = p.fees0 > 0n || p.fees1 > 0n
                const feePct0 = feeUsd > 0 ? (p.fees0Usd / feeUsd) * 100 : hasFees ? 50 : 0
                const feePct1 = feeUsd > 0 ? (p.fees1Usd / feeUsd) * 100 : hasFees ? 50 : 0
                const rangeSpan = Math.max(cq.coinPriceUpper - cq.coinPriceLower, 1e-18)
                const rangeMarker = Math.max(
                  0,
                  Math.min(100, ((cq.coinPrice - cq.coinPriceLower) / rangeSpan) * 100),
                )
                return (
                  <button
                    type="button"
                    key={id}
                    className={`pos-card ${selectedRow ? 'selected' : ''}`}
                    onClick={() => setSelectedId(id)}
                  >
                    <div className="pos-top">
                      <span className="pos-label">#{p.tokenId.toString()} · {p.version.toUpperCase()} · {(p.fee / 10000).toFixed(2)}%</span>
                      <span className={`pill ${p.inRange ? 'ok' : 'out'}`}>{p.inRange ? 'In range' : 'Out of range'}</span>
                    </div>
                    <div className="pos-pair">{cq.coin.symbol} / {cq.quote.symbol}</div>
                    <div className="pos-total">{formatUsd(p.totalUsd)}</div>
                    <div className={`pos-pnl ${p.pnlUsd >= 0 ? 'up' : 'down'}`}>
                      PnL {formatPnl(p.pnlUsd)}
                      <span className="pos-pnl-sub">
                        费 {formatUsd(p.totalFeesUsd)} (未领 {formatUsd(p.fees0Usd + p.fees1Usd)} / 已领·复投 {formatUsd(p.claimedFeesUsd)})
                      </span>
                    </div>

                    <div className="bar">
                      <div className="bar-a" style={{ width: `${Math.max(2, Math.min(98, p.pct0))}%` }} />
                      <div className="bar-b" style={{ width: `${Math.max(2, Math.min(98, p.pct1))}%` }} />
                    </div>
                    <div className="bar-legend">
                      <span><i className="dot a" />{p.token0.symbol} {p.pct0.toFixed(2)}%</span>
                      <span><i className="dot b" />{p.token1.symbol} {p.pct1.toFixed(2)}%</span>
                    </div>

                    <div className="asset-row">
                      <span className="asset-left"><i className="dot a" />{formatUsd(p.amount0Usd)}</span>
                      <span className="asset-right mono">{formatAmount(p.amount0, p.token0.decimals, 4)} {p.token0.symbol}</span>
                    </div>
                    <div className="asset-row">
                      <span className="asset-left"><i className="dot b" />{formatUsd(p.amount1Usd)}</span>
                      <span className="asset-right mono">{formatAmount(p.amount1, p.token1.decimals, 4)} {p.token1.symbol}</span>
                    </div>

                    <div className={`fees-block ${hasFees || p.claimedFeesUsd > 0 ? 'has' : 'empty'}`}>
                      <div className="fees-head">
                        <span className="fees-label">手续费合计</span>
                        <span className="fees-total">{formatUsd(p.totalFeesUsd)}</span>
                      </div>
                      <div className="asset-row fee-row">
                        <span className="asset-left">未领</span>
                        <span className="asset-right mono">{formatUsd(feeUsd)}</span>
                      </div>
                      <div className="asset-row fee-row">
                        <span className="asset-left">已领/复投</span>
                        <span className="asset-right mono">{formatUsd(p.claimedFeesUsd)}</span>
                      </div>
                      {(p.claimed0 > 0n || p.claimed1 > 0n) && (
                        <div className="asset-row fee-row muted claimed-tokens">
                          <span className="asset-left" />
                          <span className="asset-right mono">
                            {p.claimed0 > 0n ? `${formatAmount(p.claimed0, p.token0.decimals, 4)} ${p.token0.symbol}` : ''}
                            {p.claimed0 > 0n && p.claimed1 > 0n ? ' · ' : ''}
                            {p.claimed1 > 0n ? `${formatAmount(p.claimed1, p.token1.decimals, 4)} ${p.token1.symbol}` : ''}
                          </span>
                        </div>
                      )}
                      {hasFees && (
                        <>
                          <div className="bar fees-bar">
                            <div className="bar-a" style={{ width: `${Math.max(2, Math.min(98, feePct0 || 2))}%` }} />
                            <div className="bar-b" style={{ width: `${Math.max(2, Math.min(98, feePct1 || 2))}%` }} />
                          </div>
                          <div className="asset-row fee-row">
                            <span className="asset-left"><i className="dot a" />{formatUsd(p.fees0Usd)}</span>
                            <span className="asset-right mono">+{formatAmount(p.fees0, p.token0.decimals, 5)} {p.token0.symbol}</span>
                          </div>
                          <div className="asset-row fee-row">
                            <span className="asset-left"><i className="dot b" />{formatUsd(p.fees1Usd)}</span>
                            <span className="asset-right mono">+{formatAmount(p.fees1, p.token1.decimals, 5)} {p.token1.symbol}</span>
                          </div>
                        </>
                      )}
                    </div>

                    <div className={`range-block ${p.inRange ? 'in' : 'out'}`}>
                      <div className="range-head">
                        <span className="fees-label">价格区间</span>
                        <span className="range-now">现价 {formatPrice(cq.coinPrice)}</span>
                      </div>
                      <div className="range-track">
                        <div className="range-fill" />
                        <div className="range-marker" style={{ left: `${rangeMarker}%` }} />
                      </div>
                      <div className="range-ends">
                        <div className="range-end">
                          <span className="range-end-label">下限</span>
                          <span className="range-end-val">{formatPrice(cq.coinPriceLower)}</span>
                        </div>
                        <div className="range-end right">
                          <span className="range-end-label">上限</span>
                          <span className="range-end-val">{formatPrice(cq.coinPriceUpper)}</span>
                        </div>
                      </div>
                      <div className="range-unit">{cq.priceUnit}</div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          {selected && (
            <div className="actions">
              <div className="actions-head">
                <h3>
                  操作 · {selected.token0.symbol}/{selected.token1.symbol} #{selected.tokenId.toString()}
                </h3>
                <div className="btn-row tight">
                  <button className="btn ghost" type="button" onClick={() => copyText(selected.tokenId.toString())}>复制 NFT ID</button>
                  {selected.poolAddress && (
                    <a className="btn ghost" href={explorerAddress(selected.poolAddress)} target="_blank" rel="noreferrer">看池子 ↗</a>
                  )}
                </div>
              </div>

              {selectedUsesWeth && (
                <label className="inline-setting check" style={{ marginBottom: 10 }}>
                  <input type="checkbox" checked={useNativeEth} onChange={(e) => setUseNativeEth(e.target.checked)} />
                  用原生 ETH：加仓付 ETH / Claim·撤出收 ETH（不经 WETH）
                </label>
              )}

              <div className="btn-row">
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void run(
                    selected.version === 'v4'
                      ? 'Claim V4'
                      : (addUseEth ? 'Claim→ETH' : 'Claim'),
                    () => selected.version === 'v4'
                      ? claimV4({ walletClient: wallet!, owner: address!, position: selected })
                      : claimV3({
                        walletClient: wallet!,
                        owner: address!,
                        tokenId: selected.tokenId,
                        unwrapEth: addUseEth,
                        token0: selected.token0.address,
                        token1: selected.token1.address,
                      }),
                    `${selected.token0.symbol}/${selected.token1.symbol}`,
                  )}
                >
                  Claim 手续费{selected.version === 'v3' && addUseEth ? '（收 ETH）' : ''}
                  {selected.version === 'v4' ? ' · V4' : ''}
                </button>
              </div>

              <div className="op-block">
                <h4>向该仓位加仓</h4>
                <div className="grid2">
                  <label>
                    {addLabel0}
                    <span className="bal-hint">余额 {formatAmount(addShow0, selected.token0.decimals, 6)}</span>
                    <input value={add0} onChange={(e) => onAddSide(0, e.target.value)} placeholder="填一边，另一边自动算" />
                  </label>
                  <label>
                    {addLabel1}
                    <span className="bal-hint">余额 {formatAmount(addShow1, selected.token1.decimals, 6)}</span>
                    <input value={add1} onChange={(e) => onAddSide(1, e.target.value)} placeholder="填一边，另一边自动算" />
                  </label>
                </div>
                <p className="muted" style={{ marginTop: 0 }}>填一边即可，另一边按当前区间配平。</p>
                <div className="btn-row">
                  <button
                    className="btn"
                    type="button"
                    disabled={!address}
                    onClick={() => {
                      const gasReserve = 10n ** 15n
                      const r0 = addUseEth && selected.token0.address.toLowerCase() === CONTRACTS.weth.toLowerCase()
                        ? (ethBal > gasReserve ? ethBal - gasReserve : 0n)
                        : addBal0
                      const r1 = addUseEth && selected.token1.address.toLowerCase() === CONTRACTS.weth.toLowerCase()
                        ? (ethBal > gasReserve ? ethBal - gasReserve : 0n)
                        : addBal1
                      const from0 = pairAmountForRange({
                        sqrtPriceX96: selected.sqrtPriceX96,
                        tickLower: selected.tickLower,
                        tickUpper: selected.tickUpper,
                        amount: r0,
                        side: 0,
                      })
                      if (from0.singleSided === 'token0' || from0.amount1 <= r1) {
                        setAdd0(formatAmountExact(from0.amount0, selected.token0.decimals))
                        setAdd1(formatAmountExact(from0.amount1, selected.token1.decimals))
                        return
                      }
                      const from1 = pairAmountForRange({
                        sqrtPriceX96: selected.sqrtPriceX96,
                        tickLower: selected.tickLower,
                        tickUpper: selected.tickUpper,
                        amount: r1,
                        side: 1,
                      })
                      setAdd0(formatAmountExact(from1.amount0, selected.token0.decimals))
                      setAdd1(formatAmountExact(from1.amount1, selected.token1.decimals))
                    }}
                  >
                    按余额配平
                  </button>
                  <button
                    className="btn primary"
                    disabled={busy}
                    onClick={() => void run(
                      selected.version === 'v4' ? '加仓 V4' : '加仓',
                      () => selected.version === 'v4'
                        ? increaseV4Liquidity({
                          walletClient: wallet!,
                          owner: address!,
                          position: selected,
                          amount0: parseAmount(add0 || '0', selected.token0.decimals),
                          amount1: parseAmount(add1 || '0', selected.token1.decimals),
                          useNativeEth: addUseEth,
                          slippageBps,
                        })
                        : increaseV3Liquidity({
                          walletClient: wallet!,
                          owner: address!,
                          position: selected,
                          amount0: parseAmount(add0 || '0', selected.token0.decimals),
                          amount1: parseAmount(add1 || '0', selected.token1.decimals),
                          slippageBps,
                          useNativeEth: addUseEth,
                        }),
                      `${selected.token0.symbol}/${selected.token1.symbol}`,
                    )}
                  >
                    确认加仓{selected.version === 'v4' ? ' · V4' : ''}
                  </button>
                </div>
              </div>

              <div className="op-block">
                <h4>部分移除 LP</h4>
                <label className="full">
                  移除比例 {removePct}%
                  <input type="range" min={1} max={100} value={removePct} onChange={(e) => setRemovePct(Number(e.target.value))} />
                </label>
                <div className="chip-row">
                  {[25, 50, 75, 100].map((n) => (
                    <button key={n} type="button" className={`chip ${removePct === n ? 'on' : ''}`} onClick={() => setRemovePct(n)}>{n}%</button>
                  ))}
                </div>
                <p className="muted">
                  约 {formatAmount((selected.amount0 * BigInt(removePct)) / 100n, selected.token0.decimals, 4)} {selected.token0.symbol}
                  {' + '}
                  {formatAmount((selected.amount1 * BigInt(removePct)) / 100n, selected.token1.decimals, 4)} {selected.token1.symbol}
                  {removePct === 100 ? ' · 全撤后会 burn 空 NFT' : ''}
                </p>
                <button
                  className="btn danger"
                  disabled={busy}
                  onClick={() => {
                    const ok = window.confirm(
                      `确认移除 ${removePct}% 流动性？\n${selected.token0.symbol}/${selected.token1.symbol} #${selected.tokenId}`,
                    )
                    if (!ok) return
                    void run(selected.version === 'v4' ? '移除 V4' : '移除 LP', async () => {
                      const hash = selected.version === 'v4'
                        ? await removeV4Liquidity({
                          walletClient: wallet!,
                          owner: address!,
                          position: selected,
                          percent: removePct,
                          burnEmpty: removePct >= 100,
                        })
                        : await removeV3Liquidity({
                          walletClient: wallet!,
                          owner: address!,
                          position: selected,
                          percent: removePct,
                          burnEmpty: removePct >= 100,
                          slippageBps,
                          unwrapEth: addUseEth,
                        })
                      if (removePct >= 100) setSelectedId(null)
                      return { hash }
                    }, `${selected.token0.symbol}/${selected.token1.symbol}`)
                  }}
                >
                  撤出 {removePct}%{selected.version === 'v4' ? ' · V4' : ''}
                </button>
              </div>

            </div>
          )}
        </section>
      )}

      {tab === 'mint' && (
        <section className="panel">
          <div className="range-mode" style={{ marginBottom: 12 }}>
            <button type="button" className={`chip ${mintProtocol === 'v3' ? 'on' : ''}`} onClick={() => { setMintProtocol('v3'); setPool(null); setScannedPools([]); setShowCreatePool(false) }}>V3</button>
            <button type="button" className={`chip ${mintProtocol === 'v4' ? 'on' : ''}`} onClick={() => { setMintProtocol('v4'); setPool(null); setScannedPools([]); setShowCreatePool(false) }}>V4</button>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            {mintProtocol === 'v4'
              ? 'V4：优先匹配原生 ETH 池（address(0)）。勾选「直接付 ETH」时开仓用钱包原生 ETH，一笔完成，无需先 Wrap。'
              : <>Token 选 <strong>ETH</strong> 即可（链上池仍是 WETH）。勾选「直接付 ETH」后用钱包原生 ETH 开仓。示例：<code style={{ fontSize: 11 }}>0x7ad1eed380501e037a3207c3355de4a1be789559</code></>}
          </p>
          <div className="grid2">
            <label>
              币（要做 LP 的代币）
              <select value={tokenA} onChange={(e) => setTokenA(e.target.value as Address)}>
                {tokenOptions.map((t) => <option key={`a-${t.addr}`} value={t.addr}>{t.symbol}</option>)}
              </select>
            </label>
            <label>
              报价（通常选 ETH）
              <select value={tokenB} onChange={(e) => setTokenB(e.target.value as Address)}>
                {tokenOptions.map((t) => <option key={`b-${t.addr}`} value={t.addr}>{t.symbol}</option>)}
              </select>
            </label>
            <label>
              Fee tier
              <select
                value={fee}
                onChange={(e) => {
                  const f = Number(e.target.value)
                  setFee(f)
                  if (mintProtocol === 'v4') setV4TickSpacing(suggestV4TickSpacing(f))
                }}
              >
                {(mintProtocol === 'v4' ? V4_FEE_PRESETS : FEE_TIERS).map((f) => (
                  <option key={f} value={f}>{(f / 10000).toFixed(2)}%</option>
                ))}
              </select>
            </label>
            <label>
              自定义 Token → 币
              <div className="inline">
                <input value={customToken} onChange={(e) => setCustomToken(e.target.value)} placeholder="0x…" />
                <button className="btn" type="button" onClick={() => void addCustomToken()}>设为币</button>
              </div>
            </label>
          </div>
          <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
            将加载/创建：
            <strong>
              {tokenLabel(tokenA)}
              {' / '}
              {tokenLabel(tokenB)}
            </strong>
            {isEthLikeCurrency(tokenA) && !isEthLikeCurrency(tokenB)
              ? '（建议把 ETH 放在右侧「报价」）'
              : ''}
            。链上 token0/token1 会按地址自动排序，不影响币价口径。
          </p>
          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={() => void loadPoolByPair()}>按 Fee 加载</button>
            <button className="btn primary" disabled={busy} onClick={() => void scanPools()}>扫描全部 Fee</button>
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => {
                setShowCreatePool(true)
                setPool(null)
                if (mintProtocol === 'v4') {
                  setV4TickSpacing(suggestV4TickSpacing(fee))
                  setCustomFeeInput('')
                }
                setStatus(`填写初始价后创建 ${mintProtocol.toUpperCase()} 池（可同笔注入初仓）`)
              }}
            >
              创建 {mintProtocol.toUpperCase()} 池
            </button>
          </div>

          {showCreatePool && !pool && (
            <div className="mint-create">
              <div className="mint-create-title">
                创建 {mintProtocol.toUpperCase()} 池
                {seedOnCreate ? ' + 注入初仓（同笔交易）' : '（仅初始化）'}
              </div>
              <p className="muted" style={{ margin: '0 0 10px' }}>
                交易对：
                <strong>
                  {tokenLabel(tokenA)}/{tokenLabel(tokenB)}
                </strong>
                。可在上方粘贴 CA「设为币」后创建。
                {isEthLikeCurrency(tokenA) !== isEthLikeCurrency(tokenB) ? (
                  <> 初始<strong>币价</strong>单位：ETH per 币。</>
                ) : (
                  <> 初始价：报价 per 币。</>
                )}
              </p>

              {mintProtocol === 'v4' && (
                <div className="grid2" style={{ marginBottom: 8 }}>
                  <label>
                    V4 费率
                    <select
                      value={
                        (V4_FEE_PRESETS as readonly number[]).includes(fee) && !customFeeInput
                          ? fee
                          : -1
                      }
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        if (v < 0) return
                        setFee(v)
                        setCustomFeeInput('')
                        setV4TickSpacing(suggestV4TickSpacing(v))
                      }}
                    >
                      {V4_FEE_PRESETS.map((f) => (
                        <option key={f} value={f}>{(f / 10000).toFixed(2)}%</option>
                      ))}
                      <option value={-1}>自定义…</option>
                    </select>
                  </label>
                  <label>
                    自定义费率 %
                    <input
                      value={customFeeInput}
                      onChange={(e) => {
                        setCustomFeeInput(e.target.value)
                        const pct = Number(e.target.value.replace(/%/g, '').trim())
                        if (pct > 0 && Number.isFinite(pct)) {
                          const f = Math.round(pct * 10000)
                          setFee(f)
                          setV4TickSpacing(suggestV4TickSpacing(f))
                        }
                      }}
                      placeholder="如 0.25 → 0.25%"
                      inputMode="decimal"
                    />
                  </label>
                  <label>
                    tickSpacing
                    <input
                      type="number"
                      value={v4TickSpacing}
                      min={1}
                      max={16384}
                      onChange={(e) => setV4TickSpacing(Math.max(1, Number(e.target.value) || 1))}
                    />
                  </label>
                  <label className="inline-setting check" style={{ alignSelf: 'end', marginBottom: 8 }}>
                    <input type="checkbox" checked={useNativeEth} onChange={(e) => setUseNativeEth(e.target.checked)} />
                    ETH 用原生币（非 WETH）
                  </label>
                </div>
              )}

              <div className="grid2">
                <label>
                  {isEthLikeCurrency(tokenA) !== isEthLikeCurrency(tokenB)
                    ? `初始币价（ETH per ${isEthLikeCurrency(tokenA) ? (tokenOptions.find((x) => x.addr === tokenB)?.symbol ?? '币') : (tokenOptions.find((x) => x.addr === tokenA)?.symbol ?? '币')}）`
                    : '初始价格（报价 per 币）'}
                  <input
                    value={initPrice}
                    onChange={(e) => setInitPrice(e.target.value)}
                    placeholder={isEthLikeCurrency(tokenA) !== isEthLikeCurrency(tokenB) ? '例如 0.0003' : '例如 1'}
                    inputMode="decimal"
                  />
                </label>
                {mintProtocol === 'v3' && (
                  <label>
                    Fee
                    <input value={`${(fee / 10000).toFixed(2)}%`} disabled />
                  </label>
                )}
              </div>

              <label className="inline-setting check" style={{ margin: '12px 0 8px' }}>
                <input type="checkbox" checked={seedOnCreate} onChange={(e) => setSeedOnCreate(e.target.checked)} />
                同时注入初仓（与创建同笔发送）
              </label>

              {seedOnCreate && (
                <>
                  <div className="mint-preset-row" style={{ marginBottom: 8 }}>
                    <span className="mint-preset-label">区间</span>
                    <div className="chip-row">
                      <button
                        type="button"
                        className={`chip ${createRangePreset === 'onesided-eth' ? 'on' : ''}`}
                        onClick={() => {
                          setCreateRangePreset('onesided-eth')
                          const { percentLower: lo, percentUpper: hi } = oneSidedEthPercents()
                          setPercentLower(lo)
                          setPercentUp(hi)
                        }}
                      >
                        单边 ETH
                      </button>
                      <button
                        type="button"
                        className={`chip ${createRangePreset === 'full' ? 'on' : ''}`}
                        onClick={() => setCreateRangePreset('full')}
                      >
                        全区间
                      </button>
                      {[5, 10, 20, 30, 50].map((n) => (
                        <button
                          key={`create-bi-${n}`}
                          type="button"
                          className={`chip ${createRangePreset === n ? 'on' : ''}`}
                          onClick={() => {
                            setCreateRangePreset(n)
                            setPercentLower(-n)
                            setPercentUp(n)
                          }}
                        >
                          ±{n}%
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="muted" style={{ margin: '0 0 8px', fontSize: 12 }}>
                    {createRangePreset === 'onesided-eth'
                      ? '单边 ETH：区间在市价下方，创建时通常只需付 ETH。'
                      : createRangePreset === 'full'
                        ? '全区间：覆盖全部价格，需同时准备两侧代币（按初始价比例）。'
                        : `双边 ±${createRangePreset}%：区间围绕初始价，通常需两侧代币。`}
                    {createSynth && initPrice.trim() ? (
                      <> 填<strong>一边数量</strong>，另一边按初始价+区间自动配平。</>
                    ) : (
                      <> 请先填好上方初始价。</>
                    )}
                    {mintProtocol === 'v3' && (
                      <> V3 链上用 WETH，可直接付 ETH（自动 Wrap）。</>
                    )}
                  </p>
                  <div className="grid2">
                    <label>
                      {tokenLabel(tokenA)} 数量
                      {createRangePreset === 'onesided-eth' && isEthLikeCurrency(tokenA)
                        ? '（单边）'
                        : createRangePreset === 'onesided-eth' && isEthLikeCurrency(tokenB)
                          ? '（不需要）'
                          : ''}
                      <span className="bal-hint">余额 {formatAmount(createSeedBalA, createSynth?.decA ?? 18, 6)}</span>
                      <input
                        value={seedAmtA}
                        onChange={(e) => onCreateSeedSide('A', e.target.value)}
                        disabled={
                          !createSynth
                          || (createRangePreset === 'onesided-eth'
                          && isEthLikeCurrency(tokenB)
                          && !isEthLikeCurrency(tokenA))
                        }
                        placeholder={createSynth ? '填数量' : '先填初始价'}
                        inputMode="decimal"
                      />
                    </label>
                    <label>
                      {tokenLabel(tokenB)} 数量
                      {createRangePreset === 'onesided-eth' && isEthLikeCurrency(tokenB)
                        ? '（单边）'
                        : createRangePreset === 'onesided-eth' && isEthLikeCurrency(tokenA)
                          ? '（不需要）'
                          : ''}
                      <span className="bal-hint">余额 {formatAmount(createSeedBalB, createSynth?.decB ?? 18, 6)}</span>
                      <input
                        value={seedAmtB}
                        onChange={(e) => onCreateSeedSide('B', e.target.value)}
                        disabled={
                          !createSynth
                          || (createRangePreset === 'onesided-eth'
                          && isEthLikeCurrency(tokenA)
                          && !isEthLikeCurrency(tokenB))
                        }
                        placeholder={createSynth ? '填数量' : '先填初始价'}
                        inputMode="decimal"
                      />
                    </label>
                  </div>
                  <div className="chip-row">
                    {[25, 50, 75, 100].map((n) => (
                      <button
                        key={`seed-${n}`}
                        type="button"
                        className="chip"
                        disabled={!address || !createSynth}
                        onClick={() => fillCreateSeedBalances(n)}
                      >
                        {n === 100 ? 'Max' : `${n}%`}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <div className="btn-row" style={{ marginTop: 10 }}>
                <button className="btn primary" disabled={busy || !address} onClick={() => void createPool()}>
                  {!address ? '先连接钱包' : seedOnCreate ? '创建并注入流动性' : '创建并初始化'}
                </button>
                <button className="btn" type="button" disabled={busy} onClick={() => setShowCreatePool(false)}>取消</button>
              </div>
            </div>
          )}

          {scannedPools.length > 1 && (
            <div className="chip-row">
              {scannedPools.map((p) => (
                <button
                  key={p.poolAddress ?? `${p.fee}-${p.tick}`}
                  type="button"
                  className={`chip ${pool?.poolAddress === p.poolAddress ? 'on' : ''}`}
                  onClick={() => {
                    setPool(p)
                    setFee(p.fee)
                    applyDefaultCoinRange(p, setPriceLo, setPriceHi)
                  }}
                >
                  {(p.fee / 10000).toFixed(2)}% · {formatPrice(getCoinQuote(p).spot)}
                </button>
              ))}
            </div>
          )}

          <label className="full">
            或粘贴 V3 池地址 / V4 poolId / 池子链接
            <div className="inline">
              <input
                value={poolInput}
                onChange={(e) => setPoolInput(e.target.value)}
                placeholder="0x… 或 Uniswap / Blockscout 链接"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void loadPoolByAddress()
                }}
              />
              <button className="btn" disabled={busy} onClick={() => void loadPoolByAddress()}>加载</button>
            </div>
          </label>

          {pool && (
            <>
              <div className="mint-pool">
                <div className="mint-pool-top">
                  <div>
                    <div className="mint-pair">{getCoinQuote(pool).coin.symbol} / {getCoinQuote(pool).quote.symbol}</div>
                    <div className="mint-meta">Fee {(pool.fee / 10000).toFixed(2)}% · {pool.version.toUpperCase()}</div>
                  </div>
                  <button className="btn" type="button" disabled={busy} onClick={() => void refreshPoolPrice()}>
                    刷新币价
                  </button>
                </div>
                <div className="mint-spot">
                  <span className="mint-spot-label">当前币价</span>
                  <strong className="mint-spot-val">
                    {formatPrice(rangePreview?.coinSpot ?? getCoinQuote(pool).spot)}
                  </strong>
                  <span className="mint-spot-unit">
                    {rangePreview?.quoteSymbol ?? getCoinQuote(pool).quote.symbol}
                    {' per '}
                    {rangePreview?.coinSymbol ?? getCoinQuote(pool).coin.symbol}
                  </span>
                </div>
              </div>

              <div className={`mint-range ${rangePreview?.inRangePreview === false ? 'out' : 'in'}`}>
                <div className="mint-range-head">
                  <h3>设置币价区间</h3>
                  <div className="range-mode">
                    <button type="button" className={`chip ${rangeMode === 'percent' ? 'on' : ''}`} onClick={() => setRangeMode('percent')}>按 %</button>
                    <button type="button" className={`chip ${rangeMode === 'custom' ? 'on' : ''}`} onClick={() => setRangeMode('custom')}>自定义价</button>
                    <button type="button" className={`chip ${rangeMode === 'full' ? 'on' : ''}`} onClick={() => setRangeMode('full')}>全区间</button>
                  </div>
                </div>

                {rangeMode === 'full' ? (
                  <p className="mint-full-hint">全区间：使用当前池 tickSpacing 对齐的最小/最大 tick，V3/V4 均适用。流动性覆盖全部价格。</p>
                ) : rangeMode === 'percent' ? (
                  <>
                    <div className="mint-presets">
                      <div className="chip-row">
                        <button
                          type="button"
                          className={`chip ${percentLower === -75 && percentUp === -3 ? 'on' : ''}`}
                          onClick={() => {
                            // 币价口径固定 -75%~-3%，ETH 在 token0/token1 都能单边付 ETH
                            const { percentLower: lo, percentUpper: hi } = oneSidedEthPercents()
                            setPercentLower(lo)
                            setPercentUp(hi)
                            setRangeMode('percent')
                          }}
                        >
                          单边 ETH
                        </button>
                      </div>
                      <div className="mint-preset-row">
                        <span className="mint-preset-label">双边</span>
                        <div className="chip-row">
                          {[5, 10, 20, 30, 40, 50].map((n) => (
                            <button
                              key={`bi-${n}`}
                              type="button"
                              className={`chip ${percentLower === -n && percentUp === n ? 'on' : ''}`}
                              onClick={() => {
                                setPercentLower(-n)
                                setPercentUp(n)
                                setRangeMode('percent')
                              }}
                            >
                              ±{n}%
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="mint-preset-row">
                        <span className="mint-preset-label">单边</span>
                        <div className="chip-row">
                          {[100, 200, 300, 500].map((up) => (
                            <button
                              key={`side-${up}`}
                              type="button"
                              className={`chip ${percentLower === -50 && percentUp === up ? 'on' : ''}`}
                              onClick={() => {
                                setPercentLower(-50)
                                setPercentUp(up)
                                setRangeMode('percent')
                              }}
                            >
                              -50%/+{up}%
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="mint-pct-grid">
                      <label className="mint-pct-field">
                        <span className="mint-pct-label">下限 · 相对币价</span>
                        <div className="mint-pct-input">
                          <SoftNumberInput
                            value={percentLower}
                            min={-99.9}
                            max={100000}
                            onCommit={(lo) => {
                              setPercentLower(lo)
                              if (percentUp <= lo) setPercentUp(Math.min(lo + 0.1, 100000))
                            }}
                          />
                          <span className="mint-pct-suffix">%</span>
                        </div>
                        <span className="mint-pct-price">
                          ≈ {formatPrice(rangePreview?.coinPriceLower ?? getCoinQuote(pool).spot * (1 + percentLower / 100))}
                        </span>
                      </label>
                      <label className="mint-pct-field">
                        <span className="mint-pct-label">上限 · 相对币价</span>
                        <div className="mint-pct-input">
                          <SoftNumberInput
                            value={percentUp}
                            min={-99.9}
                            max={100000}
                            onCommit={(v) => {
                              const minUp = percentLower + 0.01
                              setPercentUp(Math.min(100000, Math.max(minUp, v)))
                            }}
                          />
                          <span className="mint-pct-suffix">%</span>
                        </div>
                        <span className="mint-pct-price">
                          ≈ {formatPrice(rangePreview?.coinPriceUpper ?? getCoinQuote(pool).spot * (1 + percentUp / 100))}
                        </span>
                      </label>
                    </div>
                  </>
                ) : (
                  <div className="mint-pct-grid">
                    <label className="mint-pct-field">
                      <span className="mint-pct-label">币价下限</span>
                      <div className="mint-pct-input">
                        <input value={priceLo} onChange={(e) => setPriceLo(e.target.value)} inputMode="decimal" />
                      </div>
                    </label>
                    <label className="mint-pct-field">
                      <span className="mint-pct-label">币价上限</span>
                      <div className="mint-pct-input">
                        <input value={priceHi} onChange={(e) => setPriceHi(e.target.value)} inputMode="decimal" />
                      </div>
                    </label>
                  </div>
                )}

                {rangePreview && (() => {
                  const coinLo = rangePreview.coinPriceLower
                  const coinHi = rangePreview.coinPriceUpper
                  const coinSpot = rangePreview.coinSpot
                  const span = Math.max(coinHi - coinLo, 1e-18)
                  const rawMarker = ((coinSpot - coinLo) / span) * 100
                  const needToken0 = pool.tick < rangePreview.tickLower
                  const needToken1 = pool.tick >= rangePreview.tickUpper
                  const singleSym = needToken0 ? label0 : needToken1 ? label1 : null
                  const coinBelow = coinHi < coinSpot
                  const marker = coinBelow ? 108 : coinLo > coinSpot ? -8 : Math.max(4, Math.min(96, rawMarker))
                  const statusText = rangeMode === 'full'
                    ? '全区间 · 覆盖全部价格'
                    : rangePreview.inRangePreview
                    ? '双边 · 币价在区间内'
                    : `单边 · 币价区间${coinBelow ? '低于' : '高于'}市价，只需 ${singleSym}`
                  return (
                    <div className="mint-range-viz">
                      <div className={`mint-range-banner ${rangePreview.inRangePreview ? 'ok' : 'side'}`}>
                        {statusText}
                      </div>
                      <div className="mint-range-track">
                        <div className="mint-range-fill" />
                        <div
                          className={`mint-range-marker ${!rangePreview.inRangePreview ? 'outside' : ''}`}
                          style={{ left: `${marker}%` }}
                          title="币价"
                        />
                      </div>
                      <div className="mint-range-ends">
                        <div>
                          <span className="mint-end-k">下限</span>
                          <span className="mint-end-v">{formatPrice(coinLo)}</span>
                        </div>
                        <div className="mint-end-mid">
                          <span className="mint-end-k">币价</span>
                          <span className="mint-end-v">{formatPrice(coinSpot)}</span>
                        </div>
                        <div className="right">
                          <span className="mint-end-k">上限</span>
                          <span className="mint-end-v">{formatPrice(coinHi)}</span>
                        </div>
                      </div>
                      <details className="mint-advanced">
                        <summary>技术细节</summary>
                        <p>
                          ticks [{rangePreview.tickLower}, {rangePreview.tickUpper}]
                          {' · '}spacing {pool.tickSpacing}
                          {pool.poolAddress ? ` · ${shortAddr(pool.poolAddress)}` : ''}
                        </p>
                      </details>
                    </div>
                  )
                })()}
              </div>

              {poolUsesWeth && (
                <label className="inline-setting check" style={{ marginBottom: 10 }}>
                  <input type="checkbox" checked={useNativeEth} onChange={(e) => setUseNativeEth(e.target.checked)} />
                  {mintProtocol === 'v4' || pool?.version === 'v4'
                    ? '直接付 ETH 铸造（原生 ETH 池 · 一笔 value，不经 WETH）'
                    : '直接付 ETH 铸造（Uniswap 会自动 Wrap 成 WETH）'}
                </label>
              )}

              <div className="grid2">
                <label>
                  {label0}
                  <span className="bal-hint">余额 {formatAmount(showBal0, pool.token0.decimals, 6)}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={amount0}
                    onChange={(e) => onMintSide(0, e.target.value)}
                    placeholder={
                      rangePreview && pool.tick >= rangePreview.tickUpper
                        ? '此区间不需要'
                        : '填数量'
                    }
                    disabled={Boolean(rangePreview && pool.tick >= rangePreview.tickUpper)}
                  />
                </label>
                <label>
                  {label1}
                  <span className="bal-hint">余额 {formatAmount(showBal1, pool.token1.decimals, 6)}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={amount1}
                    onChange={(e) => onMintSide(1, e.target.value)}
                    placeholder={
                      rangePreview && pool.tick < rangePreview.tickLower
                        ? '此区间不需要'
                        : '填数量'
                    }
                    disabled={Boolean(rangePreview && pool.tick < rangePreview.tickLower)}
                  />
                </label>
              </div>
              <p className="muted" style={{ marginTop: 0 }}>
                {rangePreview && !rangePreview.inRangePreview
                  ? (
                    pool.tick < rangePreview.tickLower
                      ? `单边：只需 ${label0}。`
                      : `单边：只需 ${label1}。`
                  )
                  : '填一边即可，另一边按区间配平；用 ETH 时请留一点付 gas。'}
              </p>
              <div className="chip-row">
                {[25, 50, 75, 100].map((n) => (
                  <button key={n} type="button" className="chip" disabled={!address || !mintTicks} onClick={() => fillBalances(n)}>
                    {n === 100 ? 'Max' : `${n}%`}
                  </button>
                ))}
              </div>
              <div className="btn-row">
                <button
                  className="btn primary"
                  disabled={!address || !wallet || busy || !mintTicks}
                  onClick={() => {
                    if (!pool || !mintTicks) return
                    const a0 = amount0 || '0'
                    const a1 = amount1 || '0'
                    if (parseAmount(a0, pool.token0.decimals) === 0n && parseAmount(a1, pool.token1.decimals) === 0n) {
                      setStatus('请先输入数量')
                      return
                    }
                    if (pool.version === 'v4' || mintProtocol === 'v4') {
                      void run('Mint V4', () => mintV4Position({
                        walletClient: wallet!,
                        owner: address!,
                        pool,
                        amount0: parseAmount(a0, pool.token0.decimals),
                        amount1: parseAmount(a1, pool.token1.decimals),
                        tickLower: mintTicks.tickLower,
                        tickUpper: mintTicks.tickUpper,
                        useNativeEth: mintUseEth,
                        slippageBps,
                      }), `${pool.token0.symbol}/${pool.token1.symbol}`)
                      return
                    }
                    void run('Mint', () => mintV3Position({
                      walletClient: wallet!,
                      owner: address!,
                      pool,
                      amount0: parseAmount(a0, pool.token0.decimals),
                      amount1: parseAmount(a1, pool.token1.decimals),
                      tickLower: mintTicks.tickLower,
                      tickUpper: mintTicks.tickUpper,
                      useNativeEth: mintUseEth,
                    }), `${pool.token0.symbol}/${pool.token1.symbol}`)
                  }}
                >
                  Mint {pool?.version === 'v4' || mintProtocol === 'v4' ? 'V4' : 'V3'} 开仓{mintUseEth ? '（ETH）' : ''}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {tab === 'tools' && (
        <section className="panel">
          <h2>ETH ↔ WETH</h2>
          <p className="muted">做 LP 前可把 ETH wrap 成 WETH。余额：{formatAmount(ethBal, 18, 5)} ETH / {formatAmount(wethBal, 18, 5)} WETH</p>
          <label>
            数量
            <input value={wrapAmt} onChange={(e) => setWrapAmt(e.target.value)} placeholder="0.0" />
          </label>
          <div className="chip-row">
            <button type="button" className="chip" onClick={() => setWrapAmt(formatAmountExact(ethBal / 2n, 18))}>一半 ETH</button>
            <button type="button" className="chip" onClick={() => setWrapAmt(formatAmountExact(ethBal > 10n ** 15n ? ethBal - 10n ** 15n : 0n, 18))}>Max ETH（留 gas）</button>
            <button type="button" className="chip" onClick={() => setWrapAmt(formatAmountExact(wethBal, 18))}>Max WETH</button>
          </div>
          <div className="btn-row">
            <button
              className="btn primary"
              disabled={!address || busy}
              onClick={() => void run('Wrap ETH', () => wrapEth({
                walletClient: wallet!,
                owner: address!,
                amount: parseAmount(wrapAmt || '0', 18),
              }))}
            >
              Wrap → WETH
            </button>
            <button
              className="btn"
              disabled={!address || busy}
              onClick={() => void run('Unwrap WETH', () => unwrapWeth({
                walletClient: wallet!,
                owner: address!,
                amount: parseAmount(wrapAmt || '0', 18),
              }))}
            >
              Unwrap → ETH
            </button>
          </div>
          <hr className="sep" />
          <h2>清理空 V3 仓位 NFT</h2>
          <p className="muted">
            撤出流动性后 NFT 可能仍留在钱包（如 #107661），刷新列表会隐藏它们，但链上仍占一个 NFT 槽位。
          </p>
          <div className="btn-row">
            <button
              className="btn"
              type="button"
              disabled={!address || busy}
              onClick={() => void run('扫描空 NFT', async () => {
                const ids = await listVacantV3TokenIds(address!)
                setVacantV3Ids(ids)
                setStatus(`发现 ${ids.length} 个可销毁的空 V3 NFT`)
              })}
            >
              扫描空 NFT
            </button>
            <button
              className="btn primary"
              type="button"
              disabled={!address || !wallet || busy || vacantV3Ids === null || vacantV3Ids.length === 0}
              onClick={() => void run('销毁空 NFT', async () => {
                const { burned, failed } = await burnVacantV3Nfts({
                  walletClient: wallet!,
                  owner: address!,
                  onStatus: setStatus,
                })
                setVacantV3Ids(failed.length ? failed : [])
                await refreshPositions({ silent: true })
                setStatus(`已销毁 ${burned.length} 个空 NFT${failed.length ? `，${failed.length} 个失败` : ''}`)
              })}
            >
              销毁全部空 NFT{vacantV3Ids?.length ? ` (${vacantV3Ids.length})` : ''}
            </button>
          </div>
          {vacantV3Ids && vacantV3Ids.length > 0 && (
            <p className="muted mono" style={{ marginTop: 8 }}>
              {vacantV3Ids.map((id) => `#${id.toString()}`).join(', ')}
            </p>
          )}
          <hr className="sep" />
          <h2>常用链接</h2>
          <ul className="link-list">
            <li><a href={explorerAddress(CONTRACTS.v3Npm)} target="_blank" rel="noreferrer">V3 Position Manager</a></li>
            <li><a href={explorerAddress(CONTRACTS.weth)} target="_blank" rel="noreferrer">WETH</a></li>
            <li><a href={explorerAddress(CONTRACTS.stable)} target="_blank" rel="noreferrer">{chainId === 8453 ? 'USDC' : 'USDG'}</a></li>
            <li><a href={chainCfg.explorerUrl} target="_blank" rel="noreferrer">{chainCfg.chain.blockExplorers?.default.name ?? '浏览器'}</a></li>
          </ul>
        </section>
      )}

      {tab === 'history' && (
        <section className="panel">
          <div className="row between">
            <h2>本地交易历史</h2>
            <button className="btn" type="button" onClick={() => { clearTxHistory(); setTxHistory([]) }}>清空</button>
          </div>
          <p className="muted">仅保存在本机 localStorage，不会上链。</p>
          {txHistory.length === 0 ? (
            <p className="muted">暂无记录</p>
          ) : (
            <ul className="tx-list">
              {txHistory.map((t) => (
                <li key={t.id}>
                  <div>
                    <strong>{t.label}</strong>
                    {t.pair ? <span className="muted"> · {t.pair}</span> : null}
                    <div className="muted mono">{new Date(t.at).toLocaleString()}</div>
                  </div>
                  <a href={explorerTx(t.hash)} target="_blank" rel="noreferrer">{shortAddr(t.hash)} ↗</a>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <footer>
        <p>{chainCfg.label} · Uniswap V3 NPM <code>{CONTRACTS.v3Npm}</code></p>
        <p>半自动工具：V3 + V4（modifyLiquidities / Permit2）。无人值守 keeper 后续再加。</p>
      </footer>
    </div>
  )
}
