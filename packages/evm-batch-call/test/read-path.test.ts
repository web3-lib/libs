/** 读取链路：取消传到底层、分片并发上限与单片重试、tryAll 走自动合并、代币元数据缓存、主币信息 */
import { AbiCoder, encodeBytes32String, type TransactionRequest } from 'ethers'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { multicall3Interface, resetMulticallCache } from '../src/aggregate.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { FallbackRpc, Provider, TRON_CHAIN_ID, TronProvider } from '../src/index.js'
import { MULTICALL3_ADDRESS } from '../src/multicall.js'
import { LruCache, TimeoutError } from '../src/util.js'
import { approvals } from '../src/subpaths/approvals.js'
import { createMockProvider, erc20Interface, fakeToken } from './mockProvider.js'

const USER = '0x4000000000000000000000000000000000000004'
const TOKEN = '0x1000000000000000000000000000000000000001'
const SPENDER = '0x2000000000000000000000000000000000000002'
const OLD_TOKEN = '0x3000000000000000000000000000000000000003'
/** 没有内置 multicall 的链：走 deployless */
const UNKNOWN_CHAIN = 99_999_999

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const owner = (i: number) => `0x${(i + 0x100).toString(16).padStart(40, '0')}`

/** 包一层延迟，记录发起的请求数和同时在途的最大数；failWhen 返回错误时这次请求失败 */
function slowNode(inner: ReturnType<typeof createMockProvider>, ms: number, failWhen?: (tx: TransactionRequest, attempt: number) => Error | null) {
  const stats = { started: 0, inFlight: 0, max: 0, byKey: new Map<string, number>() }
  const node = {
    async call(tx: TransactionRequest): Promise<string> {
      stats.started++
      stats.inFlight++
      stats.max = Math.max(stats.max, stats.inFlight)
      const key = chunkKey(tx)
      const attempt = (stats.byKey.get(key) ?? 0) + 1
      stats.byKey.set(key, attempt)
      try {
        await delay(ms)
        const err = failWhen?.(tx, attempt)
        if (err) throw err
        return await inner.call(tx)
      } finally {
        stats.inFlight--
      }
    },
    getBalance: inner.getBalance,
  }
  return { node, stats }
}

/** aggregate3 / deployless 请求里第一条子调用的 callData，用来区分是哪一片 */
function chunkKey(tx: TransactionRequest): string {
  return subCalls(tx)[0] ?? ''
}

function subCalls(tx: TransactionRequest): string[] {
  const data = String(tx.data)
  if (tx.to) {
    const [calls] = multicall3Interface.decodeFunctionData('aggregate3', data)
    return (calls as Array<[string, boolean, string]>).map((c) => c[2])
  }
  return []
}

const balanceCalls = (multi: Provider, n: number) => Array.from({ length: n }, (_, i) => multi.erc20(TOKEN).balanceOf(owner(i)))

afterEach(() => {
  vi.unstubAllGlobals()
  resetMulticallCache()
})

