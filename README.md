# RangeDesk（Uniswap LP 工具）

浏览器端 Uniswap V3/V4 仓位工具。钱包在本地签名，无需后端。

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

## 在线部署（GitHub Pages，免 Vercel）

仓库已带 GitHub Actions。开启 Pages 后，每次 `git push` 自动更新：

1. 打开 https://github.com/earnbabysol/uniswap-lp-tool/settings/pages
2. **Source** 选 **GitHub Actions**
3. 等 Actions 跑完（仓库顶部 Actions 页）
4. 访问：https://earnbabysol.github.io/uniswap-lp-tool/

本地开发仍用 `npm run dev`（不受 Pages 的 base 路径影响）。
