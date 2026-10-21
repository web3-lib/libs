/**
 * Jetton 风险检查（子路径 `@w3lib/ton-batch-call/risk`）：admin（能不能增发、有没有放弃）、mintable、索引器的诈骗标记、
 * Jetton 钱包代码是不是认识的代码，可选模拟买入 / 卖出（貔貅盘、转账税）。不放在主入口，不用时打包不会带上这部分代码；
 * 模拟用的 `/swap` 代码按需加载。
 *
 * ```ts
 * import { getTokenRisks } from '@w3lib/ton-batch-call/risk'
 *
 * const [risk] = await getTokenRisks([jetton], { simulate: true })
 * if (risk.flags.includes('honeypot')) alert('卖不出')
 * ```
 */
import { split, type ShortcutOptions } from '../shortcuts.js'
import { tokenRisks, type TokenRiskOptions, type TonTokenRisk } from '../risk.js'

export { GOVERNED_JETTON_WALLET_CODES, KNOWN_JETTON_WALLET_CODES, codeHashOf, tokenRisks, type TokenRiskOptions, type TonTokenRisk, type TonTradeCheck, type TradeStage } from '../risk.js'

export interface GetTokenRisksOptions extends TokenRiskOptions, ShortcutOptions {}

/** 检查 Jetton 的风险，节点参数同其他快捷函数 */
export function getTokenRisks(tokens: readonly string[], options: GetTokenRisksOptions = {}): Promise<TonTokenRisk[]> {
  const [client, rest] = split(options)
  return tokenRisks(client, tokens, rest as TokenRiskOptions)
}
