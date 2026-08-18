import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Address, WalletClient } from 'viem'
import { isAddress } from 'viem'
import {
  CONTRACTS,
  FEE_TIERS,
  V4_FEE_PRESETS,
  KNOWN_TOKENS,
  SUPPORTED_CHAINS,
  chainHasWrappedNative,
  getActiveChainConfig,
  getActiveChainId,
  getNativeSymbol,
  getWrappedNativeSymbol,
  listKnownTokens,
  type SupportedChainId,
} from './chain'
import {
  claimV3,
  claimV4,
  claimV3PositionBatch,
  claimV4PositionBatch,
  claimAndCompound,
  closeV3PositionBatch,
  closeV4PositionBatch,
  createV3PoolAndSeed,
  createV4PoolAndSeed,
  describeFullRange,
  describeRange,
  discoverPoolsByToken,
  findBestV3Pool,
  findV4Pool,
  formatAmount,
  getErc20Balance,
  getNativeBalance,
  getTokenBalanceView,
  isArcUsdcErc20,
  getTokenUsdPrice,
  getWethUsdPrice,
  increaseV3Liquidity,
  increaseV4Liquidity,
  isEthLikeCurrency,
  isNativeCurrency,
  loadPoolFromInput,
  loadPoolDepth,
  loadV3Pool,
  loadV4Pool,
  burnVacantV3Nfts,
  listVacantV3TokenIds,
  loadV3Positions,
  loadV4Positions,
  enrichPositionsLifetimeFees,
  isOneSidedRangeStale,
  reanchorRangeToLiveSpot,
  remapMintAmountsForRange,
  mintV3Position,
  mintV3DlmmPositions,
  mintV4Position,
  mintV4DlmmPositions,
  pairHasWeth,
  recordPositionClaim,
  removeV3Liquidity,
  removeV4Liquidity,
  rebalanceV3,
  scanV3Pools,
  scanV4Pools,
  ticksFromCoinPrices,
  getCoinQuote,
  getPositionCoinPrices,
  getPositionUsdRange,
  oneSidedEthPercents,
  suggestV4TickSpacing,
  unwrapWeth,
  wrapEth,
  loadV4PoolById,
  aggregateFeesByPool,
  positionPoolKey,
  poolAsSwapPosition,
  type DiscoveredPool,
  type PoolDepth,
  type PoolInfo,
  type PositionRow,
} from './lp'
import { RangeDepthChart } from './RangeDepthChart'
import { PositionDetailCard, estimateRebalanceHalfPercent } from './PositionDetailCard'
import { PositionLegs } from './PositionLegs'
import { quotePoolSwap, swapInPool, type PoolSwapQuote } from './swap'
import { parseAmount, formatPrice, formatUsd, pairAmountForRange, neededMintSide, formatAmountExact, priceToClosestTick, priceToSqrtPriceX96, tickToPrice } from './math'
import { withTimeout } from './async'
import {
  connectWallet,
  ensureActiveChain,
  explorerAddress,
  explorerTx,
  makeLocalWalletClient,
  makeWalletClient,
  publicClient,
  refreshPublicClient,
  shortAddr,
  switchAppChain,
} from './wallet'
import { isUnlocked, lock as lockSigner, touchAutoLock } from './signer'
import { SignerPanel } from './SignerPanel'
import { AutomationPanel } from './AutomationPanel'
import {
  executeAction,
  loadAutoConfig,
  planActions,
  pushAutoLog,
  saveAutoConfig,
  type AutoConfig,
  type Plan,
} from './automation'
import {
  defaultRpcUrl,
  describeActiveRpc,
  loadCustomRpcUrl,
  saveCustomRpcUrl,
  testRpcLatency,
} from './rpcSettings'
import { clearTxHistory, loadTxHistory, pushTxHistory, relTime, type TxRecord } from './history'
import {
  FIXTURE_ADDRESS,
  FIXTURE_HISTORY,
  FIXTURE_POOL,
  FIXTURE_POSITIONS,
  designMode,
  designSignerMode,
} from './fixtures'
import { usePersistentState, useTheme, writePref, type ThemeMode } from './prefs'
import {
  ConfirmDialog,
  InfoHint,
  PositionSkeleton,
  ToastStack,
  useToasts,
  type ConfirmRequest,
} from './ui'
import { TokenPicker, type TokenOption } from './TokenPicker'
import FlowMonitor from './FlowMonitor'
import DlmmMode, { type DlmmMintRequest } from './DlmmMode'
import DlmmPositionsPanel from './DlmmPositionsPanel'
import {
  allocateDlmmAmounts,
  buildEvmDlmmTranches,
  refreshEvmDlmmPlan,
  type DlmmSide,
  type EvmDlmmPlan,
} from './dlmm'
import {
  attachDlmmGroupTokenIds,
  createDlmmGroupRecord,
  forgetDlmmGroupRecord,
  loadDlmmGroupRecords,
  resolveDlmmPositionGroups,
  upsertDlmmGroupRecord,
  type DlmmPositionGroup,
} from './dlmmGroups'
import type { FlowChainId, FlowVersion } from './flowEvents'
import {
  describeGraphApiKey,
  loadGraphApiKey,
  saveGraphApiKey,
} from './graphSettings'
import { fetchTransferTaxBps, isHoneypotWhitelisted } from './honeypot'
import { chooseWrappedPoolPayment, type BalanceReadStatus } from './mintPayment'
import './App.css'
import './signer.css'

type SortKey = 'value' | 'fees' | 'pnl' | 'pair' | 'apr' | 'risk'
type FilterKey = 'all' | 'in' | 'out' | 'v3' | 'v4' | 'risk'
type RangeMode = 'percent' | 'custom' | 'full'
type Density = 'cozy' | 'compact'
type TabKey = 'positions' | 'mint' | 'dlmm' | 'tools' | 'auto' | 'history' | 'flow'

const MINT_GAS_RESERVE_WEI = 10n ** 15n

const REFRESH_OPTIONS = [30, 60, 180, 600] as const

/** 左侧导航轨。blurb 会显示在工作条标题下面，替代原来那条通用副标题 */
const NAV_ITEMS: { key: TabKey; label: string; icon: string; hotkey: string; blurb: string }[] = [
  { key: 'positions', label: '仓位', icon: '▤', hotkey: '1', blurb: '在管仓位、手续费与区间状态' },
  { key: 'mint', label: '新建仓', icon: '＋', hotkey: '2', blurb: '选池、定区间、自动配平并建仓' },
  { key: 'dlmm', label: 'DLMM', icon: '▥', hotkey: '7', blurb: '低价分批买入或高价分批卖出' },
  { key: 'tools', label: '工具', icon: '⚒', hotkey: '3', blurb: '批量操作与链上辅助查询' },
  { key: 'auto', label: '自动化', icon: '◈', hotkey: '4', blurb: '本地私钥签名与自动复投 / Rebalance' },
  { key: 'history', label: '交易历史', icon: '⇅', hotkey: '5', blurb: '本机记录的交易与浏览器链接' },
  { key: 'flow', label: '动向', icon: '↗', hotkey: '6', blurb: 'BSC / Robinhood / Base 大额开仓与撤出' },
]

function formatPnl(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) > 1e11) return '—'
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  const abs = Math.abs(n)
  return `${sign}US$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** 当前价距离最近边界还有多少 %。越小越危险；已越界返回 0 */
function rangeProximityPct(p: PositionRow): number | null {
  if (!p.inRange) return 0
  const lo = p.priceLower
  const hi = p.priceUpper
  const spot = p.price
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(spot) || spot <= 0) return null
  if (!(hi > lo)) return null
  const dLo = ((spot - lo) / spot) * 100
  const dHi = ((hi - spot) / spot) * 100
  const near = Math.min(dLo, dHi)
  if (!Number.isFinite(near)) return null
  return Math.max(0, near)
}

/** 距边界 < 3% 记为高危，< 8% 记为注意 */
function riskLevel(p: PositionRow): 'out' | 'high' | 'warn' | 'ok' | null {
  if (!p.inRange) return 'out'
  const near = rangeProximityPct(p)
  if (near == null) return null
  if (near < 3) return 'high'
  if (near < 8) return 'warn'
  return 'ok'
}

function formatApr(pct?: number): string {
  if (pct == null || !Number.isFinite(pct)) return '—'
  if (pct >= 1000) return `${Math.round(pct).toLocaleString('en-US')}%`
  return `${pct.toFixed(pct >= 100 ? 0 : 1)}%`
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

function downloadCsv(name: string, rows: (string | number | null | undefined)[][]) {
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
  // BOM 让 Excel 正确识别 UTF-8
  const blob = new Blob([`﻿${body}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function extractHash(r: unknown): string | null {
  if (typeof r === 'string' && r.startsWith('0x') && r.length === 66) return r
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>
    if (typeof o.hash === 'string') return o.hash
    if (typeof o.increaseHash === 'string') return o.increaseHash
    if (typeof o.claimHash === 'string') return o.claimHash
    if (typeof o.exitHash === 'string') return o.exitHash
    if (typeof o.mintHash === 'string') return o.mintHash
  }
  return null
}

function extractNote(r: unknown): string | null {
  if (r && typeof r === 'object' && 'note' in r && typeof (r as { note: unknown }).note === 'string') {
    return (r as { note: string }).note
  }
  return null
}

function copyText(text: string) {
  void navigator.clipboard?.writeText(text)
}

