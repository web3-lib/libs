/**
 * 代币风险检查（子路径 `@w3lib/sui-batch-call/risk`）：监管币（发行方能否冻结地址、全局暂停）、TreasuryCap 在谁手里（能否增发）、
 * 元数据能否修改，可选用 /swap 模拟买入再卖出（能不能卖）。不放在主入口，不用时打包不会带上这部分代码；兑换的代码按需加载。
 *
 * ```ts
 * import { getCoinRisks } from '@w3lib/sui-batch-call/risk'
 *
 * const [risk] = await getCoinRisks([coinType])
 * if (risk.honeypot) alert('卖不出')
 * ```
 */
import { coinRisks, type CoinRisk, type CoinRiskOptions } from '../risk.js'
import { clientFor, type ShortcutOptions } from '../shortcuts.js'

export { coinRisks, type CapHolder, type CoinRisk, type CoinRiskOptions, type SellCheck, type SupplyState } from '../risk.js'

export interface GetCoinRisksOptions extends CoinRiskOptions, ShortcutOptions {}

/** 检查代币的风险，节点参数同其他快捷函数（provider、network…） */
export function getCoinRisks(coinTypes: readonly string[], options: GetCoinRisksOptions = {}): Promise<CoinRisk[]> {
  const { provider, network, timeout, headers, fetch, retries, concurrency, ...rest } = options
  return coinRisks(clientFor({ provider, network, timeout, headers, fetch, retries, concurrency }), coinTypes, rest)
}
