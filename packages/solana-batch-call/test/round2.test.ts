import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AllNodesFailedError,
  FallbackRpc,
  HttpError,
  HttpRpc,
  METADATA_PROGRAM_ID,
  NATIVE_MINT,
  SYSTEM_PROGRAM_ID,
  SolanaClient,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  exportTokenMetaCache,
  formatAmount,
  formatUnits,
  getAssociatedTokenAddress,
  getBalances,
  getMetadataAddress,
  getMultiBalances,
  getTokens,
  importTokenMetaCache,
  onRequest,
  parseTransferFeeConfig,
  persistTokenMetaCache,
  watchBalances,
  type RequestEvent,
  type RpcTransport,
} from '../src/index.js'
import { resetTokenMetaCache } from '../src/client.js'
import { resetNodeHealth } from '../src/rpc.js'
import { resetClientCache, resolveClientForTest } from '../src/shortcuts.js'
import { createMockNode, metaplexData, mintData, tokenAccountData, type MockAccount } from './mock.js'

const OWNER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
const FEE = 'BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG' // Token-2022，带转账手续费

function world(): Record<string, MockAccount> {
  return {
    [OWNER]: { lamports: 1_500_000_000n, owner: SYSTEM_PROGRAM_ID },
    [OTHER]: { lamports: 2_000_000_000n, owner: SYSTEM_PROGRAM_ID },
    [USDC]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) },
    [getMetadataAddress(USDC)]: { owner: METADATA_PROGRAM_ID, data: metaplexData({ mint: USDC, name: 'USD Coin', symbol: 'USDC' }) },
    [PYUSD]: { owner: TOKEN_2022_PROGRAM_ID, data: mintData({ decimals: 6, metadata: { name: 'PayPal USD', symbol: 'PYUSD', uri: '' } }) },
    [FEE]: {
      owner: TOKEN_2022_PROGRAM_ID,
      data: mintData({
        decimals: 9,
        metadata: { name: 'Fee Token', symbol: 'FEE', uri: '' },
        transferFee: { authority: OWNER, older: { epoch: 100n, maximumFee: 5_000n, basisPoints: 50 }, newer: { epoch: 600n, maximumFee: 9_000n, basisPoints: 200 }, withheld: 7n },
      }),
    },
    [getAssociatedTokenAddress(OWNER, USDC, TOKEN_PROGRAM_ID)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(USDC, OWNER, 1_000_000n) },
    [getAssociatedTokenAddress(OTHER, USDC, TOKEN_PROGRAM_ID)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(USDC, OTHER, 3_000_000n) },
    [getAssociatedTokenAddress(OTHER, PYUSD, TOKEN_2022_PROGRAM_ID)]: { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccountData(PYUSD, OTHER, 4_000_000n) },
  }
}

/** 按顺序返回结果 / 抛错的自定义节点 */
function scripted(label: string, ...steps: Array<unknown | (() => never)>) {
  const calls: string[] = []
  const node: RpcTransport & { calls: string[] } = {
    label,
    calls,
    async request<T>(method: string): Promise<T> {
      calls.push(method)
      const step = steps.length > 1 ? steps.shift() : steps[0]
      if (typeof step === 'function') return (step as () => never)()
      return step as T
    },
  }
  return node
}

const timeoutError = () => {
  throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
}
const serverError = () => {
  throw new HttpError('HTTP 503', 503)
}

