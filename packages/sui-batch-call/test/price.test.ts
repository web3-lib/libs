/**
 * 价格源的组合、DefiLlama 的请求、链上价格（假节点上的 Cetus / Turbos / FlowX 池子）、资产总值（不连网络）
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { SUI_COIN_TYPE, SuiClient, normalizeStructTag, normalizeSuiAddress, resetCoinCache } from '../src/index.js'
import { combinePrices, defillamaPrices, onchainPrices, portfolio, priceKeyOf, tokenPrices, type SuiPriceSource } from '../src/subpaths/price.js'
import { CETUS } from '../src/cetus.js'
import { createFakeNode, type FakeObject, type FakeState } from './fakeNode.js'

const USDC = normalizeStructTag('0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC')
const CETUS_COIN = normalizeStructTag('0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS')
const DEEP = normalizeStructTag('0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP')
const OWNER = normalizeSuiAddress('0xa1')
const TURBOS = '0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1'
const FLOWX = '0x25929e7f29e0a30eb4e692952ba1b5b65a3a4d65ab5f2a32e1ba3edcb587f26d'
const FEE3000 = `${TURBOS.slice(2)}::fee3000bps::FEE3000BPS`

/** sqrt 价格（Q64.64）：raw = coinB / coinA 的最小单位之比 */
const sqrtOf = (raw: number) => BigInt(Math.round(Math.sqrt(raw) * 2 ** 64)).toString()

const fixed = (name: string, prices: Record<string, number>, seen: string[][] = []): SuiPriceSource => ({
  name,
  async prices(ctx) {
    seen.push([...ctx.coinTypes])
    return new Map(Object.entries(prices).filter(([k]) => ctx.coinTypes.includes(k)))
  },
})

function state(objects: FakeObject[] = []): FakeState {
  return {
    chain: 'mainnet',
    checkpoint: 1000,
    balances: { [OWNER]: { [SUI_COIN_TYPE]: 1_500_000_000n, [USDC]: 2_500_000n, [`${normalizeSuiAddress('0x9')}::junk::JUNK`]: 7n } },
    coins: { [USDC]: { decimals: 6, symbol: 'USDC' }, [CETUS_COIN]: { decimals: 9, symbol: 'CETUS' }, [DEEP]: { decimals: 6, symbol: 'DEEP' } },
    objects,
  }
}

const clientOf = (s: FakeState) => new SuiClient('https://node.test', { fetch: createFakeNode(s).fetch })

beforeEach(() => resetCoinCache())

