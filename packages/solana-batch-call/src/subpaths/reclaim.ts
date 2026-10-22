/**
 * 账户回收（子路径 `@w3lib/solana-batch-call/reclaim`）：扫描钱包里关闭后能退回租金（SOL）的账户并批量关闭：空的代币账户、垃圾币（销毁后关闭）、
 * Wrapped SOL（解包）、已清空的 Orca Whirlpool / Raydium CLMM 仓位。给出每项和合计能拿回多少 lamports，发送前用 /simulate 模拟。
 * 不放在主入口，不用时打包不会带上这部分代码；发送的代码按需加载。
 *
 * ```ts
 * import { getReclaimable, reclaim } from '@w3lib/solana-batch-call/reclaim'
 *
 * const r = await getReclaimable(owner, { provider: 'https://my-rpc…' })
 * r.totalLamports                                          // 全部能拿回的 lamports
 * const { simulation, results } = await reclaim(client, key, r.items.filter((i) => i.selected))
 * ```
 */
import { reclaimable, type Reclaimable, type ReclaimQuery } from '../reclaim.js'
import { resolve, type ShortcutOptions } from '../shortcuts.js'

export {
  buildReclaim,
  reclaim,
  reclaimable,
  simulateReclaim,
  type BuildReclaimOptions,
  type JunkContext,
  type ReclaimBlocker,
  type ReclaimCall,
  type ReclaimCallResult,
  type ReclaimItem,
  type ReclaimKind,
  type ReclaimOptions,
  type ReclaimPlan,
  type ReclaimQuery,
  type ReclaimResult,
  type ReclaimSimulation,
  type ReclaimSimulationOptions,
  type Reclaimable,
} from '../reclaim.js'
export type { PlanSimulation } from '../batchPlan.js'
export { burnChecked, closeAccount, harvestWithheldTokensToMint } from '../write/instructions.js'

export interface GetReclaimableOptions extends ReclaimQuery, ShortcutOptions {}

/**
 * 扫描钱包里能回收租金的账户，节点参数与 getBalances 相同。默认列出全部代币账户（需要支持 getTokenAccountsByOwner 的节点），
 * 免费公共节点传 `mints` 只看指定代币的 ATA。
 *
 * ```ts
 * const r = await getReclaimable(owner, { provider: 'https://my-rpc…' })
 * // { totalLamports: '45862080', selectedLamports: '41302080',
 * //   items: [{ kind: 'empty-token', account, mint, lamports: '2039280', selected: true, reasons: ['empty'] },
 * //           { kind: 'junk-token', symbol: 'claim-rewards.xyz', lamports: '2039280', selected: true, reasons: ['no-price', 'spam-name'] }, …],
 * //   blocked: [{ kind: 'empty-token', blocker: 'frozen', … }] }
 * ```
 */
export function getReclaimable(owner: string, options: GetReclaimableOptions = {}): Promise<Reclaimable> {
  const { client, own } = resolve(options, ['mints', 'junk', 'positions', 'prices', 'maxJunkUsd', 'risk', 'isJunk', 'signal'])
  return reclaimable(client, owner, { ...own, ...(options.fetch ? { fetch: options.fetch } : {}) })
}
