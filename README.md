# web3-libs

Web3 工具库 monorepo（pnpm workspace），每个库独立发布到 npm。

| 包 | 说明 |
| --- | --- |
| [evm-batch-call](packages/evm-batch-call) | 基于 Multicall3 的 EVM / Tron 批量只读请求与预执行，API 兼容 ethcall |

## 目录结构

```
web3-libs/
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
pnpm --filter evm-batch-call test:live   # 单个包执行脚本
```

## 新增一个库

1. 复制 `packages/evm-batch-call` 的 `package.json`、`tsconfig.json`、`tsconfig.build.json`、`LICENSE` 到 `packages/<新包名>/`
2. 修改 `name` / `description` / `keywords` / `version`，按需调整 `dependencies` / `peerDependencies`
3. 源码放 `src/`，入口 `src/index.ts`；测试放 `test/`（vitest）

## 发布

```bash
cd packages/<包名>
npm version patch            # 或 minor / major
pnpm publish                 # prepublishOnly 会先跑 typecheck + test + build
```

发布前先在 npm 上确认包名可用（`npm view <包名>` 返回 404 即可用）。如果以后统一放到某个 scope 下（如 `@xxx/evm-batch-call`），改 `name` 即可，`publishConfig.access` 已设为 `public`。
