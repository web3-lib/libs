import type { LpToken } from '../lp.js'
import {
  MAX_TICK,
  MIN_TICK,
  clampedTickAtSqrtRatio,
  getLiquidityForAmount0,
  getLiquidityForAmount1,
  getLiquidityForAmounts,
  getMintAmounts,
  getSqrtRatioAtTick,
  nearestUsableTick,
  parseDecimal,
  ratioToSqrtPriceX96,
  sqrtPriceBounds,
  toUint128,
} from '../lpMath.js'
import type { NewPositionParams } from './types.js'

/**
 * 价格（tokenB / tokenA，按精度换算）→ 池子的 sqrtPriceX96（token1 / token0）。aIs0：tokenA 是不是 token0
 */
export function sqrtPriceOf(price: string | number, aIs0: boolean, token0: LpToken, token1: LpToken, name: string): bigint {
  if (token0.decimals === null || token1.decimals === null) {
    throw new Error(`Cannot read token decimals to convert ${name}; pass ticks instead`)
  }
  const { num, den } = parseDecimal(price)
  if (num === 0n) {
    throw new RangeError(`${name} must be greater than 0`)
  }
  // tokenA 是 token1 时取倒数
  return aIs0 ? ratioToSqrtPriceX96(num, den, token0.decimals, token1.decimals) : ratioToSqrtPriceX96(den, num, token0.decimals, token1.decimals)
}

/** 新建仓位的 tick 区间：fullRange / tickLower + tickUpper / priceLower + priceUpper 三选一 */
export function resolveRange(params: NewPositionParams, aIs0: boolean, token0: LpToken, token1: LpToken, tickSpacing: number): [number, number] {
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
    // tokenA 是 token1 时价格取倒数，区间两端也随之对调；下面按大小排序
    const ticks = [params.priceLower, params.priceUpper].map((price, i) => {
      return nearestUsableTick(clampedTickAtSqrtRatio(sqrtPriceOf(price, aIs0, token0, token1, i ? 'priceUpper' : 'priceLower')), tickSpacing)
    }) as [number, number]
    ;[lower, upper] = ticks[0] <= ticks[1] ? ticks : [ticks[1], ticks[0]]
  }
  if (lower >= upper) {
    throw new RangeError(`The price range is too narrow: tickLower ${lower} must be below tickUpper ${upper} (tickSpacing ${tickSpacing})`)
  }
  return [lower, upper]
}

/**
 * 按输入的数量算添加的流动性：两边都给时取较少的一边；只给一边时另一边按当前价格算。
 * 价格在区间外时只需要一种代币，给错了另一种会报错
 */
export function liquidityFor(sqrtPrice: bigint, tickLower: number, tickUpper: number, amount0: bigint | undefined, amount1: bigint | undefined, token0: LpToken, token1: LpToken): bigint {
  const sqrtA = getSqrtRatioAtTick(tickLower)
  const sqrtB = getSqrtRatioAtTick(tickUpper)
  const name = (t: LpToken) => t.symbol ?? t.address
  if (amount0 === undefined && amount1 === undefined) {
    throw new Error('Pass the amount of at least one token')
  }
  // 价格在区间外时只需要一种代币：给的是另一种（或需要的那种是 0）时说明要给哪种
  if (sqrtPrice >= sqrtB && !amount1) {
    throw new Error(`The current price is above the range: the position takes only ${name(token1)} (token1); pass its amount instead`)
  }
  if (sqrtPrice <= sqrtA && !amount0) {
    throw new Error(`The current price is below the range: the position takes only ${name(token0)} (token0); pass its amount instead`)
  }
  let liquidity: bigint
  if (amount0 !== undefined && amount1 !== undefined) {
    liquidity = getLiquidityForAmounts(sqrtPrice, sqrtA, sqrtB, amount0, amount1)
  } else if (amount0 !== undefined) {
    liquidity = getLiquidityForAmount0(sqrtPrice > sqrtA ? sqrtPrice : sqrtA, sqrtB, amount0)
  } else {
    liquidity = getLiquidityForAmount1(sqrtA, sqrtPrice < sqrtB ? sqrtPrice : sqrtB, amount1 as bigint)
  }
  if (liquidity === 0n) {
    throw new Error('Amount too small: the liquidity rounds to 0')
  }
  return toUint128(liquidity)
}

/**
 * V3：按传给仓位合约的数量（desired），价格在滑点范围内变动时至少会用掉多少（amountMin）。
 * 合约按当时的价格重新算流动性：token0 在价格最高时用得最少，token1 在最低时；取三个价格下的最小值
 */
export function v3MinAmounts(sqrtPrice: bigint, tickLower: number, tickUpper: number, desired0: bigint, desired1: bigint, slippage: number): [bigint, bigint] {
  const sqrtA = getSqrtRatioAtTick(tickLower)
  const sqrtB = getSqrtRatioAtTick(tickUpper)
  const [lower, upper] = sqrtPriceBounds(sqrtPrice, slippage)
  let min0: bigint | null = null
  let min1: bigint | null = null
  for (const s of [lower, sqrtPrice, upper]) {
    const [a0, a1] = getMintAmounts(s, sqrtA, sqrtB, getLiquidityForAmounts(s, sqrtA, sqrtB, desired0, desired1))
    min0 = min0 === null || a0 < min0 ? a0 : min0
    min1 = min1 === null || a1 < min1 ? a1 : min1
  }
  return [min0 as bigint, min1 as bigint]
}
