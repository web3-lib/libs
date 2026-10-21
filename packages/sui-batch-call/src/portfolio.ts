/**
 * 资产总值（子路径 `@w3lib/sui-batch-call/price`）：地址持有的代币余额 × 价格，可选加上 LP 仓位的价值
 */
import type { SuiClient } from './client.js'
import { lpPositions, type LpPositionsOptions, type SuiLpPosition } from './lp.js'
import { combinePrices, defillamaPrices, onchainPrices, tokenPrices, type SuiPriceSource } from './price.js'

export interface PortfolioOptions {
  /** 只计入这些代币；默认地址持有的全部代币（一次 ListBalances） */
  coinTypes?: readonly string[]
  /** 价格源，依次使用，默认 [defillamaPrices(), onchainPrices()] */
  sources?: readonly SuiPriceSource[]
  /** 同时计入 LP 仓位（参数同 lpPositions，价格源用上面的 sources），默认不计入 */
  lp?: boolean | Omit<LpPositionsOptions, 'prices' | 'fetch' | 'onPriceError' | 'signal'>
  /** 价值低于它的代币不列出（不影响合计），默认 0 */
  minUsd?: number
  /** 某个价格源出错时调用 */
  onPriceError?: (err: unknown) => void
  fetch?: typeof fetch
  signal?: AbortSignal
}

export interface PortfolioToken {
  /** 代币类型（规范化） */
  token: string
  /** 是否是 SUI */
  native: boolean
  symbol: string | null
  balance: string
  /** 读不到代币信息时为 null（这时 formatted、value 也为 null） */
  decimals: number | null
  formatted: string | null
  price: number | null
  /** 美元价值；没有价格时为 null */
  value: number | null
  /** 给出价格的价格源 */
  priceSource: string | null
}

export interface Portfolio {
  /** 合计（代币 + LP；没有价格的不计入） */
  totalUsd: number
  tokensUsd: number
  /** LP 仓位的 valueUsd 之和（不含未领取的手续费和奖励） */
  lpUsd: number
  /** 有余额的代币，按价值从高到低 */
  tokens: PortfolioToken[]
  /** LP 仓位（开启 lp 时） */
  lp: SuiLpPosition[]
  /** 有余额但算不出价值的代币数（LP 仓位里缺价格的也算） */
  unpriced: number
}

/**
 * 一个地址的资产总值：持有的全部代币（Sui 节点能直接列出）× 价格，可选加上 LP 仓位。
 * 开启 lp 时，作为 LP 仓位计入的 LP 代币（DipCoin、FlowX V2、Aftermath）不再算在代币里。
 *
 * ```ts
 * const p = await portfolio(sui, owner, { lp: true })
 * p.totalUsd  // 1234.5
 * ```
 */
export async function portfolio(client: SuiClient, owner: string, options: PortfolioOptions = {}): Promise<Portfolio> {
  const { coinTypes, sources = [defillamaPrices(), onchainPrices()], lp, minUsd = 0, onPriceError, fetch: fetchFn, signal } = options
  const onError = onPriceError ? (_: SuiPriceSource, err: unknown) => onPriceError(err) : undefined
  const [balances, positions] = await Promise.all([
    coinTypes && !coinTypes.length ? Promise.resolve([]) : client.balances(owner, coinTypes, { symbol: true, signal }),
    lp ? lpPositions(client, owner, { ...(lp === true ? {} : lp), prices: combinePrices(sources, { onError }), onPriceError, fetch: fetchFn, signal }) : Promise.resolve([]),
  ])
  // LP 代币已经按仓位计入
  const lpCoins = new Set(positions.flatMap((p) => (p.type === 'amm' || p.type === 'multi') && p.position === null ? [p.lpCoinType] : []))
  const held = balances.filter((b) => b.success && BigInt(b.balance) > 0n && !lpCoins.has(b.token))
  const prices = held.length ? await tokenPrices(client, held.map((b) => b.token), { sources, onError, fetch: fetchFn, signal }) : []
  const list: PortfolioToken[] = held.map((b, i) => {
    const p = prices[i]
    const price = p?.price ?? null
    return {
      token: b.token,
      native: b.native,
      symbol: b.symbol ?? null,
      balance: b.balance,
      decimals: b.decimals,
      formatted: b.formatted,
      price,
      value: price === null || b.formatted === null ? null : Number(b.formatted) * price,
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
