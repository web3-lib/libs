# Changelog

## 0.1.0

首个版本 0.1.0。

- `getOverview(input, options)`：多链资产总览，EVM（多条链）、Tron、Solana、Sui、TON 各给一个地址，一次调用返回
  - 合计（`totalUsd` / `tokensUsd` / `lpUsd`）、分链明细（代币、LP、`unpriced`、耗时）、跨链合并的资产（USDC 等在各链上合成一项）、LP 仓位（统一格式）、授权风险摘要（无限授权、未知被授权方的数量）
  - 某条链失败不影响其余链（`status: 'error'` + `errors`，带 `address`），LP / 授权读取失败降级为 `partial`；某条链的 `portfolio.lp` 优先于全局 `lp`（对象合并）
  - 链包（`@w3lib/*-batch-call`）是可选 peerDependencies，由应用传 `loaders`（`() => import('…/price')`）按需加载；没传时按包名动态导入
  - EVM / Tron 的代币：内置主要代币表（8 条链核对过）+ 应用的列表 + `discover`（钩子，或 `true` 用 `/owner`）；Solana 先列出全部持仓，开了 LP 时先去掉 LP 重试，列出失败才退回内置列表
  - EVM / Tron 总是查主币（ETH、BNB、POL、AVAX、TRX…）：自动加进代币列表第一个，应用传了 `0xeeee…` / 零地址时不重复；没有 symbol 的主币按链区分（`evm:<id>:native`），不把不同链的主币合成一项
  - `minUsd` 在本库过滤列出的代币（链包拿到的是全部持仓），授权检查用过滤前的持仓，零头、没有价格的代币上的授权也查
  - 降级只在原因归于 LP 时发生：去掉 LP 也失败就报这一次的错误（不是 LP 那次的），不再继续重试；Solana 内置列表也失败时错误里给出两个原因
  - `signal` 取消、`concurrency` 并发限制、`chainTimeoutMs` 单条链超时、`onChain` 逐条回调（EVM / Tron 的取消会中止链包的节点请求，需要 `@w3lib/evm-batch-call` 的 `getPortfolio` 支持 `signal`）
- 子路径 `@w3lib/overview/mnemonic`（主入口不引入）：助记词在本地推导各链地址再查总览
  - `deriveAddresses(mnemonic, { accounts, passphrase, chains })`：EVM `m/44'/60'/0'/0/i`、Tron `m/44'/195'/0'/0/i`、Solana `m/44'/501'/i'/0'`、Sui `m/44'/784'/i'/0'/0'`、TON（`m/44'/607'/i'`，TON 格式助记词用它自己的密钥，两种都合法时都推导）的 v4r2 / v5r1 地址，带派生路径；校验 BIP-39 校验和，错误信息不含助记词
  - `getDerivedOverview(addresses, options)` / `getOverviewFromMnemonic(mnemonic, options)`：每个账户一次 getOverview 再合计；TON 查已部署或有余额的钱包版本；`evm.chains: []` 时不查 EVM；合计的 `errors` 带账户、`timings` 同链多地址不覆盖
  - 只返回地址和路径，不返回私钥；种子、私钥用完清零；加密用 @scure/bip39、@scure/bip32、@noble/curves、@noble/hashes，按公开测试向量核对
- demo：“多链总览”可以连接钱包（`@w3lib/wallet` 的 multi 模式，五种链），连上的地址自动填进对应的栏；新增“助记词总览”页（输入框已清空时沿用上次推导的地址并在状态里说明，账户数、链或密码改过时要求重新填助记词；一条 EVM 链都没勾时显示库的 warning）
