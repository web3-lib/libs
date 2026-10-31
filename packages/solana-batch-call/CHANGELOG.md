# Changelog

## Unreleased

### 改进（读取链路，无破坏性变更）

- 取消传到底层：`RpcTransport.request` 新增可选的第三个参数 `{ signal }`（新增类型 `RpcRequestOptions`，自定义传输不处理也照常工作）。各查询的 `signal` 传给传输层：`HttpRpc` 合并超时与 signal 交给 `fetch`，还在排队的调用取消时直接移出队列，已发出的批量请求在所有成员都取消后才中止；`FallbackRpc` 取消后不再换节点，也不把节点记为故障；取消时 reject 的仍是 `signal.reason`
- publicnode 的已知限制预置：单次 `getMultipleAccounts` 最多 10 个账户、一个批量里最多 1 个，首次请求就按它拆分，不再先等 3 秒多的 403
- `HttpRpc` 新增 `maxConcurrency`（默认 4）：同一节点地址同时在途的 HTTP 请求数上限（按 URL 在所有连接间共享），超出的排队：排队最多等 `timeout`（等不到按超时处理、多节点时换节点），发出后重新计时。之前大批量读取在 publicnode 上同时有二十多个请求
- 拆分后的 `getMultipleAccounts` 子请求、客户端分组读取改用并发池（不再整波等最慢的；出错后不再发后面的请求）
- 429 退避加 ±25% 随机抖动，有 `Retry-After` 头时按它等（超过 10 秒不等，直接报错交给上层换节点）；413 / “Batch of more than N” 缩小的批量 10 分钟后恢复（之前永久缩小）；学到的节点限制表有条目上限
- 去重：`HttpRpc` 同一批里 method 和 params 完全相同的只读调用只发一次（新增选项 `dedupe`，默认 true）；补读代币 decimals / 元数据时，同一 mint 正在被别的查询读取就共用那次读取
- `/lp`：LP mint → 池子地址找到后缓存（最多 1 万条），之后不再 `getProgramAccounts`；按 LP mint 找池子同时最多 4 个
- 内部：并发池 `mapPool`、`sleep` 挪到公共的 `util.ts`

### 新功能 / 改进（第二阶段，公开 API 只新增）

- 写操作 `SendOptions` 新增 `sendRpc`（发送交易用的节点，按 client 的网络和节点选项解析，网络不一致时报 `NetworkMismatchError`；模拟和查确认状态仍用 client）和 `broadcast: 'first' | 'all'`（默认 `'first'`；`'all'` 同时发给所有节点，第一个接受就返回，其余在后台完成）
- 有优先费用时少一次模拟：第一次模拟顺带取付款方模拟后的余额（和当前余额同一个批量请求），付完优先费用后仍不低于免租下限就不再按真实费用模拟第二次。取舍：第二次模拟和第一次只隔几百毫秒、基于几乎同一个状态，按收紧后的计算单元上限复核几乎不会失败，挡不住发送时的状态变化；新增 `SendOptions.computeUnitMargin`（默认 `{ ratio: 1.1, extra: 1000 }`），消耗会波动的调用可以调大余量
- 内部的并发池（`mapPool`）一项出错后不再执行后面的项（/lp 找池子的 `getProgramAccounts`、/history 的 `getTransaction` 等）
- 等待确认时不再每轮都查 `getEpochInfo`：记下上次的（区块高度, slot），用状态查询返回的 slot 估算高度上限，可能过期时才查
- `priorityFee: 'auto'` 去掉 0 再取 75 分位：不活跃账户的最近费用大多是 0（2026-10 主网实测 USDC mint 150 个 slot 里 135 个为 0），之前几乎总是算出 0
- 打包合一：`batchCall` 等的发送和 `/reclaim`、`/claim` 的批量计划共用 `packUnits`，按累计的账户集合和指令字节增量估算交易大小（之前每加一个调用就完整编译整条消息），每笔最后完整编译校验一次；分组结果与之前相同
- `client.balances(owner, { mints, ...options })` 新写法（新类型 `BalancesQueryOptions`），旧写法 `balances(owner, mints, options)` 照常可用
- 地址非法时抛 `InvalidAddressError`（继承 `Error`，message 不变，带 `code: 'INVALID_ADDRESS'` 和 `address`），主入口导出
- `/approvals`、`/reclaim`、`/claim` 的查询参数类型改名为 `ApprovalsOptions`、`ReclaimableOptions`、`ClaimableOptions`（与其他查询的 options 统一），旧名 `ApprovalsQuery`、`ReclaimQuery`、`ClaimQuery` 保留为别名（@deprecated）
- 去重：同一批里相同的只读调用，第二个起的调用方拿到结果的副本（调用方修改结果不会影响别人）
- PDA 缓存的键改用种子的十六进制（不再每次 base58 编码），满了按 LRU 淘汰最久没用的（之前整表清空）

