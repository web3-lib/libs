/** 交易历史：getTransaction 结果整理成 Activity、翻页 / 过滤 / 数据源切换、Helius 数据源，模拟节点，不连网络 */
import { base58 } from '@scure/base'
import { describe, expect, it } from 'vitest'

import { NATIVE_MINT, SYSTEM_PROGRAM_ID, SolanaClient, TOKEN_PROGRAM_ID } from '../src/index.js'
import { activityFromHelius, activityFromTransaction, getHistory, heliusHistory, rpcHistory, type HistorySource } from '../src/subpaths/history.js'
import { keypair } from './fakeSolana.js'

const WALLET = keypair(1).address
const OTHER = keypair(2).address
const USDC = keypair(3).address
const PROGRAM = keypair(4).address
const WALLET_USDC = keypair(5).address
const OTHER_USDC = keypair(6).address

const u64 = (n: bigint) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, n, true)
  return b
}
const bal = (accountIndex: number, owner: string, amount: string) => ({ accountIndex, mint: USDC, owner, uiTokenAmount: { amount, decimals: 6 } })

function tx(signature: string, options: { keys: string[]; ixs: Array<{ program: number; accounts: number[]; data: Uint8Array }>; pre?: number[]; post?: number[]; preTokens?: Array<ReturnType<typeof bal>>; postTokens?: Array<ReturnType<typeof bal>>; err?: unknown; fee?: number; time?: number }) {
  return {
    slot: 100,
    blockTime: options.time ?? 1_700_000_000,
    meta: { err: options.err ?? null, fee: options.fee ?? 5000, preBalances: options.pre ?? options.keys.map(() => 10_000_000), postBalances: options.post ?? options.keys.map((_, i) => 10_000_000 - (i === 0 ? (options.fee ?? 5000) : 0)), preTokenBalances: options.preTokens ?? [], postTokenBalances: options.postTokens ?? [] },
    transaction: { signatures: [signature], message: { accountKeys: options.keys, instructions: options.ixs.map((i) => ({ programIdIndex: i.program, accounts: i.accounts, data: base58.encode(i.data) })) } },
  }
}

const solTransfer = (sig: string, from: string, to: string, lamports: bigint, time?: number) =>
  tx(sig, { keys: [from, to, SYSTEM_PROGRAM_ID], ixs: [{ program: 2, accounts: [0, 1], data: new Uint8Array([2, 0, 0, 0, ...u64(lamports)]) }], pre: [10_000_000, 0, 1], post: [10_000_000 - Number(lamports) - 5000, Number(lamports), 1], time })

