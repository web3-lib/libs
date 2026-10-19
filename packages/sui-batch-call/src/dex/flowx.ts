/**
 * FlowX CLMM：仓位是地址拥有的 Position 对象，池子在共享的 PoolRegistry 里（函数都传注册表）；
 * 手续费和奖励用 position_manager::collect / collect_pool_reward 领取（返回 Coin）。
 * 移除流动性先记到仓位的待领取里，再 collect 取出
 */
import { normalizeSuiAddress } from '../address.js'
import { pure, type Argument } from '../write/bcs.js'
import { big } from './env.js'
import type { DexReader, DexWriter, DexEnv, DexPool, SharedRef } from './types.js'
import { coinTypeOf, i32, json, refOf, typeArgs } from './util.js'

const PKG = '0x25929e7f29e0a30eb4e692952ba1b5b65a3a4d65ab5f2a32e1ba3edcb587f26d'
const POOL_REGISTRY: SharedRef = { objectId: '0x27565d24a4cd51127ac90e4074a841bbe356cca7bf5759ddc14a975be1632abc', initialSharedVersion: 101644053n }
const POSITION_REGISTRY: SharedRef = { objectId: '0x7dffe3229d675645564273aa68c67406b6a80aa29e245ac78283acd7ed5e4912', initialSharedVersion: 101644053n }
const VERSIONED: SharedRef = { objectId: '0x67624a1533b5aff5d0dfcf5e598684350efd38134d2d245f475524c03a64e656', initialSharedVersion: 101644053n }
const U64_MAX = 2n ** 64n - 1n

const deadline = (env: DexEnv) => env.ptb.pure(pure.u64(BigInt(env.now + 10 * 60_000)))
const toI32 = (env: DexEnv, tick: number) => env.ptb.moveCall(`${env.pkg(PKG)}::i32::${tick < 0 ? 'neg_from' : 'from'}`, [], [env.ptb.pure(pure.u32(Math.abs(tick)))])

/** 领取全部待领取的手续费（和已移除的流动性）：返回两个 Coin */
function collectAll(env: DexEnv, pool: DexPool, position: Argument): [Argument, Argument] {
  const ptb = env.ptb
  const out = ptb.moveCall(`${env.pkg(PKG)}::position_manager::collect`, pool.typeArgs, [
    env.shared(POOL_REGISTRY, true),
    position,
    ptb.pure(pure.u64(U64_MAX)),
    ptb.pure(pure.u64(U64_MAX)),
    env.shared(VERSIONED, false),
    env.clock(),
  ])
  return [ptb.nested(out, 0), ptb.nested(out, 1)]
}

function collectReward(env: DexEnv, pool: DexPool, position: Argument, k: number): Argument {
  const ptb = env.ptb
  return ptb.moveCall(`${env.pkg(PKG)}::position_manager::collect_pool_reward`, [...pool.typeArgs, pool.rewardCoins[k] as string], [
    env.shared(POOL_REGISTRY, true),
    position,
    ptb.pure(pure.u64(U64_MAX)),
    env.shared(VERSIONED, false),
    env.clock(),
  ])
}

