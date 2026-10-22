/**
 * 交易历史（子路径 `@w3lib/ton-batch-call/history`）：一个地址的活动（兑换、转账、流动性、增发、失败），统一成 Activity。
 * 默认用 toncenter v3 的 `/actions`（索引器已分类），出错退回 `/transactions` + `/jetton/transfers`；应用有自己的数据源时传 `adapters`。
 * 不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getHistory } from '@w3lib/ton-batch-call/history'
 *
 * const page = await getHistory(owner, { limit: 20 })
 * const more = await getHistory(owner, { cursor: page.nextCursor })
 * const swaps = await getHistory(owner, { types: ['swap'] })
 * ```
 */
import { split, type ShortcutOptions } from '../shortcuts.js'
import { history, type HistoryOptions, type HistoryPage } from '../history.js'

export {
  history,
  toncenterActions,
  toncenterTransactions,
  type Activity,
  type ActivityChange,
  type ActivityType,
  type HistoryAdapter,
  type HistoryOptions,
  type HistoryPage,
  type HistoryQuery,
} from '../history.js'

export interface GetHistoryOptions extends HistoryOptions, ShortcutOptions {}

/** 一个地址的历史（同 history），节点参数同其他快捷函数 */
export function getHistory(address: string, options: GetHistoryOptions = {}): Promise<HistoryPage> {
  const [client, rest] = split(options)
  return history(client, address, rest as HistoryOptions)
}
