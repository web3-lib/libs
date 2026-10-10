import { makeError, type TransactionRequest } from 'ethers'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FallbackRpc, MULTICALL3_ADDRESS, NATIVE_TOKEN, Provider, watchBalances } from '../src/index.js'
import { resetMulticallCache } from '../src/aggregate.js'
import { exportTokenMetaCache, getCachedTokenMeta, importTokenMetaCache, resetDecimalsCache } from '../src/erc20.js'
import { resetNodeHealth } from '../src/fallback.js'
import { resetBalancesProviderCache } from '../src/shortcuts.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const TOKEN = '0x1000000000000000000000000000000000000001'
const USER = '0x4000000000000000000000000000000000000004'

beforeEach(() => {
  resetNodeHealth()
  resetMulticallCache()
  resetDecimalsCache()
  resetBalancesProviderCache()
})

/** 按脚本应答 getBalance 的节点 */
function scripted(name: string, log: string[], answer: () => Promise<bigint>) {
  return {
    async call(): Promise<string> {
      throw new Error('unused')
    },
    getBalance(): Promise<bigint> {
      log.push(name)
      return answer()
    },
  }
}

describe('01 节点返回 null（ethers 解析出 INVALID_ARGUMENT）时换节点', () => {
  it('值为 null 的 INVALID_ARGUMENT 是节点问题：换下一个节点；参数本身非法仍直接抛出', async () => {
    const log: string[] = []
    const nullResult = () => Promise.reject(makeError('invalid BigNumberish value', 'INVALID_ARGUMENT', { argument: 'value', value: null }))
    const rpc = new FallbackRpc([scripted('null', log, nullResult), scripted('ok', log, async () => 5n)])
    expect(await rpc.getBalance(USER)).toBe(5n)
    expect(log).toEqual(['null', 'ok'])

    const badArg = () => Promise.reject(makeError('invalid address', 'INVALID_ARGUMENT', { argument: 'address', value: 'bad' }))
    const strict = new FallbackRpc([scripted('a', [], badArg), scripted('b', log, async () => 5n)])
    await expect(strict.getBalance('bad')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})

describe('02 stallTimeout：慢节点输掉竞争后排到后面', () => {
  it('首选节点慢、被后发的节点抢先：下一次先用快的节点，不再每次多等 stallTimeout', async () => {
    const log: string[] = []
    const slow = scripted('slow', log, () => new Promise((r) => setTimeout(() => r(1n), 150)))
    const fast = scripted('fast', log, async () => 2n)
    const rpc = new FallbackRpc([slow, fast], { stallTimeout: 20 })
    expect(await rpc.getBalance(USER)).toBe(2n)
    log.length = 0
    const started = Date.now()
    expect(await rpc.getBalance(USER)).toBe(2n)
    expect(log).toEqual(['fast'])
    expect(Date.now() - started).toBeLessThan(20)
  })
})

describe('03 / 04 节点返回空数据（0x）', () => {
  it('deployless：一个节点返回 0x 时换下一个节点', async () => {
    const bad = createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6) } })
    bad.call = async () => '0x'
    const good = createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6) } })
    const multi = new Provider(56, [bad, good], { deployless: true })
    expect((await multi.tokens([TOKEN], { fields: ['symbol'] }))[0]?.symbol).toBe('AAA')
  })

  it('Multicall3：一个节点偶发返回 0x 时换节点，不弃用合约', async () => {
    const flaky = createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6) }, multicallAddresses: [MULTICALL3_ADDRESS] })
    const real = flaky.call
    let glitch = true
    flaky.call = async (tx: TransactionRequest) => (glitch && tx.to ? ((glitch = false), '0x') : real(tx))
    const good = createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6) }, multicallAddresses: [MULTICALL3_ADDRESS] })
    const multi = new Provider(56, [flaky, good])
    expect((await multi.tokens([TOKEN], { fields: ['symbol'] }))[0]?.symbol).toBe('AAA')
    await multi.tokens([TOKEN], { fields: ['decimals'] })
    // 两次都用合约（tx.to 有值），没有退回 deployless
    expect([...flaky.calls, ...good.calls].every((c) => c.to)).toBe(true)
  })

  it('Multicall3：所有节点都返回 0x（合约确实不存在）时确认弃用，之后走 deployless', async () => {
    const make = () => createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6) } }) // 没有部署 multicall
    const [a, b] = [make(), make()]
    const multi = new Provider(56, [a, b])
    expect((await multi.tokens([TOKEN], { fields: ['symbol'] }))[0]?.symbol).toBe('AAA')
    const [beforeA, beforeB] = [a.calls.length, b.calls.length]
    await multi.tokens([TOKEN], { fields: ['decimals'] })
    const later = [...a.calls.slice(beforeA), ...b.calls.slice(beforeB)]
    expect(later.length).toBeGreaterThan(0)
    expect(later.every((c) => !c.to)).toBe(true) // 直接走 deployless，不再先试合约
  })
})

