/** Flap 分红：用假链核对读取（余额 / 可领取 / 已领取 / 分红资产 / WBNB 解包）、unsupported 判定、领取交易的编码（不连网络） */
import { Interface } from 'ethers'
import { describe, expect, it, vi } from 'vitest'

import { Provider } from '../src/index.js'
import { MULTICALL3_ADDRESS } from '../src/multicall.js'
import { FLAP_TOKEN_SUFFIXES, buildClaimDividends, claimDividends, dividends, getDividends } from '../src/subpaths/dividends.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const simulateMock = vi.fn(async () => ({ success: true }))
vi.mock('../src/simulate.js', () => ({ simulate: (...args: unknown[]) => (simulateMock as (...a: unknown[]) => unknown)(...args) }))
vi.mock('../src/write/batch.js', () => ({
  batchCall: vi.fn(async (_p: unknown, txs: unknown[]) => txs.map((_, index) => ({ index, status: 'confirmed', hash: '0x1', error: null }))),
}))

const USER = '0x1111111111111111111111111111111111111111'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const REWARD = '0x9b8E987e6fEc8Cf1380C4dcA7071e2C7853AEEA1'
const TOKEN_WBNB = '0x78dE1541Dc85b0c89035ed8Bb3F0e25685A87777'
const TOKEN_REWARD = '0xB169215e59E11C84aa794B124f5345d58b447777'
const TOKEN_PLAIN = '0xA3D6d277147d88c2a51A9c28123a185BF48B8888' // 没有 dividendContract()
const TOKEN_ODD = '0x5F2dBFb5CC6524d767dDA117E8704E21bfB77777' // Dividend 合约缺函数
const DIV_WBNB = '0xB69d39f27497B09B542A2405F531e86A563E18c9'
const DIV_REWARD = '0xF71dF1586Dda70d8713db76e4679C6399A4B7C1f'
const DIV_ODD = '0x0000000000000000000000000000000000000d0d'

const tokenIface = new Interface(['function dividendContract() view returns (address)', 'function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)'])
const divIface = new Interface([
  'function dividendToken() view returns (address)',
  'function weth() view returns (address)',
  'function minimumShareBalance() view returns (uint256)',
  'function withdrawableDividends(address) view returns (uint256)',
  'function withdrawnDividends(address) view returns (uint256)',
])

const answer = (iface: Interface, values: Record<string, unknown[]>) => (data: string) => {
  const tx = iface.parseTransaction({ data })
  const out = tx && values[tx.name]
  return out ? { success: true, returnData: iface.encodeFunctionResult(tx.name, out) } : { success: false, returnData: '0x' }
}

function setupContracts() {
  const taxToken = (div: string, balance: bigint) => answer(tokenIface, { dividendContract: [div], balanceOf: [balance], symbol: ['TAX'], decimals: [18] })
  return {
      [TOKEN_WBNB]: taxToken(DIV_WBNB, 0n), // 卖光了，但累计的分红还能领
      [TOKEN_REWARD]: taxToken(DIV_REWARD, 50_000n * 10n ** 18n),
      [TOKEN_ODD]: taxToken(DIV_ODD, 1n),
      [TOKEN_PLAIN]: fakeToken('USDT', 18),
      [DIV_WBNB]: answer(divIface, { dividendToken: [WBNB], weth: [WBNB], minimumShareBalance: [10_000n * 10n ** 18n], withdrawableDividends: [194002826213118n], withdrawnDividends: [5n] }),
      [DIV_REWARD]: answer(divIface, { dividendToken: [REWARD], weth: [WBNB], minimumShareBalance: [10_000n * 10n ** 18n], withdrawableDividends: [0n], withdrawnDividends: [88823258714382840n] }),
      [DIV_ODD]: () => ({ success: false, returnData: '0x' }),
      [REWARD]: fakeToken('FXIon', 18),
  }
}

function setup() {
  return new Provider(56, createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], contracts: setupContracts() }))
}