describe('activityFromTransaction', () => {
  it('SOL 转出：方向、对手方、手续费', () => {
    const a = activityFromTransaction(WALLET, solTransfer('s1', WALLET, OTHER, 1_000_000n))
    expect(a).toMatchObject({ hash: 's1', type: 'transfer', status: 'success', direction: 'out', counterparty: OTHER, fee: '5000', time: 1_700_000_000, block: 100 })
    expect(a?.changes).toEqual([{ asset: 'native', symbol: 'SOL', decimals: 9, delta: '-1000000', formatted: '-0.001' }])
    expect(a?.label).toBe(`Send 0.001 SOL to ${OTHER.slice(0, 4)}…${OTHER.slice(-4)}`)
    // 对方的角度：收到，不是手续费支付者
    const b = activityFromTransaction(OTHER, solTransfer('s1', WALLET, OTHER, 1_000_000n))
    expect(b).toMatchObject({ direction: 'in', counterparty: WALLET })
    expect(b?.fee).toBeUndefined()
  })

  it('兑换：不认识的程序，按一减一增推断；Wrapped SOL 并入 SOL', () => {
    const a = activityFromTransaction(WALLET, tx('s2', {
      keys: [WALLET, WALLET_USDC, PROGRAM],
      ixs: [{ program: 2, accounts: [0, 1], data: new Uint8Array([1, 2, 3]) }],
      pre: [10_000_000, 2_039_280, 1],
      post: [10_000_000 - 5000, 2_039_280, 1],
      preTokens: [bal(1, WALLET, '0'), { ...bal(1, WALLET, '500'), mint: NATIVE_MINT }],
      postTokens: [bal(1, WALLET, '7000000')],
    }))
    expect(a).toMatchObject({ type: 'swap' })
    expect(a?.changes.map((c) => [c.asset, c.delta])).toEqual([['native', '-500'], [USDC, '7000000']])
    expect(a?.direction).toBeUndefined()
  })

  it('失败的交易：status failed，没有资产变化，只有手续费', () => {
    const a = activityFromTransaction(WALLET, { ...solTransfer('s3', WALLET, OTHER, 1_000_000n), meta: { ...solTransfer('s3', WALLET, OTHER, 1n).meta, err: { InstructionError: [0, 'Custom'] } } })
    expect(a).toMatchObject({ status: 'failed', type: 'transfer', changes: [], fee: '5000' })
    expect(a?.label).toMatch(/^Failed: /)
  })

  it('代币转账：对手方是代币账户的 owner；授权', () => {
    const transfer = new Uint8Array([12, ...u64(5_000_000n), 6])
    const a = activityFromTransaction(WALLET, tx('s4', {
      keys: [WALLET, WALLET_USDC, OTHER_USDC, USDC, TOKEN_PROGRAM_ID],
      post: [10_000_000 - 5000, 1, 1, 1, 1],
      pre: [10_000_000, 1, 1, 1, 1],
      ixs: [{ program: 4, accounts: [1, 3, 2, 0], data: transfer }],
      preTokens: [bal(1, WALLET, '9000000'), bal(2, OTHER, '0')],
      postTokens: [bal(1, WALLET, '4000000'), bal(2, OTHER, '5000000')],
    }))
    expect(a).toMatchObject({ type: 'transfer', direction: 'out', counterparty: OTHER })
    expect(a?.changes).toMatchObject([{ asset: USDC, delta: '-5000000', formatted: '-5' }])
    const approve = activityFromTransaction(WALLET, tx('s5', { keys: [WALLET, WALLET_USDC, OTHER, TOKEN_PROGRAM_ID], ixs: [{ program: 3, accounts: [1, 2, 0], data: new Uint8Array([4, ...u64(1n)]) }] }))
    expect(approve).toMatchObject({ type: 'approve', changes: [] })
  })
})

function fakeClient(signatures: Array<{ signature: string; blockTime: number }>, txs: Record<string, unknown>) {
  const calls: string[] = []
  const client = new SolanaClient({
    async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      calls.push(method)
      if (method === 'getSignaturesForAddress') {
        const { limit, before } = params[1] as { limit: number; before?: string }
        const start = before ? signatures.findIndex((s) => s.signature === before) + 1 : 0
        return signatures.slice(start, start + limit).map((s) => ({ ...s, slot: 1, err: null })) as T
      }
      if (method === 'getTransaction') return (txs[params[0] as string] ?? null) as T
      throw new Error(`unexpected ${method}`)
    },
  }, { cluster: 'mainnet' })
  return { client, calls }
}

