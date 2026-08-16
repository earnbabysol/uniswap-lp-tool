export type FlowPoolSelectable = {
  chainId: 56 | 4663
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
  chainIds: Array<56 | 4663>,
  maxPools: number,
): T[] {
  if (maxPools <= 0 || events.length === 0) return []
  const groups = new Map<string, {
    key: string
    chainId: 56 | 4663
    latest: number
    totalUsd: number
    events: T[]
  }>()
  for (const event of events) {
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
    return events.slice().sort((a, b) => b.timestamp - a.timestamp)
  }

  const wantsBoth = chainIds.includes(56) && chainIds.includes(4663)
  const quota = wantsBoth ? Math.floor(maxPools / 2) : maxPools
  const selectedKeys = new Set<string>()
  const counts: Record<56 | 4663, number> = { 56: 0, 4663: 0 }
  for (const group of ranked) {
    if (selectedKeys.size >= maxPools) break
    if (counts[group.chainId] >= quota) continue
    selectedKeys.add(group.key)
    counts[group.chainId] += 1
  }
  for (const group of ranked) {
    if (selectedKeys.size >= maxPools) break
    selectedKeys.add(group.key)
  }
  return ranked
    .filter((group) => selectedKeys.has(group.key))
    .flatMap((group) => group.events)
    .sort((a, b) => b.timestamp - a.timestamp)
}
