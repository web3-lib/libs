/**
 * Orca Whirlpool 的兑换：swap_v2（按输入数量）。报价照搬程序（manager/swap_manager.rs、fee_rate_manager.rs、util/sparse_swap.rs）：
 * 当前价格起最多 3 个 tick 数组（不存在的按全空处理），逐个区间计算；包括自适应费率（Oracle 账户里的波动累计）和两边的 Token-2022 转账手续费。
 * 兑换超出这 3 个 tick 数组时程序会失败，报价同样不可用
 */
import { sha256 } from '@noble/hashes/sha2.js'

import { decodeAddress, findProgramAddress } from '../address.js'
import { SYSTEM_PROGRAM_ID } from '../constants.js'
import type { AccountInfo } from '../layout.js'
import { MEMO_PROGRAM_ID, Writer, anchorIx, r, w } from '../liquidity/common.js'
import { ORCA_WHIRLPOOL_PROGRAM_ID, orcaTickArray, utf8 } from '../lp.js'
import { MAX_TICK, MIN_TICK, ORCA_MAX_SQRT_PRICE, ORCA_MIN_SQRT_PRICE, orcaSqrtPriceAtTick, tickAtSqrtPrice } from '../lpMath.js'
import type { Instruction } from '../write/transaction.js'
import { SwapMathError, computeSwapStep } from './clmmMath.js'
import { Bytes, UnsupportedPool, need, swapMint, transferFee, type AccountGetter, type HopQuote, type SwapEnv, type SwapMint, type SwapPool } from './common.js'

const PROGRAM = ORCA_WHIRLPOOL_PROGRAM_ID
const POOL_SIZE = 653
const TICK_ARRAY_SIZE = 88
const FIXED_TICK_SIZE = 113
const FEE_RATE_HARD_LIMIT = 100_000n
const VOLATILITY_SCALE = 10_000n
const REDUCTION_FACTOR_DENOMINATOR = 10_000n
const CONTROL_FACTOR_DENOMINATOR = 100_000n
const MAX_REFERENCE_AGE = 3_600n

export interface WhirlpoolState {
  address: string
  tickSpacing: number
  feeRate: bigint
  liquidity: bigint
  sqrtPrice: bigint
  tick: number
  mint0: string
  vault0: string
  mint1: string
  vault1: string
}

/** Whirlpool：tick_spacing 41、fee_rate 45、liquidity 49、sqrt_price 65、tick 81、mint_a 101、vault_a 133、mint_b 181、vault_b 213 */
export function parseWhirlpool(account: AccountInfo): WhirlpoolState | null {
  if (account.owner !== PROGRAM || account.data.length !== POOL_SIZE) return null
  const b = new Bytes(account.data)
  return {
    address: account.address,
    tickSpacing: b.u16(41),
    feeRate: BigInt(b.u16(45)),
    liquidity: b.u128(49),
    sqrtPrice: b.u128(65),
    tick: b.i32(81),
    mint0: b.key(101),
    vault0: b.key(133),
    mint1: b.key(181),
    vault1: b.key(213),
  }
}

const disc = (name: string) => sha256(utf8(`account:${name}`)).subarray(0, 8)
let discriminators: { fixed: Uint8Array; dynamic: Uint8Array; oracle: Uint8Array } | undefined
const starts = (data: Uint8Array, prefix: Uint8Array) => data.length >= 8 && prefix.every((x, i) => data[i] === x)
const i128 = (v: bigint) => (v >= 1n << 127n ? v - (1n << 128n) : v)
const floorDiv = (a: number, b: number) => Math.floor(a / b)

export const oracleAddress = (pool: string) => findProgramAddress([utf8('oracle'), decodeAddress(pool)], PROGRAM)

/** 与程序 get_start_tick_indexes 一致：当前所在的数组和方向上接下来的两个（向右时 tick 靠近数组末尾会整体右移一个） */
export function whirlpoolTickArrayStarts(state: WhirlpoolState, aToB: boolean): number[] {
  const size = TICK_ARRAY_SIZE * state.tickSpacing
  const base = floorDiv(state.tick, size) * size
  const offsets = aToB ? [0, -1, -2] : state.tick + state.tickSpacing >= base + size ? [1, 2, 3] : [0, 1, 2]
  const minStart = MIN_TICK - ((MIN_TICK % size) + size)
  return offsets
    .map((o) => base + o * size)
    .filter((s) => (s < MIN_TICK || s > MAX_TICK ? s <= MIN_TICK && s === minStart : s % size === 0))
}

