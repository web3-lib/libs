/**
 * 编译 contracts/DeploylessMulticall3.sol，生成 src/deployless.ts（字节码常量）。
 * 合约改动后执行 `pnpm build:contracts`，并把生成的文件一起提交。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const solc = require('solc')

const SOURCE = new URL('../contracts/DeploylessMulticall3.sol', import.meta.url)
const OUTPUT = new URL('../src/deployless.ts', import.meta.url)

const input = {
  language: 'Solidity',
  sources: { 'DeploylessMulticall3.sol': { content: readFileSync(SOURCE, 'utf8') } },
  settings: {
    // paris：不产生 PUSH0，老链、部分 L2 和 Tron TVM 都能执行
    evmVersion: 'paris',
    optimizer: { enabled: true, runs: 200 },
    // 去掉 metadata hash，保证同一份源码编译结果稳定
    metadata: { bytecodeHash: 'none', appendCBOR: false },
    outputSelection: { '*': { '*': ['evm.bytecode.object', 'abi'] } },
  },
}

const output = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (output.errors ?? []).filter((e) => e.severity === 'error')
if (errors.length) {
  console.error(errors.map((e) => e.formattedMessage).join('\n'))
  process.exit(1)
}

const contract = output.contracts['DeploylessMulticall3.sol'].DeploylessMulticall3
const bytecode = `0x${contract.evm.bytecode.object}`

writeFileSync(
  OUTPUT,
  `// 由 scripts/build-contracts.mjs 生成，不要手改。源码：contracts/DeploylessMulticall3.sol（solc ${solc.version()}）

/** constructor((address target, bool allowFailure, bytes callData)[] calls) — 以 aggregate3 的返回格式带回结果 */
export const DEPLOYLESS_MULTICALL3_BYTECODE =
  '${bytecode}'
`,
)
console.log(`wrote src/deployless.ts (${(bytecode.length - 2) / 2} bytes)`)
