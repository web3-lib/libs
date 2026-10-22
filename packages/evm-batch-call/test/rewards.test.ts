import { AbiCoder, Interface, Wallet, getAddress } from 'ethers'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MULTICALL3_ADDRESS, Provider } from '../src/index.js'
import { resetMulticallCache } from '../src/aggregate.js'
import { clearChainIdCache } from '../src/detect.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { LP_PROTOCOLS } from '../src/lp.js'
import { buildClaimAll, claimAll, claimable, type ClaimItem } from '../src/subpaths/rewards.js'
import { createMockProvider } from './mockProvider.js'

// 模拟 /simulate：data 里带 tokenId 99 的交易失败，其余成功
vi.mock('../src/write/batch.js', async (orig) => ({
  ...(await orig<typeof import('../src/write/batch.js')>()),
  batchCall: vi.fn(async (_p: unknown, txs: unknown[], o: { dryRun?: boolean }) => txs.map((_, index) => ({ index, status: o.dryRun ? 'simulated' : 'confirmed' }))),
}))

const pad = (n: bigint) => n.toString(16).padStart(64, '0')
const simHook = { batchOnly: false, abort: false }
vi.mock('../src/simulate.js', () => ({
  simulate: vi.fn(async (_provider: unknown, tx: { data: string }) => {
    if (simHook.abort) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    // batchOnly：单个仓位都能过，7 和 8 合在一笔里就失败（gas / multicall 的相互影响）
    const bad = tx.data.includes(pad(99n)) || (simHook.batchOnly && tx.data.includes(pad(7n)) && tx.data.includes(pad(8n)))
    return { success: !bad, ...(bad ? { error: 'not owner' } : {}), gasUsed: '1', balanceChanges: [], approvalChanges: [], decoded: { type: 'contract', summary: '' }, warnings: [], transfers: [], mode: 'eth_call' }
  }),
}))

const USER = '0x4000000000000000000000000000000000000004'
const OTHER = '0x5000000000000000000000000000000000000005'
const TOKEN_A = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const TOKEN_B = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const CAKE = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'
const AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'
const POOL = '0x7100000000000000000000000000000000000071'
const GAUGE = '0x8100000000000000000000000000000000000081'
const MASTER_CHEF = '0x556B9306565093C855AEA9AE92A594704c2Cd59e'
const ZERO = '0x0000000000000000000000000000000000000000'
const Q128 = 2n ** 128n
const U128 = 2n ** 128n - 1n

const CAKE_V3 = LP_PROTOCOLS.find((p) => p.chainId === 56 && p.id === 'pancakeswap-v3')!
const UNI_V3 = LP_PROTOCOLS.find((p) => p.chainId === 1 && p.id === 'uniswap-v3')!
const UNI_V4 = LP_PROTOCOLS.find((p) => p.chainId === 1 && p.id === 'uniswap-v4')!

type Impl = Record<string, (...args: any[]) => unknown[] | null>
function handler(iface: Interface, impl: Impl) {
  return (data: string) => {
    const tx = iface.parseTransaction({ data })
    const fn = tx && impl[tx.name]
    const out = fn ? fn(...tx.args) : null
    return out === null || !tx ? { success: false, returnData: '0x' } : { success: true, returnData: iface.encodeFunctionResult(tx.name, out) }
  }
}

const tokenIface = new Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)'])
const npmIface = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
  'function factory() view returns (address)',
  'function positions(uint256) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)',
  'function multicall(bytes[] data)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params)',
])
const factoryIface = new Interface(['function getPool(address, address, uint24) view returns (address)'])
const poolIface = new Interface([
  'function slot0() view returns (uint160, int24, uint16, uint16, uint32, uint32, bool)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24) view returns (uint128, int128, uint256, uint256, int56, uint160, uint32, bool)',
])
const mcIface = new Interface([
  'function CAKE() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
  'function pendingCake(uint256) view returns (uint256)',
  'function harvest(uint256, address)',
  'function collectTo((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params, address to)',
  'function multicall(bytes[] data)',
])
const gaugeIface = new Interface([
  'function stakedValues(address) view returns (uint256[])',
  'function earned(address, uint256) view returns (uint256)',
  'function rewardToken() view returns (address)',
  'function getReward(uint256)',
])
const pmIface = new Interface(['function modifyLiquidities(bytes unlockData, uint256 deadline)'])

