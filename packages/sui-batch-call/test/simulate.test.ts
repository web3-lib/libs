import { describe, expect, it } from 'vitest'

import { PROTOCOL_PACKAGES, decodeError } from '../src/analyze.js'
import { CETUS } from '../src/cetus.js'
import { SWAP_PACKAGES } from '../src/swapTx.js'
import { SuiClient } from '../src/client.js'
import { GrpcError, type GrpcTransport } from '../src/grpc.js'
import { getHistoryOf } from '../src/history.js'
import type { HistoryAdapter, HistoryQuery } from '../src/historyAdapters.js'
import { ProtoMessage } from '../src/proto.js'
import { balanceChangesWithoutGas, rawFromJson, type RawTx } from '../src/rawTx.js'

const ME = '0x00000000000000000000000000000000000000000000000000000000000000aa'
const YOU = '0x00000000000000000000000000000000000000000000000000000000000000bb'
const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'

/** 只回空响应的节点：GetCoinInfo 报不存在，ListPackageVersions 没有版本 */
const nodeStub: GrpcTransport = {
  label: 'stub',
  async unary(method) {
    if (method.endsWith('GetCoinInfo')) throw new GrpcError(5, 'not found')
    return { message: ProtoMessage.decode(new Uint8Array()), checkpoint: null, chain: 'mainnet' }
  },
}

const effects = (extra: object = {}) => ({ status: { success: true }, gasUsed: { computationCost: '1000', storageCost: '2000', storageRebate: '500', nonRefundableStorageFee: '0' }, changedObjects: [], ...extra })
const tx = (digest: string, sender: string, changes: Array<[string, string, string]>, commands: object[], extra: Partial<Parameters<typeof rawFromJson>[0]> = {}): RawTx =>
  rawFromJson({
    digest,
    transaction: { sender, gasPayment: { owner: sender, price: '1000', budget: '5000000' }, kind: { kind: 'PROGRAMMABLE_TRANSACTION', programmableTransaction: { commands } } },
    effects: effects(),
    balanceChanges: changes.map(([address, coinType, amount]) => ({ address, coinType, amount })),
    timestamp: '2026-10-01T00:00:00Z',
    checkpoint: 100,
    ...extra,
  })

describe('decodeError', () => {
  it('Move abort: location, code, framework / clever names', () => {
    const e = decodeError({ description: 'x', kind: 'MOVE_ABORT', command: 1, abort: { code: 2n, package: '0x2', module: 'balance', function: 'split', constant: null, message: null } })
    expect(e?.message).toContain('0x0000000000000000000000000000000000000000000000000000000000000002::balance::split')
    expect(e?.message).toContain('ENotEnough')
    expect(e?.abort).toMatchObject({ code: '2', name: 'ENotEnough (not enough balance)' })
    const clever = decodeError({ description: 'x', kind: 'MOVE_ABORT', command: 0, abort: { code: 7n, package: '0xabc', module: 'pool', function: 'swap', constant: 'EPriceLimit', message: 'price limit hit' } })
    expect(clever?.message).toMatch(/code 7 \(EPriceLimit\): price limit hit/)
  })
  it('other kinds get a readable text; no error is null', () => {
    expect(decodeError({ description: 'InsufficientGas', kind: 'INSUFFICIENT_GAS', command: null, abort: null })?.message).toMatch(/Gas budget is too low/)
    expect(decodeError(null)).toBeNull()
  })
})

describe('protocol table', () => {
  it('matches the packages the swap / liquidity builders call', () => {
    for (const [protocol, ids] of Object.entries(SWAP_PACKAGES)) for (const id of ids) expect(PROTOCOL_PACKAGES[protocol]).toContain(id)
    expect(PROTOCOL_PACKAGES.cetus).toContain(CETUS.clmm)
  })
})

describe('raw transactions', () => {
  it('balance changes exclude the gas the payer spent', () => {
    const t = tx('d1', ME, [[ME, SUI, '-1002500'], [YOU, SUI, '1000000']], [{ transferObjects: {} }])
    // 费用 = 1000 + 2000 - 500 = 2500
    expect(balanceChangesWithoutGas(t).find((c) => c.address === ME)?.amount).toBe(-1_000_000n)
  })
})

