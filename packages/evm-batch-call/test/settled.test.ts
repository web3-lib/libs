import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest'

import { MULTICALL3_ADDRESS, NATIVE_TOKEN, Provider, getAllowances, getBalances, type RawTokenBalance, type TokenBalance } from '../src/index.js'
import { multicall3Interface, resetMulticallCache } from '../src/aggregate.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { resetBalancesProviderCache } from '../src/shortcuts.js'
import { createMockProvider, erc20Interface, fakeToken } from './mockProvider.js'

const TOKEN_A = '0x1000000000000000000000000000000000000001'
const NFT = '0x6000000000000000000000000000000000000006' // 有 balanceOf，没有 decimals（ERC721）
const NO_CODE = '0x3000000000000000000000000000000000000003'
const USER = '0x4000000000000000000000000000000000000004'
const SPENDER = '0x5000000000000000000000000000000000000005'

function nft() {
  return (callData: string) => {
    const tx = erc20Interface.parseTransaction({ data: callData })
    return tx?.name === 'balanceOf'
      ? { success: true, returnData: erc20Interface.encodeFunctionResult('balanceOf', [128n]) }
      : { success: false, returnData: '0x' }
  }
}

function setup() {
  const mock = createMockProvider({
    contracts: { [TOKEN_A]: fakeToken('AAA', 18, { [USER]: 10n ** 18n }), [NFT]: nft() },
    multicallAddresses: [MULTICALL3_ADDRESS],
    balances: { [USER]: 2n * 10n ** 18n },
  })
  return { mock, multi: new Provider(56, mock) }
}

const subCalls = (mock: ReturnType<typeof createMockProvider>) =>
  mock.calls.map((c) => (multicall3Interface.parseTransaction({ data: String(c.data) })?.args[0] as unknown[]).length)

beforeEach(() => {
  resetMulticallCache()
  resetDecimalsCache()
  resetBalancesProviderCache()
})

describe('失败原因', () => {
  it('balances：地址非法 / 没有合约 / decimals 读不到 分别标出', async () => {
    const { multi } = setup()
    const res = await multi.balances(USER, [TOKEN_A, NO_CODE, 'bad', NFT])
    expect(res[0]).not.toHaveProperty('error')
    expect(res.slice(1).map((r) => [r.success, r.error, r.errorField])).toEqual([
      [false, 'no-contract', 'balance'],
      [false, 'invalid-address', 'balance'],
      [false, 'reverted', 'decimals'],
    ])
  })

  it('allowances：同样带失败原因', async () => {
    const { multi } = setup()
    const res = await multi.allowances(USER, SPENDER, [TOKEN_A, NO_CODE, 'bad'])
    expect(res.map((r) => [r.success, r.error, r.errorField])).toEqual([
      [true, undefined, undefined],
      [false, 'no-contract', 'allowance'],
      [false, 'invalid-address', 'allowance'],
    ])
  })
})

describe('decimals: false', () => {
  it('balances：只查余额，没有 decimals 的合约（ERC721）也能拿到余额；结果不带 decimals / formatted', async () => {
    const { mock, multi } = setup()
    const res = await multi.balances(USER, [NATIVE_TOKEN, TOKEN_A, NFT], { decimals: false })
    expectTypeOf(res).toEqualTypeOf<RawTokenBalance[]>()
    expect(res).toEqual([
      { token: NATIVE_TOKEN, native: true, balance: '2000000000000000000', success: true },
      { token: TOKEN_A, native: false, balance: '1000000000000000000', success: true },
      { token: NFT, native: false, balance: '128', success: true },
    ])
    expect(subCalls(mock)).toEqual([3]) // 每个代币只有 balanceOf
    expectTypeOf(await multi.balances(USER, [TOKEN_A])).toEqualTypeOf<TokenBalance[]>()
  })

  it('allowances / getBalances / getAllowances 透传', async () => {
    const { mock, multi } = setup()
    expect(await multi.allowances(USER, SPENDER, [TOKEN_A], { decimals: false })).toEqual([
      { token: TOKEN_A, spender: SPENDER, native: false, allowance: '123', unlimited: false, success: true },
    ])
    expect((await getBalances(USER, [NFT], { chainId: 56, provider: mock, decimals: false }))[0]).toEqual({ token: NFT, native: false, balance: '128', success: true })
    expect((await getAllowances(USER, SPENDER, [TOKEN_A], { chainId: 56, provider: mock, decimals: false }))[0]).not.toHaveProperty('decimals')
  })
})

