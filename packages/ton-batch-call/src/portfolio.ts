/**
 * 资产总值（子路径 `@w3lib/ton-batch-call/price`）：TON 和持有的全部 Jetton 的余额 × 价格，可选加上 LP 仓位的价值
 */
import { toRawAddress } from './address.js'
import type { TonClient } from './client.js'
import type { RequestOptions } from './http.js'
import { lpPositions, type LpPositionsOptions, type TonLpPosition } from './lp.js'
import { combinePrices, defillamaPrices, onchainPrices, tokenPrices, type TonPriceSource } from './price.js'

export interface PortfolioOptions extends RequestOptions {
  /** 价格源，依次使用，默认 [defillamaPrices(), onchainPrices()] */
  sources?: readonly TonPriceSource[]
  /** 同时计入 LP 仓位（参数同 lpPositions，价格源用上面的 sources），默认不计入。计入时 LP Jetton 不再算作代币 */
  lp?: boolean | Omit<LpPositionsOptions, 'prices' | 'onPriceError' | 'fetch' | 'signal'>
  /** 价值低于它的代币不列出（不影响合计），默认 0 */
  minUsd?: number
  /** 计入索引器标记的诈骗代币（常见的是仿冒 USDT 的空投），默认 false：不列出、不查价格 */
  includeScam?: boolean
  /** 某个价格源出错时调用 */
  onPriceError?: (err: unknown) => void
  /** 请求 DefiLlama 等用的 fetch；默认全局 fetch */
  fetch?: typeof fetch
}

export interface TonPortfolioToken {
  /** NATIVE_TON 或 Jetton 主合约地址（用户友好格式） */
  token: string
  native: boolean
  symbol: string | null
  /** owner 的 Jetton 钱包；TON 为 null */
  wallet: string | null
  balance: string
  decimals: number
  /** 精度未知（索引器还没读到链下元数据）：formatted 不可信，value 为 null */
  decimalsUnknown?: true
  formatted: string
  price: number | null
  /** 美元价值；没有价格（或精度未知）时为 null */
  value: number | null
  /** 给出价格的价格源 */
  priceSource: string | null
}

export interface TonPortfolio {
  /** 合计（代币 + LP；没有价格的不计入） */
  totalUsd: number
  tokensUsd: number
  lpUsd: number
  /** 有余额的代币，按价值从高到低 */
  tokens: TonPortfolioToken[]
  /** LP 仓位（开启 lp 时） */
  lp: TonLpPosition[]
  /** 有余额但没有价值的代币数（没有价格或精度未知；LP 仓位里缺价格的也算） */
  unpriced: number
}

/**
 * 一个地址的资产总值：TON 和持有的全部 Jetton（索引器列出）× 价格，可选加上 LP 仓位。
 * 没有 DefiLlama 价格的 Jetton 会走链上价格源，toncenter 没有 API Key 时每个约 3~6 次请求（每秒 1 次），空投的杂币多时较慢
 *
 * ```ts
 * const p = await portfolio(ton, owner, { lp: true })
 * p.totalUsd  // 1234.5
 * ```
 */
export async function portfolio(client: TonClient, owner: string, options: PortfolioOptions = {}): Promise<TonPortfolio> {
  const { sources = [defillamaPrices(), onchainPrices()], lp, minUsd = 0, includeScam = false, onPriceError, fetch: fetchFn, signal } = options
  const onError = onPriceError ? (_: TonPriceSource, err: unknown) => onPriceError(err) : undefined
  const [balances, positions] = await Promise.all([
    client.balances(owner, undefined, { symbol: true, signal }),
    lp
      ? lpPositions(client, owner, { ...(lp === true ? {} : lp), prices: combinePrices(sources, { onError }), ...(fetchFn ? { fetch: fetchFn } : {}), ...(onPriceError ? { onPriceError } : {}), ...(signal ? { signal } : {}) })
      : Promise.resolve([]),
  ])
  const lpJettons = new Set(positions.map((p) => toRawAddress(p.pool)))
  const held = balances.filter((b) => b.success && BigInt(b.balance) > 0n && (includeScam || !b.isScam) && (b.native || !lpJettons.has(toRawAddress(b.token))))
  const prices = held.length ? await tokenPrices(client, held.map((b) => b.token), { sources, ...(onError ? { onError } : {}), ...(fetchFn ? { fetch: fetchFn } : {}), ...(signal ? { signal } : {}) }) : []
  const list: TonPortfolioToken[] = held.map((b, i) => {
    const p = prices[i]
    const price = p?.price ?? null
    return {
      token: b.token,
      native: b.native,
      symbol: b.symbol ?? null,
      wallet: b.wallet,
      balance: b.balance,
      decimals: b.decimals,
      ...(b.decimalsUnknown ? { decimalsUnknown: true as const } : {}),
      formatted: b.formatted,
      price,
      value: price === null || b.decimalsUnknown ? null : Number(b.formatted) * price,
      priceSource: p?.source ?? null,
    }
  })
  const tokensUsd = list.reduce((sum, t) => sum + (t.value ?? 0), 0)
  const lpUsd = positions.reduce((sum, p) => sum + (p.valueUsd ?? 0), 0)
  return {
    totalUsd: tokensUsd + lpUsd,
    tokensUsd,
    lpUsd,
    tokens: list.filter((t) => (t.value ?? 0) >= minUsd || (minUsd === 0 && t.value === null)).sort((a, b) => (b.value ?? -1) - (a.value ?? -1)),
    lp: positions,
    unpriced: list.filter((t) => t.value === null).length + positions.filter((p) => p.valueUsd === null).length,
  }
}
