/**
 * 价格（子路径 `@w3lib/sui-batch-call/price`）：DefiLlama（当前 / 历史）、链上池子价格（Cetus、Turbos、FlowX CLMM，按流动性选）、
 * 组合多个价格源。价格只用于展示和估值，不要用来计算交易的最小数量
 */
import { SUI_COIN_TYPE, normalizeStructTag } from './address.js'
import { CETUS } from './cetus.js'
import type { SuiClient } from './client.js'
import { SUI_DECIMALS } from './constants.js'
import { json, typeArgs } from './dex/util.js'
import { formatUnits } from './format.js'
import { FLOWX_PKG, TURBOS_PKG, findPools } from './pools.js'
import type { SuiObject } from './services.js'

export interface SuiPriceSourceContext {
  /** 代币类型（规范化、去重，见 priceKeyOf） */
  coinTypes: readonly string[]
  fetch: typeof fetch
  signal?: AbortSignal
  /** 查询用的客户端（链上价格源 onchainPrices 用它读池子） */
  client?: SuiClient
}

export interface SuiPriceSource {
  readonly name: string
  /** 返回代币类型（规范化） → 美元价格；没有价格的不返回 */
  prices(ctx: SuiPriceSourceContext): Promise<Map<string, number>>
}

/** 价格结果里的键：规范化的代币类型（如 '0x2::sui::SUI' → '0x000…002::sui::SUI'）；类型不合法时抛错 */
export const priceKeyOf = (coinType: string): string => normalizeStructTag(coinType)

const keyOrNull = (coinType: string): string | null => {
  try {
    return priceKeyOf(coinType)
  } catch {
    return null
  }
}

export interface DefillamaPriceOptions {
  /** 置信度下限（0~1），DefiLlama 给出的置信度低于它视为没有价格，默认 0.9 */
  minConfidence?: number
  /** 历史价格：这个时间点（unix 秒或 Date）附近的价格；不传为当前价格 */
  at?: number | Date
}

/**
 * DefiLlama 价格（免费、不需要 Key，按 50 个一批查询）。
 * 注意：流动性很差的代币价格可能虚高，展示总资产时建议配合 minUsd 或自己的价格源。
 *
 * ```ts
 * defillamaPrices()                                   // 当前价格
 * defillamaPrices({ at: new Date('2026-01-01') })     // 历史价格
 * ```
 */
export function defillamaPrices(options: DefillamaPriceOptions = {}): SuiPriceSource {
  const minConfidence = options.minConfidence ?? 0.9
  const at = options.at === undefined ? undefined : Math.floor(options.at instanceof Date ? options.at.getTime() / 1000 : options.at)
  const endpoint = at === undefined ? 'https://coins.llama.fi/prices/current' : `https://coins.llama.fi/prices/historical/${at}`
  return {
    name: at === undefined ? 'defillama' : `defillama@${at}`,
    async prices({ coinTypes, fetch: fetchFn, signal }) {
      const result = new Map<string, number>()
      const batches: string[][] = []
      for (let i = 0; i < coinTypes.length; i += 50) batches.push(coinTypes.slice(i, i + 50))
      await Promise.all(
        batches.map(async (batch) => {
          const res = await fetchFn(`${endpoint}/${batch.map((t) => encodeURIComponent(`sui:${t}`)).join(',')}`, { signal })
          if (!res.ok) throw new Error(`DefiLlama prices: HTTP ${res.status}`)
          const body = (await res.json()) as { coins?: Record<string, { price?: number; confidence?: number }> }
          for (const [key, coin] of Object.entries(body.coins ?? {})) {
            if (typeof coin.price !== 'number' || !Number.isFinite(coin.price) || (coin.confidence !== undefined && coin.confidence < minConfidence)) continue
            try {
              result.set(normalizeStructTag(key.slice(key.indexOf(':') + 1)), coin.price)
            } catch {
              // 认不出的键不要
            }
          }
        }),
      )
      return result
    },
  }
}

// ---------------------------------------------------------------------------
// 组合
// ---------------------------------------------------------------------------

/**
 * 依次使用多个价格源：前面的源没给出价格的代币交给下一个源。某个源出错时跳过它（错误交给 onError）。
 *
 * ```ts
 * combinePrices([defillamaPrices(), onchainPrices()])
 * ```
 */
