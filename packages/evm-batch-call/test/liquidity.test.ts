import { AbiCoder, Interface, MaxUint256, getAddress } from 'ethers'
import { beforeEach, describe, expect, it } from 'vitest'

import { MULTICALL3_ADDRESS, NATIVE_TOKEN, Provider } from '../src/index.js'
import { resetMulticallCache } from '../src/aggregate.js'
import { clearChainIdCache } from '../src/detect.js'
import { resetDecimalsCache } from '../src/erc20.js'
import {
  MAX_TICK,
  MIN_TICK,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getMaxAmounts,
  getMinAmounts,
  getMintAmounts,
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
  nearestUsableTick,
  parseDecimal,
  priceToSqrtPriceX96,
  priceToTick,
  sqrtBigInt,
  tickToPrice,
} from '../src/lpMath.js'
import { poolIdOf } from '../src/lpV4.js'
import { LP_PROTOCOLS, type LpProtocol } from '../src/lp.js'
import { PERMIT2_ADDRESS, buildAddLiquidity, buildCollectFees, buildRemoveLiquidity } from '../src/subpaths/liquidity.js'
import { createMockProvider } from './mockProvider.js'

describe('lpMath：添加 / 移除用到的计算', () => {
  it('sqrtBigInt 精确向下取整', () => {
    for (const v of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 2n ** 64n - 1n, 2n ** 192n * 3n, 2n ** 320n + 12345n, (2n ** 160n - 1n) ** 2n, (2n ** 160n - 1n) ** 2n - 1n]) {
      const x = sqrtBigInt(v)
      expect(x * x <= v && (x + 1n) * (x + 1n) > v).toBe(true)
    }
  })

  it('getTickAtSqrtRatio 与 getSqrtRatioAtTick 互逆', () => {
    for (const tick of [MIN_TICK, -887271, -200000, -1, 0, 1, 60, 199999, MAX_TICK - 1]) {
      const sqrt = getSqrtRatioAtTick(tick)
      expect(getTickAtSqrtRatio(sqrt)).toBe(tick)
      expect(getTickAtSqrtRatio(sqrt + 1n)).toBe(tick)
      if (tick > MIN_TICK) {
        expect(getTickAtSqrtRatio(sqrt - 1n)).toBe(tick - 1)
      }
    }
    expect(() => getTickAtSqrtRatio(getSqrtRatioAtTick(MAX_TICK))).toThrow(RangeError)
  })

  it('价格 → tick：tickToPrice(tick) <= price < tickToPrice(tick + 1)', () => {
    expect(priceToTick(1, 18, 18)).toBe(0)
    expect(priceToSqrtPriceX96('1', 18, 18)).toBe(2n ** 96n)
    for (const [price, d0, d1] of [
      [2500, 18, 6],
      ['0.000123', 6, 18],
      [1.0001, 18, 18],
      ['3e-7', 18, 18],
    ] as const) {
      const tick = priceToTick(price, d0, d1)
      expect(tickToPrice(tick, d0, d1) <= Number(price) * (1 + 1e-12)).toBe(true)
      expect(tickToPrice(tick + 1, d0, d1) > Number(price) * (1 - 1e-12)).toBe(true)
    }
    expect(() => priceToTick(0, 18, 18)).toThrow()
  })

  it('parseDecimal 精确解析，不经过浮点', () => {
    expect(parseDecimal('1.5')).toEqual({ num: 15n, den: 10n })
    expect(parseDecimal('2e-7')).toEqual({ num: 2n, den: 10n ** 7n })
    expect(parseDecimal(1e21)).toEqual({ num: 10n ** 21n, den: 1n })
    expect(parseDecimal('.25')).toEqual({ num: 25n, den: 100n })
    for (const bad of ['', '-1', 'abc', '1.2.3', Number.NaN, Infinity]) {
      expect(() => parseDecimal(bad as string)).toThrow()
    }
  })

  it('nearestUsableTick 取最近的倍数，不超出范围', () => {
    expect(nearestUsableTick(29, 60)).toBe(0)
    expect(nearestUsableTick(31, 60)).toBe(60)
    expect(nearestUsableTick(-31, 60)).toBe(-60)
    expect(nearestUsableTick(MAX_TICK, 60)).toBe(887220)
    expect(nearestUsableTick(MIN_TICK, 60)).toBe(-887220)
  })

  it('按数量算的流动性：需要的数量不超过给的，最小值 <= 预计 <= 最大值', () => {
    const sqrtA = getSqrtRatioAtTick(-600)
    const sqrtB = getSqrtRatioAtTick(900)
    const sqrtP = getSqrtRatioAtTick(123)
    const L = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, 10n ** 18n, 5n * 10n ** 18n)
    const [m0, m1] = getMintAmounts(sqrtP, sqrtA, sqrtB, L)
    expect(m0 <= 10n ** 18n && m1 <= 5n * 10n ** 18n).toBe(true)
    // 有一边正好用完（误差 1）
    expect(10n ** 18n - m0 <= 1n || 5n * 10n ** 18n - m1 <= 1n).toBe(true)
    const [a0, a1] = getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, L)
    const [min0, min1] = getMinAmounts(sqrtP, sqrtA, sqrtB, L, 0.01)
    const [max0, max1] = getMaxAmounts(sqrtP, sqrtA, sqrtB, L, 0.01)
    expect(min0 < a0 && a0 <= m0 && m0 < max0).toBe(true)
    expect(min1 < a1 && a1 <= m1 && m1 < max1).toBe(true)
    // 滑点 0：最小值就是按当前价格的数量
    expect(getMinAmounts(sqrtP, sqrtA, sqrtB, L, 0)).toEqual([a0, a1])
  })
})