describe('取消传到底层', () => {
  it('分片循环：取消后不再发出剩下的分片，reject 的是 signal.reason', async () => {
    const { node, stats } = slowNode(createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], contracts: { [TOKEN]: fakeToken('T', 18) } }), 30)
    const multi = new Provider(56, node, { chunkSize: 10, maxConcurrentChunks: 1 })
    const ctl = new AbortController()
    const reason = new Error('stop')
    const pending = multi.all(balanceCalls(multi, 50), { signal: ctl.signal })
    await delay(10)
    ctl.abort(reason)
    await expect(pending).rejects.toBe(reason)
    await delay(120)
    expect(stats.started).toBe(1)
  })

  it('callPlain（不支持 deployless 的链）：取消后不再发出剩下的逐条 eth_call', async () => {
    const inner = createMockProvider({ noDeployless: true, contracts: { [TOKEN]: fakeToken('T', 18) } })
    const ctl = new AbortController()
    let plain = 0
    const node = {
      async call(tx: TransactionRequest) {
        if (tx.to) {
          plain++
          if (plain === 5) ctl.abort(new Error('stop'))
          await delay(5)
        }
        return inner.call(tx)
      },
      getBalance: inner.getBalance,
    }
    const multi = new Provider(UNKNOWN_CHAIN, node)
    await expect(multi.tryAll(balanceCalls(multi, 120), { signal: ctl.signal })).rejects.toThrow('stop')
    await delay(50)
    // 并发上限 50：已发出的第一轮之后不再发出新的（改动前 120 条全部发出）
    expect(plain).toBeLessThanOrEqual(50)
  })

  it('FallbackRpc：取消后不再换下一个节点（stallTimeout 的提前请求也不发），不计入节点健康状态', async () => {
    const slow = { call: () => new Promise<string>(() => {}), getBalance: async () => 0n }
    const failing = { call: vi.fn(async () => Promise.reject(new Error('boom'))), getBalance: async () => 0n }
    const second = { call: vi.fn(async () => '0x'), getBalance: async () => 0n }
    const ctl = new AbortController()
    const rpc = new FallbackRpc([slow, second], { stallTimeout: 40, timeout: 0 })
    const pending = rpc.call({ to: TOKEN, data: '0x' }, { signal: ctl.signal })
    await delay(10)
    ctl.abort(new Error('stop'))
    await expect(pending).rejects.toThrow('stop')
    await delay(80)
    expect(second.call).not.toHaveBeenCalled()

    // 已取消时一个节点都不请求
    const rpc2 = new FallbackRpc([failing, second])
    await expect(rpc2.call({ to: TOKEN, data: '0x' }, { signal: AbortSignal.abort(new Error('early')) })).rejects.toThrow('early')
    expect(failing.call).not.toHaveBeenCalled()
  })

  describe('Tron：fetch 中断、排队中的请求出队', () => {
    // 创世区块 blockID 的最后 4 字节是 chainId（主网 728126428 = 0x2b6653dc）
    const GENESIS = { blockID: `${'0'.repeat(56)}2b6653dc` }

    function stubFetch() {
      const signals: AbortSignal[] = []
      const paths: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init: RequestInit) => {
          const path = String(url).split('/').slice(-2).join('/')
          if (path === 'wallet/getblockbynum') {
            return Promise.resolve(new Response(JSON.stringify(GENESIS)))
          }
          paths.push(path)
          const signal = init.signal as AbortSignal
          signals.push(signal)
          // 一直不返回，直到被中断
          return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
        }),
      )
      return { signals, paths }
    }

    it('TronProvider：在途 fetch 被中断，排队中的请求出队、不再发出', async () => {
      const { signals } = stubFetch()
      const tron = new TronProvider({ fullHost: 'http://tron.local', concurrency: 1 })
      const ctl = new AbortController()
      const reason = new Error('stop')
      const first = tron.call({ to: TOKEN, data: '0x' }, { signal: ctl.signal })
      const queued = tron.call({ to: TOKEN, data: '0x' }, { signal: ctl.signal })
      await delay(10)
      expect(signals).toHaveLength(1)
      ctl.abort(reason)
      await expect(first).rejects.toBe(reason)
      await expect(queued).rejects.toBe(reason)
      await delay(20)
      expect(signals).toHaveLength(1)
      expect(signals[0]?.aborted).toBe(true)
      // 名额已释放：之后的请求照常发出
      const other = new AbortController()
      void tron.call({ to: TOKEN, data: '0x' }, { signal: other.signal }).catch(() => {})
      await delay(10)
      expect(signals).toHaveLength(2)
      other.abort()
    })

    it('Provider → 合并队列 → FallbackRpc → TronProvider：合并的调用方都取消后才中断共享请求', async () => {
      const { signals, paths } = stubFetch()
      const multi = new Provider(TRON_CHAIN_ID.mainnet, 'http://tron.local')
      const a = new AbortController()
      const b = new AbortController()
      const reasonA = new Error('a')
      const reasonB = new Error('b')
      const pa = multi.tokens(['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'], { signal: a.signal })
      const pb = multi.tokens(['TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8'], { signal: b.signal })
      await delay(30)
      expect(paths).toEqual(['wallet/triggerconstantcontract'])
      a.abort(reasonA)
      await expect(pa).rejects.toBe(reasonA)
      await delay(10)
      // 另一个调用方还在等：共享的请求不中断
      expect(signals[0]?.aborted).toBe(false)
      b.abort(reasonB)
      await expect(pb).rejects.toBe(reasonB)
      await delay(10)
      expect(signals[0]?.aborted).toBe(true)
    })
  })
})

