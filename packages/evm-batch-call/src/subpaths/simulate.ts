/**
 * 交易模拟（子路径 `@w3lib/evm-batch-call/simulate`）：发送前先看一笔（或一串依赖的）交易会发生什么——成不成功、gas、
 * 哪些资产进出（含美元价值）、给了什么授权、calldata 解码、风险提示。可以直接传 `buildSwap` / `buildRevokes` / 流动性构建的交易。
 * 不放在主入口，不用时打包不会带上这部分代码。EVM 用 `eth_simulateV1`（不支持时退回 `eth_call`），Tron 用 `triggerconstantcontract`。
 *
 * ```ts
 * import { getSimulation, getBatchSimulation } from '@w3lib/evm-batch-call/simulate'
 *
 * const sim = await getSimulation({ to: router, data, value }, { chainId: 1, from: user, usd: true })
 * if (sim.warnings.some((w) => w.severity === 'danger')) alert(sim.warnings[0].message)
 * const flow = await getBatchSimulation(plan.transactions, { chainId: 1, from: user }) // approve + swap，状态延续
 * ```
 */
import { simulate, simulateBatch, type BatchSimulationResult, type SimulateOptions, type SimulateTx, type SimulationResult } from '../simulate.js'
import { resolve, type ShortcutProviderOptions } from '../shortcuts.js'

export {
  assertSimulation,
  decodeCalldata,
  decodeRevert,
  simulate,
  simulateBatch,
  type ApprovalChange,
  type BalanceChange,
  type BatchSimulationResult,
  type DecodedCall,
  type DecodedType,
  type SimulatedTransfer,
  type SimulateOptions,
  type SimulateTx,
  type SimulationResult,
  type SimulationWarning,
  type StateOverrides,
  type WarningSeverity,
} from '../simulate.js'

const OWN = ['from', 'watch', 'stateOverrides', 'gas', 'fee', 'usd', 'risk', 'forceCall'] as const

export interface GetSimulationOptions extends SimulateOptions, ShortcutProviderOptions {}

/** 模拟一笔交易，节点参数与 getBalances 相同 */
export function getSimulation(tx: SimulateTx, options: GetSimulationOptions = {}): Promise<SimulationResult> {
  const { provider, overrides, own } = resolve(options, OWN)
  return simulate(provider, tx, { ...own, ...(overrides.blockTag === undefined ? {} : { blockTag: overrides.blockTag }) })
}

/** 按顺序模拟一串依赖前一笔的交易（也可以直接传 buildSwap 等的结果），节点参数与 getBalances 相同 */
export function getBatchSimulation(txs: readonly SimulateTx[] | { transactions: readonly SimulateTx[] }, options: GetSimulationOptions = {}): Promise<BatchSimulationResult> {
  const { provider, overrides, own } = resolve(options, OWN)
  return simulateBatch(provider, txs, { ...own, ...(overrides.blockTag === undefined ? {} : { blockTag: overrides.blockTag }) })
}