function positionPoolRef(p: { poolAddress?: string | null; poolId?: string | null }): string | null {
  if (p.poolAddress) return p.poolAddress
  if (p.poolId) return p.poolId
  return null
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

const THEME_CYCLE: ThemeMode[] = ['auto', 'light', 'dark']
const THEME_META: Record<ThemeMode, { icon: string; label: string }> = {
  auto: { icon: '◐', label: '跟随系统' },
  light: { icon: '☀', label: '浅色' },
  dark: { icon: '☾', label: '深色' },
}

function ThemeToggle({ mode, onChange }: { mode: ThemeMode; onChange: (m: ThemeMode) => void }) {
  const meta = THEME_META[mode]
  return (
    <button
      className="btn icon"
      type="button"
      title={`主题：${meta.label}（点击切换）`}
      aria-label={`主题：${meta.label}`}
      onClick={() => onChange(THEME_CYCLE[(THEME_CYCLE.indexOf(mode) + 1) % THEME_CYCLE.length])}
    >
      {meta.icon}
    </button>
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
  /** 原生余额 raw（18 位 wei；Arc 上也是原生 USDC 的 18 位内部精度，用于 gas/value） */
  const [ethBal, setEthBal] = useState<bigint>(0n)
  const [ethBalStatus, setEthBalStatus] = useState<BalanceReadStatus>('idle')
  const [wethBal, setWethBal] = useState<bigint>(0n)
  const [wethBalStatus, setWethBalStatus] = useState<BalanceReadStatus>('idle')
  const balanceRefreshGenRef = useRef(0)
  /** 钱包条展示：Arc 用 ERC-20 USDC(6)，其它链直接展示 ethBal(18) */
  const [gasTokenDisplay, setGasTokenDisplay] = useState<{ raw: bigint; decimals: number }>({
    raw: 0n,
    decimals: 18,
  })

  const [tab, setTab] = useState<TabKey>(() => {
    const requested = new URLSearchParams(window.location.search).get('tab')
    return NAV_ITEMS.some((item) => item.key === requested) ? requested as TabKey : 'positions'
  })
  /** 签名方式：'wallet' 插件钱包 / 'local' 本地私钥。两者互斥 */
  const [signerMode, setSignerMode] = useState<'none' | 'wallet' | 'local'>('none')
  const [localAddr, setLocalAddr] = useState<Address | null>(null)
  const [autoLockMins, setAutoLockMins] = usePersistentState('autoLockMins', 30)
  const [autoCfg, setAutoCfg] = useState<AutoConfig>(() => loadAutoConfig())
  const [autoPlan, setAutoPlan] = useState<Plan | null>(null)
  const [autoRunning, setAutoRunning] = useState(false)
  const [autoLastRunAt, setAutoLastRunAt] = useState<number | null>(null)
  const [autoNextIn, setAutoNextIn] = useState<number | null>(null)
  const [positions, setPositions] = useState<PositionRow[]>([])
  const [dlmmGroupRecords, setDlmmGroupRecords] = useState(() => loadDlmmGroupRecords())
  const [percentLower, setPercentLower] = useState(-5)
  const [percentUp, setPercentUp] = useState(5)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    const url = new URL(window.location.href)
    if (tab === 'positions') url.searchParams.delete('tab')
    else url.searchParams.set('tab', tab)
    window.history.replaceState(null, '', url)
  }, [tab])
  const [slippageBps, setSlippageBps] = usePersistentState('slippageBps', 300)
  /** V4 山寨币转账税（bps）。0.25%=25；GoPlus 对 MEOW 类约 1% 会自动填 ~100 */
  const [transferTaxBps, setTransferTaxBps] = useState(0)
  const [sortKey, setSortKey] = usePersistentState<SortKey>('sortKey', 'value')
  const [sortAsc, setSortAsc] = usePersistentState('sortAsc', false)
  const [filterKey, setFilterKey] = usePersistentState<FilterKey>('filterKey', 'all')
  const [query, setQuery] = useState('')
  const [density, setDensity] = usePersistentState<Density>('density', 'cozy')
  const [themeMode, setThemeMode] = useTheme()
  const [showSettings, setShowSettings] = usePersistentState('showSettings', false)
  const [removePct, setRemovePct] = useState(100)
  const [posOpMode, setPosOpMode] = useState<'add' | 'remove' | 'swap'>('add')
  const [add0, setAdd0] = useState('')
  const [add1, setAdd1] = useState('')
  const [addBal0, setAddBal0] = useState<bigint>(0n)
  const [addBal1, setAddBal1] = useState<bigint>(0n)
  /** 本池 Swap：true = token0→token1 */
  const [swapZeroForOne, setSwapZeroForOne] = useState(true)
  const [swapAmount, setSwapAmount] = useState('')
  const [swapQuote, setSwapQuote] = useState<PoolSwapQuote | null>(null)
  const [swapQuoteBusy, setSwapQuoteBusy] = useState(false)
  const [swapQuoteErr, setSwapQuoteErr] = useState<string | null>(null)
  /** 新建仓：已加载池旁展开本池 Swap */
  const [mintSwapOpen, setMintSwapOpen] = useState(false)
  const [autoRefresh, setAutoRefresh] = usePersistentState('autoRefresh', false)
  const [refreshSecs, setRefreshSecs] = usePersistentState<number>('refreshSecs', 60)
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null)
  const { toasts, push: pushToast, update: updateToast, dismiss: dismissToast } = useToasts()
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [txHistory, setTxHistory] = useState<TxRecord[]>(() => loadTxHistory())
  const [rpcInput, setRpcInput] = useState(() => loadCustomRpcUrl() ?? '')
  const [activeRpcLabel, setActiveRpcLabel] = useState(() => describeActiveRpc())
  const [rpcLatency, setRpcLatency] = useState<number | null>(null)
  const [rpcBlock, setRpcBlock] = useState<bigint | null>(null)
  const [rpcBusy, setRpcBusy] = useState(false)
  const [graphKeyInput, setGraphKeyInput] = useState(() => loadGraphApiKey() ?? '')
  const [graphKeyLabel, setGraphKeyLabel] = useState(() => describeGraphApiKey())
  const [chainId, setChainId] = useState<SupportedChainId>(() => getActiveChainId())
  const chainCfg = getActiveChainConfig()

  const [tokenA, setTokenA] = useState<Address>(() => getActiveChainConfig().defaultTokenA)
  const [tokenB, setTokenB] = useState<Address>(() => getActiveChainConfig().defaultTokenB)
  const [tokenMetaCache, setTokenMetaCache] = useState<Record<string, { symbol: string; decimals: number }>>({})
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
  const [poolDepth, setPoolDepth] = useState<PoolDepth | null>(null)
  const [depthLoading, setDepthLoading] = useState(false)
  const [depthError, setDepthError] = useState<string | null>(null)
  /** 仅当当前池/创建对含 ETH·WETH 时才有意义；非 ETH 对组仓不会触发 Wrap */
  const [useNativeEth, setUseNativeEth] = useState(false)
  /** 当前池由用户亲自选过支付资产后，后台余额刷新不能再擅自覆盖选择。 */
  const mintPaymentTouchedPoolRef = useRef<string | null>(null)
  /** 新建池页的原生/包装币选择，独立于已加载池，避免被 Mint 页逻辑清掉。 */
  const createPaymentTouchedRef = useRef<string | null>(null)
  const [mintProtocol, setMintProtocol] = usePersistentState<'v3' | 'v4'>('mintProtocol', 'v3')
  /**
   * 「初始价」输入框是 U 本位：用户填 USD per 币。
   * 链上需要的是「报价 per 币」，用报价代币的 USD 单价 quoteUsd 换算。
   * quoteUsd = 0 代表拿不到汇率 —— 此时必须挡住创建，绝不能拿 0 去乘除。
   */
  const [initPrice, setInitPrice] = useState('')
  const [quoteUsd, setQuoteUsd] = useState(0)
  const [quoteUsdBusy, setQuoteUsdBusy] = useState(false)
  const [showCreatePool, setShowCreatePool] = useState(false)
  const [v4TickSpacing, setV4TickSpacing] = useState(200)
  const [customFeeInput, setCustomFeeInput] = useState('')
  const [seedOnCreate, setSeedOnCreate] = useState(true)
  const [seedAmtA, setSeedAmtA] = useState('')
  const [seedAmtB, setSeedAmtB] = useState('')
  const [createSeedBalA, setCreateSeedBalA] = useState<bigint>(0n)
  const [createSeedBalB, setCreateSeedBalB] = useState<bigint>(0n)
  /** 创建时初仓区间预设；默认双边 ±10%，勿默认单边 ETH（山寨/U 池会被带偏） */
  const [createRangePreset, setCreateRangePreset] = useState<'onesided-eth' | 'full' | 'custom' | number>(10)
  /** 自定义区间：USD per 币（与初始价同一本位） */
  const [createUsdLo, setCreateUsdLo] = useState('')
  const [createUsdHi, setCreateUsdHi] = useState('')

  const [wrapAmt, setWrapAmt] = useState('')
  const [vacantV3Ids, setVacantV3Ids] = useState<bigint[] | null>(null)
  /** 用户最后编辑的是哪一侧：区间/价格变化后按这一侧重新配平 */
  const [pairSide, setPairSide] = useState<0 | 1>(0)
  /** 输入代币合约后扫出来的候选池 */
  const [discovered, setDiscovered] = useState<DiscoveredPool[] | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discoverNote, setDiscoverNote] = useState('')

  const tabRef = useRef(tab)
  /** 递增可使进行中的刷新结果全部作废（切链 / 重新刷新 / 断开） */
  const refreshGenRef = useRef(0)
  const refreshingRef = useRef(false)
  useEffect(() => {
    tabRef.current = tab
  }, [tab])

  const selected = useMemo(
    () => positions.find((p) => `${p.version}-${p.tokenId}` === selectedId) ?? null,
    [positions, selectedId],
  )

  const dlmmPositionGroups = useMemo(
    () => resolveDlmmPositionGroups(dlmmGroupRecords, positions, chainId, address),
    [dlmmGroupRecords, positions, chainId, address],
  )

  useEffect(() => {
    if (!address || positions.length === 0) return
    const before = dlmmGroupRecords
      .flatMap((record) => record.bands.map((band) => band.tokenId ?? ''))
      .join('|')
    const next = attachDlmmGroupTokenIds(dlmmGroupRecords, positions, chainId, address)
    const after = next
      .flatMap((record) => record.bands.map((band) => band.tokenId ?? ''))
      .join('|')
    if (before !== after) setDlmmGroupRecords(next)
  }, [address, chainId, dlmmGroupRecords, positions])

  useEffect(() => {
    if (!selectedId) return
    const el = document.getElementById('position-detail-card')
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    setPosOpMode('add')
    setAdd0('')
    setAdd1('')
    setRemovePct(100)
    setSwapAmount('')
    setSwapQuote(null)
    setSwapQuoteErr(null)
    setSwapZeroForOne(true)
  }, [selectedId])

  const fillAddBalances = (pct = 100) => {
    if (!selected) return
    const f = BigInt(Math.floor(pct * 100))
    const gas = 10n ** 15n
    const eth0 = isEthLikeCurrency(selected.token0.address)
    const eth1 = isEthLikeCurrency(selected.token1.address)
    let r0 = addUseEth && eth0 ? (ethBal > gas ? ethBal - gas : 0n) : addBal0
    let r1 = addUseEth && eth1 ? (ethBal > gas ? ethBal - gas : 0n) : addBal1
    r0 = (r0 * f) / 10000n
    r1 = (r1 * f) / 10000n
    const from0 = pairAmountForRange({
      sqrtPriceX96: selected.sqrtPriceX96,
      tickLower: selected.tickLower,
      tickUpper: selected.tickUpper,
      amount: r0,
      side: 0,
    })
    const from1 = pairAmountForRange({
      sqrtPriceX96: selected.sqrtPriceX96,
      tickLower: selected.tickLower,
      tickUpper: selected.tickUpper,
      amount: r1,
      side: 1,
    })
    if (from0.singleSided === 'token1' || from1.singleSided === 'token1') {
      setAdd0('0')
      setAdd1(formatAmountExact(from1.amount1, selected.token1.decimals))
      return
    }
    if (from0.singleSided === 'token0' || from1.singleSided === 'token0') {
      setAdd0(formatAmountExact(from0.amount0, selected.token0.decimals))
      setAdd1('0')
      return
    }
    if (from0.amount0 > 0n && from0.amount1 <= r1) {
      setAdd0(formatAmountExact(from0.amount0, selected.token0.decimals))
      setAdd1(formatAmountExact(from0.amount1, selected.token1.decimals))
      return
    }
    setAdd0(formatAmountExact(from1.amount0, selected.token0.decimals))
    setAdd1(formatAmountExact(from1.amount1, selected.token1.decimals))
  }

  const summary = useMemo(() => {
    const totalUsd = positions.reduce((s, p) => s + p.totalUsd, 0)
    const feesUsd = positions.reduce((s, p) => s + p.totalFeesUsd, 0)
    const unclaimedUsd = positions.reduce((s, p) => s + p.fees0Usd + p.fees1Usd, 0)
    const claimedUsd = positions.reduce((s, p) => s + p.claimedFeesUsd, 0)
    const pnlRows = positions.filter((p) => p.pnlReady)
    const pnlUsd = pnlRows.reduce((s, p) => s + p.pnlUsd, 0)
    const pnlEstimated = pnlRows.filter((p) => p.pnlQuality === 'estimated').length
    const inRange = positions.filter((p) => p.inRange).length
    const atRisk = positions.filter((p) => {
      const r = riskLevel(p)
      return r === 'high' || r === 'warn'
    }).length
    // 组合年化 = 按仓位价值加权（只统计已算出年化的仓位）
    let aprWeight = 0
    let aprSum = 0
    for (const p of positions) {
      if (p.feeAprPct == null || !Number.isFinite(p.feeAprPct)) continue
      const w = p.totalUsd > 0 ? p.totalUsd : 0
      if (w <= 0) continue
      aprWeight += w
      aprSum += p.feeAprPct * w
    }
    const feeAprPct = aprWeight > 0 ? aprSum / aprWeight : undefined
    return {
      totalUsd, feesUsd, unclaimedUsd, claimedUsd, pnlUsd, inRange, atRisk, feeAprPct,
      pnlReady: pnlRows.length,
      pnlEstimated,
      n: positions.length,
    }
  }, [positions])

  const poolFeeSummaries = useMemo(() => aggregateFeesByPool(positions), [positions])
  const poolFeeByKey = useMemo(() => {
    const m = new Map<string, (typeof poolFeeSummaries)[number]>()
    for (const row of poolFeeSummaries) m.set(row.key, row)
    return m
  }, [poolFeeSummaries])

  const counts = useMemo(
    () => ({
      all: positions.length,
      in: positions.filter((p) => p.inRange).length,
      out: positions.filter((p) => !p.inRange).length,
      v3: positions.filter((p) => p.version === 'v3').length,
      v4: positions.filter((p) => p.version === 'v4').length,
      risk: positions.filter((p) => {
        const r = riskLevel(p)
        return r === 'high' || r === 'warn'
      }).length,
    }),
    [positions],
  )

  const filteredPositions = useMemo(() => {
    let list = [...positions]
    if (filterKey === 'in') list = list.filter((p) => p.inRange)
    if (filterKey === 'out') list = list.filter((p) => !p.inRange)
    if (filterKey === 'v3') list = list.filter((p) => p.version === 'v3')
    if (filterKey === 'v4') list = list.filter((p) => p.version === 'v4')
    if (filterKey === 'risk') {
      list = list.filter((p) => {
        const r = riskLevel(p)
        return r === 'high' || r === 'warn'
      })
    }
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter((p) => {
        const hay = `${p.token0.symbol} ${p.token1.symbol} ${p.token0.symbol}/${p.token1.symbol} ${p.version} ${p.tokenId}`.toLowerCase()
        return hay.includes(q)
      })
    }
    const dir = sortAsc ? -1 : 1
    list.sort((a, b) => {
      if (sortKey === 'fees') return dir * (b.totalFeesUsd - a.totalFeesUsd)
      if (sortKey === 'pnl') return dir * (b.pnlUsd - a.pnlUsd)
      if (sortKey === 'pair') {
        return dir * `${a.token0.symbol}/${a.token1.symbol}`.localeCompare(`${b.token0.symbol}/${b.token1.symbol}`)
      }
      if (sortKey === 'apr') return dir * ((b.feeAprPct ?? -1) - (a.feeAprPct ?? -1))
      if (sortKey === 'risk') {
        // 危险排前面：已越界 → 距边界最近
        const ra = rangeProximityPct(a) ?? 1e9
        const rb = rangeProximityPct(b) ?? 1e9
        return dir * (ra - rb)
      }
      return dir * (b.totalUsd - a.totalUsd)
    })
    return list
  }, [positions, filterKey, sortKey, sortAsc, query])

  const exportPositionsCsv = useCallback(() => {
    if (!filteredPositions.length) {
      pushToast({ kind: 'info', title: '没有可导出的仓位' })
      return
    }
    const head = [
      '协议', 'tokenId', '交易对', '费率', '状态', '价值USD', '未领手续费USD', '已领手续费USD',
      '累计手续费USD', '累计投入USD', '累计收回USD', 'PnL USD', 'PnL口径', '手续费年化%', '持仓天数', '下界', '上界', '当前价', '距边界%',
    ]
    const rows = filteredPositions.map((p) => [
      p.version.toUpperCase(), p.tokenId.toString(), `${p.token0.symbol}/${p.token1.symbol}`,
      `${p.fee / 10_000}%`, p.inRange ? 'in range' : 'out of range',
      p.totalUsd.toFixed(2), (p.fees0Usd + p.fees1Usd).toFixed(2), p.claimedFeesUsd.toFixed(2),
      p.totalFeesUsd.toFixed(2), p.costBasisUsd.toFixed(2), (p.cashOutUsd ?? 0).toFixed(2),
      p.pnlReady ? p.pnlUsd.toFixed(2) : '', p.pnlQuality ?? 'unavailable',
      p.feeAprPct == null ? '' : p.feeAprPct.toFixed(2),
      p.ageDays == null ? '' : p.ageDays.toFixed(2),
      formatPrice(p.priceLower), formatPrice(p.priceUpper), formatPrice(p.price),
      rangeProximityPct(p)?.toFixed(2) ?? '',
    ])
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    downloadCsv(`rangedesk-positions-${stamp}.csv`, [head, ...rows])
    pushToast({ kind: 'success', title: `已导出 ${rows.length} 个仓位` })
  }, [filteredPositions, pushToast])

  const refreshBalances = useCallback(async (addr: Address) => {
    const requestChainId = chainId
    if (getActiveChainId() !== requestChainId) return
    const generation = ++balanceRefreshGenRef.current
    const stillCurrent = () =>
      generation === balanceRefreshGenRef.current && getActiveChainId() === requestChainId

    // 已有读数时不要闪成「…」；只在从未成功时显示读取中。
    setEthBalStatus((current) => current === 'ready' ? 'ready' : 'loading')
    if (chainCfg.hasWrappedNative) {
      setWethBalStatus((current) => current === 'ready' ? 'ready' : 'loading')
    } else {
      setWethBalStatus('idle')
    }

    const watchdog = window.setTimeout(() => {
      if (!stillCurrent()) return
      setEthBalStatus((current) => current === 'loading' ? 'error' : current)
      setWethBalStatus((current) => current === 'loading' ? 'error' : current)
    }, 10_000)

    const extraBalance = chainCfg.key === 'arc'
      ? getTokenBalanceView(CONTRACTS.stable, addr)
      : chainCfg.hasWrappedNative
        ? getErc20Balance(CONTRACTS.weth, addr)
        : Promise.resolve(null)
    const [nativeResult, extraResult] = await Promise.allSettled([
      getNativeBalance(addr),
      extraBalance,
    ])
    window.clearTimeout(watchdog)
    if (!stillCurrent()) return

    if (nativeResult.status === 'fulfilled') {
      setEthBal(nativeResult.value)
      setEthBalStatus('ready')
      if (chainCfg.key !== 'arc') {
        setGasTokenDisplay({ raw: nativeResult.value, decimals: 18 })
      }
    } else {
      setEthBalStatus((current) => current === 'ready' ? 'ready' : 'error')
    }
    if (chainCfg.key === 'arc') {
      if (
        extraResult.status === 'fulfilled'
        && extraResult.value
        && typeof extraResult.value !== 'bigint'
      ) {
        setGasTokenDisplay({ raw: extraResult.value.raw, decimals: extraResult.value.decimals })
      }
      setWethBal(0n)
      setWethBalStatus('idle')
    } else if (chainCfg.hasWrappedNative) {
      if (extraResult.status === 'fulfilled' && typeof extraResult.value === 'bigint') {
        setWethBal(extraResult.value)
        setWethBalStatus('ready')
      } else {
        setWethBalStatus((current) => current === 'ready' ? 'ready' : 'error')
      }
    } else {
      setWethBal(0n)
      setWethBalStatus('idle')
    }
  }, [chainCfg.hasWrappedNative, chainCfg.key, chainId])

  // 账户和应用链任一变化都重读余额。此前切链只刷新仓位，原生 ETH 可能保留为 0/旧链值。
  useEffect(() => {
    if (!address) return
    void refreshBalances(address)
  }, [address, refreshBalances])

  const connect = async () => {
    // 互斥：本地私钥解锁时不允许再连插件钱包
    if (signerMode === 'local') {
      pushToast({
        kind: 'error',
        title: '本地私钥正在使用中',
        detail: '连接钱包前请先在「自动化」页锁定本地私钥',
      })
      return
    }
    try {
      setBusy(true)
      setStatus('连接中…')
      const { address: addr, walletClient } = await connectWallet()
      setAddress(addr)
      setWallet(walletClient)
      setSignerMode('wallet')
      setStatus(`已连接 ${shortAddr(addr)}`)
      setStatusHash(null)
      await refreshBalances(addr)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /*
   * 设计模式：dev + ?design=1 时灌入夹具数据，好在有仓位的密集布局下调版式。
   *
   * 第一行必须直接写 import.meta.env.DEV，不能只靠 designMode() 里面那层判断。
   * Vite 只会把字面量 import.meta.env.DEV 替换成 false，替换不了 designMode() 这个函数调用，
   * 压缩器于是没法证明后面几行是死代码，FIXTURE_* 的引用就全留下来了 ——
   * 实测生产包里能 grep 到夹具地址和「设计模式」那句文案。写成常量表达式，
   * 整个函数体在生产构建里就是不可达代码，fixtures 模块才真的被 tree-shake 掉。
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (!designMode()) return
    setAddress(FIXTURE_ADDRESS)
    /*
     * ?design=local 时装成本地私钥通道。「自动化」整页挂在 signerMode === 'local' 上，
     * 插件钱包模式下它只会渲染一块「自动化需要本地私钥」的占位，里面的版式根本调不到。
     * 只动 signerMode / localAddr 这两个 UI 状态，不碰 signer.ts —— SECRETS 闭包依旧是空的，
     * 所以这个模式能看不能签（wallet 仍为 null，所有发交易的按钮照样是灰的）。
     */
    const mode = designSignerMode()
    setSignerMode(mode)
    if (mode === 'local') setLocalAddr(FIXTURE_ADDRESS)
    setPositions(FIXTURE_POSITIONS)
    setTxHistory(FIXTURE_HISTORY)
    // 灌一个已选池，否则建仓页第二/三步（定区间、配数量）整段渲染不出来
    setPool(FIXTURE_POOL)
    setStatus('设计模式：数据为本地夹具，未连链')
  }, [])

  const disconnect = () => {
    refreshGenRef.current += 1
    refreshingRef.current = false
    setRefreshing(false)
    setRefreshStatus('')
    if (signerMode === 'local') lockSigner()
    setAddress(null)
    setWallet(null)
    setSignerMode('none')
    setLocalAddr(null)
    setPositions([])
    setSelectedId(null)
    balanceRefreshGenRef.current += 1
    setEthBal(0n)
    setEthBalStatus('idle')
    setWethBal(0n)
    setWethBalStatus('idle')
    setAutoCfg((c) => ({ ...c, enabled: false }))
    setStatus(signerMode === 'local' ? '已锁定本地私钥' : '已断开连接')
    setStatusHash(null)
  }

  /** 本地私钥解锁成功：接管签名通道 */
  const onLocalUnlocked = useCallback(
    (addr: Address) => {
      try {
        const { walletClient } = makeLocalWalletClient()
        setAddress(addr)
        setWallet(walletClient)
        setLocalAddr(addr)
        setSignerMode('local')
        setStatus(`本地私钥已解锁 ${shortAddr(addr)}`)
        setStatusHash(null)
        setPositions([])
        setSelectedId(null)
        void refreshBalances(addr)
        pushToast({ kind: 'success', title: '本地私钥已解锁', detail: shortAddr(addr) })
      } catch (e) {
        pushToast({
          kind: 'error',
          title: '解锁失败',
          detail: e instanceof Error ? e.message : String(e),
        })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshBalances],
  )

  const onLocalLocked = useCallback(() => {
    setLocalAddr(null)
    setSignerMode((m) => (m === 'local' ? 'none' : m))
    setAutoCfg((c) => ({ ...c, enabled: false }))
    setAddress((a) => (isUnlocked() ? a : null))
    setWallet((w) => (isUnlocked() ? w : null))
    setStatus('本地私钥已锁定')
    setStatusHash(null)
  }, [])

  const testRpc = async () => {
    try {
      setRpcBusy(true)
      setRpcLatency(null)
      setRpcBlock(null)
      const typed = rpcInput.trim()
      // Arc 默认公共节点常挂：未填自定义时测实际只读路径（含钱包 RPC）
      if (!typed && chainCfg.key === 'arc') {
        refreshPublicClient()
        const start = performance.now()
        const blockNumber = await withTimeout(publicClient.getBlockNumber(), 15_000, 'Arc RPC')
        setRpcLatency(Math.round(performance.now() - start))
        setRpcBlock(blockNumber)
        setStatus('Arc 只读路径正常（优先钱包节点）')
        return
      }
      const { latencyMs, blockNumber } = await testRpcLatency(typed || defaultRpcUrl())
      setRpcLatency(latencyMs)
      setRpcBlock(blockNumber)
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e)
      if (chainCfg.key === 'arc') {
        msg = `${msg} · Arc 请连接钱包或填私有 RPC（公共节点基本不可用）`
      }
      setStatus(msg)
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

  const saveGraphKey = () => {
    try {
      const saved = saveGraphApiKey(graphKeyInput)
      setGraphKeyInput(saved ?? '')
      setGraphKeyLabel(describeGraphApiKey())
      setStatus(saved ? '已保存 The Graph API Key' : '已清除 The Graph API Key')
      setStatusHash(null)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
      setStatusHash(null)
    }
  }

  const refreshPositions = useCallback(async (opts?: { silent?: boolean; deep?: boolean }) => {
    if (!address) return []
    // 设计模式下仓位是写死的夹具，真去链上拉一遍只会把它们冲掉
    if (designMode()) return []
    const silent = opts?.silent ?? tabRef.current !== 'positions'
    const deep = Boolean(opts?.deep)
    // 静默自动刷新不打断用户手动/深度刷新；手动刷新可覆盖旧任务
    if (refreshingRef.current && silent) return []

    const gen = ++refreshGenRef.current
    const startedChainId = getActiveChainId()
    const stillCurrent = () =>
      gen === refreshGenRef.current && getActiveChainId() === startedChainId

    refreshingRef.current = true
    setRefreshing(true)
    if (!silent) {
      setRefreshStatus(deep ? '深度扫描仓位…' : '刷新 V3 / V4 仓位…')
    }
    const started = Date.now()
    const partial: string[] = []
    /** 本轮拿到的完整快照，给自动化用（两侧都失败时为空） */
    let merged: PositionRow[] = []
    try {
      // 让出主线程一帧，避免刷新一启动就卡死下拉框点击
      await new Promise<void>((r) => setTimeout(r, 0))
      if (!stillCurrent()) return []

      const onV4Status = silent
        ? undefined
        : (msg: string) => {
            if (stillCurrent()) setRefreshStatus(msg)
          }

      const v3P = withTimeout(loadV3Positions(address), deep ? 90_000 : 35_000, 'V3 仓位')
        .then((rows) => {
          if (!stillCurrent()) return null
          setPositions((prev) => {
            const keepV4 = prev.filter((p) => p.version === 'v4')
            return [...rows, ...keepV4]
          })
          return rows
        })
        .catch((e) => {
          if (!stillCurrent()) return null
          partial.push(e instanceof Error ? e.message : String(e))
          console.warn('loadV3Positions failed', e)
          return null
        })

      const v4P = withTimeout(
        loadV4Positions(address, {
          deep,
          skipPnl: true,
          onStatus: onV4Status,
        }),
        deep ? 90_000 : 35_000,
        'V4 仓位',
      )
        .then((rows) => {
          if (!stillCurrent()) return null
          setPositions((prev) => {
            const keepV3 = prev.filter((p) => p.version === 'v3')
            return [...keepV3, ...rows]
          })
          return rows
        })
        .catch((e) => {
          if (!stillCurrent()) return null
          partial.push(e instanceof Error ? e.message : String(e))
          console.warn('loadV4Positions failed', e)
          return null
        })

      const [v3, v4] = await Promise.all([v3P, v4P])
      if (!stillCurrent()) return []

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
      merged = feeBase
      if (feeBase.length && address) {
        if (!silent) setRefreshStatus((s) => `${s} · 补扫历史手续费…`)
        void enrichPositionsLifetimeFees(feeBase, address, {
          onRow: (row) => {
            if (!stillCurrent()) return
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
          if (!stillCurrent()) return
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
      if (stillCurrent() && (!silent || tabRef.current === 'positions')) {
        setRefreshStatus(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (gen === refreshGenRef.current) {
        refreshingRef.current = false
        setRefreshing(false)
      }
    }
    return merged
  }, [address, refreshBalances])

  const onSwitchChain = (nextId: SupportedChainId) => {
    if (nextId === chainId) return
    // 立刻作废进行中的刷新，避免旧链结果写回新链
    refreshGenRef.current += 1
    refreshingRef.current = false
    setRefreshing(false)
    setRefreshStatus('')
    try {
      const cfg = switchAppChain(nextId)
      setChainId(nextId)
      setTokenA(cfg.defaultTokenA)
      setTokenB(cfg.defaultTokenB)
      setTokenMetaCache({})
      balanceRefreshGenRef.current += 1
      setEthBal(0n)
      setEthBalStatus('idle')
      setWethBal(0n)
      setWethBalStatus('idle')
      setGasTokenDisplay({ raw: 0n, decimals: cfg.key === 'arc' ? 6 : 18 })
      setPool(null)
      setScannedPools([])
      setPositions([])
      setSelectedId(null)
      setPoolInput('')
      setAmount0('')
      setAmount1('')
      setInitPrice('')
      setMintSwapOpen(false)
      setSwapAmount('')
      setSwapQuote(null)
      setRpcInput(loadCustomRpcUrl(nextId) ?? '')
      setActiveRpcLabel(describeActiveRpc(nextId))
      setRpcLatency(null)
      setRpcBlock(null)
      setStatusHash(null)
      setBusy(false)
      setStatus(`已切换到 ${cfg.label}`)

      // 应用内立刻切链；钱包弹窗 / 刷新都后台跑，绝不 await 卡住下拉框
      if (address) {
        if (signerMode === 'local') {
          try {
            setWallet(makeLocalWalletClient().walletClient)
          } catch {
            /* 未解锁则仅切应用链 */
          }
          setStatus(`已切换到 ${cfg.label}，正在刷新仓位…`)
          void refreshPositions({ silent: false })
        } else if (signerMode === 'wallet' && window.ethereum) {
          setStatus(`已切换到 ${cfg.label}，请在钱包确认网络（可继续点别的）…`)
          void ensureActiveChain()
            .then(() => {
              setWallet(makeWalletClient(address))
              setStatus(`已切换到 ${cfg.label}，正在刷新仓位…`)
              void refreshPositions({ silent: false })
            })
            .catch((e) => {
              setStatus(
                `应用已切到 ${cfg.label}，请在钱包切换到该网后点刷新：${e instanceof Error ? e.message : String(e)}`,
              )
              // 即便钱包未切，也用新链 RPC 试刷只读数据
              void refreshPositions({ silent: false })
            })
        } else {
          void refreshPositions({ silent: false })
        }
      }
    } catch (e) {
      setBusy(false)
      setStatus(e instanceof Error ? e.message : String(e))
    }
  }

  const openFlowPool = async (args: {
    chainId: FlowChainId
    version: FlowVersion
    poolAddress?: Address
    poolId?: `0x${string}`
  }) => {
    if (args.chainId !== getActiveChainId()) {
      onSwitchChain(args.chainId)
    }
    setTab('mint')
    setMintProtocol(args.version)
    const ref = args.version === 'v4' ? args.poolId : args.poolAddress
    if (!ref) {
      setStatus('动向条目缺少池引用')
      return
    }
    setPoolInput(ref)
    setBusy(true)
    setStatus(`从动向加载 ${args.version.toUpperCase()} 池 ${shortAddr(ref)}…`)
    try {
      const info =
        args.version === 'v4'
          ? await loadV4PoolById(args.poolId!)
          : await loadV3Pool(args.poolAddress!)
      setDiscovered(null)
      setPool(info)
      const q = getCoinQuote(info)
      setTokenA(q.coin.address)
      setTokenB(q.quote.address)
      setFee(info.fee)
      if (args.version === 'v4' && info.tickSpacing) setV4TickSpacing(info.tickSpacing)
      applyDefaultCoinRange(info, setPriceLo, setPriceHi)
      setStatus(
        `已从动向加载 ${args.version.toUpperCase()} · ${q.coin.symbol}/${q.quote.symbol} · 币价 ${formatPrice(q.spot)} ${q.quote.symbol}/${q.coin.symbol}`,
      )
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

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
        return
      }
      // 钱包刚切回应用链时，它的 RPC 才能成为可信余额源；立即重读，不等下一轮仓位刷新。
      refreshPublicClient()
      if (address) void refreshBalances(address)
      setStatus(`钱包已切换到 ${getActiveChainConfig().label}，正在刷新余额…`)
    }
    window.ethereum.on?.('accountsChanged', onAccounts)
    window.ethereum.on?.('chainChanged', onChain)
    return () => {
      window.ethereum?.removeListener?.('accountsChanged', onAccounts)
      window.ethereum?.removeListener?.('chainChanged', onChain)
    }
  }, [address, refreshBalances]) // eslint-disable-line react-hooks/exhaustive-deps

  // 自动刷新：标签页不可见时暂停，省 RPC 配额；回到前台若已过期立刻补一次
  useEffect(() => {
    if (!autoRefresh || !address) return
    const ms = Math.max(15, refreshSecs) * 1000
    let timer: ReturnType<typeof setInterval> | null = null
    const tick = () => void refreshPositions({ silent: true })
    const start = () => {
      if (timer != null) return
      timer = setInterval(tick, ms)
    }
    const stop = () => {
      if (timer == null) return
      clearInterval(timer)
      timer = null
    }
    const onVisible = () => {
      if (document.hidden) stop()
      else {
        tick()
        start()
      }
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [autoRefresh, address, refreshSecs, refreshPositions])

  // 键盘快捷键：1-4 切页 / r 刷新 / / 聚焦搜索 / Esc 收起详情
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      if (typing) {
        if (e.key === 'Escape') t?.blur()
        return
      }
      // 抽屉开着时 Esc 先关抽屉，不要顺手把仓位详情也收了
      if (e.key === 'Escape' && showSettings) {
        setShowSettings(false)
        return
      }
      if (e.key === '1') setTab('positions')
      else if (e.key === '2') setTab('mint')
      else if (e.key === '3') setTab('tools')
      else if (e.key === '4') setTab('auto')
      else if (e.key === '5') setTab('history')
      else if (e.key === '6') setTab('flow')
      else if (e.key === '7') setTab('dlmm')
      else if (e.key === 'r' || e.key === 'R') {
        if (address) void refreshPositions({ silent: false })
      } else if (e.key === '/') {
        e.preventDefault()
        setTab('positions')
        setTimeout(() => searchRef.current?.focus(), 0)
      } else if (e.key === 'Escape') {
        setSelectedId(null)
      } else return
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [address, refreshPositions, showSettings, setShowSettings])

  /* ───────────────── 自动化 ───────────────── */

  useEffect(() => {
    saveAutoConfig(autoCfg)
  }, [autoCfg])

  // 用户有动作就重置闲置计时
  useEffect(() => {
    if (signerMode !== 'local') return
    const touch = () => touchAutoLock()
    const events = ['pointerdown', 'keydown', 'wheel'] as const
    for (const ev of events) window.addEventListener(ev, touch, { passive: true })
    return () => {
      for (const ev of events) window.removeEventListener(ev, touch)
    }
  }, [signerMode])

  /** 跑一轮自动化。dryRunOverride=true 时强制只演算 */
  const runAutomation = useCallback(
    async (dryRunOverride?: boolean) => {
      if (signerMode !== 'local' || !wallet || !address) return
      const dry = dryRunOverride ?? autoCfg.dryRun
      setAutoRunning(true)
      try {
        // 先拿最新仓位快照，别拿着过期数据下决策
        const fresh = await refreshPositions({ silent: true })
        const rows = fresh && fresh.length ? fresh : positions
        const plan = await planActions(rows, autoCfg, address)
        setAutoPlan(plan)
        setAutoLastRunAt(Date.now())
        if (plan.blocked || plan.actions.length === 0) return

        for (const a of plan.actions) {
          const label = a.action === 'compound' ? '自动复投' : '自动 Rebalance'
          const pair = `${a.position.token0.symbol}/${a.position.token1.symbol}`
          const toastId = pushToast({
            kind: dry ? 'info' : 'pending',
            title: dry ? `[演练] ${label}` : `${label} 进行中…`,
            detail: `${pair} · ${a.reason}`,
          })
          try {
            const r = await executeAction(a, {
              walletClient: wallet,
              owner: address,
              slippageBps,
              dryRun: dry,
            })
            updateToast(toastId, {
              kind: 'success',
              title: dry ? `[演练] ${label}` : `${label} 完成`,
              detail: `${pair} · ${r.note}`,
              href: r.hash ? explorerTx(r.hash) : undefined,
            })
            if (r.hash) setTxHistory(pushTxHistory({ label, hash: r.hash, pair }))
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            updateToast(toastId, { kind: 'error', title: `${label} 失败`, detail: msg })
            pushAutoLog({
              at: Date.now(),
              action: 'error',
              pair,
              tokenId: a.position.tokenId.toString(),
              detail: msg,
            })
            // 一笔失败就停掉这一轮，避免连环出错
            break
          }
        }
        if (!dry) {
          await refreshPositions({ silent: true })
          await refreshBalances(address)
        }
      } catch (e) {
        pushToast({
          kind: 'error',
          title: '自动化检查失败',
          detail: e instanceof Error ? e.message : String(e),
        })
      } finally {
        setAutoRunning(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signerMode, wallet, address, autoCfg, slippageBps, positions, refreshPositions, refreshBalances],
  )

  // 调度循环：只在本地私钥 + 总开关打开时跑。
  // runAutomation 每次跑完都会刷新 positions，函数身份跟着变；要是把它放进依赖，
  // 定时器会被重建、倒计时被重置回 5 秒，于是变成 5 秒一轮的失控循环。
  // 所以用 ref 固定住最新的实现，effect 只依赖真正的开关和间隔。
  const autoBusyRef = useRef(false)
  const runAutomationRef = useRef(runAutomation)
  useEffect(() => {
    runAutomationRef.current = runAutomation
  }, [runAutomation])

  useEffect(() => {
    if (!autoCfg.enabled || signerMode !== 'local' || !address) {
      setAutoNextIn(null)
      return
    }
    let left = 5 // 打开开关后 5 秒先跑一轮
    setAutoNextIn(left)
    const timer = window.setInterval(() => {
      if (document.hidden) return // 后台标签页不动手
      left -= 1
      if (left > 0) {
        setAutoNextIn(left)
        return
      }
      left = autoCfg.intervalSecs
      setAutoNextIn(left)
      if (autoBusyRef.current) return
      autoBusyRef.current = true
      void runAutomationRef
        .current()
        .finally(() => {
          autoBusyRef.current = false
        })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [autoCfg.enabled, autoCfg.intervalSecs, signerMode, address])

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
    let cancelled = false
    const requestChainId = chainId
    const requestChainKey = chainCfg.key
    const wrappedAddress = chainCfg.hasWrappedNative ? CONTRACTS.weth.toLowerCase() : null
    void (async () => {
      const shouldReadNative = pairHasWeth(pool.token0.address, pool.token1.address)
      const [b0, b1, native] = await Promise.allSettled([
        isNativeCurrency(pool.token0.address) ? getNativeBalance(address) : getErc20Balance(pool.token0.address, address),
        isNativeCurrency(pool.token1.address) ? getNativeBalance(address) : getErc20Balance(pool.token1.address, address),
        shouldReadNative ? getNativeBalance(address) : Promise.resolve(null),
      ])
      if (cancelled || getActiveChainId() !== requestChainId) return
      if (b0.status === 'fulfilled') {
        setBal0(b0.value)
        if (wrappedAddress && pool.token0.address.toLowerCase() === wrappedAddress) {
          setWethBal(b0.value)
          setWethBalStatus('ready')
        }
      }
      if (b1.status === 'fulfilled') {
        setBal1(b1.value)
        if (wrappedAddress && pool.token1.address.toLowerCase() === wrappedAddress) {
          setWethBal(b1.value)
          setWethBalStatus('ready')
        }
      }
      // 建仓页切到“直接付 ETH”时展示 ethBal；加载池时同步更新它，不能只依赖连接钱包那一次。
      if (native.status === 'fulfilled' && typeof native.value === 'bigint') {
        setEthBal(native.value)
        setEthBalStatus('ready')
        if (requestChainKey !== 'arc') {
          setGasTokenDisplay({ raw: native.value, decimals: 18 })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [address, chainCfg.hasWrappedNative, chainCfg.key, chainId, pool])

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
      const info = await findBestV3Pool(tokenA, tokenB, fee)
      if (!info) {
        setPool(null)
        setShowCreatePool(true)
        setStatus('该 Fee 尚无 V3 池（已查 Uniswap/Pancake）— 可在下方创建 Uniswap 池')
        return
      }
      if (info.sqrtPriceX96 === 0n) {
        setPool(null)
        setShowCreatePool(true)
        setStatus('池已部署但未初始化 — 填写初始价后创建/初始化')
        return
      }
      setPool(info)
      setShowCreatePool(false)
      applyDefaultCoinRange(info, setPriceLo, setPriceHi)
      {
        const q = getCoinQuote(info)
        setStatus(`已加载 ${info.dexLabel ?? 'V3'} · ${(info.fee / 10000).toFixed(2)}% · ${info.poolAddress ? shortAddr(info.poolAddress) : ''} · 币价 ${formatPrice(q.spot)} ${q.quote.symbol}/${q.coin.symbol}`)
      }
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

  /**
   * 从同币对已有池取「币」的 USD 单价填初始价。
   * 输入框语义：USD per 币（U 本位）。
   */
  const borrowInitPrice = async () => {
    setBusy(true)
    setStatus('查找同币对的已有池子…')
    try {
      const { coin, quote } = createSides
      const [coinUsd, qUsd] = await Promise.all([
        getTokenUsdPrice(coin),
        getTokenUsdPrice(quote),
      ])
      if (qUsd > 0) setQuoteUsd(qUsd)

      if (coinUsd > 0) {
        const shown = coinUsd >= 1 ? coinUsd.toFixed(4) : coinUsd.toPrecision(8)
        setInitPrice(shown)
        setStatus(`已取 ${tokenLabel(coin)} 现价 ≈ $${shown}（U 本位）`)
        return
      }

      const [v3, v4] = await Promise.all([
        scanV3Pools(tokenA, tokenB).catch(() => []),
        scanV4Pools(tokenA, tokenB).catch(() => []),
      ])
      const all = [...v3, ...v4].filter((p) => p.sqrtPriceX96 > 0n)
      if (!all.length) {
        setStatus('这个币对还没有任何已初始化的池子，初始价需要你自己定（USD）')
        return
      }
      const best = all.reduce((a, b) => (b.liquidity > a.liquidity ? b : a))
      const q = getCoinQuote(best)
      const quotePerCoin = q.coin.address.toLowerCase() === coin.toLowerCase() ? q.spot : 1 / q.spot
      const usd = (qUsd > 0 ? qUsd : quoteUsd) * quotePerCoin
      if (!(usd > 0) || !Number.isFinite(usd)) {
        setStatus('参考池价格异常，请手动填 USD 单价')
        return
      }
      const shown = usd >= 1 ? usd.toFixed(4) : usd.toPrecision(8)
      setInitPrice(shown)
      setStatus(
        `已取 ${best.version.toUpperCase()} ${(best.fee / 10000).toFixed(2)}% 池 → ≈ $${shown} / ${tokenLabel(coin)}`,
      )
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 选中一个发现出来的池子，直接进入下一步 */
  const pickDiscoveredPool = (info: PoolInfo) => {
    setPool(info)
    const q = getCoinQuote(info)
    setTokenA(q.coin.address)
    setTokenB(q.quote.address)
    setFee(info.fee)
    if (info.version === 'v4') {
      setMintProtocol('v4')
      if (info.tickSpacing) setV4TickSpacing(info.tickSpacing)
    } else {
      setMintProtocol('v3')
    }
    applyDefaultCoinRange(info, setPriceLo, setPriceHi)
    setShowCreatePool(false)
    setDiscovered(null)
    setDiscoverNote('')
    setStatus(
      `已选择 ${info.version.toUpperCase()} · ${q.coin.symbol}/${q.quote.symbol} · ${(info.fee / 10000).toFixed(2)}% · 币价 ${formatPrice(q.spot)} ${q.quote.symbol}/${q.coin.symbol}`,
    )
  }

  /** 粘贴代币合约 → 扫出该币的所有池子 */
  const discoverByToken = async (token: Address) => {
    setDiscovering(true)
    setDiscovered(null)
    setDiscoverNote('')
    setStatus('识别为代币合约，扫描相关池子…')
    try {
      // 先探活：Arc 公共 RPC 常挂，尽早失败并提示走钱包/自定义节点
      await withTimeout(publicClient.getBlockNumber(), 12_000, '连接 RPC')
      const rows = await withTimeout(
        discoverPoolsByToken(token, {
          includeV4: true,
          onStatus: (s) => setStatus(s),
        }),
        60_000,
        '扫描池子',
      )
      if (!rows.length) {
        setDiscoverNote('没找到已初始化的池子。可以在下方「创建新池」自己开一个。')
        setStatus('未找到该代币的任何池子')
        setShowCreatePool(true)
        setTokenA(token)
        return
      }
      setDiscovered(rows)
      setStatus(`找到 ${rows.length} 个池子，选一个继续`)
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e)
      if (chainCfg.key === 'arc' && /超时|RPC|fetch|network|refused|403|429/i.test(msg)) {
        msg =
          'Arc 主网公共 RPC 不可用。请先连接钱包（读取会走钱包节点），或在设置里填 Alchemy/QuickNode 等私有 RPC 后保存再试。'
      }
      setDiscoverNote(msg)
      setStatus(msg)
    } finally {
      setDiscovering(false)
    }
  }

  const loadPoolByAddress = async () => {
    const raw = poolInput.trim()
    if (!raw) return
    // 裸地址：先试池子，不是池子就当代币合约扫池子列表
    if (isAddress(raw)) {
      setBusy(true)
      try {
        const info = await loadPoolFromInput(raw)
        setPool(info)
        const q = getCoinQuote(info)
        setTokenA(q.coin.address)
        setTokenB(q.quote.address)
        setFee(info.fee)
        applyDefaultCoinRange(info, setPriceLo, setPriceHi)
        setDiscovered(null)
        setStatus(
          `已加载 V3 · ${shortAddr(raw as Address)} · ${q.coin.symbol}/${q.quote.symbol} · 币价 ${formatPrice(q.spot)} ${q.quote.symbol}/${q.coin.symbol}`,
        )
        return
      } catch {
        // 不是池子地址，走代币发现
      } finally {
        setBusy(false)
      }
      await discoverByToken(raw as Address)
      return
    }
    setBusy(true)
    setStatus('解析并加载池子…')
    try {
      const info = await loadPoolFromInput(poolInput)
      setDiscovered(null)
      setPool(info)
      if (info.version === 'v4') setMintProtocol('v4')
      else setMintProtocol('v3')
      {
        const q = getCoinQuote(info)
        setTokenA(q.coin.address)
        setTokenB(q.quote.address)
      }
      setFee(info.fee)
      if (info.tickSpacing) setV4TickSpacing(info.tickSpacing)
      // 超大 tickSpacing（如 3000）时默认 ±5% 会塌格；自动切全区间更稳
      if (info.tickSpacing >= 500) {
        setRangeMode('full')
      } else {
        applyDefaultCoinRange(info, setPriceLo, setPriceHi)
      }
      const q = getCoinQuote(info)
      const tag = info.version === 'v4'
        ? `V4 · poolId ${info.poolId ? shortAddr(info.poolId) : ''}`
        : `V3 · ${info.poolAddress ? shortAddr(info.poolAddress) : ''}`
      const feePct = (info.fee / 10_000).toFixed(2)
      const spacingNote = info.tickSpacing >= 500
        ? ` · spacing ${info.tickSpacing} 很大，已切全区间`
        : info.tickSpacing
          ? ` · spacing ${info.tickSpacing}`
          : ''
      const hooksNote =
        info.version === 'v4' && (!info.hooks || info.hooks === '0x0000000000000000000000000000000000000000')
          ? ' · hooks 空（若币种限制 PoolManager 结算，可能无法组 LP）'
          : ''
      setStatus(
        `已加载 ${tag} · ${q.coin.symbol}/${q.quote.symbol} · Fee ${feePct}%${spacingNote}${hooksNote} · 币价 ${formatPrice(q.spot)} ${q.quote.symbol}/${q.coin.symbol}`,
      )
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

  const finishToast = (
    toastId: number,
    patch: { kind: 'success' | 'error' | 'info'; title: string; detail?: string; href?: string },
  ) => {
    const ok = updateToast(toastId, patch)
    if (!ok) {
      // pending 已被挤出栈时补一条，避免界面永远停在「进行中…」
      pushToast(patch)
    }
  }

  const run = async (
    label: string,
    fn: () => Promise<unknown>,
    pair?: string,
    opts?: { afterSuccess?: () => void },
  ) => {
    if (!wallet || !address) {
      pushToast({ kind: 'error', title: '请先连接钱包' })
      return setStatus('请先连接钱包')
    }
    setBusy(true)
    setStatus(`${label} 进行中…`)
    setStatusHash(null)
    const toastId = pushToast({ kind: 'pending', title: `${label} 进行中…`, detail: pair })
    try {
      // 总超时兜底：钱包拒签不返回 / RPC 挂死时，别让「进行中」锁死整页
      const r = await withTimeout(fn(), 180_000, label)
      const hash = extractHash(r)
      const note = extractNote(r)
      if (hash) {
        setStatusHash(hash)
        setTxHistory(pushTxHistory({ label, hash, pair }))
      }
      const title = note ?? `${label} 已完成`
      setStatus(title)
      finishToast(toastId, {
        kind: note && /失败|加不进|不足|偏慢/.test(note) ? 'info' : 'success',
        title,
        detail: pair,
        href: hash ? explorerTx(hash) : undefined,
      })
      opts?.afterSuccess?.()
      // 后台刷新，不占用 busy，避免交易成功后按钮还锁几十秒
      void (async () => {
        try {
          await withTimeout(refreshPositions({ silent: true }), 45_000, '刷新仓位')
          if (address) await withTimeout(refreshBalances(address), 20_000, '刷新余额')
        } catch (e) {
          console.warn('post-tx refresh failed', e)
        }
      })()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const cancelled = /user rejected|denied|已取消/i.test(msg)
      const timedOut = /超时/.test(msg)
      setStatus(msg)
      finishToast(toastId, {
        kind: 'error',
        title: cancelled ? `${label} 已取消` : timedOut ? `${label} 超时` : `${label} 失败`,
        detail: msg,
      })
    } finally {
      setBusy(false)
    }
  }

  /** 用应用内弹窗替代 window.confirm，避免浏览器原生弹窗打断操作 */
  const confirmThen = useCallback(
    (opts: { title: string; lines?: string[]; confirmLabel?: string; danger?: boolean }, onConfirm: () => void) => {
      setConfirmReq({ ...opts, onConfirm })
    },
    [],
  )

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

  // 池子变化时加载深度剖面（不阻塞表单）
  useEffect(() => {
    if (!pool) {
      setPoolDepth(null)
      setDepthError(null)
      setDepthLoading(false)
      return
    }
    let cancelled = false
    setDepthLoading(true)
    setDepthError(null)
    void loadPoolDepth(pool)
      .then((d) => {
        if (cancelled) return
        setPoolDepth(d)
        setDepthLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setPoolDepth(null)
        setDepthError(e instanceof Error ? e.message : '深度加载失败')
        setDepthLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [pool?.poolAddress, pool?.poolId, pool?.tick, pool?.liquidity, pool?.version])

  const onDepthRangeChange = useCallback((range: { coinLower: number; coinUpper: number }) => {
    setRangeMode('custom')
    setPriceLo(formatPrice(range.coinLower))
    setPriceHi(formatPrice(range.coinUpper))
  }, [])

  // 切到单边区间时清掉不需要的那一侧输入
  useEffect(() => {
    if (!pool || !rangePreview) return
    if (pool.tick >= rangePreview.tickUpper) setAmount0('0')
    else if (pool.tick < rangePreview.tickLower) setAmount1('0')
  }, [pool, rangePreview])


  const tokenOptions = useMemo(() => {
    const weth = CONTRACTS.weth.toLowerCase()
    const zero = '0x0000000000000000000000000000000000000000'
    const gasSym = getNativeSymbol()
    const base = listKnownTokens().map((t) => ({
      addr: t.address,
      symbol: t.address.toLowerCase() === weth ? gasSym : t.symbol,
      decimals: t.decimals,
    }))
    const extra: { addr: Address; symbol: string; decimals: number }[] = []
    const pushExtra = (addr: Address) => {
      if (!addr || KNOWN_TOKENS[addr.toLowerCase()]) return
      if (extra.some((e) => e.addr.toLowerCase() === addr.toLowerCase())) return
      if (addr.toLowerCase() === zero || addr.toLowerCase() === weth) {
        extra.push({ addr, symbol: gasSym, decimals: 18 })
        return
      }
      const cached = tokenMetaCache[addr.toLowerCase()]
      extra.push({
        addr,
        symbol: cached?.symbol ?? shortAddr(addr),
        decimals: cached?.decimals ?? 18,
      })
    }
    pushExtra(tokenA)
    pushExtra(tokenB)
    return [...base, ...extra]
  }, [tokenA, tokenB, chainId, tokenMetaCache])

  /*
   * 地址一律按小写比对后再取回选项里的原始写法。
   *
   * 必须这样做的原因：knownTokens 的键是 .toLowerCase() 过的，所以 listKnownTokens()
   * 给出的是全小写地址；而 defaultTokenA / q.coin.address / meta.address 这些来源
   * 是 EIP-55 校验和写法。用 === 比就会漏：
   *   · <select value> 匹配不上任何 option，浏览器退回显示第一项 —— 界面显示 ETH，
   *     state 里其实是 USDG，点「扫描全部 Fee」扫的是另一个对；
   *   · decimals 查不到会回退 18，而 USDG 是 6 位。这个值会流进
   *     priceToSqrtPriceX96 / parseAmount，建池初始价和注入数量直接差 10^12 倍。
   */
  const findToken = (addr: Address) =>
    tokenOptions.find((x) => x.addr.toLowerCase() === addr?.toLowerCase())

  const tokenDecimals = (addr: Address) => {
    const known = KNOWN_TOKENS[addr?.toLowerCase()]?.decimals
    if (known != null) return known
    if (isArcUsdcErc20(addr)) return 6
    return tokenMetaCache[addr?.toLowerCase()]?.decimals ?? findToken(addr)?.decimals ?? 18
  }

  const pickToken = useCallback((side: 'a' | 'b', addr: Address, meta?: TokenOption) => {
    if (meta) {
      setTokenMetaCache((prev) => ({
        ...prev,
        [addr.toLowerCase()]: { symbol: meta.symbol, decimals: meta.decimals },
      }))
    }
    // 始终保持 tokenA=币、tokenB=报价：若一侧是原生/包装币，它必须落在报价侧
    let nextA = side === 'a' ? addr : tokenA
    let nextB = side === 'b' ? addr : tokenB
    const ethA = isEthLikeCurrency(nextA)
    const ethB = isEthLikeCurrency(nextB)
    if (ethA && !ethB) {
      const tmp = nextA
      nextA = nextB
      nextB = tmp
    }
    setTokenA(nextA)
    setTokenB(nextB)
  }, [tokenA, tokenB])

  const swapTokens = useCallback(() => {
    // 交换后若 ETH 落在币侧，再归一回「币 / 报价」
    const nextA = tokenB
    const nextB = tokenA
    if (isEthLikeCurrency(nextA) && !isEthLikeCurrency(nextB)) {
      setTokenA(nextB)
      setTokenB(nextA)
      return
    }
    setTokenA(nextA)
    setTokenB(nextB)
  }, [tokenA, tokenB])

  // 打开创建区时，纠正历史状态里颠倒的币/报价
  useEffect(() => {
    if (!showCreatePool) return
    if (isEthLikeCurrency(tokenA) && !isEthLikeCurrency(tokenB)) {
      setTokenA(tokenB)
      setTokenB(tokenA)
    }
  }, [showCreatePool, tokenA, tokenB])

  const tokenLabel = (addr: Address) => {
    if (isNativeCurrency(addr)) {
      return getNativeSymbol()
    }
    if (chainHasWrappedNative() && addr.toLowerCase() === CONTRACTS.weth.toLowerCase()) {
      return getNativeSymbol()
    }
    return findToken(addr)?.symbol ?? KNOWN_TOKENS[addr?.toLowerCase()]?.symbol ?? shortAddr(addr)
  }

  /** V3 链上永远是 WETH；V4 可选原生 ETH */
  const chainCurrency = (addr: Address) => {
    if (!isEthLikeCurrency(addr)) return addr
    if (mintProtocol === 'v3') return CONTRACTS.weth
    return useNativeEth ? '0x0000000000000000000000000000000000000000' as Address : CONTRACTS.weth
  }

  /**
   * 创建池时的「币 / 报价」划分，必须和下面 createSynth 的价格语义一致：
   * 一侧是 ETH 时 ETH 永远当报价；两侧都不是 ETH 时 A 当币、B 当报价。
   */
  const createSides = useMemo(() => {
    const ethA = isEthLikeCurrency(tokenA)
    const ethB = isEthLikeCurrency(tokenB)
    const quoteIsA = ethA && !ethB
    return { coin: quoteIsA ? tokenB : tokenA, quote: quoteIsA ? tokenA : tokenB }
  }, [tokenA, tokenB])

  /** 拉报价代币的 USD 单价，用来把 U 本位输入换算成链上要的「报价 per 币」 */
  useEffect(() => {
    if (!showCreatePool) return
    let alive = true
    setQuoteUsdBusy(true)
    void (async () => {
      const p = await getTokenUsdPrice(createSides.quote).catch(() => 0)
      if (!alive) return
      setQuoteUsd(p)
      setQuoteUsdBusy(false)
    })()
    return () => {
      alive = false
    }
  }, [showCreatePool, createSides.quote, chainId])

  /** U 本位输入（USD per 币）→ 报价 per 币。汇率缺失或输入非法都返回 null */
  const initPriceQuote = useMemo(() => {
    const usd = Number(initPrice.replace(/,/g, ''))
    if (!(usd > 0) || !Number.isFinite(usd)) return null
    if (!(quoteUsd > 0) || !Number.isFinite(quoteUsd)) return null
    const v = usd / quoteUsd
    if (!(v > 0) || !Number.isFinite(v)) return null
    return v
  }, [initPrice, quoteUsd])

  /** 根据初始价 + 区间预设，预览创建池（用于初仓数量自动配平） */
  const createSynth = useMemo(() => {
    const price = initPriceQuote
    if (price == null) return null

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
    const decA = tokenDecimals(tokenA)
    const decB = tokenDecimals(tokenB)
    const d0 = sortedAFirst ? decA : decB
    const d1 = sortedAFirst ? decB : decA
    const sym0 = sortedAFirst ? tokenLabel(tokenA) : tokenLabel(tokenB)
    const sym1 = sortedAFirst ? tokenLabel(tokenB) : tokenLabel(tokenA)

    let sortedPrice = initialPriceBPerA
    if (t0.toLowerCase() !== rawA.toLowerCase()) sortedPrice = 1 / initialPriceBPerA

    const spacing =
      mintProtocol === 'v4'
        ? Math.max(1, Number(v4TickSpacing) || suggestV4TickSpacing(useFee))
        : useFee === 100
          ? 1
          : useFee === 500
            ? 10
            : useFee === 2500
              ? 50
              : useFee === 3000
                ? 60
                : 200

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

    let range: ReturnType<typeof describeRange>
    if (createRangePreset === 'full') {
      range = describeFullRange(synth)
    } else if (createRangePreset === 'custom') {
      const usdLo = Number(createUsdLo.replace(/,/g, ''))
      const usdHi = Number(createUsdHi.replace(/,/g, ''))
      if (!(usdLo > 0) || !(usdHi > 0) || usdLo >= usdHi) return null
      if (!(quoteUsd > 0)) return null
      // U 本位 → 报价 per 币（与初始价同一换算），再落成 tick
      try {
        range = ticksFromCoinPrices(synth, usdLo / quoteUsd, usdHi / quoteUsd)
      } catch {
        return null
      }
    } else {
      const pct =
        createRangePreset === 'onesided-eth' && (ethA || ethB)
          ? oneSidedEthPercents()
          : typeof createRangePreset === 'number'
            ? { percentLower: -createRangePreset, percentUpper: createRangePreset }
            : { percentLower, percentUpper: percentUp }
      range = describeRange(synth, pct.percentLower, pct.percentUpper)
    }

    return { synth, range, sortedAFirst, rawA, rawB, initialPriceBPerA, useFee, decA, decB }
  }, [
    initPriceQuote,
    quoteUsd,
    tokenA,
    tokenB,
    fee,
    mintProtocol,
    v4TickSpacing,
    customFeeInput,
    useNativeEth,
    createRangePreset,
    createUsdLo,
    createUsdHi,
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

  const createPaymentKey = showCreatePool
    ? `create:${chainId}:${tokenA.toLowerCase()}:${tokenB.toLowerCase()}`
    : ''
  const createHasEthLike = isEthLikeCurrency(tokenA) || isEthLikeCurrency(tokenB)

  // 新建 ETH 对：有原生币就默认付 ETH，别拿 0 WETH 标成「ETH 余额 0」。
  useEffect(() => {
    if (!showCreatePool || !createHasEthLike) return
    if (createPaymentTouchedRef.current !== createPaymentKey) {
      createPaymentTouchedRef.current = null
    }
    if (createPaymentTouchedRef.current === createPaymentKey) return
    const choice = chooseWrappedPoolPayment({
      nativeBalance: ethBal,
      wrappedBalance: wethBal,
      nativeStatus: ethBalStatus,
      wrappedStatus: wethBalStatus,
      gasReserve: MINT_GAS_RESERVE_WEI,
    })
    if (choice) setUseNativeEth(choice === 'native')
  }, [
    showCreatePool,
    createHasEthLike,
    createPaymentKey,
    ethBal,
    wethBal,
    ethBalStatus,
    wethBalStatus,
  ])

  useEffect(() => {
    if (!address || !showCreatePool) return
    let cancelled = false
    void (async () => {
      const balA = isEthLikeCurrency(tokenA)
        ? (useNativeEth ? ethBal : wethBal)
        : await getErc20Balance(tokenA, address)
      const balB = isEthLikeCurrency(tokenB)
        ? (useNativeEth ? ethBal : wethBal)
        : await getErc20Balance(tokenB, address)
      if (cancelled) return
      setCreateSeedBalA(balA)
      setCreateSeedBalB(balB)
    })()
    return () => {
      cancelled = true
    }
  }, [address, showCreatePool, tokenA, tokenB, ethBal, wethBal, useNativeEth])

  const createSideLabel = (addr: Address) => {
    if (!isEthLikeCurrency(addr)) return tokenLabel(addr)
    return useNativeEth ? getNativeSymbol() : getWrappedNativeSymbol()
  }
  const createSideBalanceStatus = (addr: Address): BalanceReadStatus => {
    if (!isEthLikeCurrency(addr)) return 'ready'
    return useNativeEth ? ethBalStatus : wethBalStatus
  }

  const fillCreateSeedBalances = (pct = 100) => {
    if (!createSynth) return
    const { synth, range, sortedAFirst, decA, decB } = createSynth
    const f = BigInt(Math.floor(pct * 100))
    const gasReserve = 10n ** 15n
    let availA = createSeedBalA
    let availB = createSeedBalB
    if (useNativeEth && isEthLikeCurrency(tokenA)) {
      availA = ethBal > gasReserve ? ethBal - gasReserve : 0n
    }
    if (useNativeEth && isEthLikeCurrency(tokenB)) {
      availB = ethBal > gasReserve ? ethBal - gasReserve : 0n
    }
    availA = (availA * f) / 10000n
    availB = (availB * f) / 10000n

    const avail0 = sortedAFirst ? availA : availB
    const avail1 = sortedAFirst ? availB : availA

    const applyPool = (a0: bigint, a1: bigint) => {
      if (sortedAFirst) {
        setSeedAmtA(formatAmountExact(a0, decA))
        setSeedAmtB(formatAmountExact(a1, decB))
      } else {
        setSeedAmtA(formatAmountExact(a1, decA))
        setSeedAmtB(formatAmountExact(a0, decB))
      }
    }

    const wethA = isEthLikeCurrency(tokenA)
    const wethB = isEthLikeCurrency(tokenB)

    if (createRangePreset === 'onesided-eth' && (wethA || wethB)) {
      const ethSide: 0 | 1 = wethA ? (sortedAFirst ? 0 : 1) : (sortedAFirst ? 1 : 0)
      const ethAvail = ethSide === 0 ? avail0 : avail1
      const paired = pairAmountForRange({
        sqrtPriceX96: synth.sqrtPriceX96,
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        amount: ethAvail,
        side: ethSide,
      })
      applyPool(paired.amount0, paired.amount1)
      return
    }

    const from0 = pairAmountForRange({
      sqrtPriceX96: synth.sqrtPriceX96,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      amount: avail0,
      side: 0,
    })
    const from1 = pairAmountForRange({
      sqrtPriceX96: synth.sqrtPriceX96,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      amount: avail1,
      side: 1,
    })
    if (from0.singleSided === 'token1' || from1.singleSided === 'token1') {
      applyPool(0n, from1.amount1)
      return
    }
    if (from0.singleSided === 'token0' || from1.singleSided === 'token0') {
      applyPool(from0.amount0, 0n)
      return
    }
    if (from0.amount0 > 0n && from0.amount1 <= avail1) {
      applyPool(from0.amount0, from0.amount1)
      return
    }
    if (from1.amount1 > 0n && from1.amount0 <= avail0) {
      applyPool(from1.amount0, from1.amount1)
      return
    }
    if (from0.amount0 > 0n) applyPool(from0.amount0, from0.amount1)
    else applyPool(from1.amount0, from1.amount1)
  }

  const createPool = async () => {
    if (!address || !wallet) {
      setStatus('请先连接钱包')
      return
    }
    // 新建池走 Uniswap Factory；Pancake 深池请直接「加载」后 Mint，勿在此重复创建
    if (tokenA.toLowerCase() === tokenB.toLowerCase()) {
      setStatus('两个 Token 不能相同')
      return
    }
    const usd = Number(initPrice.replace(/,/g, ''))
    if (!(usd > 0)) {
      setStatus('请填写有效的初始价（USD per 币）')
      return
    }
    if (!createSynth) {
      if (createRangePreset === 'custom') {
        setStatus('请填写有效的 U 本位区间（下限 < 上限），并确保初始价与报价汇率可用')
        return
      }
      if (quoteUsdBusy) setStatus('正在拉取报价币 USD 汇率…')
      else setStatus(`无法换算链上价格：请确认 ${tokenLabel(createSides.quote)} 汇率可用，或换稳定币作报价`)
      return
    }

    const ethA = isEthLikeCurrency(tokenA)
    const ethB = isEthLikeCurrency(tokenB)
    const initialPriceBPerA = createSynth.initialPriceBPerA
    const useFee = createSynth.useFee
    const decA = createSynth.decA
    const decB = createSynth.decB

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

    // V3：按 WETH 地址排序 amount0/1。V4：把 A/B 原样交给 createV4PoolAndSeed，
    // 内部按原生 0x0 / 代币排序——切勿在外面用 WBNB 排序，否则会和 0x0 对调两侧数量。
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
        ? `准备创建 ${mintProtocol.toUpperCase()} 池…`
        : `准备创建 / 初始化 ${mintProtocol.toUpperCase()} 池…`,
    )
    try {
      if (mintProtocol === 'v4') {
        // 池费率（你要的 0.25%）≠ 币转账扣费。注入初仓时自动探测并垫付，无需手填。
        let taxA = 0
        let taxB = 0
        if (seedOnCreate && (chainId === 56 || chainId === 1)) {
          setStatus('注入前自动检测代币转账扣费（与池费率无关）…')
          const probe = async (addr: Address) => {
            if (isEthLikeCurrency(addr) || isHoneypotWhitelisted(chainId, addr)) return 0
            const bps = await fetchTransferTaxBps(chainId, addr)
            return bps != null && bps > 0 ? bps : 0
          }
          ;[taxA, taxB] = await Promise.all([probe(tokenA), probe(tokenB)])
          // 手填优先取更大值（防动态税低估）
          if (!isEthLikeCurrency(tokenA) && !isHoneypotWhitelisted(chainId, tokenA)) {
            taxA = Math.max(taxA, transferTaxBps)
          }
          if (!isEthLikeCurrency(tokenB) && !isHoneypotWhitelisted(chainId, tokenB)) {
            taxB = Math.max(taxB, transferTaxBps)
          }
          if (taxA > 0 || taxB > 0) {
            const shown = Math.max(taxA, taxB)
            setTransferTaxBps((prev) => (prev > 0 ? prev : shown))
            setStatus(
              `池费率 ${(useFee / 10000).toFixed(2)}% · 已自动按转账扣费约 ${(shown / 100).toFixed(2)}% 垫付注入…`,
            )
          }
        } else {
          taxA = isHoneypotWhitelisted(chainId, tokenA) || isEthLikeCurrency(tokenA) ? 0 : transferTaxBps
          taxB = isHoneypotWhitelisted(chainId, tokenB) || isEthLikeCurrency(tokenB) ? 0 : transferTaxBps
        }
        const { pool: info, hash, seeded } = await createV4PoolAndSeed({
          walletClient: wallet,
          owner: address,
          tokenA,
          tokenB,
          fee: useFee,
          tickSpacing: v4TickSpacing,
          initialPriceBPerA,
          amountA: seedOnCreate ? amountA : undefined,
          amountB: seedOnCreate ? amountB : undefined,
          tickLower,
          tickUpper,
          // 非 ETH 对绝不走原生/Wrap 路径（避免误弹换 WETH）
          useNativeEth: useNativeEth && (ethA || ethB),
          slippageBps,
          transferTaxBpsA: taxA,
          transferTaxBpsB: taxB,
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
          tokenA: chainCurrency(tokenA),
          tokenB: chainCurrency(tokenB),
          fee: useFee,
          initialPriceBPerA,
          amount0: seedOnCreate ? amount0 : undefined,
          amount1: seedOnCreate ? amount1 : undefined,
          tickLower,
          tickUpper,
          useNativeEth: useNativeEth && (ethA || ethB),
          slippageBps,
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
    const eth0 = isEthLikeCurrency(pool.token0.address)
    const eth1 = isEthLikeCurrency(pool.token1.address)
    let avail0 = bal0
    let avail1 = bal1
    if (useNativeEth && eth0) avail0 = ethBal > gasReserve ? ethBal - gasReserve : 0n
    if (useNativeEth && eth1) avail1 = ethBal > gasReserve ? ethBal - gasReserve : 0n
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
    const from1 = pairAmountForRange({
      sqrtPriceX96: pool.sqrtPriceX96,
      tickLower: mintTicks.tickLower,
      tickUpper: mintTicks.tickUpper,
      amount: avail1,
      side: 1,
    })

    // 区间上方只要 token1；下方只要 token0
    if (from0.singleSided === 'token1' || from1.singleSided === 'token1') {
      apply(0n, from1.amount1)
      setPairSide(1)
      return
    }
    if (from0.singleSided === 'token0' || from1.singleSided === 'token0') {
      apply(from0.amount0, 0n)
      setPairSide(0)
      return
    }
    if (from0.amount0 > 0n && from0.amount1 <= avail1) {
      apply(from0.amount0, from0.amount1)
      setPairSide(0)
      return
    }
    if (from1.amount1 > 0n && from1.amount0 <= avail0) {
      apply(from1.amount0, from1.amount1)
      setPairSide(1)
      return
    }
    if (from0.amount0 > 0n) {
      apply(from0.amount0, from0.amount1)
      setPairSide(0)
      return
    }
    apply(from1.amount0, from1.amount1)
    setPairSide(1)
  }

  const onMintSide = (side: 0 | 1, raw: string) => {
    if (!pool || !mintTicks) {
      if (side === 0) setAmount0(raw)
      else setAmount1(raw)
      setPairSide(side)
      return
    }
    const need = neededMintSide(pool.tick, mintTicks.tickLower, mintTicks.tickUpper)
    // 单边区间点到不需要的一侧：清零并忽略，避免 Max 把可用侧冲掉
    if (need !== 'both' && need !== side) {
      if (side === 0) setAmount0('0')
      else setAmount1('0')
      return
    }
    if (side === 0) setAmount0(raw)
    else setAmount1(raw)
    setPairSide(side)
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

  /**
   * 区间或池价一变，就按用户最后编辑的那一侧重新配平另一侧。
   * 之前只在敲键盘时配平，调完百分比/价格后数量就成了旧的，得手动算 —— 这个 effect 补掉那个坑。
   */
  const lowerT = mintTicks?.tickLower
  const upperT = mintTicks?.tickUpper
  const poolSqrt = pool?.sqrtPriceX96
  useEffect(() => {
    if (!pool || lowerT == null || upperT == null || poolSqrt == null) return
    const src = pairSide === 0 ? amount0 : amount1
    const dec = pairSide === 0 ? pool.token0.decimals : pool.token1.decimals
    const amount = parseAmount(src || '0', dec)
    if (amount <= 0n) return
    const paired = pairAmountForRange({
      sqrtPriceX96: poolSqrt,
      tickLower: lowerT,
      tickUpper: upperT,
      amount,
      side: pairSide,
    })
    if (pairSide === 0) {
      const next = formatAmountExact(paired.amount1, pool.token1.decimals)
      setAmount1((prev) => (prev === next ? prev : next))
    } else {
      const next = formatAmountExact(paired.amount0, pool.token0.decimals)
      setAmount0((prev) => (prev === next ? prev : next))
    }
    // amount0/amount1 故意不进依赖：那是敲键盘时 onMintSide 的活，这里只管区间/价格变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lowerT, upperT, poolSqrt, pairSide, pool])

  const onAddSide = (side: 0 | 1, raw: string) => {
    if (!selected) return
    const need = neededMintSide(selected.tick, selected.tickLower, selected.tickUpper)
    if (need !== 'both' && need !== side) {
      if (side === 0) setAdd0('0')
      else setAdd1('0')
      return
    }
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
  const poolHasNativeToken = Boolean(
    pool && (isNativeCurrency(pool.token0.address) || isNativeCurrency(pool.token1.address)),
  )
  const poolHasWrappedToken = Boolean(
    pool
      && chainCfg.hasWrappedNative
      && (
        pool.token0.address.toLowerCase() === CONTRACTS.weth.toLowerCase()
        || pool.token1.address.toLowerCase() === CONTRACTS.weth.toLowerCase()
      ),
  )
  const mintPaymentPoolKey = pool
    ? `${chainId}:${pool.version}:${pool.poolId ?? pool.poolAddress ?? ''}:${pool.token0.address}:${pool.token1.address}`
    : ''
  const mintUseEth = useNativeEth && poolUsesWeth

  // 原生池只能付原生币；WETH/WBNB 池等余额读完后默认选择真正有资金的一边。
  // 用户一旦手动选择，本池后续后台刷新不得覆盖。
  useEffect(() => {
    if (!pool) return
    if (mintPaymentTouchedPoolRef.current !== mintPaymentPoolKey) {
      mintPaymentTouchedPoolRef.current = null
    }
    if (poolHasNativeToken) {
      setUseNativeEth(true)
      return
    }
    if (!poolHasWrappedToken) {
      setUseNativeEth(false)
      return
    }
    if (mintPaymentTouchedPoolRef.current === mintPaymentPoolKey) return
    const choice = chooseWrappedPoolPayment({
      nativeBalance: ethBal,
      wrappedBalance: wethBal,
      nativeStatus: ethBalStatus,
      wrappedStatus: wethBalStatus,
      gasReserve: MINT_GAS_RESERVE_WEI,
    })
    if (choice) setUseNativeEth(choice === 'native')
  }, [
    pool,
    mintPaymentPoolKey,
    poolHasNativeToken,
    poolHasWrappedToken,
    ethBal,
    wethBal,
    ethBalStatus,
    wethBalStatus,
  ])

  const selectMintPayment = (payment: 'native' | 'wrapped') => {
    mintPaymentTouchedPoolRef.current = mintPaymentPoolKey
    setUseNativeEth(payment === 'native')
  }

  /** 把 UI 的「山寨币税」映射到 pool.token0/1；稳定币/WETH/原生为 0 */
  const mintTransferTax = useMemo(() => {
    if (!pool || transferTaxBps <= 0) return { tax0: 0, tax1: 0 }
    const taxSide = (addr: Address) => {
      if (isEthLikeCurrency(addr) || isNativeCurrency(addr)) return 0
      if (isHoneypotWhitelisted(chainId, addr)) return 0
      return transferTaxBps
    }
    return { tax0: taxSide(pool.token0.address), tax1: taxSide(pool.token1.address) }
  }, [pool, transferTaxBps, chainId])

  // 换池 / 换仓时清空转账税，再由 GoPlus 探测（按当前 Tab 选源）
  const taxProbeKey =
    tab === 'mint' && pool?.version === 'v4'
      ? `pool:${pool.poolId ?? pool.poolAddress ?? ''}`
      : tab === 'positions' && selected?.version === 'v4'
        ? `pos:${selected.tokenId}:${selected.token0.address}:${selected.token1.address}`
        : pool?.version === 'v4'
          ? `pool:${pool.poolId ?? pool.poolAddress ?? ''}`
          : selected?.version === 'v4'
            ? `pos:${selected.tokenId}:${selected.token0.address}:${selected.token1.address}`
            : ''
  useEffect(() => {
    setTransferTaxBps(0)
  }, [taxProbeKey, chainId])

  // V4 自动探测转账税（BSC/ETH GoPlus）
  useEffect(() => {
    if (chainId !== 56 && chainId !== 1 || !taxProbeKey) return
    const tokens: Address[] | null = taxProbeKey.startsWith('pool:') && pool?.version === 'v4'
      ? [pool.token0.address, pool.token1.address]
      : taxProbeKey.startsWith('pos:') && selected?.version === 'v4'
        ? [selected.token0.address, selected.token1.address]
        : null
    if (!tokens) return
    let cancelled = false
    const run = async () => {
      const candidates = tokens.filter(
        (a) => !isEthLikeCurrency(a) && !isNativeCurrency(a) && !isHoneypotWhitelisted(chainId, a),
      )
      let best = 0
      for (const addr of candidates) {
        const bps = await fetchTransferTaxBps(chainId, addr)
        if (bps != null && bps > best) best = bps
      }
      if (!cancelled && best > 0) {
        setTransferTaxBps((prev) => (prev > 0 ? prev : best))
        setStatus(`检测到代币转账税约 ${(best / 100).toFixed(2)}%，已填入 V4 垫付（可改）`)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [taxProbeKey, chainId, pool, selected])
  const mintNeedSide = pool && mintTicks
    ? neededMintSide(pool.tick, mintTicks.tickLower, mintTicks.tickUpper)
    : 'both'
  const label0 = pool
    ? (mintUseEth && isEthLikeCurrency(pool.token0.address) ? getNativeSymbol() : pool.token0.symbol)
    : ''
  const label1 = pool
    ? (mintUseEth && isEthLikeCurrency(pool.token1.address) ? getNativeSymbol() : pool.token1.symbol)
    : ''
  const showBal0IsNative = Boolean(pool && mintUseEth && isEthLikeCurrency(pool.token0.address))
  const showBal1IsNative = Boolean(pool && mintUseEth && isEthLikeCurrency(pool.token1.address))
  const showBal0IsWrapped = Boolean(
    pool
      && !showBal0IsNative
      && chainCfg.hasWrappedNative
      && pool.token0.address.toLowerCase() === CONTRACTS.weth.toLowerCase(),
  )
  const showBal1IsWrapped = Boolean(
    pool
      && !showBal1IsNative
      && chainCfg.hasWrappedNative
      && pool.token1.address.toLowerCase() === CONTRACTS.weth.toLowerCase(),
  )
  const showBal0 = pool
    ? (showBal0IsNative ? ethBal : showBal0IsWrapped ? wethBal : bal0)
    : 0n
  const showBal1 = pool
    ? (showBal1IsNative ? ethBal : showBal1IsWrapped ? wethBal : bal1)
    : 0n
  const showBal0Status: BalanceReadStatus = showBal0IsNative
    ? ethBalStatus
    : showBal0IsWrapped
      ? wethBalStatus
      : 'ready'
  const showBal1Status: BalanceReadStatus = showBal1IsNative
    ? ethBalStatus
    : showBal1IsWrapped
      ? wethBalStatus
      : 'ready'
  const headerBalanceText = (raw: bigint, status: BalanceReadStatus, symbol: string) => {
    if (status === 'ready') return `${formatAmount(raw, 18, 4)} ${symbol}`
    if (status === 'error') return `读取失败 ${symbol}`
    if (raw > 0n) return `${formatAmount(raw, 18, 4)} ${symbol}`
    return `… ${symbol}`
  }
  const mintBalanceText = (raw: bigint, decimals: number, balanceStatus: BalanceReadStatus = 'ready') => {
    if (balanceStatus === 'ready') return formatAmount(raw, decimals, 6)
    if (balanceStatus === 'error') return '读取失败'
    if (raw > 0n) return formatAmount(raw, decimals, 6)
    return '读取中…'
  }
  const gasReserve = MINT_GAS_RESERVE_WEI
  const mintMax0 = pool
    ? (showBal0IsNative
      ? (ethBal > MINT_GAS_RESERVE_WEI ? ethBal - MINT_GAS_RESERVE_WEI : 0n)
      : showBal0)
    : 0n
  const mintMax1 = pool
    ? (showBal1IsNative
      ? (ethBal > MINT_GAS_RESERVE_WEI ? ethBal - MINT_GAS_RESERVE_WEI : 0n)
      : showBal1)
    : 0n

  /**
   * 建仓预览：两侧折算成 token1 的价值占比 + 余额是否够。
   * 用池价换算（不查 USD 报价），任何币对都能算，不依赖外部行情。
   */
  const mintPlan = useMemo(() => {
    if (!pool) return null
    const raw0 = parseAmount(amount0 || '0', pool.token0.decimals)
    const raw1 = parseAmount(amount1 || '0', pool.token1.decimals)
    const n0 = Number(formatAmountExact(raw0, pool.token0.decimals)) || 0
    const n1 = Number(formatAmountExact(raw1, pool.token1.decimals)) || 0
    // token0 折算成 token1：price = token1 per token0
    const v0 = pool.price > 0 ? n0 * pool.price : 0
    const v1 = n1
    const total = v0 + v1
    const pct0 = total > 0 ? (v0 / total) * 100 : 0
    const short0 = showBal0Status === 'ready' && raw0 > showBal0
    const short1 = showBal1Status === 'ready' && raw1 > showBal1
    return {
      raw0,
      raw1,
      n0,
      n1,
      total,
      pct0,
      pct1: total > 0 ? 100 - pct0 : 0,
      short0,
      short1,
      empty: raw0 === 0n && raw1 === 0n,
      unit: pool.token1.symbol,
    }
  }, [pool, amount0, amount1, showBal0, showBal1, showBal0Status, showBal1Status])

  /**
   * 经典建仓和 DLMM 模式共用同一条真实 Mint 链路。
   * 这样单边 Bid / Ask 不是另写一套「看起来能点」的逻辑：刷新现价、过期区间重锚、
   * V4 税币垫付和错误翻译都与原建仓页保持一致。
   */
  const startMintPosition = (opts: {
    targetPool: PoolInfo
    tickLower: number
    tickUpper: number
    coinPriceLower: number
    coinPriceUpper: number
    input0: string
    input1: string
    actionLabel: string
    dlmm?: {
      plan: EvmDlmmPlan
    }
    afterSuccess?: () => void
  }) => {
    const {
      targetPool,
      tickLower,
      tickUpper,
      coinPriceLower,
      coinPriceUpper,
      input0,
      input1,
      actionLabel,
      dlmm,
      afterSuccess,
    } = opts
    const raw0 = parseAmount(input0 || '0', targetPool.token0.decimals)
    const raw1 = parseAmount(input1 || '0', targetPool.token1.decimals)
    if (raw0 === 0n && raw1 === 0n) {
      setStatus('请先输入数量')
      return
    }

    const plannedTick = targetPool.tick
    const plannedSpot = getCoinQuote(targetPool).spot
    const isV4 = targetPool.version === 'v4'
    void run(actionLabel, async () => {
      const live = isV4
        ? (targetPool.hooks != null && targetPool.tickSpacing
          ? await loadV4Pool({
              currency0: targetPool.token0.address,
              currency1: targetPool.token1.address,
              fee: targetPool.fee,
              tickSpacing: targetPool.tickSpacing,
              hooks: targetPool.hooks,
            })
          : await findV4Pool(targetPool.token0.address, targetPool.token1.address, targetPool.fee).then((next) => {
              if (!next) throw new Error('刷新 V4 池失败')
              return next
            }))
        : await loadV3Pool(targetPool.poolAddress!)
      setPool(live)

      let useLower = tickLower
      let useUpper = tickUpper
      let mint0 = parseAmount(input0 || '0', live.token0.decimals)
      let mint1 = parseAmount(input1 || '0', live.token1.decimals)

      if (dlmm) {
        // 固定用户确认过的绝对价格范围，再用最新池价校验方向。
        // 单边越界直接停止；双边范围仍覆盖现价时继续使用两种明确输入的币。
        const freshPlan = refreshEvmDlmmPlan(live, dlmm.plan)
        useLower = freshPlan.tickLower
        useUpper = freshPlan.tickUpper
        if (freshPlan.depositTokenIndex === 0) mint1 = 0n
        if (freshPlan.depositTokenIndex === 1) mint0 = 0n
        setStatus(
          `最新池价校验通过，${freshPlan.side === 'both' ? '双边' : freshPlan.side === 'bid' ? 'Bid' : 'Ask'} 范围 ${formatPrice(freshPlan.coinPriceLower)} – ${formatPrice(freshPlan.coinPriceUpper)}，继续创建…`,
        )
      } else if (isOneSidedRangeStale({
        plannedTick,
        liveTick: live.tick,
        tickLower: useLower,
        tickUpper: useUpper,
      })) {
        const fresh = reanchorRangeToLiveSpot({
          livePool: live,
          plannedSpot,
          coinLower: coinPriceLower,
          coinUpper: coinPriceUpper,
        })
        if (!fresh) throw new Error('现价已变化且无法自动重设区间，请刷新后重新确认')
        useLower = fresh.tickLower
        useUpper = fresh.tickUpper
        const remapped = remapMintAmountsForRange({
          sqrtPriceX96: live.sqrtPriceX96,
          tickLower: useLower,
          tickUpper: useUpper,
          amount0: mint0,
          amount1: mint1,
          liveTick: live.tick,
        })
        mint0 = remapped.amount0
        mint1 = remapped.amount1
        if (mint0 <= 0n && mint1 <= 0n) {
          throw new Error('自动重设区间后数量无效，请重新输入数量')
        }
        // 同步经典建仓页，方便失败后切回去核对精确 ticks / 数量。
        setRangeMode('custom')
        setPriceLo(formatPrice(fresh.coinPriceLower))
        setPriceHi(formatPrice(fresh.coinPriceUpper))
        setAmount0(formatAmountExact(mint0, live.token0.decimals))
        setAmount1(formatAmountExact(mint1, live.token1.decimals))
        setStatus(
          `现价已变，已把单边区间重锚到 ${formatPrice(fresh.coinPriceLower)} – ${formatPrice(fresh.coinPriceUpper)}，继续创建…`,
        )
      }

      if (isV4) {
        return mintV4Position({
          walletClient: wallet!,
          owner: address!,
          pool: live,
          amount0: mint0,
          amount1: mint1,
          tickLower: useLower,
          tickUpper: useUpper,
          useNativeEth: mintUseEth,
          slippageBps,
          transferTaxBps0: mintTransferTax.tax0,
          transferTaxBps1: mintTransferTax.tax1,
          strictSingleSidedToken: dlmm && dlmm.plan.depositTokenIndex !== 'both'
            ? targetPool[dlmm.plan.depositTokenIndex === 0 ? 'token0' : 'token1'].address
            : undefined,
          onStatus: setStatus,
        })
      }
      return mintV3Position({
        walletClient: wallet!,
        owner: address!,
        pool: live,
        amount0: mint0,
        amount1: mint1,
        tickLower: useLower,
        tickUpper: useUpper,
        useNativeEth: mintUseEth,
        slippageBps,
        strictSingleSidedToken: dlmm && dlmm.plan.depositTokenIndex !== 'both'
          ? targetPool[dlmm.plan.depositTokenIndex === 0 ? 'token0' : 'token1'].address
          : undefined,
        onStatus: setStatus,
      })
    }, `${targetPool.token0.symbol}/${targetPool.token1.symbol}`, { afterSuccess })
  }

  const startDlmmMint = (request: DlmmMintRequest) => {
    if (!pool) return
    const sideLabel = request.side === 'bid' ? 'Bid' : request.side === 'ask' ? 'Ask' : '双边'
    if (request.executionMode === 'multi') {
      const sourcePool = pool
      const sourceAmount0 = parseAmount(request.amount0 || '0', sourcePool.token0.decimals)
      const sourceAmount1 = parseAmount(request.amount1 || '0', sourcePool.token1.decimals)
      void run(
        `批量创建 ${request.trancheCount} 档 ${sideLabel} · ${sourcePool.version.toUpperCase()}`,
        async () => {
          const live = sourcePool.version === 'v4'
            ? (sourcePool.hooks != null && sourcePool.tickSpacing
              ? await loadV4Pool({
                  currency0: sourcePool.token0.address,
                  currency1: sourcePool.token1.address,
                  fee: sourcePool.fee,
                  tickSpacing: sourcePool.tickSpacing,
                  hooks: sourcePool.hooks,
                })
              : await findV4Pool(
                  sourcePool.token0.address,
                  sourcePool.token1.address,
                  sourcePool.fee,
                ).then((next) => {
                  if (!next) throw new Error('刷新 V4 池失败')
                  return next
                }))
            : await loadV3Pool(sourcePool.poolAddress!)
          setPool(live)
          const freshPlan = refreshEvmDlmmPlan(live, request.plan)
          const tranches = buildEvmDlmmTranches(
            live,
            freshPlan,
            request.shape,
            request.trancheCount,
          )
          if (tranches.length < 2) throw new Error('当前范围不足以拆成多档，请增加 Bin 数')
          const allocations = allocateDlmmAmounts(sourceAmount0, sourceAmount1, tranches)
          const allocationsReady = allocations.every((amount, index) => {
            const required = tranches[index]?.liquiditySide
            if (required === 0) return amount.amount0 > 0n
            if (required === 1) return amount.amount1 > 0n
            return amount.amount0 > 0n && amount.amount1 > 0n
          })
          if (!allocationsReady) {
            throw new Error('数量太小，无法分配到全部档位；请增加数量或减少档位')
          }
          const bands = tranches.map((tranche, index) => ({
            tickLower: tranche.tickLower,
            tickUpper: tranche.tickUpper,
            amount0: allocations[index]?.amount0 ?? 0n,
            amount1: allocations[index]?.amount1 ?? 0n,
          }))
          setStatus(
            `已按最新价格重建 ${bands.length} 档 ${sideLabel}，准备一笔原子批量 Mint…`,
          )
          const strictToken = freshPlan.depositTokenIndex === 'both'
            ? undefined
            : live[freshPlan.depositTokenIndex === 0 ? 'token0' : 'token1'].address
          const result = live.version === 'v4'
            ? await mintV4DlmmPositions({
              walletClient: wallet!,
              owner: address!,
              pool: live,
              bands,
              useNativeEth: mintUseEth,
              slippageBps,
              transferTaxBps0: mintTransferTax.tax0,
              transferTaxBps1: mintTransferTax.tax1,
              strictSingleSidedToken: strictToken,
              onStatus: setStatus,
            })
            : await mintV3DlmmPositions({
              walletClient: wallet!,
              owner: address!,
              pool: live,
              bands,
              useNativeEth: mintUseEth,
              slippageBps,
              strictSingleSidedToken: strictToken,
              onStatus: setStatus,
            })
          const record = createDlmmGroupRecord({
            chainId,
            owner: address!,
            pool: result.pool,
            side: request.side,
            shape: request.shape,
            binCount: freshPlan.binCount,
            gapBins: freshPlan.gapBins,
            txHash: result.hash,
            bands: result.bands,
          })
          setDlmmGroupRecords((previous) => upsertDlmmGroupRecord(previous, record))
          return result
        },
        `${sourcePool.token0.symbol}/${sourcePool.token1.symbol}`,
        {
          afterSuccess: () => {
            setAmount0('')
            setAmount1('')
            setTab('positions')
          },
        },
      )
      return
    }
    startMintPosition({
      targetPool: pool,
      tickLower: request.plan.tickLower,
      tickUpper: request.plan.tickUpper,
      coinPriceLower: request.plan.coinPriceLower,
      coinPriceUpper: request.plan.coinPriceUpper,
      input0: request.amount0,
      input1: request.amount1,
      actionLabel: `创建 ${sideLabel} · ${pool.version.toUpperCase()}`,
      dlmm: {
        plan: request.plan,
      },
      afterSuccess: () => {
        setAmount0('')
        setAmount1('')
        setTab('positions')
      },
    })
  }

  const collectDlmmGroup = (group: DlmmPositionGroup) => {
    if (group.positions.length < 2) return
    const value = group.positions.reduce((sum, position) => sum + position.totalUsd, 0)
    const fees = group.positions.reduce(
      (sum, position) => sum + position.fees0Usd + position.fees1Usd,
      0,
    )
    confirmThen({
      title: `批量领取 ${group.positions.length} 档手续费？`,
      lines: [
        `${group.pair} · ${group.version.toUpperCase()} · 组合价值 ${formatUsd(value)}`,
        `当前未领约 ${formatUsd(fees)}，所有档位会在同一笔交易中领取。`,
        '任一 NFT 执行失败时整笔回滚，不会出现只领取一半的状态。',
      ],
      confirmLabel: `领取 ${group.positions.length} 档`,
    }, () => {
      void run(`批量领取 ${group.positions.length} 档`, async () => {
        const sample = group.positions[0]!
        const unwrapEth = useNativeEth
          && pairHasWeth(sample.token0.address, sample.token1.address)
        const hash = group.version === 'v4'
          ? await claimV4PositionBatch({
            walletClient: wallet!,
            owner: address!,
            positions: group.positions,
            onStatus: setStatus,
          })
          : await claimV3PositionBatch({
            walletClient: wallet!,
            owner: address!,
            positions: group.positions,
            unwrapEth,
          })
        const wethUsd = await getWethUsdPrice().catch(() => 0)
        const claimed = new Map(group.positions.map((position) => {
          const next = recordPositionClaim(position, wethUsd, 'collect')
          return [`${next.version}-${next.tokenId}`, next] as const
        }))
        setPositions((previous) => previous.map((position) => (
          claimed.get(`${position.version}-${position.tokenId}`) ?? position
        )))
        return { hash }
      }, group.pair)
    })
  }

  const closeDlmmGroup = (group: DlmmPositionGroup) => {
    if (group.positions.length < 2) return
    const value = group.positions.reduce((sum, position) => sum + position.totalUsd, 0)
    const fees = group.positions.reduce(
      (sum, position) => sum + position.fees0Usd + position.fees1Usd,
      0,
    )
    confirmThen({
      title: `一键退出 ${group.positions.length} 档 DLMM？`,
      lines: [
        `${group.pair} · ${group.version.toUpperCase()} · 当前价值约 ${formatUsd(value)}`,
        `未领手续费约 ${formatUsd(fees)} 会一并取回。`,
        group.missingBandCount > 0
          ? `本地计划有 ${group.plannedBandCount} 档，本次只退出当前识别到的 ${group.positions.length} 档。`
          : `将销毁 ${group.positions.length} 个 NFT；任意一档失败会整笔回滚。`,
        `退出最小到账按当前估算和 ${(slippageBps / 100).toFixed(2)}% 滑点保护。`,
      ],
      confirmLabel: `全撤并销毁 ${group.positions.length} 档`,
      danger: true,
    }, () => {
      void run(`一键退出 ${group.positions.length} 档`, async () => {
        const sample = group.positions[0]!
        const unwrapEth = useNativeEth
          && pairHasWeth(sample.token0.address, sample.token1.address)
        const hash = group.version === 'v4'
          ? await closeV4PositionBatch({
            walletClient: wallet!,
            owner: address!,
            positions: group.positions,
            slippageBps,
            onStatus: setStatus,
          })
          : await closeV3PositionBatch({
            walletClient: wallet!,
            owner: address!,
            positions: group.positions,
            slippageBps,
            unwrapEth,
          })
        const selectedKey = selected ? `${selected.version}:${selected.tokenId}` : ''
        if (group.positions.some((position) => `${position.version}:${position.tokenId}` === selectedKey)) {
          setSelectedId(null)
        }
        return { hash }
      }, group.pair)
    })
  }

  const previewDlmmReopen = (group: DlmmPositionGroup) => {
    const sample = group.positions[0]
    if (!sample) return
    void (async () => {
      setBusy(true)
      setStatus('刷新池价并生成 DLMM 重挂预览…')
      try {
        const info: PoolInfo = import.meta.env.DEV && designMode()
          ? {
            version: sample.version,
            poolAddress: sample.poolAddress,
            poolId: sample.poolId,
            token0: sample.token0,
            token1: sample.token1,
            fee: sample.fee,
            tickSpacing: sample.tickSpacing,
            tick: sample.tick,
            sqrtPriceX96: sample.sqrtPriceX96,
            price: sample.price,
            liquidity: group.positions.reduce((sum, position) => sum + position.liquidity, 0n),
            hooks: sample.hooks,
          }
          : sample.version === 'v3'
            ? await loadV3Pool(sample.poolAddress!)
            : sample.hooks != null && sample.tickSpacing
              ? await loadV4Pool({
                currency0: sample.token0.address,
                currency1: sample.token1.address,
                fee: sample.fee,
                tickSpacing: sample.tickSpacing,
                hooks: sample.hooks,
              })
              : await loadV4PoolById(sample.poolId!)
        const prices = group.positions.map(getPositionCoinPrices)
        const lower = Math.min(...prices.map((price) => price.coinPriceLower))
        const upper = Math.max(...prices.map((price) => price.coinPriceUpper))
        const spot = prices[0]!.coinPrice
        const side: DlmmSide = group.record?.side
          ?? (lower < spot && upper > spot ? 'both' : upper <= spot ? 'bid' : 'ask')
        const lowerPct = spot > 0 ? ((lower / spot) - 1) * 100 : -30
        const upperPct = spot > 0 ? ((upper / spot) - 1) * 100 : 40
        const derivedBins = Math.max(
          1,
          Math.round((Math.max(...group.positions.map((position) => position.tickUpper))
            - Math.min(...group.positions.map((position) => position.tickLower))) / info.tickSpacing),
        )
        writePref('dlmmSide', side)
        writePref('dlmmRangePreset', 'custom')
        writePref('dlmmRangeLowerPct', lowerPct)
        writePref('dlmmRangeUpperPct', upperPct)
        writePref('dlmmExecutionMode', 'multi')
        writePref('dlmmShape', group.record?.shape ?? 'bid-ask')
        writePref('dlmmTrancheCount', Math.min(12, Math.max(2, group.plannedBandCount)))
        writePref('dlmmBinCount', group.record?.binCount ?? derivedBins)
        writePref('dlmmGapBins', group.record?.gapBins ?? 0)
        setPool(info)
        setPoolInput(sample.version === 'v3' ? sample.poolAddress ?? '' : sample.poolId ?? '')
        setMintProtocol(sample.version)
        setTokenA(info.token0.address)
        setTokenB(info.token1.address)
        setFee(info.fee)
        if (info.version === 'v4') setV4TickSpacing(info.tickSpacing)
        setTab('dlmm')
        setStatus(
          `已按最新价格生成 ${side === 'both' ? '双边' : side === 'bid' ? 'Bid' : 'Ask'} 重挂预览；原组合尚未撤出，不会自动重复投入。`,
        )
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    })()
  }

  const forgetDlmmGroup = (group: DlmmPositionGroup) => {
    if (!group.record) return
    confirmThen({
      title: '忽略这条 DLMM 组合记录？',
      lines: [
        `${group.pair} · ${group.plannedBandCount} 档`,
        '只删除本浏览器的组合标签，不会操作、转移或销毁链上 NFT。连续仓位仍可能被自动识别。',
      ],
      confirmLabel: '仅删除本地记录',
    }, () => {
      setDlmmGroupRecords((previous) => forgetDlmmGroupRecord(previous, group.id))
      pushToast({ kind: 'info', title: '已删除本地组合记录', detail: group.pair })
    })
  }

  const selectedUsesWeth = selected ? pairHasWeth(selected.token0.address, selected.token1.address) : false
  const addUseEth = useNativeEth && selectedUsesWeth
  const addNeedSide = selected
    ? neededMintSide(selected.tick, selected.tickLower, selected.tickUpper)
    : 'both'
  const addLabel0 = selected
    ? (addUseEth && isEthLikeCurrency(selected.token0.address) ? getNativeSymbol() : selected.token0.symbol)
    : ''
  const addLabel1 = selected
    ? (addUseEth && isEthLikeCurrency(selected.token1.address) ? getNativeSymbol() : selected.token1.symbol)
    : ''
  const addShow0 = selected
    ? (addUseEth && isEthLikeCurrency(selected.token0.address) ? ethBal : addBal0)
    : 0n
  const addShow1 = selected
    ? (addUseEth && isEthLikeCurrency(selected.token1.address) ? ethBal : addBal1)
    : 0n
  const addMax0 = selected
    ? (addUseEth && isEthLikeCurrency(selected.token0.address)
      ? (ethBal > gasReserve ? ethBal - gasReserve : 0n)
      : addBal0)
    : 0n
  const addMax1 = selected
    ? (addUseEth && isEthLikeCurrency(selected.token1.address)
      ? (ethBal > gasReserve ? ethBal - gasReserve : 0n)
      : addBal1)
    : 0n

  const mintSwapActive = tab === 'mint' && mintSwapOpen && !!pool
  const posSwapActive = tab === 'positions' && !!selected && posOpMode === 'swap'
  const swapTarget = useMemo(() => {
    if (mintSwapActive && pool) {
      return {
        position: poolAsSwapPosition(pool),
        useEth: mintUseEth,
        label0,
        label1,
        bal0: showBal0,
        bal1: showBal1,
      }
    }
    if (posSwapActive && selected) {
      return {
        position: selected,
        useEth: addUseEth,
        label0: addLabel0,
        label1: addLabel1,
        bal0: addShow0,
        bal1: addShow1,
      }
    }
    return null
  }, [
    mintSwapActive,
    posSwapActive,
    pool,
    selected,
    mintUseEth,
    addUseEth,
    label0,
    label1,
    addLabel0,
    addLabel1,
    showBal0,
    showBal1,
    addShow0,
    addShow1,
  ])

  const swapInMeta = (() => {
    if (!swapTarget) return null
    return swapZeroForOne
      ? {
        token: swapTarget.position.token0,
        label: swapTarget.label0,
        bal: swapTarget.bal0,
      }
      : {
        token: swapTarget.position.token1,
        label: swapTarget.label1,
        bal: swapTarget.bal1,
      }
  })()
  const swapOutMeta = (() => {
    if (!swapTarget) return null
    return swapZeroForOne
      ? { token: swapTarget.position.token1, label: swapTarget.label1 }
      : { token: swapTarget.position.token0, label: swapTarget.label0 }
  })()

  // 本池 Swap 报价（防抖）：仓位页 Swap 模式 / 新建仓展开面板共用
  useEffect(() => {
    if (!swapTarget) {
      setSwapQuote(null)
      setSwapQuoteErr(null)
      return
    }
    const raw = swapAmount.trim()
    if (!raw || Number(raw) <= 0) {
      setSwapQuote(null)
      setSwapQuoteErr(null)
      setSwapQuoteBusy(false)
      return
    }
    let cancelled = false
    setSwapQuoteBusy(true)
    setSwapQuoteErr(null)
    const decimals = swapZeroForOne
      ? swapTarget.position.token0.decimals
      : swapTarget.position.token1.decimals
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const amountIn = parseAmount(raw, decimals)
          if (amountIn <= 0n) {
            if (!cancelled) {
              setSwapQuote(null)
              setSwapQuoteBusy(false)
            }
            return
          }
          const q = await quotePoolSwap({
            position: swapTarget.position,
            zeroForOne: swapZeroForOne,
            amountIn,
            slippageBps,
          })
          if (!cancelled) {
            setSwapQuote(q)
            setSwapQuoteBusy(false)
          }
        } catch (e) {
          if (!cancelled) {
            setSwapQuote(null)
            setSwapQuoteBusy(false)
            setSwapQuoteErr(e instanceof Error ? e.message : String(e))
          }
        }
      })()
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [
    swapTarget,
    swapAmount,
    swapZeroForOne,
    slippageBps,
  ])

  const activeNav = NAV_ITEMS.find((it) => it.key === tab)

  return (
    <div className="shell">
      {/* ── 左侧导航轨：品牌 + 主导航常驻，不再挤在顶栏 ── */}
      <aside className="rail">
        <div className="rail-brand">
          <span className="brand-mark" aria-hidden>◧</span>
          <div className="brand-text">
            <p className="brand">RangeDesk</p>
            <p className="sub">V3 / V4 终端</p>
          </div>
        </div>

        <nav className="rail-nav" aria-label="主导航">
          {NAV_ITEMS.map((it) => {
            const count =
              it.key === 'positions' ? positions.length : it.key === 'history' ? txHistory.length : 0
            return (
              <button
                key={it.key}
                className={`rail-item ${tab === it.key ? 'active' : ''}`}
                aria-current={tab === it.key ? 'page' : undefined}
                /* 1180 以下轨道收成纯图标，没有 title 就认不出是哪一页 */
                title={`${it.label}（${it.hotkey}）· ${it.blurb}`}
                onClick={() => setTab(it.key)}
              >
                <span className="rail-icon" aria-hidden>{it.icon}</span>
                <span className="rail-label">{it.label}</span>
                {count > 0 && <span className="rail-count">{count}</span>}
                {it.key === 'auto' && signerMode === 'local' && autoCfg.enabled ? (
                  <span className={`tab-dot ${autoCfg.dryRun ? 'dry' : 'live'}`} />
                ) : null}
                <kbd className="rail-key">{it.hotkey}</kbd>
              </button>
            )
          })}
        </nav>

        <div className="rail-foot">
          <div
            className={`rail-net ${signerMode === 'local' ? 'local' : ''}`}
            title={`${chainCfg.label}（${chainCfg.id}）${signerMode === 'local' ? ' · 本地私钥' : ''}`}
          >
            <span className="rail-net-dot" aria-hidden />
            <span className="rail-net-name">{chainCfg.shortLabel}</span>
          </div>
        </div>
      </aside>

      <div className="workspace">
        {/* ── 顶部工作条：网络 / 钱包 / 刷新 / 主题 / 设置 ── */}
        <header className="workbar">
          <div className="workbar-title">
            <h1 className="workbar-h1">{activeNav?.label ?? 'RangeDesk'}</h1>
            <span className="workbar-sub muted">{activeNav?.blurb}</span>
          </div>

          <div className="workbar-right">
            <select
              className="chain-select"
              aria-label="网络"
              value={chainId}
              title="随时可切换；刷新中切换会取消旧刷新"
              onChange={(e) => onSwitchChain(Number(e.target.value) as SupportedChainId)}
            >
              {SUPPORTED_CHAINS.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>

            {address ? (
              <>
                <div className={`wallet-chip ${signerMode === 'local' ? 'local' : ''}`}>
                  <span
                    className="wallet-mode"
                    title={signerMode === 'local' ? '本地私钥签名' : '插件钱包签名'}
                  >
                    {signerMode === 'local' ? '本地' : '钱包'}
                  </span>
                  <a className="wallet-link mono" href={explorerAddress(address)} target="_blank" rel="noreferrer">
                    {shortAddr(address)}
                  </a>
                  <span
                    className="wallet-bals mono"
                    role="button"
                    tabIndex={0}
                    title="点击重新读取 ETH / WETH 余额"
                    onClick={() => address && void refreshBalances(address)}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && address) {
                        e.preventDefault()
                        void refreshBalances(address)
                      }
                    }}
                  >
                    {chainHasWrappedNative()
                      ? `${headerBalanceText(ethBal, ethBalStatus, getNativeSymbol())} · ${headerBalanceText(wethBal, wethBalStatus, getWrappedNativeSymbol())}`
                      : `${formatAmount(gasTokenDisplay.raw, gasTokenDisplay.decimals, 4)} ${chainCfg.chain.nativeCurrency.symbol}`}
                  </span>
                </div>
                <div className="btn-split">
                  <button
                    className={`btn ${refreshing ? 'active' : ''}`}
                    title={refreshing ? '刷新进行中，再次点击将重新开始' : '刷新仓位（快捷键 R）'}
                    onClick={() => void refreshPositions({ silent: false })}
                  >
                    {refreshing ? '刷新中…' : '刷新'}
                  </button>
                  <button
                    className="btn"
                    title={refreshing ? '深度扫描将覆盖当前刷新' : '深度扫描：扩大回溯 + ownerOf 校验，较慢'}
                    onClick={() => void refreshPositions({ silent: false, deep: true })}
                  >
                    深度
                  </button>
                </div>
                <button className="btn" title="断开当前签名方式" onClick={disconnect}>
                  断开
                </button>
              </>
            ) : (
              <>
                <button className="btn primary" disabled={busy} onClick={() => void connect()}>连接钱包</button>
                <button className="btn" title="用本地私钥签名，可跑自动化" onClick={() => setTab('auto')}>
                  本地私钥
                </button>
              </>
            )}

            <ThemeToggle mode={themeMode} onChange={setThemeMode} />
            <button
              className={`btn icon ${showSettings ? 'active' : ''}`}
              title="设置 / RPC"
              aria-expanded={showSettings}
              onClick={() => setShowSettings(!showSettings)}
            >
              ⚙
            </button>
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

        <main className="content">

      {showSettings && (
      <>
      <button className="drawer-scrim" aria-label="关闭设置" onClick={() => setShowSettings(false)} />
      <div className="settings-panel" role="dialog" aria-label="设置">
      <div className="drawer-head">
        <strong>设置</strong>
        <button className="btn icon" aria-label="关闭设置" onClick={() => setShowSettings(false)}>✕</button>
      </div>
      <div className="settings-row">
        <label className="inline-setting">
          滑点
          <select value={slippageBps} onChange={(e) => setSlippageBps(Number(e.target.value))} title="开仓/加仓/撤出/Swap 均生效；被夹超限会直接失败">
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
          自动刷新
        </label>
        <label className="inline-setting">
          间隔
          <select
            value={refreshSecs}
            disabled={!autoRefresh}
            onChange={(e) => setRefreshSecs(Number(e.target.value))}
          >
            {REFRESH_OPTIONS.map((s) => (
              <option key={s} value={s}>{s < 60 ? `${s} 秒` : `${s / 60} 分钟`}</option>
            ))}
          </select>
        </label>
        <label className="inline-setting">
          密度
          <select value={density} onChange={(e) => setDensity(e.target.value as Density)}>
            <option value="cozy">宽松</option>
            <option value="compact">紧凑</option>
          </select>
        </label>
        <span className="inline-setting-note muted">
          标签页切到后台时自动刷新会暂停，省 RPC 配额。
        </span>
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
          {chainCfg.key === 'arc'
            ? 'Arc 主网几乎没有可用公共 RPC。请连接已配置 Arc 的钱包（读取走钱包节点），或在此填 Alchemy / QuickNode 私有 RPC 后保存。'
            : '留空并保存即恢复当前链默认 RPC。测延迟会请求输入框地址；未填写则测默认节点。'}
          {rpcLatency != null && (
            <span className="rpc-latency ok-text">
              {' '}
              延迟 {rpcLatency} ms
              {rpcBlock != null ? ` · 区块 #${rpcBlock.toString()}` : ''}
            </span>
          )}
        </p>
      </div>

      <div className="rpc-panel">
        <div className="rpc-panel-head">
          <strong>The Graph API Key</strong>
          <span className="muted">{graphKeyLabel}</span>
        </div>
        <div className="rpc-panel-row">
          <input
            className="rpc-input mono"
            type="password"
            autoComplete="off"
            value={graphKeyInput}
            placeholder="可选 · Studio → API Keys"
            onChange={(e) => setGraphKeyInput(e.target.value)}
          />
          <button className="btn primary" type="button" onClick={saveGraphKey}>
            保存
          </button>
        </div>
        <p className="rpc-panel-note muted">
          可选。有效 Gateway Key 可加速 BSC 动向；不填或 Key 无效时自动改用链上扫描，功能不受影响。申请：
          {' '}
          <a href="https://thegraph.com/studio/apikeys/" target="_blank" rel="noreferrer">
            The Graph Studio → API Keys
          </a>
          （不是 Deploy Key）。留空保存即清除。
        </p>
      </div>

      <p className="shortcut-hint muted">
        快捷键：<kbd>1</kbd>–<kbd>6</kbd> 切换标签 · <kbd>R</kbd> 刷新 · <kbd>/</kbd> 搜索仓位 · <kbd>Esc</kbd> 收起详情
      </p>
      </div>
      </>
      )}

      {tab === 'positions' && (
        /*
         * 这里原来是 <section className="panel">，把整个仓位页（KPI 条 + 筛选条 + 卡片网格
         * + 详情卡）全包在一张白底大卡里。加了抬升分级之后这个结构立刻露馅：
         * 一张有阴影的白卡里面装着一条有阴影的 KPI、七张有阴影的仓位卡 ——
         * 盒子套盒子，每一层都在争「我是一个独立表面」，看下来反而糊成一片。
         *
         * 现在换成不带样式的 <section>：KPI 条、筛选条、卡片网格各自直接坐在页面背景上，
         * 每个都是一等公民，层级只有「背景 → 表面」这一跳，干净。
         * 详情卡（.pdc）自己带边框，不受影响。
         */
        <section className="page-positions">
          <div className="pos-page-head">
            <div>
              <h2 className="pos-page-title">我的仓位</h2>
              <p className="muted pos-page-sub">
                {positions.length > 0
                  ? `${positions.length} 个仓位 · ${summary.inRange} 个在区间内${summary.atRisk > 0 ? ` · ${summary.atRisk} 个临界` : ''}`
                  : '连接钱包并刷新以加载链上仓位'}
              </p>
            </div>
            <div className="pos-page-actions">
              <button
                type="button"
                className={`btn primary ${refreshing ? 'active' : ''}`}
                disabled={!address}
                title={refreshing ? '刷新进行中，再次点击将重新开始' : undefined}
                onClick={() => void refreshPositions()}
              >
                {refreshing ? '刷新中…' : '刷新仓位'}
              </button>
              <button type="button" className="btn" onClick={() => setTab('mint')}>新建仓</button>
            </div>
          </div>

          <div className="summary-strip">
            <div><span className="sum-label">总价值</span><strong>{formatUsd(summary.totalUsd)}</strong></div>
            <div>
              <span className="sum-label">累计手续费</span>
              <strong className="ok-text">{formatUsd(summary.feesUsd)}</strong>
              <span className="sum-sub muted">已领 {formatUsd(summary.claimedUsd)}</span>
            </div>
            <div>
              <span className="sum-label">
                手续费年化
                <InfoHint text="按仓位价值加权的平均年化：累计手续费 / 成本 / 持仓时长。建仓不足 6 小时的仓位不计入。" />
              </span>
              <strong className={summary.feeAprPct != null ? 'ok-text' : ''}>{formatApr(summary.feeAprPct)}</strong>
            </div>
            <div>
              <span className="sum-label">
                盈亏
                <InfoHint text="当前仓位资产（本金 + 可领取）+ 累计 Collect 收回 − 累计 Increase 投入。V3 的 Decrease 只把本金移入可领取余额，不会提前当作回款；复投的 Collect 与 Increase 会相互抵消。该口径不含 gas，也不追踪资产离开仓位后的钱包涨跌。" />
              </span>
              <strong className={summary.pnlUsd >= 0 ? 'ok-text' : 'bad-text'}>
                {summary.pnlReady > 0 ? formatPnl(summary.pnlUsd) : '—'}
              </strong>
              {summary.n > 0 && (
                <span className="sum-sub muted">
                  {summary.pnlReady}/{summary.n} 已完成
                  {summary.pnlEstimated > 0 ? ` · ${summary.pnlEstimated} 个估算` : ''}
                </span>
              )}
            </div>
            <div>
              <span className="sum-label">区间内</span>
              <strong>{summary.inRange}/{summary.n}</strong>
              {summary.atRisk > 0 && <span className="sum-sub warn-text">{summary.atRisk} 个接近边界</span>}
            </div>
          </div>

          <DlmmPositionsPanel
            groups={dlmmPositionGroups}
            busy={busy}
            onSelectPosition={(position) => setSelectedId(`${position.version}-${position.tokenId}`)}
            onCollect={collectDlmmGroup}
            onClose={closeDlmmGroup}
            onReopen={previewDlmmReopen}
            onForget={forgetDlmmGroup}
          />

          <div className="pos-toolbar">
            {/* 状态轴 | 版本轴：同一个单选，分隔线只表示「问的不是同一个问题」 */}
            <div className="seg" role="group" aria-label="筛选仓位">
              {([
                ['all', '全部'],
                ['in', '区间内'],
                ['out', '已出区间'],
                ['risk', '临界'],
                ['v3', 'V3'],
                ['v4', 'V4'],
              ] as [FilterKey, string][]).map(([k, label]) => (
                <Fragment key={k}>
                  {k === 'v3' && <span className="seg-div" aria-hidden />}
                  <button
                    type="button"
                    aria-pressed={filterKey === k}
                    className={`filter-chip ${filterKey === k ? 'active' : ''} ${k === 'risk' && counts.risk > 0 ? 'warn' : ''}`}
                    onClick={() => setFilterKey(k)}
                  >
                    {label}
                    <span className="chip-count">{counts[k]}</span>
                  </button>
                </Fragment>
              ))}
            </div>

            <div className="filters">
              <input
                ref={searchRef}
                className="search-input"
                type="search"
                value={query}
                placeholder="搜索 交易对 / tokenId  ( / )"
                onChange={(e) => setQuery(e.target.value)}
              />
              <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                <option value="value">按价值</option>
                <option value="fees">按手续费</option>
                <option value="apr">按年化</option>
                <option value="pnl">按 PnL</option>
                <option value="risk">按边界距离</option>
                <option value="pair">按交易对</option>
              </select>
              <button
                className="btn icon"
                type="button"
                title={sortAsc ? '当前升序，点击改降序' : '当前降序，点击改升序'}
                onClick={() => setSortAsc(!sortAsc)}
              >
                {sortAsc ? '↑' : '↓'}
              </button>
              <button
                className="btn"
                type="button"
                disabled={!filteredPositions.length}
                onClick={exportPositionsCsv}
              >
                导出 CSV
              </button>
            </div>
          </div>

          {/*
           * 列表和详情包一层。宽屏上这两块并排（详情钉在右侧跟着滚），窄屏上还是上下堆。
           * 之前是纯上下结构，宽屏下只有 1 个仓位时那张卡占 536px、右边空 1096px，
           * 紧接着下面的详情面板又是满宽的 1632px —— 一窄一宽叠在一起，
           * 空的那一大块正好夹在中间。并排之后那块空白直接没了。
           * 只在「选中了某个仓位」时才分栏：没选中时列表本来就该铺满整个版心。
           */}
          <div className={`pos-split ${selected ? 'has-detail' : ''}`}>
          {refreshing && positions.length === 0 ? (
            <PositionSkeleton count={3} />
          ) : filteredPositions.length === 0 ? (
            <div className="empty-state">
              {positions.length === 0 ? (
                <>
                  <p className="empty-title">还没有仓位</p>
                  <p className="muted">先连接钱包并刷新；确认有仓位后可在「新建仓」里 Mint 一个 V3/V4 仓。</p>
                  <button className="btn primary" onClick={() => setTab('mint')}>去新建仓</button>
                </>
              ) : (
                <>
                  <p className="empty-title">没有匹配的仓位</p>
                  <p className="muted">当前筛选/搜索条件下没有结果。</p>
                  <button
                    className="btn"
                    onClick={() => {
                      setFilterKey('all')
                      setQuery('')
                    }}
                  >
                    清除筛选
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className={`pos-grid ${density}`}>
              {filteredPositions.map((p) => {
                const id = `${p.version}-${p.tokenId}`
                const selectedRow = selectedId === id
                const cq = getPositionCoinPrices(p)
                const usdRange = getPositionUsdRange(p)
                const feeUsd = p.fees0Usd + p.fees1Usd
                const poolSum = poolFeeByKey.get(positionPoolKey(p))
                const poolFeesUsd = poolSum?.totalFeesUsd ?? p.totalFeesUsd
                const multiInPool = (poolSum?.positionCount ?? 1) > 1
                const rangeSpan = Math.max(cq.coinPriceUpper - cq.coinPriceLower, 1e-18)
                const rangeMarker = Math.max(
                  0,
                  Math.min(100, ((cq.coinPrice - cq.coinPriceLower) / rangeSpan) * 100),
                )
                const risk = riskLevel(p)
                const near = rangeProximityPct(p)
                return (
                  <article
                    role="button"
                    tabIndex={0}
                    aria-pressed={selectedRow}
                    key={id}
                    className={`pos-card ${selectedRow ? 'selected' : ''} ${risk === 'high' ? 'risk-high' : risk === 'warn' ? 'risk-warn' : ''}`}
                    onClick={() => setSelectedId(id)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      setSelectedId(id)
                    }}
                  >
                    <div className="pc-top">
                      <span className="pc-meta-line mono">
                        #{p.tokenId.toString()} · {p.version.toUpperCase()} · {(p.fee / 10000).toFixed(2)}%
                        {multiInPool ? ` · ${poolSum!.positionCount} 仓` : ''}
                      </span>
                      <span className={`pc-state ${p.inRange ? (risk === 'high' || risk === 'warn' ? risk : 'in') : 'out'}`}>
                        {p.inRange
                          ? risk === 'high' || risk === 'warn'
                            ? `临界 ${near != null ? near.toFixed(1) : '?'}%`
                            : '区间内'
                          : '已出区间'}
                      </span>
                    </div>

                    <div className="pc-pair">{cq.coin.symbol} / {cq.quote.symbol}</div>
                    {(() => {
                      const pref = positionPoolRef(p)
                      if (!pref) return null
                      return (
                        <button
                          type="button"
                          className="pc-pool mono"
                          title={`点击复制 ${pref}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            copyText(pref)
                            pushToast({ kind: 'success', title: '已复制池地址', detail: pref })
                          }}
                        >
                          <span className="pc-pool-k">{p.version === 'v4' ? 'poolId' : '池'}</span>
                          {pref.length > 22 ? `${pref.slice(0, 10)}…${pref.slice(-8)}` : pref}
                        </button>
                      )
                    })()}

                    <div className="pc-hero">
                      <div className="pc-value">{formatUsd(p.totalUsd)}</div>
                      <div
                        className={`pc-pnl ${!p.pnlReady ? '' : p.pnlUsd >= 0 ? 'up' : 'down'}`}
                        title={
                          p.pnlReady
                            ? `盈亏 = 当前资产 ${formatUsd(p.totalUsd)} + 累计收回 ${formatUsd(p.cashOutUsd ?? 0)} − 累计投入 ${formatUsd(p.costBasisUsd)}。${p.pnlNote ?? ''}`
                            : p.pnlNote ?? '正在根据链上现金流与历史价格计算盈亏…'
                        }
                      >
                        {p.pnlReady ? (
                          <>
                            盈亏 {formatPnl(p.pnlUsd)}
                            {p.costBasisUsd > 0 && (
                              <span className="pc-pnl-pct">
                                {' '}({p.pnlUsd >= 0 ? '+' : '−'}{Math.abs((p.pnlUsd / p.costBasisUsd) * 100).toFixed(1)}%)
                                {' · '}{p.pnlQuality === 'historical' ? '历史价' : '估算'}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="muted">盈亏 —</span>
                        )}
                      </div>
                      <div className="pc-fee-line">
                        {multiInPool ? (
                          <>本池累计 {formatUsd(poolFeesUsd)} · </>
                        ) : null}
                        <span>未领 {formatUsd(feeUsd)}</span>
                        <span>已领 {formatUsd(p.claimedFeesUsd)}</span>
                        {((p.owedPrincipal0Usd ?? 0) + (p.owedPrincipal1Usd ?? 0)) > 0 && (
                          <span>待收本金 {formatUsd((p.owedPrincipal0Usd ?? 0) + (p.owedPrincipal1Usd ?? 0))}</span>
                        )}
                        {p.feeAprPct != null && <span>年化 {formatApr(p.feeAprPct)}</span>}
                      </div>
                    </div>

                    <PositionLegs position={p} variant="card" />

                    <div className={`pc-range ${p.inRange ? 'in' : 'out'}`}>
                      <div className="pc-range-head">
                        <span>价格区间</span>
                        <span className="pc-range-spot mono">现价 {formatPrice(cq.coinPrice)}</span>
                      </div>
                      <div className="pc-track">
                        <span className="pc-track-in" />
                        <span
                          className="pc-spot"
                          style={{ left: `${p.inRange ? rangeMarker : cq.coinPrice < cq.coinPriceLower ? 0 : 100}%` }}
                        />
                      </div>
                      <div className="pc-scale mono">
                        <span title={`${cq.priceUnit} ${cq.coinPriceLower}`}>
                          {formatPrice(cq.coinPriceLower)}
                        </span>
                        <span title={`${cq.priceUnit} ${cq.coinPriceUpper}`}>
                          {formatPrice(cq.coinPriceUpper)}
                        </span>
                      </div>
                      {usdRange && (
                        <div
                          className="pc-scale pc-scale-usd mono"
                          title={`U 本位：1 ${cq.coin.symbol} = $×（由 ${cq.priceUnit} × USD/${cq.quote.symbol}）`}
                        >
                          <span>${formatPrice(usdRange.usdLower)}</span>
                          <span>${formatPrice(usdRange.usdUpper)}</span>
                        </div>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          )}

          {selected && (
            <PositionDetailCard
              position={selected}
              busy={busy}
              poolRef={positionPoolRef(selected)}
              poolHref={selected.poolAddress ? explorerAddress(selected.poolAddress) : null}
              onCopyId={() => {
                copyText(selected.tokenId.toString())
                pushToast({ kind: 'success', title: '已复制仓位编号', detail: selected.tokenId.toString() })
              }}
              onCopyPool={() => {
                const pref = positionPoolRef(selected)
                if (!pref) return
                copyText(pref)
                pushToast({ kind: 'success', title: '已复制池地址', detail: pref })
              }}
              onCollect={() => void run(
                selected.version === 'v4'
                  ? 'Claim V4'
                  : (addUseEth ? 'Claim→ETH' : 'Claim'),
                async () => {
                  const pos = selected
                  const hash = pos.version === 'v4'
                    ? await claimV4({ walletClient: wallet!, owner: address!, position: pos })
                    : await claimV3({
                      walletClient: wallet!,
                      owner: address!,
                      tokenId: pos.tokenId,
                      unwrapEth: addUseEth,
                      token0: pos.token0.address,
                      token1: pos.token1.address,
                      dex: pos.dex,
                      v3Npm: pos.v3Npm,
                    })
                  const wethUsd = await getWethUsdPrice().catch(() => 0)
                  const next = recordPositionClaim(pos, wethUsd, 'collect')
                  setPositions((prev) => prev.map((p) =>
                    p.version === next.version && p.tokenId === next.tokenId ? next : p,
                  ))
                  return { hash }
                },
                `${selected.token0.symbol}/${selected.token1.symbol}`,
              )}
              onCompound={() => {
                const feeUsd = selected.fees0Usd + selected.fees1Usd
                confirmThen({
                  title: '领取手续费并复投？',
                  lines: [
                    `#${selected.tokenId} ${selected.token0.symbol}/${selected.token1.symbol}`,
                    `未领约 ${formatUsd(feeUsd)}，只会用这笔手续费加回本仓。`,
                    '配不平的一边留在钱包；大波动导致加仓失败时，手续费仍在钱包，可再手动加仓。',
                    selected.version === 'v4' ? 'V4 为两笔交易（先领再加）。' : 'V3 尽量一笔完成；失败会自动退回先领后加。',
                  ],
                  confirmLabel: '领取并复投',
                }, () => {
                  void run(
                    '领取并复投',
                    async () => {
                      const pos = selected
                      const result = await claimAndCompound({
                        walletClient: wallet!,
                        owner: address!,
                        position: pos,
                        slippageBps,
                        onStatus: setStatus,
                      })
                      // 只要领取成功（不论复投是否成功），未领都应记入已领
                      if (result.claimHash) {
                        const wethUsd = await getWethUsdPrice().catch(() => 0)
                        const next = recordPositionClaim(pos, wethUsd, 'compound')
                        setPositions((prev) => prev.map((p) =>
                          p.version === next.version && p.tokenId === next.tokenId ? next : p,
                        ))
                      }
                      return result
                    },
                    `${selected.token0.symbol}/${selected.token1.symbol}`,
                  )
                })
              }}
              onClose={() => {
                confirmThen({
                  title: '确认关闭仓位（全撤 100%）？',
                  lines: [
                    `${selected.token0.symbol}/${selected.token1.symbol} #${selected.tokenId}`,
                    `当前价值 ${formatUsd(selected.totalUsd)}，未领手续费 ${formatUsd(selected.fees0Usd + selected.fees1Usd)} 会一并领出。`,
                    'NFT 将被销毁，此操作不可撤销。',
                  ],
                  confirmLabel: '全撤并关闭',
                  danger: true,
                }, () => {
                  void run(selected.version === 'v4' ? '关闭 V4' : '关闭仓位', async () => {
                    const hash = selected.version === 'v4'
                      ? await removeV4Liquidity({
                        walletClient: wallet!,
                        owner: address!,
                        position: selected,
                        percent: 100,
                        burnEmpty: true,
                      })
                      : await removeV3Liquidity({
                        walletClient: wallet!,
                        owner: address!,
                        position: selected,
                        percent: 100,
                        burnEmpty: true,
                        slippageBps,
                        unwrapEth: addUseEth,
                      })
                    setSelectedId(null)
                    return { hash }
                  }, `${selected.token0.symbol}/${selected.token1.symbol}`)
                })
              }}
              onRebalance={() => {
                if (selected.version === 'v3') {
                  const half = estimateRebalanceHalfPercent(selected)
                  confirmThen({
                    title: 'Rebalance V3',
                    lines: [
                      `#${selected.tokenId} ${selected.token0.symbol}/${selected.token1.symbol}`,
                      `全撤后按现价重开约 ±${half.toFixed(1)}% 区间。`,
                      '单边仓通常无需 swap；滑点按上方设置。',
                    ],
                    confirmLabel: '执行 Rebalance',
                    danger: true,
                  }, () => {
                    void run('Rebalance V3', () => rebalanceV3({
                      walletClient: wallet!,
                      owner: address!,
                      position: selected,
                      percent: half,
                      slippageBps,
                    }), `${selected.token0.symbol}/${selected.token1.symbol}`)
                  })
                  return
                }
                const cq = getPositionCoinPrices(selected)
                const width = Math.max(cq.coinPriceUpper - cq.coinPriceLower, 0)
                const spot = cq.coinPrice
                const halfW = width > 0 ? width / 2 : spot * 0.1
                const nextLo = Math.max(spot - halfW, spot * 1e-6)
                const nextHi = spot + halfW
                confirmThen({
                  title: 'V4 暂无一键 Rebalance',
                  lines: [
                    `#${selected.tokenId} ${selected.token0.symbol}/${selected.token1.symbol}`,
                    '将先全撤（销毁 NFT），再跳到「新建仓」预填同池与等宽币价区间。',
                    `预填区间 ${formatPrice(nextLo)} – ${formatPrice(nextHi)}，新仓需你手动确认 Mint。`,
                  ],
                  confirmLabel: '全撤并预填',
                  danger: true,
                }, () => {
                  void run('关闭并去新建仓', async () => {
                    const hash = await removeV4Liquidity({
                      walletClient: wallet!,
                      owner: address!,
                      position: selected,
                      percent: 100,
                      burnEmpty: true,
                    })
                    setSelectedId(null)
                    setMintProtocol('v4')
                    setTokenA(cq.coin.address)
                    setTokenB(cq.quote.address)
                    setFee(selected.fee)
                    if (selected.tickSpacing) setV4TickSpacing(selected.tickSpacing)
                    setRangeMode('custom')
                    setPriceLo(formatPrice(nextLo))
                    setPriceHi(formatPrice(nextHi))
                    try {
                      if (selected.hooks != null && selected.tickSpacing) {
                        const info = await loadV4Pool({
                          currency0: selected.token0.address,
                          currency1: selected.token1.address,
                          fee: selected.fee,
                          tickSpacing: selected.tickSpacing,
                          hooks: selected.hooks,
                        })
                        setPool(info)
                      } else if (selected.poolId) {
                        setPool(await loadV4PoolById(selected.poolId))
                      }
                    } catch (e) {
                      console.warn('prefill V4 pool failed', e)
                    }
                    setTab('mint')
                    return { hash }
                  }, `${selected.token0.symbol}/${selected.token1.symbol}`)
                })
              }}
            >
              <div className="pdc-manage-head">
                <div className="seg" role="group" aria-label="仓位操作">
                  <button
                    type="button"
                    className={`filter-chip ${posOpMode === 'add' ? 'active' : ''}`}
                    aria-pressed={posOpMode === 'add'}
                    onClick={() => setPosOpMode('add')}
                  >
                    加仓
                  </button>
                  <button
                    type="button"
                    className={`filter-chip ${posOpMode === 'remove' ? 'active' : ''}`}
                    aria-pressed={posOpMode === 'remove'}
                    onClick={() => setPosOpMode('remove')}
                  >
                    部分撤出
                  </button>
                  <button
                    type="button"
                    className={`filter-chip ${posOpMode === 'swap' ? 'active' : ''}`}
                    aria-pressed={posOpMode === 'swap'}
                    onClick={() => setPosOpMode('swap')}
                  >
                    本池 Swap
                  </button>
                </div>
                {selectedUsesWeth && (
                  <label className="op-native inline-setting check">
                    <input type="checkbox" checked={useNativeEth} onChange={(e) => setUseNativeEth(e.target.checked)} />
                    <span className="op-native-text">
                      用原生 {getNativeSymbol()}
                      <span className="op-native-sub">加仓付 / Claim·撤出收 / Swap</span>
                    </span>
                  </label>
                )}
              </div>

              {posOpMode === 'add' ? (
              <div className="op-block">
                <div className="grid2">
                  <label className="amt">
                    <span className="amt-head">{addLabel0}</span>
                    <span className="bal-hint">
                      余额 {formatAmount(addShow0, selected.token0.decimals, 6)}
                      <button
                        type="button"
                        className="amt-max"
                        disabled={!address || addMax0 === 0n || addNeedSide === 1}
                        onClick={() => onAddSide(0, formatAmountExact(addMax0, selected.token0.decimals))}
                      >
                        Max
                      </button>
                    </span>
                    <input
                      value={add0}
                      onChange={(e) => onAddSide(0, e.target.value)}
                      inputMode="decimal"
                      placeholder={addNeedSide === 1 ? '此区间不需要' : '填数量'}
                      disabled={addNeedSide === 1}
                    />
                  </label>
                  <label className="amt">
                    <span className="amt-head">{addLabel1}</span>
                    <span className="bal-hint">
                      余额 {formatAmount(addShow1, selected.token1.decimals, 6)}
                      <button
                        type="button"
                        className="amt-max"
                        disabled={!address || addMax1 === 0n || addNeedSide === 0}
                        onClick={() => onAddSide(1, formatAmountExact(addMax1, selected.token1.decimals))}
                      >
                        Max
                      </button>
                    </span>
                    <input
                      value={add1}
                      onChange={(e) => onAddSide(1, e.target.value)}
                      inputMode="decimal"
                      placeholder={addNeedSide === 0 ? '此区间不需要' : '填数量'}
                      disabled={addNeedSide === 0}
                    />
                  </label>
                </div>
                <p className="muted op-hint">
                  {addNeedSide === 'both'
                    ? '填一边即可，另一边按当前区间配平。'
                    : `当前仓位在区间外，加仓只需 ${addNeedSide === 0 ? addLabel0 : addLabel1}。`}
                </p>
                {selected.version === 'v4' && (
                  <label className="inline-setting" style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    转账税
                    <input
                      type="number"
                      min={0}
                      max={5000}
                      step={1}
                      value={transferTaxBps}
                      onChange={(e) => setTransferTaxBps(Math.max(0, Math.min(5000, Math.floor(Number(e.target.value) || 0))))}
                      style={{ width: 88 }}
                      title="单位 bps：25=0.25%，100=1%"
                    />
                    <span className="muted small">bps（{(transferTaxBps / 100).toFixed(2)}%）· 税币 V4 加仓必填</span>
                  </label>
                )}
                <div className="mint-fill">
                  <span className="muted small">按余额填</span>
                  <div className="seg" role="group" aria-label="按余额比例加仓">
                    {[25, 50, 75, 100].map((n) => (
                      <button
                        key={`add-fill-${n}`}
                        type="button"
                        className="filter-chip mono"
                        disabled={!address}
                        onClick={() => fillAddBalances(n)}
                      >
                        {n === 100 ? '全部' : `${n}%`}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="btn-row">
                  <button
                    className="btn primary"
                    disabled={busy || (!add0 && !add1)}
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
                          transferTaxBps0:
                            isEthLikeCurrency(selected.token0.address)
                            || isNativeCurrency(selected.token0.address)
                            || isHoneypotWhitelisted(chainId, selected.token0.address)
                              ? 0
                              : transferTaxBps,
                          transferTaxBps1:
                            isEthLikeCurrency(selected.token1.address)
                            || isNativeCurrency(selected.token1.address)
                            || isHoneypotWhitelisted(chainId, selected.token1.address)
                              ? 0
                              : transferTaxBps,
                          onStatus: setStatus,
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
                      { afterSuccess: () => { setAdd0(''); setAdd1('') } },
                    )}
                  >
                    确认加仓{selected.version === 'v4' ? ' · V4' : ''}
                  </button>
                </div>
              </div>
              ) : posOpMode === 'swap' ? (
              <div className="op-block">
                {selected.version === 'v3' && selected.dex && selected.dex !== 'uniswap' && selected.dex !== 'unknown' ? (
                  <p className="muted op-hint warn-text">
                    {selected.dexLabel ?? selected.dex} 池暂不支持本工具内 Swap，请用站外兑换。
                  </p>
                ) : null}
                <div className="swap-dir-row">
                  <button
                    type="button"
                    className={`filter-chip ${swapZeroForOne ? 'active' : ''}`}
                    aria-pressed={swapZeroForOne}
                    onClick={() => setSwapZeroForOne(true)}
                  >
                    {addLabel0} → {addLabel1}
                  </button>
                  <button
                    type="button"
                    className={`filter-chip ${!swapZeroForOne ? 'active' : ''}`}
                    aria-pressed={!swapZeroForOne}
                    onClick={() => setSwapZeroForOne(false)}
                  >
                    {addLabel1} → {addLabel0}
                  </button>
                  <button
                    type="button"
                    className="btn icon mint-swap"
                    title="切换方向"
                    onClick={() => setSwapZeroForOne((v) => !v)}
                  >
                    ⇄
                  </button>
                </div>
                <label className="amt">
                  <span className="amt-head">支付 {swapInMeta?.label}</span>
                  <span className="bal-hint">
                    余额 {swapInMeta ? formatAmount(swapInMeta.bal, swapInMeta.token.decimals, 6) : '—'}
                    <button
                      type="button"
                      className="amt-max"
                      disabled={!address || !swapInMeta || swapInMeta.bal === 0n}
                      onClick={() => {
                        if (!swapInMeta) return
                        // 原生侧留一点 gas
                        let max = swapInMeta.bal
                        if (swapTarget?.useEth && isEthLikeCurrency(swapInMeta.token.address)) {
                          const gasReserve = 10n ** 15n
                          max = ethBal > gasReserve ? ethBal - gasReserve : 0n
                        }
                        setSwapAmount(formatAmountExact(max, swapInMeta.token.decimals))
                      }}
                    >
                      Max
                    </button>
                  </span>
                  <input
                    value={swapAmount}
                    onChange={(e) => setSwapAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder="兑换数量"
                  />
                </label>
                <div className="swap-quote-box">
                  <div className="swap-quote-line">
                    <span className="muted">预计得到</span>
                    <strong>
                      {swapQuoteBusy
                        ? '报价中…'
                        : swapQuote
                          ? `${formatAmount(swapQuote.amountOut, swapQuote.tokenOutDecimals, 6)} ${swapOutMeta?.label ?? ''}`
                          : '—'}
                    </strong>
                  </div>
                  {swapQuote && (
                    <div className="swap-quote-line muted">
                      <span>最少（滑点 {(slippageBps / 100).toFixed(2)}%）</span>
                      <span>
                        {formatAmount(swapQuote.amountOutMin, swapQuote.tokenOutDecimals, 6)}{' '}
                        {swapOutMeta?.label}
                        {!swapQuote.quoted ? ' · 现价估算' : ''}
                      </span>
                    </div>
                  )}
                  {swapQuoteErr && <p className="err-inline">{swapQuoteErr}</p>}
                </div>
                <p className="muted op-hint">
                  在当前{selected.version.toUpperCase()}池内单跳兑换，适合新池冷启动或换边配平。滑点用顶部设置。
                </p>
                <div className="btn-row">
                  <button
                    className="btn primary"
                    disabled={
                      busy
                      || !address
                      || !swapQuote
                      || swapQuoteBusy
                      || (selected.version === 'v3' && Boolean(selected.dex && selected.dex !== 'uniswap' && selected.dex !== 'unknown'))
                    }
                    onClick={() => {
                      if (!selected || !swapInMeta || !swapQuote) return
                      void run(
                        selected.version === 'v4' ? '本池 Swap V4' : '本池 Swap',
                        () => swapInPool({
                          walletClient: wallet!,
                          owner: address!,
                          position: swapTarget?.position ?? selected,
                          zeroForOne: swapZeroForOne,
                          amountIn: swapQuote.amountIn,
                          slippageBps,
                          useNativeEth: swapTarget?.useEth ?? addUseEth,
                          onStatus: setStatus,
                        }),
                        `${swapInMeta.label}→${swapOutMeta?.label ?? ''}`,
                        { afterSuccess: () => { setSwapAmount(''); setSwapQuote(null) } },
                      )
                    }}
                  >
                    确认 Swap{selected.version === 'v4' ? ' · V4' : ''}
                  </button>
                </div>
              </div>
              ) : (
              <div className="op-block op-danger">
                <label className="full">
                  移除比例 {removePct}%
                  <input type="range" min={1} max={100} value={removePct} onChange={(e) => setRemovePct(Number(e.target.value))} />
                </label>
                <div className="chip-row">
                  {[25, 50, 75, 100].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`chip ${removePct === n ? 'on' : ''}`}
                      onClick={() => setRemovePct(n)}
                    >
                      {n === 100 ? '全部关闭' : `${n}%`}
                    </button>
                  ))}
                </div>
                <p className="muted">
                  约 {formatAmount((selected.amount0 * BigInt(removePct)) / 100n, selected.token0.decimals, 4)} {addLabel0 || selected.token0.symbol}
                  {' + '}
                  {formatAmount((selected.amount1 * BigInt(removePct)) / 100n, selected.token1.decimals, 4)} {addLabel1 || selected.token1.symbol}
                  {(selected.fees0 > 0n || selected.fees1 > 0n) ? ' · 未领手续费会一并领出' : ''}
                  {removePct === 100 ? ' · 全撤后销毁空 NFT' : ''}
                </p>
                <button
                  className="btn danger"
                  disabled={busy}
                  onClick={() => {
                    confirmThen({
                      title: removePct >= 100 ? '确认关闭仓位？' : `确认移除 ${removePct}% 流动性？`,
                      lines: [
                        `${selected.token0.symbol}/${selected.token1.symbol} #${selected.tokenId}`,
                        `约 ${formatAmount((selected.amount0 * BigInt(removePct)) / 100n, selected.token0.decimals, 4)} ${selected.token0.symbol} + ${formatAmount((selected.amount1 * BigInt(removePct)) / 100n, selected.token1.decimals, 4)} ${selected.token1.symbol}`,
                        selected.fees0 + selected.fees1 > 0n
                          ? `未领手续费约 ${formatUsd(selected.fees0Usd + selected.fees1Usd)} 会一并领出`
                          : '当前无未领手续费',
                        removePct >= 100 ? '全撤后会 burn 空 NFT，不可撤销。' : '滑点按上方设置。',
                      ],
                      confirmLabel: removePct >= 100 ? '全撤并关闭' : `撤出 ${removePct}%`,
                      danger: true,
                    }, () => {
                      void run(
                        selected.version === 'v4'
                          ? (removePct >= 100 ? '关闭 V4' : '移除 V4')
                          : (removePct >= 100 ? '关闭仓位' : '移除 LP'),
                        async () => {
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
                    })
                  }}
                >
                  {removePct >= 100
                    ? `关闭仓位${selected.version === 'v4' ? ' · V4' : ''}`
                    : `撤出 ${removePct}%${selected.version === 'v4' ? ' · V4' : ''}`}
                </button>
              </div>
              )}
            </PositionDetailCard>
          )}
          </div>
        </section>
      )}

      {tab === 'mint' && (
        /*
         * 和仓位页同样的处理：外面这层 .panel 去掉。原来是一张白底大卡里套着
         * 四个 card-2 底的步骤盒 —— 盒里盒。现在每个 .mint-step 自己就是白色主表面，
         * 直接坐在页面背景上，三步之间靠间距和编号分段，不需要再有一个总容器把它们圈起来。
         */
        <section className="page-mint">
          {/*
           * 建仓是「选池 → 定区间 → 配数量」三步，之前全平铺在一块面板里，
           * 没有任何阶段感，四段说明文字混在控件之间。现在第一步单独成段并编号，
           * 说明文字收进 InfoHint / <details>，控件自己说话。
           */}
          {/*
           * 第一步也要有自己的盒子。它原先直接坐在 .panel 上，而第二三步各有一层
           * 子面板，于是三个编号分别落在 x=275 / 294 / 290 —— 编号是在宣告
           * 「这是同级的三步」，三条不同的左边界会把这个宣告拆掉。
           * 扫出来的池子列表、创建池表单等「第一步的结果」留在盒子外面。
           */}
          <div className="mint-step">
          <div className="step-head">
            <h3>
              <span className="step-n">1</span>选池
            </h3>
            <div className="seg" role="group" aria-label="协议版本">
              {(['v3', 'v4'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={mintProtocol === v}
                  className={`filter-chip ${mintProtocol === v ? 'active' : ''}`}
                  onClick={() => { setMintProtocol(v); setPool(null); setScannedPools([]); setShowCreatePool(false) }}
                >
                  {v.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="mint-token-row">
            <TokenPicker
              label="币"
              hint="做 LP 的目标代币"
              value={tokenA}
              options={tokenOptions}
              onChange={(addr, meta) => pickToken('a', addr, meta)}
            />
            <button
              type="button"
              className="btn icon mint-swap"
              title="交换币 / 报价"
              onClick={swapTokens}
            >
              ⇄
            </button>
            <TokenPicker
              label="报价"
              hint="计价侧，常用 ETH 或稳定币"
              value={tokenB}
              options={tokenOptions}
              onChange={(addr, meta) => pickToken('b', addr, meta)}
            />
          </div>

          {/*
           * 费率档从 <select> 改成铺开的分段控件：V3 只有 4 档、V4 八档，
           * 藏在下拉里等于让人先点一下才知道有哪些档；铺开还顺手补掉了
           * grid2 里那个只有 3 个子项时留下的空格子。
           */}
          <div className="field-block">
            <span className="lbl">
              费率档
              <InfoHint text="池子的手续费档位。同一个交易对在不同费率档是不同的池子，深度也不同 —— 拿不准就用「扫描全部费率」看哪档有量。" />
            </span>
            <div className="seg" role="group" aria-label="费率档">
              {(mintProtocol === 'v4' ? V4_FEE_PRESETS : FEE_TIERS).map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={fee === f}
                  className={`filter-chip mono ${fee === f ? 'active' : ''}`}
                  onClick={() => {
                    setFee(f)
                    if (mintProtocol === 'v4') setV4TickSpacing(suggestV4TickSpacing(f))
                  }}
                >
                  {(f / 10000).toFixed(2)}%
                </button>
              ))}
            </div>
          </div>

          {/* 当前解析出的对，让人点扫描前先确认一眼 */}
          <p className="pair-echo">
            将查找
            <strong>
              {tokenLabel(tokenA)}
              {' / '}
              {tokenLabel(tokenB)}
            </strong>
          </p>

          <div className="btn-row">
            <button className="btn primary" disabled={busy} onClick={() => void scanPools()}>扫描全部费率</button>
            <button className="btn" disabled={busy} onClick={() => void loadPoolByPair()}>
              只加载 {(fee / 10000).toFixed(2)}%
            </button>
            {/*
             * 创建池是部署新合约、要自己定初始价的重操作，和上面两个「查一下」
             * 不是一个量级 —— 用分隔线推开并降为文字按钮，避免手滑点成主路径。
             */}
            <span className="btn-row-sep" aria-hidden />
            <button
              className="btn ghost"
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
              找不到？创建新池
            </button>
          </div>

          {showCreatePool && !pool && (
            <div className="mint-create">
              <div className="mint-create-title">
                创建 {mintProtocol.toUpperCase()} 池
                {seedOnCreate ? ' + 注入初仓（同笔交易）' : '（仅初始化）'}
              </div>
              <p className="muted mint-create-lead">
                自选交易对并设定初始价（<strong>USD / {tokenLabel(createSides.coin)}</strong>），系统会自动换算成链上需要的
                {' '}{tokenLabel(createSides.quote)} per {tokenLabel(createSides.coin)}。
                {mintProtocol === 'v3' && (
                  <> 新建会走 <strong>Uniswap</strong> Factory；已有 Pancake 深池请用上方「加载」后 Mint。</>
                )}
              </p>

              <div className="mint-token-row compact">
                <TokenPicker
                  label="币"
                  value={tokenA}
                  options={tokenOptions}
                  onChange={(addr, meta) => pickToken('a', addr, meta)}
                />
                <button type="button" className="btn icon mint-swap" title="交换" onClick={swapTokens}>⇄</button>
                <TokenPicker
                  label="报价"
                  value={tokenB}
                  options={tokenOptions}
                  onChange={(addr, meta) => pickToken('b', addr, meta)}
                />
              </div>

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
                </div>
              )}
              {createHasEthLike && (
                <label className="inline-setting check" style={{ margin: '0 0 8px' }}>
                  <input
                    type="checkbox"
                    checked={useNativeEth}
                    onChange={(e) => {
                      createPaymentTouchedRef.current = createPaymentKey
                      setUseNativeEth(e.target.checked)
                    }}
                  />
                  {getNativeSymbol()} 用原生币（钱包 ETH），不要用 {getWrappedNativeSymbol()}
                </label>
              )}

              <div className="grid2 mint-price-row">
                <label className="full">
                  <span className="lbl">
                    初始价（USD / {tokenLabel(createSides.coin)}）
                    <button
                      type="button"
                      className="amt-max"
                      disabled={busy}
                      title="取该币 USD 现价（U 本位）"
                      onClick={() => void borrowInitPrice()}
                    >
                      取现价
                    </button>
                  </span>
                  <input
                    value={initPrice}
                    onChange={(e) => setInitPrice(e.target.value)}
                    placeholder="例如 125.5"
                    inputMode="decimal"
                  />
                  {initPriceQuote != null && (
                    <span className="field-note muted">
                      链上换算 ≈ {formatPrice(initPriceQuote)} {tokenLabel(createSides.quote)} / {tokenLabel(createSides.coin)}
                    </span>
                  )}
                  {quoteUsdBusy && (
                    <span className="field-note muted">正在获取 {tokenLabel(createSides.quote)} 汇率…</span>
                  )}
                  {!quoteUsdBusy && showCreatePool && !(quoteUsd > 0) && (
                    <span className="field-note warn-text">无法获取 {tokenLabel(createSides.quote)} USD 价，建议换稳定币作报价</span>
                  )}
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
              {mintProtocol === 'v4' && seedOnCreate && (
                <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
                  上方费率档是池手续费。注入时山寨币转账扣费会自动垫付；仍失败可先取消本勾选，只建空池再 Mint。
                </p>
              )}

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
                        单边 {getNativeSymbol()}
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
                      <button
                        type="button"
                        className={`chip ${createRangePreset === 'custom' ? 'on' : ''}`}
                        onClick={() => {
                          setCreateRangePreset('custom')
                          const spot = Number(initPrice.replace(/,/g, ''))
                          if (spot > 0) {
                            if (!createUsdLo.trim()) setCreateUsdLo(formatPrice(spot * 0.9))
                            if (!createUsdHi.trim()) setCreateUsdHi(formatPrice(spot * 1.1))
                          }
                        }}
                      >
                        自定义 U
                      </button>
                    </div>
                  </div>
                  {createRangePreset === 'custom' && (
                    <div className="mint-pct-grid" style={{ marginBottom: 8 }}>
                      <label className="mint-pct-field">
                        <span className="mint-pct-label">下限 · USD / 币</span>
                        <div className="mint-pct-input">
                          <input
                            value={createUsdLo}
                            onChange={(e) => setCreateUsdLo(e.target.value)}
                            inputMode="decimal"
                            placeholder="例如 0.001"
                          />
                        </div>
                      </label>
                      <label className="mint-pct-field">
                        <span className="mint-pct-label">上限 · USD / 币</span>
                        <div className="mint-pct-input">
                          <input
                            value={createUsdHi}
                            onChange={(e) => setCreateUsdHi(e.target.value)}
                            inputMode="decimal"
                            placeholder="例如 0.01"
                          />
                        </div>
                      </label>
                    </div>
                  )}
                  <p className="muted" style={{ margin: '0 0 8px', fontSize: 12 }}>
                    {createRangePreset === 'onesided-eth'
                      ? `单边 ${getNativeSymbol()}：区间放到币价下方，创建时通常只需付报价侧（${tokenLabel(createSides.quote)}）。`
                      : createRangePreset === 'full'
                        ? '全区间：覆盖全部价格，需同时准备两侧代币（按初始价比例）。'
                        : createRangePreset === 'custom'
                          ? '自定义 U 本位：按「1 枚币值多少美元」填上下限（与上方初始价同一口径），会对齐到 tick。'
                          : `双边 ±${createRangePreset}%：区间围绕初始价，通常需两侧代币。`}
                    {createSynth?.range && createRangePreset === 'custom' ? (
                      <>
                        {' '}链上对齐后约 $
                        {formatPrice(createSynth.range.coinPriceLower * quoteUsd)} – $
                        {formatPrice(createSynth.range.coinPriceUpper * quoteUsd)} / 币。
                      </>
                    ) : null}
                    {createSynth && initPrice.trim() ? (
                      <> 填<strong>一边数量</strong>，另一边按初始价+区间自动配平。</>
                    ) : createRangePreset === 'custom' ? (
                      <> 填好初始价与 U 区间后，这里填一边就会自动配平。</>
                    ) : (
                      <> 上方初始价填好后，这里填一边就会自动配平（可点「取现价」从已有池子带过来）。</>
                    )}
                    {mintProtocol === 'v3' && (
                      <> V3 链上用 {getWrappedNativeSymbol()}，勾选原生币后会自动 Wrap。</>
                    )}
                    {createHasEthLike && (
                      <> 当前按{useNativeEth ? `原生 ${getNativeSymbol()}` : getWrappedNativeSymbol()}计余额。</>
                    )}
                  </p>
                  <div className="grid2">
                    <label>
                      {createSideLabel(tokenA)} 数量
                      {createRangePreset === 'onesided-eth' && isEthLikeCurrency(tokenA)
                        ? '（单边）'
                        : createRangePreset === 'onesided-eth' && isEthLikeCurrency(tokenB)
                          ? '（不需要）'
                          : ''}
                      <span className="bal-hint">
                        余额 {mintBalanceText(
                          createSeedBalA,
                          isEthLikeCurrency(tokenA) ? 18 : (createSynth?.decA ?? tokenDecimals(tokenA)),
                          createSideBalanceStatus(tokenA),
                        )}
                      </span>
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
                      {createSideLabel(tokenB)} 数量
                      {createRangePreset === 'onesided-eth' && isEthLikeCurrency(tokenB)
                        ? '（单边）'
                        : createRangePreset === 'onesided-eth' && isEthLikeCurrency(tokenA)
                          ? '（不需要）'
                          : ''}
                      <span className="bal-hint">
                        余额 {mintBalanceText(
                          createSeedBalB,
                          isEthLikeCurrency(tokenB) ? 18 : (createSynth?.decB ?? tokenDecimals(tokenB)),
                          createSideBalanceStatus(tokenB),
                        )}
                      </span>
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
                  {p.dexLabel ? `${p.dexLabel} · ` : ''}{(p.fee / 10000).toFixed(2)}% · {formatPrice(getCoinQuote(p).spot)}
                </button>
              ))}
            </div>
          )}

          {/* 第二条路径：已经有地址就不用挑下拉。用一道「或」把两条路分开。 */}
          <div className="or-split"><span>或者直接贴地址</span></div>

          <label className="full">
            <span className="lbl">
              代币合约 / 池地址 / poolId / 池子链接
              <InfoHint text="贴代币合约（比如某个 memecoin 地址）会扫出它和 WETH / 稳定币 / 原生 ETH 的所有 V3+V4 池，按深度排序供你挑。贴池地址或 Uniswap 链接则直接加载那一个池。" />
            </span>
            <div className="inline">
              <input
                value={poolInput}
                onChange={(e) => setPoolInput(e.target.value)}
                placeholder="0x… 代币合约会列出全部池子；池地址 / 链接直接加载"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void loadPoolByAddress()
                }}
              />
              <button className="btn" disabled={busy || discovering} onClick={() => void loadPoolByAddress()}>
                {discovering ? '扫描中…' : '加载'}
              </button>
            </div>
          </label>

          </div>

          {discoverNote && <p className="discover-note">{discoverNote}</p>}

          {discovering && (
            <div className="discover-loading">
              <span className="toast-spin" />
              正在扫描池子，需要几秒…
            </div>
          )}

          {discovered && discovered.length > 0 && (
            <div className="discover-table">
              <div className="discover-head">
                <strong>找到 {discovered.length} 个池子</strong>
                <span className="muted small">按深度排序，点一行即选中</span>
                <button className="btn ghost sm" onClick={() => (setDiscovered(null), setDiscoverNote(''))}>
                  收起
                </button>
              </div>
              <div className="discover-row head">
                <span>协议</span>
                <span>交易对</span>
                <span>Fee</span>
                <span>Spacing</span>
                <span>币价</span>
                <span>深度</span>
                <span>地址</span>
                <span />
              </div>
              {discovered.map((d) => {
                const key = `${d.pool.version}-${d.pool.poolAddress ?? d.pool.poolId}-${d.pool.fee}-${d.pool.tickSpacing}`
                const q = getCoinQuote(d.pool)
                const isSel =
                  pool != null &&
                  pool.version === d.pool.version &&
                  (pool.poolAddress ?? pool.poolId) === (d.pool.poolAddress ?? d.pool.poolId) &&
                  pool.fee === d.pool.fee &&
                  pool.tickSpacing === d.pool.tickSpacing
                const addr = d.pool.poolAddress ?? d.pool.poolId
                const hasHook =
                  d.pool.version === 'v4' &&
                  !!d.pool.hooks &&
                  d.pool.hooks.toLowerCase() !== '0x0000000000000000000000000000000000000000'
                return (
                  <div
                    key={key}
                    className={`discover-row ${isSel ? 'on' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => pickDiscoveredPool(d.pool)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        pickDiscoveredPool(d.pool)
                      }
                    }}
                  >
                    <span className={`tag ${d.pool.version}`}>
                      {d.pool.version === 'v3' ? (d.pool.dexLabel ?? 'V3') : 'V4'}
                    </span>
                    <span className="mono">
                      {q.coin.symbol}/{q.quote.symbol}
                      {hasHook && (
                        <span className="tag warn" title={`自定义 Hook ${d.pool.hooks}`}>
                          Hook
                        </span>
                      )}
                    </span>
                    <span>{(d.pool.fee / 10000).toFixed(2)}%</span>
                    <span className="muted">{d.pool.tickSpacing}</span>
                    <span className="mono">
                      {formatPrice(d.coinPrice)}
                      <span className="muted small"> {d.quoteSymbol}</span>
                    </span>
                    <span className="mono">
                      {d.tvlUsd != null ? formatUsd(d.tvlUsd) : d.liquidity > 0n ? '有流动性' : '空池'}
                    </span>
                    <span className="mono muted small">
                      {addr ? shortAddr(addr as Address) : '—'}
                    </span>
                    <span className="discover-pick">{isSel ? '已选' : '选择 →'}</span>
                  </div>
                )
              })}
            </div>
          )}

          {pool && (
            <>
              <div className="mint-pool">
                <div className="mint-pool-top">
                  <div>
                    <div className="mint-pair">{getCoinQuote(pool).coin.symbol} / {getCoinQuote(pool).quote.symbol}</div>
                    <div className="mint-meta">
                      Fee {(pool.fee / 10000).toFixed(2)}% · {pool.version.toUpperCase()}
                      {pool.dexLabel ? ` · ${pool.dexLabel}` : ''}
                    </div>
                  </div>
                  <div className="mint-pool-actions">
                    <button
                      className={`btn ${mintSwapOpen ? 'primary' : ''}`}
                      type="button"
                      aria-pressed={mintSwapOpen}
                      onClick={() => setMintSwapOpen((v) => !v)}
                    >
                      本池 Swap
                    </button>
                    <button className="btn" type="button" disabled={busy} onClick={() => void refreshPoolPrice()}>
                      刷新币价
                    </button>
                  </div>
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
                {pool.version === 'v4' && pool.hooks && pool.hooks.toLowerCase() !== '0x0000000000000000000000000000000000000000' && (
                  <p className="hook-warn">
                    含自定义 Hook（{shortAddr(pool.hooks)}），可能拒绝外部流动性或改变费用逻辑，开仓前请确认。
                  </p>
                )}
                {mintSwapOpen && (
                  <div className="mint-pool-swap op-block">
                    {pool.version === 'v3' && pool.dex && pool.dex !== 'uniswap' && pool.dex !== 'unknown' ? (
                      <p className="muted op-hint warn-text">
                        {pool.dexLabel ?? pool.dex} 池暂不支持本工具内 Swap，请用站外兑换。
                      </p>
                    ) : null}
                    <div className="swap-dir-row">
                      <button
                        type="button"
                        className={`filter-chip ${swapZeroForOne ? 'active' : ''}`}
                        aria-pressed={swapZeroForOne}
                        onClick={() => setSwapZeroForOne(true)}
                      >
                        {label0} → {label1}
                      </button>
                      <button
                        type="button"
                        className={`filter-chip ${!swapZeroForOne ? 'active' : ''}`}
                        aria-pressed={!swapZeroForOne}
                        onClick={() => setSwapZeroForOne(false)}
                      >
                        {label1} → {label0}
                      </button>
                      <button
                        type="button"
                        className="btn icon mint-swap"
                        title="切换方向"
                        onClick={() => setSwapZeroForOne((v) => !v)}
                      >
                        ⇄
                      </button>
                    </div>
                    <label className="amt">
                      <span className="amt-head">支付 {swapInMeta?.label ?? (swapZeroForOne ? label0 : label1)}</span>
                      <span className="bal-hint">
                        余额 {swapInMeta ? formatAmount(swapInMeta.bal, swapInMeta.token.decimals, 6) : '—'}
                        <button
                          type="button"
                          className="amt-max"
                          disabled={!address || !swapInMeta || swapInMeta.bal === 0n}
                          onClick={() => {
                            if (!swapInMeta) return
                            let max = swapInMeta.bal
                            if (mintUseEth && isEthLikeCurrency(swapInMeta.token.address)) {
                              max = ethBal > gasReserve ? ethBal - gasReserve : 0n
                            }
                            setSwapAmount(formatAmountExact(max, swapInMeta.token.decimals))
                          }}
                        >
                          Max
                        </button>
                      </span>
                      <input
                        value={swapAmount}
                        onChange={(e) => setSwapAmount(e.target.value)}
                        inputMode="decimal"
                        placeholder="兑换数量"
                      />
                    </label>
                    <div className="swap-quote-box">
                      <div className="swap-quote-line">
                        <span className="muted">预计得到</span>
                        <strong>
                          {swapQuoteBusy
                            ? '报价中…'
                            : swapQuote
                              ? `${formatAmount(swapQuote.amountOut, swapQuote.tokenOutDecimals, 6)} ${swapOutMeta?.label ?? ''}`
                              : '—'}
                        </strong>
                      </div>
                      {swapQuote && (
                        <div className="swap-quote-line muted">
                          <span>最少（滑点 {(slippageBps / 100).toFixed(2)}%）</span>
                          <span>
                            {formatAmount(swapQuote.amountOutMin, swapQuote.tokenOutDecimals, 6)}{' '}
                            {swapOutMeta?.label}
                            {!swapQuote.quoted ? ' · 现价估算' : ''}
                          </span>
                        </div>
                      )}
                      {swapQuoteErr && <p className="err-inline">{swapQuoteErr}</p>}
                    </div>
                    <p className="muted op-hint">
                      在当前{pool.version.toUpperCase()}池内单跳兑换，适合冷启动或建仓前换边配平。滑点用顶部设置。
                    </p>
                    <div className="btn-row">
                      <button
                        className="btn primary"
                        disabled={
                          busy
                          || !address
                          || !swapQuote
                          || swapQuoteBusy
                          || (pool.version === 'v3' && Boolean(pool.dex && pool.dex !== 'uniswap' && pool.dex !== 'unknown'))
                        }
                        onClick={() => {
                          if (!pool || !swapInMeta || !swapQuote) return
                          void run(
                            pool.version === 'v4' ? '本池 Swap V4' : '本池 Swap',
                            () => swapInPool({
                              walletClient: wallet!,
                              owner: address!,
                              position: poolAsSwapPosition(pool),
                              zeroForOne: swapZeroForOne,
                              amountIn: swapQuote.amountIn,
                              slippageBps,
                              useNativeEth: mintUseEth,
                              onStatus: setStatus,
                            }),
                            `${swapInMeta.label}→${swapOutMeta?.label ?? ''}`,
                            {
                              afterSuccess: () => {
                                setSwapAmount('')
                                setSwapQuote(null)
                                void refreshPoolPrice()
                              },
                            },
                          )
                        }}
                      >
                        确认 Swap{pool.version === 'v4' ? ' · V4' : ''}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className={`mint-range ${rangePreview?.inRangePreview === false ? 'out' : 'in'}`}>
                {/* 与第一步同一套编号头：三步是一条流程，标题样式必须同源 */}
                <div className="step-head">
                  <h3>
                    <span className="step-n">2</span>定区间
                    <InfoHint text="只有币价落在这个区间里，你的流动性才在工作、才收手续费。区间越窄，同样本金的手续费越高，但越容易被行情走出去。" />
                  </h3>
                  <div className="seg" role="group" aria-label="区间输入方式">
                    {([['percent', '按 %'], ['custom', '自定义价'], ['full', '全区间']] as const).map(([m, label]) => (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={rangeMode === m}
                        className={`filter-chip ${rangeMode === m ? 'active' : ''}`}
                        onClick={() => setRangeMode(m)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <RangeDepthChart
                  pool={pool}
                  depth={poolDepth}
                  loading={depthLoading}
                  error={depthError}
                  coinLower={rangePreview?.coinPriceLower ?? null}
                  coinUpper={rangePreview?.coinPriceUpper ?? null}
                  fullRange={rangeMode === 'full'}
                  onRangeChange={onDepthRangeChange}
                />

                {rangeMode === 'full' ? (
                  <p className="mint-full-hint">全区间：使用当前池 tickSpacing 对齐的最小/最大 tick，V3/V4 均适用。流动性覆盖全部价格。</p>
                ) : rangeMode === 'percent' ? (
                  <>
                    {/*
                     * 预设按「区间形状」分三组，而不是按数字大小平铺 —— 选区间的人心里想的是
                     * 「我要对称押注 / 我要偏多 / 我只想拿 ETH 进去」，不是「我要 -50/+200」。
                     * 原先两组都叫「单边」（一组是偏多区间，一组是只付单币），同名指两件事。
                     */}
                    <div className="mint-presets">
                      <div className="mint-preset-row">
                        <span className="mint-preset-label">对称</span>
                        <div className="seg" role="group" aria-label="对称区间预设">
                          {[5, 10, 20, 30, 40, 50].map((n) => (
                            <button
                              key={`bi-${n}`}
                              type="button"
                              aria-pressed={percentLower === -n && percentUp === n}
                              className={`filter-chip mono ${percentLower === -n && percentUp === n ? 'active' : ''}`}
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
                        <span className="mint-preset-label">偏多</span>
                        <div className="seg" role="group" aria-label="偏多区间预设">
                          {[100, 200, 300, 500].map((up) => (
                            <button
                              key={`side-${up}`}
                              type="button"
                              aria-pressed={percentLower === -50 && percentUp === up}
                              className={`filter-chip mono ${percentLower === -50 && percentUp === up ? 'active' : ''}`}
                              onClick={() => {
                                setPercentLower(-50)
                                setPercentUp(up)
                                setRangeMode('percent')
                              }}
                            >
                              -50 / +{up}%
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="mint-preset-row">
                        <span className="mint-preset-label">只付 {getNativeSymbol()}</span>
                        <div className="seg" role="group" aria-label="单币区间预设">
                          <button
                            type="button"
                            aria-pressed={percentLower === -75 && percentUp === -3}
                            className={`filter-chip ${percentLower === -75 && percentUp === -3 ? 'active' : ''}`}
                            onClick={() => {
                              // 币价口径固定 -75%~-3%，原生币在 token0/token1 都能单边支付
                              const { percentLower: lo, percentUpper: hi } = oneSidedEthPercents()
                              setPercentLower(lo)
                              setPercentUp(hi)
                              setRangeMode('percent')
                            }}
                          >
                            区间放到币价下方
                          </button>
                        </div>
                        <InfoHint text={`把整个区间挪到当前币价下方，建仓时通常只需付 ${getNativeSymbol()}（报价侧），不用先买币。等币价跌进区间才会开始成交。`} />
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
                  const needToken0 = pool.tick < rangePreview.tickLower
                  const needToken1 = pool.tick >= rangePreview.tickUpper
                  const singleSym = needToken0 ? label0 : needToken1 ? label1 : null
                  const coinBelow = coinHi < coinSpot
                  const statusText = rangeMode === 'full'
                    ? '全区间 · 覆盖全部价格，两侧代币都要准备'
                    : rangePreview.inRangePreview
                    ? `币价在区间内 · 建仓需要 ${label0} 和 ${label1} 两侧`
                    : `币价${coinBelow ? '高于上限' : '低于下限'} · 建仓只需要 ${singleSym}`
                  return (
                    <div className="mint-range-viz">
                      <div className={`mint-range-banner ${rangePreview.inRangePreview ? 'ok' : 'side'}`}>
                        {statusText}
                      </div>
                      {/*
                       * 这里曾经还有一条 .mint-range-track 轨道条 + 一排下限/币价/上限 —— 删了。
                       * 上方深度图已经用两个手柄画了同一个区间、用虚线画了同一个现价，
                       * 同一屏里把同一件事画两遍，读者会去找两者的差别（其实没有）。
                       * 精确数字仍然要有，但只留一处：区间宽度 + 两端价，横排一行。
                       */}
                      <div className="mint-range-facts">
                        {/*
                         * 按 % 模式下两个输入框各自已经挂着 ≈ 价格，这里再列一遍上下限
                         * 就是第三次说同一件事；那个模式下只补它没说的「宽度」。
                         * 自定义价 / 全区间 模式没有这个回显，才需要这条汇总。
                         */}
                        {rangeMode !== 'percent' && (
                          <div>
                            <span className="mint-end-k">区间</span>
                            <span className="mint-end-v">
                              {formatPrice(coinLo)} – {formatPrice(coinHi)}
                            </span>
                          </div>
                        )}
                        {/* 按 % 模式下这是唯一一项，右对齐就没有意义（会变成孤零零靠左的右对齐文字） */}
                        <div className={rangeMode === 'percent' ? '' : 'right'}>
                          <span className="mint-end-k">宽度</span>
                          <span className="mint-end-v">
                            {coinLo > 0 ? `${(((coinHi - coinLo) / coinSpot) * 100).toFixed(1)}%` : '—'}
                          </span>
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

              {poolHasWrappedToken && (
                <div className="mint-native-setting" role="group" aria-label="建仓支付资产">
                  <span className="mint-payment-label">支付资产</span>
                  <div className="mint-payment-options">
                    <button
                      type="button"
                      className={`mint-payment-option ${useNativeEth ? 'active' : ''}`}
                      aria-pressed={useNativeEth}
                      onClick={() => selectMintPayment('native')}
                    >
                      <span>原生 {getNativeSymbol()}</span>
                      <b className="mono">{mintBalanceText(ethBal, 18, ethBalStatus)}</b>
                    </button>
                    <button
                      type="button"
                      className={`mint-payment-option ${!useNativeEth ? 'active' : ''}`}
                      aria-pressed={!useNativeEth}
                      onClick={() => selectMintPayment('wrapped')}
                    >
                      <span>{getWrappedNativeSymbol()}</span>
                      <b className="mono">{mintBalanceText(wethBal, 18, wethBalStatus)}</b>
                    </button>
                  </div>
                  <button
                    type="button"
                    className="amt-max mint-balance-refresh"
                    disabled={!address || ethBalStatus === 'loading' || wethBalStatus === 'loading'}
                    onClick={() => address && void refreshBalances(address)}
                  >
                    刷新余额
                  </button>
                  <span className="mint-payment-note">
                    {useNativeEth
                      ? `${getNativeSymbol()} 会在建仓流程中自动包装；已预留少量 gas`
                      : `使用钱包已有 ${getWrappedNativeSymbol()}；原生 ${getNativeSymbol()} 只用于 gas`}
                  </span>
                </div>
              )}
              {poolHasNativeToken && !poolHasWrappedToken && (
                <div className="mint-native-setting native-only">
                  <span className="mint-payment-label">支付资产</span>
                  <span className="mint-native-only-value">
                    原生 {getNativeSymbol()} · 余额 {mintBalanceText(ethBal, 18, ethBalStatus)}
                  </span>
                  <button
                    type="button"
                    className="amt-max mint-balance-refresh"
                    disabled={!address || ethBalStatus === 'loading'}
                    onClick={() => address && void refreshBalances(address)}
                  >
                    刷新余额
                  </button>
                </div>
              )}

              <div className="mint-amounts">
                {/*
                 * 第三步的核心承诺是「你只填一边」—— 这件事以前只写在两个输入框
                 * 下面的一行灰色小字里，等于藏在用户已经动手算完之后才看到的位置。
                 * 现在提到步骤标题上：先看见规则，再看见输入框。
                 */}
                <div className="step-head">
                  <h3>
                    <span className="step-n">3</span>配数量
                  </h3>
                  <span className="step-promise">填一边，另一边自动算</span>
                </div>
                <div className="grid2">
                  <label className={mintPlan?.short0 ? 'amt short' : 'amt'}>
                    <span className="amt-head">
                      {label0}
                      {pairSide === 1 && !mintPlan?.empty && <span className="amt-auto">自动配平</span>}
                    </span>
                    <span className="bal-hint">
                      余额 {mintBalanceText(showBal0, pool.token0.decimals, showBal0Status)}
                      <button
                        type="button"
                        className="amt-max"
                        disabled={
                          !address
                          || !mintTicks
                          || mintMax0 === 0n
                          || mintNeedSide === 1
                          || showBal0Status !== 'ready'
                        }
                        onClick={() => onMintSide(0, formatAmountExact(mintMax0, pool.token0.decimals))}
                      >
                        Max
                      </button>
                    </span>
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
                    {mintPlan?.short0 && <span className="amt-warn">超出余额</span>}
                  </label>
                  <label className={mintPlan?.short1 ? 'amt short' : 'amt'}>
                    <span className="amt-head">
                      {label1}
                      {pairSide === 0 && !mintPlan?.empty && <span className="amt-auto">自动配平</span>}
                    </span>
                    <span className="bal-hint">
                      余额 {mintBalanceText(showBal1, pool.token1.decimals, showBal1Status)}
                      <button
                        type="button"
                        className="amt-max"
                        disabled={
                          !address
                          || !mintTicks
                          || mintMax1 === 0n
                          || mintNeedSide === 0
                          || showBal1Status !== 'ready'
                        }
                        onClick={() => onMintSide(1, formatAmountExact(mintMax1, pool.token1.decimals))}
                      >
                        Max
                      </button>
                    </span>
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
                    {mintPlan?.short1 && <span className="amt-warn">超出余额</span>}
                  </label>
                </div>

                {mintPlan && !mintPlan.empty && (
                  <div className="ratio-bar-wrap">
                    <div className="ratio-bar">
                      <span className="ratio-seg s0" style={{ width: `${mintPlan.pct0}%` }} />
                      <span className="ratio-seg s1" style={{ width: `${mintPlan.pct1}%` }} />
                    </div>
                    <div className="ratio-legend">
                      <span>
                        <i className="dot s0" />
                        {label0} {mintPlan.pct0.toFixed(0)}%
                      </span>
                      <span>
                        <i className="dot s1" />
                        {label1} {mintPlan.pct1.toFixed(0)}%
                      </span>
                      <span className="muted">
                        合计约 {formatPrice(mintPlan.total)} {mintPlan.unit}
                      </span>
                    </div>
                  </div>
                )}

                <div className="mint-fill">
                  <span className="muted small">按余额填</span>
                  <div className="seg" role="group" aria-label="按余额比例填入">
                    {[25, 50, 75, 100].map((n) => (
                      <button
                        key={n}
                        type="button"
                        className="filter-chip mono"
                        disabled={!address || !mintTicks}
                        onClick={() => fillBalances(n)}
                      >
                        {n === 100 ? '全部' : `${n}%`}
                      </button>
                    ))}
                  </div>
                </div>

                {/*
                 * 「填一边自动算另一边」已经写在步骤标题上了，这里只留标题说不了的：
                 * 单边区间该留空哪一侧、以及 ETH 要留 gas。避免同一句话说两遍。
                 */}
                <p className="muted amt-note">
                  {rangePreview && !rangePreview.inRangePreview
                    ? `当前是单边区间，只需要 ${pool.tick < rangePreview.tickLower ? label0 : label1}，另一侧留空即可。`
                    : '调整区间或刷新币价后数量会自动重算。用原生 ETH 建仓时记得留一点付 gas。'}
                </p>

                {(pool.version === 'v4' || mintProtocol === 'v4') && (
                  <label className="inline-setting" style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    转账税
                    <input
                      type="number"
                      min={0}
                      max={5000}
                      step={1}
                      value={transferTaxBps}
                      onChange={(e) => setTransferTaxBps(Math.max(0, Math.min(5000, Math.floor(Number(e.target.value) || 0))))}
                      style={{ width: 88 }}
                      title="单位 bps：25=0.25%，100=1%。池费率 0.25% 不是转账税"
                    />
                    <span className="muted small">
                      bps（{(transferTaxBps / 100).toFixed(2)}%）· 山寨币进 V4 必填；≠ 池 Fee
                    </span>
                    <InfoHint text="带转账税的币 transfer 到 PoolManager 会少到账，V4 的 SETTLE_PAIR 会直接 revert。这里按 bps 垫付 settle。0.25% 税填 25；MEOW 类 GoPlus 常见约 1%（~100）。上方「Fee 0.25%」是池手续费，不是转账税。" />
                  </label>
                )}
              </div>
              <div className="btn-row">
                <button
                  className="btn primary"
                  disabled={!address || !wallet || busy || !mintTicks}
                  onClick={() => {
                    if (!pool || !mintTicks || !rangePreview) return
                    startMintPosition({
                      targetPool: pool,
                      tickLower: mintTicks.tickLower,
                      tickUpper: mintTicks.tickUpper,
                      coinPriceLower: rangePreview.coinPriceLower,
                      coinPriceUpper: rangePreview.coinPriceUpper,
                      input0: amount0 || '0',
                      input1: amount1 || '0',
                      actionLabel: pool.version === 'v4' ? 'Mint V4' : 'Mint',
                      afterSuccess: () => {
                        setAmount0('')
                        setAmount1('')
                        setTab('positions')
                      },
                    })
                  }}
                >
                  Mint {pool?.version === 'v4' || mintProtocol === 'v4' ? 'V4' : 'V3'} 开仓{mintUseEth ? `（${getNativeSymbol()}）` : ''}
                </button>
                {/*
                 * 灰掉的主按钮必须说明为什么。禁用条件和上面 disabled= 是同一串，
                 * 顺序也一致：谁先拦住就报谁。少了这行，没连钱包的人只会看到
                 * 一个点不动的按钮，而页面上没有任何地方解释原因。
                 */}
                {!busy && (!address || !wallet || !mintTicks) && (
                  <span className="btn-reason">
                    {!address
                      ? '先在「工具」页连接钱包或导入本地私钥'
                      : !wallet
                      ? signerMode === 'local'
                        ? '本地私钥已锁定，去「工具」页解锁'
                        : '钱包未就绪，重新连接一次'
                      : '当前区间无效，检查上下限'}
                  </span>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {tab === 'dlmm' && (
        <DlmmMode
          pool={pool}
          poolInput={poolInput}
          discovered={discovered}
          discovering={discovering}
          busy={busy}
          address={address}
          walletReady={Boolean(wallet)}
          balance0={bal0}
          balance1={bal1}
          nativeBalance={ethBal}
          useNativeEth={useNativeEth}
          transferTaxBps={transferTaxBps}
          onPoolInput={setPoolInput}
          onLoadPool={() => void loadPoolByAddress()}
          onPickPool={pickDiscoveredPool}
          onRefreshPool={() => void refreshPoolPrice()}
          onUseNativeEth={setUseNativeEth}
          onTransferTaxBps={setTransferTaxBps}
          onOpenClassic={() => setTab('mint')}
          onExecute={startDlmmMint}
        />
      )}

      {tab === 'tools' && (
        /*
         * 三件互不相干的事拆成三张卡，不再是一块 1140px 宽的板子里用 <hr> 隔开。
         *
         * 原来的样子：ETH↔WETH、清空 NFT、常用链接顺着往下堆，中间两条横线，
         * 一个只会填「0.5」的数量框铺满 1118px，链接是浏览器默认的圆点列表，
         * 而右下角三分之二的屏幕是空的。卡片化以后宽屏一行三张，窄屏自己折。
         */
        <div className="tools-grid">
          <section className="panel tool-card">
            <h2>{getNativeSymbol()} ↔ {getWrappedNativeSymbol()}</h2>
            <p className="muted">
              仅组 {getWrappedNativeSymbol()} 池、且不走原生币支付时才需要。山寨/稳定币池不用 Wrap。
            </p>
            {/*
             * 余额从正文里拨出来做成两个读数。原来是「余额：0 ETH / 0 WETH」缩在说明句尾，
             * 和「做 LP 前可把…」同字号同颜色 —— 这是下面填数量时唯一要看的数，
             * 不该跟说明文字混在一句里。
             */}
            <div className="tool-bal">
              <span>
                <em>{getNativeSymbol()}</em>
                <b className="mono">{formatAmount(ethBal, 18, 5)}</b>
              </span>
              <span>
                <em>{getWrappedNativeSymbol()}</em>
                <b className="mono">{formatAmount(wethBal, 18, 5)}</b>
              </span>
            </div>
            <label className="tool-amt">
              数量
              <input value={wrapAmt} onChange={(e) => setWrapAmt(e.target.value)} placeholder="0.0" />
            </label>
            <div className="chip-row">
            <button type="button" className="chip" onClick={() => setWrapAmt(formatAmountExact(ethBal / 2n, 18))}>{`一半 ${getNativeSymbol()}`}</button>
            <button type="button" className="chip" onClick={() => setWrapAmt(formatAmountExact(ethBal > 10n ** 15n ? ethBal - 10n ** 15n : 0n, 18))}>{`Max ${getNativeSymbol()}(留 gas)`}</button>
            <button type="button" className="chip" onClick={() => setWrapAmt(formatAmountExact(wethBal, 18))}>{`Max ${getWrappedNativeSymbol()}`}</button>
          </div>
          <div className="btn-row">
            <button
              className="btn primary"
              disabled={!address || busy}
              onClick={() => void run(`Wrap ${getNativeSymbol()}`, () => wrapEth({
                walletClient: wallet!,
                owner: address!,
                amount: parseAmount(wrapAmt || '0', 18),
              }))}
            >
              Wrap → {getWrappedNativeSymbol()}
            </button>
            <button
              className="btn"
              disabled={!address || busy}
              onClick={() => void run(`Unwrap ${getWrappedNativeSymbol()}`, () => unwrapWeth({
                walletClient: wallet!,
                owner: address!,
                amount: parseAmount(wrapAmt || '0', 18),
              }))}
            >
              Unwrap → {getNativeSymbol()}
            </button>
          </div>
          </section>

          <section className="panel tool-card">
          <h2>清理空 V3 仓位 NFT</h2>
          <p className="muted">
            撤出流动性后 NFT 可能仍留在钱包（如 #107661），刷新列表会隐藏它们，但链上仍占一个 NFT 槽位。
          </p>
          {/*
           * 扫描结果常驻一块。原来只在「扫到了 ≥1 个」时才渲染一行 id，
           * 于是点完「扫描空 NFT」如果结果是 0，卡上什么都不变 —— 分不清是扫过了没有，
           * 还是没扫到。三种状态各写一句，另外这块也把等高卡片中间那段空白占上。
           */}
          <div className={`tool-scan ${vacantV3Ids === null ? 'idle' : vacantV3Ids.length ? 'found' : 'clean'}`}>
            {vacantV3Ids === null ? (
              <p className="tool-scan-msg">还没扫描。点下面的「扫描空 NFT」查一遍钱包里的 V3 仓位 NFT。</p>
            ) : vacantV3Ids.length === 0 ? (
              <p className="tool-scan-msg">没有空 NFT，钱包是干净的。</p>
            ) : (
              <>
                <p className="tool-scan-msg">
                  <b>{vacantV3Ids.length}</b> 个空 NFT 可销毁
                </p>
                <p className="tool-ids mono">
                  {vacantV3Ids.map((id) => `#${id.toString()}`).join(', ')}
                </p>
              </>
            )}
          </div>
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
          </section>

          <section className="panel tool-card tool-card-links">
            <h2>常用链接</h2>
            <p className="muted">合约与浏览器，在区块浏览器打开。</p>
            {/*
             * 从 <ul class="link-list"> 换成一排可点的行。原来是浏览器默认的圆点列表，
             * 四个下划线蓝链接吊在项目符号后面，跟这个工具里别处的按钮/卡片没有一点关系。
             * 每行补上地址：这几个链接的用处就是核对地址，光有名字还得点进去才知道对不对。
             */}
            <div className="tool-links">
              {/*
               * 当前地址排第一。这一栏的用处是「去浏览器核对」，而最常要核对的就是
               * 自己这个地址（看余额、看有没有到账、看那笔交易上没上链），
               * 它却是唯一一个要绕回顶栏去点的。没连时不显示，不留空行。
               */}
              {address && (
                <a
                  className="tool-link tool-link-me"
                  href={explorerAddress(address)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="tool-link-name">
                    当前地址
                    <span className="tool-link-tag">{signerMode === 'local' ? '本地' : '钱包'}</span>
                  </span>
                  <span className="tool-link-addr mono">{shortAddr(address)}</span>
                  <span className="tool-link-go" aria-hidden>↗</span>
                </a>
              )}
              {[
                { name: 'V3 Position Manager', addr: CONTRACTS.v3Npm, href: explorerAddress(CONTRACTS.v3Npm) },
                ...(chainHasWrappedNative()
                  ? [{ name: getWrappedNativeSymbol(), addr: CONTRACTS.weth, href: explorerAddress(CONTRACTS.weth) }]
                  : []),
                {
                  name: KNOWN_TOKENS[CONTRACTS.stable.toLowerCase()]?.symbol
                    ?? (chainId === 4663 ? 'USDG' : 'USDC'),
                  addr: CONTRACTS.stable,
                  href: explorerAddress(CONTRACTS.stable),
                },
              ].map((l) => (
                <a key={l.name} className="tool-link" href={l.href} target="_blank" rel="noreferrer">
                  <span className="tool-link-name">{l.name}</span>
                  <span className="tool-link-addr mono">{shortAddr(l.addr)}</span>
                  <span className="tool-link-go" aria-hidden>↗</span>
                </a>
              ))}
              <a className="tool-link" href={chainCfg.explorerUrl} target="_blank" rel="noreferrer">
                <span className="tool-link-name">{chainCfg.chain.blockExplorers?.default.name ?? '浏览器'}</span>
                <span className="tool-link-addr">{chainCfg.chain.name}</span>
                <span className="tool-link-go" aria-hidden>↗</span>
              </a>
            </div>
          </section>
        </div>
      )}

      {tab === 'auto' && (
        // 和仓位页、新建仓页同一处理：外层不再是 .panel。
        // 这页里面装着签名方式选择卡、两张策略卡、安全阀卡，
        // 外面再套一层有阴影的白卡就又是盒子套盒子，里层卡片只能靠灰底把自己
        // 和父卡分开，颜色越叠越糊。去掉外壳后里层卡片可以升级成真正的主表面。
        <section className="page-auto">
          <div className="row between">
            <h2>本地私钥与自动化</h2>
            <span className="muted small">
              {signerMode === 'wallet'
                ? '当前用插件钱包签名'
                : signerMode === 'local'
                  ? '当前用本地私钥签名'
                  : '未选择签名方式'}
            </span>
          </div>

          <div className="signer-mode-row">
            <div className={`mode-card ${signerMode === 'wallet' ? 'on' : ''}`}>
              <div className="mode-head">
                <strong>插件钱包</strong>
                {signerMode === 'wallet' && <span className="badge">使用中</span>}
              </div>
              <p className="muted small">
                MetaMask / Rabby。每笔交易手动确认，私钥不离开插件，最安全。不支持无人值守。
              </p>
              {signerMode === 'wallet' ? (
                <button className="btn ghost sm" onClick={disconnect}>
                  断开
                </button>
              ) : (
                <>
                  <button className="btn sm" disabled={busy || signerMode === 'local'} onClick={connect}>
                    连接钱包
                  </button>
                  {/*
                   * 两张卡是并列的两种签名通道，说的是同一条互斥规则，
                   * 所以两边都得解释自己为什么不可用 —— 右边那张一直有这么一行
                   * （「需先断开插件钱包」/「在下方导入」），左边却只有一个灰按钮，
                   * 本地私钥模式下点不动也不说为什么。
                   */}
                  {signerMode === 'local' && (
                    <span className="muted small">需先锁定本地私钥</span>
                  )}
                </>
              )}
            </div>

            <div className={`mode-card ${signerMode === 'local' ? 'on' : ''}`}>
              <div className="mode-head">
                <strong>本地私钥</strong>
                {signerMode === 'local' && <span className="badge live">使用中</span>}
              </div>
              <p className="muted small">
                导入私钥后本地签名直接广播，无需确认，可跑自动化。安全性低于插件钱包。
              </p>
              <span className="muted small">
                {signerMode === 'wallet' ? '需先断开插件钱包' : '在下方导入'}
              </span>
            </div>
          </div>

          <SignerPanel
            active={localAddr}
            walletConnected={signerMode === 'wallet'}
            onUnlocked={onLocalUnlocked}
            onLocked={onLocalLocked}
            onError={(msg) => pushToast({ kind: 'error', title: msg })}
            autoLockMins={autoLockMins}
            onAutoLockMins={setAutoLockMins}
          />

          <h3 className="section-h">自动策略</h3>
          <AutomationPanel
            cfg={autoCfg}
            onCfg={setAutoCfg}
            unlocked={signerMode === 'local'}
            running={autoRunning}
            lastRunAt={autoLastRunAt}
            nextRunIn={autoNextIn}
            plan={autoPlan}
            busy={autoRunning || busy}
            onDryRun={() => void runAutomation(true)}
            onRunNow={() =>
              confirmThen(
                {
                  title: '立即执行一轮自动化？',
                  lines: [
                    '会按当前配置真实发起交易（撤仓 / 重开 / 领取 / 加仓）。',
                    '建议先用「立即演算一次」确认计划。',
                  ],
                  confirmLabel: '执行',
                  danger: true,
                },
                () => void runAutomation(false),
              )
            }
          />
        </section>
      )}

      {tab === 'history' && (
        // 原来是 .panel + `.tx-panel > * { max-width: 760px }`：外壳铺满 1160px，
        // 里面的东西全被压在左边 760px 内，于是这页看起来是一张空了三分之一的大白卡。
        // 那个 760 的上限本身没错（四列表格摊到 1160 会松散得像没写完），错在
        // 卡住的是子元素而不是外壳。改成外壳自己有宽度上限，表格自己就是那个表面。
        <section className="page-history">
          <div className="row between">
            <h2>本地交易历史</h2>
            <div className="btn-row tight">
              <button
                className="btn"
                type="button"
                disabled={!txHistory.length}
                onClick={() => {
                  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
                  downloadCsv(`rangedesk-tx-${stamp}.csv`, [
                    ['时间', '操作', '交易对', '交易哈希'],
                    ...txHistory.map((t) => [new Date(t.at).toLocaleString(), t.label, t.pair ?? '', t.hash]),
                  ])
                  pushToast({ kind: 'success', title: `已导出 ${txHistory.length} 条记录` })
                }}
              >
                导出 CSV
              </button>
              <button
                className="btn danger"
                type="button"
                disabled={!txHistory.length}
                onClick={() =>
                  confirmThen(
                    { title: '清空本地交易历史？', lines: ['只影响本机记录，不影响链上数据。'], confirmLabel: '清空', danger: true },
                    () => {
                      clearTxHistory()
                      setTxHistory([])
                      pushToast({ kind: 'success', title: '已清空本地记录' })
                    },
                  )
                }
              >
                清空
              </button>
            </div>
          </div>
          <p className="muted">仅保存在本机 localStorage，不会上链。</p>
          {/*
            * 四个字段拆成对齐的四列，不再是「一坨左边内容 + 贴右边的哈希」。
            *
            * 原来一行只有两个盒子：左边把操作、交易对、时间挤成一摞，右边 space-between
            * 把哈希顶到 1118px 宽行的最右端 —— 量出来中间是 844~850px 的死区，
            * 而且交易对和时间在行与行之间根本不对齐（左块宽度随文案在 170~176px 之间浮动），
            * 想竖着扫「哪几笔是复投」得逐行找。
            *
            * 表结构照 .discover-row 那套来（外框 + 表头 + 网格行），页面里已经有这个惯例了。
            */}
          {txHistory.length === 0 ? (
            <p className="muted">暂无记录</p>
          ) : (
            <div className="tx-table">
              {/* 真 table：列宽在 thead / tbody 之间天然共享，而且 th scope 能把列名念给读屏 */}
              <table>
                <thead>
                  <tr>
                    <th scope="col">操作</th>
                    <th scope="col">交易对</th>
                    <th scope="col">时间</th>
                    <th scope="col" className="tx-hash-col">交易哈希</th>
                  </tr>
                </thead>
                <tbody>
                  {txHistory.map((t) => (
                    <tr key={t.id}>
                      <th scope="row">{t.label}</th>
                      <td className="tx-pair">{t.pair ?? '—'}</td>
                      {/* 列上是量级，绝对时间挪进 title —— 查证时才需要精确到秒 */}
                      <td className="tx-when" title={new Date(t.at).toLocaleString()}>
                        {relTime(t.at)}
                      </td>
                      <td className="tx-hash-col">
                        {/*
                          * 链接的可见文字是截断哈希，读屏念出来是一串没有上下文的十六进制。
                          * aria-label 补上「这是谁的哈希、点了会去哪」。
                          */}
                        <a
                          className="mono"
                          href={explorerTx(t.hash)}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`在区块浏览器查看${t.label}的交易 ${t.hash}`}
                        >
                          {shortAddr(t.hash)} ↗
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'flow' && <FlowMonitor onOpenPool={(args) => void openFlowPool(args)} />}

      {/*
       * 页脚。原来是两个裸 <p> 顺着往下堆，灰字挂在一片空白里，是全站最像
       * 「还没做完」的一处。改成一条带发丝上边框的注脚行：左边是链和合约（要核对地址时看的），
       * 右边是能力说明。宽屏一行放下，窄屏自己折成两行。
       */}
      <footer className="app-foot">
        <span className="foot-chain">
          <i className="foot-dot" aria-hidden />
          {chainCfg.label}
          <span className="foot-sep" aria-hidden>·</span>
          Uniswap V3 NPM
          <code>{CONTRACTS.v3Npm}</code>
        </span>
        <span className="foot-note">
          半自动工具：V3 + V4（modifyLiquidities / Permit2）。无人值守 keeper 后续再加。
        </span>
      </footer>
        </main>
      </div>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      <ConfirmDialog request={confirmReq} onClose={() => setConfirmReq(null)} />
    </div>
  )
}
