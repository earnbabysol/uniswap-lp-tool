export type FlowSelectableChainId = 56 | 4663 | 8453

export type FlowPoolSelectable = {
  chainId: FlowSelectableChainId
  version: 'v3' | 'v4'
  poolAddress: string
  poolId?: string
  timestamp: number
  amountUsd: number
}

function selectablePoolRef(event: FlowPoolSelectable): string {
  return event.version === 'v4' && event.poolId ? event.poolId : event.poolAddress
}

/** Keep a pool quota without discarding the other events needed to calculate net flow. */
export function takeFlowPoolEvents<T extends FlowPoolSelectable>(
  events: T[],
  chainIds: FlowSelectableChainId[],
  maxPools: number,
): T[] {
  if (maxPools <= 0 || events.length === 0) return []
  const selectedChains = [...new Set(chainIds)]
  if (selectedChains.length === 0) return []
  const selectedChainSet = new Set(selectedChains)
  const eligibleEvents = events.filter((event) => selectedChainSet.has(event.chainId))
  if (eligibleEvents.length === 0) return []
  const groups = new Map<string, {
    key: string
    chainId: FlowSelectableChainId
    latest: number
    totalUsd: number
    events: T[]
  }>()
  for (const event of eligibleEvents) {
    const key = `${event.chainId}:${event.version}:${selectablePoolRef(event).toLowerCase()}`
    const group = groups.get(key)
    if (group) {
      group.events.push(event)
      group.latest = Math.max(group.latest, event.timestamp)
      group.totalUsd += event.amountUsd
    } else {
      groups.set(key, {
        key,
        chainId: event.chainId,
        latest: event.timestamp,
        totalUsd: event.amountUsd,
        events: [event],
      })
    }
  }
  const ranked = [...groups.values()].sort((a, b) =>
    b.latest - a.latest || b.totalUsd - a.totalUsd || a.key.localeCompare(b.key))
  if (ranked.length <= maxPools) {
    return eligibleEvents.slice().sort((a, b) => b.timestamp - a.timestamp)
  }

  const quota = selectedChains.length > 1
    ? Math.max(1, Math.floor(maxPools / selectedChains.length))
    : maxPools
  const selectedKeys = new Set<string>()
  const counts = new Map<FlowSelectableChainId, number>(
    selectedChains.map((chainId) => [chainId, 0]),
  )
  for (const group of ranked) {
    if (selectedKeys.size >= maxPools) break
    if (!selectedChainSet.has(group.chainId)) continue
    if ((counts.get(group.chainId) ?? 0) >= quota) continue
    selectedKeys.add(group.key)
    counts.set(group.chainId, (counts.get(group.chainId) ?? 0) + 1)
  }
  for (const group of ranked) {
    if (selectedKeys.size >= maxPools) break
    if (!selectedChainSet.has(group.chainId)) continue
    selectedKeys.add(group.key)
  }
  return ranked
    .filter((group) => selectedKeys.has(group.key))
    .flatMap((group) => group.events)
    .sort((a, b) => b.timestamp - a.timestamp)
}
