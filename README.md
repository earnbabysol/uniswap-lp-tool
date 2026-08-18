# RangeDesk（Uniswap LP 工具）

浏览器端 Uniswap V3/V4 仓位工具。钱包始终在本地签名；只读行情由 Pages 上的轻量共享索引加速。

## 本地开发

```bash
npm install
npm run dev
```

打开 http://127.0.0.1:5188/

## 生产构建

```bash
npm run build
```

产物在 `dist/`。

## 共享行情索引

`npm run index:flow` 会增量扫描 BSC、Robinhood Chain 与 Base 的 V3/V4 LP 动向，并生成：

- `public/index/flow.json`：最近 45 分钟的动向、手续费年化和池元数据
- `public/index/pools.json`：池搜索种子

GitHub Actions 每 10 分钟更新一次索引，并通过缓存保留扫描游标。浏览器优先读取这份同域快照；只有快照缺失或无效时才回退到公共 RPC。币种搜索和 1h K 线使用 GeckoTerminal 的公开索引，交易前的池价格仍会重新从链上读取。

## 在线部署（GitHub Pages，免 Vercel）

仓库已带 GitHub Actions。开启 Pages 后，每次 `git push` 自动更新：

1. 打开 https://github.com/earnbabysol/uniswap-lp-tool/settings/pages
2. **Source** 选 **GitHub Actions**
3. 等 Actions 跑完（仓库顶部 Actions 页）
4. 访问：https://earnbabysol.github.io/uniswap-lp-tool/

本地开发仍用 `npm run dev`（不受 Pages 的 base 路径影响）。
