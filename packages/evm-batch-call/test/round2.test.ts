import { makeError } from 'ethers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AllNodesFailedError, FallbackRpc, MULTICALL3_ADDRESS, NATIVE_TOKEN, Provider, onRequest, type RequestEvent } from '../src/index.js'
import { resetNodeHealth } from '../src/fallback.js'
import { nodeLabel } from '../src/source.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const USER = '0x4000000000000000000000000000000000000004'

/** 按脚本应答的节点：'ok' 返回 1n，'fail' 报 503，'hang' 不返回 */
function node(name: string, log: string[], script: () => 'ok' | 'fail' | 'hang') {
  return {
    async call(): Promise<string> {
      throw new Error('unused')
    },
    getBalance(): Promise<bigint> {
      log.push(name)
      const action = script()
      if (action === 'ok') return Promise.resolve(1n)
      if (action === 'fail') return Promise.reject(makeError(`${name} 503`, 'SERVER_ERROR', { request: null as any, response: null as any }))
      return new Promise(() => {})
    },
  }
}

beforeEach(() => resetNodeHealth())

describe('AllNodesFailedError', () => {
  it('所有节点都失败时带上每个节点的标识和原因；单节点抛原始错误', async () => {
    const log: string[] = []
    const rpc = new FallbackRpc([node('a', log, () => 'fail'), node('b', log, () => 'fail')], {}, [
      { label: 'rpc-a.example', key: 'https://rpc-a.example/KEY' },
      { label: 'rpc-b.example', key: 'https://rpc-b.example/KEY' },
    ])
    const err = await rpc.getBalance(USER).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AllNodesFailedError)
    expect((err as AllNodesFailedError).errors.map((e) => e.node)).toEqual(['rpc-a.example', 'rpc-b.example'])
    expect((err as Error).message).toMatch(/rpc-a\.example: .*a 503.*rpc-b\.example: .*b 503/)
    expect((err as Error).message).not.toMatch(/KEY/)

    const single = new FallbackRpc([node('c', log, () => 'fail')])
    await expect(single.getBalance(USER)).rejects.toMatchObject({ code: 'SERVER_ERROR' })
  })

  it('节点标识：URL 只取 host，不含 path / query 里的 Key', () => {
    expect(nodeLabel('https://eth-mainnet.g.alchemy.com/v2/SECRET?key=1')).toBe('eth-mainnet.g.alchemy.com')
    expect(nodeLabel({ request: async () => null } as any)).toBe('wallet')
  })
})

describe('超时与出错分开计', () => {
  it('超时只换节点、不冷却；连续 3 次超时才冷却', async () => {
    const log: string[] = []
    const rpc = new FallbackRpc([node('slow', log, () => 'hang'), node('b', log, () => 'ok')], { timeout: 20 })
    for (let i = 0; i < 3; i++) {
      await rpc.getBalance(USER)
    }
    // 前 3 次都先试 slow（超时不冷却）
    expect(log).toEqual(['slow', 'b', 'slow', 'b', 'slow', 'b'])
    log.length = 0
    await rpc.getBalance(USER)
    expect(log).toEqual(['b']) // 连续 3 次超时后冷却
  })

  it('出错立即冷却', async () => {
    const log: string[] = []
    const rpc = new FallbackRpc([node('bad', log, () => 'fail'), node('b', log, () => 'ok')])
    await rpc.getBalance(USER)
    log.length = 0
    await rpc.getBalance(USER)
    expect(log).toEqual(['b'])
  })
})

describe('节点健康状态全局共享', () => {
  it('同一节点（URL / 对象）在新建的 FallbackRpc / Provider 里仍处于冷却', async () => {
    const log: string[] = []
    const bad = node('bad', log, () => 'fail')
    const good = node('good', log, () => 'ok')
    await new FallbackRpc([bad, good]).getBalance(USER)
    log.length = 0
    await new FallbackRpc([bad, good]).getBalance(USER) // 新实例：bad 仍在冷却
    expect(log).toEqual(['good'])

    const info = (url: string) => ({ label: url, key: url })
    const badByUrl = node('bad2', log, () => 'fail')
    await new FallbackRpc([badByUrl, good], {}, [info('https://x.example'), info('https://y.example')]).getBalance(USER)
    log.length = 0
    // 不同的连接对象，但是同一个 URL
    await new FallbackRpc([node('bad3', log, () => 'fail'), good], {}, [info('https://x.example'), info('https://y.example')]).getBalance(USER)
    expect(log).toEqual(['good'])
  })
})

