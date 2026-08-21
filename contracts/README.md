# RangeDesk V4 directional-tax hook

This package implements the optional `0% LP fee + immutable buy/sell tax` pool mode.

- One permissionless factory is deployed per chain through the canonical Arachnid CREATE2 proxy.
- Every pool receives its own EIP-1167 hook clone.
- The clone address is namespaced by the creator wallet, preventing a copied pending transaction from stealing the collector role.
- Pool fee is fixed to `0`; the project token, buy/sell rates and collector are frozen during initialization.
- Tax proceeds are transferred directly to the pool creator wallet.
- Supported rate presets are `0, 1, 3, 5, 10, 20, 30, 50, 80%`.

The contracts deliberately require `beforeInitialize`, `afterSwap` and `afterSwapReturnDelta` address flags (`0x2044`). No `hookData` is required.

## Supported mainnets

The frontend derives the factory from the canonical PoolManager and the fixed `v1` CREATE2 salt.
These addresses are currently undeployed; the first creator on a chain can deploy the exact same
permissionless bytecode from the web app after a wallet confirmation.

| Chain | Chain ID | Predicted factory |
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

Set `POOL_MANAGER` to the canonical manager for the target chain, then run the script with an RPC URL and a funded broadcaster. The web app can also deploy the same deterministic factory after an explicit wallet confirmation.

This code is unaudited. Mainnet deployment and high tax rates must be treated as high risk until an independent smart-contract review is complete.