// ---------------------------------------------------------------------------
// 构建计划（假的链）
// ---------------------------------------------------------------------------

const USER = '0x4000000000000000000000000000000000000004'
const OTHER = '0x5000000000000000000000000000000000000005'
const VAULT = '0x6000000000000000000000000000000000000006'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const ZERO = '0x0000000000000000000000000000000000000000'
const PAIR = '0x6100000000000000000000000000000000000061'
const V3_POOL = '0x7100000000000000000000000000000000000071'

const UNI_V2 = LP_PROTOCOLS.find((p) => p.chainId === 1 && p.id === 'uniswap-v2') as LpProtocol
const UNI_V3 = LP_PROTOCOLS.find((p) => p.chainId === 1 && p.id === 'uniswap-v3') as LpProtocol
const UNI_V4 = LP_PROTOCOLS.find((p) => p.chainId === 1 && p.id === 'uniswap-v4') as LpProtocol

type Impl = Record<string, (...args: any[]) => unknown[] | null>
function handler(iface: Interface, impl: Impl) {
  return (data: string) => {
    const tx = iface.parseTransaction({ data })
    const fn = tx && impl[tx.name]
    const out = fn ? fn(...tx.args) : null
    return out === null || !tx ? { success: false, returnData: '0x' } : { success: true, returnData: iface.encodeFunctionResult(tx.name, out) }
  }
}

const tokenIface = new Interface([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])
const routerIface = new Interface([
  'function WETH() view returns (address)',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline)',
  'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable',
  'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline)',
  'function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline)',
])
const v2Factory = new Interface(['function getPair(address, address) view returns (address)', 'function feeTo() view returns (address)'])
const v2Pair = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function factory() view returns (address)',
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function allowance(address, address) view returns (uint256)',
  'function kLast() view returns (uint256)',
])
const npmIface = new Interface([
  'function WETH9() view returns (address)',
  'function isApprovedForAll(address, address) view returns (bool)',
  'function factory() view returns (address)',
  'function ownerOf(uint256) view returns (address)',
  'function positions(uint256) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)',
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params)',
  'function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params)',
  'function burn(uint256 tokenId)',
  'function multicall(bytes[] data)',
  'function refundETH()',
  'function unwrapWETH9(uint256 amountMinimum, address recipient)',
  'function sweepToken(address token, uint256 amountMinimum, address recipient)',
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)',
])
const v3Factory = new Interface(['function getPool(address, address, uint24) view returns (address)', 'function feeAmountTickSpacing(uint24) view returns (int24)'])
const v3Pool = new Interface([
  'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
  'function tickSpacing() view returns (int24)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24) view returns (uint128, int128, uint256, uint256, int56, uint160, uint32, bool)',
])
const pmIface = new Interface([
  'function ownerOf(uint256) view returns (address)',
  'function getApproved(uint256) view returns (address)',
  'function isApprovedForAll(address, address) view returns (bool)',
  'function getPoolAndPositionInfo(uint256) view returns ((address, address, uint24, int24, address), uint256)',
  'function getPositionLiquidity(uint256) view returns (uint128)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline)',
  'function multicall(bytes[] data)',
  'function initializePool((address, address, uint24, int24, address) key, uint160 sqrtPriceX96)',
])
const svIface = new Interface([
  'function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)',
  'function getFeeGrowthInside(bytes32, int24, int24) view returns (uint256, uint256)',
  'function getPositionInfo(bytes32, address, int24, int24, bytes32) view returns (uint128, uint256, uint256)',
])
const permit2Iface = new Interface([
  'function allowance(address, address, address) view returns (uint160, uint48, uint48)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
])

/** USDC/WETH 价格 2000（token0 = USDC 6 位，token1 = WETH 18 位：raw 价格 = 1/2000 × 10^12） */
const SQRT_2000 = priceToSqrtPriceX96(1 / 2000, 6, 18)
const TICK_2000 = getTickAtSqrtRatio(SQRT_2000)
const Q128 = 2n ** 128n

interface ChainState {
  allowances: Record<string, bigint>
  pairExists: boolean
  v3PoolExists: boolean
  v4Price: bigint
  permit2: [bigint, bigint]
  /** 协议手续费：非 0 时 factory.feeTo 不为零、pair.kLast 为这个值 */
  kLast: bigint
}

