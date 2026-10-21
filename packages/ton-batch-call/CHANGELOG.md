# Changelog

## 0.2.0

### 新功能

- 价格，子路径 `@w3lib/ton-batch-call/price`：
  - `getTokenPrices` / `tokenPrices`：TON 和 Jetton 的美元价格，依次使用多个价格源，结果带给出价格的源
  - `onchainPrices()`：从 STON.fi v1 / v2、DeDust 的池子算价格（对 TON、USD₮，用计价币一侧最深的池子，流动性下限 `minLiquidityUsd`），池子地址用 router / factory 的 `get_pool_address` 算出
  - `defillamaPrices({ at })`：历史价格
  - `combinePrices([...])`：组合多个价格源，可以传给 `getLpPositions` 的 `prices`
  - `getPortfolio` / `portfolio`：地址的资产总值（TON 和持有的全部 Jetton 的余额 × 价格，默认跳过诈骗代币，可选加上 LP 仓位）
- 价格源的上下文新增 `client`（链上价格源用）；`defillamaPrices`、`TonPriceSource` 仍可以从 `/lp` 导入
- 域名解析，子路径 `@w3lib/ton-batch-call/names`：`getNameAddresses` / `resolveNames`（名字 → 钱包地址，链上调用 `dnsresolve`，支持 .ton、.t.me 和子域名）、`getAddressNames` / `lookupAddresses`（地址 → 自己持有并指向自己的名字，来自索引器的地址簿，正查核对）；内置 `NAME_SERVICES`、`TON_DNS_ROOT`
- 手续费估算，子路径 `@w3lib/ton-batch-call/fees`：`getCostEstimate` / `estimateCost`、`getCostEstimates` / `estimateCosts`，消息与 `batchCall` 相同，模拟整条交易链（emulateTrace），返回钱包交易的手续费明细（导入、存储、计算、动作、转发）、钱包付的手续费、附带 / 退回的 TON、余额变化、整条链的手续费；`from` 可以直接传钱包地址
- 兑换，子路径 `@w3lib/ton-batch-call/swap`：`getSwapQuote` / `buildSwap`（报价并构建消息）、`swap`（发送，走 `/write` 的流程）
  - STON.fi v2 / v1、DeDust（volatile）的池子，TON 和 Jetton，直接兑换或经过 TON / USD₮ 的两跳（`intermediates`），三个协议都报价，选输出最多的；`routes` 是所有报到价的路线，`route` 可以指定其中一条
  - 报价：STON.fi v2 按 `get_pool_data` 和合约的公式本地算，v1 用 `get_expected_outputs`，DeDust 用 `estimate_swap_out`；`amountOutMin` 按滑点（默认 0.5%）由合约检查，`priceImpact`
  - 消息格式与 @ston-fi/sdk 2.7 / @dedust/sdk 0.8 相同（STON.fi v2 TON 走 pTON v2.1 的 `ton_transfer`，两跳用同一个 router 的 `cross_swap`，或经过 TON 转给另一个 router；DeDust 的 TON vault / Jetton vault 和 `next` 步骤）；附带的 TON 是 `SWAP_GAS`
  - 结果判断要求收款地址真的收到了不少于 `amountOutMin` 的代币，`amountReceived` 是交易链里实际收到的数量（不含退回的 gas）；`receivedInTrace`、`stonfiV2SwapOut` 也导出
- Jetton 风险检查，子路径 `@w3lib/ton-batch-call/risk`：`getTokenRisks` / `tokenRisks`
  - 链上 `get_jetton_data` 的 admin（`addr_none` 或零地址算放弃）、mintable，索引器的诈骗标记，Jetton 钱包代码的哈希（库 Cell 取库里代码的哈希）对照 `KNOWN_JETTON_WALLET_CODES`
  - `simulate: true`：从持有人里找 v4r2 / v5r1 钱包，用 `/swap` 模拟买入、卖出，算出买入税、卖出税，判断能不能卖
  - 风险标记 `flags`：`not-found`、`scam`、`mintable`、`admin`、`governed`（USD₮ 这类带治理的钱包，admin 可以冻结持有人的余额）、`unknown-wallet-code`、`no-pool`、`cannot-buy`、`honeypot`、`high-buy-tax` / `high-sell-tax`、`has-tax`
- `/write` 的 `TraceMessage` 类型加上 `source` 和 `message_content.body`（toncenter 返回的字段）

### 修复

- `multiBalances`：多个地址都指定了多个 Jetton 时 toncenter 返回 HTTP 422（“exact one owner_address required for multiple jetton_address”），整个查询失败。现在按 Jetton（每个 Jetton 每 100 个地址一次）或按地址拆开请求，取请求少的，结果不变；一个地址指定超过 100 个 Jetton 时也按 100 个一次拆开

## 0.1.0

### 新功能

- 首个版本：通过 toncenter v3 索引器读取 TON（不依赖 TON SDK）
  - `TonClient`：`balances`（TON + 全部 / 指定 Jetton）、`multiBalances`（多个地址合成一次请求）、`tonBalances`、`jettons`（元数据，有缓存）、`walletStates`、`nfts`
  - 快捷函数 `getBalances` / `getMultiBalances` / `getTonBalances` / `getJettons` / `getWalletStates` / `getNfts`
  - 自动限频（没有 API Key 时每秒 1 次）、429 退避重试、多节点故障切换
  - 地址工具：原始 / 用户友好格式互转（TEP-2，CRC16 校验）
- 批量写操作（子路径 `/write`）：`batchTransfer`（一对多转账，TON 和 Jetton 混合，带备注）、`batchCollect`（多钱包归集，可以先给子钱包补 gas）、`batchCall`（批量执行交易）
  - 钱包 v4r2 / v5r1，本地 Cell / BOC 编码（与 @ton/core 一致）、WebCrypto Ed25519 签名；TON 助记词、私钥、自定义签名器、TON Connect
  - 发送前用 toncenter 的 emulateTrace 模拟整条交易链；按规范化消息哈希（TEP-467）等交易链走完，退回的算失败；过期自动重发
- LP 仓位（子路径 `/lp`）：STON.fi v1 / v2、DeDust 的 LP Jetton，用 router / factory 核对池子，按份额算出数量，可选美元价值（DefiLlama）
- 添加 / 移除流动性（子路径 `/liquidity`）：STON.fi v2、DeDust 添加和移除，STON.fi v1 移除；`build*` 只构建消息
- demo（`pnpm demo`），通过 GitHub Actions 发布到 GitHub Pages
