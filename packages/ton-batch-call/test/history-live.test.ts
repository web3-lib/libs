/**
 * 历史连主网（toncenter /actions、/transactions + /jetton/transfers），默认跳过：
 * `LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/history-live.test.ts`（TONCENTER_API_KEY 可选）
 * 用的是一个常有兑换的 v5r1 钱包（别人的地址，只读）
 */
import { describe, expect, it } from 'vitest'

import { TonClient } from '../src/index.js'
import { history, toncenterTransactions } from '../src/subpaths/history.js'

const live = process.env.LIVE ? describe : describe.skip
const ton = new TonClient(undefined, process.env.TONCENTER_API_KEY ? { apiKey: process.env.TONCENTER_API_KEY } : { timeout: 30_000 })
const ADDRESS = 'UQCHY3ke1FpJ6rpDOqrxrIuooJ1pE5XFUz0P-rAXgmBqWBEW'

live('历史（主网）', { timeout: 300_000 }, () => {
  it('/actions：兑换、转账分类，翻页不重复；types 过滤', async () => {
    const page = await history(ton, ADDRESS, { limit: 10 })
    console.log(JSON.stringify(page.items.slice(0, 4), null, 1), page.nextCursor?.slice(0, 40))
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.map((i) => i.type)).toContain('swap')
    const swap = page.items.find((i) => i.type === 'swap')
    expect(swap?.changes.length).toBe(2)
    expect(swap?.changes.some((c) => BigInt(c.delta) < 0n) && swap?.changes.some((c) => BigInt(c.delta) > 0n)).toBe(true)
    expect(page.items.every((i) => /^[0-9a-f]{64}$/.test(i.hash) && i.time > 0)).toBe(true)
    expect(page.items.map((i) => i.time)).toEqual([...page.items.map((i) => i.time)].sort((x, y) => y - x))
    const next = await history(ton, ADDRESS, { limit: 10, cursor: page.nextCursor })
    const seen = new Set(page.items.map((i) => i.hash))
    expect(next.items.length).toBeGreaterThan(0)
    expect(next.items.filter((i) => seen.has(i.hash))).toEqual([])
    const swaps = await history(ton, ADDRESS, { limit: 3, types: ['swap'] })
    expect(swaps.items.length).toBeGreaterThan(0)
    expect(swaps.items.every((i) => i.type === 'swap')).toBe(true)
  })

  it('退路：/transactions + /jetton/transfers；第一个适配器出错时自动换', async () => {
    const page = await history(ton, ADDRESS, { limit: 10, adapters: [toncenterTransactions()] })
    console.log(JSON.stringify(page.items.slice(0, 3), null, 1), page.nextCursor)
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.nextCursor).toMatch(/^transactions:\d+,\d+$/)
    const broken = await history(ton, ADDRESS, { limit: 5, adapters: [{ name: 'broken', fetch: async () => Promise.reject(new Error('boom')) }, toncenterTransactions()] })
    expect(broken.items.length).toBeGreaterThan(0)
    expect(broken.nextCursor?.startsWith('transactions:')).toBe(true)
  })
})
