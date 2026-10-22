import { AbiCoder, Interface, hexlify } from 'ethers'

import type { LpPosition, LpProtocol, LpToken } from '../lp.js'
import { getAmountsForLiquidity, getFeesEarned, getMaxAmounts, getMinAmounts, getMintAmounts, getSqrtRatioAtTick, getTickAtSqrtRatio } from '../lpMath.js'
import { decodePositionInfo, poolIdOf } from '../lpV4.js'
import { liquidityFor, resolveRange, sqrtPriceOf } from './concentrated.js'
import {
  ZERO_ADDRESS,
  concentratedProtocol,
  evm,
  isNative,
  makePlan,
  parseAmount,
  permit2Approvals,
  priceFields,
  removeAmount,
  tokenIdOf,
  tokenInfo,
  type Ctx,
} from './common.js'
import type { IncreaseLiquidityParams, LiquidityPlan, NewPositionParams, PositionRef, RemoveLiquidityParams } from './types.js'

export const pmInterface = new Interface([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  'function initializePool((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) payable returns (int24)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
])
const stateViewInterface = new Interface([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)',
  'function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
])

/** v4-periphery 的 Actions */
export const Actions = {
  INCREASE_LIQUIDITY: 0x00,
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  SETTLE_PAIR: 0x0d,
  TAKE: 0x0e,
  TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12,
  SWEEP: 0x14,
} as const

/** 标准手续费档位对应的 tick 间距（与 Uniswap 网页一致） */
const DEFAULT_TICK_SPACING: Readonly<Record<number, number>> = { 100: 1, 500: 10, 3000: 60, 10000: 200 }

const coder = AbiCoder.defaultAbiCoder()
const POOL_KEY = 'tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)'

interface PoolKey {
  currency0: string
  currency1: string
  fee: number
  tickSpacing: number
  hooks: string
}

const keyTuple = (k: PoolKey) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]

/** 依次执行的 action 列表 → modifyLiquidities 的 unlockData */
export class Planner {
  readonly actions: number[] = []
  readonly params: string[] = []

  add(action: number, types: string[], values: unknown[]): this {
    this.actions.push(action)
    this.params.push(coder.encode(types, values))
    return this
  }

  encode(): string {
    return coder.encode(['bytes', 'bytes[]'], [hexlify(new Uint8Array(this.actions)), this.params])
  }
}

interface V4Pool {
  key: PoolKey
  poolId: string
  sqrtPriceX96: bigint
  tick: number
}

interface V4Position {
  protocol: LpProtocol
  pm: string
  stateView: string
  tokenId: bigint
  owner: string
  /** 发送者能不能管理这个仓位（所有者或被授权） */
  canManage: boolean
  pool: V4Pool
  tickLower: number
  tickUpper: number
  liquidity: bigint
  fees0: bigint
  fees1: bigint
}

function addresses(ctx: Ctx, protocol: LpProtocol): { pm: string; stateView: string } {
  if (ctx.tron) {
    throw new Error('Uniswap V4 is not supported on Tron')
  }
  if (!protocol.positionManager || !protocol.stateView) {
    throw new Error(`Protocol ${protocol.id} needs positionManager and stateView`)
  }
  return { pm: evm(protocol.positionManager), stateView: evm(protocol.stateView) }
}

