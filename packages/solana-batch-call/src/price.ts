/**
 * 价格（子路径 `@w3lib/solana-batch-call/price`）：DefiLlama（当前 / 历史）、链上池子价格（Raydium CLMM / CPMM、Orca Whirlpool，按 PDA 推导池子地址，
 * 不需要 getProgramAccounts）、组合多个价格源。价格只用于展示和估值，不要用来计算交易的最小数量
 */
import { isAddress } from './address.js'
import type { RequestOptions, SolanaClient } from './client.js'
import { NATIVE_MINT } from './constants.js'
import { formatUnits, parseMint, parseTokenAccount, type AccountInfo } from './layout.js'
import { Bytes, ORCA_WHIRLPOOL_PROGRAM_ID, RAYDIUM_CLMM_PROGRAM_ID, parseAmmPool } from './lp.js'
import { sqrtPriceToPrice } from './lpMath.js'
import { poolAddresses, type PdaPoolProtocol } from './pools.js'

export interface SolanaPriceSourceContext {
  /** 代币 mint（原生 SOL 用 NATIVE_MINT So111…112 查） */
  mints: readonly string[]
  fetch: typeof fetch
  signal?: AbortSignal
  /** 查询用的客户端（链上价格源 onchainPrices 用它读池子） */
  client?: SolanaClient
}

export interface SolanaPriceSource {
  readonly name: string
  /** 返回 mint → 美元价格；没有价格的不返回 */
  prices(ctx: SolanaPriceSourceContext): Promise<Map<string, number>>
}

export interface DefillamaPriceOptions {
  /** 置信度下限（0~1），DefiLlama 给出的置信度低于它视为没有价格，默认 0.9 */
  minConfidence?: number
  /** 历史价格：这个时间点（unix 秒或 Date）附近的价格；不传为当前价格 */
  at?: number | Date
}

/**
 * DefiLlama 价格（免费、不需要 Key，按 100 个一批查询）。
 * 注意：流动性很差的代币价格可能虚高，展示总资产时建议配合 minUsd 或自己的价格源。
 *
 * ```ts
 * defillamaPrices()                                   // 当前价格
 * defillamaPrices({ at: new Date('2026-01-01') })     // 历史价格
 * ```
 */