export function combinePrices(sources: readonly SuiPriceSource[], options: { onError?: (source: SuiPriceSource, err: unknown) => void } = {}): SuiPriceSource {
  return {
    name: sources.map((s) => s.name).join('+'),
    async prices(ctx) {
      const found = await runSources(sources, ctx, options.onError)
      return new Map([...found].map(([k, v]) => [k, v.price]))
    },
  }
}

/** 依次查询，记下每个价格来自哪个源 */
async function runSources(sources: readonly SuiPriceSource[], ctx: SuiPriceSourceContext, onError?: (source: SuiPriceSource, err: unknown) => void): Promise<Map<string, { price: number; source: string }>> {
  const result = new Map<string, { price: number; source: string }>()
  let coinTypes = [...ctx.coinTypes]
  for (const source of sources) {
    if (!coinTypes.length) break
    let found: Map<string, number>
    try {
      found = await source.prices({ ...ctx, coinTypes })
    } catch (err) {
      if (ctx.signal?.aborted) throw err
      onError?.(source, err)
      continue
    }
    for (const [key, price] of found) if (!result.has(key) && Number.isFinite(price)) result.set(key, { price, source: source.name })
    coinTypes = coinTypes.filter((t) => !result.has(t))
  }
  return result
}

// ---------------------------------------------------------------------------
// 链上价格
// ---------------------------------------------------------------------------

/** 原生 USDC（Circle） */
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
/** USDT（Sui Bridge） */
const USDT = '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT'

/** 按 1 美元计的稳定币（链上价格的计价锚点之一；另一个是 SUI） */
export const STABLECOINS: readonly string[] = [USDC, USDT]

/** 链上价格用到的 DEX：池子都能按两种币（和手续费档位）在本地算出注册表条目的 ID，不需要索引服务 */
export type OnchainPriceProtocol = 'cetus' | 'turbos' | 'flowx'

export interface OnchainPriceOptions {
  /** 池子里计价币一侧的价值（美元）下限，低于它的池子不用（防止小池子的价格被操纵），默认 10000 */
  minLiquidityUsd?: number
  /** 按 1 美元计的稳定币，默认 STABLECOINS（USDC、USDT） */
  stablecoins?: readonly string[]
  /** 用哪些 DEX 的池子，默认全部（'cetus'、'turbos'、'flowx'） */
  protocols?: readonly OnchainPriceProtocol[]
  /**
   * 一次最多给多少个代币找池子，默认 50：每个代币要按 SUI、每个稳定币、每个手续费档位查约 100 个注册表条目，
   * 持有大量垃圾币的地址会发出很多请求。超出的代币（按传入顺序）没有价格
   */
  maxCoins?: number
}

/** 池子的两种币、sqrt 价格（Q64.64，coinB / coinA）、两边的储备 */
interface PoolState {
  coinA: string
  coinB: string
  sqrtPrice: bigint
  reserveA: bigint
  reserveB: bigint
}

const big = (v: unknown) => {
  try {
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' ? BigInt(v) : null
  } catch {
    return null
  }
}

/** 池子对象 → PoolState：类型以 prefix 开头，fields 给出 [储备 A, 储备 B, sqrt 价格, 可以交易] */
function poolOf(o: SuiObject, prefix: string, fields: (j: Record<string, any>) => [unknown, unknown, unknown, boolean]): PoolState | null {
  if (!o.type?.startsWith(prefix)) return null
  let args: string[] | null
  try {
    args = typeArgs(o.type)
  } catch {
    return null
  }
  const [ra, rb, sqrt, open] = fields(json(o))
  const reserveA = big(ra)
  const reserveB = big(rb)
  const sqrtPrice = big(sqrt)
  if (!args || args.length < 2 || reserveA === null || reserveB === null || sqrtPrice === null || !open) return null
  return { coinA: args[0] as string, coinB: args[1] as string, sqrtPrice, reserveA, reserveB }
}

