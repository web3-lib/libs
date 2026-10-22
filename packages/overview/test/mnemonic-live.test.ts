/**
 * 助记词 → 多链总览，连主网的真实节点，默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/mnemonic-live.test.ts`
 * 用公开的测试助记词（abandon … about，各条链上常有别人转进来的零碎资产）；链包从同一个仓库的源码加载
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { OverviewLoaders } from '../src/index.js'
import { getOverviewFromMnemonic } from '../src/subpaths/mnemonic.js'

const live = process.env.LIVE ? describe : describe.skip

const src = (pkg: string, path: string) => fileURLToPath(new URL(`../../${pkg}/src/${path}.ts`, import.meta.url))
const loaders: OverviewLoaders = {
  evm: () => import(/* @vite-ignore */ src('evm-batch-call', 'subpaths/price')),
  solana: () => import(/* @vite-ignore */ src('solana-batch-call', 'subpaths/price')),
  sui: () => import(/* @vite-ignore */ src('sui-batch-call', 'subpaths/price')),
  ton: () => import(/* @vite-ignore */ src('ton-batch-call', 'subpaths/price')),
  tonWrite: () => import(/* @vite-ignore */ src('ton-batch-call', 'subpaths/write')),
  tonCore: () => import(/* @vite-ignore */ src('ton-batch-call', 'index')),
}

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const tonNode = process.env.TONCENTER_API_KEY ? { node: { apiKey: process.env.TONCENTER_API_KEY } } : {}

live('助记词总览（主网）', { timeout: 300_000 }, () => {
  it('abandon … about 的两个账户：五种链都查到，合计等于各账户之和', async () => {
    const r = await getOverviewFromMnemonic(ABANDON, {
      accounts: 2,
      evm: { chains: [1, 56] },
      ton: tonNode,
      loaders,
      minUsd: 0,
      chainTimeoutMs: 90_000,
    })
    for (const a of r.accounts) {
      console.log(`account ${a.index}`, a.addresses, a.ton.map((t) => `${t.version}:${t.status}`))
      for (const c of a.overview.byChain) console.log(' ', c.chain, c.address, c.status, c.totalUsd.toFixed(2), `${c.tokens.length} tokens`, c.error ?? '')
    }
    console.log('total', r.total.totalUsd.toFixed(2), r.warnings)
    expect(r.accounts).toHaveLength(2)
    expect(r.accounts[0]?.addresses.evm).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
    for (const a of r.accounts) expect(a.ton.length).toBeGreaterThan(0)
    const chains = r.total.byChain.filter((c) => c.status !== 'error').map((c) => c.chain)
    for (const chain of ['evm:1', 'evm:56', 'tron', 'solana', 'sui']) expect(chains, chain).toContain(chain)
    expect(r.total.totalUsd).toBeCloseTo(r.accounts.reduce((s, a) => s + a.overview.totalUsd, 0), 6)
  })
})
