# web3-lib/libs

Web3 工具库 monorepo（pnpm workspace），每个库独立发布到 npm。

| 包 | 说明 |
| --- | --- |
| [@w3lib/evm-batch-call](packages/evm-batch-call) | 基于 Multicall3 的 EVM / Tron 批量只读请求与预执行，API 兼容 ethcall；LP 仓位（V2 / V3 / V4，子路径 `/lp`）；添加 / 移除流动性（子路径 `/liquidity`）；批量转账 / 归集 / 批量调用合约，EVM 与 Tron（子路径 `/write`，可用 EIP-7702、ERC-4337、EIP-5792 合成一笔并赞助 gas）；交易模拟与解码（`/simulate`）、交易历史（`/history`）、Permit / Permit2 免 approve（`/permit`）、LP 手续费和挖矿奖励批量领取（`/rewards`）、Flap 分红领取（`/dividends`）；[在线 demo](https://web3-lib.github.io/libs/evm/) |
| [@w3lib/solana-batch-call](packages/solana-batch-call) | Solana 批量读取：SOL / SPL / Token-2022 余额、代币详情、NFT，不依赖 Solana SDK；LP 仓位（Raydium、Orca，子路径 `/lp`）；添加 / 移除流动性（子路径 `/liquidity`）；子路径 `/write`：批量转账、归集、批量调用程序；`/simulate` 交易模拟与解码、`/history` 交易历史、`/reclaim` 账户回收（空账户、垃圾币、空仓位）、`/claim` CLMM 手续费和奖励批量领取；[在线 demo](https://web3-lib.github.io/libs/solana/) |
| [@w3lib/sui-batch-call](packages/sui-batch-call) | Sui 批量读取：SUI / 代币余额、代币信息、对象、NFT（Display），gRPC-web 直连全节点、多节点故障切换，不依赖 Sui SDK；子路径 `/write` 批量转账 / 归集（赞助 gas）/ 批量交易，`/simulate` 交易模拟与解码、`/history` 交易历史，`/lp`、`/liquidity` LP 仓位和加减流动性（Cetus、Bluefin、Momentum、Turbos、Magma、FlowX、Kriya 的 CLMM，Cetus DLMM，DipCoin、FlowX V2、Kriya 的 AMM，Aftermath 多币池）；[在线 demo](https://web3-lib.github.io/libs/sui/) |
| [@w3lib/ton-batch-call](packages/ton-batch-call) | TON 批量读取：TON / Jetton 余额（多个地址合成一个请求）、Jetton 信息、NFT、钱包状态，基于 toncenter v3 索引器，自动限频、多节点故障切换，不依赖 TON SDK；子路径 `/write` 批量转账 / 归集 / 批量交易（钱包 v4r2 / v5r1、TON Connect），`/simulate` 交易模拟与解码、`/history` 交易历史，`/lp`、`/liquidity` STON.fi / DeDust 的 LP 仓位和加减流动性；[在线 demo](https://web3-lib.github.io/libs/ton/) |
| [@w3lib/overview](packages/overview) | 多链资产总览：EVM / Tron / Solana / Sui / TON 各给一个地址，一次调用得到合计、分链明细、跨链合并的资产、LP 仓位、授权风险摘要，某条链失败不影响其他链；链包是可选依赖，由应用传 loader 按需加载；[在线 demo](https://web3-lib.github.io/libs/overview/) |
| [@w3lib/wallet](packages/wallet) | 浏览器钱包连接：EVM（EIP-6963、WalletConnect）、Solana、Sui、Tron、TON，自动恢复、统一事件和错误；框架无关，可选的自带连接弹窗（浅色 / 深色）、Vue / React hook、内置常用链；[在线 demo](https://web3-lib.github.io/libs/wallet/) |

**在线 demo**：<https://web3-lib.github.io/libs/>（[wallet](https://web3-lib.github.io/libs/wallet/) · [evm-batch-call](https://web3-lib.github.io/libs/evm/) · [solana-batch-call](https://web3-lib.github.io/libs/solana/) · [ton-batch-call](https://web3-lib.github.io/libs/ton/) · [sui-batch-call](https://web3-lib.github.io/libs/sui/) · [overview](https://web3-lib.github.io/libs/overview/)），push 到 main 时由 `.github/workflows/demos.yml` 构建发布到 GitHub Pages。

## 目录结构

```
libs/
├── packages/
│   └── <包名>/
│       ├── src/
│       ├── test/
│       ├── demo/                 # 在线 demo（vite，直接引用 src）
│       ├── package.json
│       ├── tsconfig.json         # 继承 ../../tsconfig.base.json，含 test，用于类型检查
│       ├── tsconfig.build.json   # 只编译 src 到 dist
│       └── README.md
├── tsconfig.base.json            # 公共 TS 配置（ES2022 + NodeNext，纯 ESM）
└── pnpm-workspace.yaml
```

## 常用命令

```bash
pnpm install
pnpm -r test                             # 所有包跑测试
pnpm -r build                            # 所有包构建
pnpm --filter @w3lib/evm-batch-call test:live   # 单个包执行脚本
pnpm --filter @w3lib/evm-batch-call demo        # 本地运行某个包的 demo（每个包都有 demo/）
```

## 新增一个库

1. 复制 `packages/evm-batch-call` 的 `package.json`、`tsconfig.json`、`tsconfig.build.json`、`LICENSE` 到 `packages/<新包名>/`
2. 修改 `name`（统一用 `@w3lib/` scope）/ `description` / `keywords` / `version` / `repository.directory` / `homepage`，按需调整 `dependencies` / `peerDependencies`
3. 源码放 `src/`，入口 `src/index.ts`；测试放 `test/`（vitest）

## 发布

```bash
cd packages/<包名>
npm version patch            # 或 minor / major
pnpm publish                 # prepublishOnly 会先跑 typecheck + test + build
```

所有包都发布在 npm 的 `@w3lib` scope 下。scope 包默认是私有的，各包 `package.json` 里已设置 `publishConfig.access: public`，新包记得带上。
