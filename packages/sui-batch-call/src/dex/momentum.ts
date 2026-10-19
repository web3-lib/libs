/**
 * Momentum（MMT，CLMM）和与它接口相同的 Kriya CLMM：仓位是地址拥有的 Position 对象；手续费和奖励用 collect::fee / collect::reward
 * 领取（返回 Coin，只读调用里读数量）；加减流动性用 liquidity 模块（带数量下限，返回 Coin），交易命令在 momentumTx.ts
 */
import { normalizeSuiAddress } from '../address.js'
import { pure, type Argument } from '../write/bcs.js'
import { big } from './env.js'
import type { DexReader, DexEnv, DexPool, SharedRef, SuiClmmProtocol } from './types.js'
import { coinTypeOf, i32, i32Bits, json, refOf, sharedOf, typeArgs } from './util.js'

export interface MomentumLike {
  protocol: SuiClmmProtocol
  name: string
  /** 包（原始 id） */
  pkg: string
  /** 版本对象（每个调用都要传） */
  version: SharedRef
}

export const MOMENTUM_CONFIG: MomentumLike = {
  protocol: 'momentum',
  name: 'Momentum',
  pkg: '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860',
  version: { objectId: '0x2375a0b1ec12010aaea3b2545acfa2ad34cfbba03ce4b59f4c39e1e25eed1b2a', initialSharedVersion: 499761252n },
}

/** Kriya CLMM（与 Momentum 的接口相同，池子没有暂停标记） */
export const KRIYA_CLMM_CONFIG: MomentumLike = {
  protocol: 'kriya-clmm',
  name: 'Kriya CLMM',
  pkg: '0xf6c05e2d9301e6e91dc6ab6c3ca918f7d55896e1f1edd64adc0e615cde27ebf1',
  version: { objectId: '0xf5145a7ac345ca8736cf8c76047d00d6d378f30e81be6f6eb557184d9de93c78', initialSharedVersion: 304677359n },
}

export const poolArg = (env: DexEnv, pool: DexPool) => env.shared(pool.shared as SharedRef, true)
export const nested = (env: DexEnv, r: Argument, i: number) => env.ptb.nested(r, i)
export const toI32 = (env: DexEnv, c: MomentumLike, tick: number) => env.ptb.moveCall(`${env.pkg(c.pkg)}::i32::from_u32`, [], [env.ptb.pure(pure.u32(i32Bits(tick)))])

function reader(c: MomentumLike): DexReader {
  const PKG = c.pkg
  const VERSION = c.version
  return {
    protocol: c.protocol,
    name: c.name,
    original: PKG,
    packages: [PKG],
    positionType: `${PKG}::position::Position`,
    isPool: (type) => !!type?.startsWith(`${PKG}::pool::Pool<`),

    parsePosition(o) {
      const j = json(o)
      if (o.type !== this.positionType || typeof j.pool_id !== 'string') return null
      return {
        protocol: c.protocol,
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
        protocol: c.protocol,
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
}

export const momentum = reader(MOMENTUM_CONFIG)
export const kriyaClmm = reader(KRIYA_CLMM_CONFIG)
