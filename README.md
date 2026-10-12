# web3-lib/libs

Web3 工具库 monorepo（pnpm workspace），每个库独立发布到 npm。

| 包 | 说明 |
| --- | --- |
| [@w3lib/evm-batch-call](packages/evm-batch-call) | 基于 Multicall3 的 EVM / Tron 批量只读请求与预执行，API 兼容 ethcall；批量转账 / 归集 / 批量调用合约，EVM 与 Tron（子路径 `/write`） |
| [@w3lib/solana-batch-call](packages/solana-batch-call) | Solana 批量读取：SOL / SPL / Token-2022 余额、代币详情、NFT，不依赖 Solana SDK；子路径 `/write`：批量转账、归集、批量调用程序 |
| [@w3lib/wallet](packages/wallet) | 浏览器钱包连接：EVM（EIP-6963、WalletConnect）、Solana、Sui、Tron、TON，自动恢复、统一事件和错误；框架无关，可选的自带连接弹窗（浅色 / 深色）、Vue / React hook、内置常用链；[在线 demo](https://web3-lib.github.io/libs/) |

## 目录结构

```
libs/
├── packages/
│   └── <包名>/
│       ├── src/
│       ├── test/
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