const token = (symbol: string, decimals: number) => handler(tokenIface, { symbol: () => [symbol], decimals: () => [decimals], balanceOf: () => [0n] })

/** BSC：USER 在 MasterChef 里质押了仓位 11（有手续费 + 挖矿奖励）和 12（什么都没有），自己还持有 NPM 里的仓位 21 */
function bsc() {
  const positions: Record<string, unknown[]> = {
    // tickLower, tickUpper 包含当前 tick 0；liquidity 1e6；tokensOwed 5 / 7
    '11': [0n, ZERO, TOKEN_A, TOKEN_B, 500n, -100n, 100n, 10n ** 6n, 0n, 0n, 5n, 7n],
    '12': [0n, ZERO, TOKEN_A, TOKEN_B, 500n, -100n, 100n, 0n, 0n, 0n, 0n, 0n],
    '21': [0n, ZERO, TOKEN_A, TOKEN_B, 500n, -100n, 100n, 10n ** 6n, 0n, 0n, 1n, 0n],
  }
  const mock = createMockProvider({
    contracts: {
      [TOKEN_A]: token('AAA', 6),
      [TOKEN_B]: token('BBB', 18),
      [CAKE]: token('Cake', 18),
      [MASTER_CHEF]: handler(mcIface, {
        CAKE: () => [CAKE],
        balanceOf: (u: string) => [getAddress(u) === getAddress(USER) ? 2n : 0n],
        tokenOfOwnerByIndex: (_u: string, i: bigint) => [i === 0n ? 11n : 12n],
        pendingCake: (id: bigint) => [id === 11n ? 3n * 10n ** 18n : 0n],
      }),
      [CAKE_V3.positionManager as string]: handler(npmIface, {
        balanceOf: (u: string) => [getAddress(u) === getAddress(USER) ? 1n : 0n],
        tokenOfOwnerByIndex: () => [21n],
        factory: () => [CAKE_V3.factory],
        positions: (id: bigint) => positions[String(id)] ?? null,
      }),
      [CAKE_V3.factory as string]: handler(factoryIface, { getPool: () => [POOL] }),
      [POOL]: handler(poolIface, {
        slot0: () => [2n ** 96n, 0n, 0n, 0n, 0n, 0n, true],
        feeGrowthGlobal0X128: () => [2n * Q128],
        feeGrowthGlobal1X128: () => [0n],
        ticks: () => [0n, 0n, 0n, 0n, 0n, 0n, 0n, true],
      }),
    },
    multicallAddresses: [MULTICALL3_ADDRESS],
  })
  return new Provider(56, mock)
}

beforeEach(() => {
  simHook.batchOnly = false
  simHook.abort = false
  clearChainIdCache()
  resetMulticallCache()
  resetDecimalsCache()
})

const fee = (id: string, over: Partial<ClaimItem> = {}): ClaimItem => ({
  id: `fees:uniswap-v3:${id}`,
  kind: 'fees',
  protocol: 'uniswap-v3',
  protocolName: 'Uniswap V3',
  version: 'v3',
  tokenId: id,
  pool: POOL,
  staked: false,
  target: UNI_V3.positionManager as string,
  amounts: [
    { token: { address: TOKEN_A, native: false, symbol: 'AAA', decimals: 6 }, amount: '1000000', formatted: '1' },
    { token: { address: TOKEN_B, native: false, symbol: 'BBB', decimals: 18 }, amount: '0', formatted: '0' },
  ],
  ...over,
})

