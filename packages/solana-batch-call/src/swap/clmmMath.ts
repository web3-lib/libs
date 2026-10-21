/**
 * 集中流动性兑换一步的计算（只做按输入数量兑换），照搬 Raydium CLMM（libraries/swap_math.rs、sqrt_price_math.rs、liquidity_math.rs）
 * 和 Orca Whirlpool（math/swap_math.rs、token_math.rs）。两个程序“手续费从输入扣”时的公式和取整完全相同；Raydium 另有“手续费从输出扣”的池子
 */
import { U64_MAX, mulDivCeil } from './common.js'

const Q64 = 1n << 64n
export const FEE_RATE_DENOMINATOR = 1_000_000n

export class SwapMathError extends Error {}

/** 价格从 a 到 b（任意顺序）对应的 token0 数量：L · 2^64 · (hi − lo) / (lo · hi) */
export function amount0Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  if (lo === 0n) throw new SwapMathError('zero sqrt price')
  const num = (liquidity * (hi - lo)) << 64n
  const den = lo * hi
  return roundUp ? (num + den - 1n) / den : num / den
}

/** 价格从 a 到 b 对应的 token1 数量：L · (hi − lo) / 2^64 */
export function amount1Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const p = liquidity * (hi - lo)
  return roundUp ? (p + Q64 - 1n) >> 64n : p >> 64n
}

/** 卖出 amount 后的 sqrt 价格（向不越过目标价格的方向取整）：卖 token0 时价格下降，卖 token1 时上升 */
export function nextSqrtPriceFromInput(sqrtPrice: bigint, liquidity: bigint, amount: bigint, zeroForOne: boolean): bigint {
  if (liquidity === 0n) throw new SwapMathError('zero liquidity')
  if (amount === 0n) return sqrtPrice
  if (zeroForOne) {
    const num = liquidity << 64n
    const den = num + amount * sqrtPrice
    return mulDivCeil(num, sqrtPrice, den)
  }
  return sqrtPrice + (amount << 64n) / liquidity
}

export interface SwapStep {
  /** 走到的 sqrt 价格 */
  sqrtPrice: bigint
  /** 计入价格变动的输入（不含手续费） */
  amountIn: bigint
  /** 给用户的输出（手续费从输出扣时已扣除） */
  amountOut: bigint
  feeAmount: bigint
}

/**
 * 一步兑换：从当前价格向目标价格，最多用 remaining 个输入。
 * feeOnInput（Orca 和 Raydium 的默认）：输入先按费率扣手续费；否则（Raydium fee_on）：输出按费率扣
 */
export function computeSwapStep(
  sqrtCurrent: bigint,
  sqrtTarget: bigint,
  liquidity: bigint,
  remaining: bigint,
  feeRate: bigint,
  zeroForOne: boolean,
  feeOnInput: boolean,
  program: 'raydium' | 'orca',
): SwapStep {
  const amountForPrice = feeOnInput ? (remaining * (FEE_RATE_DENOMINATOR - feeRate)) / FEE_RATE_DENOMINATOR : remaining
  // 走到目标价格需要的输入（向上取整）和得到的输出（向下取整）；超过 u64 视为走不到
  const inAtTarget = zeroForOne ? amount0Delta(sqrtTarget, sqrtCurrent, liquidity, true) : amount1Delta(sqrtCurrent, sqrtTarget, liquidity, true)
  let sqrtNext: bigint
  let amountIn: bigint
  let amountOut: bigint
  const outAtTarget = () => (zeroForOne ? amount1Delta(sqrtTarget, sqrtCurrent, liquidity, false) : amount0Delta(sqrtCurrent, sqrtTarget, liquidity, false))
  let reached = inAtTarget <= U64_MAX && amountForPrice >= inAtTarget
  // Raydium：目标价格处的输出超过 u64 也算走不到；Orca 照常走到目标（之后报错）
  const out = reached ? outAtTarget() : 0n
  if (reached && program === 'raydium' && out > U64_MAX) reached = false
  if (reached) {
    sqrtNext = sqrtTarget
    amountIn = inAtTarget
    amountOut = out
  } else {
    sqrtNext = nextSqrtPriceFromInput(sqrtCurrent, liquidity, amountForPrice, zeroForOne)
    amountIn = zeroForOne ? amount0Delta(sqrtNext, sqrtCurrent, liquidity, true) : amount1Delta(sqrtCurrent, sqrtNext, liquidity, true)
    amountOut = zeroForOne ? amount1Delta(sqrtNext, sqrtCurrent, liquidity, false) : amount0Delta(sqrtCurrent, sqrtNext, liquidity, false)
  }
  if (amountIn > U64_MAX || amountOut > U64_MAX) throw new SwapMathError('token amount exceeds u64')
  if (zeroForOne ? sqrtNext < sqrtTarget : sqrtNext > sqrtTarget) throw new SwapMathError('price moved past the target')
  let feeAmount: bigint
  if (feeOnInput) {
    feeAmount = sqrtNext !== sqrtTarget ? remaining - amountIn : mulDivCeil(amountIn, feeRate, FEE_RATE_DENOMINATOR - feeRate)
  } else {
    feeAmount = mulDivCeil(amountOut, feeRate, FEE_RATE_DENOMINATOR)
    amountOut -= feeAmount
    // 没走到目标价格：输入全部用掉（不足一个单位的零头归池子）
    if (sqrtNext !== sqrtTarget) amountIn = remaining
  }
  return { sqrtPrice: sqrtNext, amountIn, amountOut, feeAmount }
}
