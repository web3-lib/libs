import { beforeEach, describe, expect, it } from 'vitest'

import {
  AllNodesFailedError,
  ApiError,
  FallbackTransport,
  HttpError,
  NATIVE_TON,
  TonClient,
  ToncenterTransport,
  crc16,
  getBalances,
  isValidTonAddress,
  parseTonAddress,
  resetMetadataCache,
  sameTonAddress,
  toFriendlyAddress,
  toRawAddress,
  type TonTransport,
} from '../src/index.js'

// 主网上的真实地址：钱包（v4r2）和 USDT 主合约
const WALLET_RAW = '0:23fa979918f1fe702db9100bf843e87c7015eccd39a4721e9b6bac170bc04ce3'
const WALLET = 'UQAj-peZGPH-cC25EAv4Q-h8cBXszTmkch6ba6wXC8BM40qt'
const USDT_RAW = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe'
const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'

describe('地址', () => {
  it('原始格式 ↔ 用户友好格式（可回弹 / 不可回弹 / 测试网 / 非 URL 安全）', () => {
    expect(toRawAddress(WALLET)).toBe(WALLET_RAW)
    expect(toRawAddress(USDT)).toBe(USDT_RAW)
    expect(toFriendlyAddress(WALLET_RAW, { bounceable: false })).toBe(WALLET)
    expect(toFriendlyAddress(USDT_RAW)).toBe(USDT)
    expect(toFriendlyAddress(WALLET_RAW, { bounceable: true })).toBe('EQAj-peZGPH-cC25EAv4Q-h8cBXszTmkch6ba6wXC8BM4xdo')
    const test = toFriendlyAddress(WALLET_RAW, { testOnly: true })
    expect(test.startsWith('kQ')).toBe(true)
    expect(parseTonAddress(test)).toMatchObject({ bounceable: true, testOnly: true, workchain: 0 })
    expect(toFriendlyAddress(WALLET_RAW, { urlSafe: false })).toMatch(/^[A-Za-z0-9+/]+$/)
    expect(sameTonAddress(WALLET, WALLET_RAW.toUpperCase().replace('0X', '0x'))).toBe(true)
    // 主链（-1）地址
    const master = `-1:${'3'.repeat(64)}`
    expect(toRawAddress(toFriendlyAddress(master))).toBe(master)
  })

  it('校验和、长度、标志位不对的都不合法', () => {
    const bad = `${WALLET.slice(0, -1)}${WALLET.endsWith('t') ? 'u' : 't'}`
    for (const v of [bad, 'abc', `0:${'0'.repeat(63)}`, `128:${'0'.repeat(64)}`, '']) {
      expect(isValidTonAddress(v)).toBe(false)
    }
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0x31c3) // CRC16-XMODEM 的标准测试向量
  })
})

// ---------------------------------------------------------------------------
// 假的 toncenter
// ---------------------------------------------------------------------------

interface FakeApi {
  accounts: Record<string, { balance: string; status: string }>
  /** owner → master → [钱包地址, 余额] */
  jettonWallets: Record<string, Record<string, [string, string]>>
  masters: Record<string, { decimals?: string; name?: string; symbol?: string; totalSupply: string; indexedDecimals?: string; scam?: boolean; uri?: string }>
}

const up = (raw: string) => raw.toUpperCase().replace(/^(-?\d+):/, '$1:')

