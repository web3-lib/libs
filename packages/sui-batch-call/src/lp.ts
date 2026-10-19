/**
 * LP 仓位（子路径 `@w3lib/sui-batch-call/lp`）：Sui 上集中流动性 DEX 的仓位对象，以及传统 AMM 的 LP。
 * 集中流动性：未领取的手续费和挖矿奖励由合约自己算：一次只读调用（不检查交易的模拟）里对每个仓位执行领取，读返回的数量，
 * 与真正领取时的结果相同；撤出能拿到的数量按 tick 和流动性计算（Cetus 用合约的 get_position_amounts_v2）。
 * 传统 AMM：持有的 LP × 池子储备 / LP 总量（手续费已经计入储备）
 */
import { normalizeStructTag, normalizeSuiAddress } from './address.js'
import { amountsForLiquidity, sqrtPriceAtTick } from './clmmMath.js'
import type { RequestOptions, SuiClient } from './client.js'
import { resolvePackages } from './dex/env.js'
import { AMM_READERS } from './amm/index.js'
import type { AmmHolding, AmmPool, AmmReader, SuiAmmProtocol } from './amm/types.js'
import { READERS, readerList } from './dex/index.js'
import { inspect } from './dex/inspect.js'
import { typeArgs } from './dex/util.js'
import type { DexEnv, DexPool, DexPosition, DexReader, ReadOut, SuiLpProtocol } from './dex/types.js'
import { formatUnits } from './format.js'
import { CETUS_DLMM, CETUS_DLMM_POSITION_TYPE, binPrice, parseDlmmPool, parseDlmmPosition, readDlmm, type DlmmPool, type DlmmPosition, type DlmmReadOut, type SuiDlmmProtocol } from './dlmm.js'
import { AFTERMATH, loadAftermathPools, maybeAftermathLp, parseAftermathFees, withdrawAllAmounts, type AftermathPool, type SuiMultiProtocol } from './aftermath.js'
import { listBalances, type BalanceEntry, type SuiObject } from './services.js'

export type { SuiAmmProtocol } from './amm/types.js'
export type { SuiDlmmProtocol } from './dlmm.js'
export type { SuiMultiProtocol } from './aftermath.js'
export type { SuiClmmProtocol, SuiLpProtocol } from './dex/types.js'

export interface SuiLpProtocolInfo {
  name: string
  /** clmm：集中流动性的仓位对象；dlmm：bin 式的仓位对象；amm：两种币的 LP 代币；multi：多币池的 LP 代币 */
  type: 'clmm' | 'dlmm' | 'amm' | 'multi'
  /** 仓位对象的类型（Kriya AMM 是 KriyaLPToken 的类型前缀）；LP 是普通 Coin 时为 null */
  positionType: string | null
  /** LP 是普通 Coin 时：LP 代币类型的前缀（如 `0x…::manage::LP`），否则为 null */
  lpCoinType: string | null
}

/** 支持的协议 */
export const SUI_LP_PROTOCOLS = {
  ...Object.fromEntries(Object.values(READERS).map((a) => [a.protocol, { name: a.name, type: 'clmm', positionType: a.positionType, lpCoinType: null }])),
  ...Object.fromEntries(
    Object.values(AMM_READERS).map((a) => [a.protocol, { name: a.name, type: 'amm', positionType: a.positionPrefix?.slice(0, -1) ?? null, lpCoinType: a.lpCoinPrefix?.slice(0, -1) ?? null }]),
  ),
  'cetus-dlmm': { name: 'Cetus DLMM', type: 'dlmm', positionType: CETUS_DLMM_POSITION_TYPE, lpCoinType: null },
  // 每个池子有自己的 LP 代币（如 0x…::af_lp::AF_LP），按 PoolRegistry 的 lp_coin_map 认出来
  aftermath: { name: 'Aftermath', type: 'multi', positionType: null, lpCoinType: null },
} as Readonly<Record<SuiLpProtocol, SuiLpProtocolInfo>>

// ---------------------------------------------------------------------------
// 价格源
// ---------------------------------------------------------------------------

export interface SuiPriceSource {
  readonly name: string
  /** 返回代币类型（规范化） → 美元价格；没有价格的不返回 */
  prices(ctx: { coinTypes: readonly string[]; fetch: typeof fetch; signal?: AbortSignal }): Promise<Map<string, number>>
}

/** DefiLlama 价格（免费免 Key，按 50 个一批查询）；confidence 低于 minConfidence（默认 0.9）的价格不用 */
export function defillamaPrices(options: { minConfidence?: number } = {}): SuiPriceSource {
  const minConfidence = options.minConfidence ?? 0.9
  return {
    name: 'defillama',
    async prices({ coinTypes, fetch: fetchFn, signal }) {
      const result = new Map<string, number>()
      const batches: string[][] = []
      for (let i = 0; i < coinTypes.length; i += 50) batches.push(coinTypes.slice(i, i + 50))
      await Promise.all(
        batches.map(async (batch) => {
          const res = await fetchFn(`https://coins.llama.fi/prices/current/${batch.map((t) => encodeURIComponent(`sui:${t}`)).join(',')}`, { signal })
          if (!res.ok) throw new Error(`DefiLlama prices: HTTP ${res.status}`)
          const body = (await res.json()) as { coins?: Record<string, { price?: number; confidence?: number }> }
          for (const [key, coin] of Object.entries(body.coins ?? {})) {
            if (typeof coin.price === 'number' && Number.isFinite(coin.price) && (coin.confidence === undefined || coin.confidence >= minConfidence)) {
              result.set(normalizeStructTag(key.slice(key.indexOf(':') + 1)), coin.price)
            }
          }
        }),
      )
      return result
    },
  }
}

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