describe('分片并发上限与单片重试', () => {
  it('合约路径：同时在途的分片 ≤ maxConcurrentChunks（默认 4）', async () => {
    const mock = () => createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], contracts: { [TOKEN]: fakeToken('T', 18, { [owner(3)]: 7n }) } })
    const def = slowNode(mock(), 20)
    const multi = new Provider(56, def.node, { chunkSize: 10 })
    const res = await multi.all(balanceCalls(multi, 100))
    expect(res[3]).toBe(7n)
    expect(def.stats.started).toBe(10)
    expect(def.stats.max).toBe(4)

    const two = slowNode(mock(), 20)
    const multi2 = new Provider(56, two.node, { chunkSize: 10, maxConcurrentChunks: 2 })
    await multi2.all(balanceCalls(multi2, 100))
    expect(two.stats.max).toBe(2)
  })

  it('deployless 按 48KB 切片也受同一个上限约束（外层分片 × 内层切片合计）', { timeout: 30_000 }, async () => {
    const { node, stats } = slowNode(createMockProvider({ contracts: { [TOKEN]: fakeToken('T', 18) } }), 20)
    const multi = new Provider(UNKNOWN_CHAIN, node, { chunkSize: 300, maxConcurrentChunks: 2 })
    const res = await multi.tryAll(balanceCalls(multi, 600))
    expect(res).toHaveLength(600)
    expect(stats.started).toBeGreaterThanOrEqual(4)
    expect(stats.max).toBeLessThanOrEqual(2)
  })

  it('单片限频：只重试这一片，其他片的结果保留', async () => {
    const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], contracts: { [TOKEN]: fakeToken('T', 18, { [owner(15)]: 9n }) } })
    const second = erc20Interface.encodeFunctionData('balanceOf', [owner(10)])
    const { node, stats } = slowNode(mock, 5, (tx, attempt) => (chunkKey(tx) === second && attempt === 1 ? new Error('429 Too Many Requests') : null))
    const multi = new Provider(56, node, { chunkSize: 10 })
    const res = await multi.all(balanceCalls(multi, 30))
    expect(res[15]).toBe(9n)
    expect(stats.started).toBe(4)
    expect(stats.byKey.get(second)).toBe(2)
    expect([...stats.byKey.values()].filter((n) => n === 1)).toHaveLength(2)
  })

  it('一直限频：最多重试 2 次后按原错误抛出；非限频 / 超时的错误不重试', async () => {
    const second = erc20Interface.encodeFunctionData('balanceOf', [owner(10)])
    const limited = slowNode(createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], contracts: { [TOKEN]: fakeToken('T', 18) } }), 1, (tx) =>
      chunkKey(tx) === second ? new Error('rate limit exceeded') : null,
    )
    const multi = new Provider(56, limited.node, { chunkSize: 10 })
    await expect(multi.all(balanceCalls(multi, 30))).rejects.toThrow('rate limit exceeded')
    expect(limited.stats.byKey.get(second)).toBe(3)

    const broken = slowNode(createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], contracts: { [TOKEN]: fakeToken('T', 18) } }), 1, (tx) =>
      chunkKey(tx) === second ? new Error('connection reset') : null,
    )
    const multi2 = new Provider(56, broken.node, { chunkSize: 10 })
    await expect(multi2.all(balanceCalls(multi2, 30))).rejects.toThrow('connection reset')
    expect(broken.stats.byKey.get(second)).toBe(1)
  })
})

