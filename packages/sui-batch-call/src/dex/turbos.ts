/**
 * Turbos（CLMM）：用户拥有仓位 NFT（TurbosPositionNFT），仓位本身在共享的 Positions 管理器里；
 * tick 和流动性用 position_manager::get_position_info 读，手续费和奖励用 collect_*_with_return_ 领取（返回 Coin）。
 * 池子有三个类型参数（第三个是手续费等级）；每个奖励有自己的金库对象
 */
import { normalizeSuiAddress } from '../address.js'
import { pure, type Argument } from '../write/bcs.js'
import { big } from './env.js'
import type { DexReader, DexWriter, DexEnv, DexPool, SharedRef } from './types.js'
import { coinTypeOf, i32, json, refOf, sharedOf, typeArgs } from './util.js'

const PKG = '0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1'
const POSITIONS: SharedRef = { objectId: '0xf5762ae5ae19a2016bb233c72d9a4b2cba5a302237a82724af66292ae43ae52d', initialSharedVersion: 1621135n }
const VERSIONED: SharedRef = { objectId: '0xf1cf0e81048df168ebeb1b8030fad24b3e0b53ae827c25053fff0779c1445b6f', initialSharedVersion: 1621135n }
/** 已停用的奖励（与官方 SDK 的 deprecatedPools 相同）：领取会失败，跳过 */
const DEPRECATED_REWARDS: Readonly<Record<string, readonly number[]>> = {
  '0x839595a83dbb6b076a0fddad42dd512b66c065aa7ef3d298daa00a327d53ab31': [0],
  '0x6a3be30a31f88d9055da7f26f53dd34c85bc5aab9028212361ccf67f5f00fd46': [0],
}
const U64_MAX = 2n ** 64n - 1n
/** 截止时间：10 分钟后（毫秒） */
const deadline = (env: DexEnv) => env.ptb.pure(pure.u64(BigInt(env.now + 10 * 60_000)))
const deprecated = (pool: DexPool, k: number) => DEPRECATED_REWARDS[pool.id]?.includes(k) ?? false

const common = (env: DexEnv, pool: DexPool) => [env.shared(pool.shared as SharedRef, true), env.shared(POSITIONS, true)]
const vaultOf = (env: DexEnv, pool: DexPool, k: number) => {
  const v = pool.rewardVaults?.[k]
  if (!v || v.initialSharedVersion === null) throw new Error(`Unknown reward vault ${k} of pool ${pool.id}`)
  return env.shared(v as SharedRef, true)
}

/** 领取手续费和奖励（Coin 留给 owner）；返回 Coin 用于读数量 */
function collectCoins(env: DexEnv, pool: DexPool, nft: Argument, rewards: readonly number[]): { fees: [Argument, Argument]; rewards: Argument[] } {
  const pkg = env.pkg(PKG)
  const ptb = env.ptb
  const owner = ptb.pure(pure.address(env.owner))
  const fee = ptb.moveCall(`${pkg}::position_manager::collect_with_return_`, pool.typeArgs, [
    ...common(env, pool),
    nft,
    ptb.pure(pure.u64(U64_MAX)),
    ptb.pure(pure.u64(U64_MAX)),
    owner,
    deadline(env),
    env.clock(),
    env.shared(VERSIONED, false),
  ])
  const fees: [Argument, Argument] = [ptb.nested(fee, 0), ptb.nested(fee, 1)]
  const coins = rewards.map((k) =>
    ptb.moveCall(`${pkg}::position_manager::collect_reward_with_return_`, [...pool.typeArgs, pool.rewardCoins[k] as string], [
      ...common(env, pool),
      nft,
      vaultOf(env, pool, k),
      ptb.pure(pure.u64(BigInt(k))),
      ptb.pure(pure.u64(U64_MAX)),
      owner,
      deadline(env),
      env.clock(),
      env.shared(VERSIONED, false),
    ]),
  )
  return { fees, rewards: coins }
}

