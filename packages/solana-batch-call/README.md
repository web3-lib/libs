# @w3lib/solana-batch-call

Solana 批量读取库：余额（SOL / SPL Token / Token-2022）、代币详情、NFT。不依赖 Solana SDK，直接发 JSON-RPC。

```bash
pnpm add @w3lib/solana-batch-call
```

- **一次请求查一批**：账户读取用 `getMultipleAccounts`（自动去重、按 100 个一组拆分）；同一 tick 内发起的 RPC 调用合并成一个 JSON-RPC 批量请求
- **免费节点也能查余额**：指定代币时在本地推导关联代币账户（ATA）地址，和 SOL 账户、mint 账户一起一次读完，不需要 `getTokenAccountsByOwner` 这类索引方法
- **Token-2022**：余额、decimals、TokenMetadata 扩展里的 name / symbol / uri 都支持
- **多节点故障切换**：限频、403、需要 API Key、不支持某方法等节点问题自动换下一个节点；节点不支持批量请求或限制批量大小时自动降级
- **网络校验**：按创世区块哈希确认节点所在网络，不会把 devnet 的数据当成 mainnet 的返回
- 结果字段都是字符串 / 数字 / 布尔 / null，可以直接 `JSON.stringify`

## 快速上手

```ts
import { NATIVE_MINT, getBalances, getNftOwners, getNfts, getOwnerNfts, getSolBalances, getTokens } from '@w3lib/solana-batch-call'

// 余额：SOL + 代币，带 decimals 换算（不传 provider 时使用内置的 mainnet 公共节点）
await getBalances(owner, [NATIVE_MINT, USDC, PYUSD], { symbol: true })
// [
//   { token: NATIVE_MINT, native: true,  balance: '1500000000', decimals: 9, formatted: '1.5', tokenProgram: null, symbol: 'SOL', success: true },
//   { token: USDC,        native: false, balance: '1234500000', decimals: 6, formatted: '1234.5', tokenProgram: 'Tokenkeg…', symbol: 'USDC', success: true },
//   ...
// ]

// 多个地址的 SOL 余额
await getSolBalances([addressA, addressB])

// 代币详情，字段可选：name / symbol / uri / decimals / supply / tokenProgram / mintAuthority / freezeAuthority（默认 name、symbol、decimals）
await getTokens([USDC, PYUSD], { fields: ['name', 'symbol', 'decimals', 'supply'] })
// [{ address: USDC, native: false, name: 'USD Coin', symbol: 'USDC', decimals: 6, supply: '…', supplyFormatted: '…', success: true }, ...]

// NFT
await getNfts([mint])        // 名称、uri、所属集合（是否已认证）、版税、标准、创作者
await getNftOwners([mint])   // 持有人
await getOwnerNfts(owner)    // 某地址持有的全部 NFT（需要支持索引方法的节点）
```

| 函数 | SolanaClient 方法 | 说明 |
| --- | --- | --- |
| `getBalances(owner, mints?, opts)` | `balances` | SOL + SPL Token + Token-2022 余额；`symbol: true` 额外返回 symbol；不传 mints 返回全部持仓 |
| `getSolBalances(addresses, opts)` | `solBalances` | 多个地址的 SOL 余额 |
| `getTokens(mints, opts)` | `tokens` | 代币详情，`fields` 选择字段，结果类型随之收窄 |
| `getNfts(mints, opts)` | `nfts` | NFT 元数据（Metaplex；Token-2022 NFT 取扩展） |
| `getNftOwners(mints, opts)` | `nftOwners` | NFT 持有人 |
| `getOwnerNfts(owner, opts)` | `ownerNfts` | 某地址持有的全部 NFT |
| — | `accounts(addresses)` | 批量读原始账户（`AccountInfo \| null`） |
| — | `request(method, params)` | 直接发 JSON-RPC（同样参与合并与故障切换） |

## 余额的两种模式

| | 指定 mints（默认） | 扫描（不传 mints，或 `scan: true`） |
| --- | --- | --- |
| 实现 | 本地推导 ATA + 一次 `getMultipleAccounts` | `getTokenAccountsByOwner`（Token / Token-2022 各一次） |
| 统计范围 | 只统计 **ATA** 里的余额 | 该地址的**全部**代币账户，同一代币多个账户合计 |
| 免费公共节点 | 可用 | 大多不支持，需要自己的节点（Helius、QuickNode、Triton 等） |

普通钱包的代币都在 ATA 里，用默认模式即可。交易所、托管类地址常有非 ATA 的代币账户，默认模式会少算，需要 `scan: true`。

其他规则：

- **主币**：`So111…112`（`NATIVE_MINT`，Wrapped SOL 的 mint）和 `11111…1`（System Program）按原生 SOL 查询（lamports，9 位精度）；可用 `nativeMints` 配置，传 `[]` 时 `So111…112` 按普通代币（Wrapped SOL）查询
- **缓存**：decimals、所属程序、name、symbol 查过一次后按网络缓存（各函数共用），之后轮询只查余额
- **失败**：mint 不存在、地址非法等只让该项 `success: false`；节点不可用等整个请求失败时才抛错

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
- 节点不支持批量请求时自动改为逐条并发；返回 “Batch of more than N” 时按 N 缩小批量
- HTTP 429 和 JSON-RPC 错误码 429 都会退避重试（`retries`，默认 2；多节点时为 0，直接换节点），批量里只重试被限频的那几条
- 单次请求超时 `timeout`，默认 10 秒

**故障切换**（多节点时）：网络错误、超时、限频、403、需要 API Key、请求被拦截等节点问题换下一个节点，出错节点冷却 `cooldown`（默认 30 秒）；参数错误等确定性错误直接抛出（`RpcError`，`isNodeFault(err)` 可判断）。

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

## 工具函数

```ts
import {
  getAssociatedTokenAddress, // ATA 地址
  getMetadataAddress,        // Metaplex 元数据账户地址
  findProgramAddress,        // 通用 PDA 推导（与 web3.js findProgramAddressSync 相同）
  isAddress,
  parseMint, parseTokenAccount, parseMetaplexMetadata, // 账户数据解析
  formatAmount,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, GENESIS_HASHES,
} from '@w3lib/solana-batch-call'
```

## 开发

```bash
pnpm test        # 单元测试（模拟节点，不需要网络）
pnpm test:live   # 连真实节点（SOLANA_RPC 指定支持索引方法的节点；需要代理时加 NODE_USE_ENV_PROXY=1）
pnpm build
```

## License

MIT
