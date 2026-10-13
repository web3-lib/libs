import { Interface } from 'ethers'
import { beforeEach, describe, expect, it } from 'vitest'

import { MULTICALL3_ADDRESS, NATIVE_TOKEN, Provider } from '../src/index.js'
import { resetMulticallCache } from '../src/aggregate.js'
import { clearChainIdCache } from '../src/detect.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { resetBalancesProviderCache } from '../src/shortcuts.js'
import { getAmountsForLiquidity, getFeeGrowthInside, getFeesEarned, getSqrtRatioAtTick } from '../src/lpMath.js'
import {
  LP_PROTOCOLS,
  decodePositionInfo,
  getLpPositions,
  lpPositions,
  memoryLpScanStorage,
  poolIdOf,
  resolveLpProtocols,
  type LpConcentratedPosition,
  type LpProtocol,
  type LpV2Position,
  type PriceSource,
} from '../src/subpaths/lp.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const USER = '0x4000000000000000000000000000000000000004'
const OTHER = '0x5000000000000000000000000000000000000005'
const TOKEN_A = '0x1000000000000000000000000000000000000001' // 18 位
const TOKEN_B = '0x2000000000000000000000000000000000000002' // 6 位
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

const UNI_V2 = LP_PROTOCOLS.find((p) => p.chainId === 1 && p.id === 'uniswap-v2') as LpProtocol
const SUSHI_V2 = LP_PROTOCOLS.find((p) => p.chainId === 1 && p.id === 'sushiswap-v2') as LpProtocol
const UNI_V3 = LP_PROTOCOLS.find((p) => p.chainId === 1 && p.id === 'uniswap-v3') as LpProtocol
const UNI_V4 = LP_PROTOCOLS.find((p) => p.chainId === 1 && p.id === 'uniswap-v4') as LpProtocol

const PAIR_WETH_USDC = '0x6100000000000000000000000000000000000061'
const PAIR_A_WETH = '0x6200000000000000000000000000000000000062'
const PAIR_UNKNOWN = '0x6300000000000000000000000000000000000063'
const UNKNOWN_FACTORY = '0x6400000000000000000000000000000000000064'
const V3_POOL = '0x7100000000000000000000000000000000000071'

type Impl = Record<string, (...args: any[]) => unknown[] | null>
function handler(iface: Interface, impl: Impl) {
  return (data: string) => {
    const tx = iface.parseTransaction({ data })
    const fn = tx && impl[tx.name]
    const out = fn ? fn(...tx.args) : null
    return out === null || !tx ? { success: false, returnData: '0x' } : { success: true, returnData: iface.encodeFunctionResult(tx.name, out) }
  }
}

const v2Factory = new Interface(['function getPair(address, address) view returns (address)'])
const v2Pair = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function factory() view returns (address)',
  'function getReserves() view returns (uint112, uint112, uint32)',
])
const npmIface = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
  'function positions(uint256) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)',
])
const v3Factory = new Interface(['function getPool(address, address, uint24) view returns (address)'])
// 真实池子的 slot0 有 7 个返回值；这里按完整格式返回，验证只声明前两个也能解
const v3Pool = new Interface([
  'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24) view returns (uint128, int128, uint256, uint256, int56, uint160, uint32, bool)',
])
const pmIface = new Interface([
  'function ownerOf(uint256) view returns (address)',
  'function getPoolAndPositionInfo(uint256) view returns ((address, address, uint24, int24, address), uint256)',
  'function getPositionLiquidity(uint256) view returns (uint128)',
])
const svIface = new Interface([
  'function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)',
  'function getFeeGrowthInside(bytes32, int24, int24) view returns (uint256, uint256)',
  'function getPositionInfo(bytes32, address, int24, int24, bytes32) view returns (uint128, uint256, uint256)',
])

const Q128 = 2n ** 128n
const SQRT_PRICE = getSqrtRatioAtTick(100) // 当前价格 tick 100

