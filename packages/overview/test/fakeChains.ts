import type { OverviewLoaders } from '../src/index.js'

export const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
export const USDC_BSC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'
export const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

export interface FakeToken {
  token: string
  native?: boolean
  symbol: string
  formatted: string
  price: number | null
  decimals?: number
}

export const tok = (t: FakeToken) => ({
  token: t.token,
  native: !!t.native,
  symbol: t.symbol,
  balance: String(Math.round(Number(t.formatted) * 10 ** (t.decimals ?? 6))),
  decimals: t.decimals ?? 6,
  formatted: t.formatted,
  price: t.price,
  value: t.price === null ? null : Number(t.formatted) * t.price,
  priceSource: t.price === null ? null : 'fake',
})

export function portfolioOf(tokens: FakeToken[], lp: any[] = []) {
  const list = tokens.map(tok)
  const tokensUsd = list.reduce((s, t) => s + (t.value ?? 0), 0)
  const lpUsd = lp.reduce((s, p) => s + (p.valueUsd ?? 0), 0)
  return { totalUsd: tokensUsd + lpUsd, tokensUsd, lpUsd, tokens: list, lp, unpriced: list.filter((t) => t.value === null).length }
}

export type Handler = (owner: string, options: Record<string, any>) => Promise<unknown> | unknown

/** 每个加载器返回一个带 getPortfolio（和 getApprovals）的假模块，调用记录在 calls 里 */
export function fakeLoaders(handlers: { evm?: Handler; solana?: Handler; sui?: Handler; ton?: Handler; evmApprovals?: Handler; solanaApprovals?: Handler; evmOwner?: Handler }) {
  const calls: Array<{ module: string; owner: string; options: Record<string, any> }> = []
  const wrap = (module: string, fn: Handler | undefined, name: string) =>
    fn
      ? async () => ({
          [name]: async (owner: string, options: Record<string, any>) => {
            calls.push({ module, owner, options })
            return fn(owner, options)
          },
        })
      : undefined
  const loaders: OverviewLoaders = {}
  for (const [key, name] of [['evm', 'getPortfolio'], ['solana', 'getPortfolio'], ['sui', 'getPortfolio'], ['ton', 'getPortfolio'], ['evmApprovals', 'getApprovals'], ['solanaApprovals', 'getApprovals'], ['evmOwner', 'getOwnerTokens']] as const) {
    const l = wrap(key, handlers[key], name)
    if (l) loaders[key] = l
  }
  return { loaders, calls }
}
