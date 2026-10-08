import type { CallOverrides } from './aggregate.js'
import { NATIVE_CURRENCIES } from './chains.js'
import { NATIVE_TOKEN, type BalanceToken } from './erc20.js'
import type { Provider } from './provider.js'

// ---------------------------------------------------------------------------
// 代币来源：负责“这个地址可能持有哪些代币”。余额一律由本库用 multicall 在链上核对。
// ---------------------------------------------------------------------------

export interface DiscoveredToken {
  address: string
  symbol?: string | null
  name?: string | null
  decimals?: number | null
  logo?: string | null
}

export interface TokenSourceContext {
  chainId: number
  owner: string
  fetch: typeof fetch
}

export interface TokenSource {
  /** 名称，出现在结果的 source 字段 */
  readonly name: string
  /** 返回候选代币；不支持这条链时返回 null（firstAvailable 会接着试下一个来源） */
  discover(ctx: TokenSourceContext): Promise<DiscoveredToken[] | null>
}

const REQUEST_TIMEOUT = 20_000
const LIST_TTL = 60 * 60 * 1000
const MAX_CACHED_LISTS = 32
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} from ${url}`)
    this.name = 'HttpStatusError'
  }
}

// 公开代币列表按 URL 缓存 1 小时（缓存 Promise，同时发起的请求共用；失败不缓存）
const listCache = new Map<string, { at: number; promise: Promise<unknown> }>()

/** 测试用：清空代币列表缓存 */
export function clearTokenListCache(): void {
  listCache.clear()
}

function fetchJson<T>(fetchFn: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  return fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT) }).then(async (res) => {
    if (!res.ok) {
      throw new HttpStatusError(res.status, url.replace(/\/v[12]\/[^/?]+/, '/v*/***')) // 不在错误信息里暴露 Key
    }
    return (await res.json()) as T
  })
}

function cachedList<T>(fetchFn: typeof fetch, url: string): Promise<T> {
  const hit = listCache.get(url)
  if (hit && Date.now() - hit.at < LIST_TTL) {
    return hit.promise as Promise<T>
  }
  const promise = fetchJson<T>(fetchFn, url)
  listCache.set(url, { at: Date.now(), promise })
  if (listCache.size > MAX_CACHED_LISTS) {
    listCache.delete(listCache.keys().next().value as string)
  }
  promise.catch(() => {
    if (listCache.get(url)?.promise === promise) listCache.delete(url)
  })
  return promise
}

/**
 * MetaMask 钱包用来自动发现代币的列表（汇总多家来源，Ethereum 约 9500 个、BSC 约 2 万个）。
 * minOccurrences：至少被几家来源收录（MetaMask 自己用 3），用来过滤垃圾币。
 *
 * 注意：这是 MetaMask 自己在用的接口，并非对外承诺的公开 API，可能随时限流或变更，建议与其他来源组合使用。
 */
export function metamaskTokenList(options: { minOccurrences?: number } = {}): TokenSource {
  const min = options.minOccurrences ?? 3
  return {
    name: 'metamask',
    async discover({ chainId, fetch: fetchFn }) {
      let list: Array<{ address: string; symbol?: string; name?: string; decimals?: number; iconUrl?: string; occurrences?: number }>
      try {
        list = await cachedList(fetchFn, `https://token.api.cx.metamask.io/tokens/${chainId}`)
      } catch (err) {
        if (err instanceof HttpStatusError && (err.status === 400 || err.status === 404)) {
          return null // 不支持这条链
        }
        throw err
      }
      const tokens = (Array.isArray(list) ? list : [])
        .filter((t) => t.address && t.address !== ZERO_ADDRESS && (t.occurrences ?? 0) >= min)
        .map((t) => ({ address: t.address, symbol: t.symbol ?? null, name: t.name ?? null, decimals: t.decimals ?? null, logo: t.iconUrl ?? null }))
      return tokens.length ? tokens : null
    },
  }
}