beforeEach(() => {
  resetTokenMetaCache()
  resetClientCache()
  resetNodeHealth()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AllNodesFailedError', () => {
  it('所有节点都失败时带上每个节点的名称和原因；URL 只保留 host', async () => {
    const fetchFn = (async () => new Response('bad', { status: 503 })) as unknown as typeof fetch
    const rpc = new FallbackRpc([new HttpRpc('https://rpc.example/v2/SECRET_KEY?api-key=SECRET', { fetch: fetchFn, retries: 0 }), scripted('backup', serverError)])
    const err = (await rpc.request('getSlot').catch((e: unknown) => e)) as AllNodesFailedError
    expect(err).toBeInstanceOf(AllNodesFailedError)
    expect(err.errors.map((e) => e.node)).toEqual(['rpc.example', 'backup'])
    expect(err.errors.every((e) => e.error instanceof HttpError)).toBe(true)
    expect(err.message).toMatch(/rpc\.example: Invalid JSON from https:\/\/rpc\.example \(HTTP 503\).*backup: HTTP 503/)
    expect(err.message).not.toContain('SECRET')
  })

  it('单个节点失败时抛原始错误；确定性错误直接抛出', async () => {
    await expect(new FallbackRpc([scripted('only', serverError)]).request('getSlot')).rejects.toBeInstanceOf(HttpError)
    const invalid = createMockNode({ errors: { getBalance: { code: -32602, message: 'Invalid param' } } })
    const second = createMockNode()
    await expect(new FallbackRpc([invalid, second]).request('getBalance', ['x'])).rejects.toThrow('Invalid param')
    expect(second.calls).toHaveLength(0)
  })
})

describe('超时与出错分开', () => {
  it('超时只换节点、不冷却；连续 3 次超时才冷却；其他错误立即冷却', async () => {
    const slow = scripted('slow', timeoutError)
    const good = scripted('good', 'ok')
    const rpc = new FallbackRpc([slow, good])
    for (let i = 0; i < 3; i++) await rpc.request('getSlot')
    expect(slow.calls).toHaveLength(3) // 前 3 次都先试 slow（第 3 次后进入冷却）
    await rpc.request('getSlot')
    expect(slow.calls).toHaveLength(3)

    resetNodeHealth()
    const broken = scripted('broken', serverError)
    const rpc2 = new FallbackRpc([broken, good])
    await rpc2.request('getSlot')
    await rpc2.request('getSlot')
    expect(broken.calls).toHaveLength(1)
  })

  it('HttpRpc 超时的 HttpError 带 timeout 标记', async () => {
    const fetchFn = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as unknown as typeof fetch
    const err = (await new HttpRpc('https://slow.example', { fetch: fetchFn, timeout: 20 }).request('getSlot').catch((e: unknown) => e)) as HttpError
    expect(err).toBeInstanceOf(HttpError)
    expect(err.timeout).toBe(true)
  })

  it('节点健康状态全局共享：客户端重建后，刚出错的节点仍排在后面（URL 相同即同一节点）', async () => {
    const bad = scripted('bad', serverError)
    const good = scripted('good', 'ok')
    await new FallbackRpc([bad, good]).request('getSlot')
    await new FallbackRpc([bad, good]).request('getSlot')
    expect(bad.calls).toHaveLength(1)

    let hits = 0
    const fetchFn = (async () => {
      hits++
      return new Response('bad', { status: 503 })
    }) as unknown as typeof fetch
    const backup = scripted('backup', 'ok')
    await new FallbackRpc([new HttpRpc('https://flaky.example', { fetch: fetchFn, retries: 0 }), backup]).request('getSlot')
    await new FallbackRpc([new HttpRpc('https://flaky.example', { fetch: fetchFn, retries: 0 }), backup]).request('getSlot')
    expect(hits).toBe(1)
  })
})

describe('formatUnits', () => {
  it('与 formatAmount 相同（formatAmount 保留为别名）', () => {
    expect(formatUnits(1_500_000_000n, 9)).toBe('1.5')
    expect(formatAmount).toBe(formatUnits)
  })
})

