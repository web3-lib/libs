/**
 * 价格（子路径 `@w3lib/evm-batch-call/price`）：DefiLlama（当前 / 历史）、链上池子价格（V2 / V3 池子，按流动性选）、
 * 组合多个价格源、按地址算资产总值。价格只用于展示和估值，不要用来计算交易的最小数量
 */
import type { CallOverrides } from './aggregate.js'
import type { Call } from './call.js'
import { formatUnits } from './erc20.js'
import { fetchJson } from './http.js'
import { LP_PROTOCOLS, LP_QUOTE_TOKENS, type LpProtocol } from './lp.js'
import { sqrtPriceToPrice } from './lpMath.js'
import { getNativeCurrency } from './chains.js'
import type { Provider } from './provider.js'
import { TRON_CHAIN_ID, isTronChain, toTronAddress } from './tron.js'

export interface PriceSourceContext {
  chainId: number
  /** 代币地址（不含主币） */
  tokens: readonly string[]
  /** 主币 symbol（需要主币价格时）；不需要时为 null */
  nativeSymbol: string | null
  fetch: typeof fetch
  /** 查询用的 Provider（链上价格源 onchainPrices 用它读池子） */
  provider?: Provider
}

export interface PriceSource {
  readonly name: string
  /** 返回 去重键 → 美元价格：EVM 是小写 0x 地址；Tron 是 T 开头的 base58 地址（区分大小写）；主币用键 'native'。没有价格的不返回 */
  prices(ctx: PriceSourceContext): Promise<Map<string, number>>
}

/** DefiLlama 的链标识：chainId → slug（2026-10 实测可用） */
export const DEFILLAMA_CHAINS: Readonly<Record<number, string>> = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bsc',
  130: 'unichain',
  137: 'polygon',
  143: 'monad',
  196: 'xlayer',
  204: 'op_bnb',
  324: 'era',
  999: 'hyperliquid',
  1116: 'core',
  2818: 'morph',
  5000: 'mantle',
  8453: 'base',
  9745: 'plasma',
  34443: 'mode',
  42161: 'arbitrum',
  43114: 'avax',
  57073: 'ink',
  59144: 'linea',
  80094: 'berachain',
  81457: 'blast',
  534352: 'scroll',
  [TRON_CHAIN_ID.mainnet]: 'tron',
}

/** 主币价格：按主币 symbol 对应 CoinGecko 的币种 id（DefiLlama 用 coingecko:<id> 查） */
const NATIVE_PRICE_IDS: Readonly<Record<string, string>> = {
  ETH: 'ethereum',
  BNB: 'binancecoin',
  POL: 'polygon-ecosystem-token',
  AVAX: 'avalanche-2',
  MNT: 'mantle',
  OKB: 'okb',
  HYPE: 'hyperliquid',
  BERA: 'berachain-bera',
  CORE: 'coredaoorg',
  MON: 'monad',
  XPL: 'plasma',
  TRX: 'tron',
}

export interface DefillamaPriceOptions {
  /** 置信度下限（0~1），DefiLlama 给出的置信度低于它视为没有价格，默认 0.9 */
  minConfidence?: number
  /** 历史价格：这个时间点（unix 秒或 Date）附近的价格；不传为当前价格 */
  at?: number | Date
}

/**
 * DefiLlama 价格（免费、不需要 Key）。
 * 注意：流动性很差的代币价格可能虚高，展示总资产时建议配合 minUsd 或自己的价格源。
 *
 * ```ts
 * defillamaPrices()                                   // 当前价格
 * defillamaPrices({ at: new Date('2026-01-01') })     // 历史价格
 * ```
 */
