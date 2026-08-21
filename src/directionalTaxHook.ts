import {
  concatHex,
  createPublicClient,
  encodeDeployData,
  getAddress,
  getCreate2Address,
  http,
  keccak256,
  padHex,
  stringToHex,
  toHex,
  type Address,
  type Hash,
  type Hex,
  type WalletClient,
} from 'viem'
import {
  CONTRACTS,
  getActiveChainConfig,
  getActiveChainId,
  type SupportedChainId,
} from './chain'
import { withTimeout } from './async'
import { loadCustomRpcUrl } from './rpcSettings'
import { publicClient } from './wallet'
import { CONFIGURABLE_TAX_FACTORY_V2_BYTECODE } from './generated/configurableTaxFactoryV2Bytecode'
import { DIRECTIONAL_TAX_FACTORY_BYTECODE } from './generated/directionalTaxFactoryBytecode'

export const DIRECTIONAL_TAX_CHAIN_IDS = [1, 56, 4663, 8453] as const
export const DIRECTIONAL_TAX_PRESETS_BPS = [0, 100, 300, 500, 1000, 2000, 3000, 5000, 8000] as const

export const DIRECTIONAL_TAX_CREATE2_PROXY = getAddress(
  '0x4e59b44847b379578588920cA78FbF26c0B4956C',
)
export const DIRECTIONAL_TAX_FACTORY_SALT = keccak256(
  stringToHex('RangeDesk DirectionalTaxHookFactory v1'),
)
export const CONFIGURABLE_TAX_FACTORY_V2_SALT = keccak256(
  stringToHex('RangeDesk ConfigurableTaxHookFactory v2'),
)
export const DIRECTIONAL_TAX_REQUIRED_FLAGS = 0x2044n
export const DIRECTIONAL_TAX_ALL_FLAGS_MASK = 0x3fffn
export const DIRECTIONAL_TAX_MAX_BPS = 8_000
export const V4_MAX_LP_FEE = 1_000_000

const CLONE_CREATION_PREFIX = '0x3d602d80600a3d3981f3' as const
const CLONE_RUNTIME_PREFIX = '0x363d3d373d3d3d363d73' as const
const CLONE_RUNTIME_SUFFIX = '0x5af43d82803e903d91602b57fd5bf3' as const

export const directionalTaxFactoryAbi = [
  {
    type: 'constructor',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'manager', type: 'address' }],
  },
  {
    type: 'function',
    name: 'poolManager',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'implementation',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'REQUIRED_FLAGS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint160' }],
  },
  {
    type: 'function',
    name: 'cloneInitCodeHash',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'predictHook',
    stateMutability: 'view',
    inputs: [
      { name: 'creator', type: 'address' },
      { name: 'userSalt', type: 'bytes32' },
    ],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'createPool',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'currency0', type: 'address' },
      { name: 'currency1', type: 'address' },
      { name: 'tickSpacing', type: 'int24' },
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'taxToken', type: 'address' },
      { name: 'buyTaxBps', type: 'uint16' },
      { name: 'sellTaxBps', type: 'uint16' },
      { name: 'userSalt', type: 'bytes32' },
    ],
    outputs: [
      { name: 'hook', type: 'address' },
      { name: 'poolId', type: 'bytes32' },
      { name: 'tick', type: 'int24' },
    ],
  },
] as const

export const configurableTaxFactoryV2Abi = [
  {
    type: 'constructor',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'manager', type: 'address' }],
  },
  {
    type: 'function',
    name: 'poolManager',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'implementation',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'REQUIRED_FLAGS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint160' }],
  },
  {
    type: 'function',
    name: 'predictHook',
    stateMutability: 'view',
    inputs: [
      { name: 'creator', type: 'address' },
      { name: 'userSalt', type: 'bytes32' },
    ],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'createPool',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'currency0', type: 'address' },
      { name: 'currency1', type: 'address' },
      { name: 'lpFee', type: 'uint24' },
      { name: 'tickSpacing', type: 'int24' },
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'taxToken', type: 'address' },
      { name: 'buyTaxBps', type: 'uint16' },
      { name: 'sellTaxBps', type: 'uint16' },
      { name: 'userSalt', type: 'bytes32' },
    ],
    outputs: [
      { name: 'hook', type: 'address' },
      { name: 'poolId', type: 'bytes32' },
      { name: 'tick', type: 'int24' },
    ],
  },
] as const

