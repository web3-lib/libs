/** 价格源的组合、tokenPrices 的结果（价格源是假的，不连网络） */
import { describe, expect, it } from 'vitest'

import { NATIVE_TOKEN, Provider, TRON_CHAIN_ID } from '../src/index.js'
import { combinePrices, defillamaPrices, getPortfolio, portfolio, priceKeyOf, tokenPrices, type PriceSource } from '../src/subpaths/price.js'

const USDT = '0x55d398326f99059fF775485246999027B3197955'
const CAKE = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'

const fixed = (name: string, prices: Record<string, number>, seen: string[][] = []): PriceSource => ({
  name,
  async prices(ctx) {
    seen.push([...ctx.tokens, ...(ctx.nativeSymbol ? ['native'] : [])])
    return new Map(Object.entries(prices).filter(([k]) => k === 'native' ? ctx.nativeSymbol : ctx.tokens.some((t) => priceKeyOf(ctx.chainId, t) === k)))
  },
})

describe('price sources', () => {
  it('前面的源没有的价格交给后面的源，记下来源；出错的源跳过', async () => {
    const seen: string[][] = []
    const broken: PriceSource = { name: 'broken', prices: async () => Promise.reject(new Error('down')) }
    const errors: string[] = []
    const list = await tokenPrices(new Provider(56), [NATIVE_TOKEN, USDT, CAKE, '0x0000000000000000000000000000000000000001'], {
      sources: [broken, fixed('a', { [USDT.toLowerCase()]: 1 }, seen), fixed('b', { native: 600, [CAKE.toLowerCase()]: 2, [USDT.toLowerCase()]: 9 }, seen)],
      onError: (s) => errors.push(s.name),
    })
    expect(errors).toEqual(['broken'])
    expect(list.map((p) => [p.native, p.price, p.source])).toEqual([
      [true, 600, 'b'],
      [false, 1, 'a'],
      [false, 2, 'b'],
      [false, null, null],
    ])
    // 第二个源只查第一个源没有的
    expect(seen[1]).toEqual([CAKE, '0x0000000000000000000000000000000000000001', 'native'])
  })

  it('combinePrices 组合成一个价格源；Tron 的键是 base58 地址', async () => {
    const source = combinePrices([fixed('a', { TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: 1 }), fixed('b', { native: 0.3 })])
    expect(source.name).toBe('a+b')
    const result = await source.prices({ chainId: TRON_CHAIN_ID.mainnet, tokens: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'], nativeSymbol: 'TRX', fetch })
    expect([...result]).toEqual([
      ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 1],
      ['native', 0.3],
    ])
  })

  it('DefiLlama：当前和历史价格的地址、主币按 coingecko id', async () => {
    const urls: string[] = []
    const fakeFetch = (async (url: string) => {
      urls.push(url)
      const all: Record<string, { price: number; confidence: number }> = { 'coingecko:binancecoin': { price: 600, confidence: 0.99 }, [`bsc:${USDT.toLowerCase()}`]: { price: 1, confidence: 0.5 } }
      const asked = (url.split('/').pop() ?? '').split(',')
      return new Response(JSON.stringify({ coins: Object.fromEntries(Object.entries(all).filter(([k]) => asked.includes(k))) }))
    }) as typeof fetch
    const now = await defillamaPrices().prices({ chainId: 56, tokens: [USDT], nativeSymbol: 'BNB', fetch: fakeFetch })
    expect([...now]).toEqual([['native', 600]]) // 置信度 0.5 的不要
    const at = defillamaPrices({ at: new Date('2026-01-01T00:00:00Z'), minConfidence: 0 })
    expect(at.name).toBe('defillama@1767225600')
    expect([...(await at.prices({ chainId: 56, tokens: [USDT], nativeSymbol: null, fetch: fakeFetch }))]).toEqual([[USDT.toLowerCase(), 1]])
    expect(urls).toEqual([`https://coins.llama.fi/prices/current/coingecko:binancecoin,bsc:${USDT.toLowerCase()}`, `https://coins.llama.fi/prices/historical/1767225600/bsc:${USDT.toLowerCase()}`])
  })
})

describe('portfolio signal', () => {
  it('signal 传给余额查询；getPortfolio 也把 signal 传下去，已取消时以 reason 失败', async () => {
    let seen: AbortSignal | undefined
    const fake = { balances: (_o: string, _t: readonly string[], opts: { signal?: AbortSignal }) => ((seen = opts.signal), new Promise(() => {})) } as unknown as Provider
    const ctl = new AbortController()
    void portfolio(fake, '0x0000000000000000000000000000000000000001', { tokens: [NATIVE_TOKEN], signal: ctl.signal })
    expect(seen).toBe(ctl.signal) // 真 Provider 的 balances 随 signal 中止
    const aborted = AbortSignal.abort(new Error('cancelled'))
    await expect(getPortfolio('0x0000000000000000000000000000000000000001', { chainId: 56, tokens: [NATIVE_TOKEN], signal: aborted })).rejects.toThrow('cancelled')
  })
})
