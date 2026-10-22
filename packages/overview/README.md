# @w3lib/overview

多链资产总览：给每条链一个地址，一次调用得到合计、分链明细、跨链合并的资产、LP 仓位和授权风险摘要。
薄薄的一层，建立在 [`@w3lib/evm-batch-call`](../evm-batch-call)（EVM、Tron）、[`solana-batch-call`](../solana-batch-call)、[`sui-batch-call`](../sui-batch-call)、[`ton-batch-call`](../ton-batch-call) 已有的 `/price`（`getPortfolio`）、`/lp`、`/approvals` 之上，不重新实现任何读取逻辑。

- **不依赖任何链包**：链包都是可选的 peerDependencies，由应用传 `loaders` 按需加载，打包时只会带上应用用到的链包。单独引入本包约 14KB（gzip 约 7KB，其中约一半是内置的代币地址表）
- **部分失败不影响整体**：一条链出错（节点挂了、超时）只让那条链 `status: 'error'`，其余链照常返回；LP、授权读取失败时降级为 `partial`，原因在 `warnings`（带 LP 失败后去掉 LP 重试一次；去掉 LP 也失败说明是节点的问题，报这一次的错误，不再重试）
- 可取消、限制并发、每条链单独超时、`onChain` 逐条回调（界面可以边查边渲染）

## 安装

```bash
pnpm add @w3lib/overview @w3lib/evm-batch-call @w3lib/solana-batch-call   # 用到哪些链就装哪些链包（EVM 还需要 ethers）
```

## 使用

```ts
import { getOverview } from '@w3lib/overview'

const overview = await getOverview(
  {
    evm: { address: '0x…', chains: [1, 56, 8453] },
    tron: { address: 'T…' },
    solana: { address: '…' },
    sui: { address: '0x…' },
    ton: { address: 'UQ…' },
  },
  {
    // 只写用到的；写成 `() => import(…)` 的形式，打包工具才能只带上这些链包
    loaders: {
      evm: () => import('@w3lib/evm-batch-call/price'),          // EVM 和 Tron 共用
      solana: () => import('@w3lib/solana-batch-call/price'),
      sui: () => import('@w3lib/sui-batch-call/price'),
      ton: () => import('@w3lib/ton-batch-call/price'),
    },
    lp: true,                                    // 同时计入 LP 仓位（默认不计入）
    approvals: true,                             // 授权风险摘要（默认不检查）
    onChain: (chain) => render(chain),           // 每条链完成时回调
    signal: controller.signal,
  },
)

overview.totalUsd          // 合计（没有价格的不计入）
overview.byChain           // [{ chain: 'evm:1', status, totalUsd, tokensUsd, lpUsd, tokens, lp, unpriced, approvals?, warnings, ms }]，按价值排序
overview.tokens            // 跨链合并的资产：[{ key: 'USDC', amount, usd, price, chains: [{ chain, token, formatted, value }] }]
overview.lp                // 全部 LP 仓位（统一格式，raw 是链包的原始仓位）
overview.approvals         // { total, unlimited, unknownSpender, items }
overview.errors            // [{ chain: 'solana', address, message }]（多账户合计时还有 account）
overview.timings           // { totalMs, chains: { 'evm:1': 812, … } }；同一条链出现多次（多账户）时键是 'evm:1@0x…'
```

没传 `loaders` 时（Node 脚本、服务端）会按包名动态导入（`@w3lib/evm-batch-call/price` 等），包没装时那条链报错，错误信息里有该写的 loader。`approvals` / `discover: true` 还需要 `evmApprovals`（`/approvals`）、`solanaApprovals`、`evmOwner`（`/owner`）这几个 loader。

链键：EVM 是 `evm:<chainId>`，其余是 `tron`、`solana`、`sui`、`ton`。

## 代币从哪来

