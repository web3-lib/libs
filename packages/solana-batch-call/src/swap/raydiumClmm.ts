/**
 * Raydium CLMM 的兑换：swap_v2（按输入数量）。报价照搬程序的 swap_internal（instructions/swap.rs，2026-09 的版本）：
 * 按 tick 数组位图找下一个已初始化的 tick，逐个区间计算；包括 fee_on（手续费从输入 / 输出扣）、动态费率（按波动累计）、
 * tick 上的限价单（先按 tick 价格成交）、两边的 Token-2022 转账手续费。
 * 不支持需要位图扩展账户的池子（当前价格或兑换路径超出池子自带位图覆盖的范围，只会出现在 tick spacing < 15 的池子）
 */
import { MEMO_PROGRAM_ID, Writer, anchorIx, r, w } from '../liquidity/common.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../constants.js'
import type { AccountInfo } from '../layout.js'
import { RAYDIUM_CLMM_PROGRAM_ID, raydiumTickArray } from '../lp.js'
import { MAX_TICK, MIN_TICK, RAYDIUM_MAX_SQRT_PRICE, RAYDIUM_MIN_SQRT_PRICE, raydiumSqrtPriceAtTick, tickAtSqrtPrice } from '../lpMath.js'
import type { Instruction } from '../write/transaction.js'
import { FEE_RATE_DENOMINATOR, SwapMathError, computeSwapStep } from './clmmMath.js'
import { Bytes, NeedAccounts, UnsupportedPool, U64_MAX, mulDivCeil, need, swapMint, transferFee, type AccountGetter, type HopQuote, type SwapEnv, type SwapMint, type SwapPool } from './common.js'

const POOL_SIZE = 1544
const TICK_ARRAY_LEN = 10240
const TICK_ARRAY_SIZE = 60
const TICK_SIZE = 168
const BITMAP_SIZE = 512
const Q64 = 1n << 64n
/** 先读几个 tick 数组（当前的和兑换方向上已初始化的），不够时每次再多读 3 个，最多 MAX_TICK_ARRAYS 个 */
const INITIAL_TICK_ARRAYS = 2
const MAX_TICK_ARRAYS = 10
const MAX_FEE_RATE = 100_000n
const DYNAMIC_FEE_CONTROL_DENOMINATOR = 100_000n
const VOLATILITY_SCALE = 10_000n
const REDUCTION_FACTOR_DENOMINATOR = 10_000n

interface DynamicFee {
  filterPeriod: bigint
  decayPeriod: bigint
  reductionFactor: bigint
  control: bigint
  maxVolatility: bigint
  indexReference: number
  volatilityReference: bigint
  volatility: bigint
  lastUpdate: bigint
}

export interface RaydiumClmmState {
  address: string
  config: string
  mint0: string
  mint1: string
  vault0: string
  vault1: string
  observation: string
  tickSpacing: number
  liquidity: bigint
  sqrtPrice: bigint
  tick: number
  status: number
  feeOn: number
  bitmap: bigint
  openTime: bigint
  dynamicFee: DynamicFee | null
}

/**
 * PoolState：amm_config 9、mint 73 / 105、vault 137 / 169、observation 201、tick_spacing 235、liquidity 237、sqrt_price 253、tick 269、
 * status 389、fee_on 390、tick_array_bitmap 904（16 个 u64）、open_time 1080、dynamic_fee_info 1096（80 字节，全 0 表示没有）
 */
