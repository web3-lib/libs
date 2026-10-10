# Changelog

## Unreleased

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