/** 池子（按两种币在注册表里找，见 pools.ts）的状态 */
const POOL_STATES: Readonly<Record<OnchainPriceProtocol, (o: SuiObject) => PoolState | null>> = {
  cetus: (o) => poolOf(o, `${CETUS.clmm}::pool::Pool<`, (j) => [j.coin_a, j.coin_b, j.current_sqrt_price, !j.is_pause]),
  turbos: (o) => poolOf(o, `${TURBOS_PKG}::pool::Pool<`, (j) => [j.coin_a, j.coin_b, j.sqrt_price, j.unlocked !== false]),
  flowx: (o) => poolOf(o, `${FLOWX_PKG}::pool::Pool<`, (j) => [j.reserve_x, j.reserve_y, j.sqrt_price, !j.locked]),
}

/**
 * 链上价格：在 Cetus、Turbos、FlowX CLMM 里找代币对 SUI、稳定币的池子，用计价币一侧最深的池子的价格。
 * 稳定币按 1 美元；SUI 按它对稳定币最深的池子。池子按两种币在注册表里的条目找（条目的对象 ID 本地算出，不需要索引服务），
 * 读取用 BatchGetObjects 合并：配置（有缓存）、条目、池子和代币精度各一轮。
 * 适合 DefiLlama 没有收录的新币；价格是池子当前的价格，可能被单笔交易影响，只用于展示
 */
export function onchainPrices(options: OnchainPriceOptions = {}): SuiPriceSource {
  return {
    name: 'onchain',
    async prices({ coinTypes, client, signal }) {
      if (!client) throw new Error('onchainPrices needs a SuiClient (ctx.client)')
      const minLiquidity = options.minLiquidityUsd ?? 10_000
      const stables = [...new Set((options.stablecoins ?? STABLECOINS).map(priceKeyOf))]
      const protocols = (options.protocols ?? (Object.keys(POOL_STATES) as OnchainPriceProtocol[])).filter((p) => p in POOL_STATES)
      const result = new Map<string, number>()
      const tokens = [...new Set(coinTypes.flatMap((t) => keyOrNull(t) ?? []))]
      for (const t of tokens) if (stables.includes(t)) result.set(t, 1)
      const wantSui = tokens.includes(SUI_COIN_TYPE) && !result.has(SUI_COIN_TYPE)
      const rest = tokens.filter((t) => !result.has(t) && t !== SUI_COIN_TYPE).slice(0, Math.max(0, options.maxCoins ?? 50))
      if ((!rest.length && !wantSui) || !stables.length || !protocols.length) return result

      // 1. 要找的池子：SUI 对稳定币（SUI 是其他代币的计价币），其他代币对 SUI 和稳定币
      const pairs: Array<[string, string]> = stables.filter((s) => s !== SUI_COIN_TYPE).map((s) => [SUI_COIN_TYPE, s])
      for (const t of rest) for (const anchor of [SUI_COIN_TYPE, ...stables]) pairs.push([t, anchor])
      const found = await findPools(client, pairs, protocols, signal)
      const pools = found.flatMap((list, pair) => list.map((p) => ({ ...p, pair, state: POOL_STATES[p.protocol as OnchainPriceProtocol] })))
      if (!pools.length) return result

      // 2. 读池子和精度
      const [objects, coins] = await Promise.all([
        client.objects(
          pools.map((p) => p.id),
          { fields: ['type', 'json'], signal },
        ),
        client.coins([...new Set(pairs.flat())].filter((t) => t !== SUI_COIN_TYPE), { signal }),
      ])
      const decimals = new Map<string, number | null>([[SUI_COIN_TYPE, SUI_DECIMALS], ...coins.map((c) => [c.token, c.decimals] as const)])
      const quotes = pools.flatMap((p, i) => {
        const o = objects[i]
        const state = o ? p.state(o) : null
        const [token, anchor] = pairs[p.pair] as [string, string]
        const dt = decimals.get(token)
        const da = decimals.get(anchor)
        if (!state || dt === null || dt === undefined || da === null || da === undefined) return []
        const q = quote(state, token, anchor, dt, da)
        return q ? [{ token, anchor, ...q }] : []
      })

      // 3. 先算 SUI，再算其他代币（深度按计价币的美元价值）
      const anchorsUsd = new Map(stables.map((s) => [s, 1]))
      const best = (token: string) => {
        let found: { usd: number; depthUsd: number } | null = null
        for (const q of quotes) {
          const anchorUsd = q.token === token ? anchorsUsd.get(q.anchor) : undefined
          if (anchorUsd === undefined) continue
          const depthUsd = q.depth * anchorUsd
          if (depthUsd >= minLiquidity && (!found || depthUsd > found.depthUsd)) found = { usd: q.price * anchorUsd, depthUsd }
        }
        return found?.usd ?? null
      }
      const sui = anchorsUsd.get(SUI_COIN_TYPE) ?? best(SUI_COIN_TYPE)
      if (sui !== null) {
        anchorsUsd.set(SUI_COIN_TYPE, sui)
        if (wantSui) result.set(SUI_COIN_TYPE, sui)
      }
      for (const t of rest) {
        const usd = best(t)
        if (usd !== null) result.set(t, usd)
      }
      return result
    },
  }
}

