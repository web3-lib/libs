/**
 * 手续费估算（子路径 `@w3lib/evm-batch-call/fees`）：EIP-1559 的三档费用建议、一笔交易的手续费（含 L1 数据费），
 * Tron 按能量 / 带宽和账户剩余的资源算要烧的 TRX。不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getCostEstimate, getFeeEstimate } from '@w3lib/evm-batch-call/fees'
 *
 * await getFeeEstimate({ chainId: 1 })
 * await getCostEstimate({ from: user, to: USDT, data }, { chainId: 728126428 })
 * ```
 */
import { estimateCost, estimateFees, type CostCall, type CostEstimate, type EstimateCostOptions, type EstimateFeesOptions, type FeeEstimate } from '../fees.js'
import { resolve, type ShortcutProviderOptions } from '../shortcuts.js'

export {
  estimateCost,
  estimateFees,
  type CostCall,
  type CostEstimate,
  type EstimateCostOptions,
  type EstimateFeesOptions,
  type EvmCostEstimate,
  type FeeEstimate,
  type FeeLevel,
  type FeeLevelEstimate,
  type TronCost,
} from '../fees.js'

export interface GetFeeEstimateOptions extends EstimateFeesOptions, ShortcutProviderOptions {}

/** 当前的三档手续费建议（EVM 链），节点参数与 getBalances 相同 */
export function getFeeEstimate(options: GetFeeEstimateOptions = {}): Promise<FeeEstimate> {
  const { provider, own } = resolve(options, ['blocks', 'percentiles', 'baseFeeMultiplier'])
  return estimateFees(provider, own)
}

export interface GetCostEstimateOptions extends EstimateCostOptions, ShortcutProviderOptions {}

/** 一笔交易的手续费（EVM：gas × 价格 + L1 数据费；Tron：要烧的 TRX） */
export function getCostEstimate(call: CostCall, options: GetCostEstimateOptions = {}): Promise<CostEstimate> {
  const { provider, own } = resolve(options, ['blocks', 'percentiles', 'baseFeeMultiplier', 'level', 'fees'])
  return estimateCost(provider, call, own)
}
