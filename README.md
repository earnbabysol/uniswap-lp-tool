# RangeDesk — Uniswap LP 半自动工具（Robinhood Chain）

一期半自动：自定义 ±% 区间、一键 Claim / Claim+复投 / Rebalance、创建 V3/V4 池并注入。每笔操作需钱包签名。

## 朋友如何下载使用

**方式一：直接下载 ZIP（最简单）**

1. 打开：<https://github.com/earnbabysol/uniswap-lp-tool/archive/refs/heads/master.zip>
2. 解压后进入文件夹，按下方「启动」执行 `npm install` 和 `npm run dev`

**方式二：用 Git 克隆**

```bash
git clone https://github.com/earnbabysol/uniswap-lp-tool.git
cd uniswap-lp-tool
npm install
npm run dev
```

浏览器打开终端提示的本地地址（通常 `http://localhost:5173`）。

## 功能

- 连接 MetaMask / Rabby，自动添加 **Robinhood Chain (4663)**
- 读取钱包 **Uniswap V3 + V4** 仓位（支持深度扫描）
- 创建 **V3 / V4** 池：设初始价、单边/双边注入（V3/V4 可直接付 ETH）
- 按交易对或池地址加载池
- 自定义 **±X%** 价格区间开仓（Mint），含全区间预设
- **Claim** 手续费 / **Claim + 复投** / **Rebalance 到新 ±%**
- 历史累计已领手续费展示

## 启动

```bash
cd uniswap-lp-tool
npm install
npm run dev
```

## 使用前准备

1. 安装 [Node.js](https://nodejs.org/)（建议 LTS 版本）
2. 钱包切到 / 添加 Robinhood Chain  
   - Chain ID: `4663`  
   - RPC: `https://rpc.mainnet.chain.robinhood.com`  
   - Explorer: `https://robinhoodchain.blockscout.com`
3. 准备好要 LP 的代币（如 AAPL / USDG / WETH 等）并授权
4. 建议先用小额测试 Rebalance（会撤出全部流动性再按新区间 mint）

## 已知限制

- 公共 RPC 有速率限制，仓位多时加载会慢；可用「深度扫描」补全 V4 仓位
- Rebalance 会使用钱包内该交易对的**当前余额**重新 mint，闲置同币余额可能被一并打入
- Claim+复投使用仓位 `tokensOwed` 作为复投量参考

## 仓库地址

<https://github.com/earnbabysol/uniswap-lp-tool>
