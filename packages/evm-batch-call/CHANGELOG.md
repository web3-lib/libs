# Changelog

## 0.7.0

### 新功能

- 价格，子路径 `@w3lib/evm-batch-call/price`：
  - `getTokenPrices` / `tokenPrices`：代币（含主币）的美元价格，依次使用多个价格源，结果带给出价格的源
  - `onchainPrices()`：从内置协议表的 V2 / V3 池子算价格（对包装主币、稳定币，用最深的池子，流动性下限 `minLiquidityUsd`），也支持 Tron 的 SunSwap
  - `defillamaPrices({ at })`：历史价格
  - `combinePrices([...])`：组合多个价格源，可以传给 `getLpPositions` / `getOwnerTokens` 的 `prices`
  - `getPortfolio` / `portfolio`：地址的资产总值（传入代币的余额 × 价格，可选加上 LP 仓位）
- 兑换，子路径 `@w3lib/evm-batch-call/swap`：`getSwapQuote` / `buildSwap`（V2 / V3 池子的直接和两跳路线，一次 multicall 报价，选输出最多的，按滑点算最少收到、价格影响）、`swap`（授权 + 兑换，主币自动包装 / 解包），Tron 上是 SunSwap V2
  - `swap` 有授权时，授权确认后重新报价再发兑换（deadline、最少收到从发兑换那一刻算）；`tax` 选项：V2 报价不含转账税，带税代币的最少收到要再乘 (1 − tax)
- 代币风险检查，子路径 `@w3lib/evm-batch-call/risk`：`getTokenRisks` / `tokenRisks`，在 `eth_call` 里用 deployless 的探测合约（`contracts/TokenProbe.sol`）模拟买入 / 转账 / 卖出，算出买入税、转账税、卖出税，识别貔貅盘；检查 EIP-1967 代理和 owner
- 手续费估算，子路径 `@w3lib/evm-batch-call/fees`：`getFeeEstimate` / `estimateFees`（按 `eth_feeHistory` 的三档 EIP-1559 费用，不支持时按 `eth_gasPrice`）、`getCostEstimate` / `estimateCost`（一笔交易的手续费，含 OP Stack / Scroll 的 L1 数据费；Tron 按能量、带宽和账户剩余资源算要烧的 TRX，含激活费）
- 域名解析，子路径 `@w3lib/evm-batch-call/names`：`getNameAddresses` / `resolveNames`（名字 → 地址）、`getAddressNames` / `lookupAddresses`（地址 → 主名字，正查核对），内置 ENS、SPACE ID（.bnb）、Basenames（.base.eth），名字按 ENSIP-15 规范化
- 授权管理，子路径 `@w3lib/evm-batch-call/approvals`：
  - `getApprovals` / `approvals`：批量查 ERC20 额度、Permit2 额度（含过期时间）、NFT 的 setApprovalForAll；默认检查 `knownSpenders(chainId)`（内置协议的 Router / 仓位合约、Uniswap / PancakeSwap Router、1inch、0x、ParaSwap、Permit2、OpenSea / Blur）
  - `scanApprovals`：按 Approval / ApprovalForAll / Permit2 事件增量发现授权过的代币和 NFT 合约，进度可以保存
  - `buildRevokes` / `revokeApprovals`：批量撤销（approve 0、Permit2 lockdown、setApprovalForAll false），发送同 `batchCall`，支持 7702 合成一笔
  - Tron 支持查询和撤销（没有 Permit2，不支持扫描）
- 价格源的 `PriceSourceContext` 新增 `provider`（链上价格源用）；`defillamaPrices`、`PriceSource` 仍可以从 `/owner`、`/lp` 导入
- 批量查询的链：Multicall3 地址表和内置节点补充 Conflux eSpace（1030）、Injective EVM（1776）、Pharos（1672，主币 PROS），星空链（202308）只有节点（没有 Multicall3，走 deployless）；FSC（201022）补主币 FON
- deployless 不可用（合约创建式 `eth_call` 返回空数据 / 无法解码）时，自动改成逐条 `eth_call`（主币余额用 `eth_getBalance`，区块号用 `getBlockNumber`）；确认不支持后记住 10 分钟，不再先试一次注定失败的 deployless

## 0.6.0

### 新功能