### 内部重构（导出路径和名字不变）

- `client.ts` 拆成 `tokenMeta.ts`（代币信息缓存）、`accountReader.ts`（账户读取管线）、`balances.ts`（三种余额查法、持仓列表）、`tokenDetails.ts`（代币详情 / NFT），`SolanaClient` 只保留薄的公开方法
- `write/send.ts` 拆出 `errors.ts`（交易错误文案）、`chain.ts`（blockhash / 优先费用 / 模拟 / 广播）、`tracker.ts`（确认轮询）、`pack.ts`（打包）
- 二进制读取器合一（`bytes.ts`，原 layout 的 Reader、lp 的 Bytes、decode 的 Data）；代币账户完整布局的解析统一到 `layout.parseTokenAccountState`（/approvals、/simulate 共用）；计算预算指令的上限 / 单价解码合一（`computeBudgetOf`，/simulate、/fees 共用）；`history.ts` 的并发池改用公共的 `mapPool`；“方法不可用时说明怎么绕过”的报错包装抽成 `withMethodHint`（/lp、/approvals、资产总值共用）

## 0.6.0

### 新功能

- 交易模拟，子路径 `@w3lib/solana-batch-call/simulate`：`getSimulation` / `simulate` 在主网模拟一笔交易（`simulateTransaction`，不验签名、不上链），输入是 base64 / 字节的交易（legacy、v0 含地址查找表）或本库构建器的输出（`buildSwap`、流动性计划、`{ owner, instructions }`、`buildRevokes` / `buildCloses`）。给出余额变化（SOL 不含手续费、Wrapped SOL 并入 SOL、可选美元价值）、授权变化（delegate 设置 / 变更 / 撤销、账户 owner / 关闭权限 / mint 权限被改、关闭账户，按模拟前后的账户状态比较）、指令解码（System、Token / Token-2022、ATA、计算预算、Memo，Jupiter / Raydium / Orca / Meteora / Pump.fun 的协议和指令名）、程序错误解码、计算单元、手续费和警告（无限额度授权、SetAuthority、改 owner、关闭账户退给别人、不认识的程序、新收款地址、多余的签名者、手续费过高、花掉大部分余额；可选 `/risk` 检查变化的代币）。publicnode 的 `simulateTransaction` 最多返回 10 个账户，自动只看和钱包有关的账户并分批
- 交易历史，子路径 `@w3lib/solana-batch-call/history`：`getHistory` 把地址的交易整理成统一的 `Activity`（兑换、转账、授权、流动性、铸造、合约调用、失败，带方向、对手方、资产变化、手续费、协议），`cursor` 是最后一条签名，支持 `limit`、`before` / `after`（区块时间）、`types` 过滤。数据源可换：默认 `rpcHistory()`（`getSignaturesForAddress` + `getTransaction`，限并发），可选 `heliusHistory({ apiKey })`；传数组时按顺序尝试
- 账户回收，子路径 `@w3lib/solana-batch-call/reclaim`：`getReclaimable` / `reclaimable` 扫描钱包里关闭后能退回租金的账户并给出每项和合计的 lamports：空代币账户（SPL Token / Token-2022，有暂存转账手续费的先收到 mint 上）、垃圾币（销毁后关闭；保守的默认判断：有价格且价值高的、NFT、仓位 NFT 一律不当垃圾币，只勾选有价格的尘埃 / `/risk` 标记的，可疑名字只作提示不单独触发勾选，可传 `isJunk`、`prices`、`maxJunkUsd`）、Wrapped SOL（解包）、已清空的 Orca Whirlpool / Raydium CLMM 仓位（关闭仓位、销毁 NFT，Token-2022 的 NFT 连 mint 一起退回）；冻结 / 关闭权限是别人 / 仓位还有没领的手续费的列在 `blocked`。`buildReclaim` 发送前重新读取账户并核对（余额变了、冻结、仓位不再为空的跳过并给出原因），`simulateReclaim` 用 `/simulate` 逐笔模拟并给出预计退回的 SOL，`reclaim` 构建 → 模拟 → 签名发送（打包同 `batchCall`，`destination`、`feePayer`、`dryRun`）。`/write` 新增指令工具 `burnChecked`
- 批量领取，子路径 `@w3lib/solana-batch-call/claim`：`getClaimable` / `claimable` 只读预览 Orca Whirlpool、Raydium CLMM 仓位的未领取手续费和挖矿奖励（Orca 奖励 slot、Raydium 农场奖励，数量按程序的公式结算），带美元价值和按代币汇总；`buildClaimAll` 复用 `/liquidity` 的 `collectFees` 为每个仓位构建领取（手续费 + 全部奖励），`simulateClaim` 用 `/simulate` 模拟并汇总收到的代币，`claimAll` 构建 → 模拟 → 签名发送（`minUsd`、`dryRun`）
- `/lp`：`getLpPositions` 新增 `rewards: true`（仓位的 `rewards`、`rewardsUsd`，`now` 指定结算时刻），`/lp` 导出 `rewardGrowthGlobal`、`getRewardGrowthInside`；`/liquidity` 内部抽出 `orcaClosePosition` / `raydiumClosePosition`（关闭已清空的仓位）