function setup(state: Partial<ChainState> = {}) {
  const s: ChainState = { allowances: {}, pairExists: true, v3PoolExists: true, v4Price: SQRT_2000, permit2: [0n, 0n], kLast: 0n, ...state }
  const token = (symbol: string, decimals: number) =>
    handler(tokenIface, {
      symbol: () => [symbol],
      decimals: () => [decimals],
      balanceOf: () => [10n ** 30n],
      allowance: (_o: string, spender: string) => [s.allowances[`${symbol}:${spender.toLowerCase()}`] ?? 0n],
    })
  const V4_KEY = [ZERO, USDC, 500n, 10n, ZERO]
  const v4PoolId = poolIdOf({ currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10, hooks: ZERO })
  const mock = createMockProvider({
    contracts: {
      [USDC]: token('USDC', 6),
      [WETH]: token('WETH', 18),
      [USDT]: token('USDT', 6),
      [UNI_V2.router as string]: handler(routerIface, { WETH: () => [WETH] }),
      [UNI_V2.factory as string]: handler(v2Factory, { getPair: () => [s.pairExists ? PAIR : ZERO], feeTo: () => [s.kLast ? OTHER : ZERO] }),
      // 储备：4000 USDC / 2 WETH，LP 总量 4e18，USER 持有 1e18
      [PAIR]: handler(v2Pair, {
        balanceOf: (owner: string) => [owner.toLowerCase() === USER ? 10n ** 18n : 0n],
        totalSupply: () => [4n * 10n ** 18n],
        token0: () => [USDC],
        token1: () => [WETH],
        factory: () => [UNI_V2.factory],
        getReserves: () => [4000n * 10n ** 6n, 2n * 10n ** 18n, 0n],
        allowance: () => [0n],
        kLast: () => [s.kLast],
      }),
      [UNI_V3.positionManager as string]: handler(npmIface, {
        WETH9: () => [WETH],
        factory: () => [UNI_V3.factory],
        ownerOf: (id: bigint) => [id === 1n ? USER : OTHER],
        // VAULT 被 USER setApprovalForAll 授权
        isApprovedForAll: (owner: string, operator: string) => [owner.toLowerCase() === USER.toLowerCase() && operator.toLowerCase() === VAULT.toLowerCase()],
        // 仓位 #1：USDC/WETH 0.05%，区间包含当前价格；#2 没有流动性也没有手续费
        positions: (id: bigint) =>
          id === 1n
            ? [0n, ZERO, USDC, WETH, 500n, BigInt(TICK_2000 - TICK_2000 % 10 - 1000), BigInt(TICK_2000 - TICK_2000 % 10 + 1000), 10n ** 15n, 0n, 0n, 7n, 9n]
            : [0n, ZERO, USDC, WETH, 500n, -100n, 100n, 0n, 0n, 0n, 0n, 0n],
      }),
      [UNI_V3.factory as string]: handler(v3Factory, { getPool: () => [s.v3PoolExists ? V3_POOL : ZERO], feeAmountTickSpacing: (fee: bigint) => [fee === 500n ? 10n : 0n] }),
      [V3_POOL]: handler(v3Pool, {
        slot0: () => [SQRT_2000, BigInt(TICK_2000), 0n, 0n, 0n, 0n, true],
        tickSpacing: () => [10n],
        feeGrowthGlobal0X128: () => [0n],
        feeGrowthGlobal1X128: () => [0n],
        ticks: () => [0n, 0n, 0n, 0n, 0n, 0n, 0n, true],
      }),
      [UNI_V4.positionManager as string]: handler(pmIface, {
        ownerOf: () => [USER],
        getApproved: () => [ZERO],
        isApprovedForAll: (_owner: string, operator: string) => [operator.toLowerCase() === VAULT.toLowerCase()],
        getPoolAndPositionInfo: () => [V4_KEY, (BigInt.asUintN(24, BigInt(TICK_2000 - TICK_2000 % 10 + 500)) << 32n) | (BigInt.asUintN(24, BigInt(TICK_2000 - TICK_2000 % 10 - 500)) << 8n)],
        getPositionLiquidity: () => [10n ** 12n],
      }),
      [UNI_V4.stateView as string]: handler(svIface, {
        getSlot0: (id: string) => (id === v4PoolId ? [s.v4Price, s.v4Price ? BigInt(getTickAtSqrtRatio(s.v4Price)) : 0n, 0n, 500n] : [0n, 0n, 0n, 0n]),
        getFeeGrowthInside: () => [3n * Q128, 0n],
        getPositionInfo: () => [10n ** 12n, Q128, 0n],
      }),
      [PERMIT2_ADDRESS]: handler(permit2Iface, { allowance: () => [s.permit2[0], s.permit2[1], 0n] }),
    },
    multicallAddresses: [MULTICALL3_ADDRESS],
  })
  return new Provider(1, mock)
}

const decode = (iface: Interface, data: string) => iface.parseTransaction({ data }) as NonNullable<ReturnType<Interface['parseTransaction']>>

beforeEach(() => {
  clearChainIdCache()
  resetMulticallCache()
  resetDecimalsCache()
})