describe('05 minBlock：节点对未来区块不报错、返回最新状态（如 HyperEVM）', () => {
  it('按区块号重查的结果同样校验区块号，不满足时等节点跟上', async () => {
    const started = Date.now()
    const mock = createMockProvider({
      contracts: { [TOKEN]: fakeToken('AAA', 6, { [USER]: 7n }) },
      multicallAddresses: [MULTICALL3_ADDRESS],
      blockNumber: () => (Date.now() - started > 500 ? 103 : 100),
      ignoreFutureBlock: true,
    })
    const [r] = await new Provider(56, mock).balances(USER, [TOKEN], { minBlock: 103 })
    expect(r?.blockNumber).toBeGreaterThanOrEqual(103)
    expect(Date.now() - started).toBeGreaterThanOrEqual(500)
  })
})

describe('06 钱包的健康状态按链分开记', () => {
  it('同一个钱包在一条链上冷却，不影响另一条链上的排序', async () => {
    const log: string[] = []
    const wallet = { name: 'wallet' }
    let failing = true
    const node = scripted('wallet', log, () => (failing ? Promise.reject(makeError('network changed', 'NETWORK_ERROR', {})) : Promise.resolve(1n)))
    const other = scripted('other', log, async () => 2n)
    await new FallbackRpc([node, other], {}, [{ label: 'wallet', key: wallet, chainId: 1 }, { label: 'other', key: 'https://other' }]).getBalance(USER)
    failing = false
    log.length = 0
    await new FallbackRpc([node, other], {}, [{ label: 'wallet', key: wallet, chainId: 56 }, { label: 'other', key: 'https://other' }]).getBalance(USER)
    expect(log).toEqual(['wallet'])
  })
})

describe('07 各节点的“区块不存在”报错都只换节点、不冷却（几秒内排到后面，之后恢复）', () => {
  it.each([
    'unsupported block number 123',
    'block is out of range',
    'requested block is above the latest consensus block',
    'height must be less than or equal to the head',
    "Block with such an ID doesn't exist yet",
  ])('%s', async (message) => {
    const log: string[] = []
    const behind = scripted('behind', log, () => Promise.reject(makeError(message, 'SERVER_ERROR', { request: null as any, response: null as any })))
    const rpc = new FallbackRpc([behind, scripted('ok', log, async () => 1n)])
    await rpc.getBalance(USER)
    await rpc.getBalance(USER) // 几秒内先问别的节点
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000)
    try {
      await rpc.getBalance(USER) // 不是 30 秒的冷却：几秒后又先问它
    } finally {
      clock.mockRestore()
    }
    expect(log).toEqual(['behind', 'ok', 'ok', 'behind', 'ok'])
  })
})

describe('08 合并请求结束后移除挂在调用方 signal 上的监听', () => {
  it('长期存在的 signal 发起多次查询，监听不累积', async () => {
    const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], balances: { [USER]: 5n } })
    const multi = new Provider(56, mock)
    const controller = new AbortController()
    const added = vi.spyOn(controller.signal, 'addEventListener')
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    for (let i = 0; i < 5; i++) {
      await multi.balances(USER, [NATIVE_TOKEN], { signal: controller.signal })
    }
    const batcherAdds = added.mock.calls.filter(([, , opts]) => (opts as { once?: boolean } | undefined)?.once).length
    expect(batcherAdds).toBeGreaterThan(0)
    expect(removed.mock.calls.length).toBeGreaterThanOrEqual(batcherAdds)
  })
})

