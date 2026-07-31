/** 代币兼容性预检：Flap / 拦截 PoolManager 的 meme，避免弹钱包后才失败。 */
import { erc20Abi, parseAbi, zeroAddress, type Address } from 'viem'
import { CONTRACTS } from './chain'
import { withTimeout } from './async'
import { publicClient } from './wallet'

const flapProbeAbi = parseAbi([
  'function flapV4Hook() view returns (address)',
  'function mainPool() view returns (address)',
  'function taxProcessor() view returns (address)',
])

function isSkipToken(token: Address) {
  const t = token.toLowerCase()
  return t === zeroAddress || t === CONTRACTS.weth.toLowerCase()
}

/**
 * Flap TokenV3（后缀常为 …8888/…7777）：流动性由发射台 migrator + hook 注入，
 * 合约硬编码 DirectPoolManagerTransferBlocked，标准 Uni V3 NPM / V4 PM mint 都会失败。
 */
export async function assertNotFlapLaunchpadToken(token: Address) {
  if (isSkipToken(token)) return
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
    if (!hook || hook === zeroAddress) return

    let mainPool = ''
    try {
      mainPool = await publicClient.readContract({
        address: token,
        abi: flapProbeAbi,
        functionName: 'mainPool',
      })
    } catch {
      /* ignore */
    }

    throw new Error(
      `这是 Flap 发射台代币（flapV4Hook=${hook.slice(0, 10)}…），` +
        `合约禁止普通钱包直接往 Uniswap V3/V4 PositionManager 注资` +
        `（含 DirectPoolManagerTransferBlocked）。` +
        `你看到的「有人组成功」是 Flap 毕业 migrator 注入主池` +
        (mainPool && mainPool !== zeroAddress ? `（mainPool ${mainPool.slice(0, 10)}…）` : '') +
        `，不是本工具的标准 Mint。` +
        `本工具无法绕过该合约限制；请在 Flap / 其主池路径操作，或换普通 ERC-20。`,
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('Flap 发射台')) throw e instanceof Error ? e : new Error(msg)
    // 无 flapV4Hook / RPC 失败：不拦
  }
}

/** V3/V4 建仓前：两边代币都过一遍 Flap 检测。 */
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
    if (msg.includes('Flap 发射台')) throw e instanceof Error ? e : new Error(msg)
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