| 链 | 来源 |
| --- | --- |
| Sui、TON | 节点直接列出全部持仓 |
| Solana | 不传 `tokens`：先列出全部持仓（需要支持 `getTokenAccountsByOwner` 的节点，用 `node: { provider }` 传自己的）；节点不支持时退回内置的主要代币列表并在 `warnings` 里说明。`tokens: [...]` 指定 mint，`'default'` 直接用内置列表 |
| EVM、Tron | 节点没法列出持仓，查三类代币的并集：内置的主要代币（稳定币、包装主币、主流币，按链核对过：Ethereum、Optimism、BNB Chain、Polygon、Base、Arbitrum、Avalanche、Tron）；应用的列表（`evm.tokens: { 1: [...] }`、链配置里的 `tokens`）；发现（`discover`）。主币总是查 |

```ts
evm: {
  address,
  chains: [1, { chainId: 56, tokens: [myToken], node: { provider: 'https://my-bsc-node' }, defaults: false }],
  tokens: { 1: [pepe] },                         // 按链给应用的代币列表
  discover: ({ chainId, address }) => myIndexer(chainId, address),   // 或 true：用 /owner 的 getOwnerTokens（公开代币列表，尽力而为）
}
```

不在内置表里的链只查主币 + 应用给的代币。

## 配置

输入每条链：`address`；`node`（传给链包每个函数的节点参数：`provider`、`cluster` / `network`、`apiKey`、`fetch` 等，EVM 的 `chainId` 自动带上）；`portfolio`（只传给 `getPortfolio` 的其他选项，如 `sources`、`includeScam`、Sui 的 `coinTypes`、Solana 的 `lp: { mints, pools }`）。

选项：

| 选项 | 说明 |
| --- | --- |
| `loaders` | 链包的模块加载器，见上 |
| `lp` | `true` 或链包 `getPortfolio` 的 lp 参数。默认 false：LP 要多读很多合约；Solana 免费公共节点上要自己的节点或 `portfolio.lp` 传 mints / pools，否则降级成没有 LP。某条链的 `portfolio.lp` 优先：对象与全局的合并（`lp: true` 不会覆盖它），`false` 关掉这条链，只在链上设了也算开了 LP（失败同样降级） |
| `approvals` | `true` 或 `{ maxTokens, options }`：检查持有的代币（价值最高的 30 个）的授权，EVM / Tron 的 ERC20、Permit2、NFT，Solana 的 delegate，Sui / TON 没有授权概念不查 |
| `minUsd` | 价值低于它的代币不列出（不影响合计；大于 0 时没有价格的也不列出）。链上的 `portfolio.minUsd` 优先。在本库里过滤，授权检查仍看全部持仓（零头、没有价格的代币上的授权一样危险） |
| `maxUnknownTokenUsd` | 内置表里不认识的代币单个价值超过它（默认 100 万美元）就当价格不可信，不计入合计、算作没有价格，链的 `warnings` 里有说明；防止薄池子的垃圾币把总值抬高。`Infinity` 关闭，LP 仓位不受影响 |
| `sources` | 各链的价格源 `{ evm, solana, sui, ton }`（链包 `/price` 的 PriceSource，类型因链而异）；Tron 用 `tron`，没有时用 `evm` 的 |
| `concurrency` | 同时查多少条链，默认 4 |
| `chainTimeoutMs` | 单条链的超时，默认 60000，超时按出错处理 |
| `signal` | 取消：`getOverview` 抛出 `signal.reason` |
| `mergeBySymbol` | 同符号的代币也合并（默认只合并认识的资产） |
| `onChain`、`onPriceError`、`fetch` | 回调、自定义 fetch |

## 跨链合并

`overview.tokens` 把各链上的同一个资产合成一项（数量、美元价值求和，`price` 是有价格部分的加权平均）：

- 内置表里认识的代币用资产 id 合并：USDC（含桥接的 USDC.e、USDbC）、USDT、DAI、WETH……跨 EVM / Tron / Solana / Sui / TON 都认；主币按 symbol 合并（Ethereum、Base、Arbitrum、Optimism 的 ETH 是一项）；不在链信息表里、没有 symbol 的链的主币按链区分（`evm:250:native`），不合并。WETH 与 ETH、WBTC 与 cbBTC 不合并
- 不认识的代币**不按 symbol 合并**（防止同名假币混进真币），`key` 是 `<链>:<地址>`；确实要合并时传 `mergeBySymbol: true`
- 数量是按精度换算后的浮点数，只用于展示

