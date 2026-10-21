/**
 * 链上价格连主网，和 DefiLlama 对比（相差不超过 2%），默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/price-live.test.ts`
 * - SOLANA_RPC：自己的节点；默认官方节点（关闭批量合并：官方节点对批量请求限频更严）
 */
import { describe, expect, it } from 'vitest'

import { HttpRpc, NATIVE_MINT, SolanaClient } from '../src/index.js'
import { defillamaPrices, onchainPrices, portfolio, tokenPrices } from '../src/subpaths/price.js'

const live = process.env.LIVE ? describe : describe.skip
const client = new SolanaClient(new HttpRpc(process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com', { batch: false }), { cluster: 'mainnet' })

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
// SOL、USDC、JUP、BONK、RAY、JTO、WIF
const MINTS = [
  NATIVE_MINT,
  USDC,
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
]

live('链上价格（Solana 主网）', { timeout: 120_000 }, () => {
  it('和 DefiLlama 相差不超过 2%', async () => {
    const [llama, onchain] = await Promise.all([tokenPrices(client, MINTS, { sources: [defillamaPrices()] }), tokenPrices(client, MINTS, { sources: [onchainPrices()] })])
    const rows = MINTS.map((m, i) => ({ mint: m, defillama: llama[i]?.price, onchain: onchain[i]?.price }))
    console.table(rows.map((r) => ({ ...r, diff: r.defillama && r.onchain ? `${((r.onchain / r.defillama - 1) * 100).toFixed(3)}%` : null })))
    for (const r of rows) {
      expect([r.mint, typeof r.defillama, typeof r.onchain]).toEqual([r.mint, 'number', 'number'])
      expect(Math.abs((r.onchain as number) / (r.defillama as number) - 1)).toBeLessThan(0.02)
    }
    expect(onchain.every((p) => p.source === 'onchain')).toBe(true)
    expect(onchain[0]?.native).toBe(true)
  })

  it('DefiLlama 历史价格', async () => {
    const [sol] = await tokenPrices(client, [NATIVE_MINT], { sources: [defillamaPrices({ at: new Date('2026-01-01T00:00:00Z') })] })
    expect(sol?.source).toBe('defillama@1767225600')
    expect(sol?.price).toBeGreaterThan(0)
  })

  it('资产总值：指定代币（ATA，免费节点也能用）', async () => {
    // Raydium AMM v4 的权限地址持有大量 SOL 和代币，作为示例地址
    const p = await portfolio(client, '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', { tokens: [NATIVE_MINT, USDC] })
    expect(p.tokens.length).toBeGreaterThan(0)
    expect(p.totalUsd).toBeCloseTo(p.tokensUsd, 6)
    expect(p.tokensUsd).toBeGreaterThan(0)
  })
})
