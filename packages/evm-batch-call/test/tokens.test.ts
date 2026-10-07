import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest'

import { MULTICALL3_ADDRESS, NATIVE_TOKEN, Provider, getTokens } from '../src/index.js'
import { multicall3Interface, resetMulticallCache } from '../src/aggregate.js'
import { clearChainIdCache } from '../src/detect.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { resetBalancesProviderCache } from '../src/shortcuts.js'
import { createMockProvider, erc20Interface, fakeToken } from './mockProvider.js'

const TOKEN_A = '0x1000000000000000000000000000000000000001'
const TOKEN_B = '0x2000000000000000000000000000000000000002'
const NO_CODE = '0x3000000000000000000000000000000000000003'
const SUPPLY = 21_000_000_000_000n // 21,000,000 × 10^6

function setup() {
  const supplyToken = fakeToken('BBB', 6)
  const mock = createMockProvider({
    contracts: {
      [TOKEN_A]: fakeToken('AAA', 18),
      // fakeToken 不支持 totalSupply / name，这里补上
      [TOKEN_B]: (data, ctx) => {
        if (data.startsWith('0x18160ddd')) return { success: true, returnData: '0x' + SUPPLY.toString(16).padStart(64, '0') }
        if (data.startsWith('0x06fdde03')) return { success: true, returnData: erc20NameResult('Bee Token') }
        return supplyToken(data, ctx)
      },
    },
    multicallAddresses: [MULTICALL3_ADDRESS],
  })
  return { mock, multi: new Provider(56, mock) }
}

function erc20NameResult(name: string): string {
  return erc20Interface.getAbiCoder().encode(['string'], [name])
}

function subCalls(mock: ReturnType<typeof createMockProvider>, index: number): number {
  const parsed = multicall3Interface.parseTransaction({ data: String(mock.calls[index]?.data) })
  return (parsed?.args[0] as unknown[]).length
}

beforeEach(() => {
  clearChainIdCache()
  resetMulticallCache()
  resetDecimalsCache()
  resetBalancesProviderCache()
})

describe('Provider.tokens', () => {
  it('默认返回 name / symbol / decimals，一次请求', async () => {
    const { mock, multi } = setup()
    const [b] = await multi.tokens([TOKEN_B])
    expect(b).toEqual({ address: TOKEN_B, native: false, name: 'Bee Token', symbol: 'BBB', decimals: 6, success: true })
    expect(mock.calls).toHaveLength(1)
    expectTypeOf(b!.symbol).toEqualTypeOf<string | null>()
  })

  it('fields 选择字段，结果只包含所选字段，类型随之收窄', async () => {
    const { mock, multi } = setup()
    const [b] = await multi.tokens([TOKEN_B], { fields: ['symbol', 'totalSupply'] })
    expect(b).toEqual({
      address: TOKEN_B,
      native: false,
      symbol: 'BBB',
      totalSupply: SUPPLY.toString(),
      totalSupplyFormatted: '21000000',
      success: true,
    })
    // totalSupplyFormatted 需要 decimals：symbol + totalSupply + decimals 三个子调用
    expect(subCalls(mock, 0)).toBe(3)
    expectTypeOf(b!).toHaveProperty('totalSupplyFormatted')
    // @ts-expect-error 没请求 name，结果类型里没有这个字段
    void b!.name
  })

  it('name / symbol / decimals 缓存（与 balances 共用），totalSupply 每次都查', async () => {
    const { mock, multi } = setup()
    await multi.tokens([TOKEN_B], { fields: ['name', 'symbol', 'decimals', 'totalSupply'] })
    expect(subCalls(mock, 0)).toBe(4)
    await multi.tokens([TOKEN_B], { fields: ['name', 'symbol', 'decimals', 'totalSupply'] })
    expect(subCalls(mock, 1)).toBe(1) // 只剩 totalSupply
    await multi.tokens([TOKEN_B]) // 全部命中缓存，不发请求
    expect(mock.calls).toHaveLength(2)
    // balances 用上 tokens 缓存的 decimals
    await multi.balances('0x4000000000000000000000000000000000000004', [TOKEN_B])
    expect(subCalls(mock, 2)).toBe(1)
  })

  it('主币：信息取内置链信息表，不发请求；totalSupply 为 null 且不算失败', async () => {
    const { mock, multi } = setup()
    const [native] = await multi.tokens([NATIVE_TOKEN], { fields: ['name', 'symbol', 'decimals', 'totalSupply'] })
    expect(native).toEqual({
      address: NATIVE_TOKEN,
      native: true,
      name: 'BNB Chain Native Token',
      symbol: 'BNB',
      decimals: 18,
      totalSupply: null,
      totalSupplyFormatted: null,
      success: true,
    })
    expect(mock.calls).toHaveLength(0)
  })

  it('主币信息可用 nativeName / nativeSymbol / nativeDecimals 覆盖', async () => {
    const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS] })
    const multi = new Provider(999_999, mock, { nativeName: 'Foo Coin', nativeSymbol: 'FOO', nativeDecimals: 8 })
    expect((await multi.tokens([NATIVE_TOKEN]))[0]).toMatchObject({ name: 'Foo Coin', symbol: 'FOO', decimals: 8, success: true })
  })

  it('非代币地址：字段为 null，success 为 false；不影响其他代币', async () => {
    // TOKEN_A 的模拟合约没有 name()：只请求它支持的字段
    const { multi } = setup()
    const res = await multi.tokens([NO_CODE, TOKEN_A, 'bad-address'], { fields: ['symbol', 'decimals'] })
    expect(res[0]).toEqual({ address: NO_CODE, native: false, symbol: null, decimals: null, success: false })
    expect(res[1]).toMatchObject({ symbol: 'AAA', decimals: 18, success: true })
    expect(res[2]?.success).toBe(false)
  })

  it('部分字段读取失败：该字段为 null，success 为 false', async () => {
    const { multi } = setup()
    const [a] = await multi.tokens([TOKEN_A]) // 没有 name()
    expect(a).toMatchObject({ name: null, symbol: 'AAA', decimals: 18, success: false })
  })
})

describe('getTokens', () => {
  it('节点参数与 getBalances 相同，fields 透传', async () => {
    const { mock } = setup()
    const res = await getTokens([TOKEN_B, NATIVE_TOKEN], { chainId: 56, provider: mock, fields: ['symbol', 'decimals'] })
    expect(res).toEqual([
      { address: TOKEN_B, native: false, symbol: 'BBB', decimals: 6, success: true },
      { address: NATIVE_TOKEN, native: true, symbol: 'BNB', decimals: 18, success: true },
    ])
  })

  it('只传节点（钱包）时自动识别 chainId', async () => {
    const { mock } = setup()
    const wallet = {
      async request({ method, params }: { method: string; params?: any[] }) {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_call') return mock.call({ ...(params as any[])[0], blockTag: (params as any[])[1] })
        throw new Error(method)
      },
    }
    const res = await getTokens([NATIVE_TOKEN, TOKEN_A], { provider: wallet, fields: ['symbol'] })
    expect(res.map((r) => r.symbol)).toEqual(['ETH', 'AAA'])
  })

  it('既没有 chainId 也没有节点时报错', () => {
    expect(() => getTokens([TOKEN_A])).toThrow(/chainId or provider/)
  })
})
