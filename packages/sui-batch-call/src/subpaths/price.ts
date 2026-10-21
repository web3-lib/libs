/**
 * 价格（子路径 `@w3lib/sui-batch-call/price`）：代币的美元价格（DefiLlama 当前 / 历史价格，没有收录的从 Cetus、Turbos、FlowX 的池子算）、
 * 组合价格源、地址的资产总值。不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getTokenPrices, getPortfolio } from '@w3lib/sui-batch-call/price'
 *
 * await getTokenPrices([SUI_COIN_TYPE, USDC, newCoin])
 * await getPortfolio(owner, { lp: true })
 * ```
 */
import { portfolio, type Portfolio, type PortfolioOptions } from '../portfolio.js'
import { tokenPrices, type TokenPrice, type TokenPricesOptions } from '../price.js'
import { clientFor, type ShortcutOptions } from '../shortcuts.js'

export { portfolio, type Portfolio, type PortfolioOptions, type PortfolioToken } from '../portfolio.js'
export {
  STABLECOINS,
  combinePrices,
  defillamaPrices,
  onchainPrices,
  priceKeyOf,
  tokenPrices,
  type DefillamaPriceOptions,
  type OnchainPriceOptions,
  type OnchainPriceProtocol,
  type SuiPriceSource,
  type SuiPriceSourceContext,
  type TokenPrice,
  type TokenPricesOptions,
} from '../price.js'

export interface GetTokenPricesOptions extends TokenPricesOptions, ShortcutOptions {}

/**
 * 查代币的美元价格，节点参数同其他快捷函数（provider、network…），fetch 同时用于节点请求和查价。
 *
 * ```ts
 * await getTokenPrices([SUI_COIN_TYPE, USDC])
 * // [{ token: '0x…::sui::SUI', native: true, price: 3.21, source: 'defillama' }, { token: USDC, …, price: 1, source: 'defillama' }]
 * ```
 */
export function getTokenPrices(coinTypes: readonly string[], options: GetTokenPricesOptions = {}): Promise<TokenPrice[]> {
  const { provider, network, timeout, headers, fetch, retries, concurrency, ...rest } = options
  return tokenPrices(clientFor({ provider, network, timeout, headers, fetch, retries, concurrency }), coinTypes, { ...rest, fetch })
}

export interface GetPortfolioOptions extends PortfolioOptions, ShortcutOptions {}

/**
 * 地址的资产总值：持有的全部代币 × 价格，可选加上 LP 仓位（lp: true）。节点参数同其他快捷函数。
 *
 * ```ts
 * const p = await getPortfolio(owner, { lp: true, minUsd: 1 })
 * ```
 */
export function getPortfolio(owner: string, options: GetPortfolioOptions = {}): Promise<Portfolio> {
  const { provider, network, timeout, headers, fetch, retries, concurrency, ...rest } = options
  return portfolio(clientFor({ provider, network, timeout, headers, fetch, retries, concurrency }), owner, { ...rest, fetch })
}
