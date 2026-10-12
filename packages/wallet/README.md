# @w3lib/wallet

浏览器钱包连接库，支持 EVM（插件钱包、WalletConnect）、Solana、Sui、Tron、TON。框架无关：库负责发现钱包、连接、恢复、监听变化；可以用自带的连接弹窗，也可以自己画界面。

- **一个对象管所有链**：`wallet.wallets()` 拿钱包列表（每项可以直接 `connect()`），`wallet.address` 拿当前地址，`wallet.on()` 监听变化
- **自带连接弹窗（可选）**：浅色 / 深色主题，带二维码，不依赖任何框架和第三方库；不引用就不会打包
- **Vue / React hook**：`useWallet()`、`useWallets()`，SSR 安全
- **内置常用链**：`import { bsc, ethereum } from '@w3lib/wallet/chains'`，不用自己写 RPC、原生币
- **尽量少的第三方依赖**：EVM 插件钱包、Solana、Sui、Tron 插件钱包都直接对接钱包，不需要 SDK；只有扫码连手机钱包（WalletConnect、TON）需要装对应的 SDK
- **一个钱包或多链同时连接**：默认同一时间只连一个钱包（连新的会断开旧的）；设 `mode: 'multi'` 后每条链可以各连一个
- **刷新后自动恢复**：静默恢复上次的连接，不弹窗、不在页面加载时切链
- **钱包发现**：持续监听 EIP-6963 / TIP-6963（晚注入的插件也能出现），兼容只注入 `window.ethereum` 的老钱包；Wallet Standard 钱包随时注册随时出现
- **错误统一**：用户拒绝、请求已挂起、没安装、链不支持… 都是带 `code` 的 `WalletError`
- **按需打包、体积小**：每条链一个子路径，只用到的才打包

**在线 demo**：<https://web3-lib.github.io/libs/>（自带弹窗的两种选择方式、浅色 / 深色主题、single / multi 模式、签名、切链、自己画钱包列表、事件日志）。本地运行：

```bash
pnpm --filter @w3lib/wallet demo        # http://localhost:5173
```

## 目录