describe('tryAll / tryEach 走自动合并队列', () => {
  it('与同一时刻的 call() 合成一次请求，相同调用去重；编码失败的条目为 null', async () => {
    const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], contracts: { [TOKEN]: fakeToken('T', 18, { [USER]: 5n }) } })
    const multi = new Provider(56, mock)
    const t = multi.erc20(TOKEN)
    const [single, list, each] = await Promise.all([
      multi.call(t.balanceOf(USER)),
      multi.tryAll([t.balanceOf(USER), t.decimals(), multi.erc20('0xnot-an-address').decimals()]),
      multi.tryEach([t.decimals()], [true]),
    ])
    expect(single).toBe(5n)
    expect(list).toEqual([5n, 18n, null])
    expect(each).toEqual([18n])
    expect(mock.calls).toHaveLength(1)
    expect(subCalls(mock.calls[0] as TransactionRequest)).toHaveLength(2)
  })

  it('有不允许失败的条目时语义不变：它 revert 时整体抛错', async () => {
    const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], contracts: { [TOKEN]: fakeToken('T', 18) } })
    const multi = new Provider(56, mock)
    const c = multi.contract(TOKEN, erc20Interface.fragments.map((f) => f.format('full')))
    await expect(multi.tryEach([c.boom(), c.decimals()], [false, true])).rejects.toThrow()
    expect(await multi.tryEach([c.boom(), c.decimals()], [true, false])).toEqual([null, 18n])
  })
})

describe('代币元数据缓存', () => {
  it('approvals：decimals / symbol 读写共用缓存（第二次不再查），symbol 兼容 bytes32', async () => {
    resetDecimalsCache()
    const bytes32Symbol = (data: string) => {
      if (data.startsWith(erc20Interface.getFunction('symbol')!.selector)) {
        return { success: true, returnData: AbiCoder.defaultAbiCoder().encode(['bytes32'], [encodeBytes32String('MKR')]) }
      }
      return fakeToken('X', 18)(data, {})
    }
    const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], contracts: { [TOKEN]: fakeToken('AAA', 6), [OLD_TOKEN]: bytes32Symbol } })
    const multi = new Provider(56, mock)
    const query = { tokens: [TOKEN, OLD_TOKEN], spenders: [SPENDER], permit2: false }
    const first = await approvals(multi, USER, query)
    expect(first.map((a) => (a.type === 'erc20' ? [a.token, a.symbol, a.decimals] : null))).toEqual([
      [TOKEN, 'AAA', 6],
      [OLD_TOKEN, 'MKR', 18],
    ])
    // 额度和元数据合成一次 multicall
    expect(mock.calls).toHaveLength(1)
    const decimalsSelector = erc20Interface.getFunction('decimals')!.selector
    const symbolSelector = erc20Interface.getFunction('symbol')!.selector
    await approvals(multi, USER, query)
    const again = subCalls(mock.calls[1] as TransactionRequest)
    expect(again.filter((d) => d.startsWith(decimalsSelector) || d.startsWith(symbolSelector))).toHaveLength(0)
    // balances 也能直接用 approvals 写进去的缓存
    const [bal] = await multi.balances(USER, [OLD_TOKEN], { symbol: true })
    expect(bal).toMatchObject({ symbol: 'MKR', decimals: 18 })
    expect(subCalls(mock.calls[2] as TransactionRequest)).toHaveLength(1)
  })
})

describe('主币信息', () => {
  it('nativeCurrency()：配置 > 内置表；Tron 测试网为 TRX / 6 位', async () => {
    const mock = createMockProvider()
    expect(await new Provider(56, mock).nativeCurrency()).toEqual({ decimals: 18, symbol: 'BNB', name: 'BNB Chain Native Token' })
    expect(await new Provider(56, mock, { nativeSymbol: 'XBNB', nativeDecimals: 8 }).nativeCurrency()).toMatchObject({ decimals: 8, symbol: 'XBNB' })
    expect(await new Provider(TRON_CHAIN_ID.shasta, mock).nativeCurrency()).toEqual({ decimals: 6, symbol: 'TRX', name: 'TRON' })
    expect(await new Provider(TRON_CHAIN_ID.nile, mock).nativeCurrency()).toEqual({ decimals: 6, symbol: 'TRX', name: 'TRON' })
    expect(await new Provider(UNKNOWN_CHAIN, mock).nativeCurrency()).toEqual({ decimals: 18, symbol: null, name: null })
  })
})

