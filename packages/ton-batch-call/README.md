# @w3lib/ton-batch-call

TON 批量读取和批量写操作库：TON / Jetton 余额、Jetton 信息、NFT、钱包状态；一对多转账、多钱包归集、批量执行交易；STON.fi / DeDust 的 LP 仓位和加减流动性。通过 **toncenter v3 索引器**（或兼容的自建 [ton-indexer](https://github.com/toncenter/ton-indexer)），多个地址合成一个请求，自动限频、多节点故障切换。不依赖 TON SDK，浏览器和 Node（≥ 20.19）都能用。

```sh
pnpm add @w3lib/ton-batch-call
```

只做查询时打包后约 13KB（minify，gzip 约 5KB），不带任何依赖；写操作在子路径 `/write`（见[批量写操作](#批量写操作)）。

**在线 demo**：<https://web3-lib.github.io/libs/ton/>（余额、多个地址、Jetton 信息、LP 仓位、添加 / 移除流动性（报价，用 TON Connect 连接钱包后可以发送）、NFT，显示每次查询实际发出的 toncenter 请求）。本地运行：`pnpm --filter @w3lib/ton-batch-call demo`（http://localhost:5176）

## 快速上手

```ts
import { NATIVE_TON, TonClient, getBalances } from '@w3lib/ton-batch-call'

const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'

// 快捷函数：默认主网 toncenter（没有 API Key 时每秒 1 次请求，自动排队）
await getBalances(owner)                                        // TON + 持有的全部 Jetton（余额为 0 的不返回）
await getBalances(owner, { tokens: [NATIVE_TON, USDT], apiKey })
// [{ token: 'TON', native: true, wallet: null, balance: '1500000000', decimals: 9, formatted: '1.5', success: true },
//  { token: 'EQCxE6…', native: false, wallet: 'EQAmJs…', balance: '2500000', decimals: 6, formatted: '2.5', success: true }]

const ton = new TonClient('https://toncenter.com/api/v3', { apiKey })
await ton.multiBalances([{ owner: a }, { owner: b, tokens: [USDT] }])   // 多个地址合成一次请求（每 100 个一次）
await ton.tonBalances([a, b, c])                                // 只查 TON
await ton.jettons([USDT])                                       // 名称、symbol、精度、图片、总供应量、是否诈骗代币
await ton.walletStates([a])                                     // 钱包类型（v4r2 / v5r1 …）、seqno、部署状态
await ton.nfts(owner, { collection })                           // 持有的 NFT（含正在出售的）
```

| 方法 | 快捷函数 | 说明 |
| --- | --- | --- |
| `balances(owner, tokens?, opts)` | `getBalances(owner, { tokens })` | 不传 `tokens` 时返回 TON 和持有的全部 Jetton；传了时与它一一对应（`NATIVE_TON` 表示 TON，其余是 Jetton 主合约地址） |
| `multiBalances(queries)` | `getMultiBalances(queries)` | 所有地址的 Jetton 合成每 100 个地址一次 `jetton/wallets`，TON 余额合成 `accountStates` |
| `tonBalances(addresses)` | `getTonBalances(addresses)` | `accountStates`；从没用过的地址余额 0、`status: 'nonexist'` |
| `jettons(masters)` | `getJettons(masters)` | `jetton/masters` + 索引器的元数据 |
| `walletStates(addresses)` | `getWalletStates(addresses)` | `walletStates` |
| `nfts(owner, { collection, limit })` | `getNfts(owner)` | `nft/items`，自动翻页；名称和图片取自索引器的元数据，没有索引到时为 `null`（`contentUri` 是链下元数据地址） |

结果的约定：

- 地址都输出为用户友好格式：索引器给出的格式优先（钱包是不可回弹的 `UQ…`，合约是 `EQ…`），测试网是 `kQ…` / `0Q…`；输入任意格式都可以（原始 `0:…`、`EQ…`、`UQ…`）
- 余额是最小单位的十进制字符串；Jetton 精度取自元数据，没写时按 TEP-64 的默认值 9
- `symbol: true` 时返回 `symbol` 和 `isScam`（索引器标记的诈骗代币，常见的是仿冒 USDT 的空投）
- 失败项 `success: false`，`error` 为 `'invalid-address'` 或 `'not-found'`（不是 Jetton 主合约）；查全部代币时 owner 非法直接报错
- Jetton 元数据进程内缓存。元数据在链下、索引器还没读到的新 Jetton 不知道精度：`decimals` 暂按 9，带 `decimalsUnknown: true`（不缓存）；写操作和加流动性对它不接受 `formatted`，要传最小单位的 `amount`
- 地址工具：`parseTonAddress`、`toRawAddress`、`toFriendlyAddress`（`bounceable` / `testOnly` / `urlSafe`）、`sameTonAddress`、`isValidTonAddress`

## 批量写操作

子路径 `@w3lib/ton-batch-call/write`：只做查询时打包不会带上这部分代码。钱包合约 v4r2 / v5r1（W5），交易在本地编码（Cell、BOC 与 @ton/core 逐字节一致），私钥签名用运行环境的 WebCrypto（Ed25519）。

```ts
import { NATIVE_TON, TonClient } from '@w3lib/ton-batch-call'
import { batchCall, batchCollect, batchTransfer, beginCell, commentCell } from '@w3lib/ton-batch-call/write'

const ton = new TonClient('https://toncenter.com/api/v3', { apiKey })   // 写操作请求较多，建议带 API Key；测试网用 testnet.toncenter.com（按 URL 判断网络，也可以传 network）

// 一对多转账：多个收款人打包进同一笔交易（v5r1 每笔最多 255 条消息，v4r2 最多 4 条），TON 和 Jetton 可以混在一起
await batchTransfer(ton, mnemonic, [
  { to: a, formatted: '1.5' },                                 // 默认 TON（options.token）
  { to: b, token: USDT, formatted: '20', comment: 'order 42' },  // 交易所充值的 memo 写在 comment
])

// 归集：多个钱包 → 一个地址。Jetton 全部转走，包含 TON 时最后把剩下的 TON 全部转走（模式 128）
await batchCollect(ton, [m1, m2, m3], hotWallet, { tokens: [USDT, NATIVE_TON], gasFunder: gasMnemonic })

// 批量执行交易：每个调用是一个钱包的一笔交易
await batchCall(ton, [
  { from: m1, messages: [{ to: pool, value: 300_000_000n, body: swapBody }] },   // body：Cell 或 BOC 的 base64
  { from: m2, messages: [{ to: a, value: 1_000_000n, bounce: false, body: commentCell('hi') }] },
])
```

**钱包**：24 个词的 TON 助记词、私钥（32 字节种子或 64 字节 secretKey，十六进制或 `Uint8Array`）、自定义签名器 `{ publicKey, sign(hash) }`（KMS / 硬件钱包），或 TON Connect（@tonconnect/sdk 的 `TonConnect`、@tonconnect/ui 的 `TonConnectUI`，已连接）。BIP-39 助记词（多链钱包的 12 / 24 词）和带密码的 TON 助记词不支持。

- 钱包版本：私钥钱包不指定时，算出 v5r1 和 v4r2 两个地址，用已部署（或有余额）的那个，两个都有时用余额多的，都没有时用 v5r1；指定用 `{ key, version: 'v4r2', walletId }`。`resolveWallets(ton, [key])` 可以先看地址、版本、seqno
- 钱包没部署时（只收过款），第一笔交易自动带上 StateInit 部署
- TON Connect：每笔交易请求一次签名（钱包自己发送），按返回的 BOC 查结果；一笔最多发几条消息看钱包声明的 `maxMessages`（默认 4）；不能指定发送模式，所以不能转走全部余额（归集 TON 时这一项 `failed`）。用户拒绝时为 `failed`，`error` 为 `'rejected by user'`；钱包已经发出、但返回的 BOC 读不出来时为 `pending`（可能已上链，同一钱包后面的交易不再发）

**发送流程**：
- 同一钱包的交易依次执行（每笔用下一个 seqno，等上一笔上链再发下一笔），不同钱包并发（`concurrency`，默认 4）
- 先模拟（toncenter 的 emulateTrace，模拟整条交易链）：钱包拒绝、TON 不够、Jetton 余额不够（会被退回）等直接 `failed`，不发送、不花手续费；`simulate: false` 关闭；模拟服务不可用（节点问题，或模拟服务自己的限制等不是钱包拒绝的错误）时跳过模拟照常发送。模拟结果不完整（交易链太长被截断）时只看钱包交易和已有的部分。已部署的 v4r2 / v5r1 TON Connect 钱包在请求签名前也会模拟（用空签名、不检查签名；这样模拟被钱包拒绝时只跳过模拟，不判失败）
- 发送后按外部消息的规范化哈希（TEP-467）查交易链，等整条链走完（Jetton 转账要经过几个合约）。结果逐条消息判断：W5 和默认的发送模式（3）会跳过发不出的消息（TON 不够等），同一笔里可能有的成功有的失败，所以 `batchTransfer` 每个收款人各自是 `confirmed` 或 `reverted`（没发出、或后面的合约失败退回）；钱包交易本身失败时整笔 `reverted`
- 过了有效期（`validFor`，默认 60 秒）30 秒后还没查到：按节点上（get 方法，不经过索引器）钱包的 seqno 判断，没变说明没上链，私钥钱包重新签名再发（`retries`，默认 1），用完重试次数时为 `failed`；seqno 变了说明已执行、只是还没索引到，继续等（超时为 `pending`）。重发后会等到重发的那条也过期、能判断结果为止（可能超过 `timeout`），不会在它还能上链时返回。查结果一直出错时（如 API Key 不对），超时的 `pending` 里带最后一次的错误。重发后同一个 seqno 的几条消息都会查（最多一条能执行），原来那条晚到时结果就是它；TON Connect 钱包不重发，按钱包签名的有效期判断
- 同一钱包前面的交易失败时，后面的为 `skipped`
- `dryRun` 只模拟。同一钱包的多笔交易各自按当前状态模拟（模拟不出前一笔执行后的状态）

**转账和归集的细节**：
- Jetton 转账发给发送者自己的 Jetton 钱包，附带 `jettonGas`（默认 0.05 TON），多余的退回发送者；`forwardAmount`（默认 1 nanoTON）让收款人收到 `transfer_notification`（交易所靠它识别充值）。备注放在通知里
- TON 转账：收款地址没部署时不可回弹（否则会被退回）；已部署时按地址格式的标志（UQ… 不可回弹，EQ… 和原始格式可回弹）
- 发送前检查余额（含 Jetton gas，每笔交易预留 0.01 TON、每条消息 0.001 TON 的手续费），不够时直接报错；`checkBalance: false` 关闭
- 归集：TON 上没有代付手续费，Jetton 转账要用子钱包自己的 TON 付 gas。传 `gasFunder` 时先给不够的钱包补上（每个 Jetton `jettonGas` + 手续费，一笔交易补多个钱包，不可回弹），确认后再归集；`tokens` 包含 TON 时补的 TON 剩下的部分也一起归集回来，否则留在子钱包里。结果里的 `funding` 是补 gas 的那笔。不传时这些钱包为 `failed`
- 归集时没指定版本的私钥钱包，持有要归集的 Jetton 的那个版本的地址优先（只收过 Jetton、没部署的 v4r2 充值地址也能找到）
- 归集 TON 用模式 128（扣掉手续费后余额归零）；TON 不到 `minTon`（默认 0.01 TON）且没有 Jetton 的钱包为 `skipped`

**结果**：与输入一一对应，可以直接 `JSON.stringify`：

```ts
{ index: 0, from: 'UQ…', status: 'confirmed', hash: '9a1f…', txHash: '3c0e…', fee: '2731048', error: null }
// batchTransfer 另有 to / token / amount / formatted；batchCollect 另有 to / tokens / funding
```

`status`：`confirmed` / `reverted`（上链但失败，手续费已扣）/ `failed`（没有上链：模拟失败、过期、钱包里拒绝等）/ `sent`（`wait: false`：只发每个钱包的第一笔，后面的为 `skipped`）/ `pending`（等到 `timeout` 还没确认，或钱包交易已确认但后面的消息还在处理）/ `skipped` / `simulated`（`dryRun`）。`hash` 是外部消息的规范化哈希（在 tonviewer 等浏览器里可以搜），`txHash` 是钱包交易的哈希，`fee` 是钱包交易的手续费（不含随消息附带的 TON，Jetton gas 多余的部分会退回）。

**共同选项**（`SendOptions`）：`dryRun`、`simulate`（默认 true）、`validFor`（默认 60 秒）、`wait`（默认 true）、`timeout`（默认 120 秒）、`pollInterval`（默认 3 秒）、`retries`（默认 1）、`concurrency`（默认 4）、`signal`、`onUpdate`。

**工具**：`beginCell` / `Cell`（Builder、Slice、BOC 编解码）、`commentCell`、`jettonTransferBody`、`outMessageCell`、`externalMessageCell`、`stateInitCell`、`contractAddress`、`normalizedMessageHash`、`walletAddress` / `walletInit` / `signedBody`（v4r2 / v5r1）、`mnemonicToSeed`、`resolveTonSigner`、`evaluateTrace`。

**体积**（esbuild 打包、minify，对比只用 `TonClient`）：引入 `batchTransfer` 增加约 36KB（gzip 约 14KB），三个函数都引入增加约 40KB（gzip 约 15KB），其中约 4KB 是依赖（@noble/hashes 的 SHA-256），约 2KB 是钱包合约代码（部署新钱包要用）。

## LP 仓位

子路径 `@w3lib/ton-batch-call/lp`：**STON.fi v1 / v2**、**DeDust** 的 LP Jetton。返回两种代币的数量（撤出全部 LP 能拿到的，LP 份额 × 储备，向下取整）、份额、手续费率，可选美元价值。

```ts
import { getLpPositions, lpPositions } from '@w3lib/ton-batch-call/lp'

await getLpPositions(owner, { prices: true })
// [{ type: 'amm', protocol: 'stonfi-v2', protocolName: 'STON.fi v2', pool: 'EQCG…', lpWallet,
//    token0: { address: 'EQCxE6…', symbol: 'USD₮', decimals: 6 }, token1: { address: 'TON', symbol: 'TON', decimals: 9 },
//    balance, totalSupply, share: 0.0112, amount0, amount1, amount0Formatted, amount1Formatted, reserve0, reserve1,
//    feeBps: 10, poolType: 'constant_product', valueUsd: 55522.3 }, …]
```

**怎么找仓位**：读地址持有的 Jetton，主合约的 admin 是 STON.fi 的 router（v1 的 router，或内置的 50 个 v2 router）、或元数据来自 DeDust 的是候选；再调用 router / DeDust factory 的 `get_pool_address` 核对池子地址（仿冒的 LP 空投过不了这一步）。STON.fi 的代币是 router 的 Jetton 钱包，换成主合约，pTON 显示为 TON。

| 选项 | 说明 |
| --- | --- |
| `protocols` | 只查 `'stonfi-v1'` / `'stonfi-v2'` / `'dedust'` 中的某些，默认全部 |
| `includeClosed` | 返回 LP 余额为 0 的（Jetton 钱包还在），默认 false |
| `stonfiRouters` | 额外认可的 STON.fi v2 router（STON.fi 新部署的 router 还不在内置列表里时） |
| `prices` | `true` 用 DefiLlama，也可以传自己的 `TonPriceSource`；默认不查。价格源出错时美元价值为 null（`onPriceError` 拿到错误） |

- 打包后 `/lp` 约增加 22KB（minify，gzip 约 10KB，含 Cell 编解码和 router 列表）；`/liquidity` 约 45KB（gzip 约 17KB，含 `/write` 的发送代码）
- 读池子时节点出错（限频、超时）直接抛出，不会悄悄少返回仓位；不是池子的（get 方法失败）跳过
- 每个池子 3~6 次 get 方法调用：toncenter 没有 API Key 时每秒 1 次请求，3 个池子约 15~20 秒
- `feeBps` 是交易手续费（万分之一，STON.fi 为 LP + 协议手续费）
- **局限**：质押在 STON.fi / DeDust 农场里的 LP、STON.fi 的 LP account（还没配对的存入）查不到；其他 DEX 暂不支持

## 添加 / 移除流动性

子路径 `@w3lib/ton-batch-call/liquidity`：STON.fi v2 和 DeDust（volatile）添加、移除，STON.fi v1 移除。消息格式与官方 SDK（@ston-fi/sdk 2.7、@dedust/sdk 0.8）相同，发送走 `/write` 的流程（先模拟整条交易链，再发送、等结果），钱包和发送参数也相同。

```ts
import { lpPositions } from '@w3lib/ton-batch-call/lp'
import { addLiquidity, buildAddLiquidity, removeLiquidity } from '@w3lib/ton-batch-call/liquidity'

const [position] = await lpPositions(ton, owner)
await addLiquidity(ton, mnemonic, { position, amount1Formatted: '10' })                // 给一边，另一边按储备比例
await addLiquidity(ton, mnemonic, { protocol: 'dedust', pool, amount0Formatted: '5' })  // 指定池子
await removeLiquidity(ton, mnemonic, { position, percent: 50 })                         // 或 lpAmount

// 只构建：messages 可以交给 batchCall 或 TON Connect
const plan = await buildAddLiquidity(ton, owner, { position, amount0Formatted: '1' })
// { action: 'add', amount0, amount1, lpAmount, minLpOut, messages: [{ to, value, body, bounce }], tonAttached }
```

| | 添加 | 移除 |
| --- | --- | --- |
| STON.fi v2 | 两条消息：Jetton 转给 router（forward 里是 `provide_lp`）/ TON 发给 router 的 pTON 钱包（`ton_transfer`），LP account 收齐两边后铸造 LP | 用户的 LP 钱包 `burn` |
| STON.fi v1 | 不支持（用 v2） | `burn` |
| DeDust | 两条消息：TON 发给原生 vault（`deposit_liquidity`）/ Jetton 转给 Jetton vault，LiquidityDeposit 合约收齐后存入 | `burn` |

- 数量：给一边时另一边按储备比例（向上取整）；两边都给时按给的数量。预计 LP = min(数量 / 储备 × 总量)，`minLpOut` = 预计 × (1 − `slippage`)（默认 0.005），合约按它检查，不够时退款
- 附带的 TON：与官方 SDK 默认值相同（`LIQUIDITY_GAS`：STON.fi Jetton 一边 0.3、TON 一边 0.31 + 存入的 TON，移除 0.8 / v1 0.5；DeDust TON 一边 0.3 + 存入的 TON、Jetton 一边 0.5，移除 0.5），多余的退回
- 结果判断：除了没有失败退回，添加时还要求交易链里 LP 发到了用户的 LP 钱包（DEX 失败时是退款，不是退回），移除时要求用户已有的 Jetton 钱包收到取回的代币
- STON.fi 非 constant_product 的池子（stableswap 等）、DeDust stable 池子估不出 LP 数量：添加时要传 `minLpOut`（计划里的 `lpAmount` 为 null）
- STON.fi v2 的池子要求 router 在内置的 router 列表里（`stonfiRouters` 可以加），池子自己报的 router 不可信；用 pTON v1 的池子不能加 TON
- 移除时按要发 burn 的 LP 钱包在链上的余额算比例
- 移除的数量是按当前储备预计的，合约不检查下限
- 发送前检查余额（存入的数量 + 附带的 TON + 0.02 TON 手续费），`checkBalance: false` 关闭

核对方式：在主网上以真实 LP 持有人的地址模拟整条交易链（emulateTrace）：三个协议的移除、STON.fi v2 和 DeDust 的 TON / 代币池添加。

## 节点

- 节点是 toncenter v3 风格的 URL（`https://toncenter.com/api/v3`、`https://testnet.toncenter.com/api/v3`，或自建 / 服务商的同格式接口），或自己实现的 `TonTransport`（`get` / `post`）；数组时依次故障切换
- 网络（`network`）：不传时按节点 URL 判断（含 `testnet` 的是测试网），不传节点时默认主网。它决定输出地址的格式，以及 v5r1 钱包地址和 TON Connect 请求里的网络 ID
- 写操作的模拟走同一个服务的 `/api/emulate/v1/emulateTrace`（toncenter 提供；自建索引器没有时跳过模拟）
- **限频**：toncenter 没有 API Key 时约每秒 1 次请求，`minInterval` 默认 1100 毫秒（有 `apiKey` 时 0），同一个节点对象的请求自动排队；遇到 HTTP 429 退避重试 `retries` 次（默认 3）。快捷函数复用客户端，共享同一个队列
- 网络错误、超时、5xx、429、401 / 403 换下一个节点，出错的节点冷却 30 秒；其他 4xx（参数错误等）和钱包拒绝外部消息的 500 是请求本身的问题，直接抛出 `ApiError`
- 索引器比链上最新状态晚几秒：刚发出的交易可能还没反映在余额里

## 开发

```sh
pnpm test                  # 单元测试（假的 toncenter，不需要网络）
pnpm test:live             # 连主网（TONCENTER_URL / TONCENTER_API_KEY 可选；需要代理时加 NODE_USE_ENV_PROXY=1）
pnpm test:live:write       # 写操作在主网上模拟（emulateTrace，不发送）
pnpm test:live:liquidity   # LP 仓位和加减流动性（主网模拟）
pnpm demo                  # 本地运行 demo（demo/，直接用 src 的源码）
```

## License

MIT
