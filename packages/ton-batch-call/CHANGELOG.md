# Changelog

## 未发布

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
