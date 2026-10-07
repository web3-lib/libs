/** code review 发现的问题的回归测试 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HttpRpc,
  METADATA_PROGRAM_ID,
  NATIVE_MINT,
  SYSTEM_PROGRAM_ID,
  SolanaClient,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getMetadataAddress,
} from '../src/index.js'
import { resetTokenMetaCache } from '../src/client.js'
import { resetClientCache } from '../src/shortcuts.js'
import { createMockNode, metaplexData, mintData, tokenAccountData } from './mock.js'

const OWNER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const BARE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' // 没有元数据的代币

type Body = { id: number; method: string }

function rawFetch(handle: (body: Body | Body[]) => [number, string]) {
  const requests: Array<Body | Body[]> = []
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body | Body[]
    requests.push(body)
    const [status, text] = handle(body)
    return new Response(text, { status })
  }) as unknown as typeof fetch
  return { fetchFn, requests }
}

const okText = (b: Body) => JSON.stringify({ jsonrpc: '2.0', id: b.id, result: `${b.method}-ok` })

beforeEach(() => {
  resetTokenMetaCache()
  resetClientCache()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('scan 模式', () => {
  it('Wrapped SOL 代币账户不会让 SOL 重复出现', async () => {
    const node = createMockNode({
      accounts: {
        [OWNER]: { lamports: 2_000_000_000n, owner: SYSTEM_PROGRAM_ID },
        [NATIVE_MINT]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 9 }) },
        [getAssociatedTokenAddress(OWNER, NATIVE_MINT, TOKEN_PROGRAM_ID)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(NATIVE_MINT, OWNER, 500_000_000n) },
      },
    })
    const res = await new SolanaClient(node).balances(OWNER)
    expect(res.filter((b) => b.token === NATIVE_MINT)).toHaveLength(1)
  })

  it('symbol：只读 mint / 元数据账户，不推导 ATA；没有元数据的代币记为“没有”，不再重查', async () => {
    const node = createMockNode({
      accounts: {
        [OWNER]: { lamports: 1n, owner: SYSTEM_PROGRAM_ID },
        [BARE]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 2 }) },
        [getAssociatedTokenAddress(OWNER, BARE, TOKEN_PROGRAM_ID)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(BARE, OWNER, 100n) },
      },
    })
    const sol = new SolanaClient(node, { cluster: 'mainnet' })
    const first = await sol.balances(OWNER, undefined, { symbol: true })
    expect(first[1]).toMatchObject({ token: BARE, formatted: '1', symbol: null })
    const requested = node.calls.filter((c) => c.method === 'getMultipleAccounts').flatMap((c) => c.params[0] as string[])
    expect(requested.sort()).toEqual([BARE, getMetadataAddress(BARE)].sort())
    const before = node.calls.filter((c) => c.method === 'getMultipleAccounts').length
    await sol.balances(OWNER, undefined, { symbol: true })
    expect(node.calls.filter((c) => c.method === 'getMultipleAccounts').length).toBe(before)
  })
})

describe('传输层', () => {
  it('节点对不超过上限的批量也报 “more than N” 时降级为逐条请求，不会无限重发', async () => {
    const { fetchFn, requests } = rawFetch((body) =>
      Array.isArray(body)
        ? [500, JSON.stringify(body.map((b) => ({ jsonrpc: '2.0', id: b.id, error: { code: -32600, message: 'Batch of more than 3 requests are not allowed' } })))]
        : [200, okText(body)],
    )
    const rpc = new HttpRpc('https://rpc.example', { fetch: fetchFn })
    expect(await Promise.all(['a', 'b', 'c'].map((m) => rpc.request(m)))).toEqual(['a-ok', 'b-ok', 'c-ok'])
    expect(requests.length).toBeLessThan(10)
  })

  it('批量请求被限频（单个 429 错误对象）时不永久关闭批量，也不立刻扇出成逐条请求', async () => {
    let limited = true
    const { fetchFn, requests } = rawFetch((body) => {
      if (Array.isArray(body) && limited) {
        limited = false
        return [200, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: 429, message: 'Too many requests' } })]
      }
      return [200, Array.isArray(body) ? `[${body.map(okText).join(',')}]` : okText(body)]
    })
    const rpc = new HttpRpc('https://rpc.example', { fetch: fetchFn, retries: 0 })
    const first = await Promise.allSettled([rpc.request('a'), rpc.request('b')])
    expect(first.every((r) => r.status === 'rejected')).toBe(true)
    expect(requests).toHaveLength(1) // 没有扇出
    await Promise.all([rpc.request('c'), rpc.request('d')])
    expect(Array.isArray(requests[1])).toBe(true) // 之后仍然是批量请求
  })

  it('lamports 超过 2^53 时不丢精度', async () => {
    const big = '12345678123456789' // 约 1234 万 SOL
    const { fetchFn } = rawFetch((body) => [
      200,
      `{"jsonrpc":"2.0","id":${(body as Body).id},"result":{"context":{"slot":1},"value":[{"lamports":${big},"owner":"${SYSTEM_PROGRAM_ID}","data":["","base64"],"executable":false}]}}`,
    ])
    const sol = new SolanaClient(new HttpRpc('https://rpc.example', { fetch: fetchFn }))
    expect((await sol.solBalances([OWNER]))[0]?.balance).toBe(big)
  })

  it('内置节点保留 429 重试（浏览器里官方节点总是 403）', async () => {
    let publicnodeCalls = 0
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Body
      if (String(url).includes('publicnode') && publicnodeCalls++ === 0) {
        return new Response('{}', { status: 429 })
      }
      if (String(url).includes('mainnet-beta')) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: 403, message: 'Access forbidden' } }), { status: 403 })
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: [null] } }), { status: 200 })
    })
    expect((await new SolanaClient().solBalances([OWNER]))[0]?.success).toBe(true)
  })
})

describe('解析与缓存', () => {
  it('代币账户不会被当成 mint 解析（也不会缓存错误的 decimals）', async () => {
    const ata = getAssociatedTokenAddress(OWNER, USDC, TOKEN_PROGRAM_ID)
    const node = createMockNode({ accounts: { [ata]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(USDC, OWNER, 1n) } } })
    const [res] = await new SolanaClient(node).tokens([ata], { fields: ['decimals'] })
    expect(res).toMatchObject({ decimals: null, success: false })
  })

  it('没指定 cluster 的不同节点不共用代币信息缓存', async () => {
    const a = createMockNode({ accounts: { [USDC]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) } } })
    const b = createMockNode({ accounts: { [USDC]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 9 }) } } })
    expect((await new SolanaClient(a).tokens([USDC], { fields: ['decimals'] }))[0]?.decimals).toBe(6)
    expect((await new SolanaClient(b).tokens([USDC], { fields: ['decimals'] }))[0]?.decimals).toBe(9)
  })

  it('只缓存了 name / symbol 时，tokens 不会误报 success: false', async () => {
    // mint 账户读不到、但有 Metaplex 元数据：nfts() 记下 name / symbol
    const node = createMockNode({
      accounts: { [getMetadataAddress(USDC)]: { owner: METADATA_PROGRAM_ID, data: metaplexData({ mint: USDC, name: 'USD Coin', symbol: 'USDC' }) } },
    })
    const sol = new SolanaClient(node, { cluster: 'mainnet' })
    await sol.nfts([USDC])
    expect((await sol.tokens([USDC], { fields: ['name', 'symbol'] }))[0]).toMatchObject({ name: 'USD Coin', symbol: 'USDC', success: true })
  })

  it('name / symbol 缓存 1 小时后过期重查（元数据可修改）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const node = createMockNode({
      accounts: {
        [USDC]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) },
        [getMetadataAddress(USDC)]: { owner: METADATA_PROGRAM_ID, data: metaplexData({ mint: USDC, name: 'USD Coin', symbol: 'USDC' }) },
      },
    })
    const sol = new SolanaClient(node, { cluster: 'mainnet' })
    await sol.tokens([USDC], { fields: ['symbol'] })
    node.accounts[getMetadataAddress(USDC)] = { owner: METADATA_PROGRAM_ID, data: metaplexData({ mint: USDC, name: 'USD Coin', symbol: 'USDC2' }) }
    expect((await sol.tokens([USDC], { fields: ['symbol'] }))[0]?.symbol).toBe('USDC')
    vi.setSystemTime(Date.now() + 61 * 60 * 1000)
    expect((await sol.tokens([USDC], { fields: ['symbol'] }))[0]?.symbol).toBe('USDC2')
  })
})
