import assert from 'node:assert/strict'
import { setActiveChainId } from '../src/chain.ts'
import {
  coinPriceToUsdPrice,
  getCoinQuote,
  ticksFromUsdPrices,
  usdPriceToCoinPrice,
} from '../src/lp.ts'
import { priceToClosestTick, priceToSqrtPriceX96 } from '../src/math.ts'

setActiveChainId(4663)

const quoteUsd = 1_935.9
const coinPerEth = 1 / 0.06729
const token0 = {
  address: '0x0000000000000000000000000000000000000000',
  symbol: 'ETH',
  decimals: 18,
}
const token1 = {
  address: '0x43B07D15cE533bEc5476d70C22a78a1B2B662155',
  symbol: 'MRNA',
  decimals: 18,
}
const pool = {
  version: 'v4',
  poolId: '0x32be53c0e86965275e39cdd3083c62e290af4e3835673a725305e9034ff5e06b',
  token0,
  token1,
  fee: 500,
  tickSpacing: 10,
  tick: priceToClosestTick(coinPerEth, token0.decimals, token1.decimals),
  sqrtPriceX96: priceToSqrtPriceX96(coinPerEth, token0.decimals, token1.decimals),
  price: coinPerEth,
  liquidity: 1n,
}

const quote = getCoinQuote(pool)
assert.equal(quote.coin.symbol, 'MRNA')
assert.equal(quote.quote.symbol, 'ETH')
assert.ok(Math.abs(coinPriceToUsdPrice(quote.spot, quoteUsd) - 130.266711) < 1e-6)
assert.ok(Math.abs(usdPriceToCoinPrice(130.26, quoteUsd) - 0.06728653339532) < 1e-12)

const range = ticksFromUsdPrices(pool, 120, 140, quoteUsd)
assert.ok(range.tickLower < range.tickUpper)
assert.ok(Math.abs(coinPriceToUsdPrice(range.coinPriceLower, quoteUsd) - 120) / 120 < 0.002)
assert.ok(Math.abs(coinPriceToUsdPrice(range.coinPriceUpper, quoteUsd) - 140) / 140 < 0.002)

console.log('USD range conversion tests passed')
