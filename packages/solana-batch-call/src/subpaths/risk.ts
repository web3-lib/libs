/**
 * 代币风险检查（子路径 `@w3lib/solana-batch-call/risk`）：mint 的增发 / 冻结权限，Token-2022 扩展里影响持有人的设置
 * （转账手续费、永久授权、转账 hook、不可转让、默认冻结、可暂停、保密转账、mint 可关闭等），可选持币集中度；
 * tradeChecks 在主网模拟“买入 → 卖出”判断能不能卖（用 /swap，不用时打包不会带上）。不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getTokenRisks, getTradeChecks } from '@w3lib/solana-batch-call/risk'
 *
 * const [risk] = await getTokenRisks([mint])
 * if (risk.flags.includes('permanent-delegate')) alert('发行方可以转走你的代币')
 * const [trade] = await getTradeChecks([mint], { owner: myAddress })
 * if (trade.honeypot) alert('卖不出')
 * ```
 */
import { tokenRisks, type SolanaTokenRisk, type TokenRisksOptions } from '../risk.js'
import { resolve, type ShortcutOptions } from '../shortcuts.js'
import { tradeChecks, type SolanaTradeCheck, type TradeCheckOptions } from '../tradeCheck.js'

export { parseRisk, tokenRisks, type SolanaTokenRisk, type TokenRisksOptions } from '../risk.js'
export { tradeChecks, type SolanaTradeCheck, type TradeCheckOptions, type TradeStage } from '../tradeCheck.js'

export interface GetTokenRisksOptions extends TokenRisksOptions, ShortcutOptions {}

/** 检查代币的风险（一次 getMultipleAccounts），节点参数与 getBalances 相同 */
export function getTokenRisks(mints: readonly string[], options: GetTokenRisksOptions = {}): Promise<SolanaTokenRisk[]> {
  const { client, own } = resolve(options, ['concentration', 'signal'])
  return tokenRisks(client, mints, own)
}

export interface GetTradeChecksOptions extends TradeCheckOptions, ShortcutOptions {}

/** 模拟买入再卖出，判断能不能交易，节点参数与 getBalances 相同 */
export function getTradeChecks(mints: readonly string[], options: GetTradeChecksOptions): Promise<SolanaTradeCheck[]> {
  const { client, own } = resolve(options, ['owner', 'amount', 'amountFormatted', 'protocols', 'intermediates', 'pools', 'discover', 'signal'])
  return tradeChecks(client, mints, own as TradeCheckOptions)
}
