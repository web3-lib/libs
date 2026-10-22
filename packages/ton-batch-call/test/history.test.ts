/** 历史：/actions 的分组与分类、交易链被分页截断、游标、适配器故障切换、/transactions 退路（假的 toncenter，不连网络） */
import { describe, expect, it } from 'vitest'

import { TonClient, type TonTransport } from '../src/index.js'
import { history, toncenterTransactions, type HistoryAdapter } from '../src/subpaths/history.js'

const ME = `0:${'11'.repeat(32)}`
const OTHER = `0:${'22'.repeat(32)}`
const POOL = `0:${'33'.repeat(32)}`
const USDT = `0:${'44'.repeat(32)}`
const meta = { [USDT.toUpperCase()]: { token_info: [{ valid: true, type: 'jetton_masters', symbol: 'USD₮', extra: { decimals: '6' } }] } }
const b64 = (n: number) => Buffer.from(String(n).padStart(32, '0')).toString('base64')
const action = (trace: number, type: string, details: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ trace_id: b64(trace), start_utime: 1_000_000 - trace, trace_mc_seqno_end: 7, trace_external_hash_norm: b64(trace + 100), success: true, type, details, ...extra })

const swap = (t: number) => action(t, 'jetton_swap', { dex: 'stonfi_v2', sender: ME, asset_in: USDT, asset_out: null, dex_incoming_transfer: { asset: USDT, amount: '1000000' }, dex_outgoing_transfer: { asset: null, amount: '743854486' } })
const excess = (t: number) => action(t, 'call_contract', { opcode: '0xd53276db', source: POOL, destination: ME, value: '5' })

function fake(pages: Record<string, { actions: unknown[]; next_cursor?: string }>, calls: Array<Record<string, unknown>> = []): TonTransport {
  return {
    async get(path, query) {
      calls.push({ path, ...query })
      if (path === 'actions') {
        if (query.trace_id) return { actions: Object.values(pages).flatMap((p) => p.actions).filter((a) => (a as { trace_id: string }).trace_id === query.trace_id), metadata: meta } as never
        const page = pages[String(query.cursor ?? 'first')]
        if (!page) throw new Error('no page')
        return { ...page, metadata: meta } as never
      }
      throw new Error(`unexpected ${path}`)
    },
    async post() {
      throw new Error('unexpected post')
    },
  }
}

