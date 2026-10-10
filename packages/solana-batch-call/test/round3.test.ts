import { base64 } from '@scure/base'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HttpError,
  HttpRpc,
  SolanaClient,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  exportTokenMetaCache,
  findProgramAddress,
  getAssociatedTokenAddress,
  importTokenMetaCache,
  type RpcTransport,
} from '../src/index.js'
import { resetTokenMetaCache } from '../src/client.js'
import { quoteBigIntegers, resetNodeHealth } from '../src/rpc.js'
import { resetClientCache } from '../src/shortcuts.js'
import { createMockNode, mintData, tokenAccountData, type MockAccount } from './mock.js'

const OWNER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
const TOKEN_ACCOUNT = '7KJjY7rArbydeLBF7gQ5LdqXRKRYyPArT99NEctsHsgU'

beforeEach(() => {
  resetTokenMetaCache()
  resetClientCache()
  resetNodeHealth()
})
afterEach(() => {
  vi.restoreAllMocks()
})

type RpcCall = { id: number; method: string; params: unknown[] }

/** 假节点：按请求体应答，记录每个 HTTP 请求的内容 */
function fakeFetch(answer: (body: RpcCall | RpcCall[]) => unknown, log: Array<RpcCall | RpcCall[]> = []): typeof fetch {
  return (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as RpcCall | RpcCall[]
    log.push(body)
    return new Response(JSON.stringify(answer(body)), { status: 200 })
  }) as typeof fetch
}

const ok = (req: RpcCall) => ({ jsonrpc: '2.0', id: req.id, result: req.method })

describe('01：整批被拒时暂停批量（不再永久关闭），冷却后恢复', () => {
  it('-32603 等任意错误码整批被拒：这一批逐条重发，10 分钟内逐条请求（不会每批都先失败一次），之后恢复批量', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    let first = true
    const log: Array<RpcCall | RpcCall[]> = []
    const rpc = new HttpRpc('https://rpc.example', {
      fetch: fakeFetch((body) => {
        if (Array.isArray(body) && first) {
          first = false
          return { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' } }
        }
        return Array.isArray(body) ? body.map(ok) : ok(body)
      }, log),
    })
    try {
      expect(await Promise.all([rpc.request('a'), rpc.request('b')])).toEqual(['a', 'b'])
      log.length = 0
      await Promise.all([rpc.request('c'), rpc.request('d')])
      expect(log.every((entry) => !Array.isArray(entry))).toBe(true) // 冷却期内逐条请求，没有再发失败的批量
      clock.mockReturnValue(now + 11 * 60 * 1000)
      log.length = 0
      await Promise.all([rpc.request('e'), rpc.request('f')])
      expect(log).toHaveLength(1)
      expect(Array.isArray(log[0])).toBe(true) // 冷却后重新批量
    } finally {
      clock.mockRestore()
    }
  })

  it('-32600 invalid request：10 分钟内逐条请求，之后重新尝试批量', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const log: Array<RpcCall | RpcCall[]> = []
    let supportsBatch = false
    const rpc = new HttpRpc('https://rpc.example', {
      fetch: fakeFetch((body) => {
        if (Array.isArray(body)) {
          return supportsBatch ? body.map(ok) : { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid request' } }
        }
        return ok(body)
      }, log),
    })
    expect(await Promise.all([rpc.request('a'), rpc.request('b')])).toEqual(['a', 'b'])
    log.length = 0
    await Promise.all([rpc.request('c'), rpc.request('d')])
    expect(log.every((b) => !Array.isArray(b))).toBe(true)
    supportsBatch = true
    clock.mockReturnValue(now + 11 * 60 * 1000)
    log.length = 0
    await Promise.all([rpc.request('e'), rpc.request('f')])
    expect(log).toHaveLength(1)
    expect(Array.isArray(log[0])).toBe(true)
  })
})

