/**
 * 集中流动性（Uniswap V3 / V4 及其分叉）的数学：tick ↔ sqrtPrice、按流动性算代币数量、未领取的手续费。
 * 与 Uniswap 合约里的整数算法逐位一致（TickMath、LiquidityAmounts、Position 的手续费计算）。
 */

export const MIN_TICK = -887272
export const MAX_TICK = 887272

const Q96 = 2n ** 96n
const Q128 = 2n ** 128n
const Q256 = 2n ** 256n
const MAX_UINT256 = Q256 - 1n

/** TickMath.getSqrtRatioAtTick 里的常数：sqrt(1.0001)^(-2^i) 的 Q128 定点数 */
const RATIOS: readonly bigint[] = [
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
]

/** TickMath.getSqrtRatioAtTick：tick → sqrt(1.0001^tick) 的 Q64.96 定点数 */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new RangeError(`tick out of range: ${tick}`)
  }
  const absTick = Math.abs(tick)
  let ratio = absTick & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n
  for (let i = 0; i < RATIOS.length; i++) {
    if (absTick & (0x2 << i)) {
      ratio = (ratio * (RATIOS[i] as bigint)) >> 128n
    }
  }
  if (tick > 0) {
    ratio = MAX_UINT256 / ratio
  }
  // Q128.128 → Q64.96，向上取整（与合约一致）
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n)
}

/** SqrtPriceMath.getAmount0Delta（向下取整）：区间 [a, b] 内 L 对应的 token0 数量 */
function amount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  return ((liquidity << 96n) * (sqrtB - sqrtA)) / sqrtB / sqrtA
}

/** SqrtPriceMath.getAmount1Delta（向下取整）：区间 [a, b] 内 L 对应的 token1 数量 */
function amount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  return (liquidity * (sqrtB - sqrtA)) / Q96
}

/**
 * LiquidityAmounts.getAmountsForLiquidity：当前价格 sqrtPrice 下，价格区间 [sqrtA, sqrtB] 内流动性 L 对应的两种代币数量
 * （与移除全部流动性时拿到的数量一致，向下取整）
 */
export function getAmountsForLiquidity(sqrtPrice: bigint, sqrtA: bigint, sqrtB: bigint, liquidity: bigint): [bigint, bigint] {
  if (sqrtA > sqrtB) {
    ;[sqrtA, sqrtB] = [sqrtB, sqrtA]
  }
  if (liquidity === 0n) {
    return [0n, 0n]
  }
  if (sqrtPrice <= sqrtA) {
    return [amount0Delta(sqrtA, sqrtB, liquidity), 0n]
  }
  if (sqrtPrice < sqrtB) {
    return [amount0Delta(sqrtPrice, sqrtB, liquidity), amount1Delta(sqrtA, sqrtPrice, liquidity)]
  }
  return [0n, amount1Delta(sqrtA, sqrtB, liquidity)]
}

const wrap = (x: bigint) => ((x % Q256) + Q256) % Q256

/**
 * 区间内的累计手续费增长（Tick.getFeeGrowthInside，按 uint256 回绕）。
 * global：池子的 feeGrowthGlobalX128；lowerOutside / upperOutside：两端 tick 的 feeGrowthOutsideX128
 */
export function getFeeGrowthInside(tick: number, tickLower: number, tickUpper: number, global: bigint, lowerOutside: bigint, upperOutside: bigint): bigint {
  const below = tick >= tickLower ? lowerOutside : wrap(global - lowerOutside)
  const above = tick < tickUpper ? upperOutside : wrap(global - upperOutside)
  return wrap(global - below - above)
}

/** 自上次结算以来新产生的手续费：L × (inside − insideLast) / 2^128（差值按 uint256 回绕，与合约一致） */
export function getFeesEarned(liquidity: bigint, feeGrowthInside: bigint, feeGrowthInsideLast: bigint): bigint {
  return (liquidity * wrap(feeGrowthInside - feeGrowthInsideLast)) / Q128
}

/** sqrtPriceX96 → token1 / token0 的价格（按精度换算后的人类可读数字，有浮点误差，只用于展示） */
export function sqrtPriceToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  // 全程浮点：sqrtPrice 不超过 2^160，转 Number 只丢末尾的位（相对误差约 1e-16）；先除 2^96 再平方，价格很小时也不会变成 0
  const ratio = Number(sqrtPriceX96) / 2 ** 96
  return ratio * ratio * 10 ** (decimals0 - decimals1)
}

/** tick → token1 / token0 的价格（按精度换算，只用于展示） */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1)
}
