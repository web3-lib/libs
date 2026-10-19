/**
 * Cetus CLMM 和它的分叉 Magma：仓位是地址拥有的 Position 对象；数量、手续费、奖励用核心包的 pool::get_position_amounts(_v2) /
 * calculate_and_update_fee / calculate_and_update_rewards 算；交易（integrate 包的 pool_script_v2 入口函数）在 cetusTx.ts，只用 /lp 时不打包
 */
import { normalizeSuiAddress } from '../address.js'
import { CETUS } from '../cetus.js'
import { pure } from '../write/bcs.js'
import { big } from './env.js'
import type { DexPool, DexReader, SharedRef, SuiClmmProtocol } from './types.js'
import { coinTypeOf, i32, json, refOf, sharedOf, typeArgs } from './util.js'

export interface CetusLike {
  protocol: SuiClmmProtocol
  name: string
  /** 核心包（原始 id） */
  clmm: string
  /** integrate 包（原始 id） */
  integrate: string
  config: SharedRef
  vault: SharedRef
  /** 算仓位数量的函数 */
  amounts: 'get_position_amounts_v2' | 'get_position_amounts'
  /** 有没有 is_attacked_position（Cetus 2025 年 5 月攻击事件后加的） */
  attacked: boolean
}

export const poolRef = (pool: DexPool) => pool.shared as SharedRef

function reader(c: CetusLike): DexReader {
  return {
    protocol: c.protocol,
    name: c.name,
    original: c.clmm,
    packages: [c.clmm],
    positionType: `${c.clmm}::position::Position`,
    isPool: (type) => !!type?.startsWith(`${c.clmm}::pool::Pool<`),

    parsePosition(o) {
      const j = json(o)
      if (o.type !== this.positionType || typeof j.pool !== 'string') return null
      return {
        protocol: c.protocol,
        id: normalizeSuiAddress(o.objectId),
        ref: refOf(o),
        pool: normalizeSuiAddress(j.pool),
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
        sqrtPrice: BigInt(j.current_sqrt_price),
        tick: i32(j.current_tick_index),
        fee: Number(j.fee_rate),
        tickSpacing: Number(j.tick_spacing),
        rewardCoins: ((j.rewarder_manager?.rewarders ?? []) as Array<{ reward_coin: unknown }>).map((r) => coinTypeOf(r.reward_coin)),
        shared,
        paused: !!j.is_pause,
      }
    },

    read(env, pos, pool) {
      const pkg = env.pkg(c.clmm)
      const ptb = env.ptb
      const config = env.shared(c.config, false)
      const p = env.shared(poolRef(pool), true)
      const id = ptb.pure(pure.address(pos.id))
      const amounts = ptb.moveCall(`${pkg}::pool::${c.amounts}`, pool.typeArgs, [p, id]) as { index: number }
      const fees = ptb.moveCall(`${pkg}::pool::calculate_and_update_fee`, pool.typeArgs, [config, p, id]) as { index: number }
      const rewards = ptb.moveCall(`${pkg}::pool::calculate_and_update_rewards`, pool.typeArgs, [config, p, id, env.clock()]) as { index: number }
      const attacked = c.attacked ? (ptb.moveCall(`${pkg}::pool::is_attacked_position`, pool.typeArgs, [p, id]) as { index: number }) : null
      return (outputs) => {
        const a = outputs[amounts.index]
        const f = outputs[fees.index]
        const r = outputs[rewards.index]
        const x = attacked ? outputs[attacked.index] : [false]
        return {
          amounts: a?.length === 2 ? [big(a[0]), big(a[1])] : null,
          fees: f?.length === 2 ? [big(f[0]), big(f[1])] : null,
          rewards: Array.isArray(r?.[0]) ? (r[0] as unknown[]).map(big) : null,
          restricted: typeof x?.[0] === 'boolean' ? x[0] : null,
        }
      }
    },
  }
}

export const CETUS_CONFIG: CetusLike = {
  protocol: 'cetus',
  name: 'Cetus',
  clmm: CETUS.clmm,
  integrate: CETUS.integrate,
  config: CETUS.globalConfig,
  vault: CETUS.rewarderVault,
  amounts: 'get_position_amounts_v2',
  attacked: true,
}

/** Magma（Cetus 的分叉，主网的包和共享对象） */
export const MAGMA_CONFIG: CetusLike = {
  protocol: 'magma',
  name: 'Magma',
  clmm: '0x4a35d3dfef55ed3631b7158544c6322a23bc434fe4fca1234cb680ce0505f82d',
  integrate: '0x668909f9f30380dd1b63834534dc2bd19b274e6312a0dfa9be0ee5b0cef73446',
  config: { objectId: '0x4c4e1402401f72c7d8533d0ed8d5f8949da363c7a3319ccef261ffe153d32f8a', initialSharedVersion: 481056560n },
  vault: { objectId: '0xa7e1102f222b6eb81ccc8a126e7feb2353342be9df6f6646a77c4519da29c071', initialSharedVersion: 481056560n },
  amounts: 'get_position_amounts',
  attacked: false,
}

export const cetus = reader(CETUS_CONFIG)
export const magma = reader(MAGMA_CONFIG)