describe('自动合并', () => {
  it('同一时刻的 balances / tokens / allowances / await 单条调用合并成一次 eth_call，相同调用去重', async () => {
    const { mock, multi } = setup()
    const [a, b, t, al, single] = await Promise.all([
      multi.balances(USER, [TOKEN_A]),
      multi.balances(USER, [TOKEN_A, NATIVE_TOKEN]),
      multi.tokens([TOKEN_A], { fields: ['symbol'] }),
      multi.allowances(USER, SPENDER, [TOKEN_A], { decimals: false }),
      multi.erc20(TOKEN_A).balanceOf(USER),
    ])
    expect(a[0]?.formatted).toBe('1')
    expect(b.map((r) => r.formatted)).toEqual(['1', '2'])
    expect(t[0]?.symbol).toBe('AAA')
    expect(al[0]?.allowance).toBe('123')
    expect(single).toBe(10n ** 18n)
    // balanceOf(USER) + decimals + getEthBalance + symbol + allowance：重复的 balanceOf / decimals 只请求一次
    expect(subCalls(mock)).toEqual([5])
  })

  it('不同 blockTag 不合并', async () => {
    const { mock, multi } = setup()
    await Promise.all([multi.balances(USER, [TOKEN_A]), multi.balances(USER, [TOKEN_A], { blockTag: 100 })])
    expect(mock.calls).toHaveLength(2)
  })

  it('一次 balances 的子调用不会被 batch.maxSize 拆开', async () => {
    const mock = setup().mock
    const multi = new Provider(56, mock, { batch: { maxSize: 2 } })
    await multi.balances(USER, [TOKEN_A, NFT, NATIVE_TOKEN], { decimals: false })
    expect(subCalls(mock)).toEqual([3])
  })

  it('节点错误照常抛出', async () => {
    const mock = setup().mock
    const broken = { ...mock, call: async () => Promise.reject(new Error('node down')) }
    await expect(new Provider(56, broken).balances(USER, [TOKEN_A])).rejects.toThrow('node down')
  })
})

describe('快捷函数复用 Provider', () => {
  it('钱包 + URL 混合列表：同一个钱包对象 + 相同 URL 复用实例；换钱包、换 URL、没传 chainId 时不复用', async () => {
    const { resolveProviderForTest } = await import('../src/shortcuts.js')
    const walletA = { request: async () => '0x38' }
    const walletB = { request: async () => '0x38' }
    const a = resolveProviderForTest({ chainId: 56, provider: [walletA, 'https://rpc-1.example'] })
    expect(resolveProviderForTest({ chainId: 56, provider: [walletA, 'https://rpc-1.example'] })).toBe(a)
    expect(resolveProviderForTest({ chainId: 56, provider: [walletB, 'https://rpc-1.example'] })).not.toBe(a)
    expect(resolveProviderForTest({ chainId: 56, provider: [walletA, 'https://rpc-2.example'] })).not.toBe(a)
    expect(resolveProviderForTest({ chainId: 1, provider: [walletA, 'https://rpc-1.example'] })).not.toBe(a)
    expect(resolveProviderForTest({ provider: [walletA, 'https://rpc-1.example'] })).not.toBe(resolveProviderForTest({ provider: [walletA, 'https://rpc-1.example'] }))
  })

  it('直接传 Provider 实例：原样使用；同时传 chainId / 配置时报错', async () => {
    const { mock, multi } = setup()
    const res = await getBalances(USER, [TOKEN_A], { provider: multi })
    expect(res[0]?.formatted).toBe('1')
    expect(mock.calls).toHaveLength(1)
    await expect(async () => getBalances(USER, [TOKEN_A], { provider: multi, chainId: 56 })).rejects.toThrow(/Provider instance/)
    await expect(async () => getBalances(USER, [TOKEN_A], { provider: multi, nativeSymbol: 'X' })).rejects.toThrow(/Provider instance/)
  })
})

describe('all / tryAll 的类型', () => {
  it('显式 all<any> / tryAll<any> 返回数组，可以按数组解构；其他写法不变', async () => {
    const { multi } = setup()
    const token = multi.erc20(TOKEN_A)
    const anyResults = await multi.all<any>([token.symbol(), token.decimals()])
    expectTypeOf(anyResults).toEqualTypeOf<any[]>()
    const [symbol, decimals] = anyResults
    expect([symbol, decimals]).toEqual(['AAA', 18n])
    expectTypeOf(await multi.tryAll<any>([token.symbol()])).toEqualTypeOf<any[]>()
    expectTypeOf(await multi.all<string>([token.symbol()])).toEqualTypeOf<string[]>()
    expectTypeOf(await multi.all([token.symbol(), token.decimals()])).toEqualTypeOf<[string, bigint]>()
    expectTypeOf(await multi.all({ s: token.symbol() })).toEqualTypeOf<{ s: string }>()
  })
})
