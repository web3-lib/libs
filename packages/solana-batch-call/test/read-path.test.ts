// 0.6.1 读取链路：取消传到底层、并发上限、publicnode 预置限制、429 / 413 处理、去重、LP 池子缓存
import { sha256 } from '@noble/hashes/sha2.js'
import { base58 } from '@scure/base'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FallbackRpc, HttpRpc, SolanaClient, TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getMetadataAddress, type RpcTransport } from '../src/index.js'
import { resetTokenMetaCache } from '../src/client.js'
import { RAYDIUM_AMM_AUTHORITY, lpPositions, resetLpPoolCache } from '../src/lp.js'
import { resetNodeHealth, retryDelay } from '../src/rpc.js'
import { createMockNode, METADATA_PROGRAM_ID, metaplexData, mintData, tokenAccountData } from './mock.js'

type Call = { id: number; method: string; params: unknown[] }

const OWNER = 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ'
/** 测试地址：合法的 base58（32 字节），各不相同 */
const ADDRS = Array.from({ length: 600 }, (_, i) => base58.encode(sha256(new TextEncoder().encode(`addr-${i}`))))

let urlId = 0
/** 每个测试用不同的节点地址：学到的限制、并发计数按地址共享 */
function uniqueUrl(): string {
  return `https://node-${++urlId}.example`
}

function reply(call: Call, result: unknown = { context: { slot: 1 }, value: (call.params[0] as unknown[] | undefined)?.map?.(() => null) ?? null }) {
  return { jsonrpc: '2.0', id: call.id, result }
}

