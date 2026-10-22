/**
 * 模拟交易（子路径 `@w3lib/sui-batch-call/simulate`）：不签名、不上链，看一笔交易会发生什么——余额变化、对象变化、gas、
 * 失败原因（Move abort 解码）、调用了哪个 DEX、风险提示。可以直接传本库构建器（buildSwap、buildAddLiquidity…）的结果。
 * 不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { simulate } from '@w3lib/sui-batch-call/simulate'
 *
 * const plan = await getSwapQuote(owner, { tokenIn: SUI_COIN_TYPE, tokenOut: USDC, amountInFormatted: '1' })
 * const sim = await simulate(plan, { sender: owner })
 * if (sim.success && !sim.warnings.length) await send(plan.kind)
 * ```
 */
import { clientFor, type ShortcutOptions } from '../shortcuts.js'
import { simulateTx, type SimulateInput, type SimulateOptions, type SimulationResult } from '../simulate.js'

export { simulateTx, type SimulateInput, type SimulateOptions, type SimulatedBalanceChange, type SimulationResult, type SimulationWarning, type WarningSeverity } from '../simulate.js'
export { decodeError, type CallInfo, type DecodedError, type ObjectChangeInfo } from '../analyze.js'

export interface SimulateShortcutOptions extends SimulateOptions, ShortcutOptions {}

/**
 * 模拟交易，节点参数同其他快捷函数（provider、network…）。
 * tx：完整的 TransactionData（字节 / base64，发送者在里面），或构建器的结果 / TransactionKind（要传 options.sender）
 */
export function simulate(tx: SimulateInput, options: SimulateShortcutOptions = {}): Promise<SimulationResult> {
  const { provider, network, timeout, headers, fetch, retries, concurrency, ...rest } = options
  return simulateTx(clientFor({ provider, network, timeout, headers, fetch, retries, concurrency }), tx, rest)
}