describe('onRequest', () => {
  const events: RequestEvent[] = []
  let off: () => void
  beforeEach(() => {
    events.length = 0
    off = onRequest((e) => events.push(e))
  })
  afterEach(() => off())

  it('每次对节点的请求都触发：节点、方法、耗时、是否成功、第几个节点', async () => {
    const log: string[] = []
    const rpc = new FallbackRpc([node('a', log, () => 'fail'), node('b', log, () => 'ok')], {}, [
      { label: 'a.example', key: 'https://a.example' },
      { label: 'b.example', key: 'https://b.example' },
    ])
    await rpc.getBalance(USER)
    expect(events.map((e) => [e.node, e.method, e.ok, e.attempt])).toEqual([
      ['a.example', 'getBalance', false, 0],
      ['b.example', 'getBalance', true, 1],
    ])
    expect(events[0]?.error).toBeTruthy()
    expect(typeof events[1]?.ms).toBe('number')
  })

  it('单节点 Provider 的 multicall 也触发；监听函数出错不影响请求；取消订阅后不再触发', async () => {
    const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], balances: { [USER]: 5n } })
    const offBad = onRequest(() => {
      throw new Error('listener bug')
    })
    const res = await new Provider(56, mock).balances(USER, [NATIVE_TOKEN])
    offBad()
    expect(res[0]?.balance).toBe('5')
    expect(events.map((e) => [e.node, e.method, e.ok, e.attempt])).toEqual([['provider', 'call', true, 0]])
    off()
    await new Provider(56, mock).balances(USER, [NATIVE_TOKEN])
    expect(events).toHaveLength(1)
  })
})

