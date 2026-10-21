/**
 * 按两种币找池子（/price、/swap 用）：Cetus、Magma、Turbos、FlowX CLMM、DipCoin、FlowX V2 的注册表条目的对象 ID 都能在本地算出，
 * 一轮 BatchGetObjects 读完，不需要索引服务。其他 DEX（Bluefin、Momentum、Kriya、Cetus DLMM、Aftermath）没有按币对查的链上注册表
 */
import { blake2b } from '@noble/hashes/blake2.js'
import { sha256 } from '@noble/hashes/sha2.js'

import { normalizeSuiAddress } from './address.js'
import { CETUS } from './cetus.js'
import type { SuiClient } from './client.js'
import { json } from './dex/util.js'
import { dynamicFieldId, stringFieldId, typeNameOf } from './dynamicField.js'
import type { GrpcTransport } from './grpc.js'
import type { SuiObject } from './services.js'
import { BcsWriter } from './write/bcs.js'

/** 能按币对找池子的 DEX */
export type PoolLookupProtocol = 'cetus' | 'magma' | 'turbos' | 'flowx' | 'dipcoin' | 'flowx-v2'

export const TURBOS_PKG = '0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1'
export const FLOWX_PKG = '0x25929e7f29e0a30eb4e692952ba1b5b65a3a4d65ab5f2a32e1ba3edcb587f26d'

/** Cetus：factory::Pools（0xf699…98d0）的 list（LinkedTable<ID, PoolSimpleInfo>），键是 blake2b256(类型名 A ‖ 类型名 B ‖ u32 tick spacing)，A 是字典序较大的一个 */
const CETUS_POOL_LIST = '0x4c9ab808d50ca1358cc699bb53b6334b9471d4718fb19bb621ff41c2e93bbce4'
/** Magma（Cetus 的分叉）：factory::Pools（0xfa14…a8b2）的 list，键的算法与 Cetus 相同 */
const MAGMA_POOL_LIST = '0x4f0cdc6195a637f65c7b28e6d614af65fa5bd719f3fa29a7507065e9e3a92648'
/** Turbos：pool_factory::PoolConfig（fee_map 是手续费类型，pools 是 Table<ID, PoolSimpleInfo>），键是 sha256(类型名 lo ‖ 类型名 hi ‖ 手续费类型名) */
const TURBOS_POOL_CONFIG = '0xc294552b2765353bcafa7c359cd28fd6bc237662e5db8f09877558d81669170c'
/** FlowX CLMM：池子是 PoolRegistry 的动态对象字段，键是 PoolDfKey { coin_type_x: lo, coin_type_y: hi, fee_rate } */
const FLOWX_POOL_REGISTRY = '0x27565d24a4cd51127ac90e4074a841bbe356cca7bf5759ddc14a975be1632abc'
/** FlowX 的手续费档位（PoolRegistry.fee_amount_tick_spacing，2026-10） */
const FLOWX_FEES = [0, 10, 100, 500, 1000, 2000, 3000, 10000]
/** Magma 的 GlobalConfig（fee_tiers），与 dex/cetus.ts 的 MAGMA_CONFIG 相同（这里单独写，/price 不用打包 DEX 的读取代码） */
const MAGMA_GLOBAL_CONFIG = '0x4c4e1402401f72c7d8533d0ed8d5f8949da363c7a3319ccef261ffe153d32f8a'
/** DipCoin 的 Global.registered_pools、FlowX V2 的 Container.pairs（同 amm/dipcoin.ts、amm/flowxV2.ts） */
const DIPCOIN_REGISTRY = '0x55c65b7b67b0ccdf28e13b3b6d204e859dd19556603e3b94137a19306a7254d8'
const FLOWX_V2_PAIRS = '0xd15e209f5a250d6055c264975fee57ec09bf9d6acdda3b5f866f76023d1563e6'