export function parseRaydiumClmmPool(account: AccountInfo): RaydiumClmmState | null {
  if (account.owner !== RAYDIUM_CLMM_PROGRAM_ID || account.data.length !== POOL_SIZE) return null
  const b = new Bytes(account.data)
  let bitmap = 0n
  for (let i = 15; i >= 0; i--) bitmap = (bitmap << 64n) | b.u64(904 + i * 8)
  const fee = account.data.subarray(1096, 1176)
  const dynamicFee = fee.some((x) => x !== 0)
    ? {
        filterPeriod: BigInt(b.u16(1096)),
        decayPeriod: BigInt(b.u16(1098)),
        reductionFactor: BigInt(b.u16(1100)),
        control: BigInt(b.u32(1102)),
        maxVolatility: BigInt(b.u32(1106)),
        indexReference: b.i32(1110),
        volatilityReference: BigInt(b.u32(1114)),
        volatility: BigInt(b.u32(1118)),
        lastUpdate: b.u64(1122),
      }
    : null
  return {
    address: account.address,
    config: b.key(9),
    mint0: b.key(73),
    mint1: b.key(105),
    vault0: b.key(137),
    vault1: b.key(169),
    observation: b.key(201),
    tickSpacing: b.u16(235),
    liquidity: b.u128(237),
    sqrtPrice: b.u128(253),
    tick: b.i32(269),
    status: b.u8(389),
    feeOn: b.u8(390),
    bitmap,
    openTime: b.u64(1080),
    dynamicFee,
  }
}

const floorDiv = (a: number, b: number) => Math.floor(a / b)
const arrayStart = (tick: number, spacing: number) => floorDiv(tick, spacing * TICK_ARRAY_SIZE) * spacing * TICK_ARRAY_SIZE
const i128 = (v: bigint) => (v >= 1n << 127n ? v - (1n << 128n) : v)

/** 池子自带位图里这个 tick 数组是否已初始化；超出位图覆盖的范围时为 null */
function bitmapHas(state: RaydiumClmmState, start: number): boolean | null {
  const multiplier = state.tickSpacing * TICK_ARRAY_SIZE
  const bit = start / multiplier + BITMAP_SIZE
  if (bit < 0 || bit >= 2 * BITMAP_SIZE) return null
  return ((state.bitmap >> BigInt(bit)) & 1n) === 1n
}

/** 兑换会经过的已初始化 tick 数组（当前的，以及方向上接下来的），最多 count 个；需要位图扩展时报不支持 */
function tickArrayStarts(state: RaydiumClmmState, zeroForOne: boolean, count: number): number[] {
  const step = state.tickSpacing * TICK_ARRAY_SIZE
  let start = arrayStart(state.tick, state.tickSpacing)
  const current = bitmapHas(state, start)
  if (current === null) throw new UnsupportedPool('Pool price is outside the default tick array bitmap (needs the bitmap extension account)')
  const out = current ? [start] : []
  while (out.length < count) {
    start += zeroForOne ? -step : step
    const has = bitmapHas(state, start)
    if (has === null) break
    if (has) out.push(start)
  }
  return out
}

interface TickState {
  tick: number
  liquidityNet: bigint
  liquidityGross: bigint
  /** 限价单未成交的数量（orders_amount + part_filled_orders_remaining） */
  unfilled: bigint
}

/** TickArrayState：pool_id 8、start_tick_index 40、ticks 44（60 个，每个 168 字节：tick +0、liquidity_net +4、liquidity_gross +20、orders_amount +124、part_filled +132） */
function readTickArray(state: RaydiumClmmState, address: string, start: number, account: AccountInfo | null | undefined): TickState[] {
  if (!account || account.owner !== RAYDIUM_CLMM_PROGRAM_ID || account.data.length !== TICK_ARRAY_LEN) {
    throw new UnsupportedPool(`Tick array not loaded: ${address}`)
  }
  const b = new Bytes(account.data)
  if (b.key(8) !== state.address || b.i32(40) !== start) throw new UnsupportedPool(`Unexpected tick array: ${address}`)
  return Array.from({ length: TICK_ARRAY_SIZE }, (_, i) => {
    const o = 44 + i * TICK_SIZE
    return { tick: start + i * state.tickSpacing, liquidityNet: i128(b.u128(o + 4)), liquidityGross: b.u128(o + 20), unfilled: b.u64(o + 124) + b.u64(o + 132) }
  })
}