export interface SuiLpToken {
  /** 代币类型（规范化） */
  coinType: string
  symbol: string | null
  /** 读不到时为 null（这时 formatted 字段也为 null） */
  decimals: number | null
}

export interface SuiLpReward extends SuiLpToken {
  /** 未领取的奖励（最小单位） */
  amount: string
  formatted: string | null
  /** 开启 prices 时返回 */
  valueUsd?: number | null
}

export interface SuiLpPositionBase {
  protocol: SuiLpProtocol
  protocolName: string
  pool: string
  token0: SuiLpToken
  token1: SuiLpToken
  /** 价格是 token1 / token0（按精度换算，只用于展示）；读不到精度时为 null */
  price: number | null
  /** 开启 prices 时：两种代币的美元价值（缺价格时为 null） */
  valueUsd?: number | null
}

/** 传统 AMM（DipCoin、FlowX V2、Kriya）：持有的 LP */
export interface SuiLpAmmPosition extends SuiLpPositionBase {
  type: 'amm'
  protocol: SuiAmmProtocol
  /** Kriya：KriyaLPToken 对象 ID（每个对象一个仓位）；LP 是普通 Coin 时为 null（地址持有的这种 LP 合计一个仓位） */
  position: string | null
  /** LP 代币的类型 */
  lpCoinType: string
  /** 持有的 LP 和 LP 总量（最小单位） */
  balance: string
  totalSupply: string
  /** 份额（0~1，浮点数） */
  share: number
  /** 撤出全部 LP 能拿到的数量（LP × 储备 / 总量，向下取整，手续费已经计入储备） */
  amount0: string
  amount1: string
  amount0Formatted: string | null
  amount1Formatted: string | null
  reserve0: string
  reserve1: string
  /** 交易手续费率，百万分之一（3000 = 0.3%） */
  fee: number
  /** Kriya 的 stable 池子 */
  stable: boolean
}

/** 集中流动性：仓位对象 */
export interface SuiLpClmmPosition extends SuiLpPositionBase {
  type: 'clmm'
  /** 仓位对象 ID */
  position: string
  /** 撤出全部流动性能拿到的数量（最小单位，不含手续费）；合约调用失败时为 null */
  amount0: string | null
  amount1: string | null
  amount0Formatted: string | null
  amount1Formatted: string | null
  /** 手续费率，百万分之一（2500 = 0.25%） */
  fee: number
  tickSpacing: number
  /** 区间（Turbos 的 tick 在仓位管理器里，读不到时为 null） */
  tickLower: number | null
  tickUpper: number | null
  /** 池子当前 tick */
  tick: number
  /** 当前价格在区间内（tickLower ≤ tick < tickUpper）；读不到区间时为 null */
  inRange: boolean | null
  liquidity: string | null
  /** 区间的价格（token1 / token0，按精度换算，只用于展示）；读不到精度时为 null */
  priceLower: number | null
  priceUpper: number | null
  /** 未领取的手续费（最小单位）；合约调用失败时为 null */
  fees0: string | null
  fees1: string | null
  fees0Formatted: string | null
  fees1Formatted: string | null
  /** 未领取的挖矿奖励（与池子的奖励顺序相同）；合约调用失败时为 null */
  rewards: SuiLpReward[] | null
  /** Cetus 标记的受攻击影响的仓位（2025 年 5 月的攻击事件，pool::is_attacked_position）：合约不允许一次移除全部流动性；其他 DEX 为 false，读不到时为 null */
  restricted: boolean | null
  /** 开启 prices 时：手续费的美元价值、奖励的美元价值（缺价格时为 null） */
  feesUsd?: number | null
  rewardsUsd?: number | null
}

/** Cetus DLMM：仓位对象，流动性分布在 [binLower, binUpper] 的 bin 里 */
export interface SuiLpDlmmPosition extends SuiLpPositionBase {
  type: 'dlmm'
  protocol: SuiDlmmProtocol
  /** 仓位对象 ID */
  position: string
  /** 撤出全部流动性能拿到的数量（不含手续费）；合约调用失败时为 null */
  amount0: string | null
  amount1: string | null
  amount0Formatted: string | null
  amount1Formatted: string | null
  /** 基础手续费率，百万分之一（另有随波动变化的动态手续费） */
  fee: number
  /** 相邻两个 bin 的价格差，万分之一（50 = 0.5%） */
  binStep: number
  /** 仓位的 bin 区间、池子当前价格所在的 bin */
  binLower: number
  binUpper: number
  activeBin: number
  inRange: boolean
  /** 区间两端 bin 的价格（token1 / token0，按精度换算，只用于展示） */
  priceLower: number | null
  priceUpper: number | null
  fees0: string | null
  fees1: string | null
  fees0Formatted: string | null
  fees1Formatted: string | null
  rewards: SuiLpReward[] | null
  feesUsd?: number | null
  rewardsUsd?: number | null
}