interface Tick {
  initialized: boolean
  liquidityNet: bigint
}

interface TickArray {
  start: number
  /** 按偏移（0~87）的 tick；全空的数组为 null */
  ticks: Array<Tick | null>
}

/** 固定大小（TickArray）或可变大小（DynamicTickArray）的 tick 数组；账户不存在时按全空处理（与程序的 ZeroedTickArray 一致） */
function readTickArray(pool: string, start: number, account: AccountInfo | null): TickArray {
  const empty: TickArray = { start, ticks: new Array<Tick | null>(TICK_ARRAY_SIZE).fill(null) }
  if (!account || (account.owner === SYSTEM_PROGRAM_ID && account.data.length === 0)) return empty
  if (account.owner !== PROGRAM) throw new UnsupportedPool(`Tick array owned by another program: ${account.address}`)
  discriminators ??= { fixed: disc('TickArray'), dynamic: disc('DynamicTickArray'), oracle: disc('Oracle') }
  const b = new Bytes(account.data)
  const data = account.data
  if (starts(data, discriminators.fixed) && data.length >= 12 + TICK_ARRAY_SIZE * FIXED_TICK_SIZE + 32) {
    if (b.key(12 + TICK_ARRAY_SIZE * FIXED_TICK_SIZE) !== pool) throw new UnsupportedPool('Tick array of another whirlpool')
    return {
      start: b.i32(8),
      ticks: Array.from({ length: TICK_ARRAY_SIZE }, (_, i) => {
        const o = 12 + i * FIXED_TICK_SIZE
        return { initialized: b.u8(o) === 1, liquidityNet: i128(b.u128(o + 1)) }
      }),
    }
  }
  if (starts(data, discriminators.dynamic) && data.length >= 60) {
    if (b.key(12) !== pool) throw new UnsupportedPool('Tick array of another whirlpool')
    // 可变大小：未初始化的 tick 1 字节（0），初始化的 1 字节（1）+ 112 字节数据
    const ticks: Array<Tick | null> = []
    let o = 60
    for (let i = 0; i < TICK_ARRAY_SIZE; i++) {
      if (o >= data.length) throw new UnsupportedPool('Truncated dynamic tick array')
      if (b.u8(o) === 1) {
        if (o + 113 > data.length) throw new UnsupportedPool('Truncated dynamic tick array')
        ticks.push({ initialized: true, liquidityNet: i128(b.u128(o + 1)) })
        o += 113
      } else {
        ticks.push({ initialized: false, liquidityNet: 0n })
        o += 1
      }
    }
    return { start: b.i32(8), ticks }
  }
  throw new UnsupportedPool(`Unexpected tick array account: ${account.address}`)
}

interface AdaptiveFee {
  tradeEnableTimestamp: bigint
  filterPeriod: bigint
  decayPeriod: bigint
  reductionFactor: bigint
  controlFactor: bigint
  maxVolatility: bigint
  tickGroupSize: number
  lastReferenceUpdate: bigint
  lastMajorSwap: bigint
  volatilityReference: bigint
  indexReference: number
  volatility: bigint
}

/** Oracle：whirlpool 8、trade_enable_timestamp 40、常量 48（filter 48、decay 50、reduction 52、control 54、max_va 58、tick_group_size 62）、变量 82（last_ref 82、last_major 90、vr 98、ref 102、va 106） */
function readOracle(pool: string, account: AccountInfo | null): AdaptiveFee | null {
  if (!account || (account.owner === SYSTEM_PROGRAM_ID && account.data.length === 0)) return null
  discriminators ??= { fixed: disc('TickArray'), dynamic: disc('DynamicTickArray'), oracle: disc('Oracle') }
  if (account.owner !== PROGRAM || !starts(account.data, discriminators.oracle) || account.data.length < 126) throw new UnsupportedPool('Unexpected oracle account')
  const b = new Bytes(account.data)
  if (b.key(8) !== pool) throw new UnsupportedPool('Oracle of another whirlpool')
  return {
    tradeEnableTimestamp: b.u64(40),
    filterPeriod: BigInt(b.u16(48)),
    decayPeriod: BigInt(b.u16(50)),
    reductionFactor: BigInt(b.u16(52)),
    controlFactor: BigInt(b.u32(54)),
    maxVolatility: BigInt(b.u32(58)),
    tickGroupSize: b.u16(62),
    lastReferenceUpdate: b.u64(82),
    lastMajorSwap: b.u64(90),
    volatilityReference: BigInt(b.u32(98)),
    indexReference: b.i32(102),
    volatility: BigInt(b.u32(106)),
  }
}

