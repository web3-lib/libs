/**
 * 资产总值（子路径 `@w3lib/solana-batch-call/price`）：代币余额 × 价格，可选加上 LP 仓位的价值
 */
import type { RequestOptions, SolanaClient } from './client.js'
import { lpPositions, methodUnavailable, type LpPositionsOptions, type SolanaLpPosition } from './lp.js'
import { combinePrices, defillamaPrices, onchainPrices, tokenPrices, type SolanaPriceSource } from './price.js'

export interface PortfolioOptions extends RequestOptions {
  /**
   * 要计入的代币（SOL 用 NATIVE_MINT），按关联代币账户（ATA）读余额，免费公共节点也能用。
   * 不传时列出地址持有的全部代币（同 getOwnerTokens，含 SOL，不含 NFT），需要支持 getTokenAccountsByOwner 的节点
   */
  tokens?: readonly string[]
  /** 价格源，依次使用，默认 [defillamaPrices(), onchainPrices()] */
  sources?: readonly SolanaPriceSource[]
  /**
   * 同时计入 LP 仓位（参数同 lpPositions，价格源用上面的 sources），默认不计入。
   * 注意 lpPositions 不传 mints 时也要扫描代币账户：免费公共节点上传 { mints: [仓位 NFT / LP mint], pools: [AMM 池子] }
   */
  lp?: boolean | Omit<LpPositionsOptions, 'prices' | 'onPriceError' | 'fetch' | 'signal'>
  /** 价值低于它的代币不列出（不影响合计），默认 0 */
  minUsd?: number
  /** 某个价格源出错时调用；回调本身出错会被忽略 */
  onPriceError?: (err: unknown) => void
  /** 查价格用的 fetch，默认全局 fetch */
  fetch?: typeof fetch
}

export interface PortfolioToken {
  /** 代币的 mint；SOL 为 NATIVE_MINT（或传入的 nativeMints 里的地址） */
  token: string
  /** 原生 SOL；Wrapped SOL 的代币账户单独列出（native: false），价格同 SOL */
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
  lp: SolanaLpPosition[]
  /** 有余额但没有价格的代币数（LP 仓位里缺价格的也算） */
  unpriced: number
}

interface Held {
  token: string
  native: boolean
  symbol: string | null
  balance: string
  decimals: number
  formatted: string
}

/**
 * 一个地址的资产总值：代币余额 × 价格，可选加上 LP 仓位。
 *
 * ```ts
 * const p = await portfolio(client, owner, { tokens: [NATIVE_MINT, USDC, JUP] })   // 指定代币：免费公共节点也能用
 * const all = await portfolio(new SolanaClient('https://my-rpc…'), owner, { lp: true })   // 全部持仓 + LP：需要支持 getTokenAccountsByOwner 的节点
 * p.totalUsd  // 1234.5
 * ```
 */
export async function portfolio(client: SolanaClient, owner: string, options: PortfolioOptions = {}): Promise<Portfolio> {
  const { tokens, sources = [defillamaPrices(), onchainPrices()], lp, minUsd = 0, onPriceError, fetch: fetchFn, signal } = options
  // 回调本身出错由 combinePrices / lpPositions 忽略
  const onError = onPriceError ? (_: SolanaPriceSource, err: unknown) => onPriceError(err) : undefined
  const [balances, positions] = await Promise.all([
    holdings(client, owner, tokens, signal),
    lp
      ? lpPositions(client, owner, { ...(lp === true ? {} : lp), prices: combinePrices(sources, { onError }), fetch: fetchFn, onPriceError, signal })
      : Promise.resolve([]),
  ])
  // 列出全部持仓时，LP 代币已经按仓位计入，不再作为代币重复计算
  const lpMints = new Set(positions.flatMap((p) => (p.type === 'amm' ? [p.lpMint] : [])))
  const held = balances.filter((b) => BigInt(b.balance) > 0n && !(tokens === undefined && lpMints.has(b.token)))
  const prices = held.length ? await tokenPrices(client, held.map((b) => b.token), { sources, onError, fetch: fetchFn, signal }) : []
  const list: PortfolioToken[] = held.map((b, i) => {
    const p = prices[i]
    const price = p?.price ?? null
    return { ...b, price, value: price === null ? null : Number(b.formatted) * price, priceSource: p?.source ?? null }
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

/** 余额：传 tokens 时读这些代币的 ATA，否则列出全部持仓 */
async function holdings(client: SolanaClient, owner: string, tokens: readonly string[] | undefined, signal: AbortSignal | undefined): Promise<Held[]> {
  if (tokens) {
    const balances = tokens.length ? await client.balances(owner, tokens, { symbol: true, signal }) : []
    return balances.filter((b) => b.success).map((b) => ({ token: b.token, native: b.native, symbol: b.symbol ?? null, balance: b.balance, decimals: b.decimals, formatted: b.formatted }))
  }
  const owned = await client.ownerTokens(owner, { signal }).catch((err: unknown) => {
    if (signal?.aborted || !methodUnavailable(err)) {
      throw err // 取消、限频、超时等原样抛出（保留错误类型）
    }
    throw new Error(
      `Listing the tokens of ${owner} failed (${err instanceof Error ? err.message : String(err)}). ` +
        'Listing needs getTokenAccountsByOwner (most free public nodes do not support it): pass the mints in `tokens`, or use a node that supports it',
      { cause: err },
    )
  })
  return owned.map((t) => ({ token: t.token, native: t.native, symbol: t.symbol ?? null, balance: t.balance, decimals: t.decimals, formatted: t.formatted }))
}
