# Changelog

## 0.3.0

### 新功能

- 模拟交易，子路径 `@w3lib/sui-batch-call/simulate`：`simulate` / `simulateTx`（`SimulateTransaction`，不签名）：所有地址的余额变化（不含 gas，可选美元价值）、对象变化（新建 / 删除 / 换所有者）、gas 明细和手续费、失败原因解码（Move abort 的函数 / 码 / 常量名，系统包常见码）、Move 调用解码（本库认得的 12 个协议，按原始包 id 对照）、提醒（失败、发布 / 升级包、不认得的包、把对象转给别的地址、收款人白名单、过高的 gas 上限、可选的代币风险）；接受完整的 TransactionData（字节 / base64）或构建器的结果（`buildSwap`、`buildAddLiquidity`… 的 `kind`，传 `sender`）
- 交易历史，子路径 `@w3lib/sui-batch-call/history`：`getHistory` / `getHistoryOf`：整理成 `Activity`（转账 / 兑换 / 流动性 / 铸造 / 合约调用，失败的、方向、对方、币变化、手续费、收到 / 送出的对象），游标翻页；数据源 GraphQL（完整历史，默认）和节点的 gRPC `ListTransactions`（最近几周），前面的出错换后面的，可以传自己的 `HistoryAdapter`（`graphqlHistory`、`grpcHistory`）
- `GrpcResponse.frames`：服务端流式方法（如 `ListTransactions`）的全部数据帧

## 0.2.0

### 新功能

- 价格，子路径 `@w3lib/sui-batch-call/price`：
  - `getTokenPrices` / `tokenPrices`：代币的美元价格，依次使用多个价格源，结果带给出价格的源
  - `onchainPrices()`：从 Cetus、Turbos、FlowX CLMM 的池子算价格（对 SUI、USDC、USDT，用最深的池子，流动性下限 `minLiquidityUsd`）；池子按两种币在各 DEX 的注册表里找（条目 ID 本地算出，不需要索引服务）
  - `defillamaPrices({ at })`：历史价格
  - `combinePrices([...])`：组合多个价格源，可以传给 `getLpPositions` 的 `prices`
  - `getPortfolio` / `portfolio`：地址的资产总值（持有的全部代币 × 价格，可选加上 LP 仓位）
- 域名解析，子路径 `@w3lib/sui-batch-call/names`：`getNameAddresses` / `resolveNames`（SuiNS 名字 → 地址，支持 `@name` 格式、子域名，过期的名字为 null）、`getAddressNames` / `lookupAddresses`（地址 → 默认名字，正查核对），`normalizeSuiName` / `formatSuiName`；名字记录的对象 ID 本地算出，一轮 `BatchGetObjects` 读完，内置主网、测试网的部署（`SUINS`）
- 手续费估算，子路径 `@w3lib/sui-batch-call/fees`：`getFeeEstimate` / `estimateFees`（当前 epoch 的参考 gas 价格；Sui 的 gas 价格每个 epoch 固定，没有三档）、`getCostEstimate` / `estimateCost`（模拟一笔交易：计算费、存储费、存储返还、净花费，和 /write 发送时会用的 gas 上限；支持赞助交易）
- 兑换，子路径 `@w3lib/sui-batch-call/swap`：
  - `getSwapQuote` / `buildSwap` 报价并构建交易（不签名），`swap` 构建后签名发送（钱包、赞助交易、`dryRun` 同 `/write`）；卖出固定数量
  - 路线：直接兑换，或经过 SUI / USDC（`intermediates`）的两跳（可以跨 DEX）；12 个协议都能兑换，Cetus、Magma、Turbos、FlowX CLMM、DipCoin、FlowX V2 按币对自动找池子（注册表条目的 ID 本地算出），其他协议用 `pools` 传池子
  - 两跳每个中间币保留第一跳输出最多的 2 个池子（不只第一名）；价格影响的参考输出不到 100 个最小单位时返回 null
  - 报价：每条候选路线在只读调用里执行一遍兑换、读出买到的数量（合约自己算，与实际成交逐位一致），按 `concurrency` 并发；最少收到按滑点，在交易最后检查；价格影响按 1 / 10000 数量的价格
