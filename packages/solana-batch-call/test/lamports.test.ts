import { beforeEach, describe, expect, it } from 'vitest'

import {
  NATIVE_MINT,
  SYSTEM_PROGRAM_ID,
  SolanaClient,
  TOKEN_PROGRAM_ID,
  encodeAddress,
  getAssociatedTokenAddress,
  getMultiBalances,
  getSolBalances,
} from '../src/index.js'
import { resetTokenMetaCache } from '../src/client.js'
import { RpcError, resetNodeHealth } from '../src/rpc.js'
import { resetClientCache } from '../src/shortcuts.js'
import { createMockNode, mintData, tokenAccountData, type MockAccount } from './mock.js'

const BIG_PROGRAM = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' // 数据 105KB、余额超过 2^53 的账户
const WALLET = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const PROGRAM_OWNER = 'BPFLoaderUpgradeab1e11111111111111111111111'
const HUGE = 2n ** 60n + 12_345n // 超过 2^53，按 number 解析会丢精度

function setup() {
  const node = createMockNode({
    accounts: {
      [BIG_PROGRAM]: { lamports: HUGE, owner: PROGRAM_OWNER, data: new Uint8Array(105 * 1024).fill(7) },
      [WALLET]: { lamports: 1_500_000_000n, owner: SYSTEM_PROGRAM_ID },
    },
  })
  return { node, sol: new SolanaClient(node) }
}

const multipleAccountsCalls = (node: ReturnType<typeof createMockNode>) => node.calls.filter((c) => c.method === 'getMultipleAccounts')
const sliceOf = (call: { params: readonly unknown[] }) => (call.params[1] as { dataSlice?: unknown }).dataSlice

/** 第 i 个不同的地址（内容无关紧要，32 字节即可） */
function distinct(i: number): string {
  const bytes = new Uint8Array(32)
  bytes[0] = 1
  new DataView(bytes.buffer).setUint32(28, i)
  return encodeAddress(bytes)
}

beforeEach(() => {
  resetTokenMetaCache()
  resetClientCache()
  resetNodeHealth()
})

describe('只查主币余额时不读回账户数据（dataSlice）', () => {
  it('getSolBalances：带 dataSlice { offset: 0, length: 0 }；大程序账户的余额超过 2^53 也是精确值', async () => {
    const { node } = setup()
    const res = await getSolBalances([BIG_PROGRAM, WALLET], { provider: node })
    expect(res.map((r) => r.balance)).toEqual([HUGE.toString(), '1500000000'])
    const calls = multipleAccountsCalls(node)
    expect(calls).toHaveLength(1)
    expect(sliceOf(calls[0]!)).toEqual({ offset: 0, length: 0 })
  })

  it('单币模式查主币、multiBalances：钱包账户同样不读回数据，余额精确', async () => {
    const { node, sol } = setup()
    const [native] = await sol.balances(BIG_PROGRAM, [NATIVE_MINT])
    expect(native).toMatchObject({ native: true, balance: HUGE.toString(), success: true })
    const [a, b] = await getMultiBalances(
      [
        { owner: BIG_PROGRAM, mints: [NATIVE_MINT] },
        { owner: WALLET, mints: [NATIVE_MINT] },
      ],
      { provider: node },
    )
    expect([a?.[0]?.balance, b?.[0]?.balance]).toEqual([HUGE.toString(), '1500000000'])
    // 程序账户始终单独带 dataSlice 读
    expect(multipleAccountsCalls(node).filter((c) => (c.params[0] as string[]).includes(BIG_PROGRAM)).every(sliceOf)).toBe(true)
  })

  it('超过 100 个地址时按 100 个一组，每组都带 dataSlice', async () => {
    const { node } = setup()
    const res = await getSolBalances(
      Array.from({ length: 150 }, (_, i) => distinct(i)),
      { provider: node },
    )
    expect(res).toHaveLength(150)
    const calls = multipleAccountsCalls(node)
    expect(calls.map((c) => (c.params[0] as string[]).length)).toEqual([100, 50])
    expect(calls.every(sliceOf)).toBe(true)
  })
})

