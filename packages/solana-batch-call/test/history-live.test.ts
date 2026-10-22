/**
 * 交易历史连主网，默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/history-live.test.ts`
 * - SOLANA_RPC：自己的节点；默认内置公共节点（getTransaction 逐笔请求，publicnode 不接受批量）
 * 用交易所热钱包（转账多）翻页，再从 Raydium CLMM 池子最近的一笔交易里找到交易者，查它的兑换
 */
import { describe, expect, it } from 'vitest'

import { SolanaClient } from '../src/index.js'
import { getHistory } from '../src/subpaths/history.js'

const live = process.env.LIVE ? describe : describe.skip
const client = new SolanaClient(process.env.SOLANA_RPC)

/** 有 SOL 和 USDC 的系统账户（Coinbase 热钱包） */
const WHALE = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
const RAYDIUM_SOL_USDC = '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv'

live('交易历史（Solana 主网）', { timeout: 300_000 }, () => {
  it('分页：游标是最后一条签名，下一页接着往后', async () => {
    const first = await getHistory(WHALE, { limit: 8 })
    console.table(first.items.map((a) => ({ hash: a.hash.slice(0, 8), type: a.type, dir: a.direction, label: a.label?.slice(0, 60), fee: a.fee })))
    expect(first.items).toHaveLength(8)
    expect(first.nextCursor).toBe(first.items[7]?.hash)
    const second = await getHistory(WHALE, { limit: 5, cursor: first.nextCursor })
    expect(second.items).toHaveLength(5)
    expect(second.items[0]?.time).toBeLessThanOrEqual(first.items[7]?.time as number)
    expect(second.items.some((a) => first.items.some((b) => b.hash === a.hash))).toBe(false)
    // 热钱包主要是 SOL / USDC 转账
    const transfers = [...first.items, ...second.items].filter((a) => a.type === 'transfer')
    expect(transfers.length).toBeGreaterThan(0)
    expect(transfers.every((a) => a.changes.length > 0 && a.direction && a.counterparty)).toBe(true)
    expect(transfers.some((a) => a.changes.some((c) => c.symbol === 'USDC'))).toBe(true)
  })

  it('兑换：按类型过滤、协议、资产变化', async () => {
    const sigs = await client.request<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [RAYDIUM_SOL_USDC, { limit: 10 }])
    const tx = await client.request<{ transaction: { message: { accountKeys: string[] } } }>('getTransaction', [sigs.find((s) => !s.err)?.signature, { encoding: 'json', maxSupportedTransactionVersion: 1 }])
    const trader = tx.transaction.message.accountKeys[0] as string
    const page = await getHistory(trader, { limit: 3, types: ['swap'] })
    console.table(page.items.map((a) => ({ type: a.type, protocol: a.protocol, label: a.label?.slice(0, 80), changes: a.changes.length })))
    expect(page.items.length).toBeGreaterThan(0)
    for (const a of page.items) {
      expect(a.type).toBe('swap')
      expect(a.changes.some((c) => c.delta.startsWith('-'))).toBe(true)
      expect(a.changes.some((c) => !c.delta.startsWith('-'))).toBe(true)
      expect(a.changes.every((c) => c.symbol && !c.symbol.includes('…'))).toBe(true)
    }
  })

  it('时间范围：after 之前的不看', async () => {
    const now = Math.floor(Date.now() / 1000)
    const page = await getHistory(WHALE, { limit: 100, after: now - 60 })
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.every((a) => a.time >= now - 60)).toBe(true)
    expect(page.nextCursor).toBeUndefined()
  })
})