describe('discover', () => {
  it('扫描收到过的 Transfer：只收 7777 / 8888 后缀的 ERC20，再核对分红合约；没有分红的发现项不报告', async () => {
    const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], blockNumber: 5000, contracts: setupContracts() })
    const filters: unknown[] = []
    const topic = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`
    const logs = [
      { address: TOKEN_WBNB, topics: ['0xddf2', topic(DIV_WBNB), topic(USER)] },
      { address: TOKEN_PLAIN, topics: ['0xddf2', topic(DIV_WBNB), topic(USER)] }, // 8888 后缀，没有分红合约
      { address: REWARD, topics: ['0xddf2', topic(DIV_WBNB), topic(USER)] }, // 后缀不对
      { address: TOKEN_WBNB, topics: ['0xddf2', topic(DIV_WBNB), topic(USER), topic(DIV_WBNB)] }, // ERC721
    ]
    const provider = new Provider(56, Object.assign(mock, { getBlockNumber: async () => 5000, getLogs: async (f: unknown) => (filters.push(f), logs) }) as never)
    const r = await dividends(provider, USER, { discover: { lookbackBlocks: 1000, blockRange: 1000 }, prices: false })
    expect(r.scan?.tokens).toEqual([TOKEN_WBNB, TOKEN_PLAIN])
    expect(r.items.map((i) => i.token)).toEqual([TOKEN_WBNB])
    expect(r.unsupported).toEqual([])
    expect(filters[0]).toMatchObject({ topics: [expect.stringMatching(/^0xddf252ad/), null, topic(USER)] })
  })
})

describe('dividends', () => {
  it('读取：WBNB 分红按 BNB 领取、卖光的代币仍有可领取、没有可领取的默认不返回', async () => {
    const { items, unsupported } = await dividends(setup(), USER, { tokens: [TOKEN_WBNB, TOKEN_REWARD, TOKEN_PLAIN, TOKEN_ODD], prices: false })
    expect(items.map((i) => i.token)).toEqual([TOKEN_WBNB])
    expect(items[0]).toMatchObject({
      owner: USER,
      symbol: 'TAX',
      balance: '0',
      dividendContract: DIV_WBNB,
      dividendToken: WBNB,
      asset: 'native',
      assetSymbol: 'BNB',
      claimable: '194002826213118',
      claimed: '5',
      usd: null,
      accruing: false,
      adapter: 'flap',
    })
    expect(items[0]?.claimableFormatted).toBe('0.000194002826213118')
    expect(unsupported.map((u) => u.token).sort()).toEqual([TOKEN_ODD, TOKEN_PLAIN].sort())
  })

  it('includeZero 返回没有可领取的代币，分红代币是普通 ERC20 时给出它的 symbol', async () => {
    const { items } = await dividends(setup(), USER, { tokens: [TOKEN_REWARD], includeZero: true, prices: false })
    expect(items[0]).toMatchObject({ asset: REWARD, assetSymbol: 'FXIon', claimable: '0', claimed: '88823258714382840', accruing: true })
  })

  it('快捷函数：不是 BSC 或没有代币时的行为', async () => {
    await expect(getDividends(USER, { chainId: 1, tokens: [TOKEN_WBNB] })).rejects.toThrow(/BNB Chain/)
    expect((await dividends(setup(), USER, { prices: false })).items).toEqual([])
    expect(FLAP_TOKEN_SUFFIXES).toContain('7777')
  })

  it('buildClaimDividends：每个有可领取的代币一笔 withdrawDividendsFor(owner) 发给 Dividend 合约，没有可领取的跳过', async () => {
    const { items } = await dividends(setup(), USER, { tokens: [TOKEN_WBNB, TOKEN_REWARD], includeZero: true, prices: false })
    const txs = buildClaimDividends(items)
    expect(txs).toHaveLength(1)
    expect(txs[0]?.to).toBe(DIV_WBNB)
    expect(txs[0]?.value).toBe('0')
    const iface = new Interface(['function withdrawDividendsFor(address user)'])
    expect(iface.decodeFunctionData('withdrawDividendsFor', txs[0]?.data as string)[0]).toBe(USER)
  })

  it('buildClaimDividends：校验地址', async () => {
    const { items } = await dividends(setup(), USER, { tokens: [TOKEN_WBNB], prices: false })
    expect(() => buildClaimDividends([{ ...items[0]!, dividendContract: '0x123' }])).toThrow(/Invalid/)
    expect(() => buildClaimDividends([{ ...items[0]!, owner: 'nope' }])).toThrow(/Invalid/)
  })

  it('claimDividends：dividendContract 与代币链上的不一致的项跳过；默认先模拟，会 revert 的不发', async () => {
    const provider = setup()
    const { items } = await dividends(provider, USER, { tokens: [TOKEN_WBNB], prices: false })
    const forged = { ...(items[0] as never as Record<string, unknown>), dividendContract: DIV_REWARD }
    const key = '0x' + '11'.repeat(32)
    const [bad] = await claimDividends(provider, key, [forged as never])
    expect(bad).toMatchObject({ status: 'skipped' })
    expect(bad?.error).toMatch(/dividendContract mismatch/)
    simulateMock.mockClear()
    const [ok] = await claimDividends(provider, key, items)
    expect(simulateMock).toHaveBeenCalledTimes(1)
    expect(ok?.status).toBe('confirmed')
    simulateMock.mockResolvedValueOnce({ success: false, error: 'reverted' } as never)
    const [rev] = await claimDividends(provider, key, items)
    expect(rev).toMatchObject({ status: 'skipped', error: 'reverted' })
  })

  it('分红资产的 decimals 读不到：标 decimalsUnknown', async () => {
    const contracts = setupContracts()
    contracts[REWARD] = answer(new Interface(['function symbol() view returns (string)']), { symbol: ['FXIon'] })
    const p = new Provider(56, createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], contracts }))
    const { items } = await dividends(p, USER, { tokens: [TOKEN_REWARD], includeZero: true, prices: false })
    expect(items[0]).toMatchObject({ asset: REWARD, decimalsUnknown: true, usd: null })
  })
})
