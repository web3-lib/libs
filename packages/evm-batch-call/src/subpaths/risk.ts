/**
 * 代币风险检查（子路径 `@w3lib/evm-batch-call/risk`）：模拟买入 / 转账 / 卖出，算出买卖税、判断貔貅盘，看是不是可升级代理、owner 有没有放弃。
 * 不放在主入口，不用时打包不会带上这部分代码（含约 2.7KB 的探测合约字节码）。
 *
 * ```ts
 * import { getTokenRisks } from '@w3lib/evm-batch-call/risk'
 *
 * const [risk] = await getTokenRisks([token], { chainId: 56 })
 * if (risk.honeypot) alert('卖不出')
 * ```
 */
import { tokenRisks, type TokenRisk, type TokenRiskOptions } from '../risk.js'
import { resolve, type ShortcutProviderOptions } from '../shortcuts.js'

export { tokenRisks, type ProbeStage, type TokenRisk, type TokenRiskOptions } from '../risk.js'

export interface GetTokenRisksOptions extends TokenRiskOptions, ShortcutProviderOptions {}

/** 检查代币的风险，节点参数与 getBalances 相同 */
export function getTokenRisks(tokens: readonly string[], options: GetTokenRisksOptions = {}): Promise<TokenRisk[]> {
  const { provider, own } = resolve(options, ['amount', 'protocols'])
  return tokenRisks(provider, tokens, own)
}
