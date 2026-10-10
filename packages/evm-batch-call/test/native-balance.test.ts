import { beforeEach, describe, expect, it } from 'vitest'

import { MULTICALL3_ADDRESS, NATIVE_TOKEN, Provider, getNativeBalanceMode } from '../src/index.js'
import { resetMulticallCache } from '../src/aggregate.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const TOKEN_A = '0x1000000000000000000000000000000000000001'
const NATIVE_ERC20 = '0x5000000000000000000000000000000000000005'
const USER = '0x4000000000000000000000000000000000000004'

function setup(multicall = true) {
  const mock = createMockProvider({
    contracts: {
      [TOKEN_A]: fakeToken('AAA', 18, { [USER]: 7n }),
      [NATIVE_ERC20]: fakeToken('NAT', 18, { [USER]: 3_000_000_000_000_000_000n }),
    },
    multicallAddresses: multicall ? [MULTICALL3_ADDRESS] : [],
    balances: { [USER]: 3_000_000_000_000_000_000n },
    zeroNativeInContract: true,
  })
  return mock
}

beforeEach(() => {
  resetMulticallCache()
  resetDecimalsCache()
})

describe('nativeBalance：合约里读主币余额不可靠的链', () => {
  it("默认 'contract' 在这类链上会读成 0（问题本身）", async () => {
    const multi = new Provider(56, setup())
    expect((await multi.balances(USER, [NATIVE_TOKEN]))[0]).toMatchObject({ balance: '0', success: true })
  })

  it("'rpc'：主币走 eth_getBalance，代币仍在一次 eth_call 里", async () => {
    for (const multicall of [true, false]) {
      const mock = setup(multicall)
      const multi = new Provider(56, mock, { nativeBalance: 'rpc', deployless: !multicall })
      const res = await multi.balances(USER, [NATIVE_TOKEN, TOKEN_A])
      expect(res.map((r) => r.balance)).toEqual(['3000000000000000000', '7'])
      expect(mock.balanceCalls).toEqual([USER])
      expect(mock.calls).toHaveLength(1)
    }
  })

  it("{ erc20 }：主币改调 ERC20 的 balanceOf，和代币在同一次 eth_call 里", async () => {
    const mock = setup()
    const multi = new Provider(56, mock, { nativeBalance: { erc20: NATIVE_ERC20 } })
    const res = await multi.balances(USER, [NATIVE_TOKEN, TOKEN_A])
    expect(res.map((r) => [r.balance, r.native])).toEqual([
      ['3000000000000000000', true],
      ['7', false],
    ])
    expect(mock.balanceCalls).toEqual([])
    expect(mock.calls).toHaveLength(1)
  })

  it('getEthBalance 的其他用法（await、all、staticCall）同样生效', async () => {
    const rpc = new Provider(56, setup(), { nativeBalance: 'rpc' })
    expect(await rpc.getEthBalance(USER)).toBe(3_000_000_000_000_000_000n)
    expect(await rpc.all([rpc.getEthBalance(USER), rpc.erc20(TOKEN_A).balanceOf(USER)])).toEqual([3_000_000_000_000_000_000n, 7n])
    const erc20 = new Provider(56, setup(), { nativeBalance: { erc20: NATIVE_ERC20 } })
    expect(await erc20.staticCall(erc20.getEthBalance(USER))).toBe(3_000_000_000_000_000_000n)
  })

  it("内置表：Anubis（6714）默认 'rpc'", async () => {
    expect(getNativeBalanceMode(6714)).toBe('rpc')
    expect(getNativeBalanceMode(56)).toBe('contract')
    const mock = setup()
    const res = await new Provider(6714, mock).balances(USER, [NATIVE_TOKEN])
    expect(res[0]?.balance).toBe('3000000000000000000')
  })
})