describe('两组账户共用调度', () => {
  const tokenWorld = () => ({ [USDC]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) } })

  it('同时进行的 getMultipleAccounts 最多 3 个（代币账户组和只读 lamports 组合计）', async () => {
    const node = createMockNode({ accounts: tokenWorld() })
    let inFlight = 0
    let peak = 0
    const request = node.request.bind(node)
    node.request = async <T,>(method: string, params?: readonly unknown[]): Promise<T> => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      try {
        return await request<T>(method, params)
      } finally {
        inFlight--
      }
    }
    const owners = Array.from({ length: 250 }, (_, i) => distinct(i))
    const res = await new SolanaClient(node).multiBalances(owners.map((owner) => ({ owner, mints: [NATIVE_MINT, USDC] })))
    expect(res).toHaveLength(250)
    expect(multipleAccountsCalls(node).length).toBeGreaterThan(3) // 代币账户 3 组 + 钱包 3 组
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('一批里有请求失败时，后面的批次不再发', async () => {
    const node = createMockNode({ accounts: tokenWorld() })
    const request = node.request.bind(node)
    let count = 0
    node.request = async <T,>(method: string, params?: readonly unknown[]): Promise<T> => {
      if (method === 'getMultipleAccounts' && count++ === 0) {
        node.calls.push({ method, params: params ?? [] })
        throw new RpcError('Invalid params', -32602)
      }
      return request<T>(method, params)
    }
    const owners = Array.from({ length: 250 }, (_, i) => distinct(i))
    await expect(new SolanaClient(node).multiBalances(owners.map((owner) => ({ owner, mints: [NATIVE_MINT, USDC] })))).rejects.toThrow(/Invalid params/)
    expect(multipleAccountsCalls(node).length).toBe(3) // 只有第一批
  })
})

describe('普通钱包确认后与代币账户同一个请求', () => {
  it('第一次单独带 dataSlice；确认是系统账户后只发一个请求；程序账户始终单独读', async () => {
    const node = createMockNode({
      accounts: {
        [WALLET]: { lamports: 1_500_000_000n, owner: SYSTEM_PROGRAM_ID },
        [BIG_PROGRAM]: { lamports: HUGE, owner: PROGRAM_OWNER, data: new Uint8Array(105 * 1024) },
        [USDC]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) },
        [getAssociatedTokenAddress(WALLET, USDC, TOKEN_PROGRAM_ID)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(USDC, WALLET, 5n) },
      },
    })
    const sol = new SolanaClient(node)
    const query = () =>
      sol.multiBalances([
        { owner: WALLET, mints: [NATIVE_MINT, USDC] },
        { owner: BIG_PROGRAM, mints: [NATIVE_MINT] },
      ])
    const first = await query()
    expect(first.map((l) => l.map((r) => r.balance))).toEqual([['1500000000', '5'], [HUGE.toString()]])
    expect(multipleAccountsCalls(node).filter(sliceOf).map((c) => [...(c.params[0] as string[])].sort())).toEqual([[WALLET, BIG_PROGRAM].sort()])

    node.calls.length = 0
    expect(await query()).toEqual(first)
    const calls = multipleAccountsCalls(node)
    // WALLET 与代币账户同一个请求（不带 dataSlice）；BIG_PROGRAM 仍单独带 dataSlice
    expect(calls.find((c) => !sliceOf(c))?.params[0]).toContain(WALLET)
    expect(calls.filter(sliceOf).map((c) => c.params[0])).toEqual([[BIG_PROGRAM]])
  })

  it('已确认的钱包后来不再是系统账户（如被分配给程序）时移出，下次重新单独读', async () => {
    const accounts: Record<string, MockAccount> = { [WALLET]: { lamports: 1n, owner: SYSTEM_PROGRAM_ID } }
    const node = createMockNode({ accounts })
    const sol = new SolanaClient(node)
    await sol.balances(WALLET, [NATIVE_MINT]) // 学到是普通钱包
    accounts[WALLET] = { lamports: 1n, owner: PROGRAM_OWNER, data: new Uint8Array(1024) }
    await sol.balances(WALLET, [NATIVE_MINT]) // 与代币组同读，发现不再是系统账户
    node.calls.length = 0
    await sol.balances(WALLET, [NATIVE_MINT])
    expect(multipleAccountsCalls(node).map(sliceOf)).toEqual([{ offset: 0, length: 0 }])
  })
})

