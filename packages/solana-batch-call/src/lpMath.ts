/**
 * 集中流动性（Raydium CLMM / Orca Whirlpool）的定点数计算，与链上程序逐位一致（Q64.64，bigint）。
 * 两个程序的 tick → 价格换算用的常量和步骤不同（结果在最后几位可能不同），各自照搬；
 * 数量和手续费的公式两边相同：撤出流动性时向下取整，手续费增长按 u128 回绕相减。
 */

const Q64 = 1n << 64n
const U128_MAX = (1n << 128n) - 1n
const U64_MAX = (1n << 64n) - 1n

export const MIN_TICK = -443636
export const MAX_TICK = 443636

function checkTick(tick: number): void {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new RangeError(`Tick out of range: ${tick}`)
  }
}

// raydium-clmm programs/amm/src/libraries/tick_math.rs（第 0 项对应 abs_tick & 0x1）
const RAYDIUM_RATIOS = [
  0xfffcb933bd6fb800n,
  0xfff97272373d4000n,
  0xfff2e50f5f657000n,
  0xffe5caca7e10f000n,
  0xffcb9843d60f7000n,
  0xff973b41fa98e800n,
  0xff2ea16466c9b000n,
  0xfe5dee046a9a3800n,
  0xfcbe86c7900bb000n,
  0xf987a7253ac65800n,
  0xf3392b0822bb6000n,
  0xe7159475a2caf000n,
  0xd097f3bdfd2f2000n,
  0xa9f746462d9f8000n,
  0x70d869a156f31c00n,
  0x31be135f97ed3200n,
  0x9aa508b5b85a500n,
  0x5d6af8dedc582cn,
  0x2216e584f5fan,
]

/** Raydium CLMM：tick → sqrt 价格（Q64.64） */
export function raydiumSqrtPriceAtTick(tick: number): bigint {
  checkTick(tick)
  const abs = Math.abs(tick)
  let ratio = abs & 1 ? (RAYDIUM_RATIOS[0] as bigint) : Q64
  for (let i = 1; i < RAYDIUM_RATIOS.length; i++) {
    if (abs & (1 << i)) {
      ratio = (ratio * (RAYDIUM_RATIOS[i] as bigint)) >> 64n
    }
  }
  return tick > 0 ? U128_MAX / ratio : ratio
}

// orca whirlpools programs/whirlpool/src/math/tick_math.rs：正 tick 用 Q96 常量，负 tick 用 Q64 常量
const ORCA_POSITIVE = [
  79232123823359799118286999567n,
  79236085330515764027303304731n,
  79244008939048815603706035061n,
  79259858533276714757314932305n,
  79291567232598584799939703904n,
  79355022692464371645785046466n,
  79482085999252804386437311141n,
  79736823300114093921829183326n,
  80248749790819932309965073892n,
  81282483887344747381513967011n,
  83390072131320151908154831281n,
  87770609709833776024991924138n,
  97234110755111693312479820773n,
  119332217159966728226237229890n,
  179736315981702064433883588727n,
  407748233172238350107850275304n,
  2098478828474011932436660412517n,
  55581415166113811149459800483533n,
  38992368544603139932233054999993551n,
]
const ORCA_NEGATIVE = [
  18445821805675392311n,
  18444899583751176498n,
  18443055278223354162n,
  18439367220385604838n,
  18431993317065449817n,
  18417254355718160513n,
  18387811781193591352n,
  18329067761203520168n,
  18212142134806087854n,
  17980523815641551639n,
  17526086738831147013n,
  16651378430235024244n,
  15030750278693429944n,
  12247334978882834399n,
  8131365268884726200n,
  3584323654723342297n,
  696457651847595233n,
  26294789957452057n,
  37481735321082n,
]

/** Orca Whirlpool：tick → sqrt 价格（Q64.64） */
export function orcaSqrtPriceAtTick(tick: number): bigint {
  checkTick(tick)
  if (tick >= 0) {
    let ratio = tick & 1 ? (ORCA_POSITIVE[0] as bigint) : 1n << 96n
    for (let i = 1; i < ORCA_POSITIVE.length; i++) {
      if (tick & (1 << i)) {
        ratio = (ratio * (ORCA_POSITIVE[i] as bigint)) >> 96n
      }
    }
    return ratio >> 32n
  }
  const abs = -tick
  let ratio = abs & 1 ? (ORCA_NEGATIVE[0] as bigint) : Q64
  for (let i = 1; i < ORCA_NEGATIVE.length; i++) {
    if (abs & (1 << i)) {
      ratio = (ratio * (ORCA_NEGATIVE[i] as bigint)) >> 64n
    }
  }
  return ratio
}