- 添加 / 移除流动性，子路径 `@w3lib/evm-batch-call/liquidity`：
  - `buildAddLiquidity` / `buildRemoveLiquidity` / `buildCollectFees` 只构建（报价 + 按顺序发送的交易，授权在前），`addLiquidity` / `removeLiquidity` / `collectFees` 构建后签名发送（钱包同 `/write`）
  - V2：Router 的 `addLiquidity(ETH)` / `removeLiquidity(ETH)`，数量与 Router 的取整逐位一致；V3：`mint` / `increaseLiquidity` / `decreaseLiquidity` + `collect`（+ `burn`），池子不存在时可传 `initialPrice` 创建；V4：PositionManager 的 actions + Permit2 授权，主币池子
  - 新建仓位按价格区间（tokenB / tokenA）、tick 或全区间，给一边的数量自动算另一边；往已有仓位追加、按比例移除可以直接传 `getLpPositions` 的结果
  - 主币：V2 / V3 的包装币那一边可以用主币支付 / 收取；滑点按价格范围算 V3 的 `amountMin`、V4 的 `amountMax` 和移除的最小数量
  - Tron 的 SunSwap V2 / V3 同样支持
- `LpProtocol.router`：V2 协议的 Router（内置表里的 V2 协议都已填好、在链上核对过）。SunSwap V2 用 SunSwap 网页当前使用的 Router
- `LpProtocol.protocolFee`：V2 协议手续费给 feeTo 增发的比例（`'1/6'` / `'8/25'`），添加 / 移除时按它算 LP 总量
- `/lp` 的数学工具新增 `getLiquidityForAmounts`、`getMintAmounts`、`getTickAtSqrtRatio`、`priceToTick`、`priceToSqrtPriceX96`、`nearestUsableTick` 等（也从 `/liquidity` 导出）

## 0.5.0

### 新功能

- 批量写操作，子路径 `@w3lib/evm-batch-call/write`（只做查询时打包不会带上）：
  - `batchCall`：批量调用合约。`'tx'` 模式每个调用一笔交易，同一钱包按 nonce 顺序连续发出、不同钱包并发；`'7702'` 模式通过 EIP-7702 委托给 Simple7702Account，同一钱包的调用合成一笔交易。依赖前一笔结果的调用（先 approve 再调用）预估失败时自动等前一笔确认后重新预估
  - `batchTransfer`：一对多转账（主币 / ERC20 可混合），默认走 Disperse 合约，链上没有合约、只有一个收款人、某一批预估 revert 时自动改为逐笔发送；为 Disperse 发出的 approve 交易在结果的 `approvals` 里
  - `batchCollect`：多钱包归集，可选 `gasWallet` 自动补 gas（只补差额）、扫空剩余主币（扣除手续费，OP Stack / Scroll 预留 L1 数据费；代币没有全部归集成功的钱包不扫）
  - `revokeDelegation`：撤销 EIP-7702 委托
  - Tron：同样的三个函数传 Tron 的 Provider 即可（TRX / TRC20 转账、合约调用、归集含补 gas 和激活账户）。交易本地编码签名、`broadcasthex` 广播，合约调用先模拟，过期按链上时间判断后自动重发；支持浏览器钱包（tronWeb / tronwallet-adapter）；这部分按需加载
  - 钱包可以传私钥或 ethers Signer（含浏览器钱包的 JsonRpcSigner）；结果可以直接 JSON 序列化，`onUpdate` 回调进度，支持 `dryRun` / `wait: false` / `signal`
- `FallbackRpc.request(method, fn)`：用任意方法请求节点，与 call / getBalance 相同的故障切换
- LP 仓位，子路径 `@w3lib/evm-batch-call/lp`：`getLpPositions` / `lpPositions` 查一个地址的 V2 LP 代币、V3 / V4 仓位 NFT，两种代币的数量、未领取手续费（与合约 `decreaseLiquidity` / `collect` 的结果逐位核对过）、可选美元价值。内置 Uniswap、PancakeSwap、SushiSwap（7 条 EVM 链）和 Tron 的 SunSwap；V4 支持传 tokenId 或扫描 Transfer 事件发现仓位
- DefiLlama 价格源支持 Tron（资产列表在 Tron 上也可以带价格）

## 0.4.2

### 修复

