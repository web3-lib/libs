/**
 * 手续费估算（子路径 `@w3lib/sui-batch-call/fees`）：当前的参考 gas 价格，一笔交易的手续费（模拟执行）。
 * 不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getCostEstimate, getFeeEstimate } from '@w3lib/sui-batch-call/fees'
 *
 * await getFeeEstimate()
 * await getCostEstimate({ from: owner, kind })
 * ```
 */
import { estimateCost, estimateFees, type CostCall, type CostEstimate, type EstimateCostOptions, type FeeEstimate } from '../fees.js'
import { clientFor, type ShortcutOptions } from '../shortcuts.js'

export { estimateCost, estimateFees, type CostCall, type CostEstimate, type EstimateCostOptions, type FeeEstimate } from '../fees.js'

export interface GetFeeEstimateOptions extends ShortcutOptions {
  signal?: AbortSignal
}

/**
 * 当前 epoch 的参考 gas 价格，节点参数同其他快捷函数（provider、network…）。
 *
 * ```ts
 * await getFeeEstimate()   // { epoch: '1285', referenceGasPrice: '100' }
 * ```
 */
export function getFeeEstimate(options: GetFeeEstimateOptions = {}): Promise<FeeEstimate> {
  const { provider, network, timeout, headers, fetch, retries, concurrency, ...rest } = options
  return estimateFees(clientFor({ provider, network, timeout, headers, fetch, retries, concurrency }), rest)
}

export interface GetCostEstimateOptions extends EstimateCostOptions, ShortcutOptions {}

/**
 * 一笔交易的手续费（模拟执行，不发送）。
 *
 * ```ts
 * await getCostEstimate({ from: owner, kind })
 * // { gasPrice: '100', computationCost, storageCost, storageRebate, total, totalFormatted: '0.001088099', gasBudget, gasBudgetFormatted, symbol: 'SUI' }
 * ```
 */
export function getCostEstimate(call: CostCall, options: GetCostEstimateOptions = {}): Promise<CostEstimate> {
  const { provider, network, timeout, headers, fetch, retries, concurrency, ...rest } = options
  return estimateCost(clientFor({ provider, network, timeout, headers, fetch, retries, concurrency }), call, rest)
}