describe('02：节点解析不了的代币账户（退回 base64）不丢弃', () => {
  /** jsonParsed 时对这个 Token-2022 账户退回 base64 的节点 */
  function node(): RpcTransport {
    const mintAccount = { lamports: 1, owner: TOKEN_2022_PROGRAM_ID, data: [base64.encode(mintData({ decimals: 6 })), 'base64'], executable: false }
    const entry = { pubkey: TOKEN_ACCOUNT, account: { owner: TOKEN_2022_PROGRAM_ID, data: [base64.encode(tokenAccountData(PYUSD, OWNER, 2_500_000n)), 'base64'] } }
    return {
      async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
        switch (method) {
          case 'getBalance':
            return { context: { slot: 1 }, value: 5 } as T
          case 'getTokenAccountsByOwner': {
            const filter = params[1] as { programId?: string; mint?: string }
            const match = filter.mint === PYUSD || filter.programId === TOKEN_2022_PROGRAM_ID
            return { context: { slot: 1 }, value: match ? [entry] : [] } as T
          }
          case 'getMultipleAccounts':
            return { context: { slot: 1 }, value: (params[0] as string[]).map((a) => (a === PYUSD ? mintAccount : null)) } as T
          default:
            throw new Error(`unsupported ${method}`)
        }
      },
    }
  }

  it('扫描模式：按 base64 解出 mint / 数量，decimals 读 mint 账户补上', async () => {
    const res = await new SolanaClient(node()).balances(OWNER)
    expect(res.find((r) => r.token === PYUSD)).toMatchObject({ balance: '2500000', decimals: 6, formatted: '2.5', tokenProgram: TOKEN_2022_PROGRAM_ID, success: true })
  })

  it("accounts: 'all'：余额不会被算成 0", async () => {
    const [pyusd] = await new SolanaClient(node()).balances(OWNER, [PYUSD], { accounts: 'all' })
    expect(pyusd).toMatchObject({ balance: '2500000', decimals: 6, success: true })
  })
})

describe('03：未初始化的 mint 不当作 decimals = 0、不缓存', () => {
  it('读到未初始化的 mint 时失败；初始化后能正常读到 decimals', async () => {
    const data = mintData({ decimals: 6 })
    const uninitialized = data.slice()
    uninitialized[45] = 0 // isInitialized
    const accounts: Record<string, MockAccount> = { [USDC]: { owner: TOKEN_PROGRAM_ID, data: uninitialized } }
    const sol = new SolanaClient(createMockNode({ accounts }))
    const [before] = await sol.tokens([USDC], { fields: ['decimals'] })
    expect(before?.success).toBe(false)
    accounts[USDC] = { owner: TOKEN_PROGRAM_ID, data }
    const [after] = await sol.tokens([USDC], { fields: ['decimals'] })
    expect(after).toMatchObject({ decimals: 6, success: true })
  })
})

describe('04：读响应体时出错包装成 HttpError', () => {
  it('读 body 超时：HttpError（timeout 标记），不是原生 DOMException', async () => {
    const rpc = new HttpRpc('https://rpc.example/KEY', {
      fetch: (async () =>
        ({
          status: 200,
          ok: true,
          text: () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
        }) as unknown as Response) as typeof fetch,
    })
    const err = await rpc.request('getSlot').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).timeout).toBe(true)
    expect((err as Error).message).not.toMatch(/KEY/)
  })
})

describe('05：持续 429 时不放大请求数', () => {
  it('整批都是 429：只在批量层重试（共 retries + 1 次），不再逐条重试', async () => {
    const log: Array<RpcCall | RpcCall[]> = []
    const rpc = new HttpRpc('https://rpc.example', {
      retries: 1,
      fetch: fakeFetch((body) => (Array.isArray(body) ? body : [body]).map((r) => ({ jsonrpc: '2.0', id: r.id, error: { code: 429, message: 'Too many requests' } })), log),
    })
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => rpc.request(`m${i}`)))
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    expect(log).toHaveLength(2)
  })

  it('批量里部分 429：只把这些调用单独重试一次', async () => {
    const log: Array<RpcCall | RpcCall[]> = []
    const rpc = new HttpRpc('https://rpc.example', {
      fetch: fakeFetch((body) =>
        Array.isArray(body) ? body.map((r) => (r.method === 'busy' ? { jsonrpc: '2.0', id: r.id, error: { code: 429, message: 'Too many requests' } } : ok(r))) : ok(body),
      log),
    })
    const [a, busy] = await Promise.allSettled([rpc.request('a'), rpc.request('busy')])
    expect(a).toMatchObject({ status: 'fulfilled', value: 'a' })
    expect(busy).toMatchObject({ status: 'fulfilled', value: 'busy' })
    expect(log).toHaveLength(2)
  })
})

