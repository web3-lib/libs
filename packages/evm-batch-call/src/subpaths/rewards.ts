/**
 * 一键领取手续费和挖矿奖励（子路径 `@w3lib/evm-batch-call/rewards`）：V3 / V4 仓位（含 Tron 的 SunSwap V3）未领取的手续费、
 * PancakeSwap V3 MasterChef 的 CAKE（和质押仓位的手续费）、Aerodrome / Velodrome Slipstream gauge 的奖励。
 * 不放在主入口，不用时打包不会带上这部分代码。
 *
 * - getClaimable：只读，列出每个仓位能领什么（数量 + 美元价值）
 * - buildClaimAll：合并成尽量少的交易（V3 multicall、V4 一次 modifyLiquidities、MasterChef multicall），先模拟、剔除会失败的项
 * - claimAll：构建后签名发送；`mode: '7702' | '4337' | '5792'` 时合成一笔原子交易
 *
 * ```ts
 * import { claimAll, getClaimable } from '@w3lib/evm-batch-call/rewards'
 *
 * const c = await getClaimable(user, { chainId: 56, prices: true })   // c.items、c.totals、c.usd
 * const { status, claimed } = await claimAll(multi, privateKey, { minUsd: 1 })
 * ```
 */
import { resolve, type ShortcutProviderOptions } from '../shortcuts.js'
import { claimable } from '../rewards/index.js'
import type { Claimable, ClaimableOptions } from '../rewards/types.js'

export { FARM_PROTOCOLS, buildClaimAll, claimAll, claimable } from '../rewards/index.js'
export type {
  ClaimAllOptions,
  ClaimAllSendOptions,
  ClaimAmount,
  ClaimItem,
  ClaimKind,
  ClaimPlan,
  ClaimResult,
  ClaimSkipped,
  ClaimTx,
  ClaimTxResult,
  Claimable,
  ClaimableOptions,
  FarmProtocol,
} from '../rewards/types.js'
export type { LpProtocol } from '../lp.js'
export type { SignerInput, WriteResult, WriteStatus } from '../subpaths/write.js'

export interface GetClaimableOptions extends ClaimableOptions, ShortcutProviderOptions {}

/** 查一个地址能领取的手续费和挖矿奖励，节点参数与 getBalances 相同 */
export function getClaimable(owner: string, options: GetClaimableOptions = {}): Promise<Claimable> {
  const { provider, overrides, own } = resolve(options, ['protocols', 'fees', 'rewards', 'v4', 'farms', 'gauges', 'maxPositions', 'prices', 'onPriceError', 'fetch'])
  return claimable(provider, owner, { ...overrides, ...own })
}
