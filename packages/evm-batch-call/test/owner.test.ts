import { beforeEach, describe, expect, it } from 'vitest'

import { MULTICALL3_ADDRESS, Provider } from '../src/index.js'
import {
  alchemy,
  clearTokenListCache,
  coingeckoTokenList,
  combine,
  defillamaPrices,
  firstAvailable,
  getOwnerTokens,
  metamaskTokenList,
  nodereal,
  ownerTokens,
  type PriceSource,
  staticTokens,
  tokenList,
} from '../src/subpaths/owner.js'
import { resetMulticallCache } from '../src/aggregate.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { resetBalancesProviderCache } from '../src/shortcuts.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const USER = '0x4000000000000000000000000000000000000004'
const A = '0x1000000000000000000000000000000000000001' // 持有 100 AAA
const B = '0x2000000000000000000000000000000000000002' // 持有 5 BBB
const C = '0x3000000000000000000000000000000000000003' // 不持有
const NOT_ERC20 = '0x5000000000000000000000000000000000000005'

/** 按 URL 路由的模拟 fetch，记录每次请求 */
function mockFetch(routes: Record<string, (init?: RequestInit) => [number, unknown]>) {
  const calls: Array<{ url: string; body?: unknown }> = []
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix))
    if (!key) return new Response('not found', { status: 404 })
    const [status, body] = routes[key]!(init)
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fn, calls }
}

function chain() {
  const mock = createMockProvider({
    contracts: {
      [A]: fakeToken('AAA', 18, { [USER]: 100n * 10n ** 18n }),
      [B]: fakeToken('BBB', 6, { [USER]: 5_000_000n }),
      [C]: fakeToken('CCC', 18),
    },
    multicallAddresses: [MULTICALL3_ADDRESS],
    balances: { [USER]: 2n * 10n ** 18n },
  })
  return { mock, multi: new Provider(1, mock) }
}

const ctx = (fetchFn: typeof fetch, chainId = 1) => ({ chainId, owner: USER, fetch: fetchFn })

beforeEach(() => {
  clearTokenListCache()
  resetMulticallCache()
  resetDecimalsCache()
  resetBalancesProviderCache()
})

describe('代币来源', () => {
  it('metamaskTokenList：按收录来源数过滤，结果按 URL 缓存', async () => {
    const { fn, calls } = mockFetch({
      'https://token.api.cx.metamask.io/tokens/1': () => [
        200,
        [
          { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, occurrences: 100 },
          { address: A, symbol: 'AAA', name: 'Token A', decimals: 18, occurrences: 5, iconUrl: 'https://icon/a' },
          { address: B, symbol: 'BBB', decimals: 6, occurrences: 2 },
        ],
      ],
    })
    const source = metamaskTokenList()
    expect(await source.discover(ctx(fn))).toEqual([{ address: A, symbol: 'AAA', name: 'Token A', decimals: 18, logo: 'https://icon/a' }])
    await metamaskTokenList().discover(ctx(fn))
    expect(calls).toHaveLength(1) // 同样的条件命中缓存（缓存的是过滤后的结果）
    expect(await metamaskTokenList({ minOccurrences: 1 }).discover(ctx(fn))).toHaveLength(2)
  })

  it('metamaskTokenList：不支持的链（400）或空列表返回 null', async () => {
    const { fn } = mockFetch({
      'https://token.api.cx.metamask.io/tokens/999999': () => [400, { error: 'unsupported' }],
      'https://token.api.cx.metamask.io/tokens/130': () => [200, []],
    })
    expect(await metamaskTokenList().discover(ctx(fn, 999999))).toBeNull()
    expect(await metamaskTokenList().discover(ctx(fn, 130))).toBeNull()
  })

  it('coingeckoTokenList / tokenList：Uniswap 列表格式，按 chainId 过滤；不在映射表里的链返回 null', async () => {
    const { fn } = mockFetch({
      'https://tokens.coingecko.com/ethereum/all.json': () => [200, { tokens: [{ chainId: 1, address: A, symbol: 'AAA', decimals: 18, logoURI: 'L' }] }],
      'https://list.example': () => [200, { tokens: [{ chainId: 1, address: A, symbol: 'AAA', decimals: 18 }, { chainId: 56, address: B, symbol: 'BBB', decimals: 6 }] }],
    })
    expect(await coingeckoTokenList().discover(ctx(fn))).toEqual([{ address: A, symbol: 'AAA', name: null, decimals: 18, logo: 'L' }])
    expect(await coingeckoTokenList().discover(ctx(fn, 999999))).toBeNull()
    expect((await tokenList('https://list.example').discover(ctx(fn)))?.map((t) => t.address)).toEqual([A])
  })

  it('firstAvailable：前一个不支持或出错时用下一个；全部不支持返回 null', async () => {
    const { fn } = mockFetch({
      'https://token.api.cx.metamask.io/tokens/1': () => [500, 'down'],
      'https://tokens.coingecko.com/ethereum/all.json': () => [200, { tokens: [{ address: A, symbol: 'AAA', decimals: 18 }] }],
    })
    const tokens = await firstAvailable(metamaskTokenList(), coingeckoTokenList()).discover(ctx(fn))
    expect(tokens?.map((t) => t.address)).toEqual([A])
    expect(await firstAvailable(staticTokens([])).discover(ctx(fn))).toBeNull()
  })

  it('combine：合并去重（不区分大小写），先出现的元数据优先', async () => {
    const merged = await combine(staticTokens([{ address: A, symbol: 'FIRST' }]), staticTokens([A.toUpperCase().replace('0X', '0x'), B])).discover(ctx(fetch))
    expect(merged?.map((t) => [t.address, t.symbol])).toEqual([
      [A, 'FIRST'],
      [B, undefined],
    ])
  })
})