/** 兑换走到了没有读的 tick 数组 */
export class MissingTickArray extends Error {
  constructor(readonly start: number) {
    super(`Tick array ${start} is not loaded`)
  }
}

const initialized = (t: TickState) => t.liquidityGross > 0n || t.unfilled > 0n

/** 与程序 tick_spacing_index_from_tick 一致：向负无穷取整 */
function spacingIndex(tick: number, spacing: number): number {
  return tick % spacing === 0 || tick >= 0 ? Math.trunc(tick / spacing) : Math.trunc(tick / spacing) - 1
}

/** 动态费率（与程序 compute_dynamic_fee_rate 一致） */
function dynamicFeeRate(fee: DynamicFee, spacing: number): bigint {
  const crossed = fee.volatility * BigInt(spacing)
  const rate = mulDivCeil(fee.control, crossed * crossed, DYNAMIC_FEE_CONTROL_DENOMINATOR * VOLATILITY_SCALE * VOLATILITY_SCALE)
  return rate > MAX_FEE_RATE ? MAX_FEE_RATE : rate
}

/** tick 的价格（Q64.64，price = sqrt² / 2^64） */
const priceOf = (sqrt: bigint, roundUp: boolean) => (sqrt * sqrt + (roundUp ? Q64 - 1n : 0n)) >> 64n

/**
 * 本地报价（swap_internal 的按输入数量部分）。amount 是扣掉输入转账手续费后进入池子的数量；
 * 返回池子付出的输出（未扣输出转账手续费）和经过的 tick 数组
 */