describe('09 watchBalances：新订阅的间隔更短时不推迟下一次轮询', () => {
  it('15s 的轮询过了 14s 时加入 10s 的订阅：下一次仍在 15s 时', async () => {
    vi.useFakeTimers()
    try {
      const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], balances: { [USER]: 5n } })
      const opts = { chainId: 56, provider: mock, onChange: () => {} }
      const stopA = watchBalances(USER, [NATIVE_TOKEN], { ...opts, interval: 15_000 })
      await vi.advanceTimersByTimeAsync(14_000)
      const before = mock.calls.length
      const stopB = watchBalances(USER, [NATIVE_TOKEN], { ...opts, interval: 10_000 })
      await vi.advanceTimersByTimeAsync(1_100)
      expect(mock.calls.length).toBeGreaterThan(before)
      stopA()
      stopB()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('10 导入缓存的时间戳', () => {
  it('未来的时间截到当前时间（1 小时后照常过期）；NaN / Infinity 丢弃', () => {
    const now = Date.now()
    importTokenMetaCache({
      version: 1,
      entries: [
        ['1:0xaa', { symbol: 'FUT', symbolAt: now + 365 * 24 * 3600 * 1000, decimals: 6 }],
        ['1:0xbb', { symbol: 'NAN', symbolAt: Number.NaN }],
        ['1:0xcc', { symbol: 'INF', symbolAt: Number.POSITIVE_INFINITY, decimals: 8 }],
      ],
    })
    expect(getCachedTokenMeta(1, '0xaa').symbol).toBe('FUT')
    expect(getCachedTokenMeta(1, '0xbb')).toEqual({})
    expect(getCachedTokenMeta(1, '0xcc')).toEqual({ decimals: 8 })
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 61 * 60 * 1000)
    expect(getCachedTokenMeta(1, '0xaa')).toEqual({ decimals: 6 })
    spy.mockRestore()
    expect(exportTokenMetaCache().entries.length).toBeGreaterThan(0)
  })
})

describe('review 修复（第二轮）', () => {
  it('一个节点返回 0x、另一个节点出错（超时、限频等）：合约可能不存在，退回 deployless，查询照常成功', async () => {
    const empty = createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6) } }) // 没有部署 multicall：合约调用返回 0x
    const broken = createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6) } })
    const real = broken.call
    broken.call = async (tx: TransactionRequest) => {
      if (tx.to) throw makeError('server response 503', 'SERVER_ERROR', { request: null as any, response: null as any })
      return real(tx)
    }
    const multi = new Provider(56, [empty, broken])
    expect((await multi.tokens([TOKEN], { fields: ['symbol'] }))[0]?.symbol).toBe('AAA')
  })

  it('合约确实不存在时最多试 2 个节点就确认，不把所有节点挨个试一遍', async () => {
    const nodes = Array.from({ length: 4 }, () => createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6) } }))
    const multi = new Provider(56, nodes)
    await multi.tokens([TOKEN], { fields: ['symbol'] })
    const contractCalls = nodes.flatMap((n) => n.calls).filter((c) => c.to)
    expect(contractCalls).toHaveLength(2)
  })

  it('调用方传入 undefined（值为 undefined 的 INVALID_ARGUMENT）直接抛出，不在每个节点重试；节点返回 null 只换节点、不冷却', async () => {
    const log: string[] = []
    const undef = () => Promise.reject(makeError('invalid address', 'INVALID_ARGUMENT', { argument: 'address', value: undefined }))
    const rpc = new FallbackRpc([scripted('a', log, undef), scripted('b', log, async () => 1n)])
    await expect(rpc.getBalance(undefined as unknown as string)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(log).toEqual(['a'])

    log.length = 0
    let nulls = 1
    const nullOnce = () => (nulls-- > 0 ? Promise.reject(makeError('invalid BigNumberish value', 'INVALID_ARGUMENT', { argument: 'value', value: null })) : Promise.resolve(3n))
    const flaky = new FallbackRpc([scripted('flaky', log, nullOnce), scripted('ok', log, async () => 1n)])
    await flaky.getBalance(USER)
    await flaky.getBalance(USER)
    expect(log).toEqual(['flaky', 'ok', 'flaky']) // 返回过 null 的节点没被冷却，下次仍排第一
  })
})