describe('HTTP 层解析：JSON 里不带引号的大数 lamports', () => {
  it('超过 2^53 的 lamports 按原文解析，结果是精确字符串', async () => {
    const HUGE_TEXT = '1152921504606859191' // 19 位，按 number 解析会变成 1152921504606859300
    const fakeFetch = (async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { id: number } | Array<{ id: number }>
      const reply = (req: { id: number }) =>
        `{"jsonrpc":"2.0","id":${req.id},"result":{"context":{"slot":1},"value":[{"lamports":${HUGE_TEXT},"owner":"11111111111111111111111111111111","data":["","base64"],"executable":false}]}}`
      const text = Array.isArray(body) ? `[${body.map(reply).join(',')}]` : reply(body)
      return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const sol = new SolanaClient('https://rpc.example', { fetch: fakeFetch })
    const [res] = await sol.solBalances([WALLET])
    expect(res?.balance).toBe(HUGE_TEXT)
  })
})

describe('节点限制单个方法在批量里的数量（publicnode：getMultipleAccounts 最多 1 个）', () => {
  it('整批被拒时按限制重新分批，调用方照常拿到结果；之后的请求直接按限制分批', async () => {
    const bodies: Array<Array<{ method: string }>> = []
    let rejected = 0
    const fakeFetch = (async (_url: string, init?: { body?: string }) => {
      const parsed = JSON.parse(init?.body ?? '{}') as { id: number; method: string } | Array<{ id: number; method: string }>
      const list = Array.isArray(parsed) ? parsed : [parsed]
      bodies.push(list)
      if (Array.isArray(parsed) && list.filter((r) => r.method === 'getMultipleAccounts').length > 1) {
        rejected++
        const message = "Maximum number of 'getMultipleAccounts' calls in a batch request is 1. To increase limits, get a personal token here: https://www.allnodes.com/publicnode"
        return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message } }), { status: 200 })
      }
      const reply = (req: { id: number }) => ({
        jsonrpc: '2.0',
        id: req.id,
        result: { context: { slot: 1 }, value: [{ lamports: 7, owner: '11111111111111111111111111111111', data: ['', 'base64'], executable: false }] },
      })
      return new Response(JSON.stringify(Array.isArray(parsed) ? list.map(reply) : reply(list[0]!)), { status: 200 })
    }) as typeof fetch
    const sol = new SolanaClient('https://rpc.example', { fetch: fakeFetch })
    // 同一 tick 两个查询：两个 getMultipleAccounts 合并进同一个批量
    const [a, b] = await Promise.all([sol.solBalances([WALLET]), sol.solBalances([BIG_PROGRAM])])
    expect([a[0]?.balance, b[0]?.balance]).toEqual(['7', '7'])
    expect(rejected).toBe(1)
    const before = bodies.length
    await Promise.all([sol.solBalances([WALLET]), sol.solBalances([BIG_PROGRAM])])
    expect(rejected).toBe(1) // 学到限制后不再被拒
    expect(bodies.slice(before).every((list) => list.filter((r) => r.method === 'getMultipleAccounts').length <= 1)).toBe(true)
  })
})
