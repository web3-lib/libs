/**
 * 价格（子路径 `@w3lib/ton-batch-call/price`）：DefiLlama（当前 / 历史）、链上池子价格（STON.fi v1 / v2、DeDust，按流动性选）、
 * 组合多个价格源。价格只用于展示和估值，不要用来计算交易的最小数量
 */
import { isValidTonAddress, toFriendlyAddress, toRawAddress } from './address.js'
import type { TonClient } from './client.js'
import { NATIVE_TON, TON_DECIMALS } from './constants.js'
import { formatUnits } from './format.js'
import { runGetMethod } from './getters.js'
import type { RequestOptions } from './http.js'
import { PTON_V1_MASTER, PTON_V2_MASTER, STONFI_V1_ROUTER, dedustAsset, type TonLpProtocol } from './lp.js'
import { INFINITE, cached, dedustPoolAddress, orNull, resetPoolCache, routerType, routerWallets, stonfiMaster, stonfiPoolAddress, stonfiRouters, type PoolEnv, type RouterWallet } from './pools.js'

export interface TonPriceSourceContext {
  /** 代币：NATIVE_TON 或 Jetton 主合约地址（tokenPrices、lpPositions 传的是原始格式 0:…） */
  tokens: readonly string[]
  fetch: typeof fetch
  signal?: AbortSignal
  /** 查询用的客户端（链上价格源 onchainPrices 用它读池子） */
  client?: TonClient
}

export interface TonPriceSource {
  readonly name: string
  /** 返回 priceKeyOf(代币) → 美元价格：TON 为 NATIVE_TON，Jetton 为主合约的原始地址（小写 0:…）。没有价格的不返回 */
  prices(ctx: TonPriceSourceContext): Promise<Map<string, number>>
}

/** 价格结果里的键：TON 为 NATIVE_TON，Jetton 为主合约的原始地址（小写 0:…，任意格式的输入都转成它） */
export function priceKeyOf(token: string): string {
  return token === NATIVE_TON ? NATIVE_TON : toRawAddress(token)
}

const validToken = (t: string) => t === NATIVE_TON || isValidTonAddress(t)

// ---------------------------------------------------------------------------
// DefiLlama
// ---------------------------------------------------------------------------

export interface DefillamaPriceOptions {
  /** 置信度下限（0~1），DefiLlama 给出的置信度低于它视为没有价格，默认 0.9 */
  minConfidence?: number
  /** 历史价格：这个时间点（unix 秒或 Date）附近的价格；不传为当前价格 */
  at?: number | Date
}

/**
 * DefiLlama 价格（免费、不需要 Key）。TON 按 CoinGecko 的 the-open-network，Jetton 按 `ton:` + 可回弹的用户友好地址（EQ…）。
 * 注意：流动性很差的代币价格可能虚高，展示总资产时建议配合 minUsd 或自己的价格源。
 *
 * ```ts
 * defillamaPrices()                                   // 当前价格
 * defillamaPrices({ at: new Date('2026-01-01') })     // 历史价格
 * ```
 */
