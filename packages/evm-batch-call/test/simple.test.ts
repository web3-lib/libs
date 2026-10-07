import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest'

import { CallFailedError, Contract, MULTICALL3_ADDRESS, Provider, type Call } from '../src/index.js'
import { resetMulticallCache } from '../src/aggregate.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const TOKEN_A = '0x1000000000000000000000000000000000000001'
const TOKEN_B = '0x2000000000000000000000000000000000000002'
const NO_CODE = '0x3000000000000000000000000000000000000003'
const USER = '0x4000000000000000000000000000000000000004'
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

const ABI = [
  'function symbol() view returns (string)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function boom() view returns (uint256)',
  'function deposit() payable returns (uint256 received)',
  'function whoami() view returns (address)',
]

function setup() {
  const mock = createMockProvider({
    contracts: {
      [TOKEN_A]: fakeToken('AAA', 18, { [USER]: 100n }),
      [TOKEN_B]: fakeToken('BBB', 6, { [USER]: 200n }),
    },
    multicallAddresses: [MULTICALL3_ADDRESS],
    balances: { [USER]: 42n },
  })
  return { mock, multi: new Provider(56, mock) }
}

beforeEach(() => resetMulticallCache())

describe('绑定合约', () => {
  it('直接 await，同一 tick 内的调用合并成一次请求', async () => {
    const { mock, multi } = setup()
    const a = multi.erc20(TOKEN_A)
    const b = multi.erc20(TOKEN_B)
    const [symbol, decimals, balance, native] = await Promise.all([a.symbol(), b.decimals(), a.balanceOf(USER), multi.getEthBalance(USER)])
    expect([symbol, decimals, balance, native]).toEqual(['AAA', 6n, 100n, 42n])
    expect(mock.calls).toHaveLength(1)
    expectTypeOf(symbol).toEqualTypeOf<string>()
    expectTypeOf(balance).toEqualTypeOf<bigint>()
  })

  it('单独 await 也可以', async () => {
    const { multi } = setup()
    expect(await multi.erc20(TOKEN_A).symbol()).toBe('AAA')
    expect(await multi.getEthBalance(USER)).toBe(42n)
  })

  it('绑定合约的 Call 仍可传给 all / tryAll，且不会额外发请求', async () => {
    const { mock, multi } = setup()
    const a = multi.erc20(TOKEN_A)
    const res = await multi.all([a.symbol(), a.decimals()])
    expect(res).toEqual(['AAA', 18n])
    expectTypeOf(res).toEqualTypeOf<[string, bigint]>()
    expect(mock.calls).toHaveLength(1)
  })

  it('多次 then 只发一次请求', async () => {
    const { mock, multi } = setup()
    const call = multi.erc20(TOKEN_A).symbol()
    expect(await call).toBe('AAA')
    expect(await call).toBe('AAA')
    expect(mock.calls).toHaveLength(1)
  })

  it('失败时 reject CallFailedError', async () => {
    const { multi } = setup()
    const err = await multi.contract(TOKEN_A, ABI).boom().then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(CallFailedError)
  })

  it('method.staticCall：写法同 ethers，最后一个参数是 overrides', async () => {
    const { mock, multi } = setup()
    const c = multi.contract(TOKEN_A, ABI)
    expect(await c.deposit.staticCall({ value: 3n })).toBe(3n)
    expect(await c.whoami.staticCall({ from: USER })).toBe(USER)
    // 预执行直接调目标合约，不经过 multicall
    expect(mock.calls.every((tx) => String(tx.to) === TOKEN_A)).toBe(true)
  })

  it('then 不可枚举，不影响序列化和展开', () => {
    const { multi } = setup()
    const call = multi.erc20(TOKEN_A).symbol()
    expect(Object.keys(call)).not.toContain('then')
    expect(JSON.parse(JSON.stringify(call)).name).toBe('symbol')
  })
})

describe('all / tryAll 传对象', () => {
  it('返回同名字段', async () => {
    const { mock, multi } = setup()
    const a = multi.erc20(TOKEN_A)
    const res = await multi.all({ symbol: a.symbol(), balance: a.balanceOf(USER), native: multi.getEthBalance(USER) })
    expect(res).toEqual({ symbol: 'AAA', balance: 100n, native: 42n })
    expectTypeOf(res).toEqualTypeOf<{ symbol: string; balance: bigint; native: bigint }>()
    expect(mock.calls).toHaveLength(1)
  })

  it('tryAll：失败字段为 null', async () => {
    const { multi } = setup()
    const res = await multi.tryAll({
      symbol: multi.erc20(TOKEN_A).symbol(),
      missing: multi.erc20(NO_CODE).symbol(),
      reserves: multi.contract(TOKEN_A, ABI).getReserves(),
    })
    expect(res.symbol).toBe('AAA')
    expect(res.missing).toBeNull()
    expect(res.reserves.reserve1).toBe(2n)
    expectTypeOf(res.symbol).toEqualTypeOf<string | null>()
  })
})

describe('兼容 ethcall 写法', () => {
  it('显式泛型、未绑定 Contract 照常可用', async () => {
    const { multi } = setup()
    const calls: Call[] = [new Contract(TOKEN_A, ABI).symbol(), new Contract(TOKEN_B, ABI).symbol()]
    const res = await multi.tryAll<string>(calls)
    expectTypeOf(res).toEqualTypeOf<(string | null)[]>()
    expect(res).toEqual(['AAA', 'BBB'])
    const all = await multi.all<string>(calls)
    expectTypeOf(all).toEqualTypeOf<string[]>()
  })
})

describe('快捷方法', () => {
  it('不传节点时用内置公共节点', () => {
    expect(new Provider(56).rpc).toBeTruthy()
  })
})
