/** Momentum / Kriya CLMM 的交易命令（只在 /liquidity 里用到） */
import { pure } from '../write/bcs.js'
import { KRIYA_CLMM_CONFIG, MOMENTUM_CONFIG, nested, poolArg, toI32, type MomentumLike } from './momentum.js'
import type { DexWriter } from './types.js'

function writer(c: MomentumLike): DexWriter {
  const PKG = c.pkg
  const VERSION = c.version
  return {
    packages: [],
    open(env, pool, args) {
      const position = env.ptb.moveCall(`${env.pkg(PKG)}::liquidity::open_position`, pool.typeArgs, [
        poolArg(env, pool),
        toI32(env, c, args.tickLower),
        toI32(env, c, args.tickUpper),
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
}

export const momentumTx = writer(MOMENTUM_CONFIG)
export const kriyaClmmTx = writer(KRIYA_CLMM_CONFIG)