/** 多币池里的一种币 */
export interface SuiLpMultiCoin extends SuiLpToken {
  /** 权重（0~1；稳定池也有，只用于展示） */
  weight: number
  /** 池子的储备（最小单位） */
  reserve: string
  /** 按比例取回全部币时能拿到的（已扣协议手续费和 DAO 费） */
  amount: string
  amountFormatted: string | null
  /** 开启 prices 时 */
  valueUsd?: number | null
}

/** 多币池（Aftermath，2~8 种币的加权池或稳定池）：持有的 LP */
export interface SuiLpMultiPosition {
  type: 'multi'
  protocol: SuiMultiProtocol
  protocolName: string
  /** 池子对象 ID（DAO 费池子也是里面的 Pool 的 ID） */
  pool: string
  /** LP 是普通代币，没有仓位对象 */
  position: null
  lpCoinType: string
  /** 持有的 LP 和 LP 总量（最小单位） */
  balance: string
  totalSupply: string
  /** 份额（0~1，浮点数） */
  share: number
  /** 池子的币（池子的顺序） */
  coins: SuiLpMultiCoin[]
  /** swap 手续费率，百万分之一 */
  fee: number
  /** 稳定池（flatness = 1） */
  stable: boolean
  /** 存入、取出时收的协议手续费，百万分之一（500 = 0.05%；有推荐人时略少） */
  protocolFee: number
  /** DAO 费池子存取时额外收的费率，百万分之一；普通池子为 null */
  daoFee: number | null
  /** 开启 prices 时：全部币的美元价值（缺价格时为 null） */
  valueUsd?: number | null
}

export type SuiLpPosition = SuiLpClmmPosition | SuiLpDlmmPosition | SuiLpAmmPosition | SuiLpMultiPosition

export interface LpPositionsOptions extends RequestOptions {
  /** 只查这些协议，默认全部 */
  protocols?: readonly SuiLpProtocol[]
  /** 只查这些仓位对象（不扫描地址拥有的对象；LP 是普通 Coin 的 AMM 没有仓位对象，这时不查） */
  positions?: readonly string[]
  /** 返回已清空的仓位（流动性为 0、手续费和奖励也领完，仓位对象还在；Kriya 是 LP 为 0 的 KriyaLPToken）。默认 false */
  includeClosed?: boolean
  /** 查美元价值：true 用 DefiLlama，也可以传自己的 SuiPriceSource。默认不查 */
  prices?: boolean | SuiPriceSource
  /** 价格源出错时调用：这时照样返回仓位，只是美元价值为 null */
  onPriceError?: (err: unknown) => void
  /**
   * 某个协议读取出错时调用：扫描、读池子的准备工作出错时跳过这个协议（照样返回其他协议的仓位）；
   * 读不到池子的仓位跳过；只读调用时节点出错，仓位照样返回、手续费和奖励为 null
   */
  onError?: (protocol: SuiLpProtocol, err: unknown) => void
  /** 查价用的 fetch */
  fetch?: typeof fetch
}

/** 每次只读调用最多几个仓位（交易大小有上限） */
const PER_INSPECT = 50

const EMPTY: ReadOut = { fees: null, rewards: null }

/** 一次只读调用领取一批仓位的手续费和奖励；整批失败时逐个再算（个别仓位出错不影响其他的） */
type Item = { adapter: DexReader; pos: DexPosition; pool: DexPool; sender: string }

/** 限制并发地对每一项执行 */
async function mapLimit<T, R>(list: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (next < list.length) {
        const i = next++
        out[i] = await fn(list[i] as T)
      }
    }),
  )
  return out
}

/**
 * 按批只读调用，每项一个解析结果；整批执行失败（Move abort）时逐个再算（并发 8），个别出错不影响其他的。
 * 节点出错（限频、超时等）时不逐个重试：这批的结果为 null，错误交给 onFail。
 * 每批里的仓位属于同一个地址（只读调用以它为发送者）
 */
async function inspectEach<T extends { sender: string }, R>(
  client: SuiClient,
  packages: Map<string, string>,
  items: readonly T[],
  build: (env: DexEnv, item: T) => (outputs: unknown[][]) => R,
  onFail: (batch: readonly T[], err: unknown) => void,
  signal?: AbortSignal,
): Promise<Array<R | null>> {
  /** undefined：节点出错；null：执行失败 */
  const run = async (batch: readonly T[]): Promise<R[] | null | undefined> => {
    const res = await inspect(
      client,
      (batch[0] as T).sender,
      packages,
      (env) => {
        const decoders = batch.map((item) => build(env, item))
        return (outputs) => decoders.map((d) => d(outputs))
      },
      signal,
    ).catch((err: unknown) => {
      if (signal?.aborted) throw err
      onFail(batch, err)
      return undefined
    })
    return res === undefined ? undefined : res.value
  }
  const out: Array<R | null> = new Array(items.length).fill(null)
  const bySender = new Map<string, number[]>()
  items.forEach((item, i) => bySender.set(item.sender, [...(bySender.get(item.sender) ?? []), i]))
  for (const indexes of bySender.values()) {
    for (let i = 0; i < indexes.length; i += PER_INSPECT) {
      const idx = indexes.slice(i, i + PER_INSPECT)
      const all = await run(idx.map((k) => items[k] as T))
      if (all) idx.forEach((k, j) => (out[k] = all[j] ?? null))
      else if (all === null) await mapLimit(idx, 8, async (k) => (out[k] = (await run([items[k] as T]))?.[0] ?? null))
    }
  }
  return out
}

