import { beforeEach, describe, expect, it } from 'vitest'

import {
  AllNodesFailedError,
  BehindError,
  FallbackTransport,
  GrpcError,
  GrpcWebTransport,
  HttpError,
  NetworkMismatchError,
  ProtoMessage,
  ProtoWriter,
  SUI_COIN_TYPE,
  SuiClient,
  decodeValue,
  formatUnits,
  getBalances,
  normalizeStructTag,
  normalizeSuiAddress,
  parseUnits,
  resetCoinCache,
  type GrpcTransport,
} from '../src/index.js'
import { createFakeNode, encodeValue, grpcWebBody, type FakeState } from './fakeNode.js'

const OWNER = '0xa1'
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
const long = (a: string) => normalizeSuiAddress(a)

function state(): FakeState {
  return {
    chain: 'mainnet',
    checkpoint: 1000,
    balances: { [long(OWNER)]: { [SUI_COIN_TYPE]: 1_500_000_000n, [USDC]: 2_500_000n, [`${long('0x9')}::junk::JUNK`]: 0n } },
    coins: { [USDC]: { decimals: 6, symbol: 'USDC', totalSupply: 10n ** 12n } },
    objects: [
      { id: '0x6', type: `${long('0x2')}::clock::Clock`, json: { timestamp_ms: '1' } },
      { id: '0xc1', type: `${long('0x2')}::coin::Coin<${SUI_COIN_TYPE}>`, owner: OWNER, json: { balance: '5' } },
      { id: '0xd1', type: `${long('0x77')}::nft::Hero`, owner: OWNER, display: { name: 'Hero #1', image_url: 'https://img/1', link: 'https://x' } },
      { id: '0xd2', type: `${long('0x78')}::nft::Plain`, owner: OWNER, json: { name: 'Plain', url: 'https://img/2', nested: { a: [1, true, null] } } },
      { id: '0xd3', type: `${long('0x79')}::cap::AdminCap`, owner: OWNER, json: { id: '0xd3' } },
    ],
  }
}

function client(s: FakeState = state()) {
  const node = createFakeNode(s)
  return { node, sui: new SuiClient('https://node.test', { fetch: node.fetch }) }
}

beforeEach(() => resetCoinCache())

describe('protobuf', () => {
  it('写入和读取：varint、负数、字符串、嵌套、重复字段', () => {
    const bytes = new ProtoWriter()
      .uint(1, 300)
      .uint(2, -5)
      .string(3, '你好')
      .message(4, new ProtoWriter().uint(1, 2n ** 63n))
      .string(5, 'a')
      .string(5, 'b')
      .uint(6, true)
      .finish()
    const m = ProtoMessage.decode(bytes)
    expect(m.number(1)).toBe(300)
    expect(m.int(2)).toBe(-5n)
    expect(m.string(3)).toBe('你好')
    expect(m.message(4)?.uint(1)).toBe(2n ** 63n)
    expect(m.strings(5)).toEqual(['a', 'b'])
    expect(m.bool(6)).toBe(true)
    expect(m.string(99)).toBe(null)
    expect(() => ProtoMessage.decode(new Uint8Array([0x0a, 0x05, 1]))).toThrow(/truncated/)
  })

  it('google.protobuf.Value', () => {
    const value = { a: 1.5, b: 'x', c: [true, null, { d: -2 }], e: false }
    expect(decodeValue(ProtoMessage.decode(encodeValue(value).finish()))).toEqual(value)
  })
})

describe('地址和类型', () => {
  it('补足 64 位、小写；泛型参数同样处理', () => {
    expect(normalizeSuiAddress('0x2')).toBe(`0x${'0'.repeat(63)}2`)
    expect(normalizeSuiAddress('0xABC')).toBe(`0x${'0'.repeat(61)}abc`)
    expect(() => normalizeSuiAddress('0xzz')).toThrow()
    expect(() => normalizeSuiAddress('abc')).toThrow() // 必须带 0x
    expect(normalizeStructTag('0x2::sui::SUI')).toBe(SUI_COIN_TYPE)
    expect(normalizeStructTag('0x2::coin::Coin<0x2::sui::SUI>')).toBe(`${long('0x2')}::coin::Coin<${SUI_COIN_TYPE}>`)
    expect(normalizeStructTag('0x1::pool::Pool<0x2::sui::SUI,vector<u8>>')).toBe(`${long('0x1')}::pool::Pool<${SUI_COIN_TYPE}, vector<u8>>`)
    for (const bad of ['sui', '0x2::sui', '0x2::sui::SUI<', '0x2::1x::A', 'zz::a::B']) {
      expect(() => normalizeStructTag(bad)).toThrow()
    }
  })

  it('formatUnits / parseUnits', () => {
    expect(formatUnits(1_500_000_000n, 9)).toBe('1.5')
    expect(parseUnits('1.5', 9)).toBe(1_500_000_000n)
    expect(() => parseUnits('1.0000000001', 9)).toThrow(/Too many decimals/)
  })
})

