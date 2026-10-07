import { beforeEach, describe, expect, it } from 'vitest'

import { MULTICALL3_ADDRESS, NATIVE_TOKEN, Provider, TRON_CHAIN_ID, formatAmount, getBalances } from '../src/index.js'
import { multicall3Interface, resetMulticallCache } from '../src/aggregate.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const TOKEN_A = '0x1000000000000000000000000000000000000001' // 18 位
const TOKEN_B = '0x2000000000000000000000000000000000000002' // 6 位
const NO_CODE = '0x3000000000000000000000000000000000000003'
const USER = '0x4000000000000000000000000000000000000004'
const ZERO = '0x0000000000000000000000000000000000000000'

function setup() {
  const mock = createMockProvider({
    contracts: {
      [TOKEN_A]: fakeToken('AAA', 18, { [USER]: 1_234_500_000_000_000_000_000n }),
      [TOKEN_B]: fakeToken('BBB', 6, { [USER]: 5_000_000n }),
    },
    multicallAddresses: [MULTICALL3_ADDRESS],
    balances: { [USER]: 1_500_000_000_000_000_000n },
  })
  return { mock, multi: new Provider(56, mock) }
}

/** 某次 eth_call 里打包的子调用数 */
function subCalls(mock: ReturnType<typeof createMockProvider>, index: number): number {
  const parsed = multicall3Interface.parseTransaction({ data: String(mock.calls[index]?.data) })
  return (parsed?.args[0] as unknown[]).length
}

beforeEach(() => {
  resetMulticallCache()
  resetDecimalsCache()
})

describe('formatAmount', () => {
  it('按精度换算，去掉多余的 0，整数不带小数点', () => {
    expect(formatAmount(1_234_500_000n, 6)).toBe('1234.5')
    expect(formatAmount(10n ** 18n, 18)).toBe('1')
    expect(formatAmount(1n, 18)).toBe('0.000000000000000001')
    expect(formatAmount(0n, 18)).toBe('0')
    expect(formatAmount(123n, 0)).toBe('123')
    expect(formatAmount(-1_500_000n, 6)).toBe('-1.5')
  })
})

describe('Provider.balances', () => {
  it('主币 + 代币一次请求，返回原始余额、decimals 和换算后的数值', async () => {
    const { mock, multi } = setup()
    const res = await multi.balances(USER, [NATIVE_TOKEN, TOKEN_A, TOKEN_B])
    expect(res).toEqual([
      { token: NATIVE_TOKEN, native: true, balance: '1500000000000000000', decimals: 18, formatted: '1.5', success: true },
      { token: TOKEN_A, native: false, balance: '1234500000000000000000', decimals: 18, formatted: '1234.5', success: true },
      { token: TOKEN_B, native: false, balance: '5000000', decimals: 6, formatted: '5', success: true },
    ])
    expect(mock.calls).toHaveLength(1)
    // 可以直接序列化
    expect(JSON.parse(JSON.stringify(res))).toEqual(res)
  })

  it('0xeeee…eeee（不区分大小写）和零地址都按主币处理', async () => {
    const { multi } = setup()
    const res = await multi.balances(USER, [NATIVE_TOKEN.toLowerCase(), ZERO])
    expect(res.map((r) => [r.native, r.formatted])).toEqual([
      [true, '1.5'],
      [true, '1.5'],
    ])
  })

  it('decimals 查过一次后缓存，之后只查 balanceOf', async () => {
    const { mock, multi } = setup()
    await multi.balances(USER, [TOKEN_A, TOKEN_B])
    expect(subCalls(mock, 0)).toBe(4) // 2 × (balanceOf + decimals)
    const res = await multi.balances(USER, [TOKEN_A, TOKEN_B])
    expect(subCalls(mock, 1)).toBe(2) // 只剩 balanceOf
    expect(res.map((r) => r.formatted)).toEqual(['1234.5', '5'])
    // 缓存按链共享，新建 Provider 也能用上
    const other = new Provider(56, mock)
    await other.balances(USER, [TOKEN_A])
    expect(subCalls(mock, 2)).toBe(1)
  })

  it('可以直接传已知 decimals，跳过查询', async () => {
    const { mock, multi } = setup()
    const res = await multi.balances(USER, [{ address: TOKEN_B, decimals: 6 }])
    expect(res[0]?.formatted).toBe('5')
    expect(subCalls(mock, 0)).toBe(1)
  })

  it('单个代币失败不影响其他，该项 success 为 false', async () => {
    const { multi } = setup()
    const res = await multi.balances(USER, [TOKEN_A, NO_CODE, 'bad-address', NATIVE_TOKEN])
    expect(res.map((r) => r.success)).toEqual([true, false, false, true])
    expect(res[1]).toMatchObject({ token: NO_CODE, balance: '0', formatted: '0', success: false })
  })

  it('失败的 decimals 不缓存', async () => {
    const { mock, multi } = setup()
    await multi.balances(USER, [NO_CODE])
    await multi.balances(USER, [NO_CODE])
    expect(subCalls(mock, 1)).toBe(2)
  })

  it('Tron 主币默认 6 位精度，可通过 nativeDecimals 覆盖', async () => {
    const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], balances: { [USER]: 2_500_000n } })
    const tron = new Provider(TRON_CHAIN_ID.mainnet, mock, { multicall: { address: MULTICALL3_ADDRESS } })
    expect((await tron.balances(USER, [NATIVE_TOKEN]))[0]?.formatted).toBe('2.5')
    const custom = new Provider(56, mock, { nativeDecimals: 6 })
    expect((await custom.balances(USER, [NATIVE_TOKEN]))[0]?.formatted).toBe('2.5')
  })

  it('自定义主币地址', async () => {
    const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], balances: { [USER]: 7n } })
    const multi = new Provider(56, mock, { nativeTokens: ['0x0000000000000000000000000000000000001010'] })
    const [res] = await multi.balances(USER, ['0x0000000000000000000000000000000000001010'])
    expect(res).toMatchObject({ native: true, balance: '7' })
  })
})

describe('getBalances', () => {
  it('传 rpc 时用指定节点', async () => {
    const { mock } = setup()
    const res = await getBalances(56, USER, [NATIVE_TOKEN, TOKEN_B], { rpc: mock })
    expect(res.map((r) => r.formatted)).toEqual(['1.5', '5'])
    expect(mock.calls).toHaveLength(1)
  })

  it('blockTag 透传', async () => {
    const { mock } = setup()
    await getBalances(56, USER, [TOKEN_B], { rpc: mock, blockTag: 'pending' })
    expect(mock.calls[0]?.blockTag).toBe('pending')
  })
})
