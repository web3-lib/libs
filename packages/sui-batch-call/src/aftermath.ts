/**
 * Aftermath AMM：多币池（2~8 种币，加权池或稳定池），每个池子有自己的 LP 代币（Coin<…::af_lp::AF_LP> 等）。
 * LP 代币类型 → 池子：PoolRegistry 的 lp_coin_map 表（键是不带 0x 的类型名），条目的对象 ID 在本地算出。
 * 约 20% 的池子包在 DaoFeePool 里（池子是它的动态对象字段，交易调用外壳包的同名函数，存取时多收 fee_bps）。
 * 交易命令在 aftermathTx.ts
 */
import { normalizeStructTag, normalizeSuiAddress } from './address.js'
import type { SuiClient } from './client.js'
import { big } from './dex/env.js'
import type { SharedRef } from './dex/types.js'
import { coinTypeOf, json, sharedOf, typeArgs } from './dex/util.js'
import { dynamicFieldId, typeNameOf } from './dynamicField.js'
import type { SuiObject } from './services.js'
import { BcsWriter } from './write/bcs.js'

export type SuiMultiProtocol = 'aftermath'

const shared = (objectId: string, initialSharedVersion: bigint): SharedRef => ({ objectId, initialSharedVersion })

export const AFTERMATH = {
  /** AMM 包（原始 id，类型名用它） */
  amm: '0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c',
  /** DAO 费外壳包（原始 id） */
  dao: '0x6f60a091637054e23915b8745c0c0d47b1d49618ee3435b5f68eccf6a44fb53d',
  registry: shared('0xfcc774493db2c45c79f688f88d28023a3e7d98e4ee9f48bbf5c7990f651577ae', 6808332n),
  feeVault: shared('0xf194d9b1bcad972e45a7dd67dd49b3ee1e3357a00a50850c52cd51bb450e13b4', 6668823n),
  treasury: shared('0x28e499dff5e864a2eafe476269a4f5035f1c16f338da7be18b103499abf271ce', 3338989n),
  insuranceFund: shared('0xf0c40d67b078000e18032334c3325c47b9ec9f3d9ae4128be820d54663d14e3b', 3338991n),
  referralVault: shared('0x35d35b0e5b177593d8c3a801462485572fc30861e6ce96a55af6dc4730709278', 3338990n),
  /** DAO 费外壳的版本对象 */
  daoVersion: shared('0xb4bfb0f917f12ad2a772bea9b4f22431f6f5f9653162c3ae6fae5b99b21392b7', 293243902n),
  /** PoolRegistry 里的 lp_coin_map（Table<ascii::String, ID>） */
  lpCoinMap: '0x7f3bb65251feccacc7f48461239be1008233b85594114f7bf304e5e5b340bf59',
} as const

/** 一个池子最多几种币（合约的函数到 8 为止） */
export const MAX_POOL_COINS = 8
const ONE = 10n ** 18n

export interface AftermathPool {
  /** 池子对象 ID（DAO 费池子也是里面的 Pool 的 ID） */
  id: string
  lpCoinType: string
  /** 池子的币（池子的顺序：type_names） */
  coins: string[]
  /** 储备（最小单位）= normalized_balances / decimal_scalars */
  reserves: bigint[]
  normalized: bigint[]
  scalars: bigint[]
  /** 权重（1e18 = 100%） */
  weights: bigint[]
  lpSupply: bigint
  /** 稳定池（flatness = 1） */
  stable: boolean
  /** swap 手续费率（百万分之一，取各币的最大值） */
  fee: number
  /** 普通池子：共享的 Pool；DAO 费池子为 null */
  shared: SharedRef | null
  /** DAO 费池子：外壳（共享对象）和费率（万分之一） */
  dao: { id: string; shared: SharedRef; feeBps: number } | null
}

/** 协议手续费（存入时从每个币、取出时从每个币收；有推荐人时略少） */
export interface AftermathFees {
  /** 合计费率（1e18 = 100%） */
  total: bigint
  /** 分给国库、保险基金、开发者钱包的比例（1e18 = 100%），各自向下取整 */
  parts: bigint[]
}

