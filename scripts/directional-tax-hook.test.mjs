import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DIRECTIONAL_TAX_MAX_BPS,
  DIRECTIONAL_TAX_PRESETS_BPS,
  DIRECTIONAL_TAX_REQUIRED_FLAGS,
  configurableTaxFactoryV2Address,
  configurableTaxFactoryV2InitCode,
  directionalTaxFactoryAddress,
  directionalTaxFactoryInitCode,
  hasDirectionalTaxHookFlags,
  isDirectionalTaxPreset,
  mineDirectionalTaxHookSalt,
  predictDirectionalTaxHook,
} from '../src/directionalTaxHook.ts'
import { CHAIN_CONFIGS } from '../src/chain.ts'
import { recoverV4PoolKeyFromCandidates, v4PoolId } from '../src/lp.ts'
import { zeroAddress } from 'viem'

const manager = '0x498581fF718922c3f8e6A244956aF099B2652b2b'
const factory = directionalTaxFactoryAddress(manager)
const initCode = directionalTaxFactoryInitCode(manager)
const factoryV2 = configurableTaxFactoryV2Address(manager)
const initCodeV2 = configurableTaxFactoryV2InitCode(manager)
assert.match(initCode, /^0x[0-9a-f]+$/i)
assert.ok(initCode.length > 10_000, 'factory creation bytecode should be embedded')
assert.match(factory, /^0x[0-9a-fA-F]{40}$/)
assert.match(initCodeV2, /^0x[0-9a-f]+$/i)
assert.ok(initCodeV2.length > 10_000, 'v2 factory creation bytecode should be embedded')
assert.match(factoryV2, /^0x[0-9a-fA-F]{40}$/)
assert.notEqual(factoryV2, factory, 'v2 must not replace the v1 deterministic factory')

const contractReadme = readFileSync(new URL('../contracts/README.md', import.meta.url), 'utf8')
for (const chainId of [1, 56, 4663, 8453]) {
  const predicted = directionalTaxFactoryAddress(CHAIN_CONFIGS[chainId].contracts.v4PoolManager)
  const predictedV2 = configurableTaxFactoryV2Address(CHAIN_CONFIGS[chainId].contracts.v4PoolManager)
  assert.ok(contractReadme.includes(predicted), `README must list chain ${chainId} v1 factory ${predicted}`)
  assert.ok(contractReadme.includes(predictedV2), `README must list chain ${chainId} v2 factory ${predictedV2}`)
}

assert.equal(DIRECTIONAL_TAX_MAX_BPS, 8_000)

for (const bps of DIRECTIONAL_TAX_PRESETS_BPS) assert.equal(isDirectionalTaxPreset(bps), true)
for (const bps of [1, 99, 250, 999, 7999, 8001, 10_000]) {
  assert.equal(isDirectionalTaxPreset(bps), false)
}

assert.equal(
  hasDirectionalTaxHookFlags(`0x${'0'.repeat(36)}2044`),
  true,
)
assert.equal(
  BigInt(`0x${'0'.repeat(36)}2044`) & 0x3fffn,
  DIRECTIONAL_TAX_REQUIRED_FLAGS,
)
assert.equal(hasDirectionalTaxHookFlags(`0x${'0'.repeat(36)}2045`), false)

const implementation = '0x1111111111111111111111111111111111111111'
const creator = '0x2222222222222222222222222222222222222222'
const otherCreator = '0x3333333333333333333333333333333333333333'
const mined = await mineDirectionalTaxHookSalt({
  factory,
  implementation,
  creator,
  start: 0n,
  maxAttempts: 300_000,
})
assert.equal(hasDirectionalTaxHookFlags(mined.hook), true)
assert.ok(mined.attempts > 0 && mined.attempts <= 300_000)
assert.equal(
  predictDirectionalTaxHook(factory, implementation, creator, mined.userSalt),
  mined.hook,
)
assert.notEqual(
  predictDirectionalTaxHook(factory, implementation, otherCreator, mined.userSalt),
  mined.hook,
  'creator namespace must alter the clone address',
)

const hookSource = readFileSync(new URL('../src/directionalTaxHook.ts', import.meta.url), 'utf8')
assert.match(
  hookSource,
  /result: simulated/,
  'the exact PoolId returned by createPool simulation must be retained before submission',
)
assert.match(
  hookSource,
  /opts\.onSubmitted\?\.\(submission\)/,
  'PoolId recovery data must reach the UI before receipt/config polling',
)
assert.match(
  hookSource,
  /Promise\.any\(urls\.map/,
  'post-receipt config verification must accept the first healthy RPC instead of trusting one node',
)

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
assert.match(
  appSource,
  /PoolId（已自动保存）/,
  'the mint UI must visibly expose the recoverable full PoolId',
)
assert.match(
  appSource,
  /setTaxPoolRecoveries/,
  'submitted Hook pool recovery data must be persisted locally',
)
assert.match(
  appSource,
  /已从 Hook 找回 PoolId/,
  'a Hook address from an old viem error must recover and expose its PoolId',
)

const recoveryTaxToken = '0xb2000000000000000000004c27f6523082f41d01'
const recoveryHook = '0xe56151A5B5909C731fb5A93c46F97EC8a7662044'
const recoveryPoolId = v4PoolId({
  currency0: zeroAddress,
  currency1: recoveryTaxToken,
  fee: 2900,
  tickSpacing: 60,
  hooks: recoveryHook,
})
const recoveredKey = await recoverV4PoolKeyFromCandidates({
  poolId: recoveryPoolId,
  hook: recoveryHook,
  fee: 2900,
  taxToken: recoveryTaxToken,
  partnerCandidates: [CHAIN_CONFIGS[8453].contracts.weth, zeroAddress],
  preferredTickSpacings: [10, 60],
})
assert.deepEqual(
  recoveredKey,
  {
    currency0: zeroAddress,
    currency1: recoveryTaxToken,
    fee: 2900,
    tickSpacing: 60,
    hooks: recoveryHook,
  },
  'old Hook errors should reconstruct a common native-token PoolKey without an eth_getLogs scan',
)

console.log(`directional tax hook UI tests passed (salt mined in ${mined.attempts} attempts)`)