describe('price sources', () => {
  it('前面的源没有的价格交给后面的源，记下来源；出错的源跳过；类型规范化，不合法的为 null', async () => {
    const seen: string[][] = []
    const broken: SuiPriceSource = { name: 'broken', prices: async () => Promise.reject(new Error('down')) }
    const errors: string[] = []
    const list = await tokenPrices(clientOf(state()), ['0x2::sui::SUI', USDC, CETUS_COIN, 'not a type', DEEP], {
      sources: [broken, fixed('a', { [USDC]: 1 }, seen), fixed('b', { [SUI_COIN_TYPE]: 3, [CETUS_COIN]: 0.1, [USDC]: 9 }, seen)],
      onError: (s) => errors.push(s.name),
    })
    expect(errors).toEqual(['broken'])
    expect(list.map((p) => [p.token, p.native, p.price, p.source])).toEqual([
      ['0x2::sui::SUI', true, 3, 'b'],
      [USDC, false, 1, 'a'],
      [CETUS_COIN, false, 0.1, 'b'],
      ['not a type', false, null, null],
      [DEEP, false, null, null],
    ])
    // 第二个源只查第一个源没有的
    expect(seen[1]).toEqual([SUI_COIN_TYPE, CETUS_COIN, DEEP])
  })

  it('combinePrices 组合成一个价格源', async () => {
    const source = combinePrices([fixed('a', { [USDC]: 1 }), fixed('b', { [SUI_COIN_TYPE]: 3 })])
    expect(source.name).toBe('a+b')
    const result = await source.prices({ coinTypes: [USDC, SUI_COIN_TYPE], fetch })
    expect([...result]).toEqual([
      [USDC, 1],
      [SUI_COIN_TYPE, 3],
    ])
    expect(priceKeyOf('0x2::sui::SUI')).toBe(SUI_COIN_TYPE)
  })

  it('DefiLlama：当前和历史价格的地址；键规范化，置信度低的不要', async () => {
    const urls: string[] = []
    const fakeFetch = (async (url: string) => {
      urls.push(url)
      const asked = (url.split('/').pop() ?? '').split(',').map(decodeURIComponent)
      // 返回的键用短格式也能认出来
      const all: Record<string, [string, { price: number; confidence: number }]> = { [`sui:${SUI_COIN_TYPE}`]: ['sui:0x2::sui::SUI', { price: 3, confidence: 0.99 }], [`sui:${USDC}`]: [`sui:${USDC}`, { price: 1, confidence: 0.5 }] }
      return new Response(JSON.stringify({ coins: Object.fromEntries(asked.flatMap((k) => (all[k] ? [all[k]] : []))) }))
    }) as typeof fetch
    const now = await defillamaPrices().prices({ coinTypes: [SUI_COIN_TYPE, USDC], fetch: fakeFetch })
    expect([...now]).toEqual([[SUI_COIN_TYPE, 3]]) // 置信度 0.5 的不要
    const at = defillamaPrices({ at: new Date('2026-01-01T00:00:00Z'), minConfidence: 0 })
    expect(at.name).toBe('defillama@1767225600')
    expect([...(await at.prices({ coinTypes: [USDC], fetch: fakeFetch }))]).toEqual([[USDC, 1]])
    expect(urls).toEqual([
      `https://coins.llama.fi/prices/current/${encodeURIComponent(`sui:${SUI_COIN_TYPE}`)},${encodeURIComponent(`sui:${USDC}`)}`,
      `https://coins.llama.fi/prices/historical/1767225600/${encodeURIComponent(`sui:${USDC}`)}`,
    ])
  })
})

