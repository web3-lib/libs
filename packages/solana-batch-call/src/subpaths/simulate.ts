/**
 * 交易模拟（子路径 `@w3lib/solana-batch-call/simulate`）：不签名、不发送，在主网模拟一笔交易，给出余额变化、授权变化（delegate / SetAuthority / 关闭账户）、
 * 指令说明、程序错误、手续费和警告。输入可以是 base64 的交易，也可以直接是本库构建器的输出。不放在主入口，不用时打包不会带上这部分代码；价格、风险检查按需加载。
 *
 * ```ts
 * import { buildSwap } from '@w3lib/solana-batch-call/swap'
 * import { getSimulation } from '@w3lib/solana-batch-call/simulate'
 *
 * const plan = await getSwapQuote(owner, { tokenIn: NATIVE_MINT, tokenOut: USDC, amountInFormatted: '0.5' })
 * const sim = await getSimulation(plan)            // 或 getSimulation(base64Tx, { owner })
 * if (!sim.success || sim.warnings.some((w) => w.severity === 'danger')) throw new Error(sim.error ?? sim.warnings[0].message)
 * ```
 */
import { resolve, type ShortcutOptions } from '../shortcuts.js'
import { simulate, type SimulateInput, type SimulateOptions, type SimulationResult } from '../simulate.js'

export {
  failureText,
  simulate,
  type ApprovalChange,
  type ApprovalChangeKind,
  type SimulateInput,
  type SimulateOptions,
  type SimulatedBalanceChange,
  type SimulationResult,
  type SimulationWarning,
  type WarningSeverity,
} from '../simulate.js'
export { decodeInstruction, type DecodedInstruction } from '../decode.js'

export interface GetSimulationOptions extends SimulateOptions, ShortcutOptions {}

/** 模拟一笔交易，节点参数与 getBalances 相同 */
export function getSimulation(input: SimulateInput, options: GetSimulationOptions = {}): Promise<SimulationResult> {
  const { client, own } = resolve(options, ['owner', 'signers', 'watch', 'step', 'prices', 'risk', 'fetch', 'signal'])
  return simulate(client, input, own)
}
