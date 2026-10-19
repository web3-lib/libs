/**
 * LP 仓位（子路径 `@w3lib/sui-batch-call/lp`）：Sui 上集中流动性 DEX 的仓位对象。
 * 未领取的手续费和挖矿奖励由合约自己算：一次只读调用（不检查交易的模拟）里对每个仓位执行领取，读返回的数量，
 * 与真正领取时的结果相同；撤出能拿到的数量按 tick 和流动性计算（Cetus 用合约的 get_position_amounts_v2）
 */
import { normalizeStructTag, normalizeSuiAddress } from './address.js'
import { amountsForLiquidity, sqrtPriceAtTick } from './clmmMath.js'
import type { RequestOptions, SuiClient } from './client.js'
import { resolvePackages } from './dex/env.js'
import { READERS, readerList } from './dex/index.js'
import { inspect } from './dex/inspect.js'
import type { DexEnv, DexPool, DexPosition, DexReader, ReadOut, SuiLpProtocol } from './dex/types.js'
import { formatUnits } from './format.js'
import type { SuiObject } from './services.js'

export type { SuiLpProtocol } from './dex/types.js'

/** 支持的协议和它们的仓位对象类型 */
export const SUI_LP_PROTOCOLS = Object.fromEntries(Object.values(READERS).map((a) => [a.protocol, { name: a.name, positionType: a.positionType }])) as Readonly<
  Record<SuiLpProtocol, { name: string; positionType: string }>
>

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

export interface SuiLpPosition {
  type: 'clmm'
  protocol: SuiLpProtocol
  protocolName: string
  pool: string
  /** 仓位对象 ID */
  position: string
  token0: SuiLpToken
  token1: SuiLpToken
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
  /** 价格都是 token1 / token0（按精度换算，只用于展示）；读不到精度时为 null */
  price: number | null
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
  /** 开启 prices 时：两种代币的美元价值、手续费的美元价值、奖励的美元价值（缺价格时为 null） */
  valueUsd?: number | null
  feesUsd?: number | null
  rewardsUsd?: number | null
}

export interface LpPositionsOptions extends RequestOptions {
  /** 只查这些协议，默认全部 */
  protocols?: readonly SuiLpProtocol[]
  /** 只查这些仓位对象（不扫描地址拥有的对象） */
  positions?: readonly string[]
  /** 返回已清空的仓位（流动性为 0、手续费和奖励也领完，仓位对象还在）。默认 false */
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
async function inspectEach<R>(
  client: SuiClient,
  packages: Map<string, string>,
  items: readonly Item[],
  build: (env: DexEnv, item: Item) => (outputs: unknown[][]) => R,
  onFail: (batch: readonly Item[], err: unknown) => void,
  signal?: AbortSignal,
): Promise<Array<R | null>> {
  /** undefined：节点出错；null：执行失败 */
  const run = async (batch: readonly Item[]): Promise<R[] | null | undefined> => {
    const res = await inspect(
      client,
      (batch[0] as Item).sender,
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
      const all = await run(idx.map((k) => items[k] as Item))
      if (all) idx.forEach((k, j) => (out[k] = all[j] ?? null))
      else if (all === null) await mapLimit(idx, 8, async (k) => (out[k] = (await run([items[k] as Item]))?.[0] ?? null))
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
  if (!adapters.length) return []
  const broken = new Set<DexReader>()
  const report = (adapter: DexReader, err: unknown) => {
    try {
      options.onError?.(adapter.protocol, err)
    } catch {
      // 回调出错不影响结果
    }
  }
  const failed = (adapter: DexReader, err: unknown) => {
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
  // 仓位对象：指定了 ID 时按类型认出协议，否则按各协议的类型扫描
  const found: Array<{ adapter: DexReader; object: SuiObject }> = []
  if (options.positions) {
    // 重复的 ID 只读一次（Momentum 等领取后再读会显示为 0）
    const ids = [...new Set(options.positions.map(normalizeSuiAddress))]
    for (const o of await client.objects(ids, { fields: ['type', 'owner', 'json'], signal })) {
      const adapter = o && adapters.find((a) => a.positionType === o.type)
      if (o && adapter) found.push({ adapter, object: o })
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
  if (!positions.length) return []
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

  const coinTypes = [...new Set(items.flatMap(({ pool }) => [pool.coinA, pool.coinB, ...pool.rewardCoins]))]
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

  const list = items.map(({ adapter, pos, pool }, i): SuiLpPosition => {
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
    const rewards = c.rewards?.map((amount, k): SuiLpReward => {
      const t = token(pool.rewardCoins[k] ?? '')
      const formatted = fmt(amount, t)
      return { ...t, amount: amount.toString(), formatted, ...(priceSource ? { valueUsd: amount === 0n ? 0 : usd(t, formatted) } : {}) }
    }) ?? null
    const out: SuiLpPosition = {
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
    if (priceSource) {
      out.valueUsd = total([
        { value: usd(token0, out.amount0Formatted), amount: a0 },
        { value: usd(token1, out.amount1Formatted), amount: a1 },
      ])
      out.feesUsd = total([
        { value: usd(token0, out.fees0Formatted), amount: f0 },
        { value: usd(token1, out.fees1Formatted), amount: f1 },
      ])
      out.rewardsUsd = rewards === null ? null : total(rewards.map((r) => ({ value: r.valueUsd ?? null, amount: BigInt(r.amount) })))
    }
    return out
  })
  const open = options.includeClosed
    ? list
    : list.filter((p) => p.liquidity !== '0' || p.fees0 !== '0' || p.fees1 !== '0' || (p.rewards ?? [{ amount: '1' }]).some((r) => r.amount !== '0'))
  return priceSource ? open.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1)) : open
}
