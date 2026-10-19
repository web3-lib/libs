/**
 * Momentum（MMT，CLMM）：仓位是地址拥有的 Position 对象；手续费和奖励用 collect::fee / collect::reward 领取（返回 Coin，
 * 只读调用里读数量）；加减流动性用 liquidity 模块（带数量下限，返回 Coin）
 */
import { normalizeSuiAddress } from '../address.js'
import { pure, type Argument } from '../write/bcs.js'
import { big } from './env.js'
import type { DexReader, DexWriter, DexEnv, DexPool, SharedRef } from './types.js'
import { coinTypeOf, i32, i32Bits, json, refOf, sharedOf, typeArgs } from './util.js'

const PKG = '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860'
const VERSION: SharedRef = { objectId: '0x2375a0b1ec12010aaea3b2545acfa2ad34cfbba03ce4b59f4c39e1e25eed1b2a', initialSharedVersion: 499761252n }

const poolArg = (env: DexEnv, pool: DexPool) => env.shared(pool.shared as SharedRef, true)
const nested = (env: DexEnv, r: Argument, i: number) => env.ptb.nested(r, i)
const toI32 = (env: DexEnv, tick: number) => env.ptb.moveCall(`${env.pkg(PKG)}::i32::from_u32`, [], [env.ptb.pure(pure.u32(i32Bits(tick)))])

export const momentum: DexReader = {
  protocol: 'momentum',
  name: 'Momentum',
  original: PKG,
  packages: [PKG],
  positionType: `${PKG}::position::Position`,
  isPool: (type) => !!type?.startsWith(`${PKG}::pool::Pool<`),

  parsePosition(o) {
    const j = json(o)
    if (o.type !== this.positionType || typeof j.pool_id !== 'string') return null
    return {
      protocol: 'momentum',
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
    const shared = sharedOf(o)
    if (!this.isPool(o.type) || !args || args.length !== 2 || !shared) return null
    return {
      protocol: 'momentum',
      id: shared.objectId,
      typeArgs: args,
      coinA: args[0] as string,
      coinB: args[1] as string,
      sqrtPrice: BigInt(j.sqrt_price),
      tick: i32(j.tick_index),
      fee: Number(j.swap_fee_rate),
      tickSpacing: Number(j.tick_spacing),
      rewardCoins: ((j.reward_infos ?? []) as Array<{ reward_coin_type: unknown }>).map((r) => coinTypeOf(r.reward_coin_type)),
      shared,
      paused: !!j.is_paused,
    }
  },

  read(env, _pos, pool, position) {
    const pkg = env.pkg(PKG)
    const ptb = env.ptb
    const pos = position()
    const fee = ptb.moveCall(`${pkg}::collect::fee`, pool.typeArgs, [poolArg(env, pool), pos, env.clock(), env.shared(VERSION, false)])
    const coins = [nested(env, fee, 0), nested(env, fee, 1)]
    const fees = [env.coinValue(coins[0] as Argument, pool.coinA), env.coinValue(coins[1] as Argument, pool.coinB)]
    coins.forEach((c, i) => env.keepCoin(c, i === 0 ? pool.coinA : pool.coinB))
    const rewards = pool.rewardCoins.map((r) => {
      const coin = ptb.moveCall(`${pkg}::collect::reward`, [...pool.typeArgs, r], [poolArg(env, pool), pos, env.clock(), env.shared(VERSION, false)])
      const k = env.coinValue(coin, r)
      env.keepCoin(coin, r)
      return k
    })
    return (outputs) => ({
      fees: [big(outputs[fees[0] as number]?.[0]), big(outputs[fees[1] as number]?.[0])],
      rewards: rewards.map((k) => big(outputs[k]?.[0])),
    })
  },

}

/** momentum 的交易命令（只在 /liquidity 里用到） */
export const momentumTx: DexWriter = {
  packages: [],
  open(env, pool, args) {
    const position = env.ptb.moveCall(`${env.pkg(PKG)}::liquidity::open_position`, pool.typeArgs, [
      poolArg(env, pool),
      toI32(env, args.tickLower),
      toI32(env, args.tickUpper),
      env.shared(VERSION, false),
    ])
    this.add(env, pool, position, args)
    env.keep(position)
  },

  add(env, pool, position, args) {
    const ptb = env.ptb
    // 按两边的币能加的最多流动性（固定的一边数量就是给的数量，另一边多给了滑点余量），下限防滑点；剩下的币返回
    const left = ptb.moveCall(`${env.pkg(PKG)}::liquidity::add_liquidity`, pool.typeArgs, [
      poolArg(env, pool),
      position,
      args.coinA,
      args.coinB,
      ptb.pure(pure.u64(args.amount0Min)),
      ptb.pure(pure.u64(args.amount1Min)),
      env.clock(),
      env.shared(VERSION, false),
    ])
    env.keepCoin(nested(env, left, 0), pool.coinA)
    env.keepCoin(nested(env, left, 1), pool.coinB)
  },

  collect(env, pool, position, claim) {
    const pkg = env.pkg(PKG)
    const ptb = env.ptb
    const fee = ptb.moveCall(`${pkg}::collect::fee`, pool.typeArgs, [poolArg(env, pool), position, env.clock(), env.shared(VERSION, false)])
    env.keepCoin(nested(env, fee, 0), pool.coinA)
    env.keepCoin(nested(env, fee, 1), pool.coinB)
    for (const k of claim) {
      const r = pool.rewardCoins[k] as string
      env.keepCoin(ptb.moveCall(`${pkg}::collect::reward`, [...pool.typeArgs, r], [poolArg(env, pool), position, env.clock(), env.shared(VERSION, false)]), r)
    }
  },

  withdraw(env, pool, position, args) {
    const pkg = env.pkg(PKG)
    const ptb = env.ptb
    if (args.liquidity > 0n) {
      const out = ptb.moveCall(`${pkg}::liquidity::remove_liquidity`, pool.typeArgs, [
        poolArg(env, pool),
        position,
        ptb.pure(pure.u128(args.liquidity)),
        ptb.pure(pure.u64(args.amount0Min)),
        ptb.pure(pure.u64(args.amount1Min)),
        env.clock(),
        env.shared(VERSION, false),
      ])
      env.keepCoin(nested(env, out, 0), pool.coinA)
      env.keepCoin(nested(env, out, 1), pool.coinB)
    }
    // 只能关闭空仓位（流动性、手续费、奖励都已取出）
    if (args.close) ptb.moveCall(`${pkg}::liquidity::close_position`, [], [position, env.shared(VERSION, false)])
  },
}
