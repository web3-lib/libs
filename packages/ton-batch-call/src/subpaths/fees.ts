/**
 * 手续费估算（子路径 `@w3lib/ton-batch-call/fees`）：模拟整条交易链（toncenter 的 emulateTrace），算出钱包付的手续费、
 * 附带和退回的 TON、整条链的手续费。不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getCostEstimate } from '@w3lib/ton-batch-call/fees'
 *
 * await getCostEstimate({ from: owner, messages: [{ to: jettonWallet, value: 50_000_000n, body }] })
 * ```
 */
import { estimateCost, estimateCosts, type EstimateCostOptions, type FeeCall, type TonCostEstimate } from '../fees.js'
import { split, type ShortcutOptions } from '../shortcuts.js'

export { estimateCost, estimateCosts, type EstimateCostOptions, type FeeCall, type TonCostEstimate, type TonFeeBreakdown } from '../fees.js'
export type { CallMessage } from '../write/batch.js'

export interface GetCostEstimateOptions extends EstimateCostOptions, ShortcutOptions {}

/**
 * 一笔交易的手续费，节点参数同其他快捷函数。`from` 可以是钱包地址（只读）。
 *
 * ```ts
 * await getCostEstimate({ from: owner, messages: [{ to: recipient, value: 10_000_000n, bounce: false }] })
 * // { fee: '403198', feeFormatted: '0.000403198', attached: '10000000', returned: '0', balanceChange: '-10403198', … }
 * ```
 */
export function getCostEstimate(call: FeeCall, options: GetCostEstimateOptions = {}): Promise<TonCostEstimate> {
  const [client, rest] = split(options)
  return estimateCost(client, call, rest)
}

/** 多笔交易的手续费（每个调用一笔，与 batchCall 相同） */
export function getCostEstimates(calls: readonly FeeCall[], options: GetCostEstimateOptions = {}): Promise<TonCostEstimate[]> {
  const [client, rest] = split(options)
  return estimateCosts(client, calls, rest)
}
