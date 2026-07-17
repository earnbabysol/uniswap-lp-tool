# RangeDesk — Uniswap LP 半自动工具

支持 **Robinhood Chain (4663)** 与 **Base (8453)**。自定义 ±% 区间、Claim / Claim+复投 / Rebalance、创建 V3/V4 池并注入。每笔操作需钱包签名。

## 朋友如何下载使用

**方式一：直接下载 ZIP（最简单）**

1. 打开：https://github.com/earnbabysol/uniswap-lp-tool/archive/refs/heads/master.zip  
2. 解压后进入文件夹，执行下方「启动」命令

**方式二：用 Git 克隆**

```bash
git clone https://github.com/earnbabysol/uniswap-lp-tool.git
cd uniswap-lp-tool
npm install
npm run dev
```

浏览器打开终端提示的本地地址（本仓库默认 `http://127.0.0.1:5188/`）。

## 功能

- 连接 MetaMask / Rabby，在界面切换 **Robinhood / Base**
- 自定义 RPC（可测延迟；留空保存即回默认）
- 读取钱包 **Uniswap V3 + V4** 仓位（支持深度扫描）
- 创建 **V3 / V4** 池：设初始价、单边/双边注入（可直接付 ETH）
- 自定义 **±X%** 价格区间开仓（Mint），含全区间预设
- **Claim** / **Claim + 复投** / **Rebalance**
- 历史累计已领手续费展示

## 启动

```bash
cd uniswap-lp-tool
npm install
npm run dev
```

## 使用前准备

1. 安装 [Node.js](https://nodejs.org/)（建议 LTS）
2. 钱包添加对应网络：
   - **Robinhood**：Chain ID `4663`，RPC `https://rpc.mainnet.chain.robinhood.com`
   - **Base**：Chain ID `8453`，RPC `https://mainnet.base.org`
3. 准备好要 LP 的代币并授权
4. 建议先用小额测试 Rebalance

## 已知限制

- 公共 RPC 有速率限制；Base 普通刷新走索引快路径，漏仓请用「深度扫描」
- Rebalance 会使用钱包内该交易对的当前余额重新 mint
- Claim+复投使用仓位未领费作为复投量参考

## 仓库地址

https://github.com/earnbabysol/uniswap-lp-tool
