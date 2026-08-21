# RangeDesk V4 tax hooks

This package contains both generations of the optional immutable buy/sell-tax pool mode.

- **V2 (current):** custom static LP fee plus independent custom buy/sell taxes. LP fee may be `0%`; each tax side accepts `0–80%` at `0.01%` precision, but both tax sides cannot be zero.
- **V1 (legacy):** LP fee is fixed to `0%`; buy/sell tax is selected from the original presets. Existing V1 factories, hooks and pools remain supported and are not upgraded or replaced.

- One permissionless factory is deployed per chain through the canonical Arachnid CREATE2 proxy.
- Every pool receives its own EIP-1167 hook clone.
- The clone address is namespaced by the creator wallet, preventing a copied pending transaction from stealing the collector role.
- The LP fee, project token, buy/sell rates and collector are frozen during initialization.
- Tax proceeds are transferred directly to the pool creator wallet.
- The web app still provides the quick presets `0, 1, 3, 5, 10, 20, 30, 50, 80%`, while V2 also accepts custom rates.
- A V4 position NFT is permanently tied to its complete PoolKey, including the Hook address. Increasing liquidity reuses that same PoolKey and cannot silently turn a Hook position into a normal position.

The contracts deliberately require `beforeInitialize`, `afterSwap` and `afterSwapReturnDelta` address flags (`0x2044`). No `hookData` is required.

## V2 supported mainnets

The frontend derives the V2 factory from the canonical PoolManager and the fixed, V2-specific CREATE2 salt. The web app checks the bytecode before use and can deploy the deterministic factory after an explicit wallet confirmation when it is absent.

| Chain | Chain ID | Predicted V2 factory |
| --- | ---: | --- |
| Ethereum | 1 | `0x30c17f3079a67Ccf0E75C6372B0005E247CA33dB` |
| BNB Smart Chain | 56 | `0x131Cd87f4468BA29A6F9D4fadeB90CD3Eb60aF4F` |
| Robinhood Chain | 4663 | `0x81882996c992659cD0da22327A4D9E5F903210b2` |
| Base | 8453 | `0x6045B0dd4531E6D43c21d2B529c27ebFeaC9cF10` |

## V1 legacy mainnets

The frontend derives the factory from the canonical PoolManager and the fixed `v1` CREATE2 salt.
These addresses stay unchanged so all existing V1 hooks remain recognizable.

| Chain | Chain ID | Predicted V1 factory |
| --- | ---: | --- |
| Ethereum | 1 | `0xDf507a9D72375D0BD295C64ef3992bBe2613F096` |
| BNB Smart Chain | 56 | `0x3f9c59deC3188cdbD29c273E3Bf864AecfE19DE8` |
| Robinhood Chain | 4663 | `0x907e2B00a0963317d9D7E213631635A16E352bCB` |
| Base | 8453 | `0x4BB336620781024851e968bFA014feDf86271ca6` |

## Local verification

From the repository root:

```powershell
npm run contracts:test
npm run contracts:artifact
```

## CLI deployment

Set `POOL_MANAGER` to the canonical manager for the target chain, then run `DeployConfigurableTaxHookFactoryV2.s.sol` with an RPC URL and a funded broadcaster. The web app can also deploy the same deterministic V2 factory after an explicit wallet confirmation.

This code is unaudited. Mainnet deployment and high tax rates must be treated as high risk until an independent smart-contract review is complete.