async function readPosition(ctx: Ctx, ref: PositionRef | LpPosition): Promise<V4Position> {
  const protocol = concentratedProtocol(ctx, ref)
  const { pm, stateView } = addresses(ctx, protocol)
  const tokenId = tokenIdOf(ref)
  const c = ctx.provider.contract(pm, pmInterface)
  const [owner, info, liquidity] = (await ctx.provider.all([c.ownerOf(tokenId), c.getPoolAndPositionInfo(tokenId), c.getPositionLiquidity(tokenId)])) as [
    string,
    { 0: { currency0: string; currency1: string; fee: bigint; tickSpacing: bigint; hooks: string }; 1: bigint },
    bigint,
  ]
  const raw = info[0]
  const key: PoolKey = { currency0: evm(raw.currency0), currency1: evm(raw.currency1), fee: Number(raw.fee), tickSpacing: Number(raw.tickSpacing), hooks: evm(raw.hooks) }
  const poolId = poolIdOf(key)
  const { tickLower, tickUpper } = decodePositionInfo(info[1])
  const sv = ctx.provider.contract(stateView, stateViewInterface)
  const salt = `0x${tokenId.toString(16).padStart(64, '0')}`
  const [slot0, inside, last, approved, approvedForAll] = (await ctx.provider.all([
    sv.getSlot0(poolId),
    sv.getFeeGrowthInside(poolId, tickLower, tickUpper),
    sv.getPositionInfo(poolId, pm, tickLower, tickUpper, salt),
    c.getApproved(tokenId),
    c.isApprovedForAll(owner, ctx.owner),
  ])) as [{ 0: bigint; 1: bigint }, { 0: bigint; 1: bigint }, { 1: bigint; 2: bigint }, string, boolean]
  return {
    protocol,
    pm,
    stateView,
    tokenId,
    owner: evm(owner),
    // 与 PositionManager 的 onlyIfApproved 一致：所有者、单个仓位的 approve、setApprovalForAll 都可以
    canManage: evm(owner) === ctx.owner || evm(approved) === ctx.owner || approvedForAll,
    pool: { key, poolId, sqrtPriceX96: slot0[0], tick: Number(slot0[1]) },
    tickLower,
    tickUpper,
    liquidity,
    fees0: getFeesEarned(liquidity, inside[0], last[1]),
    fees1: getFeesEarned(liquidity, inside[1], last[2]),
  }
}

function assertOwner(ctx: Ctx, position: V4Position): void {
  if (!position.canManage) {
    throw new Error(`${ctx.owner} is not the owner of position ${position.tokenId} (owner: ${position.owner})`)
  }
}

const hookData = (ctx: Ctx) => (ctx.options.hookData ? hexlify(ctx.options.hookData) : '0x')

