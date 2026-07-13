import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Address, WalletClient } from 'viem'
import { isAddress } from 'viem'
import { CONTRACTS, FEE_TIERS, KNOWN_TOKENS } from './chain'
import {
  claimV3,
  claimV4,
  createV3Pool,
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
  loadV3Pool,
  loadV3Positions,
  loadV4Positions,
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
  unwrapWeth,
  wrapEth,
  type PoolInfo,
  type PositionRow,
} from './lp'
import { parseAmount, formatPrice, formatUsd, pairAmountForRange, formatAmountExact } from './math'
import {
  connectWallet,
  explorerAddress,
  explorerTx,
  makeWalletClient,
  shortAddr,
} from './wallet'
import { clearTxHistory, loadTxHistory, pushTxHistory, type TxRecord } from './history'
import './App.css'

type SortKey = 'value' | 'fees' | 'pnl' | 'pair'
type FilterKey = 'all' | 'in' | 'out' | 'v3' | 'v4'
type RangeMode = 'percent' | 'custom'

function formatPnl(n: number): string {
  if (!Number.isFinite(n)) return '-'
  const sign = n > 0 ? '+' : ''
  return `${sign}${formatUsd(n)}`
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
  const [busy, setBusy] = useState(false)
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

  const [tokenA, setTokenA] = useState<Address>(CONTRACTS.weth)
  const [tokenB, setTokenB] = useState<Address>(CONTRACTS.usdg)
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

  const [wrapAmt, setWrapAmt] = useState('')

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

  const refreshPositions = useCallback(async () => {
    if (!address) return
    setBusy(true)
    setStatus('刷新仓位中…')
    setStatusHash(null)
    try {
      const [v3, v4] = await Promise.all([loadV3Positions(address), loadV4Positions(address)])
      const all = [...v3, ...v4]
      setPositions(all)
      setStatus(`共 ${all.length} 个仓位（V3 ${v3.length} / V4 ${v4.length}）`)
      setSelectedId((prev) => {
        if (prev && all.some((p) => `${p.version}-${p.tokenId}` === prev)) return prev
        return all.length ? `${all[0].version}-${all[0].tokenId}` : null
      })
      await refreshBalances(address)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [address, refreshBalances])

  useEffect(() => {
    if (address) void refreshPositions()
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
    const onChain = (chainId: unknown) => {
      const id = Number(chainId as string)
      if (id !== 4663) setStatus('请切换到 Robinhood Chain (4663)')
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
    const t = setInterval(() => void refreshPositions(), 60_000)
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
          setShowCreatePool(false)
          setStatus('该 fee 无 V4 池（已试 WETH/原生 ETH + 常见 tickSpacing）')
          return
        }
        setPool(info)
        setShowCreatePool(false)
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

  const createPool = async () => {
    if (mintProtocol !== 'v3') return
    if (!address || !wallet) {
      setStatus('请先连接钱包')
      return
    }
    const price = Number(initPrice.replace(/,/g, ''))
    if (!(price > 0)) {
      setStatus('请填写有效的初始价格（Token B per Token A）')
      return
    }
    setBusy(true)
    setStatusHash(null)
    setStatus('创建 / 初始化 V3 池…')
    try {
      const { pool: info, hash, created } = await createV3Pool({
        walletClient: wallet,
        owner: address,
        tokenA,
        tokenB,
        fee,
        initialPriceBPerA: price,
      })
      setPool(info)
      setShowCreatePool(false)
      applyDefaultCoinRange(info, setPriceLo, setPriceHi)
      if (hash) {
        setStatusHash(hash)
        setTxHistory(pushTxHistory({
          label: created ? '创建 V3 池' : '初始化 V3 池',
          hash,
          pair: `${info.token0.symbol}/${info.token1.symbol}`,
        }))
      }
      const q = getCoinQuote(info)
      setStatus(
        created
          ? `V3 池已创建 · ${shortAddr(info.poolAddress!)} · 币价 ${formatPrice(q.spot)}`
          : `池已存在，已加载 · ${shortAddr(info.poolAddress!)} · 币价 ${formatPrice(q.spot)}`,
      )
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const loadPoolByAddress = async () => {
    if (!poolInput.trim()) return
    setBusy(true)
    try {
      const info = await loadV3Pool(poolInput.trim() as Address)
      setPool(info)
      setTokenA(info.token0.address)
      setTokenB(info.token1.address)
      setFee(info.fee)
      applyDefaultCoinRange(info, setPriceLo, setPriceHi)
      setStatus(`已加载 V3 池，现价 ${formatPrice(info.price)}`)
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
        const info = await findV4Pool(pool.token0.address, pool.token1.address, pool.fee)
        if (!info) throw new Error('刷新 V4 池失败')
        setPool(info)
        setStatus(`V4 价格已刷新 · 现价 ${formatPrice(info.price)}`)
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
        if (rangeMode === 'percent') {
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

      setStatus(`价格已刷新 · 现价 ${formatPrice(info.price)} ${info.token1.symbol}/${info.token0.symbol} · tick ${info.tick}`)
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
      setTokenB(meta.address)
      setStatus(`已设置 Token B = ${meta.symbol} (${shortAddr(meta.address)})`)
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
      await refreshPositions()
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
    const base = Object.entries(KNOWN_TOKENS).map(([addr, t]) => ({
      addr: addr as Address,
      ...t,
      // 池子仍是 WETH，界面显示 ETH（可直接付原生 ETH）
      symbol: addr.toLowerCase() === weth ? 'ETH' : t.symbol,
    }))
    const extra: { addr: Address; symbol: string; decimals: number }[] = []
    if (tokenA && !KNOWN_TOKENS[tokenA.toLowerCase()]) {
      extra.push({ addr: tokenA, symbol: shortAddr(tokenA), decimals: 18 })
    }
    if (tokenB && !KNOWN_TOKENS[tokenB.toLowerCase()]) {
      extra.push({ addr: tokenB, symbol: shortAddr(tokenB), decimals: 18 })
    }
    return [...base, ...extra]
  }, [tokenA, tokenB])

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
          <h1>Uniswap LP · Robinhood Chain</h1>
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
                <button className="btn" disabled={busy} onClick={() => void refreshPositions()}>刷新</button>
                <button className="btn" onClick={disconnect}>断开</button>
              </div>
            </>
          ) : (
            <button className="btn primary" disabled={busy} onClick={() => void connect()}>连接钱包</button>
          )}
        </div>
      </header>

      <div className={`status-bar ${busy ? 'busy' : ''}`}>
        <span>{status || '连接钱包（MetaMask/Rabby），切到 Robinhood Chain (4663）'}</span>
        {statusHash && (
          <a href={explorerTx(statusHash)} target="_blank" rel="noreferrer">查看交易 ↗</a>
        )}
      </div>

      <div className="settings-row">
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
                const feeUsd = p.fees0Usd + p.fees1Usd
                const hasFees = p.fees0 > 0n || p.fees1 > 0n
                const feePct0 = feeUsd > 0 ? (p.fees0Usd / feeUsd) * 100 : hasFees ? 50 : 0
                const feePct1 = feeUsd > 0 ? (p.fees1Usd / feeUsd) * 100 : hasFees ? 50 : 0
                const rangeSpan = Math.max(p.priceUpper - p.priceLower, 1e-18)
                const rangeMarker = Math.max(0, Math.min(100, ((p.price - p.priceLower) / rangeSpan) * 100))
                const priceUnit = `${p.token1.symbol}/${p.token0.symbol}`
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
                    <div className="pos-pair">{p.token0.symbol} / {p.token1.symbol}</div>
                    <div className="pos-total">{formatUsd(p.totalUsd)}</div>
                    <div className={`pos-pnl ${p.pnlUsd >= 0 ? 'up' : 'down'}`}>
                      PnL {formatPnl(p.pnlUsd)}
                      <span className="pos-pnl-sub">
                        费 {formatUsd(p.totalFeesUsd)} (未领 {formatUsd(p.fees0Usd + p.fees1Usd)} / 已领 {formatUsd(p.claimedFeesUsd)})
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
                        <span className="asset-left">已领</span>
                        <span className="asset-right mono">{formatUsd(p.claimedFeesUsd)}</span>
                      </div>
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
                        <span className="range-now">现价 {formatPrice(p.price)}</span>
                      </div>
                      <div className="range-track">
                        <div className="range-fill" />
                        <div className="range-marker" style={{ left: `${rangeMarker}%` }} />
                      </div>
                      <div className="range-ends">
                        <div className="range-end">
                          <span className="range-end-label">下限</span>
                          <span className="range-end-val">{formatPrice(p.priceLower)}</span>
                        </div>
                        <div className="range-end right">
                          <span className="range-end-label">上限</span>
                          <span className="range-end-val">{formatPrice(p.priceUpper)}</span>
                        </div>
                      </div>
                      <div className="range-unit">{priceUnit}</div>
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
              ? 'V4：按交易对 + Fee 探测池（hooks=0）。WETH 池勾选原生 ETH 时会先 Wrap 再经 Permit2 入池。'
              : <>Token 选 <strong>ETH</strong> 即可（链上池仍是 WETH）。勾选「直接付 ETH」后用钱包原生 ETH 开仓。示例：<code style={{ fontSize: 11 }}>0x7ad1eed380501e037a3207c3355de4a1be789559</code></>}
          </p>
          <div className="grid2">
            <label>
              Token A
              <select value={tokenA} onChange={(e) => setTokenA(e.target.value as Address)}>
                {tokenOptions.map((t) => <option key={t.addr} value={t.addr}>{t.symbol}</option>)}
              </select>
            </label>
            <label>
              Token B
              <select value={tokenB} onChange={(e) => setTokenB(e.target.value as Address)}>
                {tokenOptions.map((t) => <option key={t.addr} value={t.addr}>{t.symbol}</option>)}
              </select>
            </label>
            <label>
              Fee tier
              <select value={fee} onChange={(e) => setFee(Number(e.target.value))}>
                {FEE_TIERS.map((f) => <option key={f} value={f}>{(f / 10000).toFixed(2)}%</option>)}
              </select>
            </label>
            <label>
              自定义 Token 地址 → B
              <div className="inline">
                <input value={customToken} onChange={(e) => setCustomToken(e.target.value)} placeholder="0x…" />
                <button className="btn" type="button" onClick={() => void addCustomToken()}>设为 B</button>
              </div>
            </label>
          </div>
          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={() => void loadPoolByPair()}>按 Fee 加载</button>
            <button className="btn primary" disabled={busy} onClick={() => void scanPools()}>扫描全部 Fee</button>
            {mintProtocol === 'v3' && (
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => {
                  setShowCreatePool(true)
                  setPool(null)
                  setStatus('填写初始价后创建 V3 池')
                }}
              >
                创建 V3 池
              </button>
            )}
          </div>

          {mintProtocol === 'v3' && showCreatePool && !pool && (
            <div className="mint-create">
              <div className="mint-create-title">池不存在时创建并初始化</div>
              <p className="muted" style={{ margin: '0 0 10px' }}>
                初始价单位：Token B / Token A（当前为{' '}
                {tokenOptions.find((x) => x.addr === tokenB)?.symbol ?? 'B'}
                {' per '}
                {tokenOptions.find((x) => x.addr === tokenA)?.symbol ?? 'A'}
                ）。
              </p>
              <div className="grid2">
                <label>
                  初始价格（B per A）
                  <input
                    value={initPrice}
                    onChange={(e) => setInitPrice(e.target.value)}
                    placeholder="例如 3000"
                    inputMode="decimal"
                  />
                </label>
                <label>
                  Fee
                  <input value={`${(fee / 10000).toFixed(2)}%`} disabled />
                </label>
              </div>
              <div className="btn-row" style={{ marginTop: 10 }}>
                <button className="btn primary" disabled={busy || !address} onClick={() => void createPool()}>
                  {!address ? '先连接钱包' : '创建并初始化'}
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
            或粘贴 V3 Pool 地址
            <div className="inline">
              <input value={poolInput} onChange={(e) => setPoolInput(e.target.value)} placeholder="0x…" />
              <button className="btn" disabled={busy} onClick={() => void loadPoolByAddress()}>加载</button>
            </div>
          </label>

          {pool && (
            <>
              <div className="mint-pool">
                <div className="mint-pool-top">
                  <div>
                    <div className="mint-pair">{pool.token0.symbol} / {pool.token1.symbol}</div>
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
                  </div>
                </div>

                {rangeMode === 'percent' ? (
                  <>
                    <div className="mint-presets">
                      <div className="chip-row">
                        <button
                          type="button"
                          className={`chip ${percentLower === -75 && percentUp === -1 ? 'on' : ''}`}
                          onClick={() => {
                            const eth0 = isEthLikeCurrency(pool.token0.address)
                            // 单边 ETH：默认币价 -75% ~ -1%
                            if (eth0) { setPercentLower(-75); setPercentUp(-1) }
                            else { setPercentLower(1); setPercentUp(75) }
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
                  const statusText = rangePreview.inRangePreview
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
                  直接付 ETH 铸造（Uniswap 会自动 Wrap 成 WETH）
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
          <h2>常用链接</h2>
          <ul className="link-list">
            <li><a href={explorerAddress(CONTRACTS.v3Npm)} target="_blank" rel="noreferrer">V3 Position Manager</a></li>
            <li><a href={explorerAddress(CONTRACTS.weth)} target="_blank" rel="noreferrer">WETH</a></li>
            <li><a href={explorerAddress(CONTRACTS.usdg)} target="_blank" rel="noreferrer">USDG</a></li>
            <li><a href="https://robinhoodchain.blockscout.com" target="_blank" rel="noreferrer">Blockscout 浏览器</a></li>
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
        <p>Robinhood Chain · Uniswap V3 NPM <code>{CONTRACTS.v3Npm}</code></p>
        <p>半自动工具：V3 + V4（modifyLiquidities / Permit2）。无人值守 keeper 后续再加。</p>
      </footer>
    </div>
  )
}
