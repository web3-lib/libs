/**
 * Flap 分红（子路径 `@w3lib/evm-batch-call/dividends`）：查持有人在 Flap（flap.sh，BNB Chain 发币平台）税收代币上累计的分红
 * （可领取 / 已领取、分红资产、美元价值），批量领取（可用 7702 / 4337 / 5792 合成一笔原子交易）。
 * 不放在主入口，不用时打包不会带上这部分代码；发送和模拟的代码按需加载。只支持 BSC，合约形态和核实范围见 README「Flap 分红」。
 *
 * ```ts
 * import { getDividends, claimDividends } from '@w3lib/evm-batch-call/dividends'
 *
 * const { items } = await getDividends(user, { chainId: 56, discover: true })   // 或 tokens: [flapToken]
 * await claimDividends(provider, key, items, { mode: '7702', simulate: true })
 * ```
 */
import { dividends, type DividendsOptions, type DividendsResult } from '../dividends.js'
import { resolve, type ShortcutProviderOptions } from '../shortcuts.js'

export {
  FLAP_DIVIDEND_CHAINS,
  FLAP_TOKEN_SUFFIXES,
  buildClaimDividends,
  claimDividends,
  dividends,
  scanDividendTokens,
  type ClaimDividendResult,
  type ClaimDividendTx,
  type ClaimDividendsOptions,
  type DividendItem,
  type DividendScanOptions,
  type DividendUnsupported,
  type DividendsOptions,
  type DividendsResult,
} from '../dividends.js'

export interface GetDividendsOptions extends DividendsOptions, ShortcutProviderOptions {}

/**
 * 查持有人在 Flap 代币上的分红，节点参数与 getBalances 相同（chainId 只能是 56）。
 * tokens 给定要查的代币；discover 从收到过的 Transfer 事件里发现（卖光的代币上之前累计的分红也能领）。
 *
 * ```ts
 * const { items, unsupported } = await getDividends(user, { chainId: 56, tokens: [flapToken] })
 * // [{ token, symbol, balance, claimable: '88823258714382840', asset: '0x9b8E…', assetSymbol: 'FXIon', usd: null, dividendContract, … }]
 * ```
 */
export function getDividends(owner: string, options: GetDividendsOptions = {}): Promise<DividendsResult> {
  const { provider, own } = resolve(options, ['tokens', 'discover', 'prices', 'fetch', 'includeZero'])
  return dividends(provider, owner, own as DividendsOptions)
}