/** 自适应费率（FeeRateManager::Adaptive）；静态费率的池子 fee 为 null */
class FeeManager {
  index = 0
  lower: { index: number; sqrt: bigint } | null = null
  upper: { index: number; sqrt: bigint } | null = null

  constructor(
    readonly aToB: boolean,
    readonly staticFee: bigint,
    readonly fee: AdaptiveFee | null,
    tick: number,
    timestamp: bigint,
  ) {
    if (!fee) return
    const size = fee.tickGroupSize
    this.index = floorDiv(tick, size)
    // update_reference
    const max = fee.lastReferenceUpdate > fee.lastMajorSwap ? fee.lastReferenceUpdate : fee.lastMajorSwap
    if (timestamp < max) throw new SwapMathError('invalid timestamp')
    if (timestamp - fee.lastReferenceUpdate > MAX_REFERENCE_AGE) {
      fee.indexReference = this.index
      fee.volatilityReference = 0n
      fee.lastReferenceUpdate = timestamp
    } else {
      const elapsed = timestamp - max
      if (elapsed >= fee.filterPeriod) {
        fee.indexReference = this.index
        fee.volatilityReference = elapsed < fee.decayPeriod ? (fee.volatility * fee.reductionFactor) / REDUCTION_FACTOR_DENOMINATOR : 0n
        fee.lastReferenceUpdate = timestamp
      }
    }
    const delta = Number((fee.maxVolatility - fee.volatilityReference + VOLATILITY_SCALE - 1n) / VOLATILITY_SCALE)
    const lowerIndex = fee.indexReference - delta
    const upperIndex = fee.indexReference + delta
    const lowerTick = lowerIndex * size
    const upperTick = upperIndex * size + size
    this.lower = lowerTick > MIN_TICK ? { index: lowerIndex, sqrt: orcaSqrtPriceAtTick(lowerTick) } : null
    this.upper = upperTick < MAX_TICK ? { index: upperIndex, sqrt: orcaSqrtPriceAtTick(upperTick) } : null
  }

  updateVolatility(): void {
    const f = this.fee
    if (!f) return
    const v = f.volatilityReference + BigInt(Math.abs(f.indexReference - this.index)) * VOLATILITY_SCALE
    f.volatility = v < f.maxVolatility ? v : f.maxVolatility
  }

  totalFee(): bigint {
    const f = this.fee
    if (!f) return this.staticFee
    const crossed = f.volatility * BigInt(f.tickGroupSize)
    const den = CONTROL_FACTOR_DENOMINATOR * VOLATILITY_SCALE * VOLATILITY_SCALE
    let adaptive = (f.controlFactor * crossed * crossed + den - 1n) / den
    if (adaptive > FEE_RATE_HARD_LIMIT) adaptive = FEE_RATE_HARD_LIMIT
    const total = this.staticFee + adaptive
    return total > FEE_RATE_HARD_LIMIT ? FEE_RATE_HARD_LIMIT : total
  }

  /** 这一步最多走到的价格和是否跳过了 tick 组的逐个计算 */
  bounded(target: bigint, liquidity: bigint): [bigint, boolean] {
    const f = this.fee
    if (!f) return [target, false]
    if (f.controlFactor === 0n || liquidity === 0n) return [target, true]
    if (this.lower && this.index < this.lower.index) return this.aToB ? [target, true] : [target < this.lower.sqrt ? target : this.lower.sqrt, true]
    if (this.upper && this.index > this.upper.index) return this.aToB ? [target > this.upper.sqrt ? target : this.upper.sqrt, true] : [target, true]
    const size = f.tickGroupSize
    const boundary = Math.min(Math.max(this.aToB ? this.index * size : this.index * size + size, MIN_TICK), MAX_TICK)
    const s = orcaSqrtPriceAtTick(boundary)
    return this.aToB ? [target > s ? target : s, false] : [target < s ? target : s, false]
  }

  advance(): void {
    if (this.fee) this.index += this.aToB ? -1 : 1
  }

