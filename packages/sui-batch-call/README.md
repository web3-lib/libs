# @w3lib/sui-batch-call

Sui 批量读取和批量写操作库：SUI / 代币余额、代币信息、对象、NFT（Display）；一对多转账、多钱包归集、批量执行交易；Cetus、Bluefin、Momentum、Turbos、Magma、FlowX、Kriya（集中流动性），Cetus DLMM，DipCoin、FlowX V2、Kriya（传统 AMM），Aftermath（多币池）的 LP 仓位和加减流动性。通过 **gRPC-web** 直接访问全节点（Sui 已于 2026 年停用 JSON-RPC），多节点故障切换。不依赖 Sui SDK，浏览器和 Node（≥ 20.19）都能用。

```sh
pnpm add @w3lib/sui-batch-call
```

只做查询时打包后约 17KB（minify，gzip 约 7KB），不带任何依赖；写操作在子路径 `/write`（见[批量写操作](#批量写操作)）。

**在线 demo**：<https://web3-lib.github.io/libs/sui/>（余额、代币信息、LP 仓位（集中流动性、DLMM、传统 AMM、多币池，12 个协议）、添加 / 移除流动性（报价，连接浏览器钱包后可以发送）、NFT、对象，显示每次查询实际发出的 gRPC 调用）。本地运行：`pnpm --filter @w3lib/sui-batch-call demo`（http://localhost:5177）

## 快速上手

```ts
import { SUI_COIN_TYPE, SuiClient, getBalances } from '@w3lib/sui-batch-call'

// 快捷函数：默认主网公共全节点（限频严，正式环境请用自己的节点或服务商）
await getBalances(owner)                                        // 持有的全部代币（余额为 0 的不返回）
await getBalances(owner, { coinTypes: [SUI_COIN_TYPE, USDC], provider: 'https://my-node…' })
// [{ token: '0x000…002::sui::SUI', native: true, balance: '1500000000', decimals: 9, formatted: '1.5', success: true }, …]

// 客户端：主节点 + 备用节点
const sui = new SuiClient(['https://my-node…', 'https://fullnode.mainnet.sui.io'])
await sui.balances(owner, ['0x2::sui::SUI'], { symbol: true })  // 类型可以写短格式，结果里是规范化的完整格式
await sui.multiBalances([{ owner: a }, { owner: b, coinTypes: [USDC] }])
await sui.coins([USDC])                                         // 精度、名称、symbol、图标、总供应量（有缓存）
await sui.objects(['0x6', id], { fields: ['type', 'owner', 'json'] })
await sui.ownedObjects(owner, { type: '0x2::coin::Coin' })      // 类型可以是完整类型或前缀
await sui.nfts(owner)                                           // NFT：节点渲染的 Display（name、image_url…）
```

| 方法 | 快捷函数 | 说明 |
| --- | --- | --- |
| `balances(owner, coinTypes?, opts)` | `getBalances(owner, { coinTypes })` | 不传 `coinTypes` 时返回持有的全部代币（`ListBalances`，自动翻页）；传了时与它一一对应（每个代币一个 `GetBalance`，并发发出） |
| `multiBalances(queries)` | `getMultiBalances(queries)` | 多个地址 |
| `coins(coinTypes)` | `getCoins(coinTypes)` | 代币信息（`GetCoinInfo`），进程内缓存 |
| `objects(ids, { fields })` | `getObjects(ids)` | 按 ID 读对象（`BatchGetObjects`，每次 50 个，自动分批），不存在的为 `null` |
| `ownedObjects(owner, { type, limit })` | `getOwnedObjects(owner)` | 地址拥有的对象，自动翻页 |
| `nfts(owner, { type, all })` | `getNfts(owner)` | 去掉代币后的对象，`name` / `description` / `imageUrl` / `link` / `projectUrl` / `creator` 取自 Display；没有 Display 的 NFT 取内容里的同名字段（`image_url` / `img_url` / `url`）。默认只返回像 NFT 的对象，`all: true` 返回全部非代币对象 |
| `serviceInfo()` | | 网络、epoch、最新 checkpoint |

结果的约定：

- 余额、供应量是最小单位的十进制字符串；`formatted` 按精度换算，读不到代币信息时 `decimals` / `formatted` 为 `null`
- 代币类型统一成节点返回的完整格式（地址补足 64 位），`normalizeStructTag` / `normalizeSuiAddress` 可以单独用
- 失败项 `success: false`，`error` 为 `'invalid-address'`（地址非法）、`'invalid-type'`（类型写错）或 `'not-found'`（代币不存在：没有代币信息且余额为 0）
- `withCheckpoint: true` 时返回读取时节点的 checkpoint；`minCheckpoint` 要求节点至少到某个 checkpoint（如刚执行的交易所在的 checkpoint），落后的节点换下一个，都落后时等一会儿再试（最多约 10 秒）
- 地址拥有的对象不包括放在 Kiosk 等容器里的（它们属于 Kiosk 对象）

## 批量写操作

子路径 `@w3lib/sui-batch-call/write`：只做查询时打包不会带上这部分代码。交易在本地按 BCS 编码（与 @mysten/sui 的编码逐字节一致），私钥签名用运行环境的 WebCrypto（Ed25519）。

```ts
import { SUI_COIN_TYPE, SuiClient } from '@w3lib/sui-batch-call'
import { PtbBuilder, batchCall, batchCollect, batchTransfer, pure } from '@w3lib/sui-batch-call/write'

const sui = new SuiClient(['https://my-node…'])

// 一对多转账：所有收款人打包进同一笔可编程交易（每笔最多 batchSize 个，默认 200），SUI 和代币可以混在一起
await batchTransfer(sui, 'suiprivkey1…', [
  { to: a, formatted: '1.5' },                 // 默认 SUI（options.token）
  { to: b, token: USDC, formatted: '20' },
  { to: b, amount: 1_000_000n },               // 同一收款人的多个币一次转
])

// 归集：多个钱包 → 一个地址，每个钱包一笔交易。sponsor 付 gas（Sui 原生的赞助交易），子钱包不需要 SUI，SUI 也能全部转走
await batchCollect(sui, [key1, key2, key3], hotWallet, { tokens: [USDC, SUI_COIN_TYPE], sponsor: gasKey })

// 批量执行交易：kind 是 @mysten/sui 构建的 TransactionKind，或用本库的 PtbBuilder 拼
const kind = await tx.build({ client, onlyTransactionKind: true })   // @mysten/sui 的 Transaction
const ptb = new PtbBuilder()
ptb.moveCall('0x…::pool::deposit', [USDC], [ptb.object({ kind: 'shared', objectId: pool, initialSharedVersion: 1n, mutable: true }), ptb.pure(pure.u64(100n))])
await batchCall(sui, [{ from: key1, kind }, { from: key2, kind: ptb.build(), sponsor: gasKey }])
```

**钱包**：`suiprivkey1…`（Sui CLI / 钱包导出的格式）、32 字节十六进制（0x 可省略）、旧版 keystore 的 base64（33 字节，带方案标志）、`Uint8Array`（32 字节种子，或 64 字节、前 32 字节是种子）、@mysten/sui 的 `Keypair`、自定义 `{ address, signTransaction(bytes) }`（KMS / 硬件钱包，返回 Sui 序列化签名），或 Wallet Standard 浏览器钱包（Slush / Suiet / OKX 等，`getWallets().get()` 拿到的对象；用第一个账户，指定账户传 `{ wallet, account }`），可以和私钥混用（如浏览器钱包当 `sponsor`）。私钥只支持 Ed25519。

- 浏览器钱包用 `sui:signTransaction` 签名（每笔交易请求一次），交易由本库发送；钱包改了交易（如调整 gas）时用钱包签的版本，赞助交易里则判为失败（付款钱包的签名对不上）
- `dryRun` 只模拟，不请求签名

**gas**：
- 付款钱包（`sponsor`，没有时是发送者）的 SUI Coin 当 gas 币（最多 255 个，交易里用到的除外）；没有 Coin（或只剩零头、地址余额更多，且交易没有用到 gas 币）时，gas 直接从地址余额（Address Balances）扣（交易用 `ValidDuring` 过期规则）。Sui 规定一笔交易最多从地址余额取款 10 次（地址余额付 gas 算一次），超过时不发送、直接 `failed`
- gas 上限：先模拟，按实际消耗 × `gasMultiplier`（默认 1.2）；`gasBudget` 固定上限不模拟。Sui 会先从 gas 币里预留 gas 上限，所以上限不超过 gas 币扣掉交易拆走的 SUI 后剩下的部分。gas 价格默认当前 epoch 的参考价格（`gasPrice` 可改）
- 模拟失败的交易不发送（`failed`，不花 gas）

**转账和归集的细节**：
- SUI 从 gas 币拆出（发送者自己付 gas、SUI Coin 足够时，可以转到只剩 gas）；代币先合并发送者的 Coin（从大到小选到够为止，每笔交易合计最多 1000 个）再拆分。Coin 不够时从地址余额取差额（`coin::redeem_funds`）；Coin 太多、一笔交易用不完而地址余额又不够补时直接报错（调小 `batchSize`，或先归集给自己合并 Coin）。`batchSize` 默认 200，最多 500（一条命令最多 512 个参数）
- 收款人收到的是 Coin 对象
- 发送前检查余额（`checkBalance: false` 关闭），不够时直接报错
- 归集把指定代币的全部 Coin 合并后转走，地址余额里的部分也取出来。有 `sponsor` 时 SUI 全部转走；没有时把 gas 币整个转走（最多 255 个 SUI Coin 合并成的 gas 币，扣掉 gas 后剩下的全部），地址余额里的 SUI 不动，没有 SUI Coin 的钱包不能归集 SUI。余额为 0 的钱包为 `skipped`，读不到余额的为 `failed`。Coin 特别多（超过 1000 个，SUI 超过 255 个）、或有地址余额的代币超过 9 种的钱包一次归集不完（每笔交易最多从地址余额取款 10 次），再调用一次即可。同一个钱包传了多次时只归集一次（其余 `skipped`）

**执行**：共用发送者或付款钱包的交易依次执行（会用到同一批对象：本库选的 Coin 和 gas 币按执行结果里的新版本更新，下一笔不用等节点同步；`batchCall` 里自己写进交易的对象引用要自己保证是最新的），其余并发（`concurrency`，默认 8）。执行后等交易进入 checkpoint 再返回（约 15 秒内），之后的读取要求节点至少到这个 checkpoint；结果里的 `checkpoint` 也可以当 `minCheckpoint` 读到执行后的状态：

```ts
const results = await batchTransfer(sui, key, recipients)
const checkpoint = Math.max(...results.map((r) => r.checkpoint ?? 0))
await sui.balances(recipient, [SUI_COIN_TYPE], { minCheckpoint: checkpoint })
```

**结果**：与输入一一对应，可以直接 `JSON.stringify`：

```ts
{ index: 0, from, status: 'confirmed', digest: '9wYi…', fee: '1000099', checkpoint: 2395595, error: null }
// batchTransfer 另有 to / token / amount / formatted；batchCollect 另有 to / tokens（归集了哪些代币）
```

`status`：`confirmed`（执行成功）/ `reverted`（上链但执行失败，gas 已扣）/ `failed`（没有发出：模拟失败、付不起 gas、钱包里拒绝等，不花 gas）/ `sent`（已提交但节点都连不上，不能确认结果，可以用 `digest` 查）/ `skipped`（同一组前面的交易失败、已取消；`batchCall` 的 `continueOnError: true` 时后面的照常执行，但前面有 `sent` 的总是跳过）/ `simulated`（`dryRun`）。`fee` 是整笔交易实际花的 gas（计算 + 存储 − 存储返还，可能为负），同一笔交易里的调用相同。

**共同选项**（`SendOptions`）：`gasPrice`、`gasBudget`、`gasMultiplier`、`dryRun`、`concurrency`、`signal`、`onUpdate`。

**工具**：`PtbBuilder`（拼可编程交易：输入去重，`gas` / `pure` / `owned` / `object` / `withdrawal` / `command` / `nested` / `moveCall`）、`pure`（BCS 编码 `u8` / `u64` / `u128` / `bool` / `address` / `string` / `vector`）、`encodeTransactionData` / `encodeTransactionKind`、`transactionDigest`、`resolveSigner`、`ed25519Address`。

**体积**（esbuild 打包、minify，对比只用 `SuiClient`）：引入 `batchTransfer` 增加约 37KB（gzip 约 14KB），三个函数都引入增加约 39KB（gzip 约 14KB），其中约 15KB 是依赖（@noble/hashes 的 blake2b、@scure/base 的编码）。

## LP 仓位

子路径 `@w3lib/sui-batch-call/lp`：
- 集中流动性（`type: 'clmm'`）：**Cetus**、**Bluefin Spot**、**Momentum**（MMT）、**Turbos**、**Magma**、**FlowX CLMM**、**Kriya CLMM** 的仓位对象
- bin 式集中流动性（`type: 'dlmm'`）：**Cetus DLMM** 的仓位对象
- 传统 AMM（`type: 'amm'`）：**DipCoin**、**FlowX V2**、**Kriya** 的 LP
- 多币池（`type: 'multi'`）：**Aftermath** 的 LP（2~8 种币的加权池 / 稳定池，含 DAO 费池子）

集中流动性和 DLMM：未领取的手续费和挖矿奖励由合约自己算：一次只读调用（不检查交易的模拟，不需要 gas）里对每个仓位执行各 DEX 的领取 / 计算函数，读返回的数量，与真正领取时的结果相同。传统 AMM：撤出能拿到的数量 = LP × 储备 / LP 总量（手续费已经计入储备）。可选美元价值。

```ts
import { getLpPositions, lpPositions } from '@w3lib/sui-batch-call/lp'

await getLpPositions(owner, { prices: true })        // 快捷函数（节点参数同其他快捷函数）
await lpPositions(sui, owner, { positions: [id] })   // 只看指定的仓位对象（按类型认出协议）
// [{ type: 'clmm', protocol: 'bluefin', protocolName: 'Bluefin', pool, position,
//    token0: { coinType: '0x…::sui::SUI', symbol: 'SUI', decimals: 9 }, token1,
//    amount0, amount1, amount0Formatted, amount1Formatted, fee: 2000, tickSpacing: 40, tickLower, tickUpper, tick, inRange, liquidity,
//    price, priceLower, priceUpper, fees0, fees1, fees0Formatted, fees1Formatted,
//    rewards: [{ coinType, symbol, decimals, amount, formatted, valueUsd }], restricted: false,
//    valueUsd, feesUsd, rewardsUsd },
//  { type: 'dlmm', protocol: 'cetus-dlmm', position, binStep: 50, binLower, binUpper, activeBin, inRange, price, priceLower, priceUpper,
//    amount0, amount1, fees0, fees1, rewards, fee: 4000, … },
//  { type: 'amm', protocol: 'dipcoin', pool, position: null, lpCoinType: '0x…::manage::LP<…>', balance, totalSupply, share: 0.0123,
//    amount0, amount1, reserve0, reserve1, fee: 500, stable: false, price, valueUsd },
//  { type: 'multi', protocol: 'aftermath', pool, position: null, lpCoinType: '0x…::af_lp::AF_LP', balance, totalSupply, share,
//    coins: [{ coinType, symbol, decimals, weight: 0.2, reserve, amount, amountFormatted, valueUsd }, …],
//    fee: 2500, stable: false, protocolFee: 500, daoFee: null, valueUsd }]
```

| 协议 | 仓位 | 手续费 / 奖励怎么算 |
| --- | --- | --- |
| `cetus` | 地址拥有的 Position | `pool::calculate_and_update_fee` / `calculate_and_update_rewards`；数量用 `get_position_amounts_v2` |
| `magma` | 地址拥有的 Position（Cetus 的分叉） | 同 Cetus；数量用 `get_position_amounts` |
| `bluefin` | 地址拥有的 Position | `pool::get_accrued_fee` / `get_accrued_rewards` |
| `momentum` | 地址拥有的 Position | `collect::fee` / `collect::reward`（只读调用里领取，读 Coin 的数量） |
| `turbos` | 地址拥有的仓位 NFT（仓位在共享的 Positions 里） | `position_manager::collect_with_return_` / `collect_reward_with_return_`；tick 和流动性用 `get_position_info` 读 |
| `flowx` | 地址拥有的 Position（池子在 PoolRegistry 里） | `position_manager::collect` / `collect_pool_reward` |
| `kriya-clmm` | 地址拥有的 Position（与 Momentum 的接口相同） | `collect::fee` / `collect::reward` |
| `cetus-dlmm` | 地址拥有的 Position（区间 [lower_bin, upper_bin]） | `pool::refresh_position_info_v2` 一次给出数量、手续费、奖励 |
| `dipcoin` | LP 代币 `Coin<manage::LP<X, Y>>`（从地址余额里认出来，一次 `ListBalances`） | 计入储备；池子按 Global 里 registered_pools 表的条目找（条目的对象 ID 本地算出） |
| `flowx-v2` | LP 代币 `Coin<pair::LP<X, Y>>` | 计入储备；池子是 Container 里 pairs 表的条目（本地算出对象 ID，`pool` 是这个 ID） |
| `kriya-amm` | 地址拥有的 `KriyaLPToken<X, Y>` 对象（每个对象一个仓位） | 计入储备 |
| `aftermath` | LP 代币（每个池子一种，如 `Coin<…::af_lp::AF_LP>`）：余额里没有类型参数的代币，按 PoolRegistry 的 lp_coin_map 表认出来（条目的对象 ID 本地算出） | 计入储备；取回的数量扣协议手续费和 DAO 费 |

| 选项 | 说明 |
| --- | --- |
| `positions` | 只查这些仓位对象 ID（Turbos 是仓位 NFT 的 ID，Kriya AMM 是 KriyaLPToken 的 ID），不扫描地址拥有的对象；这时 LP 是普通代币的 AMM（DipCoin、FlowX V2）不查 |
| `protocols` | 只查某些协议：`'cetus'` / `'bluefin'` / `'momentum'` / `'turbos'` / `'magma'` / `'flowx'` / `'kriya-clmm'` / `'cetus-dlmm'` / `'dipcoin'` / `'flowx-v2'` / `'kriya-amm'` / `'aftermath'`，默认全部（仓位对象每个协议扫描一次地址拥有的对象；LP 代币一次 `ListBalances`）。`SUI_LP_PROTOCOLS` 有各协议的名称、类型和对象 / 代币类型 |
| `includeClosed` | 返回已清空的仓位（流动性为 0、手续费和奖励也领完，仓位对象还在；Kriya AMM 是 LP 为 0 的 KriyaLPToken），默认 false |
| `prices` | `true` 用 DefiLlama，也可以传自己的 `SuiPriceSource`；默认不查。价格源出错时照样返回仓位，美元价值为 null（`onPriceError` 可以拿到错误） |
| `onError` | 某个协议读取出错时调用 `(protocol, err)`：扫描、准备工作出错时跳过这个协议（照样返回其他协议的仓位）；只读调用时节点出错，仓位照样返回、手续费和奖励为 null |
| `fetch` / `signal` | 查价用的 fetch、取消查询 |

- 撤出能拿到的数量：Cetus / Magma 用合约的 `get_position_amounts(_v2)`；其他协议按 tick 和流动性用集中流动性的公式算（与合约相同的整数算法；tick → sqrt 价格用 Cetus 的 tick_math，六个 DEX 都是它，主网上逐位核对过）
- 合约会升级：调用时用包的最新版本（`ListPackageVersions` 查，进程内缓存 10 分钟）
- `fee` 是手续费率（百万分之一，2500 = 0.25%；DLMM 是基础手续费率，另有随波动变化的部分）；价格都是 token1 / token0，按精度换算的浮点数，只用于展示（传统 AMM 是储备的比例，DLMM 是 bin 的价格 (1 + binStep / 10000)^bin）
- 一次只读调用最多算 50 个仓位，整批执行失败时逐个再算；个别仓位出错时它的手续费 / 奖励为 null，不影响其他仓位。节点出错（限频、超时）时不逐个重试，这些仓位的手续费 / 奖励为 null，错误交给 `onError`。某个协议的扫描出错时只少它的仓位，读不到池子的仓位跳过（都会调用 `onError`）；`positions` 里重复的 ID 只返回一次
- Turbos 的 tick 和流动性用单独的只读调用读（与领取分开）；读不到时数量和区间为 null
- 用 `positions` 指定别人的仓位时，只读调用以仓位的持有人为发送者
- `restricted`：Cetus 标记的受 2025 年 5 月攻击事件影响的仓位（`pool::is_attacked_position`），合约不允许一次移除全部流动性；其他协议为 false
- Turbos 的两个池子有已停用的奖励（与官方 SDK 相同的列表），不领取，数量记为 0；这样的仓位如果还有已停用奖励没领，合约不允许关闭（`burn`），只能移除流动性
- FlowX 的手续费用 `position_manager::collect` 读，它返回仓位全部待领取的币：在别处移除了流动性、还没领取的本金也算在手续费里
- 传统 AMM：DipCoin、FlowX V2 的 LP 是普通代币，地址持有的同一种 LP 合计一个仓位（`position` 为 null）；`balance` 含地址余额里的部分
- FlowX V2 的协议手续费（Uniswap V2 式的 `mint_fee`）在移除时先增发给协议，实际取回的数量比 `amount0` / `amount1` 略少
- Aftermath：`coins[].amount` 是按比例取回全部币时能拿到的，按合约的算法（r = LP / 总量，每种币 = 储备 × r）扣掉协议手续费（`protocolFee`，0.05%，读 ProtocolFeeVault；有推荐人时略少）和 DAO 费（`daoFee`），主网上与模拟执行的结果逐位一致。约 20% 的池子是 DAO 费池子（池子放在 DaoFeePool 里，`pool` 仍是 Pool 的 ID）。`fee` 是 swap 手续费率，`weight` 是权重（稳定池也照样返回）
- **局限**：只认地址直接拥有的仓位对象 / LP；质押在农场 / 金库里的查不到（如 Aftermath 的 afLP 金库）。BlueMove、STEAMM 等暂不支持

## 添加 / 移除流动性

子路径 `@w3lib/sui-batch-call/liquidity`：与 `/lp` 相同的协议。集中流动性的报价按集中流动性的公式在本地算；交易调用各 DEX 合约的函数，合约检查数量上限 / 下限，超出滑点时整笔失败。DLMM 和传统 AMM 见下面各自的说明。计划（plan）的 `type` 是 `'clmm'` / `'dlmm'` / `'amm'`，只适用于某一种的字段在其他类型里为 null。

- `buildAddLiquidity` / `buildRemoveLiquidity` / `buildCollectFees`：只读取、不签名，返回报价和交易内容（`kind`，按发送者当前的 Coin 构建、发送者自己付 gas），可以交给 `batchCall` 或自己签名
- `addLiquidity` / `removeLiquidity` / `collectFees`：报价后签名发送，钱包和发送参数与 `/write` 相同（还可以传 `sponsor` 赞助 gas）

```ts
import { lpPositions } from '@w3lib/sui-batch-call/lp'
import { addLiquidity, buildAddLiquidity, collectFees, removeLiquidity } from '@w3lib/sui-batch-call/liquidity'

// 新建仓位：池子（按类型认出协议）+ 价格区间（token1 / token0，或 tickLower / tickUpper，或 fullRange: true）+ 一边的数量
const plan = await buildAddLiquidity(sui, owner, { pool, priceLower: 3, priceUpper: 4, amount0Formatted: '100' })
// { action: 'add', protocol: 'turbos', position: null, tickLower, tickUpper, liquidity, amount0, amount1, fixed: 'token0',
//   amount0Max, amount1Max, amount0Min, amount1Min, kind, gasSpend, … }
await addLiquidity(sui, key, { pool, fullRange: true, amount1Formatted: '10' })

// 已有仓位：lpPositions 的结果或仓位对象 ID（Turbos 是仓位 NFT 的 ID）
const [position] = await lpPositions(sui, owner)
await addLiquidity(sui, key, { position, amount0Formatted: '50' })           // 追加
await removeLiquidity(sui, key, { position, percent: 50 })                  // 按比例移除（先领取手续费和奖励）
await removeLiquidity(sui, key, { position, burn: true })                   // 全部移除并关闭仓位
await collectFees(sui, key, { position })                                   // 只领取手续费和奖励
```

| 协议 | 新建 / 追加 | 移除 / 关闭 | 领取 |
| --- | --- | --- | --- |
| Cetus、Magma | integrate `pool_script_v2::open_position_with_liquidity_by_fix_coin` / `add_liquidity_by_fix_coin`（固定一边，另一边上限） | `remove_liquidity` / `close_position`（带下限） | `collect_fee` / `collect_reward` |
| Bluefin | `pool::open_position` + `gateway::provide_liquidity_with_fixed_amount`（固定一边，两边上限） | `gateway::remove_liquidity`（带下限）/ `close_position` | `gateway::collect_fee` / `pool::collect_reward` |
| Momentum | `liquidity::open_position` + `add_liquidity`（两边的币 + 下限） | `remove_liquidity`（带下限）/ `close_position` | `collect::fee` / `collect::reward` |
| Turbos | `position_manager::mint_with_return_` / `increase_liquidity_with_return_`（期望数量 + 下限） | `decrease_liquidity_with_return_`（带下限）/ `burn` | `collect_with_return_` / `collect_reward_with_return_` |
| FlowX | `position_manager::open_position` + `increase_liquidity_v2`（两边的币 + 下限） | `decrease_liquidity`（带下限）+ `collect` / `close_position` | `collect` / `collect_pool_reward` |

- `slippage`：数量滑点，默认 `0.005`。添加时给的一边是固定的数量，另一边的上限 = 按当前价格算出的数量 × (1 + s)（`amount0Max` / `amount1Max`），下限 = 数量 × (1 − s)（`amount0Min` / `amount1Min`）；移除时下限 = 数量 × (1 − s)。价格移动使数量超出上限 / 下限时交易失败（不扣代币）
  - Cetus、Magma、Bluefin 按固定的一边加，固定的数量正好用完；Momentum、Turbos、FlowX 按两边的币能加的较少的流动性加，价格不利时固定的一边也可能只用一部分（不少于下限），剩下的退回
- 两边数量都给时，按能加的较少的一边固定，另一边的上限不超过给的数量（这一边没有滑点余量，价格不利时交易失败）；区间在当前价格一侧时只需要一种代币（价格在区间下方只要 token0，上方只要 token1）
- 代币从发送者的 Coin 里凑（不够时用地址余额补），SUI 在发送者自己付 gas、SUI Coin 够时从 gas 币拆；没用完的部分、新仓位和领取的代币都转回发送者
- 部分移除 / 领取前先只读调用一次，只领取数量不为 0 的奖励（执行失败时不领奖励）；关闭仓位时全部奖励都领取（报价到执行之间奖励可能从 0 开始累积，仓位要清空才能关闭）。Bluefin 的奖励用 `pool::collect_reward` 领（`gateway::collect_reward` 在数量为 0 时失败）
- 领取的代币和找零：合并进发送者已有的同类 Coin（找零合并回付款的那个 Coin，SUI 在自己付 gas 时合并进 gas 币），不新建数量为 0 的币；发送者没有这类 Coin 时同类的合并成一个再转给发送者
- Turbos、FlowX 的交易带截止时间（构建后 10 分钟）：`build*` 的 `kind` 要在这之前签名发送
- 仓位要直接属于发送者（质押在农场 / 金库里的不行）
- `build*` 返回的 `kind` 按发送者自己付 gas 构建（SUI 从 gas 币拆）：要赞助 gas 时用 `addLiquidity` 等发送函数的 `sponsor`，不要把 `kind` 交给带 sponsor 的 `batchCall`（会从付款钱包的 gas 币里拆出 SUI）
- 发送前按上限检查余额，SUI 另外留出约 0.05 SUI 的 gas（`checkBalance: false` 关闭）
- Cetus 受攻击影响的仓位（`restricted`）全部移除或关闭时提前报错，只能部分移除

**Cetus DLMM**（router 的 spot 策略：区间内平均分配，当前 bin 以上的 bin 只放 token0，以下的只放 token1，当前 bin 两种都放）：

```ts
await addLiquidity(sui, key, { pool, priceLower: 0.9, priceUpper: 1.1, amount0Formatted: '100', amount1Formatted: '100' })  // 两边各自给
await addLiquidity(sui, key, { pool, tickLower: bin + 2, tickUpper: bin + 20, amount0Formatted: '100' })               // 区间在当前价格上方：只放 token0（tick 就是 bin id）
await addLiquidity(sui, key, { position, amount0: 1000n, amount1: 1000n })                                              // 追加（仓位的区间）
await removeLiquidity(sui, key, { position, percent: 30 })                                                              // 按比例移除（先领取手续费和奖励）
await removeLiquidity(sui, key, { position, burn: true })                                                               // 全部移除并关闭
```

- 新建：`router::spot::open_position`；追加：`router::spot::add_liquidity`；移除：`pool::remove_liquidity_by_percent`；关闭：`close_position` + `destroy_close_position_cert`；领取：`update_position_fee_and_rewards` + `collect_position_fee` / `collect_position_reward`
- 一个仓位最多 1000 个 bin（不支持 `fullRange`）；价格按 bin 向下取整（价格所在的 bin）
- 合约的加减流动性没有数量上下限：用 `binShift` 防价格变动（`slippage` 换算成允许当前 bin 偏离报价时的 bin 数，至少 1 个；`router::utils::validate_active_id_slippage` / router 参数检查，超出时整笔失败）。移除时另在交易里检查取回的数量不少于 `amount0Min` / `amount1Min`（预计 × (1 − `slippage`)；从取回的币里拆出下限再合并回去，不够时整笔失败）；添加的计划里下限为 `'0'`
- 池子关闭了领取（`disable_collect_fee` / `disable_collect_reward`）时：部分移除和领取跳过被关闭的那部分，关闭仓位报错；空仓位按比例移除时报错
- 移除只能按比例（`percent`，万分之一精度）或 `burn`，计划的 `liquidity` 是移除的比例（万分之一）；添加的计划 `liquidity` 为 `'0'`（每个 bin 各有份额）

**传统 AMM**（DipCoin、FlowX V2、Kriya）：

```ts
await addLiquidity(sui, key, { pool, amount0Formatted: '100' })                        // 给一边，另一边按储备比例（向上取整）
await addLiquidity(sui, key, { position, amount1Formatted: '5' })                      // lpPositions 的结果：往它的池子里加
await removeLiquidity(sui, key, { position, percent: 50 })                              // 或 liquidity: LP 数量
await removeLiquidity(sui, key, { pool, percent: 100 })                                 // DipCoin、FlowX V2：只给池子，移除持有的这个池子的 LP
```

| | 添加 | 移除 |
| --- | --- | --- |
| DipCoin | `router::add_liquidity`（两边的币 + 下限，入口函数；LP 和多余的币转给发送者） | `router::remove_liquidity`（LP 数量 + 下限） |
| FlowX V2 | `router::add_liquidity`（传 Container，带截止时间） | `router::remove_liquidity`（拆出正好的 LP） |
| Kriya | `spot_dex::add_liquidity`（返回新的 KriyaLPToken，多余的币转给发送者） | `spot_dex::remove_liquidity`（部分移除时剩下的 KriyaLPToken 转回发送者；合约没有数量下限，取回后在交易里检查） |

- 预计的 LP = min(数量 / 储备 × 总量)；两边都给时按比例实际用掉的部分是 `amount0` / `amount1`，给的数量是 `amount0Max` / `amount1Max`，下限 = 实际用掉的 × (1 − `slippage`)
- 移除：预计数量 = LP × 储备 / 总量（向下取整），下限 = 预计 × (1 − `slippage`)；有一边会取回 0 时报错（数量太少）
- DipCoin、FlowX V2 用的是入口函数：付款的币只能来自 Coin 对象（不能用地址余额，发送前的余额检查也只算 Coin 对象；SUI 在自己付 gas 时从 gas 币拆）；LP 也只算 Coin 对象里的
- 手续费已经计入 LP 份额：`collectFees` / `buildCollectFees` 报错；不支持新建池子（池子为空时报错）；DipCoin 每次添加至少要铸造池子规定的最少 LP

**多币池（Aftermath）**：计划的 `type` 是 `'multi'`，每种币的数量在 `coins` 里（`token0` / `token1`、`amount0` / `amount1` 是前两种）：

```ts
await addLiquidity(sui, key, { pool, coin: USDC, amountFormatted: '100' })                    // 按比例：给一种币，其余按储备比例
await addLiquidity(sui, key, { pool, coin: SUI_COIN_TYPE, amountFormatted: '10', single: true })  // 只存一种币
await removeLiquidity(sui, key, { position, percent: 50 })                                     // 按比例取回全部币（或 liquidity: LP 数量）
await removeLiquidity(sui, key, { pool, protocol: 'aftermath', percent: 100, outCoin: USDC })   // 只取回一种币
```

| | 调用 | 报价 / 保护 |
| --- | --- | --- |
| 按比例存入 | `deposit::all_coin_deposit_N_coins`（全部币，`&mut`，按最少的比例取，剩下的退回） | 预计的 LP 按合约的算法估算（扣协议手续费和 DAO 费）；合约没有下限，在交易里检查拿到的 LP 不少于预计 × (1 − `slippage`) |
| 只存一种币 | `deposit::deposit_1_coins_direct`（带 LP 下限） | 按模拟执行的结果报价（发送者要有这些币），LP 下限 = 报价 × (1 − `slippage`) |
| 按比例取回 | `withdraw::all_coin_withdraw_N_coins` | 按合约的算法算出（与模拟结果逐位一致）；合约没有下限，在交易里检查每种币不少于预计 × (1 − `slippage`)（`coins[].amountMin`） |
| 只取一种币 | `withdraw::withdraw_1_coin_direct`（带数量下限） | 按模拟执行的结果报价，下限 = 报价 × (1 − `slippage`) |

- DAO 费池子调用外壳包（`0x6f60a0…`）的同名函数（多传 DaoFeePool 和 Version），存取时多收 `fee_bps`；`pool` 传 Pool 的 ID 或 DaoFeePool 的 ID 都可以
- 每次存取都收协议手续费（0.05%，按比例存入时从给的全部币上收）；`collectFees` 报错（手续费已经计入 LP 份额）

核对方式：每个协议都在主网上以真实仓位持有人 / 持币地址的身份模拟执行：仓位读取（手续费、奖励）、新建（区间内两边、区间一侧）、追加、部分移除、领取、全部移除并关闭；传统 AMM 是 LP 读取、按比例移除、添加。

打包（esbuild、minify，对比只用 `SuiClient`）：`/lp` 约增加 55KB（gzip 约 20KB，十二个协议的读取、只读调用的交易编码、算动态字段 ID 的 blake2b），再加上 `build*` 共约 98KB（gzip 约 32KB），再加上发送函数共约 117KB（gzip 约 38KB，含 `/write` 的发送代码）。只用 `/lp` 时不会打包各 DEX 的交易命令。

`addLiquidity` 等发送函数结果里的 `plan.kind` 是实际发出的交易。

## 节点

- 节点是 gRPC-web 的 URL（如 `https://fullnode.mainnet.sui.io`），或自己实现的 `GrpcTransport`（`unary(method, request)`）；数组时依次故障切换
- 网络不通、超时、HTTP 错误、`UNAVAILABLE` / `RESOURCE_EXHAUSTED` 等节点问题换下一个节点，出错的节点冷却 30 秒；参数错误、对象不存在等确定性错误直接抛出
- 按响应头 `x-sui-chain` 核对节点的网络（`network` 选项，默认 `'mainnet'`），不一致的节点不用（`NetworkMismatchError`）
- 限频（HTTP 429 / `RESOURCE_EXHAUSTED`）时同一节点退避重试 `retries` 次（默认 2）；`timeout` 默认 10 秒；`headers` 可以带服务商的 API Key；`concurrency` 限制同时发出的请求数（默认 16）
- 主网公共全节点由 Sui Foundation 提供，限频严、只适合开发测试；支持 gRPC 的服务商见 [Sui 文档](https://docs.sui.io/develop/accessing-data/rpc-providers)

## 开发

```sh
pnpm test                  # 单元测试（假的 gRPC-web 节点，不需要网络）
pnpm test:live             # 连主网（SUI_GRPC 可以指定节点；需要代理时加 NODE_USE_ENV_PROXY=1），写操作只模拟
pnpm test:live:liquidity   # 各 DEX 的 LP 仓位和加减流动性（主网模拟；DEX=bluefin 时 dex-live / amm-live 只跑这一个 DEX）
SUI_DEVNET_KEY=suiprivkey1… pnpm test:devnet   # 在 devnet 真实执行写操作（这个私钥要有几个 devnet SUI）
pnpm demo                  # 本地运行 demo（demo/，直接用 src 的源码）
```

## License

MIT
