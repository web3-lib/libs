# Changelog

## Unreleased

### 新功能

- 钱包登录：`@w3lib/wallet/auth`（前端：`signIn`、`createSignInMessage` / `parseSignInMessage` / `createNonce`，EIP-4361 格式，其他链按 CAIP-122）和 `@w3lib/wallet/verify`（后端：`verifySignIn`，要求规范格式的消息，核对域名 / chainId / 时间 / 一次性 nonce 并验签，返回规范化的地址）。验签支持 EVM（含 EIP-1271 回调）、Solana、Sui（ed25519 / secp256k1 / secp256r1）、Tron、TON（TON Connect signData）
- 新增依赖 `@noble/curves`、`@noble/hashes`（只在 `/verify` 里用到）

## 0.1.0

### 新功能

- 首个版本：框架无关的浏览器钱包连接
  - EVM：EIP-6963 插件钱包（持续监听）、只注入 `window.ethereum` 的钱包、WalletConnect；切链时钱包没有这条链按配置添加
  - Solana / Sui：Wallet Standard（不依赖 @wallet-standard/app），silent 恢复
  - Tron：直接对接 TIP-1193 / TIP-6963 和 TronLink 协议的注入钱包
  - TON：@tonconnect/sdk（不带界面，手机钱包通过 onDisplayUri 拿链接画二维码）
  - `mode: 'single'`（默认，同一时间只连一个钱包）/ `'multi'`（每条链各连一个钱包）；刷新后静默恢复；统一的事件和 `WalletError`
  - 恢复时区分“不再授权”（删记录）和“出错 / 超时”（保留记录）；每条链单独超时（`restoreTimeout`），晚到的照样接上
  - 并发连接：较新的生效后较早的作废（`superseded`，不断开钱包），较新的失败不影响较早的
  - TON 的 `signMessage` 用 TON Connect 的 `signData`
  - 可选的自带连接弹窗（`@w3lib/wallet/ui`）：浅色 / 深色 / 跟随系统主题，自带二维码（不依赖第三方库），中英文；两种选择方式：先选链再选钱包（默认）/ 先选钱包再选链（`flow: 'wallet-first'`）
  - 按钱包合并的列表：`walletGroups()` / `watchWalletGroups()` / `useWalletGroups()`，同一个插件在各条链上合成一项
  - Vue / React hook（`@w3lib/wallet/vue`、`/react`），SSR 安全
  - 内置常用 EVM 链（`@w3lib/wallet/chains`）
  - Tron 插件钱包（TronLink、OKX、Bitget、TokenPocket）直接对接，不需要 SDK；只有 Tron 的 WalletConnect 需要 `@tronweb3/tronwallet-adapters`
  - `wallet.ready`、`connected`、`chainId`、`on(type, handler)`；`connect` 时可以传 `onDisplayUri`
  - 简单的调用方式：`wallet.address` / `wallet.connection` / `state.address` 拿当前地址；`wallet.wallets(chains?)` 按一条或几条链过滤钱包列表，每项带 `connected` 和 `connect()`；`watchWallets()` 监听列表；`getAddress(namespace)`；`connect()` 可以直接传列表项
  - 移动端：`openInWalletUrl()` 生成“在钱包 App 里打开”的链接，`isMobileBrowser()`
  - demo（`pnpm demo`），通过 GitHub Actions 发布到 GitHub Pages
