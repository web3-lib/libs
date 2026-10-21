/**
 * 价格（子路径 `@w3lib/solana-batch-call/price`）：代币的美元价格（DefiLlama 当前 / 历史价格，没有收录的从链上 Raydium / Orca 池子算）、
 * 组合价格源、地址的资产总值。不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { NATIVE_MINT } from '@w3lib/solana-batch-call'
 * import { getPortfolio, getTokenPrices } from '@w3lib/solana-batch-call/price'
 *
 * await getTokenPrices([NATIVE_MINT, USDC, newToken])
 * await getPortfolio(owner, { tokens: [NATIVE_MINT, USDC, JUP] })
 * ```
 */
import { portfolio, type Portfolio, type PortfolioOptions } from '../portfolio.js'
import { tokenPrices, type TokenPrice, type TokenPricesOptions } from '../price.js'
import { resolve, type ShortcutOptions } from '../shortcuts.js'

export { portfolio, type Portfolio, type PortfolioOptions, type PortfolioToken } from '../portfolio.js'
export {
  STABLECOINS,
  combinePrices,
  defillamaPrices,
  onchainPrices,
  tokenPrices,
  type DefillamaPriceOptions,
  type OnchainPriceOptions,
  type OnchainPriceProtocol,
  type SolanaPriceSource,
  type SolanaPriceSourceContext,
  type TokenPrice,
  type TokenPricesOptions,
} from '../price.js'

export interface GetTokenPricesOptions extends TokenPricesOptions, ShortcutOptions {}

/**
 * 查代币的美元价格（SOL 用 NATIVE_MINT），节点参数与 getBalances 相同。
 *
 * ```ts
 * await getTokenPrices([NATIVE_MINT, USDC])
 * // [{ token: 'So111…112', native: true, price: 187.4, source: 'defillama' }, { token: USDC, native: false, price: 1, source: 'defillama' }]
 * ```
 */
export function getTokenPrices(mints: readonly string[], options: GetTokenPricesOptions = {}): Promise<TokenPrice[]> {
  // fetch 同时给节点请求（客户端配置）和查价用，与 getLpPositions 一致
  const { client, own } = resolve(options, ['sources', 'onError', 'signal'])
  return tokenPrices(client, mints, { ...own, ...(options.fetch ? { fetch: options.fetch } : {}) })
}

export interface GetPortfolioOptions extends PortfolioOptions, ShortcutOptions {}

/**
 * 地址的资产总值：代币余额 × 价格，可选加上 LP 仓位（lp: true）。
 *
 * ```ts
 * await getPortfolio(owner, { tokens: [NATIVE_MINT, USDC, JUP] })              // 指定代币：免费公共节点也能用
 * await getPortfolio(owner, { provider: 'https://my-rpc…', lp: true })         // 全部持仓 + LP：需要支持 getTokenAccountsByOwner 的节点
 * ```
 */
export function getPortfolio(owner: string, options: GetPortfolioOptions = {}): Promise<Portfolio> {
  const { client, own } = resolve(options, ['tokens', 'sources', 'lp', 'minUsd', 'onPriceError', 'signal'])
  return portfolio(client, owner, { ...own, ...(options.fetch ? { fetch: options.fetch } : {}) })
}
