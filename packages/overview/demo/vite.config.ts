import { fileURLToPath } from 'node:url'

import { defineConfig, type Plugin } from 'vite'

const pkg = (name: string, path: string) => fileURLToPath(new URL(`../../${name}/src/${path}`, import.meta.url))
const own = (path: string) => fileURLToPath(new URL(`../src/${path}`, import.meta.url))

/** demo 部署的地址（GitHub Pages），TON Connect 的 manifest 里要写它 */
const DEMO_URL = process.env.DEMO_URL ?? 'https://web3-lib.github.io/libs/overview/'

/** tonconnect-manifest.json（连接 TON 钱包用）：开发时用本地地址，构建时用部署地址（钱包会核对 manifest 里的 url） */
function tonManifest(): Plugin {
  // 图标是 demo/public/icon.png（TON Connect 要求 PNG，180×180）
  const manifest = (base: string) => {
    const root = base.endsWith('/') ? base : `${base}/`
    return JSON.stringify({ url: root.replace(/\/$/, ''), name: '@w3lib/overview demo', iconUrl: new URL('icon.png', root).href }, null, 2)
  }
  return {
    name: 'ton-manifest',
    configureServer(server) {
      server.middlewares.use('/tonconnect-manifest.json', (req, res) => {
        const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0]
        res.setHeader('Content-Type', 'application/json')
        res.end(manifest(`${proto}://${req.headers.host ?? 'localhost:5178'}/`))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'tonconnect-manifest.json', source: manifest(DEMO_URL) })
    },
  }
}

// demo 直接用各包的源码：import 写法和正式使用时一样，loader 里的 import() 让打包工具把链包分成单独的块
export default defineConfig({
  // 相对路径：部署在 GitHub Pages 的子路径（/libs/overview/）下也能用
  base: './',
  resolve: {
    alias: [
      ...(['evm', 'solana', 'sui', 'ton'] as const).flatMap((c) => [
        { find: new RegExp(`^@w3lib/${c}-batch-call/([\\w-]+)$`), replacement: pkg(`${c}-batch-call`, 'subpaths/$1.ts') },
      ]),
      { find: /^@w3lib\/ton-batch-call$/, replacement: pkg('ton-batch-call', 'index.ts') },
      /** 连接浏览器钱包用同一个仓库里的 @w3lib/wallet（也用源码） */
      { find: /^@w3lib\/wallet\/(\w+)$/, replacement: pkg('wallet', '$1/index.ts') },
      { find: /^@w3lib\/wallet$/, replacement: pkg('wallet', 'index.ts') },
      { find: /^@w3lib\/overview\/(\w+)$/, replacement: own('subpaths/$1.ts') },
      { find: /^@w3lib\/overview$/, replacement: own('index.ts') },
    ],
  },
  plugins: [tonManifest()],
  server: { port: 5178 },
  build: { outDir: 'dist', emptyOutDir: true },
})