## 授权风险

`approvals` 里只统计有效的授权（额度为 0、Permit2 已过期、NFT 未授权的不算）：`unlimited` 是无限授权（ERC20 / Permit2 额度 ≥ 2^96，NFT 的 `setApprovalForAll` 授权整个合集，Solana delegate 额度 ≥ 2^63）；`unknownSpender` 是被授权方不在已知列表里。注意 EVM 默认只检查已知的 Router / 聚合器 / 市场（`knownSpenders`），所以默认几乎不会有 `unknownSpender`，要发现未知的被授权方，用 `approvals: { options: { pairs: [...] } }` 或链包的 `scanApprovals`；Solana 没有已知列表，所有 delegate 都算未知。

## 连接钱包后查询

本包不管钱包连接；用 [`@w3lib/wallet`](../wallet) 连上之后，把每条链的地址放进输入就行。`mode: 'multi'` 时每条链可以各连一个钱包（EVM 用 MetaMask、Solana 用 Phantom…），连了哪条链就查哪条链：

```ts
import { getOverview, type OverviewInput } from '@w3lib/overview'
import { createWallet } from '@w3lib/wallet'
import { evm } from '@w3lib/wallet/evm'
import { solana } from '@w3lib/wallet/solana'
import { ton } from '@w3lib/wallet/ton'

const wallet = createWallet({ mode: 'multi', connectors: [evm(), solana(), ton({ manifestUrl, load: () => import('@tonconnect/sdk') })] })
// …用户连接（wallet.connect 或 @w3lib/wallet/ui 的弹窗）后：
const address = (ns: 'evm' | 'tron' | 'solana' | 'sui' | 'ton') => wallet.getConnection(ns)?.address
const input: OverviewInput = {}
if (address('evm')) input.evm = { address: address('evm')!, chains: [1, 56, 8453] }
if (address('solana')) input.solana = { address: address('solana')! }
if (address('ton')) input.ton = { address: address('ton')! }      // TON Connect 给的是 UQ… 格式，直接可用
const overview = await getOverview(input, { loaders })
```

钱包切换账户、断开时用 `wallet.subscribe` 重新组装输入。demo 的“多链总览”页有“连接钱包”：连上的地址自动填进对应的栏，断开时只清空钱包填的栏。

## 助记词 → 多链总览（`@w3lib/overview/mnemonic`）

从助记词在本地推导各链地址，再查所有地址的总览。单独的子路径，主入口不引入，只用 `getOverview` 时打包不会带上这里的加密库（本子路径约 116KB，gzip 约 47KB，主要是 `@noble/curves` 的 secp256k1 + ed25519 和 BIP-39 词表）。

```ts
import { deriveAddresses, getDerivedOverview, getOverviewFromMnemonic } from '@w3lib/overview/mnemonic'

// TON 钱包地址用 ton-batch-call 的代码算（没传时按包名动态导入）
const tonLoaders = { tonWrite: () => import('@w3lib/ton-batch-call/write'), tonCore: () => import('@w3lib/ton-batch-call') }

const a = await deriveAddresses(mnemonic, { accounts: 3, passphrase: '', chains: ['evm', 'tron', 'solana', 'sui', 'ton'], loaders: tonLoaders })
a.evm               // ['0x…', '0x…', '0x…']（EIP-55 大小写）
a.paths.evm         // ["m/44'/60'/0'/0/0", …]；tron / solana / sui 同理
a.ton               // [{ index: 0, v4r2: 'UQ…', v5r1: 'UQ…', scheme: 'bip39', path: "m/44'/607'/0'" }, …]
a.kind              // { bip39: true, ton: false }
a.warnings          // 如 TON 链包加载不了、TON 格式助记词只有一个账户

// 推导完就可以丢掉助记词，再查总览（账户依次查；选项同 getOverview，加上各链的配置）
const r = await getDerivedOverview(a, { evm: { chains: [1, 56] }, loaders: { ...loaders, ...tonLoaders }, onAccount: (acc) => render(acc) })
r.total             // 所有账户合计（Overview，byChain 里同一条链可能出现多次，按 address 区分）
r.accounts          // [{ index, addresses: { evm, tron, solana, sui }, ton: [{ version: 'v4r2', scheme: 'bip39', address, status: 'active' }], overview }]

// 一步完成
await getOverviewFromMnemonic(mnemonic, { accounts: 3, evm: { chains: [1, 56] }, loaders: { ...loaders, ...tonLoaders } })
```

