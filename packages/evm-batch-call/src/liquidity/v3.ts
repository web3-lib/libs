import { Interface } from 'ethers'

import type { LpPosition, LpProtocol, LpToken } from '../lp.js'
import { getAmountsForLiquidity, getFeeGrowthInside, getFeesEarned, getMinAmounts, getMintAmounts, getSqrtRatioAtTick, getTickAtSqrtRatio } from '../lpMath.js'
import { liquidityFor, resolveRange, sqrtPriceOf, v3MinAmounts } from './concentrated.js'
import {
  MAX_UINT128,
  ZERO_ADDRESS,
  approvals,
  concentratedProtocol,
  evm,
  isNative,
  makePlan,
  out,
  parseAmount,
  priceFields,
  removeAmount,
  tokenIdOf,
  tokenInfo,
  type Ctx,
} from './common.js'
import type { IncreaseLiquidityParams, LiquidityPlan, LiquidityTx, NewPositionParams, PositionRef, RemoveLiquidityParams } from './types.js'

const npmInterface = new Interface([
  'function WETH9() view returns (address)',
  'function factory() view returns (address)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function refundETH() payable',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function sweepToken(address token, uint256 amountMinimum, address recipient) payable',
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)',
])
const factoryInterface = new Interface([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
  'function feeAmountTickSpacing(uint24 fee) view returns (int24)',
])
// 只声明前两个返回值：各分叉 slot0 后面的字段类型不同
const poolInterface = new Interface([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick)',
  'function tickSpacing() view returns (int24)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128)',
])

const U128_MASK = MAX_UINT128

interface V3Pool {
  address: string | null
  sqrtPriceX96: bigint
  tick: number
  tickSpacing: number
}

interface V3Position {
  protocol: LpProtocol
  npm: string
  tokenId: bigint
  owner: string
  operator: string
  /** 发送者是不是被所有者 setApprovalForAll 授权的 operator */
  approvedForAll: boolean
  token0: string
  token1: string
  fee: number
  tickLower: number
  tickUpper: number
  liquidity: bigint
  pool: V3Pool & { address: string }
  /** 未领取的手续费（含 tokensOwed） */
  fees0: bigint
  fees1: bigint
}

async function factoryOf(ctx: Ctx, protocol: LpProtocol): Promise<string> {
  if (protocol.factory) {
    return evm(protocol.factory)
  }
  return evm((await ctx.provider.call(ctx.provider.contract(protocol.positionManager as string, npmInterface).factory())) as string)
}

const wethOf = async (ctx: Ctx, npm: string) => evm((await ctx.provider.call(ctx.provider.contract(npm, npmInterface).WETH9())) as string)