describe('07：导入缓存的时间戳和所属程序', () => {
  it('未来的时间戳截到现在：name / symbol 仍按 1 小时过期；NaN / Infinity 丢弃', () => {
    const now = Date.now()
    importTokenMetaCache({
      version: 1,
      entries: [
        [`mainnet:${USDC}`, { decimals: 6, name: 'USD Coin', symbol: 'USDC', namesAt: now + 10 * 365 * 24 * 3600 * 1000 }],
        [`mainnet:${PYUSD}`, { decimals: 6, name: 'PayPal USD', symbol: 'PYUSD', namesAt: Number.POSITIVE_INFINITY }],
      ],
    })
    const entries = Object.fromEntries(exportTokenMetaCache().entries)
    expect(entries[`mainnet:${USDC}`]?.namesAt).toBeLessThanOrEqual(Date.now())
    expect(entries[`mainnet:${PYUSD}`]).toEqual({ decimals: 6 })
  })

  it('导入的所属程序记错时，ATA 模式照常读到余额，并从链上纠正缓存', async () => {
    importTokenMetaCache({ version: 1, entries: [[`mainnet:${USDC}`, { decimals: 6, tokenProgram: TOKEN_2022_PROGRAM_ID }]] })
    const node = createMockNode({
      accounts: {
        [OWNER]: { lamports: 1n, owner: SYSTEM_PROGRAM_ID },
        [USDC]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) },
        [getAssociatedTokenAddress(OWNER, USDC, TOKEN_PROGRAM_ID)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(USDC, OWNER, 7_000_000n) },
      },
    })
    const sol = new SolanaClient(node, { cluster: 'mainnet' })
    const [usdc] = await sol.balances(OWNER, [USDC])
    expect(usdc).toMatchObject({ balance: '7000000', tokenProgram: TOKEN_PROGRAM_ID, success: true })
    expect(Object.fromEntries(exportTokenMetaCache().entries)[`mainnet:${USDC}`]?.tokenProgram).toBe(TOKEN_PROGRAM_ID)
  })
})

describe('09：大数兜底跳过字符串字面量', () => {
  it('只改数值位置上 16 位以上的整数，字符串里的长数字原样保留', () => {
    const text = '{"message":"limit, 12345678901234567] exceeded \\" 9999999999999999999","lamports":1152921504606859191,"x":[1.5e300,-12345678901234567,12]}'
    expect(JSON.parse(quoteBigIntegers(text))).toEqual({
      message: 'limit, 12345678901234567] exceeded " 9999999999999999999',
      lamports: '1152921504606859191',
      x: [1.5e300, '-12345678901234567', 12],
    })
  })
})

describe('10：节点限制单次 getMultipleAccounts 的账户数', () => {
  it('“Too many accounts requested”：减半后分多次请求、合并结果，并记住上限；不当成节点故障', async () => {
    const sizes: number[] = []
    const rpc = new HttpRpc('https://rpc.example', {
      batch: false,
      fetch: fakeFetch((body) => {
        const req = body as RpcCall
        const addresses = req.params[0] as string[]
        sizes.push(addresses.length)
        if (addresses.length > 2) {
          return { jsonrpc: '2.0', id: req.id, error: { code: -32600, message: 'Too many accounts requested' } }
        }
        return { jsonrpc: '2.0', id: req.id, result: { context: { slot: 10 + addresses.length }, value: addresses.map((a) => ({ a })) } }
      }),
    })
    const addresses = ['a', 'b', 'c', 'd', 'e']
    const res = (await rpc.request('getMultipleAccounts', [addresses, {}])) as { context: { slot: number }; value: Array<{ a: string }> }
    expect(res.value.map((v) => v.a)).toEqual(addresses)
    expect(res.context.slot).toBe(11) // 合并后取最小的 slot
    sizes.length = 0
    await rpc.request('getMultipleAccounts', [addresses, {}])
    expect(sizes.every((n) => n <= 2)).toBe(true) // 记住了上限，直接拆分
  })
})

describe('11：findProgramAddress 检查种子', () => {
  it('种子超过 32 字节或超过 15 个（加上 bump 共 16 个）时抛错', () => {
    expect(() => findProgramAddress([new Uint8Array(33)], TOKEN_PROGRAM_ID)).toThrow('Max seed length exceeded')
    expect(() => findProgramAddress(Array.from({ length: 16 }, () => new Uint8Array(1)), TOKEN_PROGRAM_ID)).toThrow('Max seeds exceeded')
    expect(() => findProgramAddress(Array.from({ length: 15 }, () => new Uint8Array(32)), TOKEN_PROGRAM_ID)).not.toThrow()
  })
})


