/**
 * 资产总值（子路径 `@w3lib/evm-batch-call/price`）：已知代币的余额 × 价格，可选加上 LP 仓位的价值
 */
import { lpPositions, type LpPosition, type LpPositionsOptions } from './lp.js'
import { combinePrices, defillamaPrices, onchainPrices, tokenPrices, type PriceSource } from './price.js'
import type { Provider } from './provider.js'
import { withSignal } from './util.js'

export interface PortfolioOptions {
  /** 要计入的代币（含主币：NATIVE_TOKEN），余额用 multicall 一次读出 */
  tokens: readonly string[]
  /** 价格源，依次使用，默认 [defillamaPrices(), onchainPrices()] */
  sources?: readonly PriceSource[]
  /** 同时计入 LP 仓位（V2 LP 代币、V3 仓位 NFT；参数同 lpPositions，价格源用上面的 sources），默认不计入 */
  lp?: boolean | Omit<LpPositionsOptions, 'prices'>
  /** 价值低于它的代币不列出（不影响合计）；大于 0 时没有价格的代币也不列出（计入 unpriced），默认 0 */
  minUsd?: number
  /** 某个价格源出错时调用 */
  onPriceError?: (err: unknown) => void
  fetch?: typeof fetch
  /** 取消：余额、LP 的节点请求随之中止，查价格的步骤立即以 signal.reason 失败 */
  signal?: AbortSignal
}

export interface PortfolioToken {
  token: string
  native: boolean
  symbol: string | null
  balance: string
  decimals: number
  formatted: string
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
  lpUsd: number
  /** 有余额的代币，按价值从高到低 */
  tokens: PortfolioToken[]
  /** LP 仓位（开启 lp 时） */
  lp: LpPosition[]
  /** 有余额但没有价格的代币数（LP 仓位里缺价格的也算） */
  unpriced: number
}

/**
 * 一个地址的资产总值：代币余额（只看传入的代币，EVM 不能只靠节点列出持仓）× 价格，可选加上 LP 仓位。
 *
 * ```ts
 * const p = await portfolio(provider, user, { tokens: [NATIVE_TOKEN, USDT, USDC], lp: true })
 * p.totalUsd  // 1234.5
 * ```
 */
export async function portfolio(provider: Provider, owner: string, options: PortfolioOptions): Promise<Portfolio> {
  const { tokens, sources = [defillamaPrices(), onchainPrices()], lp, minUsd = 0, onPriceError, fetch: fetchFn, signal } = options
  signal?.throwIfAborted()
  const onError = onPriceError ? (_: PriceSource, err: unknown) => onPriceError(err) : undefined
  const sig = signal ? { signal } : {}
  const [balances, positions] = await Promise.all([
    tokens.length ? provider.balances(owner, tokens, { symbol: true, ...sig }) : Promise.resolve([]),
    lp ? lpPositions(provider, owner, { ...(lp === true ? {} : lp), prices: combinePrices(sources, { onError }), ...(fetchFn ? { fetch: fetchFn } : {}), ...(onPriceError ? { onPriceError } : {}), ...sig }) : Promise.resolve([]),
  ])
  const held = balances.filter((b) => b.success && BigInt(b.balance) > 0n)
  const prices = held.length
    ? await withSignal(signal, () => tokenPrices(provider, held.map((b) => b.token), { sources, ...(onError ? { onError } : {}), ...(fetchFn ? { fetch: fetchFn } : {}) }))
    : []
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
      value: price === null ? null : Number(b.formatted) * price,
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
    unpriced: list.filter((t) => t.price === null).length + positions.filter((p) => p.valueUsd === null).length,
  }
}