/**
 * 地址的 LP 仓位：扫描拥有的仓位对象（各 DEX 的类型），读池子，一次只读调用领取手续费和奖励。
 *
 * ```ts
 * import { lpPositions } from '@w3lib/sui-batch-call/lp'
 * await lpPositions(sui, owner, { prices: true })
 * ```
 */
export async function lpPositions(client: SuiClient, owner: string, options: LpPositionsOptions = {}): Promise<SuiLpPosition[]> {
  const { signal } = options
  const address = normalizeSuiAddress(owner)
  const adapters = readerList(options.protocols)
  const ammReaders = (options.protocols ?? (Object.keys(AMM_READERS) as SuiAmmProtocol[])).flatMap((p) => AMM_READERS[p as SuiAmmProtocol] ?? [])
  const dlmm = !options.protocols || options.protocols.includes('cetus-dlmm')
  // LP 是普通代币的协议（不指定仓位对象时）：地址的余额只读一次
  const multi = (!options.protocols || options.protocols.includes('aftermath')) && !options.positions
  if (!adapters.length && !ammReaders.length && !dlmm && !multi) return []
  let balancesOnce: Promise<BalanceEntry[]> | null = null
  const balances = () => (balancesOnce ??= listBalances(client.transport, address, { signal }).then((r) => r.balances))
  const broken = new Set<Source>()
  const report = (adapter: Source, err: unknown) => {
    try {
      options.onError?.(adapter.protocol, err)
    } catch {
      // 回调出错不影响结果
    }
  }
  const failed = (adapter: Source, err: unknown) => {
    if (signal?.aborted) throw err
    broken.add(adapter)
    report(adapter, err)
  }
  // 只读调用时节点出错：仓位照样返回（手续费、奖励为 null），每个协议只报一次
  const reported = new Set<DexReader>()
  const inspectFailed = (batch: readonly Item[], err: unknown) => {
    for (const a of new Set(batch.map((i) => i.adapter))) {
      if (reported.has(a)) continue
      reported.add(a)
      report(a, err)
    }
  }
  // 指定了仓位 ID 时先读出来，按类型分给各协议（重复的 ID 只读一次：Momentum 等领取后再读会显示为 0）
  const given = options.positions
    ? (await client.objects([...new Set(options.positions.map(normalizeSuiAddress))], { fields: ['type', 'owner', 'json'], signal })).filter((o): o is SuiObject => !!o)
    : null
  const [{ items, computed }, amm, bins, multiPools] = await Promise.all([
    loadClmm(client, address, adapters, given, { signal, failed, report, inspectFailed, broken }),
    loadAmm(client, address, ammReaders, given, balances, { signal, failed, includeClosed: !!options.includeClosed }),
    dlmm ? loadDlmm(client, address, given, { signal, failed, report }) : [],
    multi ? loadMulti(client, balances, { signal, failed }) : null,
  ])
  return build(client, items, computed, amm, bins, multiPools, options)
}

const MULTI_SOURCE: Source = { protocol: 'aftermath' }

/** 多币池（Aftermath）：余额里没有类型参数的代币都可能是 LP，按 lp_coin_map 找池子；再读协议手续费 */
async function loadMulti(
  client: SuiClient,
  balances: () => Promise<BalanceEntry[]>,
  hooks: Pick<LoadHooks, 'signal' | 'failed'>,
): Promise<{ held: Array<{ pool: AftermathPool; balance: bigint }>; fees: ReturnType<typeof parseAftermathFees> } | null> {
  const { signal, failed } = hooks
  try {
    const candidates = (await balances()).filter((b) => b.balance > 0n && maybeAftermathLp(b.coinType))
    if (!candidates.length) return null
    const [pools, [vault]] = await Promise.all([
      loadAftermathPools(client, candidates.map((b) => normalizeStructTag(b.coinType)), signal),
      client.objects([AFTERMATH.feeVault.objectId], { fields: ['json'], signal }),
    ])
    const held = candidates.flatMap((b, i) => (pools[i] ? [{ pool: pools[i] as AftermathPool, balance: b.balance }] : []))
    return held.length ? { held, fees: parseAftermathFees(vault ?? null) } : null
  } catch (err) {
    failed(MULTI_SOURCE, err)
    return null
  }
}

/** 出错时报告的来源：协议的适配器 */
type Source = { protocol: SuiLpProtocol }

interface LoadHooks {
  signal?: AbortSignal
  failed: (adapter: Source, err: unknown) => void
  report: (adapter: Source, err: unknown) => void
  inspectFailed: (batch: readonly Item[], err: unknown) => void
  /** 出错跳过的协议 */
  broken: ReadonlySet<Source>
}

const DLMM_SOURCE: Source = { protocol: 'cetus-dlmm' }