/** CoinGecko 按链维护的代币列表：chainId → 平台 id（2026-10 实测可用） */
export const COINGECKO_PLATFORMS: Readonly<Record<number, string>> = {
  1: 'ethereum',
  10: 'optimistic-ethereum',
  56: 'binance-smart-chain',
  130: 'unichain',
  137: 'polygon-pos',
  143: 'monad',
  173: 'eni',
  196: 'x-layer',
  204: 'opbnb',
  324: 'zksync',
  988: 'stable',
  999: 'hyperevm',
  1116: 'core',
  2818: 'morph-l2',
  4663: 'robinhood',
  5000: 'mantle',
  8453: 'base',
  9745: 'plasma',
  34443: 'mode',
  42161: 'arbitrum-one',
  43114: 'avalanche',
  57073: 'ink',
  59144: 'linea',
  80094: 'berachain',
  81457: 'blast',
  534352: 'scroll',
}

/** CoinGecko 代币列表（CoinGecko 收录的代币，Ethereum 约 6000 个、BSC 约 4500 个） */
export function coingeckoTokenList(): TokenSource {
  return {
    name: 'coingecko',
    async discover({ chainId, fetch: fetchFn }) {
      const platform = COINGECKO_PLATFORMS[chainId]
      if (!platform) {
        return null
      }
      const list = await cachedList<{ tokens?: UniswapListToken[] }>(fetchFn, `https://tokens.coingecko.com/${platform}/all.json`)
      return fromUniswapList(list.tokens ?? [], chainId)
    },
  }
}

interface UniswapListToken {
  chainId?: number
  address: string
  symbol?: string
  name?: string
  decimals?: number
  logoURI?: string
}

function fromUniswapList(tokens: readonly UniswapListToken[], chainId: number): DiscoveredToken[] | null {
  const out = tokens
    .filter((t) => (t.chainId === undefined || t.chainId === chainId) && t.address)
    .map((t) => ({ address: t.address, symbol: t.symbol ?? null, name: t.name ?? null, decimals: t.decimals ?? null, logo: t.logoURI ?? null }))
  return out.length ? out : null
}

/** 任意 Uniswap Token List 格式的列表（如 https://tokens.uniswap.org、PancakeSwap 列表、自己维护的列表） */
export function tokenList(url: string, options: { name?: string } = {}): TokenSource {
  return {
    name: options.name ?? `list:${url}`,
    async discover({ chainId, fetch: fetchFn }) {
      const list = await cachedList<{ tokens?: UniswapListToken[] }>(fetchFn, url)
      return fromUniswapList(list.tokens ?? [], chainId)
    },
  }
}

/** 固定的代币列表（如之前发现过、存下来的代币） */
export function staticTokens(tokens: ReadonlyArray<string | DiscoveredToken>, options: { name?: string } = {}): TokenSource {
  const list = tokens.map((t) => (typeof t === 'string' ? { address: t } : t))
  return {
    name: options.name ?? 'static',
    async discover() {
      return list.length ? list : null
    },
  }
}

/** Alchemy 各链的子域名（2026-10 实测存在） */
export const ALCHEMY_NETWORKS: Readonly<Record<number, string>> = {
  1: 'eth-mainnet',
  10: 'opt-mainnet',
  56: 'bnb-mainnet',
  130: 'unichain-mainnet',
  137: 'polygon-mainnet',
  143: 'monad-mainnet',
  196: 'xlayer-mainnet',
  204: 'opbnb-mainnet',
  324: 'zksync-mainnet',
  999: 'hyperliquid-mainnet',
  5000: 'mantle-mainnet',
  8453: 'base-mainnet',
  42161: 'arb-mainnet',
  43114: 'avax-mainnet',
  57073: 'ink-mainnet',
  59144: 'linea-mainnet',
  80094: 'berachain-mainnet',
  81457: 'blast-mainnet',
  534352: 'scroll-mainnet',
}

/**
 * Alchemy `alchemy_getTokenBalances`：查到地址的全部历史持仓（不限于公开列表）。需要 Alchemy 的 API Key（有免费额度）。
 * url 可覆盖默认地址（如表里没有的链）；maxPages 限制翻页次数（每页 100 个）。
 */
