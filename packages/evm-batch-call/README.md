# @w3lib/evm-batch-call

基于 Multicall3 的 EVM / Tron 批量合约读取与交易预执行库，依赖 ethers v6，API 兼容 [ethcall](https://github.com/Destiner/ethcall)。

```bash
pnpm add @w3lib/evm-batch-call ethers
```

## 快速上手

### 常用查询

常用的批量查询都有现成函数，一次请求查完一批，结果都是字符串 / 数字 / 布尔，可以直接 `JSON.stringify`：

```ts
import { NATIVE_TOKEN, getAllowances, getBalances, getTokens } from '@w3lib/evm-batch-call'
import { getErc1155Balances, getNftBalances, getNftCollections, getNftOwners, getNftTokenUris } from '@w3lib/evm-batch-call/nft' // NFT 在子路径

// 余额：主币 + 代币，带 decimals 换算
await getBalances(user, [NATIVE_TOKEN, USDT], { chainId: 56 })
// [{ token: NATIVE_TOKEN, native: true, balance: '1500000000000000000', decimals: 18, formatted: '1.5', success: true }, ...]
await getBalances(user, [NATIVE_TOKEN, USDT], { chainId: 56, symbol: true }) // 额外返回 symbol
await getBalances(user, [BAYC, USDT], { chainId: 1, decimals: false })       // 只查余额，不查 decimals（没有 decimals 的合约也能查）
// [{ token: BAYC, native: false, balance: '128', success: true }, ...]

// 代币详情，字段可选：name / symbol / decimals / totalSupply（默认前三个）
await getTokens([USDT, NATIVE_TOKEN], { chainId: 56, fields: ['symbol', 'decimals', 'totalSupply'] })
// [{ address: USDT, native: false, symbol: 'USDT', decimals: 18, totalSupply: '…', totalSupplyFormatted: '…', success: true }, ...]

// 授权额度：发交易前判断是否需要 approve
const [allowance] = await getAllowances(user, router, [USDT], { chainId: 56 })
// { token: USDT, spender: router, allowance: '…', formatted: '100', unlimited: false, success: true }

// NFT
await getNftCollections([BAYC], { chainId: 1, fields: ['standard', 'name', 'totalSupply'] }) // standard 通过 ERC165 识别
await getNftBalances(user, [BAYC, MAYC], { chainId: 1 })                                     // ERC721 持有数量
await getNftOwners([{ contract: BAYC, tokenId: 1 }], { chainId: 1 })                        // ERC721 持有人
await getNftTokenUris([{ contract: BAYC, tokenId: 1 }], { chainId: 1, ipfsGateway: 'https://ipfs.io/ipfs/' })
await getErc1155Balances(user, [{ contract: ITEMS, tokenId: 7 }], { chainId: 137 })         // ERC1155 余额
```

| 函数 | 传 Provider 实例的写法 | 说明 |
| --- | --- | --- |
| `getBalances(owner, tokens, opts)` | `multi.balances(owner, tokens, opts)` | 主币 + 代币余额；`symbol: true` 额外返回 symbol；`decimals: false` 只查余额 |
| `getTokens(tokens, opts)` | `multi.tokens(tokens, opts)` | ERC20 详情，`fields` 选择返回字段，结果类型随之收窄 |
| `getAllowances(owner, spender, tokens, opts)` | `multi.allowances(...)` | 授权额度；`unlimited` 表示额度 ≥ uint96 最大值（覆盖 MaxUint256 及 UNI / COMP 这类截断为 uint96 的代币）；`decimals: false` 只查额度 |
| `getNftCollections(contracts, opts)` | `nftCollections(multi, contracts, opts)` | **子路径 `/nft`**。NFT 集合 standard / name / symbol / totalSupply，`fields` 可选 |
| `getNftBalances(owner, contracts, opts)` | `nftBalances(multi, owner, contracts)` | **`/nft`**。ERC721 持有数量 |
| `getNftOwners(items, opts)` | `nftOwners(multi, items)` | **`/nft`**。ERC721 持有人，可混合多个集合；不存在的 tokenId 为 null；Tron 链上返回 T 开头的地址 |
| `getNftTokenUris(items, opts)` | `nftTokenUris(multi, items, opts)` | **`/nft`**。元数据地址：自动兼容 ERC721 `tokenURI` 与 ERC1155 `uri`（`{id}` 按规范替换），`ipfsGateway` 转换 `ipfs://`；首次查询顺带识别集合标准并缓存，之后只发对应的调用 |
| `getErc1155Balances(owner, items, opts)` | `erc1155Balances(multi, owner, items)` | **`/nft`**。ERC1155 余额 |
| `getOwnerTokens(owner, opts)` | `ownerTokens(multi, owner, opts)` | **子路径 `/owner`**。资产列表：地址持有的代币（**不推荐使用**，结果不保证完整，见[资产列表](#资产列表)） |

**子路径**：NFT 查询在 `@w3lib/evm-batch-call/nft`，资产列表（含代币来源、价格源、Transfer 增量扫描）在 `@w3lib/evm-batch-call/owner`。不用这些功能时打包不会带上它们的代码（拆出后约少 15KB：只用 `getBalances` 时 minify 后约 44KB、gzip 约 16KB，均不含 ethers）。

共同的规则：

- **主币**：`0xeeee…eeee`（导出为 `NATIVE_TOKEN`，不区分大小写）按主币处理，不发合约调用；name / symbol / 精度来自内置链信息表（`NATIVE_CURRENCIES`），可用 `nativeTokens` / `nativeName` / `nativeSymbol` / `nativeDecimals` 配置
- **⚠ 零地址 `0x0000…0000` 默认也按主币处理**（返回主币余额，不会去调零地址上的 `balanceOf`）。如果你的数据里零地址代表别的含义，传 `nativeTokens: [NATIVE_TOKEN]` 只保留 `0xeeee…eeee`
- **主币余额的读取方式**：默认和合约调用放在同一次 `eth_call` 里。有的链在合约里读主币余额恒为 0、不报错（如 Anubis），内置表 `NATIVE_BALANCE_MODES` 已为这类链改用 `eth_getBalance`；其他链可用 `nativeBalance: 'rpc'` 或 `{ erc20: '0x…' }` 配置，见[主币余额与 deployless](#主币余额与-deployless)
- **缓存**：查过一次后按链缓存（各函数共用），之后只查会变的数据。decimals / NFT 标准永久缓存；name / symbol 在可升级合约上可能改，各自缓存 1 小时；最多 5 万个代币，超出淘汰最早的（与 solana-batch-call 一致）。已知精度可以直接传 `{ address, decimals }`（主币也适用，优先于内置配置）。缓存可以持久化，见[缓存持久化](#缓存持久化)
- **失败**：单项失败（非合约地址、非法地址、不存在的 tokenId 等）不影响其他项，该项 `success: false`；整个请求失败（节点不可用等）才会抛错。`getBalances` / `getTokens` / `getAllowances` 的失败项还带 `error`（`invalid-address` 地址非法、`invalid-argument` 其他参数编码失败、`no-contract` 地址上没有合约、`reverted` 执行 revert、`decode-failed` 返回值无法解码、`not-configured` 没发请求的信息缺失，如主币不在内置链信息表里）和 `errorField`（哪一项没读到，如 `balance` / `decimals`），可以按原因分别处理（如地址非法报错、没有合约按 0）
- **取消**：所有查询都可以传 `signal`（`AbortController`）：已取消时不发请求；查询中取消时立即 reject，合并在一起的底层请求继续完成、结果丢弃。切换代币时不必再手动比对、丢弃旧结果
- **只查余额**：`decimals: false` 时不查 decimals，结果不带 `decimals` / `formatted`（类型随之变化）。适合没有 `decimals` 的合约（ERC721 的 `balanceOf`）、或只需要原始数值的场景，冷启动时子调用数减半
- **数值**：原始数值是最小单位的十进制字符串，需要计算时用 `BigInt(x)`；`formatted` 保留全部有效小数位、不四舍五入，整数不带小数点（单独格式化可用 `formatUnits(value, decimals)`；旧名 `formatAmount` 仍可用，已标记 deprecated）
- **老代币**：symbol / name 返回 bytes32 的代币（MKR 等）也能解析

### 多个钱包、轮询、刚成交后刷新

```ts
import { getMultiBalances, watchBalances } from '@w3lib/evm-batch-call'

// 多个钱包一次查：同一条链上合成一次 multicall
const [a, b] = await getMultiBalances([{ owner: walletA, tokens: [NATIVE_TOKEN, USDT] }, { owner: walletB, tokens: [USDT] }], { chainId: 56 })

// 轮询：多处订阅同一个钱包的同一组代币时合并成一份轮询（代币顺序无关），只在余额变化时通知；返回取消订阅的函数
const stop = watchBalances(user, [NATIVE_TOKEN, USDT], { chainId: 56, interval: 10_000, onChange: (list, previous) => render(list) })

// 交易刚确认：要求读到的数据不早于交易所在区块（公共节点可能还落后一两个块）
const receipt = await tx.wait()
await getBalances(user, tokens, { chainId: 56, minBlock: receipt.blockNumber })
await getBalances(user, tokens, { chainId: 56, withBlock: true }) // 每项带 blockNumber：读取时的区块号
```

- **`withBlock`**：区块号与数据在同一次 `eth_call` 里读出（Multicall3 的 `getBlockNumber`；deployless 合约里直接取 `block.number`），不多发请求。`balances` / `tokens` / `allowances` 及对应函数都支持
- **`minBlock`**：先按最新状态查并顺带读区块号，节点落后（结果的区块号早于 `minBlock`）时当场换下一个节点，跟上的节点直接给出最新状态；所有节点都落后时按 `minBlock` 指定区块重查——落后的节点对未来区块报错或返回较旧区块，同样换节点（落后不算故障，不进入冷却）；仍然都落后时每秒重试，最多约 10 秒后抛错，传了 `signal` 时取消后立即停止。重查得到的是 `minBlock` 那个区块的状态（已包含刚确认的交易）。只对最新状态的查询生效（指定了 `blockTag` 时忽略）。Tron 节点只能查最新状态，落后时等节点跟上再查。`nativeBalance: 'rpc'` 时主币余额在批量查询实际读取的区块上用 `eth_getBalance` 读取，与代币余额、`blockNumber` 一致
- **`watchBalances`**：相同的节点参数 + 钱包 + 代币 + 选项共用一份轮询（多处订阅时取最小的 `interval`），新订阅者立即拿到最近一次的结果；查询失败调用 `onError`，轮询继续；上一次查询没完成时不会重叠发起；最后一个订阅者取消后停止

### 节点参数

以上函数的节点参数相同，`chainId` 和 `provider` 至少传一个：

```ts
await getBalances(user, tokens, { chainId: 56 })                                   // 只传 chainId：使用内置公共节点
await getBalances(user, tokens, { provider: 'https://bsc-dataseed.bnbchain.org' }) // 只传节点：chainId 自动识别
await getBalances(user, tokens, { provider: ['https://rpc-1.example', 'https://rpc-2.example'] }) // 主节点 + 备用节点
await getBalances(user, tokens, { provider: window.ethereum })                     // EVM 钱包
await getBalances(user, tokens, { provider: window.tronWeb })                      // Tron 钱包
await getBalances(user, tokens, { chainId: 56, provider: [window.ethereum, 'https://bsc-dataseed.bnbchain.org'] }) // 钱包优先，失败用公共节点
await getBalances(user, tokens, { chainId: 56, blockTag: 'pending' })              // 指定区块
```

- **chainId 自动识别**：EVM 节点 / 钱包用 `eth_chainId`，ethers Provider 用 `getNetwork()`，Tron 读创世区块哈希的最后 4 字节（与 TronGrid 的 `eth_chainId` 一致）；只传 URL 时先按 EVM 识别，失败再按 Tron 识别，所以 Tron 节点 URL 也不用传 chainId
- **识别结果缓存**：同时发起的识别共用一个请求，失败或超时不缓存（下次重试）。URL 按地址缓存；tronWeb 按当前连接的节点地址缓存（TronLink 切网络后自动重新识别）；EIP-1193 钱包按对象缓存并监听 `chainChanged`，切链时失效，不支持事件监听的钱包不缓存。`clearChainIdCache()` 可手动清空
- **链校验**：传入的节点会确认它实际所在的链与 chainId 一致，不一致时报 `NETWORK_ERROR`，多节点时自动换下一个节点。所以 `[钱包, 公共节点]` 这类组合、配错了节点 URL、或用户自己创建的 `BrowserProvider` 在别的链上，都不会把另一条链的数据当成这条链的返回。校验通过已配置好的节点连接进行（带 Tron apiKey 等），与实际请求并行发出、不增加延迟，结果缓存，每个节点只多一次请求；内置公共节点不校验
- **Provider 复用**：同一个 chainId + 配置 + 节点多次调用会复用同一个 Provider（共享连接和合并队列，最多缓存 32 组，超出淘汰最早的）；`[window.ethereum, ...urls]` 这类钱包 + URL 混合列表按“钱包对象 + URL”复用。只传钱包（没传 chainId）时每次按钱包当前的链创建，切链后自动按新链查询。`chainId` 为 `null` / `''` 时视为未传
- **直接传 Provider 实例**：`{ provider: multi }` 时直接用这个实例（chainId 和配置以实例为准，同时再传会报错），与其他直接调用 `multi` 的代码共享合并队列
- 其余 Provider 配置（`fallback`、`nativeSymbol` 等，见[配置](#配置)）也可以直接放进这个参数

### 合约调用

```ts
import { Provider } from '@w3lib/evm-batch-call'

const multi = new Provider(56)                 // 只传 chainId：使用内置公共节点（多节点自动故障切换）
// const multi = await Provider.create(window.ethereum) // 只传节点：等 chainId 识别完成后返回（也可以 new Provider(window.ethereum)，首次调用时识别）
// const multi = new Provider(56, rpc, config) // 都传：与 ethcall 相同

const usdt = multi.erc20('0x55d398326f99059fF775485246999027B3197955')

// 直接 await；同一 tick 内发起的调用自动合并成一次 multicall
const [symbol, balance, bnb] = await Promise.all([
  usdt.symbol(),
  usdt.balanceOf(user),
  multi.getEthBalance(user), // 主币余额也在同一次请求里
])

// 对象形式：结果是同名字段，类型自动推断
const { decimals, allowance } = await multi.all({
  decimals: usdt.decimals(),
  allowance: usdt.allowance(user, spender),
})

// 常用查询都有对应的 Provider 方法
const list = await multi.balances(user, [NATIVE_TOKEN, USDT], { symbol: true })
const infos = await multi.tokens([USDT, BUSD], { fields: ['symbol', 'decimals'] })

// 任意合约
const pair = multi.contract(pairAddress, [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
])
const [reserves, token0] = await Promise.all([pair.getReserves(), pair.token0()])
reserves.reserve0 // 多返回值可按名字或下标取

// 预执行（模拟交易），写法同 ethers
const router = multi.contract(routerAddress, RouterABI)
const amountOut = await router.swap.staticCall(params, { value, from: user })
```

## 资产列表

> **不推荐使用**（已标记 `@deprecated`）：`getOwnerTokens` / `ownerTokens` 只能尽力而为，结果不保证完整、准确，局限性见下文。已知要查哪些代币时请用 `getBalances`；传 `alchemy` / `nodereal` 来源能查全，但同样受第三方服务的额度和可用性约束，需要可靠的完整持仓请直接接入索引服务的接口或自己的索引。

EVM 链上**没有办法只靠节点列出一个地址持有的全部代币**（链上没有“某地址持有哪些代币”的索引）。`getOwnerTokens` 的做法是：先从“代币来源”拿到候选代币，再用 multicall 在链上核对这些代币的余额，返回有余额的部分。

```ts
import { alchemy, getOwnerTokens, nodereal, tokenList } from '@w3lib/evm-batch-call/owner'

await getOwnerTokens(user, { chainId: 56 })                                   // 默认：免费公开代币列表
await getOwnerTokens(user, { chainId: 1, prices: true, minUsd: 1 })           // 带美元价值，按价值排序，过滤 < $1 的代币
await getOwnerTokens(user, { chainId: 56, source: alchemy({ apiKey: KEY }) }) // 用 Alchemy 查全部历史持仓（需要 Key）
// [
//   { token: NATIVE_TOKEN, native: true,  symbol: 'BNB',  formatted: '1.5', price: 600, value: 900, source: 'native', … },
//   { token: '0x…',        native: false, symbol: 'CAKE', formatted: '120', price: 2,   value: 240, source: 'metamask', logo: '…', … },
// ]
```

### 代币来源

| 来源 | 需要 Key | 能发现什么 | 说明 |
| --- | --- | --- | --- |
| `metamaskTokenList()`（默认首选） | 否 | MetaMask 汇总的代币列表（Ethereum 约 9500 个、BSC 约 2 万个），默认只用至少 3 家来源收录的 | MetaMask 自用接口，非对外承诺的公开 API |
| `coingeckoTokenList()`（默认备用） | 否 | CoinGecko 收录的代币（Ethereum 约 6000 个、BSC 约 4500 个） | 覆盖 26 条链，见 `COINGECKO_PLATFORMS` |
| `tokenList(url)` | 否 | 任意 Uniswap Token List 格式的列表（自己维护的、PancakeSwap 等） | |
| `staticTokens(list)` | 否 | 固定的代币地址 | 如之前发现过、存下来的代币 |
| `alchemy({ apiKey })` | **是** | 地址的全部历史持仓 | 19 条链，见 `ALCHEMY_NETWORKS`；可用 `urls: { [chainId]: url }` 按链覆盖地址 |
| `nodereal({ apiKey })` | **是** | 地址的全部历史持仓 | 仅 BSC、Ethereum；同样支持 `urls` |

- 默认来源是 `firstAvailable(metamaskTokenList(), coingeckoTokenList())`：MetaMask 列表不支持这条链、为空或请求失败时，用 CoinGecko 列表
- 来源可以组合：`firstAvailable(a, b)` 依次尝试，`combine(a, b)` 合并去重（单个来源出错不影响其他来源），例如 `combine(defaultTokenSource(), staticTokens(savedTokens))`
- **Key 只在调用时传入**：库里没有内置任何 Key，`alchemy()` / `nodereal()` 不传 `apiKey` 会直接报错，不传就不能用这两个来源。出错信息里不会包含 Key。在浏览器里使用时 Key 会暴露给用户，建议在服务端调用，或使用对方控制台里的域名白名单
- 不管代币从哪个来源发现，**余额和精度都由本库在链上用 multicall 核对**（来源返回的余额不使用，来源给错的精度会被链上的值纠正），链上读不到精度的合约（不是正常的 ERC20）不返回
- 主币用 Provider 配置的 `nativeTokens` 里的第一个地址查询（默认 `0xeeee…eeee`），名称 / symbol 同样遵循 `nativeName` / `nativeSymbol` 配置；列表里出现的主币映射地址（如 Polygon 的 `0x…1010`、zkSync 的 `0x…800A`）会被排除，不会把主币算两次
- 公开代币列表按 URL 缓存 1 小时；`clearTokenListCache()` 可手动清空

### 增量扫描（可选）

代币列表发现不了的新代币（刚发行、未被收录），可以用 `scanTransfers` 开关补充：开启后，从**第一次调用开始**，每次调用都往后扫描新区块里转给该地址的 ERC20 `Transfer` 事件，把发现的代币合并进来（结果的 `source` 为 `'transfers'`）。默认关闭。

```ts
import { getOwnerTokens, keyValueScanStorage } from '@w3lib/evm-batch-call/owner'

await getOwnerTokens(user, { chainId: 1, scanTransfers: true })                    // 进度存在内存里
await getOwnerTokens(user, { chainId: 1, scanTransfers: { storage: keyValueScanStorage(localStorage) } }) // 刷新页面后接着扫
await getOwnerTokens(user, { chainId: 1, scanTransfers: { lookbackBlocks: 20_000 } }) // 第一次额外往回扫一段
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `storage` | 内存 | 扫描进度（起始区块、已扫到的区块、发现的代币）。内存存储在进程 / 页面结束后丢失；`keyValueScanStorage(localStorage)` 或自己实现 `{ get, set }`（如存数据库）可以持久化 |
| `lookbackBlocks` | 0 | 第一次调用时往回扫的区块数（0 表示只从现在开始） |
| `blockRange` | 1000 | 单次 `eth_getLogs` 的最大区块范围。节点有上限时按报错里的上限自动缩小（报错里没写上限就减半试），记下的上限 1 天后失效再重新试；偶发错误导致缩小后，连续成功会逐步放大回去 |
| `maxRequests` | 20 | 每次调用最多发多少个 `eth_getLogs`；落后很多时分多次追上 |
| `timeBudget` | 5000 | 每次调用的扫描时间预算（毫秒），超过后不再发新请求，留到下次调用 |
| `confirmations` | 5 | 只扫到最新区块往前这么多个区块，避开链重组和节点之间的高度差（否则可能漏掉刚出的区块） |

出错时的处理：所有节点都明确不开放 `eth_getLogs` 时暂停 10 分钟；能用的节点只是限频 / 超时时不缩小范围，退避后重试（连续 3 次失败留到下次调用）；有节点报范围超限时缩小范围。存储里的进度格式不对（如旧版本留下的）会被丢弃，重新开始。

也可以单独当作代币来源使用：`combine(defaultTokenSource(), transferScan({ storage }))`；`getTransferScanState(chainId, owner, storage)` 读取扫描进度。

**增量扫描的局限**：

- **只能发现开始扫描之后收到的代币**（以及 `lookbackBlocks` 范围内的）。更早收到、又不在代币列表里的代币仍然查不到；需要完整历史请用 `alchemy` / `nodereal`
- **需要节点支持 `eth_getLogs`**，免费公共节点限制很多：BSC 上内置节点只有 blockrazor 可用，且每次最多 25 个区块（会自动适配），连续请求还会被限频；节点完全不支持时会暂停 10 分钟再试。持续使用建议传自己的节点
- **进度默认只在内存里**：页面刷新、服务重启后会从头开始（重新记下当前区块），需要持久化请传 `storage`
- **会增加 `getOwnerTokens` 的耗时**：扫描和余额查询一起等待，每次调用通常多几百毫秒到 `timeBudget`（默认 5 秒），最坏再加上一个请求的超时时间（节点超时默认 10 秒）。对耗时敏感时可以调小 `timeBudget` / `maxRequests`，或单独用 `transferScan` 在后台定期扫描、展示时只读进度
- **很久没调用时追赶较慢**：每次最多 `maxRequests` 个请求、`timeBudget` 时间（如 BSC 上 20 × 25 = 500 个区块），落后很多时需要多次调用才能追上
- **最新几个区块里收到的代币要等下一次调用**（`confirmations`，默认 5 个区块）
- 扫描到的代币不经过任何列表筛选，**大部分会是空投垃圾币**，建议配合 `prices` + `minUsd` 使用
- 只看转入（`to` 为该地址）的 ERC20 `Transfer` 事件；不发标准 `Transfer` 事件的代币发现不了；Tron 不支持

### 价格

`prices: true` 用 DefiLlama 查美元价格（免费、不需要 Key），结果带 `price` / `value`，并按价值从高到低排序；`minUsd` 只保留价值不低于它的代币（没有价格的代币也会被去掉，主币始终保留）。只传 `minUsd` 时会自动开启 DefiLlama 价格；与 `prices: false` 同时使用会报错。也可以传自己的价格源：`prices: { name, prices: async ({ chainId, tokens, native }) => Map }`。

### 局限性

使用前请了解：

1. **默认来源只能发现公开列表里的代币**。刚发行、还没被列表收录的代币（如新上线的 meme 币）、小众代币查不到；需要完整持仓时，传 `alchemy({ apiKey })` 或 `nodereal({ apiKey })`
2. **默认来源依赖第三方免费服务**（MetaMask、CoinGecko 的列表，DefiLlama 的价格）：它们可能限流、变更格式或停止服务；MetaMask 列表接口不是对外承诺的公开 API。生产环境建议组合多个来源，或使用自己维护的列表（`tokenList(url)`）
3. **列表里也有垃圾币和零头**。默认只用至少 3 家来源收录的代币来减少垃圾币，但仍会有不少价值很低的代币；需要干净的列表时开启 `prices` 并设置 `minUsd`
4. **价格不一定可信**。流动性很差的代币价格可能严重虚高（实测有空投代币被估值数十万美元），默认已过滤 DefiLlama 置信度低于 0.9 的价格，但展示总资产时仍建议使用自己的价格源或再做校验
5. **需要查几千到两万个代币的余额**，耗时几秒：实测 Ethereum（约 9500 个代币）首次约 11 秒、之后约 6 秒，BSC（约 4800 个）首次约 8 秒、之后约 4 秒（首次要在链上核对持有代币的精度，之后有缓存）。大量使用时建议缓存结果；列表很大时也会占用较多节点请求
6. **只包含 ERC20 代币**，不含 NFT（NFT 请用 `getNftBalances` 等）；Tron 链没有默认来源，需要自己传 `source`
7. 使用 Alchemy / NodeReal 时受它们的免费额度和限频约束，翻页次数默认最多 20 页（2000 个代币），可用 `maxPages` 调整
8. 开启 `scanTransfers` 时另有局限，见上面「增量扫描」

## 功能

- **常用查询**：余额、代币详情、授权额度、NFT（集合 / 持有 / 元数据地址 / ERC1155 余额，子路径 `/nft`），一个函数一次请求
- **资产列表**（不推荐使用，尽力而为，子路径 `/owner`）：`getOwnerTokens`，免费公开代币列表或带 Key 的索引服务发现代币，multicall 核对余额，可选 DefiLlama 价格
- **批量读取**：`all` / `tryAll` / `tryEach`，N 条读调用合成一次 `eth_call`；支持数组或对象输入
- **自动合并**：绑定合约直接 `await`、`provider.call(x)`，以及 `balances` / `tokens` / `allowances`，同一收集窗口内的调用合并成一次请求并去重
- **预执行**：`staticCall` / `staticCallAll` / `method.staticCall`，带 `from` / `value` 模拟交易，返回解析好的 revert 原因
- **主币余额合并**：`getEthBalance` 与合约调用在同一次 `eth_call` 里——无论链上有没有 Multicall3
- **任意链可用**：内置 Multicall3 地址表；表里没有、地址无效、或查询早于部署区块时，自动改用 deployless（链上无需部署任何合约）。少数链不支持 deployless（合约创建式 `eth_call`，如 Oasis Emerald、Aurora），这些链已在地址表里，只能查合约部署之后的状态；`pnpm check:rpc` 会检查内置节点表里每条链至少有一种批量方式可用
- **备用节点**：传多个节点自动故障切换；不传节点使用内置公共节点表（34 条 EVM 链 + Tron）
- **chainId 可选**：传了节点就能自动识别 chainId，结果缓存，钱包切链自动失效
- **Tron**：走 Tron HTTP API，T 开头地址可以直接用
- **浏览器插件钱包**：直接传 `window.ethereum`（EIP-1193）或 `window.tronWeb`
- **大批量**：合约模式按 `chunkSize`（默认 500）分片；deployless 按 48KB initcode 上限自动分片，结果超过 24KB 也能拿回

## 节点与备用节点

```ts
new Provider('https://bsc-dataseed.bnbchain.org')       // 只传节点：chainId 自动识别
new Provider(56)                                        // 内置公共节点
new Provider(56, 'https://bsc-dataseed.bnbchain.org')   // 单个 URL
new Provider(56, ['https://a.example', 'https://b.example']) // 主节点 + 备用节点
new Provider(56, [window.ethereum, 'https://bsc-dataseed.bnbchain.org']) // 钱包优先，失败用公共节点
new Provider(56, new JsonRpcProvider(url))               // 任意 ethers Provider
new Provider(56, DEFAULT_RPC_URLS[56], { fallback: { timeout: 8000, cooldown: 60_000 } })
```

多节点时按顺序使用：出错或超时（默认 10s）换下一个节点，出错的节点在 `cooldown`（默认 30s）内排到最后。与 ethers 的 `FallbackProvider` 相比，没有首次请求前对所有节点的同步，一个卡住的节点不会拖住第一次查询；合约 revert 等确定性结果不会拿去别的节点重试。

**超时与出错分开计**：出错（连不上、5xx、限频等）的节点进入冷却；超时只换下一个节点、不冷却，同一节点连续 3 次超时才冷却——冷启动的大批量查询偶尔慢，不会把健康的节点踢到后面。冷却状态按节点（URL / 对象）全局共享，Provider 重建后刚失败过的节点仍排在后面。

**所有节点都失败**时抛 `AllNodesFailedError`，`err.errors` 是每个节点的标识和失败原因（`[{ node, error }]`，按尝试顺序），message 里也逐个列出；节点标识只取 URL 的 host，不含 path / query 里的 API Key。单节点时抛原始错误。

**可观测性**：`onRequest(listener)` 订阅所有节点请求（全局，返回取消订阅的函数），每次对节点的请求一条事件：

```ts
import { onRequest } from '@w3lib/evm-batch-call'

const off = onRequest(({ node, method, ms, ok, error, attempt }) => {
  // node：节点 host（钱包为 'wallet'）；method：call / getBalance / getLogs …；attempt > 0 表示换过节点
  console.log(`${node} ${method} ${ms}ms ${ok ? 'ok' : 'failed'}${attempt ? ` (第 ${attempt + 1} 个节点)` : ''}`)
})
```

**慢节点**：`fallback.stallTimeout`（毫秒，默认 0 关闭）设置后，当前节点超过这个时间还没返回就同时请求下一个节点，原请求不取消，谁先成功用谁（与 `FallbackProvider` 的 stallTimeout 语义相同）；`timeout` 才是真正放弃。节点正常但偶尔较慢时，用 `{ stallTimeout: 2000, timeout: 10_000 }` 比把 `timeout` 设短更好：大批量查询本来就要几秒，`timeout` 太短会把正常的慢请求判成超时、反复重试。只影响 `eth_call` / `eth_getBalance`。

ethers 会把 `eth_call` 的**任何** JSON-RPC 错误（限流、`header not found` 等）都包装成 `CALL_EXCEPTION`，库内用 `isExecutionError(err)` 区分“合约执行结果”和“节点问题”，只有后者会触发切换。

内置节点表 `DEFAULT_RPC_URLS`（按 chainId）/ `DEFAULT_TRON_HOSTS` 中的节点都能在浏览器里直连：放行跨域、支持 batch 请求、chainId 正确、不需要 API Key。公共节点随时可能下线或限流，生产环境建议传入自己的节点，内置表作为备用。

## 缓存持久化

decimals 永远不会变，但页面刷新后缓存就没了，冷启动的大批量查询要顺带查精度，耗时能差好几倍。可以把缓存持久化：

```ts
import { exportTokenMetaCache, importTokenMetaCache, persistTokenMetaCache } from '@w3lib/evm-batch-call'

persistTokenMetaCache(localStorage)          // 调用时读入，之后有更新就防抖（1 秒）写回，默认最多 5000 条；返回停止函数
// 或自己存：IndexedDB、服务端……
await save(JSON.stringify(exportTokenMetaCache()))
importTokenMetaCache(JSON.parse(await load())) // 格式不对的数据忽略；name / symbol 仍按写入时间 1 小时过期
```

## 批量读取

```ts
import { Contract, Provider } from '@w3lib/evm-batch-call'

const usdt = new Contract(USDT, ERC20_ABI) // 未绑定的 Contract：方法返回 Call，与 ethcall 一致
const multi = new Provider(56)

const [symbol, decimals] = await multi.all([usdt.symbol(), usdt.decimals()]) // 任意一条失败整体抛错
const res = await multi.tryAll([usdt.symbol(), other.symbol()])             // 失败的位置为 null
const res2 = await multi.tryEach([usdt.symbol(), usdt.balanceOf(user)], [true, false])
await multi.all(calls, { blockTag: 40_000_000 })                            // 指定区块
```

- 单返回值的函数直接返回该值；多返回值返回 ethers `Result`（可按下标或名字取）；整数统一是 `bigint`
- 结果类型按输入推断（元组保留各项类型）；ethcall 风格的 `all<T>(calls)` 返回 `T[]`，`all<any>(calls)` 返回 `any[]`
- `tryAll` 中出现非法地址（如后端给的脏数据）只让该条为 `null`，不会拖垮整批
- `Contract` 暴露 ABI 里的**所有**函数（不只 view/pure），重载函数用完整签名访问：`c['getAmount(uint256,address)'](...)`

## 自动合并

绑定合约（`multi.contract` / `multi.erc20`）的方法返回值可以直接 `await`，等价于 `multi.call(call)`：

```ts
const multi = new Provider(chainId, rpc, { batch: { wait: 10, maxSize: 500 } })

// 分散在不同组件里的调用，只要落在同一个收集窗口内就只发一次 eth_call
const a = multi.erc20(tokenA).balanceOf(user)
const b = multi.erc20(tokenB).balanceOf(user)
```

- `wait`：收集窗口，默认 `0`（同一事件循环 tick）；`maxSize`：达到即发出，默认 500
- 单条失败只 reject 自己（`CallFailedError`，`err.reason` 是 revert 原因）
- blockTag / from 不同的调用分开发
- `balances` / `tokens` / `allowances` 的子调用也进同一个队列：不同组件同时查余额时合成一次 `eth_call`，相同的 `balanceOf` / `decimals` 只请求一次；一次调用的子调用不会被 `maxSize` 拆开
- 合并发生在**同一个 Provider 实例**内，应按链缓存 Provider，不要每次 `new`
- 绑定合约的 Call 只在第一次 `await` 时才发请求，传给 `all` / `tryAll` 不会额外发请求
- 末位参数可以带 overrides：`await pair.getReserves({ blockTag: 18_000_000 })`。传给 `all` / `tryAll` 时以批次的 overrides 为准（一批只能在同一个区块、同一个 from 下执行）

## 预执行

```ts
const router = multi.contract(routerAddress, RouterABI)

await router.swap.staticCall(params, { value, from: user }) // 写法同 ethers
await multi.staticCall(router.swap(params, { value }), { from: user })

// 批量：每条单独返回成功/失败
const results = await multi.staticCallAll(
  [quoter.quoteExactInputSingle(paramsA), { call: router.swap(paramsB), overrides: { value: amountIn } }],
  { from: user },
)
for (const r of results) {
  if (r.success) console.log(r.data)
  else console.log(r.error) // 合约 revert 时是 CallFailedError（r.error.reason）
}
```

预执行**不走 multicall**：multicall 里子调用的 `msg.sender` 是 multicall 合约，也无法逐条带 `value`，与真实交易不一致。每条都是对目标合约的独立 `eth_call`，同时发出（`JsonRpcProvider` 会合进一个 JSON-RPC batch 请求）。

## 主币余额与 deployless

`getEthBalance`（以及 `balances` 里的主币）默认在两种模式下都和合约调用在同一次 `eth_call` 里：

- 有 Multicall3：调合约自带的 `getEthBalance`
- deployless：使用本库的 [DeploylessMulticall3](contracts/DeploylessMulticall3.sol)，构造函数里直接用 `BALANCE` 读取

**有的链在合约里读不到正确的主币余额**：比如 Anubis（6714）的主币其实是一个 ERC20，`getEthBalance` 和 `BALANCE` 对任何地址都返回 0、不报错，只有 `eth_getBalance` 正确。这时 `balances()` 会返回 `success: true, balance: '0'`，调用方察觉不到。用 `nativeBalance` 配置读取方式：

```ts
new Provider(6714, url, { nativeBalance: 'rpc' })              // 主币单独走 eth_getBalance（与 eth_call 同时发出）
new Provider(chainId, url, { nativeBalance: { erc20: '0x…' } }) // 主币改调这个 ERC20 的 balanceOf，仍在同一次 eth_call 里
```

内置表 `NATIVE_BALANCE_MODES` 收录了已知的这类链（目前是 Anubis），默认按表处理。`pnpm check:rpc` 会对每条链比对“合约里读到的主币余额”和 `eth_getBalance`，新链有这个问题时会报出来。

deployless 还修正了 ethcall 自带字节码的两个上限问题（在 BSC 上实测，约 150 条 `balanceOf` 起就会失败）：

| 限制 | 现象 | 处理 |
| --- | --- | --- |
| EIP-170：合约创建返回 ≤ 24KB | `max code size exceeded` | 结果过大时合约改为 `revert Aggregate3Result(...)` 带回（revert 数据没有大小限制） |
| EIP-3860：initcode ≤ 48KB | `max initcode size exceeded` | 按编码后的大小自动分片 |

如果钱包或中间层丢掉了 revert 数据，会对半拆分重试，直到结果能正常返回。合约用 `pnpm build:contracts` 编译（solc 0.8.30，evmVersion=paris，不使用 PUSH0，兼容老链和 Tron TVM）。

## 浏览器插件钱包

```ts
const multi = new Provider(window.ethereum) // MetaMask / OKX / Rabby …，chainId 取钱包当前的链
const tron = new Provider(window.tronWeb)   // TronLink / OKX …
const bsc = new Provider(56, window.ethereum) // 指定链：钱包不在这条链上时报错
```

- EVM 钱包内部用 ethers `BrowserProvider` 包装
- Tron 钱包请求走钱包配置的节点，预执行默认以当前连接地址作为 `from`，切换账号后自动跟随
- 请求发到的是**钱包当前所选的链**。传了 `chainId` 而钱包不在这条链上（包括用户中途切链）时请求会报 `NETWORK_ERROR`，不会返回别的链的数据；写成 `[window.ethereum, ...公共节点]` 时会自动改用公共节点
- 只传钱包时，同一个 Provider 实例固定在识别时的链上，用户切链后请求同样报 `NETWORK_ERROR`；需要跟随钱包切链时用 `getBalances` 等函数（每次按当前链查询），或在 `chainChanged` 时重新创建 Provider
- 只传节点时 chainId 在首次调用时识别，识别失败（如钱包未解锁、节点限流）会在下次调用时重试；`rpc` / `multicall` 这类同步属性需要在 `await multi.ready()` 之后读取，或直接用 `await Provider.create(...)`

## Tron

```ts
import { Provider, TRON_CHAIN_ID, TronProvider, toTronAddress } from '@w3lib/evm-batch-call'

const multi = new Provider(TRON_CHAIN_ID.mainnet) // 内置 4 个全节点，自动故障切换
// 或自定义：new Provider(TRON_CHAIN_ID.mainnet, new TronProvider({ apiKey, minInterval: 200 }))

const usdt = multi.erc20('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
const [symbol, balance, trx] = await Promise.all([
  usdt.symbol(),
  usdt.balanceOf('TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G'), // 参数里的 T 地址自动转换
  multi.getEthBalance('TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G'), // TRX，单位 sun
])
toTronAddress('0xa614f803b6fd780986a42c78ec9c7f77e6ded13c') // 返回值里的地址是 0x 格式，需要时转换
```

- 主网使用链上的 Multicall3 `TEazPvZwDjDtFeJupyo7QunvnrnUjPH8ED`；Nile / Shasta 走 deployless
- 用 Tron 全节点 HTTP API 而不是 `/jsonrpc`：后者不支持 deployless、revert 不返回数据、不支持 `value`
- 只能查最新状态，传历史 `blockTag` 会报错
- 免费的 TronGrid 限频很严，`TronProvider` 支持 `concurrency`（默认 4）、`minInterval`、429 自动退避重试（`retries`，默认 3；多节点时为 0，直接切换节点）

## 配置

```ts
new Provider(chainId, nodes?, { // 或 new Provider(nodes, { … })
  multicall: { address: '0x…', block: 0 }, // 自定义 Multicall3 地址（默认查内置表）
  deployless: false,                       // true：强制走 deployless
  chunkSize: 500,                          // 合约模式单次 eth_call 最多打包的调用数
  batch: { wait: 0, maxSize: 500 },        // 自动合并参数
  fallback: { timeout: 10_000, cooldown: 30_000, stallTimeout: 0 }, // 节点超时 / 出错节点冷却时间（超时连续 3 次才冷却）/ 慢节点提前请求下一个
  tron: { apiKey, minInterval: 200 },      // 用 URL 创建 TronProvider 时的参数
  nativeTokens: [NATIVE_TOKEN, ZeroAddress], // 视为主币的地址（默认值；ZeroAddress 来自 ethers）
  nativeDecimals: 18,                      // 主币精度 / symbol / 名称，默认按内置链信息表（NATIVE_CURRENCIES）
  nativeSymbol: 'BNB',
  nativeName: 'BNB',
  nativeBalance: 'contract',               // 主币余额读取方式：'contract' | 'rpc' | { erc20 }，默认按内置表 NATIVE_BALANCE_MODES
})
```

## 从 ethcall 迁移

API 兼容，大多数情况下只需替换 import，现有调用（含 `tryAll<bigint>(calls)` 这种显式泛型写法）无需改动：

```ts
- import { Contract, Provider } from 'ethcall'
+ import { Contract, Provider } from '@w3lib/evm-batch-call'

  const multi = new Provider(chainId, ethersProvider)
  const token = new Contract(address, abi) // ABI 现在也可以直接用人类可读字符串
  const [symbol, decimals] = await multi.all([token.symbol(), token.decimals()])
```

之后可以逐步简化：

```ts
// 节点：直接传 URL 列表（或不传，用内置公共节点），不需要自己组装 FallbackProvider
const multi = new Provider(chainId, ['https://rpc-1.example', 'https://rpc-2.example'])

// 主币余额不用再单独 getBalance，和代币余额一次查
const balances = await multi.balances(account, tokens) // [{ balance, decimals, formatted, success }]

// 代币详情、授权额度一次查
const infos = await multi.tokens(tokens)
const allowances = await multi.allowances(account, router, tokens)

// Tron 也能批量查，不用逐个 triggerConstantContract
const tron = new Provider(TRON_CHAIN_ID.mainnet, window.tronWeb)

// 预执行：绑定合约后写法同 ethers
const router = multi.contract(routerAddress, RouterABI)
await router.swap.staticCall(params, { value })
```

与 ethcall 的行为差异：

| | ethcall 6 | evm-batch-call |
| --- | --- | --- |
| ABI | 仅 JSON（需要 `abiToJson`） | 人类可读字符串 / JSON / `Interface` |
| 合约实现 | `all`/`tryAll`/`tryEach` 分别用 Multicall1/2/3 | 全部用 Multicall3 `aggregate3` |
| 地址表有但链上地址无效 | 直接报错 | 自动退回 deployless 并记住 |
| deployless 大批量 | 约 150 条起失败 | 自动分片 + revert 带回 |
| 主币余额 | 仅有 multicall 合约时可用 | 任何模式都在同一批 |
| `tryAll` 中出现非法地址 | 整批抛错 | 只有该条为 `null` |
| 暴露的函数 | 仅 view / pure | 全部函数（便于模拟调用） |
| 节点 | 单个 ethers Provider | URL / 多节点故障切换 / 钱包 / 内置公共节点 |
| Tron、自动合并、预执行、绑定合约 | 无 | 有 |

## 开发

```bash
pnpm test              # 单元测试（mock 节点，不需要网络）
pnpm test:live         # 连真实节点：BSC / Ethereum / Tron 主网（BSC_RPC / ETH_RPC / TRON_HOST / TRON_API_KEY 可覆盖）
pnpm build             # 编译到 dist
pnpm build:contracts   # 修改 contracts/ 后重新生成 src/deployless.ts
pnpm check:rpc         # 检查内置公共节点表的可用性（--chain=56 只查一条链）
```

## License

MIT。Multicall3 地址表来自 ethcall（MIT）。