/** 记录请求的 fake fetch：handler 返回 Response；记录同时在途数、收到的 signal */
function recorder(handler: (calls: Call[], init: RequestInit, url: string) => Promise<Response> | Response) {
  const state = { bodies: [] as Call[][], inflight: 0, maxInflight: 0, signals: [] as AbortSignal[] }
  const fetchFn = (async (url: string, init: RequestInit) => {
    const parsed = JSON.parse(String(init.body)) as Call | Call[]
    const calls = Array.isArray(parsed) ? parsed : [parsed]
    state.bodies.push(calls)
    if (init.signal) state.signals.push(init.signal)
    state.inflight++
    state.maxInflight = Math.max(state.maxInflight, state.inflight)
    try {
      return await handler(calls, init, url)
    } finally {
      state.inflight--
    }
  }) as typeof fetch
  return { state, fetchFn }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

/** 一直挂起，直到 signal 中止（和真实 fetch 一样 reject signal.reason） */
function hang(init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init.signal
    if (signal?.aborted) return reject(signal.reason)
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  resetTokenMetaCache()
  resetNodeHealth()
  resetLpPoolCache()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('取消传到底层', () => {
  it('HttpRpc：取消后 fetch 收到 abort，reject 的就是 signal.reason', async () => {
    const { state, fetchFn } = recorder((_calls, init) => hang(init))
    const rpc = new HttpRpc(uniqueUrl(), { fetch: fetchFn })
    const controller = new AbortController()
    const pending = rpc.request('getBalance', [OWNER], { signal: controller.signal })
    await tick()
    expect(state.signals).toHaveLength(1)
    const reason = new Error('stop')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(state.signals[0]?.aborted).toBe(true)
  })

  it('批量里只有部分调用方取消时不中止，全部取消才中止 fetch', async () => {
    let release: () => void = () => {}
    const { state, fetchFn } = recorder(async (calls, init) => {
      await Promise.race([new Promise<void>((r) => (release = r)), hang(init)])
      return json(calls.map((c) => reply(c, 7)))
    })
    const rpc = new HttpRpc(uniqueUrl(), { fetch: fetchFn })
    const a = new AbortController()
    const b = new AbortController()
    const pa = rpc.request('getBalance', ['a'], { signal: a.signal })
    const pb = rpc.request('getBalance', ['b'], { signal: b.signal })
    const pc = rpc.request('getBalance', ['c'])
    await tick()
    expect(state.bodies).toEqual([[expect.objectContaining({ method: 'getBalance' }), expect.anything(), expect.anything()]])
    a.abort()
    await expect(pa).rejects.toBeDefined()
    expect(state.signals[0]?.aborted).toBe(false) // 还有没取消的调用方
    release()
    expect(await pc).toBe(7)
    await expect(pb).resolves.toBe(7)

    // 两个调用方都取消：中止 fetch
    const x = new AbortController()
    const y = new AbortController()
    const px = rpc.request('getSlot', [], { signal: x.signal })
    const py = rpc.request('getEpochInfo', [], { signal: y.signal })
    await tick()
    x.abort()
    expect(state.signals[1]?.aborted).toBe(false)
    y.abort()
    await Promise.allSettled([px, py])
    expect(state.signals[1]?.aborted).toBe(true)
  })

  it('还在排队的调用取消时直接移出队列，不会发出', async () => {
    const { state, fetchFn } = recorder((calls) => json(calls.length === 1 ? reply(calls[0] as Call, 1) : calls.map((c) => reply(c, 1))))
    const rpc = new HttpRpc(uniqueUrl(), { fetch: fetchFn, batchWait: 20 })
    const controller = new AbortController()
    const cancelled = rpc.request('getBalance', ['x'], { signal: controller.signal })
    const kept = rpc.request('getSlot', [])
    controller.abort()
    await expect(cancelled).rejects.toBeDefined()
    expect(await kept).toBe(1)
    expect(state.bodies.flat().map((c) => c.method)).toEqual(['getSlot'])
  })

  it('FallbackRpc：取消后不再换节点，也不把节点记为故障', async () => {
    const secondCalls = vi.fn()
    const second: RpcTransport = { request: async <T,>() => (secondCalls(), 'second' as T) }
    const first: RpcTransport = {
      request: (_method, _params, options) =>
        new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted inside')), { once: true })),
    }
    const rpc = new FallbackRpc([first, second])
    const controller = new AbortController()
    const pending = rpc.request('getSlot', [], { signal: controller.signal })
    await tick()
    const reason = new Error('user cancelled')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(secondCalls).not.toHaveBeenCalled()
    // 节点没被冷却：下一次仍先用第一个节点
    const order: string[] = []
    const rpc2 = new FallbackRpc([
      { request: async <T,>() => (order.push('first'), 'ok' as T), label: 'a' },
      { request: async <T,>() => (order.push('second'), 'ok' as T), label: 'b' },
    ])
    await rpc2.request('getSlot')
    expect(order).toEqual(['first'])
  })

  it('SolanaClient：balances 的 signal 一路传到 fetch；reject 的是 signal.reason（与之前一致）', async () => {
    const { state, fetchFn } = recorder((_calls, init) => hang(init))
    const sol = new SolanaClient(uniqueUrl(), { fetch: fetchFn })
    const controller = new AbortController()
    const pending = sol.balances(OWNER, ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'], { signal: controller.signal })
    await tick()
    expect(state.signals.length).toBeGreaterThan(0)
    const reason = new Error('page closed')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    await tick()
    expect(state.signals.every((s) => s.aborted)).toBe(true)
  })

  it('自定义传输只实现两个参数也照常工作；没传 signal 时只传两个参数', async () => {
    const node = createMockNode()
    const seen: number[] = []
    const transport: RpcTransport = {
      request<T>(method: string, params?: readonly unknown[]): Promise<T> {
        seen.push(arguments.length)
        return node.request<T>(method, params)
      },
    }
    const sol = new SolanaClient(transport)
    expect((await sol.solBalances([OWNER]))[0]?.success).toBe(true)
    expect(seen.every((n) => n === 2)).toBe(true)
  })
})

describe('并发上限、publicnode 预置限制', () => {
  it('同一节点地址同时在途的 HTTP 请求默认最多 4 个（跨实例共享），可以调', async () => {
    const { state, fetchFn } = recorder(async (calls) => {
      await tick(5)
      return json(reply(calls[0] as Call, 1))
    })
    const url = uniqueUrl()
    const a = new HttpRpc(url, { fetch: fetchFn, batch: false })
    const b = new HttpRpc(url, { fetch: fetchFn, batch: false })
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).request('getBalance', [String(i)])))
    expect(state.bodies).toHaveLength(20)
    expect(state.maxInflight).toBe(4)

    const two = recorder(async (calls) => {
      await tick(5)
      return json(reply(calls[0] as Call, 1))
    })
    const c = new HttpRpc(uniqueUrl(), { fetch: two.fetchFn, batch: false, maxConcurrency: 2 })
    await Promise.all(Array.from({ length: 10 }, (_, i) => c.request('getBalance', [String(i)])))
    expect(two.state.maxInflight).toBe(2)
  })

  it('默认节点（publicnode）首次就按 10 个账户、每批 1 个 getMultipleAccounts 拆分，不出现 403；在途 ≤ 4', async () => {
    // 模拟 publicnode：单次超过 10 个账户返回 403 Request blocked，一个批量里多于 1 个 getMultipleAccounts 整批被拒
    let blocked = 0
    let methodLimited = 0
    const { state, fetchFn } = recorder(async (calls, init) => {
      await tick(2)
      const isBatch = Array.isArray(JSON.parse(String(init.body)))
      if (calls.some((c) => c.method === 'getMultipleAccounts' && (c.params[0] as unknown[]).length > 10)) {
        blocked++
        return json({ jsonrpc: '2.0', id: calls[0]?.id, error: { code: -32602, message: 'Request blocked' } }, 403)
      }
      if (calls.filter((c) => c.method === 'getMultipleAccounts').length > 1) {
        methodLimited++
        return json({ jsonrpc: '2.0', error: { code: -32600, message: "Maximum number of 'getMultipleAccounts' calls in a batch request is 1" } })
      }
      return json(isBatch ? calls.map((c) => reply(c)) : reply(calls[0] as Call))
    })
    const sol = new SolanaClient(undefined, { fetch: fetchFn })
    const accounts = await sol.accounts(ADDRS.slice(0, 250))
    expect(accounts).toHaveLength(250)
    expect(blocked).toBe(0)
    expect(methodLimited).toBe(0)
    const gma = state.bodies.map((body) => body.filter((c) => c.method === 'getMultipleAccounts'))
    expect(gma.every((list) => list.length <= 1)).toBe(true)
    expect(gma.flat().every((c) => (c.params[0] as unknown[]).length <= 10)).toBe(true)
    expect(gma.flat()).toHaveLength(25)
    expect(state.maxInflight).toBeLessThanOrEqual(4)
  })

  it('拆分后的子请求：一个失败后不再发后面的', async () => {
    // 超过 10 个账户时报错给出上限；拆分后的请求全部 502
    const { state, fetchFn } = recorder(async (calls) => {
      await tick(2)
      const call = calls[0] as Call
      if ((call.params[0] as unknown[]).length > 10) {
        return json({ jsonrpc: '2.0', id: call.id, error: { code: -32602, message: 'A maximum of 10 accounts is allowed' } })
      }
      return new Response('upstream error', { status: 502 })
    })
    const rpc = new HttpRpc(uniqueUrl(), { fetch: fetchFn, batch: false })
    await expect(rpc.request('getMultipleAccounts', [ADDRS.slice(0, 100), {}])).rejects.toThrow(/502|Invalid JSON/)
    // 第一次 100 个被拒、学到 10 个；拆成 10 份后同时在途最多 4 个，失败后不再发剩下的（之前 10 份全发）
    expect(state.bodies.length).toBeLessThanOrEqual(5)
  })

  it('client 的分组读取用并发池：一个慢请求不挡住后面的请求', async () => {
    const started: number[] = []
    let finishedFirst = false
    let startedBeforeFirstDone = 0
    const node = createMockNode()
    const transport: RpcTransport = {
      async request<T>(method: string, params?: readonly unknown[]): Promise<T> {
        const index = started.push(started.length) - 1
        if (!finishedFirst && index > 0) startedBeforeFirstDone++
        await tick(index === 0 ? 60 : 2)
        if (index === 0) finishedFirst = true
        return node.request<T>(method, params)
      },
    }
    const sol = new SolanaClient(transport)
    await sol.accounts(ADDRS.slice(0, 600))
    expect(started).toHaveLength(6)
    // 之前按波次（3 个一波）要等第一个请求结束才发第 4 个；现在其余 5 个都在它结束前发出
    expect(startedBeforeFirstDone).toBe(5)
  })

  it('tolerant 读取（ownerTokens 补元数据）失败后不再发后面的请求', async () => {
    const mints = ADDRS.slice(0, 120)
    const accounts: Record<string, { owner: string; data: Uint8Array }> = {}
    mints.forEach((mint, i) => {
      accounts[mint] = { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) }
      accounts[ADDRS[300 + i] as string] = { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(mint, OWNER, 5n) }
    })
    const node = createMockNode({ accounts })
    let gma = 0
    const transport: RpcTransport = {
      async request<T>(method: string, params?: readonly unknown[]): Promise<T> {
        if (method === 'getMultipleAccounts') {
          gma++
          const { RpcError } = await import('../src/rpc.js')
          throw new RpcError('Too many requests', 429)
        }
        return node.request<T>(method, params)
      },
    }
    const list = await new SolanaClient(transport).ownerTokens(OWNER)
    expect(list.filter((t) => !t.native).every((t) => t.metadataStatus === 'failed')).toBe(true)
    // 120 个 mint + 120 个元数据账户 = 3 个请求；第一个失败后其余不再发（并发池最先的 3 个同时发出）
    expect(gma).toBeLessThanOrEqual(3)
  })
})

