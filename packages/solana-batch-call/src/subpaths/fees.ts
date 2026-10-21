/**
 * 手续费估算（子路径 `@w3lib/solana-batch-call/fees`）：三档优先费建议，一笔交易的花费（基础费 + 优先费 + 新建账户的押金）。
 * 不放在主入口，不用时打包不会带上这部分代码；模拟交易的代码按需加载。
 *
 * ```ts
 * import { getCostEstimate, getFeeEstimate } from '@w3lib/solana-batch-call/fees'
 *
 * await getFeeEstimate({ accounts: [pool] })
 * await getCostEstimate({ feePayer: owner, instructions })
 * ```
 */
import { estimateCost, estimateFees, type CostEstimate, type CostInput, type EstimateCostOptions, type EstimateFeesOptions, type PriorityFeeEstimate } from '../fees.js'
import { resolve, type ShortcutOptions } from '../shortcuts.js'

export {
  estimateCost,
  estimateFees,
  type CostEstimate,
  type CostInput,
  type CreatedAccount,
  type EstimateCostOptions,
  type EstimateFeesOptions,
  type FeeLevel,
  type PriorityFeeEstimate,
} from '../fees.js'

export interface GetFeeEstimateOptions extends EstimateFeesOptions, ShortcutOptions {}

/** 当前的三档优先费建议（micro-lamports / 计算单元），节点参数与 getBalances 相同 */
export function getFeeEstimate(options: GetFeeEstimateOptions = {}): Promise<PriorityFeeEstimate> {
  const { client, own } = resolve(options, ['accounts', 'percentiles', 'signal'])
  return estimateFees(client, own)
}

export interface GetCostEstimateOptions extends EstimateCostOptions, ShortcutOptions {}

/** 一笔交易的花费（基础费 + 优先费 + 新建账户的押金），模拟一次、不发送 */
export function getCostEstimate(input: CostInput, options: GetCostEstimateOptions = {}): Promise<CostEstimate> {
  const { client, own } = resolve(options, ['percentiles', 'level', 'priorityFee', 'fees', 'signal'])
  return estimateCost(client, input, own)
}