export const directionalTaxHookAbi = [
  {
    type: 'function',
    name: 'config',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'poolId', type: 'bytes32' },
      { name: 'collector', type: 'address' },
      { name: 'taxToken', type: 'address' },
      { name: 'buyTaxBps', type: 'uint16' },
      { name: 'sellTaxBps', type: 'uint16' },
      { name: 'initialized', type: 'bool' },
    ],
  },
] as const

export const configurableTaxHookV2Abi = [
  {
    type: 'function',
    name: 'config',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'poolId', type: 'bytes32' },
      { name: 'collector', type: 'address' },
      { name: 'taxToken', type: 'address' },
      { name: 'lpFee', type: 'uint24' },
      { name: 'buyTaxBps', type: 'uint16' },
      { name: 'sellTaxBps', type: 'uint16' },
      { name: 'initialized', type: 'bool' },
    ],
  },
] as const

export type DirectionalTaxFactoryStatus = {
  supported: boolean
  factory: Address
  deployed: boolean
  implementation?: Address
  reason?: string
}

export type DirectionalTaxPoolSubmission = {
  factory: Address
  hook: Address
  poolId: Hex
  currency0: Address
  currency1: Address
  lpFee: number
  tickSpacing: number
  userSalt: Hex
  factoryHash?: Hash
  poolHash: Hash
}

export type DirectionalTaxPoolDeployment = DirectionalTaxPoolSubmission & {
  /** 交易已成功，但公共 RPC 尚未完成 config() 复检时给 UI 的非阻断提示。 */
  verificationWarning?: string
}

export type DirectionalTaxHookConfig = {
  version: 'v1' | 'v2'
  poolId: Hex
  collector: Address
  taxToken: Address
  lpFee: number
  buyTaxBps: number
  sellTaxBps: number
}

type FactoryStatusCacheEntry = {
  expiresAt: number
  promise: Promise<DirectionalTaxFactoryStatus>
}

const factoryStatusCache = new Map<string, FactoryStatusCacheEntry>()
const FACTORY_STATUS_CACHE_MS = 20_000

function factoryStatusCacheKey(version: 'v1' | 'v2'): string {
  return `${getActiveChainId()}:${CONTRACTS.v4PoolManager.toLowerCase()}:${version}`
}

function clearFactoryStatusCache(version?: 'v1' | 'v2'): void {
  if (!version) {
    factoryStatusCache.clear()
    return
  }
  factoryStatusCache.delete(factoryStatusCacheKey(version))
}

function getCachedFactoryStatus(version: 'v1' | 'v2'): Promise<DirectionalTaxFactoryStatus> {
  const key = factoryStatusCacheKey(version)
  const cached = factoryStatusCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.promise

  const promise = version === 'v2'
    ? getConfigurableTaxFactoryV2Status()
    : getDirectionalTaxFactoryStatus()
  factoryStatusCache.set(key, { expiresAt: Date.now() + FACTORY_STATUS_CACHE_MS, promise })
  void promise.catch(() => {
    if (factoryStatusCache.get(key)?.promise === promise) factoryStatusCache.delete(key)
  })
  return promise
}

export function supportsDirectionalTax(chainId: SupportedChainId = getActiveChainId()): boolean {
  return (DIRECTIONAL_TAX_CHAIN_IDS as readonly number[]).includes(chainId)
}

export function isDirectionalTaxPreset(bps: number): boolean {
  return (DIRECTIONAL_TAX_PRESETS_BPS as readonly number[]).includes(bps)
}

export function directionalTaxFactoryInitCode(poolManager: Address = CONTRACTS.v4PoolManager): Hex {
  return encodeDeployData({
    abi: directionalTaxFactoryAbi,
    bytecode: DIRECTIONAL_TAX_FACTORY_BYTECODE,
    args: [poolManager],
  })
}