describe('429 / 413', () => {
  it('退避带随机抖动', () => {
    const samples = Array.from({ length: 50 }, () => retryDelay(0, null) as number)
    expect(samples.every((ms) => ms >= 375 && ms <= 625)).toBe(true)
    expect(new Set(samples).size).toBeGreaterThan(1)
    expect(retryDelay(2, undefined)).toBeGreaterThanOrEqual(1500)
  })

  it('有 Retry-After 时按它等；太长时不等，直接报错（交给上层换节点）', async () => {
    expect(retryDelay(0, '2')).toBe(2000)
    expect(retryDelay(0, '120')).toBeNull()
    let n = 0
    const quick = recorder((calls) => (n++ === 0 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : json(reply(calls[0] as Call, 5))))
    const started = Date.now()
    expect(await new HttpRpc(uniqueUrl(), { fetch: quick.fetchFn }).request('getSlot')).toBe(5)
    expect(Date.now() - started).toBeLessThan(300) // 没按默认的 500ms 起步等
    expect(quick.state.bodies).toHaveLength(2)

    const slow = recorder(() => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }))
    await expect(new HttpRpc(uniqueUrl(), { fetch: slow.fetchFn }).request('getSlot')).rejects.toThrow(/429/)
    expect(slow.state.bodies).toHaveLength(1)
  })

  it('413 后批量调小，冷却期过后恢复原来的大小', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { state, fetchFn } = recorder((calls) => (calls.length > 10 ? new Response('too large', { status: 413 }) : json(calls.map((c) => reply(c, 1)))))
    const rpc = new HttpRpc(uniqueUrl(), { fetch: fetchFn })
    const send = () => Promise.all(Array.from({ length: 20 }, (_, i) => rpc.request('getBalance', [String(i)])))
    await send()
    expect(state.bodies.map((b) => b.length)).toEqual([20, 10, 10])
    state.bodies.length = 0
    await send()
    expect(state.bodies.map((b) => b.length)).toEqual([10, 10]) // 冷却期内直接按 10 个
    vi.setSystemTime(Date.now() + 11 * 60 * 1000)
    state.bodies.length = 0
    await send()
    expect(state.bodies.map((b) => b.length)[0]).toBe(20) // 到期后重新尝试原来的批量大小
  })

  it('学到的节点限制有条目上限（淘汰最早的）', async () => {
    const url = uniqueUrl()
    const sizes: number[] = []
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body)) as Call
      const n = (call.params[0] as unknown[]).length
      sizes.push(n)
      if (n > 5) return json({ jsonrpc: '2.0', id: call.id, error: { code: -32602, message: 'Too many accounts requested' } })
      return json(reply(call))
    }) as typeof fetch
    await new HttpRpc(url, { fetch: fetchFn, batch: false }).request('getMultipleAccounts', [ADDRS.slice(0, 8), {}])
    sizes.length = 0
    await new HttpRpc(url, { fetch: fetchFn, batch: false }).request('getMultipleAccounts', [ADDRS.slice(0, 8), {}])
    expect(Math.max(...sizes)).toBeLessThanOrEqual(5) // 记住了
    for (let i = 0; i < 1001; i++) new HttpRpc(`https://evict-${urlId}-${i}.example`)
    sizes.length = 0
    await new HttpRpc(url, { fetch: fetchFn, batch: false }).request('getMultipleAccounts', [ADDRS.slice(0, 8), {}])
    expect(sizes[0]).toBe(8) // 已被淘汰，重新学
  })
})

