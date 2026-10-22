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
  /** 三个挖矿奖励的 tick 外增长（读 tick 时带上；只算手续费时可以不给） */
  rewardGrowthsOutside?: readonly bigint[]
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

/** 池子里一个挖矿奖励的状态（两个程序的 reward_infos 里的同名字段） */
export interface RewardEmission {
  /** 已初始化：奖励的 mint 不是默认地址 */
  initialized: boolean
  emissionsPerSecondX64: bigint
  growthGlobalX64: bigint
  /** 上次更新的时间（秒）。Raydium 每个奖励自己记；Orca 是池子的 reward_last_updated_timestamp（三个奖励相同） */
  lastUpdated: bigint
  /** 开始 / 结束时间（秒）：Raydium 的 open_time / end_time；Orca 没有，传 0n / 2^64 − 1 */
  openTime: bigint
  endTime: bigint
}

/**
 * 池子在 now 时刻的奖励全局增长：程序每次操作池子（交易、增减流动性、领取）前先把排放按时间摊给当前的流动性，
 * Q64.64：growth += Δt · emissions_per_second / liquidity（向下取整，u128 回绕）。
 * Raydium：now ≤ open_time 不动，Δt 到 end_time 为止；Orca：池子流动性为 0 或 Δt 为 0 不动
 */
export function rewardGrowthGlobal(liquidity: bigint, reward: RewardEmission, now: bigint): bigint {
  if (!reward.initialized || liquidity === 0n || now <= reward.openTime) {
    return reward.growthGlobalX64
  }
  const latest = now < reward.endTime ? now : reward.endTime
  const delta = latest > reward.lastUpdated ? latest - reward.lastUpdated : 0n
  return wrap(reward.growthGlobalX64 + (delta * reward.emissionsPerSecondX64) / liquidity)
}

