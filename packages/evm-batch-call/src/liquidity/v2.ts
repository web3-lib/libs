import { Interface } from 'ethers'

import { LP_PROTOCOLS, type LpPosition, type LpProtocol, type LpToken } from '../lp.js'
import { sqrtBigInt } from '../lpMath.js'
import { ZERO_ADDRESS, approvals, evm, isNative, makePlan, minus, out, parseAmount, protocolById, removeAmount, same, tokenInfo, type Ctx } from './common.js'
import type { IncreaseLiquidityParams, LiquidityPlan, LiquidityTx, NewPositionParams, PositionRef, RemoveLiquidityParams } from './types.js'

const routerInterface = new Interface([
  'function WETH() view returns (address)',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
  'function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256 amountToken, uint256 amountETH)',
])
const factoryInterface = new Interface(['function getPair(address tokenA, address tokenB) view returns (address)', 'function feeTo() view returns (address)'])
const pairInterface = new Interface([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function factory() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function kLast() view returns (uint256)',
])

/** UniswapV2Pair.MINIMUM_LIQUIDITY：第一次添加时锁定的 LP 代币 */
const MINIMUM_LIQUIDITY = 1000n

interface PairState {
  protocol: LpProtocol
  router: string
  pair: string | null
  token0: string
  token1: string
  reserve0: bigint
  reserve1: bigint
  /** LP 总量，已加上下一次添加 / 移除前会先给 feeTo 增发的协议手续费（_mintFee） */
  totalSupply: bigint
  balance: bigint
}

/**
 * UniswapV2Pair._mintFee：协议手续费开启（factory.feeTo 不为零）时，每次添加 / 移除前先按 √k 的增长给 feeTo 增发 LP，
 * 按份额算数量时要用增发后的总量。比例按 LpProtocol.protocolFee，没填时按 8/25（增发得多、算出的数量偏少，最小值更宽松，不会因此 revert）
 */
function protocolFeeMint(protocol: LpProtocol, totalSupply: bigint, reserve0: bigint, reserve1: bigint, kLast: bigint): bigint {
  if (kLast === 0n || totalSupply === 0n) {
    return 0n
  }
  const rootK = sqrtBigInt(reserve0 * reserve1)
  const rootKLast = sqrtBigInt(kLast)
  if (rootK <= rootKLast) {
    return 0n
  }
  return protocol.protocolFee === '1/6'
    ? (totalSupply * (rootK - rootKLast)) / (rootK * 5n + rootKLast)
    : (totalSupply * (rootK - rootKLast) * 8n) / (rootK * 17n + rootKLast * 8n)
}

function routerOf(protocol: LpProtocol): string {
  if (!protocol.router) {
    throw new Error(`Protocol ${protocol.id} has no router; set router on its LpProtocol`)
  }
  return evm(protocol.router)
}

/** 读池子：储备、总量、owner 持有的 LP；协议没给时按池子的 factory 找（Router）。已知协议时协议手续费的状态一并读 */
async function readPair(ctx: Ctx, pair: string, protocol?: LpProtocol): Promise<PairState> {
  const c = ctx.provider.contract(pair, pairInterface)
  const feeToCall = (factory: string) => ctx.provider.contract(factory, factoryInterface).feeTo()
  // kLast / feeTo 有的分叉没有：一起用 tryAll 读，读不到按没开启协议手续费
  const first = (await ctx.provider.tryAll([
    c.token0(),
    c.token1(),
    c.factory(),
    c.getReserves(),
    c.totalSupply(),
    c.balanceOf(ctx.owner),
    c.kLast(),
    ...(protocol?.factory ? [feeToCall(protocol.factory)] : []),
  ])) as [string | null, string | null, string | null, { 0: bigint; 1: bigint } | null, bigint | null, bigint | null, bigint | null, (string | null)?]
  const [token0, token1, factory, reserves, totalSupply, balance, kLast] = first
  if (!token0 || !token1 || !factory || !reserves || totalSupply === null || balance === null) {
    throw new Error(`${out(ctx, pair)} is not a V2 pool`)
  }
  const found =
    protocol ??
    [...(ctx.options.protocols ?? []), ...LP_PROTOCOLS].find((p) => p.chainId === ctx.chainId && p.version === 'v2' && p.factory && same(p.factory, factory))
  if (!found) {
    throw new Error(`Unknown V2 factory ${out(ctx, evm(factory))} of pool ${out(ctx, pair)}; pass its LpProtocol (with router) in options.protocols`)
  }
  if (protocol?.factory && !same(protocol.factory, factory)) {
    throw new Error(`Pool ${out(ctx, pair)} does not belong to ${protocol.id}`)
  }
  const feeTo = protocol?.factory ? (first[7] ?? null) : ((await ctx.provider.tryAll([feeToCall(factory)])) as [string | null])[0]
  const feeOn = feeTo !== null && evm(feeTo) !== ZERO_ADDRESS
  const minted = feeOn ? protocolFeeMint(found, totalSupply, reserves[0], reserves[1], kLast ?? 0n) : 0n
  return {
    protocol: found,
    router: routerOf(found),
    pair,
    token0: evm(token0),
    token1: evm(token1),
    reserve0: reserves[0],
    reserve1: reserves[1],
    totalSupply: totalSupply + minted,
    balance,
  }
}