export function raydiumSwap(
  state: RaydiumClmmState,
  arrays: ReadonlyMap<number, TickState[]>,
  amount: bigint,
  zeroForOne: boolean,
  baseFeeRate: bigint,
  timestamp: bigint,
): { amountIn: bigint; amountOut: bigint; starts: number[]; crossed: number; orders: number } {
  const spacing = state.tickSpacing
  const limit = zeroForOne ? RAYDIUM_MIN_SQRT_PRICE + 1n : RAYDIUM_MAX_SQRT_PRICE - 1n
  if (amount === 0n) throw new SwapMathError('zero amount')
  if (zeroForOne ? !(limit < state.sqrtPrice) : !(limit > state.sqrtPrice)) throw new SwapMathError('price is at the limit')
  // 只读一次的 tick 数组按顺序取（与程序一样按位图找下一个）
  const step = spacing * TICK_ARRAY_SIZE
  const getArray = (start: number) => {
    const ticks = arrays.get(start)
    if (!ticks) throw new MissingTickArray(start)
    return ticks
  }
  const nextArrayStart = (from: number): number => {
    let s = from
    for (;;) {
      s += zeroForOne ? -step : step
      const has = bitmapHas(state, s)
      if (has === null) {
        if (spacing >= 15) throw new UnsupportedPool('Insufficient liquidity')
        throw new UnsupportedPool('Swap goes beyond the default tick array bitmap (needs the bitmap extension account)')
      }
      if (has) return s
    }
  }
  const currentStart = arrayStart(state.tick, spacing)
  const currentInit = bitmapHas(state, currentStart)
  if (currentInit === null) throw new UnsupportedPool('Pool price is outside the default tick array bitmap (needs the bitmap extension account)')
  let firstContains = currentInit
  let validStart = currentInit ? currentStart : nextArrayStart(currentStart)
  let ticks = getArray(validStart)
  const starts = [validStart]

  const feeOnInput = state.feeOn === 1 ? zeroForOne : state.feeOn === 2 ? !zeroForOne : true
  let remaining = amount
  let calculated = 0n
  let sqrt = state.sqrtPrice
  let tick = state.tick
  let liquidity = state.liquidity
  // 动态费率：开始时按时间更新参考值
  const fee = state.dynamicFee ? { ...state.dynamicFee } : null
  let index = 0
  if (fee) {
    index = spacingIndex(tick, spacing)
    const elapsed = timestamp > fee.lastUpdate ? timestamp - fee.lastUpdate : 0n
    if (elapsed >= fee.filterPeriod) {
      fee.indexReference = index
      fee.volatilityReference = elapsed < fee.decayPeriod ? (fee.volatility * fee.reductionFactor) / REDUCTION_FACTOR_DENOMINATOR : 0n
      fee.lastUpdate = timestamp
    }
  }
  const updateVolatility = () => {
    if (!fee) return
    const v = fee.volatilityReference + BigInt(Math.abs(fee.indexReference - index)) * VOLATILITY_SCALE
    fee.volatility = v < fee.maxVolatility ? v : fee.maxVolatility
  }
  const apply = (amountIn: bigint, amountOut: bigint, feeAmount: bigint) => {
    remaining -= feeOnInput ? amountIn + feeAmount : amountIn
    calculated += amountOut
    if (remaining < 0n) throw new SwapMathError('amount remaining overflow')
  }
  // 限价单剩余（按 tick）：同一笔里可能被吃掉一部分
  const unfilled = new Map<number, bigint>()
  let crossed = 0
  let orders = 0

  while (remaining !== 0n && sqrt !== limit) {
    // 下一个已初始化的 tick
    let next: TickState | undefined
    const inCurrent = arrayStart(tick, spacing) === validStart
    if (inCurrent) {
      const offset = Math.floor((tick - validStart) / spacing)
      if (zeroForOne) {
        for (let i = offset; i >= 0 && !next; i--) if (initialized(ticks[i] as TickState)) next = ticks[i]
      } else {
        for (let i = offset + 1; i < TICK_ARRAY_SIZE && !next; i++) if (initialized(ticks[i] as TickState)) next = ticks[i]
      }
    }
    if (!next) {
      if (!firstContains) {
        firstContains = true
      } else {
        validStart = nextArrayStart(validStart)
        ticks = getArray(validStart)
        starts.push(validStart)
      }
      next = zeroForOne ? [...ticks].reverse().find(initialized) : ticks.find(initialized)
      if (!next) throw new UnsupportedPool('Invalid tick array (no initialized tick)')
    }
    const nextState: TickState = { ...next, unfilled: unfilled.get(next.tick) ?? next.unfilled }
    if (!initialized(nextState)) throw new SwapMathError('tick is not initialized')
    const tickNext = Math.min(Math.max(nextState.tick, MIN_TICK), MAX_TICK)
    const sqrtNextTick = raydiumSqrtPriceAtTick(tickNext)
    const target = (zeroForOne && sqrtNextTick < limit) || (!zeroForOne && sqrtNextTick > limit) ? limit : sqrtNextTick

    let liquidityNext = liquidity
    for (;;) {
      updateVolatility()
      let totalFee = baseFeeRate
      if (fee) {
        totalFee = baseFeeRate + dynamicFeeRate(fee, spacing)
        if (totalFee > MAX_FEE_RATE) totalFee = MAX_FEE_RATE
      }
      // 动态费率：每次最多走到当前 tick 组（tickSpacing 个 tick）的边界
      let skipped = true
      let bounded = target
      let boundedTick: number | null = null
      if (fee && liquidity !== 0n && fee.volatility !== fee.maxVolatility) {
        skipped = false
        const bt = Math.min(Math.max(zeroForOne ? index * spacing : (index + 1) * spacing, MIN_TICK), MAX_TICK)
        const bs = raydiumSqrtPriceAtTick(bt)
        if (zeroForOne ? target <= bs : target >= bs) {
          bounded = bs
          boundedTick = bt
        }
      }
      let stepPrice = bounded
      if (sqrt !== bounded) {
        const s = computeSwapStep(sqrt, bounded, liquidity, remaining, totalFee, zeroForOne, feeOnInput, 'raydium')
        apply(s.amountIn, s.amountOut, s.feeAmount)
        stepPrice = s.sqrtPrice
      }
      if (sqrtNextTick === stepPrice) {
        // 走到 tick：先按 tick 价格和限价单成交
        const total = nextState.unfilled
        if (remaining !== 0n && total !== 0n) {
          const price0 = priceOf(sqrtNextTick, !zeroForOne)
          let lin: bigint
          let lfee = 0n
          let lout: bigint
          if (feeOnInput) {
            lfee = mulDivCeil(remaining, totalFee, FEE_RATE_DENOMINATOR)
            lin = remaining - lfee
          } else {
            lin = remaining
          }
          const matched = zeroForOne ? (lin * price0) / Q64 : (lin * Q64) / price0
          if (matched > total) {
            lout = total
            lin = zeroForOne ? mulDivCeil(total, Q64, price0) : mulDivCeil(total, price0, Q64)
            if (lin > U64_MAX) throw new SwapMathError('limit order input overflow')
            if (feeOnInput) lfee = mulDivCeil(lin, totalFee, FEE_RATE_DENOMINATOR - totalFee)
          } else {
            lout = matched
          }
          nextState.unfilled = total - lout
          unfilled.set(nextState.tick, nextState.unfilled)
          if (!feeOnInput) {
            lfee = mulDivCeil(lout, totalFee, FEE_RATE_DENOMINATOR)
            lout -= lfee
          }
          if (lin !== 0n || lout !== 0n || lfee !== 0n) {
            apply(lin, lout, lfee)
            orders++
          }
        }
        const hasOrders = nextState.unfilled > 0n
        if (nextState.liquidityGross > 0n && !hasOrders) {
          liquidityNext = liquidity + (zeroForOne ? -nextState.liquidityNet : nextState.liquidityNet)
          crossed++
          if (liquidityNext < 0n) throw new SwapMathError('liquidity underflow')
        }
        tick = (zeroForOne && !hasOrders) || (!zeroForOne && hasOrders) ? tickNext - 1 : tickNext
      } else if (sqrt !== stepPrice) {
        tick = boundedTick !== null && stepPrice === bounded ? boundedTick : tickAtSqrtPrice('raydium', stepPrice)
      }
      sqrt = stepPrice
      if (fee) {
        if (skipped) {
          const t = sqrt === sqrtNextTick ? tickNext : tick
          let idx = spacingIndex(t, spacing)
          if (!zeroForOne && t % spacing === 0) idx -= 1
          index = idx
          if (fee.volatility !== fee.maxVolatility) updateVolatility()
        }
        index += zeroForOne ? -1 : 1
      }
      if (remaining === 0n || sqrt === target) break
    }
    liquidity = liquidityNext
  }
  // 没有给价格上限时不允许部分成交
  if (remaining !== 0n) throw new UnsupportedPool('Insufficient liquidity')
  return { amountIn: amount, amountOut: calculated, starts, crossed, orders }
}