/** Cetus DLMM：仓位对象 → 池子 → 一次只读调用（refresh_position_info_v2）算出数量、手续费和奖励 */
async function loadDlmm(
  client: SuiClient,
  address: string,
  given: SuiObject[] | null,
  hooks: Pick<LoadHooks, 'signal' | 'failed' | 'report'>,
): Promise<Array<{ pos: DlmmPosition; pool: DlmmPool; read: DlmmReadOut | null }>> {
  const { signal, failed, report } = hooks
  try {
    const objects = given ? given.filter((o) => o.type === CETUS_DLMM_POSITION_TYPE) : await client.ownedObjects(address, { type: CETUS_DLMM_POSITION_TYPE, fields: ['type', 'owner', 'json'], signal })
    const ownerOf = new Map(objects.map((o) => [normalizeSuiAddress(o.objectId), o.owner?.kind === 'address' && o.owner.address ? normalizeSuiAddress(o.owner.address) : address]))
    const positions = objects.flatMap((o) => parseDlmmPosition(o) ?? [])
    if (!positions.length) return []
    const pools = new Map(
      (await client.objects([...new Set(positions.map((p) => p.pool))], { fields: ['type', 'owner', 'json'], signal })).flatMap((o) => {
        const pool = o ? parseDlmmPool(o) : null
        return pool ? [[pool.id, pool] as const] : []
      }),
    )
    const items = positions.flatMap((pos) => {
      const pool = pools.get(pos.pool)
      if (!pool) report(DLMM_SOURCE, new Error(`Position ${pos.id}: cannot read its pool ${pos.pool}`))
      return pool ? [{ pos, pool, sender: ownerOf.get(pos.id) ?? address }] : []
    })
    const packages = await resolvePackages(client.transport, [{ packages: [CETUS_DLMM.pkg] }])
    let reported = false
    const reads = await inspectEach(
      client,
      packages,
      items,
      (env, { pos, pool }) => readDlmm(env, pos, pool),
      (_batch, err) => {
        if (!reported) report(DLMM_SOURCE, err)
        reported = true
      },
      signal,
    )
    return items.map((item, i) => ({ pos: item.pos, pool: item.pool, read: reads[i] ?? null }))
  } catch (err) {
    failed(DLMM_SOURCE, err)
    return []
  }
}

/** 集中流动性：仓位对象 → 池子 → 一次只读调用领取手续费和奖励 */
async function loadClmm(client: SuiClient, address: string, adapters: readonly DexReader[], given: SuiObject[] | null, hooks: LoadHooks): Promise<{ items: Item[]; computed: ReadOut[] }> {
  const { signal, failed, report, inspectFailed, broken } = hooks
  if (!adapters.length) return { items: [], computed: [] }
  // 仓位对象：指定了 ID 时按类型认出协议，否则按各协议的类型扫描
  const found: Array<{ adapter: DexReader; object: SuiObject }> = []
  if (given) {
    for (const o of given) {
      const adapter = adapters.find((a) => a.positionType === o.type)
      if (adapter) found.push({ adapter, object: o })
    }
  } else {
    // 每个协议单独扫描：某个协议出错时只少它的仓位（onError 拿到错误），不影响其他协议
    const lists = await Promise.allSettled(adapters.map((a) => client.ownedObjects(address, { type: a.positionType, fields: ['type', 'owner', 'json'], signal })))
    lists.forEach((r, i) => {
      const adapter = adapters[i] as DexReader
      if (r.status === 'fulfilled') r.value.forEach((object) => found.push({ adapter, object }))
      else failed(adapter, r.reason)
    })
  }
  const positions = found.flatMap(({ adapter, object }) => {
    const pos = adapter.parsePosition(object)
    return pos?.ref ? [{ adapter, pos }] : []
  })
  if (!positions.length) return { items: [], computed: [] }
  const poolIds = [...new Set(positions.map((p) => p.pos.pool))]
  const poolObjects = await client.objects(poolIds, { fields: ['type', 'owner', 'json'], signal })
  const pools = new Map<string, DexPool>()
  poolObjects.forEach((o) => {
    const adapter = o && positions.find((p) => p.pos.pool === normalizeSuiAddress(o.objectId))?.adapter
    const pool = o && adapter?.parsePool(o)
    if (pool) pools.set(pool.id, pool)
  })
  // 只读调用以仓位的持有人为发送者（指定的仓位不一定属于 owner）
  const ownerOf = (o: SuiObject) => (o.owner?.kind === 'address' && o.owner.address ? normalizeSuiAddress(o.owner.address) : address)
  const senders = new Map(found.map(({ object }) => [normalizeSuiAddress(object.objectId), ownerOf(object)]))
  let items: Item[] = positions.flatMap(({ adapter, pos }) => {
    const pool = pools.get(pos.pool)
    if (!pool) report(adapter, new Error(`Position ${pos.id}: cannot read its pool ${pos.pool}`))
    return pool ? [{ adapter, pos, pool, sender: senders.get(pos.id) ?? address }] : []
  })
  // 各协议的准备工作和包版本：出错的协议跳过
  const packages = new Map<string, string>()
  await Promise.all(
    [...new Set(items.map((i) => i.adapter))].map(async (a) => {
      try {
        await a.prepare?.(client, items.filter((i) => i.adapter === a).map((i) => i.pool), signal)
        for (const [k, v] of await resolvePackages(client.transport, [a])) packages.set(k, v)
      } catch (err) {
        failed(a, err)
      }
    }),
  )
  items = items.filter((i) => !broken.has(i.adapter))
  // Turbos：tick 和流动性在仓位管理器里，单独读（不和领取放在同一个只读调用里）
  const stateItems = items.filter((i) => i.adapter.state && (i.pos.tickLower === null || i.pos.liquidity === null))
  const states = await inspectEach(client, packages, stateItems, (env, { adapter, pos }) => (adapter.state as NonNullable<DexReader['state']>)(env, pos), inspectFailed, signal)
  stateItems.forEach((item, k) => {
    const st = states[k]
    if (st) item.pos = { ...item.pos, ...st }
  })
  const computed = (await inspectEach(client, packages, items, (env, { adapter, pos, pool }) => adapter.read(env, pos, pool, () => env.ptb.owned(pos.ref as NonNullable<DexPosition['ref']>)), inspectFailed, signal)).map((r) => r ?? EMPTY)
  return { items, computed }
}