/** 仓位上带的协议：LpProtocol 对象直接用；协议 id 按内置表 / options.protocols 找（getLpPositions 里不认识的工厂是 'v2:<工厂>'，按工厂找） */
function refProtocol(ctx: Ctx, ref: PositionRef | LpPosition): LpProtocol | undefined {
  if (!ref.protocol || (typeof ref.protocol === 'string' && ref.protocol.startsWith('v2:'))) {
    return undefined
  }
  const protocol = protocolById(ctx, ref.protocol)
  if (protocol.version !== 'v2') {
    throw new Error(`${protocol.id} is not a V2 protocol`)
  }
  return protocol
}

const wethOf = async (ctx: Ctx, router: string) => evm((await ctx.provider.call(ctx.provider.contract(router, routerInterface).WETH())) as string)

/** UniswapV2Library.quote：按储备比例换算 */
const quote = (amountA: bigint, reserveA: bigint, reserveB: bigint) => (amountA * reserveB) / reserveA

export async function v2Add(ctx: Ctx, params: IncreaseLiquidityParams | NewPositionParams): Promise<LiquidityPlan> {
  let state: PairState
  /** 新建时 tokenA 是不是 token0；往已有仓位追加时为 null（数量直接按 token0 / token1） */
  let aIs0: boolean | null = null
  let native = ctx.options.native ?? false
  /** Router 的包装币（用主币时才读） */
  let weth: string | null = null

  if ('position' in params) {
    const ref = params.position as PositionRef | LpPosition
    if (!ref.pool) {
      throw new Error('V2 position needs pool')
    }
    state = await readPair(ctx, evm(ref.pool), refProtocol(ctx, ref))
  } else {
    const protocol = params.protocol as LpProtocol
    const router = routerOf(protocol)
    let a = evm(params.tokenA)
    let b = evm(params.tokenB)
    if (isNative(ctx, a) || isNative(ctx, b)) {
      // 主币：换成 Router 的包装币，用主币支付
      const wrapped = await wethOf(ctx, router)
      a = isNative(ctx, a) ? wrapped : a
      b = isNative(ctx, b) ? wrapped : b
      weth = wrapped
      native = true
    }
    if (a === b) {
      throw new Error('tokenA and tokenB must be different')
    }
    if (!protocol.factory) {
      throw new Error(`Protocol ${protocol.id} has no factory; set factory on its LpProtocol`)
    }
    const pair = evm((await ctx.provider.call(ctx.provider.contract(protocol.factory, factoryInterface).getPair(a, b))) as string)
    if (pair === ZERO_ADDRESS) {
      // 池子还不存在：Router 添加时会创建
      const [token0, token1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a]
      state = { protocol, router, pair: null, token0, token1, reserve0: 0n, reserve1: 0n, totalSupply: 0n, balance: 0n }
    } else {
      state = await readPair(ctx, pair, protocol)
    }
    aIs0 = a === state.token0
  }

  const { router, token0, token1, reserve0, reserve1, totalSupply } = state
  // 代币信息和（往已有仓位用主币追加时）包装币地址互不依赖，一起读
  const [tokens, wrapped] = await Promise.all([tokenInfo(ctx, [token0, token1]), native && !weth ? wethOf(ctx, router) : Promise.resolve(weth)])
  const [t0, t1] = tokens as [LpToken, LpToken]
  weth = wrapped
  let given0: bigint | undefined
  let given1: bigint | undefined
  if (aIs0 === null) {
    const p = params as IncreaseLiquidityParams
    given0 = parseAmount(p.amount0, p.amount0Formatted, t0, 'amount0')
    given1 = parseAmount(p.amount1, p.amount1Formatted, t1, 'amount1')
  } else {
    const p = params as NewPositionParams
    const amountA = parseAmount(p.amountA, p.amountAFormatted, aIs0 ? t0 : t1, 'amountA')
    const amountB = parseAmount(p.amountB, p.amountBFormatted, aIs0 ? t1 : t0, 'amountB')
    ;[given0, given1] = aIs0 ? [amountA, amountB] : [amountB, amountA]
  }
  if (given0 === undefined && given1 === undefined) {
    throw new Error('Pass the amount of at least one token')
  }

  // 主币：其中一边必须是包装币
  if (native) {
    weth ??= await wethOf(ctx, router)
    if (weth !== token0 && weth !== token1) {
      throw new Error('native: true needs one side of the pool to be the wrapped native token')
    }
  }

  // 传给 Router 的数量（desired）：给了的按给的，另一边按储备比例
  let desired0: bigint
  let desired1: bigint
  const empty = reserve0 === 0n && reserve1 === 0n
  if (!empty && (reserve0 === 0n || reserve1 === 0n)) {
    throw new Error(`Pool ${out(ctx, state.pair as string)} has one empty reserve; liquidity cannot be added at a meaningful price`)
  }
  if (empty) {
    if (!given0 || !given1) {
      throw new Error('The pool is empty: pass the amounts of both tokens (they set the initial price)')
    }
    ;[desired0, desired1] = [given0, given1]
  } else {
    desired0 = given0 ?? quote(given1 as bigint, reserve1, reserve0)
    desired1 = given1 ?? quote(given0 as bigint, reserve0, reserve1)
  }
  // 实际用掉的数量：与 Router 的 _addLiquidity 一致（A 是 addLiquidity 的第一个代币；addLiquidityETH 的 A 是非包装币那一边）。
  // 先按 A 算 B 的最优数量，超出 B 的 desired 时反过来按 B 算 A
  let amount0 = desired0
  let amount1 = desired1
  if (!empty) {
    const aIsToken0 = weth !== token0
    const [dA, dB, rA, rB] = aIsToken0 ? [desired0, desired1, reserve0, reserve1] : [desired1, desired0, reserve1, reserve0]
    const optimalB = quote(dA, rA, rB)
    const [amountA, amountB] = optimalB <= dB ? [dA, optimalB] : [quote(dB, rB, rA), dB]
    ;[amount0, amount1] = aIsToken0 ? [amountA, amountB] : [amountB, amountA]
  }
  if (amount0 === 0n || amount1 === 0n) {
    throw new Error('Amount too small: one side rounds to 0')
  }
  const liquidity = totalSupply === 0n ? sqrtBigInt(amount0 * amount1) - MINIMUM_LIQUIDITY : minBig((amount0 * totalSupply) / reserve0, (amount1 * totalSupply) / reserve1)
  if (liquidity <= 0n) {
    throw new Error('Amount too small: no LP tokens would be minted')
  }

  // 最小值按实际会用掉的数量算（两边都给、比例与池子不同时，Router 会按较少的一边收取，那一边的最小值不能按给的数量算）
  const min0 = empty ? desired0 : minus(amount0, ctx.slippage)
  const min1 = empty ? desired1 : minus(amount1, ctx.slippage)
  let main: LiquidityTx
  let value = 0n
  if (weth) {
    const tokenIs0 = weth === token1
    const token = tokenIs0 ? token0 : token1
    // 附带的主币按 desired 给，没用完的 Router 会退回
    value = tokenIs0 ? desired1 : desired0
    main = {
      kind: 'add',
      to: out(ctx, router),
      data: routerInterface.encodeFunctionData('addLiquidityETH', [
        token,
        tokenIs0 ? desired0 : desired1,
        tokenIs0 ? min0 : min1,
        tokenIs0 ? min1 : min0,
        ctx.recipient,
        ctx.deadline,
      ]),
      value: value.toString(),
    }
  } else {
    main = {
      kind: 'add',
      to: out(ctx, router),
      data: routerInterface.encodeFunctionData('addLiquidity', [token0, token1, desired0, desired1, min0, min1, ctx.recipient, ctx.deadline]),
      value: '0',
    }
  }
  const approve = await approvals(
    ctx,
    [
      { token: token0, spender: router, amount: desired0 },
      { token: token1, spender: router, amount: desired1 },
    ].filter((i) => i.token !== weth),
  )
  return makePlan(ctx, {
    action: 'add',
    version: 'v2',
    protocol: state.protocol.id,
    protocolName: state.protocol.name,
    pool: state.pair,
    createPool: state.pair === null,
    token0: t0,
    token1: t1,
    tokenId: null,
    tickLower: null,
    tickUpper: null,
    tick: null,
    price: null,
    priceLower: null,
    priceUpper: null,
    liquidity: liquidity.toString(),
    amount0: amount0.toString(),
    amount1: amount1.toString(),
    amount0Max: desired0.toString(),
    amount1Max: desired1.toString(),
    amount0Min: null,
    amount1Min: null,
    fees0: '0',
    fees1: '0',
    native: weth === null ? null : weth === token0 ? 'token0' : 'token1',
    value: value.toString(),
    transactions: [...approve, main],
  })
}