/** 各 DEX 的手续费档位：Cetus / Magma 的 tick spacing、Turbos 的手续费类型（从配置对象读） */
export interface Tiers {
  cetus: number[]
  magma: number[]
  turbos: { table: string; feeTypes: string[] } | null
}

type TierKey = keyof Tiers

interface Lookup {
  /** 一对币在注册表里的条目 ID（lo < hi 是两种币按字典序排列的类型名） */
  entries(lo: string, hi: string, tiers: Tiers): string[]
  /** 条目里的池子 ID */
  poolId(entry: SuiObject): unknown
  /** 要读哪些配置（手续费档位） */
  tiers: readonly TierKey[]
}

const utf8 = (s: string) => new TextEncoder().encode(s)
const ID_TYPE = '0x2::object::ID'
const cetusKey = (list: string, lo: string, hi: string, spacings: readonly number[]) =>
  spacings.map((ts) => dynamicFieldId(list, ID_TYPE, blake2b(new BcsWriter().fixed(utf8(hi)).fixed(utf8(lo)).u32(ts).finish(), { dkLen: 32 })))

export const POOL_LOOKUPS: Readonly<Record<PoolLookupProtocol, Lookup>> = {
  cetus: {
    entries: (lo, hi, tiers) => cetusKey(CETUS_POOL_LIST, lo, hi, tiers.cetus),
    // linked_table::Node<ID, PoolSimpleInfo>
    poolId: (e) => json(e).value?.value?.pool_id,
    tiers: ['cetus'],
  },
  magma: {
    entries: (lo, hi, tiers) => cetusKey(MAGMA_POOL_LIST, lo, hi, tiers.magma),
    poolId: (e) => json(e).value?.value?.pool_id,
    tiers: ['magma'],
  },
  turbos: {
    entries: (lo, hi, { turbos }) => (turbos ? turbos.feeTypes.map((fee) => dynamicFieldId(turbos.table, ID_TYPE, sha256(utf8(lo + hi + fee)))) : []),
    poolId: (e) => json(e).value?.pool_id,
    tiers: ['turbos'],
  },
  flowx: {
    entries: (lo, hi) =>
      FLOWX_FEES.map((fee) => dynamicFieldId(FLOWX_POOL_REGISTRY, `0x2::dynamic_object_field::Wrapper<${FLOWX_PKG}::pool_manager::PoolDfKey>`, new BcsWriter().string(lo).string(hi).u64(fee).finish())),
    // 动态对象字段的值是池子对象的 ID
    poolId: (e) => json(e).value,
    tiers: [],
  },
  // Global.registered_pools：键 "LP-X-Y"（池子的币顺序），值是池子地址；顺序未知，两种都查
  dipcoin: {
    entries: (lo, hi) => [stringFieldId(DIPCOIN_REGISTRY, `LP-${lo}-${hi}`), stringFieldId(DIPCOIN_REGISTRY, `LP-${hi}-${lo}`)],
    poolId: (e) => json(e).value,
    tiers: [],
  },
  // Container.pairs：键 "LP-X-Y"，字段对象本身就是池子（PairMetadata）
  'flowx-v2': {
    entries: (lo, hi) => [stringFieldId(FLOWX_V2_PAIRS, `LP-${lo}-${hi}`), stringFieldId(FLOWX_V2_PAIRS, `LP-${hi}-${lo}`)],
    poolId: (e) => e.objectId,
    tiers: [],
  },
}

/** 配置对象（手续费档位）缓存多久（毫秒） */
const TIERS_TTL = 10 * 60_000
const tierCache = /* @__PURE__ */ new WeakMap<GrpcTransport, Map<TierKey, { at: number; value: Promise<unknown> }>>()

const CONFIGS: Readonly<Record<TierKey, string>> = { cetus: CETUS.globalConfig.objectId, magma: MAGMA_GLOBAL_CONFIG, turbos: TURBOS_POOL_CONFIG }

