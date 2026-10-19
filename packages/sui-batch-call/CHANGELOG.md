# Changelog

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
