/**
 * 交易历史（子路径 `@w3lib/solana-batch-call/history`）：地址的交易整理成统一的 Activity（兑换、转账、授权、流动性、铸造、失败……），
 * 数据源可换（默认节点：getSignaturesForAddress + getTransaction；可选 Helius 增强历史）。不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getHistory, heliusHistory } from '@w3lib/solana-batch-call/history'
 *
 * const page = await getHistory(address, { limit: 20 })
 * const next = await getHistory(address, { cursor: page.nextCursor, types: ['swap'] })
 * await getHistory(address, { source: [heliusHistory({ apiKey }), rpcHistory()] })   // 依次尝试
 * ```
 */
import { history, type HistoryOptions, type HistoryPage } from '../history.js'
import { resolve, type ShortcutOptions } from '../shortcuts.js'

export {
  MAX_HISTORY_LIMIT,
  activityFromTransaction,
  history,
  rpcHistory,
  type Activity,
  type ActivityChange,
  type ActivityType,
  type HistoryContext,
  type HistoryOptions,
  type HistoryPage,
  type HistorySource,
  type RpcHistoryOptions,
} from '../history.js'
export { activityFromHelius, heliusHistory, type HeliusHistoryOptions } from '../historyHelius.js'

export interface GetHistoryOptions extends HistoryOptions, ShortcutOptions {}

/** 查地址的交易历史，节点参数与 getBalances 相同 */
export function getHistory(address: string, options: GetHistoryOptions = {}): Promise<HistoryPage> {
  const { client, own } = resolve(options, ['limit', 'cursor', 'before', 'after', 'types', 'source', 'symbols', 'fetch', 'signal'])
  return history(client, address, own)
}