describe('gRPC-web 传输', () => {
  const respond = (body: Uint8Array, init: ResponseInit = { status: 200 }) => (async () => new Response(body as BodyInit, init)) as unknown as typeof fetch

  it('数据帧 + trailer；状态不为 0 时抛 GrpcError（消息按百分号解码）', async () => {
    const ok = new GrpcWebTransport('https://n.test', { fetch: respond(grpcWebBody(new ProtoWriter().string(1, 'x').finish())) })
    expect((await ok.unary('a/B', new Uint8Array())).message.string(1)).toBe('x')
    const bad = new GrpcWebTransport('https://n.test', { fetch: respond(grpcWebBody(null, 3, 'bad arg: 中文')) })
    await expect(bad.unary('a/B', new Uint8Array())).rejects.toMatchObject({ name: 'GrpcError', code: 3, details: 'bad arg: 中文' })
  })

  it('只有响应头的错误（trailers-only）、HTTP 错误、截断的响应', async () => {
    const headersOnly = new GrpcWebTransport('https://n.test', { fetch: respond(new Uint8Array(), { status: 200, headers: { 'grpc-status': '14', 'grpc-message': 'down' } }) })
    await expect(headersOnly.unary('a/B', new Uint8Array())).rejects.toMatchObject({ code: 14 })
    const http = new GrpcWebTransport('https://n.test', { fetch: respond(new Uint8Array(), { status: 502 }), retries: 0 })
    await expect(http.unary('a/B', new Uint8Array())).rejects.toBeInstanceOf(HttpError)
    const noStatus = new GrpcWebTransport('https://n.test', { fetch: respond(new Uint8Array([0, 0, 0, 0, 0])) })
    await expect(noStatus.unary('a/B', new Uint8Array())).rejects.toThrow(/no grpc-status/)
  })

  it('限频时退避重试', async () => {
    let n = 0
    const fetchFn = (async () => (++n < 2 ? new Response('', { status: 429 }) : new Response(grpcWebBody(new Uint8Array()) as BodyInit, { status: 200 }))) as unknown as typeof fetch
    await new GrpcWebTransport('https://n.test', { fetch: fetchFn, retries: 2 }).unary('a/B', new Uint8Array())
    expect(n).toBe(2)
  })
})

describe('多节点', () => {
  const node = (label: string, impl: () => Promise<{ checkpoint?: number; chain?: string }>): GrpcTransport & { hits: number } => {
    const t = {
      label,
      hits: 0,
      async unary() {
        t.hits++
        const r = await impl()
        return { message: ProtoMessage.decode(new Uint8Array()), checkpoint: r.checkpoint ?? 100, chain: r.chain ?? 'mainnet' }
      },
    }
    return t
  }

  it('节点故障换下一个；确定性错误直接抛出', async () => {
    const down = node('down', async () => {
      throw new GrpcError(14, 'unavailable')
    })
    const up = node('up', async () => ({}))
    await new FallbackTransport([down, up]).unary('a/B', new Uint8Array())
    expect([down.hits, up.hits]).toEqual([1, 1])
    // 出错的节点冷却期内排到后面
    await new FallbackTransport([down, up]).unary('a/B', new Uint8Array())
    const invalid = node('invalid', async () => {
      throw new GrpcError(3, 'bad')
    })
    const spare = node('spare', async () => ({}))
    await expect(new FallbackTransport([invalid, spare]).unary('a/B', new Uint8Array())).rejects.toMatchObject({ code: 3 })
    expect(spare.hits).toBe(0)
  })

  it('网络不一致的节点不用；全部失败时 AllNodesFailedError', async () => {
    const testnet = node('t', async () => ({ chain: 'testnet' }))
    const mainnet = node('m', async () => ({ chain: 'mainnet' }))
    await new FallbackTransport([testnet, mainnet], { network: 'mainnet' }).unary('a/B', new Uint8Array())
    expect(mainnet.hits).toBe(1)
    await expect(new FallbackTransport([testnet], { network: 'mainnet' }).unary('a/B', new Uint8Array())).rejects.toBeInstanceOf(NetworkMismatchError)
    // devnet 的节点报告 'unknown'：可以用；但明确是主网的节点不行
    const devnet = node('d', async () => ({ chain: 'unknown' }))
    await new FallbackTransport([devnet], { network: 'devnet' }).unary('a/B', new Uint8Array())
    await expect(new FallbackTransport([mainnet], { network: 'devnet' }).unary('a/B', new Uint8Array())).rejects.toBeInstanceOf(NetworkMismatchError)
    // 主网要求精确一致（'unknown' 的节点可能是配错的 devnet）
    await expect(new FallbackTransport([devnet], { network: 'mainnet' }).unary('a/B', new Uint8Array())).rejects.toBeInstanceOf(NetworkMismatchError)
    const a = node('a', async () => {
      throw new HttpError('x')
    })
    const b = node('b', async () => {
      throw new HttpError('y')
    })
    await expect(new FallbackTransport([a, b]).unary('a/B', new Uint8Array())).rejects.toBeInstanceOf(AllNodesFailedError)
  })

  it('minCheckpoint：落后的节点换下一个；都落后时等节点跟上', async () => {
    let height = 90
    const slow = node('slow', async () => ({ checkpoint: (height += 5) }))
    const res = await new FallbackTransport([slow]).unary('a/B', new Uint8Array(), { minCheckpoint: 100 })
    expect(res.checkpoint).toBeGreaterThanOrEqual(100)
    expect(slow.hits).toBeGreaterThan(1)
    const stuck = node('stuck', async () => ({ checkpoint: 1 }))
    const fresh = node('fresh', async () => ({ checkpoint: 200 }))
    expect((await new FallbackTransport([stuck, fresh]).unary('a/B', new Uint8Array(), { minCheckpoint: 150 })).checkpoint).toBe(200)
    expect(BehindError).toBeTypeOf('function')
  }, 20_000)
})