- `minBlock`：节点落后但不报错（返回早于 `minBlock` 的区块）时当场换下一个节点；原来会一直在这个节点上重试，直到约 10 秒后报错，从不问已经跟上的节点。区块号校验移到故障切换里做（deployless 拆成多片时每片各自校验，不会混进落后节点的旧数据）：跟上的节点直接给出最新状态，落后的节点之后排到后面；所有节点都落后时按区块号重查一次，然后等待最新状态跟上；落后不进入冷却，也不会被误判成 Multicall3 不可用

## 0.4.1

### 修复

- 节点返回 `result: null` 等无法解析的结果时（ethers 报 `INVALID_ARGUMENT`，值为 null），换下一个节点、不冷却（调用方传入 undefined 等非法参数仍直接抛出）；原来被当成确定性错误直接抛出、不换节点（如 Unichain 官方节点对未来区块返回 null）
- `eth_call` 返回空数据（`0x`）或无法解码时换下一个节点重试，不冷却：deployless 原来直接报 `BAD_DATA`；Multicall3 原来偶发一次就在整个会话里弃用（在不支持 deployless 的 Oasis Emerald、Aurora 上会导致批量查询全部失败）。现在最多试 2 个节点：2 个节点都返回空数据（或单节点连续 2 次）才判定合约不可用，10 分钟后重新尝试；有节点返回空数据、其余节点出错时退回 deployless
- `minBlock`：按区块号重查的结果同样校验区块号——有的节点对未来区块不报错、直接返回最新状态（如 HyperEVM），原来会把早于 `minBlock` 的旧状态当成结果
- 识别更多节点的“区块不存在”报错（Arbitrum 系 `unsupported block number`、X Layer、Mantle、zkSync、Winchain 等），只换节点、不冷却
- `stallTimeout`：在并发竞争中输给后发节点的慢节点，冷却期内排到健康节点之后；原来慢但不超时的首选节点永不降级，每次查询都多等一个 `stallTimeout`
- 钱包等对象节点的健康状态按链分开记：钱包在一条链上出错，不再影响它在其他链上的排序
- 合并请求结束后移除挂在调用方 `signal` 上的监听（长期存在的 signal 发起多次查询时不再累积）
- `watchBalances`：新订阅的间隔更短时按上次轮询时间计算下一次，不再因重新计时而推迟
- 导入代币信息缓存时，时间戳只接受有限值，晚于现在的截到现在（原来未来时间、`NaN` / `Infinity` 会让 name / symbol 永不过期）

## 0.4.0

### 不兼容的改动

- 代币信息缓存与 solana-batch-call 对齐：最多 5 万个代币（超出淘汰最早的），name / symbol 缓存 1 小时后重查（可升级合约可能改名）；decimals 仍永久缓存
- 单节点也经过 `FallbackRpc`（统一触发 onRequest 事件），`provider.rpc` 始终是 `FallbackRpc`，底层节点在 `rpc.nodes[0]`；错误仍是节点的原始错误
- NFT 查询和资产列表移到子路径，不用时打包不再带上（拆出后约少 15KB；只用 `getBalances` 时 minify 后约 44KB，含本版本新增功能，不含 ethers）：
  - `@w3lib/evm-batch-call/nft`：`getNftCollections` / `getNftBalances` / `getNftOwners` / `getNftTokenUris` / `getErc1155Balances`、`ERC721_ABI` / `ERC1155_ABI` 及相关类型
  - `@w3lib/evm-batch-call/owner`：`getOwnerTokens`、代币来源（`metamaskTokenList` / `alchemy` / `combine` …）、`defillamaPrices`、`transferScan` / `keyValueScanStorage` 等
  - 删除 `Provider` 上的 `nftCollections` / `nftBalances` / `nftOwners` / `nftTokenUris` / `erc1155Balances` / `ownerTokens` 方法，改用子路径里接收 Provider 的同名函数：`multi.nftOwners(items)` → `nftOwners(multi, items)`
- `balances` / `tokens` / `allowances` 的子调用改走自动合并队列（见下），与同一时刻的其他查询合并成一次 `eth_call`；结果不变，但请求会推迟到 `batch.wait` 收集窗口结束（默认同一 tick）

### 新增