/** 读已有的仓位：仓位信息、池子状态、未领取的手续费 */
async function readPosition(ctx: Ctx, ref: PositionRef | LpPosition): Promise<V3Position> {
  const protocol = concentratedProtocol(ctx, ref)
  const npm = evm(protocol.positionManager as string)
  const tokenId = tokenIdOf(ref)
  const c = ctx.provider.contract(npm, npmInterface)
  const [factory, [owner, p]] = await Promise.all([
    factoryOf(ctx, protocol),
    ctx.provider.all([c.ownerOf(tokenId), c.positions(tokenId)]) as Promise<
      [
        string,
        {
          operator: string
          token0: string
          token1: string
          fee: bigint
          tickLower: bigint
          tickUpper: bigint
          liquidity: bigint
          feeGrowthInside0LastX128: bigint
          feeGrowthInside1LastX128: bigint
          tokensOwed0: bigint
          tokensOwed1: bigint
        },
      ]
    >,
  ])
  const pool = evm((await ctx.provider.call(ctx.provider.contract(factory, factoryInterface).getPool(p.token0, p.token1, p.fee))) as string)
  if (pool === ZERO_ADDRESS) {
    throw new Error(`Cannot find the pool of position ${tokenId}`)
  }
  const tickLower = Number(p.tickLower)
  const tickUpper = Number(p.tickUpper)
  const pc = ctx.provider.contract(pool, poolInterface)
  const [slot0, spacing, global0, global1, lower, upper, approvedForAll] = (await ctx.provider.all([
    pc.slot0(),
    pc.tickSpacing(),
    pc.feeGrowthGlobal0X128(),
    pc.feeGrowthGlobal1X128(),
    pc.ticks(tickLower),
    pc.ticks(tickUpper),
    c.isApprovedForAll(owner, ctx.owner),
  ])) as [{ 0: bigint; 1: bigint }, bigint, bigint, bigint, { 2: bigint; 3: bigint }, { 2: bigint; 3: bigint }, boolean]
  const tick = Number(slot0[1])
  const inside0 = getFeeGrowthInside(tick, tickLower, tickUpper, global0, lower[2], upper[2])
  const inside1 = getFeeGrowthInside(tick, tickLower, tickUpper, global1, lower[3], upper[3])
  return {
    protocol,
    npm,
    tokenId,
    owner: evm(owner),
    operator: evm(p.operator),
    approvedForAll,
    token0: evm(p.token0),
    token1: evm(p.token1),
    fee: Number(p.fee),
    tickLower,
    tickUpper,
    liquidity: p.liquidity,
    pool: { address: pool, sqrtPriceX96: slot0[0], tick, tickSpacing: Number(spacing) },
    // 与仓位合约一致：tokensOwed += uint128(新增)，按 uint128 回绕
    fees0: (p.tokensOwed0 + (getFeesEarned(p.liquidity, inside0, p.feeGrowthInside0LastX128) & U128_MASK)) & U128_MASK,
    fees1: (p.tokensOwed1 + (getFeesEarned(p.liquidity, inside1, p.feeGrowthInside1LastX128) & U128_MASK)) & U128_MASK,
  }
}

/** 追加 / 移除 / 领取需要是仓位的所有者，或被授权的 operator（单个仓位的 approve 或 setApprovalForAll），与合约一致 */
function assertCanManage(ctx: Ctx, position: V3Position): void {
  if (position.owner !== ctx.owner && position.operator !== ctx.owner && !position.approvedForAll) {
    throw new Error(`${out(ctx, ctx.owner)} is not the owner of position ${position.tokenId} (owner: ${out(ctx, position.owner)})`)
  }
}

/** 包装币那一边用主币时：确认池子里有包装币 */
async function nativeWeth(ctx: Ctx, npm: string, token0: string, token1: string): Promise<string | null> {
  if (!ctx.options.native) {
    return null
  }
  const weth = await wethOf(ctx, npm)
  if (weth !== token0 && weth !== token1) {
    throw new Error('native: true needs one side of the pool to be the wrapped native token')
  }
  return weth
}

const call = (name: string, args: unknown[]) => npmInterface.encodeFunctionData(name, args)
/** 一个调用直接发，多个用仓位合约的 multicall 合成一笔 */
const wrap = (calls: string[]) => (calls.length === 1 ? (calls[0] as string) : npmInterface.encodeFunctionData('multicall', [calls]))

