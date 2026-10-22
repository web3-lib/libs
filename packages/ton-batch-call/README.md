# @w3lib/ton-batch-call

TON 批量读取和批量写操作库：TON / Jetton 余额、Jetton 信息、NFT、钱包状态；一对多转账、多钱包归集、批量执行交易；STON.fi / DeDust 的 LP 仓位和加减流动性；代币价格（DefiLlama、链上池子）和地址的资产总值；TON DNS（.ton、.t.me）域名解析；按模拟整条交易链估算手续费；STON.fi / DeDust 兑换（找路线、报价、发送）；Jetton 风险检查（admin、钱包代码、模拟买卖）。通过 **toncenter v3 索引器**（或兼容的自建 [ton-indexer](https://github.com/toncenter/ton-indexer)），多个地址合成一个请求，自动限频、多节点故障切换。不依赖 TON SDK，浏览器和 Node（≥ 20.19）都能用。

```sh
pnpm add @w3lib/ton-batch-call
```

只做查询时打包后约 13KB（minify，gzip 约 5KB），不带任何依赖；写操作在子路径 `/write`（见[批量写操作](#批量写操作)）。

**在线 demo**：<https://web3-lib.github.io/libs/ton/>（余额、多个地址、Jetton 信息、LP 仓位、添加 / 移除流动性（报价，用 TON Connect 连接钱包后可以发送）、NFT、价格和资产总值、域名解析（正向 + 反向）、手续费估算、兑换（STON.fi / DeDust 报价，连接钱包后可以发送，默认只模拟）、Jetton 风险检查，显示每次查询实际发出的 toncenter 请求）。本地运行：`pnpm --filter @w3lib/ton-batch-call demo`（http://localhost:5176）

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
| `multiBalances(queries)` | `getMultiBalances(queries)` | 所有地址的 Jetton 合成每 100 个地址一次 `jetton/wallets`，TON 余额合成 `accountStates`；多个地址都指定了多个 Jetton 时（toncenter 不接受一次查多个地址的多个 Jetton）按 Jetton（每个 Jetton 每 100 个地址一次）或按地址拆开，取请求少的 |
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
| `prices` | `true` 用 DefiLlama，也可以传价格源（如 [`/price`](#价格) 的 `combinePrices([defillamaPrices(), onchainPrices()])`）；默认不查。价格源出错时美元价值为 null（`onPriceError` 拿到错误） |

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

## 价格

子路径 `@w3lib/ton-batch-call/price`：TON 和 Jetton 的美元价格，地址的资产总值。

```ts
import { NATIVE_TON } from '@w3lib/ton-batch-call'
import { getPortfolio, getTokenPrices } from '@w3lib/ton-batch-call/price'

await getTokenPrices([NATIVE_TON, USDT, newJetton])
// [{ token: 'TON', native: true, price: 1.348, source: 'defillama' }, …, { token: newJetton, native: false, price: 0.0012, source: 'onchain' }]

const p = await getPortfolio(owner, { lp: true })
p.totalUsd // TON + 持有的全部 Jetton + LP 仓位的合计；p.tokens 按价值排序，p.lp 是 LP 仓位
```

- 价格源依次使用，前面没有价格的代币交给后面的（`sources`，默认 `[defillamaPrices(), onchainPrices()]`），结果的 `source` 是给出价格的源；地址任意格式，价格源内部的键是 `priceKeyOf`（TON 为 `NATIVE_TON`，Jetton 为原始地址 `0:…`）
- `defillamaPrices({ at })`：历史价格（unix 秒或 `Date`）；`minConfidence` 过滤置信度低的价格（默认 0.9）
- `onchainPrices()`：在 STON.fi（v1 / v2）、DeDust 的池子里找代币对 TON、USD₮ 的池子，用计价币一侧最深的池子的价格；USD₮ 按 1 美元，TON 按它对 USD₮ 的池子。`minLiquidityUsd`（默认 10000）以下的池子不用，防止小池子的价格被操纵。主网实测和 DefiLlama 相差在 0.7% 以内（TON、NOT、DOGS、STON）
  - 池子地址都用 router / factory 的 `get_pool_address` 算出，不信任索引器或池子自己报的信息；池子是否部署合并成一次 `accountStates`，只读部署了的池子的储备
  - STON.fi：用索引器查各个 router 的这个代币的 Jetton 钱包（每个代币一次请求），选余额最多的 constant_product router（v1 或 v2），看它的 代币/TON（pTON）、代币/USD₮ 两个池子；STON.fi 没有合格池子的代币再看 DeDust 的 volatile 池子 代币/TON
  - 请求数：toncenter 没有 API Key 时每秒 1 次，TON + 3 个 Jetton 第一次约 24 次请求（约 25~30 秒）；池子地址、router 类型等有进程内缓存，第二次约 10 次。只支持主网
- `combinePrices([…])` 把多个源组合成一个，可以传给 `getLpPositions` 的 `prices`
- 资产总值：TON 和持有的全部 Jetton（索引器列出），默认跳过索引器标记的诈骗代币（`includeScam`）；`lp: true` 时加上 LP 仓位（参数同 `getLpPositions`），LP Jetton 不再重复算作代币；`minUsd` 以下的代币不列出（不影响合计）。精度未知的 Jetton 没有价值（`value: null`，计入 `unpriced`）
  - 没有 DefiLlama 价格的 Jetton 都会走链上价格源：持有很多空投杂币时，没有 API Key 会比较慢（实测一个持有 26 个 Jetton、其中 19 个是没有价格的杂币的地址，加上 LP 仓位共约 124 次请求、2.5 分钟）。只用 DefiLlama 时传 `sources: [defillamaPrices()]`

价格只用于展示和估值：链上价格是池子当前的价格，可能被单笔交易影响，不要用它算交易的最小数量。

打包：在已经用到 `getBalances` 的基础上，`getTokenPrices` 约增加 24KB（minify，gzip 约 11KB），加上 `getPortfolio`（含 LP 仓位）约 31KB（gzip 约 13KB）；其中大部分是和 `/lp` 共用的 Cell 编解码和 router 列表（只用 `getLpPositions` 约 23KB）。

## 域名解析

子路径 `@w3lib/ton-batch-call/names`：TON DNS（`.ton`）和 Telegram 用户名（`.t.me`，Fragment 上的用户名 NFT），名字 → 钱包地址、地址 → 名字。

```ts
import { getAddressNames, getNameAddresses, resolveNames } from '@w3lib/ton-batch-call/names'

await getNameAddresses(['foundation.ton', 'stud.t.me', 'nobody-here.ton'])
// [{ name: 'foundation.ton', normalized: 'foundation.ton', address: 'UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI', service: 'ton' },
//  { name: 'stud.t.me', normalized: 'stud.t.me', address: 'UQB6yZ8zNPjxoJpwcz9LqQvlVuxLhID7bzRZpp98ouBmfoEJ', service: 't.me' },
//  { name: 'nobody-here.ton', normalized: 'nobody-here.ton', address: null, service: 'ton' }]

await getAddressNames(['UQCdqXGvONLwOr3zCNX5FjapflorB6ZsOdcdfLrjsDLt3AF4'])
// [{ address: 'UQCdqXGv…', name: 'tolya.ton', service: 'ton' }]
await resolveNames(ton, names)   // 也可以传 TonClient
```

- **名字 → 地址**（链上读，不经过索引器）：按 TEP-81 调用 `dnsresolve` get 方法，类别 `wallet`（sha256("wallet")）。名字按各级倒序、每级后面一个 `\0` 编码（`foundation.ton` → `ton\0foundation\0`）；根 DNS（配置参数 4）解析掉后缀那部分（`ton` / `me\0t`），交给后缀的 NFT 集合，集合再交给域名 NFT，NFT 返回 wallet 记录（`dns_smc_address#9fd3`）。内置的 `NAME_SERVICES` 记着两个集合的地址（在主网上核对过：根 DNS 对这两个后缀返回的就是它们），从集合开始解析，每个名字 2 次 get 方法调用；子域名（NFT 的 `dns_next_resolver` 记录）每多一级多一次
- 名字按小写解析、去掉末尾的点；含空格、控制字符、非 ASCII 的为不合法（`normalized: null`）。没有服务认的后缀（如 `.eth`）`service: null`。注册了但没设置钱包、没注册（NFT 没部署）、NFT 还没初始化的都返回 `address: null`；节点出错照常抛出
- 地址按 TEP-2 输出为不可回弹的 `UQ…`（测试网 `0Q…`）
- **地址 → 名字**（索引器 + 链上核对）：TON 没有反向解析的合约，用 toncenter v3 的 `addressBook`（每 100 个地址一次请求）里的 `domain`——索引器给出的是地址**自己持有**、并且 wallet 记录指向自己的名字（`dns/records` 里 `self_assigned` 的那个）。再正查核对名字确实解析回这个地址（索引器落后几秒、名字可能刚转走或过期），`verify: false` 跳过核对。只是被别人的名字指向的地址返回 `null`（如 `foundation.ton` 指向 `UQCD39VS…`，但 NFT 在别的地址手里）
- 测试网只有 `.ton`；`services` 可以传自己的服务（`{ id, name, network, suffix, resolver }`）
- toncenter 没有 API Key 时每秒 1 次请求：5 个名字约 10 秒
- 打包：在已经用到 `getBalances` 的基础上约增加 4KB（minify，gzip 约 2KB）。`dnsresolve` 的参数和结果只用到单个 Cell，直接编解码，不带上 `/write` 的 Cell 和 SHA-256

核对方式：在主网上解析 `foundation.ton`、`tolya.ton`、`stud.t.me`（与索引器的 `dns/records` 一致）、`wallet.ton`（没设置钱包）和不存在的名字，反查 `tolya.ton`、`stud.t.me` 的持有人。

## 手续费估算

子路径 `@w3lib/ton-batch-call/fees`：给出一笔交易的消息（与 `batchCall` 相同）和发送的钱包，用 toncenter 的 emulateTrace 模拟整条交易链（与 `/write` 发送前的模拟是同一个），算出钱包付的手续费、附带和退回的 TON、整条链的手续费。不签名、不发送。

```ts
import { getCostEstimate, estimateCosts } from '@w3lib/ton-batch-call/fees'
import { jettonTransferBody } from '@w3lib/ton-batch-call/write'

// from 可以直接传钱包地址（只读，要已部署的 v4r2 / v5r1），也可以是 /write 的钱包（助记词、私钥、TON Connect）
await getCostEstimate({ from: owner, messages: [{ to: myUsdtWallet, value: 50_000_000n, body: jettonTransferBody({ amount, destination, responseDestination: owner, forwardTonAmount: 1n }) }] })
// { index: 0, from: 'UQDx…', error: null, simulated: true, incomplete: false,
//   walletFees: { import: '213334', storage: '4647632', gas: '377068', action: '61243', forward: '122492' },
//   fee: '5473637', feeFormatted: '0.005473637',            // 钱包付的手续费
//   attached: '50001000', attachedFormatted: '0.050001',    // 附带的 TON
//   returned: '48536094', returnedFormatted: '0.048536094', // 退回钱包的 TON（多余的 Jetton gas）
//   balanceChange: '-6938543', balanceChangeFormatted: '-0.006938543',
//   chainFee: '7952441', chainFeeFormatted: '0.007952441' }  // 整条链的手续费
await estimateCosts(ton, [call1, call2])   // 多笔：钱包状态一次请求，之后每笔一次 emulateTrace
```

| 字段 | 说明 |
| --- | --- |
| `walletFees` | 外部消息触发的钱包交易：`import`（导入外部消息，按消息大小；部署钱包时含 StateInit）、`storage`（上次交易以来的存储费）、`gas`、`action`（转发费里发送时收的部分）、`forward`（转发费的其余部分）。与 toncenter `estimateFee` 的 `source_fees` 一致（`in_fwd_fee`、`gas_fee`、`fwd_fee` = `action + forward`） |
| `fee` | 钱包付的手续费：钱包交易的手续费 + 发出消息的转发费 + 交易链里钱包之后的交易（如收到退回的 TON）的手续费 |
| `attached` | 钱包发出的消息附带的 TON：模式 64 / 128 带上的余额、模式没有 +1 时从金额里扣掉的转发费都按模拟的实际金额 |
| `returned` | 交易链里回到钱包的 TON：Jetton 转账多余的 gas（excess）、失败退回的消息 |
| `balanceChange` | 钱包余额的净变化 = `returned − attached − fee`（与模拟结果里钱包账户的前后余额一致） |
| `chainFee` | 整条链所有交易的手续费 + 所有消息的转发费：大多从附带的 TON 里出（多余的退回），也含其他合约用自己余额付的存储费，所以不全是用户付的 |

- 都是 nanoTON 的十进制字符串，`*Formatted` 按 TON 换算
- `error`：模拟的结果，与 `dryRun` 的判断相同（消息没发出、后面的合约失败退回等）；这时数值是失败的那条链的（失败退回时 `returned` 含退回的 TON）
- `simulated: false`（数值都是 `null`）：钱包拒绝外部消息（余额不够付手续费、seqno 等）、不知道钱包版本（只给地址、钱包没部署或不是 v4r2 / v5r1）、模拟服务不可用。私钥钱包没部署时带上 StateInit 一起模拟（含部署的费用）
- `incomplete: true`：交易链太长、模拟结果被截断，`returned`、`chainFee` 只算了已有的部分
- 按钱包当前的链上状态模拟；同一钱包的多笔各自按当前状态模拟（模拟不出前一笔执行后的状态）。用空签名、模拟时不检查签名（不需要私钥签名，TON Connect 钱包也不弹窗）
- TON 没有手续费市场：价格由链上配置决定，不随拥堵变化，所以没有快慢档。模拟时的状态（存储费按时间累计、合约状态）和真正上链时可能略有不同
- 打包：在已经用到 `getBalances` 的基础上约增加 29KB（minify，gzip 约 11KB，含 `/write` 的钱包编码和模拟代码）；已经用到 `batchCall` 时只多约 3KB（gzip 约 1KB）

核对方式：在主网上以真实钱包的地址模拟 USDT 转账 + 备注转账（v5r1，钱包交易的明细与 `estimateFee` 一致，余额变化与模拟结果里账户的前后余额一致）、TON 转账和模式 128（v4r2）、Jetton 余额不够被退回。

## 兑换

子路径 `@w3lib/ton-batch-call/swap`：在 STON.fi v2 / v1、DeDust（volatile）的池子里找最好的路线，报价并构建 / 发送兑换的消息。TON 和 Jetton 都可以，直接兑换或经过 TON / USD₮ 的两跳。消息格式与官方 SDK（@ston-fi/sdk 2.7、@dedust/sdk 0.8）相同，发送走 `/write` 的流程（先模拟整条交易链，再发送、等结果），钱包和发送参数也相同。

```ts
import { NATIVE_TON } from '@w3lib/ton-batch-call'
import { TON_USDT, getSwapQuote, swap } from '@w3lib/ton-batch-call/swap'

const plan = await getSwapQuote(owner, { tokenIn: NATIVE_TON, tokenOut: TON_USDT, amountInFormatted: '1' })
plan.amountOutFormatted   // '1.358772'
plan.route                // { protocol: 'dedust', protocolName: 'DeDust', path: ['TON', 'EQCxE6…'], pools: [pool], routers: [], amountOut: '1358772' }
plan.routes               // 所有报到价的路线，从高到低
plan.messages             // [{ to, value, body, bounce }]：可以交给 batchCall 或 TON Connect

const r = await swap(ton, mnemonic, { tokenIn: TON_USDT, tokenOut: NATIVE_TON, amountInFormatted: '10' }, { slippage: 0.01 })
r.status          // 'confirmed'
r.amountReceived  // 交易链里实际收到的 nanoTON（不含退回的多余 gas）
await swap(ton, connector, params, { dryRun: true })   // 只模拟：amountReceived 是模拟里收到的数量
```

| | 报价 | 卖出 TON | 卖出 Jetton | 两跳 |
| --- | --- | --- | --- | --- |
| STON.fi v2 | 读池子的 `get_pool_data`，按合约的 `get_swap_out` 公式本地算（v2 的池子没有报价的 get 方法） | `ton_transfer` 发给 router 的 pTON 钱包，forward 里是 `swap` | Jetton 转给 router，forward 里是 `swap` | 同一个 router：第一跳的 `custom_payload` 是 `cross_swap`；经过 TON 时可以在不同的 router 上：第一跳的输出由 pTON 钱包 `ton_transfer` 给第二个 router 的 pTON 钱包，`custom_payload` 是第二跳的 `swap` |
| STON.fi v1 | 池子的 `get_expected_outputs` | Jetton 转账的格式发给 router 的 pTON v1 钱包 | Jetton 转给 router | 不支持 |
| DeDust | 池子的 `estimate_swap_out` | `swap` 发给 TON vault | Jetton 转给 Jetton vault，forward 里是 `swap` | 消息里的 `next` 步骤 |

- **路线**：直接兑换，加上经过 TON / USD₮（`intermediates`，传 `[]` 只找直接兑换）的两跳，三个协议都报价，选输出最多的。池子地址都用 router / factory 的 `get_pool_address` 算出（与 `/price` 共用，有进程内缓存），没部署的池子不报价（一次 `accountStates`）
  - STON.fi 有几十个 v2 router，同一对代币常在多个 router 上都有池子（有的是空的）：用索引器查每个代币在各个 router 的 Jetton 钱包，每一跳看排名之和最前的两个和两个代币各自余额最多的 router（只用 constant_product 的，最多 3 个），都报价；两跳的每种 router 组合都报价，选输出最多的
  - 两跳在 STON.fi 上只用 v2，经过 USD₮ 等 Jetton 时两跳要在同一个 router 上（跨 router 转 Jetton 没有核对过，不用）；不跨协议（一条路线的两跳在同一个 DEX）；DeDust 只用 volatile 池子，STON.fi 只用 constant_product 池子
- `route`：指定走 `routes` 里的某一条（`{ protocol, path, pools }`），不选最好的
- **最少收到**：`amountOutMin = 报价 × (1 − slippage)`（默认 0.5%），由 DEX 合约检查（两跳时只限最后一跳），不够时退款；`deadline`（默认 900 秒）过期也退款。`priceImpact` 是这笔的价格比极小数量的价格差多少
- **附带的 TON**（`SWAP_GAS`，多余的退回）：与官方 SDK 默认值相同——STON.fi v2 Jetton 卖出 0.3（forward 0.24）、TON 卖出 0.31 + 卖出的 TON；v1 Jetton → Jetton 0.22、Jetton → TON 0.17、TON 卖出 0.185 + 卖出的 TON；DeDust TON 卖出 0.2 + 卖出的 TON、Jetton 卖出 0.3（forward 0.25）。两跳多带 0.1，STON.fi 跨 router 时再加第二跳的 forward（0.3）
- **结果判断**：除了没有失败退回，还要求交易链里收款地址收到了不少于 `amountOutMin` 的代币（DEX 失败时是退款，不是退回）：Jetton 看收款地址的 Jetton 钱包收到的 `internal_transfer`；TON 看付款方消息体里的数量（STON.fi 是 router 的 pTON 钱包发来的 `ton_transfer` / `transfer_notification`，DeDust 是池子发给 TON vault 的 `payout_from_pool`），不含一起退回的多余 gas。`amountReceived` 是这个数量
- `recipient` 可以让别的地址收；发送前检查余额（卖出的数量 + 附带的 TON + 0.02 TON），`checkBalance: false` 关闭。只支持主网
- 请求数：toncenter 没有 API Key 时每秒 1 次请求。实测 TON → USD₮ 约 18 次请求（23 秒），USD₮ → NOT（含两跳）约 32 次（42 秒）；池子地址、router 类型、router 的 Jetton 钱包有进程内缓存，同一对代币第二次约 16 次。`swap` 另外读钱包状态、余额和模拟，多约 4 次
- 报价是池子当前的状态，交易上链前价格可能变化；STON.fi 的 stableswap 池子、DeDust 的 stable 池子不报价。有转账税或限制转账的 Jetton 可以先用 [Jetton 风险检查](#jetton-风险检查)

主网核对：以真实钱包的地址（v4r2，持有 TON、USD₮、NOT）模拟整条交易链（emulateTrace），三个协议各三个方向（TON → Jetton、Jetton → TON、Jetton → Jetton），都模拟成功，收到的数量 ≥ `amountOutMin`，与报价的差别：

| 协议 | 兑换 | 路线 | 报价 | 模拟里收到 |
| --- | --- | --- | --- | --- |
| STON.fi v2 | 1 TON → USD₮ | 直接 | 1.356902 | 1.356902 |
| STON.fi v2 | 2 USD₮ → TON | 直接 | 1.470997079 | 1.470997080 |
| STON.fi v2 | 2 USD₮ → NOT | 经过 TON，跨 router | 5140.186438965 | 5141.703222905（+0.03%，报价和模拟之间池子变了） |
| DeDust | 1 TON → USD₮ | 直接 | 1.358772 | 1.358772 |
| DeDust | 2 USD₮ → TON | 直接 | 1.468955909 | 1.468955909 |
| DeDust | 1000 NOT → USD₮ | 经过 TON | 0.38729 | 0.38729 |
| STON.fi v1 | 1 TON → NOT | 直接 | 3480.514160877 | 3480.514160877 |
| STON.fi v1 | 1000 NOT → TON | 直接 | 0.281602177 | 0.281602177 |
| STON.fi v1 | 1000 NOT → USD₮ | 直接 | 0.383049 | 0.383049 |

另外核对了同一个 router 上的 `cross_swap`（1 USD₮ → TON → TRC、→ CAPY，收到的与报价完全一致）。

打包：在已经用到 `getBalances` 的基础上，`getSwapQuote` / `buildSwap` 约增加 34KB（minify，gzip 约 14KB，大部分是和 `/write`、`/lp` 共用的 Cell 编解码、SHA-256 和 router 列表）；`swap` 另外按需加载约 19KB（gzip 约 8KB）的发送代码。已经用到 `batchCall` 时，`/swap` 只多约 21KB（gzip 约 9KB）。

## Jetton 风险检查

子路径 `@w3lib/ton-batch-call/risk`：主合约的 admin（能不能增发、有没有放弃）、mintable、索引器的诈骗标记、Jetton 钱包代码是不是认识的代码，可选模拟买入 / 卖出。

```ts
import { getTokenRisks } from '@w3lib/ton-batch-call/risk'

const [usdt, not] = await getTokenRisks([USDT, NOT])
// usdt: { symbol: 'USD₮', admin: 'EQBkQP48…', mintable: true, isScam: false, walletCode: 'stablecoin', flags: ['mintable', 'admin', 'governed'], … }
// not:  { symbol: 'NOT', admin: null, mintable: true, walletCode: 'notcoin', flags: [], … }

const [r] = await getTokenRisks([jetton], { simulate: true })
r.trade   // { stage: 'ok', protocol: 'stonfi-v2', buyQuote, bought, sellQuote, sold, buyTax: 0, sellTax: 0, holder: 'UQD4…' }
```

- **admin、mintable**：链上的 `get_jetton_data`（不用索引器的记录）。admin 是 `addr_none` 或零地址时为 `null`（已放弃，不能再增发）；有 admin 且 mintable 时标记 `mintable`，有 admin 时标记 `admin`（能增发、改元数据，看合约）
- **钱包代码**：`get_jetton_data` 给出的 Jetton 钱包代码的哈希（`walletCodeHash`；代码是库 Cell 时取库里代码的哈希），在 `KNOWN_JETTON_WALLET_CODES` 里的给出名字（`standard`：TEP-74 参考实现；`stablecoin`：USD₮ 的带治理的钱包；`notcoin`：NOT、DOGS；`dedust`、`stonfi-lp`、`blum-memepad`、`memepad`、`hamster`、`tonstakers`、`bridge`）。2026-10 抽查的索引器里 2000 个 Jetton 约 88% 用这些代码；不在表里时标记 `unknown-wallet-code`（不标准的钱包代码可以禁止转账、偷偷收税），`knownWalletCodes` 可以加自己认可的。`governed`：带治理的钱包代码（`stablecoin`）且有 admin——admin 可以冻结、强制转出持有人的余额
- **诈骗标记**：索引器（toncenter）的 `is_scam`，标记 `scam`。注意它很少标记：2026-10 抽查的 2000 个 Jetton 和 4 个大地址持有的约 110 个 Jetton 里没有一个被标记，大量仿冒 USD₮ / DOGS / TON 的空投都没标记（它们的钱包代码都不在表里，会标记 `unknown-wallet-code`）
- **模拟买卖**（`simulate: true`）：用索引器找余额最多的持有人里 v4r2 / v5r1、TON 够付的钱包（`holder` 可以指定），用 `/swap` 的路线模拟两笔（不发送、不签名）：用 `buyAmount`（默认 1 TON）买入，再卖出不超过买到的数量（模拟不出买入后的状态，卖的是持有人现有的 Jetton）。滑点放宽到 99%，量出实际收到的数量：税率 = 1 − 实际收到 / 报价。`stage`：`ok`、`buy-failed`、`sell-failed`（卖不出）、`no-pool`、`no-holder`；标记 `no-pool`、`cannot-buy`、`honeypot`（卖不出或卖出税 ≥ 90%）、`high-buy-tax` / `high-sell-tax`（> 10%）、`has-tax`（> 0.5%）。每个代币多约 30 次请求
- 只能发现模拟时的行为：针对特定地址、时间、数量的限制不一定能发现

主网核对：USD₮（`stablecoin`，有 admin，`['mintable', 'admin', 'governed']`）、NOT（`notcoin`，admin 已放弃，没有标记）、CATI（admin 是零地址，`standard`）、一个仿冒 USD₮ 的空投（“Tether USD”，有 admin、钱包代码不认识、没有池子：`['admin', 'unknown-wallet-code', 'no-pool']`）；模拟 NOT 买入 1 TON、卖出：买到 3495.478412764 NOT、卖出得到 0.995059193 TON，都和报价完全一致（税率 0）。

打包：在已经用到 `getBalances` 的基础上 `getTokenRisks` 约增加 21KB（minify，gzip 约 8KB，大部分是算代码哈希的 Cell 编解码和 SHA-256）；`simulate: true` 时按需加载 `/swap` 和发送的代码（约 39KB，gzip 约 16KB）。

## 模拟

子路径 `@w3lib/ton-batch-call/simulate`：用 toncenter 的 emulateTrace（`/api/emulate/v1/emulateTrace`，与 v3 同一个服务，公共节点可用）模拟整条交易链（钱包 → Jetton 钱包 → DEX → …），不检查签名、不发送。输入是本包构建器的消息（`buildSwap`、`buildAddLiquidity` / `buildRemoveLiquidity` 的 `plan.messages`、`batchCall` 的 `messages`），或外部消息 / 内部消息的 BOC。

```ts
import { buildSwap } from '@w3lib/ton-batch-call/swap'
import { getSimulation } from '@w3lib/ton-batch-call/simulate'

const plan = await buildSwap(ton, owner, { tokenIn: USDT, tokenOut: NATIVE_TON, amountInFormatted: '1' })
const sim = await getSimulation({ from: owner, messages: plan.messages })
if (!sim.success) throw new Error(sim.error)
sim.decoded.summary   // 'Swap 1 USD₮ for 0.743854486 TON on STON.fi v2'
sim.balanceChanges    // [{ address: 'UQCHY3…', asset: 'native', symbol: 'TON', delta: '738966451', … }, { asset: 'EQCxE6…', symbol: 'USD₮', delta: '-1000000', formatted: '-1', … }]
sim.fees              // { total, wallet, gas, forward, storage, other }（nanoTON）

await getSimulation({ boc: signedExternalBoc })              // 已签名的外部消息（签名不检查，seqno 要对得上）
await getSimulation({ boc: internalMessageBoc, from: owner })  // 内部消息：由 from 钱包发出
```

- **结果**：`success` 要求钱包交易成功、消息都发出、后续合约没有失败退回；`error` 是可读的原因（账户、退出码的说明、在处理哪条消息，如 `EQCD-2L5…: exit code 47: not enough jettons in the wallet … while handling jetton_transfer; the message bounced`）；`failures` 是交易链里所有失败的交易；`simulated: false` 表示没有模拟结果（钱包拒绝外部消息，如 seqno 不对：`the wallet rejected the message (exit code 133: wrong seqno …)`；钱包没部署、模拟服务不可用）
- **余额变化**：用交易链里每个账户模拟前后的余额：TON 按账户余额的差，Jetton 按 Jetton 钱包存储里 balance 的差（所以带税、特殊钱包代码的也准）。默认只列钱包 / 普通地址（含没部署的收款地址），不列 DEX、Jetton 钱包等合约（`includeContracts: true` 全列，`watch` 总是列出的地址）；`asset` 是 `'native'` 或 Jetton 主合约，`usd: true` 时加美元价值（按需加载 `/price`）
- **手续费**：`fees.total`（整条链：所有交易的手续费 + 转发费）= `gas` + `forward` + `storage` + `other`（导入外部消息等）；`fees.wallet` 是钱包付的（同 `/fees`），`gasUsed` 是整条链的 gas 单位
- **解码**：`decoded` 汇总（`type`：`transfer` / `swap` / `liquidity` / `contract` / `unknown`，`protocol`，`summary`）；有 DEX 动作（toncenter 的 `jetton_swap`、`dex_deposit_liquidity`、`dex_withdraw_liquidity`）时按实际执行的结果，否则按钱包发出的消息体。单独可用：`decodeMessage`（Jetton 转账 / 销毁、NFT 转账、pTON、STON.fi v1 / v2 的兑换和存入、DeDust 的兑换和存入，载荷里嵌套的兑换 / 存入也会解出）、`decodeExternalMessage`（钱包 v4r2 / v5r1 的外部消息：seqno、有效期、每条消息的发送模式和解码）、`describeExitCode`（标准 TVM 码、动作阶段、钱包 v4r2 / v5r1、标准 Jetton 钱包和 USD₮ 钱包的码；不认识的合约码只给数字）
- **警告**（`warnings: { code, severity, message }[]`）：`bounceable-to-uninit`（可回弹的消息发给没部署的地址）、`jetton-to-contract`（Jetton 转给合约而不是钱包）、`unknown-opcode`、`high-forward-amount`（Jetton 转账的 forward TON 超过 `maxForwardTon`，默认 1 TON）、`drains-balance`（花掉余额的 90% 以上）、`swap-not-executed`（发出了兑换但交易链里没有兑换的结果，多半被退款）、`scam-token`（收到索引器标记的诈骗代币）、`trace-incomplete`；`risk: true` 时对收到的 Jetton 做 `/risk` 检查（按需加载），危险的标记（`honeypot`、`high-sell-tax` …）以 `token-risk` 给出
- 没有授权（approve）：`approvalChanges` 恒为空

主网核对（公共 toncenter，别人的钱包地址、不签名）：USD₮ → TON 的兑换（STON.fi v2 / DeDust）、Jetton + TON 的批量转账（USD₮ 的治理钱包，收款人新部署的 Jetton 钱包不当作收款地址列出）、TON 不够付兑换的附带 TON、seqno 不对的外部消息（v5r1 退出码 133）、Jetton 余额不够（USD₮ 钱包的退出码 47）、Jetton 转给 USD₮ 主合约（`jetton-to-contract`）。

打包：`/simulate` 单独约 105KB（minify，含 `/risk`、`/price`、`/swap` 的按需代码被一起打进了没拆分的包；主入口不变）。

## 交易历史

子路径 `@w3lib/ton-batch-call/history`：一个地址的活动，统一成 `Activity`。默认用 toncenter v3 的 `/actions`（索引器已分类的动作，同一条交易链的动作合成一条），出错退回 `/transactions` + `/jetton/transfers`；请求走 `TonClient` 的传输层（限频、重试、多节点故障切换）。

```ts
import { getHistory } from '@w3lib/ton-batch-call/history'

const page = await getHistory(owner, { limit: 20 })
page.items[0]   // { hash, time, block, status: 'success', type: 'swap', label: 'Swapped 2.19956 XAUH for 289.070885 USD₮ on STON.fi v2', changes: [{ asset, symbol: 'XAUH', delta: '-2199560000000000000', … }, …], protocol: 'STON.fi v2' }
const next = await getHistory(owner, { cursor: page.nextCursor })
const swaps = await getHistory(owner, { types: ['swap', 'liquidity'], after: Math.floor(Date.now() / 1000) - 86400 })
```

- **Activity**：`type`：`transfer`（TON / Jetton / NFT）、`swap`、`liquidity`（存入 / 取出）、`mint`、`contract`、`other`（如销毁）；`status`：`failed` 为交易链里有失败的动作；`direction`、`counterparty`、`changes`（对这个地址的带符号变化，TON 的 `asset` 是 `'native'`）、`hash`（外部消息的规范化哈希的十六进制，同 `/write` 的 `hash`）。只有多余 TON 退回（excess）的交易链不单独成一条
- **分页**：`limit`（默认 20，最多 100；`/actions` 按动作数分页，所以一页的活动数可能少于它），`cursor` / `nextCursor`（带适配器名，翻页用同一个适配器），`before` / `after`（unix 秒）。页末被截断的交易链会单独取完整，下一页跳过它。`types` 在结果里过滤并连续翻页（最多 `maxPages` 页），所以可能多于 `limit`
- **适配器**：`adapters` 是 `{ name, fetch(query) → { items, nextCursor } }` 的数组，依次尝试（出错换下一个）；默认 `[toncenterActions(), toncenterTransactions()]`。应用有带 Key 的 toncenter 时传 `apiKey`（`TonClient` 的选项）；用 tonapi 等别的服务时自己实现一个适配器（返回 `Activity`）传进来
- **退路的限制**：`/transactions` 没有协议分类：付出和收到资产（0.1 TON 以内的 gas 不算）的按 `swap` 算，没有 `protocol`，`hash` 是 trace id 的十六进制（与 `/actions` 的不同）；翻页是尽力而为（一条交易链的数据可能跨页）；有 `fee`（钱包发起的交易的手续费）

主网核对：一个常有兑换的 v5r1 钱包：`/actions` 分出 `swap`（XAUH → USD₮、STON.fi v2）和 `transfer`，翻页没有重复，`types` 过滤；退路适配器同一批数据得到相同的兑换，第一个适配器出错时自动换下一个。

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
pnpm test:live:price       # 链上价格和 DefiLlama 对比、资产总值
pnpm test:live:names       # 域名正查、反查
pnpm test:live:fees        # 手续费估算（主网模拟）
pnpm test:live:swap        # 兑换：三个协议各三个方向（主网模拟）
pnpm test:live:risk        # Jetton 风险检查、模拟买卖（主网）
pnpm demo                  # 本地运行 demo（demo/，直接用 src 的源码）
```

## License

MIT
