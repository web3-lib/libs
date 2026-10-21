/** 价格源的组合、DefiLlama 的请求、链上价格（假的 toncenter，不连网络） */
import { beforeEach, describe, expect, it } from 'vitest'

import { NATIVE_TON, TonClient, toFriendlyAddress, type TonTransport } from '../src/index.js'
import { STONFI_V1_ROUTER, DEDUST_FACTORY, PTON_V1_MASTER, dedustAsset, dedustAssetCell } from '../src/lp.js'
import { TON_USDT, combinePrices, defillamaPrices, onchainPrices, priceKeyOf, resetPriceCache, tokenPrices, type TonPriceSource } from '../src/subpaths/price.js'
import { Cell, beginCell } from '../src/write/cell.js'

const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const JET = `0:${'1'.repeat(64)}`
const JET2 = `0:${'2'.repeat(64)}`
const JET3 = `0:${'3'.repeat(64)}`

const fixed = (name: string, prices: Record<string, number>, seen: string[][] = []): TonPriceSource => ({
  name,
  async prices(ctx) {
    seen.push([...ctx.tokens])
    return new Map(Object.entries(prices).filter(([k]) => ctx.tokens.includes(k)))
  },
})

/** 没有用到网络的客户端（价格源是假的） */
const offline = new TonClient({ get: () => Promise.reject(new Error('offline')), post: () => Promise.reject(new Error('offline')) })

describe('价格源', () => {
  it('前面的源没有的价格交给后面的源，记下来源；出错的源跳过；任意格式的地址统一成原始格式', async () => {
    const seen: string[][] = []
    const broken: TonPriceSource = { name: 'broken', prices: async () => Promise.reject(new Error('down')) }
    const errors: string[] = []
    const list = await tokenPrices(offline, [NATIVE_TON, USDT, JET, 'not-an-address', JET2], {
      sources: [broken, fixed('a', { [TON_USDT]: 1 }, seen), fixed('b', { [NATIVE_TON]: 1.3, [JET]: 2, [TON_USDT]: 9 }, seen)],
      onError: (s) => errors.push(s.name),
    })
    expect(errors).toEqual(['broken'])
    expect(list.map((p) => [p.token, p.native, p.price, p.source])).toEqual([
      [NATIVE_TON, true, 1.3, 'b'],
      [USDT, false, 1, 'a'],
      [JET, false, 2, 'b'],
      ['not-an-address', false, null, null],
      [JET2, false, null, null],
    ])
    // 源收到的是去重后的原始地址；第二个源只查第一个源没有的
    expect(seen[0]).toEqual([NATIVE_TON, TON_USDT, JET, JET2])
    expect(seen[1]).toEqual([NATIVE_TON, JET, JET2])
    expect(priceKeyOf(USDT)).toBe(TON_USDT)
  })

  it('combinePrices 组合成一个价格源', async () => {
    const source = combinePrices([fixed('a', { [TON_USDT]: 1 }), fixed('b', { [NATIVE_TON]: 1.3 })])
    expect(source.name).toBe('a+b')
    const result = await source.prices({ tokens: [USDT, NATIVE_TON], fetch })
    expect([...result]).toEqual([
      [TON_USDT, 1],
      [NATIVE_TON, 1.3],
    ])
  })

  it('DefiLlama：当前和历史价格，TON 按 coingecko id，Jetton 按 EQ 地址；置信度低的不要', async () => {
    const urls: string[] = []
    const fakeFetch = (async (url: string) => {
      urls.push(url)
      const all: Record<string, { price: number; confidence: number }> = { 'coingecko:the-open-network': { price: 1.3, confidence: 0.99 }, [`ton:${USDT}`]: { price: 1, confidence: 0.99 }, [`ton:${toFriendlyAddress(JET)}`]: { price: 5, confidence: 0.5 } }
      const asked = (url.split('/').pop() ?? '').split(',').map(decodeURIComponent)
      return new Response(JSON.stringify({ coins: Object.fromEntries(Object.entries(all).filter(([k]) => asked.includes(k))) }))
    }) as typeof fetch
    const now = await defillamaPrices().prices({ tokens: [NATIVE_TON, TON_USDT, JET], fetch: fakeFetch })
    expect([...now]).toEqual([
      [NATIVE_TON, 1.3],
      [TON_USDT, 1],
    ])
    const at = defillamaPrices({ at: new Date('2026-01-01T00:00:00Z'), minConfidence: 0 })
    expect(at.name).toBe('defillama@1767225600')
    expect([...(await at.prices({ tokens: [JET], fetch: fakeFetch }))]).toEqual([[JET, 5]])
    expect(urls).toEqual([
      `https://coins.llama.fi/prices/current/coingecko%3Athe-open-network,ton%3A${USDT},ton%3A${toFriendlyAddress(JET)}`,
      `https://coins.llama.fi/prices/historical/1767225600/ton%3A${toFriendlyAddress(JET)}`,
    ])
  })
})