describe('去重', () => {
  it('同一批里相同的只读调用只发一次，结果分给各调用方；写操作不去重', async () => {
    const { state, fetchFn } = recorder((calls) => json(calls.map((c) => reply(c, `r-${c.method}-${JSON.stringify(c.params)}`))))
    const rpc = new HttpRpc(uniqueUrl(), { fetch: fetchFn })
    const results = await Promise.all([
      rpc.request('getBalance', [OWNER, { commitment: 'confirmed' }]),
      rpc.request('getBalance', [OWNER, { commitment: 'confirmed' }]),
      rpc.request('getBalance', [OWNER, { commitment: 'finalized' }]),
      rpc.request('sendTransaction', ['tx']),
      rpc.request('sendTransaction', ['tx']),
    ])
    expect(results[0]).toBe(results[1])
    expect(results[2]).not.toBe(results[0])
    expect(state.bodies).toHaveLength(1)
    expect(state.bodies[0]?.map((c) => c.method)).toEqual(['getBalance', 'getBalance', 'sendTransaction', 'sendTransaction'])
  })

  it('去重后各调用方拿到各自的副本：一个改了结果不影响另一个', async () => {
    const { fetchFn } = recorder((calls, init) => {
      const out = calls.map((c) => reply(c, { context: { slot: 1 }, value: [{ lamports: 5 }] }))
      return json(Array.isArray(JSON.parse(String(init.body))) ? out : out[0])
    })
    const rpc = new HttpRpc(uniqueUrl(), { fetch: fetchFn })
    const [a, b] = (await Promise.all([rpc.request('getMultipleAccounts', [['x'], {}]), rpc.request('getMultipleAccounts', [['x'], {}])])) as Array<{ value: Array<{ lamports: number }> }>
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    a!.value[0]!.lamports = 99
    expect(b!.value[0]!.lamports).toBe(5)
  })

  it('去重后其中一个调用方取消，不影响其他调用方', async () => {
    const { state, fetchFn } = recorder(async (calls) => {
      await tick(5)
      return json(calls.length === 1 ? reply(calls[0] as Call, 3) : calls.map((c) => reply(c, 3)))
    })
    const rpc = new HttpRpc(uniqueUrl(), { fetch: fetchFn })
    const controller = new AbortController()
    const a = rpc.request('getSlot', [], { signal: controller.signal })
    const b = rpc.request('getSlot', [])
    await tick()
    controller.abort()
    await expect(a).rejects.toBeDefined()
    expect(await b).toBe(3)
    expect(state.bodies).toHaveLength(1)
    expect(state.signals[0]?.aborted).toBe(false)
  })

  it('#loadMeta 在途去重：两个查询同时要同一个 mint 的元数据，只读一次', async () => {
    const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
    const accounts = {
      [MINT]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) },
      [getMetadataAddress(MINT)]: { owner: METADATA_PROGRAM_ID, data: metaplexData({ mint: MINT, name: 'USD Coin', symbol: 'USDC' }) },
      [getAssociatedTokenAddress(OWNER, MINT, TOKEN_PROGRAM_ID)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(MINT, OWNER, 1n) },
      [getAssociatedTokenAddress(OTHER, MINT, TOKEN_PROGRAM_ID)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(MINT, OTHER, 2n) },
    }
    const node = createMockNode({ accounts, delay: 5 })
    const sol = new SolanaClient(node, { cluster: 'mainnet' })
    const [a, b] = await Promise.all([sol.ownerTokens(OWNER), sol.ownerTokens(OTHER)])
    expect(a.find((t) => t.token === MINT)?.symbol).toBe('USDC')
    expect(b.find((t) => t.token === MINT)?.symbol).toBe('USDC')
    const reads = node.calls.filter((c) => c.method === 'getMultipleAccounts' && (c.params[0] as string[]).includes(MINT))
    expect(reads).toHaveLength(1)
  })

  it('#loadMeta 在途去重：发起方取消不影响加入的查询', async () => {
    const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
    const accounts = {
      [MINT]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) },
      [getMetadataAddress(MINT)]: { owner: METADATA_PROGRAM_ID, data: metaplexData({ mint: MINT, name: 'USD Coin', symbol: 'USDC' }) },
      [getAssociatedTokenAddress(OWNER, MINT, TOKEN_PROGRAM_ID)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(MINT, OWNER, 1n) },
      [getAssociatedTokenAddress(OTHER, MINT, TOKEN_PROGRAM_ID)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(MINT, OTHER, 2n) },
    }
    const node = createMockNode({ accounts, delay: 10 })
    const aborted: boolean[] = []
    const transport: RpcTransport = {
      request: (method, params, options) => {
        const p = node.request(method, params)
        if (method === 'getMultipleAccounts') aborted.push(options?.signal?.aborted ?? false)
        return p as never
      },
    }
    const sol = new SolanaClient(transport, { cluster: 'mainnet' })
    const controller = new AbortController()
    const a = sol.ownerTokens(OWNER, { signal: controller.signal })
    const b = sol.ownerTokens(OTHER)
    await tick(15) // 两个扫描都结束，正在补元数据
    controller.abort()
    await expect(a).rejects.toBeDefined()
    expect((await b).find((t) => t.token === MINT)?.symbol).toBe('USDC')
  })
})