describe('formatUnits / 代币信息缓存', () => {
  it('formatUnits 与 formatAmount 相同', async () => {
    const { formatUnits, formatAmount } = await import('../src/index.js')
    expect(formatUnits(1_234_500_000n, 6)).toBe('1234.5')
    expect(formatAmount).toBe(formatUnits)
  })

  it('name / symbol 1 小时过期，decimals 不过期', async () => {
    const { getCachedTokenMeta, setCachedTokenMeta, resetDecimalsCache } = await import('../src/erc20.js')
    resetDecimalsCache()
    const now = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now)
    setCachedTokenMeta(1, '0xAA', { decimals: 6, symbol: 'AA', name: 'A' })
    expect(getCachedTokenMeta(1, '0xaa')).toEqual({ decimals: 6, symbol: 'AA', name: 'A' })
    spy.mockReturnValue(now + 61 * 60 * 1000)
    expect(getCachedTokenMeta(1, '0xaa')).toEqual({ decimals: 6 })
    spy.mockRestore()
  })

  it('导出 / 导入 / 持久化到 localStorage 风格的存储', async () => {
    vi.useFakeTimers()
    try {
      const { exportTokenMetaCache, importTokenMetaCache, persistTokenMetaCache, getCachedTokenMeta, setCachedTokenMeta, resetDecimalsCache } = await import('../src/erc20.js')
      resetDecimalsCache()
      setCachedTokenMeta(56, '0x' + '1'.repeat(40), { decimals: 18 })
      setCachedTokenMeta(728126428, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', { decimals: 6 })
      const snapshot = JSON.parse(JSON.stringify(exportTokenMetaCache()))
      resetDecimalsCache()
      importTokenMetaCache({ version: 1, entries: [['bad', {}], 'x', ['1:0xab', { decimals: 'nope' }]] }) // 格式不对的忽略
      importTokenMetaCache(snapshot)
      expect(getCachedTokenMeta(56, '0x' + '1'.repeat(40)).decimals).toBe(18)
      expect(getCachedTokenMeta(728126428, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t').decimals).toBe(6)
      expect(exportTokenMetaCache(1).entries).toHaveLength(1)

      const data = new Map<string, string>()
      const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
      const stop = persistTokenMetaCache(store)
      setCachedTokenMeta(1, '0x' + '2'.repeat(40), { decimals: 8 })
      expect(data.size).toBe(0) // 防抖
      vi.advanceTimersByTime(1000)
      expect(JSON.parse(data.get('w3lib:evm-token-meta') as string).entries).toHaveLength(3)
      stop()

      resetDecimalsCache()
      store.setItem('w3lib:evm-token-meta', '{broken')
      expect(() => persistTokenMetaCache(store)()).not.toThrow()
      persistTokenMetaCache({ getItem: () => JSON.stringify(snapshot), setItem: () => {} })()
      expect(getCachedTokenMeta(56, '0x' + '1'.repeat(40)).decimals).toBe(18)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('signal', () => {
  const TOKEN = '0x1000000000000000000000000000000000000001'
  function setup() {
    const mock = createMockProvider({ contracts: {}, multicallAddresses: [MULTICALL3_ADDRESS], balances: { [USER]: 5n } })
    return { mock, multi: new Provider(56, mock) }
  }

  it('已取消：直接 reject，不发请求', async () => {
    const { mock, multi } = setup()
    const signal = AbortSignal.abort()
    await expect(multi.balances(USER, [NATIVE_TOKEN], { signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(multi.tokens([TOKEN], { signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(multi.all([multi.getEthBalance(USER)], { signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(multi.allowances(USER, USER, [TOKEN], { signal })).rejects.toMatchObject({ name: 'AbortError' })
    const { getBalances } = await import('../src/index.js')
    await expect(getBalances(USER, [NATIVE_TOKEN], { chainId: 56, provider: mock, signal })).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((r) => setTimeout(r, 10))
    expect(mock.calls).toHaveLength(0)
  })

  it('执行中取消：该调用立即 reject，同批合并的其他调用照常拿到结果', async () => {
    const { mock, multi } = setup()
    const controller = new AbortController()
    const a = multi.balances(USER, [NATIVE_TOKEN], { signal: controller.signal })
    const b = multi.balances(USER, [NATIVE_TOKEN])
    controller.abort(new Error('switched token'))
    await expect(a).rejects.toThrow('switched token')
    expect((await b)[0]?.balance).toBe('5')
    expect(mock.calls).toHaveLength(1)
  })

  it('signal 不进 Provider 配置（不影响快捷函数复用实例）', async () => {
    const { resolveProviderForTest } = await import('../src/shortcuts.js')
    const { mock } = setup()
    const a = resolveProviderForTest({ chainId: 56, provider: mock })
    expect(resolveProviderForTest({ chainId: 56, provider: mock, signal: new AbortController().signal })).toBe(a)
  })
})

describe('withBlock / minBlock', () => {
  const TOKEN = '0x1000000000000000000000000000000000000001'
  const mockAt = (blockNumber: number | (() => number), multicall = true) =>
    createMockProvider({
      contracts: { [TOKEN]: fakeToken('AAA', 6, { [USER]: 7n }) },
      multicallAddresses: multicall ? [MULTICALL3_ADDRESS] : [],
      balances: { [USER]: 5n },
      blockNumber,
    })

  it('withBlock：结果带区块号，与数据在同一次 eth_call 里（合约模式和 deployless）', async () => {
    for (const multicall of [true, false]) {
      const mock = mockAt(123, multicall)
      const multi = new Provider(56, mock, { deployless: !multicall })
      const res = await multi.balances(USER, [NATIVE_TOKEN, TOKEN], { withBlock: true })
      expect(res.map((r) => [r.balance, r.blockNumber])).toEqual([
        ['5', 123],
        ['7', 123],
      ])
      expect(mock.calls).toHaveLength(1)
      expect((await multi.tokens([TOKEN], { withBlock: true }))[0]?.blockNumber).toBe(123)
      expect((await multi.allowances(USER, USER, [TOKEN], { withBlock: true }))[0]?.blockNumber).toBe(123)
      expect((await multi.balances(USER, [TOKEN]))[0]).not.toHaveProperty('blockNumber')
    }
  })

  it('minBlock：第一个节点落后时按 minBlock 重查，自动换到跟上的节点', async () => {
    const behind = mockAt(100)
    const ahead = mockAt(105)
    const multi = new Provider(56, [behind, ahead])
    const res = await multi.balances(USER, [NATIVE_TOKEN, TOKEN], { minBlock: 103 })
    expect(res.map((r) => [r.balance, r.blockNumber])).toEqual([
      ['5', 103],
      ['7', 103],
    ])
    expect(ahead.calls.at(-1)?.blockTag).toBe(103)
  })

  it('minBlock：节点已经跟上时不重查，结果是最新区块', async () => {
    const mock = mockAt(110)
    const res = await new Provider(56, mock).balances(USER, [TOKEN], { minBlock: 103 })
    expect(res[0]?.blockNumber).toBe(110)
    expect(mock.calls).toHaveLength(1)
  })

  it('minBlock：所有节点都落后时稍等重试，跟上后返回', async () => {
    const started = Date.now()
    const mock = mockAt(() => (Date.now() - started > 500 ? 103 : 100))
    const res = await new Provider(56, mock).balances(USER, [TOKEN], { minBlock: 103 })
    expect(res[0]).toMatchObject({ balance: '7', blockNumber: 103 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(500)
  })

  it("getBalances 透传 minBlock / withBlock；nativeBalance: 'rpc' 时主币按 minBlock 读取", async () => {
    const { getBalances } = await import('../src/index.js')
    const mock = mockAt(120)
    expect((await getBalances(USER, [TOKEN], { chainId: 56, provider: mock, withBlock: true }))[0]?.blockNumber).toBe(120)
    const rpc = new Provider(56, mockAt(120), { nativeBalance: 'rpc' })
    expect((await rpc.balances(USER, [NATIVE_TOKEN], { minBlock: 110 }))[0]).toMatchObject({ balance: '5', blockNumber: 120 })
  })
})

describe('multiBalances', () => {
  it('多个钱包的余额合成一次 eth_call，结果与 queries 一一对应', async () => {
    const TOKEN = '0x1000000000000000000000000000000000000001'
    const OTHER = '0x5000000000000000000000000000000000000005'
    const mock = createMockProvider({
      contracts: { [TOKEN]: fakeToken('AAA', 6, { [USER]: 7n, [OTHER]: 9n }) },
      multicallAddresses: [MULTICALL3_ADDRESS],
      balances: { [USER]: 5n, [OTHER]: 6n },
    })
    const { getMultiBalances } = await import('../src/index.js')
    const [a, b] = await getMultiBalances(
      [
        { owner: USER, tokens: [NATIVE_TOKEN, TOKEN] },
        { owner: OTHER, tokens: [TOKEN] },
      ],
      { chainId: 56, provider: mock },
    )
    expect(a?.map((r) => r.balance)).toEqual(['5', '7'])
    expect(b?.map((r) => r.formatted)).toEqual(['0.000009'])
    expect(mock.calls).toHaveLength(1)
  })
})

describe('watchBalances', () => {
  const TOKEN = '0x1000000000000000000000000000000000000001'
  it('多处订阅同一份数据共用一份轮询；只在变化时通知；全部取消后停止', async () => {
    vi.useFakeTimers()
    try {
      const { watchBalances } = await import('../src/index.js')
      const { resetBalancesProviderCache } = await import('../src/shortcuts.js')
      resetBalancesProviderCache()
      const tokenBalances: Record<string, bigint> = { [USER]: 7n } // fakeToken 每次调用时读取，可以中途修改
      const mock = createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6, tokenBalances) }, multicallAddresses: [MULTICALL3_ADDRESS], balances: { [USER]: 5n } })
      const a: string[][] = []
      const b: string[][] = []
      const stopA = watchBalances(USER, [NATIVE_TOKEN, TOKEN], { chainId: 56, provider: mock, interval: 1000, onChange: (list) => a.push(list.map((x) => x.balance)) })
      const stopB = watchBalances(USER, [TOKEN, NATIVE_TOKEN], { chainId: 56, provider: mock, interval: 5000, onChange: (list) => b.push(list.map((x) => x.balance)) })
      await vi.advanceTimersByTimeAsync(10)
      expect(a).toEqual([['5', '7']])
      expect(b).toEqual([['7', '5']]) // 按各自的代币顺序
      expect(mock.calls).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(1000) // 取最小间隔；余额没变不通知
      expect(mock.calls).toHaveLength(2)
      expect(a).toHaveLength(1)

      tokenBalances[USER] = 8n
      await vi.advanceTimersByTimeAsync(1000)
      expect(a.at(-1)).toEqual(['5', '8'])
      expect(b.at(-1)).toEqual(['8', '5'])

      stopA()
      stopB()
      const calls = mock.calls.length
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mock.calls).toHaveLength(calls)
    } finally {
      vi.useRealTimers()
    }
  })

  it('查询失败时调用 onError，轮询继续', async () => {
    vi.useFakeTimers()
    try {
      const { watchBalances } = await import('../src/index.js')
      let fail = true
      const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], balances: { [USER]: 5n } })
      const realCall = mock.call
      mock.call = async (tx) => (fail ? Promise.reject(new Error('down')) : realCall(tx))
      const errors: unknown[] = []
      const seen: string[] = []
      const stop = watchBalances(USER, [NATIVE_TOKEN], { chainId: 56, provider: mock, interval: 100, onChange: (l) => seen.push(l[0]!.balance), onError: (e) => errors.push(e) })
      await vi.advanceTimersByTimeAsync(10)
      expect(errors).toHaveLength(1)
      fail = false
      await vi.advanceTimersByTimeAsync(100)
      expect(seen).toEqual(['5'])
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('review 修复', () => {
  const TOKEN = '0x1000000000000000000000000000000000000001'
  const behindError = () =>
    makeError('missing revert data', 'CALL_EXCEPTION', {
      action: 'call',
      data: null,
      reason: null,
      transaction: { to: null, data: '0x' },
      invocation: null,
      revert: null,
      info: { error: { code: -32000, message: 'header not found' } },
    })

  it('Tron 上 minBlock：不按区块号查询，等节点跟上后查最新状态', async () => {
    const { TRON_CHAIN_ID } = await import('../src/index.js')
    const started = Date.now()
    const mock = createMockProvider({
      contracts: { [TOKEN]: fakeToken('AAA', 6, { [USER]: 7n }) },
      balances: { [USER]: 5n },
      blockNumber: () => (Date.now() - started > 500 ? 103 : 100),
    })
    const realCall = mock.call
    mock.call = async (tx) => {
      if (tx.blockTag !== undefined) throw new Error(`Tron does not support calls at block ${tx.blockTag}`)
      return realCall(tx)
    }
    const res = await new Provider(TRON_CHAIN_ID.mainnet, mock, { deployless: true }).balances(USER, [TOKEN], { minBlock: 103, decimals: false })
    expect(res[0]).toMatchObject({ balance: '7', blockNumber: 103 })
  })

  it("nativeBalance 'rpc' + minBlock：所有节点都落后时等待重试；主币与代币、blockNumber 在同一个区块读取", async () => {
    const started = Date.now()
    const mock = createMockProvider({
      contracts: { [TOKEN]: fakeToken('AAA', 6, { [USER]: 7n }) },
      multicallAddresses: [MULTICALL3_ADDRESS],
      balances: { [USER]: 5n },
      blockNumber: () => (Date.now() - started > 500 ? 105 : 100),
    })
    const tags: unknown[] = []
    const realBalance = mock.getBalance
    mock.getBalance = async (address: string, blockTag?: unknown) => {
      tags.push(blockTag)
      return realBalance(address, blockTag)
    }
    const res = await new Provider(56, mock, { nativeBalance: 'rpc' }).balances(USER, [NATIVE_TOKEN, TOKEN], { minBlock: 103 })
    // 节点跟上后读的是最新区块（≥ minBlock），主币和代币在同一个区块
    expect(res.map((r) => [r.balance, r.blockNumber])).toEqual([
      ['5', 105],
      ['7', 105],
    ])
    expect(tags.at(-1)).toBe(105) // 主币在批量查询实际读取的区块上读
  })

  it("nativeBalance 'rpc' + withBlock：主币按批量查询读出的区块号读取", async () => {
    const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], balances: { [USER]: 5n }, blockNumber: 222 })
    const tags: unknown[] = []
    const realBalance = mock.getBalance
    mock.getBalance = async (address: string, blockTag?: unknown) => {
      tags.push(blockTag)
      return realBalance(address, blockTag)
    }
    const res = await new Provider(56, mock, { nativeBalance: 'rpc' }).balances(USER, [NATIVE_TOKEN], { withBlock: true })
    expect(res[0]).toMatchObject({ balance: '5', blockNumber: 222 })
    expect(tags).toEqual([222])
  })

  it('节点还没有请求的区块（header not found）只换节点、不冷却', async () => {
    const log: string[] = []
    const behind = {
      async call(): Promise<string> {
        throw new Error('unused')
      },
      async getBalance(): Promise<bigint> {
        log.push('behind')
        throw behindError()
      },
    }
    const rpc = new FallbackRpc([behind, node('b', log, () => 'ok')])
    await rpc.getBalance(USER)
    await rpc.getBalance(USER)
    expect(log).toEqual(['behind', 'b', 'behind', 'b'])
  })

  it('minBlock 等待重试期间取消：立即 reject，之后不再发请求', async () => {
    const mock = createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6, { [USER]: 7n }) }, multicallAddresses: [MULTICALL3_ADDRESS], blockNumber: 100 })
    const multi = new Provider(56, mock)
    const controller = new AbortController()
    const pending = multi.all([multi.erc20(TOKEN).balanceOf(USER)], { minBlock: 200, signal: controller.signal })
    await new Promise((r) => setTimeout(r, 100))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const calls = mock.calls.length
    await new Promise((r) => setTimeout(r, 1200))
    expect(mock.calls).toHaveLength(calls)
  })

  it('watchBalances：某个订阅者的回调出错不影响其他订阅者，也不当成查询失败', async () => {
    const { watchBalances } = await import('../src/index.js')
    const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], balances: { [USER]: 5n } })
    const errors: unknown[] = []
    const seen: string[] = []
    const stopA = watchBalances(USER, [NATIVE_TOKEN], {
      chainId: 56,
      provider: mock,
      onChange: () => {
        throw new Error('render failed')
      },
      onError: (e) => errors.push(e),
    })
    const stopB = watchBalances(USER, [NATIVE_TOKEN], { chainId: 56, provider: mock, onChange: (l) => seen.push(l[0]!.balance), onError: (e) => errors.push(e) })
    await new Promise((r) => setTimeout(r, 50))
    expect(seen).toEqual(['5'])
    expect(errors).toEqual([])
    stopA()
    stopB()
  })

  it("tokens：主币信息没配置时 error 为 'not-configured'（没有发请求，不是解码失败）", async () => {
    const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS] })
    const [native] = await new Provider(999_999, mock).tokens([NATIVE_TOKEN])
    expect(native).toMatchObject({ success: false, error: 'not-configured', errorField: 'name' })
  })

  it('name / symbol 分开计时过期：只刷新 symbol 不会延长 name 的缓存', async () => {
    const { getCachedTokenMeta, setCachedTokenMeta, resetDecimalsCache } = await import('../src/erc20.js')
    resetDecimalsCache()
    const now = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now)
    setCachedTokenMeta(1, '0xBB', { name: 'Old' })
    spy.mockReturnValue(now + 59 * 60 * 1000)
    setCachedTokenMeta(1, '0xBB', { symbol: 'B' })
    spy.mockReturnValue(now + 61 * 60 * 1000)
    expect(getCachedTokenMeta(1, '0xbb')).toEqual({ symbol: 'B' })
    spy.mockRestore()
  })
})

describe('Arbitrum 系的链：区块号用 ArbSys.arbBlockNumber（block.number 是 L1 区块号）', () => {
  it('withBlock / minBlock 用 L2 区块号；其他链上 0x64 没有代码，照常用 block.number', async () => {
    const arbSys = () => ({ success: true, returnData: '0x' + (5000n).toString(16).padStart(64, '0') })
    const mock = createMockProvider({ contracts: { '0x0000000000000000000000000000000000000064': arbSys }, multicallAddresses: [MULTICALL3_ADDRESS], balances: { [USER]: 5n }, blockNumber: 20_000_000 })
    const multi = new Provider(42161, mock)
    expect((await multi.balances(USER, [NATIVE_TOKEN], { withBlock: true }))[0]?.blockNumber).toBe(5000)
    expect((await multi.balances(USER, [NATIVE_TOKEN], { minBlock: 4999 }))[0]?.blockNumber).toBe(5000)
    for (const deployless of [true, false]) {
      const plain = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], balances: { [USER]: 5n }, blockNumber: 777 })
      expect((await new Provider(56, plain, { deployless }).balances(USER, [NATIVE_TOKEN], { withBlock: true }))[0]?.blockNumber).toBe(777)
    }
  })
})