export function defillamaPrices(options: DefillamaPriceOptions = {}): TonPriceSource {
  const minConfidence = options.minConfidence ?? 0.9
  const at = options.at instanceof Date ? Math.floor(options.at.getTime() / 1000) : options.at === undefined ? undefined : Math.floor(options.at)
  const endpoint = at === undefined ? 'https://coins.llama.fi/prices/current' : `https://coins.llama.fi/prices/historical/${at}`
  return {
    name: at === undefined ? 'defillama' : `defillama@${at}`,
    async prices({ tokens, fetch: fetchFn, signal }) {
      const result = new Map<string, number>()
      // DefiLlama 的键 → 结果的键
      const back = new Map<string, string>()
      for (const t of tokens) {
        if (!validToken(t)) continue
        const key = priceKeyOf(t)
        back.set(key === NATIVE_TON ? 'coingecko:the-open-network' : `ton:${toFriendlyAddress(key)}`, key)
      }
      const keys = [...back.keys()]
      const batches: string[][] = []
      for (let i = 0; i < keys.length; i += 50) batches.push(keys.slice(i, i + 50))
      const responses = await Promise.all(
        batches.map(async (batch) => {
          const res = await fetchFn(`${endpoint}/${batch.map(encodeURIComponent).join(',')}`, { signal })
          if (!res.ok) throw new Error(`DefiLlama prices: HTTP ${res.status}`)
          return (await res.json()) as { coins?: Record<string, { price?: number; confidence?: number }> }
        }),
      )
      for (const body of responses) {
        for (const [key, coin] of Object.entries(body.coins ?? {})) {
          const token = back.get(key)
          if (token && typeof coin.price === 'number' && Number.isFinite(coin.price) && (coin.confidence === undefined || coin.confidence >= minConfidence)) result.set(token, coin.price)
        }
      }
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
export function combinePrices(sources: readonly TonPriceSource[], options: { onError?: (source: TonPriceSource, err: unknown) => void } = {}): TonPriceSource {
  return {
    name: sources.map((s) => s.name).join('+'),
    async prices(ctx) {
      const found = await runSources(sources, ctx, options.onError)
      return new Map([...found].map(([k, v]) => [k, v.price]))
    },
  }
}

/** 依次查询，记下每个价格来自哪个源 */
async function runSources(sources: readonly TonPriceSource[], ctx: TonPriceSourceContext, onError?: (source: TonPriceSource, err: unknown) => void): Promise<Map<string, { price: number; source: string }>> {
  const result = new Map<string, { price: number; source: string }>()
  let tokens = [...new Set(ctx.tokens.filter(validToken).map(priceKeyOf))]
  for (const source of sources) {
    if (!tokens.length) break
    let found: Map<string, number>
    try {
      found = await source.prices({ ...ctx, tokens })
    } catch (err) {
      if (ctx.signal?.aborted) throw err
      try {
        onError?.(source, err)
      } catch {
        // 回调出错不影响结果
      }
      continue
    }
    for (const [key, price] of found) if (!result.has(key) && Number.isFinite(price)) result.set(key, { price, source: source.name })
    tokens = tokens.filter((t) => !result.has(t))
  }
  return result
}

// ---------------------------------------------------------------------------
// 链上价格
// ---------------------------------------------------------------------------

/** USD₮（Tether 在 TON 上发行的） */
export const TON_USDT = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe'

/** 按 1 美元计的稳定币（链上价格的计价锚点之一；另一个是 TON） */
export const STABLECOINS: readonly string[] = [TON_USDT]

export interface OnchainPriceOptions {
  /** 池子里计价币一侧的价值（美元）下限，低于它的池子不用（防止小池子的价格被操纵），默认 10000 */
  minLiquidityUsd?: number
  /** 按 1 美元计的稳定币，默认 STABLECOINS（USD₮） */
  stablecoins?: readonly string[]
  /** 用哪些协议的池子，默认全部：先找 STON.fi（v1 / v2），没有合格池子的代币再找 DeDust */
  protocols?: readonly TonLpProtocol[]
  /** 额外认可的 STON.fi v2 router（与 lpPositions 的同名选项相同） */
  stonfiRouters?: readonly string[]
}

/** 测试用：清空链上价格的缓存（池子地址等，与 `/swap` 共用） */
export function resetPriceCache(): void {
  resetPoolCache()
}

/** 池子候选：代币 × 计价币 */
interface Candidate {
  token: string
  anchor: string
  pool: string
  protocol: TonLpProtocol
  /** STON.fi：代币在 router 的 Jetton 钱包（按它判断池子里的顺序）；DeDust 不用 */
  tokenWallet?: string
}

interface Env extends PoolEnv {
  protocols: ReadonlySet<TonLpProtocol>
  minLiquidityUsd: number
  decimals: ReadonlyMap<string, number>
}

/**
 * 链上价格：在 STON.fi（v1 / v2）、DeDust 的池子里找代币对 TON、稳定币（USD₮）的池子，用计价币一侧最深的池子的价格。
 * 稳定币按 1 美元；TON 按它对稳定币最深的池子。池子地址用 router / factory 的 get_pool_address 算出（不信任索引器给的池子）。
 *
 * - STON.fi：router 的 Jetton 钱包（索引器，每个代币一次请求）里这个代币余额最多的 constant_product router，
 *   看它的 代币/TON（pTON）、代币/USD₮ 两个池子
 * - DeDust：STON.fi 没有合格池子的代币，看 volatile 池子 代币/TON（TON 自己看 TON/USD₮）
 * - 池子是否部署用一次 accountStates 合并查询，只读部署了的池子的储备
 *
 * toncenter 没有 API Key 时每秒 1 次请求：每个代币第一次约 2~6 次请求（池子地址等有进程内缓存，之后约 1~3 次）。
 * 只支持主网（内置的 router、factory、稳定币是主网的）。价格是池子当前的价格，可能被单笔交易影响，只用于展示
 */
export function onchainPrices(options: OnchainPriceOptions = {}): TonPriceSource {
  return {
    name: 'onchain',
    async prices({ tokens, client, signal }) {
      if (!client) throw new Error('onchainPrices needs a TonClient (ctx.client)')
      const result = new Map<string, number>()
      if (client.network !== 'mainnet') return result
      const stables = [...new Set((options.stablecoins ?? STABLECOINS).map(priceKeyOf))]
      const keys = [...new Set(tokens.filter(validToken).map(priceKeyOf))]
      for (const k of keys) if (stables.includes(k)) result.set(k, 1)
      const rest = keys.filter((k) => !result.has(k))
      if (!rest.length || !stables.length) return result

      // 精度：代币和稳定币一次查（精度未知的不定价）
      const jettons = [...new Set([...rest, ...stables].filter((k) => k !== NATIVE_TON))]
      const details = await client.jettons(jettons, { signal })
      const decimals = new Map<string, number>([[NATIVE_TON, TON_DECIMALS]])
      for (const d of details) if (d.success && !d.decimalsUnknown) decimals.set(toRawAddress(d.address), d.decimals)
      const env: Env = {
        client,
        signal,
        protocols: new Set(options.protocols ?? (['stonfi-v1', 'stonfi-v2', 'dedust'] as const)),
        ...stonfiRouters(options.stonfiRouters),
        minLiquidityUsd: options.minLiquidityUsd ?? 10_000,
        decimals,
      }

      // TON 先对稳定币定价，Jetton 再对 TON 和稳定币定价
      const others = rest.filter((k) => k !== NATIVE_TON && decimals.has(k))
      if (!others.length && !rest.includes(NATIVE_TON)) return result
      const anchorsUsd = new Map(stables.map((s) => [s, 1]))
      const [tonUsd] = await bestQuotes(env, [NATIVE_TON], anchorsUsd)
      if (tonUsd !== null && tonUsd !== undefined) {
        anchorsUsd.set(NATIVE_TON, tonUsd)
        if (rest.includes(NATIVE_TON)) result.set(NATIVE_TON, tonUsd)
      }
      if (!others.length) return result
      const quotes = await bestQuotes(env, others, anchorsUsd)
      others.forEach((k, i) => {
        const q = quotes[i]
        if (q !== null && q !== undefined) result.set(k, q)
      })
      return result
    },
  }
}

/** 每个代币在 anchors 上最深的池子给出的美元价格（没有合格的池子时为 null）：先 STON.fi，没有的再 DeDust */
async function bestQuotes(env: Env, tokens: readonly string[], anchorsUsd: ReadonlyMap<string, number>): Promise<Array<number | null>> {
  const best: Array<{ usd: number; depthUsd: number } | null> = tokens.map(() => null)
  const stonfi = env.protocols.has('stonfi-v1') || env.protocols.has('stonfi-v2')
  for (const step of [stonfi ? stonfiCandidates : null, env.protocols.has('dedust') ? dedustCandidates : null]) {
    if (!step) continue
    const todo = tokens.filter((_, i) => !best[i])
    if (!todo.length) break
    const candidates = await step(env, todo, [...anchorsUsd.keys()])
    if (!candidates.length) continue
    // 没部署的池子不读（一次 accountStates 合并查询）
    const states = await env.client.tonBalances(
      candidates.map((c) => c.pool),
      { signal: env.signal },
    )
    const live = candidates.filter((_, i) => states[i]?.status === 'active')
    const reserves = await Promise.all(live.map((c) => orNull(env, readReserves(env, c))))
    live.forEach((c, i) => {
      const r = reserves[i]
      const anchorUsd = anchorsUsd.get(c.anchor)
      const dt = env.decimals.get(c.token)
      const da = env.decimals.get(c.anchor)
      if (!r || anchorUsd === undefined || dt === undefined || da === undefined) return
      const [rt, ra] = r
      if (rt <= 0n || ra <= 0n) return
      const anchor = Number(formatUnits(ra, da))
      const price = (anchor / Number(formatUnits(rt, dt))) * anchorUsd
      const depthUsd = anchor * anchorUsd
      const index = tokens.indexOf(c.token)
      const current = best[index]
      if (Number.isFinite(price) && price > 0 && depthUsd >= env.minLiquidityUsd && (!current || depthUsd > current.depthUsd)) best[index] = { usd: price, depthUsd }
    })
  }
  return best.map((b) => (b ? b.usd : null))
}

/** STON.fi 的候选池子：每个代币选余额最多的 constant_product router（最多看 3 个），对每个计价币算池子地址 */
async function stonfiCandidates(env: Env, tokens: readonly string[], anchors: readonly string[]): Promise<Candidate[]> {
  const allowed = (router: string) => env.protocols.has(router === STONFI_V1_ROUTER ? 'stonfi-v1' : 'stonfi-v2')
  // TON 在 STON.fi 是 pTON：v1 的 router 用 pTON v1，v2 用 pTON v2.1
  const mastersOf = (t: string) => (t === NATIVE_TON ? [PTON_V1_MASTER, PTON_V2_MASTER] : [t])
  const masters = [...new Set([...tokens, ...anchors].flatMap(mastersOf))]
  const lists = await Promise.all(masters.map((m) => routerWallets(env, m)))
  const walletsOf = new Map(masters.map((m, i) => [m, lists[i] as RouterWallet[]]))
  const walletOn = (t: string, router: string) => walletsOf.get(stonfiMaster(t, router))?.find((w) => w.router === router)?.wallet
  const picks = await Promise.all(
    tokens.map(async (token) => {
      const ranked = mastersOf(token)
        .flatMap((m) => walletsOf.get(m) ?? [])
        .filter((w) => w.balance > 0n && allowed(w.router) && walletOn(token, w.router) === w.wallet)
        .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))
      for (const w of ranked.slice(0, 3)) {
        if ((await routerType(env, w.router)) === 'constant_product') return w
      }
      return null
    }),
  )
  const lookups: Array<Omit<Candidate, 'pool'> & { router: string; anchorWallet: string }> = []
  tokens.forEach((token, i) => {
    const pick = picks[i]
    if (!pick) return
    for (const anchor of anchors) {
      const anchorWallet = anchor === token ? undefined : walletOn(anchor, pick.router)
      if (anchorWallet) lookups.push({ token, anchor, protocol: pick.router === STONFI_V1_ROUTER ? 'stonfi-v1' : 'stonfi-v2', tokenWallet: pick.wallet, router: pick.router, anchorWallet })
    }
  })
  const pools = await Promise.all(lookups.map((l) => stonfiPoolAddress(env, l.router, l.tokenWallet as string, l.anchorWallet)))
  return lookups.flatMap((l, i) => {
    const pool = pools[i]
    return pool ? [{ token: l.token, anchor: l.anchor, pool, protocol: l.protocol, tokenWallet: l.tokenWallet }] : []
  })
}

/**
 * DeDust 的候选池子：volatile 池子 代币/TON（TON 自己或 TON 没有价格时对稳定币）。
 * DeDust 的 Jetton 池子基本都对 TON，不再看 代币/USD₮：没有价格的杂币多时（持仓里的空投）每个少一次请求
 */
async function dedustCandidates(env: Env, tokens: readonly string[], anchors: readonly string[]): Promise<Candidate[]> {
  const pairs = tokens.flatMap((token) => (token !== NATIVE_TON && anchors.includes(NATIVE_TON) ? [NATIVE_TON] : anchors.filter((a) => a !== token)).map((anchor) => ({ token, anchor })))
  const pools = await Promise.all(pairs.map(({ token, anchor }) => dedustPoolAddress(env, token, anchor)))
  return pairs.flatMap((p, i) => {
    const pool = pools[i]
    return pool ? [{ ...p, pool, protocol: 'dedust' as const }] : []
  })
}

/** 池子的储备：[代币一侧, 计价币一侧]；池子的两个代币对不上时为 null */
async function readReserves(env: Env, c: Candidate): Promise<[bigint, bigint] | null> {
  const t = env.client.transport
  const opts = { signal: env.signal }
  if (c.protocol === 'dedust') {
    const assets = await cached(`assets:${c.pool}`, INFINITE, async () => {
      const s = await runGetMethod(t, c.pool, 'get_assets', [], opts)
      return [dedustAsset(s.cell()), dedustAsset(s.cell())]
    })
    const s = await runGetMethod(t, c.pool, 'get_reserves', [], opts)
    const [r0, r1] = [s.num(), s.num()]
    if (assets[0] === c.token && assets[1] === c.anchor) return [r0, r1]
    if (assets[1] === c.token && assets[0] === c.anchor) return [r1, r0]
    return null
  }
  const s = await runGetMethod(t, c.pool, 'get_pool_data', [], opts)
  // v1：reserve0, reserve1, token0_wallet, token1_wallet …；v2：is_locked, router, total_supply, reserve0, reserve1, token0_wallet, token1_wallet …
  if (c.protocol === 'stonfi-v2') s.skip(3)
  const [r0, r1] = [s.num(), s.num()]
  const [w0, w1] = [s.address(), s.address()]
  if (w0 === c.tokenWallet) return [r0, r1]
  if (w1 === c.tokenWallet) return [r1, r0]
  return null
}

// ---------------------------------------------------------------------------
// tokenPrices
// ---------------------------------------------------------------------------

export interface TokenPricesOptions extends RequestOptions {
  /** 价格源，依次使用（前面没有价格的交给后面的），默认 [defillamaPrices(), onchainPrices()] */
  sources?: readonly TonPriceSource[]
  /** 某个价格源出错时调用（继续用下一个源） */
  onError?: (source: TonPriceSource, err: unknown) => void
  /** 请求 DefiLlama 等用的 fetch（代理等场景）；默认全局 fetch */
  fetch?: typeof fetch
}

export interface TonTokenPrice {
  /** 传入的代币（原样） */
  token: string
  native: boolean
  /** 美元价格；所有价格源都没有（或地址非法）时为 null */
  price: number | null
  /** 给出价格的价格源（如 'defillama'、'onchain'） */
  source: string | null
}

/**
 * 查代币的美元价格（TON 用 NATIVE_TON，Jetton 用主合约地址，任意格式）。默认先查 DefiLlama，没有收录的再从链上池子算。
 *
 * ```ts
 * await tokenPrices(ton, [NATIVE_TON, USDT, newJetton])
 * // [{ token: 'TON', native: true, price: 1.34, source: 'defillama' }, …, { token: newJetton, native: false, price: 0.0012, source: 'onchain' }]
 * await tokenPrices(ton, tokens, { sources: [defillamaPrices({ at: new Date('2026-01-01') })] })   // 历史价格
 * ```
 */
export async function tokenPrices(client: TonClient, tokens: readonly string[], options: TokenPricesOptions = {}): Promise<TonTokenPrice[]> {
  const { sources = [defillamaPrices(), onchainPrices()], onError, fetch: fetchOption, signal } = options
  const fetchFn = fetchOption ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const found = await runSources(sources, { tokens, fetch: fetchFn, signal, client }, onError)
  return tokens.map((token) => {
    const hit = validToken(token) ? found.get(priceKeyOf(token)) : undefined
    return { token, native: token === NATIVE_TON, price: hit?.price ?? null, source: hit?.source ?? null }
  })
}
