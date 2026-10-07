# Changelog

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
