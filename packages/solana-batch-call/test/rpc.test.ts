import { describe, expect, it } from 'vitest'

import { AllNodesFailedError, FallbackRpc, GENESIS_HASHES, HttpRpc, NetworkCheckedRpc, NetworkMismatchError, RpcError, SolanaClient, isNodeFault } from '../src/index.js'
import { resolveSource } from '../src/source.js'
import { createMockNode } from './mock.js'

type Body = { id: number; method: string }

/** 模拟 fetch：handle 收到解析后的请求体（单条或数组），返回 [status, body] */
function mockFetch(handle: (body: Body | Body[]) => [number, unknown]) {
  const requests: Array<Body | Body[]> = []
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body | Body[]
    requests.push(body)
    const [status, response] = handle(body)
    return new Response(JSON.stringify(response), { status })
  }) as unknown as typeof fetch
  return { fetchFn, requests }
}

const ok = (b: Body) => ({ jsonrpc: '2.0', id: b.id, result: `${b.method}-ok` })

describe('HttpRpc 自动合并', () => {
  it('同一 tick 内的调用合并成一个 JSON-RPC 批量请求', async () => {
    const { fetchFn, requests } = mockFetch((body) => [200, Array.isArray(body) ? body.map(ok) : ok(body)])
    const rpc = new HttpRpc('https://rpc.example', { fetch: fetchFn })
    expect(await Promise.all([rpc.request('a'), rpc.request('b'), rpc.request('c')])).toEqual(['a-ok', 'b-ok', 'c-ok'])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toHaveLength(3)
  })

  it('超过 maxBatchSize 拆成多个批量请求', async () => {
    const { fetchFn, requests } = mockFetch((body) => [200, Array.isArray(body) ? body.map(ok) : ok(body)])
    const rpc = new HttpRpc('https://rpc.example', { fetch: fetchFn, maxBatchSize: 2 })
    await Promise.all([rpc.request('a'), rpc.request('b'), rpc.request('c')])
    expect(requests.map((r) => (Array.isArray(r) ? r.length : 1))).toEqual([2, 1])
  })

  it('节点不支持批量（返回非数组）时降级为逐条请求，并记住', async () => {
    const { fetchFn, requests } = mockFetch((body) =>
      Array.isArray(body) ? [400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }] : [200, ok(body)],
    )
    const rpc = new HttpRpc('https://rpc.example', { fetch: fetchFn })
    expect(await Promise.all([rpc.request('a'), rpc.request('b')])).toEqual(['a-ok', 'b-ok'])
    await Promise.all([rpc.request('c'), rpc.request('d')])
    // 第一次：1 个批量 + 2 个单条；之后直接单条
    expect(requests.map((r) => (Array.isArray(r) ? 'batch' : 'single'))).toEqual(['batch', 'single', 'single', 'single', 'single'])
  })

  it('“Batch of more than 3” 时按限制缩小批量', async () => {
    const { fetchFn, requests } = mockFetch((body) => {
      if (Array.isArray(body) && body.length > 3) {
        return [500, body.map((b) => ({ jsonrpc: '2.0', id: b.id, error: { code: -32600, message: 'Batch of more than 3 requests are not allowed on free tier' } }))]
      }
      return [200, Array.isArray(body) ? body.map(ok) : ok(body)]
    })
    const rpc = new HttpRpc('https://rpc.example', { fetch: fetchFn })
    const res = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((m) => rpc.request(m)))
    expect(res).toEqual(['a-ok', 'b-ok', 'c-ok', 'd-ok', 'e-ok'])
    expect(requests.slice(1).map((r) => (Array.isArray(r) ? r.length : 1))).toEqual([3, 2])
  })

  it('HTTP 429 和 JSON-RPC 429 都会退避重试', async () => {
    let n = 0
    const { fetchFn } = mockFetch((body) => {
      n++
      if (n === 1) return [429, { error: 'too many' }]
      if (n === 2) return [200, { jsonrpc: '2.0', id: (body as Body).id, error: { code: 429, message: 'Too many requests for a specific RPC call' } }]
      return [200, ok(body as Body)]
    })
    const rpc = new HttpRpc('https://rpc.example', { fetch: fetchFn })
    expect(await rpc.request('a')).toBe('a-ok')
    expect(n).toBe(3)
  })

  it('批量请求遇到 5xx 不降级（多半是节点本身的问题）', async () => {
    const { fetchFn } = mockFetch(() => [503, 'unavailable'])
    const rpc = new HttpRpc('https://rpc.example', { fetch: fetchFn })
    const res = await Promise.allSettled([rpc.request('a'), rpc.request('b')])
    expect(res.every((r) => r.status === 'rejected')).toBe(true)
  })

  it('JSON-RPC 错误转成 RpcError', async () => {
    const { fetchFn } = mockFetch((body) => [200, { jsonrpc: '2.0', id: (body as Body).id, error: { code: -32602, message: 'Invalid param' } }])
    const err = (await new HttpRpc('https://rpc.example', { fetch: fetchFn }).request('a').catch((e: unknown) => e)) as RpcError
    expect(err).toBeInstanceOf(RpcError)
    expect(err.code).toBe(-32602)
  })
})

