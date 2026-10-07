# @w3lib/evm-batch-call

基于 Multicall3 的 EVM / Tron 批量合约读取与交易预执行库，依赖 ethers v6，API 兼容 [ethcall](https://github.com/Destiner/ethcall)。

```bash
pnpm add @w3lib/evm-batch-call ethers
```

## 快速上手

### 批量查余额

```ts
import { NATIVE_TOKEN, getBalances } from '@w3lib/evm-batch-call'

// 主币 + 代币一次请求，返回原始余额、decimals 和换算后的数值；不传节点使用内置公共节点
const list = await getBalances(56, user, [NATIVE_TOKEN, USDT, BUSD])
// [
//   { token: NATIVE_TOKEN, native: true,  balance: 1500000000000000000n, decimals: 18, formatted: '1.5',    success: true },
//   { token: USDT,         native: false, balance: 1234500000000000000000n, decimals: 18, formatted: '1234.5', success: true },
//   ...
// ]
```

- 主币地址：`0xeeee…eeee`（导出为 `NATIVE_TOKEN`，不区分大小写）和零地址；可通过 `nativeTokens` 配置
- 主币精度：EVM 链 18、Tron 6（TRX 以 sun 为单位）；可通过 `nativeDecimals` 配置
- decimals 查过一次后按链缓存，之后轮询只查 `balanceOf`；已知精度可以直接传 `{ address, decimals }`
- 单个代币失败（非合约地址、非法地址等）不影响其他代币：该项 `success: false`、`balance: 0n`、`formatted: '0'`
- `formatted` 保留全部有效小数位、不四舍五入，整数不带小数点；单独格式化可用 `formatAmount(value, decimals)`
- 指定节点或区块：`getBalances(56, user, tokens, { rpc: ['https://…'], blockTag: 'pending' })`；也可以用 Provider 上的同名方法 `multi.balances(user, tokens)`

### 合约调用

```ts
import { Provider } from '@w3lib/evm-batch-call'

const multi = new Provider(56) // 不传节点：使用内置公共节点（多节点自动故障切换）

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

// 批量代币信息
const infos = await multi.tokenInfo([USDT, BUSD]) // { symbol, name, decimals } | null

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

## 功能

- **批量余额**：`getBalances` / `balances`，主币 + 代币一次请求，带 decimals 换算后的数值
- **批量读取**：`all` / `tryAll` / `tryEach`，N 条读调用合成一次 `eth_call`；支持数组或对象输入
- **自动合并**：绑定合约直接 `await`，或 `provider.call(x)`，同一收集窗口内的调用合并成一次请求并去重
- **预执行**：`staticCall` / `staticCallAll` / `method.staticCall`，带 `from` / `value` 模拟交易，返回解析好的 revert 原因
- **主币余额合并**：`getEthBalance` 与合约调用在同一次 `eth_call` 里——无论链上有没有 Multicall3
- **任意链可用**：内置 Multicall3 地址表；表里没有、地址无效、或查询早于部署区块时，自动改用 deployless（链上无需部署任何合约）
- **备用节点**：传多个节点自动故障切换；不传节点使用内置公共节点表（34 条 EVM 链 + Tron）
- **Tron**：走 Tron HTTP API，T 开头地址可以直接用
- **浏览器插件钱包**：直接传 `window.ethereum`（EIP-1193）或 `window.tronWeb`
- **大批量**：合约模式按 `chunkSize`（默认 500）分片；deployless 按 48KB initcode 上限自动分片，结果超过 24KB 也能拿回

## 节点与备用节点

```ts
new Provider(56)                                        // 内置公共节点
new Provider(56, 'https://bsc-dataseed.bnbchain.org')   // 单个 URL
new Provider(56, ['https://a.example', 'https://b.example']) // 主节点 + 备用节点
new Provider(56, [window.ethereum, 'https://bsc-dataseed.bnbchain.org']) // 钱包优先，失败用公共节点
new Provider(56, new JsonRpcProvider(url))               // 任意 ethers Provider
new Provider(56, DEFAULT_RPC_URLS[56], { fallback: { timeout: 8000, cooldown: 60_000 } })
```

多节点时按顺序使用：出错或超时（默认 10s）换下一个节点，出错的节点在 `cooldown`（默认 30s）内排到最后。与 ethers 的 `FallbackProvider` 相比，没有首次请求前对所有节点的同步，一个卡住的节点不会拖住第一次查询；合约 revert 等确定性结果不会拿去别的节点重试。

ethers 会把 `eth_call` 的**任何** JSON-RPC 错误（限流、`header not found` 等）都包装成 `CALL_EXCEPTION`，库内用 `isExecutionError(err)` 区分“合约执行结果”和“节点问题”，只有后者会触发切换。

内置节点表 `DEFAULT_RPC_URLS`（按 chainId）/ `DEFAULT_TRON_HOSTS` 中的节点都能在浏览器里直连：放行跨域、支持 batch 请求、chainId 正确、不需要 API Key。公共节点随时可能下线或限流，生产环境建议传入自己的节点，内置表作为备用。

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

`getEthBalance` 在两种模式下都和合约调用在同一次 `eth_call` 里：

- 有 Multicall3：调合约自带的 `getEthBalance`
- deployless：使用本库的 [DeploylessMulticall3](contracts/DeploylessMulticall3.sol)，构造函数里直接用 `BALANCE` 读取

deployless 还修正了 ethcall 自带字节码的两个上限问题（在 BSC 上实测，约 150 条 `balanceOf` 起就会失败）：

| 限制 | 现象 | 处理 |
| --- | --- | --- |
| EIP-170：合约创建返回 ≤ 24KB | `max code size exceeded` | 结果过大时合约改为 `revert Aggregate3Result(...)` 带回（revert 数据没有大小限制） |
| EIP-3860：initcode ≤ 48KB | `max initcode size exceeded` | 按编码后的大小自动分片 |

如果钱包或中间层丢掉了 revert 数据，会对半拆分重试，直到结果能正常返回。合约用 `pnpm build:contracts` 编译（solc 0.8.30，evmVersion=paris，不使用 PUSH0，兼容老链和 Tron TVM）。

## 浏览器插件钱包

```ts
const multi = new Provider(chainId, window.ethereum)          // MetaMask / OKX / Rabby …
const tron = new Provider(TRON_CHAIN_ID.mainnet, window.tronWeb) // TronLink / OKX …
```

- EVM 钱包内部用 ethers `BrowserProvider` 包装
- Tron 钱包请求走钱包配置的节点，预执行默认以当前连接地址作为 `from`，切换账号后自动跟随
- 请求发到的是**钱包当前所选的链**，要与传入的 `chainId` 一致；可以写成 `[window.ethereum, ...公共节点]`，钱包出错时自动用公共节点

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
new Provider(chainId, nodes?, {
  multicall: { address: '0x…', block: 0 }, // 自定义 Multicall3 地址（默认查内置表）
  deployless: false,                       // true：强制走 deployless
  chunkSize: 500,                          // 合约模式单次 eth_call 最多打包的调用数
  batch: { wait: 0, maxSize: 500 },        // 自动合并参数
  fallback: { timeout: 10_000, cooldown: 30_000 }, // 节点超时 / 出错节点冷却时间
  tron: { apiKey, minInterval: 200 },      // 用 URL 创建 TronProvider 时的参数
  nativeTokens: [NATIVE_TOKEN, ZeroAddress], // balances() 里视为主币的地址（默认值；ZeroAddress 来自 ethers）
  nativeDecimals: 18,                      // 主币精度（默认 EVM 18、Tron 6）
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

// 代币信息一次查
const infos = await multi.tokenInfo(tokens)

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