describe('review 修复：补读 mint、钱包学习、导入的所属程序', () => {
  /** 对 PYUSD 的代币账户退回 base64 的节点；可让读 mint 失败、可去掉账户 owner；记录所有调用 */
  function node(options: { mintFails?: boolean; noOwner?: boolean; slot?: number } = {}) {
    const calls: Array<{ method: string; params: readonly unknown[] }> = []
    const mintAccount = { lamports: 1, owner: TOKEN_2022_PROGRAM_ID, data: [base64.encode(mintData({ decimals: 6 })), 'base64'], executable: false }
    const entry = {
      pubkey: TOKEN_ACCOUNT,
      account: { ...(options.noOwner ? {} : { owner: TOKEN_2022_PROGRAM_ID }), data: [base64.encode(tokenAccountData(PYUSD, OWNER, 2_500_000n)), 'base64'] },
    }
    const transport: RpcTransport & { calls: typeof calls } = {
      calls,
      async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
        calls.push({ method, params })
        const context = { slot: options.slot ?? 100 }
        switch (method) {
          case 'getBalance':
            return { context, value: 5 } as T
          case 'getTokenAccountsByOwner': {
            const filter = params[1] as { programId?: string; mint?: string }
            return { context, value: filter.mint === PYUSD || filter.programId === TOKEN_2022_PROGRAM_ID ? [entry] : [] } as T
          }
          case 'getMultipleAccounts': {
            const { RpcError } = await import('../src/rpc.js')
            if (options.mintFails && (params[0] as string[]).includes(PYUSD)) throw new RpcError('Too many requests', 429)
            // 补读 mint 的响应 slot 更小：不应计入扫描的 slot
            return { context: { slot: 1 }, value: (params[0] as string[]).map((a) => (a === PYUSD ? mintAccount : null)) } as T
          }
          default:
            throw new Error(`unsupported ${method}`)
        }
      },
    }
    return transport
  }

  it('ownerTokens：补读 mint 不带 minContextSlot、不计入扫描的 slot；读失败时跳过这个代币，不让整次查询失败', async () => {
    const n = node()
    const list = await new SolanaClient(n).ownerTokens(OWNER, { metadata: false, minContextSlot: 50, withSlot: true })
    expect(list.find((t) => t.token === PYUSD)).toMatchObject({ balance: '2500000', decimals: 6 })
    expect(list[0]?.slot).toBe(100)
    const mintRead = n.calls.find((c) => c.method === 'getMultipleAccounts')
    expect((mintRead?.params[1] as { minContextSlot?: number }).minContextSlot).toBeUndefined()

    resetTokenMetaCache()
    const failing = await new SolanaClient(node({ mintFails: true })).ownerTokens(OWNER, { metadata: false })
    expect(failing.map((t) => t.token)).not.toContain(PYUSD)
  })

  it("accounts: 'all' + symbol：mint 账户只读一次", async () => {
    const n = node()
    await new SolanaClient(n).balances(OWNER, [PYUSD], { accounts: 'all', symbol: true })
    expect(n.calls.filter((c) => c.method === 'getMultipleAccounts' && (c.params[0] as string[]).includes(PYUSD))).toHaveLength(1)
  })

  it('节点没给代币账户的 owner：读 mint 账户确认所属程序，而不是得到 undefined', async () => {
    const [pyusd] = await new SolanaClient(node({ noOwner: true })).balances(OWNER, [PYUSD], { accounts: 'all' })
    expect(pyusd).toMatchObject({ balance: '2500000', tokenProgram: TOKEN_2022_PROGRAM_ID, success: true })
  })

  it("导入的所属程序记错时，accounts: 'all' 不用它排除代币，按链上结果过滤", async () => {
    const USDC_ATA = getAssociatedTokenAddress(OWNER, USDC, TOKEN_PROGRAM_ID)
    const mock = createMockNode({
      accounts: {
        [USDC]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) },
        [USDC_ATA]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(USDC, OWNER, 7_000_000n) },
      },
    })
    // 快照把 USDC 记成了 Token-2022
    importTokenMetaCache({ version: 1, entries: [[`mainnet:${USDC}`, { decimals: 6, tokenProgram: TOKEN_2022_PROGRAM_ID }]] })
    expect(JSON.stringify(exportTokenMetaCache())).toContain(TOKEN_2022_PROGRAM_ID) // 快照确实导入了（否则这条用例没有意义）
    const res = await new SolanaClient(mock, { cluster: 'mainnet' }).balances(OWNER, [USDC], { accounts: 'all', tokenPrograms: ['spl'] })
    expect(res).toEqual([expect.objectContaining({ token: USDC, balance: '7000000', tokenProgram: TOKEN_PROGRAM_ID })])
  })

  it('不存在的钱包也记为普通钱包：第二次起与代币账户同一个请求', async () => {
    const EMPTY_WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
    const mock = createMockNode({ accounts: { [USDC]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) } } })
    const sol = new SolanaClient(mock)
    await sol.balances(EMPTY_WALLET, ['So11111111111111111111111111111111111111112', USDC])
    mock.calls.length = 0
    const res = await sol.balances(EMPTY_WALLET, ['So11111111111111111111111111111111111111112', USDC])
    expect(res.map((r) => r.balance)).toEqual(['0', '0'])
    const reads = mock.calls.filter((c) => c.method === 'getMultipleAccounts')
    expect(reads).toHaveLength(1)
    expect(reads[0]?.params[0]).toContain(EMPTY_WALLET)
  })
})