export function parseAftermathPool(o: SuiObject): Omit<AftermathPool, 'shared' | 'dao'> | null {
  const j = json(o)
  const lp = typeArgs(o.type)?.[0]
  if (!o.type?.startsWith(`${AFTERMATH.amm}::pool::Pool<`) || !lp) return null
  const coins = ((j.type_names ?? []) as unknown[]).map((t) => coinTypeOf(t))
  const normalized = ((j.normalized_balances ?? []) as unknown[]).map(big)
  const scalars = ((j.decimal_scalars ?? []) as unknown[]).map(big)
  const weights = ((j.weights ?? []) as unknown[]).map(big)
  if (!coins.length || coins.length !== normalized.length || coins.length !== scalars.length) return null
  const fees = ((j.fees_swap_in ?? []) as unknown[]).map(big)
  return {
    id: normalizeSuiAddress(o.objectId),
    lpCoinType: lp,
    coins,
    reserves: normalized.map((n, i) => n / (scalars[i] as bigint)),
    normalized,
    scalars,
    weights,
    lpSupply: big(j.lp_supply?.value),
    stable: big(j.flatness ?? 0) === ONE,
    fee: Number(fees.reduce((m, f) => (f > m ? f : m), 0n) / 10n ** 12n),
  }
}

export function parseAftermathFees(o: SuiObject | null): AftermathFees {
  const f = (o ? json(o).fee_percentages : null) ?? {}
  // 读不到时用 2026-10 的值：0.05%，国库 / 保险基金 / 开发者 5 : 3 : 2
  const total = f.total_protocol_fee !== undefined ? big(f.total_protocol_fee) : 5n * 10n ** 14n
  const parts = f.treasury !== undefined ? [big(f.treasury), big(f.insurance_fund), big(f.dev_wallet)] : [5n * 10n ** 17n, 3n * 10n ** 17n, 2n * 10n ** 17n]
  return { total, parts }
}

/** 从 x 里收的协议手续费 */
export const protocolFeeOf = (x: bigint, fees: AftermathFees) => fees.parts.reduce((sum, p) => sum + (x * fees.total * p) / ONE / ONE, 0n)

/**
 * 按比例取回全部币（withdraw::all_coin_withdraw）：r = lp / 总量，每个币 = 储备 × r，再扣协议手续费和 DAO 费。
 * 有推荐人时协议手续费略少（实际略多于这里）
 */
export function withdrawAllAmounts(pool: AftermathPool, lp: bigint, fees: AftermathFees): bigint[] {
  if (pool.lpSupply === 0n) return pool.coins.map(() => 0n)
  const r = (lp * ONE) / pool.lpSupply
  return pool.normalized.map((n, i) => {
    const out = (n * r) / ONE / (pool.scalars[i] as bigint)
    const afterProtocol = out - protocolFeeOf(out, fees)
    return pool.dao ? afterProtocol - (afterProtocol * BigInt(pool.dao.feeBps)) / 10_000n : afterProtocol
  })
}

/** lp_coin_map 里 LP 类型的条目（对象 ID 本地算出） */
const lpEntryId = (lpCoinType: string) => dynamicFieldId(AFTERMATH.lpCoinMap, '0x1::ascii::String', new BcsWriter().string(typeNameOf(lpCoinType)).finish())

/**
 * 按 LP 类型找池子（不是 Aftermath 的 LP 时为 null）：lp_coin_map 的条目 → Pool；
 * Pool 不是共享对象时是 DAO 费池子：Pool 的所有者是动态字段，字段的所有者是 DaoFeePool
 */