/**
 * 传统 AMM：LP 是普通 Coin 的从地址余额里认出来（一次 ListBalances），放在对象里的（Kriya）扫描地址拥有的对象；
 * 再按各 DEX 的方式找池子
 */
async function loadAmm(
  client: SuiClient,
  address: string,
  readers: readonly AmmReader[],
  given: SuiObject[] | null,
  balances: () => Promise<BalanceEntry[]>,
  hooks: { signal?: AbortSignal; failed: LoadHooks['failed']; includeClosed: boolean },
): Promise<Array<{ reader: AmmReader; holding: AmmHolding; pool: AmmPool }>> {
  const { signal, failed } = hooks
  if (!readers.length) return []
  const holdings: Array<{ reader: AmmReader; holding: AmmHolding }> = []
  const coinReaders = readers.filter((r) => r.lpCoinPrefix)
  // 指定了仓位 ID 时只看这些对象（LP 是普通 Coin 的没有仓位对象，不查）
  if (coinReaders.length && !given) {
    try {
      for (const b of await balances()) {
        const coinType = normalizeStructTag(b.coinType)
        const reader = coinReaders.find((r) => coinType.startsWith(r.lpCoinPrefix as string))
        const args = reader && typeArgs(coinType)
        if (!reader || !args || args.length !== 2 || b.balance === 0n) continue
        holdings.push({ reader, holding: { protocol: reader.protocol, lpCoinType: coinType, coinA: args[0] as string, coinB: args[1] as string, balance: b.balance, position: null, ref: null, pool: null } })
      }
    } catch (err) {
      for (const r of coinReaders) failed(r, err)
    }
  }
  const objectReaders = readers.filter((r) => r.positionPrefix && r.parseHolding)
  const objects = await Promise.all(
    objectReaders.map(async (reader) => {
      try {
        const list = given ? given.filter((o) => o.type?.startsWith(reader.positionPrefix as string)) : await client.ownedObjects(address, { type: (reader.positionPrefix as string).slice(0, -1), fields: ['type', 'owner', 'json'], signal })
        return list.map((o) => ({ reader, holding: (reader.parseHolding as NonNullable<AmmReader['parseHolding']>)(o) }))
      } catch (err) {
        failed(reader, err)
        return []
      }
    }),
  )
  for (const { reader, holding } of objects.flat()) if (holding && (holding.balance > 0n || hooks.includeClosed)) holdings.push({ reader, holding })
  // 找池子：每个 DEX 一批
  const out: Array<{ reader: AmmReader; holding: AmmHolding; pool: AmmPool }> = []
  await Promise.all(
    readers.map(async (reader) => {
      const mine = holdings.filter((h) => h.reader === reader)
      if (!mine.length) return
      try {
        const pools = await reader.loadPools(client, mine.map((h) => h.holding), signal)
        mine.forEach((h, i) => {
          const pool = pools[i]
          if (pool) out.push({ ...h, pool })
          else hooks.failed(reader, new Error(`Cannot find the pool of ${h.holding.position ?? h.holding.lpCoinType}`))
        })
      } catch (err) {
        failed(reader, err)
      }
    }),
  )
  return out
}