describe('审查修正', () => {
  it('并发闸门按 Provider 共用：互不合并的两次查询合计在途也 ≤ maxConcurrentChunks', async () => {
    const { node, stats } = slowNode(createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], contracts: { [TOKEN]: fakeToken('T', 18) } }), 20)
    const multi = new Provider(56, node, { maxConcurrentChunks: 1 })
    // blockTag 不同：进不同的合并队列，各发一次 eth_call
    await Promise.all([multi.all(balanceCalls(multi, 3), { blockTag: 1 }), multi.all(balanceCalls(multi, 3), { blockTag: 2 })])
    expect(stats.started).toBe(2)
    expect(stats.max).toBe(1)
  })

  it('逐条 eth_call 兜底也按 Provider 共用上限 50', async () => {
    const inner = createMockProvider({ noDeployless: true, contracts: { [TOKEN]: fakeToken('T', 18) } })
    let inFlight = 0
    let max = 0
    const node = {
      async call(tx: TransactionRequest) {
        if (!tx.to) return inner.call(tx)
        inFlight++
        max = Math.max(max, inFlight)
        await delay(5)
        inFlight--
        return inner.call(tx)
      },
      getBalance: inner.getBalance,
    }
    const multi = new Provider(UNKNOWN_CHAIN, node)
    await Promise.all([multi.all(balanceCalls(multi, 40), { blockTag: 1 }), multi.all(balanceCalls(multi, 40), { blockTag: 2 })])
    expect(max).toBeLessThanOrEqual(50)
    expect(max).toBeGreaterThan(1)
  })

  it('超时不整片重发（ethers 已超时的请求中断不了，重发只会叠加节点负载）', async () => {
    const second = erc20Interface.encodeFunctionData('balanceOf', [owner(10)])
    const { node, stats } = slowNode(createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], contracts: { [TOKEN]: fakeToken('T', 18) } }), 1, (tx) =>
      chunkKey(tx) === second ? new TimeoutError(10) : null,
    )
    const multi = new Provider(56, node, { chunkSize: 10 })
    await expect(multi.all(balanceCalls(multi, 30))).rejects.toThrow('timed out')
    expect(stats.byKey.get(second)).toBe(1)
  })

  it('够一批的 tryAll 直接请求，不等合并窗口（batch.wait）', async () => {
    const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], contracts: { [TOKEN]: fakeToken('T', 18) } })
    const multi = new Provider(56, mock, { chunkSize: 50, batch: { wait: 300 } })
    let started = Date.now()
    expect(await multi.tryAll(balanceCalls(multi, 60))).toHaveLength(60)
    expect(Date.now() - started).toBeLessThan(200)
    // 小查询照常进合并队列，等收集窗口
    started = Date.now()
    await multi.tryAll(balanceCalls(multi, 3))
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
  })

  it('Tron minInterval：排队中取消的请求退回时间槽，后面的请求不白等', async () => {
    const starts: number[] = []
    const tron = new TronProvider({ minInterval: 150, concurrency: 10, request: async () => (starts.push(Date.now()), {}) })
    const t0 = Date.now()
    await tron.request('a')
    const ctl = new AbortController()
    const cancelled = tron.request('b', {}, { signal: ctl.signal })
    await delay(10)
    ctl.abort(new Error('stop'))
    await expect(cancelled).rejects.toThrow('stop')
    await tron.request('c')
    // c 用的是 b 退回的那个时间槽（约 150ms），而不是排在 b 后面（约 300ms）
    expect(starts).toHaveLength(2)
    expect((starts[1] as number) - t0).toBeLessThan(250)
    expect((starts[1] as number) - (starts[0] as number)).toBeGreaterThanOrEqual(140)
  })

  it('LruCache：满了淘汰最久没用的一条', () => {
    const lru = new LruCache<string, number>(2)
    lru.set('a', 1)
    lru.set('b', 2)
    expect(lru.get('a')).toBe(1)
    lru.set('c', 3)
    expect(lru.get('b')).toBeUndefined()
    expect(lru.get('a')).toBe(1)
    expect(lru.get('c')).toBe(3)
    expect(lru.size).toBe(2)
  })
})
