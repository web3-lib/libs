/** getOwnerTokens code review 发现的问题的回归测试 */
import { beforeEach, describe, expect, it } from 'vitest'

import { MULTICALL3_ADDRESS, Provider, alchemy, clearTokenListCache, combine, staticTokens, toEvmAddress, tokenList, type PriceSource, type TokenSource } from '../src/index.js'
import { resetMulticallCache } from '../src/aggregate.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const USER = '0x4000000000000000000000000000000000000004'
const A = '0x1000000000000000000000000000000000000001'
const B = '0x2000000000000000000000000000000000000002'
const POL_ALIAS = '0x0000000000000000000000000000000000001010'
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

function provider(chainId = 1, extra: Record<string, ReturnType<typeof fakeToken>> = {}, config = {}) {
  const mock = createMockProvider({
    contracts: {
      [A]: fakeToken('AAA', 6, { [USER]: 5_000_000n }), // 链上精度 6
      [B]: fakeToken('BBB', 18, { [USER]: 10n ** 18n }),
      ...extra,
    },
    multicallAddresses: [MULTICALL3_ADDRESS],
    balances: { [USER]: 10n ** 18n },
  })
  return new Provider(chainId, mock, config)
}

function mockFetch(routes: Record<string, () => [number, unknown]>) {
  const calls: string[] = []
  const fn = (async (url: string) => {
    calls.push(url)
    const key = Object.keys(routes).find((p) => url.startsWith(p))
    if (!key) return new Response('{}', { status: 404 })
    const [status, body] = routes[key]!()
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fn, calls }
}

beforeEach(() => {
  clearTokenListCache()
  resetMulticallCache()
  resetDecimalsCache()
})

describe('getOwnerTokens 回归', () => {
  it('Tron 的 T 开头地址不会被过滤掉', async () => {
    const hex = toEvmAddress(TRON_USDT)
    const multi = provider(1, { [hex]: fakeToken('USDT', 6, { [USER]: 7_000_000n }) })
    const list = await multi.ownerTokens(USER, { source: staticTokens([TRON_USDT]), includeNative: false })
    expect(list.map((t) => [t.token, t.formatted])).toEqual([[TRON_USDT, '7']])
  })

  it('combine：单个来源出错不影响其他来源', async () => {
    const broken: TokenSource = { name: 'broken', discover: async () => Promise.reject(new Error('429')) }
    const list = await provider().ownerTokens(USER, { source: combine(broken, staticTokens([B])), includeNative: false })
    expect(list.map((t) => t.symbol)).toEqual(['BBB'])
  })

  it('主币的 ERC20 映射地址（Polygon 0x…1010）和 nativeTokens 配置里的地址不会被重复计入', async () => {
    const multi = provider(137, { [POL_ALIAS]: fakeToken('POL', 18, { [USER]: 10n ** 18n }) }, { nativeTokens: [B] })
    const list = await multi.ownerTokens(USER, { source: staticTokens([POL_ALIAS, B, A]) })
    expect(list.map((t) => [t.symbol, t.native])).toEqual([
      ['POL', true],
      ['AAA', false],
    ])
  })

  it('主币信息使用 nativeSymbol / nativeName 配置，价格源也拿到配置的 symbol', async () => {
    let seen: string | null = null
    const prices: PriceSource = {
      name: 'test',
      async prices({ nativeSymbol }) {
        seen = nativeSymbol
        return new Map([['native', 2]])
      },
    }
    const multi = provider(999_999, {}, { nativeSymbol: 'XDAI', nativeName: 'xDai' })
    const [native] = await multi.ownerTokens(USER, { source: staticTokens([A]), prices })
    expect(native).toMatchObject({ symbol: 'XDAI', name: 'xDai', value: 2 })
    expect(seen).toBe('XDAI')
  })

  it('来源给错的 decimals 以链上为准；非法 decimals（NaN）当作未知', async () => {
    const multi = provider()
    const list = await multi.ownerTokens(USER, {
      source: staticTokens([
        { address: A, symbol: 'AAA', decimals: 18 }, // 列表说 18，链上是 6
        { address: B, symbol: 'BBB', decimals: Number.NaN },
      ]),
      includeNative: false,
    })
    expect(list.map((t) => [t.symbol, t.decimals, t.formatted])).toEqual([
      ['AAA', 6, '5'],
      ['BBB', 18, '1'],
    ])
  })

  it('alchemy 的 urls 只覆盖指定的链，其他链仍用默认地址', async () => {
    const { fn, calls } = mockFetch({ 'https://': () => [200, { result: { tokenBalances: [] } }] })
    const source = alchemy({ apiKey: 'KEY', urls: { 56: 'https://proxy.example/bsc' } })
    await source.discover({ chainId: 56, owner: USER, fetch: fn })
    await source.discover({ chainId: 1, owner: USER, fetch: fn })
    expect(calls).toEqual(['https://proxy.example/bsc', 'https://eth-mainnet.g.alchemy.com/v2/KEY'])
  })

  it('只传 minUsd 时自动开启 DefiLlama 价格；与 prices: false 同时使用时报错', async () => {
    const { fn, calls } = mockFetch({ 'https://coins.llama.fi/': () => [200, { coins: { [`ethereum:${B.toLowerCase()}`]: { price: 5, confidence: 0.99 } } }] })
    const list = await provider().ownerTokens(USER, { source: staticTokens([A, B]), minUsd: 1, includeNative: false, fetch: fn })
    expect(list.map((t) => [t.symbol, t.value])).toEqual([['BBB', 5]])
    expect(calls.some((u) => u.startsWith('https://coins.llama.fi/'))).toBe(true)
    await expect(provider().ownerTokens(USER, { source: staticTokens([A]), minUsd: 1, prices: false })).rejects.toThrow(/minUsd requires prices/)
  })

  it('错误信息不泄露 Key（Key 在查询参数里也一样），公开列表的错误信息保留完整地址', async () => {
    const { fn } = mockFetch({ 'https://': () => [500, {}] })
    const keyed = alchemy({ apiKey: 'SECRET', urls: { 1: 'https://proxy.example/alchemy?apiKey=SECRET' } })
    const err = (await keyed.discover({ chainId: 1, owner: USER, fetch: fn }).catch((e: unknown) => e)) as Error
    expect(err.message).not.toContain('SECRET')
    const listErr = (await tokenList('https://x.example/v1/list.json').discover({ chainId: 1, owner: USER, fetch: fn }).catch((e: unknown) => e)) as Error
    expect(listErr.message).toContain('https://x.example/v1/list.json')
  })
})