export function alchemy(options: { apiKey: string; url?: string; maxPages?: number }): TokenSource {
  if (!options?.apiKey) {
    throw new Error('alchemy() requires an apiKey (https://dashboard.alchemy.com)')
  }
  const maxPages = options.maxPages ?? 20
  return {
    name: 'alchemy',
    async discover({ chainId, owner, fetch: fetchFn }) {
      const network = ALCHEMY_NETWORKS[chainId]
      const url = options.url ?? (network ? `https://${network}.g.alchemy.com/v2/${options.apiKey}` : null)
      if (!url) {
        return null
      }
      const out: DiscoveredToken[] = []
      let pageKey: string | undefined
      for (let page = 0; page < maxPages; page++) {
        const res = await fetchJson<{ result?: { tokenBalances?: Array<{ contractAddress: string }>; pageKey?: string }; error?: { message?: string } }>(
          fetchFn,
          url,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenBalances', params: [owner, 'erc20', { maxCount: 100, ...(pageKey ? { pageKey } : {}) }] }),
          },
        )
        if (res.error) {
          throw new Error(`alchemy_getTokenBalances failed: ${res.error.message ?? 'unknown error'}`)
        }
        for (const t of res.result?.tokenBalances ?? []) {
          out.push({ address: t.contractAddress })
        }
        pageKey = res.result?.pageKey
        if (!pageKey) {
          break
        }
      }
      return out
    },
  }
}

const NODEREAL_NETWORKS: Readonly<Record<number, string>> = { 1: 'eth-mainnet', 56: 'bsc-mainnet' }

/**
 * NodeReal `nr_getTokenHoldings`：查到地址的全部历史持仓（仅 BSC、Ethereum）。需要 NodeReal 的 API Key（有免费额度）。
 */
export function nodereal(options: { apiKey: string; url?: string; maxPages?: number }): TokenSource {
  if (!options?.apiKey) {
    throw new Error('nodereal() requires an apiKey (https://nodereal.io)')
  }
  const maxPages = options.maxPages ?? 20
  return {
    name: 'nodereal',
    async discover({ chainId, owner, fetch: fetchFn }) {
      const network = NODEREAL_NETWORKS[chainId]
      const url = options.url ?? (network ? `https://${network}.nodereal.io/v1/${options.apiKey}` : null)
      if (!url) {
        return null
      }
      type Detail = { tokenAddress: string; tokenName?: string; tokenSymbol?: string; tokenDecimals?: string; tokenDecimails?: string }
      const out: DiscoveredToken[] = []
      for (let page = 1; page <= maxPages; page++) {
        const res = await fetchJson<{ result?: { totalCount?: string; details?: Detail[] }; error?: { message?: string } }>(fetchFn, url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nr_getTokenHoldings', params: [owner, `0x${page.toString(16)}`, '0x64'] }),
        })
        if (res.error) {
          throw new Error(`nr_getTokenHoldings failed: ${res.error.message ?? 'unknown error'}`)
        }
        const details = res.result?.details ?? []
        for (const d of details) {
          // 文档里字段名就是 tokenDecimails（拼写如此），两种都兼容
          const decimals = d.tokenDecimals ?? d.tokenDecimails
          out.push({ address: d.tokenAddress, symbol: d.tokenSymbol ?? null, name: d.tokenName ?? null, decimals: decimals ? Number(decimals) : null })
        }
        const total = Number(res.result?.totalCount ?? 0)
        if (!details.length || out.length >= total) {
          break
        }
      }
      return out
    },
  }
}

/** 按顺序尝试：前一个不支持这条链（返回 null）或出错时用下一个 */
export function firstAvailable(...sources: TokenSource[]): TokenSource {
  return {
    name: sources.map((s) => s.name).join('|'),
    async discover(ctx) {
      let lastError: unknown
      for (const source of sources) {
        try {
          const tokens = await source.discover(ctx)
          if (tokens) {
            return tokens.map((t) => ({ ...t, [SOURCE]: (t as Tagged)[SOURCE] ?? source.name }))
          }
        } catch (err) {
          lastError = err
        }
      }
      if (lastError) {
        throw lastError
      }
      return null
    },
  }
}

