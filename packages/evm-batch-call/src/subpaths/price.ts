/**
 * 价格（子路径 `@w3lib/evm-batch-call/price`）：代币的美元价格（DefiLlama 当前 / 历史价格，没有收录的从链上 V2 / V3 池子算）、
 * 组合价格源、地址的资产总值。不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getTokenPrices, getPortfolio } from '@w3lib/evm-batch-call/price'
 *
 * await getTokenPrices([NATIVE_TOKEN, USDT, newToken], { chainId: 56 })
 * await getPortfolio(user, { chainId: 56, tokens: [NATIVE_TOKEN, USDT], lp: true })
 * ```
 */
import { portfolio, type Portfolio, type PortfolioOptions } from '../portfolio.js'
import { tokenPrices, type TokenPrice, type TokenPricesOptions } from '../price.js'
import { resolve, type ShortcutProviderOptions } from '../shortcuts.js'

export { portfolio, type Portfolio, type PortfolioOptions, type PortfolioToken } from '../portfolio.js'
export {
  DEFILLAMA_CHAINS,
  STABLECOINS,
  combinePrices,
  defillamaPrices,
  onchainPrices,
  priceKeyOf,
  tokenPrices,
  type DefillamaPriceOptions,
  type OnchainPriceOptions,
  type PriceSource,
  type PriceSourceContext,
  type TokenPrice,
  type TokenPricesOptions,
} from '../price.js'

export interface GetTokenPricesOptions extends TokenPricesOptions, ShortcutProviderOptions {}

/**
 * 查代币的美元价格（主币用 NATIVE_TOKEN），节点参数与 getBalances 相同。
 *
 * ```ts
 * await getTokenPrices([NATIVE_TOKEN, USDT], { chainId: 56 })
 * // [{ token: '0xEeee…', native: true, price: 612.3, source: 'defillama' }, { token: USDT, …, price: 1, source: 'defillama' }]
 * ```
 */
export function getTokenPrices(tokens: readonly string[], options: GetTokenPricesOptions = {}): Promise<TokenPrice[]> {
  const { provider, own } = resolve(options, ['sources', 'onError', 'fetch'])
  return tokenPrices(provider, tokens, own)
}

export interface GetPortfolioOptions extends PortfolioOptions, ShortcutProviderOptions {}

/**
 * 地址的资产总值：传入代币的余额 × 价格，可选加上 LP 仓位（lp: true）。
 *
 * ```ts
 * const p = await getPortfolio(user, { chainId: 56, tokens: [NATIVE_TOKEN, USDT, CAKE], lp: true })
 * ```
 */
export function getPortfolio(owner: string, options: GetPortfolioOptions): Promise<Portfolio> {
  const { provider, overrides, own } = resolve(options, ['tokens', 'sources', 'lp', 'minUsd', 'onPriceError', 'fetch'])
  return portfolio(provider, owner, { ...(own as PortfolioOptions), ...(overrides.signal ? { signal: overrides.signal } : {}) })
}
