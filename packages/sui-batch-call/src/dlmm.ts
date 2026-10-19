/**
 * Cetus DLMM（离散的价格 bin，每个 bin 内是恒定价格）：仓位是地址拥有的 Position 对象（区间 [lower_bin, upper_bin]）。
 * 数量、未领取的手续费和奖励用 pool::refresh_position_info_v2 一次算出（只读调用里执行）；交易命令在 dlmmTx.ts
 */
import { normalizeSuiAddress } from './address.js'
import { big } from './dex/env.js'
import type { DexEnv, SharedRef } from './dex/types.js'
import { coinTypeOf, i32, json, refOf, sharedOf, typeArgs } from './dex/util.js'
import type { SuiObject } from './services.js'
import { pure, type ObjectRef } from './write/bcs.js'

export type SuiDlmmProtocol = 'cetus-dlmm'

export const CETUS_DLMM = {
  /** 核心包（原始 id，类型名用它） */
  pkg: '0x5664f9d3fd82c84023870cfbda8ea84e14c8dd56ce557ad2116e0668581a682b',
  /** router（open_position / add_liquidity 按分布策略加流动性） */
  router: '0x8d389fa25cb08ebc5e520bc520ed394eed9e62b56b7868acb398bf298b8a76f3',
  config: { objectId: '0xf31b605d117f959b9730e8c07b08b856cb05143c5e81d5751c90d2979e82f599', initialSharedVersion: 640780258n } as SharedRef,
  versioned: { objectId: '0x05370b2d656612dd5759cbe80463de301e3b94a921dfc72dd9daa2ecdeb2d0a8', initialSharedVersion: 640780258n } as SharedRef,
} as const

export const CETUS_DLMM_POSITION_TYPE = `${CETUS_DLMM.pkg}::position::Position`

/** 一个仓位最多跨多少个 bin（router 的限制） */
export const MAX_BIN_WIDTH = 1000

export interface DlmmPool {
  id: string
  shared: SharedRef
  coinA: string
  coinB: string
  /** 当前价格所在的 bin */
  activeBin: number
  /** 相邻两个 bin 的价格差，万分之一（50 = 0.5%） */
  binStep: number
  /** 基础手续费率，百万分之一（另有随波动变化的动态部分） */
  fee: number
  rewardCoins: string[]
  canAdd: boolean
  canRemove: boolean
  canCollectFee: boolean
  canCollectReward: boolean
}

export interface DlmmPosition {
  id: string
  ref: ObjectRef | null
  pool: string
  binLower: number
  binUpper: number
}

export function parseDlmmPool(o: SuiObject): DlmmPool | null {
  const j = json(o)
  const args = typeArgs(o.type)
  const shared = sharedOf(o)
  if (!o.type?.startsWith(`${CETUS_DLMM.pkg}::pool::Pool<`) || !args || args.length !== 2 || !shared) return null
  const p = j.permissions ?? {}
  return {
    id: shared.objectId,
    shared,
    coinA: args[0] as string,
    coinB: args[1] as string,
    activeBin: i32(j.active_id),
    binStep: Number(j.bin_manager?.bin_step),
    // base_fee_rate 是十亿分之一
    fee: Number(j.base_fee_rate) / 1000,
    rewardCoins: ((j.reward_manager?.rewards ?? []) as Array<{ reward_coin: unknown }>).map((r) => coinTypeOf(r.reward_coin)),
    canAdd: !p.disable_add,
    canRemove: !p.disable_remove,
    canCollectFee: !p.disable_collect_fee,
    canCollectReward: !p.disable_collect_reward,
  }
}

export function parseDlmmPosition(o: SuiObject): DlmmPosition | null {
  const j = json(o)
  if (o.type !== CETUS_DLMM_POSITION_TYPE || typeof j.pool_id !== 'string') return null
  return { id: normalizeSuiAddress(o.objectId), ref: refOf(o), pool: normalizeSuiAddress(j.pool_id), binLower: i32(j.lower_bin_id), binUpper: i32(j.upper_bin_id) }
}

export interface DlmmReadOut {
  amounts: [bigint, bigint]
  fees: [bigint, bigint]
  /** 与池子的奖励顺序相同 */
  rewards: bigint[]
}

/** 只读调用：refresh_position_info_v2 返回数量、手续费和奖励（不传 bin 时算整个仓位） */
export function readDlmm(env: DexEnv, pos: DlmmPosition, pool: DlmmPool): (outputs: unknown[][]) => DlmmReadOut | null {
  const r = env.ptb.moveCall(`${env.pkg(CETUS_DLMM.pkg)}::pool::refresh_position_info_v2`, [pool.coinA, pool.coinB], [
    env.shared(pool.shared, true),
    env.ptb.pure(pure.address(pos.id)),
    env.ptb.pure(new Uint8Array([0])), // Option<I32>::none
    env.shared(CETUS_DLMM.versioned, false),
    env.clock(),
  ]) as { index: number }
  return (outputs) => {
    const d = outputs[r.index]?.[0] as Record<string, any> | undefined
    if (!d) return null
    const byType = new Map(((d.rewards?.contents ?? []) as Array<{ key: unknown; value: unknown }>).map((e) => [coinTypeOf(e.key), big(e.value)]))
    return {
      amounts: [big(d.amount_a), big(d.amount_b)],
      fees: [big(d.fee_a), big(d.fee_b)],
      rewards: pool.rewardCoins.map((t) => byType.get(t) ?? 0n),
    }
  }
}

/** bin 的价格（token1 / token0，最小单位）：(1 + binStep / 10000) ^ bin */
export const binPrice = (bin: number, binStep: number) => (1 + binStep / 10_000) ** bin
