/**
 * 地址的交易历史（子路径 `@w3lib/sui-batch-call/history`）：整理成 Activity（转账 / 兑换 / 流动性 / 铸造 / 失败），游标翻页。
 * 数据源：GraphQL（完整历史，默认）+ 节点的 gRPC ListTransactions（最近一段时间，备用），也可以传自己的数据源。
 * 不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getHistory } from '@w3lib/sui-batch-call/history'
 *
 * const page = await getHistory(address, { limit: 20 })
 * const older = await getHistory(address, { cursor: page.nextCursor })
 * ```
 */
import { getHistoryOf, type HistoryOptions, type HistoryResult } from '../history.js'
import { clientFor, type ShortcutOptions } from '../shortcuts.js'

export { getHistoryOf } from '../history.js'
export type { Activity, ActivityChange, ActivityType, HistoryOptions, HistoryResult } from '../history.js'
export { DEFAULT_GRAPHQL_URLS, graphqlHistory, grpcHistory, type GraphqlHistoryOptions, type HistoryAdapter, type HistoryPage, type HistoryQuery } from '../historyAdapters.js'

export interface GetHistoryOptions extends HistoryOptions, ShortcutOptions {}

/** 查地址的交易历史（新的在前），节点参数同其他快捷函数（provider、network…） */
export function getHistory(address: string, options: GetHistoryOptions = {}): Promise<HistoryResult> {
  const { provider, network, timeout, headers, fetch, retries, concurrency, ...rest } = options
  return getHistoryOf(clientFor({ provider, network, timeout, headers, fetch, retries, concurrency }), address, rest)
}