describe('getHistory', () => {
  const sigs = Array.from({ length: 30 }, (_, i) => ({ signature: `sig${i}`, blockTime: 1_700_000_000 - i * 100 }))
  // 偶数是 SOL 转账，3 的倍数是对自己的 Memo 之类的“其他”
  const txs = Object.fromEntries(sigs.map((s, i) => [s.signature, i % 2 === 0 ? solTransfer(s.signature, WALLET, OTHER, 1000n, s.blockTime) : tx(s.signature, { keys: [WALLET, PROGRAM], ixs: [{ program: 1, accounts: [0], data: new Uint8Array(1) }], time: s.blockTime })]))

  it('分页：游标是最后一条签名；最后一页没有 nextCursor', async () => {
    const { client } = fakeClient(sigs, txs)
    const first = await getHistory(WALLET, { limit: 10, provider: client.transport, symbols: false })
    expect(first.items.map((a) => a.hash)).toEqual(sigs.slice(0, 10).map((s) => s.signature))
    expect(first.nextCursor).toBe('sig9')
    const third = await getHistory(WALLET, { limit: 10, cursor: 'sig19', provider: client.transport, symbols: false })
    expect(third.items).toHaveLength(10)
    expect(third.nextCursor).toBeUndefined()
  })

  it('types 过滤：不够时往后多找；时间范围', async () => {
    const { client } = fakeClient(sigs, txs)
    const page = await getHistory(WALLET, { limit: 4, types: ['transfer'], provider: client.transport, symbols: false })
    expect(page.items.map((a) => a.hash)).toEqual(['sig0', 'sig2', 'sig4', 'sig6'])
    expect(page.nextCursor).toBe('sig6')
    const ranged = await getHistory(WALLET, { limit: 50, before: 1_700_000_000 - 100, after: 1_700_000_000 - 500, provider: client.transport, symbols: false })
    expect(ranged.items.map((a) => a.hash)).toEqual(['sig2', 'sig3', 'sig4', 'sig5'])
    expect(ranged.nextCursor).toBeUndefined()
  })

  it('数据源失败时换下一个；全部失败时汇总原因', async () => {
    const { client } = fakeClient(sigs, txs)
    const broken: HistorySource = { name: 'broken', getHistory: () => Promise.reject(new Error('HTTP 401')) }
    const page = await getHistory(WALLET, { limit: 2, source: [broken, rpcHistory()], provider: client.transport, symbols: false })
    expect(page.items).toHaveLength(2)
    await expect(getHistory(WALLET, { source: [broken], provider: client.transport })).rejects.toThrow('All history sources failed (broken: HTTP 401)')
  })

  it('参数检查', async () => {
    await expect(getHistory('nope')).rejects.toThrow('Invalid address')
    await expect(getHistory(WALLET, { limit: 0 })).rejects.toThrow(RangeError)
  })
})

describe('heliusHistory', () => {
  const item = {
    signature: 'h1', timestamp: 1_700_000_000, slot: 5, fee: 5000, feePayer: WALLET, type: 'SWAP', source: 'JUPITER', description: 'swapped',
    accountData: [
      { account: WALLET, nativeBalanceChange: -1_000_005_000, tokenBalanceChanges: [] },
      { account: WALLET_USDC, nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: WALLET, mint: USDC, rawTokenAmount: { tokenAmount: '150000000', decimals: 6 } }] },
    ],
  }

  it('按 accountData 整理出这个地址的变化（SOL 不含手续费）', () => {
    const a = activityFromHelius(WALLET, item)
    expect(a).toMatchObject({ hash: 'h1', type: 'swap', protocol: 'Jupiter', status: 'success', fee: '5000', label: 'swapped' })
    expect(a.changes.map((c) => [c.asset, c.delta])).toEqual([['native', '-1000000000'], [USDC, '150000000']])
  })

  it('翻页用 before，apiKey 在查询参数里，HTTP 错误抛出', async () => {
    const urls: string[] = []
    const fetchMock = (async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify([item]), { status: 200 })
    }) as unknown as typeof fetch
    const client = new SolanaClient({ request: async () => [] as never }, { cluster: 'mainnet' })
    const page = await getHistory(WALLET, { limit: 1, cursor: 'prev', source: heliusHistory({ apiKey: 'K' }), fetch: fetchMock, provider: client.transport, symbols: false })
    expect(urls[0]).toBe(`https://api.helius.xyz/v0/addresses/${WALLET}/transactions?api-key=K&limit=1&before=prev`)
    expect(page.nextCursor).toBe('h1')
    const bad = (async () => new Response('', { status: 429 })) as unknown as typeof fetch
    await expect(getHistory(WALLET, { source: heliusHistory({ apiKey: 'K' }), fetch: bad, provider: client.transport })).rejects.toThrow('HTTP 429')
    expect(() => heliusHistory({ apiKey: '' })).toThrow('apiKey')
  })
})