describe('V2', () => {
  it('给一边的数量：另一边按储备比例，两种代币都要授权给 Router', async () => {
    const plan = await buildAddLiquidity(setup(), USER, { protocol: 'uniswap-v2', tokenA: WETH, tokenB: USDC, amountAFormatted: '0.5' })
    expect(plan).toMatchObject({ version: 'v2', protocol: 'uniswap-v2', pool: PAIR, createPool: false, native: null, value: '0' })
    // token0 = USDC：0.5 WETH 对应 1000 USDC
    expect(plan.amount0Formatted).toBe('1000')
    expect(plan.amount1Formatted).toBe('0.5')
    expect(plan.liquidity).toBe(String(10n ** 18n)) // 份额 1/4
    expect(plan.transactions.map((t) => t.kind)).toEqual(['approve', 'approve', 'add'])
    const add = decode(routerIface, plan.transactions[2]?.data as string)
    expect(add.name).toBe('addLiquidity')
    expect(add.args.slice(0, 6).map(String)).toEqual([USDC, WETH, '1000000000', String(5n * 10n ** 17n), '995000000', String(4975n * 10n ** 14n)])
    expect(add.args[6]).toBe(USER)
  })

  it('主币：用 addLiquidityETH 附带主币，包装币不需要授权；已有部分额度时直接改（只有 USDT 等才先归零）', async () => {
    const plan = await buildAddLiquidity(setup({ allowances: { [`USDC:${(UNI_V2.router as string).toLowerCase()}`]: 5n } }), USER, {
      protocol: 'uniswap-v2',
      tokenA: NATIVE_TOKEN,
      tokenB: USDC,
      amountBFormatted: '400',
    })
    expect(plan.native).toBe('token1')
    expect(plan.value).toBe(String(2n * 10n ** 17n))
    expect(plan.transactions.map((t) => [t.kind, t.amount])).toEqual([
      ['approve', '400000000'],
      ['add', undefined],
    ])
    const add = decode(routerIface, plan.transactions[1]?.data as string)
    expect(add.name).toBe('addLiquidityETH')
    expect(add.args.slice(0, 4).map(String)).toEqual([USDC, '400000000', '398000000', String(199n * 10n ** 15n)])
    expect(plan.transactions[1]?.value).toBe(plan.value)
  })

  it('USDT（Ethereum）已有部分额度：先 approve 0 再授权', async () => {
    const provider = setup({ allowances: { [`USDT:${(UNI_V3.positionManager as string).toLowerCase()}`]: 5n } })
    const plan = await buildAddLiquidity(provider, USER, { protocol: 'uniswap-v3', tokenA: WETH, tokenB: USDT, fee: 500, fullRange: true, amountAFormatted: '1' })
    expect(plan.transactions.filter((t) => t.token === USDT).map((t) => t.amount)).toEqual(['0', plan.amount1Max])
  })

  it('仓位上带的协议对象（不在内置表 / options.protocols 里）也能用', async () => {
    const custom = { ...UNI_V2, id: 'fork-v2', name: 'Fork V2' }
    const plan = await buildRemoveLiquidity(setup(), USER, { position: { pool: PAIR, protocol: custom }, percent: 10 })
    expect(plan.protocol).toBe('fork-v2')
    await expect(buildRemoveLiquidity(setup(), USER, { position: { pool: PAIR, protocol: { ...custom, factory: OTHER } } })).rejects.toThrow(/does not belong/)
  })

  it('协议手续费比例按 LpProtocol.protocolFee：自定义协议没填时按 8/25（偏保守）', async () => {
    const k = 4000n * 10n ** 6n * 2n * 10n ** 18n
    const rootK = sqrtBigInt(k)
    const rootKLast = (rootK * 10n) / 11n
    const supply = 4n * 10n ** 18n
    const custom = { ...UNI_V2, id: 'my-v2', protocolFee: undefined }
    const plan = await buildRemoveLiquidity(setup({ kLast: rootKLast * rootKLast }), USER, { position: { pool: PAIR }, percent: 50 }, { protocols: [custom] })
    // 自定义协议排在内置的前面，按工厂找到的是它
    expect(plan.protocol).toBe('my-v2')
    const minted = (supply * (rootK - rootKLast) * 8n) / (rootK * 17n + rootKLast * 8n)
    expect(plan.amount0).toBe(String((5n * 10n ** 17n * 4000n * 10n ** 6n) / (supply + minted)))
  })

  it('两边都给：按较少的一边（与 Router 一致）；额度够时不再授权；max 授权', async () => {
    const provider = setup({ allowances: { [`USDC:${(UNI_V2.router as string).toLowerCase()}`]: 10n ** 12n } })
    const plan = await buildAddLiquidity(provider, USER, { protocol: 'uniswap-v2', tokenA: USDC, tokenB: WETH, amountA: 3000n * 10n ** 6n, amountBFormatted: '1' }, { approve: 'max' })
    expect([plan.amount0Formatted, plan.amount1Formatted]).toEqual(['2000', '1'])
    // 传给 Router 的是给的数量，最小值按实际会用掉的（2000 USDC）算，否则 Router 按较少的一边收取时会 revert
    const add = decode(routerIface, plan.transactions[plan.transactions.length - 1]?.data as string)
    expect(add.args.slice(2, 6).map(String)).toEqual(['3000000000', String(10n ** 18n), '1990000000', String(995n * 10n ** 15n)])
    expect(plan.transactions.map((t) => [t.kind, t.token, t.amount])).toEqual([
      ['approve', WETH, MaxUint256.toString()],
      ['add', undefined, undefined],
    ])
  })

  it('新池子：两边都要给，LP = sqrt(a × b) − 1000', async () => {
    const provider = setup({ pairExists: false })
    await expect(buildAddLiquidity(provider, USER, { protocol: 'uniswap-v2', tokenA: USDC, tokenB: WETH, amountAFormatted: '1' })).rejects.toThrow(/both tokens/)
    const plan = await buildAddLiquidity(provider, USER, { protocol: 'uniswap-v2', tokenA: USDC, tokenB: WETH, amountA: 10n ** 6n, amountB: 10n ** 12n })
    expect(plan.createPool).toBe(true)
    expect(plan.pool).toBe(null)
    expect(plan.liquidity).toBe(String(10n ** 9n - 1000n))
  })

  it('移除：按比例，授权 LP 代币；native 时换成主币', async () => {
    const plan = await buildRemoveLiquidity(setup(), USER, { position: { pool: PAIR }, percent: 50 }, { native: true, slippage: 0.01 })
    expect(plan).toMatchObject({ action: 'remove', liquidity: String(5n * 10n ** 17n), amount0: '500000000', amount1: String(25n * 10n ** 16n), native: 'token1' })
    expect(plan.transactions.map((t) => [t.kind, t.token])).toEqual([
      ['approve', PAIR],
      ['remove', undefined],
    ])
    const remove = decode(routerIface, plan.transactions[1]?.data as string)
    expect(remove.name).toBe('removeLiquidityETH')
    expect(remove.args.slice(0, 4).map(String)).toEqual([USDC, String(5n * 10n ** 17n), '495000000', String(2475n * 10n ** 14n)])
    // 不持有：报错
    await expect(buildRemoveLiquidity(setup(), OTHER, { position: { pool: PAIR } })).rejects.toThrow(/holds no LP/)
    await expect(buildRemoveLiquidity(setup(), USER, { position: { pool: PAIR }, percent: 0 })).rejects.toThrow(RangeError)
  })

  it('协议手续费开启：按先给 feeTo 增发后的总量算（Uniswap 增发 √k 增长的 1/6）', async () => {
    // 储备 4000 USDC / 2 WETH，√k 比 kLast 时增长了 10%
    const k = 4000n * 10n ** 6n * 2n * 10n ** 18n
    const rootK = sqrtBigInt(k)
    const rootKLast = (rootK * 10n) / 11n
    const supply = 4n * 10n ** 18n
    const minted = (supply * (rootK - rootKLast)) / (rootK * 5n + rootKLast)
    const plan = await buildRemoveLiquidity(setup({ kLast: rootKLast * rootKLast }), USER, { position: { pool: PAIR }, percent: 50 })
    expect(plan.amount0).toBe(String((5n * 10n ** 17n * 4000n * 10n ** 6n) / (supply + minted)))
    expect(BigInt(plan.amount0)).toBeLessThan(500n * 10n ** 6n)
  })
})

