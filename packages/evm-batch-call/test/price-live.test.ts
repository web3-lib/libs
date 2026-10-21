/**
 * 链上价格连主网，和 DefiLlama 对比（相差不超过 2%），默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/price-live.test.ts`
 */
import { describe, expect, it } from 'vitest'

import { NATIVE_TOKEN, Provider, TRON_CHAIN_ID } from '../src/index.js'
import { defillamaPrices, onchainPrices, portfolio, tokenPrices } from '../src/subpaths/price.js'

const live = process.env.LIVE ? describe : describe.skip

const CASES: Record<number, string[]> = {
  // 主币、UNI、LINK、PEPE
  1: [NATIVE_TOKEN, '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', '0x514910771AF9Ca656af840dff83E8264EcF986CA', '0x6982508145454Ce325dDbE47a25d4ec3d2311933'],
  // 主币、USDT、CAKE、ETH、BTCB
  56: [NATIVE_TOKEN, '0x55d398326f99059fF775485246999027B3197955', '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c'],
  // 主币、SUN、USDT、WIN
  [TRON_CHAIN_ID.mainnet]: [NATIVE_TOKEN, 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7'],
}

for (const [chain, tokens] of Object.entries(CASES)) {
  live(`链上价格（${chain}）`, { timeout: 120_000 }, () => {
    it('和 DefiLlama 相差不超过 2%', async () => {
      const provider = new Provider(Number(chain))
      const [llama, onchain] = await Promise.all([tokenPrices(provider, tokens, { sources: [defillamaPrices()] }), tokenPrices(provider, tokens, { sources: [onchainPrices()] })])
      tokens.forEach((t, i) => {
        const a = llama[i]?.price
        const b = onchain[i]?.price
        expect([t, typeof a, typeof b]).toEqual([t, 'number', 'number'])
        expect(Math.abs((b as number) / (a as number) - 1)).toBeLessThan(0.02)
      })
      expect(onchain.every((p) => p.source === 'onchain')).toBe(true)
    })
  })
}

live('资产总值（BSC）', { timeout: 120_000 }, () => {
  it('代币 + LP 仓位', async () => {
    const p = await portfolio(new Provider(56), '0xb2709AeE04A6aaA04613ADf0f5397e04Eb609f6F', { tokens: [NATIVE_TOKEN, '0x55d398326f99059fF775485246999027B3197955'], lp: true })
    expect(p.lp.length).toBeGreaterThan(0)
    expect(p.totalUsd).toBeCloseTo(p.tokensUsd + p.lpUsd, 6)
    expect(p.lpUsd).toBeGreaterThan(0)
  })
})