describe('minBlock：落后但不报错的节点（返回较旧区块）时换节点，不在它身上反复重试', () => {
  it('第一个节点落后、第二个已跟上：只问第一个节点一次就换到第二个，立即返回', async () => {
    const mk = (height: number) =>
      createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6, { [USER]: 7n }) }, multicallAddresses: [MULTICALL3_ADDRESS], blockNumber: height, ignoreFutureBlock: true })
    for (const deployless of [false, true]) {
      resetNodeHealth()
      resetMulticallCache()
      const behind = mk(100)
      const ahead = mk(110)
      const started = Date.now()
      const [r] = await new Provider(56, [behind, ahead], { deployless }).balances(USER, [TOKEN], { minBlock: 105 })
      expect(r?.blockNumber).toBe(110)
      expect(Date.now() - started).toBeLessThan(500)
      expect(behind.calls).toHaveLength(1)
    }
  })

  it('所有节点都落后时等待，跟上后返回；不会把落后误判成 Multicall3 不可用', async () => {
    const started = Date.now()
    // 区块高度要晚于 BSC 上 Multicall3 的部署区块（15921452），否则按区块号重查时本来就该走 deployless
    const height = () => (Date.now() - started > 500 ? 30_000_006 : 30_000_000)
    const mk = () => createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6, { [USER]: 7n }) }, multicallAddresses: [MULTICALL3_ADDRESS], blockNumber: height, ignoreFutureBlock: true })
    const [a, b] = [mk(), mk()]
    const multi = new Provider(56, [a, b])
    const [r] = await multi.balances(USER, [TOKEN], { minBlock: 30_000_005 })
    expect(r?.blockNumber).toBeGreaterThanOrEqual(30_000_005)
    await multi.balances(USER, [TOKEN])
    expect([...a.calls, ...b.calls].every((c) => c.to)).toBe(true) // 始终用合约，没有退回 deployless
  })

  it('Arbitrum 系：用 L2 区块号判断是否落后（block.number 是 L1 区块号，不能拿来比较）', async () => {
    const arbSys = (height: number) => () => ({ success: true, returnData: '0x' + BigInt(height).toString(16).padStart(64, '0') })
    const mk = (l2: number) =>
      createMockProvider({
        contracts: { '0x0000000000000000000000000000000000000064': arbSys(l2), [TOKEN]: fakeToken('AAA', 6, { [USER]: 7n }) },
        multicallAddresses: [MULTICALL3_ADDRESS],
        blockNumber: 20_000_000, // L1 区块号
        ignoreFutureBlock: true,
      })
    const behind = mk(5000)
    const ahead = mk(5100)
    const [r] = await new Provider(42161, [behind, ahead]).balances(USER, [TOKEN], { minBlock: 5050 })
    expect(r?.blockNumber).toBe(5100)
  })
})

describe('minBlock（第三轮 review）', () => {
  const tokenAddr = (i: number) => '0x' + (0x2000 + i).toString(16).padStart(40, '0')

  it('deployless 拆成多片时每片都校验区块号：落后节点的旧数据不会混进结果', async () => {
    const tokens = Array.from({ length: 600 }, (_, i) => tokenAddr(i))
    const mk = (height: number, balance: bigint) =>
      createMockProvider({
        contracts: Object.fromEntries(tokens.map((t) => [t, fakeToken('T', 6, { [USER]: balance })])),
        blockNumber: height,
        ignoreFutureBlock: true,
      })
    const behind = mk(30_000_000, 1n) // 旧状态
    const ahead = mk(30_000_010, 2n) // 新状态
    const res = await new Provider(56, [behind, ahead], { deployless: true }).balances(USER, tokens, { minBlock: 30_000_005, decimals: false })
    expect(behind.calls.length + ahead.calls.length).toBeGreaterThan(2) // 确实拆成了多片
    expect(res.every((r) => r.balance === '2')).toBe(true)
    expect(res.every((r) => r.blockNumber === 30_000_010)).toBe(true)
  })

  it('所有节点都落后时按区块号重查只做一轮，之后只等最新状态', async () => {
    const started = Date.now()
    const height = () => (Date.now() - started > 2200 ? 30_000_006 : 30_000_000)
    const mk = () => createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6, { [USER]: 7n }) }, multicallAddresses: [MULTICALL3_ADDRESS], blockNumber: height })
    const [a, b] = [mk(), mk()]
    const [r] = await new Provider(56, [a, b]).balances(USER, [TOKEN], { minBlock: 30_000_005 })
    expect(r?.blockNumber).toBeGreaterThanOrEqual(30_000_005)
    const pinnedCalls = [...a.calls, ...b.calls].filter((c) => typeof c.blockTag === 'number')
    expect(pinnedCalls.length).toBeLessThanOrEqual(2) // 每个节点最多一次
  })

  it('落后的节点排到后面：下次查询先问已跟上的节点', async () => {
    const mk = (height: number) =>
      createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6, { [USER]: 7n }) }, multicallAddresses: [MULTICALL3_ADDRESS], blockNumber: height, ignoreFutureBlock: true })
    const behind = mk(30_000_000)
    const ahead = mk(30_000_010)
    const multi = new Provider(56, [behind, ahead])
    await multi.balances(USER, [TOKEN], { minBlock: 30_000_005 })
    expect(behind.calls).toHaveLength(1)
    await multi.balances(USER, [TOKEN], { minBlock: 30_000_005 })
    expect(behind.calls).toHaveLength(1) // 第二次直接问 ahead
  })
})

