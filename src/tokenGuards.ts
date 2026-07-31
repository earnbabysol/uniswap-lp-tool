/**
 * 代币兼容性预检。
 *
 * 注意：Flap 税币的买卖税通常只作用于 `pools[addr]==true` 的主池/登记池，
 * 不是「任意 V3 都不能 mint」。用户已在 Uniswap UI 上对未登记池成功组仓，
 * 因此 V3 路径不得因 taxProcessor/税率一刀切拦截。
 */
import { erc20Abi, parseAbi, zeroAddress, type Address } from 'viem'
import { CONTRACTS } from './chain'
import { withTimeout } from './async'
import { publicClient } from './wallet'

const flapProbeAbi = parseAbi([
  'function flapV4Hook() view returns (address)',
  'function pools(address) view returns (bool)',
])

function isSkipToken(token: Address) {
  const t = token.toLowerCase()
  return t === zeroAddress || t === CONTRACTS.weth.toLowerCase()
}

/**
 * 仅拦截带 flapV4Hook、禁止直转 PoolManager 的 Flap TokenV3（…8888 一类）。
 * 税币（…7777）不在这里拦——V3 能否 mint 取决于目标池是否被登记进 token.pools。
 */
export async function assertNotFlapV4HookToken(token: Address) {
  if (isSkipToken(token)) return
  try {
    const hook = await withTimeout(
      publicClient.readContract({
        address: token,
        abi: flapProbeAbi,
        functionName: 'flapV4Hook',
      }),
      8_000,
      '检测 Flap hook',
    )
    if (!hook || hook === zeroAddress) return
    throw new Error(
      `这是带 flapV4Hook 的 Flap 代币（${hook.slice(0, 10)}…），` +
        `合约禁止普通路径往 V4 PoolManager 注资（DirectPoolManagerTransferBlocked）。` +
        `请改用 V3（选未被该币登记为税池的交易对），或在 Flap 主池路径操作。`,
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('flapV4Hook')) throw e instanceof Error ? e : new Error(msg)
  }
}

/**
 * Flap 税币若把某 V3 池登记进 `pools[]`，转入该池会走卖税，标准 V3 mint 常 revert（如 M1/STF）。
 * 未登记的池（例如用户手组的 USDT 对）可以正常 mint——与 Uniswap 官方 UI 一致。
 */
export async function assertV3PoolNotFlapTaxed(token: Address, poolAddress: Address | undefined) {
  if (isSkipToken(token) || !poolAddress) return
  try {
    const taxed = await withTimeout(
      publicClient.readContract({
        address: token,
        abi: flapProbeAbi,
        functionName: 'pools',
        args: [poolAddress],
      }),
      8_000,
      '检测 Flap 税池',
    )
    if (!taxed) return
    throw new Error(
      `该代币已把池 ${poolAddress.slice(0, 10)}… 登记为 Flap 税池（pools=true），` +
        `往此池转入会抽卖税，Uniswap V3 标准 Mint 会失败。` +
        `请换未被登记的交易对（例如用 USDT 而不是已登记的 WBNB 池），或在 Flap/V2 主池操作。`,
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('登记为 Flap 税池')) throw e instanceof Error ? e : new Error(msg)
    // 无 pools() / RPC 失败：不拦
  }
}

/** V3 建仓前：两边代币检查目标池是否被 Flap 登记为税池。 */
export async function assertTokensAllowV3Mint(
  tokens: Address[],
  poolAddress: Address | undefined,
  onStatus?: (msg: string) => void,
) {
  onStatus?.('检测目标池是否被标记为税池…')
  for (const t of tokens) {
    await assertV3PoolNotFlapTaxed(t, poolAddress)
  }
}

/**
 * V4 settle 必须能把 ERC20 转入 PoolManager。
 */
export async function assertTokenAllowsV4PoolManager(owner: Address, token: Address) {
  if (isSkipToken(token)) return
  await assertNotFlapV4HookToken(token)

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
    if (msg.includes('flapV4Hook')) throw e instanceof Error ? e : new Error(msg)
    if (/超时|timeout|network|fetch/i.test(msg)) return
    throw new Error(
      `该代币禁止转入 Uniswap V4 PoolManager（${CONTRACTS.v4PoolManager.slice(0, 10)}…），` +
        `标准 V4 建池/加仓会失败。可改试 V3。` +
        `（钱包里的「授权/余额不足」多半是这个原因。）`,
    )
  }
}

export async function assertCurrenciesAllowV4(owner: Address, currency0: Address, currency1: Address) {
  await assertTokenAllowsV4PoolManager(owner, currency0)
  await assertTokenAllowsV4PoolManager(owner, currency1)
}