// ---------------------------------------------------------------------------
// 链上价格：假的 STON.fi v1 router 和 DeDust
// ---------------------------------------------------------------------------

const w = (n: number) => `0:${n.toString(16).padStart(64, 'a')}`
const W_PTON = w(1)
const W_USDT = w(2)
const W_JET = w(3)
const W_JET3 = w(4)
const [P_TON_USDT, P_JET_TON, P_JET_USDT, P_JET2_TON] = [w(10), w(11), w(12), w(13)]
/** 没部署的池子（STON.fi、DeDust） */
const [P_NONE_STONFI, P_NONE_DEDUST] = [w(99), w(98)]
const E9 = 10n ** 9n
const E6 = 10n ** 6n

/** router 钱包 → 池子；池子 → [reserve0, reserve1, wallet0, wallet1] */
const STONFI_POOLS: Record<string, string> = { [`${W_USDT}|${W_PTON}`]: P_TON_USDT, [`${W_JET}|${W_PTON}`]: P_JET_TON, [`${W_JET}|${W_USDT}`]: P_JET_USDT }
const POOL_DATA: Record<string, [bigint, bigint, string, string]> = {
  // TON = 2 USDT（TON 在前），USDT 一侧 200 万
  [P_TON_USDT]: [1_000_000n * E9, 2_000_000n * E6, W_PTON, W_USDT],
  // JET = 50 TON = 100 美元，TON 一侧 10 万美元
  [P_JET_TON]: [1000n * E9, 50_000n * E9, W_JET, W_PTON],
  // JET = 500 USDT，但 USDT 一侧只有 5000 美元：不用
  [P_JET_USDT]: [10n * E9, 5000n * E6, W_JET, W_USDT],
}

function fakeChain() {
  const calls: string[] = []
  const stack = (entries: Array<bigint | Cell>) => entries.map((e) => (typeof e === 'bigint' ? { type: 'num', value: `0x${e.toString(16)}` } : { type: 'cell', value: e.toBase64() }))
  const addr = (a: string) => beginCell().storeAddress(a).endCell()
  const argAddress = (v: { value: string }) => {
    const a = Cell.fromBase64(v.value).beginParse().loadAddress()
    return a ? `${a.workchain}:${[...a.hash].map((b) => b.toString(16).padStart(2, '0')).join('')}` : ''
  }
  const transport: TonTransport = {
    async get(path, query) {
      calls.push(path)
      if (path === 'jetton/masters') {
        const list = query.address as string[]
        return { jetton_masters: list.map((a) => ({ address: a, jetton_content: { decimals: a === TON_USDT ? '6' : '9' } })) } as never
      }
      if (path === 'jetton/wallets') {
        const wallets: Record<string, [string, string]> = { [PTON_V1_MASTER]: [W_PTON, '1000'], [TON_USDT]: [W_USDT, '500'], [JET]: [W_JET, '100'], [JET3]: [W_JET3, '50'] }
        const hit = wallets[query.jetton_address as string]
        return { jetton_wallets: hit && (query.owner_address as string[]).includes(STONFI_V1_ROUTER) ? [{ address: hit[0], owner: STONFI_V1_ROUTER, balance: hit[1] }] : [] } as never
      }
      if (path === 'accountStates') {
        return { accounts: (query.address as string[]).map((a) => ({ address: a, balance: '1', status: a === P_NONE_STONFI || a === P_NONE_DEDUST ? 'nonexist' : 'active' })) } as never
      }
      throw new Error(`unexpected ${path}`)
    },
    async post(path, body) {
      const { address, method, stack: args } = body as { address: string; method: string; stack: Array<{ value: string }> }
      calls.push(method)
      if (address === STONFI_V1_ROUTER && method === 'get_pool_address') {
        const [a, b] = args.map(argAddress)
        const pool = STONFI_POOLS[`${a}|${b}`] ?? STONFI_POOLS[`${b}|${a}`]
        return { exit_code: 0, stack: stack([addr(pool ?? P_NONE_STONFI)]) } as never
      }
      if (address === DEDUST_FACTORY && method === 'get_pool_address') {
        const [, a, b] = args.map((x) => (x.value.startsWith('0x') ? '' : dedustAsset(Cell.fromBase64(x.value))))
        const pair = [a, b].sort().join('|')
        const pool = pair === [NATIVE_TON, JET2].sort().join('|') ? P_JET2_TON : P_NONE_DEDUST
        return { exit_code: 0, stack: stack([addr(pool)]) } as never
      }
      const data = POOL_DATA[address]
      if (data && method === 'get_pool_data') return { exit_code: 0, stack: stack([data[0], data[1], addr(data[2]), addr(data[3]), 20n, 10n, 10n]) } as never
      if (address === P_JET2_TON && method === 'get_assets') return { exit_code: 0, stack: stack([dedustAssetCell(JET2), dedustAssetCell(NATIVE_TON)]) } as never
      // JET2 = 0.02 TON，TON 一侧 2 万个（4 万美元）
      if (address === P_JET2_TON && method === 'get_reserves') return { exit_code: 0, stack: stack([1_000_000n * E9, 20_000n * E9]) } as never
      return { exit_code: -13, stack: [] } as never
    },
  }
  return { transport, calls }
}