export async function v3Add(ctx: Ctx, params: IncreaseLiquidityParams | NewPositionParams): Promise<LiquidityPlan> {
  let protocol: LpProtocol
  let npm: string
  let token0: string
  let token1: string
  let fee: number
  let pool: V3Pool
  let tickLower: number
  let tickUpper: number
  let tokenId: bigint | null = null
  let createPrice: bigint | null = null
  let weth: string | null
  let t0: LpToken
  let t1: LpToken
  let given0: bigint | undefined
  let given1: bigint | undefined

  if ('position' in params) {
    const position = await readPosition(ctx, params.position)
    // 合约允许任何人往别人的仓位里加流动性：tokenId 写错时代币会白送给别人，这里只允许所有者 / operator
    assertCanManage(ctx, position)
    ;({ protocol, npm, token0, token1, fee, pool, tickLower, tickUpper } = position)
    tokenId = position.tokenId
    weth = await nativeWeth(ctx, npm, token0, token1)
    ;[t0, t1] = (await tokenInfo(ctx, [token0, token1])) as [LpToken, LpToken]
    given0 = parseAmount(params.amount0, params.amount0Formatted, t0, 'amount0')
    given1 = parseAmount(params.amount1, params.amount1Formatted, t1, 'amount1')
  } else {
    protocol = params.protocol as LpProtocol
    npm = evm(protocol.positionManager as string)
    if (params.fee === undefined) {
      throw new Error('fee is required for V3 (e.g. 500, 3000, 10000)')
    }
    fee = params.fee
    let a = evm(params.tokenA)
    let b = evm(params.tokenB)
    weth = null
    if (isNative(ctx, a) || isNative(ctx, b) || ctx.options.native) {
      weth = await wethOf(ctx, npm)
      a = isNative(ctx, a) ? weth : a
      b = isNative(ctx, b) ? weth : b
      if (a !== weth && b !== weth) {
        throw new Error('native: true needs one side of the pool to be the wrapped native token')
      }
    }
    if (a === b) {
      throw new Error('tokenA and tokenB must be different')
    }
    const aIs0 = BigInt(a) < BigInt(b)
    ;[token0, token1] = aIs0 ? [a, b] : [b, a]
    const factory = await factoryOf(ctx, protocol)
    const f = ctx.provider.contract(factory, factoryInterface)
    const [address, defaultSpacing] = (await ctx.provider.all([f.getPool(token0, token1, fee), f.feeAmountTickSpacing(fee)])) as [string, bigint]
    pool = { address: evm(address) === ZERO_ADDRESS ? null : evm(address), sqrtPriceX96: 0n, tick: 0, tickSpacing: Number(defaultSpacing) }
    if (pool.address) {
      const pc = ctx.provider.contract(pool.address, poolInterface)
      const [slot0, spacing] = (await ctx.provider.all([pc.slot0(), pc.tickSpacing()])) as [{ 0: bigint; 1: bigint }, bigint]
      pool = { ...pool, sqrtPriceX96: slot0[0], tick: Number(slot0[1]), tickSpacing: Number(spacing) }
    } else if (pool.tickSpacing <= 0) {
      throw new Error(`Fee tier ${fee} is not enabled on ${protocol.id}`)
    }
    ;[t0, t1] = (await tokenInfo(ctx, [token0, token1])) as [LpToken, LpToken]
    if (pool.sqrtPriceX96 === 0n) {
      // 池子不存在或还没初始化：用 initialPrice 创建
      if (params.initialPrice === undefined) {
        throw new Error(`The ${protocol.id} pool for this pair and fee ${fee} does not exist yet; pass initialPrice to create it`)
      }
      createPrice = sqrtPriceOf(params.initialPrice, aIs0, t0, t1, 'initialPrice')
      pool = { ...pool, sqrtPriceX96: createPrice, tick: getTickAtSqrtRatio(createPrice) }
    }
    ;[tickLower, tickUpper] = resolveRange(params, aIs0, t0, t1, pool.tickSpacing)
    const amountA = parseAmount(params.amountA, params.amountAFormatted, aIs0 ? t0 : t1, 'amountA')
    const amountB = parseAmount(params.amountB, params.amountBFormatted, aIs0 ? t1 : t0, 'amountB')
    ;[given0, given1] = aIs0 ? [amountA, amountB] : [amountB, amountA]
  }

  const liquidity = liquidityFor(pool.sqrtPriceX96, tickLower, tickUpper, given0, given1, t0, t1)
  const [amount0, amount1] = getMintAmounts(pool.sqrtPriceX96, getSqrtRatioAtTick(tickLower), getSqrtRatioAtTick(tickUpper), liquidity)
  // 传给合约的数量：给了的按给的，另一边按算出来的（合约按两边较少的算流动性，结果就是上面的 liquidity）。
  // 价格在区间外时用不到的一边为 0（不用授权 / 附带主币）
  const desired0 = amount0 === 0n ? 0n : (given0 ?? amount0)
  const desired1 = amount1 === 0n ? 0n : (given1 ?? amount1)
  const [min0, min1] = v3MinAmounts(pool.sqrtPriceX96, tickLower, tickUpper, desired0, desired1, ctx.slippage)

  const calls: string[] = []
  if (createPrice !== null) {
    calls.push(call('createAndInitializePoolIfNecessary', [token0, token1, fee, createPrice]))
  }
  if (tokenId === null) {
    calls.push(call('mint', [{ token0, token1, fee, tickLower, tickUpper, amount0Desired: desired0, amount1Desired: desired1, amount0Min: min0, amount1Min: min1, recipient: ctx.recipient, deadline: ctx.deadline }]))
  } else {
    calls.push(call('increaseLiquidity', [{ tokenId, amount0Desired: desired0, amount1Desired: desired1, amount0Min: min0, amount1Min: min1, deadline: ctx.deadline }]))
  }
  // 主币：附带包装币那一边的数量，多余的退回
  const value = weth === token0 ? desired0 : weth === token1 ? desired1 : 0n
  if (value > 0n) {
    calls.push(call('refundETH', []))
  }
  const main: LiquidityTx = { kind: 'add', to: out(ctx, npm), data: wrap(calls), value: value.toString() }
  const approve = await approvals(
    ctx,
    [
      { token: token0, spender: npm, amount: desired0 },
      { token: token1, spender: npm, amount: desired1 },
    ].filter((i) => i.token !== weth),
  )
  return makePlan(ctx, {
    action: 'add',
    version: 'v3',
    protocol: protocol.id,
    protocolName: protocol.name,
    pool: pool.address,
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
    amount0Max: desired0.toString(),
    amount1Max: desired1.toString(),
    amount0Min: null,
    amount1Min: null,
    // V3 追加流动性不会领取手续费（留在仓位里）
    fees0: '0',
    fees1: '0',
    native: weth === null ? null : weth === token0 ? 'token0' : 'token1',
    value: value.toString(),
    transactions: [...approve, main],
  })
}

