import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

const src = (path: string) => fileURLToPath(new URL(`../src/${path}`, import.meta.url))

// demo 直接用库的源码：import 写法和正式使用时一样（@w3lib/ton-batch-call），改了源码刷新就能看到
export default defineConfig({
  // 相对路径：部署在 GitHub Pages 的子路径（/libs/ton/）下也能用
  base: './',
  resolve: {
    alias: [
      { find: /^@w3lib\/ton-batch-call\/(\w+)$/, replacement: src('subpaths/$1.ts') },
      { find: /^@w3lib\/ton-batch-call$/, replacement: src('index.ts') },
    ],
  },
  server: { port: 5176 },
  build: { outDir: 'dist', emptyOutDir: true },
})