describe('链上价格', () => {
  beforeEach(() => resetPriceCache())

  it('TON 对 USD₮，Jetton 用计价币一侧最深的合格池子；STON.fi 没有的走 DeDust', async () => {
    const { transport, calls } = fakeChain()
    const ton = new TonClient(transport)
    const list = await tokenPrices(ton, [NATIVE_TON, USDT, JET, JET2, JET3], { sources: [onchainPrices()] })
    expect(list.map((p) => [p.price, p.source])).toEqual([
      [2, 'onchain'],
      [1, 'onchain'],
      [100, 'onchain'],
      [0.04, 'onchain'],
      [null, null],
    ])
    // 没部署的池子（JET3 的）不读储备；DeDust 的 Jetton 只看对 TON 的池子
    expect(calls.filter((c) => c === 'get_pool_data')).toHaveLength(3)
    expect(calls.filter((c) => c === 'get_reserves')).toHaveLength(1)
    expect(calls.filter((c) => c === 'get_pool_address')).toHaveLength(1 + 4 + 2)
    // 池子地址、DeDust 池子的资产、router 钱包有缓存：第二次只查精度、部署状态和储备
    calls.length = 0
    await tokenPrices(ton, [JET, JET2, JET3], { sources: [onchainPrices()] })
    expect(calls.sort()).toEqual(['accountStates', 'accountStates', 'accountStates', 'get_pool_data', 'get_pool_data', 'get_pool_data', 'get_reserves', 'jetton/masters'])
  })

  it('流动性下限、只用某些协议、测试网和没有客户端', async () => {
    const { transport } = fakeChain()
    const ton = new TonClient(transport)
    // 下限提高到 15 万：JET 的 TON 池子（10 万）也不用了
    expect((await onchainPrices({ minLiquidityUsd: 150_000 }).prices({ tokens: [NATIVE_TON, JET], fetch, client: ton })).get(JET)).toBeUndefined()
    // 只用 DeDust：TON/USD₮ 没有 DeDust 池子，TON 没有价格，JET2 也算不出来
    expect([...(await onchainPrices({ protocols: ['dedust'] }).prices({ tokens: [JET2, TON_USDT], fetch, client: ton }))]).toEqual([[TON_USDT, 1]])
    expect((await onchainPrices().prices({ tokens: [NATIVE_TON], fetch, client: new TonClient(transport, { network: 'testnet' }) })).size).toBe(0)
    await expect(onchainPrices().prices({ tokens: [NATIVE_TON], fetch })).rejects.toThrow('TonClient')
  })
})