/** 合并多个来源（去重，先出现的元数据优先），如“公开列表 + 自己存下来的代币” */
export function combine(...sources: TokenSource[]): TokenSource {
  return {
    name: sources.map((s) => s.name).join('+'),
    async discover(ctx) {
      const results = await Promise.all(sources.map((s) => s.discover(ctx).then((tokens) => tokens?.map((t) => ({ ...t, [SOURCE]: (t as Tagged)[SOURCE] ?? s.name })) ?? null)))
      if (results.every((r) => r === null)) {
        return null
      }
      return dedupe(results.flatMap((r) => r ?? []))
    },
  }
}

/** 默认来源：MetaMask 列表（至少 3 家收录），不支持或不可用时用 CoinGecko 列表。都免费、不需要 Key */
export function defaultTokenSource(): TokenSource {
  return firstAvailable(metamaskTokenList(), coingeckoTokenList())
}

const SOURCE = Symbol('source')
type Tagged = DiscoveredToken & { [SOURCE]?: string }

function dedupe(tokens: DiscoveredToken[]): DiscoveredToken[] {
  const seen = new Map<string, DiscoveredToken>()
  for (const t of tokens) {
    const key = t.address.toLowerCase()
    if (!seen.has(key)) seen.set(key, t)
  }
  return [...seen.values()]
}

// ---------------------------------------------------------------------------
// 价格来源
// ---------------------------------------------------------------------------

export interface PriceSourceContext {
  chainId: number
  /** 代币地址（不含主币） */
  tokens: readonly string[]
  /** 是否需要主币价格 */
  native: boolean
  fetch: typeof fetch
}

export interface PriceSource {
  readonly name: string
  /** 返回 小写地址 → 美元价格；主币用键 'native'。没有价格的不返回 */
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
}

/**
 * DefiLlama 价格（免费、不需要 Key）。minConfidence：DefiLlama 给出的置信度下限（0~1），低于它视为没有价格，默认 0.9。
 * 注意：流动性很差的代币价格可能虚高，展示总资产时建议配合 minUsd 或自己的价格源。
 */
export function defillamaPrices(options: { minConfidence?: number } = {}): PriceSource {
  const minConfidence = options.minConfidence ?? 0.9
  return {
    name: 'defillama',
    async prices({ chainId, tokens, native, fetch: fetchFn }) {
      const result = new Map<string, number>()
      const slug = DEFILLAMA_CHAINS[chainId]
      const nativeId = NATIVE_PRICE_IDS[NATIVE_CURRENCIES[chainId]?.symbol ?? '']
      const keys = [...(native && nativeId ? [`coingecko:${nativeId}`] : []), ...(slug ? tokens.map((t) => `${slug}:${t.toLowerCase()}`) : [])]
      for (let i = 0; i < keys.length; i += 100) {
        const batch = keys.slice(i, i + 100)
        const res = await fetchJson<{ coins?: Record<string, { price?: number; confidence?: number }> }>(fetchFn, `https://coins.llama.fi/prices/current/${batch.join(',')}`)
        for (const [key, coin] of Object.entries(res.coins ?? {})) {
          if (typeof coin.price !== 'number' || (coin.confidence !== undefined && coin.confidence < minConfidence)) {
            continue
          }
          result.set(key.startsWith('coingecko:') ? 'native' : key.slice(key.indexOf(':') + 1).toLowerCase(), coin.price)
        }
      }
      return result
    },
  }
}

// ---------------------------------------------------------------------------
// ownerTokens
// ---------------------------------------------------------------------------

export interface OwnerTokensOptions extends CallOverrides {
  /** 代币来源，默认 defaultTokenSource()（MetaMask 列表 → CoinGecko 列表，免费免 Key） */
  source?: TokenSource
  /** 查美元价格：true 用 DefiLlama，也可以传自己的 PriceSource。默认 false */
  prices?: boolean | PriceSource
  /** 只保留价值 ≥ minUsd 的代币（需要 prices；没有价格的代币也会被去掉；主币不受影响） */
  minUsd?: number
  /** 第一项返回主币。默认 true */
  includeNative?: boolean
  /** 自定义 fetch（代理等场景）；默认全局 fetch */
  fetch?: typeof fetch
}

