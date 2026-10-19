/**
 * Aftermath 的交易命令（只在 /liquidity 里用到）：按比例存入全部币（all_coin_deposit）、只存一个币（deposit_1_coins_direct）、
 * 按比例取回全部币（all_coin_withdraw）、只取一个币（withdraw_1_coin_direct）。
 * DAO 费池子调用外壳包的同名函数：前面多传 DaoFeePool 和 Version，其余参数相同
 */
import { AFTERMATH, type AftermathPool } from './aftermath.js'
import type { DexEnv } from './dex/types.js'
import { pure, type Argument } from './write/bcs.js'

/** 函数所在的包和前面的固定参数：池子（或 DAO 外壳 + 版本）、注册表、协议手续费金库、国库、保险基金、推荐金库 */
function call(env: DexEnv, pool: AftermathPool): { pkg: string; head: Argument[] } {
  const head = pool.dao ? [env.shared(pool.dao.shared, true), env.shared(AFTERMATH.daoVersion, false)] : [env.shared(pool.shared as NonNullable<AftermathPool['shared']>, true)]
  return {
    pkg: env.pkg(pool.dao ? AFTERMATH.dao : AFTERMATH.amm),
    head: [
      ...head,
      env.shared(AFTERMATH.registry, false),
      env.shared(AFTERMATH.feeVault, false),
      env.shared(AFTERMATH.treasury, true),
      env.shared(AFTERMATH.insuranceFund, true),
      env.shared(AFTERMATH.referralVault, false),
    ],
  }
}

/** 按比例存入全部币：coins 与池子的币一一对应（&mut，按比例用掉，剩下的留在里面）；返回 Coin<LP> */
export function depositAll(env: DexEnv, pool: AftermathPool, coins: readonly Argument[]): Argument {
  const { pkg, head } = call(env, pool)
  return env.ptb.moveCall(`${pkg}::deposit::all_coin_deposit_${pool.coins.length}_coins`, [pool.lpCoinType, ...pool.coins], [...head, ...coins])
}

/** 只存一个币（池子的第 k 种），LP 少于 minLp 时失败；返回 Coin<LP> */
export function depositOne(env: DexEnv, pool: AftermathPool, k: number, coin: Argument, minLp: bigint): Argument {
  const { pkg, head } = call(env, pool)
  return env.ptb.moveCall(`${pkg}::deposit::deposit_1_coins_direct`, [pool.lpCoinType, pool.coins[k] as string], [...head, coin, env.ptb.pure(pure.u64(minLp))])
}

/** 按比例取回全部币：传入的 LP 全部移除；返回与池子的币一一对应的 Coin */
export function withdrawAll(env: DexEnv, pool: AftermathPool, lp: Argument): Argument[] {
  const { pkg, head } = call(env, pool)
  const out = env.ptb.moveCall(`${pkg}::withdraw::all_coin_withdraw_${pool.coins.length}_coins`, [pool.lpCoinType, ...pool.coins], [...head, lp])
  return pool.coins.map((_, i) => env.ptb.nested(out, i))
}

/** 只取一个币（池子的第 k 种），少于 minOut 时失败；返回 Coin */
export function withdrawOne(env: DexEnv, pool: AftermathPool, k: number, lp: Argument, minOut: bigint): Argument {
  const { pkg, head } = call(env, pool)
  return env.ptb.moveCall(`${pkg}::withdraw::withdraw_1_coin_direct`, [pool.lpCoinType, pool.coins[k] as string], [...head, lp, env.ptb.pure(pure.u64(minOut))])
}