describe('V3', () => {
  it('新建仓位：价格区间取可用 tick，给一边算另一边，mint 的数量与计划一致', async () => {
    const plan = await buildAddLiquidity(setup(), USER, { protocol: 'uniswap-v3', tokenA: WETH, tokenB: USDC, fee: 500, priceLower: 1800, priceUpper: 2200, amountAFormatted: '1' })
    // 价格是 USDC / WETH，tokenA = token1：tick 区间按倒数换算
    expect((plan.tickLower as number) % 10).toBe(0)
    expect((plan.tickUpper as number) % 10).toBe(0)
    expect(plan.tickLower as number).toBeLessThan(TICK_2000)
    expect(plan.tickUpper as number).toBeGreaterThan(TICK_2000)
    expect(1 / (plan.priceUpper as number)).toBeCloseTo(1800, -1)
    expect(1 / (plan.priceLower as number)).toBeCloseTo(2200, -1)
    // 给的一边按给的传给合约（amount1Max）；按流动性取整，实际用掉的略少（不到 1000 wei）
    expect(plan.amount1Max).toBe(String(10n ** 18n))
    expect(10n ** 18n - BigInt(plan.amount1)).toBeLessThan(1000n)
    expect(Number(plan.amount0Formatted)).toBeGreaterThan(1000)
    const mint = decode(npmIface, plan.transactions[plan.transactions.length - 1]?.data as string)
    expect(mint.name).toBe('mint')
    const p = mint.args[0]
    expect([p.token0, p.token1, p.fee, p.tickLower, p.tickUpper].map(String)).toEqual([USDC, WETH, '500', String(plan.tickLower), String(plan.tickUpper)])
    // 合约按 desired 算出的流动性就是计划里的
    const L = getLiquidityForAmounts(SQRT_2000, getSqrtRatioAtTick(plan.tickLower as number), getSqrtRatioAtTick(plan.tickUpper as number), p.amount0Desired, p.amount1Desired)
    expect(L.toString()).toBe(plan.liquidity)
    expect(p.amount0Min < p.amount0Desired && p.amount1Min < p.amount1Desired).toBe(true)
  })

  it('主币：附带包装币那一边，multicall(mint, refundETH)', async () => {
    const plan = await buildAddLiquidity(setup(), USER, { protocol: 'uniswap-v3', tokenA: NATIVE_TOKEN, tokenB: USDC, fee: 500, fullRange: true, amountAFormatted: '1' })
    expect(plan.native).toBe('token1')
    expect(plan.value).toBe(String(10n ** 18n))
    expect(plan.transactions.map((t) => [t.kind, t.token])).toEqual([
      ['approve', USDC],
      ['add', undefined],
    ])
    const calls = decode(npmIface, plan.transactions[1]?.data as string).args[0] as string[]
    expect(calls.map((c) => decode(npmIface, c).name)).toEqual(['mint', 'refundETH'])
    expect([plan.tickLower, plan.tickUpper]).toEqual([-887270, 887270])
  })

  it('区间在当前价格之外：只能给对应的一种代币', async () => {
    // 价格高于区间（USDC/WETH 2000 > 1500）：仓位里只有……按 token1/token0 方向判断
    await expect(
      buildAddLiquidity(setup(), USER, { protocol: 'uniswap-v3', tokenA: WETH, tokenB: USDC, fee: 500, priceLower: 1000, priceUpper: 1500, amountAFormatted: '1' }),
    ).rejects.toThrow(/only USDC/)
    const plan = await buildAddLiquidity(setup(), USER, { protocol: 'uniswap-v3', tokenA: WETH, tokenB: USDC, fee: 500, priceLower: 1000, priceUpper: 1500, amountBFormatted: '100' })
    expect(plan.amount1).toBe('0')
    // 两边都给：用不到的 WETH 不授权、不传
    const both = await buildAddLiquidity(setup(), USER, { protocol: 'uniswap-v3', tokenA: WETH, tokenB: USDC, fee: 500, priceLower: 1000, priceUpper: 1500, amountAFormatted: '1', amountBFormatted: '100' })
    expect(both.amount1Max).toBe('0')
    expect(both.transactions.filter((t) => t.kind === 'approve').map((t) => t.token)).toEqual([USDC])
    // 需要的那种给了 0：说明要给哪种
    await expect(
      buildAddLiquidity(setup(), USER, { protocol: 'uniswap-v3', tokenA: WETH, tokenB: USDC, fee: 500, priceLower: 1000, priceUpper: 1500, amountAFormatted: '1', amountB: 0n }),
    ).rejects.toThrow(/only USDC/)
  })

  it('池子不存在：没有 initialPrice 报错；有时先创建', async () => {
    const provider = setup({ v3PoolExists: false })
    await expect(buildAddLiquidity(provider, USER, { protocol: 'uniswap-v3', tokenA: WETH, tokenB: USDC, fee: 500, fullRange: true, amountAFormatted: '1' })).rejects.toThrow(/initialPrice/)
    const plan = await buildAddLiquidity(provider, USER, { protocol: 'uniswap-v3', tokenA: WETH, tokenB: USDC, fee: 500, fullRange: true, amountAFormatted: '1', initialPrice: 2000 })
    expect(plan.createPool).toBe(true)
    expect(Math.abs((plan.tick as number) - TICK_2000)).toBeLessThanOrEqual(1)
    const calls = decode(npmIface, plan.transactions[plan.transactions.length - 1]?.data as string).args[0] as string[]
    expect(calls.map((c) => decode(npmIface, c).name)).toEqual(['createAndInitializePoolIfNecessary', 'mint'])
    // 手续费档位没开：报错
    await expect(buildAddLiquidity(provider, USER, { protocol: 'uniswap-v3', tokenA: WETH, tokenB: USDC, fee: 123, fullRange: true, amountAFormatted: '1', initialPrice: 2000 })).rejects.toThrow(
      /not enabled/,
    )
  })

  it('追加：increaseLiquidity；不是所有者时报错（合约允许，但 tokenId 写错会把代币白送给别人）', async () => {
    const plan = await buildAddLiquidity(setup(), USER, { position: { protocol: 'uniswap-v3', tokenId: 1 }, amount0Formatted: '100' })
    expect(plan.tokenId).toBe('1')
    expect(decode(npmIface, plan.transactions[plan.transactions.length - 1]?.data as string).name).toBe('increaseLiquidity')
    await expect(buildAddLiquidity(setup(), OTHER, { position: { protocol: 'uniswap-v3', tokenId: 1 }, amount0Formatted: '100' })).rejects.toThrow(/not the owner/)
    await expect(buildAddLiquidity(setup(), USER, { position: { protocol: 'uniswap-v3', tokenId: 2 ** 60 }, amount0Formatted: '100' })).rejects.toThrow(/safe integer/)
  })

  it('移除：decreaseLiquidity + collect；native 时收到仓位合约再换成主币；全部移除可以销毁', async () => {
    const provider = setup()
    const plan = await buildRemoveLiquidity(provider, USER, { position: { positionManager: UNI_V3.positionManager, tokenId: '1' }, burn: true }, { native: true })
    expect(plan).toMatchObject({ action: 'remove', liquidity: String(10n ** 15n), fees0: '7', fees1: '9', native: 'token1' })
    const calls = decode(npmIface, plan.transactions[0]?.data as string).args[0] as string[]
    expect(calls.map((c) => decode(npmIface, c).name)).toEqual(['decreaseLiquidity', 'collect', 'unwrapWETH9', 'sweepToken', 'burn'])
    expect(decode(npmIface, calls[1] as string).args[0].recipient).toBe(ZERO)
    expect(decode(npmIface, calls[3] as string).args[0]).toBe(USDC)
    // 部分移除不能销毁；不是所有者报错
    await expect(buildRemoveLiquidity(provider, USER, { position: { protocol: 'uniswap-v3', tokenId: 1 }, percent: 50, burn: true })).rejects.toThrow(/whole position/)
    await expect(buildRemoveLiquidity(provider, OTHER, { position: { protocol: 'uniswap-v3', tokenId: 1 } })).rejects.toThrow(/not the owner/)
    // setApprovalForAll 授权的 operator 可以管理（与合约一致）
    const byVault = await buildRemoveLiquidity(provider, VAULT, { position: { protocol: 'uniswap-v3', tokenId: 1 }, percent: 50 })
    expect(byVault.owner).toBe(VAULT)
  })

  it('领取手续费：只有 collect；没有手续费时报错', async () => {
    const plan = await buildCollectFees(setup(), USER, { position: { protocol: 'uniswap-v3', tokenId: 1 } })
    expect(plan.action).toBe('collect')
    expect(decode(npmIface, plan.transactions[0]?.data as string).name).toBe('collect')
    await expect(buildCollectFees(setup(), USER, { position: { pool: PAIR } })).rejects.toThrow(/V2 has no separate fees/)
  })
})

