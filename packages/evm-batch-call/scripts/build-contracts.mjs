/**
 * 编译 contracts/ 下的合约，生成字节码常量：
 * - DeploylessMulticall3.sol → src/deployless.ts
 * - TokenProbe.sol → src/tokenProbe.ts（子路径 /risk 用）
 * 合约改动后执行 `pnpm build:contracts`，并把生成的文件一起提交。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const solc = require('solc')

const TARGETS = [
  {
    file: 'DeploylessMulticall3.sol',
    contract: 'DeploylessMulticall3',
    output: 'deployless.ts',
    constant: 'DEPLOYLESS_MULTICALL3_BYTECODE',
    doc: 'constructor((address target, bool allowFailure, bytes callData)[] calls) — 以 aggregate3 的返回格式带回结果',
  },
  {
    file: 'TokenProbe.sol',
    contract: 'TokenProbe',
    output: 'tokenProbe.ts',
    constant: 'TOKEN_PROBE_BYTECODE',
    doc: 'constructor(address router, address token, address pair) payable — 返回 (stage, buyQuote, bought, transferSent, transferReceived, sellAmount, sellQuote, sold, buyGas, sellGas, pairReceived)',
  },
]

for (const target of TARGETS) {
  const input = {
    language: 'Solidity',
    sources: { [target.file]: { content: readFileSync(new URL(`../contracts/${target.file}`, import.meta.url), 'utf8') } },
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
  const bytecode = `0x${output.contracts[target.file][target.contract].evm.bytecode.object}`
  writeFileSync(
    new URL(`../src/${target.output}`, import.meta.url),
    `// 由 scripts/build-contracts.mjs 生成，不要手改。源码：contracts/${target.file}（solc ${solc.version()}）

/** ${target.doc} */
export const ${target.constant} =
  '${bytecode}'
`,
  )
  console.log(`wrote src/${target.output} (${(bytecode.length - 2) / 2} bytes)`)
}
