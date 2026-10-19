import { lpPositions, type SolanaLpClmmPosition, type SolanaLpToken } from '../lp.js'
import {
  MAX_TICK,
  MIN_TICK,
  getLiquidityForAmounts,
  nearestUsableTick,
  priceToTick,
  sqrtPriceAtTick,
  sqrtPriceToPrice,
  tickToPrice,
  type ClmmProgram,
} from '../lpMath.js'
import type { Ctx } from './common.js'
import type { SolanaNewPositionParams } from './types.js'

/** 新建仓位的 tick 区间：fullRange / tickLower + tickUpper / priceLower + priceUpper（token1 / token0）三选一 */
export function resolveRange(program: ClmmProgram, params: SolanaNewPositionParams, token0: SolanaLpToken, token1: SolanaLpToken, tickSpacing: number): [number, number] {
  const byTicks = params.tickLower !== undefined || params.tickUpper !== undefined
  const byPrices = params.priceLower !== undefined || params.priceUpper !== undefined
  if (Number(!!params.fullRange) + Number(byTicks) + Number(byPrices) !== 1) {
    throw new Error('Pass exactly one of fullRange, tickLower + tickUpper, or priceLower + priceUpper')
  }
  let lower: number
  let upper: number
  if (params.fullRange) {
    lower = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing
    upper = Math.floor(MAX_TICK / tickSpacing) * tickSpacing
  } else if (byTicks) {
    if (params.tickLower === undefined || params.tickUpper === undefined) {
      throw new Error('Pass both tickLower and tickUpper')
    }
    lower = params.tickLower
    upper = params.tickUpper
    for (const tick of [lower, upper]) {
      if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK || tick % tickSpacing !== 0) {
        throw new RangeError(`tick ${tick} must be an integer multiple of tickSpacing ${tickSpacing} within [${MIN_TICK}, ${MAX_TICK}]`)
      }
    }
  } else {
    if (params.priceLower === undefined || params.priceUpper === undefined) {
      throw new Error('Pass both priceLower and priceUpper')
    }
    if (token0.decimals === null || token1.decimals === null) {
      throw new Error('Cannot read token decimals to convert prices; pass ticks instead')
    }
    const ticks = [params.priceLower, params.priceUpper].map((price) => {
      return nearestUsableTick(priceToTick(program, price, token0.decimals as number, token1.decimals as number), tickSpacing)
    }) as [number, number]
    ;[lower, upper] = ticks[0] <= ticks[1] ? ticks : [ticks[1], ticks[0]]
  }
  if (lower >= upper) {
    throw new RangeError(`The price range is too narrow: tickLower ${lower} must be below tickUpper ${upper} (tickSpacing ${tickSpacing})`)
  }
  return [lower, upper]
}

/** 按输入的数量算添加的流动性；价格在区间外时只需要一种代币，给错了另一种会报错 */
export function liquidityFor(
  program: ClmmProgram,
  tick: number,
  sqrtPrice: bigint,
  tickLower: number,
  tickUpper: number,
  amount0: bigint | undefined,
  amount1: bigint | undefined,
  token0: SolanaLpToken,
  token1: SolanaLpToken,
): bigint {
  const name = (t: SolanaLpToken) => t.symbol ?? t.mint
  if (amount0 === undefined && amount1 === undefined) {
    throw new Error('Pass the amount of at least one token')
  }
  if (amount1 === undefined && (tick >= tickUpper || sqrtPrice >= sqrtPriceAtTick(program, tickUpper))) {
    throw new Error(`The current price is above the range: the position takes only ${name(token1)} (token1); pass amount1 instead`)
  }
  if (amount0 === undefined && (tick < tickLower || sqrtPrice <= sqrtPriceAtTick(program, tickLower))) {
    throw new Error(`The current price is below the range: the position takes only ${name(token0)} (token0); pass amount0 instead`)
  }
  const liquidity = getLiquidityForAmounts(tick, sqrtPrice, sqrtPriceAtTick(program, tickLower), sqrtPriceAtTick(program, tickUpper), amount0, amount1, tickLower, tickUpper)
  if (liquidity === 0n) {
    throw new Error('Amount too small: the liquidity rounds to 0')
  }
  if (liquidity >= 1n << 128n) {
    throw new RangeError('Amount too large')
  }
  return liquidity
}

/** 计划里的价格字段（token1 / token0，按精度换算，只用于展示） */
export function priceInfo(tick: number, sqrtPrice: bigint, token0: SolanaLpToken, token1: SolanaLpToken, tickLower: number, tickUpper: number) {
  const known = token0.decimals !== null && token1.decimals !== null
  return {
    tick,
    price: known ? sqrtPriceToPrice(sqrtPrice, token0.decimals as number, token1.decimals as number) : null,
    priceLower: known ? tickToPrice(tickLower, token0.decimals as number, token1.decimals as number) : null,
    priceUpper: known ? tickToPrice(tickUpper, token0.decimals as number, token1.decimals as number) : null,
  }
}

/** 已有的仓位：用查询拿到数量、手续费、价格（要求 owner 持有仓位 NFT 的关联代币账户） */
export async function queryPosition(ctx: Ctx, protocol: 'raydium-clmm' | 'orca-whirlpool', positionMint: string): Promise<SolanaLpClmmPosition> {
  const list = await lpPositions(ctx.client, ctx.owner, { protocols: [protocol], mints: [positionMint], includeClosed: true, signal: ctx.signal })
  const found = list.find((p): p is SolanaLpClmmPosition => p.type === 'clmm' && p.positionMint === positionMint)
  if (!found) {
    throw new Error(`${ctx.owner} does not hold the ${protocol} position ${positionMint} (in its associated token account)`)
  }
  return found
}