describe('需要 Key 的来源', () => {
  it('不传 apiKey 时直接报错', () => {
    expect(() => alchemy({ apiKey: '' })).toThrow(/requires an apiKey/)
    expect(() => nodereal(undefined as never)).toThrow(/requires an apiKey/)
  })

  it('alchemy：按 pageKey 翻页，使用对应链的地址；不支持的链返回 null', async () => {
    let page = 0
    const { fn, calls } = mockFetch({
      'https://eth-mainnet.g.alchemy.com/v2/KEY': () => {
        page++
        return [200, { jsonrpc: '2.0', id: 1, result: { tokenBalances: [{ contractAddress: page === 1 ? A : B, tokenBalance: '0x1' }], pageKey: page === 1 ? 'next' : undefined } }]
      },
    })
    const tokens = await alchemy({ apiKey: 'KEY' }).discover(ctx(fn))
    expect(tokens?.map((t) => t.address)).toEqual([A, B])
    expect(calls.map((c) => (c.body as { params: unknown[] }).params[2])).toEqual([{ maxCount: 100 }, { maxCount: 100, pageKey: 'next' }])
    expect(await alchemy({ apiKey: 'KEY' }).discover(ctx(fn, 999999))).toBeNull()
  })

  it('alchemy：出错信息里不暴露 Key', async () => {
    const { fn } = mockFetch({ 'https://eth-mainnet.g.alchemy.com/v2/SECRET': () => [401, { error: 'Must be authenticated!' }] })
    const err = (await alchemy({ apiKey: 'SECRET' }).discover(ctx(fn)).catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/401/)
    expect(err.message).not.toContain('SECRET')
  })

  it('nodereal：按 totalCount 翻页，兼容文档里的 tokenDecimails 字段；只支持 BSC / Ethereum', async () => {
    const { fn } = mockFetch({
      'https://bsc-mainnet.nodereal.io/v1/KEY': (init) => {
        const page = Number((JSON.parse(String(init?.body)) as { params: string[] }).params[1])
        return [
          200,
          {
            result: {
              totalCount: '0x2',
              details: [page === 1 ? { tokenAddress: A, tokenSymbol: 'AAA', tokenName: 'A', tokenDecimails: '0x12' } : { tokenAddress: B, tokenSymbol: 'BBB', tokenDecimals: '0x6' }],
            },
          },
        ]
      },
    })
    const tokens = await nodereal({ apiKey: 'KEY' }).discover(ctx(fn, 56))
    expect(tokens).toEqual([
      { address: A, symbol: 'AAA', name: 'A', decimals: 18 },
      { address: B, symbol: 'BBB', name: null, decimals: 6 },
    ])
    expect(await nodereal({ apiKey: 'KEY' }).discover(ctx(fn, 8453))).toBeNull()
  })
})