describe('history（/actions）', () => {
  it('同一条交易链的动作合成一条；兑换、转账、失败的分类；多余 TON 退回不单独成一条', async () => {
    const ton = new TonClient(
      fake({
        first: {
          actions: [
            swap(1),
            excess(1),
            action(2, 'jetton_transfer', { sender: OTHER, receiver: ME, asset: USDT, amount: '5000000' }),
            action(3, 'ton_transfer', { source: ME, destination: OTHER, value: '1500000000' }, { success: false }),
            excess(4),
          ],
        },
      }),
    )
    const { items, nextCursor } = await history(ton, ME)
    expect(nextCursor).toBeUndefined()
    expect(items.map((i) => [i.type, i.status, i.direction])).toEqual([
      ['swap', 'success', undefined],
      ['transfer', 'success', 'in'],
      ['transfer', 'failed', 'out'],
    ])
    expect(items[0]).toMatchObject({ protocol: 'STON.fi v2', label: 'Swapped 1 USD₮ for 0.743854486 TON on STON.fi v2', block: 7, time: 999_999 })
    expect(items[0]?.changes).toEqual([
      { asset: expect.stringMatching(/^EQ/), symbol: 'USD₮', decimals: 6, delta: '-1000000', formatted: '-1' },
      { asset: 'native', symbol: 'TON', decimals: 9, delta: '743854486', formatted: '0.743854486' },
    ])
    expect(items[1]).toMatchObject({ label: expect.stringMatching(/^Received 5 USD₮ from /), changes: [{ delta: '5000000' }] })
    expect(items[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('页末被截断的交易链单独取完整，下一页跳过它；游标带适配器名', async () => {
    const calls: Array<Record<string, unknown>> = []
    const ton = new TonClient(
      fake(
        {
          first: { actions: [action(1, 'ton_transfer', { source: ME, destination: OTHER, value: '1' }), swap(2)], next_cursor: 'c1' },
          c1: { actions: [excess(2), action(3, 'ton_transfer', { source: OTHER, destination: ME, value: '2' })] },
        },
        calls,
      ),
    )
    const p1 = await history(ton, ME, { limit: 2 })
    expect(p1.items.map((i) => i.type)).toEqual(['transfer', 'swap'])
    expect(p1.nextCursor).toBe(`actions:c1|${b64(2)}`)
    expect(calls.some((c) => c.trace_id === b64(2))).toBe(true)
    const p2 = await history(ton, ME, { limit: 2, cursor: p1.nextCursor })
    // 属于第 2 条交易链的 excess 被跳过
    expect(p2.items).toHaveLength(1)
    expect(p2.items[0]?.direction).toBe('in')
    expect(p2.nextCursor).toBeUndefined()
  })

  it('types 过滤会继续翻页；before / after 传给索引器', async () => {
    const calls: Array<Record<string, unknown>> = []
    const ton = new TonClient(
      fake(
        {
          first: { actions: [action(1, 'ton_transfer', { source: ME, destination: OTHER, value: '1' })], next_cursor: 'c1' },
          c1: { actions: [swap(2)] },
        },
        calls,
      ),
    )
    const { items } = await history(ton, ME, { limit: 5, types: ['swap'], after: 10, before: 20 })
    expect(items.map((i) => i.type)).toEqual(['swap'])
    expect(calls.filter((c) => c.path === 'actions' && !c.trace_id)).toHaveLength(2)
    expect(calls[0]).toMatchObject({ account: ME.toLowerCase(), start_utime: 10, end_utime: 20 })
  })

  it('地址非法、游标不是配置的适配器时报错', async () => {
    const ton = new TonClient(fake({}))
    await expect(history(ton, 'nope')).rejects.toThrow(/Invalid TON address/)
    await expect(history(ton, ME, { cursor: 'mystery:1' })).rejects.toThrow(/Invalid history cursor/)
  })
})

describe('适配器', () => {
  it('第一个出错换下一个，翻页用同一个；全部出错时汇总', async () => {
    const ton = new TonClient(fake({}))
    const good: HistoryAdapter = { name: 'good', fetch: async () => ({ items: [], nextCursor: 'n' }) }
    const bad: HistoryAdapter = { name: 'bad', fetch: async () => Promise.reject(new Error('boom')) }
    const page = await history(ton, ME, { adapters: [bad, good] })
    expect(page.nextCursor).toBe('good:n')
    await expect(history(ton, ME, { adapters: [bad, bad] })).rejects.toThrow(/All history sources failed: bad: boom; bad: boom/)
  })

  it('/transactions + /jetton/transfers：按交易链合并，兑换、转账、手续费', async () => {
    const tx = (hash: string, trace: number, now: number, before: number, after: number, external: boolean) => ({
      hash,
      now,
      mc_block_seqno: 9,
      trace_id: b64(trace),
      total_fees: '1000',
      description: { aborted: false, compute_ph: { success: true } },
      in_msg: { source: external ? null : OTHER },
      out_msgs: [{ destination: POOL }],
      account_state_before: { balance: String(before) },
      account_state_after: { balance: String(after) },
    })
    const transport: TonTransport = {
      async get(path) {
        if (path === 'transactions') return { transactions: [tx('a', 1, 200, 5_000_000_000, 4_999_000_000, true), tx('b', 2, 100, 1_000_000_000, 1_500_000_000, false)] } as never
        if (path === 'jetton/transfers') return { jetton_transfers: [{ source: ME, destination: POOL, amount: '1000000', jetton_master: USDT, transaction_now: 200, trace_id: b64(1) }], metadata: meta } as never
        throw new Error(`unexpected ${path}`)
      },
      async post() {
        throw new Error('unexpected')
      },
    }
    const { items, nextCursor } = await history(new TonClient(transport), ME, { limit: 5, adapters: [toncenterTransactions()] })
    expect(nextCursor).toBeUndefined()
    expect(items.map((i) => [i.type, i.direction, i.fee])).toEqual([
      ['transfer', 'out', '1000'],
      ['transfer', 'in', undefined],
    ])
    expect(items[0]?.changes).toEqual([expect.objectContaining({ symbol: 'USD₮', delta: '-1000000' })])
    expect(items[1]?.changes).toEqual([expect.objectContaining({ asset: 'native', delta: '500000000' })])
  })
})