export async function v2Remove(ctx: Ctx, params: RemoveLiquidityParams): Promise<LiquidityPlan> {
  const ref = params.position
  if (!ref.pool) {
    throw new Error('V2 position needs pool')
  }
  const state = await readPair(ctx, evm(ref.pool), refProtocol(ctx, ref))
  const { router, token0, token1, reserve0, reserve1, totalSupply, balance } = state
  if (balance === 0n) {
    throw new Error(`${out(ctx, ctx.owner)} holds no LP tokens of ${out(ctx, state.pair as string)}`)
  }
  const liquidity = removeAmount(balance, params.percent, params.liquidity)
  const [t0, t1] = (await tokenInfo(ctx, [token0, token1])) as [LpToken, LpToken]
  // 按份额取出（与 pair.burn 一致；总量已含先给 feeTo 增发的协议手续费）
  const amount0 = (liquidity * reserve0) / totalSupply
  const amount1 = (liquidity * reserve1) / totalSupply
  const min0 = minus(amount0, ctx.slippage)
  const min1 = minus(amount1, ctx.slippage)

  let weth: string | null = null
  if (ctx.options.native) {
    weth = await wethOf(ctx, router)
    if (weth !== token0 && weth !== token1) {
      throw new Error('native: true needs one side of the pool to be the wrapped native token')
    }
  }
  const tokenIs0 = weth === token1
  const main: LiquidityTx = {
    kind: 'remove',
    to: out(ctx, router),
    data: weth
      ? routerInterface.encodeFunctionData('removeLiquidityETH', [tokenIs0 ? token0 : token1, liquidity, tokenIs0 ? min0 : min1, tokenIs0 ? min1 : min0, ctx.recipient, ctx.deadline])
      : routerInterface.encodeFunctionData('removeLiquidity', [token0, token1, liquidity, min0, min1, ctx.recipient, ctx.deadline]),
    value: '0',
  }
  const approve = await approvals(ctx, [{ token: state.pair as string, spender: router, amount: liquidity }])
  return makePlan(ctx, {
    action: 'remove',
    version: 'v2',
    protocol: state.protocol.id,
    protocolName: state.protocol.name,
    pool: state.pair,
    createPool: false,
    token0: t0,
    token1: t1,
    tokenId: null,
    tickLower: null,
    tickUpper: null,
    tick: null,
    price: null,
    priceLower: null,
    priceUpper: null,
    liquidity: liquidity.toString(),
    amount0: amount0.toString(),
    amount1: amount1.toString(),
    amount0Max: null,
    amount1Max: null,
    amount0Min: min0.toString(),
    amount1Min: min1.toString(),
    fees0: '0',
    fees1: '0',
    native: weth === null ? null : weth === token0 ? 'token0' : 'token1',
    value: '0',
    transactions: [...approve, main],
  })
}

const minBig = (a: bigint, b: bigint) => (a < b ? a : b)
