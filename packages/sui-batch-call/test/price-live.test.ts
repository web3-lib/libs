/**
 * 链上价格连主网，和 DefiLlama 对比（相差不超过 2%），默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/price-live.test.ts`
 */
import { describe, expect, it } from 'vitest'

import { SUI_COIN_TYPE, SuiClient } from '../src/index.js'
import { defillamaPrices, onchainPrices, portfolio, tokenPrices } from '../src/subpaths/price.js'

const live = process.env.LIVE ? describe : describe.skip
const sui = new SuiClient(process.env.SUI_GRPC)

// SUI、USDC、CETUS、DEEP、WAL
const COINS = [
  SUI_COIN_TYPE,
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS',
  '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP',
  '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
]
/** 2026-10 时有 Momentum 仓位的地址（demo 的示例） */
const LP_OWNER = '0xd296f7f43c8c48f1de676eb898398bd36401a16cec5000245c19626b2897c359'

live('链上价格（Sui 主网）', { timeout: 120_000 }, () => {
  it('和 DefiLlama 相差不超过 2%；Cetus、Turbos 单独也能给出 SUI 的价格', async () => {
    const [llama, onchain] = await Promise.all([tokenPrices(sui, COINS, { sources: [defillamaPrices()] }), tokenPrices(sui, COINS, { sources: [onchainPrices()] })])
    COINS.forEach((t, i) => {
      const a = llama[i]?.price
      const b = onchain[i]?.price
      expect([t, typeof a, typeof b]).toEqual([t, 'number', 'number'])
      expect(Math.abs((b as number) / (a as number) - 1)).toBeLessThan(0.02)
    })
    expect(onchain.every((p) => p.source === 'onchain')).toBe(true)
    const sui0 = llama[0]?.price as number
    // FlowX 的 SUI / 稳定币池子（2026-10）稳定币一侧都不到 1 万美元，单独用时 SUI 没有价格
    for (const protocol of ['cetus', 'turbos'] as const) {
      const [p] = await tokenPrices(sui, [SUI_COIN_TYPE], { sources: [onchainPrices({ protocols: [protocol] })] })
      expect([protocol, Math.abs((p?.price as number) / sui0 - 1) < 0.02]).toEqual([protocol, true])
    }
  })

  it('历史价格', async () => {
    const [p] = await tokenPrices(sui, [SUI_COIN_TYPE], { sources: [defillamaPrices({ at: new Date('2026-01-01T00:00:00Z') })] })
    expect(p?.source).toBe('defillama@1767225600')
    expect(p?.price).toBeGreaterThan(0)
  })
})

live('资产总值（Sui 主网）', { timeout: 120_000 }, () => {
  it('代币 + LP 仓位', async () => {
    const p = await portfolio(sui, LP_OWNER, { lp: { protocols: ['momentum'] }, minUsd: 1 })
    expect(p.lp.length).toBeGreaterThan(0)
    expect(p.lpUsd).toBeGreaterThan(0)
    expect(p.totalUsd).toBeCloseTo(p.tokensUsd + p.lpUsd, 6)
    expect(p.tokens.every((t) => (t.value ?? 0) >= 1)).toBe(true)
  })
})