export interface OwnedToken {
  token: string
  native: boolean
  /** 余额（最小单位的十进制字符串），由 multicall 在链上核对 */
  balance: string
  decimals: number
  formatted: string
  symbol: string | null
  name: string | null
  logo: string | null
  /** 美元单价；未开启 prices 或没有价格时为 null */
  price: number | null
  /** 美元价值（formatted × price） */
  value: number | null
  /** 发现这个代币的来源（如 metamask / coingecko / alchemy）；主币为 'native' */
  source: string
}

export async function ownerTokens(provider: Provider, owner: string, options: OwnerTokensOptions = {}): Promise<OwnedToken[]> {
  const { source = defaultTokenSource(), prices = false, minUsd, includeNative = true, fetch: fetchOption, ...overrides } = options
  const fetchFn = fetchOption ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const chainId = await provider.getChainId()

  const discovered = await source.discover({ chainId, owner, fetch: fetchFn })
  if (!discovered) {
    throw new Error(`No token source supports chain ${chainId}; pass options.source (e.g. tokenList(url), alchemy({ apiKey }))`)
  }
  const candidates = dedupe(discovered).filter((t) => /^0x[0-9a-fA-F]{40}$/.test(t.address) && t.address.toLowerCase() !== NATIVE_TOKEN.toLowerCase() && t.address !== ZERO_ADDRESS)

  // 余额统一在链上核对（来源给的 decimals 直接用，省一次查询）
  const inputs: BalanceToken[] = candidates.map((t) => (typeof t.decimals === 'number' ? { address: t.address, decimals: t.decimals } : t.address))
  const balances = await provider.balances(owner, includeNative ? [NATIVE_TOKEN, ...inputs] : inputs, overrides)
  const nativeBalance = includeNative ? balances[0] : undefined
  const tokenBalances = includeNative ? balances.slice(1) : balances

  const held = candidates
    .map((t, i) => ({ meta: t, balance: tokenBalances[i] }))
    .filter((x): x is { meta: DiscoveredToken; balance: NonNullable<typeof x.balance> } => !!x.balance?.success && x.balance.balance !== '0')

  // 来源没给 symbol / name 的（如 Alchemy），用 multicall 补
  const missing = held.filter((x) => !x.meta.symbol || !x.meta.name).map((x) => x.meta.address)
  const fetched = missing.length ? await provider.tokens(missing, { ...overrides, fields: ['name', 'symbol'] }) : []
  const fetchedBy = new Map(fetched.map((t) => [t.address.toLowerCase(), t]))

  const priceSource = prices === true ? defillamaPrices() : prices || null
  const priceMap = priceSource
    ? await priceSource.prices({ chainId, tokens: held.map((x) => x.meta.address), native: includeNative, fetch: fetchFn })
    : new Map<string, number>()

  const valueOf = (formatted: string, price: number | undefined) => (price === undefined ? null : Number(formatted) * price)

  let list: OwnedToken[] = held.map(({ meta, balance }) => {
    const extra = fetchedBy.get(meta.address.toLowerCase())
    const price = priceMap.get(meta.address.toLowerCase())
    return {
      token: meta.address,
      native: false,
      balance: balance.balance,
      decimals: balance.decimals,
      formatted: balance.formatted,
      symbol: meta.symbol || extra?.symbol || null,
      name: meta.name || extra?.name || null,
      logo: meta.logo ?? null,
      price: price ?? null,
      value: valueOf(balance.formatted, price),
      source: (meta as Tagged)[SOURCE] ?? source.name,
    }
  })
  if (minUsd !== undefined && priceSource) {
    list = list.filter((t) => t.value !== null && t.value >= minUsd)
  }
  // 有价格时按价值从高到低，没有价格的排在后面（保持来源里的顺序）
  if (priceSource) {
    list.sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
  }
  if (nativeBalance?.success) {
    const currency = NATIVE_CURRENCIES[chainId]
    const price = priceMap.get('native')
    list.unshift({
      token: NATIVE_TOKEN,
      native: true,
      balance: nativeBalance.balance,
      decimals: nativeBalance.decimals,
      formatted: nativeBalance.formatted,
      symbol: currency?.symbol ?? null,
      name: currency?.name ?? null,
      logo: null,
      price: price ?? null,
      value: valueOf(nativeBalance.formatted, price),
      source: 'native',
    })
  }
  return list
}