/** V3 的三个仓位：#1 在区间内、#2 已清空（流动性 0、手续费已领）、#3 只剩未领取的手续费 */
const POSITIONS: Record<string, unknown[]> = {
  '1': [0n, OTHER, TOKEN_A, TOKEN_B, 3000n, -600n, 600n, 10n ** 18n, 5n * Q128, 7n * Q128, 11n, 13n],
  '2': [0n, OTHER, TOKEN_A, TOKEN_B, 3000n, -600n, 600n, 0n, 0n, 0n, 0n, 0n],
  '3': [0n, OTHER, TOKEN_A, TOKEN_B, 3000n, -600n, 600n, 0n, 0n, 0n, 9n, 0n],
}

function setup(extra: Record<string, ReturnType<typeof handler>> = {}, blockNumber?: number) {
  const mock = createMockProvider({
    ...(blockNumber === undefined ? {} : { blockNumber }),
    contracts: {
      [TOKEN_A]: fakeToken('AAA', 18),
      [TOKEN_B]: fakeToken('BBB', 6),
      [WETH]: fakeToken('WETH', 18),
      [USDC]: fakeToken('USDC', 6),
      // V2：WETH/USDC 在 Uniswap、A/WETH 在 SushiSwap；另一个工厂不在协议表里
      [UNI_V2.factory as string]: handler(v2Factory, {
        getPair: (a: string, b: string) => [[a, b].map((x) => x.toLowerCase()).sort().join() === [WETH, USDC].map((x) => x.toLowerCase()).sort().join() ? PAIR_WETH_USDC : '0x0000000000000000000000000000000000000000'],
      }),
      [SUSHI_V2.factory as string]: handler(v2Factory, {
        getPair: (a: string, b: string) => [[a, b].some((x) => x.toLowerCase() === TOKEN_A.toLowerCase()) && [a, b].some((x) => x.toLowerCase() === WETH.toLowerCase()) ? PAIR_A_WETH : '0x0000000000000000000000000000000000000000'],
      }),
      [PAIR_WETH_USDC]: handler(v2Pair, {
        balanceOf: (owner: string) => [owner.toLowerCase() === USER ? 10n ** 18n : 0n],
        totalSupply: () => [4n * 10n ** 18n],
        token0: () => [USDC],
        token1: () => [WETH],
        factory: () => [UNI_V2.factory],
        getReserves: () => [4000n * 10n ** 6n, 2n * 10n ** 18n, 0n],
      }),
      [PAIR_A_WETH]: handler(v2Pair, {
        balanceOf: () => [0n], // 有池子但没持有
        totalSupply: () => [1n],
        token0: () => [TOKEN_A],
        token1: () => [WETH],
        factory: () => [SUSHI_V2.factory],
        getReserves: () => [1n, 1n, 0n],
      }),
      [PAIR_UNKNOWN]: handler(v2Pair, {
        balanceOf: () => [5n],
        totalSupply: () => [10n],
        token0: () => [TOKEN_A],
        token1: () => [TOKEN_B],
        factory: () => [UNKNOWN_FACTORY],
        getReserves: () => [100n, 200n, 0n],
      }),
      // V3
      [UNI_V3.positionManager as string]: handler(npmIface, {
        balanceOf: (owner: string) => [owner.toLowerCase() === USER ? 3n : 0n],
        tokenOfOwnerByIndex: (_owner: string, index: bigint) => [index + 1n],
        positions: (id: bigint) => (POSITIONS[id.toString()] as unknown[]) ?? null,
      }),
      [UNI_V3.factory as string]: handler(v3Factory, { getPool: () => [V3_POOL] }),
      [V3_POOL]: handler(v3Pool, {
        slot0: () => [SQRT_PRICE, 100n, 0n, 0n, 0n, 0n, true],
        feeGrowthGlobal0X128: () => [100n * Q128],
        feeGrowthGlobal1X128: () => [200n * Q128],
        ticks: (tick: bigint) => (tick === -600n ? [0n, 0n, 10n * Q128, 20n * Q128, 0n, 0n, 0n, true] : [0n, 0n, 30n * Q128, 40n * Q128, 0n, 0n, 0n, true]),
      }),
      ...extra,
    },
    multicallAddresses: [MULTICALL3_ADDRESS],
  })
  return { mock, multi: new Provider(1, mock) }
}

beforeEach(() => {
  clearChainIdCache()
  resetMulticallCache()
  resetDecimalsCache()
  resetBalancesProviderCache()
})

