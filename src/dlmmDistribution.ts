import type { DlmmShape } from './dlmm'

export function dlmmShapeWeight(
  shape: DlmmShape,
  distanceFromSpot: number,
  maxDistance: number,
): number {
  const scale = 1_000_000
  const floor = 20_000
  const distance = Math.max(0, Number.isFinite(distanceFromSpot) ? distanceFromSpot : 0)
  const edge = Math.max(1, Number.isFinite(maxDistance) ? maxDistance : 1)

  if (shape === 'spot') return scale
  if (shape === 'curve') {
    // Delta-style linear curve: closest-to-market bands receive the most,
    // while even the furthest band keeps a small non-zero allocation.
    return Math.max(floor, Math.round(scale * (1 - distance / (edge + 1))))
  }
  // Bid-Ask is the inverse linear curve: the two outer edges receive more.
  return Math.max(floor, Math.round(scale * (distance / edge)))
}

/** Proportional bigint allocation with no lost remainder. */
export function distributeIntegerAmount(total: bigint, weights: readonly number[]): bigint[] {
  if (total <= 0n || weights.length === 0) return weights.map(() => 0n)
  const safeWeights = weights.map((weight) => (
    Number.isFinite(weight) && weight > 0 ? BigInt(Math.floor(weight)) : 0n
  ))
  const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0n)
  if (totalWeight <= 0n) return weights.map(() => 0n)
  let cumulativeWeight = 0n
  let allocated = 0n
  return safeWeights.map((weight, index) => {
    cumulativeWeight += weight
    const cumulativeAmount = index === safeWeights.length - 1
      ? total
      : (total * cumulativeWeight) / totalWeight
    const amount = cumulativeAmount - allocated
    allocated = cumulativeAmount
    return amount
  })
}
