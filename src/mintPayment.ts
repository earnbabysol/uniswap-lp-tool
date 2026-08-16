export type BalanceReadStatus = 'idle' | 'loading' | 'ready' | 'error'

export type WrappedPoolPayment = 'native' | 'wrapped'

type ChooseWrappedPoolPaymentArgs = {
  nativeBalance: bigint
  wrappedBalance: bigint
  nativeStatus: BalanceReadStatus
  wrappedStatus: BalanceReadStatus
  gasReserve: bigint
}

/**
 * WETH/WBNB 池的默认支付资产。
 *
 * 等两边读取结束再决定，避免原生余额先返回 0 时把仍在加载的 WETH 隐藏掉。
 * 两边都有余额时优先原生币，保留一键自动 Wrap；原生币不够预留 gas 时优先
 * 使用钱包已有的包装币。
 */
export function chooseWrappedPoolPayment({
  nativeBalance,
  wrappedBalance,
  nativeStatus,
  wrappedStatus,
  gasReserve,
}: ChooseWrappedPoolPaymentArgs): WrappedPoolPayment | null {
  const nativeDone = nativeStatus === 'ready' || nativeStatus === 'error'
  const wrappedDone = wrappedStatus === 'ready' || wrappedStatus === 'error'
  if (!nativeDone || !wrappedDone) return null

  if (nativeStatus === 'ready' && nativeBalance > gasReserve) return 'native'
  if (wrappedStatus === 'ready' && wrappedBalance > 0n) return 'wrapped'

  // 两边都是 0 时仍默认原生币：用户转入 ETH 后可以直接建仓，无需先 Wrap。
  if (nativeStatus === 'ready') return 'native'
  if (wrappedStatus === 'ready') return 'wrapped'
  return null
}