### 修复

- publicnode 对 `getMultipleAccounts` 超过 10 个账户返回 “A maximum of 10 accounts is allowed”（之前只认 “too many accounts” 和 403 “Request blocked”），会被当成节点故障。现在识别这条报错，直接按它给出的上限拆分

## 0.5.0

### 新功能

- 价格，子路径 `@w3lib/solana-batch-call/price`：
  - `getTokenPrices` / `tokenPrices`：代币（含原生 SOL）的美元价格，依次使用多个价格源，结果带给出价格的源
  - `onchainPrices()`：从 Raydium CLMM、Orca Whirlpool、Raydium CPMM 的池子算价格（按 PDA 推导池子地址，不需要 `getProgramAccounts`；对 Wrapped SOL、USDC、USDT，用最深的池子，流动性下限 `minLiquidityUsd`）
  - `defillamaPrices({ at })`：历史价格
  - `combinePrices([...])`：组合多个价格源，可以传给 `getLpPositions` 的 `prices`
  - `getPortfolio` / `portfolio`：地址的资产总值（指定代币按 ATA 读余额，或列出全部持仓；可选加上 LP 仓位）
- 手续费估算，子路径 `@w3lib/solana-batch-call/fees`：`getFeeEstimate` / `estimateFees`（按 `getRecentPrioritizationFees` 的三档优先费，可以只看交易会写的账户）、`getCostEstimate` / `estimateCost`（模拟一次算一笔交易的花费：每个签名 5000 lamports + 计算单元上限 × 单价 + 新建账户的免租押金；支持指令和构建好的 legacy / v0 交易）
- 域名解析，子路径 `@w3lib/solana-batch-call/names`：SNS（Bonfida，`.sns`）的 `getNameAddresses` / `resolveNames`（名字 → 地址，解析顺序同官方 SDK：代币化域名的 NFT 持有人、V2 / V1 的 SOL 记录、owner）、`getAddressNames` / `lookupAddresses`（地址 → 主域名，核对名字和归属）。`.sol` 已迁到 SRS、SNS 官方 SDK 不再解析，默认不认，`legacySol: true` 时按同名 `.sns` 解析
- 授权管理，子路径 `@w3lib/solana-batch-call/approvals`：
  - `getApprovals` / `approvals`：代币账户的 delegate 授权、别人持有的关闭权限、余额为 0 可以关闭的账户（指定 mints 时读 ATA，免费公共节点也能用；不传时列出全部代币账户），带能否撤销 / 关闭和原因、Token-2022 暂存的转账手续费、mint 的永久授权
  - `buildRevokes` / `revokeApprovals`：批量 Revoke；`buildCloses` / `closeTokenAccounts`：批量关闭回收租金（有暂存转账手续费时先 HarvestWithheldTokensToMint），发送同 `batchCall`
  - `/write` 新增指令工具 `revoke`、`harvestWithheldTokensToMint`