export function directionalTaxFactoryAddress(poolManager: Address = CONTRACTS.v4PoolManager): Address {
  return getCreate2Address({
    from: DIRECTIONAL_TAX_CREATE2_PROXY,
    salt: DIRECTIONAL_TAX_FACTORY_SALT,
    bytecodeHash: keccak256(directionalTaxFactoryInitCode(poolManager)),
  })
}

export function configurableTaxFactoryV2InitCode(
  poolManager: Address = CONTRACTS.v4PoolManager,
): Hex {
  return encodeDeployData({
    abi: configurableTaxFactoryV2Abi,
    bytecode: CONFIGURABLE_TAX_FACTORY_V2_BYTECODE,
    args: [poolManager],
  })
}

export function configurableTaxFactoryV2Address(
  poolManager: Address = CONTRACTS.v4PoolManager,
): Address {
  return getCreate2Address({
    from: DIRECTIONAL_TAX_CREATE2_PROXY,
    salt: CONFIGURABLE_TAX_FACTORY_V2_SALT,
    bytecodeHash: keccak256(configurableTaxFactoryV2InitCode(poolManager)),
  })
}

function cloneInitCodeHash(implementation: Address): Hex {
  return keccak256(
    concatHex([
      CLONE_CREATION_PREFIX,
      CLONE_RUNTIME_PREFIX,
      implementation,
      CLONE_RUNTIME_SUFFIX,
    ]),
  )
}

function cloneRuntimeCode(implementation: Address): Hex {
  return concatHex([CLONE_RUNTIME_PREFIX, implementation, CLONE_RUNTIME_SUFFIX])
}

function derivedCloneSalt(creator: Address, userSalt: Hex): Hex {
  return keccak256(concatHex([creator, userSalt]))
}

export function predictDirectionalTaxHook(
  factory: Address,
  implementation: Address,
  creator: Address,
  userSalt: Hex,
): Address {
  return getCreate2Address({
    from: factory,
    salt: derivedCloneSalt(creator, userSalt),
    bytecodeHash: cloneInitCodeHash(implementation),
  })
}

export function hasDirectionalTaxHookFlags(address: Address): boolean {
  return (BigInt(address) & DIRECTIONAL_TAX_ALL_FLAGS_MASK) === DIRECTIONAL_TAX_REQUIRED_FLAGS
}

function randomSaltStart(): bigint {
  const words = new Uint32Array(4)
  globalThis.crypto?.getRandomValues?.(words)
  let random = 0n
  for (const word of words) random = (random << 32n) | BigInt(word)
  // Keep the timestamp and all 128 random bits. Shifting `value` inside the loop would push
  // the timestamp past uint256 and silently discard it.
  return ((BigInt(Date.now()) << 128n) | random) & ((1n << 256n) - 1n)
}