describe('V4', () => {
  const coder = AbiCoder.defaultAbiCoder()
  const actionsOf = (data: string) => {
    const tx = decode(pmIface, data)
    const modify = tx.name === 'multicall' ? decode(pmIface, (tx.args[0] as string[])[1] as string) : tx
    const [actions] = coder.decode(['bytes', 'bytes[]'], modify.args[0] as string)
    return [...Buffer.from((actions as string).slice(2), 'hex')]
  }

  it('新建主币池子的仓位：MINT_POSITION + SETTLE_PAIR + SWEEP，附带 amount0Max；USDC 经 Permit2 授权', async () => {
    const plan = await buildAddLiquidity(setup(), USER, { protocol: 'uniswap-v4', tokenA: USDC, tokenB: NATIVE_TOKEN, fee: 500, fullRange: true, amountAFormatted: '2000' })
    expect(plan).toMatchObject({ version: 'v4', native: 'token0', createPool: false, pool: poolIdOf({ currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10, hooks: ZERO }) })
    expect(plan.token0.native).toBe(true)
    expect(plan.value).toBe(plan.amount0Max)
    expect(BigInt(plan.amount0Max as string)).toBeGreaterThan(BigInt(plan.amount0))
    expect(plan.transactions.map((t) => [t.kind, t.spender])).toEqual([
      ['approve', PERMIT2_ADDRESS],
      ['permit2', getAddress(UNI_V4.positionManager as string)],
      ['add', undefined],
    ])
    const permit = decode(permit2Iface, plan.transactions[1]?.data as string)
    expect(permit.args[2]).toBe(BigInt(plan.amount1Max as string))
    expect(Number(permit.args[3])).toBeGreaterThan(plan.deadline)
    expect(actionsOf(plan.transactions[2]?.data as string)).toEqual([0x02, 0x0d, 0x14])
  })

  it('Permit2 额度够且没过期时不再授权；过期了要重新授权', async () => {
    const far = BigInt(Math.floor(Date.now() / 1000) + 86400)
    const ok = setup({ allowances: { [`USDC:${PERMIT2_ADDRESS.toLowerCase()}`]: MaxUint256 }, permit2: [10n ** 30n, far] })
    const plan = await buildAddLiquidity(ok, USER, { protocol: 'uniswap-v4', tokenA: USDC, tokenB: NATIVE_TOKEN, fee: 500, fullRange: true, amountAFormatted: '1' })
    expect(plan.transactions.map((t) => t.kind)).toEqual(['add'])
    const expired = setup({ allowances: { [`USDC:${PERMIT2_ADDRESS.toLowerCase()}`]: MaxUint256 }, permit2: [10n ** 30n, 1n] })
    const again = await buildAddLiquidity(expired, USER, { protocol: 'uniswap-v4', tokenA: USDC, tokenB: NATIVE_TOKEN, fee: 500, fullRange: true, amountAFormatted: '1' })
    expect(again.transactions.map((t) => t.kind)).toEqual(['permit2', 'add'])
  })

  it('池子没初始化：要 initialPrice，multicall(initializePool, modifyLiquidities)；没有默认 tickSpacing 的档位要传', async () => {
    const provider = setup({ v4Price: 0n })
    await expect(buildAddLiquidity(provider, USER, { protocol: 'uniswap-v4', tokenA: USDC, tokenB: NATIVE_TOKEN, fee: 500, fullRange: true, amountAFormatted: '1' })).rejects.toThrow(/initialPrice/)
    const plan = await buildAddLiquidity(provider, USER, { protocol: 'uniswap-v4', tokenA: USDC, tokenB: NATIVE_TOKEN, fee: 500, fullRange: true, amountAFormatted: '1', initialPrice: '0.0005' })
    expect(plan.createPool).toBe(true)
    const tx = decode(pmIface, plan.transactions[plan.transactions.length - 1]?.data as string)
    expect(tx.name).toBe('multicall')
    expect(decode(pmIface, (tx.args[0] as string[])[0] as string).name).toBe('initializePool')
    await expect(buildAddLiquidity(provider, USER, { protocol: 'uniswap-v4', tokenA: USDC, tokenB: NATIVE_TOKEN, fee: 1234, fullRange: true, amountAFormatted: '1' })).rejects.toThrow(/tickSpacing/)
  })

  it('追加：INCREASE_LIQUIDITY + CLOSE_CURRENCY × 2 + SWEEP；会自动领取手续费', async () => {
    const plan = await buildAddLiquidity(setup(), USER, { position: { protocol: 'uniswap-v4', tokenId: 5 }, amount1Formatted: '10' })
    expect(plan.fees0).toBe(String((10n ** 12n * 2n * Q128) / Q128))
    expect(actionsOf(plan.transactions[plan.transactions.length - 1]?.data as string)).toEqual([0x00, 0x12, 0x12, 0x14])
  })

  it('移除：DECREASE_LIQUIDITY / BURN_POSITION + TAKE_PAIR；领取：流动性 0 的 DECREASE', async () => {
    const half = await buildRemoveLiquidity(setup(), USER, { position: { protocol: 'uniswap-v4', tokenId: 5 }, percent: 50 })
    expect(half.liquidity).toBe(String(5n * 10n ** 11n))
    expect(actionsOf(half.transactions[0]?.data as string)).toEqual([0x01, 0x11])
    const all = await buildRemoveLiquidity(setup(), USER, { position: { protocol: 'uniswap-v4', tokenId: 5 }, burn: true })
    expect(actionsOf(all.transactions[0]?.data as string)).toEqual([0x03, 0x11])
    const collect = await buildCollectFees(setup(), USER, { position: { protocol: 'uniswap-v4', tokenId: 5 } })
    expect(collect.liquidity).toBe('0')
    expect(actionsOf(collect.transactions[0]?.data as string)).toEqual([0x01, 0x11])
    await expect(buildRemoveLiquidity(setup(), OTHER, { position: { protocol: 'uniswap-v4', tokenId: 5 } })).rejects.toThrow(/not the owner/)
    expect((await buildCollectFees(setup(), VAULT, { position: { protocol: 'uniswap-v4', tokenId: 5 } })).owner).toBe(VAULT)
  })
})