export const flowx: DexReader = {
  protocol: 'flowx',
  name: 'FlowX',
  original: PKG,
  packages: [PKG],
  positionType: `${PKG}::position::Position`,
  isPool: (type) => !!type?.startsWith(`${PKG}::pool::Pool<`),

  parsePosition(o) {
    const j = json(o)
    if (o.type !== this.positionType || typeof j.pool_id !== 'string') return null
    return {
      protocol: 'flowx',
      id: normalizeSuiAddress(o.objectId),
      ref: refOf(o),
      pool: normalizeSuiAddress(j.pool_id),
      tickLower: i32(j.tick_lower_index),
      tickUpper: i32(j.tick_upper_index),
      liquidity: BigInt(j.liquidity ?? 0),
    }
  },

  parsePool(o) {
    const j = json(o)
    const args = typeArgs(o.type)
    if (!this.isPool(o.type) || !args || args.length !== 2) return null
    return {
      protocol: 'flowx',
      id: normalizeSuiAddress(o.objectId),
      typeArgs: args,
      coinA: args[0] as string,
      coinB: args[1] as string,
      sqrtPrice: BigInt(j.sqrt_price),
      tick: i32(j.tick_index),
      fee: Number(j.swap_fee_rate),
      tickSpacing: Number(j.tick_spacing),
      rewardCoins: ((j.reward_infos ?? []) as Array<{ reward_coin_type: unknown }>).map((r) => coinTypeOf(r.reward_coin_type)),
      // 池子在注册表里，交易里传注册表
      shared: null,
      paused: !!j.locked,
    }
  },

  read(env, _pos, pool, position) {
    const pos = position()
    const fees = collectAll(env, pool, pos)
    const feeIdx = fees.map((c, i) => env.coinValue(c, i === 0 ? pool.coinA : pool.coinB))
    fees.forEach((c, i) => env.keepCoin(c, i === 0 ? pool.coinA : pool.coinB))
    const rewards = pool.rewardCoins.map((r, k) => {
      const coin = collectReward(env, pool, pos, k)
      const idx = env.coinValue(coin, r)
      env.keepCoin(coin, r)
      return idx
    })
    return (outputs) => ({
      fees: [big(outputs[feeIdx[0] as number]?.[0]), big(outputs[feeIdx[1] as number]?.[0])],
      rewards: rewards.map((k) => big(outputs[k]?.[0])),
    })
  },

}

/** flowx 的交易命令（只在 /liquidity 里用到） */
export const flowxTx: DexWriter = {
  packages: [],
  open(env, pool, args) {
    const ptb = env.ptb
    const position = ptb.moveCall(`${env.pkg(PKG)}::position_manager::open_position`, pool.typeArgs, [
      env.shared(POSITION_REGISTRY, true),
      env.shared(POOL_REGISTRY, false),
      ptb.pure(pure.u64(BigInt(pool.fee))),
      toI32(env, args.tickLower),
      toI32(env, args.tickUpper),
      env.shared(VERSIONED, false),
    ])
    this.add(env, pool, position, args)
    env.keep(position)
  },

  add(env, pool, position, args) {
    const ptb = env.ptb
    // 两边的币按引用传入，用掉需要的部分（固定的一边就是给的数量），剩下的留在币里还给 owner；下限防滑点
    ptb.moveCall(`${env.pkg(PKG)}::position_manager::increase_liquidity_v2`, pool.typeArgs, [
      env.shared(POOL_REGISTRY, true),
      position,
      args.coinA,
      args.coinB,
      ptb.pure(pure.u64(args.amount0Min)),
      ptb.pure(pure.u64(args.amount1Min)),
      deadline(env),
      env.shared(VERSIONED, false),
      env.clock(),
    ])
    // 数量为 0 的一边是空币：销毁，不留给 owner
    for (const [coin, max, type] of [[args.coinA, args.amount0Max, pool.coinA], [args.coinB, args.amount1Max, pool.coinB]] as const) {
      if (max === 0n) ptb.moveCall('0x2::coin::destroy_zero', [type], [coin])
      else env.keepCoin(coin, type)
    }
  },

  collect(env, pool, position, claim) {
    collectAll(env, pool, position).forEach((c, i) => env.keepCoin(c, i === 0 ? pool.coinA : pool.coinB))
    for (const k of claim) env.keepCoin(collectReward(env, pool, position, k), pool.rewardCoins[k] as string)
  },

  withdraw(env, pool, position, args) {
    const ptb = env.ptb
    if (args.liquidity > 0n) {
      ptb.moveCall(`${env.pkg(PKG)}::position_manager::decrease_liquidity`, pool.typeArgs, [
        env.shared(POOL_REGISTRY, true),
        position,
        ptb.pure(pure.u128(args.liquidity)),
        ptb.pure(pure.u64(args.amount0Min)),
        ptb.pure(pure.u64(args.amount1Min)),
        deadline(env),
        env.shared(VERSIONED, false),
        env.clock(),
      ])
      // 移除的数量记在仓位的待领取里，取出来
      collectAll(env, pool, position).forEach((c, i) => env.keepCoin(c, i === 0 ? pool.coinA : pool.coinB))
    }
    if (args.close) ptb.moveCall(`${env.pkg(PKG)}::position_manager::close_position`, [], [env.shared(POSITION_REGISTRY, true), position, env.shared(VERSIONED, false)])
  },
}