- 价格源的参数（`SolanaPriceSourceContext`）新增 `client`（链上价格源用）；`defillamaPrices`、`SolanaPriceSource` 仍可以从 `/lp` 导入
- 兑换，子路径 `@w3lib/solana-batch-call/swap`（不依赖各 DEX 的 SDK、不调用聚合器）：
  - `buildSwap` / `getSwapQuote` 只构建（报价、最少收到、所有候选路线、按顺序执行的指令），`swap` 构建后签名发送（钱包同 `/write`）
  - Raydium CLMM、Orca Whirlpool、Raydium CPMM 按 PDA 推导池子，Raydium AMM v4 和其他池子用 `pools` 传入；直接兑换和经过 SOL / USDC / USDT 的两跳，选输出最多的
  - 卖出 SOL 时余额检查给手续费和租金留 `SWAP_SOL_RESERVE`（0.01 SOL）；Raydium AMM v4 只支持 status 6（SwapOnly）的池子
  - 本地报价照搬各程序的计算和取整：集中流动性逐个 tick 区间计算（Raydium 的 `fee_on`、动态费率、tick 上的限价单，Orca 的自适应费率），CPMM 的创建者手续费，AMM v4 的待提取收益，Token-2022 转账手续费；主网同一 slot 读账户 + 模拟交易核对 23 个场景（四个协议两个方向、大额穿过上百个 tick、限价单、两跳、转账手续费）全部逐位一致
  - SOL 自动包装 / 解包、缺少的代币账户自动创建、按滑点设每一跳的最少收到、放不进一笔交易的路线跳过
- 代币风险检查，子路径 `@w3lib/solana-batch-call/risk`：
  - `getTokenRisks` / `tokenRisks`：增发 / 冻结权限，Token-2022 的转账手续费（当前和即将生效的费率、能不能改）、永久授权、转账 hook、不可转让、默认冻结、可暂停、保密转账、mint 关闭权限、显示数量会变、销毁需批准，汇总成 `flags`；可选持币集中度（`concentration: true`）
  - `getTradeChecks` / `tradeChecks`：用 `/swap` 模拟“买入 → 卖出”，判断能不能买、能不能卖（`honeypot`）和来回损失

### 修复

- publicnode（默认节点）对单次超过 10 个账户的 `getMultipleAccounts` 返回 HTTP 403 “Request blocked”（2026-10 起），之前会被当成节点故障、换到限频很严的官方节点，`getBalances` 等较大的读取经常失败。现在按 10 个一组重新拆分；从报错里学到的节点限制按节点地址共享，新建的客户端不用再试一遍

## 0.4.0

### 新功能

- 添加 / 移除流动性，子路径 `@w3lib/solana-batch-call/liquidity`（不依赖各 DEX 的 SDK）：
  - `buildAddLiquidity` / `buildRemoveLiquidity` / `buildCollectFees` 只构建（报价 + 按顺序执行的指令），`addLiquidity` / `removeLiquidity` / `collectFees` 构建后签名发送（钱包同 `/write`）
  - Raydium CLMM、Orca Whirlpool：新建仓位（价格区间 / tick / 全区间，给一边算另一边）、追加、按比例移除、全部移除并关闭仓位、领取手续费和挖矿奖励；Orca 自动初始化缺少的 tick 数组
  - Raydium CPMM、AMM v4：存入（给一边，另一边按储备比例）、按比例取出
  - SOL 自动包装 / 解包，缺少的代币账户自动创建；滑点按价格范围算集中流动性的上下限
- `createProgramAddress`（按给定种子算 PDA）
- `/lp` 的数学工具新增 `getLiquidityForAmounts`、`getMintAmounts`、`tickAtSqrtPrice`、`priceToTick`、`getMinAmounts` / `getMaxAmounts` 等

## 0.3.0

### 新功能

- 批量写操作，子路径 `@w3lib/solana-batch-call/write`（只做查询时打包不会带上；不依赖 Solana SDK，私钥用 WebCrypto 的 Ed25519 签名，没有新增依赖）：
  - `batchTransfer`：一对多转账（SOL / SPL Token / Token-2022，可混合），多个收款人打包进同一笔交易，收款人没有 ATA 时自动创建
  - `batchCollect`：多钱包归集，`feePayer` 付全部手续费（子钱包不需要 SOL），可选关闭清空的代币账户、扫空 SOL
  - `batchCall`：批量调用程序，指令可以是 web3.js / @solana/kit / 本库格式
  - 每笔先模拟，失败的调用单独剔除；计算单元上限按模拟结果设置，优先费用默认按最近费用自动设置；blockhash 过期未上链时自动换新 blockhash 重发
  - 浏览器钱包：Wallet Standard 钱包、@solana/wallet-adapter 的 adapter / useWallet()、@solana/kit 的 TransactionSigner，可以和私钥混用；同一批交易钱包只确认一次
  - 指令工具：`systemTransfer`、`transferChecked`、`createAssociatedTokenAccountIdempotent`、`closeAccount`、`setComputeUnitLimit`、`setComputeUnitPrice`