describe('审查修复：并发名额排队、mapPool、#loadMeta 的 slot 约束', () => {
  it('并发名额被占住不放（timeout: 0 的请求挂住）时，其他连接排队最多等 timeout，按超时报错', async () => {
    const url = uniqueUrl()
    const { fetchFn } = recorder((_calls, init) => hang(init))
    const holder = new HttpRpc(url, { fetch: fetchFn, timeout: 0, maxConcurrency: 1 })
    const controller = new AbortController()
    const held = holder.request('getSlot', [], { signal: controller.signal }).catch(() => null)
    await tick()
    const waiter = new HttpRpc(url, { fetch: fetchFn, timeout: 50, maxConcurrency: 1 })
    const started = Date.now()
    const err = await waiter.request('getEpochInfo').catch((e: unknown) => e)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(err).toMatchObject({ name: 'HttpError', timeout: true })
    controller.abort()
    await held
  })

  it('mapPool：一项出错后其余 worker 不再取后面的项', async () => {
    const { mapPool } = await import('../src/util.js')
    const started: number[] = []
    await expect(
      mapPool(Array.from({ length: 20 }, (_, i) => i), 3, async (i) => {
        started.push(i)
        await tick(2)
        if (i === 0) throw new Error('boom')
        return i
      }),
    ).rejects.toThrow('boom')
    await tick(30)
    expect(started.length).toBeLessThanOrEqual(5) // 之前 20 项全部执行
  })

  it('#loadMeta：不带 minContextSlot 的查询不加入带 minContextSlot 的读取（不继承它的 slot 约束和等待）', async () => {
    const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
    const node = createMockNode({
      accounts: {
        [MINT]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) },
        [getMetadataAddress(MINT)]: { owner: METADATA_PROGRAM_ID, data: metaplexData({ mint: MINT, name: 'USD Coin', symbol: 'USDC' }) },
        [getAssociatedTokenAddress(OWNER, MINT, TOKEN_PROGRAM_ID)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(MINT, OWNER, 1n) },
        [getAssociatedTokenAddress(OTHER, MINT, TOKEN_PROGRAM_ID)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(MINT, OTHER, 2n) },
      },
    })
    // 带 minContextSlot 的 getMultipleAccounts 总是“节点落后”（会每 500ms 重试，最多约 10 秒）；其余请求忽略 minContextSlot
    const transport: RpcTransport = {
      async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
        const last = params[params.length - 1] as { minContextSlot?: number } | undefined
        if (last?.minContextSlot !== undefined) {
          if (method === 'getMultipleAccounts') {
            const { RpcError } = await import('../src/rpc.js')
            throw new RpcError('Minimum context slot has not been reached', -32016)
          }
          const { minContextSlot: _, ...rest } = last
          return node.request<T>(method, [...params.slice(0, -1), rest])
        }
        return node.request<T>(method, params)
      },
    }
    const sol = new SolanaClient(transport, { cluster: 'mainnet' })
    const controller = new AbortController()
    const strict = sol.balances(OWNER, [MINT], { accounts: 'all', symbol: true, minContextSlot: 5, signal: controller.signal }).catch(() => null)
    await tick(30) // strict 已经在补读 mint / 元数据（并在等节点追上）
    const started = Date.now()
    const list = await sol.ownerTokens(OTHER)
    expect(Date.now() - started).toBeLessThan(400) // 之前会加入 strict 的读取，等它重试（每次 500ms）
    expect(list.find((t) => t.token === MINT)?.symbol).toBe('USDC')
    controller.abort()
    await strict
  })
})

