import type { Address, Hash } from 'viem'
import type { DlmmShape, DlmmSide } from './dlmm'
import type { PoolInfo, PositionRow } from './lp'

const STORAGE_KEY = 'rangedesk.dlmm.groups.v1'
const MAX_RECORDS = 120
const PENDING_VISIBLE_MS = 24 * 60 * 60 * 1000

export type DlmmGroupBandRecord = {
  tickLower: number
  tickUpper: number
  amount0?: string
  amount1?: string
  tokenId?: string
}

export type DlmmGroupRecord = {
  id: string
  chainId: number
  owner: Address
  version: 'v3' | 'v4'
  poolKey: string
  poolRef?: string
  pair: string
  fee: number
  tickSpacing: number
  side: DlmmSide
  shape: DlmmShape
  binCount: number
  gapBins: number
  createdAt: number
  txHash: Hash
  bands: DlmmGroupBandRecord[]
}

export type DlmmPositionGroup = {
  id: string
  source: 'saved' | 'detected'
  record?: DlmmGroupRecord
  poolKey: string
  version: 'v3' | 'v4'
  pair: string
  fee: number
  tickSpacing: number
  positions: PositionRow[]
  plannedBandCount: number
  missingBandCount: number
  state: 'pending' | 'active' | 'partial'
}

function normalizedOwner(owner: Address | string): string {
  return owner.toLowerCase()
}

function fallbackPoolKey(
  version: 'v3' | 'v4',
  token0: Address,
  token1: Address,
  fee: number,
  tickSpacing: number,
  hooks?: Address,
): string {
  const tokens = [token0.toLowerCase(), token1.toLowerCase()].sort()
  return `${version}:${tokens[0]}:${tokens[1]}:${fee}:${tickSpacing}:${(hooks ?? '0x0000000000000000000000000000000000000000').toLowerCase()}`
}

export function dlmmPoolKeyFromPool(pool: PoolInfo): string {
  if (pool.version === 'v3' && pool.poolAddress) return `v3:${pool.poolAddress.toLowerCase()}`
  if (pool.version === 'v4' && pool.poolId) return `v4:${pool.poolId.toLowerCase()}`
  return fallbackPoolKey(
    pool.version,
    pool.token0.address,
    pool.token1.address,
    pool.fee,
    pool.tickSpacing,
    pool.hooks,
  )
}

export function dlmmPoolKeyFromPosition(position: PositionRow): string {
  if (position.version === 'v3' && position.poolAddress) {
    return `v3:${position.poolAddress.toLowerCase()}`
  }
  if (position.version === 'v4' && position.poolId) return `v4:${position.poolId.toLowerCase()}`
  return fallbackPoolKey(
    position.version,
    position.token0.address,
    position.token1.address,
    position.fee,
    position.tickSpacing,
    position.hooks,
  )
}

export function createDlmmGroupRecord(input: {
  chainId: number
  owner: Address
  pool: PoolInfo
  side: DlmmSide
  shape: DlmmShape
  binCount: number
  gapBins: number
  txHash: Hash
  bands: Array<{
    tickLower: number
    tickUpper: number
    amount0: bigint
    amount1: bigint
  }>
}): DlmmGroupRecord {
  const { pool } = input
  return {
    id: `${input.chainId}:${pool.version}:${input.txHash.toLowerCase()}`,
    chainId: input.chainId,
    owner: input.owner,
    version: pool.version,
    poolKey: dlmmPoolKeyFromPool(pool),
    poolRef: pool.version === 'v3' ? pool.poolAddress : pool.poolId,
    pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    side: input.side,
    shape: input.shape,
    binCount: input.binCount,
    gapBins: input.gapBins,
    createdAt: Date.now(),
    txHash: input.txHash,
    bands: input.bands.map((band) => ({
      tickLower: band.tickLower,
      tickUpper: band.tickUpper,
      amount0: band.amount0.toString(),
      amount1: band.amount1.toString(),
    })),
  }
}

function validRecord(value: unknown): value is DlmmGroupRecord {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<DlmmGroupRecord>
  return Boolean(
    typeof row.id === 'string'
    && Number.isFinite(row.chainId)
    && typeof row.owner === 'string'
    && (row.version === 'v3' || row.version === 'v4')
    && typeof row.poolKey === 'string'
    && typeof row.txHash === 'string'
    && Array.isArray(row.bands)
    && row.bands.length >= 2,
  )
}

export function loadDlmmGroupRecords(): DlmmGroupRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter(validRecord).slice(0, MAX_RECORDS) : []
  } catch {
    return []
  }
}

export function saveDlmmGroupRecords(records: readonly DlmmGroupRecord[]): void {
  try {
    const trimmed = [...records]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_RECORDS)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    /* private mode / full storage: keep the live session usable */
  }
}

export function upsertDlmmGroupRecord(
  records: readonly DlmmGroupRecord[],
  next: DlmmGroupRecord,
): DlmmGroupRecord[] {
  const merged = [next, ...records.filter((record) => record.id !== next.id)]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_RECORDS)
  saveDlmmGroupRecords(merged)
  return merged
}

export function forgetDlmmGroupRecord(
  records: readonly DlmmGroupRecord[],
  id: string,
): DlmmGroupRecord[] {
  const next = records.filter((record) => record.id !== id)
  saveDlmmGroupRecords(next)
  return next
}

function positionId(position: PositionRow): string {
  return `${position.version}:${position.tokenId.toString()}`
}

function recordInScope(record: DlmmGroupRecord, chainId: number, owner: Address): boolean {
  return record.chainId === chainId && normalizedOwner(record.owner) === normalizedOwner(owner)
}