/**
 * 撤出全部流动性能拿到的两种代币数量（向下取整）。两个程序都按当前 tick（不是价格）判断区间：
 * tick < 下限只有 token0；tick ≥ 上限只有 token1；否则两种都有
 */
export function getAmountsForLiquidity(tick: number, sqrtPrice: bigint, sqrtLower: bigint, sqrtUpper: bigint, liquidity: bigint, tickLower: number, tickUpper: number): [bigint, bigint] {
  if (liquidity === 0n) {
    return [0n, 0n]
  }
  if (tick < tickLower) {
    return [amount0Delta(sqrtLower, sqrtUpper, liquidity), 0n]
  }
  if (tick < tickUpper) {
    return [amount0Delta(sqrtPrice, sqrtUpper, liquidity), amount1Delta(sqrtLower, sqrtPrice, liquidity)]
  }
  return [0n, amount1Delta(sqrtLower, sqrtUpper, liquidity)]
}

/** floor(L · 2^64 · (b − a) / (a · b)) */
function amount0Delta(a: bigint, b: bigint, liquidity: bigint): bigint {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return lo === 0n ? 0n : ((liquidity << 64n) * (hi - lo)) / (lo * hi)
}

/** floor(L · (b − a) / 2^64) */
function amount1Delta(a: bigint, b: bigint, liquidity: bigint): bigint {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return (liquidity * (hi - lo)) >> 64n
}

/** 一个 tick 上用于计算手续费的数据；Orca 的 tick 未初始化时 initialized 为 false */
export interface TickFeeData {
  initialized: boolean
  feeGrowthOutside0: bigint
  feeGrowthOutside1: bigint
}

const wrap = (x: bigint) => ((x % (1n << 128n)) + (1n << 128n)) % (1n << 128n)

/**
 * 区间内的手续费增长（u128 回绕）。Raydium 不区分是否初始化（未初始化的 tick 各项为 0，传 initialized: true 即可）；
 * Orca 未初始化的 tick：下限按“下方增长 = 全局”、上限按“上方增长 = 0”处理（与程序一致）
 */
export function getFeeGrowthInside(
  tick: number,
  tickLower: number,
  lower: TickFeeData,
  tickUpper: number,
  upper: TickFeeData,
  global0: bigint,
  global1: bigint,
): [bigint, bigint] {
  const below = !lower.initialized
    ? [global0, global1]
    : tick < tickLower
      ? [wrap(global0 - lower.feeGrowthOutside0), wrap(global1 - lower.feeGrowthOutside1)]
      : [lower.feeGrowthOutside0, lower.feeGrowthOutside1]
  const above = !upper.initialized
    ? [0n, 0n]
    : tick < tickUpper
      ? [upper.feeGrowthOutside0, upper.feeGrowthOutside1]
      : [wrap(global0 - upper.feeGrowthOutside0), wrap(global1 - upper.feeGrowthOutside1)]
  return [wrap(global0 - (below[0] as bigint) - (above[0] as bigint)), wrap(global1 - (below[1] as bigint) - (above[1] as bigint))]
}

/**
 * 未领取的手续费：已记账的 owed + L · (区间内增长 − 上次记录) / 2^64（向下取整）。
 * 新增部分超过 u64 时：Orca 程序记为 0（checked_mul_shift_right 失败），这里同样记为 0（正常仓位不会碰到）
 */
export function getFeesOwed(owed: bigint, liquidity: bigint, growthInside: bigint, growthLast: bigint): bigint {
  const delta = (liquidity * wrap(growthInside - growthLast)) >> 64n
  return owed + (delta > U64_MAX ? 0n : delta)
}

/** Q64.64 sqrt 价格 → token1 / token0 的价格（按精度换算，浮点数，只用于展示） */
export function sqrtPriceToPrice(sqrtPrice: bigint, decimals0: number, decimals1: number): number {
  // 先取高位再转浮点，避免 2^128 级别的整数转换丢精度后再平方
  const ratio = Number(sqrtPrice) / 2 ** 64
  return ratio * ratio * 10 ** (decimals0 - decimals1)
}

/** tick → token1 / token0 的价格（1.0001^tick，按精度换算，只用于展示） */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1)
}