export function defillamaPrices(options: DefillamaPriceOptions = {}): SolanaPriceSource {
  const minConfidence = options.minConfidence ?? 0.9
  const at = options.at instanceof Date ? Math.floor(options.at.getTime() / 1000) : options.at === undefined ? undefined : Math.floor(options.at)
  const endpoint = at === undefined ? 'https://coins.llama.fi/prices/current' : `https://coins.llama.fi/prices/historical/${at}`
  return {
    name: at === undefined ? 'defillama' : `defillama@${at}`,
    async prices({ mints, fetch: fetchFn, signal }) {
      const result = new Map<string, number>()
      const batches: string[][] = []
      for (let i = 0; i < mints.length; i += 100) {
        batches.push(mints.slice(i, i + 100))
      }
      await Promise.all(
        batches.map(async (batch) => {
          const res = await fetchFn(`${endpoint}/${batch.map((m) => `solana:${m}`).join(',')}`, { signal })
          if (!res.ok) {
            throw new Error(`DefiLlama prices: HTTP ${res.status}`)
          }
          const body = (await res.json()) as { coins?: Record<string, { price?: number; confidence?: number }> }
          for (const [key, coin] of Object.entries(body.coins ?? {})) {
            if (typeof coin.price === 'number' && Number.isFinite(coin.price) && (coin.confidence === undefined || coin.confidence >= minConfidence)) {
              result.set(key.slice(key.indexOf(':') + 1), coin.price)
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
 * 依次使用多个价格源：前面的源没给出价格的代币交给下一个源。某个源出错时跳过它（错误交给 onError；取消查询时照常 reject）。
 *
 * ```ts
 * combinePrices([defillamaPrices(), onchainPrices()])
 * ```
 */
export function combinePrices(sources: readonly SolanaPriceSource[], options: { onError?: (source: SolanaPriceSource, err: unknown) => void } = {}): SolanaPriceSource {
  return {
    name: sources.map((s) => s.name).join('+'),
    async prices(ctx) {
      const found = await runSources(sources, ctx, options.onError)
      return new Map([...found].map(([k, v]) => [k, v.price]))
    },
  }
}

/** 依次查询，记下每个价格来自哪个源 */
async function runSources(
  sources: readonly SolanaPriceSource[],
  ctx: SolanaPriceSourceContext,
  onError?: (source: SolanaPriceSource, err: unknown) => void,
): Promise<Map<string, { price: number; source: string }>> {
  const result = new Map<string, { price: number; source: string }>()
  let mints = [...ctx.mints]
  for (const source of sources) {
    if (!mints.length) break
    let found: Map<string, number>
    try {
      found = await source.prices({ ...ctx, mints })
    } catch (err) {
      if (ctx.signal?.aborted) {
        throw err
      }
      try {
        onError?.(source, err)
      } catch {
        // 回调出错不影响查询结果
      }
      continue
    }
    for (const [mint, price] of found) {
      if (!result.has(mint) && Number.isFinite(price)) result.set(mint, { price, source: source.name })
    }
    mints = mints.filter((m) => !result.has(m))
  }
  return result
}

// ---------------------------------------------------------------------------
// 链上价格
// ---------------------------------------------------------------------------

/** 按 1 美元计的稳定币（链上价格的计价锚点之一；另一个是 Wrapped SOL）：USDC、USDT */
export const STABLECOINS: readonly string[] = ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']

export type OnchainPriceProtocol = PdaPoolProtocol

export interface OnchainPriceOptions {
  /** 池子里计价币一侧的价值（美元）下限，低于它的池子不用（防止小池子的价格被操纵），默认 10000 */
  minLiquidityUsd?: number
  /** 按 1 美元计的稳定币，默认 STABLECOINS（USDC、USDT） */
  stablecoins?: readonly string[]
  /** 用哪些协议的池子，默认全部：'raydium-clmm'、'orca-whirlpool'、'raydium-cpmm' */
  protocols?: readonly OnchainPriceProtocol[]
}

/** 账户至少要读到的长度（Raydium PoolState 1544 字节，Orca Whirlpool 653 字节） */
const RAYDIUM_POOL_SIZE = 1544
const ORCA_POOL_SIZE = 653

interface Candidate {
  protocol: OnchainPriceProtocol
  address: string
  token: string
  anchor: string
}

/** 两个 mint 在所有协议里可能的池子地址 */
function candidates(token: string, anchor: string, protocols: ReadonlySet<OnchainPriceProtocol>): Candidate[] {
  return poolAddresses(token, anchor, protocols).map((p) => ({ ...p, token, anchor }))
}

/** 池子里定价要用的字段：集中流动性读当前价格和活跃流动性，CPMM 读金库扣掉手续费后的余额 */
type PoolRead =
  | { kind: 'clmm'; mint0: string; mint1: string; vault0: string; vault1: string; sqrtPrice: bigint; liquidity: bigint }
  | { kind: 'cpmm'; mint0: string; mint1: string; vault0: string; vault1: string; reserved0: bigint; reserved1: bigint }

function readPool(c: Candidate, account: AccountInfo): PoolRead | null {
  const b = new Bytes(account.data)
  if (c.protocol === 'raydium-clmm' && account.owner === RAYDIUM_CLMM_PROGRAM_ID && account.data.length >= RAYDIUM_POOL_SIZE) {
    // PoolState：mint 73 / 105、vault 137 / 169、liquidity 237、sqrt_price 253
    return { kind: 'clmm', mint0: b.key(73), mint1: b.key(105), vault0: b.key(137), vault1: b.key(169), liquidity: b.u128(237), sqrtPrice: b.u128(253) }
  }
  if (c.protocol === 'orca-whirlpool' && account.owner === ORCA_WHIRLPOOL_PROGRAM_ID && account.data.length >= ORCA_POOL_SIZE) {
    // Whirlpool：liquidity 49、sqrt_price 65、mint_a 101、vault_a 133、mint_b 181、vault_b 213
    return { kind: 'clmm', mint0: b.key(101), mint1: b.key(181), vault0: b.key(133), vault1: b.key(213), liquidity: b.u128(49), sqrtPrice: b.u128(65) }
  }
  if (c.protocol === 'raydium-cpmm') {
    const pool = parseAmmPool(account)
    return pool?.protocol === 'raydium-cpmm'
      ? { kind: 'cpmm', mint0: pool.mint0, mint1: pool.mint1, vault0: pool.vault0, vault1: pool.vault1, reserved0: pool.reserved0, reserved1: pool.reserved1 }
      : null
  }
  return null
}

interface Quote {
  token: string
  anchor: string
  /** 1 个代币值多少个计价币 */
  price: number
  /** 池子里计价币的数量（按精度换算） */
  depth: number
}

/**
 * 链上价格：按 PDA 推导代币对 Wrapped SOL、稳定币的池子（Raydium CLMM 的每个 AmmConfig、Orca 的每个费率档位、Raydium CPMM 的每个 AmmConfig），
 * 用计价币一侧最深的池子的价格。稳定币按 1 美元；Wrapped SOL（和原生 SOL）按它对稳定币最深的池子。
 * 不需要 getProgramAccounts（免费公共节点大多不支持）；每个代币约推导 190 个地址，读取用 getMultipleAccounts 合并（一共两轮：池子和 mint、金库）。
 * 深度：CPMM 是金库余额；集中流动性取金库余额和当前活跃流动性折算的储备中较小的（流动性都在区间外的池子价格不可信，不会被选中）。
 * 适合 DefiLlama 没有收录的新币；价格是池子当前的价格，可能被单个区块内的交易影响，只用于展示。
 * Raydium AMM v4、Meteora、PumpSwap 等池子地址不能只靠两个 mint 推导，不在查找范围内
 */
export function onchainPrices(options: OnchainPriceOptions = {}): SolanaPriceSource {
  return {
    name: 'onchain',
    async prices({ mints, client, signal }) {
      if (!client) throw new Error('onchainPrices needs a SolanaClient (ctx.client)')
      const stables = options.stablecoins ?? STABLECOINS
      const protocols = new Set(options.protocols ?? (['raydium-clmm', 'orca-whirlpool', 'raydium-cpmm'] as const))
      const minLiquidity = options.minLiquidityUsd ?? 10_000
      const result = new Map<string, number>()
      const stableSet = new Set(stables)
      for (const m of mints) if (stableSet.has(m)) result.set(m, 1)
      const rest = [...new Set(mints)].filter((m) => !stableSet.has(m) && m !== NATIVE_MINT && isAddress(m))
      const wantSol = mints.includes(NATIVE_MINT)
      if (!stables.length || !protocols.size || (!rest.length && !wantSol)) return result

      // 1. 一次读：Wrapped SOL 对稳定币、其他代币对 Wrapped SOL 和稳定币的候选池子，以及这些代币的 mint（精度）
      const list = [
        ...stables.flatMap((s) => candidates(NATIVE_MINT, s, protocols)),
        ...rest.flatMap((t) => [NATIVE_MINT, ...stables].flatMap((anchor) => candidates(t, anchor, protocols))),
      ]
      const mintList = [...new Set([NATIVE_MINT, ...stables, ...rest])]
      const first = await client.accounts([...list.map((c) => c.address), ...mintList], { signal })
      const decimals = new Map<string, number>()
      mintList.forEach((m, i) => {
        const account = first[list.length + i]
        try {
          if (account) decimals.set(m, parseMint(account.data).decimals)
        } catch {
          // 不是代币 mint
        }
      })
      const pools = list.flatMap((c, i) => {
        const account = first[i]
        const pool = account ? readPool(c, account) : null
        // 池子里的两个 mint 要和推导时的一致（PDA 上可能是别的账户）
        const ok = pool && ((pool.mint0 === c.token && pool.mint1 === c.anchor) || (pool.mint1 === c.token && pool.mint0 === c.anchor))
        return ok ? [{ ...c, pool }] : []
      })
      if (!pools.length) return result

      // 2. 一次读：金库（集中流动性只读计价币一侧，CPMM 两侧都读）
      const vaultsOf = (p: (typeof pools)[number]) => {
        const anchorIs0 = p.pool.mint0 === p.anchor
        return p.pool.kind === 'cpmm' ? [p.pool.vault0, p.pool.vault1] : [anchorIs0 ? p.pool.vault0 : p.pool.vault1]
      }
      const vaultAddresses = [...new Set(pools.flatMap(vaultsOf))]
      const vaultAccounts = await client.accounts(vaultAddresses, { signal })
      const balances = new Map<string, bigint>()
      vaultAddresses.forEach((address, i) => {
        const account = vaultAccounts[i]
        try {
          if (account) balances.set(address, parseTokenAccount(account.data).amount)
        } catch {
          // 不是代币账户
        }
      })
      const quotes = pools.flatMap((p): Quote[] => {
        const q = quote(p.pool, p.token, p.anchor, decimals, balances)
        return q && Number.isFinite(q.price) && q.price > 0 && Number.isFinite(q.depth) ? [q] : []
      })

      // 3. 先算 Wrapped SOL（对稳定币），再按 SOL 和稳定币的美元价格算其他代币
      const anchorsUsd = new Map(stables.map((s) => [s, 1]))
      const sol = best(quotes.filter((q) => q.token === NATIVE_MINT), anchorsUsd, minLiquidity)
      if (sol !== null) {
        anchorsUsd.set(NATIVE_MINT, sol)
        if (wantSol) result.set(NATIVE_MINT, sol)
      }
      for (const t of rest) {
        const usd = best(quotes.filter((q) => q.token === t), anchorsUsd, minLiquidity)
        if (usd !== null) result.set(t, usd)
      }
      return result
    },
  }
}

/** 一个池子给出的价格（计价币 / 代币）和计价币一侧的深度；缺精度、金库时为 null */
function quote(pool: PoolRead, token: string, anchor: string, decimals: ReadonlyMap<string, number>, balances: ReadonlyMap<string, bigint>): Quote | null {
  const d0 = decimals.get(pool.mint0)
  const d1 = decimals.get(pool.mint1)
  if (d0 === undefined || d1 === undefined) return null
  const tokenIs0 = pool.mint0 === token
  const da = tokenIs0 ? d1 : d0
  if (pool.kind === 'cpmm') {
    const v0 = balances.get(pool.vault0)
    const v1 = balances.get(pool.vault1)
    if (v0 === undefined || v1 === undefined) return null
    // 与程序一致：金库余额扣掉协议 / 基金 / 创建者手续费才是储备
    const r0 = v0 > pool.reserved0 ? v0 - pool.reserved0 : 0n
    const r1 = v1 > pool.reserved1 ? v1 - pool.reserved1 : 0n
    if (r0 === 0n || r1 === 0n) return null
    const [rt, ra, dt] = tokenIs0 ? [r0, r1, d0] : [r1, r0, d1]
    const depth = Number(formatUnits(ra, da))
    return { token, anchor, price: depth / Number(formatUnits(rt, dt)), depth }
  }
  const vault = balances.get(tokenIs0 ? pool.vault1 : pool.vault0)
  if (vault === undefined || pool.sqrtPrice === 0n) return null
  // price = token1 / token0（按精度换算）
  const price1Per0 = sqrtPriceToPrice(pool.sqrtPrice, d0, d1)
  // 当前活跃流动性折算的计价币储备（最小单位）：token1 = L × √P，token0 = L / √P（√P = sqrtPrice / 2^64）
  const sqrt = Number(pool.sqrtPrice) / 2 ** 64
  const virtual = (tokenIs0 ? Number(pool.liquidity) * sqrt : Number(pool.liquidity) / sqrt) / 10 ** da
  return { token, anchor, price: tokenIs0 ? price1Per0 : 1 / price1Per0, depth: Math.min(Number(formatUnits(vault, da)), virtual) }
}

/** 深度（美元）达到下限的池子里最深的一个给出的美元价格；没有时为 null */
function best(quotes: readonly Quote[], anchorsUsd: ReadonlyMap<string, number>, minLiquidityUsd: number): number | null {
  let found: { usd: number; depthUsd: number } | null = null
  for (const q of quotes) {
    const anchorUsd = anchorsUsd.get(q.anchor)
    if (anchorUsd === undefined) continue
    const depthUsd = q.depth * anchorUsd
    if (depthUsd >= minLiquidityUsd && (!found || depthUsd > found.depthUsd)) found = { usd: q.price * anchorUsd, depthUsd }
  }
  return found ? found.usd : null
}

// ---------------------------------------------------------------------------
// tokenPrices
// ---------------------------------------------------------------------------

export interface TokenPricesOptions extends RequestOptions {
  /** 价格源，依次使用（前面没有价格的交给后面的），默认 [defillamaPrices(), onchainPrices()] */
  sources?: readonly SolanaPriceSource[]
  /** 某个价格源出错时调用（继续用下一个源）；回调本身出错会被忽略 */
  onError?: (source: SolanaPriceSource, err: unknown) => void
  /** 查价格用的 fetch（代理等场景），默认全局 fetch */
  fetch?: typeof fetch
}

export interface TokenPrice {
  /** 传入的 mint（原样） */
  token: string
  /** 按原生 SOL 处理（客户端的 nativeMints，默认 So111…112 和 11111…1），价格就是 SOL 的价格 */
  native: boolean
  /** 美元价格；所有价格源都没有时为 null */
  price: number | null
  /** 给出价格的价格源（如 'defillama'、'onchain'） */
  source: string | null
}

/**
 * 查代币的美元价格（SOL 用 NATIVE_MINT）。默认先查 DefiLlama，没有收录的再从链上池子算。
 *
 * ```ts
 * await tokenPrices(client, [NATIVE_MINT, USDC, newToken])
 * // [{ token: 'So111…112', native: true, price: 187.4, source: 'defillama' }, …, { token: newToken, price: 0.0012, source: 'onchain' }]
 * await tokenPrices(client, mints, { sources: [defillamaPrices({ at: new Date('2026-01-01') })] })   // 历史价格
 * ```
 */
export async function tokenPrices(client: SolanaClient, mints: readonly string[], options: TokenPricesOptions = {}): Promise<TokenPrice[]> {
  const { sources = [defillamaPrices(), onchainPrices()], onError, fetch: fetchOption, signal } = options
  const fetchFn = fetchOption ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const native = mints.map((m) => client.isNativeMint(m))
  // 原生 SOL 按 Wrapped SOL 的 mint 查；不是合法地址的不查
  const keys = mints.map((m, i) => (native[i] ? NATIVE_MINT : m))
  const query = [...new Set(keys.filter((k) => isAddress(k)))]
  const found = await runSources(sources, { mints: query, fetch: fetchFn, signal, client }, onError)
  return mints.map((token, i) => {
    const hit = found.get(keys[i] as string)
    return { token, native: native[i] as boolean, price: hit?.price ?? null, source: hit?.source ?? null }
  })
}
