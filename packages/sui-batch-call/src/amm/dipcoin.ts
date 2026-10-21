/**
 * DipCoin（x·y = k）：LP 是普通 Coin（Coin<manage::LP<X, Y>>）；池子是共享对象，在 Global 的 registered_pools 表里
 * 按 "LP-X-Y" 登记。加减流动性用 router 的入口函数（LP、取回的币和多余的币由合约转给发送者）
 */
import { normalizeSuiAddress } from '../address.js'
import { big } from '../dex/env.js'
import type { SharedRef } from '../dex/types.js'
import { json, sharedOf, typeArgs } from '../dex/util.js'
import { stringFieldId, typeNameOf } from '../dynamicField.js'
import { pure } from '../write/bcs.js'
import type { AmmReader, AmmWriter } from './types.js'

export const PKG = '0xdae28ab9ab072c647c4e8f2057a8f17dcc4847e42d6a8258df4b376ae183c872'
export const GLOBAL: SharedRef = { objectId: '0x935229a3c32399e9fb207ec8461a54f56c6af5744c64442435ac217ab28f0d59', initialSharedVersion: 557604664n }
/** Global.registered_pools（Table<String, address>） */
export const REGISTRY = '0x55c65b7b67b0ccdf28e13b3b6d204e859dd19556603e3b94137a19306a7254d8'

export const dipcoin: AmmReader = {
  protocol: 'dipcoin',
  name: 'DipCoin',
  packages: [PKG],
  lpCoinPrefix: `${PKG}::manage::LP<`,
  isPool: (type) => !!type?.startsWith(`${PKG}::manage::Pool<`),

  parsePool(o) {
    const j = json(o)
    const args = typeArgs(o.type)
    const shared = sharedOf(o)
    if (!this.isPool(o.type) || !args || args.length !== 2 || !shared) return null
    return {
      protocol: 'dipcoin',
      id: shared.objectId,
      coinA: args[0] as string,
      coinB: args[1] as string,
      reserveA: big(j.bal_x),
      reserveB: big(j.bal_y),
      lpSupply: big(j.lp_supply?.value),
      lpCoinType: `${PKG}::manage::LP<${args[0]}, ${args[1]}>`,
      // fee_rate 是万分之一
      fee: Number(j.fee_rate) * 100,
      stable: false,
      shared,
      depositEnabled: true,
      withdrawEnabled: true,
      minLp: big(j.min_add_liquidity_lp_amount ?? 0),
    }
  },

  async loadPools(client, holdings, signal) {
    // 表里的条目：键是 "LP-X-Y"（类型名不带 0x），值是池子地址
    const entries = await client.objects(
      holdings.map((h) => stringFieldId(REGISTRY, `LP-${typeNameOf(h.coinA)}-${typeNameOf(h.coinB)}`)),
      { fields: ['json'], signal },
    )
    const ids = entries.map((e) => (e && typeof json(e).value === 'string' ? normalizeSuiAddress(json(e).value) : null))
    const found = [...new Set(ids.filter((id): id is string => !!id))]
    const pools = new Map((await client.objects(found, { fields: ['type', 'owner', 'json'], signal })).flatMap((o) => (o ? [[normalizeSuiAddress(o.objectId), this.parsePool(o)] as const] : [])))
    return ids.map((id) => (id ? (pools.get(id) ?? null) : null))
  },
}

const global = (env: Parameters<AmmWriter['add']>[0]) => env.shared(GLOBAL, false)

/** DipCoin 的交易命令（只在 /liquidity 里用到） */
export const dipcoinTx: AmmWriter = {
  packages: [],
  entry: true,
  // 合约按两边的比例取最多能加的（多余的退回），LP 和多余的币转给发送者
  add(env, pool, args) {
    const ptb = env.ptb
    ptb.moveCall(`${env.pkg(PKG)}::router::add_liquidity`, [pool.coinA, pool.coinB], [
      global(env),
      env.shared(pool.shared as SharedRef, true),
      args.coinA,
      ptb.pure(pure.u64(args.minA)),
      args.coinB,
      ptb.pure(pure.u64(args.minB)),
    ])
  },
  // 传入的 LP 里按 lpAmount 取，剩下的 LP 和取回的币转给发送者
  remove(env, pool, args) {
    const ptb = env.ptb
    ptb.moveCall(`${env.pkg(PKG)}::router::remove_liquidity`, [pool.coinA, pool.coinB], [
      global(env),
      env.shared(pool.shared as SharedRef, true),
      args.lp,
      ptb.pure(pure.u64(args.lpAmount)),
      ptb.pure(pure.u64(args.minA)),
      ptb.pure(pure.u64(args.minB)),
    ])
  },
}
