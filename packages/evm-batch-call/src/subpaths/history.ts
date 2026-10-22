/**
 * 交易历史（子路径 `@w3lib/evm-batch-call/history`）：一个地址的转账 / 兑换 / 授权 / 流动性 / 铸造记录，带解码后的类型、资产变化和手续费。
 * 数据来源可替换、可故障切换：Blockscout（免 Key，默认）、Etherscan v2（传 apiKey）、纯 RPC 日志、Tron 的 TronGrid。
 * 不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getHistory } from '@w3lib/evm-batch-call/history'
 *
 * const page = await getHistory(user, { chainId: 1, limit: 20 })
 * const more = await getHistory(user, { chainId: 1, cursor: page.nextCursor, types: ['swap'] })
 * await getHistory(user, { chainId: 56, source: ['etherscan', 'rpc'], apiKey })
 * ```
 */
import { history, type HistoryOptions, type HistoryResult } from '../history.js'
import { resolve, type ShortcutProviderOptions } from '../shortcuts.js'

export {
  HistorySourceError,
  buildActivities,
  history,
  type Activity,
  type ActivityChange,
  type ActivityType,
  type HistoryAdapter,
  type HistoryOptions,
  type HistoryQuery,
  type HistoryResult,
  type HistorySource,
  type RawMove,
  type RawPage,
  type RawTx,
} from '../history.js'
export { BLOCKSCOUT_APIS, blockscoutSource, etherscanSource, explorerSource, rpcSource, trongridSource, type RpcSourceOptions, type TrongridSourceOptions } from '../historySources.js'

export interface GetHistoryOptions extends HistoryOptions, ShortcutProviderOptions {}

/** 查一个地址的历史活动，节点参数与 getBalances 相同（只有 rpc 来源会用到节点） */
export function getHistory(address: string, options: GetHistoryOptions = {}): Promise<HistoryResult> {
  const { provider, own } = resolve(options, ['source', 'apiKey', 'limit', 'cursor', 'types', 'before', 'after', 'nft', 'maxPages', 'fetch'])
  return history(provider, address, own)
}
