# Changelog

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
