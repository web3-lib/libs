/**
 * Kriya AMM（spot_dex，x·y = k，另有 stable 池子）：LP 放在地址拥有的 KriyaLPToken<X, Y> 对象里（{ pool_id, lsp: Coin<LSP> }），
 * 每个对象一个仓位；池子是共享对象。加减流动性用 spot_dex 的 public 函数（添加返回新的 KriyaLPToken；
 * 移除返回两种币，部分移除时剩下的 KriyaLPToken 由合约转回发送者；合约的移除没有数量下限，取回后在交易里检查）
 */
import { normalizeSuiAddress } from '../address.js'
import { big } from '../dex/env.js'
import type { SharedRef } from '../dex/types.js'
import { json, refOf, sharedOf, typeArgs } from '../dex/util.js'
import { guardMin } from '../dex/pay.js'
import { pure } from '../write/bcs.js'
import type { AmmReader, AmmWriter } from './types.js'

export const PKG = '0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66'

export const kriyaAmm: AmmReader = {
  protocol: 'kriya-amm',
  name: 'Kriya',
  packages: [PKG],
  positionPrefix: `${PKG}::spot_dex::KriyaLPToken<`,
  isPool: (type) => !!type?.startsWith(`${PKG}::spot_dex::Pool<`),

  parseHolding(o) {
    const j = json(o)
    const args = typeArgs(o.type)
    if (!o.type?.startsWith(this.positionPrefix as string) || !args || args.length !== 2 || typeof j.pool_id !== 'string') return null
    return {
      protocol: 'kriya-amm',
      lpCoinType: `${PKG}::spot_dex::LSP<${args[0]}, ${args[1]}>`,
      coinA: args[0] as string,
      coinB: args[1] as string,
      balance: big(j.lsp?.balance ?? 0),
      position: normalizeSuiAddress(o.objectId),
      ref: refOf(o),
      pool: normalizeSuiAddress(j.pool_id),
    }
  },

  parsePool(o) {
    const j = json(o)
    const args = typeArgs(o.type)
    const shared = sharedOf(o)
    if (!this.isPool(o.type) || !args || args.length !== 2 || !shared) return null
    return {
      protocol: 'kriya-amm',
      id: shared.objectId,
      coinA: args[0] as string,
      coinB: args[1] as string,
      reserveA: big(j.token_x),
      reserveB: big(j.token_y),
      lpSupply: big(j.lsp_supply?.value),
      lpCoinType: `${PKG}::spot_dex::LSP<${args[0]}, ${args[1]}>`,
      // LP 手续费 + 协议手续费，百万分之一（与 SDK 的 FEE_SCALING 相同）
      fee: Number(j.lp_fee_percent ?? 0) + Number(j.protocol_fee_percent ?? 0),
      stable: !!j.is_stable,
      shared,
      depositEnabled: j.is_deposit_enabled !== false,
      withdrawEnabled: j.is_withdraw_enabled !== false,
      minLp: 0n,
    }
  },

  async loadPools(client, holdings, signal) {
    const ids = [...new Set(holdings.flatMap((h) => (h.pool ? [h.pool] : [])))]
    const pools = new Map((await client.objects(ids, { fields: ['type', 'owner', 'json'], signal })).flatMap((o) => (o ? [[normalizeSuiAddress(o.objectId), this.parsePool(o)] as const] : [])))
    return holdings.map((h) => (h.pool ? (pools.get(h.pool) ?? null) : null))
  },
}

/** Kriya AMM 的交易命令（只在 /liquidity 里用到） */
export const kriyaAmmTx: AmmWriter = {
  packages: [],
  entry: false,
  // 参数里 Y 在前；按两边的比例取（多余的币由合约退回发送者），返回新的 KriyaLPToken
  add(env, pool, args) {
    const ptb = env.ptb
    const token = ptb.moveCall(`${env.pkg(PKG)}::spot_dex::add_liquidity`, [pool.coinA, pool.coinB], [
      env.shared(pool.shared as SharedRef, true),
      args.coinB,
      args.coinA,
      ptb.pure(pure.u64(args.amountB)),
      ptb.pure(pure.u64(args.amountA)),
      ptb.pure(pure.u64(args.minB)),
      ptb.pure(pure.u64(args.minA)),
    ])
    env.keep(token)
  },
  // lp 是 KriyaLPToken；返回 (Coin<Y>, Coin<X>)。合约没有数量下限：取回后在交易里检查（不够时整笔失败）
  remove(env, pool, args) {
    const out = env.ptb.moveCall(`${env.pkg(PKG)}::spot_dex::remove_liquidity`, [pool.coinA, pool.coinB], [
      env.shared(pool.shared as SharedRef, true),
      args.lp,
      env.ptb.pure(pure.u64(args.lpAmount)),
    ])
    const [coinB, coinA] = [env.ptb.nested(out, 0), env.ptb.nested(out, 1)]
    guardMin(env.ptb, coinA, args.minA)
    guardMin(env.ptb, coinB, args.minB)
    env.keepCoin(coinB, pool.coinB)
    env.keepCoin(coinA, pool.coinA)
  },
}
