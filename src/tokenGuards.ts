/** 代币兼容性预检：Flap / 税币 / 拦截 PoolManager，避免弹钱包后才失败。 */
import { erc20Abi, parseAbi, zeroAddress, type Address } from 'viem'
import { CONTRACTS } from './chain'
import { withTimeout } from './async'
import { publicClient } from './wallet'

const flapProbeAbi = parseAbi([
  'function flapV4Hook() view returns (address)',
  'function mainPool() view returns (address)',
  'function taxProcessor() view returns (address)',
  'function buyTaxRate() view returns (uint16)',
  'function sellTaxRate() view returns (uint16)',
  'function taxRate() view returns (uint16)',
])

function isSkipToken(token: Address) {
  const t = token.toLowerCase()
  return t === zeroAddress || t === CONTRACTS.weth.toLowerCase()
}

async function readMainPool(token: Address): Promise<Address | null> {
  try {
    const mainPool = await publicClient.readContract({
      address: token,
      abi: flapProbeAbi,
      functionName: 'mainPool',
    })
    return mainPool && mainPool !== zeroAddress ? mainPool : null
  } catch {
    return null
  }
}

function flapLpBlockedMessage(kind: string, detail: string, mainPool: Address | null) {
  return (
    `这是 Flap ${kind}（${detail}）。` +
    `Flap 税币/发射台币的流动性由毕业 migrator 注入主池` +
    (mainPool ? `（V2 mainPool ${mainPool.slice(0, 10)}…）` : '') +
    `，Uniswap 官方 V3/V4 标准 Mint 不支持转账抽税。` +
    `本工具无法绕过；请在 Flap / Pancake V2 主池路径操作，或换 0 税普通 ERC-20。`
  )
}

/**
 * Flap 非税 TokenV3（常 …8888）：可能带 flapV4Hook，禁止直转 PoolManager。
 * Flap 税币 TaxTokenV3（常 …7777）：有 taxProcessor + buy/sell tax，官方只迁 V2。
 */
export async function assertNotFlapLaunchpadToken(token: Address) {
  if (isSkipToken(token)) return

  // 1) 带 V4 hook 的 Flap TokenV3
  try {
    const hook = await withTimeout(
      publicClient.readContract({
        address: token,
        abi: flapProbeAbi,
        functionName: 'flapV4Hook',
      }),
      8_000,
      '检测 Flap',
    )
    if (hook && hook !== zeroAddress) {
      throw new Error(
        flapLpBlockedMessage(
          '发射台代币',
          `flapV4Hook=${hook.slice(0, 10)}…`,
          await readMainPool(token),
        ),
      )
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('Flap ')) throw e instanceof Error ? e : new Error(msg)
  }

  // 2) FlapTaxTokenV3：taxProcessor + 非零税率
  try {
    const taxProcessor = await withTimeout(
      publicClient.readContract({
        address: token,
        abi: flapProbeAbi,
        functionName: 'taxProcessor',
      }),
      8_000,
      '检测税币',
    )
    if (!taxProcessor || taxProcessor === zeroAddress) return

    let buy = 0
    let sell = 0
    let flat = 0
    try {
      buy = Number(
        await publicClient.readContract({
          address: token,
          abi: flapProbeAbi,
          functionName: 'buyTaxRate',
        }),
      )
    } catch {
      /* older */
    }
    try {
      sell = Number(
        await publicClient.readContract({
          address: token,
          abi: flapProbeAbi,
          functionName: 'sellTaxRate',
        }),
      )
    } catch {
      /* older */
    }
    try {
      flat = Number(
        await publicClient.readContract({
          address: token,
          abi: flapProbeAbi,
          functionName: 'taxRate',
        }),
      )
    } catch {
      /* ignore */
    }

    if (buy > 0 || sell > 0 || flat > 0) {
      throw new Error(
        flapLpBlockedMessage(
          '税币',
          `买税 ${(buy / 100).toFixed(2)}% / 卖税 ${(Math.max(sell, flat) / 100).toFixed(2)}%`,
          await readMainPool(token),
        ),
      )
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('Flap ')) throw e instanceof Error ? e : new Error(msg)
    // 无 taxProcessor / RPC 失败：不拦
  }
}

/** V3/V4 建仓前：两边代币都过一遍 Flap / 税币检测。 */
export async function assertTokensAllowStandardLp(tokens: Address[], onStatus?: (msg: string) => void) {
  onStatus?.('检测代币是否支持标准加池…')
  for (const t of tokens) {
    await assertNotFlapLaunchpadToken(t)
  }
}

/**
 * V4 settle 必须能把 ERC20 转入 PoolManager。
 * 部分 meme（含非 Flap）会黑名单 PoolManager，钱包常误报「授权/余额不足」。
 */
export async function assertTokenAllowsV4PoolManager(owner: Address, token: Address) {
  if (isSkipToken(token)) return
  await assertNotFlapLaunchpadToken(token)

  const dust = 1n
  try {
    const bal = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    })
    if (bal < dust) return
    await withTimeout(
      publicClient.simulateContract({
        address: token,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [CONTRACTS.v4PoolManager, dust],
        account: owner,
      }),
      12_000,
      '检测 V4 兼容性',
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('Flap ')) throw e instanceof Error ? e : new Error(msg)
    if (/超时|timeout|network|fetch/i.test(msg)) return
    throw new Error(
      `该代币禁止转入 Uniswap V4 PoolManager（${CONTRACTS.v4PoolManager.slice(0, 10)}…），` +
        `标准 V4 建池/加仓会失败。` +
        `若也不是普通 ERC-20，V3 同样可能失败。` +
        `（钱包里的「授权/余额不足」多半是这个原因。）`,
    )
  }
}

export async function assertCurrenciesAllowV4(owner: Address, currency0: Address, currency1: Address) {
  await assertTokenAllowsV4PoolManager(owner, currency0)
  await assertTokenAllowsV4PoolManager(owner, currency1)
}
