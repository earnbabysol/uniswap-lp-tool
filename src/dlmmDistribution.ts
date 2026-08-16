import type { DlmmShape } from './dlmm'

export function dlmmShapeWeight(
  shape: DlmmShape,
  distanceFromSpot: number,
  count: number,
): number {
  if (shape === 'spot') return 1
  if (shape === 'curve') {
    const near = count - distanceFromSpot
    return near * near
  }
  const far = distanceFromSpot + 1
  return far * far
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