describe('claimable：读取', () => {
  it('MasterChef：挖矿奖励 + 质押仓位的手续费 + 自己持有仓位的手续费', async () => {
    const c = await claimable(bsc(), USER)
    expect(c.errors).toEqual([])
    const byId = Object.fromEntries(c.items.map((i) => [i.id, i]))
    expect(Object.keys(byId).sort()).toEqual(['farm:pancakeswap-v3:11', 'fees:pancakeswap-v3:11', 'fees:pancakeswap-v3:21'])
    expect(byId['farm:pancakeswap-v3:11']).toMatchObject({ kind: 'farm', staked: true, target: MASTER_CHEF })
    expect(byId['farm:pancakeswap-v3:11']?.amounts[0]).toMatchObject({ amount: String(3n * 10n ** 18n), formatted: '3', token: { symbol: 'Cake' } })
    // 模拟里 harvest 预执行失败，退回 pendingCake：标成估计值
    expect(byId['farm:pancakeswap-v3:11']?.approximate).toBe(true)
    // fees0 = 1e6 × 2 + tokensOwed0（5）；fees1 = tokensOwed1（7）
    expect(byId['fees:pancakeswap-v3:11']).toMatchObject({ staked: true, target: MASTER_CHEF, version: 'v3' })
    expect(byId['fees:pancakeswap-v3:11']?.amounts.map((a) => a.amount)).toEqual(['2000005', '7'])
    expect(byId['fees:pancakeswap-v3:21']).toMatchObject({ staked: false, target: CAKE_V3.positionManager })
    expect(byId['fees:pancakeswap-v3:21']?.amounts.map((a) => a.amount)).toEqual(['2000001', '0'])
    // 汇总：AAA 两处、BBB 一处、CAKE 一处
    expect(c.totals.map((t) => [t.token.symbol, t.amount]).sort()).toEqual([['AAA', '4000006'], ['BBB', '7'], ['Cake', String(3n * 10n ** 18n)]])
  })

  it('fees / rewards / protocols 过滤；未知协议报错；V2 id 不查', async () => {
    const p = bsc()
    expect((await claimable(p, USER, { fees: false })).items.map((i) => i.kind)).toEqual(['farm'])
    expect((await claimable(p, USER, { rewards: false })).items.every((i) => i.kind === 'fees')).toBe(true)
    expect((await claimable(p, USER, { protocols: ['pancakeswap-v3'] })).items).toHaveLength(3)
    expect((await claimable(p, USER, { protocols: ['uniswap-v3'] })).items).toHaveLength(0) // 链上没有这个协议的仓位
    expect((await claimable(p, USER, { protocols: ['pancakeswap-v2'] })).items).toEqual([])
    await expect(claimable(p, USER, { protocols: ['nope'] })).rejects.toThrow(/Unknown protocol nope/)
  })

  it('某个来源出错只记进 errors', async () => {
    const mock = createMockProvider({ contracts: { [MASTER_CHEF]: () => ({ success: false, returnData: '0x' }) }, multicallAddresses: [MULTICALL3_ADDRESS] })
    const c = await claimable(new Provider(56, mock), USER)
    expect(c.items).toEqual([])
    expect(c.errors.map((e) => e.source)).toEqual(['pancakeswap-v3'])
  })

  it('美元价值：价格源给的价格 × 数量，没有价格的为 null，按价值排序', async () => {
    const source = { name: 'fake', prices: async () => new Map([[CAKE.toLowerCase(), 2]]) }
    const c = await claimable(bsc(), USER, { prices: [source as never] })
    const farm = c.items.find((i) => i.kind === 'farm')
    expect(farm?.usd).toBe(6) // 3 CAKE × 2
    expect(c.items[0]?.id).toBe('farm:pancakeswap-v3:11')
    expect(c.items.find((i) => i.kind === 'fees')?.usd).toBeNull()
    expect(c.usd).toBe(6)
  })

  it('gauge：指定 gauge 地址，读质押的仓位和待领取的奖励', async () => {
    const mock = createMockProvider({
      contracts: {
        [AERO]: token('AERO', 18),
        [GAUGE]: handler(gaugeIface, {
          stakedValues: (u: string) => [getAddress(u) === getAddress(USER) ? [5n, 6n] : []],
          earned: (_u: string, id: bigint) => [id === 5n ? 10n ** 18n : 0n],
          rewardToken: () => [AERO],
        }),
      },
      multicallAddresses: [MULTICALL3_ADDRESS],
    })
    const c = await claimable(new Provider(8453, mock), USER, { gauges: [GAUGE], protocols: ['aerodrome-slipstream'] })
    expect(c.errors).toEqual([])
    expect(c.items).toHaveLength(1)
    expect(c.items[0]).toMatchObject({ id: 'gauge:aerodrome-slipstream:5', kind: 'gauge', target: GAUGE, staked: true })
    expect(c.items[0]?.amounts[0]).toMatchObject({ amount: String(10n ** 18n), token: { symbol: 'AERO' } })
  })
})