- `nativeBalance` 配置：`'contract'`（默认）| `'rpc'`（主币单独走 `eth_getBalance`）| `{ erc20 }`（主币改调 ERC20 的 `balanceOf`），对 `balances`、`getEthBalance`、`all` / `call` / `staticCall` 都生效；内置表 `NATIVE_BALANCE_MODES` 收录合约里读主币余额恒为 0 的链（Anubis 6714 默认 `'rpc'`）
- `pnpm check:rpc` 比对每条链“合约里读到的主币余额”（Multicall3 / deployless）与 `eth_getBalance`，不一致且没有配置时报错
- `balances` / `allowances`（及 `getBalances` / `getAllowances`）的 `decimals: false` 选项：只查余额 / 额度，结果不带 `decimals` / `formatted`（返回类型 `RawTokenBalance` / `RawTokenAllowance`）；没有 `decimals` 的合约（ERC721）也能拿到余额
- `balances` / `tokens` / `allowances` 的失败项带 `error`（`invalid-address` / `invalid-argument` / `no-contract` / `reverted` / `decode-failed` / `not-configured`）和 `errorField`（哪一项没读到）
- `balances` / `tokens` / `allowances` 参与自动合并：不同组件同时发起的查询、单条 `await` 调用合成一次 `eth_call` 并去重；一次调用的子调用不会被 `batch.maxSize` 拆开
- `fallback.stallTimeout`：当前节点超过这个时间未返回时同时请求下一个节点，先成功的胜出（与 ethers `FallbackProvider` 的 stallTimeout 相同，没有首次请求前的全节点同步）；默认 0 不启用
- 快捷函数：`[window.ethereum, ...urls]` 这类钱包 + URL 混合列表也复用 Provider 实例；`provider` 参数可以直接传 `Provider` 实例
- 所有节点都失败时抛 `AllNodesFailedError`，带每个节点的标识（URL 只取 host）和失败原因；单节点时仍抛原始错误
- 超时与出错分开计：超时只换节点、不冷却，同一节点连续 3 次超时才冷却；节点冷却状态按节点（URL / 对象）全局共享，Provider 重建后仍有效
- `onRequest(listener)`：订阅所有节点请求（节点、方法、耗时、成败、第几个节点），用于观察故障切换和耗时
- 所有查询支持 `signal`（AbortSignal）：已取消时不发请求，查询中取消立即 reject
- `withBlock`：`balances` / `tokens` / `allowances` 的结果带读取时的区块号（同一次 `eth_call` 里读出；deployless 合约新增对 `getBlockNumber()` 的支持）
- `minBlock`：节点落后于指定区块时按该区块重查、自动换节点（落后不进入冷却），所有节点都落后时稍等重试（约 10 秒，可用 signal 取消），用于交易刚确认后刷新余额；Tron 上等节点跟上后查最新状态
- `getMultiBalances` / `multiBalances`：多个钱包一次查，同一条链上合成一次 multicall
- `watchBalances`：轮询余额，多处订阅同一份数据时合并成一份轮询，只在余额变化时通知
- 代币信息缓存可持久化：`persistTokenMetaCache(localStorage)`、`exportTokenMetaCache` / `importTokenMetaCache`
- `formatUnits`（与 ethers 同名）；`formatAmount` 保留为别名并标记 deprecated

- Multicall3 地址表补充 23 条链（2026-10 逐条在链上实测 aggregate3 可用）：Cronos、Velas、Unichain、Monad、opBNB、Boba、KCC、Astar、Stable、HyperEVM、Core、Morph、Robinhood Chain、IoTeX、Plasma、Mode、Ink、Linea、Berachain、Scroll、Winchain、Oasis Emerald、Aurora。其中 Oasis Emerald、Aurora 不支持 deployless，原来在这两条链上批量查询会失败
- `pnpm check:rpc` 检查每条链的批量调用方式：内置表里的 Multicall3 能否调用 aggregate3、deployless 能否执行，两种都不可用时报错

### 修复

- Mantle、Blast 的 Multicall3 地址（来自 ethcall 的表）调用 aggregate3 会 revert，改为标准地址（原来会自动退回 deployless，结果正确但多一次失败的请求）
- Arbitrum 系的链（Arbitrum One、Robinhood Chain 等）在合约里 `block.number` 是 L1 区块号：`withBlock` / `minBlock` 改为读 ArbSys 的 `arbBlockNumber()`，得到 L2 区块号
- `all<any>(calls)` / `tryAll<any>(calls)` 显式写 any 时返回 `any[]`，可以按数组解构（原来命中第一个重载，返回值不能解构）

