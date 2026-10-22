/**
 * 模拟（子路径 `@w3lib/ton-batch-call/simulate`）：用 toncenter 的 emulateTrace 模拟整条交易链（不检查签名、不发送），
 * 返回成功与否和可读的错误、每个地址的 TON / Jetton 余额变化、手续费明细、消息体解码（Jetton / NFT 转账、STON.fi / DeDust 的兑换和流动性、
 * 钱包 v4r2 / v5r1 的外部消息）和警告。不放在主入口，不用时打包不会带上这部分代码；风险检查、美元价值按需加载。
 *
 * ```ts
 * import { buildSwap } from '@w3lib/ton-batch-call/swap'
 * import { getSimulation } from '@w3lib/ton-batch-call/simulate'
 *
 * const plan = await buildSwap(ton, owner, { tokenIn: NATIVE_TON, tokenOut: USDT, amountInFormatted: '1' })
 * const sim = await getSimulation({ from: owner, messages: plan.messages })
 * if (!sim.success) throw new Error(sim.error)
 * ```
 */
import { split, type ShortcutOptions } from '../shortcuts.js'
import { simulateTransaction, type SimulateInput, type SimulateOptions, type SimulationResult } from '../simulate.js'

export {
  simulateTransaction,
  type BalanceChange,
  type SimulateInput,
  type SimulateOptions,
  type SimulationFailure,
  type SimulationFees,
  type SimulationResult,
  type SimulationWarning,
} from '../simulate.js'
export { decodeExternalMessage, decodeMessage, describeExitCode, parseInternalMessage, type DecodedExternal, type DecodedMessage, type DecodedType, type ExitContext, type ParsedInternalMessage } from '../decode.js'
export type { CallMessage } from '../write/batch.js'

export interface GetSimulationOptions extends SimulateOptions, ShortcutOptions {}

/** 模拟一笔交易（同 simulateTransaction），节点参数同其他快捷函数 */
export function getSimulation(input: SimulateInput, options: GetSimulationOptions = {}): Promise<SimulationResult> {
  const [client, rest] = split(options)
  return simulateTransaction(client, input, rest as SimulateOptions)
}