/** 区间内某个奖励的增长（u128 回绕），tick 未初始化的处理同 getFeeGrowthInside */
export function getRewardGrowthInside(tick: number, tickLower: number, lower: TickFeeData, tickUpper: number, upper: TickFeeData, index: number, global: bigint): bigint {
  const lowerOutside = lower.rewardGrowthsOutside?.[index] ?? 0n
  const upperOutside = upper.rewardGrowthsOutside?.[index] ?? 0n
  const below = !lower.initialized ? global : tick < tickLower ? wrap(global - lowerOutside) : lowerOutside
  const above = !upper.initialized ? 0n : tick < tickUpper ? upperOutside : wrap(global - upperOutside)
  return wrap(global - below - above)
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

// ---------------------------------------------------------------------------
// 添加 / 移除流动性用到的计算（两个程序公式相同，tick ↔ 价格按各自的换算）
// ---------------------------------------------------------------------------

/** 两个程序允许的 sqrt 价格范围（Raydium：MIN / MAX_SQRT_PRICE_X64；Orca：MIN / MAX_SQRT_PRICE） */
export const RAYDIUM_MIN_SQRT_PRICE = 4295048016n
export const RAYDIUM_MAX_SQRT_PRICE = 79226673521066979257578248091n
export const ORCA_MIN_SQRT_PRICE = 4295048016n
export const ORCA_MAX_SQRT_PRICE = 79226673515401279992447579055n

export type ClmmProgram = 'raydium' | 'orca'

const sqrtAtTick = (program: ClmmProgram) => (program === 'raydium' ? raydiumSqrtPriceAtTick : orcaSqrtPriceAtTick)
const sqrtRange = (program: ClmmProgram): [bigint, bigint] => (program === 'raydium' ? [RAYDIUM_MIN_SQRT_PRICE, RAYDIUM_MAX_SQRT_PRICE] : [ORCA_MIN_SQRT_PRICE, ORCA_MAX_SQRT_PRICE])

/** tick → sqrt 价格（按程序） */
export function sqrtPriceAtTick(program: ClmmProgram, tick: number): bigint {
  return sqrtAtTick(program)(tick)
}

/** sqrt 价格 → tick：满足 sqrtPriceAtTick(tick) <= sqrtPrice 的最大 tick（二分查找，与程序的 get_tick_at_sqrt_price 一致），限制在 [MIN_TICK, MAX_TICK] 内 */
export function tickAtSqrtPrice(program: ClmmProgram, sqrtPrice: bigint): number {
  const at = sqrtAtTick(program)
  if (sqrtPrice < at(MIN_TICK)) {
    return MIN_TICK
  }
  let lo = MIN_TICK
  let hi = MAX_TICK
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    if (at(mid) <= sqrtPrice) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return lo
}

/** 向上取整的整数除法 */
export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

/** 添加流动性 L 时程序收取的 token0（向上取整）：ceil(L · 2^64 · (b − a) / (a · b)) */
function amount0Up(a: bigint, b: bigint, liquidity: bigint): bigint {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return ceilDiv((liquidity << 64n) * (hi - lo), lo * hi)
}

/** 添加流动性 L 时程序收取的 token1（向上取整）：ceil(L · (b − a) / 2^64) */
function amount1Up(a: bigint, b: bigint, liquidity: bigint): bigint {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return ceilDiv(liquidity * (hi - lo), Q64)
}

/** 添加流动性 L 时程序收取的两种代币数量（向上取整；按当前 tick 判断区间，与程序一致） */
export function getMintAmounts(tick: number, sqrtPrice: bigint, sqrtLower: bigint, sqrtUpper: bigint, liquidity: bigint, tickLower: number, tickUpper: number): [bigint, bigint] {
  if (liquidity === 0n) {
    return [0n, 0n]
  }
  if (tick < tickLower) {
    return [amount0Up(sqrtLower, sqrtUpper, liquidity), 0n]
  }
  if (tick < tickUpper) {
    return [amount0Up(sqrtPrice, sqrtUpper, liquidity), amount1Up(sqrtLower, sqrtPrice, liquidity)]
  }
  return [0n, amount1Up(sqrtLower, sqrtUpper, liquidity)]
}

/** 区间 [a, b] 内 amount0 个 token0 对应的流动性（向下取整）：amount0 · (a · b / 2^64) / (b − a) */
export function getLiquidityForAmount0(a: bigint, b: bigint, amount0: bigint): bigint {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return (amount0 * ((lo * hi) / Q64)) / (hi - lo)
}

/** 区间 [a, b] 内 amount1 个 token1 对应的流动性（向下取整）：amount1 · 2^64 / (b − a) */
export function getLiquidityForAmount1(a: bigint, b: bigint, amount1: bigint): bigint {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return (amount1 * Q64) / (hi - lo)
}

/**
 * 最多用 amount0 / amount1 时能添加的流动性：两边都给时取较小的；只给一边时只按这一边算（另一边要多少由 getMintAmounts 算）。
 * 区间在当前价格之外时只需要一种代币，给的是另一种时返回 0
 */
export function getLiquidityForAmounts(
  tick: number,
  sqrtPrice: bigint,
  sqrtLower: bigint,
  sqrtUpper: bigint,
  amount0: bigint | undefined,
  amount1: bigint | undefined,
  tickLower: number,
  tickUpper: number,
): bigint {
  let l0: bigint | null = null
  let l1: bigint | null = null
  // 价格正好在下限（tick == tickLower 且 sqrtPrice == sqrtLower）时也只需要 token0：按下方处理，避免除以 0
  if (tick < tickLower || sqrtPrice <= sqrtLower) {
    l0 = amount0 === undefined ? null : getLiquidityForAmount0(sqrtLower, sqrtUpper, amount0)
    l1 = amount1 === undefined ? null : amount0 === undefined ? 0n : null
  } else if (tick < tickUpper && sqrtPrice < sqrtUpper) {
    // 价格正好在上限（向下穿过 tick 后 tick = tickUpper − 1、sqrtPrice = 上限）时只需要 token1：按上方处理
    l0 = amount0 === undefined ? null : getLiquidityForAmount0(sqrtPrice, sqrtUpper, amount0)
    l1 = amount1 === undefined ? null : getLiquidityForAmount1(sqrtLower, sqrtPrice, amount1)
  } else {
    l1 = amount1 === undefined ? null : getLiquidityForAmount1(sqrtLower, sqrtUpper, amount1)
    l0 = amount0 === undefined ? null : amount1 === undefined ? 0n : null
  }
  if (l0 === null) return l1 ?? 0n
  if (l1 === null) return l0
  return l0 < l1 ? l0 : l1
}

/** 整数平方根（向下取整，牛顿迭代从不小于平方根的值开始） */
export function sqrtBigInt(value: bigint): bigint {
  if (value < 0n) {
    throw new RangeError('square root of a negative number')
  }
  if (value < 2n) {
    return value
  }
  let x = 1n << BigInt((value.toString(2).length + 1) >> 1)
  for (;;) {
    const y = (x + value / x) >> 1n
    if (y >= x) {
      return x
    }
    x = y
  }
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

/** 价格（token1 / token0，按精度换算）→ Q64.64 sqrt 价格（向下取整）；num / den 是价格的分子分母 */
export function ratioToSqrtPrice(num: bigint, den: bigint, decimals0: number, decimals1: number): bigint {
  if (num <= 0n || den <= 0n) {
    throw new RangeError('price must be greater than 0')
  }
  const scale = decimals1 - decimals0
  return sqrtBigInt((num * (scale > 0 ? 10n ** BigInt(scale) : 1n) * 2n ** 128n) / (den * (scale < 0 ? 10n ** BigInt(-scale) : 1n)))
}

/** 价格（token1 / token0，按精度换算）→ tick（按程序；满足价格 >= tick 价格的最大 tick） */
export function priceToTick(program: ClmmProgram, price: string | number, decimals0: number, decimals1: number): number {
  const { num, den } = parseDecimal(price)
  return tickAtSqrtPrice(program, ratioToSqrtPrice(num, den, decimals0, decimals1))
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

/** 价格按 slippage 上下浮动后的 sqrt 价格和对应的 tick，限制在程序允许的范围内（slippage 是比例，精确到百万分之一） */
export function sqrtPriceBounds(program: ClmmProgram, sqrtPrice: bigint, slippage: number): Array<{ sqrtPrice: bigint; tick: number }> {
  if (!(slippage >= 0 && slippage < 1)) {
    throw new RangeError(`slippage must be in [0, 1): ${slippage}`)
  }
  const [min, max] = sqrtRange(program)
  const ppm = BigInt(Math.round(slippage * 1e6))
  const square = sqrtPrice * sqrtPrice
  return [1_000_000n - ppm, 1_000_000n + ppm].map((factor) => {
    let s = sqrtBigInt((square * factor) / 1_000_000n)
    s = s < min ? min : s >= max ? max - 1n : s
    return { sqrtPrice: s, tick: tickAtSqrtPrice(program, s) }
  })
}

/** 价格在 slippage 范围内变动时，流动性 L 至少对应多少代币（移除时的最小数量，向下取整） */
export function getMinAmounts(program: ClmmProgram, sqrtPrice: bigint, tickLower: number, tickUpper: number, liquidity: bigint, slippage: number): [bigint, bigint] {
  const [lower, upper] = sqrtPriceBounds(program, sqrtPrice, slippage) as [{ sqrtPrice: bigint; tick: number }, { sqrtPrice: bigint; tick: number }]
  const a = sqrtPriceAtTick(program, tickLower)
  const b = sqrtPriceAtTick(program, tickUpper)
  // token0 随价格上涨而减少，取上限价格时的；token1 取下限价格时的
  return [
    getAmountsForLiquidity(upper.tick, upper.sqrtPrice, a, b, liquidity, tickLower, tickUpper)[0],
    getAmountsForLiquidity(lower.tick, lower.sqrtPrice, a, b, liquidity, tickLower, tickUpper)[1],
  ]
}

/** 价格在 slippage 范围内变动时，添加流动性 L 最多需要多少代币（amountMax，向上取整） */
export function getMaxAmounts(program: ClmmProgram, sqrtPrice: bigint, tickLower: number, tickUpper: number, liquidity: bigint, slippage: number): [bigint, bigint] {
  const [lower, upper] = sqrtPriceBounds(program, sqrtPrice, slippage) as [{ sqrtPrice: bigint; tick: number }, { sqrtPrice: bigint; tick: number }]
  const a = sqrtPriceAtTick(program, tickLower)
  const b = sqrtPriceAtTick(program, tickUpper)
  return [
    getMintAmounts(lower.tick, lower.sqrtPrice, a, b, liquidity, tickLower, tickUpper)[0],
    getMintAmounts(upper.tick, upper.sqrtPrice, a, b, liquidity, tickLower, tickUpper)[1],
  ]
}
