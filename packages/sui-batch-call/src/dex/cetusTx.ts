/** Cetus / Magma 的交易命令（/liquidity 用）：integrate 包的 pool_script_v2 入口函数 */
import { latestPackage } from '../cetus.js'
import { inspectTransaction } from '../services.js'
import { encodeTransactionData, pure } from '../write/bcs.js'
import { PtbBuilder } from '../write/ptb.js'
import { CETUS_CONFIG, MAGMA_CONFIG, poolRef, type CetusLike } from './cetus.js'
import type { DexWriter } from './types.js'
import { i32Bits } from './util.js'

function writer(c: CetusLike): DexWriter {
  return {
    packages: [c.integrate],

    open(env, pool, args) {
      const ptb = env.ptb
      ptb.moveCall(`${env.pkg(c.integrate)}::pool_script_v2::open_position_with_liquidity_by_fix_coin`, pool.typeArgs, [
        env.shared(c.config, false),
        env.shared(poolRef(pool), true),
        ptb.pure(pure.u32(i32Bits(args.tickLower))),
        ptb.pure(pure.u32(i32Bits(args.tickUpper))),
        args.coinA,
        args.coinB,
        ptb.pure(pure.u64(args.amount0Max)),
        ptb.pure(pure.u64(args.amount1Max)),
        ptb.pure(pure.bool(args.fixA)),
        env.clock(),
      ])
    },

    add(env, pool, position, args) {
      const ptb = env.ptb
      // 固定一边的数量，另一边不超过上限（合约检查）；剩下的币由入口函数退给发送者
      ptb.moveCall(`${env.pkg(c.integrate)}::pool_script_v2::add_liquidity_by_fix_coin`, pool.typeArgs, [
        env.shared(c.config, false),
        env.shared(poolRef(pool), true),
        position,
        args.coinA,
        args.coinB,
        ptb.pure(pure.u64(args.amount0Max)),
        ptb.pure(pure.u64(args.amount1Max)),
        ptb.pure(pure.bool(args.fixA)),
        env.clock(),
      ])
    },

    collect(env, pool, position, claim) {
      const integrate = env.pkg(c.integrate)
      const ptb = env.ptb
      const config = env.shared(c.config, false)
      const p = env.shared(poolRef(pool), true)
      const zero = (t: string) => ptb.moveCall('0x2::coin::zero', [t], [])
      ptb.moveCall(`${integrate}::pool_script_v2::collect_fee`, pool.typeArgs, [config, p, position, zero(pool.coinA), zero(pool.coinB)])
      if (claim.length) {
        const vault = env.shared(c.vault, true)
        for (const k of claim) {
          const r = pool.rewardCoins[k] as string
          ptb.moveCall(`${integrate}::pool_script_v2::collect_reward`, [...pool.typeArgs, r], [config, p, position, vault, zero(r), env.clock()])
        }
      }
    },

    withdraw(env, pool, position, args) {
      const integrate = env.pkg(c.integrate)
      const ptb = env.ptb
      const config = env.shared(c.config, false)
      const p = env.shared(poolRef(pool), true)
      const mins = [ptb.pure(pure.u64(args.amount0Min)), ptb.pure(pure.u64(args.amount1Min))]
      // close_position 会移除剩下的全部流动性再关闭
      if (args.close) ptb.moveCall(`${integrate}::pool_script_v2::close_position`, pool.typeArgs, [config, p, position, ...mins, env.clock()])
      else ptb.moveCall(`${integrate}::pool_script_v2::remove_liquidity`, pool.typeArgs, [config, p, position, ptb.pure(pure.u128(args.liquidity)), ...mins, env.clock()])
    },

    ...(c.attacked
      ? {
          async checkWithdrawAll(client, owner, pos, pool, signal) {
            // Cetus 标记为受攻击影响的仓位：合约拒绝移除全部流动性（关闭也不行），提前报错
            const pkg = await latestPackage(client.transport, c.clmm)
            const ptb = new PtbBuilder()
            ptb.moveCall(`${pkg}::pool::is_attacked_position`, pool.typeArgs, [ptb.object({ kind: 'shared', ...poolRef(pool), mutable: false }), ptb.pure(pure.address(pos.id))])
            const bytes = encodeTransactionData({ kind: ptb.build(), sender: owner, gas: { payment: [], owner, price: 1000n, budget: 50_000_000_000n }, expiration: { kind: 'none' } })
            const { result, outputs } = await inspectTransaction(client.transport, bytes, { signal })
            // 查不出来时不能当作没问题：否则交易到后面才失败，错误也看不懂
            if (!result.success) throw new Error(`Could not check whether the position can be fully removed (pool::is_attacked_position): ${result.error}`)
            if (outputs[0]?.[0] === true) {
              throw new Error('Cetus marks this position as affected by the 2025 exploit (is_attacked_position): the contract rejects removing all of its liquidity; remove part of it instead')
            }
          },
        }
      : {}),
  }
}

export const cetusTx = writer(CETUS_CONFIG)
export const magmaTx = writer(MAGMA_CONFIG)