function keepAll(env: DexEnv, pool: DexPool, coins: { fees: [Argument, Argument]; rewards: Argument[] }, claim: readonly number[]): void {
  env.keepCoin(coins.fees[0], pool.coinA)
  env.keepCoin(coins.fees[1], pool.coinB)
  coins.rewards.forEach((c, i) => env.keepCoin(c, pool.rewardCoins[claim[i] as number] as string))
}

export const turbos: DexReader = {
  protocol: 'turbos',
  name: 'Turbos',
  original: PKG,
  packages: [PKG],
  positionType: `${PKG}::position_nft::TurbosPositionNFT`,
  isPool: (type) => !!type?.startsWith(`${PKG}::pool::Pool<`),

  parsePosition(o) {
    const j = json(o)
    if (o.type !== this.positionType || typeof j.pool_id !== 'string') return null
    // tick 和流动性在仓位管理器里：只读调用时读
    return { protocol: 'turbos', id: normalizeSuiAddress(o.objectId), ref: refOf(o), pool: normalizeSuiAddress(j.pool_id), tickLower: null, tickUpper: null, liquidity: null }
  },

  parsePool(o) {
    const j = json(o)
    const args = typeArgs(o.type)
    const shared = sharedOf(o)
    if (!this.isPool(o.type) || !args || args.length !== 3 || !shared) return null
    const infos = (j.reward_infos ?? []) as Array<{ vault: string; vault_coin_type: unknown }>
    return {
      protocol: 'turbos',
      id: shared.objectId,
      typeArgs: args,
      coinA: args[0] as string,
      coinB: args[1] as string,
      sqrtPrice: BigInt(j.sqrt_price),
      tick: i32(j.tick_current_index),
      fee: Number(j.fee),
      tickSpacing: Number(j.tick_spacing),
      rewardCoins: infos.map((r) => coinTypeOf(r.vault_coin_type)),
      shared,
      paused: j.unlocked === false,
      rewardVaults: infos.map((r) => ({ objectId: normalizeSuiAddress(r.vault), initialSharedVersion: null })),
    }
  },

  async prepare(client, pools, signal) {
    // 奖励金库是共享对象：读它们的共享版本
    const ids = [...new Set(pools.flatMap((p) => (p.rewardVaults ?? []).map((v) => v.objectId)))]
    if (!ids.length) return
    const objects = await client.objects(ids, { fields: ['owner'], signal })
    const versions = new Map(objects.flatMap((o) => (o && sharedOf(o) ? [[normalizeSuiAddress(o.objectId), sharedOf(o) as SharedRef] as const] : [])))
    for (const p of pools) p.rewardVaults = (p.rewardVaults ?? []).map((v) => versions.get(v.objectId) ?? v)
  },

  state(env, pos) {
    const info = env.ptb.moveCall(`${env.pkg(PKG)}::position_manager::get_position_info`, [], [env.shared(POSITIONS, false), env.ptb.pure(pure.address(pos.id))]) as { index: number }
    return (outputs) => {
      const p = outputs[info.index]
      return p?.length === 3 ? { tickLower: i32(p[0]), tickUpper: i32(p[1]), liquidity: big(p[2]) } : null
    }
  },

  read(env, _pos, pool, position) {
    const nft = position()
    const claim = pool.rewardCoins.map((_, k) => k).filter((k) => !deprecated(pool, k))
    const coins = collectCoins(env, pool, nft, claim)
    const fees = coins.fees.map((c, i) => env.coinValue(c, i === 0 ? pool.coinA : pool.coinB))
    const rewards = coins.rewards.map((c, i) => env.coinValue(c, pool.rewardCoins[claim[i] as number] as string))
    keepAll(env, pool, coins, claim)
    return (outputs) => {
      const byIndex = new Map(claim.map((k, i) => [k, big(outputs[rewards[i] as number]?.[0])]))
      return {
        fees: [big(outputs[fees[0] as number]?.[0]), big(outputs[fees[1] as number]?.[0])],
        rewards: pool.rewardCoins.map((_, k) => byIndex.get(k) ?? 0n),
      }
    }
  },

}

