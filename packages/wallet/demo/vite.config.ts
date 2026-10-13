import { fileURLToPath } from 'node:url'

import { defineConfig, type Plugin } from 'vite'

const src = (path: string) => fileURLToPath(new URL(`../src/${path}`, import.meta.url))

/** demo 部署的地址（GitHub Pages），TON Connect 的 manifest 里要写它 */
const DEMO_URL = process.env.DEMO_URL ?? 'https://web3-lib.github.io/libs/wallet/'

/** tonconnect-manifest.json：开发时用本地地址，构建时用部署地址（钱包会核对 manifest 里的 url） */
function tonManifest(): Plugin {
  // 图标是 demo/public/icon.png（TON Connect 要求 PNG，180×180）
  const manifest = (base: string) => {
    const root = base.endsWith('/') ? base : `${base}/`
    return JSON.stringify({ url: root.replace(/\/$/, ''), name: '@w3lib/wallet demo', iconUrl: new URL('icon.png', root).href }, null, 2)
  }
  return {
    name: 'ton-manifest',
    configureServer(server) {
      server.middlewares.use('/tonconnect-manifest.json', (req, res) => {
        // 通过 HTTPS 隧道（ngrok 等）访问时用 https；手机钱包访问不到 localhost，用隧道调试扫码
        const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0]
        res.setHeader('Content-Type', 'application/json')
        res.end(manifest(`${proto}://${req.headers.host ?? 'localhost:5173'}/`))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'tonconnect-manifest.json', source: manifest(DEMO_URL) })
    },
  }
}

// demo 直接用库的源码：import 写法和正式使用时一样（@w3lib/wallet、@w3lib/wallet/evm…），改了源码刷新就能看到
export default defineConfig({
  // 相对路径：部署在 GitHub Pages 的子路径（/libs/wallet/）下也能用
  base: './',
  resolve: {
    alias: [
      { find: /^@w3lib\/wallet\/(evm|solana|sui|tron|ton|chains|ui|vue|react)$/, replacement: src('$1/index.ts') },
      { find: /^@w3lib\/wallet$/, replacement: src('index.ts') },
    ],
  },
  plugins: [tonManifest()],
  server: { port: 5173 },
  build: { outDir: 'dist', emptyOutDir: true },
})
