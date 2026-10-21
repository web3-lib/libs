/** 域名解析：假的 dnsresolve 合约和地址簿（不连网络） */
import { describe, expect, it } from 'vitest'

import { TonClient, toFriendlyAddress, toRawAddress, type TonTransport } from '../src/index.js'
import { bytesCellBoc, recordAddress, rootCellData } from '../src/names.js'
import { NAME_SERVICES, lookupAddresses, resolveNames } from '../src/subpaths/names.js'
import { beginCell, Cell } from '../src/write/cell.js'

const raw = (c: string, wc = 0) => `${wc}:${c.repeat(64)}`
const TON_COLLECTION = toRawAddress(NAME_SERVICES[0]?.resolver as string)
const TME_COLLECTION = toRawAddress(NAME_SERVICES[1]?.resolver as string)
const ALICE_ITEM = raw('1')
const BOB_ITEM = raw('2')
const BOB_SUB = raw('3')
const EMPTY_ITEM = raw('4')
const MISSING_ITEM = raw('5')
const STUD_ITEM = raw('6')
const W1 = raw('a')
const W2 = raw('b')
const W3 = raw('c')

const WALLET_CATEGORY = '0xe8d44050873dba865aa7c170ab4cce64d90839a34dcfd6cf71d14e0205443b1b'
const record = (tag: number, address: string) => ({ type: 'cell', value: beginCell().storeUint(tag, 16).storeAddress(address).storeUint(0, 8).endCell().toBase64() })
const next = (address: string) => record(0xba93, address)
const wallet = (address: string) => record(0x9fd3, address)
const ok = (bytes: number, cell: unknown) => ({ exit_code: 0, stack: [{ type: 'num', value: `0x${(bytes * 8).toString(16)}` }, cell] })

/** 合约 → 剩下的名字（\0 写成 |）→ dnsresolve 的结果 */
const CONTRACTS: Record<string, (rest: string) => unknown> = {
  [TON_COLLECTION]: (rest) => {
    const label = /^\|([^|]+)/.exec(rest)?.[1] as string
    const item = { alice: ALICE_ITEM, bob: BOB_ITEM, empty: EMPTY_ITEM }[label] ?? MISSING_ITEM
    return ok(label.length + 1, next(item))
  },
  [TME_COLLECTION]: (rest) => (rest === '|stud|' ? ok(5, next(STUD_ITEM)) : ok(rest.length - 1, next(MISSING_ITEM))),
  [ALICE_ITEM]: (rest) => (rest === '|' ? ok(1, wallet(W1)) : ok(0, { type: 'list', value: [] })),
  // 子域名：bob.ton 的 NFT 把 x.bob.ton 交给下一个 resolver
  [BOB_ITEM]: (rest) => (rest === '|' ? ok(1, wallet(W2)) : ok(1, next(BOB_SUB))),
  [BOB_SUB]: (rest) => (rest === 'x|' ? ok(2, wallet(W3)) : ok(0, { type: 'list', value: [] })),
  // 注册了但没设置钱包：记录为 null
  [EMPTY_ITEM]: () => ok(1, { type: 'list', value: [] }),
  // 没部署（没注册）
  [MISSING_ITEM]: () => ({ exit_code: -13, stack: [] }),
  [STUD_ITEM]: () => ok(1, wallet(W1)),
}

function fakeNode(book: Record<string, string | null> = {}) {
  const calls: Array<{ address: string; rest: string }> = []
  const paths: string[] = []
  const transport: TonTransport = {
    async get<T>(path: string, query: Record<string, unknown>) {
      paths.push(path)
      if (path !== 'addressBook') throw new Error(`unexpected ${path}`)
      const list = query.address as string[]
      return Object.fromEntries(list.map((a) => [a, { user_friendly: a, domain: book[a] ?? null }])) as T
    },
    async post<T>(path: string, body: unknown) {
      paths.push(path)
      const { address, method, stack } = body as { address: string; method: string; stack: Array<{ type: string; value: string }> }
      expect(method).toBe('dnsresolve')
      expect(stack[1]).toEqual({ type: 'num', value: WALLET_CATEGORY })
      const s = Cell.fromBase64(stack[0]?.value as string).beginParse()
      const rest = new TextDecoder().decode(s.loadBytes(s.remainingBits / 8)).replace(/\0/g, '|')
      calls.push({ address, rest })
      const contract = CONTRACTS[address]
      return (contract ? contract(rest) : { exit_code: -13, stack: [] }) as T
    },
  }
  return { ton: new TonClient(transport), calls, paths }
}

const friendly = (a: string) => toFriendlyAddress(a, { bounceable: false })