export async function mineDirectionalTaxHookSalt(opts: {
  factory: Address
  implementation: Address
  creator: Address
  start?: bigint
  maxAttempts?: number
}): Promise<{ userSalt: Hex; hook: Address; attempts: number }> {
  const start = opts.start ?? randomSaltStart()
  const maxAttempts = opts.maxAttempts ?? 300_000
  const uint256Mask = (1n << 256n) - 1n
  const initCodeHash = cloneInitCodeHash(opts.implementation)

  for (let i = 0; i < maxAttempts; i += 1) {
    const userSalt = padHex(toHex((start + BigInt(i)) & uint256Mask), { size: 32 })
    const cloneSalt = derivedCloneSalt(opts.creator, userSalt)
    const digest = keccak256(concatHex(['0xff', opts.factory, cloneSalt, initCodeHash]))
    // Permission bits are the low 14 bits of the CREATE2 address. Avoid checksum conversion on
    // every attempt; convert to a checksummed address only once after a matching digest is found.
    if ((BigInt(`0x${digest.slice(-4)}`) & DIRECTIONAL_TAX_ALL_FLAGS_MASK) === DIRECTIONAL_TAX_REQUIRED_FLAGS) {
      const hook = getAddress(`0x${digest.slice(-40)}`)
      return { userSalt, hook, attempts: i + 1 }
    }
    if (i > 0 && i % 4096 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  throw new Error('无法找到符合 V4 权限位的 Hook 地址，请重试')
}

async function waitForHash(hash: Hash, action: string) {
  const receipt = await withTimeout(
    publicClient.waitForTransactionReceipt({ hash, confirmations: 1, pollingInterval: 1_000 }),
    120_000,
    action,
  )
  if (receipt.status !== 'success') throw new Error(`${action}失败（交易已回滚）`)
  return receipt
}

/**
 * 建池回执刚确认时，不同公共 RPC 的最新状态可能相差数秒。viem fallback 只会在
 * transport error 时切节点；某节点把新合约错误地返回成 `0x` 时不会继续 fallback。
 * 这里仅在建池后做一次并行复检：任意一个配置正确的节点成功即可，避免把已成功
 * 的建池交易误报成失败。
 */
async function readConfigurableTaxHookV2AfterReceipt(
  hook: Address,
  implementation: Address,
) {
  const chain = getActiveChainConfig()
  const customRpc = loadCustomRpcUrl(chain.id)
  const urls = [...new Set([...(customRpc ? [customRpc] : []), ...chain.defaultRpcUrls])]
  const expectedRuntime = cloneRuntimeCode(implementation).toLowerCase()
  let lastError: unknown = null

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withTimeout(
        Promise.any(urls.map(async (url) => {
          const client = createPublicClient({
            chain: chain.chain,
            transport: http(url, { batch: false, retryCount: 0, timeout: 5_000 }),
          })
          const [code, config] = await Promise.all([
            client.getBytecode({ address: hook }),
            client.readContract({
              address: hook,
              abi: configurableTaxHookV2Abi,
              functionName: 'config',
            }),
          ])
          if (!code || code === '0x') throw new Error('Hook 字节码尚未同步')
          if (code.toLowerCase() !== expectedRuntime) throw new Error('Hook 字节码版本不匹配')
          if (!config[6]) throw new Error('Hook config 尚未初始化')
          return config
        })),
        6_500,
        '多节点复检 Hook 配置',
      )
    } catch (error) {
      lastError = error
      if (attempt < 2) {
        await new Promise<void>((resolve) => setTimeout(resolve, 700 * (attempt + 1)))
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('公共 RPC 暂未同步 Hook 配置')
}

export async function getDirectionalTaxFactoryStatus(): Promise<DirectionalTaxFactoryStatus> {
  const factory = directionalTaxFactoryAddress()
  if (!supportsDirectionalTax()) {
    return { supported: false, factory, deployed: false, reason: '当前链暂未开放税率 Hook' }
  }

  const proxyCode = await publicClient.getBytecode({ address: DIRECTIONAL_TAX_CREATE2_PROXY })
  if (!proxyCode || proxyCode === '0x') {
    return { supported: false, factory, deployed: false, reason: '当前链缺少 CREATE2 部署器' }
  }

  const code = await publicClient.getBytecode({ address: factory })
  if (!code || code === '0x') return { supported: true, factory, deployed: false }

  const [manager, implementation, flags] = await Promise.all([
    publicClient.readContract({
      address: factory,
      abi: directionalTaxFactoryAbi,
      functionName: 'poolManager',
    }),
    publicClient.readContract({
      address: factory,
      abi: directionalTaxFactoryAbi,
      functionName: 'implementation',
    }),
    publicClient.readContract({
      address: factory,
      abi: directionalTaxFactoryAbi,
      functionName: 'REQUIRED_FLAGS',
    }),
  ])
  if (manager.toLowerCase() !== CONTRACTS.v4PoolManager.toLowerCase()) {
    throw new Error('税率 Hook 工厂绑定了错误的 PoolManager')
  }
  if (flags !== DIRECTIONAL_TAX_REQUIRED_FLAGS) {
    throw new Error('税率 Hook 工厂权限位版本不匹配')
  }
  const implementationCode = await publicClient.getBytecode({ address: implementation })
  if (!implementationCode || implementationCode === '0x') {
    throw new Error('税率 Hook 工厂缺少实现合约')
  }
  return { supported: true, factory, deployed: true, implementation }
}

export async function getConfigurableTaxFactoryV2Status(): Promise<DirectionalTaxFactoryStatus> {
  const factory = configurableTaxFactoryV2Address()
  if (!supportsDirectionalTax()) {
    return { supported: false, factory, deployed: false, reason: '当前链暂未开放税率 Hook' }
  }

  const proxyCode = await publicClient.getBytecode({ address: DIRECTIONAL_TAX_CREATE2_PROXY })
  if (!proxyCode || proxyCode === '0x') {
    return { supported: false, factory, deployed: false, reason: '当前链缺少 CREATE2 部署器' }
  }

  const code = await publicClient.getBytecode({ address: factory })
  if (!code || code === '0x') return { supported: true, factory, deployed: false }

  const [manager, implementation, flags] = await Promise.all([
    publicClient.readContract({
      address: factory,
      abi: configurableTaxFactoryV2Abi,
      functionName: 'poolManager',
    }),
    publicClient.readContract({
      address: factory,
      abi: configurableTaxFactoryV2Abi,
      functionName: 'implementation',
    }),
    publicClient.readContract({
      address: factory,
      abi: configurableTaxFactoryV2Abi,
      functionName: 'REQUIRED_FLAGS',
    }),
  ])
  if (manager.toLowerCase() !== CONTRACTS.v4PoolManager.toLowerCase()) {
    throw new Error('V2 税率 Hook 工厂绑定了错误的 PoolManager')
  }
  if (flags !== DIRECTIONAL_TAX_REQUIRED_FLAGS) {
    throw new Error('V2 税率 Hook 工厂权限位版本不匹配')
  }
  const implementationCode = await publicClient.getBytecode({ address: implementation })
  if (!implementationCode || implementationCode === '0x') {
    throw new Error('V2 税率 Hook 工厂缺少实现合约')
  }
  return { supported: true, factory, deployed: true, implementation }
}

/** Recognize exact v2 clones first, then the immutable v1 clones already deployed by users. */
export async function readDirectionalTaxHookConfig(
  hook: Address,
): Promise<DirectionalTaxHookConfig | null> {
  if (!supportsDirectionalTax()) return null
  try {
    const code = await publicClient.getBytecode({ address: hook })
    if (!code || code === '0x') return null

    // A position list may contain many Hook NFTs. Deduplicate the factory bytecode/config reads
    // so showing badges does not create an RPC burst for every card.
    const v2 = await getCachedFactoryStatus('v2')
    if (
      v2.deployed
      && v2.implementation
      && code.toLowerCase() === cloneRuntimeCode(v2.implementation).toLowerCase()
    ) {
      const cfg = await publicClient.readContract({
        address: hook,
        abi: configurableTaxHookV2Abi,
        functionName: 'config',
      })
      if (!cfg[6]) return null
      return {
        version: 'v2',
        poolId: cfg[0],
        collector: cfg[1],
        taxToken: cfg[2],
        lpFee: cfg[3],
        buyTaxBps: cfg[4],
        sellTaxBps: cfg[5],
      }
    }

    const v1 = await getCachedFactoryStatus('v1')
    if (
      !v1.deployed
      || !v1.implementation
      || code.toLowerCase() !== cloneRuntimeCode(v1.implementation).toLowerCase()
    ) return null
    const cfg = await publicClient.readContract({
      address: hook,
      abi: directionalTaxHookAbi,
      functionName: 'config',
    })
    if (!cfg[5]) return null
    return {
      version: 'v1',
      poolId: cfg[0],
      collector: cfg[1],
      taxToken: cfg[2],
      lpFee: 0,
      buyTaxBps: cfg[3],
      sellTaxBps: cfg[4],
    }
  } catch {
    return null
  }
}

export async function ensureDirectionalTaxFactory(opts: {
  walletClient: WalletClient
  owner: Address
  onStatus?: (message: string) => void
}): Promise<{ status: DirectionalTaxFactoryStatus; hash?: Hash }> {
  let status = await getDirectionalTaxFactoryStatus()
  if (!status.supported) throw new Error(status.reason ?? '当前链不支持税率 Hook')
  if (status.deployed) return { status }

  const initCode = directionalTaxFactoryInitCode()
  const data = concatHex([DIRECTIONAL_TAX_FACTORY_SALT, initCode])
  opts.onStatus?.('首次使用：请确认部署本链公共税率 Hook 工厂…')
  const estimated = await withTimeout(
    publicClient.estimateGas({
      account: opts.owner,
      to: DIRECTIONAL_TAX_CREATE2_PROXY,
      data,
    }),
    20_000,
    '估算 Hook 工厂 Gas',
  )
  const hash = await opts.walletClient.sendTransaction({
    account: opts.owner,
    chain: opts.walletClient.chain,
    to: DIRECTIONAL_TAX_CREATE2_PROXY,
    data,
    gas: (estimated * 130n) / 100n,
  })
  opts.onStatus?.(`税率 Hook 工厂已提交 ${hash.slice(0, 10)}…，等待确认`)
  await waitForHash(hash, '部署税率 Hook 工厂')
  clearFactoryStatusCache('v1')
  status = await getDirectionalTaxFactoryStatus()
  if (!status.deployed || !status.implementation) throw new Error('Hook 工厂部署后校验失败')
  return { status, hash }
}

export async function ensureConfigurableTaxFactoryV2(opts: {
  walletClient: WalletClient
  owner: Address
  onStatus?: (message: string) => void
}): Promise<{ status: DirectionalTaxFactoryStatus; hash?: Hash }> {
  let status = await getConfigurableTaxFactoryV2Status()
  if (!status.supported) throw new Error(status.reason ?? '当前链不支持 V2 税率 Hook')
  if (status.deployed) return { status }

  const initCode = configurableTaxFactoryV2InitCode()
  const data = concatHex([CONFIGURABLE_TAX_FACTORY_V2_SALT, initCode])
  opts.onStatus?.('本链首次使用 V2：请确认部署公共自定义税率 Hook 工厂…')
  const estimated = await withTimeout(
    publicClient.estimateGas({
      account: opts.owner,
      to: DIRECTIONAL_TAX_CREATE2_PROXY,
      data,
    }),
    20_000,
    '估算 V2 Hook 工厂 Gas',
  )
  const hash = await opts.walletClient.sendTransaction({
    account: opts.owner,
    chain: opts.walletClient.chain,
    to: DIRECTIONAL_TAX_CREATE2_PROXY,
    data,
    gas: (estimated * 130n) / 100n,
  })
  opts.onStatus?.(`V2 税率 Hook 工厂已提交 ${hash.slice(0, 10)}…，等待确认`)
  await waitForHash(hash, '部署 V2 税率 Hook 工厂')
  clearFactoryStatusCache('v2')
  status = await getConfigurableTaxFactoryV2Status()
  if (!status.deployed || !status.implementation) throw new Error('V2 Hook 工厂部署后校验失败')
  return { status, hash }
}

export async function createDirectionalTaxPool(opts: {
  walletClient: WalletClient
  owner: Address
  currency0: Address
  currency1: Address
  lpFee: number
  tickSpacing: number
  sqrtPriceX96: bigint
  taxToken: Address
  buyTaxBps: number
  sellTaxBps: number
  onStatus?: (message: string) => void
  /** 钱包已接受建池交易后立即触发；此时 PoolId 已确定，不依赖后续 RPC 复检。 */
  onSubmitted?: (submission: DirectionalTaxPoolSubmission) => void
}): Promise<DirectionalTaxPoolDeployment> {
  if (!Number.isInteger(opts.lpFee) || opts.lpFee < 0 || opts.lpFee > V4_MAX_LP_FEE) {
    throw new Error('V4 LP 手续费无效')
  }
  if (!Number.isInteger(opts.buyTaxBps) || opts.buyTaxBps < 0 || opts.buyTaxBps > DIRECTIONAL_TAX_MAX_BPS) {
    throw new Error('买入税必须在 0%–80% 之间，精度 0.01%')
  }
  if (!Number.isInteger(opts.sellTaxBps) || opts.sellTaxBps < 0 || opts.sellTaxBps > DIRECTIONAL_TAX_MAX_BPS) {
    throw new Error('卖出税必须在 0%–80% 之间，精度 0.01%')
  }
  if (opts.buyTaxBps <= 0 && opts.sellTaxBps <= 0) throw new Error('税率 Hook 至少一侧必须大于 0')

  const ensured = await ensureConfigurableTaxFactoryV2(opts)
  const { status } = ensured
  if (!status.implementation) throw new Error('无法读取税率 Hook 实现地址')

  opts.onStatus?.('本地计算专属 Hook 地址（不会产生 Gas）…')
  const mined = await mineDirectionalTaxHookSalt({
    factory: status.factory,
    implementation: status.implementation,
    creator: opts.owner,
  })
  const existingCode = await publicClient.getBytecode({ address: mined.hook })
  if (existingCode && existingCode !== '0x') throw new Error('专属 Hook 地址已占用，请重试')

  const { request, result: simulated } = await publicClient.simulateContract({
    account: opts.owner,
    address: status.factory,
    abi: configurableTaxFactoryV2Abi,
    functionName: 'createPool',
    args: [
      opts.currency0,
      opts.currency1,
      opts.lpFee,
      opts.tickSpacing,
      opts.sqrtPriceX96,
      opts.taxToken,
      opts.buyTaxBps,
      opts.sellTaxBps,
      mined.userSalt,
    ],
  })
  const simulatedHook = getAddress(simulated[0])
  const poolId = simulated[1]
  if (simulatedHook.toLowerCase() !== mined.hook.toLowerCase()) {
    throw new Error('模拟返回的 Hook 地址与本地预测不一致')
  }
  opts.onStatus?.(
    `请确认创建 V2 池 · LP fee ${(opts.lpFee / 10000).toFixed(2)}% · `
    + `买入税 ${opts.buyTaxBps / 100}% · 卖出税 ${opts.sellTaxBps / 100}%（永久冻结）…`,
  )
  const poolHash = await opts.walletClient.writeContract({
    ...request,
    chain: opts.walletClient.chain,
    account: opts.owner,
  })
  const submission: DirectionalTaxPoolSubmission = {
    factory: status.factory,
    hook: mined.hook,
    poolId,
    currency0: opts.currency0,
    currency1: opts.currency1,
    lpFee: opts.lpFee,
    tickSpacing: opts.tickSpacing,
    userSalt: mined.userSalt,
    factoryHash: ensured.hash,
    poolHash,
  }
  // 先交给 UI 保存。即使回执轮询或 config() 复检遇到 RPC 故障，用户仍能看到
  // PoolId、Hook 和交易哈希，不会因为误以为失败而重复建池。
  try {
    opts.onSubmitted?.(submission)
  } catch {
    // UI 本地存储不可用不应中断已经提交的链上交易；下面的状态仍会完整显示 PoolId。
  }
  opts.onStatus?.(`税率池已提交 ${poolHash.slice(0, 10)}… · PoolId ${poolId} · 等待确认`)
  await waitForHash(poolHash, '创建税率 Hook 池')

  let verificationWarning: string | undefined
  const cfg = await readConfigurableTaxHookV2AfterReceipt(
    mined.hook,
    status.implementation,
  ).catch(() => null)
  if (cfg) {
    if (cfg[0].toLowerCase() !== poolId.toLowerCase()) throw new Error(`Hook PoolId 校验失败：${poolId}`)
    if (cfg[1].toLowerCase() !== opts.owner.toLowerCase()) throw new Error(`Hook 收款地址校验失败 · PoolId ${poolId}`)
    if (cfg[2].toLowerCase() !== opts.taxToken.toLowerCase()) throw new Error(`Hook 项目币校验失败 · PoolId ${poolId}`)
    if (cfg[3] !== opts.lpFee || cfg[4] !== opts.buyTaxBps || cfg[5] !== opts.sellTaxBps) {
      throw new Error(`V2 Hook 费率配置校验失败 · PoolId ${poolId}`)
    }
  } else {
    verificationWarning = '建池交易已成功；公共 RPC 暂未同步 config()，已保留 PoolId 并继续加载'
    opts.onStatus?.(`${verificationWarning} · ${poolId}`)
  }

  return {
    ...submission,
    verificationWarning,
  }
}