export async function v4Add(ctx: Ctx, params: IncreaseLiquidityParams | NewPositionParams): Promise<LiquidityPlan> {
  let protocol: LpProtocol
  let pm: string
  let pool: V4Pool
  let tickLower: number
  let tickUpper: number
  let tokenId: bigint | null = null
  let createPrice: bigint | null = null
  let fees: [bigint, bigint] = [0n, 0n]
  let t0: LpToken
  let t1: LpToken
  let given0: bigint | undefined
  let given1: bigint | undefined

  if ('position' in params) {
    const position = await readPosition(ctx, params.position)
    assertOwner(ctx, position)
    ;({ protocol, pm, pool, tickLower, tickUpper } = position)
    tokenId = position.tokenId
    fees = [position.fees0, position.fees1]
    ;[t0, t1] = (await tokenInfo(ctx, [pool.key.currency0, pool.key.currency1])) as [LpToken, LpToken]
    given0 = parseAmount(params.amount0, params.amount0Formatted, t0, 'amount0')
    given1 = parseAmount(params.amount1, params.amount1Formatted, t1, 'amount1')
  } else {
    protocol = params.protocol as LpProtocol
    const { pm: positionManager, stateView } = addresses(ctx, protocol)
    pm = positionManager
    if (params.fee === undefined) {
      throw new Error('fee is required for V4 (e.g. 500, 3000, 10000)')
    }
    const tickSpacing = params.tickSpacing ?? DEFAULT_TICK_SPACING[params.fee]
    if (tickSpacing === undefined) {
      throw new Error(`Pass tickSpacing: there is no default for fee ${params.fee}`)
    }
    // 主币是零地址，排在前面
    const a = isNative(ctx, params.tokenA) ? ZERO_ADDRESS : evm(params.tokenA)
    const b = isNative(ctx, params.tokenB) ? ZERO_ADDRESS : evm(params.tokenB)
    if (a === b) {
      throw new Error('tokenA and tokenB must be different')
    }
    const aIs0 = BigInt(a) < BigInt(b)
    const key: PoolKey = { currency0: aIs0 ? a : b, currency1: aIs0 ? b : a, fee: params.fee, tickSpacing, hooks: params.hooks ? evm(params.hooks) : ZERO_ADDRESS }
    const poolId = poolIdOf(key)
    const slot0 = (await ctx.provider.call(ctx.provider.contract(stateView, stateViewInterface).getSlot0(poolId))) as { 0: bigint; 1: bigint }
    pool = { key, poolId, sqrtPriceX96: slot0[0], tick: Number(slot0[1]) }
    ;[t0, t1] = (await tokenInfo(ctx, [key.currency0, key.currency1])) as [LpToken, LpToken]
    if (pool.sqrtPriceX96 === 0n) {
      if (params.initialPrice === undefined) {
        throw new Error('This V4 pool (currencies, fee, tickSpacing, hooks) is not initialized yet; pass initialPrice to create it')
      }
      createPrice = sqrtPriceOf(params.initialPrice, aIs0, t0, t1, 'initialPrice')
      pool = { ...pool, sqrtPriceX96: createPrice, tick: getTickAtSqrtRatio(createPrice) }
    }
    ;[tickLower, tickUpper] = resolveRange(params, aIs0, t0, t1, tickSpacing)
    const amountA = parseAmount(params.amountA, params.amountAFormatted, aIs0 ? t0 : t1, 'amountA')
    const amountB = parseAmount(params.amountB, params.amountBFormatted, aIs0 ? t1 : t0, 'amountB')
    ;[given0, given1] = aIs0 ? [amountA, amountB] : [amountB, amountA]
  }

  const { key } = pool
  const sqrtA = getSqrtRatioAtTick(tickLower)
  const sqrtB = getSqrtRatioAtTick(tickUpper)
  const liquidity = liquidityFor(pool.sqrtPriceX96, tickLower, tickUpper, given0, given1, t0, t1)
  const [amount0, amount1] = getMintAmounts(pool.sqrtPriceX96, sqrtA, sqrtB, liquidity)
  // V4 直接指定流动性，价格变动时需要的数量随之变化：按滑点给出上限
  const [max0, max1] = getMaxAmounts(pool.sqrtPriceX96, sqrtA, sqrtB, liquidity, ctx.slippage)
  const native = key.currency0 === ZERO_ADDRESS
  const planner = new Planner()
  if (tokenId === null) {
    planner.add(
      Actions.MINT_POSITION,
      [POOL_KEY, 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
      [keyTuple(key), tickLower, tickUpper, liquidity, max0, max1, ctx.recipient, hookData(ctx)],
    )
    planner.add(Actions.SETTLE_PAIR, ['address', 'address'], [key.currency0, key.currency1])
  } else {
    planner.add(Actions.INCREASE_LIQUIDITY, ['uint256', 'uint256', 'uint128', 'uint128', 'bytes'], [tokenId, liquidity, max0, max1, hookData(ctx)])
    // 追加时会自动领取手续费：手续费可能比要存入的多（差额为正），CLOSE_CURRENCY 按差额的正负自动付款或收款
    planner.add(Actions.CLOSE_CURRENCY, ['address'], [key.currency0])
    planner.add(Actions.CLOSE_CURRENCY, ['address'], [key.currency1])
  }
  if (native) {
    // 附带的主币按上限给，多余的退回
    planner.add(Actions.SWEEP, ['address', 'address'], [ZERO_ADDRESS, ctx.owner])
  }
  const modify = pmInterface.encodeFunctionData('modifyLiquidities', [planner.encode(), ctx.deadline])
  const data = createPrice === null ? modify : pmInterface.encodeFunctionData('multicall', [[pmInterface.encodeFunctionData('initializePool', [keyTuple(key), createPrice]), modify]])
  const value = native ? max0 : 0n
  const approve = await permit2Approvals(
    ctx,
    pm,
    [
      { token: key.currency0, amount: max0 },
      { token: key.currency1, amount: max1 },
    ].filter((i) => i.token !== ZERO_ADDRESS),
  )
  return makePlan(ctx, {
    action: 'add',
    version: 'v4',
    protocol: protocol.id,
    protocolName: protocol.name,
    pool: pool.poolId,
    createPool: createPrice !== null,
    token0: t0,
    token1: t1,
    tokenId: tokenId === null ? null : tokenId.toString(),
    tickLower,
    tickUpper,
    tick: pool.tick,
    ...priceFields(t0, t1, pool.sqrtPriceX96, tickLower, tickUpper),
    liquidity: liquidity.toString(),
    amount0: amount0.toString(),
    amount1: amount1.toString(),
    amount0Max: max0.toString(),
    amount1Max: max1.toString(),
    amount0Min: null,
    amount1Min: null,
    fees0: fees[0].toString(),
    fees1: fees[1].toString(),
    native: native ? 'token0' : null,
    value: value.toString(),
    transactions: [...approve, { kind: 'add', to: pm, data, value: value.toString() }],
  })
}

export async function v4Remove(ctx: Ctx, params: RemoveLiquidityParams, collectOnly = false): Promise<LiquidityPlan> {
  const position = await readPosition(ctx, params.position)
  assertOwner(ctx, position)
  const { pm, pool, tickLower, tickUpper, tokenId } = position
  const { key } = pool
  let liquidity = 0n
  if (!collectOnly) {
    if (position.liquidity === 0n) {
      throw new Error(`Position ${tokenId} has no liquidity`)
    }
    liquidity = removeAmount(position.liquidity, params.percent, params.liquidity)
  } else if (position.fees0 === 0n && position.fees1 === 0n) {
    throw new Error(`Position ${tokenId} has no fees to collect`)
  }
  const burn = !collectOnly && !!params.burn
  if (burn && liquidity !== position.liquidity) {
    throw new Error('burn: true needs the whole position to be removed')
  }
  const [t0, t1] = (await tokenInfo(ctx, [key.currency0, key.currency1])) as [LpToken, LpToken]
  const sqrtA = getSqrtRatioAtTick(tickLower)
  const sqrtB = getSqrtRatioAtTick(tickUpper)
  const [amount0, amount1] = getAmountsForLiquidity(pool.sqrtPriceX96, sqrtA, sqrtB, liquidity)
  const [min0, min1] = getMinAmounts(pool.sqrtPriceX96, sqrtA, sqrtB, liquidity, ctx.slippage)
  const planner = new Planner()
  if (burn) {
    planner.add(Actions.BURN_POSITION, ['uint256', 'uint128', 'uint128', 'bytes'], [tokenId, min0, min1, hookData(ctx)])
  } else {
    // 流动性为 0 时只领取手续费
    planner.add(Actions.DECREASE_LIQUIDITY, ['uint256', 'uint256', 'uint128', 'uint128', 'bytes'], [tokenId, liquidity, min0, min1, hookData(ctx)])
  }
  planner.add(Actions.TAKE_PAIR, ['address', 'address', 'address'], [key.currency0, key.currency1, ctx.recipient])
  const data = pmInterface.encodeFunctionData('modifyLiquidities', [planner.encode(), ctx.deadline])
  return makePlan(ctx, {
    action: collectOnly ? 'collect' : 'remove',
    version: 'v4',
    protocol: position.protocol.id,
    protocolName: position.protocol.name,
    pool: pool.poolId,
    createPool: false,
    token0: t0,
    token1: t1,
    tokenId: tokenId.toString(),
    tickLower,
    tickUpper,
    tick: pool.tick,
    ...priceFields(t0, t1, pool.sqrtPriceX96, tickLower, tickUpper),
    liquidity: liquidity.toString(),
    amount0: amount0.toString(),
    amount1: amount1.toString(),
    amount0Max: null,
    amount1Max: null,
    amount0Min: min0.toString(),
    amount1Min: min1.toString(),
    fees0: position.fees0.toString(),
    fees1: position.fees1.toString(),
    native: key.currency0 === ZERO_ADDRESS ? 'token0' : null,
    value: '0',
    transactions: [{ kind: collectOnly ? 'collect' : 'remove', to: pm, data, value: '0' }],
  })
}
