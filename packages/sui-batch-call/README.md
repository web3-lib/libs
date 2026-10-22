# @w3lib/sui-batch-call

Sui 批量读取和批量写操作库：SUI / 代币余额、代币信息、对象、NFT（Display）；一对多转账、多钱包归集、批量执行交易；Cetus、Bluefin、Momentum、Turbos、Magma、FlowX、Kriya（集中流动性），Cetus DLMM，DipCoin、FlowX V2、Kriya（传统 AMM），Aftermath（多币池）的 LP 仓位和加减流动性；在这些 DEX 之间找路线兑换（按模拟执行报价，与实际成交逐位一致）；代币风险检查（监管币 / 冻结、增发权限、元数据能否修改、能不能卖）；代币的美元价格（DefiLlama 当前 / 历史价格、Cetus / Turbos / FlowX 池子的链上价格）和地址的资产总值；SuiNS 域名解析（名字 ↔ 地址）；参考 gas 价格和交易手续费估算。通过 **gRPC-web** 直接访问全节点（Sui 已于 2026 年停用 JSON-RPC），多节点故障切换。不依赖 Sui SDK，浏览器和 Node（≥ 20.19）都能用。

```sh
pnpm add @w3lib/sui-batch-call
```

只做查询时打包后约 17KB（minify，gzip 约 7KB），不带任何依赖；写操作在子路径 `/write`（见[批量写操作](#批量写操作)）。

**在线 demo**：<https://web3-lib.github.io/libs/sui/>（余额、代币信息、LP 仓位（集中流动性、DLMM、传统 AMM、多币池，12 个协议）、添加 / 移除流动性（报价，连接浏览器钱包后可以发送）、价格和资产总值、SuiNS 域名（正向 + 反向）、手续费估算、兑换（报价，连接浏览器钱包后可以发送）、代币风险（监管币、增发权限、元数据、可选模拟买入再卖出）、NFT、对象，显示每次查询实际发出的 gRPC 调用）。本地运行：`pnpm --filter @w3lib/sui-batch-call demo`（http://localhost:5177）

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
| `prices` | `true` 用 DefiLlama，也可以传自己的 `SuiPriceSource`（如 `/price` 的 `combinePrices([defillamaPrices(), onchainPrices()])`）；默认不查。价格源出错时照样返回仓位，美元价值为 null（`onPriceError` 可以拿到错误） |
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

## 价格

子路径 `@w3lib/sui-batch-call/price`：代币的美元价格和地址的资产总值。

```ts
import { SUI_COIN_TYPE } from '@w3lib/sui-batch-call'
import { getPortfolio, getTokenPrices } from '@w3lib/sui-batch-call/price'

await getTokenPrices([SUI_COIN_TYPE, USDC, newCoin])            // 节点参数同其他快捷函数
// [{ token: '0x000…002::sui::SUI', native: true, price: 3.21, source: 'defillama' }, …, { token: newCoin, price: 0.0012, source: 'onchain' }]

const p = await getPortfolio(owner, { lp: true, minUsd: 1 })
p.totalUsd // 代币 + LP 仓位的合计；p.tokens 按价值排序，p.lp 是 LP 仓位
```

- 价格源依次使用，前面没有价格的代币交给后面的（`sources`，默认 `[defillamaPrices(), onchainPrices()]`），结果的 `source` 是给出价格的源；代币类型可以写短格式，结果的键是规范化的完整格式（`priceKeyOf`）
- `defillamaPrices({ at })`：历史价格（unix 秒或 `Date`）；`minConfidence` 过滤置信度低的价格（默认 0.9）
- `onchainPrices()`：在 **Cetus**、**Turbos**、**FlowX CLMM** 里找代币对 SUI、USDC、USDT 的池子，用计价币一侧最深的池子的价格；USDC（原生）、USDT（Sui Bridge）按 1 美元（`STABLECOINS`，可以用 `stablecoins` 换），SUI 按它对稳定币最深的池子。`minLiquidityUsd`（默认 10000）以下的池子不用，防止小池子的价格被操纵；暂停的池子不用。主网实测（2026-10）和 DefiLlama 相差在 1% 以内（SUI、CETUS、DEEP、WAL）
- 找池子不需要索引服务：三个 DEX 的工厂都把池子登记在表里，条目的对象 ID 按两种币（和手续费档位）在本地算出，再用 `BatchGetObjects` 读（主网上逐个核对过）：

| DEX | 注册表 | 条目的键 |
| --- | --- | --- |
| `cetus` | `factory::Pools` 的 `LinkedTable<ID, PoolSimpleInfo>` | `blake2b256(类型名 A ‖ 类型名 B ‖ u32 tick spacing)`，A 是字典序较大的币；tick spacing 读 GlobalConfig 的 `fee_tiers` |
| `turbos` | `pool_factory::PoolConfig` 的 `Table<ID, PoolSimpleInfo>` | `sha256(类型名 lo ‖ 类型名 hi ‖ 手续费类型名)`，手续费类型读 PoolConfig 的 `fee_map` |
| `flowx` | `PoolRegistry` 的动态对象字段 | `PoolDfKey { coin_type_x: lo, coin_type_y: hi, fee_rate }`，手续费档位固定 8 个 |

- 读取轮数：配置（两个对象，按节点缓存 10 分钟）、条目、池子和代币精度各一轮。每个代币要查约 100 个条目（SUI、两个稳定币 × 各 DEX 的手续费档位），`maxCoins`（默认 50）限制一次给多少个代币找池子，超出的没有价格；`protocols` 只用某些 DEX。Bluefin、Momentum 没有按币对登记池子的表，不用
- `combinePrices([…])` 把多个源组合成一个，可以传给 `getLpPositions` 的 `prices`；价格源的上下文里有 `client`（链上价格源用它读池子），`lpPositions` 会传入
- 资产总值：Sui 节点能直接列出地址持有的全部代币（一次 `ListBalances`），也可以用 `coinTypes` 只算某些代币；`lp: true`（或 `getLpPositions` 的参数）时加上 LP 仓位的 `valueUsd`（不含未领取的手续费和奖励），作为仓位计入的 LP 代币（DipCoin、FlowX V2、Aftermath）不再算在代币里。`minUsd` 只影响列出的代币，不影响合计；`unpriced` 是算不出价值的代币和仓位数

价格只用于展示和估值：链上价格是池子当前的价格，可能被单笔交易影响，不要用它算交易的最小数量。持有大量垃圾币的地址，资产总值要读每个代币的信息、给 DefiLlama 没有收录的代币找池子，请求较多（2026-10 主网上一个持有 383 种代币的地址约 16 秒）。

打包（esbuild、minify，对比只用 `SuiClient`）：`getTokenPrices` 约增加 22KB（gzip 约 9KB，含 blake2b、sha256），`getPortfolio`（含 LP 仓位）约 65KB（gzip 约 24KB）；已经用到 `/lp` 时 `getPortfolio` 再增加约 10KB（gzip 约 4KB）。

## 域名解析

子路径 `@w3lib/sui-batch-call/names`：SuiNS 的名字 → 地址、地址 → 默认名字。

```ts
import { formatSuiName, getAddressNames, getNameAddresses } from '@w3lib/sui-batch-call/names'

await getNameAddresses(['example.sui', '@adeniyi', 'cny@stashed'])   // 节点参数同其他快捷函数
// [{ name: 'example.sui', normalized: 'example.sui', address: '0x214a…9db0', expiresAt: 1912952738221 },
//  { name: '@adeniyi', normalized: 'adeniyi.sui', address: '0x1eb7…e0b1', expiresAt: 1874340606618 }, …]
await getAddressNames(['0x1eb7…e0b1'])
// [{ address: '0x1eb7…e0b1', name: 'adeniyi.sui' }]
formatSuiName('cny.stashed.sui', 'at')   // 'cny@stashed'
```

- 名字可以写点分格式（`example.sui`、`sub.example.sui`）或 `@` 格式（`@example`、`sub@example`），大小写不限；结果的 `normalized` 是小写的点分格式（`normalizeSuiName`），不合法的名字（不是 `.sui` 结尾、标签有非法字符等）为 null。显示成 `@` 格式用 `formatSuiName(name, 'at')`
- 不需要索引服务：SuiNS 把名字记录放在注册表 `Table<Domain, NameRecord>` 里、默认名字放在反查表 `Table<address, Domain>` 里，条目是动态字段，对象 ID 按名字（标签倒序的 `Domain`）或地址在本地算出，再用 `BatchGetObjects` 读（每次 50 个，自动分批）。正查一轮，反查两轮
- 有效性按 SuiNS 的规则（与 Sui GraphQL 的解析一致）：到期时间早于现在的名字 `address` 为 null（`expiresAt` 是过去的时间）；叶子子域名（没有自己的 NFT 和到期时间）跟随父域名，父域名过期或重新注册过（NFT 对不上）时无效。时间按链上时钟对象（`0x6`）算，不依赖本机时间。名字没有设置目标地址时 `address` 为 null
- 反查读默认名字后再正查核对：名字没过期、目标地址就是这个地址才返回（名字过期、转手或改了指向后，旧的反查记录还在，不能直接用）
- 内置主网和测试网的部署（`SUINS`，表 ID 从 SuiNS 对象的 `RegistryKey<Registry>` 动态字段里读出来核对过）；devnet 等网络传 `suins: { package, registry, reverseRegistry }`

主网核对（2026-10）：`example.sui`、`@adeniyi`、`Manos.SUI`、叶子子域名 `cny.stashed.sui`、节点子域名 `shafiq.talise.sui` 的地址，过期的 `goodsoul.sui`、父域名重新注册过的叶子 `2349013927723.kns.sui`、没设地址的 `suins.sui` 为 null，反查（含反查记录还在、名字已过期的地址）都和 Sui GraphQL（`address(name:)`、`defaultNameRecord`）一致。

打包（esbuild、minify，对比只用 `SuiClient`）：约增加 13KB（gzip 约 5KB，主要是 blake2b 和 BCS 编码）；已经用到 `/price` 或 `/lp` 时约增加 3KB（gzip 不到 1.5KB）。

## 手续费估算

子路径 `@w3lib/sui-batch-call/fees`：当前的 gas 价格，和一笔交易要花多少 SUI。

```ts
import { getCostEstimate, getFeeEstimate } from '@w3lib/sui-batch-call/fees'
import { PtbBuilder, pure } from '@w3lib/sui-batch-call/write'

await getFeeEstimate()   // { epoch: '1285', referenceGasPrice: '100' }

const ptb = new PtbBuilder()
const coin = ptb.command({ kind: 'splitCoins', coin: ptb.gas, amounts: [ptb.pure(pure.u64(1_000_000n))] })
ptb.command({ kind: 'transferObjects', objects: [ptb.nested(coin, 0)], address: ptb.pure(pure.address(to)) })
await getCostEstimate({ from: owner, kind: ptb.build() })
// { gasPrice: '100', computationCost: '100000', storageCost: '1976000', storageRebate: '987901', nonRefundableStorageFee: '99',
//   total: '1088099', totalFormatted: '0.001088099', gasBudget: '2491200', gasBudgetFormatted: '0.0024912', symbol: 'SUI' }
```

- **为什么没有三档**：Sui 的参考 gas 价格（reference gas price）由验证者每个 epoch（约 24 小时）定一次，epoch 内不变，没有随区块变化的 baseFee，按参考价格发送就会被正常处理，所以 `getFeeEstimate` 只返回 `referenceGasPrice`（/write 默认用的价格）。出价更高只在交易用到拥堵的共享对象（如热门池子）时有用：这些交易按 gas 价格排队，这时给 /write 传 `gasPrice`
- **一笔交易**：`kind` 同 `batchCall`（@mysten/sui 的 `tx.build({ onlyTransactionKind: true })` 的字节 / base64，或本库的 `ProgrammableTransaction`），`from` 是地址（只模拟，不需要私钥），`sponsor` 是付 gas 的地址。和 /write 发送时一样选 gas 币（没有 Coin 时用地址余额）、模拟执行一次，返回：
  - `computationCost`（计算消耗 × gas 价格）、`storageCost`（写入的对象的存储费）、`storageRebate`（删除 / 改写的对象原来付的存储费，已扣掉 1% 不返还的 `nonRefundableStorageFee`）
  - `total` = 计算费 + 存储费 − 返还，是实际花掉的 SUI，可能为负（合并、删除对象时返还多于花费）
  - `gasBudget`：/write 发送时用的 gas 上限，(计算费 + 存储费) × `gasMultiplier`（默认 1.2），不低于 0.002 SUI，不超过付款地址可用的 SUI。执行前付款地址至少要有这么多 SUI（返还在执行后才到账）
- `gasPrice`、`gasMultiplier` 同 /write；模拟失败（Move abort、付款地址没有 SUI 等）时抛出

主网核对（2026-10，参考 gas 价格 100 MIST）：从持有 SUI 的地址转 0.001 SUI（从 gas 币拆出）净花费约 0.00109 SUI，gas 上限 0.0025 SUI；赞助交易整个转走一个 USDC Coin，存储返还几乎抵掉存储费，净花费约 0.0001 SUI；`gasPrice` 翻倍时计算费翻倍；没有 SUI 的地址报错。

打包（esbuild、minify，对比只用 `SuiClient`）：`getFeeEstimate` 不到 1KB；`getCostEstimate` 约增加 29KB（gzip 约 10KB，就是 /write 的选币、编码、模拟代码），已经用到 /write 时约增加 1KB。

## 兑换

子路径 `@w3lib/sui-batch-call/swap`：卖出固定数量（exact input），在 [LP 仓位](#lp-仓位) 支持的 12 个协议里找最好的路线。

```ts
import { SUI_COIN_TYPE, SuiClient } from '@w3lib/sui-batch-call'
import { buildSwap, getSwapQuote, swap } from '@w3lib/sui-batch-call/swap'

const plan = await getSwapQuote(owner, { tokenIn: SUI_COIN_TYPE, tokenOut: USDC, amountInFormatted: '10' })   // 节点参数同其他快捷函数
// { amountOut: '9936693', amountOutFormatted: '9.936693', amountOutMin: '9887009', price: 0.9937, priceImpact: 0.00001,
//   route: { path: [SUI, USDC], hops: [{ protocol: 'dipcoin', pool: '0x7fbd…', tokenIn, tokenOut, fee: 3000 }], amountOut }, routes: [...], kind, gasSpend }

const sui = new SuiClient()
const r = await swap(sui, key, { tokenIn: CETUS, tokenOut: SUI_COIN_TYPE, amountInFormatted: '500' }, { slippage: 0.01 })
r.status // 'confirmed'；r.plan 是实际发出的交易和报价
```

- **报价**：每条候选路线在只读调用（SimulateTransaction，检查关闭）里执行一遍兑换的命令、读出买到的 Coin 的数量，是各 DEX 合约自己算的结果（含手续费、跨 tick、动态费率），不在本地重写每个 DEX 的数学。卖出 SUI 时用模拟的 gas 币，`owner` 不需要持有；卖出其他代币时从 `owner` 的 Coin 里拆，`owner` 要持有足够的数量（否则报 `Insufficient balance`）
- **路线**（读池子 / Coin 时节点出错直接抛出，不当作没有路线）：直接兑换的每个池子；经过中间币（`intermediates`，默认 SUI、USDC）的两跳：先用第一跳的每个池子报价、取输出最多的，再和第二跳的每个池子组成两跳路线报价（两跳可以跨 DEX）。每条路线一次只读调用，按 `concurrency`（默认 `SuiClient` 的 concurrency）并发。`routes` 是报价成功的全部路线，从高到低
- **找池子**：Cetus、Magma、Turbos、FlowX CLMM、DipCoin、FlowX V2 的工厂把池子登记在表里，条目的对象 ID 按两种币（和手续费档位）在本地算出，一轮 `BatchGetObjects` 读完（同 [价格](#价格)；Magma 与 Cetus 的算法相同，DipCoin / FlowX V2 的键是 `"LP-X-Y"`，两种顺序都查）。**Bluefin、Momentum、Kriya、Cetus DLMM、Aftermath 没有按币对登记的表**，要用 `pools` 传池子 ID（可以和自动找到的一起比较；`protocols: []` 时只用 `pools`）
- **最少收到**：`amountOutMin` = 报价 × (1 − `slippage`)（默认 0.005）；中间的每一跳不设下限，交易最后从买到的 Coin 里拆出 `amountOutMin` 再合并回去（同 `/liquidity` 的 `guardMin`），不够时整笔失败（发送前的模拟就会失败，不花 gas）。每一跳把传入的币全部卖出，剩下的输入币要正好为 0（`destroy_zero`），没卖完时也失败
- **价格影响**：同一路线卖出 1 / 10000 的数量的价格和这笔的价格差多少
- **交易**：一笔 PTB。卖出 SUI 时从 gas 币拆（`gasSpend`），代币按 Coin + 地址余额凑；买到的币合并进发送者已有的同类 Coin（SUI 合并进 gas 币；发送者没有 SUI Coin 对象、只有地址余额时 gas 由地址余额付，没有 gas 币，买到的 SUI 照常转给发送者）。`buildSwap` 只构建（`kind` 可以交给 `batchCall` 或自己签名）；`swap` 发送时按最新的 Coin 重新构建（路线和 `amountOutMin` 不变），钱包、`sponsor`（赞助交易）、`dryRun` 等同 `/write`，`checkBalance`（默认 true）先检查卖出的币够不够（SUI 另留 0.05 SUI 的 gas）

| 协议 | 兑换用的函数 |
| --- | --- |
| Cetus、Magma | integrate 包的 `router::swap` |
| Bluefin | `pool::swap`（Balance 进出） |
| Momentum、Kriya CLMM | `trade::flash_swap` + `swap_receipt_debts` + `repay_flash_swap` |
| Turbos | `swap_router::swap_a_b_with_return_` / `swap_b_a_with_return_` |
| FlowX CLMM | `swap_router::swap_exact_input`（经 PoolRegistry） |
| Cetus DLMM | `pool::flash_swap` + `pay_amount` + `repay_flash_swap` |
| DipCoin | `router::swap_exact_x_to_y_with_return` / `…y_to_x…` |
| FlowX V2 | `router::swap_exact_input_direct`（经 Container） |
| Kriya AMM | `spot_dex::swap_token_x` / `swap_token_y` |
| Aftermath | `swap::swap_exact_in_direct`（DAO 费池子走外壳包） |

主网核对（2026-10，`test/swap-live.test.ts`）：以真实持币地址的身份，对每个协议的 SUI / USDC 池子（Kriya AMM 是 Wormhole USDC）两个方向各兑换 1 个，再自动找路线兑换 SUI ↔ USDC、SUI ↔ CETUS（含 SUI → USDC → CETUS、CETUS → USDC → SUI 两跳）：把构建好的交易用真实的 gas 币模拟（检查开启），按余额变化算出买到的数量（SUI 加回 gas），全部 ≥ `amountOutMin`；模拟的同时只用选中的池子再报一次价，模拟结果与报价逐位相等（这期间池子正好有成交时重来）（例：10 SUI → 9.936693 USDC，500 CETUS → 11.225536491 SUI）。Kriya CLMM 在 2026-10 关闭了交易（所有池子的 `pool::assert_trading_enabled` 都失败），报价时没有路线。

**局限**：只支持卖出固定数量（不支持买入固定数量）；最多两跳、每跳一个池子（不拆单）；中间币只试 `intermediates` 里的；没有按币对登记的 DEX 只能传 `pools`；报价时卖出的币（SUI 除外）要在 `owner` 名下。报价是当时的状态，执行时由 `amountOutMin` 保护。

打包（esbuild、minify，对比只用 `SuiClient`）：`buildSwap` 约增加 60KB（gzip 约 22KB，12 个协议的池子解析和兑换命令、找池子的哈希），加上 `swap` 共约 79KB（gzip 约 28KB，含 `/write` 的发送代码）；已经用到 `/liquidity` 时再增加约 18KB（gzip 约 7KB）。

## 代币风险

子路径 `@w3lib/sui-batch-call/risk`：Sui 的 Coin 是标准对象，没有转账税，合约也拦不住转账，风险主要在发行方保留的权限。

```ts
import { getCoinRisks } from '@w3lib/sui-batch-call/risk'

const [usdc, cetus] = await getCoinRisks([USDC, CETUS], { address: owner })   // 节点参数同其他快捷函数
// usdc：{ regulated: true, allowGlobalPause: true, paused: false, denied: false, supply: 'mintable',
//         treasuryCap: { owner: 'object', root: { type: '0xecf4…::treasury::Treasury<…USDC>', owner: 'shared' } }, metadataMutable: true,
//         sell: { stage: 'ok', route: [{ protocol: 'cetus', pool: '0x51e8…' }], roundTripLoss: 0.0002 }, honeypot: false,
//         flags: ['regulated', 'global-pause', 'mintable', 'mutable-metadata'] }
// cetus：{ regulated: false, supply: 'fixed', treasuryCap: { owner: 'immutable' }, metadataCap: { owner: 'address', address: '0x69d3…' }, flags: ['mutable-metadata'] }
```

- **监管币**（`regulated`）：发行时创建了 DenyCapV2（`coin::create_regulated_currency_v2` 或 Coin Registry 的 `make_regulated`）或 v1 的 DenyCap，持有者可以冻结地址（被冻结的地址不能再用这个币作交易输入）；`allowGlobalPause` 时还能全局暂停（v1 没有）。改名单要 `&mut DenyCap`：DenyCap 或包着它的最外层对象已冻结 / 转给 0x0 时 `canFreeze: false`，不标记 `regulated` / `global-pause`。`paused`（当前 epoch 是否全局暂停）、`denied`（`address` 是否被冻结）用 DenyList（`0x403`）的 `coin::deny_list_v2_*_current_epoch` 在只读调用里读出；v1 用 `coin::deny_list_contains`，`paused` 为 null
- **增发**（`supply`）：`fixed`：节点报告固定供应（Coin Registry 的 `make_supply_fixed`），或 TreasuryCap 已冻结 / 转给了 0x0（`burned`），或包着它的最外层对象已冻结 / 转给了 0x0（增发要 `&mut TreasuryCap`）；`burn-only`：只能销毁；`mintable`：TreasuryCap 在地址名下、在别的对象里（`root` 是一路往上找到的最外层对象，如 USDC 放在 Circle 的 `treasury::Treasury` 共享对象里，增发由它的合约控制）或是共享对象；`unknown`：节点不知道 TreasuryCap 在哪（包在别的对象的字段里而不是动态字段、或已删除），这时没法从链上直接判断（没有反向索引），标记为 `supply-unknown`
- **元数据**（`metadataMutable`）：Coin Registry 的 `Currency` 看 MetadataCap：已删除 = 不能改；已领取 = 拿着 MetadataCap 的人能改（`metadataCap` 是它的持有者；setter 按引用取它，只有转给 0x0 才算没人能改）；未领取 = TreasuryCap 的持有者能领取后修改（领取只要 `&TreasuryCap`，TreasuryCap 冻结时谁都能传它，也算能改；转给 0x0 时不能改）。旧的 `CoinMetadata` 冻结了就不能改，否则同样看 TreasuryCap。权限对象在冻结的对象里（只能经那个合约）或节点读不到时为 null
- **能不能卖**（`sell`，默认开启，`sell: false` 关闭）：用 `/swap` 找 SUI → 代币最好的路线（`swap` 传 `pools` 等参数，同 `/swap`），在同一笔只读调用里用 `amount`（默认 0.1 SUI，模拟的 gas 币，不需要持有）买入、再按原路全部卖回 SUI。`stage`：`ok`、`no-pool`（没有池子）、`buy-failed`（有池子但买不进）、`sell-failed`（买进后卖不出）；`roundTripLoss` 是来回一趟的损失（两次手续费 + 价格影响）。卖不出或损失 ≥ 90% 时 `honeypot: true`。兑换的代码按需加载
- `flags` 汇总：`not-found`、`regulated`（还能冻结地址）、`global-pause`、`paused`、`denied`、`mintable`、`supply-unknown`、`mutable-metadata`、`honeypot`、`cannot-buy`、`no-pool`、`high-round-trip-loss`（> 10%）
- 信息来自节点的 `GetCoinInfo`（元数据、TreasuryCap、监管信息）和这些对象本身：每个代币一次 `GetCoinInfo`、一轮读权限对象（在别的对象里时往上多读几层），监管币多一次只读调用

主网核对（2026-10，`test/risk-live.test.ts`）：USDC 是监管币、可以全局暂停、没有暂停，TreasuryCap 和 DenyCapV2 都在 Circle 的 `treasury::Treasury` 共享对象里；SUI 固定供应、元数据不能改；CETUS 的 TreasuryCap 已冻结（固定供应），MetadataCap 在一个地址名下；meme 币 FUD 的 TreasuryCap 转给了 0x0；DEEP 的 TreasuryCap 在 `ProtectedTreasury` 里；它们都能买进卖出（来回损失 0.02%~2%）。

**局限**：Sui 上的“貔貅”主要靠监管币冻结买家地址，这在同一笔交易里模拟不出来（冻结检查的是交易输入的 Coin），所以要结合 `regulated` / `denied` 看；TreasuryCap 包在别的对象的普通字段里时找不到持有者（`supply: 'unknown'`）；`root` 只给出最外层对象的类型，那个合约允许谁增发要看合约本身。

打包（esbuild、minify，对比只用 `SuiClient`）：约增加 24KB（gzip 约 9KB）；检查能不能卖时按需加载兑换的代码（约 62KB，gzip 约 23KB）。

## 模拟交易

子路径 `@w3lib/sui-batch-call/simulate`：不签名、不上链，用节点的 `SimulateTransaction`（检查开启）看一笔交易会发生什么。可以直接传本库构建器（`buildSwap`、`buildAddLiquidity`…）的结果，模拟通过再发送。

```ts
import { simulate } from '@w3lib/sui-batch-call/simulate'

const plan = await getSwapQuote(owner, { tokenIn: SUI_COIN_TYPE, tokenOut: USDC, amountInFormatted: '1' })
const sim = await simulate(plan, { sender: owner })          // 构建器的结果 / TransactionKind 要传 sender
const sim2 = await simulate(txBytesOrBase64)                 // 完整的 TransactionData（发送者在里面）
// { success: true, gasUsed: '…', fee: '…',
//   balanceChanges: [{ address, asset, symbol: 'SUI', decimals: 9, delta: '-1000000000', formatted: '-1', usd: -3.2 }, …],
//   objectChanges: [{ objectId, type, kind: 'created' | 'deleted' | 'transferred' | 'mutated', from, to, coin }],
//   decoded: { type: 'swap', protocol: 'dipcoin', method: 'router::swap', summary: 'Swap 1 SUI for 1.03 USDC on DipCoin', args: { calls } },
//   warnings: [], approvalChanges: [] }
```

- `balanceChanges`：所有地址的币变化（含对方）；SUI 不含 gas（手续费在 `fee`：计算 + 存储 − 返还，可以是负数——只传命令时节点自动选 gas 币，会合并一批 Coin 拿到存储返还；要看接近真实的手续费传完整的 TransactionData）。`usd` 用 `/price` 按需加载（`prices: false` 关闭，查不到为 null）
- `error` / `errorInfo`：失败原因。Move abort 给出函数、码和（新式错误的）常量名，系统包（`balance`、`coin`、`transfer`）常见码给出名字；余额不足、gas 不够等给可读说明。本库构建的兑换 / 移除用 SplitCoins 检查最少收到的数量，数量不够时会提示是滑点
- `decoded`：Move 调用解码。认得本库支持的 12 个协议（调用里的包是升级后的 storage id，用 `ListPackageVersions` 的第一个版本对照原始 id，结果缓存）；类型 `transfer` / `swap` / `liquidity` / `mint` / `contract`；不认得的合约里发送者付出一种币、收到另一种币的当作兑换
- `warnings`（`code`、`severity`、`message`）：`failed`、`publish`、`upgrade`、`unknown-package`（调用了不认得的包）、`object-transfer`（把非 Coin 对象转给别的地址）、`unknown-recipient`（`trustedRecipients` 传了白名单时，转给白名单之外的地址）、`high-gas-budget`（完整交易里的 gas 上限超过 `maxGasBudget`，默认 0.5 SUI）、`risky-token`（`risk: true` 时对收到的代币用 `/risk`（不模拟卖出）检查，按需加载）
- Sui 没有授权，`approvalChanges` 总是 `[]`

主网核对（2026-10，`test/simulate-live.test.ts`）：转账（余额变化不含 gas、收款人、新建的 Coin）、`0x2::pay::split` 超额的 Move abort 解码、`buildSwap` 的结果（识别出协议，余额变化 ≥ `amountOutMin`，美元价值）。

**局限**：没有构建一对多转账的函数（`batchTransfer` 用 `dryRun` 模拟），其他的传 `kind`；只传命令时 gas 币由节点选；没有按协议的错误码表（新式错误的常量名由节点给）。

## 交易历史

子路径 `@w3lib/sui-batch-call/history`：地址的交易历史，整理成 `Activity`（转账、兑换、流动性、铸造、合约调用、失败的），游标翻页，新的在前。

```ts
import { getHistory } from '@w3lib/sui-batch-call/history'

const page = await getHistory(address, { limit: 20, types: ['swap', 'transfer'] })
// items: [{ hash, time, block, status: 'success', type: 'swap', protocol, label: 'Swap 1 SUI for 1.03 USDC on DipCoin',
//           changes: [{ asset, symbol, decimals, delta, formatted }], direction, counterparty, fee, objects? }]
const older = await getHistory(address, { cursor: page.nextCursor })
```

- 数据源：gRPC 里没有“某个地址的交易”的接口，JSON-RPC 的 `suix_queryTransactionBlocks` 在公共节点上已下线（返回 `Method not found`）。默认依次用 **GraphQL**（`graphql.mainnet.sui.io`，`transactions(filter: { affectedAddress })`，完整历史）和 **节点的 gRPC `ListTransactions`**（`affected_address` 过滤；公共节点只保留最近几周，`x-sui-lowest-available-checkpoint` 之前的被裁掉）。前面的出错换后面的；两个数据源整理出的 `Activity` 一致
- 换数据源：`adapters: [graphqlHistory({ url, headers }), grpcHistory(transport), myIndexer]`。`HistoryAdapter` 是 `{ name, list(address, { limit, cursor, afterBlock, beforeBlock, signal }) → { txs: RawTx[], nextCursor } }`，带 Key 的索引服务实现它即可
- 游标跟着数据源走（`数据源:checkpoint:原始游标`）：下一页优先用同一个；它出错时换下一个，从游标里的 checkpoint 接着取（这个 checkpoint 里的交易可能重复，按 `hash` 去重）
- `fromBlock` / `toBlock`（checkpoint，含）限定范围；`types` 在取回后筛选，没取够 `limit` 时再取下一页（最多 5 页）；`limit` 默认 20，最多 50（GraphQL 每笔交易的响应约十几 KB）
- 站在这个地址的角度：`changes` 是它自己的币变化（SUI 不含 gas，`fee` 只在它付 gas 时有）；别人发起、对它只是收到东西的交易记为 `transfer`（`direction: 'in'`）；`objects` 是收到 / 送出的非 Coin 对象（NFT）；失败的交易 `status: 'failed'`，`error` 是 abort 码 / 原因

主网核对（2026-10，`test/simulate-live.test.ts`）：GraphQL 用游标往前翻页、时间递减且不重复；同一个地址 gRPC 与 GraphQL 整理出的 `Activity` 逐项相同；GraphQL 不可用时切到 gRPC。

打包（esbuild、minify）：`/history` 约 35KB，`/simulate` 入口约 22KB（加上共用的客户端，`/price`、`/risk` 按需加载）。

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
pnpm test:live:swap        # 兑换和代币风险（主网报价、模拟最终的交易并按余额变化核对；DEX=bluefin 只跑这个 DEX 的单池子用例）
SUI_DEVNET_KEY=suiprivkey1… pnpm test:devnet   # 在 devnet 真实执行写操作（这个私钥要有几个 devnet SUI）
pnpm demo                  # 本地运行 demo（demo/，直接用 src 的源码）
```

## License

MIT
