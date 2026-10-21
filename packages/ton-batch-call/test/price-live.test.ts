/**
 * 链上价格连主网，和 DefiLlama 对比（相差不超过 2%），默认跳过：
 * `LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/price-live.test.ts`（TONCENTER_API_KEY 可选，快很多；没有 Key 时资产总值要几分钟：示例地址持有约 20 个没有价格的空投代币）
 */
import { describe, expect, it } from 'vitest'

import { NATIVE_TON, TonClient, ToncenterTransport, type TonTransport } from '../src/index.js'
import { defillamaPrices, onchainPrices, portfolio, tokenPrices } from '../src/subpaths/price.js'

const live = process.env.LIVE ? describe : describe.skip

/** 记下请求数的 toncenter */
let requests = 0
const node = new ToncenterTransport('https://toncenter.com/api/v3', process.env.TONCENTER_API_KEY ? { apiKey: process.env.TONCENTER_API_KEY } : {})
const counting: TonTransport = {
  get: (path, query, options) => (requests++, node.get(path, query, options)),
  post: (path, body, options) => (requests++, node.post(path, body, options)),
}
const ton = new TonClient(counting)

// TON、NOT、DOGS、STON
const TOKENS = [NATIVE_TON, 'EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT', 'EQCvxJy4eG8hyHBFsZ7eePxrRsUQSFE_jpptRAYBmcG_DOGS', 'EQA2kCVNwVsil2EM2mB0SkXytxCqQjS4mttjDpnXmwG9T6bO']

/** 持有 DeDust TON/USD₮ 和 STON.fi v2 USD₮/TON LP 的地址（2026-10 时的真实仓位） */
const LP_OWNER = '0:489595F65115A45C24A0DD0176309654FB00B95E40682F0C3E85D5A4D86DFB25'

live('链上价格（主网）', { timeout: 900_000 }, () => {
  it('和 DefiLlama 相差不超过 2%', async () => {
    const llama = await tokenPrices(ton, TOKENS, { sources: [defillamaPrices()] })
    requests = 0
    const started = Date.now()
    const onchain = await tokenPrices(ton, TOKENS, { sources: [onchainPrices()] })
    console.log(`onchain: ${requests} requests, ${Date.now() - started} ms`)
    TOKENS.forEach((t, i) => {
      const a = llama[i]?.price
      const b = onchain[i]?.price
      console.log(t, 'defillama', a, 'onchain', b, `${(((b as number) / (a as number) - 1) * 100).toFixed(3)}%`)
      expect([t, typeof a, typeof b]).toEqual([t, 'number', 'number'])
      expect(Math.abs((b as number) / (a as number) - 1)).toBeLessThan(0.02)
    })
    expect(onchain.every((p) => p.source === 'onchain')).toBe(true)
    // 第二次：池子地址等有缓存
    requests = 0
    await tokenPrices(ton, TOKENS, { sources: [onchainPrices()] })
    console.log(`onchain (cached): ${requests} requests`)
  })

  it('资产总值：代币 + LP 仓位', async () => {
    requests = 0
    const p = await portfolio(ton, LP_OWNER, { lp: true })
    console.log(`portfolio: ${requests} requests, total ${p.totalUsd.toFixed(2)} (tokens ${p.tokensUsd.toFixed(2)}, lp ${p.lpUsd.toFixed(2)}), ${p.tokens.length} tokens, ${p.lp.length} lp, unpriced ${p.unpriced}`)
    console.log(p.tokens.slice(0, 5).map((t) => `${t.symbol} ${t.formatted} × ${t.price} = ${t.value} (${t.priceSource})`))
    expect(p.lp.length).toBeGreaterThan(0)
    expect(p.lpUsd).toBeGreaterThan(0)
    expect(p.totalUsd).toBeCloseTo(p.tokensUsd + p.lpUsd, 6)
    expect(p.tokens.some((t) => t.native)).toBe(true)
    // 开启 lp 时 LP Jetton 不算作代币
    expect(p.tokens.some((t) => p.lp.some((l) => l.pool === t.token))).toBe(false)
  })
})
