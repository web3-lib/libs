/**
 * Sui 上集中流动性 DEX 的数学（Q64.64 的 sqrt 价格）：tick → sqrt 价格、按流动性算数量、按数量算流动性。
 * tick → sqrt 价格用 Cetus 的 tick_math（负 tick 用 Q64 常数、正 tick 用 Q96 常数），Cetus、Bluefin（直接依赖 Cetus 的包）、
 * Momentum、Turbos、Magma、FlowX 都是它，与链上逐位一致；按流动性算数量的取整与各合约相同
 */

export const MIN_TICK = -443636
export const MAX_TICK = 443636

const Q64 = 2n ** 64n

/** 负 tick：sqrt(1.0001)^(-2^i) 的 Q64 定点数（第一个是 bit 0 为 1 时的初值，第二个是 1.0） */
const NEGATIVE: readonly bigint[] = [
  18445821805675392311n,
  18446744073709551616n,
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

/** 正 tick：sqrt(1.0001)^(2^i) 的 Q96 定点数（同上），最后右移 32 位成 Q64 */
const POSITIVE: readonly bigint[] = [
  79232123823359799118286999567n,
  79228162514264337593543950336n,
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

/** tick → sqrt(1.0001^tick) 的 Q64.64 定点数（Cetus tick_math::get_sqrt_price_at_tick） */
export function sqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new RangeError(`tick out of range: ${tick}`)
  const abs = Math.abs(tick)
  const [table, shift] = tick < 0 ? [NEGATIVE, 64n] : [POSITIVE, 96n]
  let ratio = (abs & 1 ? table[0] : table[1]) as bigint
  for (let i = 1; i < 19; i++) if (abs & (1 << i)) ratio = (ratio * (table[i + 1] as bigint)) >> shift
  return tick < 0 ? ratio : ratio >> 32n
}

const divUp = (a: bigint, b: bigint) => (a + b - 1n) / b
const sort = (a: bigint, b: bigint): [bigint, bigint] => (a > b ? [b, a] : [a, b])

/** 区间 [a, b] 内流动性 L 对应的 token0（roundUp：添加时池子收取的；否则移除时拿到的） */
export function amount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [a, b] = sort(sqrtA, sqrtB)
  const n = (liquidity << 64n) * (b - a)
  return roundUp ? divUp(divUp(n, b), a) : n / b / a
}

/** 区间 [a, b] 内流动性 L 对应的 token1 */
export function amount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [a, b] = sort(sqrtA, sqrtB)
  return roundUp ? divUp(liquidity * (b - a), Q64) : (liquidity * (b - a)) / Q64
}

/** 当前价格下区间内流动性 L 对应的两种代币（roundUp：添加；否则移除） */
export function amountsForLiquidity(sqrtPrice: bigint, sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp = false): [bigint, bigint] {
  const [a, b] = sort(sqrtA, sqrtB)
  if (liquidity === 0n) return [0n, 0n]
  if (sqrtPrice <= a) return [amount0Delta(a, b, liquidity, roundUp), 0n]
  if (sqrtPrice < b) return [amount0Delta(sqrtPrice, b, liquidity, roundUp), amount1Delta(a, sqrtPrice, liquidity, roundUp)]
  return [0n, amount1Delta(a, b, liquidity, roundUp)]
}

/** 只给 token0 / token1 时能添加的流动性（向下取整）；价格在区间另一侧时为 0 */
export function liquidityForAmount(sqrtPrice: bigint, sqrtA: bigint, sqrtB: bigint, amount: bigint, isToken0: boolean): bigint {
  const [a, b] = sort(sqrtA, sqrtB)
  if (isToken0) {
    const lo = sqrtPrice > a ? sqrtPrice : a
    if (lo >= b) return 0n
    return (amount * ((lo * b) / Q64)) / (b - lo)
  }
  const hi = sqrtPrice < b ? sqrtPrice : b
  if (hi <= a) return 0n
  return (amount * Q64) / (hi - a)
}