  advanceAfterSkip(sqrtPrice: bigint, nextTickSqrt: bigint, nextTick: number): void {
    const f = this.fee as AdaptiveFee
    const size = f.tickGroupSize
    let tick: number
    let onBoundary: boolean
    if (sqrtPrice === nextTickSqrt) {
      tick = nextTick
      onBoundary = nextTick % size === 0
    } else {
      tick = tickAtSqrtPrice('orca', sqrtPrice)
      onBoundary = tick % size === 0 && sqrtPrice === orcaSqrtPriceAtTick(tick)
    }
    const last = onBoundary && !this.aToB ? Math.trunc(tick / size) - 1 : floorDiv(tick, size)
    if ((this.aToB && last < this.index) || (!this.aToB && last > this.index)) {
      this.index = last
      this.updateVolatility()
    }
    this.index += this.aToB ? -1 : 1
  }
}

/** 本地报价（swap_manager::swap 的按输入数量部分）：amount 是扣掉输入转账手续费后的数量，返回池子付出的输出 */
export function whirlpoolSwap(state: WhirlpoolState, arrays: readonly TickArray[], oracle: AdaptiveFee | null, amount: bigint, aToB: boolean, timestamp: bigint): { amountOut: bigint; crossed: number } {
  if (amount === 0n) throw new SwapMathError('zero amount')
  const spacing = state.tickSpacing
  const limit = aToB ? ORCA_MIN_SQRT_PRICE : ORCA_MAX_SQRT_PRICE
  if (aToB ? limit >= state.sqrtPrice : limit <= state.sqrtPrice) throw new SwapMathError('price is at the limit')
  if (oracle && oracle.tradeEnableTimestamp > timestamp) throw new UnsupportedPool('Trading is not enabled yet')
  const size = TICK_ARRAY_SIZE * spacing
  const fees = new FeeManager(aToB, state.feeRate, oracle ? { ...oracle } : null, state.tick, timestamp)

  const nextInit = (arrayIndex: number, tickIndex: number): [number, number] => {
    let search = tickIndex
    let i = arrayIndex
    for (;;) {
      const array = arrays[i]
      if (!array) throw new UnsupportedPool('Swap goes beyond the 3 tick arrays the program accepts (amount too large for this pool)')
      // in_search_range：向右时整体左移一个 tickSpacing
      const lo = array.start - (aToB ? 0 : spacing)
      if (search < lo || search >= lo + size) throw new SwapMathError('invalid tick array sequence')
      let offset = floorDiv(search - array.start, spacing)
      if (!aToB) offset += 1
      for (; offset >= 0 && offset < TICK_ARRAY_SIZE; offset += aToB ? -1 : 1) {
        if (array.ticks[offset]?.initialized) return [i, array.start + offset * spacing]
      }
      if (aToB && array.start <= MIN_TICK) return [i, MIN_TICK]
      if (!aToB && array.start + size > MAX_TICK) return [i, MAX_TICK]
      if (i + 1 === arrays.length) return [i, aToB ? array.start : array.start + size - 1]
      search = aToB ? array.start - 1 : array.start + size - 1
      i += 1
    }
  }

  let remaining = amount
  let calculated = 0n
  let sqrt = state.sqrtPrice
  let tick = state.tick
  let liquidity = state.liquidity
  let arrayIndex = 0
  let crossed = 0
  while (remaining > 0n && limit !== sqrt) {
    const [nextArray, nextTick] = nextInit(arrayIndex, tick)
    const nextTickSqrt = orcaSqrtPriceAtTick(nextTick)
    const target = aToB ? (nextTickSqrt > limit ? nextTickSqrt : limit) : nextTickSqrt < limit ? nextTickSqrt : limit
    for (;;) {
      fees.updateVolatility()
      const totalFee = fees.totalFee()
      const [bounded, skipped] = fees.bounded(target, liquidity)
      const step = computeSwapStep(sqrt, bounded, liquidity, remaining, totalFee, aToB, true, 'orca')
      remaining -= step.amountIn + step.feeAmount
      if (remaining < 0n) throw new SwapMathError('amount remaining overflow')
      calculated += step.amountOut
      if (step.sqrtPrice === nextTickSqrt) {
        const array = arrays[nextArray] as TickArray
        const usable = nextTick >= MIN_TICK && nextTick <= MAX_TICK && nextTick % spacing === 0 && nextTick >= array.start && nextTick < array.start + size
        const t = usable ? array.ticks[floorDiv(nextTick - array.start, spacing)] : null
        if (t?.initialized) {
          liquidity += aToB ? -t.liquidityNet : t.liquidityNet
          crossed++
          if (liquidity < 0n || liquidity >= 1n << 128n) throw new SwapMathError('liquidity overflow')
        }
        const offset = floorDiv(nextTick - array.start, spacing)
        arrayIndex = (aToB && offset === 0) || (!aToB && offset === TICK_ARRAY_SIZE - 1) ? nextArray + 1 : nextArray
        tick = aToB ? nextTick - 1 : nextTick
      } else if (step.sqrtPrice !== sqrt) {
        tick = tickAtSqrtPrice('orca', step.sqrtPrice)
      }
      sqrt = step.sqrtPrice
      if (!skipped) fees.advance()
      else fees.advanceAfterSkip(sqrt, nextTickSqrt, nextTick)
      if (remaining === 0n || sqrt === target) break
    }
  }
  // 不给价格上限时只有走到最低 / 最高价格才会部分成交：当作流动性不足
  if (remaining > 0n) throw new UnsupportedPool('Insufficient liquidity')
  return { amountOut: calculated, crossed }
}

