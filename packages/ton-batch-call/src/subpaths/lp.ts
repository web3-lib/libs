/**
 * LP 仓位（子路径 `@w3lib/ton-batch-call/lp`）：STON.fi v1 / v2、DeDust 的 LP Jetton，按份额算出撤出能拿到的数量，可选美元价值。
 *
 * ```ts
 * import { getLpPositions } from '@w3lib/ton-batch-call/lp'
 * await getLpPositions(owner, { prices: true })
 * ```
 */
import { lpPositions, type LpPositionsOptions, type TonLpPosition } from '../lp.js'
import { split, type ShortcutOptions } from '../shortcuts.js'

export {
  DEDUST_FACTORY,
  PTON_MASTERS,
  STONFI_V1_ROUTER,
  TON_LP_PROTOCOLS,
  defillamaPrices,
  lpPositions,
  type LpPositionsOptions,
  type TonLpPosition,
  type TonLpProtocol,
  type TonLpToken,
  type TonPriceSource,
} from '../lp.js'
export { GetMethodError, Stack, runGetMethod, type StackArg } from '../getters.js'

export interface GetLpPositionsOptions extends LpPositionsOptions, ShortcutOptions {}

/** lpPositions 的快捷函数（节点参数同其他快捷函数） */
export function getLpPositions(owner: string, options: GetLpPositionsOptions = {}): Promise<TonLpPosition[]> {
  const [client, rest] = split(options)
  return lpPositions(client, owner, { ...(rest as LpPositionsOptions), fetch: options.fetch })
}