- 代币风险检查，子路径 `@w3lib/sui-batch-call/risk`：`getCoinRisks` / `coinRisks`：监管币（DenyCapV2 或 v1 的 DenyCap，冻结权限还有没有人能用、全局暂停，当前是否暂停、某地址是否被冻结）、增发权限（TreasuryCap 的持有者，在别的对象里时找到最外层对象；它或最外层对象冻结 / 转给 0x0、固定供应 = 不能增发）、元数据能否修改（Coin Registry 的 MetadataCap 或旧的 CoinMetadata），可选用 `/swap` 模拟买入再卖出（能不能卖、来回损失），汇总为 `flags`
- `SuiClient.concurrency`：同时发出的请求数上限（只读）
- 价格源的上下文 `SuiPriceSourceContext` 新增 `client`（链上价格源用，`lpPositions` 会传入）；`defillamaPrices`、`SuiPriceSource` 仍可以从 `/lp` 导入

### 修复

- `/liquidity`：发送者没有 SUI Coin 对象、只有地址余额时，取回 / 找零的 SUI 不再合并进 gas 币（这时 gas 由地址余额付，交易里没有 gas 币），照常转给发送者

## 0.1.0

### 新功能

- 首个版本：通过 gRPC-web 读取 Sui 全节点（不依赖 Sui SDK）
  - `SuiClient`：`balances`（全部代币 / 指定代币）、`multiBalances`、`coins`（代币信息，有缓存）、`objects`（批量读对象）、`ownedObjects`（按类型过滤、自动翻页）、`nfts`（Display 渲染结果，没有 Display 时取内容字段）、`serviceInfo`
  - 快捷函数 `getBalances` / `getMultiBalances` / `getCoins` / `getObjects` / `getOwnedObjects` / `getNfts`
  - 多节点故障切换、按响应头核对网络、`minCheckpoint` / `withCheckpoint`、限频退避重试
- 批量写操作（子路径 `/write`）：`batchTransfer`（一对多转账，SUI 和代币混合）、`batchCollect`（多钱包归集，支持赞助交易）、`batchCall`（批量执行 @mysten/sui 或 `PtbBuilder` 构建的交易）
  - 本地 BCS 编码（与 @mysten/sui 一致）、WebCrypto Ed25519 签名；私钥、@mysten/sui Keypair、自定义签名器、Wallet Standard 浏览器钱包
  - 支持地址余额（Address Balances）：从地址余额取款转账、用地址余额付 gas
  - 模拟估算 gas 上限、同一付款钱包依次执行（对象版本由执行结果更新）、执行后等进入 checkpoint
- LP 仓位（子路径 `/lp`）：Cetus、Bluefin、Momentum、Turbos、Magma、FlowX、Kriya CLMM 的仓位，Cetus DLMM 的仓位（未领取的手续费和奖励由合约在只读调用里算出），DipCoin、FlowX V2、Kriya 的传统 AMM LP，Aftermath 的多币池 LP（含 DAO 费池子；按份额算数量）；可选美元价值（DefiLlama）。结果按 `type`（`'clmm'` / `'dlmm'` / `'amm'` / `'multi'`）区分
- 添加 / 移除流动性（子路径 `/liquidity`）：集中流动性和 DLMM 支持新建仓位、追加、按比例移除、全部移除并关闭、领取；传统 AMM 支持添加（给一边，另一边按储备比例）和按比例 / 数量移除；Aftermath 支持按比例或只用一种币存入、取回；`build*` 只构建不签名
- demo（`pnpm demo`），通过 GitHub Actions 发布到 GitHub Pages
