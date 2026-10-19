/**
 * Cetus DLMM 的交易命令（只在 /liquidity 里用到）：router 的 spot 策略加流动性（区间内平均分配：当前 bin 以上只放 token0，
 * 以下只放 token1，当前 bin 两种都放），pool 的按比例移除、领取、关闭。合约没有数量上下限：用 active bin 的偏移（bin_shift）防价格变动，
 * 移除时另在交易里检查取回的数量
 */
import { keepBalance } from './dex/env.js'
import { guardMin } from './dex/pay.js'
import type { DexEnv } from './dex/types.js'
import { i32Bits } from './dex/util.js'
import { CETUS_DLMM, type DlmmPool } from './dlmm.js'
import { pure, type Argument } from './write/bcs.js'

const args = (pool: DlmmPool) => [pool.coinA, pool.coinB]
const config = (env: DexEnv) => env.shared(CETUS_DLMM.config, false)
const versioned = (env: DexEnv) => env.shared(CETUS_DLMM.versioned, false)
const poolArg = (env: DexEnv, pool: DlmmPool) => env.shared(pool.shared, true)
const u32 = (env: DexEnv, v: number) => env.ptb.pure(pure.u32(i32Bits(v)))

export interface DlmmAddArgs {
  coinA: Argument
  coinB: Argument
  amountA: bigint
  amountB: bigint
  binLower: number
  binUpper: number
  /** 报价时的 active bin 和允许的偏移（超出时合约拒绝） */
  activeBin: number
  binShift: number
}

/** 新建仓位：router::spot::open_position（币是 &mut，用剩的留在里面），仓位转给 owner */
export function openDlmm(env: DexEnv, pool: DlmmPool, a: DlmmAddArgs): void {
  const ptb = env.ptb
  const position = ptb.moveCall(`${env.pkg(CETUS_DLMM.router)}::spot::open_position`, args(pool), [
    poolArg(env, pool),
    a.coinA,
    a.coinB,
    ptb.pure(pure.u64(a.amountA)),
    ptb.pure(pure.u64(a.amountB)),
    u32(env, a.binLower),
    ptb.pure(pure.u16(a.binUpper - a.binLower + 1)),
    u32(env, a.activeBin),
    ptb.pure(pure.u32(a.binShift)),
    config(env),
    versioned(env),
    env.clock(),
  ])
  env.keep(position)
}

/** 往已有仓位追加：router::spot::add_liquidity（区间是仓位的区间） */
export function addDlmm(env: DexEnv, pool: DlmmPool, position: Argument, a: DlmmAddArgs): void {
  const ptb = env.ptb
  ptb.moveCall(`${env.pkg(CETUS_DLMM.router)}::spot::add_liquidity`, args(pool), [
    poolArg(env, pool),
    position,
    a.coinA,
    a.coinB,
    ptb.pure(pure.u64(a.amountA)),
    ptb.pure(pure.u64(a.amountB)),
    u32(env, a.binLower),
    u32(env, a.binUpper),
    u32(env, a.activeBin),
    ptb.pure(pure.u32(a.binShift)),
    config(env),
    versioned(env),
    env.clock(),
  ])
}

/** 领取手续费（fee 为 false 时不领）和奖励（先更新仓位的累计值）；领取的币留给 owner */
export function collectDlmm(env: DexEnv, pool: DlmmPool, position: Argument, positionId: string, fee: boolean, claim: readonly number[]): void {
  const ptb = env.ptb
  const pkg = env.pkg(CETUS_DLMM.pkg)
  if (!fee && !claim.length) return
  ptb.moveCall(`${pkg}::pool::update_position_fee_and_rewards`, args(pool), [poolArg(env, pool), ptb.pure(pure.address(positionId)), versioned(env), env.clock()])
  if (fee) {
    const out = ptb.moveCall(`${pkg}::pool::collect_position_fee`, args(pool), [poolArg(env, pool), position, config(env), versioned(env)])
    keepBalance(env, ptb.nested(out, 0), pool.coinA)
    keepBalance(env, ptb.nested(out, 1), pool.coinB)
  }
  for (const k of claim) {
    const reward = pool.rewardCoins[k] as string
    keepBalance(env, ptb.moveCall(`${pkg}::pool::collect_position_reward`, [...args(pool), reward], [poolArg(env, pool), position, config(env), versioned(env)]), reward)
  }
}

/** 价格保护：active bin 偏离报价时超过 binShift 个 bin 就整笔失败（合约的移除没有数量下限） */
export function guardDlmm(env: DexEnv, pool: DlmmPool, activeBin: number, binShift: number): void {
  env.ptb.moveCall(`${env.pkg(CETUS_DLMM.router)}::utils::validate_active_id_slippage`, args(pool), [
    env.shared(pool.shared, false),
    u32(env, activeBin),
    env.ptb.pure(pure.u32(binShift)),
  ])
}

/** 取回的 Balance → Coin，检查不少于下限（合约的移除没有下限），留给 owner */
function keepAtLeast(env: DexEnv, balance: Argument, coinType: string, min: bigint): void {
  const coin = env.ptb.moveCall('0x2::coin::from_balance', [coinType], [balance])
  guardMin(env.ptb, coin, min)
  env.keepCoin(coin, coinType)
}

/** 按比例移除（万分之一，10000 = 全部）仓位区间内的流动性；取回的数量不少于 minA / minB */
export function removeDlmm(env: DexEnv, pool: DlmmPool, position: Argument, binLower: number, binUpper: number, bps: number, minA: bigint, minB: bigint): void {
  const ptb = env.ptb
  const out = ptb.moveCall(`${env.pkg(CETUS_DLMM.pkg)}::pool::remove_liquidity_by_percent`, args(pool), [
    poolArg(env, pool),
    position,
    u32(env, binLower),
    u32(env, binUpper),
    ptb.pure(pure.u16(bps)),
    config(env),
    versioned(env),
    env.clock(),
  ])
  keepAtLeast(env, ptb.nested(out, 0), pool.coinA, minA)
  keepAtLeast(env, ptb.nested(out, 1), pool.coinB, minB)
}

/** 关闭仓位（要先领取手续费和奖励）：取回剩下的全部流动性（不少于 minA / minB），销毁关闭凭证 */
export function closeDlmm(env: DexEnv, pool: DlmmPool, position: Argument, minA: bigint, minB: bigint): void {
  const ptb = env.ptb
  const pkg = env.pkg(CETUS_DLMM.pkg)
  const out = ptb.moveCall(`${pkg}::pool::close_position`, args(pool), [poolArg(env, pool), position, config(env), versioned(env), env.clock()])
  keepAtLeast(env, ptb.nested(out, 1), pool.coinA, minA)
  keepAtLeast(env, ptb.nested(out, 2), pool.coinB, minB)
  ptb.moveCall(`${pkg}::pool::destroy_close_position_cert`, [], [ptb.nested(out, 0), versioned(env)])
}