describe('gauge 缓存', () => {
  it('第一个调用方取消不影响同时等着同一个 Voter 枚举的其他调用方', async () => {
    const VOTER = '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5'
    const voterIface = new Interface(['function length() view returns (uint256)', 'function pools(uint256) view returns (address)', 'function gauges(address) view returns (address)'])
    const mock = createMockProvider({
      contracts: {
        [VOTER]: handler(voterIface, { length: () => [1n], pools: () => [POOL], gauges: () => [GAUGE] }),
        [AERO]: token('AERO', 18),
        [GAUGE]: handler(gaugeIface, { stakedValues: () => [[5n]], earned: () => [10n ** 18n], rewardToken: () => [AERO] }),
      },
      multicallAddresses: [MULTICALL3_ADDRESS],
    })
    const p = new Provider(8453, mock)
    const ac = new AbortController()
    const first = claimable(p, USER, { protocols: ['aerodrome-slipstream'], signal: ac.signal })
    const second = claimable(p, USER, { protocols: ['aerodrome-slipstream'] })
    ac.abort()
    await expect(first).rejects.toBeDefined()
    const c = await second
    expect(c.errors).toEqual([])
    expect(c.items.map((i) => i.id)).toEqual(['gauge:aerodrome-slipstream:5'])
  })
})

describe('claimAll：dryRun', () => {
  it('只预估：claimed 为空、failed 为空、status simulated，项在 simulated 里', async () => {
    const key = Wallet.createRandom().privateKey
    const items = [fee('1'), fee('2')]
    const r = await claimAll(new Provider(1, createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS] })), key, { items, simulate: false, dryRun: true })
    expect(r.status).toBe('simulated')
    expect(r.claimed).toEqual([])
    expect(r.failed).toEqual([])
    expect(r.simulated?.map((i) => i.tokenId)).toEqual(['1', '2'])
  })
})

