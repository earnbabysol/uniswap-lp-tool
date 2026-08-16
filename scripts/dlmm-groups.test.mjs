import assert from 'node:assert/strict'
import {
  attachDlmmGroupTokenIds,
  resolveDlmmPositionGroups,
} from '../src/dlmmGroups.ts'

const owner = '0x1111111111111111111111111111111111111111'
const pool = '0x2222222222222222222222222222222222222222'
const token0 = { address: '0x3333333333333333333333333333333333333333', symbol: 'COIN', decimals: 18 }
const token1 = { address: '0x4444444444444444444444444444444444444444', symbol: 'USDC', decimals: 6 }

function position(id, tickLower, tickUpper, poolAddress = pool) {
  return {
    version: 'v3',
    tokenId: BigInt(id),
    poolAddress,
    token0,
    token1,
    fee: 3000,
    tickSpacing: 60,
    tickLower,
    tickUpper,
    totalUsd: id,
  }
}

function record(id = 'group:1') {
  return {
    id,
    chainId: 56,
    owner,
    version: 'v3',
    poolKey: `v3:${pool}`,
    poolRef: pool,
    pair: 'COIN/USDC',
    fee: 3000,
    tickSpacing: 60,
    side: 'bid',
    shape: 'bid-ask',
    binCount: 6,
    gapBins: 0,
    createdAt: Date.now(),
    txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    bands: [
      { tickLower: 0, tickUpper: 120 },
      { tickLower: 120, tickUpper: 240 },
      { tickLower: 240, tickUpper: 360 },
    ],
  }
}

const positions = [position(10, 0, 120), position(11, 120, 240), position(12, 240, 360)]
const attached = attachDlmmGroupTokenIds([record()], positions, 56, owner)
assert.deepEqual(attached[0].bands.map((band) => band.tokenId), ['10', '11', '12'])

const saved = resolveDlmmPositionGroups(attached, positions, 56, owner)
assert.equal(saved.length, 1)
assert.equal(saved[0].source, 'saved')
assert.equal(saved[0].state, 'active')
assert.equal(saved[0].positions.length, 3)

const inferred = resolveDlmmPositionGroups([], positions, 56, owner)
assert.equal(inferred.length, 1)
assert.equal(inferred[0].source, 'detected')
assert.deepEqual(inferred[0].positions.map((row) => row.tokenId), [10n, 11n, 12n])

const broken = resolveDlmmPositionGroups(
  [],
  [position(20, 0, 120), position(21, 180, 300)],
  56,
  owner,
)
assert.equal(broken.length, 0)

const closed = resolveDlmmPositionGroups(attached, [], 56, owner)
assert.equal(closed.length, 0, 'pinned records disappear after every NFT is gone')

console.log('dlmm group tests passed')