function fakeToncenter(api: FakeApi) {
  const calls: Array<{ path: string; query: URLSearchParams }> = []
  const fetchFn = (async (url: string | URL | Request) => {
    const u = new URL(String(url))
    const path = u.pathname.replace(/^\/api\/v3\//, '')
    calls.push({ path, query: u.searchParams })
    const q = u.searchParams
    const metadata = (raws: string[]) =>
      Object.fromEntries(
        raws.flatMap((r) => {
          const m = api.masters[r]
          return m?.symbol || m?.scam ? [[up(r), { is_indexed: true, token_info: [{ valid: true, type: 'jetton_masters', name: m.name, symbol: m.symbol, is_scam: m.scam ?? false, extra: m.indexedDecimals ? { decimals: m.indexedDecimals } : {} }] }]] : []
        }),
      )
    let body: unknown
    if (path === 'accountStates') {
      body = { accounts: q.getAll('address').flatMap((a) => (api.accounts[a] ? [{ address: up(a), ...api.accounts[a] }] : [])), address_book: {} }
    } else if (path === 'jetton/wallets') {
      const owners = q.getAll('owner_address')
      const filter = q.getAll('jetton_address')
      const rows = owners.flatMap((o) =>
        Object.entries(api.jettonWallets[o] ?? {})
          .filter(([m, [, bal]]) => (!filter.length || filter.includes(m)) && (q.get('exclude_zero_balance') !== 'true' || bal !== '0'))
          .map(([m, [w, bal]]) => ({ address: up(w), balance: bal, owner: up(o), jetton: up(m) })),
      )
      const offset = Number(q.get('offset') ?? 0)
      const limit = Number(q.get('limit') ?? 10)
      body = { jetton_wallets: rows.slice(offset, offset + limit), address_book: {}, metadata: metadata([...new Set(rows.map((r) => r.jetton.toLowerCase()))]) }
    } else if (path === 'jetton/masters') {
      const list = q.getAll('address').flatMap((a) => {
        const m = api.masters[a]
        return m ? [{ address: up(a), total_supply: m.totalSupply, mintable: true, admin_address: null, jetton_content: m.decimals ? { decimals: m.decimals } : m.uri ? { uri: m.uri } : {} }] : []
      })
      body = { jetton_masters: list, address_book: {}, metadata: metadata(q.getAll('address')) }
    } else {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
  return { fetch: fetchFn, calls }
}

const OWNER_B = `0:${'b'.repeat(64)}`
const JUNK = `0:${'c'.repeat(64)}`
const NOT_JETTON = `0:${'d'.repeat(64)}`

function api(): FakeApi {
  return {
    accounts: { [WALLET_RAW]: { balance: '1500000000', status: 'active' }, [OWNER_B]: { balance: '7', status: 'active' } },
    jettonWallets: {
      [WALLET_RAW]: { [USDT_RAW]: [`0:${'1'.repeat(64)}`, '2500000'], [JUNK]: [`0:${'2'.repeat(64)}`, '0'] },
      [OWNER_B]: { [JUNK]: [`0:${'3'.repeat(64)}`, '42'] },
    },
    masters: {
      // USDT：索引器的元数据里有 decimals
      [USDT_RAW]: { name: 'Tether USD', symbol: 'USD₮', indexedDecimals: '6', totalSupply: '100' },
      // 没有元数据：精度看主合约内容，都没有时按 9
      [JUNK]: { totalSupply: '5', scam: true },
    },
  }
}

function client(a = api()) {
  const node = fakeToncenter(a)
  return { node, ton: new TonClient('https://toncenter.test/api/v3', { fetch: node.fetch, minInterval: 0 }) }
}

beforeEach(() => resetMetadataCache())

describe('TonClient', () => {
  it('一个地址：TON + 持有的全部 Jetton（余额为 0 的不返回），精度来自元数据', async () => {
    const { ton } = client()
    expect(await ton.balances(WALLET, undefined, { symbol: true })).toEqual([
      { token: NATIVE_TON, native: true, wallet: null, balance: '1500000000', decimals: 9, formatted: '1.5', symbol: 'TON', isScam: false, success: true },
      { token: USDT, native: false, wallet: toFriendlyAddress(`0:${'1'.repeat(64)}`), balance: '2500000', decimals: 6, formatted: '2.5', symbol: 'USD₮', isScam: false, success: true },
    ])
  })

  it('指定代币：没有钱包的 Jetton 余额为 0，不是 Jetton 的标记 not-found，地址非法', async () => {
    const { ton } = client()
    const list = await ton.balances(WALLET, [NATIVE_TON, USDT_RAW, JUNK, NOT_JETTON, 'bad'])
    expect(list.map((b) => [b.native, b.balance, b.decimals, b.success, b.error])).toEqual([
      [true, '1500000000', 9, true, undefined],
      [false, '2500000', 6, true, undefined],
      [false, '0', 9, true, undefined],
      [false, '0', 9, false, 'not-found'],
      [false, '0', 9, false, 'invalid-address'],
    ])
    await expect(ton.balances('bad')).rejects.toThrow(/Invalid TON address/)
  })

  it('多个地址合成一次请求；元数据有缓存', async () => {
    const { ton, node } = client()
    const [a, b] = await ton.multiBalances([{ owner: WALLET }, { owner: OWNER_B }], { symbol: true })
    expect(a?.map((x) => x.formatted)).toEqual(['1.5', '2.5'])
    expect(b?.map((x) => [x.formatted, x.isScam])).toEqual([
      ['0.000000007', false],
      ['0.000000042', true],
    ])
    const paths = node.calls.map((c) => c.path)
    expect(paths.filter((p) => p === 'jetton/wallets')).toHaveLength(1)
    expect(paths.filter((p) => p === 'accountStates')).toHaveLength(1)
    expect(node.calls.find((c) => c.path === 'jetton/wallets')?.query.getAll('owner_address')).toEqual([WALLET_RAW, OWNER_B])
    const before = node.calls.length
    await ton.balances(OWNER_B)
    // 再查一次：JUNK 的元数据已缓存，不再读 jetton/masters
    expect(node.calls.slice(before).map((c) => c.path)).toEqual(['accountStates', 'jetton/wallets'])
  })

  it('混合查询：一个查全部、一个指定没有余额的 Jetton，指定的照样识别（不误报 not-found）', async () => {
    const { ton } = client()
    const [, b] = await ton.multiBalances([{ owner: WALLET }, { owner: OWNER_B, tokens: [USDT] }])
    expect(b).toMatchObject([{ token: USDT, balance: '0', decimals: 6, success: true }])
  })

  it('TON 余额：没用过的地址余额 0；Jetton 信息', async () => {
    const { ton } = client()
    expect(await ton.tonBalances([WALLET, `0:${'9'.repeat(64)}`, 'x'])).toMatchObject([
      { address: WALLET_RAW.length ? toFriendlyAddress(WALLET_RAW) : '', balance: '1500000000', status: 'active', success: true },
      { balance: '0', status: 'nonexist', success: true },
      { success: false, error: 'invalid-address' },
    ])
    expect(await ton.jettons([USDT, NOT_JETTON])).toMatchObject([
      { address: USDT, symbol: 'USD₮', decimals: 6, totalSupply: '100', success: true },
      { success: false, error: 'not-found' },
    ])
  })

  it('快捷函数', async () => {
    const node = fakeToncenter(api())
    const [ton] = await getBalances(WALLET, { provider: 'https://toncenter.test/api/v3', fetch: node.fetch, minInterval: 0, tokens: [NATIVE_TON] })
    expect(ton?.formatted).toBe('1.5')
  })
})

describe('传输', () => {
  it('按 minInterval 排队，不超过免费额度', async () => {
    const times: number[] = []
    const fetchFn = (async () => {
      times.push(Date.now())
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const t = new ToncenterTransport('https://x.test/api/v3', { fetch: fetchFn, minInterval: 100 })
    await Promise.all([t.get('a', {}), t.get('b', {}), t.get('c', {})])
    expect((times[2] as number) - (times[0] as number)).toBeGreaterThanOrEqual(190)
  })

  it('429 退避重试；4xx 是请求错误（ApiError），5xx / 网络错误换节点', async () => {
    let n = 0
    const limited = (async () => (++n < 2 ? new Response('', { status: 429 }) : new Response('{"ok":1}', { status: 200 }))) as unknown as typeof fetch
    expect(await new ToncenterTransport('https://x.test/api/v3', { fetch: limited, minInterval: 0 }).get('a', {})).toEqual({ ok: 1 })
    const notFound = new ToncenterTransport('https://x.test/api/v3', { fetch: (async () => new Response('{"error":"bad address"}', { status: 422 })) as unknown as typeof fetch, minInterval: 0 })
    await expect(notFound.get('a', {})).rejects.toBeInstanceOf(ApiError)
    const node = (label: string, fn: () => Promise<unknown>): TonTransport & { hits: number } => {
      const t = { label, hits: 0, get: async () => (t.hits++, fn()), post: async () => (t.hits++, fn()) } as TonTransport & { hits: number }
      return t
    }
    const down = node('down', async () => {
      throw new HttpError('502', 502)
    })
    const up2 = node('up', async () => 'ok')
    expect(await new FallbackTransport([down, up2]).get('a', {})).toBe('ok')
    const api = node('api', async () => {
      throw new ApiError('bad', 400)
    })
    const spare = node('spare', async () => 'x')
    await expect(new FallbackTransport([api, spare]).get('a', {})).rejects.toBeInstanceOf(ApiError)
    expect(spare.hits).toBe(0)
    await expect(new FallbackTransport([down, node('d2', async () => Promise.reject(new HttpError('x')))]).get('a', {})).rejects.toBeInstanceOf(AllNodesFailedError)
  }, 10_000)

  it('元数据在链下、索引器还没读到：decimals 暂按 9，带 decimalsUnknown，不缓存', async () => {
    const OFFCHAIN = `0:${'e'.repeat(64)}`
    const a = api()
    a.masters[OFFCHAIN] = { totalSupply: '1', uri: 'https://example.test/jetton.json' }
    const { node, ton } = client(a)
    const [first] = await ton.jettons([OFFCHAIN])
    expect(first).toMatchObject({ decimals: 9, decimalsUnknown: true, success: true })
    // 索引器读到之后再查就对了（上一次没有缓存）
    a.masters[OFFCHAIN] = { totalSupply: '1', uri: 'https://example.test/jetton.json', symbol: 'OFF', indexedDecimals: '6' }
    const [second] = await ton.jettons([OFFCHAIN])
    expect(second?.decimals).toBe(6)
    expect(second?.decimalsUnknown).toBeUndefined()
    expect(node.calls.filter((c) => c.path === 'jetton/masters').length).toBe(2)
    // 链上内容里没有 uri（全部链上）又没写 decimals：按 TEP-64 就是 9，不算未知
    const [onchain] = await ton.jettons([JUNK])
    expect(onchain?.decimalsUnknown).toBeUndefined()
  })
})
