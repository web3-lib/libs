/**
 * LP 仓位（子路径 `@w3lib/sui-batch-call/lp`）：Cetus、Bluefin、Momentum、Turbos、Magma、FlowX、Kriya 的集中流动性仓位（数量、未领取的手续费和奖励由合约在只读调用里算出），
 * Cetus DLMM 的仓位，DipCoin、FlowX V2、Kriya 的传统 AMM LP 和 Aftermath 的多币池 LP（按份额算数量），可选美元价值。
 *
 * ```ts
 * import { getLpPositions } from '@w3lib/sui-batch-call/lp'
 * await getLpPositions(owner, { prices: true })
 * ```
 */
import { lpPositions, type LpPositionsOptions, type SuiLpPosition } from '../lp.js'
import { clientFor, type ShortcutOptions } from '../shortcuts.js'

export {
  SUI_LP_PROTOCOLS,
  defillamaPrices,
  lpPositions,
  type LpPositionsOptions,
  type SuiAmmProtocol,
  type SuiClmmProtocol,
  type SuiDlmmProtocol,
  type SuiLpAmmPosition,
  type SuiLpClmmPosition,
  type SuiLpDlmmPosition,
  type SuiLpMultiCoin,
  type SuiLpMultiPosition,
  type SuiMultiProtocol,
  type SuiLpPosition,
  type SuiLpPositionBase,
  type SuiLpProtocol,
  type SuiLpProtocolInfo,
  type SuiLpReward,
  type SuiLpToken,
  type SuiPriceSource,
} from '../lp.js'
export { CETUS, CETUS_POSITION_TYPE } from '../cetus.js'
export { CETUS_DLMM, CETUS_DLMM_POSITION_TYPE } from '../dlmm.js'
export { AFTERMATH } from '../aftermath.js'

export interface GetLpPositionsOptions extends LpPositionsOptions, ShortcutOptions {}

/** lpPositions 的快捷函数：节点参数同其他快捷函数（provider、network…），fetch 同时用于节点请求和查价 */
export function getLpPositions(owner: string, options: GetLpPositionsOptions = {}): Promise<SuiLpPosition[]> {
  const { provider, network, timeout, headers, fetch, retries, concurrency, ...rest } = options
  return lpPositions(clientFor({ provider, network, timeout, headers, fetch, retries, concurrency }), owner, { ...rest, fetch })
}