describe('getHistory', () => {
  const client = new SuiClient(nodeStub)
  const swap = tx('swap', ME, [[ME, SUI, '-1002500'], [ME, USDC, '5000']], [{ moveCall: { package: '0xdead', module: 'router', function: 'go', typeArguments: [] } }])
  const send = tx('send', ME, [[ME, SUI, '-1002500'], [YOU, SUI, '1000000']], [{ splitCoins: {} }, { transferObjects: {} }])
  const recv = tx('recv', YOU, [[ME, SUI, '7'], [YOU, SUI, '-7']], [{ transferObjects: {} }], { checkpoint: 90 })
  const failed = tx('failed', ME, [[ME, SUI, '-2500']], [{ moveCall: { package: '0xdead', module: 'router', function: 'go', typeArguments: [] } }], {
    effects: effects({ status: { success: false, error: { description: 'abort', kind: 'MOVE_ABORT', abort: { abortCode: '9', location: { package: '0xdead', module: 'router', functionName: 'go' } } } } }),
  })
  const all = [swap, send, recv, failed]
  /** 假的数据源：每页 2 笔，游标是下标 */
  const fake = (name: string, fail = false): HistoryAdapter & { calls: HistoryQuery[] } => {
    const calls: HistoryQuery[] = []
    return {
      name,
      calls,
      async list(_, q) {
        calls.push(q)
        if (fail) throw new Error(`${name} down`)
        const start = q.cursor ? Number(q.cursor) : 0
        const txs = all.slice(start, start + Math.min(q.limit, 2))
        return { txs, ...(start + txs.length < all.length ? { nextCursor: String(start + txs.length) } : {}) }
      },
    }
  }

  it('classifies swap / transfer / incoming / failed from the address balance changes', async () => {
    const r = await getHistoryOf(client, ME, { limit: 4, adapters: [{ ...fake('a'), list: async () => ({ txs: all }) }] })
    const [a, b, c, d] = r.items
    expect(a).toMatchObject({ hash: 'swap', type: 'swap', status: 'success', fee: '2500' })
    expect(a?.changes.map((x) => x.delta)).toEqual(['-1000000', '5000'])
    expect(b).toMatchObject({ type: 'transfer', direction: 'out', counterparty: YOU, label: expect.stringMatching(/^Send 0\.001 SUI to /) })
    expect(c).toMatchObject({ type: 'transfer', direction: 'in', counterparty: YOU, block: 90 })
    expect(c).not.toHaveProperty('fee')
    expect(d).toMatchObject({ type: 'contract', status: 'failed', error: expect.stringContaining('Move abort 9') })
    // 失败的没有余额变化，按调用识别为合约调用
    expect(d?.changes).toEqual([])
  })

  it('cursor pages, type filter and failover to the next adapter', async () => {
    const a = fake('a')
    const p1 = await getHistoryOf(client, ME, { limit: 2, adapters: [a] })
    expect(p1.items).toHaveLength(2)
    expect(p1.nextCursor).toBe('a:100:2')
    const p2 = await getHistoryOf(client, ME, { limit: 2, cursor: p1.nextCursor, adapters: [a] })
    expect(p2.items.map((x) => x.hash)).toEqual(['recv', 'failed'])
    expect(p2.nextCursor).toBeUndefined()
    expect(a.calls[1]).toMatchObject({ cursor: '2' })

    // a 出错：换 b，游标不通用，按 checkpoint 接着取（不含更晚的）
    const bad = fake('a', true)
    const b = fake('b')
    const p3 = await getHistoryOf(client, ME, { limit: 2, cursor: p1.nextCursor, adapters: [bad, b] })
    expect(p3.items).toHaveLength(2)
    expect(b.calls[0]).toMatchObject({ beforeBlock: 101 })
    expect(b.calls[0]).not.toHaveProperty('cursor')

    const swaps = await getHistoryOf(client, ME, { limit: 1, types: ['swap'], adapters: [fake('a')] })
    expect(swaps.items.map((x) => x.hash)).toEqual(['swap'])
    await expect(getHistoryOf(client, ME, { adapters: [fake('x', true), fake('y', true)] })).rejects.toThrow(/All history adapters failed/)
  })
})