describe('SuiClient', () => {
  it('持有的全部代币：余额为 0 的不返回，精度和 symbol 来自代币信息', async () => {
    const { sui } = client()
    const list = await sui.balances(OWNER, undefined, { symbol: true, withCheckpoint: true })
    expect(list).toEqual([
      { token: SUI_COIN_TYPE, native: true, balance: '1500000000', decimals: 9, formatted: '1.5', symbol: 'SUI', success: true, checkpoint: 1000 },
      { token: USDC, native: false, balance: '2500000', decimals: 6, formatted: '2.5', symbol: 'USDC', success: true, checkpoint: 1000 },
    ])
  })

  it('指定代币：短格式规范化、非法类型和不存在的代币标记失败、地址非法', async () => {
    const { sui } = client()
    const list = await sui.balances(OWNER, ['0x2::sui::SUI', USDC, 'nope', '0x5::fake::FAKE'])
    expect(list.map((b) => [b.token, b.success, b.error, b.formatted])).toEqual([
      [SUI_COIN_TYPE, true, undefined, '1.5'],
      [USDC, true, undefined, '2.5'],
      ['nope', false, 'invalid-type', null],
      [`${long('0x5')}::fake::FAKE`, false, 'not-found', null],
    ])
    expect((await sui.balances('bad', [USDC]))[0]).toMatchObject({ success: false, error: 'invalid-address' })
    await expect(sui.balances('bad')).rejects.toThrow(/Invalid Sui address/)
  })

  it('代币信息有缓存', async () => {
    const { sui, node } = client()
    await sui.coins([USDC])
    await sui.balances(OWNER, [USDC])
    expect(node.calls.filter((c) => c.endsWith('GetCoinInfo'))).toHaveLength(1)
    expect((await sui.coins([USDC, '0x5::fake::FAKE', 'x']))).toMatchObject([
      { token: USDC, decimals: 6, symbol: 'USDC', totalSupply: String(10n ** 12n), success: true },
      { success: false, error: 'not-found' },
      { success: false, error: 'invalid-type' },
    ])
  })

  it('按 ID 读对象：去重、分批，结果与输入一一对应', async () => {
    const { sui, node } = client()
    const ids = ['0x6', '0xd1', '0x404', 'bad', '0x6', ...Array.from({ length: 60 }, (_, i) => `0x${(i + 1000).toString(16)}`)]
    const list = await sui.objects(ids, { fields: ['type', 'json'] })
    expect(list).toHaveLength(ids.length)
    expect(list[0]?.json).toEqual({ timestamp_ms: '1' })
    expect(list[1]?.type).toBe(`${long('0x77')}::nft::Hero`)
    expect([list[2], list[3]]).toEqual([null, null])
    expect(list[4]?.objectId).toBe(long('0x6'))
    // 63 个不同的合法 ID：每次最多 50 个，分两批
    expect(node.calls.filter((c) => c.endsWith('BatchGetObjects'))).toHaveLength(2)
  })

  it('拥有的对象：类型过滤、翻页、limit', async () => {
    const { sui } = client()
    expect((await sui.ownedObjects(OWNER)).map((o) => o.objectId)).toEqual(['0xc1', '0xd1', '0xd2', '0xd3'].map(long))
    expect((await sui.ownedObjects(OWNER, { type: '0x77::nft::Hero' })).map((o) => o.objectId)).toEqual([long('0xd1')])
    expect(await sui.ownedObjects(OWNER, { limit: 2 })).toHaveLength(2)
  })

  it('NFT：去掉代币；有 Display 用 Display，没有时用内容里的字段；all 返回全部非代币对象', async () => {
    const { sui } = client()
    const nfts = await sui.nfts(OWNER)
    expect(nfts.map((n) => [n.name, n.imageUrl, n.link, n.display !== null])).toEqual([
      ['Hero #1', 'https://img/1', 'https://x', true],
      ['Plain', 'https://img/2', null, false],
    ])
    expect((await sui.nfts(OWNER, { all: true })).map((n) => n.objectId)).toEqual(['0xd1', '0xd2', '0xd3'].map(long))
  })

  it('快捷函数', async () => {
    const node = createFakeNode(state())
    const list = await getBalances(OWNER, { provider: 'https://node.test', fetch: node.fetch, coinTypes: [USDC] })
    expect(list[0]?.formatted).toBe('2.5')
  })
})
