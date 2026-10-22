/**
 * 批量领取（子路径 `@w3lib/solana-batch-call/claim`）：Orca Whirlpool、Raydium CLMM 仓位的未领取手续费和挖矿奖励（农场奖励）。
 * 先只读预览（每个仓位能领多少、美元价值），再把全部（或选中的）仓位的领取指令打包成交易，发送前用 /simulate 模拟。
 * 不放在主入口，不用时打包不会带上这部分代码；指令来自 /liquidity 的 collectFees。
 *
 * ```ts
 * import { claimAll, getClaimable } from '@w3lib/solana-batch-call/claim'
 *
 * const c = await getClaimable(owner, { provider: 'https://my-rpc…' })     // 预览，不发交易
 * c.totalUsd                                                               // 全部能领的美元价值
 * await claimAll(client, key, c.positions)                                  // 批量领取
 * ```
 */
import { claimable, type Claimable, type ClaimQuery } from '../claim.js'
import { resolve, type ShortcutOptions } from '../shortcuts.js'

export {
  buildClaimAll,
  claimAll,
  claimable,
  simulateClaim,
  type BuildClaimOptions,
  type ClaimCall,
  type ClaimCallResult,
  type ClaimOptions,
  type ClaimPlan,
  type ClaimProtocol,
  type ClaimQuery,
  type ClaimResult,
  type ClaimSimulation,
  type ClaimTarget,
  type Claimable,
  type ClaimableAmount,
  type ClaimablePosition,
} from '../claim.js'
export type { PlanSimulation } from '../batchPlan.js'

export interface GetClaimableOptions extends ClaimQuery, ShortcutOptions {}

/**
 * 预览一个地址能领取的手续费和挖矿奖励（只读取），节点参数与 getBalances 相同。默认列出全部代币账户（需要支持 getTokenAccountsByOwner 的节点），
 * 免费公共节点传 `mints`（仓位 NFT 的 mint）只看指定仓位。
 *
 * ```ts
 * const c = await getClaimable(owner, { provider: 'https://my-rpc…' })
 * // { totalUsd: 345.6, tokens: [{ symbol: 'SOL', formatted: '1.627', usd: 290 }, { symbol: 'RAY', formatted: '0.0427', usd: 0.08 }, …],
 * //   positions: [{ protocol: 'raydium-clmm', positionMint, fees: [{ symbol: 'SOL', … }, { symbol: 'USDC', … }], rewards: [{ index: 0, symbol: 'RAY', … }], totalUsd: 345.6 }] }
 * ```
 */
export function getClaimable(owner: string, options: GetClaimableOptions = {}): Promise<Claimable> {
  const { client, own } = resolve(options, ['mints', 'protocols', 'prices', 'now', 'signal'])
  return claimable(client, owner, { ...own, ...(options.fetch ? { fetch: options.fetch } : {}) })
}