describe('第二次 review 修复', () => {
  const TOKEN = '0x1000000000000000000000000000000000000001'

  it('tryAll：没有返回值的函数成功时照常解码（不当成没有合约）', async () => {
    const mock = createMockProvider({ contracts: { [TOKEN]: () => ({ success: true, returnData: '0x' }) }, multicallAddresses: [MULTICALL3_ADDRESS] })
    const multi = new Provider(56, mock)
    const ping = multi.contract(TOKEN, ['function ping()']).ping()
    const sym = multi.contract(TOKEN, ['function symbol() view returns (string)']).symbol()
    const [voidResult, missing] = await multi.tryAll([ping, sym])
    expect(voidResult).not.toBeNull()
    expect(missing).toBeNull()
  })

  it("编码失败按原因区分：地址非法为 invalid-address，其他为 invalid-argument", async () => {
    const { encodeFailureReason } = await import('../src/call.js')
    const { getAddress, AbiCoder } = await import('ethers')
    expect(encodeFailureReason((() => { try { getAddress('0x123') } catch (e) { return e } })())).toBe('invalid-address')
    expect(encodeFailureReason((() => { try { AbiCoder.defaultAbiCoder().encode(['uint8'], [300]) } catch (e) { return e } })())).toBe('invalid-argument')
  })

  it('导入缓存时地址统一小写，checksum 写法的 key 也能命中', async () => {
    const { importTokenMetaCache, getCachedTokenMeta, resetDecimalsCache } = await import('../src/erc20.js')
    resetDecimalsCache()
    importTokenMetaCache({ version: 1, entries: [['1:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', { decimals: 6 }]] })
    expect(getCachedTokenMeta(1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48').decimals).toBe(6)
  })

  it("nativeBalance 'rpc' + withBlock：出错时立即抛出，不等待重试", async () => {
    const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], balances: { [USER]: 5n } })
    let calls = 0
    mock.getBalance = async () => {
      calls++
      throw new Error('429 too many requests')
    }
    const started = Date.now()
    await expect(new Provider(56, mock, { nativeBalance: 'rpc' }).balances(USER, [NATIVE_TOKEN], { withBlock: true })).rejects.toThrow(/429/)
    expect(Date.now() - started).toBeLessThan(500)
    expect(calls).toBe(1)
  })

  it("Tron + nativeBalance 'rpc' + withBlock：主币余额不按区块号读取", async () => {
    const { TRON_CHAIN_ID } = await import('../src/index.js')
    const mock = createMockProvider({ balances: { [USER]: 5n } })
    const tags: unknown[] = []
    mock.getBalance = async (_: string, blockTag?: unknown) => {
      tags.push(blockTag)
      if (blockTag !== undefined) throw new Error('Tron does not support calls at a block')
      return 5n
    }
    const [r] = await new Provider(TRON_CHAIN_ID.mainnet, mock, { deployless: true, nativeBalance: 'rpc' }).balances(USER, [NATIVE_TOKEN], { withBlock: true })
    expect(r?.balance).toBe('5')
    expect(tags).toEqual([undefined])
  })

  it('balances 走合并队列时，所有调用方都取消后 minBlock 的等待重试随之停止', async () => {
    const mock = createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6, { [USER]: 7n }) }, multicallAddresses: [MULTICALL3_ADDRESS], blockNumber: 100 })
    const multi = new Provider(56, mock)
    const controller = new AbortController()
    const pending = multi.balances(USER, [TOKEN], { minBlock: 200, signal: controller.signal })
    await new Promise((r) => setTimeout(r, 100))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((r) => setTimeout(r, 50))
    const calls = mock.calls.length
    await new Promise((r) => setTimeout(r, 1200))
    expect(mock.calls).toHaveLength(calls)
  })

  it('watchBalances：Tron 地址区分大小写，不会合并成同一份轮询', async () => {
    vi.useFakeTimers()
    try {
      const { watchBalances, TRON_CHAIN_ID } = await import('../src/index.js')
      const mock = createMockProvider({ balances: {} })
      const base = { chainId: TRON_CHAIN_ID.mainnet, provider: mock, deployless: true, interval: 1000 } as const
      const results: Record<string, boolean | undefined> = {}
      // 第二个地址只是大小写不同，不是合法的 Tron 地址：各自轮询时它的结果是失败；合并成一份时会拿到第一个地址的成功结果
      const stopA = watchBalances('TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G', [NATIVE_TOKEN], { ...base, onChange: (l) => (results.a = l[0]?.success) })
      const stopB = watchBalances('TNXOIAJ3DCT8FJG4M9FKLFH9S2V9TXC32G', [NATIVE_TOKEN], { ...base, onChange: (l) => (results.b = l[0]?.success) })
      await vi.advanceTimersByTimeAsync(10)
      expect(results).toEqual({ a: true, b: false })
      stopA()
      stopB()
    } finally {
      vi.useRealTimers()
    }
  })
})