/** turbos 的交易命令（只在 /liquidity 里用到） */
export const turbosTx: DexWriter = {
  packages: [],
  open(env, pool, args) {
    const ptb = env.ptb
    // 返回仓位 NFT 和剩下的两种币
    const out = ptb.moveCall(`${env.pkg(PKG)}::position_manager::mint_with_return_`, pool.typeArgs, [
      ...common(env, pool),
      ptb.command({ kind: 'makeMoveVec', type: `0x2::coin::Coin<${pool.coinA}>`, elements: [args.coinA] }),
      ptb.command({ kind: 'makeMoveVec', type: `0x2::coin::Coin<${pool.coinB}>`, elements: [args.coinB] }),
      ptb.pure(pure.u32(Math.abs(args.tickLower))),
      ptb.pure(pure.bool(args.tickLower < 0)),
      ptb.pure(pure.u32(Math.abs(args.tickUpper))),
      ptb.pure(pure.bool(args.tickUpper < 0)),
      ptb.pure(pure.u64(args.amount0Max)),
      ptb.pure(pure.u64(args.amount1Max)),
      ptb.pure(pure.u64(args.amount0Min)),
      ptb.pure(pure.u64(args.amount1Min)),
      deadline(env),
      env.clock(),
      env.shared(VERSIONED, false),
    ])
    env.keep(ptb.nested(out, 0))
    env.keepCoin(ptb.nested(out, 1), pool.coinA)
    env.keepCoin(ptb.nested(out, 2), pool.coinB)
  },

  add(env, pool, position, args) {
    const ptb = env.ptb
    const out = ptb.moveCall(`${env.pkg(PKG)}::position_manager::increase_liquidity_with_return_`, pool.typeArgs, [
      ...common(env, pool),
      ptb.command({ kind: 'makeMoveVec', type: `0x2::coin::Coin<${pool.coinA}>`, elements: [args.coinA] }),
      ptb.command({ kind: 'makeMoveVec', type: `0x2::coin::Coin<${pool.coinB}>`, elements: [args.coinB] }),
      position,
      ptb.pure(pure.u64(args.amount0Max)),
      ptb.pure(pure.u64(args.amount1Max)),
      ptb.pure(pure.u64(args.amount0Min)),
      ptb.pure(pure.u64(args.amount1Min)),
      deadline(env),
      env.clock(),
      env.shared(VERSIONED, false),
    ])
    env.keepCoin(ptb.nested(out, 0), pool.coinA)
    env.keepCoin(ptb.nested(out, 1), pool.coinB)
  },

  collect(env, pool, position, claim) {
    const list = claim.filter((k) => !deprecated(pool, k))
    keepAll(env, pool, collectCoins(env, pool, position, list), list)
  },

  withdraw(env, pool, position, args) {
    const pkg = env.pkg(PKG)
    const ptb = env.ptb
    if (args.liquidity > 0n) {
      const out = ptb.moveCall(`${pkg}::position_manager::decrease_liquidity_with_return_`, pool.typeArgs, [
        ...common(env, pool),
        position,
        ptb.pure(pure.u128(args.liquidity)),
        ptb.pure(pure.u64(args.amount0Min)),
        ptb.pure(pure.u64(args.amount1Min)),
        deadline(env),
        env.clock(),
        env.shared(VERSIONED, false),
      ])
      env.keepCoin(ptb.nested(out, 0), pool.coinA)
      env.keepCoin(ptb.nested(out, 1), pool.coinB)
    }
    // 销毁 NFT（仓位要已经清空）
    if (args.close) ptb.moveCall(`${pkg}::position_manager::burn`, pool.typeArgs, [env.shared(POSITIONS, true), position, env.shared(VERSIONED, false)])
  },
}
