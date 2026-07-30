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

## 在线部署（Vercel）

仓库已配置 `vercel.json`。把 GitHub 仓库接到 [Vercel](https://vercel.com) 后，每次 `git push` 会自动更新线上地址。

1. 打开 https://vercel.com/new
2. 用 GitHub 登录，导入 `earnbabysol/uniswap-lp-tool`
3. Framework 选 Vite（一般会自动识别），直接 Deploy
4. 把生成的 `*.vercel.app` 链接发给同伴即可
