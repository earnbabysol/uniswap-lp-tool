import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 项目站：https://earnbabysol.github.io/uniswap-lp-tool/
const base = process.env.GITHUB_PAGES === 'true' ? '/uniswap-lp-tool/' : '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
  },
})