describe('协议表', () => {
  it('按链选出协议；按 id / 版本过滤；不认识的 id 报错；可以传自己的协议', () => {
    expect(resolveLpProtocols(56).map((p) => p.id)).toContain('pancakeswap-v3')
    expect(resolveLpProtocols(1, { versions: ['v3'] }).every((p) => p.version === 'v3')).toBe(true)
    expect(resolveLpProtocols(1, { protocols: ['uniswap-v3'] }).map((p) => p.id)).toEqual(['uniswap-v3'])
    expect(() => resolveLpProtocols(1, { protocols: ['nope'] })).toThrow('Unknown LP protocol nope')
    const custom: LpProtocol = { id: 'my-v2', name: 'My V2', version: 'v2', chainId: 1, factory: UNKNOWN_FACTORY }
    expect(resolveLpProtocols(1, { protocols: [custom, { ...custom, chainId: 56 }] })).toEqual([custom])
    // 每个协议 id + 链只出现一次
    const keys = LP_PROTOCOLS.map((p) => `${p.chainId}:${p.id}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('V2', () => {
  it('计价币之间的组合在各工厂里找池子；只返回持有的；数量按份额算；协议按工厂识别', async () => {
    const { multi } = setup()
    const list = (await lpPositions(multi, USER, { versions: ['v2'] })) as LpV2Position[]
    expect(list).toHaveLength(1)
    const p = list[0] as LpV2Position
    expect(p).toMatchObject({
      version: 'v2',
      protocol: 'uniswap-v2',
      protocolName: 'Uniswap V2',
      pool: PAIR_WETH_USDC.toLowerCase(),
      token0: { symbol: 'USDC', decimals: 6, native: false },
      token1: { symbol: 'WETH', decimals: 18 },
      balance: (10n ** 18n).toString(),
      share: 0.25,
      amount0: (1000n * 10n ** 6n).toString(),
      amount0Formatted: '1000',
      amount1Formatted: '0.5',
    })
    expect('valueUsd' in p).toBe(false) // 没开启 prices 时不返回
  })

  it('显式传入的池子不限协议（不认识的工厂为 v2:<工厂>）；代币来源发现的 LP 也会核对', async () => {
    const { multi } = setup()
    const list = await lpPositions(multi, USER, {
      versions: ['v2'],
      quoteTokens: [],
      pools: [PAIR_UNKNOWN],
      source: { name: 'test', discover: async () => [{ address: PAIR_WETH_USDC }, { address: TOKEN_A }] },
    })
    expect(list.map((p) => p.protocol).sort()).toEqual(['uniswap-v2', `v2:${UNKNOWN_FACTORY}`])
    expect(list.find((p) => p.protocol.startsWith('v2:'))?.protocolName).toBe('Unknown V2')
  })

  it('只选了某个协议时，其他协议的池子不返回', async () => {
    const { multi } = setup()
    expect(await lpPositions(multi, USER, { protocols: ['sushiswap-v2'] })).toEqual([])
  })
})

describe('V3', () => {
  it('数量 = 当前价格下撤出全部流动性能拿到的；手续费 = 已记账 + 新产生的；已清空的仓位默认不返回', async () => {
    const { multi } = setup()
    const list = (await lpPositions(multi, USER, { versions: ['v3'] })) as LpConcentratedPosition[]
    expect(list.map((p) => p.tokenId)).toEqual(['1', '3'])
    const p = list[0] as LpConcentratedPosition
    const [amount0, amount1] = getAmountsForLiquidity(SQRT_PRICE, getSqrtRatioAtTick(-600), getSqrtRatioAtTick(600), 10n ** 18n)
    const inside0 = getFeeGrowthInside(100, -600, 600, 100n * Q128, 10n * Q128, 30n * Q128)
    const inside1 = getFeeGrowthInside(100, -600, 600, 200n * Q128, 20n * Q128, 40n * Q128)
    expect(p).toMatchObject({
      version: 'v3',
      protocol: 'uniswap-v3',
      pool: V3_POOL,
      positionManager: UNI_V3.positionManager,
      fee: 3000,
      tickLower: -600,
      tickUpper: 600,
      tick: 100,
      inRange: true,
      liquidity: (10n ** 18n).toString(),
      amount0: amount0.toString(),
      amount1: amount1.toString(),
      fees0: (11n + getFeesEarned(10n ** 18n, inside0, 5n * Q128)).toString(),
      fees1: (13n + getFeesEarned(10n ** 18n, inside1, 7n * Q128)).toString(),
    })
    expect(p.priceLower).toBeLessThan(p.price as number)
    expect(p.priceUpper).toBeGreaterThan(p.price as number)
    // #3：流动性 0 但还有未领取的手续费
    expect(list[1]).toMatchObject({ tokenId: '3', amount0: '0', amount1: '0', fees0: '9', fees1: '0' })
  })

  it('includeClosed 返回已清空的仓位；maxPositions 只看最近的', async () => {
    const { multi } = setup()
    expect(((await lpPositions(multi, USER, { versions: ['v3'], includeClosed: true })) as LpConcentratedPosition[]).map((p) => p.tokenId)).toEqual(['1', '2', '3'])
    expect(((await lpPositions(multi, USER, { versions: ['v3'], maxPositions: 1 })) as LpConcentratedPosition[]).map((p) => p.tokenId)).toEqual(['3'])
  })
})

describe('V4', () => {
  const PM = UNI_V4.positionManager as string
  const SV = UNI_V4.stateView as string
  const HOOKS = '0x0000000000000000000000000000000000000000'
  const KEY = { currency0: '0x0000000000000000000000000000000000000000', currency1: USDC, fee: 0x800000, tickSpacing: 60, hooks: HOOKS }
  const POOL_ID = poolIdOf(KEY)
  // PositionInfo：poolId 高 200 位 | tickUpper 600 | tickLower -600 | 无订阅
  const INFO = ((BigInt(POOL_ID) >> 56n) << 56n) | (600n << 32n) | ((-600n & 0xffffffn) << 8n)

  function setupV4(owners: Record<string, string> = { '7': USER, '8': OTHER }) {
    return setup({
      [PM]: handler(pmIface, {
        ownerOf: (id: bigint) => (owners[id.toString()] ? [owners[id.toString()]] : null),
        getPoolAndPositionInfo: () => [[KEY.currency0, KEY.currency1, KEY.fee, KEY.tickSpacing, KEY.hooks], INFO],
        getPositionLiquidity: () => [10n ** 15n],
      }),
      [SV]: handler(svIface, {
        getSlot0: (id: string) => (id === POOL_ID ? [SQRT_PRICE, 100n, 0n, 500n] : null),
        getFeeGrowthInside: () => [3n * Q128, 5n * Q128],
        getPositionInfo: (_id: string, owner: string, _l: bigint, _u: bigint, salt: string) =>
          owner.toLowerCase() === PM.toLowerCase() && BigInt(salt) === 7n ? [10n ** 15n, 1n * Q128, 2n * Q128] : [0n, 0n, 0n],
      }),
    })
  }

  it('PositionInfo 解码、poolId 计算', () => {
    expect(decodePositionInfo(INFO)).toEqual({ tickLower: -600, tickUpper: 600 })
    expect(BigInt(POOL_ID) >> 56n).toBe(INFO >> 56n)
  })

  it('传 tokenIds：核对仍归 owner；主币池子；动态手续费取 slot0 的 lpFee；手续费 = L × (inside − last)', async () => {
    const { multi } = setupV4()
    const list = (await lpPositions(multi, USER, { versions: ['v4'], v4: { tokenIds: [7n, '8', 'bad'] } })) as LpConcentratedPosition[]
    expect(list).toHaveLength(1) // #8 属于别人
    expect(list[0]).toMatchObject({
      version: 'v4',
      protocol: 'uniswap-v4',
      tokenId: '7',
      pool: POOL_ID,
      fee: 500,
      token0: { native: true, symbol: 'ETH', decimals: 18 },
      token1: { symbol: 'USDC' },
      fees0: getFeesEarned(10n ** 15n, 3n * Q128, 1n * Q128).toString(),
      fees1: getFeesEarned(10n ** 15n, 5n * Q128, 2n * Q128).toString(),
      hooks: HOOKS,
    })
  })

  it('Provider 的 nativeTokens 不含零地址时，V4 的零地址仍按主币处理', async () => {
    const { mock } = setupV4()
    const multi = new Provider(1, mock, { nativeTokens: [NATIVE_TOKEN] })
    const [p] = await lpPositions(multi, USER, { versions: ['v4'], v4: { tokenIds: [7n] } })
    expect(p?.token0).toMatchObject({ native: true, symbol: 'ETH', decimals: 18 })
    expect(p?.amount0Formatted).not.toBeNull()
  })

  it('maxPositions：候选太多时只核对 tokenId 最大的几个', async () => {
    const { multi } = setupV4()
    // #8 最大但属于别人：只核对 1 个时什么都查不到
    expect(await lpPositions(multi, USER, { versions: ['v4'], maxPositions: 1, v4: { tokenIds: [7n, 8n] } })).toEqual([])
    expect(await lpPositions(multi, USER, { versions: ['v4'], maxPositions: 2, v4: { tokenIds: [7n, 8n] } })).toHaveLength(1)
  })

  it('已取消时直接 reject', async () => {
    const { multi } = setupV4()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(lpPositions(multi, USER, { versions: ['v4'], v4: { tokenIds: [7n] }, signal: controller.signal })).rejects.toThrow('cancelled')
  })

  it('没传 tokenIds 也没开扫描：不查 V4', async () => {
    const { multi, mock } = setupV4()
    expect(await lpPositions(multi, USER, { versions: ['v4'] })).toEqual([])
    expect(mock.calls).toHaveLength(0)
  })

  it('扫描仓位合约发给 owner 的 NFT：从部署区块开始，进度存下来；扫到但已转走的不返回', async () => {
    const { mock, multi: _ } = setupV4({ '7': USER, '9': OTHER })
    const ownerTopic = `0x${USER.slice(2).padStart(64, '0')}`
    const requests: Array<{ fromBlock: number; toBlock: number; address?: string }> = []
    const head = (UNI_V4.deployBlock as number) + 25_000
    Object.assign(mock, {
      getBlockNumber: async () => head,
      getLogs: async (filter: { address?: string; fromBlock: number; toBlock: number; topics: string[] }) => {
        requests.push({ fromBlock: filter.fromBlock, toBlock: filter.toBlock, address: filter.address })
        expect(filter.topics[2]).toBe(ownerTopic)
        const log = (id: bigint) => ({ address: PM, topics: [filter.topics[0], ownerTopic, ownerTopic, `0x${id.toString(16).padStart(64, '0')}`] })
        return filter.fromBlock <= (UNI_V4.deployBlock as number) + 100 ? [log(7n), log(9n)] : []
      },
    })
    const multi = new Provider(1, mock)
    const storage = memoryLpScanStorage()
    const progress: unknown[] = []
    const list = (await lpPositions(multi, USER, { versions: ['v4'], v4: { scan: { storage, timeBudget: 0, onProgress: (p) => progress.push(p) } } })) as LpConcentratedPosition[]
    expect(list.map((p) => p.tokenId)).toEqual(['7'])
    expect(requests[0]).toMatchObject({ fromBlock: UNI_V4.deployBlock, address: PM })
    expect(requests.at(-1)?.toBlock).toBe(head - 5)
    expect(progress).toEqual([{ chainId: 1, positionManager: PM, startBlock: UNI_V4.deployBlock, cursor: head - 5, target: head - 5, done: true }])
    // 扫到的 #9 已经转给别人：从进度里去掉，之后不再核对
    const saved = await storage.get(`1:${PM.toLowerCase()}:${USER.toLowerCase()}`)
    expect(saved?.items).toEqual(['7'])
    // 再查：从上次的位置接着扫（已经扫完，不再请求）
    requests.length = 0
    await lpPositions(multi, USER, { versions: ['v4'], v4: { scan: { storage, timeBudget: 0 } } })
    expect(requests).toEqual([])
  })

  it('扫描进度：已销毁的从进度里去掉；读历史区块时不清理；onProgress 出错不影响保存；暂停时也回调', async () => {
    const head = (UNI_V4.deployBlock as number) + 1000
    const ownerTopic = `0x${USER.slice(2).padStart(64, '0')}`
    // #7 仍持有，#20 已销毁（ownerOf revert、仓位信息为 0），#21 转给了别人
    const { mock } = setup({
      [PM]: handler(pmIface, {
        ownerOf: (id: bigint) => (id === 7n ? [USER] : id === 21n ? [OTHER] : null),
        getPoolAndPositionInfo: (id: bigint) => [[KEY.currency0, KEY.currency1, KEY.fee, KEY.tickSpacing, KEY.hooks], id === 20n ? 0n : INFO],
        getPositionLiquidity: (id: bigint) => [id === 20n ? 0n : 10n ** 15n],
      }),
      [SV]: handler(svIface, {
        getSlot0: () => [SQRT_PRICE, 100n, 0n, 500n],
        getFeeGrowthInside: () => [3n * Q128, 5n * Q128],
        getPositionInfo: () => [10n ** 15n, 1n * Q128, 2n * Q128],
      }),
    })
    let unsupported = false
    Object.assign(mock, {
      getBlockNumber: async () => head,
      getLogs: async (filter: { topics: string[] }) => {
        if (unsupported) throw new Error('method eth_getLogs is not supported')
        const log = (id: bigint) => ({ address: PM, topics: [filter.topics[0], ownerTopic, ownerTopic, `0x${id.toString(16).padStart(64, '0')}`] })
        return [log(7n), log(20n), log(21n)]
      },
    })
    const multi = new Provider(1, mock)
    const storage = memoryLpScanStorage()
    const key = `1:${PM.toLowerCase()}:${USER.toLowerCase()}`
    const scan = { storage, timeBudget: 0, blockRange: 100_000 }

    // 读历史区块：不清理（那时的持有人不代表现在）
    await lpPositions(multi, USER, { versions: ['v4'], blockTag: head - 100, v4: { scan } })
    expect((await storage.get(key))?.items.sort()).toEqual(['20', '21', '7'])

    // 读最新：#20（销毁）、#21（转走）去掉；onProgress 抛错也照常保存
    const list = await lpPositions(multi, USER, {
      versions: ['v4'],
      v4: {
        scan: {
          ...scan,
          onProgress: () => {
            throw new Error('boom')
          },
        },
      },
    })
    expect(list.map((p) => (p as LpConcentratedPosition).tokenId)).toEqual(['7'])
    expect((await storage.get(key))?.items).toEqual(['7'])

    // 节点不开放 getLogs：暂停，之后的调用不扫描，也会回调（target 为 null、带 pausedUntil）
    await storage.set(key, { startBlock: head, cursor: head - 6, items: ['7'], blockRange: 100 })
    unsupported = true
    const progress: Array<{ target: number | null; done: boolean; pausedUntil?: number }> = []
    await lpPositions(multi, USER, { versions: ['v4'], v4: { scan: { ...scan, onProgress: (p) => progress.push(p) } } })
    await lpPositions(multi, USER, { versions: ['v4'], v4: { scan: { ...scan, onProgress: (p) => progress.push(p) } } })
    expect(progress).toHaveLength(2)
    expect(progress[0]).toMatchObject({ target: head - 5, done: false })
    expect(progress[0]?.pausedUntil).toBeGreaterThan(Date.now())
    expect(progress[1]).toMatchObject({ target: null, done: false })
    expect(progress[1]?.pausedUntil).toBeGreaterThan(Date.now())
  })

  it('节点落后于扫描进度：照样返回仓位，这次不清理进度', { timeout: 30_000 }, async () => {
    const head = (UNI_V4.deployBlock as number) + 1000
    const ownerTopic = `0x${USER.slice(2).padStart(64, '0')}`
    // eth_call 的节点比扫描用的 getBlockNumber 落后 50 个区块（超过 confirmations）
    const { mock } = setup(
      {
        [PM]: handler(pmIface, {
          ownerOf: (id: bigint) => (id === 7n ? [USER] : [OTHER]),
          getPoolAndPositionInfo: () => [[KEY.currency0, KEY.currency1, KEY.fee, KEY.tickSpacing, KEY.hooks], INFO],
          getPositionLiquidity: () => [10n ** 15n],
        }),
        [SV]: handler(svIface, {
          getSlot0: () => [SQRT_PRICE, 100n, 0n, 500n],
          getFeeGrowthInside: () => [3n * Q128, 5n * Q128],
          getPositionInfo: () => [10n ** 15n, 1n * Q128, 2n * Q128],
        }),
      },
      head - 50,
    )
    Object.assign(mock, {
      getBlockNumber: async () => head,
      getLogs: async (filter: { topics: string[] }) =>
        [7n, 21n].map((id) => ({ address: PM, topics: [filter.topics[0], ownerTopic, ownerTopic, `0x${id.toString(16).padStart(64, '0')}`] })),
    })
    const storage = memoryLpScanStorage()
    const list = await lpPositions(new Provider(1, mock), USER, { versions: ['v4'], v4: { scan: { storage, timeBudget: 0, blockRange: 100_000 } } })
    expect(list.map((p) => (p as LpConcentratedPosition).tokenId)).toEqual(['7'])
    // 落后节点读到的 #21“属于别人”不可信：不从进度里去掉
    expect((await storage.get(`1:${PM.toLowerCase()}:${USER.toLowerCase()}`))?.items.sort()).toEqual(['21', '7'])
  })

  it('第一次扫描就拿不到最新区块：onProgress 也回调一次', async () => {
    const { mock } = setupV4()
    Object.assign(mock, {
      getBlockNumber: async () => {
        throw new Error('node down')
      },
    })
    const progress: unknown[] = []
    await lpPositions(new Provider(1, mock), USER, { versions: ['v4'], v4: { scan: { storage: memoryLpScanStorage(), onProgress: (p) => progress.push(p) } } })
    expect(progress).toEqual([{ chainId: 1, positionManager: PM, startBlock: -1, cursor: -1, target: null, done: false }])
  })
})

describe('美元价值', () => {
  const prices: PriceSource = {
    name: 'test',
    prices: async ({ tokens }) => new Map(tokens.flatMap((t): Array<[string, number]> => (t.toLowerCase() === USDC.toLowerCase() ? [[USDC.toLowerCase(), 1]] : t.toLowerCase() === WETH.toLowerCase() ? [[WETH.toLowerCase(), 2000]] : []))),
  }

  it('两种代币都有价格时有 valueUsd；缺价格（且数量不为 0）时为 null，排在后面', async () => {
    const { multi } = setup()
    const list = await lpPositions(multi, USER, { prices })
    const v2 = list.find((p) => p.version === 'v2')
    expect(v2?.valueUsd).toBe(1000 + 0.5 * 2000)
    const v3 = list.find((p) => p.version === 'v3' && p.tokenId === '1') as LpConcentratedPosition
    expect(v3.valueUsd).toBeNull() // AAA / BBB 没有价格
    expect(v3.feesUsd).toBeNull()
    // #3：数量都是 0，没有价格也算 0；手续费有 AAA、没价格，为 null
    const closed = list.find((p) => p.version === 'v3' && p.tokenId === '3') as LpConcentratedPosition
    expect([closed.valueUsd, closed.feesUsd]).toEqual([0, null])
    expect(list[0]?.version).toBe('v2') // 有价值的排在前面
  })

  it('价格源出错：照样返回仓位，valueUsd 为 null', async () => {
    const { multi } = setup()
    const failing: PriceSource = { name: 'down', prices: async () => Promise.reject(new Error('HTTP 503')) }
    // 价格源同步抛错也接住
    const throwing: PriceSource = {
      name: 'sync',
      prices: () => {
        throw new Error('sync fail')
      },
    }
    const syncErrors: unknown[] = []
    expect((await lpPositions(multi, USER, { prices: throwing, onPriceError: (e) => syncErrors.push(e) })).length).toBeGreaterThan(0)
    expect(String(syncErrors[0])).toContain('sync fail')
    const errors: unknown[] = []
    const list = await lpPositions(multi, USER, { prices: failing, onPriceError: (err) => errors.push(err) })
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('HTTP 503')
    expect(list.map((p) => p.pool).sort()).toEqual((await lpPositions(multi, USER)).map((p) => p.pool).sort())
    // 数量不为 0 的仓位没有价格：valueUsd 为 null（如 V2 的 USDC / WETH 池子）
    expect(list.find((p) => p.version === 'v2')?.valueUsd).toBeNull()
  })

  it('快捷函数 getLpPositions：节点参数与 getBalances 相同', async () => {
    const { mock } = setup()
    const list = await getLpPositions(USER, { provider: mock, chainId: 1, versions: ['v2'] })
    expect(list).toHaveLength(1)
  })
})