/** 移除（liquidity > 0）/ 只领取手续费（collectOnly） */
export async function v3Remove(ctx: Ctx, params: RemoveLiquidityParams, collectOnly = false): Promise<LiquidityPlan> {
  const position = await readPosition(ctx, params.position)
  assertCanManage(ctx, position)
  const { npm, token0, token1, tickLower, tickUpper, tokenId, pool } = position
  let liquidity = 0n
  if (!collectOnly) {
    if (position.liquidity === 0n) {
      throw new Error(`Position ${tokenId} has no liquidity; use collectFees to collect what is owed`)
    }
    liquidity = removeAmount(position.liquidity, params.percent, params.liquidity)
  } else if (position.fees0 === 0n && position.fees1 === 0n) {
    throw new Error(`Position ${tokenId} has no fees to collect`)
  }
  const burn = !collectOnly && !!params.burn
  if (burn && liquidity !== position.liquidity) {
    throw new Error('burn: true needs the whole position to be removed')
  }
  const weth = await nativeWeth(ctx, npm, token0, token1)
  const [t0, t1] = (await tokenInfo(ctx, [token0, token1])) as [LpToken, LpToken]
  const sqrtA = getSqrtRatioAtTick(tickLower)
  const sqrtB = getSqrtRatioAtTick(tickUpper)
  const [amount0, amount1] = getAmountsForLiquidity(pool.sqrtPriceX96, sqrtA, sqrtB, liquidity)
  const [min0, min1] = getMinAmounts(pool.sqrtPriceX96, sqrtA, sqrtB, liquidity, ctx.slippage)

  const calls: string[] = []
  if (liquidity > 0n) {
    calls.push(call('decreaseLiquidity', [{ tokenId, liquidity, amount0Min: min0, amount1Min: min1, deadline: ctx.deadline }]))
  }
  // 撤出的代币和手续费都要 collect 才会转出；包装币换成主币时先收到仓位合约（零地址）再转出
  calls.push(call('collect', [{ tokenId, recipient: weth ? ZERO_ADDRESS : ctx.recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }]))
  if (weth) {
    calls.push(call('unwrapWETH9', [0n, ctx.recipient]))
    calls.push(call('sweepToken', [weth === token0 ? token1 : token0, 0n, ctx.recipient]))
  }
  if (burn) {
    calls.push(call('burn', [tokenId]))
  }
  return makePlan(ctx, {
    action: collectOnly ? 'collect' : 'remove',
    version: 'v3',
    protocol: position.protocol.id,
    protocolName: position.protocol.name,
    pool: pool.address,
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
    native: weth === null ? null : weth === token0 ? 'token0' : 'token1',
    value: '0',
    transactions: [{ kind: collectOnly ? 'collect' : 'remove', to: out(ctx, npm), data: wrap(calls), value: '0' }],
  })
}
