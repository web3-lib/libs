# @w3lib/solana-batch-call

Solana 批量读取库：余额（SOL / SPL Token / Token-2022）、代币详情、NFT、[LP 仓位](#lp-仓位)（子路径 `/lp`）、[价格和资产总值](#价格)（子路径 `/price`）、[手续费估算](#手续费估算)（子路径 `/fees`）、[SNS 域名解析](#域名解析)（子路径 `/names`）、[授权管理](#授权管理)（子路径 `/approvals`）、[代币风险检查](#代币风险)（子路径 `/risk`）；[添加 / 移除流动性](#添加--移除流动性)（子路径 `/liquidity`）、[兑换](#兑换)（子路径 `/swap`）；以及[批量写操作](#批量写操作)（一对多转账、多钱包归集、批量调用程序，子路径 `/write`）。不依赖 Solana SDK，直接发 JSON-RPC。

```bash
pnpm add @w3lib/solana-batch-call
```

**在线 demo**：<https://web3-lib.github.io/libs/solana/>（余额、代币信息、资产列表、NFT、LP 仓位、添加 / 移除流动性、代币价格和资产总值、授权查询和撤销 / 关闭空代币账户、SNS 域名解析、优先费估算、兑换、代币风险检查；写操作先报价 / 构建，连接浏览器钱包后可以发送；显示每次查询实际发出的 RPC 调用数）。本地运行：`pnpm --filter @w3lib/solana-batch-call demo`（http://localhost:5175）

- **一次请求查一批**：账户读取用 `getMultipleAccounts`（自动去重、按 100 个一组拆分、最多同时 3 个请求）；同一 tick 内发起的 RPC 调用合并成一个 JSON-RPC 批量请求
- **免费节点也能查余额**：指定代币时在本地推导关联代币账户（ATA）地址，和 mint 账户一起用 `getMultipleAccounts` 读完，不需要 `getTokenAccountsByOwner` 这类索引方法
- **只查主币不读账户数据**：SOL 余额（`getSolBalances`、单币模式里的主币）用带 `dataSlice` 的 `getMultipleAccounts` 只取 lamports，与代币账户分开两组、同一个批量请求发出——钱包是数据很大的程序账户时也不会拖慢或超时
- **Token-2022**：余额、decimals、TokenMetadata 扩展里的 name / symbol / uri 都支持
- **价格**（子路径 `/price`）：DefiLlama 当前 / 历史价格、链上 Raydium / Orca 池子价格（按 PDA 推导池子，不需要 `getProgramAccounts`），组合价格源，地址的资产总值（代币 + LP 仓位）
- **手续费估算**（子路径 `/fees`）：三档优先费建议（可以只看交易会写的账户），一笔交易的花费（基础费 + 优先费 + 新建账户的免租押金），支持指令和构建好的 legacy / v0 交易
- **域名解析**（子路径 `/names`）：SNS（Bonfida，`.sns`），批量正查（SOL 记录 V1 / V2、代币化域名）、反查主域名（核对属于这个地址）
- **授权管理**（子路径 `/approvals`）：代币账户的 delegate 授权、可以关闭回收租金的空账户，批量撤销 / 关闭（Token-2022 暂存的转账手续费自动先收走）
- **兑换**（子路径 `/swap`）：Raydium CLMM / CPMM / AMM v4、Orca Whirlpool 的池子里找最好的路线（直接或经过 SOL / USDC / USDT 两跳），按链上状态本地报价（与程序逐位一致，主网模拟核对），SOL 自动包装 / 解包
- **代币风险**（子路径 `/risk`）：增发 / 冻结权限、Token-2022 的转账手续费、永久授权、转账 hook、不可转让、默认冻结、可暂停等扩展；可选模拟“买入 → 卖出”判断能不能卖
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

## LP 仓位

查一个地址的流动性仓位（子路径 `@w3lib/solana-batch-call/lp`，不用时打包不会带上，约 14KB / gzip 约 5.5KB）：**Raydium CLMM**、**Orca Whirlpool** 的仓位 NFT，**Raydium AMM v4**、**Raydium CPMM** 的 LP 代币。返回两种代币的数量、未领取的手续费（集中流动性），可选美元价值。

```ts
import { getLpPositions } from '@w3lib/solana-batch-call/lp'

// 扫描地址的全部代币账户找仓位 NFT 和 LP 代币（需要支持 getTokenAccountsByOwner 的节点）
await getLpPositions(owner, { provider: 'https://my-rpc.example' })
// [
//   { type: 'clmm', protocol: 'raydium-clmm', protocolName: 'Raydium CLMM', pool: '3ucNos…', positionMint: '6MZXir…', position: '18Pfqm…',
//     token0: { mint: So111…, symbol: 'SOL', decimals: 9 }, token1: { mint: EPjF…, symbol: 'USDC', decimals: 6 },
//     amount0: '140261364355', amount0Formatted: '140.261364355', amount1Formatted: '6852.200542',
//     fees0Formatted: '0.546399344', fees1Formatted: '59.504301', fee: 400, tickSpacing: 1, tickLower: -23362, tickUpper: -19392, tick: -22166,
//     inRange: true, liquidity: '357565923571', price: 108.99, priceLower: 96.7, priceUpper: 143.8 },
//   { type: 'amm', protocol: 'raydium-amm', pool: '58oQCh…', lpMint: '8HoQne…', balance, totalSupply, share: 0.18, amount0Formatted, amount1Formatted, … },
// ]

// 免费公共节点：指定仓位 NFT / LP 代币的 mint（按 ATA 读余额），AMM v4 / CPMM 再指定池子
await getLpPositions(owner, { mints: [positionNft, lpMint], pools: [ammPool] })

// 美元价值（DefiLlama，默认不查）：valueUsd、feesUsd，结果按价值排序
await getLpPositions(owner, { provider, prices: true })
```

| 选项 | 说明 |
| --- | --- |
| `mints` | 只看这些代币（仓位 NFT 的 mint、LP 代币的 mint），按 ATA 读余额，免费节点也能用。不传时扫描全部代币账户（需要支持 `getTokenAccountsByOwner` 的节点） |
| `pools` | Raydium AMM v4 / CPMM 的池子地址。LP 代币要找到对应的池子：不在这里的按 LP mint 用 `getProgramAccounts` 查找（免费公共节点大多不支持，这时报错并提示传 `pools`，或用 `protocols` 只查 CLMM / Whirlpool）；不是 AMM v4 / CPMM 池子的地址会报错；不持有 Raydium 的 LP 代币时不会用到 |
| `protocols` | 只查某些协议：`'raydium-clmm'`、`'orca-whirlpool'`、`'raydium-amm'`、`'raydium-cpmm'`，默认全部 |
| `includeClosed` | 返回已清空的仓位（流动性为 0、手续费也领完，NFT 还在），默认 false |
| `prices` | `true` 用 DefiLlama，也可以传自己的 `SolanaPriceSource`；默认不查。价格源出错时照样返回仓位，只是 `valueUsd` / `feesUsd` 为 null |
| `onPriceError` | 价格源出错时调用（传入错误），用来区分“价格服务出错”和“代币没有价格” |
| `fetch` | 自定义 fetch（如走代理）：快捷函数里同时用于节点请求和查价 |
| `signal` | 取消查询（AbortSignal） |

**怎么找仓位**：精度 0、数量 1 的代币按 PDA `["position", mint]` 推导 Raydium / Orca 的仓位账户，存在就是仓位；其他代币读 mint，mint 权限是 AMM v4（`5Q544f…`）或 CPMM 的权限地址时是 Raydium 的 LP 代币。整个查询一般 4~5 次请求（扫描 / 读余额、仓位账户和 mint、池子、tick 数组和金库、代币信息），每次都是批量读取。

**数值**（与链上程序的计算逐位一致，测试用主网账户快照与官方 SDK 核对过）：

- 集中流动性：数量是撤出全部流动性能拿到的数量（向下取整，不含手续费）；手续费 = 已记账的 + 流动性 × 区间内手续费增长的变化，与程序领取时的计算相同，不含挖矿奖励。Orca 固定大小和可变大小（DynamicTickArray）的 tick 数组都支持；有流动性却读不到两端的 tick 数据时（极少见）`fees0` / `fees1` 为 null，不会只报已记账的部分
- AMM v4 / CPMM：LP 份额 × （金库余额 − 不属于 LP 的部分）向下取整，与撤出流动性时一致。AMM v4 扣掉待提取的收益（need_take_pnl），CPMM 扣掉协议 / 基金 / 创建者手续费；总量用池子记录的 LP 数量。AMM v4 的池子还能用 OpenBook 挂单时（status 不是 6 SwapOnly，现在很少见），挂单里的资金没算进来，数量会略少
- `fee` 是手续费率（百万分之一，400 = 0.04%）；价格都是 token1 / token0，按精度换算的浮点数，只用于展示
- Wrapped SOL 显示为 SOL（按客户端的 `nativeMints` 配置），价格就是 SOL 的价格

**局限**：质押在农场里的 LP 代币、Orca 的仓位组合（Position Bundle）、锁仓的 Raydium 仓位（NFT 不在用户名下）查不到；Meteora 等其他 DEX 暂不支持。免费公共节点不支持扫描（`getTokenAccountsByOwner`）和按 LP mint 找池子（`getProgramAccounts`），需要传 `mints` / `pools` 或用自己的节点（官方节点 `api.mainnet-beta.solana.com` 两个方法都支持，但只能在服务端用，且按方法限频：同一个批量请求里有两个 `getTokenAccountsByOwner` 就会被拒，可以用 `new HttpRpc(url, { batch: false })` 关闭合并）。

## 添加 / 移除流动性

子路径 `@w3lib/solana-batch-call/liquidity`：**Raydium CLMM**、**Orca Whirlpool**（仓位 NFT），**Raydium AMM v4**、**Raydium CPMM**（LP 代币），与 [LP 仓位](#lp-仓位) 相同的四个协议。不依赖各 DEX 的 SDK，指令按程序的格式本地编码。

- `buildAddLiquidity` / `buildRemoveLiquidity` / `buildCollectFees`：只读取、不签名，返回预计的数量和按顺序执行的指令（`steps`），可以当作报价，也可以自己组交易发送
- `addLiquidity` / `removeLiquidity` / `collectFees`：构建后签名发送，钱包与 `/write` 的 `batchCall` 相同（私钥、Keypair、Wallet Standard 钱包、wallet-adapter、@solana/kit 签名器）。准备工作（创建代币账户、初始化 Orca 的 tick 数组）和主指令能放进同一笔交易时合成一笔、原子执行（主指令模拟失败时什么都不发）；放不下时先发准备工作。SOL 的包装和解包始终和主指令在同一步里，不会留下包装好的 SOL

```ts
import { SolanaClient } from '@w3lib/solana-batch-call'
import { getLpPositions } from '@w3lib/solana-batch-call/lp'
import { addLiquidity, buildAddLiquidity, collectFees, removeLiquidity } from '@w3lib/solana-batch-call/liquidity'

const client = new SolanaClient(rpcUrl)

// 报价：新建集中流动性仓位。池子按地址指定，价格是“1 个 token0 值多少个 token1”（池子的方向），给一边的数量
const plan = await buildAddLiquidity(client, owner, {
  protocol: 'raydium-clmm', pool, priceLower: 140, priceUpper: 160,   // 或 fullRange: true，或 tickLower / tickUpper
  amount0Formatted: '1',                                               // 或 amount0（最小单位）；也可以两边都给
})
// { type: 'clmm', token0: { mint, symbol: 'SOL', decimals: 9 }, token1, tickLower, tickUpper, tick, price, liquidity,
//   amount0Formatted, amount1Formatted, amount0Max, amount1Max, native: 'token0', positionMint,
//   steps: [{ kind: 'setup', instructions }, { kind: 'add', instructions }],
//   signers: [{ address: positionMint, secretKey }] }   // 新仓位 NFT 的临时密钥，主指令所在的交易要它签名

// 发送：SOL 自动包装 / 解包
await addLiquidity(client, secretKey, { protocol: 'orca-whirlpool', pool, fullRange: true, amount0Formatted: '0.5' })
await addLiquidity(client, secretKey, { protocol: 'raydium-cpmm', pool, amount1Formatted: '100' })   // AMM：给一边，另一边按储备比例

// 已有仓位：直接用 getLpPositions 的结果（或 { protocol, positionMint } / { protocol, pool }）
const [position] = await getLpPositions(owner, { provider: rpcUrl })
await addLiquidity(client, secretKey, { position, amount0Formatted: '0.1' })     // 追加
await removeLiquidity(client, secretKey, { position, percent: 50 })              // 按比例移除（集中流动性同时领取手续费和挖矿奖励）
await removeLiquidity(client, secretKey, { position, burn: true })               // 全部移除、关闭仓位（退回租金）
await collectFees(client, secretKey, { position })                               // 只领取手续费和奖励
```

| | Raydium CLMM | Orca Whirlpool | Raydium CPMM | Raydium AMM v4 |
| --- | --- | --- | --- | --- |
| 新建 / 追加 | `open_position_with_token22_nft`（NFT 用 Token-2022，tick 数组由程序创建）/ `increase_liquidity_v2` | 初始化缺少的 tick 数组 → `open_position_with_token_extensions` → `increase_liquidity_v2` | `deposit`（按 LP 数量，两边按上限） | `deposit`（固定一边，另一边按上限和最小值） |
| 移除 | `decrease_liquidity_v2`（同时领取手续费、奖励）+ `close_position` | `decrease_liquidity_v2` + `collect_fees_v2` + `collect_reward_v2` + `close_position` | `withdraw` | `withdraw`（带 OpenBook 市场账户） |
| 领取 | 流动性为 0 的 `decrease_liquidity_v2` | `update_fees_and_rewards` + `collect_fees_v2` + `collect_reward_v2` | 计入 LP 份额 | 计入 LP 份额 |

选项（构建和发送都可以传）：

- `slippage`：价格滑点，默认 `0.005`。集中流动性添加按价格在 `[p × (1 − s), p × (1 + s)]` 内最不利时需要的数量给出 `amount0Max` / `amount1Max`（实际只扣按成交价格算的部分），移除给出 `amount0Min` / `amount1Min`；AMM 按数量 × (1 ± s)，两边都给时，按较少的一边算，另一边的上限不超过给的数量
- `native`：wSOL 那一边用 SOL 支付 / 收取，默认 `true`。用的是 wSOL 的关联代币账户：原来没有时创建、用完关闭（剩下的换回 SOL）；原来就有时只补差额、不关闭（收到的留在 wSOL 账户里）
- `recipient`：新建仓位的 NFT 归谁，默认发送者（Orca 要求是发送者：开仓和加流动性在同一笔交易里，要 NFT 持有者签名）
- 发送时还有 `/write` 的发送参数（`feePayer`、`priorityFee`、`wait`、`onUpdate`…）和 `checkBalance`（默认 true：代币按预计数量、SOL 按上限减去已有的 wSOL 检查）

数值与说明：

- **流动性**：集中流动性的 `liquidity` 与程序算出来的逐位一致；CPMM 存入拿到的 LP 与计划一致；AMM v4 的 LP 按储备比例预计（储备随交易变化）
- **仓位**：往已有仓位追加、移除、领取都要求发送者在关联代币账户里持有仓位 NFT / LP 代币（与 `getLpPositions` 传 `mints` 时相同）
- **全部移除并关闭**（`burn: true`）：同一笔交易里先领取手续费和奖励，再关闭仓位账户和 NFT，退回租金
- **奖励**：池子有挖矿奖励时一并领取（`rewardMints`），收到发送者的关联代币账户（没有时创建）；数量要等交易执行后才知道
- **Token-2022**：代币按各自的代币程序处理；带转账手续费的代币不支持（程序按扣费前 / 后的数量检查上下限，构建时直接报错）；挖矿奖励的代币不限

核对方式：在主网上以真实仓位持有人 / 交易所热钱包的身份模拟执行（`simulateTransaction`，取回执行后的账户）：Raydium CLMM 和 Orca 的新建、追加、部分移除、全部移除并关闭、领取，AMM v4 和 CPMM 的存入、取出，流动性 / LP 数量与计划逐位核对，收到的数量不少于最小值。

**局限**：

- 不使用地址查找表（ALT），一步的指令要能放进一笔 legacy 交易（最坏情况：Raydium 移除带 3 个奖励、位图扩展、关闭仓位约 1180 字节，在 1232 以内）
- 带转账钩子（transfer hook）的 Token-2022 代币不支持
- 奖励金库余额不足时程序只发放一部分、剩下的继续记账，这时 `burn: true` 关闭仓位会失败（不会扣代币），先不带 `burn` 移除
- AMM v4 执行前会结算待提取的收益，储备可能比读到的略少：`slippage: 0` 时存入 / 取出可能失败
- 新建集中流动性仓位需要 NFT mint 的临时密钥一起签名：会修改交易的钱包（如自动加优先费用）不能用于新建，追加 / 移除不受影响
- `dryRun: true` 时如果准备工作和主指令放不进一笔交易，主指令的模拟看不到准备工作的结果，会报失败

打包：在已经用到 `SolanaClient` 的基础上，只用 `build*` 约增加 43KB（minify，gzip 约 14KB，含 `/lp` 的仓位查询），加上发送约 66KB（gzip 约 22KB，含 `/write` 的发送代码）。

## 兑换

子路径 `@w3lib/solana-batch-call/swap`：在 **Raydium CLMM**、**Orca Whirlpool**、**Raydium CPMM**、**Raydium AMM v4** 的池子里兑换（按输入数量），与 [添加 / 移除流动性](#添加--移除流动性) 相同的四个协议。不依赖各 DEX 的 SDK，也不调用聚合器的 API：报价按链上状态在本地计算，照搬各程序的计算步骤和取整，结果与程序逐位一致。

- `buildSwap` / `getSwapQuote`：只读取、不签名，返回报价、最少收到、所有候选路线和按顺序执行的指令（`steps`）
- `swap`：构建后签名发送，钱包和发送参数与 `/write` 的 `batchCall` 相同；创建代币账户和兑换能放进同一笔交易时合成一笔

```ts
import { NATIVE_MINT, SolanaClient } from '@w3lib/solana-batch-call'
import { buildSwap, getSwapQuote, swap } from '@w3lib/solana-batch-call/swap'

const client = new SolanaClient(rpcUrl)
const plan = await buildSwap(client, owner, { tokenIn: NATIVE_MINT, tokenOut: USDC, amountInFormatted: '1' })
// { amountOut: '104338470', amountOutFormatted: '104.33847', amountOutMin: '103816777', price: 104.338, priceImpact: 0.00003,
//   route: { path: [SOL, USDC], hops: [{ protocol: 'raydium-clmm', pool: '3ucNos4N…', amountIn, amountOut, amountOutMin }], amountOut, value },
//   routes: [...],            // 所有能报价的路线，按 value 从高到低
//   leftover: null,           // 两跳时留在账户里的中间代币
//   native: 'tokenIn',        // 用 SOL 支付（自动包装）
//   skipped: [{ protocol, pool, reason }],   // 没用上的池子和原因
//   steps: [{ kind: 'setup', instructions }, { kind: 'swap', instructions }] }

await swap(client, secretKey, { tokenIn: USDC, tokenOut: NATIVE_MINT, amountInFormatted: '100' }, { slippage: 0.01 })
await getSwapQuote(owner, { tokenIn: JUP, tokenOut: USDC, amountIn: 10_000_000n }, { provider: rpcUrl })   // 节点参数同 getBalances
```

找池子：

- Raydium CLMM、CPMM、Orca Whirlpool 按 PDA 推导池子地址（与 `/price` 的链上价格相同：21 个 AmmConfig、22 个 Orca 费率档位），不需要 `getProgramAccounts`。直接兑换和经过中间代币（`intermediates`，默认 Wrapped SOL、USDC、USDT）的两跳一起找，候选池子和报价要用的账户（配置、金库、tick 数组、Orca 的 Oracle、Clock）用合并的 `getMultipleAccounts` 读完，一般两到三轮
- Raydium AMM v4 的池子地址要用 OpenBook 市场推导，不在自动查找范围内：放进 `pools` 才会用（如 SOL / USDC 的 `58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2`）；`pools` 也可以放用 seed_index 建的 Raydium CLMM 池子等其他地址。`discover: false` 时只用 `pools` 里的池子
- 每条路线的报价都在本地算，选 `value` 最大的；第一条放不进一笔交易（1232 字节、64 个账户）的路线跳过，用下一条

报价（与程序一致的部分）：

| | 计算 | 一起算进去的 |
| --- | --- | --- |
| Raydium CLMM | `swap_v2`：按 tick 数组位图找下一个已初始化的 tick，逐个区间计算（Q64.64，取整同程序） | 手续费从输入或输出扣（`fee_on`）、动态费率、tick 上的限价单（先按 tick 价格成交）、Token-2022 转账手续费 |
| Orca Whirlpool | `swap_v2`：当前价格起的 3 个 tick 数组（不存在的按全空），逐个区间计算 | 自适应费率（Oracle 里的波动累计，按 Clock 的时间衰减）、Token-2022 转账手续费 |
| Raydium CPMM | `swap_base_input`：恒定乘积，手续费向上取整 | 创建者手续费（从输入或输出扣）、储备扣掉协议 / 基金 / 创建者手续费、Token-2022 转账手续费 |
| Raydium AMM v4 | `swap_base_in_v2`（不需要 OpenBook 账户，只支持 status 6 SwapOnly 的池子，其他状态不报价）：恒定乘积，手续费向上取整 | 储备扣掉待提取的收益（need_take_pnl） |

- **两跳**：第二跳卖出的是第一跳的**最少收到**（交易里每一跳的数量要事先定好，第一跳实际多收到的不会卖掉）；多出来的中间代币留在账户里（`leftover`，按当前状态是第一跳报价 − 最少收到），中间代币是 Wrapped SOL 且原来没有 wSOL 账户时随账户关闭换回 SOL。`amountOut` 是这样实际能收到的数量；比较路线用 `value`（第二跳按第一跳的全部报价卖出能拿到的）
- **滑点**：每一跳的最少收到 = 报价 × (1 − `slippage`)，默认 0.005；价格影响 `priceImpact` 按同一路线卖出 1 / 10000 的数量的价格比
- **SOL**：`tokenIn` / `tokenOut` 传 `NATIVE_MINT`（或客户端的 `nativeMints`）时自动包装 / 解包，规则同添加流动性（`native` 选项，默认 true）：wSOL 账户原来没有时创建、用完关闭；原来就有时卖出先用已有的 wSOL，买入的留在 wSOL 账户里
- **代币账户**：卖出、买入、中间代币都用关联代币账户（ATA），没有时创建；卖出的代币不在 ATA 里时不支持
- **Token-2022**：转账手续费按当前 epoch 的费率算进报价（`amountOut` 是扣完手续费实际收到的）；带转账 hook 的代币不支持（池子跳过）
- `swap` 发送前检查卖出的余额（`checkBalance`，默认 true）；交易发送前照常模拟，失败时不发送

核对方式：在同一个 JSON-RPC 批量请求里读账户（池子、配置、tick 数组、Oracle、Clock、用户的代币账户）并模拟兑换交易（`simulateTransaction`，不验签名），两者 `context.slot` 相同时用读到的账户在本地重新报价，和模拟后代币账户的余额变化比较。2026-10-20 主网，23 个场景全部逐位一致（`test/swap-live.test.ts`；快照存为 `test/fixtures/swap-mainnet.json.gz`，单元测试离线重放）：

| 场景 | 本地报价 | 模拟收到 |
| --- | --- | --- |
| Raydium CLMM SOL → USDC 3 SOL / USDC → SOL 250 USDC | 311,282,691 / 2,406,607,223 | 一致 |
| Orca SOL → USDC 3 SOL（自适应费率池）/ USDC → SOL 250 USDC | 311,525,883 / 2,404,623,893 | 一致 |
| Raydium CPMM SOL → USDC / USDC → SOL | 149,994,662 / 1,287,814,267 | 一致 |
| Raydium AMM v4 SOL → USDC / USDC → SOL | 311,213,424 / 2,397,749,721 | 一致 |
| Raydium CLMM 3000 SOL → USDC（穿过 109 个 tick + 1 个限价单） | 309,164,899,689 | 一致 |
| Raydium CLMM 400000 USDC → SOL（穿过 98 个 tick） | 3,827,084,863,504 | 一致 |
| Raydium CLMM USDC → JUP / SOL → JUP（成交 tick 上的限价单） | 927,247,953 / 17,710,692,783 | 一致 |
| Orca 自适应费率池 25 SOL → USDC（穿过 14 个 tick） | 2,570,899,908 | 一致 |
| Raydium CPMM SOL → BERN / BERN → SOL（Token-2022，转账手续费 2.69%） | 657,602 / 97,156 | 一致 |
| 两跳 SOL → USDC → USDT、USDC → SOL → USDT（Orca + Raydium）、BERN → SOL → USDC | 收到的和留下的中间代币 | 都一致 |

**局限**：

- 只做按输入数量兑换（exact in）；不使用地址查找表（ALT），一条路线要能放进一笔 legacy 交易，放不下的路线跳过
- Raydium CLMM：最多读 10 个已初始化的 tick 数组（先读 2 个，不够再补读）；需要 tick 数组位图扩展账户的池子（当前价格或兑换路径超出池子自带位图覆盖的范围，只有 tick spacing < 15 的池子会碰到）不支持。一次穿过太多已初始化 tick 的大额兑换可能超过 140 万计算单元，报价能算出来但交易会失败（如在 SOL / USDC 的 spacing 1 池子一次卖 6000 SOL；3000 SOL、穿过 109 个 tick 的没问题）
- Raydium 的动态费率和 `fee_on`（手续费从输出扣）照搬了程序，但 2026-10 主网的 PDA 池子里还没有用到它们的，只用改过字段的快照检查了方向，没有和模拟核对过
- Orca：程序只接受当前价格起的 3 个 tick 数组，走不完的数量报价不可用（池子跳过）
- 报价是读取时的链上状态，发送时价格可能已经变了；保护靠最少收到。Raydium 的动态费率、Orca 的自适应费率按 Clock 的时间衰减，与上链时的时间不同会差一点
- 两跳时第一跳多收到的中间代币留在账户里（见上），不会一起卖掉
- 不查 Meteora、PumpSwap、Phoenix 等其他 DEX；要更好的价格可以用聚合器（如 Jupiter）

打包：在已经用到 `SolanaClient` 的基础上，`buildSwap` / `getSwapQuote` 约增加 35KB（minify，gzip 约 13KB），加上 `swap` 发送约 55KB（gzip 约 20KB，含 `/write` 的发送代码）。

## 价格

子路径 `@w3lib/solana-batch-call/price`：代币的美元价格和地址的资产总值。

```ts
import { NATIVE_MINT } from '@w3lib/solana-batch-call'
import { getPortfolio, getTokenPrices } from '@w3lib/solana-batch-call/price'

await getTokenPrices([NATIVE_MINT, USDC, newToken])
// [{ token: 'So111…112', native: true, price: 187.4, source: 'defillama' }, …, { token: newToken, price: 0.0012, source: 'onchain' }]

const p = await getPortfolio(owner, { tokens: [NATIVE_MINT, USDC, JUP] })     // 指定代币：按 ATA 读余额，免费公共节点也能用
const all = await getPortfolio(owner, { provider: 'https://my-rpc…', lp: true }) // 全部持仓 + LP 仓位：需要支持 getTokenAccountsByOwner 的节点
p.totalUsd // 代币 + LP 仓位的合计；p.tokens 按价值排序，p.lp 是 LP 仓位
```

- 价格源依次使用，前面没有价格的代币交给后面的（`sources`，默认 `[defillamaPrices(), onchainPrices()]`），结果的 `source` 是给出价格的源；原生 SOL（客户端的 `nativeMints`）按 Wrapped SOL 的 mint 查
- `defillamaPrices({ at })`：历史价格（unix 秒或 `Date`）；`minConfidence` 过滤置信度低的价格（默认 0.9）
- `onchainPrices()`：按 PDA 推导代币对 Wrapped SOL、USDC、USDT 的池子——Raydium CLMM（`["pool", ammConfig, mint0, mint1]`，21 个 AmmConfig）、Orca Whirlpool（`["whirlpool", config, mintA, mintB, 费率档位]`，22 个档位）、Raydium CPMM（同 CLMM 的种子，21 个 AmmConfig），用计价币一侧最深的池子的价格；稳定币按 1 美元，Wrapped SOL 先对稳定币定价。`minLiquidityUsd`（默认 10000）以下的池子不用，防止小池子的价格被操纵；集中流动性的深度取金库余额和当前活跃流动性折算的储备中较小的，流动性都在区间外的池子不会被选中。不需要 `getProgramAccounts`，每个代币约推导 190 个地址，读取分两轮（池子和 mint、金库），每轮都是合并的 `getMultipleAccounts`。2026-10 主网实测 SOL、JUP、BONK、RAY、JTO、WIF 和 DefiLlama 相差在 0.5% 以内
- Raydium AMM v4、Meteora、PumpSwap 等池子的地址不能只靠两个 mint 推导，`onchainPrices` 不查；这些代币一般 DefiLlama 有价格
- `combinePrices([…])` 把多个源组合成一个，可以传给 `getLpPositions` 的 `prices`（价格源的参数里有 `client`，链上价格源用它读池子）
- 资产总值：传 `tokens` 时按 ATA 读这些代币的余额（免费公共节点也能用）；不传时列出地址的全部持仓（同 `getOwnerTokens`，需要支持 `getTokenAccountsByOwner` 的节点，不支持时报错并提示传 `tokens`），这时 LP 代币按仓位计入、不再作为代币重复计算。`lp: true` 时加上 LP 仓位（参数同 `getLpPositions`；它不传 `mints` 时也要扫描代币账户，免费公共节点上传 `lp: { mints, pools }`）

价格只用于展示和估值：链上价格是池子当前的价格，可能被单个区块内的交易影响，不要用它算交易的最小数量。

打包：在已经用到 `SolanaClient` 的基础上，`getTokenPrices` 约增加 7KB（minify，gzip 约 3KB），`getPortfolio`（含 LP 仓位）约 22KB（gzip 约 9KB）。

## 手续费估算

子路径 `@w3lib/solana-batch-call/fees`：当前的优先费建议，和一笔交易大概要花多少 SOL。

```ts
import { getCostEstimate, getFeeEstimate } from '@w3lib/solana-batch-call/fees'

await getFeeEstimate({ accounts: [pool] })
// { slow: '0', normal: '1166', fast: '10000', slots: 150 }   每个计算单元多少 micro-lamports

await getCostEstimate({ feePayer: owner, instructions: [ix1, ix2] })
// { computeUnits: 15318, computeUnitLimit: 17850, priorityFee: '1166', signatures: 1, baseFee: '5000', priorityFeeLamports: '21', fee: '5021',
//   rent: '1488440', createdAccounts: [{ address, owner: 'Tokenkeg…', space: 165, rent: '1488440' }], total: '1493461', totalFormatted: '0.001493461', symbol: 'SOL' }

await getCostEstimate({ transaction: base64Tx })   // 构建好的交易（如聚合器 API 返回的），按交易自带的计算预算算
```

- **费用建议**：`getRecentPrioritizationFees` 返回最近 150 个 slot 里（会写 `accounts` 的）落块交易的**最低**单价，三档取第 50 / 75 / 90 百分位（`percentiles`），`normal` 与 `/write` 的 `priorityFee: 'auto'` 取法相同（不含 `maxPriorityFee` 上限）。不传 `accounts` 时看全网，大多是 0（每个区块总有不加优先费的交易）；估某笔交易时传它的可写账户（`estimateCost` 自动这样做）
- **一笔交易**：模拟一次（`sigVerify: false`、`replaceRecentBlockhash`，不需要签名、不会发送），模拟失败时抛出（带程序日志里的原因）。传指令时按 `/write` 的发送方式算：去掉自带的计算预算指令，计算单元上限 = 模拟消耗 × 1.1 + 1000，单价按这一档（`level`，或 `priorityFee` 直接指定，或传查好的 `fees` 共用）；传构建好的交易时按它自带的 SetComputeUnitLimit / SetComputeUnitPrice（没有单价时优先费为 0，没有上限时按每条指令 20 万），v0 交易会读地址查找表找可写账户
- **手续费** = 每个签名 5000 lamports + 单价 × 上限（向上取整）。**押金**：交易前不存在、模拟后存在、有数据或不归 System Program 的可写账户（新建的代币账户、仓位等），按 `getMinimumBalanceForRentExemption` 算（不写死：2026-10 主网 165 字节是 1,488,440 lamports），关闭账户时退回；普通转账给新地址不算押金
- 只支持 legacy 和 v0 交易：主网已经有 v1 格式的交易（2026-10 约三成），它们的布局不同，传入时报错（改传指令）

主网核对：Raydium SOL-USDC 池子的三档费用、新建 USDC ATA 的押金（和 `getMinimumBalanceForRentExemption(165)` 一致）；从 Jupiter 最近的真实 v0 交易（带地址查找表）算出的手续费和链上实际扣的相同（如 5803 / 5027 lamports）。

打包：在已经用到 `SolanaClient` 的基础上，`getFeeEstimate` 约增加 2KB（minify，gzip 约 1KB），`getCostEstimate` 约 5KB（gzip 约 2KB），另外按需加载 `/write` 的交易构建和错误说明（约 19KB，gzip 约 7KB）。

## 域名解析

子路径 `@w3lib/solana-batch-call/names`：SNS（Solana Name Service，Bonfida）的名字 → 地址、地址 → 主域名。

```ts
import { getAddressNames, getNameAddresses } from '@w3lib/solana-batch-call/names'

await getNameAddresses(['bonfida.sns', 'Toly.SNS', 'pay.alice.sns'])
// [{ name: 'bonfida.sns', normalized: 'bonfida.sns', address: 'Fw1E…Lb1v', owner: 'Fw1E…Lb1v', source: 'owner', service: 'sns' }, …]
await getAddressNames([wallet])
// [{ address: wallet, name: 'couponvault.sns', service: 'sns' }]
```

- **`.sol` 和 `.sns`**：SNS 的域名 2026-10 起改用 `.sns` 后缀（链上还是同一批账户，`bonfida.sol` 和 `bonfida.sns` 是同一个域名）；`.sol` 正在迁到另一个注册服务 SRS，SNS 官方 SDK 从 slot 452,825,395（约 2026-10-15）起不再解析 `.sol`，SRS 的解析还没有公开。所以默认只认 `.sns`，`.sol` 返回 null；`legacySol: true` 时 `.sol` 按同名的 `.sns` 解析（迁移前的含义，以后同一个 `.sol` 名字可能属于别人，自己判断）。反查得到的名字都是 `.sns`
- **正查**：名字小写、去掉空格，支持 `name.sns` 和一级子域名 `sub.name.sns`。账户都在本地按 PDA 推导（`sha256('SPL Name Service' + 名字)`、class、parent），一次 `getMultipleAccounts` 读域名、NFT 记录和两版 SOL 记录。解析顺序同官方 SDK：域名代币化成了 NFT → NFT 的持有人（`source: 'nft'`）；V2 的 SOL 记录（owner 验证过、没有过期，`'record-v2'`）；V1 的 SOL 记录（owner 的 Ed25519 签名，用 WebCrypto 验签，`'record-v1'`）；否则是域名的 owner（`'owner'`）。`owner` 字段总是域名的 owner（代币化的是 NFT 持有人）
- **不解析（`address` 为 null）的情况**：没有注册（`source` 也为 null）；V2 SOL 记录没有验证 / 格式不对（与官方 SDK 一样不往下解析）；owner 是 PDA（程序账户，转过去可能取不出来，`allowPda: true` 时返回）；代币化的域名要用 `getTokenLargestAccounts` 找 NFT 持有人，免费公共节点（publicnode、官方节点）都不支持，这时 `source` 为 `'nft'`、`address` 为 null，需要自己的节点
- **反查**：读地址设置的主域名（favourite domain，`85iDfUvr…` 程序的 PDA），再读域名和反查记录拼出名字（子域名再读一次父域名的反查记录），然后**核对**：名字推导出的账户就是主域名指向的账户，并且域名属于这个地址（owner 是它，或代币化后它的 ATA 里有这个域名的 NFT）。域名转给别人后旧的主域名设置不算。通常两次 `getMultipleAccounts`，免费公共节点能用

主网核对：`bonfida.sns`、`toly.sns` 的 owner（`legacySol` 时 `bonfida.sol`、`toly.sol` 相同），`crypto.sns` 识别为代币化；`Fw1E…Lb1v` 的主域名是 `couponvault.sns`，`bonfida.sns` 的旧 owner 设置的主域名已经失效（返回 null）。

打包：在已经用到 `SolanaClient` 的基础上约增加 6KB（minify，gzip 约 2.5KB）。

## 授权管理

子路径 `@w3lib/solana-batch-call/approvals`：Solana 上的“授权”是代币账户的 delegate（Approve 设置，被授权方可以转走 `delegatedAmount` 以内的代币）。查一个地址的代币账户给出的授权、可以关闭回收租金的空账户，批量撤销 / 关闭。

```ts
import { closeTokenAccounts, getApprovals, revokeApprovals } from '@w3lib/solana-batch-call/approvals'

const list = await getApprovals(owner, { mints: [USDC, BONK, NATIVE_MINT] })   // 指定代币：读 ATA，免费公共节点也能用
// [{ account, mint: USDC, symbol: 'USDC', amount: '1500000', formatted: '1.5', delegate: 'GYFk…', delegatedAmount: '1000000',
//    revocable: true, closable: false, closeBlocker: 'balance', lamports: '2039280', withheldAmount: '0', permanentDelegate: null, … }, …]
await getApprovals(owner, { provider: 'https://my-rpc…' })                    // 全部代币账户：需要支持 getTokenAccountsByOwner 的节点

await revokeApprovals(client, key, list)                                      // 有 delegate 的都撤销
await closeTokenAccounts(client, key, list.filter((a) => a.amount === '0'))   // 关闭空账户，租金退回 owner（destination 可改）
```

- **结果按代币账户**：默认返回有授权的（`delegate`，或关闭权限 `closeAuthority` 是别人）和余额为 0 的账户；`all: true` 时返回全部。传 `mints` 时读这些代币在 SPL Token 和 Token-2022 下的 ATA（一次 `getMultipleAccounts`，再一次读 mint 和元数据），非 ATA 的代币账户查不到；不传时用 `getTokenAccountsByOwner` 列出全部代币账户，节点不支持时报错并提示传 `mints`
- **能不能撤销 / 关闭**：`revocable`（有 delegate、没有冻结——冻结的账户不能 Revoke）；`closable` / `closeBlocker`：`'balance'`（有余额，Wrapped SOL 除外）、`'close-authority'`（关闭权限是别的地址，owner 关不掉，它可以在余额为 0 时关闭并拿走租金，也只有它能撤销这个权限）、`'confidential-balance'`（Token-2022 机密转账的余额不为 0）。冻结的空账户可以关闭
- **Wrapped SOL**：`native: true`，`amount` 是包装的 SOL；有余额也能关闭（`lamports` 全部退回，相当于 unwrap），默认只列出空的，`buildCloses` 不会替你过滤有余额的 wSOL 账户
- **Token-2022**：账户里暂存的转账手续费（`withheldAmount`，不属于 owner）不为 0 时直接关闭会失败，`buildCloses` 先加一条 HarvestWithheldTokensToMint（任何人都能调用，不需要签名）把它收到 mint 上；`permanentDelegate` 是 mint 的永久授权（可以转走 / 销毁任何账户里的这种代币，撤销不了，只做提示）
- **发送**：`buildRevokes` / `buildCloses` 只构建（每个账户一个调用：Revoke / [Harvest +] CloseAccount）；`revokeApprovals` / `closeTokenAccounts` 构建后用 owner 签名发送，钱包和选项同 `batchCall`（多个账户打包进同一笔交易，`feePayer` 可以替 owner 付手续费，`dryRun` 只模拟），默认一个失败不影响后面的；列表里有别人的账户时报错。发送的代码按需加载

主网核对（只模拟，不发送）：Star Atlas 游戏代币（AMMO / FOOD / FUEL）上真实的 delegate，Revoke 模拟通过（同一 owner 的两个账户打包进一笔，504 计算单元）；清空的 USDC、Wrapped SOL、Token-2022（xStocks 的 SPYx，带 PermanentDelegate）账户 CloseAccount 模拟通过；有余额的账户强行关闭时链上报 “Non-native account can only be closed if its balance is zero”，和 `closeBlocker: 'balance'` 一致；清空了、但还有暂存转账手续费的 Token-2022 账户，Harvest + CloseAccount 模拟通过（约 3700 计算单元），不 Harvest 直接关闭时链上报 “An account can only be closed if its withheld fee balance is zero”；`getTokenAccountsByOwner` 列出的结果和按 ATA 读的一致。

打包：在已经用到 `SolanaClient` 的基础上，`getApprovals` 约增加 6KB（minify，gzip 约 2KB），加上撤销 / 关闭约 7KB（gzip 约 3KB）；发送的代码（`/write`，约 21KB，gzip 约 8KB）按需加载，只查授权时不会加载。

## 代币风险

子路径 `@w3lib/solana-batch-call/risk`：买入前检查代币的权限和 Token-2022 扩展里会影响持有人的设置。

```ts
import { getTokenRisks, getTradeChecks } from '@w3lib/solana-batch-call/risk'

const [risk] = await getTokenRisks([PYUSD])
// { program: 'token-2022', decimals: 6, supply: '…', mintAuthority: '22mK…', freezeAuthority: '2apB…',
//   transferFee: { basisPoints: 0, maximumFee: '0', authority: '…', next: null }, permanentDelegate: '2apB…',
//   transferHook: { program: null, authority: '…' }, confidentialTransfer: { authority, autoApprove }, mintCloseAuthority: '…',
//   flags: ['mintable', 'freezable', 'fee-changeable', 'permanent-delegate', 'transfer-hook', 'confidential-transfer', 'closable'] }

const [trade] = await getTradeChecks([mint], { owner: myAddress, amountFormatted: '0.05' })
// { stage: 'ok', honeypot: false, roundTripLoss: 0.0002, bought: '20828496', sold: '198960224', buyRoute: [{ protocol: 'orca-whirlpool', pool }] }
```

`tokenRisks` / `getTokenRisks`：mint 和 Clock（选转账手续费的新旧配置）用一次 `getMultipleAccounts` 读完，免费公共节点也能用。标记（`flags`）：

| 标记 | 含义 |
| --- | --- |
| `mintable` / `freezable` | 增发权限、冻结权限还在（可以继续增发；可以冻结任何持有人的代币账户） |
| `transfer-fee` / `high-transfer-fee` | Token-2022 转账手续费 > 0 / > 10%（当前或已经设好、即将生效的费率） |
| `fee-changeable` | 转账手续费的配置权限还在（费率可以改，两个 epoch 后生效） |
| `permanent-delegate` | 永久授权：这个地址可以转走 / 销毁任何持有人的代币 |
| `transfer-hook` | 每次转账都调用一个程序（可以拒绝转账；程序为空但权限还在时也算，随时可以设上） |
| `non-transferable` / `default-frozen` | 不可转让；新建的代币账户默认冻结 |
| `pausable` / `paused` | 发行方可以暂停全部转账；当前已暂停 |
| `confidential-transfer` | 支持保密转账（余额和转账数量加密） |
| `closable` | mint 关闭权限（总量为 0 时可以关闭 mint） |
| `ui-amount-changes` | 显示数量会随利率 / 系数变化，且有权限可以改（InterestBearing、ScaledUiAmount） |
| `permissioned-burn` | 销毁要指定地址批准 |
| `concentrated` | `concentration: true` 时：最大的 10 个代币账户超过总量的 50%（含池子金库、交易所地址，只作参考）。用 `getTokenLargestAccounts`，免费公共节点大多不支持，不支持时 `topHolders` 为 null |
| `not-found` | mint 不存在或不是代币 mint |

`tradeChecks` / `getTradeChecks`：用 `/swap` 构建“SOL 买入 → 全部卖回 SOL”（卖出走买入的同一条路线），放进一笔交易在主网模拟（不验签名、不上链），看哪一步失败、来回损失多少：

- `owner`：模拟用的钱包，要有足够的 SOL（可以是任何有 SOL 的系统账户，如自己的地址）；`amount` / `amountFormatted`：买入花的 SOL，默认 0.05
- `stage`：`ok`、`no-pool`（内置协议里找不到路线）、`buy-failed`（买不进，标记 `cannot-buy`）、`sell-failed`（买得进、卖不出，`honeypot: true`，标记 `honeypot`）
- `roundTripLoss`：1 − 卖回的 SOL / 花的 SOL（含两次池子手续费、价格影响和转账手续费），超过 10% 标记 `high-round-trip-loss`
- 先找直接兑换的路线（买入和卖出更容易放进一笔交易），没有时再找两跳；放不下一笔交易时 `stage` 为 null，`error` 说明原因
- 2026-10-20 主网：USDC 来回损失 0.02%、JUP 0.10%，BERN（转账手续费 2.69%）能买能卖

打包：在已经用到 `SolanaClient` 的基础上，`getTokenRisks` 约增加 5KB（minify，gzip 约 1.5KB）；`tradeChecks` 用到 `/swap`，一起约 43KB（gzip 约 16KB）。

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

**指令工具**：`systemTransfer`、`transferChecked`、`createAssociatedTokenAccountIdempotent`、`closeAccount`、`revoke`、`harvestWithheldTokensToMint`、`setComputeUnitLimit`、`setComputeUnitPrice`，生成本库格式的指令，可直接放进 `batchCall`。

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
pnpm test:live:lp          # LP 仓位连主网核对
pnpm test:live:liquidity   # 加减流动性在主网上模拟（simulateTransaction，不发送）
pnpm test:live:swap        # 兑换：本地报价和主网模拟逐位核对（RECORD=1 时更新 test/fixtures/swap-mainnet.json.gz）
pnpm test:live:risk        # 代币风险和买入 / 卖出模拟连主网
pnpm demo        # 本地运行 demo（demo/，直接用 src 的源码）
pnpm build
```

## License

MIT