describe('错误分类', () => {
  it('节点限制算节点问题（换节点），参数错误不算', () => {
    expect(isNodeFault(new RpcError('Access forbidden', 403))).toBe(true)
    expect(isNodeFault(new RpcError('Indexed requests require a personal token', -32602))).toBe(true)
    expect(isNodeFault(new RpcError('Request blocked', -32602))).toBe(true)
    expect(isNodeFault(new RpcError('Too many requests for a specific RPC call', 429))).toBe(true)
    expect(isNodeFault(new RpcError('Invalid param: WrongSize', -32602))).toBe(false)
    expect(isNodeFault(new Error('fetch failed'))).toBe(true)
  })
})

describe('FallbackRpc', () => {
  it('节点问题换下一个节点；确定性错误直接抛出', async () => {
    const limited = createMockNode({ errors: { getBalance: { code: -32602, message: 'Indexed requests require a personal token' } } })
    const good = createMockNode()
    expect((await new FallbackRpc([limited, good]).request<{ value: number }>('getBalance', ['x'])).value).toBe(0)

    const invalid = createMockNode({ errors: { getBalance: { code: -32602, message: 'Invalid param' } } })
    const second = createMockNode()
    await expect(new FallbackRpc([invalid, second]).request('getBalance', ['x'])).rejects.toThrow('Invalid param')
    expect(second.calls).toHaveLength(0)
  })

  it('出错的节点在冷却期内排到最后', async () => {
    const bad = createMockNode({ errors: { getBalance: { code: 403, message: 'Access forbidden' } } })
    const good = createMockNode()
    const rpc = new FallbackRpc([bad, good])
    await rpc.request('getBalance', ['x'])
    await rpc.request('getBalance', ['x'])
    expect(bad.calls).toHaveLength(1)
  })
})

describe('网络校验', () => {
  it('节点在别的网络上时报错（指定了 cluster）', async () => {
    const devnet = createMockNode({ genesis: GENESIS_HASHES.devnet })
    const client = new SolanaClient(devnet, { cluster: 'mainnet' })
    await expect(client.solBalances(['5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'])).rejects.toThrow(NetworkMismatchError)
  })

  it('没指定 cluster 的多节点：以第一个响应节点为准，不一致的节点被跳过', async () => {
    const mainnet = createMockNode({ genesis: GENESIS_HASHES.mainnet, errors: { getMultipleAccounts: { code: 403, message: 'Access forbidden' } } })
    const devnet = createMockNode({ genesis: GENESIS_HASHES.devnet })
    const client = new SolanaClient([mainnet, devnet])
    const err = (await client.solBalances(['5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9']).catch((e: unknown) => e)) as AllNodesFailedError
    expect(err).toBeInstanceOf(AllNodesFailedError)
    expect(err.errors.map((e) => e.error)).toEqual([expect.any(RpcError), expect.any(NetworkMismatchError)])
    expect(await client.getCluster()).toBe('mainnet')
  })

  it('校验与请求并行发出，结果按节点缓存', async () => {
    const node = createMockNode()
    const checked = new NetworkCheckedRpc(node, async () => GENESIS_HASHES.mainnet)
    await checked.request('getBalance', ['x'])
    await checked.request('getBalance', ['x'])
    expect(node.calls.filter((c) => c.method === 'getGenesisHash')).toHaveLength(1)
  })

  it('内置节点与单节点（未指定 cluster）不包校验层；单节点也包一层 FallbackRpc', () => {
    const node = (source: Parameters<typeof resolveSource>[0], cluster?: 'mainnet') => (resolveSource(source, cluster).transport as FallbackRpc).nodes[0]
    expect(resolveSource(undefined, 'mainnet').transport).toBeInstanceOf(FallbackRpc)
    expect(node(undefined, 'mainnet')).toBeInstanceOf(HttpRpc)
    expect(resolveSource('https://rpc.example', undefined).transport).toBeInstanceOf(FallbackRpc)
    expect(node('https://rpc.example')).toBeInstanceOf(HttpRpc)
    expect(node('https://rpc.example', 'mainnet')).toBeInstanceOf(NetworkCheckedRpc)
  })

  it('支持 web3.js Connection（rpcEndpoint）与自定义传输', () => {
    const fromConnection = (resolveSource({ rpcEndpoint: 'https://conn.example' }, undefined).transport as FallbackRpc).nodes[0] as HttpRpc
    expect(fromConnection.url).toBe('https://conn.example')
    const custom = createMockNode()
    expect((resolveSource(custom, undefined).transport as FallbackRpc).nodes[0]).toBe(custom)
    expect(() => resolveSource({} as never, undefined)).toThrow(/Unsupported RPC source/)
  })
})
