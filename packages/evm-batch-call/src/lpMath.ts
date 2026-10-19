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

// ---------------------------------------------------------------------------
// 添加 / 移除流动性用到的计算
// ---------------------------------------------------------------------------

/** getSqrtRatioAtTick(MIN_TICK) / getSqrtRatioAtTick(MAX_TICK)：池子价格的上下限（价格必须在 [MIN, MAX) 内） */
export const MIN_SQRT_RATIO = 4295128739n
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n
export const MAX_UINT128 = 2n ** 128n - 1n

const divUp = (a: bigint, b: bigint) => (a + b - 1n) / b

/** SqrtPriceMath.getAmount0Delta：区间 [a, b] 内 L 对应的 token0，roundUp 时向上取整（添加流动性时池子收取的数量） */
export function getAmount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) {
    ;[sqrtA, sqrtB] = [sqrtB, sqrtA]
  }
  const n1 = liquidity << 96n
  const n2 = sqrtB - sqrtA
  return roundUp ? divUp(divUp(n1 * n2, sqrtB), sqrtA) : (n1 * n2) / sqrtB / sqrtA
}

/** SqrtPriceMath.getAmount1Delta：区间 [a, b] 内 L 对应的 token1，roundUp 时向上取整 */
export function getAmount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) {
    ;[sqrtA, sqrtB] = [sqrtB, sqrtA]
  }
  return roundUp ? divUp(liquidity * (sqrtB - sqrtA), Q96) : (liquidity * (sqrtB - sqrtA)) / Q96
}

/** 添加流动性 L 时池子收取的两种代币数量（向上取整，与池子的 modifyPosition 一致） */
export function getMintAmounts(sqrtPrice: bigint, sqrtA: bigint, sqrtB: bigint, liquidity: bigint): [bigint, bigint] {
  if (sqrtA > sqrtB) {
    ;[sqrtA, sqrtB] = [sqrtB, sqrtA]
  }
  if (sqrtPrice <= sqrtA) {
    return [getAmount0Delta(sqrtA, sqrtB, liquidity, true), 0n]
  }
  if (sqrtPrice < sqrtB) {
    return [getAmount0Delta(sqrtPrice, sqrtB, liquidity, true), getAmount1Delta(sqrtA, sqrtPrice, liquidity, true)]
  }
  return [0n, getAmount1Delta(sqrtA, sqrtB, liquidity, true)]
}

/** LiquidityAmounts.getLiquidityForAmount0：区间 [a, b] 内 amount0 个 token0 对应的流动性（向下取整） */
export function getLiquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  if (sqrtA > sqrtB) {
    ;[sqrtA, sqrtB] = [sqrtB, sqrtA]
  }
  return (amount0 * ((sqrtA * sqrtB) / Q96)) / (sqrtB - sqrtA)
}

/** LiquidityAmounts.getLiquidityForAmount1：区间 [a, b] 内 amount1 个 token1 对应的流动性（向下取整） */
export function getLiquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  if (sqrtA > sqrtB) {
    ;[sqrtA, sqrtB] = [sqrtB, sqrtA]
  }
  return (amount1 * Q96) / (sqrtB - sqrtA)
}

/**
 * LiquidityAmounts.getLiquidityForAmounts：最多用 amount0 / amount1 时能添加的流动性（取两边较小的，与 V3 仓位合约一致）。
 * 价格在区间下方只用 token0，上方只用 token1
 */
export function getLiquidityForAmounts(sqrtPrice: bigint, sqrtA: bigint, sqrtB: bigint, amount0: bigint, amount1: bigint): bigint {
  if (sqrtA > sqrtB) {
    ;[sqrtA, sqrtB] = [sqrtB, sqrtA]
  }
  if (sqrtPrice <= sqrtA) {
    return getLiquidityForAmount0(sqrtA, sqrtB, amount0)
  }
  if (sqrtPrice < sqrtB) {
    const l0 = getLiquidityForAmount0(sqrtPrice, sqrtB, amount0)
    const l1 = getLiquidityForAmount1(sqrtA, sqrtPrice, amount1)
    return l0 < l1 ? l0 : l1
  }
  return getLiquidityForAmount1(sqrtA, sqrtB, amount1)
}

/** 流动性是 uint128：超出时报错（合约里同样会 revert） */
export function toUint128(liquidity: bigint): bigint {
  if (liquidity < 0n || liquidity > MAX_UINT128) {
    throw new RangeError(`liquidity out of uint128 range: ${liquidity}`)
  }
  return liquidity
}

/** TickMath.getTickAtSqrtRatio：满足 getSqrtRatioAtTick(tick) <= sqrtPrice 的最大 tick（精确，二分查找） */
export function getTickAtSqrtRatio(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new RangeError(`sqrtPriceX96 out of range: ${sqrtPriceX96}`)
  }
  let lo = MIN_TICK
  let hi = MAX_TICK
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    if (getSqrtRatioAtTick(mid) <= sqrtPriceX96) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return lo
}

/** 整数平方根（向下取整） */
export function sqrtBigInt(value: bigint): bigint {
  if (value < 0n) {
    throw new RangeError('square root of a negative number')
  }
  if (value < 2n) {
    return value
  }
  // 牛顿迭代：从不小于平方根的 2^ceil(位数 / 2) 开始单调递减，收敛到向下取整的平方根
  let x = 1n << BigInt((value.toString(2).length + 1) >> 1)
  for (;;) {
    const y = (x + value / x) >> 1n
    if (y >= x) {
      break
    }
    x = y
  }
  return x
}

