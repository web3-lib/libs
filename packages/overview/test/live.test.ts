/**
 * 连主网的真实节点，每条链一个知名地址，默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/live.test.ts`
 * 链包从同一个仓库的源码加载（和应用传 loader 的写法等价）
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { getOverview, type OverviewLoaders } from '../src/index.js'

const live = process.env.LIVE ? describe : describe.skip

const src = (pkg: string, path: string) => fileURLToPath(new URL(`../../${pkg}/src/subpaths/${path}.ts`, import.meta.url))
const loaders: OverviewLoaders = {
  evm: () => import(/* @vite-ignore */ src('evm-batch-call', 'price')),
  evmApprovals: () => import(/* @vite-ignore */ src('evm-batch-call', 'approvals')),
  solana: () => import(/* @vite-ignore */ src('solana-batch-call', 'price')),
  solanaApprovals: () => import(/* @vite-ignore */ src('solana-batch-call', 'approvals')),
  sui: () => import(/* @vite-ignore */ src('sui-batch-call', 'price')),
  ton: () => import(/* @vite-ignore */ src('ton-batch-call', 'price')),
}

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const TRON_HOLDER = 'TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G' // Binance
const SOLANA_HOLDER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9' // Binance
const SUI_HOLDER = '0x9f63425709069336fec108bd4ba69a8f3d23e8ab237311f3ce58ae2bb0ed4d7f' // 持有 USDC
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SOL_USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const SUI = '0x2::sui::SUI'
const SUI_USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
const TON_HOLDER = 'UQAj-peZGPH-cC25EAv4Q-h8cBXszTmkch6ba6wXC8BM40qt' // 持有 USDT

live('多链总览（主网）', { timeout: 240_000 }, () => {
  it('五种链各一个知名地址：合计、分链、跨链合并、授权', async () => {
    const seen: string[] = []
    const o = await getOverview(
      {
        evm: { address: VITALIK, chains: [1, 8453, 56] },
        tron: { address: TRON_HOLDER },
        solana: { address: SOLANA_HOLDER, tokens: [SOL_USDC, SOL_USDT] },
        sui: { address: SUI_HOLDER, portfolio: { coinTypes: [SUI, SUI_USDC] } },
      },
      { loaders, approvals: true, minUsd: 1, onChain: (r) => seen.push(r.chain) },
    )
    for (const c of o.byChain) console.log(c.chain, c.status, c.totalUsd.toFixed(2), `${c.tokens.length} tokens`, `${c.ms}ms`, c.error ?? '', c.warnings)
    console.log('total', o.totalUsd.toFixed(2), 'assets', o.tokens.slice(0, 6).map((t) => `${t.key}:${t.usd.toFixed(0)}`).join(' '), 'approvals', o.approvals && { ...o.approvals, items: o.approvals.items.length })
    expect(seen.sort()).toEqual(['evm:1', 'evm:56', 'evm:8453', 'solana', 'sui', 'tron'])
    expect(o.errors).toEqual([])
    for (const c of o.byChain) {
      expect(c.totalUsd, c.chain).toBeGreaterThan(0)
      expect(c.tokens.length, c.chain).toBeGreaterThan(0)
    }
    expect(o.totalUsd).toBeCloseTo(o.byChain.reduce((s, c) => s + c.totalUsd, 0), 6)
    // 稳定币跨链合并成一项
    const usdc = o.tokens.find((t) => t.key === 'USDC')
    expect(usdc?.chains.length).toBeGreaterThan(1)
    expect(o.approvals).toBeDefined()
  })

  // toncenter 免费额度按 IP 限频（每秒 1 次），被限流时超时：设置 TONCENTER_API_KEY 可稳定通过
  it('TON', async () => {
    const o = await getOverview(
      { ton: { address: TON_HOLDER, node: process.env.TONCENTER_API_KEY ? { apiKey: process.env.TONCENTER_API_KEY } : {} } },
      { loaders, minUsd: 1, chainTimeoutMs: 90_000 },
    )
    const c = o.byChain[0]
    console.log('ton', c?.status, c?.totalUsd, c?.error)
    if (c?.status === 'error' && !process.env.TONCENTER_API_KEY) {
      expect(c.error).toMatch(/timed out|429|rate/i)
      return
    }
    expect(c?.status).toBe('ok')
    expect(o.tokens.some((t) => t.key === 'USDT')).toBe(true)
  })

  it('一条链出错时其余链照常返回', async () => {
    const o = await getOverview(
      { evm: { address: VITALIK, chains: [1, { chainId: 8453, node: { provider: 'http://127.0.0.1:1' } }] } },
      { loaders, chainTimeoutMs: 20_000 },
    )
    expect(o.byChain.find((c) => c.chain === 'evm:1')?.status).toBe('ok')
    expect(o.errors.map((e) => e.chain)).toEqual(['evm:8453'])
    expect(o.totalUsd).toBeGreaterThan(0)
  })
})