export async function loadAftermathPools(client: SuiClient, lpCoinTypes: readonly string[], signal?: AbortSignal): Promise<Array<AftermathPool | null>> {
  if (!lpCoinTypes.length) return []
  const entries = await client.objects(lpCoinTypes.map(lpEntryId), { fields: ['json'], signal })
  const ids = entries.map((e) => (e && typeof json(e).value === 'string' ? normalizeSuiAddress(json(e).value) : null))
  const found = [...new Set(ids.filter((id): id is string => !!id))]
  const pools = await loadPoolObjects(client, found, signal)
  return ids.map((id) => (id ? (pools.get(id) ?? null) : null))
}

/** 按 ID 读池子：Pool 的 ID，或 DaoFeePool 的 ID（已经读到这个对象时传 object，不再读） */
export async function loadAftermathPool(client: SuiClient, id: string, signal?: AbortSignal, object?: SuiObject | null): Promise<AftermathPool | null> {
  const o = object ?? (await client.objects([normalizeSuiAddress(id)], { fields: ['type', 'owner', 'json'], signal }))[0]
  if (!o) return null
  const isDao = !!o.type?.startsWith(`${AFTERMATH.dao}::pool::DaoFeePool<`)
  const poolId = isDao ? normalizeSuiAddress(String(json(o).pool_id)) : normalizeSuiAddress(o.objectId)
  return (await loadPoolObjects(client, [poolId], signal, isDao ? [] : [o])).get(poolId) ?? null
}

export const isAftermathObject = (type: string | null) => !!type && (type.startsWith(`${AFTERMATH.amm}::pool::Pool<`) || type.startsWith(`${AFTERMATH.dao}::pool::DaoFeePool<`))

async function loadPoolObjects(client: SuiClient, ids: readonly string[], signal?: AbortSignal, known: readonly SuiObject[] = []): Promise<Map<string, AftermathPool>> {
  const out = new Map<string, AftermathPool>()
  const have = new Map(known.map((o) => [normalizeSuiAddress(o.objectId), o]))
  const missing = ids.filter((id) => !have.has(id))
  const read = missing.length ? await client.objects(missing, { fields: ['type', 'owner', 'json'], signal }) : []
  const objects = [...ids.flatMap((id) => have.get(id) ?? []), ...read.filter((o): o is SuiObject => !!o)]
  // DAO 费池子：Pool → 动态字段 → DaoFeePool
  const wrapped = objects.filter((o) => o.owner?.kind === 'object' && o.owner.address)
  const fields = wrapped.length ? await client.objects(wrapped.map((o) => normalizeSuiAddress(o.owner?.address as string)), { fields: ['owner'], signal }) : []
  const daoIds = fields.map((f) => (f?.owner?.kind === 'object' && f.owner.address ? normalizeSuiAddress(f.owner.address) : null))
  const daos = new Map(
    (await client.objects([...new Set(daoIds.filter((x): x is string => !!x))], { fields: ['type', 'owner', 'json'], signal })).flatMap((d) => {
      const s = d && sharedOf(d)
      return d && s && d.type?.startsWith(`${AFTERMATH.dao}::pool::DaoFeePool<`) ? [[normalizeSuiAddress(d.objectId), { id: s.objectId, shared: s, feeBps: Number(json(d).fee_bps ?? 0), poolId: normalizeSuiAddress(String(json(d).pool_id)) }] as const] : []
    }),
  )
  for (const o of objects) {
    const parsed = parseAftermathPool(o)
    if (!parsed) continue
    const s = sharedOf(o)
    if (s) {
      out.set(parsed.id, { ...parsed, shared: s, dao: null })
      continue
    }
    const k = wrapped.indexOf(o)
    const dao = k >= 0 && daoIds[k] ? daos.get(daoIds[k] as string) : undefined
    if (dao && dao.poolId === parsed.id) out.set(parsed.id, { ...parsed, shared: null, dao: { id: dao.id, shared: dao.shared, feeBps: dao.feeBps } })
  }
  return out
}

/** 像 Aftermath LP 的代币类型：没有类型参数（每个池子发自己的 LP 代币） */
export const maybeAftermathLp = (coinType: string) => !coinType.includes('<') && normalizeStructTag(coinType) !== normalizeStructTag('0x2::sui::SUI')