- [安装](#安装)
- [快速上手](#快速上手)
- [自带的连接弹窗](#自带的连接弹窗)
- [在 Vue / React 里用](#在-vue--react-里用)
- [钱包列表：展示和连接](#钱包列表展示和连接)（含[按钱包合并](#按钱包合并先选钱包再选链)）
- [当前地址和连接状态](#当前地址和连接状态)
- [事件](#事件)
- [自己画连接弹窗](#自己画连接弹窗)
- [签名、切链、断开](#签名切链断开)
- [各条链的配置](#各条链的配置)
- [连接模式、恢复和持久化](#连接模式恢复和持久化)
- [错误处理](#错误处理)
- [移动端](#移动端)
- [配合批量写操作](#配合批量写操作)
- [API 一览](#api-一览)
- [体积与运行环境](#体积与运行环境)

## 安装

```bash
pnpm add @w3lib/wallet
```

库本身没有依赖。大部分功能不需要再装别的；只有下面两种扫码连手机钱包的方式需要对应的 SDK（通过 `load: () => import('…')` 传入，打包工具会拆成单独的 chunk，第一次用到时才加载）：

| 功能 | 需要另外安装 |
| --- | --- |
| EVM 插件钱包（MetaMask、OKX…）、Solana、Sui、Tron 插件钱包（TronLink、OKX、Bitget、TokenPocket）、自带弹窗、Vue / React hook | 不需要 |
| EVM 的 WalletConnect（扫码连手机钱包） | `@walletconnect/ethereum-provider` |
| TON | `@tonconnect/sdk`（签名消息需要 3.2+） |
| Tron 的 WalletConnect（很少用） | `@tronweb3/tronwallet-adapters` |

Vue / React hook 用的是你项目里已经装的 `vue`（3.3+）/ `react`（18+）。

## 快速上手

```ts
import { createWallet } from '@w3lib/wallet'
import { bsc, ethereum } from '@w3lib/wallet/chains'
import { evm } from '@w3lib/wallet/evm'
import { solana } from '@w3lib/wallet/solana'
import { tron } from '@w3lib/wallet/tron'
import { createWalletModal } from '@w3lib/wallet/ui'

// 1. 创建：配置要支持的链（只 import 用到的链），整个应用共用一个
export const wallet = createWallet({
  connectors: [evm({ chains: [bsc, ethereum] }), solana(), tron()],
})

// 2. 等刷新后的自动恢复完成（上次连过的钱包会静默连上）
await wallet.ready
wallet.connected          // 有没有连接
wallet.address            // 当前地址，没连接时为 null

// 3. 连接：用自带的弹窗（见下一节），或者自己画（见“钱包列表”）
const modal = createWalletModal(wallet)
const connection = await modal.open()   // 用户连接成功返回连接，关掉弹窗返回 null

// 4. 监听变化
wallet.on('accountChanged', (event) => console.log('换账户了', event.address))
wallet.on('disconnect', (event, state) => {
  if (!state.connected) console.log('退出了')        // 换钱包时旧钱包也会发 disconnect，这时 state 里已经是新钱包
})
```

## 自带的连接弹窗

不想自己画界面时，用自带的弹窗。它是可选的：不 `import '@w3lib/wallet/ui'` 就不会打包。

```ts
import { createWalletModal } from '@w3lib/wallet/ui'

const modal = createWalletModal(wallet, { theme: 'dark' })

connectButton.onclick = async () => {
  const connection = await modal.open()   // 连接成功返回连接，用户关掉弹窗返回 null（不会抛错）
  if (connection) console.log(connection.address)
}
```

### 两种选择方式

```ts
createWalletModal(wallet)                           // 先选链，再选钱包（默认）
createWalletModal(wallet, { flow: 'wallet-first' }) // 先选钱包，再选链
modal.open({ flow: 'wallet-first' })                // 也可以每次打开时指定
```

- **先选链，再选钱包**（`'chain-first'`）：顶部是链的标签（EVM / Solana / Tron…），下面是这条链上的钱包
- **先选钱包，再选链**（`'wallet-first'`）：同一个插件在各条链上合成一项（如一个 OKX，下面写着它支持的链“EVM · Solana · Tron”）。点了只有一条链能连的钱包直接连接；能连好几条链的，接着列出它的链让用户选（没装的链标“未安装”）

钱包是怎么合并的见[按钱包合并](#按钱包合并先选钱包再选链)。

### 弹窗包含

- 钱包列表（已安装 / 已连接 / 扫码 / 未安装），按上面两种方式之一
- 点击后显示“请在钱包中确认”，出错（用户拒绝、钱包里已有请求在等…）时显示原因和“重试”
- 扫码类钱包（WalletConnect、TON 手机钱包）显示二维码、“复制链接”，手机上还有“在钱包中打开”
- 没安装的钱包：电脑上打开下载页；手机上直接跳到钱包 App 的内置浏览器打开当前页面
- 已连接时底部显示地址和“断开”
- Esc、点遮罩、关闭按钮都能关闭；正在等钱包确认时关闭会取消连接

扫码不需要再配置 `onDisplayUri`，弹窗会自己画二维码（EVM 的 WalletConnect 仍然要配 `projectId` 和 `load`，见 [EVM](#evm)）。Tron 的 WalletConnect、开了 `showQrModal` 的 EVM WalletConnect 用的是 SDK 自带的扫码窗口：连接时自带弹窗会先隐藏，不挡住它，连接失败时再显示出来。

### 选项

```ts
createWalletModal(wallet, {
  flow: 'chain-first',           // 'chain-first' 先选链再选钱包（默认）| 'wallet-first' 先选钱包再选链
  theme: 'auto',                 // 'light' 浅色 | 'dark' 深色 | 'auto' 跟随系统（默认）
  locale: 'zh',                  // 'zh' | 'en'，默认按浏览器语言
  chains: ['evm', 'solana'],     // 显示哪些链，默认 createWallet 里配置了的全部
  texts: { title: '登录' },      // 覆盖部分文案
  chainLabels: { evm: 'Ethereum / BSC' },
  zIndex: 2147483000,
  container: document.body,      // 挂在哪个元素下
})
```

| 方法 / 属性 | 说明 |
| --- | --- |
| `open(chains?)` / `open({ chains?, flow? })` | 打开，返回 `Promise<Connection \| null>`。可以只显示某些链：`open('evm')`、`open(['evm', 'solana'])`（没配置的链忽略；一条都没有时不打开，直接返回 `null`）；可以这次换一种选择方式：`open({ flow: 'wallet-first' })` |
| `close()` | 关闭（`open` 返回 `null`） |
| `setTheme(theme)` | 切换主题，比如跟着网站的深色模式开关 |
| `isOpen` | 是否打开着 |
| `element` | 宿主元素（打开时才有） |
| `destroy()` | 关闭并移除 |

样式在 Shadow DOM 里，不会影响页面，也不会被页面的 CSS 影响。手机上（宽度 ≤ 480px）以底部弹出的样式显示（避开 iPhone 底部的横条）。打开时页面不滚动；键盘焦点在弹窗里循环，关闭后还给打开它的按钮；弹窗处理过的 Esc 不会再传给页面。服务端渲染时调用 `open()` 直接返回 `null`。

`container` 默认是 `document.body`。如果挂到别的元素下，而它的某个祖先设置了 `transform` / `filter` 等（会形成新的层叠上下文），弹窗的全屏遮罩和 `z-index` 会被限制在那个祖先里。

## 在 Vue / React 里用

### Vue

```vue
<script setup lang="ts">
import { useWallet, useWallets } from '@w3lib/wallet/vue'
import { wallet } from './wallet'

const { address, connected, status } = useWallet(wallet)   // 都是 ref，变化时自动更新
const wallets = useWallets(wallet, 'evm')                  // 钱包列表，可按链过滤
</script>

<template>
  <span v-if="status === 'restoring'">…</span>
  <span v-else-if="connected">{{ address }}</span>
  <template v-else>
    <!-- 用户拒绝等错误见“自己画连接弹窗” -->
    <button v-for="item in wallets" :key="item.id" @click="item.connect().catch(console.warn)">
      <img v-if="item.icon" :src="item.icon" /> {{ item.name }}
    </button>
  </template>
</template>
```

`useWallet(wallet, options?)` 返回 `{ state, address, connection, connected, chainId, status }`（都是 ref）；`useWallets(wallet, chains?, options?)` 返回钱包列表的 ref；`useWalletGroups(wallet, chains?, options?)` 返回按钱包合并的列表（先选钱包，再选链）。在 `setup`（或 `effectScope`）里调用，组件卸载时自动取消订阅。Nuxt 等服务端渲染的应用传 `{ ssr: true }`，见下面。

### React

```tsx
import { useWallet, useWallets } from '@w3lib/wallet/react'
import { wallet } from './wallet'

function ConnectButton() {
  const { address, connected, status } = useWallet(wallet)
  const wallets = useWallets(wallet, 'evm')
  if (status === 'restoring') return null
  if (connected) return <span>{address}</span>
  return wallets.map((item) => (
    // 用户拒绝等错误见“自己画连接弹窗”
    <button key={item.id} onClick={() => item.connect().catch(console.warn)}>
      {item.name}
    </button>
  ))
}
```

`useWallet(wallet)` 返回整个状态加上 `connected`；`useWallets(wallet, chains?)` 返回钱包列表；`useWalletGroups(wallet, chains?)` 返回按钱包合并的列表。

### 服务端渲染（Nuxt / Next）

钱包只在浏览器里有。hook 已经处理了服务端渲染：

- React：服务端渲染和 hydration 时状态是 `status: 'restoring'`、没有连接，钱包列表是空的，和客户端第一次渲染一致，不会报 hydration 不一致；之后换成真实状态
- Vue：服务端不订阅（不会每个请求留下一个监听），状态是 `status: 'restoring'`、没有连接。Nuxt 里给两个 hook 都传 `{ ssr: true }`：组件先用和服务端一样的状态渲染，挂载后再换成真实状态（不传时客户端第一次渲染就是真实状态，和服务端不一致）：`useWallet(wallet, { ssr: true })`、`useWallets(wallet, 'evm', { ssr: true })`

界面上在 `status === 'restoring'` 时显示加载中即可。也可以把钱包相关的组件只放在客户端渲染（Nuxt 的 `<ClientOnly>`、Next 的 `dynamic(..., { ssr: false })`）。在服务端创建 `wallet` 本身是安全的：不访问 `window`、不加载 SDK，只是没有钱包可连。

## 钱包列表：展示和连接

自己画界面时用。

### 拿列表，按链过滤

```ts
wallet.wallets()                    // 所有配置了的链的钱包
wallet.wallets('evm')               // 只要 EVM 的
wallet.wallets(['evm', 'solana'])   // 只要 EVM 和 Solana 的
```

链只有这几个：`'evm' | 'solana' | 'tron' | 'sui' | 'ton'`。传了没在 `connectors` 里配置的链会抛 `unsupported`。

每一项：

| 字段 | 说明 |
| --- | --- |
| `id` | 钱包 id，同一条链里唯一、稳定。EVM 是 EIP-6963 的 rdns（`'io.metamask'`、`'com.okex.wallet'`），WalletConnect 是 `'walletconnect'`；Solana / Sui 是钱包名（`'Phantom'`）；Tron 是 `'tronlink'`、`'okx'`、`'bitget'`、`'tokenpocket'`、`'walletconnect'`；TON 是 TON Connect 的 appName（`'tonkeeper'`） |
| `namespace` | 所在的链：`'evm'`、`'solana'`… |
| `name` | 显示名 |
| `icon` | 图标（data URI 或 URL），可能为 `null` |
| `type` | `'injected'`：浏览器插件 / 钱包 App 内置浏览器注入的；`'qrcode'`：扫码连接（WalletConnect、TON 的手机钱包） |
| `installed` | 现在能直接连接（插件已安装；扫码类总是 `true`） |
| `downloadUrl` | 没安装时引导下载的地址，可能为 `null` |
| `connected` | 这个钱包当前已连接 |
| `connect(options?)` | 连接这个钱包，返回 `Connection`（见下一节） |
| `sdkModal` | 为 `true` 时连接由钱包的 SDK 自己弹出扫码窗口（Tron 的 WalletConnect、开了 `showQrModal` 的 EVM WalletConnect），拿不到连接链接；自己画的弹窗这时应该先让开 |

同一个钱包在不同链上是不同的项，比如 OKX 在 `evm` 和 `solana` 下各有一个。一般已安装的排在前面，没安装但常用的钱包（带 `downloadUrl`，用来引导下载）排在后面。

### 列表会变：用 `watchWallets`

插件可能晚于页面注入，TON 的钱包要等 SDK 加载完才知道，连接、断开后 `connected` 也会变。`watchWallets` 立即用当前列表调用一次，之后每次变化再调用，直接赋值即可（Vue / React 的 `useWallets` 就是用它做的）：

```ts
const stop = wallet.watchWallets((list) => renderWalletList(list), 'evm')   // 第二个参数和 wallets() 一样
stop()                                                                        // 不需要时取消
```

### 按钱包合并（先选钱包，再选链）

```ts
const groups = wallet.walletGroups()          // 同样可以按链过滤：walletGroups('evm')、walletGroups(['evm', 'solana'])
// [{ id: 'okx', name: 'OKX Wallet', chains: ['evm', 'solana', 'tron'], installedChains: ['evm', 'solana'], … }, …]

async function onPickWallet(group: WalletGroup) {
  if (!group.installed) return window.open(group.downloadUrl ?? undefined)
  if (group.installedChains.length === 1) return group.connect()     // 只有一条链能连：直接连
  showChainPicker(group.installedChains)                             // 否则让用户选链……
}
await group.connect('solana')                                        // ……然后连那条链
```

同一个插件在各条链上的条目按钱包名合并：去掉大小写、空格和末尾的 “Wallet”（`OKX Wallet`、`okx`、`OKX` 都是 `okx`），少数名字不规则的有对照表（如 `BitKeep` → `bitget`）。`walletKey(name)` 是这个规则，`groupWallets(list)` 可以单独用来合并任意钱包列表。

每一项：

| 字段 | 说明 |
| --- | --- |
| `id` | 钱包 id（由钱包名归一化，如 `'okx'`、`'metamask'`、`'phantom'`） |
| `name` / `icon` | 显示名和图标（优先用能直接连接的那条链上的） |
| `type` | 有一条链上是注入的就是 `'injected'`，全是扫码的为 `'qrcode'` |
| `installed` | 至少有一条链能直接连接 |
| `connected` | 至少有一条链已连接 |
| `downloadUrl` | 没安装时的下载页 |
| `chains` | 这个钱包出现在哪些链上（按 `connectors` 的顺序） |
| `installedChains` | 能直接连接的链 |
| `wallets` | 每条链上的条目（`WalletOption`） |
| `connect(namespace?, options?)` | 连接。传了链就连那条链；不传时连第一条能连的链 |

已连接的、已安装的排在前面。`watchWalletGroups(listener, chains?)` 监听这个列表，用法同 `watchWallets`。

注意：只能知道钱包支持哪几大类链（EVM、Solana…），不能知道它支持哪些具体的 EVM 链（如 BSC、Base），这只能在切链时由钱包回答（没有时按 `evm({ chains })` 请求添加）。

## 当前地址和连接状态

### 当前钱包

默认（`mode: 'single'`）同一时间只连一个钱包，“当前钱包”就是它。`mode: 'multi'` 时可以每条链各连一个，“当前钱包”是最近一次连接（或 `setActive` 选中）的那个。

```ts
wallet.address             // 当前钱包的地址，没连接时为 null
wallet.connected           // 有没有连接
wallet.chainId             // 当前钱包所在的链（如 56），没连接时为 null
wallet.connection          // 当前钱包的连接（下表），没连接时为 null
await wallet.ready         // 等刷新后的自动恢复完成（不会抛错）
```

`Connection`：

| 字段 | 说明 |
| --- | --- |
| `namespace` | 链：`'evm'`、`'solana'`… |
| `walletId` / `walletName` / `icon` | 钱包 |
| `address` | 地址：EVM 是 0x 地址（钱包给的大小写），Solana base58，Tron `T…`，Sui 0x，TON user-friendly 的非 bounceable 地址（`UQ…`） |
| `chainId` | 当前链：EVM 是数字（`56`）；Solana / Sui 是 `'solana:mainnet'` 这样的标识；Tron 是 `'mainnet'` / `'shasta'` / `'nile'`（判断不了时为 `null`）；TON 是 `'-239'`（主网）/ `'-3'`（测试网） |
| `provider` | 钱包对象，用来发交易（见[配合批量写操作](#配合批量写操作)）：EVM 是 EIP-1193 provider，Solana / Sui 是 Wallet Standard 钱包，Tron 是钱包注入的 `tronWeb`（WalletConnect 时是 adapter），TON 是 TonConnect 实例 |

### 按链取

`mode: 'multi'` 下同时连了几条链时：

```ts
wallet.getAddress('solana')          // Solana 那个钱包的地址，没连接时为 null
wallet.getConnection('tron')         // Tron 那个钱包的连接
wallet.getAddress()                  // 不传：当前钱包，等于 wallet.address
```

### 整个状态

```ts
const state = wallet.getState()
```

| 字段 | 说明 |
| --- | --- |
| `address` | 当前钱包的地址（同 `wallet.address`） |
| `connection` | 当前钱包的连接（同 `wallet.connection`） |
| `connections` | 每条链的连接：`{ evm?: Connection, solana?: Connection, … }` |
| `active` | 当前钱包所在的链，没有连接时为 `null` |
| `status` | `'restoring'`：正在恢复上次的连接；`'ready'`：恢复完了 |

状态每次变化都是**新对象**（没变化时是同一个对象），可以直接接进框架的响应式。

页面刚打开时 `status` 是 `'restoring'`，这时还不知道有没有连接：界面上可以先显示加载中，等 `'ready'`（或 `await wallet.ready`）后再决定显示“连接钱包”按钮还是地址，避免按钮闪一下。

## 事件

只关心某一种事件时用 `on`，返回取消函数：

```ts
const off = wallet.on('accountChanged', (event, state) => reload(event.address))
wallet.on('chainChanged', (event) => console.log('切到了', event.chainId))
wallet.on('disconnect', (event, state) => !state.connected && logout())   // 看状态：换钱包不是退出
off()
```

想收到所有变化时用 `subscribe`：

```ts
const unsubscribe = wallet.subscribe((state, event) => render(state))
```

| 事件 | 时机 | 其他字段 |
| --- | --- | --- |
| `connect` | 连接成功（包括刷新后恢复） | `namespace`、`connection` |
| `disconnect` | 主动断开，或钱包那边断开 / 锁定；连接新钱包替换掉旧钱包时也会发（`replaced: true`，在新钱包的 `connect` 之前，state 里已经是新钱包） | `namespace`、`walletId`、`replaced?` |
| `accountChanged` | 在钱包里切换了账户（只是地址大小写不同不算） | `namespace`、`address` |
| `chainChanged` | 切换了链 | `namespace`、`chainId` |
| `activeChanged` | 当前钱包变了（连接了另一条链、`setActive`、当前钱包断开后换成另一个、恢复结束时设好当前钱包） | `active` |
| `restoring` | 手动调用 `restore()` 开始恢复（自动恢复时创建出来就是 `'restoring'`，不发这个事件） | |
| `restored` | 恢复结束（`status` 变成 `'ready'`） | |
| `walletsChanged` | 钱包列表变了（插件晚注入、Wallet Standard 注册、SDK 加载完） | `namespace` |

只关心地址时不用看事件，每次直接读 `state.address` 即可。链变化时页面不会刷新，按事件更新界面。

## 自己画连接弹窗

处理了没安装、扫码、用户拒绝、钱包里已有请求在等、用户关掉弹窗等情况：

```ts
import { WalletError, type WalletOption } from '@w3lib/wallet'

let cancel: AbortController | null = null

async function onSelect(item: WalletOption) {
  if (!item.installed) return window.open(item.downloadUrl ?? undefined)

  cancel = new AbortController()
  showStatus(item.type === 'qrcode' ? '请用手机钱包扫码' : `请在 ${item.name} 里确认`)
  try {
    await item.connect({
      signal: cancel.signal,
      onDisplayUri: (uri) => showQrCode(uri),   // 扫码类钱包：拿到连接链接，画成二维码
    })
    closeModal()
  } catch (err) {
    switch ((err as WalletError).code) {
      case 'user_rejected':    // 用户拒绝，或者关掉了弹窗（abort）
      case 'superseded':       // 用户又点了另一个钱包，这次的结果作废
        return showStatus('')
      case 'pending_request':  // 钱包里已经有一个连接请求在等（MetaMask -32002）
        return showStatus(`请打开 ${item.name} 处理待确认的请求`)
      case 'not_installed':
        return showStatus(`没有检测到 ${item.name}`)
      default:
        return showStatus('连接失败，请重试')
    }
  }
}

function onCloseModal() {
  cancel?.abort()         // 正在等钱包确认时关掉弹窗：连接以 user_rejected 结束，之后钱包里再同意也不会生效
}
```

`onDisplayUri` 也可以写在连接器的配置里（`evm({ walletConnect: { onDisplayUri } })`、`ton({ onDisplayUri })`），`connect` 时传的优先。在手机浏览器里可以直接 `location.href = uri` 跳到钱包 App。

## 签名、切链、断开

```ts
// 签名一段文本（登录验证等），默认用当前钱包；返回各链惯用的编码
const signature = await wallet.signMessage('Sign in to example.com')
await wallet.signMessage('hello', 'solana')     // 指定链

// 切链（只有 EVM 支持；默认作用于 EVM 的钱包）。钱包没有这条链时，按 evm({ chains }) 里的信息请求添加
await wallet.switchChain(56)
await wallet.switchChain('0x38')                // 十六进制也可以

// 连接时顺便切链（只对 EVM 有效，其他链忽略）。切链失败时连接仍然保留，抛出切链的错误
await wallet.connect('evm', 'io.metamask', { chainId: 56 })

// 断开
await wallet.disconnect()                       // 当前钱包
await wallet.disconnect('solana')               // 指定链
await wallet.disconnectAll()                    // 全部

// mode: 'multi' 下同时连了几条链时，切换当前钱包
wallet.setActive('solana')
```

`signMessage` 的返回：

| 链 | 返回 | 用的是 |
| --- | --- | --- |
| EVM | 0x 十六进制签名 | `personal_sign` |
| Solana | base58 | `solana:signMessage` |
| Sui | base64（Sui 序列化签名） | `sui:signPersonalMessage`，老钱包退回 `sui:signMessage` |
| Tron | 0x 十六进制签名 | `tronWeb.trx.signMessageV2` |
| TON | base64 | TON Connect 的 `signData`（text） |

钱包不支持签名消息时抛 `unsupported`。

## 各条链的配置

### 内置的链

```ts
import { arbitrum, avalanche, base, bsc, bscTestnet, ethereum, linea, opbnb, optimism, polygon, sepolia, zksync } from '@w3lib/wallet/chains'

evm({ chains: [bsc, ethereum, base] })
```

每条链包含 `id`、`name`、`rpcUrls`（各链官方 / 常用的公共节点）、`nativeCurrency`、`blockExplorerUrls`，单独导出，只打包用到的。生产环境可以换成自己的节点：

```ts
evm({ chains: [{ ...bsc, rpcUrls: ['https://my-bsc-node.example'] }] })
```

没内置的链自己写一个同样结构的对象即可：

```ts
const myChain = {
  id: 1234,
  name: 'My Chain',
  rpcUrls: ['https://rpc.my-chain.example'],
  nativeCurrency: { name: 'MY', symbol: 'MY', decimals: 18 },
  blockExplorerUrls: ['https://scan.my-chain.example'],   // 可选
}
```

### EVM

```ts
import { evm } from '@w3lib/wallet/evm'

evm({
  chains: [bsc, ethereum],
  walletConnect: {                                           // 可选：扫码连手机钱包
    projectId: 'xxx',                                        // https://cloud.reown.com 申请
    load: () => import('@walletconnect/ethereum-provider'),
    metadata: { name: 'My Dapp', description: '…', url: 'https://my.app', icons: ['https://my.app/icon.png'] },
  },
})
```

| 选项 | 说明 |
| --- | --- |
| `chains` | 支持的链（可以用[内置的链](#内置的链)）。切链时钱包没有这条链，就用这里的信息请求添加（`wallet_addEthereumChain`）；WalletConnect 用它们做 `optionalChains` 和 `rpcMap`。不传时切到钱包没有的链会抛 `unsupported_chain` |
| `walletConnect` | 配置后钱包列表里出现 WalletConnect（`id: 'walletconnect'`，`type: 'qrcode'`），见下表 |
| `known` | 没检测到时也列出来的钱包（引导下载），默认 MetaMask、OKX、Bitget、Binance、Trust、Coinbase、Rabby、TokenPocket（`DEFAULT_EVM_WALLETS`）；传 `[]` 不列。每项 `{ id: rdns, name, downloadUrl, icon? }` |
| `legacyInjected` | 列出只注入 `window.ethereum`、不支持 EIP-6963 的钱包（`id: 'injected'`，按 `isOkxWallet` 等字段识别名字），默认 `true` |
| `restoreTimeout` | 刷新后恢复时，等插件响应 EIP-6963 的最长时间（毫秒），默认 1500 |

`walletConnect`：

| 选项 | 说明 |
| --- | --- |
| `projectId` | 必填，Reown（WalletConnect Cloud）的 projectId |
| `load` | 必填，`() => import('@walletconnect/ethereum-provider')` |
| `onDisplayUri` | 拿到连接链接时回调：画成二维码，或在手机上跳转钱包。用自带弹窗或 `connect` 时传了 `onDisplayUri` 就不用配 |
| `showQrModal` | 改用 WalletConnect 自带的二维码弹窗（需要另外安装 `@reown/appkit`），默认 `false` |
| `qrModalOptions` | WalletConnect 自带弹窗的参数 |
| `metadata` | 钱包里显示的 dapp 信息 `{ name, description, url, icons }` |
| `name` / `icon` | 钱包列表里显示的名称和图标，默认 `'WalletConnect'` |
| `options` | 其他传给 `EthereumProvider.init` 的参数 |

- 连接 WalletConnect 时，`onDisplayUri`（配置里的或 `connect` 时传的）和 `showQrModal` 至少要有一个，否则抛 `unsupported`（用户看不到二维码）
- 断开时，对支持 EIP-2255 的钱包（如 MetaMask）撤销授权，下次连接重新确认；WalletConnect 结束会话
- 取消连接后用户仍扫码同意的话，会话一建立就被断开
- WalletConnect 会话由它自己持久化，刷新后会话还在就自动恢复，不弹二维码

### Solana / Sui

```ts
import { solana } from '@w3lib/wallet/solana'
import { sui } from '@w3lib/wallet/sui'

solana({ cluster: 'mainnet' })     // 'mainnet' | 'devnet' | 'testnet'
sui({ network: 'mainnet' })        // 'mainnet' | 'testnet' | 'devnet'
```

| 选项 | 说明 |
| --- | --- |
| `cluster` / `network` | 网络，默认 `'mainnet'`。只列出支持这个网络的钱包 |
| `known` | 没检测到时也列出来的钱包，默认 Solana：Phantom、Solflare、Backpack、OKX、Bitget；Sui：Slush、Suiet、OKX、Bitget。传 `[]` 不列。每项 `{ name, downloadUrl, icon? }` |
| `exclude` | 不显示的钱包名 |
| `restoreTimeout` | 刷新后恢复时，等钱包注册的最长时间（毫秒），默认 1500 |

基于 Wallet Standard，不需要任何 SDK（也不依赖 `@wallet-standard/app`）。只列出支持这条链、能签交易的钱包；`id` 是钱包名。

### Tron

```ts
import { tron } from '@w3lib/wallet/tron'

tron()                                       // TronLink、OKX、Bitget、TokenPocket，不需要任何 SDK

tron({                                       // 需要扫码连手机钱包时：
  walletConnect: { network: 'Mainnet', options: { projectId: 'xxx', metadata } },
  load: () => import('@tronweb3/tronwallet-adapters'),
})
```

| 选项 | 说明 |
| --- | --- |
| `wallets` | 列出的钱包，默认 `['tronlink', 'okx', 'bitget', 'tokenpocket']` |
| `icons` | 钱包图标 `{ okx: '…', bitget: '…' }`。TronLink、TokenPocket 的新版插件通过 TIP-6963 自带图标；其他没有内置图标（为了体积），默认 `null` |
| `walletConnect` | 传给 `WalletConnectAdapter` 的参数（用 adapter 自带的扫码弹窗）；另外可以带 `name` / `icon` 改列表里的显示。需要同时传 `load` |
| `load` | 只在用 WalletConnect 时需要：`() => import('@tronweb3/tronwallet-adapters')` |
| `restoreTimeout` | 刷新后恢复时，等插件注入 / 钱包给出地址的最长时间（毫秒），默认 1500 |

- 插件钱包直接对接钱包注入的对象，做法与各钱包官方 adapter 一致：新版 TronLink（`window.tron`、TIP-6963）、TokenPocket（`window.tokenpocket.tron`、TIP-6963）用 TIP-1193 的 `eth_requestAccounts`；老版 TronLink、OKX（`okxwallet.tronLink`）、Bitget（`bitkeep.tronLink`）用 `tron_requestAccounts`；钱包 App 的内置浏览器里打开时已经授权，直接连上
- 账户 / 网络变化：用钱包的事件（TIP-1193 的 `accountsChanged` / `chainChanged`，老写法的 `window.postMessage` 通知）；另外每 1.5 秒看一眼当前账户，补上不发事件的钱包。老写法的通知各钱包长得一样，所以只当作“重新读一次”，以当前钱包自己的 `tronWeb` 为准
- `connection.provider` 是连接时钱包注入的 `tronWeb`；极少数钱包换网络后会换一个新的 `tronWeb` 对象，需要最新的可以直接读 `window.tronLink.tronWeb` 等
- 注入的 Tron 钱包没有“撤销授权”的接口：`disconnect` 只在本地断开，下次连接钱包可能不再弹确认
- 刷新后恢复：钱包已授权时直接恢复，不弹窗。老写法的钱包（OKX、Bitget、老版 TronLink）还没就绪时，分不清是插件启动慢还是撤销了授权：先保留记录下次再试，连续 3 次打开页面都没就绪才删掉
- WalletConnect 的 adapter 不能静默恢复会话：刷新后需要再点一次连接（WalletConnect 自己存的会话还在时会直接连上，不用重新扫码）。adapter 报告不了当前网络，`chainId` 用 `walletConnect.network` 里配置的；用户关掉它的扫码窗口时是 `user_rejected`

### TON

```ts
import { ton } from '@w3lib/wallet/ton'

ton({
  manifestUrl: 'https://my.app/tonconnect-manifest.json',
  load: () => import('@tonconnect/sdk'),
})
```

| 选项 | 说明 |
| --- | --- |
| `manifestUrl` | 必填，[tonconnect-manifest.json](https://docs.ton.org/develop/dapps/ton-connect/manifest) 的地址 |
| `load` | 必填，`() => import('@tonconnect/sdk')` |
| `onDisplayUri` | 连接手机钱包时回调连接链接（第二个参数是钱包列表项）。用自带弹窗或 `connect` 时传了 `onDisplayUri` 就不用配；都没有时连接手机钱包抛 `unsupported` |
| `options` | 其他传给 `new TonConnect()` 的参数（如 `storage`） |

- 钱包列表由 TON Connect 远程下发，第一次 `wallets('ton')` 时开始加载
- 一个 TonConnect 实例同时只能连一个钱包：连接另一个 TON 钱包时会先断开原来的
- 发交易用 `connection.provider.sendTransaction(...)`，注意 `validUntil` 的单位是**秒**
- `signMessage` 只返回签名；TON Connect 签的内容还包括地址、时间戳和域名，后端要验签时直接调用 `connection.provider.signData({ type: 'text', text })` 拿完整结果

## 连接模式、恢复和持久化

### 连接模式

```ts
createWallet({ connectors })                    // 默认 'single'
createWallet({ connectors, mode: 'multi' })
```

- `'single'`（默认）：同一时间只连一个钱包。新钱包连接成功后断开原来的（哪怕在另一条链上；用户拒绝时原来的保持不变），刷新后恢复这个钱包。适合大多数 dapp：界面上只有一个“当前钱包”
- `'multi'`：每条链各连一个钱包（比如 EVM 用 MetaMask、Solana 用 Phantom，同时可用），`connect` 把新连接设为当前钱包，`setActive(namespace)` 切换当前钱包，`getAddress(namespace)` 取某条链的地址；刷新后全部恢复

两种模式下，状态都是一次切换到位：换钱包时不会出现“没有连接”的中间状态（不会让订阅者误以为用户退出了），然后再通知旧钱包断开。

### 同时发起多次连接

比如用户连点了两个钱包：同一条链上（`'single'` 模式下是所有链之间），先完成的先生效，后完成的替换它；如果较新的那次已经生效，较早的那次作废，抛 `superseded`（不会断开钱包）。较新的那次失败时不影响较早的。

### 取消连接

所有链都可以传 `signal`：

```ts
const controller = new AbortController()
wallet.connect('evm', 'io.metamask', { signal: controller.signal })
controller.abort()       // 立即以 user_rejected 结束；之后钱包里再同意也不会生效
```

### 刷新后自动恢复

`createWallet` 在浏览器里创建后会自动静默恢复上次的连接（`autoConnect: false` 关闭，之后可以自己调用 `wallet.restore()`），`await wallet.ready` 等它完成：

- 用的是不弹窗的方式：EVM 的 `eth_accounts`、Wallet Standard 的 silent 连接、Tron 钱包已授权的地址、TON Connect 自己存的会话；不会在页面加载时切链
- 钱包明确表示不再授权（没有账户、用户撤销了授权、钱包锁着）时删掉记录；网络出错、SDK 加载失败、插件在等待时间内没出现（可能只是加载慢）、超时时保留记录，下次刷新再试
- 每条链单独计时（`restoreTimeout`，默认 8 秒）：超时后 `status` 照常变成 `'ready'`，不被最慢的链拖住；之后恢复成功的照样接上（`connect` 事件）
- 恢复期间用户自己连接或断开了的，以用户的操作为准

### 持久化

默认存在 `localStorage` 的 `w3lib:wallet`，只存钱包 id、地址和链，不存任何密钥：

```ts
createWallet({ connectors, storageKey: 'my-app:wallet' })   // 换个 key
createWallet({ connectors, storage: null })                  // 不持久化（刷新后不恢复）
createWallet({ connectors, storage: sessionStorage })        // 或者任何有 getItem / setItem / removeItem 的对象
```

`'multi'` 模式下，这个页面没配置的链的记录原样保留（别的页面可能配置了）。

## 错误处理

所有方法抛出的都是 `WalletError`，按 `code` 处理：

```ts
import { WalletError } from '@w3lib/wallet'

try {
  await wallet.signMessage('hello')
} catch (err) {
  if (err instanceof WalletError && err.code === 'user_rejected') return   // 用户拒绝：不用提示
  throw err
}
```

| code | 含义 | 建议 |
| --- | --- | --- |
| `user_rejected` | 用户在钱包里拒绝 / 关闭了请求，或取消了连接 | 静默处理 |
| `pending_request` | 钱包里已经有一个同类请求在等处理（MetaMask -32002、TronLink 4000） | 提示用户打开钱包 |
| `not_installed` | 钱包没安装 / 没检测到 | 引导下载（`downloadUrl`） |
| `not_connected` | 这条链没有连接钱包 | 引导连接 |
| `unsupported_chain` | 钱包没有这条链，且没有在 `evm({ chains })` 里提供链的信息 | 在 `chains` 里加上这条链 |
| `unsupported` | 不支持的操作（钱包不支持签名消息、没配置这条链 / WalletConnect、管理器已 `destroy`） | |
| `superseded` | 较新的一次连接已经生效，这次连接的结果作废 | 静默处理 |
| `unknown` | 其他错误 | `err.cause` 是钱包的原始错误 |

`isUserRejected(err)` 能识别各钱包、各库的原始“用户拒绝”错误（4001、`ACTION_REJECTED`、“User rejected”、“Confirmation declined”…），自己调用钱包（比如用 `connection.provider` 发交易）时也可以用；`toWalletError(err)` 把任意钱包错误转成 `WalletError`。

## 移动端

手机浏览器里没有插件钱包，两种办法（自带弹窗都已经处理）：

1. 扫码 / 跳转：WalletConnect、TON 的手机钱包，`onDisplayUri` 收到的链接在手机上可以直接 `location.href = uri`
2. 跳到钱包 App 的内置浏览器打开当前页面（那里有注入的钱包，可以直接连接）：

```ts
import { isMobileBrowser, openInWalletUrl } from '@w3lib/wallet'

const injected = wallet.wallets('evm').filter((w) => w.type === 'injected' && w.installed)
if (isMobileBrowser() && injected.length === 0) {
  location.href = openInWalletUrl('metamask')
}
```

`openInWalletUrl(wallet, url?, options?)`：

- `wallet`：`'metamask' | 'okx' | 'bitget' | 'trust' | 'coinbase' | 'tokenpocket' | 'phantom' | 'solflare' | 'tronlink'`
- `url`：要打开的页面，默认当前页面
- `options`：`{ ref?, trustCoinId?, chain? }`：`ref` 是 Phantom / Solflare 要求的来源（默认页面的 origin）；`trustCoinId` 是 Trust Wallet 打开时的网络（SLIP-44 编号，默认 60 即 Ethereum）；`chain` 是 TokenPocket 打开时的网络（如 `'BSC'`、`'TRON'`）

链接格式来自各钱包的官方文档。https 的链接在没装 App 时会跳到下载页；`tokenpocket`、`tronlink` 只有自定义协议，没装时没有反应。

## 配合批量写操作

`connection.provider` 可以直接用在 `@w3lib/evm-batch-call/write`、`@w3lib/solana-batch-call/write` 里：

```ts
import { BrowserProvider } from 'ethers'
import type { Eip1193Provider } from '@w3lib/wallet/evm'

// EVM：EIP-1193 provider → ethers Signer
const signer = await new BrowserProvider(wallet.getConnection('evm')!.provider as Eip1193Provider).getSigner()
await batchTransfer(evmProvider, signer, recipients)

// Solana：Wallet Standard 钱包，一批交易钱包只确认一次
await batchTransfer(solanaClient, wallet.getConnection('solana')!.provider as never, recipients)

// Tron：钱包注入的 tronWeb
await batchTransfer(tronProvider, wallet.getConnection('tron')!.provider as never, recipients)
```

## API 一览

### `createWallet(config)`

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `connectors` | 必填 | 各条链的连接器：`evm()`、`solana()`、`sui()`、`tron()`、`ton()`，每条链最多一个 |
| `mode` | `'single'` | `'single'` 同一时间只连一个钱包；`'multi'` 每条链各连一个 |
| `storage` | `localStorage` | 持久化存储；`null` 不持久化 |
| `storageKey` | `'w3lib:wallet'` | 存储的 key |
| `autoConnect` | `true` | 创建后自动恢复上次的连接（只在浏览器里） |
| `restoreTimeout` | `8000` | 每条链恢复最多等多久（毫秒） |

### 返回的 `wallet`

| 成员 | 说明 |
| --- | --- |
| `address` | 当前钱包的地址，没连接时 `null` |
| `connected` | 有没有连接 |
| `chainId` | 当前钱包所在的链，没连接时 `null` |
| `connection` | 当前钱包的连接，没连接时 `null` |
| `ready` | 自动恢复完成时 resolve 的 Promise（不会 reject） |
| `namespaces` | 配置了的链，如 `['evm', 'solana']` |
| `getState()` | 整个状态（`address`、`connection`、`connections`、`active`、`status`） |
| `on(type, handler)` | 只订阅某一种事件 `(event, state) => void`，返回取消函数 |
| `subscribe(listener)` | 订阅所有变化 `(state, event) => void`，返回取消函数 |
| `wallets(chains?)` | 钱包列表，可按一条 / 几条链过滤（传了没配置的链抛 `unsupported`）；每项带 `connected`、`connect()` |
| `watchWallets(listener, chains?)` | 监听钱包列表（同样可按链过滤），立即调用一次，返回取消函数 |
| `walletGroups(chains?)` / `watchWalletGroups(listener, chains?)` | 按钱包合并的列表（先选钱包，再选链），每项带 `chains`、`installedChains`、`connect(namespace?)` |
| `connect(item, options?)` / `connect(namespace, walletId, options?)` | 连接，`options`：`{ chainId?, signal?, onDisplayUri? }`，返回 `Connection` |
| `getAddress(namespace?)` | 某条链（默认当前）的地址 |
| `getConnection(namespace?)` | 某条链（默认当前）的连接 |
| `signMessage(message, namespace?)` | 签名一段文本，默认当前钱包 |
| `switchChain(chainId, namespace = 'evm')` | 切链（只有 EVM） |
| `setActive(namespace)` | 切换当前钱包（这条链必须已连接） |
| `disconnect(namespace?)` / `disconnectAll()` | 断开 |
| `restore()` | 手动恢复（`autoConnect: false` 时用），多次调用共用一次 |
| `destroy()` | 移除所有监听（不断开钱包），之后不能再用 |

### 子路径

| 子路径 | 导出 |
| --- | --- |
| `@w3lib/wallet` | `createWallet`、`WalletError`、`isUserRejected`、`toWalletError`、`groupWallets`、`walletKey`、`isMobileBrowser`、`openInWalletUrl`、类型 |
| `@w3lib/wallet/evm` | `evm`、`DEFAULT_EVM_WALLETS` |
| `@w3lib/wallet/solana` / `/sui` | `solana`、`DEFAULT_SOLANA_WALLETS`；`sui`、`DEFAULT_SUI_WALLETS` |
| `@w3lib/wallet/tron` | `tron` |
| `@w3lib/wallet/ton` | `ton`、`friendlyAddress` |
| `@w3lib/wallet/chains` | `ethereum`、`bsc`、`polygon`、`arbitrum`、`optimism`、`base`、`avalanche`、`linea`、`zksync`、`opbnb`、`sepolia`、`bscTestnet` |
| `@w3lib/wallet/ui` | `createWalletModal` |
| `@w3lib/wallet/vue` | `useWallet`、`useWallets`、`useWalletGroups` |
| `@w3lib/wallet/react` | `useWallet`、`useWallets`、`useWalletGroups` |

## 体积与运行环境

esbuild 打包、minify（不含按需加载的 SDK）：

| 用到的 | 大小 | gzip |
| --- | --- | --- |
| 只用核心 | 约 10KB | 3.9KB |
| 核心 + EVM | 约 18KB | 6.6KB |
| 五条链全部 | 约 35KB | 11.9KB |
| 核心 + 自带弹窗（含二维码） | 约 31.5KB | 12.2KB |
| 一条内置链 | 约 0.2KB | |
| Vue / React hook | 约 0.5–1KB | |

现代浏览器。在 Node / SSR 里可以创建（不会访问 `window`、不会加载 SDK），但没有钱包可连。