/** 读代币信息和价格，组装结果 */
async function build(
  client: SuiClient,
  items: readonly Item[],
  computed: readonly ReadOut[],
  amm: ReadonlyArray<{ reader: AmmReader; holding: AmmHolding; pool: AmmPool }>,
  bins: ReadonlyArray<{ pos: DlmmPosition; pool: DlmmPool; read: DlmmReadOut | null }>,
  multi: Awaited<ReturnType<typeof loadMulti>>,
  options: LpPositionsOptions,
): Promise<SuiLpPosition[]> {
  const { signal } = options
  const coinTypes = [
    ...new Set([
      ...items.flatMap(({ pool }) => [pool.coinA, pool.coinB, ...pool.rewardCoins]),
      ...amm.flatMap(({ pool }) => [pool.coinA, pool.coinB]),
      ...bins.flatMap(({ pool }) => [pool.coinA, pool.coinB, ...pool.rewardCoins]),
      ...(multi?.held ?? []).flatMap(({ pool }) => pool.coins),
    ]),
  ]
  if (!coinTypes.length) return []
  const priceSource = options.prices === true ? defillamaPrices() : options.prices || null
  const fetchFn = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const loadPrices = async (): Promise<Map<string, number>> => {
    if (!priceSource) return new Map()
    try {
      return await priceSource.prices({ coinTypes, fetch: fetchFn, signal })
    } catch (err) {
      if (signal?.aborted) throw err
      try {
        options.onPriceError?.(err)
      } catch {
        // 回调出错不影响结果
      }
      return new Map()
    }
  }
  const [details, priceMap] = await Promise.all([client.coins(coinTypes, { signal }), loadPrices()])
  const meta = new Map(details.map((d) => [d.token, d]))
  const token = (coinType: string): SuiLpToken => ({ coinType, symbol: meta.get(coinType)?.symbol ?? null, decimals: meta.get(coinType)?.decimals ?? null })
  const fmt = (v: bigint | null | undefined, t: SuiLpToken) => (v === null || v === undefined || t.decimals === null ? null : formatUnits(v, t.decimals))
  const usd = (t: SuiLpToken, formatted: string | null) => {
    const price = priceMap.get(t.coinType)
    return formatted === null || price === undefined ? null : Number(formatted) * price
  }
  /** 数量为 0 的部分没有价格也不影响；数量未知时为 null */
  const total = (parts: Array<{ value: number | null; amount: bigint | null }>) => {
    let sum = 0
    for (const p of parts) {
      if (p.amount === null) return null
      if (p.amount === 0n) continue
      if (p.value === null) return null
      sum += p.value
    }
    return sum
  }

  /** 未领取的奖励（与池子的奖励顺序相同）；读不到时为 null */
  const rewardList = (amounts: readonly bigint[] | null, rewardCoins: readonly string[]): SuiLpReward[] | null =>
    amounts?.map((amount, k): SuiLpReward => {
      const t = token(rewardCoins[k] ?? '')
      const formatted = fmt(amount, t)
      return { ...t, amount: amount.toString(), formatted, ...(priceSource ? { valueUsd: amount === 0n ? 0 : usd(t, formatted) } : {}) }
    }) ?? null
  /** 集中流动性和 DLMM：数量、手续费、奖励的美元价值 */
  const addUsd = (out: SuiLpClmmPosition | SuiLpDlmmPosition, [a0, a1]: Array<bigint | null>, [f0, f1]: Array<bigint | null>) => {
    out.valueUsd = total([
      { value: usd(out.token0, out.amount0Formatted), amount: a0 ?? null },
      { value: usd(out.token1, out.amount1Formatted), amount: a1 ?? null },
    ])
    out.feesUsd = total([
      { value: usd(out.token0, out.fees0Formatted), amount: f0 ?? null },
      { value: usd(out.token1, out.fees1Formatted), amount: f1 ?? null },
    ])
    out.rewardsUsd = out.rewards === null ? null : total(out.rewards.map((r) => ({ value: r.valueUsd ?? null, amount: BigInt(r.amount) })))
  }

  const clmm = items.map(({ adapter, pos, pool }, i): SuiLpClmmPosition => {
    const c = computed[i] as ReadOut
    const token0 = token(pool.coinA)
    const token1 = token(pool.coinB)
    // tick 和流动性：仓位对象里的，或只读调用给出的（Turbos）
    const tickLower = c.tickLower ?? pos.tickLower
    const tickUpper = c.tickUpper ?? pos.tickUpper
    const liquidity = c.liquidity ?? pos.liquidity
    const known = tickLower !== null && tickUpper !== null && liquidity !== null
    const amounts =
      c.amounts !== undefined ? c.amounts : known ? amountsForLiquidity(pool.sqrtPrice, sqrtPriceAtTick(tickLower), sqrtPriceAtTick(tickUpper), liquidity) : null
    const [a0, a1] = amounts ?? [null, null]
    const [f0, f1] = c.fees ?? [null, null]
    const scale = token0.decimals !== null && token1.decimals !== null ? 10 ** (token0.decimals - token1.decimals) : null
    const priceAt = (tick: number) => (scale === null ? null : 1.0001 ** tick * scale)
    const sqrt = Number(pool.sqrtPrice) / 2 ** 64
    const rewards = rewardList(c.rewards, pool.rewardCoins)
    const out: SuiLpClmmPosition = {
      type: 'clmm',
      protocol: adapter.protocol,
      protocolName: adapter.name,
      pool: pool.id,
      position: pos.id,
      token0,
      token1,
      amount0: a0?.toString() ?? null,
      amount1: a1?.toString() ?? null,
      amount0Formatted: fmt(a0, token0),
      amount1Formatted: fmt(a1, token1),
      fee: pool.fee,
      tickSpacing: pool.tickSpacing,
      tickLower,
      tickUpper,
      tick: pool.tick,
      inRange: known ? tickLower <= pool.tick && pool.tick < tickUpper : null,
      liquidity: liquidity?.toString() ?? null,
      price: scale === null ? null : sqrt * sqrt * scale,
      priceLower: tickLower === null ? null : priceAt(tickLower),
      priceUpper: tickUpper === null ? null : priceAt(tickUpper),
      fees0: f0?.toString() ?? null,
      fees1: f1?.toString() ?? null,
      fees0Formatted: fmt(f0, token0),
      fees1Formatted: fmt(f1, token1),
      rewards,
      restricted: c.restricted ?? (adapter.protocol === 'cetus' ? null : false),
    }
    if (priceSource) addUsd(out, [a0, a1], [f0, f1])
    return out
  })
  const ammList = amm.map(({ reader, holding, pool }): SuiLpAmmPosition => {
    const token0 = token(pool.coinA)
    const token1 = token(pool.coinB)
    // 撤出时合约按 LP / 总量 × 储备（向下取整）
    const a0 = pool.lpSupply > 0n ? (holding.balance * pool.reserveA) / pool.lpSupply : 0n
    const a1 = pool.lpSupply > 0n ? (holding.balance * pool.reserveB) / pool.lpSupply : 0n
    const out: SuiLpAmmPosition = {
      type: 'amm',
      protocol: reader.protocol,
      protocolName: reader.name,
      pool: pool.id,
      position: holding.position,
      lpCoinType: holding.lpCoinType,
      token0,
      token1,
      balance: holding.balance.toString(),
      totalSupply: pool.lpSupply.toString(),
      share: pool.lpSupply > 0n ? Number((holding.balance * 10n ** 18n) / pool.lpSupply) / 1e18 : 0,
      amount0: a0.toString(),
      amount1: a1.toString(),
      amount0Formatted: fmt(a0, token0),
      amount1Formatted: fmt(a1, token1),
      reserve0: pool.reserveA.toString(),
      reserve1: pool.reserveB.toString(),
      fee: pool.fee,
      stable: pool.stable,
      // 储备的比例（stable 池子不是这个价格，只用于展示）
      price:
        token0.decimals === null || token1.decimals === null || pool.reserveA === 0n ? null : (Number(pool.reserveB) / Number(pool.reserveA)) * 10 ** (token0.decimals - token1.decimals),
    }
    if (priceSource) {
      out.valueUsd = total([
        { value: usd(token0, out.amount0Formatted), amount: a0 },
        { value: usd(token1, out.amount1Formatted), amount: a1 },
      ])
    }
    return out
  })
  const dlmmList = bins.map(({ pos, pool, read }): SuiLpDlmmPosition => {
    const token0 = token(pool.coinA)
    const token1 = token(pool.coinB)
    const [a0, a1] = read?.amounts ?? [null, null]
    const [f0, f1] = read?.fees ?? [null, null]
    const scale = token0.decimals !== null && token1.decimals !== null ? 10 ** (token0.decimals - token1.decimals) : null
    const priceAt = (bin: number) => (scale === null ? null : binPrice(bin, pool.binStep) * scale)
    const rewards = rewardList(read?.rewards ?? null, pool.rewardCoins)
    const out: SuiLpDlmmPosition = {
      type: 'dlmm',
      protocol: 'cetus-dlmm',
      protocolName: 'Cetus DLMM',
      pool: pool.id,
      position: pos.id,
      token0,
      token1,
      amount0: a0?.toString() ?? null,
      amount1: a1?.toString() ?? null,
      amount0Formatted: fmt(a0, token0),
      amount1Formatted: fmt(a1, token1),
      fee: pool.fee,
      binStep: pool.binStep,
      binLower: pos.binLower,
      binUpper: pos.binUpper,
      activeBin: pool.activeBin,
      inRange: pos.binLower <= pool.activeBin && pool.activeBin <= pos.binUpper,
      price: priceAt(pool.activeBin),
      priceLower: priceAt(pos.binLower),
      priceUpper: priceAt(pos.binUpper),
      fees0: f0?.toString() ?? null,
      fees1: f1?.toString() ?? null,
      fees0Formatted: fmt(f0, token0),
      fees1Formatted: fmt(f1, token1),
      rewards,
    }
    if (priceSource) addUsd(out, [a0, a1], [f0, f1])
    return out
  })
  const multiList = (multi?.held ?? []).map(({ pool, balance }): SuiLpMultiPosition => {
    const amounts = withdrawAllAmounts(pool, balance, multi?.fees as NonNullable<typeof multi>['fees'])
    const coins = pool.coins.map((coinType, i): SuiLpMultiCoin => {
      const t = token(coinType)
      const amount = amounts[i] ?? 0n
      const formatted = fmt(amount, t)
      return {
        ...t,
        weight: Number(pool.weights[i] ?? 0n) / 1e18,
        reserve: (pool.reserves[i] ?? 0n).toString(),
        amount: amount.toString(),
        amountFormatted: formatted,
        ...(priceSource ? { valueUsd: amount === 0n ? 0 : usd(t, formatted) } : {}),
      }
    })
    const out: SuiLpMultiPosition = {
      type: 'multi',
      protocol: 'aftermath',
      protocolName: 'Aftermath',
      pool: pool.id,
      position: null,
      lpCoinType: pool.lpCoinType,
      balance: balance.toString(),
      totalSupply: pool.lpSupply.toString(),
      share: pool.lpSupply > 0n ? Number((balance * 10n ** 18n) / pool.lpSupply) / 1e18 : 0,
      coins,
      fee: pool.fee,
      stable: pool.stable,
      protocolFee: Number(((multi?.fees.total ?? 0n) * 1_000_000n) / 10n ** 18n),
      daoFee: pool.dao ? pool.dao.feeBps * 100 : null,
    }
    if (priceSource) out.valueUsd = total(coins.map((c) => ({ value: c.valueUsd ?? null, amount: BigInt(c.amount) })))
    return out
  })
  // 已清空的仓位（没有流动性，手续费和奖励也领完）默认不返回；读不到的（null）当作还有
  const pending = (p: SuiLpClmmPosition | SuiLpDlmmPosition) => p.fees0 !== '0' || p.fees1 !== '0' || (p.rewards ?? [{ amount: '1' }]).some((r) => r.amount !== '0')
  const open = [
    ...(options.includeClosed ? clmm : clmm.filter((p) => p.liquidity !== '0' || pending(p))),
    ...(options.includeClosed ? dlmmList : dlmmList.filter((p) => p.amount0 !== '0' || p.amount1 !== '0' || pending(p))),
    ...ammList,
    ...multiList,
  ]
  return priceSource ? open.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1)) : open
}
