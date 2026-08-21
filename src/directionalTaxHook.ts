import {
  concatHex,
  encodeDeployData,
  getAddress,
  getCreate2Address,
  keccak256,
  padHex,
  stringToHex,
  toHex,
  type Address,
  type Hash,
  type Hex,
  type WalletClient,
} from 'viem'
import { CONTRACTS, getActiveChainId, type SupportedChainId } from './chain'
import { withTimeout } from './async'
import { publicClient } from './wallet'
import { DIRECTIONAL_TAX_FACTORY_BYTECODE } from './generated/directionalTaxFactoryBytecode'

export const DIRECTIONAL_TAX_CHAIN_IDS = [1, 56, 4663, 8453] as const
export const DIRECTIONAL_TAX_PRESETS_BPS = [0, 100, 300, 500, 1000, 2000, 3000, 5000, 8000] as const

export const DIRECTIONAL_TAX_CREATE2_PROXY = getAddress(
  '0x4e59b44847b379578588920cA78FbF26c0B4956C',
)
export const DIRECTIONAL_TAX_FACTORY_SALT = keccak256(
  stringToHex('RangeDesk DirectionalTaxHookFactory v1'),
)
export const DIRECTIONAL_TAX_REQUIRED_FLAGS = 0x2044n
export const DIRECTIONAL_TAX_ALL_FLAGS_MASK = 0x3fffn

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

export type DirectionalTaxFactoryStatus = {
  supported: boolean
  factory: Address
  deployed: boolean
  implementation?: Address
  reason?: string
}

export type DirectionalTaxPoolDeployment = {
  factory: Address
  hook: Address
  userSalt: Hex
  factoryHash?: Hash
  poolHash: Hash
}

export type DirectionalTaxHookConfig = {
  poolId: Hex
  collector: Address
  taxToken: Address
  buyTaxBps: number
  sellTaxBps: number
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

/** Recognize only an exact clone produced by this app's deterministic factory. */
export async function readDirectionalTaxHookConfig(
  hook: Address,
): Promise<DirectionalTaxHookConfig | null> {
  if (!supportsDirectionalTax()) return null
  try {
    const status = await getDirectionalTaxFactoryStatus()
    if (!status.deployed || !status.implementation) return null
    const code = await publicClient.getBytecode({ address: hook })
    if (!code || code.toLowerCase() !== cloneRuntimeCode(status.implementation).toLowerCase()) return null
    const cfg = await publicClient.readContract({
      address: hook,
      abi: directionalTaxHookAbi,
      functionName: 'config',
    })
    if (!cfg[5]) return null
    return {
      poolId: cfg[0],
      collector: cfg[1],
      taxToken: cfg[2],
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
  status = await getDirectionalTaxFactoryStatus()
  if (!status.deployed || !status.implementation) throw new Error('Hook 工厂部署后校验失败')
  return { status, hash }
}

export async function createDirectionalTaxPool(opts: {
  walletClient: WalletClient
  owner: Address
  currency0: Address
  currency1: Address
  tickSpacing: number
  sqrtPriceX96: bigint
  taxToken: Address
  buyTaxBps: number
  sellTaxBps: number
  onStatus?: (message: string) => void
}): Promise<DirectionalTaxPoolDeployment> {
  if (!isDirectionalTaxPreset(opts.buyTaxBps) || !isDirectionalTaxPreset(opts.sellTaxBps)) {
    throw new Error('税率必须使用预设档位')
  }
  if (opts.buyTaxBps <= 0 && opts.sellTaxBps <= 0) throw new Error('税率 Hook 至少一侧必须大于 0')

  const ensured = await ensureDirectionalTaxFactory(opts)
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

  const { request } = await publicClient.simulateContract({
    account: opts.owner,
    address: status.factory,
    abi: directionalTaxFactoryAbi,
    functionName: 'createPool',
    args: [
      opts.currency0,
      opts.currency1,
      opts.tickSpacing,
      opts.sqrtPriceX96,
      opts.taxToken,
      opts.buyTaxBps,
      opts.sellTaxBps,
      mined.userSalt,
    ],
  })
  opts.onStatus?.(
    `请确认创建 0% LP 费率池 · 买卖税 ${Math.max(opts.buyTaxBps, opts.sellTaxBps) / 100}%（永久冻结）…`,
  )
  const poolHash = await opts.walletClient.writeContract({
    ...request,
    chain: opts.walletClient.chain,
    account: opts.owner,
  })
  opts.onStatus?.(`税率池已提交 ${poolHash.slice(0, 10)}…，等待确认`)
  await waitForHash(poolHash, '创建税率 Hook 池')

  const [hookCode, cfg] = await Promise.all([
    publicClient.getBytecode({ address: mined.hook }),
    publicClient.readContract({
      address: mined.hook,
      abi: directionalTaxHookAbi,
      functionName: 'config',
    }),
  ])
  if (!hookCode || hookCode === '0x' || !cfg[5]) throw new Error('池已上链但 Hook 配置校验失败')
  if (cfg[1].toLowerCase() !== opts.owner.toLowerCase()) throw new Error('Hook 收款地址校验失败')

  return {
    factory: status.factory,
    hook: mined.hook,
    userSalt: mined.userSalt,
    factoryHash: ensured.hash,
    poolHash,
  }
}