describe('onRequest', () => {
  it('每次对节点的调用一条事件：节点、方法、耗时、成功与否、第几次尝试；单节点也触发；监听函数出错不影响请求', async () => {
    const events: RequestEvent[] = []
    const stop = onRequest((e) => events.push(e))
    const stopBad = onRequest(() => {
      throw new Error('listener bug')
    })
    try {
      await new FallbackRpc([scripted('a', serverError), scripted('b', 'ok')]).request('getSlot')
      await new SolanaClient(scripted('single', { context: { slot: 1 }, value: [null] })).accounts([OWNER])
    } finally {
      stop()
      stopBad()
    }
    expect(events.map((e) => [e.node, e.method, e.ok, e.attempt])).toEqual([
      ['a', 'getSlot', false, 0],
      ['b', 'getSlot', true, 1],
      ['single', 'getMultipleAccounts', true, 0],
    ])
    expect(events[0]?.error).toBeInstanceOf(HttpError)
    expect(events.every((e) => typeof e.ms === 'number')).toBe(true)
    await new FallbackRpc([scripted('c', 'ok')]).request('getSlot')
    expect(events).toHaveLength(3) // 取消后不再收到
  })
})

describe('signal', () => {
  it('已取消：直接 reject，不发请求', async () => {
    const node = createMockNode({ accounts: world() })
    const controller = new AbortController()
    controller.abort(new Error('switched token'))
    await expect(new SolanaClient(node).balances(OWNER, [USDC], { signal: controller.signal })).rejects.toThrow('switched token')
    await expect(getBalances(OWNER, [USDC], { provider: node, signal: controller.signal })).rejects.toThrow('switched token')
    expect(node.calls).toHaveLength(0)
  })

  it('中途取消：立即 reject；底层请求继续完成', async () => {
    const node = createMockNode({ accounts: world(), delay: 100 })
    const controller = new AbortController()
    const started = Date.now()
    const pending = new SolanaClient(node).balances(OWNER, [USDC], { signal: controller.signal })
    setTimeout(() => controller.abort(new Error('stale')), 10)
    await expect(pending).rejects.toThrow('stale')
    expect(Date.now() - started).toBeLessThan(80)
  })

  it('各查询方法都支持；快捷函数里的 signal 不影响客户端复用', async () => {
    const node = createMockNode({ accounts: world() })
    const aborted = AbortSignal.abort(new Error('x'))
    const sol = new SolanaClient(node)
    for (const run of [
      () => sol.accounts([OWNER], { signal: aborted }),
      () => sol.solBalances([OWNER], { signal: aborted }),
      () => sol.multiBalances([{ owner: OWNER, mints: [USDC] }], { signal: aborted }),
      () => sol.ownerTokens(OWNER, { signal: aborted }),
      () => sol.tokens([USDC], { signal: aborted }),
      () => sol.nfts([USDC], { signal: aborted }),
      () => sol.nftOwners([USDC], { signal: aborted }),
      () => sol.ownerNfts(OWNER, { signal: aborted }),
    ]) {
      await expect(run()).rejects.toThrow('x')
    }
    expect(node.calls).toHaveLength(0)
    const a = resolveClientForTest({ provider: node, signal: new AbortController().signal } as never)
    const b = resolveClientForTest({ provider: node, signal: new AbortController().signal } as never)
    expect(a).toBe(b)
  })
})

