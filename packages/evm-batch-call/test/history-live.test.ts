/**
 * 历史记录连真实数据源（Blockscout、公共 RPC、TronGrid），默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/history-live.test.ts`
 */
import { describe, expect, it } from 'vitest'

import { Provider, TRON_CHAIN_ID } from '../src/index.js'
import { blockscoutSource, history, rpcSource } from '../src/subpaths/history.js'

const live = process.env.LIVE ? describe : describe.skip
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
// Blockscout 公共实例按请求数限流（一页 3~5 个请求），关掉 NFT 的两个请求

live('历史记录（以太坊）', { timeout: 240_000 }, () => {
  const provider = new Provider(1)
  const eth = new Provider(1)

  it('Blockscout：分页、类型、手续费', async () => {
    const page = await history(provider, VITALIK, { source: 'blockscout', limit: 15, nft: false })
    expect(page.source).toBe('blockscout')
    expect(page.items.length).toBeGreaterThanOrEqual(15)
    expect(page.nextCursor).toMatch(/^p:\d+$/)
    for (const a of page.items) {
      expect(a.hash).toMatch(/^0x[0-9a-f]{64}$/)
      expect(a.time).toBeGreaterThan(1.4e9)
      expect(['transfer', 'swap', 'approve', 'liquidity', 'mint', 'contract', 'other']).toContain(a.type)
    }
    // 时间递减、第二页不和第一页重复
    const times = page.items.map((a) => a.time)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    const next = await history(provider, VITALIK, { source: 'blockscout', limit: 15, cursor: page.nextCursor, nft: false })
    const first = new Set(page.items.map((a) => a.hash))
    expect(next.items.every((a) => !first.has(a.hash))).toBe(true)
    expect(next.items[0]?.time).toBeLessThanOrEqual(times[times.length - 1] as number)
    const sent = page.items.find((a) => a.fee !== undefined)
    console.log(page.items.slice(0, 6).map((a) => `${a.type} ${a.direction ?? ''} ${a.label}`))
    if (sent) expect(BigInt(sent.fee as string)).toBeGreaterThan(0n)
  })

  it('Blockscout：按类型过滤 + 识别兑换', async () => {
    // 取以太坊上 Uniswap Universal Router 最近的调用者，他们的历史里应该有兑换
    const router = await blockscoutSource().fetch({ address: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af', chainId: 1, limit: 10, nft: false, provider, fetch })
    const traders = [...new Set(router.txs.map((t) => t.from))].slice(0, 3)
    const found = (await Promise.all(traders.map((t) => history(provider, t, { source: 'blockscout', limit: 3, types: ['swap'], maxPages: 3, nft: false })))).flatMap((p) => p.items)
    console.log(found.slice(0, 5).map((a) => `${a.protocol ?? ''} ${a.label}`))
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((a) => a.type === 'swap' && a.changes.length >= 2)).toBe(true)
  })

  it('故障切换：第一个来源失败时用下一个', async () => {
    const broken = { name: 'broken', fetch: () => Promise.reject(new Error('boom')) }
    const page = await history(provider, VITALIK, { source: [broken, blockscoutSource()], limit: 5, nft: false })
    expect(page.source).toBe('blockscout')
    expect(page.items.length).toBeGreaterThan(0)
  })

  it('RPC 日志：代币转账 + 手续费，分页', async () => {
    const page = await history(eth, VITALIK, { source: [rpcSource({ window: 1000, maxWindows: 20 })], limit: 5 })
    console.log(page.source, page.items.map((a) => `${a.type} ${a.label}`), page.nextCursor)
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.every((a) => a.changes.length > 0 || a.type !== 'transfer')).toBe(true)
    const next = await history(eth, VITALIK, { source: [rpcSource({ window: 1000, maxWindows: 20 })], limit: 5, cursor: page.nextCursor })
    expect(next.items.every((a) => !page.items.some((p) => p.hash === a.hash))).toBe(true)
  })
})

live('历史记录（Tron）', { timeout: 120_000 }, () => {
  it('TronGrid：TRX / TRC20', async () => {
    const provider = new Provider(TRON_CHAIN_ID.mainnet)
    const page = await history(provider, 'TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G', { limit: 10 })
    console.log(page.items.slice(0, 6).map((a) => `${a.type} ${a.label} fee=${a.fee}`))
    expect(page.source).toBe('trongrid')
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(page.nextCursor).toBeTruthy()
  })
})