export function raydiumClmmPool(state: RaydiumClmmState): SwapPool {
  const mints = (get: AccountGetter): [SwapMint, SwapMint] => [
    swapMint(state.mint0, need(get, state.mint0, 'Token mint')),
    swapMint(state.mint1, need(get, state.mint1, 'Token mint')),
  ]
  const arrayAddress = (start: number) => raydiumTickArray(state.address, start, state.tickSpacing).address
  return {
    protocol: 'raydium-clmm',
    address: state.address,
    mint0: state.mint0,
    mint1: state.mint1,
    mints,
    accounts(zeroForOne) {
      let starts: number[] = []
      try {
        starts = tickArrayStarts(state, zeroForOne, INITIAL_TICK_ARRAYS)
      } catch {
        // 报价时再报不支持
      }
      return [state.config, state.mint0, state.mint1, ...starts.map(arrayAddress)]
    },
    quote(get, amountIn, zeroForOne, env: SwapEnv): HopQuote {
      // status 第 4 位（Swap）为 1 表示禁止兑换
      if (state.status & 16) throw new UnsupportedPool('Swap is disabled on this pool')
      if (!(env.timestamp > state.openTime)) throw new UnsupportedPool('Pool is not open yet')
      const [m0, m1] = mints(get)
      const config = need(get, state.config, 'AMM config')
      if (config.data.length < 57) throw new UnsupportedPool('Unexpected AMM config')
      // AmmConfig：protocol_fee_rate 43、trade_fee_rate 47、fund_fee_rate 53（u32）
      const baseFee = BigInt(new Bytes(config.data).u32(47))
      // 已经读到的 tick 数组（按位图顺序，读到第一个没读的为止）
      const all = tickArrayStarts(state, zeroForOne, MAX_TICK_ARRAYS)
      const arrays = new Map<number, TickState[]>()
      for (const start of all) {
        const address = arrayAddress(start)
        const account = get(address)
        if (account === undefined) break
        arrays.set(start, readTickArray(state, address, start, account))
      }
      const [mintIn, mintOut] = zeroForOne ? [m0, m1] : [m1, m0]
      const into = amountIn - transferFee(mintIn, amountIn, env.epoch)
      if (into <= 0n) return { amountIn, amountOut: 0n, accounts: [] }
      let result: ReturnType<typeof raydiumSwap>
      try {
        result = raydiumSwap(state, arrays, into, zeroForOne, baseFee, env.timestamp)
      } catch (err) {
        if (!(err instanceof MissingTickArray)) throw err
        const more = all.filter((s) => !arrays.has(s)).slice(0, 3)
        if (!more.length) throw new UnsupportedPool(`The swap needs more than ${MAX_TICK_ARRAYS} tick arrays (amount too large for this pool)`)
        throw new NeedAccounts(more.map(arrayAddress))
      }
      if (result.amountOut === 0n) return { amountIn, amountOut: 0n, accounts: [] }
      // 交易里传经过的 tick 数组，再多带一个（价格在发送前变动时用）
      const loaded = [...arrays.keys()]
      const extra = loaded.find((s) => !result.starts.includes(s) && (zeroForOne ? s < (result.starts.at(-1) as number) : s > (result.starts.at(-1) as number)))
      const used = extra === undefined ? result.starts : [...result.starts, extra]
      return {
        amountIn,
        amountOut: result.amountOut - transferFee(mintOut, result.amountOut, env.epoch),
        accounts: used.map(arrayAddress),
        crossed: result.crossed,
        orders: result.orders,
      }
    },
    instruction(get, owner, input, output, zeroForOne, quote, minOut): Instruction {
      const [m0, m1] = mints(get)
      const [mintIn, mintOut] = zeroForOne ? [m0, m1] : [m1, m0]
      const [vaultIn, vaultOut] = zeroForOne ? [state.vault0, state.vault1] : [state.vault1, state.vault0]
      return {
        programId: RAYDIUM_CLMM_PROGRAM_ID,
        keys: [
          r(owner, true),
          r(state.config),
          w(state.address),
          w(input),
          w(output),
          w(vaultIn),
          w(vaultOut),
          w(state.observation),
          r(TOKEN_PROGRAM_ID),
          r(TOKEN_2022_PROGRAM_ID),
          r(MEMO_PROGRAM_ID),
          r(mintIn.mint),
          r(mintOut.mint),
          ...quote.accounts.map((a) => w(a)),
        ],
        // sqrt_price_limit 0：不限价（程序要求全部成交）；is_base_input true
        data: new Writer().bytes(anchorIx('swap_v2')).u64(quote.amountIn).u64(minOut).u128(0n).bool(true).build(),
      }
    },
  }
}
