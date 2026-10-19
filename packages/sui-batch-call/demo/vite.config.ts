import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

const src = (path: string) => fileURLToPath(new URL(`../src/${path}`, import.meta.url))
/** 连接浏览器钱包用同一个仓库里的 @w3lib/wallet（也用源码） */
const wallet = (path: string) => fileURLToPath(new URL(`../../wallet/src/${path}`, import.meta.url))

// demo 直接用库的源码：import 写法和正式使用时一样（@w3lib/sui-batch-call），改了源码刷新就能看到
export default defineConfig({
  // 相对路径：部署在 GitHub Pages 的子路径（/libs/sui/）下也能用
  base: './',
  resolve: {
    alias: [
      { find: /^@w3lib\/wallet\/(\w+)$/, replacement: wallet('$1/index.ts') },
      { find: /^@w3lib\/wallet$/, replacement: wallet('index.ts') },
      { find: /^@w3lib\/sui-batch-call\/(\w+)$/, replacement: src('subpaths/$1.ts') },
      { find: /^@w3lib\/sui-batch-call$/, replacement: src('index.ts') },
    ],
  },
  server: { port: 5177 },
  build: { outDir: 'dist', emptyOutDir: true },
})