describe('minBlock（第四轮 review）', () => {
  it('deployless 结果过大、通过 revert 带回时，同样识别落后节点并换节点', async () => {
    const mk = (height: number, balance: bigint) =>
      createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6, { [USER]: balance }) }, blockNumber: height, ignoreFutureBlock: true, maxCodeSize: 64 })
    const behind = mk(30_000_000, 1n)
    const ahead = mk(30_000_010, 2n)
    const [r] = await new Provider(56, [behind, ahead], { deployless: true }).balances(USER, [TOKEN], { minBlock: 30_000_005, decimals: false })
    expect(r).toMatchObject({ balance: '2', blockNumber: 30_000_010 })
  })

  it('落后的节点只在几秒内排到后面，之后恢复原来的顺序', async () => {
    const mk = (height: number) =>
      createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6, { [USER]: 7n }) }, multicallAddresses: [MULTICALL3_ADDRESS], blockNumber: height, ignoreFutureBlock: true })
    const behind = mk(30_000_000)
    const ahead = mk(30_000_010)
    const multi = new Provider(56, [behind, ahead])
    await multi.balances(USER, [TOKEN], { minBlock: 30_000_005 })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 6_000)
    try {
      await multi.balances(USER, [TOKEN]) // 不带 minBlock 的普通查询：6 秒后又先问第一个节点
      expect(behind.calls).toHaveLength(2)
    } finally {
      clock.mockRestore()
    }
  })
})

describe('第五轮 review', () => {
  it('曾经落后的节点一旦成功给出结果，立即恢复原来的顺序', async () => {
    const log: string[] = []
    let aCalls = 0
    const a = scripted('a', log, () => (aCalls++ === 0 ? Promise.reject(makeError('header not found', 'SERVER_ERROR', { request: null as any, response: null as any })) : Promise.resolve(1n)))
    let bCalls = 0
    const b = scripted('b', log, () => (bCalls++ === 1 ? Promise.reject(makeError('server response 503', 'SERVER_ERROR', { request: null as any, response: null as any })) : Promise.resolve(2n)))
    const rpc = new FallbackRpc([a, b])
    await rpc.getBalance(USER) // a 落后 → b
    await rpc.getBalance(USER) // a 被排到后面：先问 b（这次 b 出错）→ a 成功
    await rpc.getBalance(USER) // a 已恢复：先问 a
    expect(log).toEqual(['a', 'b', 'b', 'a', 'a'])
  })

  it('没有 minBlock 时：一个节点合约调用返回 0x、另一个报“区块不存在”，照常退回 deployless', async () => {
    const empty = createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6) } }) // 没有部署 multicall
    const lagging = createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 6) }, multicallAddresses: [MULTICALL3_ADDRESS] })
    lagging.call = async () => {
      throw makeError('missing revert data', 'CALL_EXCEPTION', {
        action: 'call',
        data: null,
        reason: null,
        transaction: { to: null, data: '0x' },
        invocation: null,
        revert: null,
        info: { error: { code: -32000, message: 'header not found' } },
      })
    }
    const multi = new Provider(56, [empty, lagging])
    expect((await multi.tokens([TOKEN], { fields: ['symbol'] }))[0]?.symbol).toBe('AAA')
  })
})