describe('buildClaimAll：合并交易', () => {
  const provider = (chainId: number) => new Provider(chainId, createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS] }))

  it('V3：同一个仓位合约的多个仓位合成一笔 multicall，一个时直接 collect；batchSize 拆分', async () => {
    const items = [fee('1'), fee('2'), fee('3')]
    const plan = await buildClaimAll(provider(1), USER, { items, simulate: false, recipient: OTHER })
    expect(plan.transactions).toHaveLength(1)
    const [tx] = plan.transactions
    expect(tx).toMatchObject({ kind: 'fees', to: UNI_V3.positionManager, value: '0', itemIds: items.map((i) => i.id) })
    const multi = npmIface.parseTransaction({ data: tx?.data as string })
    expect(multi?.name).toBe('multicall')
    const calls = (multi?.args[0] as string[]).map((d) => npmIface.parseTransaction({ data: d })!)
    expect(calls.map((c) => c.name)).toEqual(['collect', 'collect', 'collect'])
    expect(calls.map((c) => String(c.args[0].tokenId))).toEqual(['1', '2', '3'])
    expect(calls.every((c) => c.args[0].recipient === OTHER && c.args[0].amount0Max === U128 && c.args[0].amount1Max === U128)).toBe(true)

    const split = await buildClaimAll(provider(1), USER, { items, simulate: false, batchSize: 2 })
    expect(split.transactions.map((t) => t.itemIds.length)).toEqual([2, 1])
    expect(npmIface.parseTransaction({ data: split.transactions[1]?.data as string })?.name).toBe('collect')
    expect(plan.totals.map((t) => [t.token.symbol, t.amount])).toEqual([['AAA', '3000000']])
  })

  it('V4：一次 modifyLiquidities，每个仓位 DECREASE_LIQUIDITY(0)，每个币只 TAKE 一次', async () => {
    const v4 = (id: string, c0: string, c1: string): ClaimItem =>
      fee(id, {
        id: `fees:uniswap-v4:${id}`,
        protocol: 'uniswap-v4',
        version: 'v4',
        target: UNI_V4.positionManager as string,
        amounts: [
          { token: { address: c0, native: c0 === ZERO, symbol: 'X', decimals: 18 }, amount: '5', formatted: '0' },
          { token: { address: c1, native: false, symbol: 'Y', decimals: 18 }, amount: '0', formatted: '0' },
        ],
      })
    const plan = await buildClaimAll(provider(1), USER, { items: [v4('1', ZERO, TOKEN_A), v4('2', ZERO, TOKEN_B)], simulate: false, hookData: '0xabcd' })
    expect(plan.transactions).toHaveLength(1)
    const tx = pmIface.parseTransaction({ data: plan.transactions[0]?.data as string })!
    expect(tx.name).toBe('modifyLiquidities')
    const [actions, params] = AbiCoder.defaultAbiCoder().decode(['bytes', 'bytes[]'], tx.args[0]) as unknown as [string, string[]]
    expect(actions).toBe('0x0101' + '0e0e0e')
    const coder = AbiCoder.defaultAbiCoder()
    expect(coder.decode(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'], params[0] as string).map(String)).toEqual(['1', '0', '0', '0', '0xabcd'])
    // TAKE：ZERO（主币）、TOKEN_A、TOKEN_B，各一次，收款人是 owner，数量 0 = 全部
    expect(params.slice(2).map((p) => coder.decode(['address', 'address', 'uint256'], p).map(String))).toEqual([
      [ZERO, USER, '0'],
      [TOKEN_A, USER, '0'],
      [TOKEN_B, USER, '0'],
    ])
  })

  it('MasterChef：harvest + collectTo 合成一笔 multicall；gauge 每个仓位一笔', async () => {
    const farm: ClaimItem = { ...fee('11'), id: 'farm:pancakeswap-v3:11', kind: 'farm', version: undefined, staked: true, target: MASTER_CHEF, amounts: [{ token: { address: CAKE, native: false, symbol: 'Cake', decimals: 18 }, amount: '1', formatted: '0' }] }
    const staked = fee('11', { id: 'fees:pancakeswap-v3:11', staked: true, target: MASTER_CHEF })
    const gauge = (id: string): ClaimItem => ({ ...farm, id: `gauge:aerodrome-slipstream:${id}`, kind: 'gauge', tokenId: id, target: GAUGE })
    const plan = await buildClaimAll(provider(56), USER, { items: [farm, staked, gauge('5'), gauge('6')], simulate: false })
    expect(plan.transactions.map((t) => [t.kind, t.itemIds.length])).toEqual([['farm', 2], ['gauge', 1], ['gauge', 1]])
    const multi = mcIface.parseTransaction({ data: plan.transactions[0]?.data as string })!
    const inner = (multi.args[0] as string[]).map((d) => mcIface.parseTransaction({ data: d })!)
    expect(inner.map((c) => c.name)).toEqual(['harvest', 'collectTo'])
    expect(inner[0]?.args.map(String)).toEqual(['11', USER])
    expect(inner[1]?.args[1]).toBe(USER)
    expect(plan.transactions[1]?.to).toBe(GAUGE)
    expect(gaugeIface.parseTransaction({ data: plan.transactions[2]?.data as string })?.args.map(String)).toEqual(['6'])
  })

  it('跳过：没东西可领、低于 minUsd、gauge 不能改收款地址、重复的项', async () => {
    const empty = fee('1', { amounts: [fee('1').amounts[0]!, fee('1').amounts[1]!].map((a) => ({ ...a, amount: '0' })) })
    const dust = fee('2', { usd: 0.5 })
    const unknown = fee('3') // 价值未知：不跳过
    const gauge: ClaimItem = { ...fee('4'), id: 'gauge:x:4', kind: 'gauge', target: GAUGE }
    const plan = await buildClaimAll(provider(1), USER, { items: [empty, dust, unknown, unknown, gauge], simulate: false, minUsd: 1, recipient: OTHER })
    expect(plan.items.map((i) => i.id)).toEqual([unknown.id])
    expect(plan.skipped.map((s) => [s.item.tokenId, s.reason.split(' ')[0]])).toEqual([['1', 'nothing'], ['2', 'below'], ['4', 'gauge']])
    // 一个币有价格、另一个没有价格：价值未知，不跳过
    const half = fee('5', { usd: 0.5, amounts: [{ ...fee('5').amounts[0]!, usd: 0.5 }, { ...fee('5').amounts[1]!, amount: '7', usd: null }] })
    expect((await buildClaimAll(provider(1), USER, { items: [half], simulate: false, minUsd: 1 })).items.map((i) => i.tokenId)).toEqual(['5'])
    await expect(buildClaimAll(provider(1), USER, { items: [], batchSize: 0 })).rejects.toThrow(RangeError)
  })

  it('模拟：失败的项逐个找出来、放进 skipped，其余合成的交易照常（带模拟结果）', async () => {
    const items = [fee('1'), fee('99'), fee('3')]
    const plan = await buildClaimAll(provider(1), USER, { items })
    expect(plan.skipped.map((s) => [s.item.tokenId, s.reason])).toEqual([['99', 'simulation failed: not owner']])
    expect(plan.items.map((i) => i.tokenId)).toEqual(['1', '3'])
    expect(plan.transactions).toHaveLength(1)
    expect(plan.transactions[0]?.itemIds).toEqual(['fees:uniswap-v3:1', 'fees:uniswap-v3:3'])
    expect(plan.transactions[0]?.simulation?.success).toBe(true)
    // 只有一个仓位且失败：没有交易
    const none = await buildClaimAll(provider(1), USER, { items: [fee('99')] })
    expect(none.transactions).toEqual([])
    expect(none.skipped).toHaveLength(1)
    // simulate: false 不检查
    expect((await buildClaimAll(provider(1), USER, { items, simulate: false })).skipped).toEqual([])
  })

  it('模拟：只有合并后的那一笔失败、单项都通过时拆开重新模拟，不返回模拟失败的交易', async () => {
    simHook.batchOnly = true
    const plan = await buildClaimAll(provider(1), USER, { items: [fee('7'), fee('8'), fee('9')] })
    expect(plan.skipped).toEqual([])
    expect(plan.transactions.length).toBeGreaterThan(1)
    expect(plan.transactions.every((t) => t.simulation?.success === true)).toBe(true)
    expect(plan.transactions.flatMap((t) => t.itemIds).sort()).toEqual(['fees:uniswap-v3:7', 'fees:uniswap-v3:8', 'fees:uniswap-v3:9'])
  })

  it('模拟：取消（AbortError）时抛出，不当成模拟通过', async () => {
    simHook.abort = true
    await expect(buildClaimAll(provider(1), USER, { items: [fee('1')] })).rejects.toThrow('aborted')
  })
})
