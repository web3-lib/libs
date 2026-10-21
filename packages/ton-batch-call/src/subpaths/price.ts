/**
 * 价格（子路径 `@w3lib/ton-batch-call/price`）：TON 和 Jetton 的美元价格（DefiLlama 当前 / 历史价格，没有收录的从链上
 * STON.fi / DeDust 池子算）、组合价格源、地址的资产总值。不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getPortfolio, getTokenPrices } from '@w3lib/ton-batch-call/price'
 *
 * await getTokenPrices([NATIVE_TON, USDT, newJetton])
 * await getPortfolio(owner, { lp: true })
 * ```
 */
import { portfolio, type PortfolioOptions, type TonPortfolio } from '../portfolio.js'
import { tokenPrices, type TokenPricesOptions, type TonTokenPrice } from '../price.js'
import { split, type ShortcutOptions } from '../shortcuts.js'

export { portfolio, type PortfolioOptions, type TonPortfolio, type TonPortfolioToken } from '../portfolio.js'
export {
  STABLECOINS,
  TON_USDT,
  combinePrices,
  defillamaPrices,
  onchainPrices,
  priceKeyOf,
  resetPriceCache,
  tokenPrices,
  type DefillamaPriceOptions,
  type OnchainPriceOptions,
  type TokenPricesOptions,
  type TonPriceSource,
  type TonPriceSourceContext,
  type TonTokenPrice,
} from '../price.js'

export interface GetTokenPricesOptions extends TokenPricesOptions, ShortcutOptions {}

/**
 * 查代币的美元价格（TON 用 NATIVE_TON），节点参数同其他快捷函数；fetch 同时用于 toncenter 和 DefiLlama。
 *
 * ```ts
 * await getTokenPrices([NATIVE_TON, USDT])
 * // [{ token: 'TON', native: true, price: 1.34, source: 'defillama' }, { token: USDT, native: false, price: 1, source: 'defillama' }]
 * ```
 */
export function getTokenPrices(tokens: readonly string[], options: GetTokenPricesOptions = {}): Promise<TonTokenPrice[]> {
  const [client, rest] = split(options)
  return tokenPrices(client, tokens, { ...(rest as TokenPricesOptions), fetch: options.fetch })
}

export interface GetPortfolioOptions extends PortfolioOptions, ShortcutOptions {}

/**
 * 地址的资产总值：TON 和持有的全部 Jetton 的余额 × 价格，可选加上 LP 仓位（lp: true）。
 *
 * ```ts
 * const p = await getPortfolio(owner, { lp: true, minUsd: 1 })
 * ```
 */
export function getPortfolio(owner: string, options: GetPortfolioOptions = {}): Promise<TonPortfolio> {
  const [client, rest] = split(options)
  return portfolio(client, owner, { ...(rest as PortfolioOptions), fetch: options.fetch })
}