export function defillamaPrices(options: DefillamaPriceOptions = {}): PriceSource {
  const minConfidence = options.minConfidence ?? 0.9
  const at = options.at instanceof Date ? Math.floor(options.at.getTime() / 1000) : options.at
  const endpoint = at === undefined ? 'https://coins.llama.fi/prices/current' : `https://coins.llama.fi/prices/historical/${Math.floor(at)}`
  return {
    name: at === undefined ? 'defillama' : `defillama@${Math.floor(at)}`,
    async prices({ chainId, tokens, nativeSymbol, fetch: fetchFn }) {
      const result = new Map<string, number>()
      const slug = DEFILLAMA_CHAINS[chainId]
      const nativeId = nativeSymbol ? NATIVE_PRICE_IDS[nativeSymbol.toUpperCase()] : undefined
      // 查询键 → 结果里用的去重键：EVM 地址小写；Tron 地址区分大小写，DefiLlama 要用原样的 base58（T…）地址
      const resultKey = new Map<string, string>()
      const tokenKeys = slug
        ? tokens.map((t) => {
            const tron = slug === 'tron'
            const query = `${slug}:${tron ? toTronAddress(t) : t.toLowerCase()}`
            resultKey.set(query.toLowerCase(), tron ? toTronAddress(t) : t.toLowerCase())
            return query
          })
        : []
      const keys = [...(nativeId ? [`coingecko:${nativeId}`] : []), ...tokenKeys]
      const batches: string[][] = []
      for (let i = 0; i < keys.length; i += 100) {
        batches.push(keys.slice(i, i + 100))
      }
      const responses = await Promise.all(
        batches.map((batch) => fetchJson<{ coins?: Record<string, { price?: number; confidence?: number }> }>(fetchFn, `${endpoint}/${batch.join(',')}`)),
      )
      for (const res of responses) {
        for (const [key, coin] of Object.entries(res.coins ?? {})) {
          if (typeof coin.price !== 'number' || !Number.isFinite(coin.price) || (coin.confidence !== undefined && coin.confidence < minConfidence)) {
            continue
          }
          result.set(key.startsWith('coingecko:') ? 'native' : (resultKey.get(key.toLowerCase()) ?? key.slice(key.indexOf(':') + 1).toLowerCase()), coin.price)
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
 * 依次使用多个价格源：前面的源没给出价格的代币（和主币）交给下一个源。某个源出错时跳过它（错误交给 onError）。
 *
 * ```ts
 * combinePrices([defillamaPrices(), onchainPrices()])
 * ```
 */
export function combinePrices(sources: readonly PriceSource[], options: { onError?: (source: PriceSource, err: unknown) => void } = {}): PriceSource {
  return {
    name: sources.map((s) => s.name).join('+'),
    async prices(ctx) {
      const found = await runSources(sources, ctx, options.onError)
      return new Map([...found].map(([k, v]) => [k, v.price]))
    },
  }
}

/** 依次查询，记下每个价格来自哪个源 */
async function runSources(sources: readonly PriceSource[], ctx: PriceSourceContext, onError?: (source: PriceSource, err: unknown) => void): Promise<Map<string, { price: number; source: string }>> {
  const result = new Map<string, { price: number; source: string }>()
  let tokens = [...ctx.tokens]
  let nativeSymbol = ctx.nativeSymbol
  for (const source of sources) {
    if (!tokens.length && !nativeSymbol) break
    let found: Map<string, number>
    try {
      found = await source.prices({ ...ctx, tokens, nativeSymbol })
    } catch (err) {
      onError?.(source, err)
      continue
    }
    for (const [key, price] of found) if (!result.has(key) && Number.isFinite(price) && price > 0) result.set(key, { price, source: source.name })
    tokens = tokens.filter((t) => !result.has(priceKeyOf(ctx.chainId, t)))
    if (result.has('native')) nativeSymbol = null
  }
  return result
}

/** 价格结果里的键：EVM 小写 0x 地址；Tron 是 T 开头的 base58 地址；主币为 'native' */
export function priceKeyOf(chainId: number, token: string): string {
  return isTronChain(chainId) ? toTronAddress(token) : token.toLowerCase()
}

// ---------------------------------------------------------------------------
// 链上价格
// ---------------------------------------------------------------------------

/** 按 1 美元计的稳定币（链上价格的计价锚点之一；另一个是包装主币） */
export const STABLECOINS: Readonly<Record<number, readonly string[]>> = {
  1: ['0xdAC17F958D2ee523a2206206994597C13D831ec7', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0x6B175474E89094C44Da98b954EedeAC495271d0F'],
  56: ['0x55d398326f99059fF775485246999027B3197955', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'],
  8453: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
  42161: ['0xaf88d065e77c8cC2239327C5EDb3A432268e5831', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'],
  10: ['0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58'],
  137: ['0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'],
  43114: ['0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'],
  [TRON_CHAIN_ID.mainnet]: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'],
}

export interface OnchainPriceOptions {
  /** 池子里计价币一侧的价值（美元）下限，低于它的池子不用（防止小池子的价格被操纵），默认 10000 */
  minLiquidityUsd?: number
  /** 包装主币（计价锚点，主币的价格也按它），默认 LP_QUOTE_TOKENS 里这条链的第一个 */
  wrappedNative?: string
  /** 按 1 美元计的稳定币，默认 STABLECOINS 里这条链的 */
  stablecoins?: readonly string[]
  /** 用哪些协议的池子，默认 LP_PROTOCOLS 里这条链的 V2 和 V3 */
  protocols?: readonly LpProtocol[]
  /** V3 池子的手续费档位，默认 [100, 500, 2500, 3000, 10000] */
  fees?: readonly number[]
}

const ERC20_ABI = ['function decimals() view returns (uint8)', 'function balanceOf(address owner) view returns (uint256)']
const V2_FACTORY_ABI = ['function getPair(address tokenA, address tokenB) view returns (address)']
const V2_PAIR_ABI = ['function token0() view returns (address)', 'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)']
const V3_FACTORY_ABI = ['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)']
const V3_POOL_ABI = ['function token0() view returns (address)', 'function slot0() view returns (uint160 sqrtPriceX96, int24 tick)', 'function liquidity() view returns (uint128)']
const ZERO = '0x0000000000000000000000000000000000000000'

interface PoolQuote {
  /** 1 个代币值多少个计价币 */
  price: number
  /** 池子里计价币的数量（按精度换算） */
  depth: number
}

/**
 * 链上价格：在 V2 / V3 池子里找代币对包装主币、稳定币的池子，用计价币一侧最深的池子的价格。
 * 稳定币按 1 美元；包装主币（和主币）按它对稳定币最深的池子。读取全部用 multicall 合并。
 * 适合 DefiLlama 没有收录的新币；价格是池子当前的价格，可能被单个区块内的交易影响，只用于展示
 */
export function onchainPrices(options: OnchainPriceOptions = {}): PriceSource {
  return {
    name: 'onchain',
    async prices({ chainId, tokens, nativeSymbol, provider }) {
      if (!provider) throw new Error('onchainPrices needs a Provider (ctx.provider)')
      const key = (t: string) => priceKeyOf(chainId, t)
      const wrapped = options.wrappedNative ?? LP_QUOTE_TOKENS[chainId]?.[0]
      const stables = options.stablecoins ?? STABLECOINS[chainId] ?? []
      const protocols = (options.protocols ?? LP_PROTOCOLS.filter((p) => p.chainId === chainId)).filter((p) => (p.version === 'v2' || p.version === 'v3') && p.factory)
      const minLiquidity = options.minLiquidityUsd ?? 10_000
      const result = new Map<string, number>()
      const stableKeys = new Set(stables.map(key))
      for (const t of tokens) if (stableKeys.has(key(t))) result.set(key(t), 1)
      if (!stables.length || !protocols.length) return result

      // 包装主币先对稳定币定价，其他代币再对包装主币和稳定币定价（两轮都用一次 multicall 找池子 + 一次读池子）
      const anchorsUsd = new Map(stables.map((s) => [key(s), 1]))
      const needWrapped = wrapped && (nativeSymbol || tokens.some((t) => key(t) === key(wrapped)) || tokens.some((t) => !stableKeys.has(key(t))))
      if (wrapped && needWrapped) {
        const [quote] = await bestQuotes(provider, [wrapped], stables, anchorsUsd, protocols, options.fees, minLiquidity)
        if (quote) {
          anchorsUsd.set(key(wrapped), quote)
          if (tokens.some((t) => key(t) === key(wrapped))) result.set(key(wrapped), quote)
          if (nativeSymbol) result.set('native', quote)
        }
      }
      const rest = [...new Set(tokens.map(key))].filter((k) => !result.has(k)).map((k) => tokens.find((t) => key(t) === k) as string)
      if (!rest.length) return result
      const anchors = [...(wrapped && anchorsUsd.has(key(wrapped)) ? [wrapped] : []), ...stables]
      const quotes = await bestQuotes(provider, rest, anchors, anchorsUsd, protocols, options.fees, minLiquidity)
      rest.forEach((t, i) => {
        const q = quotes[i]
        if (q !== null && q !== undefined) result.set(key(t), q)
      })
      return result
    },
  }
}

/** 每个代币在 anchors 上最深的池子给出的美元价格（池子深度不够时为 null） */
async function bestQuotes(
  provider: Provider,
  tokens: readonly string[],
  anchors: readonly string[],
  anchorsUsd: ReadonlyMap<string, number>,
  protocols: readonly LpProtocol[],
  fees: readonly number[] = [100, 500, 2500, 3000, 10000],
  minLiquidityUsd: number,
  overrides?: CallOverrides,
): Promise<Array<number | null>> {
  const chainId = await provider.getChainId()
  const key = (t: string) => priceKeyOf(chainId, t)
  // 1. 找池子：代币 × 计价币 × (V3 的每个手续费档位 + V2)
  const lookups: Array<{ token: number; anchor: string; v3: boolean }> = []
  const calls: Call[] = []
  tokens.forEach((token, i) => {
    for (const anchor of anchors) {
      if (key(anchor) === key(token)) continue
      for (const p of protocols) {
        const factory = p.factory as string
        if (p.version === 'v2') {
          lookups.push({ token: i, anchor, v3: false })
          calls.push(provider.contract(factory, V2_FACTORY_ABI).getPair(token, anchor))
        } else {
          for (const fee of fees) {
            lookups.push({ token: i, anchor, v3: true })
            calls.push(provider.contract(factory, V3_FACTORY_ABI).getPool(token, anchor, fee))
          }
        }
      }
    }
  })
  const addresses = await provider.tryAll<string>(calls, overrides)
  const pools = lookups.flatMap((l, i) => {
    const address = addresses[i]
    return address && address.toLowerCase() !== ZERO ? [{ ...l, address }] : []
  })
  if (!pools.length) return tokens.map(() => null)

  // 2. 读池子（token0 和价格 / 储备、计价币在池子里的余额）和精度
  const decimalsOf = [...new Set([...tokens, ...anchors].map(key))]
  const original = new Map([...tokens, ...anchors].map((t) => [key(t), t]))
  const state = await provider.tryAll(
    [
      ...decimalsOf.map((k) => provider.contract(original.get(k) as string, ERC20_ABI).decimals()),
      ...pools.flatMap((p) =>
        p.v3
          ? [
              provider.contract(p.address, V3_POOL_ABI).token0(),
              provider.contract(p.address, V3_POOL_ABI).slot0(),
              provider.contract(p.anchor, ERC20_ABI).balanceOf(p.address),
              provider.contract(p.address, V3_POOL_ABI).liquidity(),
            ]
          : [provider.contract(p.address, V2_PAIR_ABI).token0(), provider.contract(p.address, V2_PAIR_ABI).getReserves()],
      ),
    ],
    overrides,
  )
  const decimals = new Map(decimalsOf.map((k, i) => [k, state[i] === null || state[i] === undefined ? null : Number(state[i])]))
  const best: Array<{ usd: number; depthUsd: number } | null> = tokens.map(() => null)
  let offset = decimalsOf.length
  for (const p of pools) {
    const size = p.v3 ? 4 : 2
    const [token0, second, third, liquidity] = state.slice(offset, offset + size) as [string | null, { 0: bigint; 1: bigint } | null, bigint | null, bigint | null]
    offset += size
    const token = tokens[p.token] as string
    const dt = decimals.get(key(token))
    const da = decimals.get(key(p.anchor))
    const anchorUsd = anchorsUsd.get(key(p.anchor))
    if (!token0 || !second || dt === null || dt === undefined || da === null || da === undefined || anchorUsd === undefined) continue
    const tokenIs0 = key(token0) === key(token)
    const q = p.v3 ? v3Quote(second[0], third, liquidity ?? null, tokenIs0, dt, da) : v2Quote(second[0], second[1], tokenIs0, dt, da)
    if (!q || !Number.isFinite(q.price) || q.price <= 0) continue
    const depthUsd = q.depth * anchorUsd
    const current = best[p.token]
    if (depthUsd >= minLiquidityUsd && (!current || depthUsd > current.depthUsd)) best[p.token] = { usd: q.price * anchorUsd, depthUsd }
  }
  return best.map((b) => (b ? b.usd : null))
}

/**
 * V3 的深度：池子里计价币的余额和当前价格附近的流动性折算的计价币数量（虚拟储备：计价币是 token1 时 L·√P，是 token0 时 L / √P）取较小的。
 * 只看余额的话，在远离当前价格的区间放一笔计价币、再把价格推过没有流动性的区间，就能用很少的成本让池子“看起来很深”
 */
function v3Quote(sqrtPriceX96: bigint, anchorBalance: bigint | null, liquidity: bigint | null, tokenIs0: boolean, dt: number, da: number): PoolQuote | null {
  if (sqrtPriceX96 === 0n || anchorBalance === null || liquidity === null) return null
  // price = token1 / token0（按精度换算）
  const price1Per0 = tokenIs0 ? sqrtPriceToPrice(sqrtPriceX96, dt, da) : sqrtPriceToPrice(sqrtPriceX96, da, dt)
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96
  const virtual = (tokenIs0 ? Number(liquidity) * sqrtP : Number(liquidity) / sqrtP) / 10 ** da
  return { price: tokenIs0 ? price1Per0 : 1 / price1Per0, depth: Math.min(Number(formatUnits(anchorBalance, da)), virtual) }
}

function v2Quote(reserve0: bigint, reserve1: bigint, tokenIs0: boolean, dt: number, da: number): PoolQuote | null {
  const [rt, ra] = tokenIs0 ? [reserve0, reserve1] : [reserve1, reserve0]
  if (rt === 0n || ra === 0n) return null
  const anchor = Number(formatUnits(ra, da))
  return { price: anchor / Number(formatUnits(rt, dt)), depth: anchor }
}

// ---------------------------------------------------------------------------
// tokenPrices
// ---------------------------------------------------------------------------

export interface TokenPricesOptions {
  /** 价格源，依次使用（前面没有价格的交给后面的），默认 [defillamaPrices(), onchainPrices()] */
  sources?: readonly PriceSource[]
  /** 某个价格源出错时调用（继续用下一个源） */
  onError?: (source: PriceSource, err: unknown) => void
  /** 自定义 fetch（代理等场景）；默认全局 fetch */
  fetch?: typeof fetch
}

export interface TokenPrice {
  /** 传入的代币地址（原样） */
  token: string
  native: boolean
  /** 美元价格；所有价格源都没有时为 null */
  price: number | null
  /** 给出价格的价格源（如 'defillama'、'onchain'） */
  source: string | null
}

/**
 * 查代币的美元价格（主币用 NATIVE_TOKEN 或零地址）。默认先查 DefiLlama，没有收录的再从链上池子算。
 *
 * ```ts
 * await tokenPrices(provider, [NATIVE_TOKEN, USDT, newToken])
 * // [{ token: '0xEeee…', native: true, price: 612.3, source: 'defillama' }, …, { token: newToken, price: 0.0012, source: 'onchain' }]
 * await tokenPrices(provider, tokens, { sources: [defillamaPrices({ at: new Date('2026-01-01') })] })   // 历史价格
 * ```
 */
export async function tokenPrices(provider: Provider, tokens: readonly string[], options: TokenPricesOptions = {}): Promise<TokenPrice[]> {
  const { sources = [defillamaPrices(), onchainPrices()], onError, fetch: fetchOption } = options
  const chainId = await provider.getChainId()
  const fetchFn = fetchOption ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const native = tokens.map((t) => provider.isNativeToken(t))
  const erc20 = [...new Set(tokens.filter((_, i) => !native[i]).map((t) => (isTronChain(chainId) ? toTronAddress(t) : t)))]
  // 主币 symbol：内置链信息表，或 Provider 的 nativeSymbol 配置（不在表里的链）
  const nativeIndex = native.indexOf(true)
  const nativeSymbol = nativeIndex < 0 ? null : (getNativeCurrency(chainId)?.symbol ?? (await provider.tokens([tokens[nativeIndex] as string], { fields: ['symbol'] }))[0]?.symbol ?? null)
  const found = await runSources(sources, { chainId, tokens: erc20, nativeSymbol, fetch: fetchFn, provider }, onError)
  return tokens.map((token, i) => {
    const hit = found.get(native[i] ? 'native' : priceKeyOf(chainId, token))
    return { token, native: native[i] as boolean, price: hit?.price ?? null, source: hit?.source ?? null }
  })
}