| 链 | 派生路径（第 i 个账户） | 地址 |
| --- | --- | --- |
| EVM | `m/44'/60'/0'/0/i`（BIP-32 secp256k1） | keccak256(公钥) 后 20 字节，EIP-55 |
| Tron | `m/44'/195'/0'/0/i` | 同上加 `0x41`，Base58Check（`T…`） |
| Solana | `m/44'/501'/i'/0'`（SLIP-0010 ed25519，同 Phantom） | 公钥的 Base58 |
| Sui | `m/44'/784'/i'/0'/0'`（SLIP-0010 ed25519） | blake2b-256(0x00 ‖ 公钥) |
| TON | `m/44'/607'/i'`（SLIP-0010 ed25519，同 Trust Wallet）；TON 格式的 24 词助记词用它自己的密钥（只有账户 0）；两种都合法时两种都推导（`scheme: 'bip39' / 'ton'`） | 主网、默认 wallet_id 的 v4r2 和 v5r1 钱包，不可回弹格式 `UQ…` |

- `accounts` 默认 1，最多 20；`passphrase` 是 BIP-39 密码（第 25 个词）；`chains` 只推导这些链
- 校验：词数、BIP-39 英文词表、校验和；不是合法 BIP-39 但是合法的 TON 格式助记词（不带密码）时只推导 TON；两种都合法时（约 1/256 的 24 词 BIP-39 助记词）TON 两种都推导、查询时都参与选择，`warnings` 有说明
- 查询时 TON 用哪个钱包：读两个版本的链上状态，查已部署或有余额的（两个都是时都查、合并进同一个账户）；都没有时查 v5r1；读不到状态（或 `tonCore` 加载不了）时两个都查，`r.warnings` 里有说明
- EVM 没传 `evm.chains` 时查 Ethereum、BNB Chain、Base；`chains: []` 时不查 EVM（`r.warnings` 里有说明）

**安全**：

- 只在本地推导：助记词、种子、私钥只存在于函数的局部变量里，不记录、不保存、不发到网络；发给节点的只有地址
- 返回值只有地址和派生路径，没有私钥、种子
- 用完的种子、私钥字节数组会清零（尽力而为：JS 的字符串没法清零，库内部的中间值也不一定都能清掉）
- 校验失败的错误信息不含助记词（只有词数、出错的词的位置）
- 加密全部用审计过的库：`@scure/bip39`、`@scure/bip32`、`@noble/curves`、`@noble/hashes`、`@scure/base`；ed25519 链的 SLIP-0010 只是按规范组合 HMAC-SHA512，用 SLIP-0010 的测试向量核对过
- 应用自己也要注意：不要把助记词放进 URL、localStorage、日志、错误上报；网页里输入助记词有被插件、XSS 读取的风险，只适合测试助记词或离线环境

测试向量：EVM / Tron / Solana 用公开的 `abandon … about`；Sui 用 MystenLabs SDK 的测试向量（与 Rust keytool 一致）；TON 用 @ton/crypto 的助记词向量、Trust Wallet wallet-core 的 v4r2 / v5r1 地址向量；SLIP-0010 的官方向量。

## 局限

- EVM / Tron 看不到内置表和应用列表之外的代币（链上无法只靠节点列出持仓）；`discover: true` 依赖第三方公开代币列表，尽力而为
- 价格只用于估值：用链包的价格源（DefiLlama + 链上池子），没有价格的代币不计入合计，计入 `unpriced`
- 慢的链：TON 免费额度每秒 1 次请求，杂币多的地址要几十秒；用 `onChain` 逐条渲染，或传 `node: { apiKey }`
- 每条链的 `node` 同时用于余额、LP、授权调用；不同链的节点各自配置，没有全局节点参数
