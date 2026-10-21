/**
 * FlowX V2（x·y = k，Uniswap V2 式）：LP 是普通 Coin（Coin<pair::LP<X, Y>>）；池子（PairMetadata）是共享的 Container 里
 * pairs 表的动态字段，键 "LP-X-Y"（类型名不带 0x，按池子的代币顺序），按字段对象的 ID 读。
 * 加减流动性用 router 的入口函数（传 Container，带截止时间；LP 和取回的币转给 to，多余的币退回发送者）
 */
import { normalizeStructTag, normalizeSuiAddress } from '../address.js'
import { big } from '../dex/env.js'
import type { DexEnv, SharedRef } from '../dex/types.js'
import { json, typeArgs } from '../dex/util.js'
import { stringFieldId, typeNameOf } from '../dynamicField.js'
import { pure } from '../write/bcs.js'
import type { AmmReader, AmmWriter } from './types.js'

export const PKG = '0xba153169476e8c3114962261d1edc70de5ad9781b83cc617ecc8c1923191cae0'
export const CONTAINER: SharedRef = { objectId: '0xb65dcbf63fd3ad5d0ebfbf334780dc9f785eff38a4459e37ab08fa79576ee511', initialSharedVersion: 5665244n }
/** Container.pairs（Bag） */
export const PAIRS = '0xd15e209f5a250d6055c264975fee57ec09bf9d6acdda3b5f866f76023d1563e6'
const PAIR_PREFIX = `${PKG}::pair::PairMetadata<`

/** 截止时间：构建后 10 分钟 */
const deadline = (env: DexEnv) => env.ptb.pure(pure.u64(BigInt(env.now + 600_000)))

export const flowxV2: AmmReader = {
  protocol: 'flowx-v2',
  name: 'FlowX V2',
  packages: [PKG],
  lpCoinPrefix: `${PKG}::pair::LP<`,
  // 池子是 dynamic_field::Field<String, PairMetadata<X, Y>>
  isPool: (type) => {
    const t = type ? normalizeStructTag(type) : ''
    return t.startsWith(`${normalizeSuiAddress('0x2')}::dynamic_field::Field<`) && t.includes(PAIR_PREFIX)
  },

  parsePool(o) {
    if (!this.isPool(o.type)) return null
    const inner = typeArgs(o.type)?.[1]
    const args = inner ? typeArgs(inner) : null
    const v = json(o).value
    if (!args || args.length !== 2 || !v) return null
    return {
      protocol: 'flowx-v2',
      id: o.objectId,
      coinA: args[0] as string,
      coinB: args[1] as string,
      reserveA: big(v.reserve_x?.balance),
      reserveB: big(v.reserve_y?.balance),
      lpSupply: big(v.lp_supply?.value),
      lpCoinType: `${PKG}::pair::LP<${args[0]}, ${args[1]}>`,
      // fee_rate 是万分之一
      fee: Number(v.fee_rate) * 100,
      stable: false,
      shared: null,
      depositEnabled: true,
      withdrawEnabled: true,
      minLp: 0n,
    }
  },

  async loadPools(client, holdings, signal) {
    const objects = await client.objects(
      holdings.map((h) => stringFieldId(PAIRS, `LP-${typeNameOf(h.coinA)}-${typeNameOf(h.coinB)}`)),
      { fields: ['type', 'owner', 'json'], signal },
    )
    return objects.map((o) => (o ? this.parsePool(o) : null))
  },
}

/** FlowX V2 的交易命令（只在 /liquidity 里用到） */
export const flowxV2Tx: AmmWriter = {
  packages: [],
  entry: true,
  add(env, pool, args) {
    const ptb = env.ptb
    ptb.moveCall(`${env.pkg(PKG)}::router::add_liquidity`, [pool.coinA, pool.coinB], [
      env.clock(),
      env.shared(CONTAINER, true),
      args.coinA,
      args.coinB,
      ptb.pure(pure.u64(args.minA)),
      ptb.pure(pure.u64(args.minB)),
      ptb.pure(pure.address(env.owner)),
      deadline(env),
    ])
  },
  // 传入的 LP 全部移除（正好是 lpAmount）
  remove(env, pool, args) {
    const ptb = env.ptb
    ptb.moveCall(`${env.pkg(PKG)}::router::remove_liquidity`, [pool.coinA, pool.coinB], [
      env.clock(),
      env.shared(CONTAINER, true),
      args.lp,
      ptb.pure(pure.u64(args.minA)),
      ptb.pure(pure.u64(args.minB)),
      ptb.pure(pure.address(env.owner)),
      deadline(env),
    ])
  },
}
