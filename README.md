# RangeDesk — Uniswap LP 半自动工具（Robinhood Chain）

一期半自动：自定义 ±% 区间、一键 Claim / Claim+复投 / Rebalance。每笔操作需钱包签名。

## 功能

- 连接 MetaMask / Rabby，自动添加 **Robinhood Chain (4663)**
- 读取钱包 **Uniswap V3 + V4** 仓位（V4 目前只读）
- 按交易对或池地址加载 V3 池
- 自定义 **±X%** 价格区间开仓（Mint）
- **Claim** 手续费 / **Claim + 复投** / **Rebalance 到新 ±%**

## 启动

```bash
cd uniswap-lp-tool
npm install
npm run dev
```

浏览器打开终端提示的本地地址（通常 `http://localhost:5173`）。

## 使用前准备

1. 钱包切到 / 添加 Robinhood Chain  
   - Chain ID: `4663`  
   - RPC: `https://rpc.mainnet.chain.robinhood.com`  
   - Explorer: `https://robinhoodchain.blockscout.com`
2. 准备好要 LP 的代币（如 AAPL / USDG / WETH 等）并授权
3. 建议先用小额测试 Rebalance（会撤出全部流动性再按新区间 mint）

## 已知限制（一期）

- **V4 写操作未完成**（Claim / Mint / Rebalance 仅 V3）
- Rebalance 会使用钱包内该交易对的**当前余额**重新 mint，闲置同币余额可能被一并打入
- Claim+复投使用仓位 `tokensOwed` 作为复投量参考
- 公共 RPC 有速率限制，仓位多时加载会慢

## 二期方向

- V4 `modifyLiquidities` 完整编码
- 后台 keeper：价格出区间自动 rebalance、定时 claim 复利