describe('onchainPrices', () => {
  // 条目的对象 ID 是主网上真实存在的（2026-10 核对）：Cetus USDC / SUI（tick spacing 10）、Turbos CETUS / SUI（0.3%）、FlowX USDC / DEEP（0.01%）
  const objects: FakeObject[] = [
    { id: CETUS.globalConfig.objectId, type: `${CETUS.clmm}::config::GlobalConfig`, json: { fee_tiers: { contents: [{ key: 10, value: { fee_rate: '500', tick_spacing: 10 } }] } } },
    {
      id: '0xc294552b2765353bcafa7c359cd28fd6bc237662e5db8f09877558d81669170c',
      type: `${TURBOS}::pool_factory::PoolConfig`,
      json: { fee_map: { contents: [{ key: FEE3000, value: '0x1' }] }, pools: { id: '0x08984ed8705f44b6403705dc248896e56ab7961447820ae29be935ce0d32198b', size: '1' } },
    },
    { id: '0x1f51653f5a9c4764bc25f5771ebd093438b9f1b1a39ddc4b74d3df7e89ed74a1', type: '0x2::dynamic_field::Field', json: { value: { value: { pool_id: '0x51e8' } } } },
    { id: '0xfbfda23fb2f8cfeaa2ad2c95ec1dc19c08255fa5dd8a8c276b4d54be2caa5603', type: '0x2::dynamic_field::Field', json: { value: { pool_id: '0xdf9d' } } },
    { id: '0xbc656eefbc65ccc0141bda54a018ed901ab4a7ea68ba08d2f6cc6d297b117b0d', type: '0x2::dynamic_field::Field', json: { value: '0x2e88' } },
    // 1 USDC = 0.5 SUI（SUI = $2），池子里 100 万 USDC
    { id: '0x51e8', type: `${CETUS.clmm}::pool::Pool<${USDC}, ${SUI_COIN_TYPE}>`, json: { coin_a: '1000000000000', coin_b: '500000000000000', current_sqrt_price: sqrtOf(0.5 * 1e3), is_pause: false } },
    // 1 CETUS = 0.05 SUI（$0.1），池子里 10 万 SUI
    { id: '0xdf9d', type: `${TURBOS}::pool::Pool<${CETUS_COIN}, ${SUI_COIN_TYPE}, 0x${FEE3000}>`, json: { coin_a: '1', coin_b: '100000000000000', sqrt_price: sqrtOf(0.05), unlocked: true } },
    // 1 DEEP = 0.02 USDC，池子里只有 5000 USDC
    { id: '0x2e88', type: `${FLOWX}::pool::Pool<${USDC}, ${DEEP}>`, json: { reserve_x: '5000000000', reserve_y: '1', sqrt_price: sqrtOf(50), locked: false } },
  ]

  it('SUI 按稳定币最深的池子，其他代币按 SUI / 稳定币的池子；深度不够的池子不用', async () => {
    const sui = clientOf(state(objects))
    const list = await tokenPrices(sui, [SUI_COIN_TYPE, USDC, CETUS_COIN, DEEP], { sources: [onchainPrices()] })
    expect(list.map((p) => p.source)).toEqual(['onchain', 'onchain', 'onchain', null])
    expect(list[0]?.price).toBeCloseTo(2, 9)
    expect(list[1]?.price).toBe(1)
    expect(list[2]?.price).toBeCloseTo(0.1, 9)
    const low = await tokenPrices(sui, [DEEP], { sources: [onchainPrices({ minLiquidityUsd: 1000 })] })
    expect(low[0]?.price).toBeCloseTo(0.02, 9)
    // 只用某个 DEX
    const cetusOnly = await tokenPrices(sui, [SUI_COIN_TYPE, CETUS_COIN], { sources: [onchainPrices({ protocols: ['cetus'] })] })
    expect(cetusOnly.map((p) => p.price !== null)).toEqual([true, false])
    // maxCoins 限制找池子的代币数（SUI 总会算）
    const capped = await tokenPrices(sui, [CETUS_COIN, SUI_COIN_TYPE], { sources: [onchainPrices({ maxCoins: 0 })] })
    expect(capped.map((p) => p.price !== null)).toEqual([false, true])
  })

  it('暂停的池子不用；没有客户端时报错', async () => {
    const paused = objects.map((o) => (o.id === '0x51e8' ? { ...o, json: { ...(o.json as object), is_pause: true } } : o))
    const list = await tokenPrices(clientOf(state(paused)), [SUI_COIN_TYPE, CETUS_COIN], { sources: [onchainPrices()] })
    // SUI 没有价格，CETUS 只有对 SUI 的池子，也没有
    expect(list.map((p) => p.price)).toEqual([null, null])
    await expect(onchainPrices().prices({ coinTypes: [SUI_COIN_TYPE], fetch })).rejects.toThrow(/SuiClient/)
  })
})

describe('portfolio', () => {
  it('全部余额 × 价格，按价值排序；minUsd 只影响列出的代币', async () => {
    const sui = clientOf(state())
    const sources = [fixed('a', { [SUI_COIN_TYPE]: 2, [USDC]: 1 })]
    const p = await portfolio(sui, OWNER, { sources })
    expect(p.tokens.map((t) => [t.symbol, t.formatted, t.value, t.priceSource])).toEqual([
      ['SUI', '1.5', 3, 'a'],
      ['USDC', '2.5', 2.5, 'a'],
      [null, null, null, null],
    ])
    expect([p.totalUsd, p.tokensUsd, p.lpUsd, p.unpriced, p.lp]).toEqual([5.5, 5.5, 0, 1, []])
    const filtered = await portfolio(sui, OWNER, { sources, minUsd: 2.6 })
    expect(filtered.tokens.map((t) => t.symbol)).toEqual(['SUI'])
    expect(filtered.totalUsd).toBe(5.5)
    const only = await portfolio(sui, OWNER, { sources, coinTypes: [USDC] })
    expect(only.tokens.map((t) => t.token)).toEqual([USDC])
  })
})