describe('defillamaPrices', () => {
  it('按链标识批量查价格，过滤低置信度；主币用 coingecko id', async () => {
    const { fn, calls } = mockFetch({
      'https://coins.llama.fi/prices/current/': () => [
        200,
        {
          coins: {
            'coingecko:ethereum': { price: 3000, confidence: 0.99 },
            [`ethereum:${A}`]: { price: 2, confidence: 0.99 },
            [`ethereum:${B}`]: { price: 1, confidence: 0.5 }, // 置信度太低
          },
        },
      ],
    })
    const prices = await defillamaPrices().prices({ chainId: 1, tokens: [A, B], nativeSymbol: 'ETH', fetch: fn })
    expect(prices).toEqual(new Map([['native', 3000], [A, 2]]))
    expect(calls[0]?.url).toContain('coingecko:ethereum')
    expect(calls[0]?.url).toContain(`ethereum:${A}`)
  })

  it('超过 100 个代币分批请求', async () => {
    const { fn, calls } = mockFetch({ 'https://coins.llama.fi/prices/current/': () => [200, { coins: {} }] })
    const tokens = Array.from({ length: 150 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`)
    await defillamaPrices().prices({ chainId: 56, tokens, nativeSymbol: null, fetch: fn })
    expect(calls).toHaveLength(2)
  })
})

describe('ownerTokens', () => {
  const prices: PriceSource = {
    name: 'test',
    async prices() {
      return new Map([
        ['native', 3000],
        [A, 0.01], // 100 × 0.01 = $1
        [B, 10], // 5 × 10 = $50
      ])
    },
  }

  it('主币在第一位；只返回有余额的代币；余额在链上核对', async () => {
    const { multi } = chain()
    const list = await ownerTokens(multi, USER, { source: staticTokens([{ address: A, symbol: 'AAA', decimals: 18, logo: 'L' }, B, C, NOT_ERC20, 'bad']) })
    expect(list.map((t) => [t.symbol, t.formatted, t.source])).toEqual([
      ['ETH', '2', 'native'],
      ['AAA', '100', 'static'],
      ['BBB', '5', 'static'], // 来源没给 symbol：用 multicall 补
    ])
    expect(list[1]).toMatchObject({ logo: 'L', price: null, value: null })
    expect(JSON.parse(JSON.stringify(list))).toEqual(list)
  })

  it('来源给的 decimals 直接使用，不再上链查', async () => {
    const { mock, multi } = chain()
    await ownerTokens(multi, USER, { source: staticTokens([{ address: A, symbol: 'AAA', name: 'A', decimals: 18 }]), includeNative: false })
    const { multicall3Interface } = await import('../src/aggregate.js')
    const parsed = multicall3Interface.parseTransaction({ data: String(mock.calls[0]?.data) })
    expect((parsed?.args[0] as unknown[]).length).toBe(1) // 只有 balanceOf
  })

  it('prices：计算美元价值并按价值排序；minUsd 过滤代币但保留主币', async () => {
    const { multi } = chain()
    const source = staticTokens([A, B])
    const list = await ownerTokens(multi, USER, { source, prices })
    expect(list.map((t) => [t.symbol, t.value])).toEqual([
      ['ETH', 6000],
      ['BBB', 50],
      ['AAA', 1],
    ])
    const filtered = await ownerTokens(multi, USER, { source, prices, minUsd: 10 })
    expect(filtered.map((t) => t.symbol)).toEqual(['ETH', 'BBB'])
  })

  it('includeNative: false', async () => {
    const { multi } = chain()
    expect((await ownerTokens(multi, USER, { source: staticTokens([A]), includeNative: false })).map((t) => t.symbol)).toEqual(['AAA'])
  })

  it('没有来源支持这条链时报错，并提示可以传 source', async () => {
    const { multi } = chain()
    await expect(ownerTokens(multi, USER, { source: staticTokens([]) })).rejects.toThrow(/No token source supports chain 1/)
  })

  it('getOwnerTokens：节点参数与其他函数相同，source / prices / fetch 透传', async () => {
    const { mock } = chain()
    const { fn, calls } = mockFetch({ 'https://tokens.coingecko.com/ethereum/all.json': () => [200, { tokens: [{ address: B, symbol: 'BBB', decimals: 6 }] }] })
    const list = await getOwnerTokens(USER, { chainId: 1, provider: mock, source: coingeckoTokenList(), prices, fetch: fn })
    expect(list.map((t) => [t.symbol, t.source])).toEqual([
      ['ETH', 'native'],
      ['BBB', 'coingecko'],
    ])
    expect(calls).toHaveLength(1)
  })

  it('默认来源：MetaMask 不可用时自动用 CoinGecko，结果标出来源', async () => {
    const { mock } = chain()
    const { fn } = mockFetch({
      'https://token.api.cx.metamask.io/tokens/1': () => [400, {}],
      'https://tokens.coingecko.com/ethereum/all.json': () => [200, { tokens: [{ address: A, symbol: 'AAA', decimals: 18 }] }],
    })
    const list = await getOwnerTokens(USER, { chainId: 1, provider: mock, fetch: fn, includeNative: false })
    expect(list.map((t) => [t.symbol, t.source])).toEqual([['AAA', 'coingecko']])
  })
})
