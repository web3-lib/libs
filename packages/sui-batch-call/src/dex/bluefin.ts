/**
 * Bluefin Spot（CLMM）：仓位是地址拥有的 Position 对象；未领取的手续费 / 奖励用 pool::get_accrued_fee / get_accrued_rewards 读；
 * 交易用 gateway 的入口函数（带数量上限 / 下限）；奖励用 pool::collect_reward 领取（gateway 的领取在数量为 0 时会失败，
 * 关闭仓位又要求奖励全部领完，报价到执行之间奖励可能从 0 开始累积）
 */
import { normalizeSuiAddress } from '../address.js'
import { pure } from '../write/bcs.js'
import { big, keepBalance } from './env.js'
import type { DexReader, DexWriter, DexPool, SharedRef } from './types.js'
import { coinTypeOf, i32, i32Bits, json, refOf, sharedOf, typeArgs } from './util.js'

const PKG = '0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267'
const CONFIG: SharedRef = { objectId: '0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352', initialSharedVersion: 406496849n }

const poolArg = (pool: DexPool) => pool.shared as SharedRef

export const bluefin: DexReader = {
  protocol: 'bluefin',
  name: 'Bluefin',
  original: PKG,
  packages: [PKG],
  positionType: `${PKG}::position::Position`,
  isPool: (type) => !!type?.startsWith(`${PKG}::pool::Pool<`),

  parsePosition(o) {
    const j = json(o)
    if (o.type !== this.positionType || typeof j.pool_id !== 'string') return null
    return {
      protocol: 'bluefin',
      id: normalizeSuiAddress(o.objectId),
      ref: refOf(o),
      pool: normalizeSuiAddress(j.pool_id),
      tickLower: i32(j.lower_tick),
      tickUpper: i32(j.upper_tick),
      liquidity: BigInt(j.liquidity ?? 0),
    }
  },

  parsePool(o) {
    const j = json(o)
    const args = typeArgs(o.type)
    const shared = sharedOf(o)
    if (!this.isPool(o.type) || !args || args.length !== 2 || !shared) return null
    return {
      protocol: 'bluefin',
      id: shared.objectId,
      typeArgs: args,
      coinA: args[0] as string,
      coinB: args[1] as string,
      sqrtPrice: BigInt(j.current_sqrt_price),
      tick: i32(j.current_tick_index),
      fee: Number(j.fee_rate),
      tickSpacing: Number(j.ticks_manager?.tick_spacing ?? j.tick_spacing),
      rewardCoins: ((j.reward_infos ?? []) as Array<{ reward_coin_type: string }>).map((r) => coinTypeOf(r.reward_coin_type)),
      shared,
      paused: !!j.is_paused,
    }
  },

  read(env, _pos, pool, position) {
    const pkg = env.pkg(PKG)
    const ptb = env.ptb
    const p = env.shared(poolArg(pool), true)
    const pos = position()
    const fees = ptb.moveCall(`${pkg}::pool::get_accrued_fee`, pool.typeArgs, [env.clock(), p, pos]) as { index: number }
    const rewards = pool.rewardCoins.map((r) => (ptb.moveCall(`${pkg}::pool::get_accrued_rewards`, [...pool.typeArgs, r], [env.clock(), p, pos]) as { index: number }).index)
    return (outputs) => {
      const f = outputs[fees.index]
      return {
        fees: f?.length === 2 ? [big(f[0]), big(f[1])] : null,
        rewards: rewards.every((k) => outputs[k]?.length) ? rewards.map((k) => big(outputs[k]?.[0])) : null,
      }
    }
  },

}

/** bluefin 的交易命令（只在 /liquidity 里用到） */
export const bluefinTx: DexWriter = {
  packages: [],
  open(env, pool, args) {
    const ptb = env.ptb
    const position = ptb.moveCall(`${env.pkg(PKG)}::pool::open_position`, pool.typeArgs, [
      env.shared(CONFIG, false),
      env.shared(poolArg(pool), true),
      ptb.pure(pure.u32(i32Bits(args.tickLower))),
      ptb.pure(pure.u32(i32Bits(args.tickUpper))),
    ])
    this.add(env, pool, position, args)
    env.keep(position)
  },

  add(env, pool, position, args) {
    const ptb = env.ptb
    // 固定一边的数量，两边各有上限（合约检查）；剩下的币由入口函数退给发送者
    ptb.moveCall(`${env.pkg(PKG)}::gateway::provide_liquidity_with_fixed_amount`, pool.typeArgs, [
      env.clock(),
      env.shared(CONFIG, false),
      env.shared(poolArg(pool), true),
      position,
      args.coinA,
      args.coinB,
      ptb.pure(pure.u64(args.fixA ? args.amount0Max : args.amount1Max)),
      ptb.pure(pure.u64(args.amount0Max)),
      ptb.pure(pure.u64(args.amount1Max)),
      ptb.pure(pure.bool(args.fixA)),
    ])
  },

  collect(env, pool, position, claim) {
    const pkg = env.pkg(PKG)
    const ptb = env.ptb
    const common = () => [env.clock(), env.shared(CONFIG, false), env.shared(poolArg(pool), true), position]
    ptb.moveCall(`${pkg}::gateway::collect_fee`, pool.typeArgs, common())
    for (const k of claim) {
      const reward = pool.rewardCoins[k] as string
      keepBalance(env, ptb.moveCall(`${pkg}::pool::collect_reward`, [...pool.typeArgs, reward], common()), reward)
    }
  },

  withdraw(env, pool, position, args) {
    const pkg = env.pkg(PKG)
    const ptb = env.ptb
    const owner = ptb.pure(pure.address(env.owner))
    if (args.liquidity > 0n) {
      ptb.moveCall(`${pkg}::gateway::remove_liquidity`, pool.typeArgs, [
        env.clock(),
        env.shared(CONFIG, false),
        env.shared(poolArg(pool), true),
        position,
        ptb.pure(pure.u128(args.liquidity)),
        ptb.pure(pure.u64(args.amount0Min)),
        ptb.pure(pure.u64(args.amount1Min)),
        owner,
      ])
    }
    if (args.close) ptb.moveCall(`${pkg}::gateway::close_position`, pool.typeArgs, [env.clock(), env.shared(CONFIG, false), env.shared(poolArg(pool), true), position, owner])
  },
}