### 文档

- 零地址默认按主币处理，在 README 中单独醒目说明，并给出只保留 `0xeeee…eeee` 的配置

## 0.3.0

### 新增

- `Provider.getBlockNumber()` / `Provider.getLogs()`；多节点时 getLogs / getBlockNumber 失败不影响 call / getBalance 的节点顺序，getLogs 全部失败抛 `GetLogsError`（带各节点的错误）
- 资产列表 `getOwnerTokens` / `ownerTokens`：从代币来源发现候选代币，multicall 在链上核对余额，返回持有的代币
  - 代币来源可替换：`metamaskTokenList`、`coingeckoTokenList`、`tokenList(url)`、`staticTokens`、`alchemy({ apiKey })`、`nodereal({ apiKey })`，以及 `firstAvailable` / `combine` 组合；默认 MetaMask 列表 → CoinGecko 列表（免费免 Key）
  - 可选价格：`prices: true` 用 DefiLlama，或传自定义价格源；`minUsd` 过滤
  - 增量扫描开关 `scanTransfers`（默认关闭）：从第一次调用开始扫描转入的 ERC20 Transfer 事件，补充列表里没有的新代币；进度可持久化（`keyValueScanStorage` 或自定义存储），自动适配节点的区块范围上限与限频；`timeBudget` 限制每次调用的扫描时间，`confirmations` 避开链重组
  - 局限性见 README「资产列表」；结果不保证完整、准确，因此标记为 `@deprecated`（不推荐使用）

## 0.2.0

### 不兼容的改动

- `balances(owner, tokens)` 的返回值从 `bigint[]` 改为对象数组：`{ token, native, balance, decimals, formatted, success }`。`balance` 是最小单位的十进制字符串，需要计算时用 `BigInt(balance)`；单项失败时 `success: false`（原来是 `0n`）
- 删除 `tokenInfo()` 和 `TokenInfo` 类型，改用 `tokens(tokens, { fields })`：可选择字段，主币不再返回 `null`，而是返回内置链信息
- 传入的节点会校验实际所在的链，与 chainId 不一致时报 `NETWORK_ERROR`（多节点时自动换下一个节点），不再静默返回另一条链的数据；内置公共节点不校验
- 主币精度默认取内置链信息表 `NATIVE_CURRENCIES`（表里没有时仍是 EVM 18、Tron 6）

### 新增

- 常用查询，每个都有 Provider 方法和独立函数两种用法：
  - `getBalances`：主币 + 代币余额，带 decimals 换算；`symbol: true` 额外返回 symbol
  - `getTokens`：ERC20 详情，`fields` 选择返回 name / symbol / decimals / totalSupply
  - `getAllowances`：授权额度与是否无限授权
  - `getNftCollections`、`getNftBalances`、`getNftOwners`、`getNftTokenUris`、`getErc1155Balances`
- chainId 可选：`new Provider(window.ethereum)`、`await Provider.create(url)` 从节点识别 chainId，结果缓存（钱包切链时失效）；`getChainId()`、`ready()`
- 独立函数的节点参数：`{ chainId?, provider? }`，可传 URL、URL 数组、ethers Provider、`window.ethereum`、`window.tronWeb` 或混合数组
- `NATIVE_TOKEN`、`NATIVE_CURRENCIES`、`formatAmount`、`detectChainId`、`clearChainIdCache`、`ERC721_ABI`、`ERC1155_ABI`、`MAX_UINT256` 等导出
- symbol / name 返回 bytes32 的老代币（MKR 等）也能解析
- `TronProvider` 新增 `timeout` 选项、`getChainId()`

### 修复

- chainId 识别失败（限流、钱包未解锁等）后会重试，不再让 Provider 永久不可用
- Tron 链上 `nftOwners` 返回 T 开头的地址

## 0.1.0

首个版本：Multicall3 批量读取（`all` / `tryAll` / `tryEach`）、自动合并、`staticCall` 预执行、deployless（含主币余额、大结果 revert 带回、initcode 分片）、多节点故障切换与内置公共节点、Tron、浏览器插件钱包。