function parseTier(key: TierKey, o: SuiObject | null): unknown {
  if (!o) throw new Error(`${key} config not found`)
  if (key === 'turbos') {
    const feeMap = (json(o).fee_map?.contents ?? []) as Array<{ key: unknown }>
    const table = json(o).pools?.id
    return typeof table === 'string' ? { table: normalizeSuiAddress(table), feeTypes: feeMap.flatMap((f) => (typeof f.key === 'string' ? [f.key] : [])) } : null
  }
  const feeTiers = (json(o).fee_tiers?.contents ?? []) as Array<{ key: unknown }>
  return feeTiers.map((t) => Number(t.key)).filter((ts) => Number.isInteger(ts) && ts > 0)
}

/**
 * 读 Cetus / Magma GlobalConfig 的 fee_tiers、Turbos PoolConfig 的 fee_map（缺的一次读完，按节点缓存 10 分钟；
 * 多个查询共用，不跟随某一个查询取消）
 */
export async function loadTiers(client: SuiClient, keys: readonly TierKey[]): Promise<Tiers> {
  let cache = tierCache.get(client.transport)
  if (!cache) {
    cache = new Map()
    tierCache.set(client.transport, cache)
  }
  const byKey = cache
  const now = Date.now()
  const missing = [...new Set(keys)].filter((k) => {
    const c = byKey.get(k)
    return !c || now - c.at >= TIERS_TTL
  })
  if (missing.length) {
    const read = client.objects(
      missing.map((k) => CONFIGS[k]),
      { fields: ['json'] },
    )
    missing.forEach((k, i) => {
      const entry = { at: now, value: read.then((objects) => parseTier(k, objects[i] ?? null)) }
      // 失败的不缓存
      entry.value.catch(() => {
        if (byKey.get(k) === entry) byKey.delete(k)
      })
      byKey.set(k, entry)
    })
  }
  const tiers: Tiers = { cetus: [], magma: [], turbos: null }
  for (const k of new Set(keys)) (tiers as unknown as Record<TierKey, unknown>)[k] = await (byKey.get(k) as { value: Promise<unknown> }).value
  return tiers
}

export interface FoundPool {
  protocol: PoolLookupProtocol
  /** 池子 ID（FlowX V2 是 pairs 表里的字段对象） */
  id: string
}

/** 按币对找池子：结果与 pairs 一一对应（每个币对在各 DEX、各手续费档位的池子） */
export async function findPools(client: SuiClient, pairs: ReadonlyArray<readonly [string, string]>, protocols: readonly PoolLookupProtocol[], signal?: AbortSignal): Promise<FoundPool[][]> {
  const lookups = protocols.map((p) => [p, POOL_LOOKUPS[p]] as const).filter(([, l]) => !!l)
  if (!pairs.length || !lookups.length) return pairs.map(() => [])
  const tiers = await loadTiers(
    client,
    lookups.flatMap(([, l]) => l.tiers),
  )
  signal?.throwIfAborted()
  const list: Array<{ pair: number; protocol: PoolLookupProtocol; lookup: Lookup; entry: string }> = []
  pairs.forEach(([x, y], pair) => {
    const [a, b] = [typeNameOf(x), typeNameOf(y)]
    const [lo, hi] = a < b ? [a, b] : [b, a]
    for (const [protocol, lookup] of lookups) for (const entry of lookup.entries(lo, hi, tiers)) list.push({ pair, protocol, lookup, entry })
  })
  const entries = await client.objects(
    list.map((l) => l.entry),
    { fields: ['json'], signal },
  )
  const out: FoundPool[][] = pairs.map(() => [])
  const seen = new Set<string>()
  list.forEach((l, i) => {
    const e = entries[i]
    const id = e ? l.lookup.poolId(e) : null
    if (typeof id !== 'string') return
    const key = `${l.pair}:${normalizeSuiAddress(id)}`
    if (seen.has(key)) return
    seen.add(key)
    out[l.pair]?.push({ protocol: l.protocol, id: normalizeSuiAddress(id) })
  })
  return out
}