export function whirlpoolPool(state: WhirlpoolState): SwapPool {
  const mints = (get: AccountGetter): [SwapMint, SwapMint] => [
    swapMint(state.mint0, need(get, state.mint0, 'Token mint')),
    swapMint(state.mint1, need(get, state.mint1, 'Token mint')),
  ]
  const oracle = oracleAddress(state.address)
  const arrayAddresses = (aToB: boolean) => whirlpoolTickArrayStarts(state, aToB).map((s) => ({ start: s, address: orcaTickArray(state.address, s, state.tickSpacing).address }))
  return {
    protocol: 'orca-whirlpool',
    address: state.address,
    mint0: state.mint0,
    mint1: state.mint1,
    mints,
    accounts: (aToB) => [state.mint0, state.mint1, oracle, ...arrayAddresses(aToB).map((a) => a.address)],
    quote(get, amountIn, aToB, env: SwapEnv): HopQuote {
      const [m0, m1] = mints(get)
      const list = arrayAddresses(aToB)
      const arrays = list.map((a) => {
        const account = get(a.address)
        if (account === undefined) throw new Error(`Tick array was not loaded: ${a.address}`)
        return readTickArray(state.address, a.start, account)
      })
      const oracleAccount = get(oracle)
      if (oracleAccount === undefined) throw new Error(`Oracle was not loaded: ${oracle}`)
      const [mintIn, mintOut] = aToB ? [m0, m1] : [m1, m0]
      const into = amountIn - transferFee(mintIn, amountIn, env.epoch)
      if (into <= 0n) return { amountIn, amountOut: 0n, accounts: [] }
      const { amountOut: out, crossed } = whirlpoolSwap(state, arrays, readOracle(state.address, oracleAccount), into, aToB, env.timestamp)
      // 固定传 3 个 tick 数组（不足 3 个有效起点时重复最后一个，程序会去重）
      const addresses = list.map((a) => a.address)
      while (addresses.length < 3) addresses.push(addresses[addresses.length - 1] as string)
      return { amountIn, amountOut: out - transferFee(mintOut, out, env.epoch), accounts: addresses, crossed }
    },
    instruction(get, owner, input, output, aToB, quote, minOut): Instruction {
      const [m0, m1] = mints(get)
      const [ownerA, ownerB] = aToB ? [input, output] : [output, input]
      return {
        programId: PROGRAM,
        keys: [
          r(m0.program),
          r(m1.program),
          r(MEMO_PROGRAM_ID),
          r(owner, true),
          w(state.address),
          r(m0.mint),
          r(m1.mint),
          w(ownerA),
          w(state.vault0),
          w(ownerB),
          w(state.vault1),
          ...quote.accounts.map((a) => w(a)),
          w(oracle),
        ],
        // sqrt_price_limit 0（不限价）、amount_specified_is_input、a_to_b、remaining_accounts_info: None
        data: new Writer().bytes(anchorIx('swap_v2')).u64(quote.amountIn).u64(minOut).u128(0n).bool(true).bool(aToB).u8(0).build(),
      }
    },
  }
}