/** 十进制数（'1.5'、'2e-7'、1.5）→ 分子 / 分母，精确，不经过浮点 */
export function parseDecimal(value: string | number): { num: bigint; den: bigint } {
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value.trim()
  const m = /^\+?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text)
  if (!m || (!m[1] && !m[2])) {
    throw new Error(`Invalid number: ${String(value)}`)
  }
  const frac = m[2] ?? ''
  const exp = Number(m[3] ?? 0) - frac.length
  if (Math.abs(exp) > 400) {
    throw new RangeError(`Number out of range: ${String(value)}`)
  }
  const digits = BigInt(`${m[1] ?? ''}${frac}` || '0')
  return exp >= 0 ? { num: digits * 10n ** BigInt(exp), den: 1n } : { num: digits, den: 10n ** BigInt(-exp) }
}

/**
 * 价格（token1 / token0，按精度换算后的人类可读数字，如 600 表示 1 个 token0 值 600 个 token1）→ sqrtPriceX96。
 * 精确计算（字符串不经过浮点），结果向下取整；价格必须大于 0
 */
export function priceToSqrtPriceX96(price: string | number, decimals0: number, decimals1: number): bigint {
  const { num, den } = parseDecimal(price)
  return ratioToSqrtPriceX96(num, den, decimals0, decimals1)
}

/** 价格（分数 num / den，token1 / token0，按精度换算）→ sqrtPriceX96，向下取整；价格必须大于 0 */
export function ratioToSqrtPriceX96(num: bigint, den: bigint, decimals0: number, decimals1: number): bigint {
  if (num <= 0n || den <= 0n) {
    throw new RangeError('price must be greater than 0')
  }
  // raw = price × 10^(d1 − d0)；sqrtPriceX96 = sqrt(raw × 2^192)
  const scale = decimals1 - decimals0
  const n = num * (scale > 0 ? 10n ** BigInt(scale) : 1n) * 2n ** 192n
  const d = den * (scale < 0 ? 10n ** BigInt(-scale) : 1n)
  return sqrtBigInt(n / d)
}

/** sqrtPriceX96 → tick（getTickAtSqrtRatio），超出池子价格范围时取 MIN_TICK / MAX_TICK */
export function clampedTickAtSqrtRatio(sqrtPrice: bigint): number {
  if (sqrtPrice < MIN_SQRT_RATIO) {
    return MIN_TICK
  }
  if (sqrtPrice >= MAX_SQRT_RATIO) {
    return MAX_TICK
  }
  return getTickAtSqrtRatio(sqrtPrice)
}

/** 价格（token1 / token0，按精度换算）→ tick：满足 tickToPrice(tick) <= price 的最大 tick，限制在 [MIN_TICK, MAX_TICK] 内 */
export function priceToTick(price: string | number, decimals0: number, decimals1: number): number {
  return clampedTickAtSqrtRatio(priceToSqrtPriceX96(price, decimals0, decimals1))
}

/** 最近的可用 tick（tickSpacing 的整数倍），限制在 [MIN_TICK, MAX_TICK] 内 */
export function nearestUsableTick(tick: number, tickSpacing: number): number {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new RangeError(`invalid tickSpacing: ${tickSpacing}`)
  }
  const rounded = Math.round(tick / tickSpacing) * tickSpacing
  if (rounded < MIN_TICK) {
    return rounded + tickSpacing
  }
  if (rounded > MAX_TICK) {
    return rounded - tickSpacing
  }
  return rounded
}

/**
 * 价格按 slippage 上下浮动后的 sqrtPrice：[sqrtPrice × sqrt(1 − s), sqrtPrice × sqrt(1 + s)]，限制在池子允许的价格范围内。
 * slippage 是比例（0.005 = 0.5%），精确到百万分之一
 */
export function sqrtPriceBounds(sqrtPriceX96: bigint, slippage: number): [bigint, bigint] {
  if (!(slippage >= 0 && slippage < 1)) {
    throw new RangeError(`slippage must be in [0, 1): ${slippage}`)
  }
  const ppm = BigInt(Math.round(slippage * 1e6))
  const square = sqrtPriceX96 * sqrtPriceX96
  const lower = sqrtBigInt((square * (1_000_000n - ppm)) / 1_000_000n)
  const upper = sqrtBigInt((square * (1_000_000n + ppm)) / 1_000_000n)
  const clamp = (x: bigint) => (x <= MIN_SQRT_RATIO ? MIN_SQRT_RATIO + 1n : x >= MAX_SQRT_RATIO ? MAX_SQRT_RATIO - 1n : x)
  return [clamp(lower), clamp(upper)]
}

/**
 * 价格在 slippage 范围内变动时，流动性 L 至少对应多少代币（移除流动性 / V3 添加时的最小数量，向下取整）。
 * token0 随价格上涨而减少，取上限价格时的数量；token1 取下限价格时的
 */
export function getMinAmounts(sqrtPriceX96: bigint, sqrtA: bigint, sqrtB: bigint, liquidity: bigint, slippage: number): [bigint, bigint] {
  const [lower, upper] = sqrtPriceBounds(sqrtPriceX96, slippage)
  return [getAmountsForLiquidity(upper, sqrtA, sqrtB, liquidity)[0], getAmountsForLiquidity(lower, sqrtA, sqrtB, liquidity)[1]]
}

/** 价格在 slippage 范围内变动时，添加流动性 L 最多需要多少代币（V4 的 amountMax，向上取整） */
export function getMaxAmounts(sqrtPriceX96: bigint, sqrtA: bigint, sqrtB: bigint, liquidity: bigint, slippage: number): [bigint, bigint] {
  const [lower, upper] = sqrtPriceBounds(sqrtPriceX96, slippage)
  return [getMintAmounts(lower, sqrtA, sqrtB, liquidity)[0], getMintAmounts(upper, sqrtA, sqrtB, liquidity)[1]]
}