describe('balances(owner, null)', () => {
  it('null 按“不传 mints”处理（扫描全部代币账户），不报 TypeError', async () => {
    const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const node = createMockNode({
      accounts: {
        [MINT]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) },
        [getAssociatedTokenAddress(OWNER, MINT, TOKEN_PROGRAM_ID)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(MINT, OWNER, 3_000_000n) },
      },
    })
    const sol = new SolanaClient(node)
    const list = await sol.balances(OWNER, null as unknown as undefined)
    expect(list.find((b) => b.token === MINT)).toMatchObject({ balance: '3000000', formatted: '3' })
    expect(node.calls.some((c) => c.method === 'getTokenAccountsByOwner')).toBe(true)
  })
})

describe('LP：按 LP mint 找池子限制并发', () => {
  it('同时进行的 getProgramAccounts 不超过 4 个', async () => {
    const mints = ADDRS.slice(0, 12)
    const accounts: Record<string, { owner: string; data: Uint8Array }> = {}
    for (const mint of mints) {
      accounts[mint] = { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6, mintAuthority: RAYDIUM_AMM_AUTHORITY }) }
      accounts[getAssociatedTokenAddress(OWNER, mint, TOKEN_PROGRAM_ID)] = { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(mint, OWNER, 100n) }
    }
    const node = createMockNode({ accounts })
    let inflight = 0
    let max = 0
    let lookups = 0
    const transport: RpcTransport = {
      async request<T>(method: string, params?: readonly unknown[]): Promise<T> {
        if (method !== 'getProgramAccounts') return node.request<T>(method, params)
        lookups++
        inflight++
        max = Math.max(max, inflight)
        await tick(3)
        inflight--
        return [] as T
      },
    }
    const list = await lpPositions(new SolanaClient(transport, { cluster: 'mainnet' }), OWNER, { mints, protocols: ['raydium-amm'] })
    expect(list).toEqual([])
    expect(lookups).toBe(12)
    expect(max).toBeLessThanOrEqual(4)
  })
})