describe('minContextSlot / withSlot', () => {
  it('withSlot：结果项带读取时的 slot', async () => {
    const node = createMockNode({ accounts: world(), slot: 42 })
    const res = await new SolanaClient(node).balances(OWNER, [NATIVE_MINT, USDC], { withSlot: true })
    expect(res.map((r) => r.slot)).toEqual([42, 42])
    expect((await new SolanaClient(node).balances(OWNER, [USDC]))[0]).not.toHaveProperty('slot')
    expect((await new SolanaClient(node).solBalances([OWNER], { withSlot: true }))[0]?.slot).toBe(42)
  })

  it('节点高度不够时换下一个节点，不让落后的节点冷却', async () => {
    const behind = createMockNode({ accounts: world(), slot: 5 })
    const ahead = createMockNode({ accounts: world(), slot: 20 })
    const sol = new SolanaClient([behind, ahead], { cluster: 'mainnet' })
    const res = await sol.balances(OWNER, [USDC], { minContextSlot: 10 })
    expect(res[0]).toMatchObject({ balance: '1000000', slot: 20 })
    expect(behind.calls.find((c) => c.method === 'getMultipleAccounts')?.params[1]).toMatchObject({ minContextSlot: 10 })
    // 不带 minContextSlot 的请求仍然先用 behind（没有因为落后被冷却）
    await sol.balances(OWNER, [USDC])
    expect(behind.calls.filter((c) => c.method === 'getMultipleAccounts')).toHaveLength(2)
  })

  it('所有节点都落后：每 500ms 重试，追上后返回', async () => {
    const node = createMockNode({ accounts: world(), slot: 5 })
    const pending = new SolanaClient(node).solBalances([OWNER], { minContextSlot: 8 })
    setTimeout(() => (node.slot = 8), 700)
    const [res] = await pending
    expect(res).toMatchObject({ balance: '1500000000', slot: 8 })
    expect(node.calls.filter((c) => c.method === 'getMultipleAccounts').length).toBeGreaterThanOrEqual(2)
  })

  it('一直落后：约 10 秒后抛错', async () => {
    vi.useFakeTimers()
    const node = createMockNode({ accounts: world(), slot: 5 })
    const pending = new SolanaClient(node).solBalances([OWNER], { minContextSlot: 100 }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(11_000)
    const err = (await pending) as Error
    expect(err.message).toMatch(/Minimum context slot/)
    expect(node.calls.length).toBeGreaterThan(15)
  })
})

describe('multiBalances', () => {
  it('ATA 模式：多个钱包一次 getMultipleAccounts，结果与 queries 一一对应', async () => {
    const node = createMockNode({ accounts: world() })
    const res = await getMultiBalances(
      [
        { owner: OWNER, mints: [NATIVE_MINT, USDC] },
        { owner: OTHER, mints: [USDC, PYUSD] },
      ],
      { provider: node, withSlot: true },
    )
    expect(res.map((list) => list.map((r) => [r.token, r.balance]))).toEqual([
      [
        [NATIVE_MINT, '1500000000'],
        [USDC, '1000000'],
      ],
      [
        [USDC, '3000000'],
        [PYUSD, '4000000'],
      ],
    ])
    expect(node.calls.filter((c) => c.method === 'getMultipleAccounts')).toHaveLength(1)
    expect(res.flat().every((r) => r.slot === 1)).toBe(true)
  })

  it('tokenPrograms 照常生效；scan / accounts: all 时各自查询；owner 非法报错', async () => {
    const node = createMockNode({ accounts: world() })
    const sol = new SolanaClient(node)
    const filtered = await sol.multiBalances([{ owner: OTHER, mints: [USDC, PYUSD] }], { tokenPrograms: ['spl'] })
    expect(filtered[0]?.map((r) => r.token)).toEqual([USDC])
    const scanned = await sol.multiBalances(
      [
        { owner: OWNER, mints: [USDC] },
        { owner: OTHER, mints: [USDC] },
      ],
      { accounts: 'all' },
    )
    expect(scanned.map((list) => list[0]?.balance)).toEqual(['1000000', '3000000'])
    await expect(sol.multiBalances([{ owner: 'bad', mints: [USDC] }])).rejects.toThrow(/Invalid owner/)
  })
})

describe('watchBalances', () => {
  it('同样的参数共用一份轮询；只在余额变化时通知；全部取消后停止', async () => {
    const node = createMockNode({ accounts: world() })
    const seenA: string[][] = []
    const seenB: string[][] = []
    const stopA = watchBalances(OWNER, [NATIVE_MINT, USDC], { provider: node, interval: 30, onChange: (list) => seenA.push(list.map((r) => r.balance)) })
    const stopB = watchBalances(OWNER, [USDC, NATIVE_MINT], { provider: node, interval: 30, onChange: (list) => seenB.push(list.map((r) => r.balance)) })
    await new Promise((r) => setTimeout(r, 100))
    const requests = node.calls.filter((c) => c.method === 'getMultipleAccounts').length
    expect(requests).toBeGreaterThanOrEqual(2)
    expect(requests).toBeLessThanOrEqual(5) // 两个订阅共用一份轮询
    expect(seenA).toEqual([['1500000000', '1000000']]) // 余额没变，只通知第一次
    expect(seenB).toEqual([['1500000000', '1000000']])

    ;(node.accounts[OWNER] as MockAccount).lamports = 2_500_000_000n
    await new Promise((r) => setTimeout(r, 60))
    expect(seenA.at(-1)).toEqual(['2500000000', '1000000'])

    stopA()
    stopB()
    const after = node.calls.length
    await new Promise((r) => setTimeout(r, 80))
    expect(node.calls.length).toBe(after)
  })

  it('请求没完成时不重叠发起；失败调 onError 后继续轮询', async () => {
    const node = createMockNode({ accounts: world(), delay: 50 })
    let inflight = 0
    let peak = 0
    const counting: RpcTransport = {
      async request<T>(method: string, params?: readonly unknown[]): Promise<T> {
        inflight++
        peak = Math.max(peak, inflight)
        try {
          return await node.request<T>(method, params)
        } finally {
          inflight--
        }
      },
    }
    const errors: unknown[] = []
    const stop = watchBalances(OWNER, [NATIVE_MINT], { provider: counting, interval: 5, onChange: () => {}, onError: (e) => errors.push(e) })
    await new Promise((r) => setTimeout(r, 200))
    stop()
    expect(peak).toBe(1)

    let fail = true
    const flaky: RpcTransport = {
      async request<T>(method: string, params?: readonly unknown[]): Promise<T> {
        if (fail) {
          fail = false
          throw new Error('boom')
        }
        return createMockNode({ accounts: world() }).request<T>(method, params)
      },
    }
    const changes: unknown[] = []
    const stop2 = watchBalances(OWNER, [NATIVE_MINT], { provider: flaky, interval: 10, onChange: (l) => changes.push(l), onError: (e) => errors.push(e) })
    await new Promise((r) => setTimeout(r, 80))
    stop2()
    expect(errors.map((e) => (e as Error).message)).toContain('boom')
    expect(changes).toHaveLength(1)
  })

  it('后加入的订阅者立即收到已有的结果', async () => {
    const node = createMockNode({ accounts: world() })
    const stopA = watchBalances(OWNER, [USDC], { provider: node, interval: 1000, onChange: () => {} })
    await new Promise((r) => setTimeout(r, 20))
    const late: Array<[string[], unknown]> = []
    const stopB = watchBalances(OWNER, [USDC], { provider: node, interval: 1000, onChange: (list, prev) => late.push([list.map((r) => r.balance), prev]) })
    await Promise.resolve()
    expect(late).toEqual([[['1000000'], null]])
    expect(node.calls.filter((c) => c.method === 'getMultipleAccounts')).toHaveLength(1)
    stopA()
    stopB()
  })
})

describe('代币信息缓存持久化', () => {
  it('导出 / 导入：只导出按网络共享的条目；格式不对的条目跳过', async () => {
    const node = createMockNode({ accounts: world() })
    await new SolanaClient(node, { cluster: 'mainnet' }).tokens([USDC], { fields: ['decimals', 'symbol'] })
    await new SolanaClient(createMockNode({ accounts: world() })).tokens([PYUSD]) // 自定义节点、没指定 cluster：私有缓存
    const snapshot = JSON.parse(JSON.stringify(exportTokenMetaCache()))
    expect(snapshot.entries.map((e: [string]) => e[0])).toEqual([`mainnet:${USDC}`])

    resetTokenMetaCache()
    importTokenMetaCache({ ...snapshot, entries: [...snapshot.entries, ['mainnet:bad', { decimals: 1 }], ['mainnet:x', null], 'junk'] })
    const fresh = createMockNode({ accounts: world() })
    const [usdc] = await new SolanaClient(fresh, { cluster: 'mainnet' }).tokens([USDC], { fields: ['decimals', 'symbol'] })
    expect(usdc).toMatchObject({ decimals: 6, symbol: 'USDC' })
    expect(fresh.calls).toHaveLength(0) // 命中导入的缓存
    importTokenMetaCache({ version: 2, entries: [] }) // 不认识的版本忽略
  })

  it('persistTokenMetaCache：读入、防抖写回、停止时立即写回；坏数据丢弃', async () => {
    vi.useFakeTimers()
    const data = new Map<string, string>([['w3lib:solana-token-meta', '{not json']])
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: vi.fn((k: string, v: string) => void data.set(k, v)) }
    const stop = persistTokenMetaCache(store)
    const node = createMockNode({ accounts: world() })
    await new SolanaClient(node, { cluster: 'mainnet' }).tokens([USDC, PYUSD], { fields: ['decimals'] })
    expect(store.setItem).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1100)
    expect(store.setItem).toHaveBeenCalledTimes(1)
    expect(JSON.parse(data.get('w3lib:solana-token-meta') as string).entries).toHaveLength(2)

    // maxEntries：只保留最近写入的
    stop()
    resetTokenMetaCache()
    const stop2 = persistTokenMetaCache(store, { maxEntries: 1, key: 'other' })
    await new SolanaClient(createMockNode({ accounts: world() }), { cluster: 'mainnet' }).tokens([USDC, PYUSD], { fields: ['decimals'] })
    stop2() // 停止时立即写回
    expect(JSON.parse(data.get('other') as string).entries.map((e: [string]) => e[0])).toEqual([`mainnet:${PYUSD}`])

    resetTokenMetaCache()
    persistTokenMetaCache(store)() // 读入上一次保存的
    expect(exportTokenMetaCache().entries).toHaveLength(2)
  })
})