describe('单个 Cell 的 BOC（不带 Cell / SHA-256 的编解码）', () => {
  it('与 Cell 的编码逐字节相同；读根 Cell 的数据（补位、引用、多个 Cell）；记录里的地址', () => {
    for (const text of ['\0foundation\0', 'x', 'a'.repeat(127)]) {
      const bytes = new TextEncoder().encode(text)
      expect(bytesCellBoc(bytes)).toBe(beginCell().storeBytes(bytes).endCell().toBase64())
    }
    const odd = beginCell().storeUint(0b101, 3).storeRef(beginCell().storeUint(7, 8)).endCell()
    expect(rootCellData(odd.toBase64())).toEqual({ data: Uint8Array.from([0b10100000]), bits: 3 })
    expect(rootCellData('not a boc')).toBe(null)
    const master = `-1:${'e5'.repeat(32)}`
    const rec = beginCell().storeUint(0x9fd3, 16).storeAddress(master).storeUint(0, 8).storeRef(beginCell().storeUint(1, 1)).endCell().toBase64()
    expect(recordAddress(rec, 0x9fd3)).toBe(master)
    expect(recordAddress(rec, 0xba93)).toBe(null)
    expect(recordAddress(beginCell().storeUint(0x9fd3, 16).storeAddress(null).endCell().toBase64(), 0x9fd3)).toBe(null)
  })
})

describe('resolveNames', () => {
  it('从后缀的 NFT 集合开始逐级解析：规范化、子域名、没有钱包 / 没注册为 null、没有服务的后缀和不合法的名字不发请求', async () => {
    const { ton, calls } = fakeNode()
    const names = ['Alice.TON', 'alice.ton.', 'x.bob.ton', 'empty.ton', 'nobody.ton', 'stud.t.me', 'vitalik.eth', 'bad name.ton', 'ton', '']
    expect(await resolveNames(ton, names)).toEqual([
      { name: 'Alice.TON', normalized: 'alice.ton', address: friendly(W1), service: 'ton' },
      { name: 'alice.ton.', normalized: 'alice.ton', address: friendly(W1), service: 'ton' },
      { name: 'x.bob.ton', normalized: 'x.bob.ton', address: friendly(W3), service: 'ton' },
      { name: 'empty.ton', normalized: 'empty.ton', address: null, service: 'ton' },
      { name: 'nobody.ton', normalized: 'nobody.ton', address: null, service: 'ton' },
      { name: 'stud.t.me', normalized: 'stud.t.me', address: friendly(W1), service: 't.me' },
      { name: 'vitalik.eth', normalized: 'vitalik.eth', address: null, service: null },
      { name: 'bad name.ton', normalized: null, address: null, service: null },
      { name: 'ton', normalized: null, address: null, service: null },
      { name: '', normalized: null, address: null, service: null },
    ])
    // 同一个名字只解析一次；根 DNS 已经解析掉的后缀不再传（"ton" / "me\0t"），从 \0 开始
    const of = (a: string) => calls.filter((c) => c.address === a).map((c) => c.rest)
    expect(of(TON_COLLECTION).sort()).toEqual(['|alice|', '|bob|x|', '|empty|', '|nobody|'])
    expect(of(TME_COLLECTION)).toEqual(['|stud|'])
    expect(of(BOB_ITEM)).toEqual(['|x|'])
    expect(of(BOB_SUB)).toEqual(['x|'])
    expect(calls).toHaveLength(11)
  })

  it('services：只用传入的服务；测试网默认只有 .ton', async () => {
    const { ton } = fakeNode()
    const [tme] = await resolveNames(ton, ['stud.t.me'], { services: NAME_SERVICES.filter((s) => s.id === 'ton' && s.network === 'mainnet') })
    expect(tme).toMatchObject({ address: null, service: null })
    expect(NAME_SERVICES.filter((s) => s.network === 'testnet').map((s) => s.suffix)).toEqual(['ton'])
  })

  it('节点问题照常抛出（不当作没有这个名字）', async () => {
    const transport: TonTransport = {
      get: async () => ({}) as never,
      post: async () => {
        throw new Error('HTTP 502')
      },
    }
    await expect(resolveNames(new TonClient(transport), ['alice.ton'])).rejects.toThrow(/502/)
  })
})

describe('lookupAddresses', () => {
  it('地址簿的 domain 再正查核对：指回别的地址的不返回；verify: false 直接用地址簿', async () => {
    const { ton, paths } = fakeNode({ [W1]: 'alice.ton', [W2]: 'Alice.ton', [W3]: 'x.bob.ton' })
    const input = [friendly(W1), W2, W3, raw('d'), 'bad']
    expect(await lookupAddresses(ton, input)).toEqual([
      { address: friendly(W1), name: 'alice.ton', service: 'ton' },
      // 地址簿说 W2 是 alice.ton，但 alice.ton 解析到 W1
      { address: W2, name: null, service: null },
      { address: W3, name: 'x.bob.ton', service: 'ton' },
      { address: raw('d'), name: null, service: null },
      { address: 'bad', name: null, service: null },
    ])
    expect(paths.filter((p) => p === 'addressBook')).toHaveLength(1)
    const { ton: ton2, paths: paths2 } = fakeNode({ [W2]: 'alice.ton' })
    expect(await lookupAddresses(ton2, [W2], { verify: false })).toEqual([{ address: W2, name: 'alice.ton', service: 'ton' }])
    expect(paths2).toEqual(['addressBook'])
  })
})