/**
 * Once a post-mint position refresh sees the exact planned ticks, pin the NFT ids.
 * Future groups may reuse the same price bands; pinned ids prevent an old record
 * from adopting the new NFTs after the old group has been closed.
 */
export function attachDlmmGroupTokenIds(
  records: readonly DlmmGroupRecord[],
  positions: readonly PositionRow[],
  chainId: number,
  owner: Address,
): DlmmGroupRecord[] {
  const scopedPositions = positions.filter((position) => position.tokenId > 0n)
  const reserved = new Set<string>()
  for (const record of records) {
    for (const band of record.bands) {
      if (band.tokenId) reserved.add(`${record.version}:${band.tokenId}`)
    }
  }

  let changed = false
  const next = records.map((record) => ({ ...record, bands: record.bands.map((band) => ({ ...band })) }))
  const pending = next
    .filter((record) => recordInScope(record, chainId, owner))
    .sort((a, b) => b.createdAt - a.createdAt)

  for (const record of pending) {
    for (const band of record.bands) {
      if (band.tokenId) continue
      const match = scopedPositions.find((position) => (
        position.version === record.version
        && dlmmPoolKeyFromPosition(position) === record.poolKey
        && position.tickLower === band.tickLower
        && position.tickUpper === band.tickUpper
        && !reserved.has(positionId(position))
      ))
      if (!match) continue
      band.tokenId = match.tokenId.toString()
      reserved.add(positionId(match))
      changed = true
    }
  }

  if (changed) saveDlmmGroupRecords(next)
  return changed ? next : [...records]
}

function exactBandMatch(
  record: DlmmGroupRecord,
  positions: readonly PositionRow[],
): PositionRow[] {
  const found: PositionRow[] = []
  const used = new Set<string>()
  for (const band of record.bands) {
    const match = positions.find((position) => {
      if (position.version !== record.version || dlmmPoolKeyFromPosition(position) !== record.poolKey) return false
      if (band.tokenId && position.tokenId.toString() !== band.tokenId) return false
      if (!band.tokenId && (position.tickLower !== band.tickLower || position.tickUpper !== band.tickUpper)) return false
      return !used.has(positionId(position))
    })
    if (!match) continue
    used.add(positionId(match))
    found.push(match)
  }
  return found.sort((a, b) => a.tickLower - b.tickLower)
}

function detectedGroups(
  positions: readonly PositionRow[],
  excluded: ReadonlySet<string>,
): DlmmPositionGroup[] {
  const byPool = new Map<string, PositionRow[]>()
  for (const position of positions) {
    if (position.tokenId <= 0n || excluded.has(positionId(position))) continue
    const key = dlmmPoolKeyFromPosition(position)
    const rows = byPool.get(key) ?? []
    rows.push(position)
    byPool.set(key, rows)
  }

  const groups: DlmmPositionGroup[] = []
  for (const [poolKey, poolPositions] of byPool) {
    const sorted = [...poolPositions].sort((a, b) => a.tickLower - b.tickLower || a.tickUpper - b.tickUpper)
    let sequence: PositionRow[] = []
    const flush = () => {
      if (sequence.length < 2) {
        sequence = []
        return
      }
      const first = sequence[0]!
      const last = sequence[sequence.length - 1]!
      groups.push({
        id: `detected:${poolKey}:${first.tickLower}:${last.tickUpper}`,
        source: 'detected',
        poolKey,
        version: first.version,
        pair: `${first.token0.symbol}/${first.token1.symbol}`,
        fee: first.fee,
        tickSpacing: first.tickSpacing,
        positions: sequence,
        plannedBandCount: sequence.length,
        missingBandCount: 0,
        state: 'active',
      })
      sequence = []
    }

    for (const position of sorted) {
      const previous = sequence[sequence.length - 1]
      if (!previous || previous.tickUpper === position.tickLower) {
        sequence.push(position)
      } else {
        flush()
        sequence.push(position)
      }
    }
    flush()
  }
  return groups
}

export function resolveDlmmPositionGroups(
  records: readonly DlmmGroupRecord[],
  positions: readonly PositionRow[],
  chainId: number,
  owner: Address | null,
  now = Date.now(),
): DlmmPositionGroup[] {
  if (!owner) return []
  const used = new Set<string>()
  const groups: DlmmPositionGroup[] = []

  for (const record of records.filter((row) => recordInScope(row, chainId, owner))) {
    const matched = exactBandMatch(record, positions)
    for (const position of matched) used.add(positionId(position))
    const pinnedCount = record.bands.filter((band) => Boolean(band.tokenId)).length
    if (matched.length === 0 && (pinnedCount > 0 || now - record.createdAt > PENDING_VISIBLE_MS)) {
      continue
    }
    const missing = Math.max(0, record.bands.length - matched.length)
    groups.push({
      id: record.id,
      source: 'saved',
      record,
      poolKey: record.poolKey,
      version: record.version,
      pair: record.pair,
      fee: record.fee,
      tickSpacing: record.tickSpacing,
      positions: matched,
      plannedBandCount: record.bands.length,
      missingBandCount: missing,
      state: matched.length === 0 ? 'pending' : missing > 0 ? 'partial' : 'active',
    })
  }

  groups.push(...detectedGroups(positions, used))
  return groups.sort((a, b) => {
    if (a.state === 'pending' && b.state !== 'pending') return 1
    if (b.state === 'pending' && a.state !== 'pending') return -1
    const valueA = a.positions.reduce((sum, position) => sum + position.totalUsd, 0)
    const valueB = b.positions.reduce((sum, position) => sum + position.totalUsd, 0)
    return valueB - valueA
  })
}
