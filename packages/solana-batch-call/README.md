# @w3lib/solana-batch-call

Solana 批量读取库：余额（SOL / SPL Token / Token-2022）、代币详情、NFT；以及[批量写操作](#批量写操作)（一对多转账、多钱包归集、批量调用程序，子路径 `/write`）。不依赖 Solana SDK，直接发 JSON-RPC。

```bash
pnpm add @w3lib/solana-batch-call
```

- **一次请求查一批**：账户读取用 `getMultipleAccounts`（自动去重、按 100 个一组拆分、最多同时 3 个请求）；同一 tick 内发起的 RPC 调用合并成一个 JSON-RPC 批量请求
- **免费节点也能查余额**：指定代币时在本地推导关联代币账户（ATA）地址，和 mint 账户一起用 `getMultipleAccounts` 读完，不需要 `getTokenAccountsByOwner` 这类索引方法
- **只查主币不读账户数据**：SOL 余额（`getSolBalances`、单币模式里的主币）用带 `dataSlice` 的 `getMultipleAccounts` 只取 lamports，与代币账户分开两组、同一个批量请求发出——钱包是数据很大的程序账户时也不会拖慢或超时
- **Token-2022**：余额、decimals、TokenMetadata 扩展里的 name / symbol / uri 都支持
- **多节点故障切换**：限频、403、需要 API Key、不支持某方法等节点问题自动换下一个节点；节点不支持批量请求或限制批量大小时自动降级
- **网络校验**：按创世区块哈希确认节点所在网络，不会把 devnet 的数据当成 mainnet 的返回
- 结果字段都是字符串 / 数字 / 布尔 / null，可以直接 `JSON.stringify`

## 快速上手

```ts
import { NATIVE_MINT, getBalances, getMultiBalances, getNftOwners, getNfts, getOwnerNfts, getOwnerTokens, getSolBalances, getTokens, watchBalances } from '@w3lib/solana-batch-call'

// 资产列表：持有人拥有的全部代币（SOL 在第一位，带 name / symbol；需要支持索引方法的节点）
await getOwnerTokens(owner, { provider: 'https://my-rpc.example' })
// [
//   { token: NATIVE_MINT, native: true,  name: 'Solana',   symbol: 'SOL',  formatted: '1.5',  accounts: 1, … },
//   { token: USDC,        native: false, name: 'USD Coin', symbol: 'USDC', formatted: '1235', accounts: 2, … },  // 2 个代币账户合计
//   ...
// ]

// 余额：SOL + 代币，带 decimals 换算（不传 provider 时使用内置的 mainnet 公共节点）
await getBalances(owner, [NATIVE_MINT, USDC, PYUSD], { symbol: true })
// [
//   { token: NATIVE_MINT, native: true,  balance: '1500000000', decimals: 9, formatted: '1.5', tokenProgram: null, symbol: 'SOL', success: true },
//   { token: USDC,        native: false, balance: '1234500000', decimals: 6, formatted: '1234.5', tokenProgram: 'Tokenkeg…', symbol: 'USDC', success: true },
//   ...
// ]

// 只要某类代币：tokenPrograms 传 ['spl'] 时结果不含 Token-2022 代币（SOL 不受影响）
await getBalances(owner, undefined, { provider: 'https://my-rpc.example', tokenPrograms: ['spl'] })

// 多个地址的 SOL 余额
await getSolBalances([addressA, addressB])

// 多个钱包一次查（ATA 模式下合并成一次 getMultipleAccounts），结果与 queries 一一对应
await getMultiBalances([{ owner: walletA, mints: [NATIVE_MINT, USDC] }, { owner: walletB, mints: [USDC] }])

// 刚成交后刷新余额：要求节点高度至少到成交所在的 slot（落后的节点自动换掉），结果带 slot
await getBalances(owner, [NATIVE_MINT, USDC], { minContextSlot: txSlot })

// 多处共用一份轮询，余额变化时才通知
const stop = watchBalances(owner, [NATIVE_MINT, USDC], { interval: 10_000, onChange: (list) => render(list) })

// 代币详情，字段可选：name / symbol / uri / decimals / supply / tokenProgram / mintAuthority / freezeAuthority / transferFee（默认 name、symbol、decimals）
await getTokens([USDC, PYUSD], { fields: ['name', 'symbol', 'decimals', 'supply'] })
// [{ address: USDC, native: false, name: 'USD Coin', symbol: 'USDC', decimals: 6, supply: '…', supplyFormatted: '…', success: true }, ...]

// NFT
await getNfts([mint])        // 名称、uri、所属集合（是否已认证）、版税、标准、创作者
await getNftOwners([mint])   // 持有人
await getOwnerNfts(owner)    // 某地址持有的全部 NFT（需要支持索引方法的节点）
```

| 函数 | SolanaClient 方法 | 说明 |
| --- | --- | --- |
| `getBalances(owner, mints?, opts)` | `balances` | SOL + SPL Token + Token-2022 余额；`symbol: true` 额外返回 symbol；不传 mints 返回全部持仓；`tokenPrograms` 按代币类型过滤 |
| `getOwnerTokens(owner, opts)` | `ownerTokens` | 持有人的全部代币（资产列表），带 name / symbol；默认不含 NFT 和余额为 0 的账户；`tokenPrograms` 按代币类型过滤 |
| `getMultiBalances(queries, opts)` | `multiBalances` | 多个钱包一次查，参数同 `getBalances` |
| `watchBalances(owner, mints?, opts)` | — | 轮询余额，相同参数的订阅共用一份轮询，余额变化时才通知 `onChange`；返回取消函数 |
| `getSolBalances(addresses, opts)` | `solBalances` | 多个地址的 SOL 余额（只读 lamports，不读回账户数据） |
| `getTokens(mints, opts)` | `tokens` | 代币详情，`fields` 选择字段，结果类型随之收窄；`transferFee` 返回 Token-2022 转账手续费 |
| `getNfts(mints, opts)` | `nfts` | NFT 元数据（Metaplex；Token-2022 NFT 取扩展） |
| `getNftOwners(mints, opts)` | `nftOwners` | NFT 持有人 |
| `getOwnerNfts(owner, opts)` | `ownerNfts` | 某地址持有的全部 NFT |
| — | `accounts(addresses)` | 批量读原始账户（`AccountInfo \| null`） |
| — | `request(method, params)` | 直接发 JSON-RPC（同样参与合并与故障切换） |

## 资产列表

`getOwnerTokens(owner)` 扫描持有人的全部代币账户（Token + Token-2022），同一代币的多个账户合计，返回：

- 第一项是 SOL，之后是 SPL Token、Token-2022 的代币（各自按节点返回的顺序；库里没有价格信息，不按价值排序）
- 每项带 `accounts`（代币账户数量）；默认还带 `name` / `symbol` / `metadataStatus`（`ok` 读到了、`missing` 确认没有元数据、`failed` 节点问题没读到），`metadata: false` 时不读元数据、不返回这三个字段
- Wrapped SOL 代币账户单独列出（`token` 同样是 `So111…112`，`native: false`），与原生 SOL 那一项区分
- 默认不含 NFT 和余额为 0 的代币账户（已清空的 ATA），用 `includeNfts` / `includeZero` 打开；`includeNative: false` 不返回 SOL。NFT 的判断按 mint 汇总：精度 0、合计数量 1（与 `getOwnerNfts` 一致）

持仓很多时读元数据较慢：读取账户最多同时 3 个请求、每个 100 个地址，以避免限频（实测 4000 个代币在官方节点上约 80 秒，不读元数据约 4 秒）。可以先用 `metadata: false` 拿到列表，再对需要展示的代币调用 `getTokens`。元数据读取遇到限频等节点问题时不再继续请求，对应代币的 `metadataStatus` 为 `failed`、`name` / `symbol` 为 `null`，余额列表照常返回；之后可以对这些代币单独重查。

需要支持 `getTokenAccountsByOwner` 的节点，内置的免费公共节点大多不支持。

## 余额的三种模式

| | 指定 mints（默认，`accounts: 'ata'`） | 指定 mints + `accounts: 'all'` | 扫描（不传 mints，或 `scan: true`） |
| --- | --- | --- | --- |
| 实现 | 本地推导 ATA + 一次 `getMultipleAccounts` | 每个代币一次按 mint 过滤的 `getTokenAccountsByOwner`（同一 tick 发出，合并成批量请求） | `getTokenAccountsByOwner`（Token / Token-2022 各一次） |
| 统计范围 | 只统计 **ATA** 里的余额 | 指定代币的**全部**代币账户，多个账户合计 | 该地址的**全部**代币账户，同一代币多个账户合计 |
| 返回 | 指定的代币 | 指定的代币 | 不传 mints：所有余额大于 0 的代币；传 mints：指定的代币 |
| 免费公共节点 | 可用 | 大多不支持，需要自己的节点（Helius、QuickNode、Triton 等） | 同左 |

普通钱包的代币都在 ATA 里，用默认模式即可。交易所、托管类地址常有非 ATA 的代币账户（实际碰到过 PYUSD 余额全在非 ATA 账户里的持有人），默认模式会少算：只关心少数几个代币时用 `accounts: 'all'`，要全部持仓时用扫描。同时传 `scan: true` 和 `accounts` 时按扫描处理。

```ts
await getBalances(owner, [USDC, PYUSD], { provider: 'https://my-rpc.example', accounts: 'all' })
```

其他规则：

- **按代币类型过滤**：`tokenPrograms` 默认两种都返回，传 `['spl']` 只要 SPL Token、传 `['token-2022']` 只要 Token-2022（也可以传程序地址 `TOKEN_PROGRAM_ID` / `TOKEN_2022_PROGRAM_ID`；不认识的值或空数组会报错），不符合的代币直接从结果里去掉（结果条数可能少于 mints）。扫描模式下只请求对应程序的代币账户；指定 mints 时所属程序未知的代币先读 mint 账户确认（与 ATA 在同一次请求里）。mint 不存在、无法判断类型的项照常返回 `success: false`；主币 SOL 不受影响（`getOwnerTokens` 用 `includeNative` 控制）

- **主币**：`So111…112`（`NATIVE_MINT`，Wrapped SOL 的 mint）和 `11111…1`（System Program）按原生 SOL 查询（lamports，9 位精度）；此时 Wrapped SOL 代币账户里的余额不单独列出。可用 `nativeMints` 配置，传 `[SYSTEM_PROGRAM_ID]` 时 `So111…112` 按普通代币（Wrapped SOL）查询。`nativeMints` 也可以包含非 Solana 地址，作为调用方自己的主币标识（如多链项目统一用 `0xEeee…EEeE` 表示主币），`balances` / `tokens` 遇到它时按 SOL 返回、`token` 原样带回，这是支持的用法
- **缓存**：decimals、所属程序永久缓存；name、symbol 来自可修改的元数据，缓存 1 小时（确认没有元数据的代币同样缓存，不会每次重查）。按网络共享（各函数共用）；自定义节点且没指定 `cluster` 时只在该客户端内缓存。最多 5 万个代币，超出淘汰最早的
- **大数**：lamports 等 u64 超过 2⁵³ 时不会丢精度
- **失败**：mint 不存在、地址非法等只让该项 `success: false`，并带 `error` 说明原因；节点不可用等整个请求失败时才抛错（多个节点都失败时是 `AllNodesFailedError`，`err.errors` 里有每个节点的名称和原因）
- **取消**：所有查询都可以传 `signal`（`AbortSignal`）。已取消时直接 reject、不发请求；中途取消时立即 reject，已经发出、和其他查询合并在一起的底层请求继续完成
- **最低 slot**：`getBalances` / `getMultiBalances` / `getSolBalances` / `getOwnerTokens` / `accounts` 可以传 `minContextSlot`：节点高度不够时换下一个节点，都不够时每 500ms 重试，最多约 10 秒；`withSlot: true`（或传了 `minContextSlot`）时结果项带读取时的 `slot`（一次查询发了多个请求时取最小的）

## 轮询余额

```ts
const stop = watchBalances(owner, [NATIVE_MINT, USDC], {
  interval: 10_000,                              // 默认 15 秒；多处订阅同一份时取最小的
  onChange: (list, previous) => render(list),   // 第一次结果、以及之后余额变化时调用
  onError: (err) => console.warn(err),          // 某次失败，之后照常轮询
})
stop() // 最后一个订阅者取消时停止轮询
```

- 同样的节点配置 + owner + mints（顺序无关）+ 影响结果的选项共用一份轮询；结果顺序按第一个订阅者传的 mints
- 上一次请求没完成时不会发起下一次；新订阅者加入时如果已经有结果，立即收到一次

## 代币信息缓存持久化

decimals / 所属程序永久缓存、name / symbol 缓存 1 小时，默认只在内存里。刷新页面后不想重查 decimals 时：

```ts
import { persistTokenMetaCache } from '@w3lib/solana-batch-call'

const stop = persistTokenMetaCache(localStorage) // 读入上次保存的，之后有变化约 1 秒后写回（最多 5000 条，可用 maxEntries 调整）
```

也可以自己存：`exportTokenMetaCache()` 返回可以 `JSON.stringify` 的快照，`importTokenMetaCache(snapshot)` 导入（格式不对的条目跳过，已有的不覆盖）。只包含按网络共享的条目（自定义节点且没指定 `cluster` 的客户端不导出）。

## 转账手续费（Token-2022）

```ts
const [token] = await getTokens([mint], { fields: ['decimals', 'transferFee'] })
token.transferFee
// { basisPoints: 50, maximumFee: '5000', epoch: '100', older: { … }, newer: { basisPoints: 200, maximumFee: '9000', epoch: '600' } }
```

顶层是当前 epoch 生效的配置（请求时顺带发一次 `getEpochInfo`，与账户读取在同一个批量请求里），`older` / `newer` 是扩展里的两套原始配置。SPL Token、没有这个扩展、主币为 `null`（不算失败）。实际到账 = 数量 − min(⌈数量 × basisPoints / 10000⌉, maximumFee)。

## 失败原因

各函数的单项结果在 `success: false` 时带 `error`（类型 `FailureReason`），成功时不带：

| `error` | 含义 | 出现在 |
| --- | --- | --- |
| `invalid-address` | 地址格式非法（不是 base58 的 32 字节） | 全部 |
| `not-found` | 地址合法，但链上没有这个账户（如 mint 不存在） | `getBalances` / `getTokens` / `getNfts` / `getNftOwners` |
| `not-token` | 账户存在，但不是代币 mint | 同上 |
| `no-metadata` | 代币存在，但没有元数据 | `getNfts` |
| `no-holder` | 没有持有人（供应量为 0 或已销毁） | `getNftOwners` |
| `missing-field` | 代币存在，但请求的字段读不到；`errorField` 是第一个读不到的字段（如没有元数据时的 `name`） | `getTokens` |

```ts
const [item] = await getBalances(owner, [mint])
if (item.error === 'invalid-address') throw new Error('bad mint')  // 参数错误
if (item.error === 'not-found') { /* 按 0 处理 */ }
```

## 节点

```ts
import { SolanaClient } from '@w3lib/solana-batch-call'

new SolanaClient()                                              // 内置 mainnet 公共节点
new SolanaClient(undefined, { cluster: 'devnet' })              // 内置 devnet 节点
new SolanaClient('https://my-rpc.example')                      // 自己的节点
new SolanaClient(['https://rpc-1.example', 'https://rpc-2.example']) // 主节点 + 备用节点
new SolanaClient(connection)                                    // @solana/web3.js 的 Connection（使用其 rpcEndpoint）
new SolanaClient({ request: (method, params) => myRpc(method, params) }) // 自定义传输

// 独立函数的节点参数相同
await getBalances(owner, mints, { provider: 'https://my-rpc.example', cluster: 'mainnet' })
```

**内置公共节点**（`DEFAULT_RPC_URLS`）：mainnet 依次是 publicnode 和官方节点。2026-10 实测：

- publicnode：放行跨域、支持批量请求，但不支持 `getTokenAccountsByOwner`、`getTokenLargestAccounts` 等需要索引的方法
- 官方节点 `api.mainnet-beta.solana.com`：对带浏览器 `Origin` 的请求返回 403，只能在服务端使用；限频较严

所以扫描持仓、`getNftOwners`、`getOwnerNfts` 在内置节点上可能不可用，生产环境建议传入自己的节点。

**传输层行为**（`HttpRpc`）：

- 收集窗口（`batchWait`，默认 0 即同一 tick）内的调用合并成一个批量请求，最多 `maxBatchSize`（默认 20）条
- 节点不支持批量请求时自动改为逐条并发；返回 “Batch of more than N” 时按 N 缩小批量；请求体过大（413）时批量减半。批量请求被限频或拒绝访问时不会降级（降级只会让限频更严重）
- HTTP 429 和 JSON-RPC 错误码 429 都会退避重试（`retries`，默认 2；传入多个自定义节点时为 0，直接换节点；内置节点保留重试），批量里只重试被限频的那几条
- 单次请求超时 `timeout`，默认 10 秒

**故障切换**（多节点时）：网络错误、超时、限频、403、需要 API Key、请求被拦截、高度不到 `minContextSlot` 等节点问题换下一个节点；参数错误等确定性错误直接抛出（`RpcError`，`isNodeFault(err)` 可判断）。

- 出错的节点冷却 `cooldown`（默认 30 秒），期间排到最后。**超时不冷却**（大批量查询慢一点很正常），同一节点连续 3 次超时才冷却；高度不够也不冷却
- 节点健康状态全局共享：URL 相同即同一个节点（其他节点按对象），客户端重建后刚出过错的节点仍排在后面
- 所有节点都失败时抛 `AllNodesFailedError`，`err.errors` 是 `{ node, error }[]`；单个节点时抛原始错误
- 节点名称（`node`）只取 URL 的 host，报错信息里的地址也只保留 origin，不会带出 path / query 里的 API Key；自定义传输可以设 `label`

**可观测性**：`onRequest(listener)` 监听所有客户端发出的调用，返回取消函数：

```ts
import { onRequest } from '@w3lib/solana-batch-call'

const stop = onRequest(({ node, method, ms, ok, error, attempt }) => {
  metrics.record({ node, method, ms, ok }) // attempt > 0 表示这次调用换过节点
})
```

每个 JSON-RPC 调用对每个节点的每次尝试一条（合并成批量 HTTP 请求时，批里每个调用各一条，`ms` 是该调用从发出到返回的时间）；单节点时也会触发。监听函数出错不影响请求。

**网络校验**：传了 `cluster`，或传了多个节点时，会用 `getGenesisHash` 确认每个节点所在的网络，不一致时报 `NetworkMismatchError`（多节点时换下一个节点）。校验与请求并行发出，结果按节点缓存，每个节点只多一次请求；内置节点不校验。`await client.getCluster()` 返回节点所在网络。

## 配置

```ts
new SolanaClient(provider?, {
  cluster: 'mainnet',          // 'mainnet' | 'devnet' | 'testnet'
  commitment: 'confirmed',     // 'processed' | 'confirmed' | 'finalized'
  nativeMints: [NATIVE_MINT, SYSTEM_PROGRAM_ID],
  timeout: 10_000,
  maxBatchSize: 20,
  batchWait: 0,
  batch: true,                 // false：不合并成批量请求
  retries: 2,
  cooldown: 30_000,
  headers: { 'x-api-key': '…' },
  fetch: customFetch,          // 需要代理等场景
})
```

在 Node 里通过代理访问节点时：Node 自带的 `fetch` 默认不读 `HTTPS_PROXY`，Node 24+ 可以设置 `NODE_USE_ENV_PROXY=1`，或者通过 `fetch` 选项传入自定义实现。

## 批量写操作

子路径 `@w3lib/solana-batch-call/write`：只做查询时打包不会带上这部分代码。不依赖 Solana SDK，私钥签名用运行环境的 WebCrypto（Ed25519）。

```ts
import { NATIVE_MINT, SolanaClient } from '@w3lib/solana-batch-call'
import { batchCall, batchCollect, batchTransfer } from '@w3lib/solana-batch-call/write'

const client = new SolanaClient('https://my-rpc.example')

// 一对多转账：多个收款人打包进同一笔交易（按 1232 字节上限自动分笔）；代币收款人没有 ATA 时自动创建
await batchTransfer(client, secretKey, [
  { to: a, formatted: '0.5' },                 // 默认 SOL（options.token）
  { to: b, token: USDC, formatted: '20' },
])

// 归集：多个钱包 → 一个地址。feePayer 付所有手续费，子钱包不需要有 SOL，多个钱包的转账打包进同一笔交易
const { results } = await batchCollect(client, [key1, key2, key3], hotWallet, {
  tokens: [USDC, NATIVE_MINT],   // 包含 SOL：代币归集确认后扫空 SOL
  feePayer: gasKey,
  closeAccounts: true,           // 关闭清空的代币账户，租金（约 0.00204 SOL）退回钱包后一起扫走
})

// 批量调用程序：每个调用是一组原子执行的指令（web3.js / @solana/kit / 本库格式都可以）
await batchCall(client, [
  { from: key1, instructions: [ix1, ix2] },
  { from: key2, instructions: ix3, signers: [newAccountKeypair] },
], { feePayer: gasKey })
```

**钱包**：base58 私钥（Phantom 等导出的 64 字节格式或 32 字节种子）、solana-keygen 的 JSON 数组、`Uint8Array`（64 字节，或 32 字节种子）、web3.js 的 `Keypair`、@solana/kit 的 `KeyPairSigner`，或自定义 `{ address, sign(message) }`（KMS / 硬件钱包，或运行环境的 WebCrypto 不支持 Ed25519 时自己用 @noble/curves 签名）。错误信息里不会带出私钥。32 字节的 base58 字符串不接受（和地址长得一样，传错成地址时会悄悄变成另一个钱包），32 字节种子请传 `Uint8Array`。

**浏览器钱包**：`from`、`feePayer`、`signers` 都可以直接传浏览器钱包，可以和私钥混用（如浏览器钱包当 `feePayer` 给一批子钱包付手续费）：

```ts
// @solana/wallet-adapter（React）：传 useWallet() 的返回值，或 wallet.adapter
const wallet = useWallet()
await batchTransfer(client, wallet, recipients)

// 直接用 Wallet Standard（Phantom / Solflare / Backpack / OKX 等都实现了）
import { getWallets } from '@wallet-standard/app'
const phantom = getWallets().get().find((w) => w.name === 'Phantom')   // 已连接；指定账户传 { wallet: phantom, account }
await batchCollect(client, [key1, key2], hotWallet, { tokens: [USDC], feePayer: phantom })

// @solana/kit 的 TransactionSigner（如 @solana/react 的 useWalletAccountTransactionSigner）
await batchCall(client, [{ from: signer, instructions }])
```

- **一次确认**：同一批交易先全部模拟，再让钱包一次签完（Wallet Standard 的 `signTransaction` 一次传多笔），然后发送。所以同一批里依赖前面交易结果的调用模拟会失败（钱包签名前还没有交易发出）：这类调用分成两次调用。例外：交易过期没上链时自动重发，每笔会再请求一次签名；同一个钱包出现在多个手续费支付者分组里时（如 batchCall 里不同调用的付款方不同），每组请求一次
- 钱包先签、本地私钥后签（有的钱包只在交易没有其他签名时才会往里加指令）。钱包改了交易（如加了优先费用）时：只有它一个签名者就接受（用户在钱包里确认过，这时 `fee` 为 null）；还有其他签名者时这笔失败，不让本地私钥去签钱包改过的内容
- 用户拒绝时这批交易都是 `failed`，`error` 为 `'rejected by user'`
- 钱包换了交易的 blockhash 时，不知道新 blockhash 的有效期，这笔不会自动重发（误判过期再发一笔可能两笔都上链），等不到确认时为 `pending`
- 钱包需要支持 Wallet Standard（主流钱包都支持）；不支持的 adapter（如部分硬件钱包 adapter）可以包成 @solana/kit 的 `TransactionPartialSigner`：`{ address, signTransactions: (txs) => … }`，`txs` 里是消息字节，返回 `{ [address]: 签名 }`

**打包与发送**：
- 同一手续费支付者的相邻调用打包进同一笔交易（`mode: 'pack'`，默认；`'tx'` 每个调用一笔）。Solana 一笔交易本来就能放多条指令，不需要 EVM 上 Disperse 那样的合约
- 每笔先模拟：失败的调用（余额不足、账户冻结、SOL 转给新地址但低于免租下限等）单独标记 `failed`，其余重新模拟后照常发送；模拟失败且同一支付者还有未确认的交易时，先等它们确认再模拟一次（后一笔依赖前一笔的结果时自动正确处理）。节点暂时的问题（限频、高度落后）会重试，不当成调用失败
- 计算单元上限按模拟结果设置（× 1.1 + 1000），优先费用默认 `'auto'`：按这笔交易可写账户的最近费用取 75 分位，不超过 `maxPriorityFee`（默认 1,000,000 micro-lamports / CU）。调用里自带的 SetComputeUnitLimit / SetComputeUnitPrice 指令会被去掉（和库加的重复会让交易失败），优先费用用 `priorityFee` 指定
- 交易发出后不等确认就发下一笔；等待期间每两次轮询重发一次原交易，一次 `getSignatureStatuses` 查所有交易。blockhash 过期仍没上链时换新 blockhash 重新模拟、重发，最多 `retries` 次（默认 2）。判断过期时，再查一次历史的那个节点的数据必须不早于看到过期的那个 slot（多节点 / 负载均衡时落后的节点可能还没看到已上链的交易），否则这一轮先不判断，避免重复执行
- Token-2022：有转账手续费的代币，`amount` 是转出的数量，收款方实际收到的更少；带 transfer hook 的代币，TransferChecked 需要额外的账户，本库不支持（模拟会失败，这一项 `failed`）
- 同一笔交易上链后才失败时一起回滚，里面的调用都是 `reverted`

**结果**：与输入一一对应，可以直接 `JSON.stringify`：

```ts
{ index: 0, from, status: 'confirmed', signature: '5x…', slot: 123, fee: '5000', computeUnits: 450, error: null }
// batchTransfer 另有 to / token / native / amount / formatted / createdAccount；
// batchCollect 另有 to / token / native / amount / formatted / close（关闭代币账户的结果）
```

`status` 与 EVM 版相同：`confirmed` / `reverted`（上链但失败，手续费已扣）/ `failed`（没有发出去，不花手续费）/ `sent`（`wait: false`；或广播时节点都连不上，交易可能已发出，`error` 里有说明）/ `pending`（等到 `timeout` 还没确认）/ `skipped` / `simulated`（`dryRun`）。`fee` 是整笔交易的手续费（每个签名 5000 lamports + 优先费用），同一笔交易里的调用相同，不含新建账户的租金。

**归集流程**（`batchCollect`）：一次读出所有钱包的余额 → 归集地址没有该代币的 ATA 时创建（传了 `feePayer` 时随第一批转账创建；不传时先由第一个有这种代币的钱包单独创建，其他钱包只需付得起手续费）→ 打包发送代币转账（`closeAccounts` 时随后关闭代币账户）→ 包含 SOL 时等代币归集确认，按最新余额扫空 SOL：传了 `feePayer` 时整个余额转走，否则扣掉这笔的手续费后转走（余额归零）。代币没有全部归集成功的钱包不扫 SOL；余额为 0、低于 `minAmount`、钱包就是归集地址或 `feePayer` 的项为 `skipped`。Solana 上不需要先给子钱包补 gas，传 `feePayer` 即可；不传时没有 SOL 的钱包对应的项失败。`dryRun` 时代币转账照常模拟，扫 SOL 的金额要等归集之后才知道，只标记 `simulated`、不做模拟。

**共同选项**（`SendOptions`）：`feePayer`、`priorityFee` / `maxPriorityFee`、`wait`（默认 true）、`timeout`（默认 120 秒）、`pollInterval`（默认 2 秒）、`retries`（默认 2）、`commitment`（`'confirmed'` / `'finalized'`）、`concurrency`（不同手续费支付者并发数，默认 8）、`dryRun`、`signal`、`onUpdate`。

**指令工具**：`systemTransfer`、`transferChecked`、`createAssociatedTokenAccountIdempotent`、`closeAccount`、`setComputeUnitLimit`、`setComputeUnitPrice`，生成本库格式的指令，可直接放进 `batchCall`。

**体积**（esbuild 打包、minify，对比只用 `SolanaClient`）：引入 `batchTransfer` 增加约 22KB（gzip 约 8KB），三个函数都引入增加约 28KB（gzip 约 10KB），含浏览器钱包适配；没有新增依赖。

## 工具函数

```ts
import {
  getAssociatedTokenAddress, // ATA 地址
  getMetadataAddress,        // Metaplex 元数据账户地址
  findProgramAddress,        // 通用 PDA 推导（与 web3.js findProgramAddressSync 相同）
  isAddress,
  isOnCurve,                 // 32 字节是否是 ed25519 曲线上的点（与 web3.js PublicKey.isOnCurve 相同）
  parseMint, parseTokenAccount, parseMetaplexMetadata, // 账户数据解析
  parseTransferFeeConfig,    // Token-2022 转账手续费扩展
  formatUnits,               // 按精度换算：formatUnits(1_500_000_000n, 9) === '1.5'（formatAmount 是同一个函数的旧名字，已不推荐）
  parseUnits,                // 反过来：parseUnits('1.5', 9) === 1_500_000_000n
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, GENESIS_HASHES,
} from '@w3lib/solana-batch-call'
```

## 运行环境

Node 20.19+（依赖的 `@noble/hashes` 2.x 要求）、现代浏览器。写操作用私钥签名时需要 WebCrypto 支持 Ed25519（Node 20+、Chrome 137+、Firefox 129+、Safari 17+）；不支持的环境（如 React Native）传自定义 `{ address, sign }`。

## 开发

```bash
pnpm test        # 单元测试（模拟节点，不需要网络）
pnpm test:live   # 连真实节点（SOLANA_RPC 指定支持索引方法的节点；需要代理时加 NODE_USE_ENV_PROXY=1）
pnpm build
```

## License

MIT