describe('参数检查', () => {
  it('amount 和 formatted 不能同时给；滑点、区间参数', async () => {
    const provider = setup()
    await expect(buildAddLiquidity(provider, USER, { protocol: 'uniswap-v2', tokenA: WETH, tokenB: USDC, amountA: 1n, amountAFormatted: '1' })).rejects.toThrow(/not both/)
    await expect(buildAddLiquidity(provider, USER, { protocol: 'uniswap-v2', tokenA: WETH, tokenB: USDC })).rejects.toThrow(/at least one/)
    await expect(buildAddLiquidity(provider, USER, { protocol: 'uniswap-v2', tokenA: WETH, tokenB: USDC, amountA: 1n }, { slippage: 1 })).rejects.toThrow(RangeError)
    await expect(buildAddLiquidity(provider, USER, { protocol: 'uniswap-v3', tokenA: WETH, tokenB: USDC, fee: 500, amountA: 1n })).rejects.toThrow(/exactly one of fullRange/)
    await expect(buildAddLiquidity(provider, USER, { protocol: 'uniswap-v3', tokenA: WETH, tokenB: USDC, fee: 500, tickLower: -15, tickUpper: 10, amountA: 1n })).rejects.toThrow(/multiple of tickSpacing/)
    await expect(buildAddLiquidity(provider, USER, { protocol: 'nope', tokenA: WETH, tokenB: USDC, amountA: 1n })).rejects.toThrow(/Unknown LP protocol/)
    await expect(buildRemoveLiquidity(provider, USER, { position: { tokenId: 1 } })).rejects.toThrow(/positionManager or protocol/)
    await expect(buildRemoveLiquidity(provider, USER, { position: { pool: V3_POOL, protocol: 'uniswap-v3' } })).rejects.toThrow(/tokenId is required/)
  })
})