- LP 仓位，子路径 `@w3lib/solana-batch-call/lp`：`getLpPositions` / `lpPositions` 查一个地址的 Raydium CLMM、Orca Whirlpool 仓位 NFT 和 Raydium AMM v4、CPMM 的 LP 代币，两种代币的数量、未领取手续费、可选美元价值（DefiLlama）。账户布局和计算用主网快照与官方 SDK 逐位核对；免费公共节点可以用 `mints` / `pools` 指定代币和池子
- `parseUnits`（`formatUnits` 的逆运算）；`SolanaClient.isNativeMint(mint)`、`SolanaClient.commitment`

## 0.2.2

- 修复：服务端临时故障（-32000 server busy / overloaded / temporarily unavailable / timeout，或 HTTP 5xx + -32603）不再暂停批量 10 分钟，按节点故障处理、换节点（与限频一样不降级，降级只会加重负载）。批量收到 5xx + -32603 时先重试一次批量（偶发故障这次就成功）；仍失败时逐条发送，逐条成功说明节点用 5xx 拒绝批量，才暂停批量。5xx 下的其他错误（方法数量超限、账户数超限、参数错误、minContextSlot 等）照常按类型处理
- 说明（0.2.1 起的行为）：ATA 模式下所属程序未知时，只统计与 mint 所属程序一致的那个 ATA；一个 mint 只属于一个程序，真实链上不会两个 ATA 同时有余额

## 0.2.1

- 只查主币余额时不再读回账户数据：`getSolBalances` 和单币模式（含 `getMultiBalances`）里的主币用 `getMultipleAccounts` + `dataSlice: { offset: 0, length: 0 }` 只取 lamports。原来钱包是数据很大的程序账户（如 105KB）时整份读回，并发查询会超时
  - 单币模式下钱包账户第一次单独一组读；确认是普通钱包（系统账户或不存在，数据本来就为空）后，之后与 mint / ATA 账户放在同一个请求里，不多发请求、主币和代币来自同一个快照；程序账户等始终单独读
  - 两组读取共用并发上限（同时最多 3 个 `getMultipleAccounts`），一个请求失败后不再发后面的批次
- 修复：节点限制单个方法在一个批量请求里的数量时（如内置的 publicnode：`getMultipleAccounts` 最多 1 个，原来整批被拒、当成节点故障切换到下一个节点），按报错里的限制重新分批发送，之后的请求直接按限制分批。原来一次读取超过 100 个账户时就会碰到
- 余额超过 2^53 lamports 时仍是精确值（新增回归测试，包括 HTTP 层对 JSON 大数的解析）
- 修复：一次偶发的批量请求失败（如 -32603）就永久关闭 JSON-RPC 批量。现在整批被拒（HTTP 400 / 404 / 405 / 415 / 422，或返回整体错误、账户数超限除外）时这一批逐条重发，10 分钟内逐条请求，之后重新尝试批量
- 修复：扫描模式和 `accounts: 'all'` 丢掉节点解析不了、退回 base64 的代币账户（如带新扩展的 Token-2022），余额被漏掉或算成 0。现在自己解析出 mint 和数量，decimals（以及节点没给的所属程序）读 mint 账户补上；补读不受 `minContextSlot` 约束、不计入 slot，读不到时只跳过这个代币
- 修复：未初始化的 mint（创建和初始化之间读到）被当作 decimals = 0 并永久缓存，之后余额被放大
- 修复：读响应体时超时或断连抛原生 `DOMException` / `TypeError`，单节点时 `ownerTokens` 读元数据的容错失效。现在同样包装成 `HttpError`（超时带 `timeout` 标记）
- 修复：节点持续返回 JSON-RPC 429 时，批量重试之后又逐条重试，请求数放大约 20 倍。整批都是 429 时只在批量层重试；部分 429 时这些调用单独重试一次
- 快捷函数的客户端缓存：配置的键顺序不同视为同一份；配置里有函数（如自定义 `fetch`）时按函数对象复用客户端（原来每次都新建）
- 导入缓存（`importTokenMetaCache` / `persistTokenMetaCache`）：写入时间只接受有限值，晚于现在的截到现在（原来未来的时间会让 name / symbol 永不过期）；导入的所属程序第一次用时从链上确认（记错时 ATA 余额不再恒为 0）
- 修复：不支持 `JSON.parse` 源文本访问的环境（Node 21 以下、老浏览器）里，大数兜底会改坏字符串里的长数字。现在跳过字符串字面量，只处理数值
- 节点限制单次 `getMultipleAccounts` 的账户数（“Too many accounts requested”）时，减半后分多次请求并合并结果、记住上限，不再当成节点故障
- `findProgramAddress` 检查种子：单个超过 32 字节、或超过 15 个（加上 bump 共 16 个）时抛错，与 web3.js 和链上一致