describe('transferFee', () => {
  it('parseTransferFeeConfig：解析扩展；SPL Token / 没有扩展时为 null', () => {
    const fee = parseTransferFeeConfig(world()[FEE]!.data!)
    expect(fee).toEqual({
      transferFeeConfigAuthority: OWNER,
      withdrawWithheldAuthority: null,
      withheldAmount: 7n,
      older: { epoch: 100n, maximumFee: 5_000n, basisPoints: 50 },
      newer: { epoch: 600n, maximumFee: 9_000n, basisPoints: 200 },
    })
    expect(parseTransferFeeConfig(world()[USDC]!.data!)).toBeNull()
    expect(parseTransferFeeConfig(world()[PYUSD]!.data!)).toBeNull()
  })

  it('tokens 的 transferFee 字段：按当前 epoch 选出生效的配置；没有手续费为 null，不算失败', async () => {
    const node = createMockNode({ accounts: world(), epoch: 500 })
    const res = await getTokens([FEE, USDC, PYUSD, NATIVE_MINT], { provider: node, fields: ['symbol', 'transferFee'] })
    expect(res[0]?.transferFee).toEqual({
      basisPoints: 50,
      maximumFee: '5000',
      epoch: '100',
      older: { basisPoints: 50, maximumFee: '5000', epoch: '100' },
      newer: { basisPoints: 200, maximumFee: '9000', epoch: '600' },
    })
    expect(res.slice(1).map((r) => [r.transferFee, r.success])).toEqual([
      [null, true],
      [null, true],
      [null, true],
    ])
    // 到了 newer.epoch 用新配置
    const later = await getTokens([FEE], { provider: createMockNode({ accounts: world(), epoch: 600 }), fields: ['transferFee'] })
    expect(later[0]?.transferFee).toMatchObject({ basisPoints: 200, maximumFee: '9000', epoch: '600' })
    // getEpochInfo 和账户读取在同一 tick 发出
    expect(node.calls.map((c) => c.method).sort()).toEqual(['getEpochInfo', 'getMultipleAccounts'])
  })
})