/** 池子里 1 个代币值多少个计价币、计价币一侧的数量（按精度换算）；池子的两种币对不上时为 null */
function quote(pool: PoolState, token: string, anchor: string, dt: number, da: number): { price: number; depth: number } | null {
  const tokenIsA = pool.coinA === token && pool.coinB === anchor
  if (!tokenIsA && !(pool.coinA === anchor && pool.coinB === token)) return null
  if (pool.sqrtPrice === 0n || (tokenIsA ? pool.reserveB : pool.reserveA) === 0n) return null
  const sqrt = Number(pool.sqrtPrice) / 2 ** 64
  // coinB / coinA（按精度换算）
  const bPerA = sqrt * sqrt * 10 ** (tokenIsA ? dt - da : da - dt)
  const price = tokenIsA ? bPerA : 1 / bPerA
  if (!Number.isFinite(price) || price <= 0) return null
  return { price, depth: Number(formatUnits(tokenIsA ? pool.reserveB : pool.reserveA, da)) }
}

// ---------------------------------------------------------------------------
// tokenPrices
// ---------------------------------------------------------------------------

export interface TokenPricesOptions {
  /** 价格源，依次使用（前面没有价格的交给后面的），默认 [defillamaPrices(), onchainPrices()] */
  sources?: readonly SuiPriceSource[]
  /** 某个价格源出错时调用（继续用下一个源） */
  onError?: (source: SuiPriceSource, err: unknown) => void
  /** 查价用的 fetch（代理等场景）；默认全局 fetch */
  fetch?: typeof fetch
  signal?: AbortSignal
}

export interface TokenPrice {
  /** 传入的代币类型（原样） */
  token: string
  /** 是否是 SUI */
  native: boolean
  /** 美元价格；所有价格源都没有（或类型不合法）时为 null */
  price: number | null
  /** 给出价格的价格源（如 'defillama'、'onchain'） */
  source: string | null
}

/**
 * 查代币的美元价格（SUI 用 SUI_COIN_TYPE 或 '0x2::sui::SUI'）。默认先查 DefiLlama，没有收录的再从链上池子算。
 *
 * ```ts
 * await tokenPrices(sui, [SUI_COIN_TYPE, USDC, newCoin])
 * // [{ token: '0x…::sui::SUI', native: true, price: 3.21, source: 'defillama' }, …, { token: newCoin, price: 0.0012, source: 'onchain' }]
 * await tokenPrices(sui, coinTypes, { sources: [defillamaPrices({ at: new Date('2026-01-01') })] })   // 历史价格
 * ```
 */
export async function tokenPrices(client: SuiClient, coinTypes: readonly string[], options: TokenPricesOptions = {}): Promise<TokenPrice[]> {
  const { sources = [defillamaPrices(), onchainPrices()], onError, fetch: fetchOption, signal } = options
  const fetchFn = fetchOption ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const keys = coinTypes.map(keyOrNull)
  const unique = [...new Set(keys.filter((k): k is string => k !== null))]
  const found = unique.length ? await runSources(sources, { coinTypes: unique, fetch: fetchFn, signal, client }, onError) : new Map<string, { price: number; source: string }>()
  return coinTypes.map((token, i) => {
    const key = keys[i]
    const hit = key ? found.get(key) : undefined
    return { token, native: key === SUI_COIN_TYPE, price: hit?.price ?? null, source: hit?.source ?? null }
  })
}