## 0.2.0

- `getBalances` / `getOwnerTokens` 新增 `tokenPrograms`：按代币类型过滤，`['spl']` 不含 Token-2022（扫描时也不再请求 Token-2022 的代币账户），`['token-2022']` 反之；也可以传程序地址。不认识的值或空数组报错
- `getBalances` 新增 `accounts: 'ata' | 'all'`：指定 mints 时用按 mint 过滤的 `getTokenAccountsByOwner` 统计全部代币账户（含非 ATA），比全量扫描轻
- 失败项带原因：`success: false` 时返回 `error`（`invalid-address` / `not-found` / `not-token` / `no-metadata` / `no-holder` / `missing-field`），`getTokens` 另带 `errorField`；新增导出类型 `FailureReason`。mint 地址非法和 mint 不存在可以区分了
- 去掉运行时依赖 `@noble/curves`：PDA 推导的“是否在曲线上”改为内置实现（与 noble / web3.js 结果一致，新增导出 `isOnCurve`）；`@noble/hashes` 版本范围放宽为 `^1.8.0 || ^2.0.0`，可与 `@solana/web3.js` 带的 1.x 去重。打包体积（minify）64.2KB → 36.4KB，gzip 24.7KB → 14.0KB
- 修复：`nativeMints` 不含 `So111…112` 时，扫描模式的余额列表里 wSOL 出现两次、没有原生 SOL
- 文档：`nativeMints` 可以包含非 Solana 地址（作为调用方自己的主币标识）
- 所有节点都失败时抛 `AllNodesFailedError`（`errors: { node, error }[]`，node 只含 URL 的 host），不再只有最后一个节点的错误；单节点时仍抛原始错误
- 超时与出错分开计：超时只换节点、不冷却，同一节点连续 3 次超时才冷却；`HttpError.timeout` 标记超时
- 节点健康状态（冷却、连续超时）全局共享：URL 相同即同一节点，客户端重建后仍然有效
- `HttpRpc` 报错信息里的地址只保留 origin，不再带出 path / query 里的 API Key
- 单个节点也包一层 `FallbackRpc`（`client.transport` 现在总是 `FallbackRpc`，原节点在 `transport.nodes[0]`）
- `onRequest(listener)`：监听每次调用的节点、方法、耗时、成功与否、第几次尝试；新增 `nodeLabel`、`RequestEvent`，自定义传输可以设 `label`
- 所有查询方法和独立函数支持 `signal`（`AbortSignal`）
- `minContextSlot` / `withSlot`（`balances` / `multiBalances` / `solBalances` / `ownerTokens`，`accounts` 支持 `minContextSlot`）：节点高度不够时换节点或等待重试（最多约 10 秒），结果带读取时的 `slot`
- `multiBalances` / `getMultiBalances`：多个钱包一次查，ATA 模式下合并成一次 `getMultipleAccounts`
- `watchBalances`：轮询余额，相同参数的订阅共用一份轮询，余额变化时才通知
- 代币信息缓存可持久化：`persistTokenMetaCache(localStorage)`，或 `exportTokenMetaCache()` / `importTokenMetaCache()`
- `getTokens` 新增字段 `transferFee`：Token-2022 转账手续费（按当前 epoch 选出生效的配置）；新增 `parseTransferFeeConfig`
- 新增 `formatUnits`（与 ethers 同名），`formatAmount` 保留为别名并标记 deprecated
- `engines.node` 改为 `>=20.19.0`（依赖的 `@noble/hashes` 2.x 的要求）

## 0.1.0

首个版本：

- 批量余额（SOL / SPL Token / Token-2022），指定代币时用 ATA + `getMultipleAccounts`，免费节点可用；扫描模式统计全部代币账户
- 代币详情（字段可选），Metaplex 与 Token-2022 TokenMetadata 扩展
- 资产列表 `getOwnerTokens`：持有人的全部代币，带 name / symbol，多账户合计，元数据分批读取、失败不影响余额
- NFT 元数据、持有人、某地址持有的全部 NFT
- JSON-RPC 自动合并、批量降级、429 重试，多节点故障切换，按创世区块哈希校验网络
- 支持 URL、web3.js Connection、自定义传输
