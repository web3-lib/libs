import type { CallOverrides } from './aggregate.js'
import { NATIVE_TOKEN, formatAmount, type BalanceToken } from './erc20.js'
import type { Provider } from './provider.js'
import { transferScan, type TransferScanOptions } from './scan.js'
import { isTronAddress } from './tron.js'

// ---------------------------------------------------------------------------
// 代币来源：负责“这个地址可能持有哪些代币”。余额和精度一律由本库用 multicall 在链上核对。
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
  /** 查询用的 Provider（扫描链上事件的来源会用到，如 transferScan） */
  provider?: Provider
}

export interface TokenSource {
  /** 名称，出现在结果的 source 字段 */
  readonly name: string
  /** 返回候选代币；不支持这条链时返回 null（firstAvailable 会接着试下一个来源） */
  discover(ctx: TokenSourceContext): Promise<DiscoveredToken[] | null>
}

const REQUEST_TIMEOUT = 20_000
const LIST_TTL = 60 * 60 * 1000
const MAX_CACHED_LISTS = 16
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    target: string,
  ) {
    super(`HTTP ${status} from ${target}`)
    this.name = 'HttpStatusError'
  }
}

/**
 * @param secret 请求里带的 Key：出错时错误信息只写域名，不写完整地址，避免 Key 出现在日志里
 */
function fetchJson<T>(fetchFn: typeof fetch, url: string, init?: RequestInit, secret?: string): Promise<T> {
  return fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT) }).then(async (res) => {
    if (!res.ok) {
      throw new HttpStatusError(res.status, secret ? safeHost(url) : url)
    }
    return (await res.json()) as T
  })
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'request'
  }
}

// 公开代币列表：缓存“按链过滤、转换后”的结果（不缓存原始 JSON），1 小时；缓存 Promise，同时发起的请求共用，失败不缓存。
// 公开列表与使用哪个 fetch 无关，所以缓存键只看列表和链
const listCache = new Map<string, { at: number; promise: Promise<DiscoveredToken[] | null> }>()

/** 清空代币列表缓存 */
export function clearTokenListCache(): void {
  listCache.clear()
}

function cachedList(key: string, load: () => Promise<DiscoveredToken[] | null>): Promise<DiscoveredToken[] | null> {
  const hit = listCache.get(key)
  if (hit && Date.now() - hit.at < LIST_TTL) {
    return hit.promise
  }
  const promise = load()
  listCache.set(key, { at: Date.now(), promise })
  if (listCache.size > MAX_CACHED_LISTS) {
    listCache.delete(listCache.keys().next().value as string)
  }
  promise.catch(() => {
    if (listCache.get(key)?.promise === promise) listCache.delete(key)
  })
  return promise
}

/** 来源给的 decimals 只在是合法整数时使用（否则当作未知，由链上查询） */
function validDecimals(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255 ? n : null
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
    discover({ chainId, fetch: fetchFn }) {
      const url = `https://token.api.cx.metamask.io/tokens/${chainId}`
      return cachedList(`metamask:${chainId}:${min}`, async () => {
        let list: Array<{ address: string; symbol?: string; name?: string; decimals?: number; iconUrl?: string; occurrences?: number }>
        try {
          list = await fetchJson(fetchFn, url)
        } catch (err) {
          if (err instanceof HttpStatusError && (err.status === 400 || err.status === 404)) {
            return null // 不支持这条链
          }
          throw err
        }
        const tokens = (Array.isArray(list) ? list : [])
          .filter((t) => t.address && t.address !== ZERO_ADDRESS && (t.occurrences ?? 0) >= min)
          .map((t) => ({ address: t.address, symbol: t.symbol ?? null, name: t.name ?? null, decimals: validDecimals(t.decimals), logo: t.iconUrl ?? null }))
        return tokens.length ? tokens : null
      })
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
    .map((t) => ({ address: t.address, symbol: t.symbol ?? null, name: t.name ?? null, decimals: validDecimals(t.decimals), logo: t.logoURI ?? null }))
  return out.length ? out : null
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
      const url = `https://tokens.coingecko.com/${platform}/all.json`
      return cachedList(`coingecko:${chainId}`, async () => fromUniswapList((await fetchJson<{ tokens?: UniswapListToken[] }>(fetchFn, url)).tokens ?? [], chainId))
    },
  }
}

/** 任意 Uniswap Token List 格式的列表（如 https://tokens.uniswap.org、PancakeSwap 列表、自己维护的列表） */
export function tokenList(url: string, options: { name?: string } = {}): TokenSource {
  return {
    name: options.name ?? `list:${url}`,
    discover({ chainId, fetch: fetchFn }) {
      return cachedList(`list:${url}:${chainId}`, async () => fromUniswapList((await fetchJson<{ tokens?: UniswapListToken[] }>(fetchFn, url)).tokens ?? [], chainId))
    },
  }
}

/** 固定的代币列表（如之前发现过、存下来的代币） */
export function staticTokens(tokens: ReadonlyArray<string | DiscoveredToken>, options: { name?: string } = {}): TokenSource {
  const list = tokens.map((t) => (typeof t === 'string' ? { address: t } : { ...t, decimals: validDecimals(t.decimals) }))
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

export interface IndexerSourceOptions {
  /** API Key（必填；库里没有内置 Key） */
  apiKey: string
  /** 按链覆盖请求地址（如代理或表里没有的链）：{ [chainId]: url }；其他链仍用默认地址 */
  urls?: Readonly<Record<number, string>>
  /** 最多翻几页（每页 100 个代币），默认 20 */
  maxPages?: number
}

/**
 * Alchemy `alchemy_getTokenBalances`：查到地址的全部历史持仓（不限于公开列表）。需要 Alchemy 的 API Key（有免费额度）。
 */
export function alchemy(options: IndexerSourceOptions): TokenSource {
  if (!options?.apiKey) {
    throw new Error('alchemy() requires an apiKey (https://dashboard.alchemy.com)')
  }
  const maxPages = options.maxPages ?? 20
  const secret = options.apiKey
  return {
    name: 'alchemy',
    async discover({ chainId, owner, fetch: fetchFn }) {
      const network = ALCHEMY_NETWORKS[chainId]
      const url = options.urls?.[chainId] ?? (network ? `https://${network}.g.alchemy.com/v2/${secret}` : null)
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
          secret,
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
export function nodereal(options: IndexerSourceOptions): TokenSource {
  if (!options?.apiKey) {
    throw new Error('nodereal() requires an apiKey (https://nodereal.io)')
  }
  const maxPages = options.maxPages ?? 20
  const secret = options.apiKey
  return {
    name: 'nodereal',
    async discover({ chainId, owner, fetch: fetchFn }) {
      const network = NODEREAL_NETWORKS[chainId]
      const url = options.urls?.[chainId] ?? (network ? `https://${network}.nodereal.io/v1/${secret}` : null)
      if (!url) {
        return null
      }
      type Detail = { tokenAddress: string; tokenName?: string; tokenSymbol?: string; tokenDecimals?: string; tokenDecimails?: string }
      const out: DiscoveredToken[] = []
      for (let page = 1; page <= maxPages; page++) {
        const res = await fetchJson<{ result?: { totalCount?: string; details?: Detail[] }; error?: { message?: string } }>(
          fetchFn,
          url,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nr_getTokenHoldings', params: [owner, `0x${page.toString(16)}`, '0x64'] }),
          },
          secret,
        )
        if (res.error) {
          throw new Error(`nr_getTokenHoldings failed: ${res.error.message ?? 'unknown error'}`)
        }
        const details = res.result?.details ?? []
        for (const d of details) {
          // 文档里字段名就是 tokenDecimails（拼写如此），两种都兼容
          out.push({ address: d.tokenAddress, symbol: d.tokenSymbol ?? null, name: d.tokenName ?? null, decimals: validDecimals(d.tokenDecimals ?? d.tokenDecimails) })
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

const SOURCE = Symbol('source')
type Tagged = DiscoveredToken & { [SOURCE]?: string }

function tag(tokens: DiscoveredToken[], name: string): Tagged[] {
  return tokens.map((t) => ({ ...t, [SOURCE]: (t as Tagged)[SOURCE] ?? name }))
}

/** 按顺序尝试：前一个不支持这条链（返回 null）或出错时用下一个；全部出错时抛出最后一个错误 */
export function firstAvailable(...sources: TokenSource[]): TokenSource {
  return {
    name: sources.map((s) => s.name).join('|'),
    async discover(ctx) {
      let lastError: unknown
      for (const source of sources) {
        try {
          const tokens = await source.discover(ctx)
          if (tokens) {
            return tag(tokens, source.name)
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

/**
 * 合并多个来源（去重，先出现的元数据优先），如“公开列表 + 自己存下来的代币”。
 * 单个来源出错不影响其他来源；全部出错时抛出第一个错误。
 */
export function combine(...sources: TokenSource[]): TokenSource {
  return {
    name: sources.map((s) => s.name).join('+'),
    async discover(ctx) {
      const settled = await Promise.allSettled(sources.map((s) => s.discover(ctx)))
      const ok = settled.flatMap((r, i) => (r.status === 'fulfilled' && r.value ? [tag(r.value, (sources[i] as TokenSource).name)] : []))
      if (!ok.length) {
        const failed = settled.find((r) => r.status === 'rejected')
        if (failed) {
          throw (failed as PromiseRejectedResult).reason
        }
        return null
      }
      return dedupe(ok.flat())
    },
  }
}

/** 默认来源：MetaMask 列表（至少 3 家收录），不支持或不可用时用 CoinGecko 列表。都免费、不需要 Key */
export function defaultTokenSource(): TokenSource {
  return firstAvailable(metamaskTokenList(), coingeckoTokenList())
}

/** 去重键：0x 地址不区分大小写；Tron 的 base58 地址区分大小写，原样比较 */
function addressKey(address: string): string {
  return isTronAddress(address) ? address : address.toLowerCase()
}

function dedupe<T extends DiscoveredToken>(tokens: T[]): T[] {
  const seen = new Map<string, T>()
  for (const t of tokens) {
    const key = addressKey(t.address)
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
  /** 主币 symbol（需要主币价格时）；不需要时为 null */
  nativeSymbol: string | null
  fetch: typeof fetch
}

export interface PriceSource {
  readonly name: string
  /** 返回 去重键（0x 地址小写）→ 美元价格；主币用键 'native'。没有价格的不返回 */
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
  TRX: 'tron',
}

/**
 * DefiLlama 价格（免费、不需要 Key）。minConfidence：DefiLlama 给出的置信度下限（0~1），低于它视为没有价格，默认 0.9。
 * 注意：流动性很差的代币价格可能虚高，展示总资产时建议配合 minUsd 或自己的价格源。
 */
export function defillamaPrices(options: { minConfidence?: number } = {}): PriceSource {
  const minConfidence = options.minConfidence ?? 0.9
  return {
    name: 'defillama',
    async prices({ chainId, tokens, nativeSymbol, fetch: fetchFn }) {
      const result = new Map<string, number>()
      const slug = DEFILLAMA_CHAINS[chainId]
      const nativeId = nativeSymbol ? NATIVE_PRICE_IDS[nativeSymbol.toUpperCase()] : undefined
      const keys = [...(nativeId ? [`coingecko:${nativeId}`] : []), ...(slug ? tokens.map((t) => `${slug}:${t.toLowerCase()}`) : [])]
      const batches: string[][] = []
      for (let i = 0; i < keys.length; i += 100) {
        batches.push(keys.slice(i, i + 100))
      }
      const responses = await Promise.all(
        batches.map((batch) => fetchJson<{ coins?: Record<string, { price?: number; confidence?: number }> }>(fetchFn, `https://coins.llama.fi/prices/current/${batch.join(',')}`)),
      )
      for (const res of responses) {
        for (const [key, coin] of Object.entries(res.coins ?? {})) {
          if (typeof coin.price !== 'number' || !Number.isFinite(coin.price) || (coin.confidence !== undefined && coin.confidence < minConfidence)) {
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

/**
 * 主币在部分链上的 ERC20 映射地址：balanceOf 返回的就是主币余额，列表里出现时要排除，否则主币会被算两次。
 * （Polygon 的 POL、zkSync 的 ETH 系统合约）
 */
const NATIVE_ALIASES: Readonly<Record<number, readonly string[]>> = {
  137: ['0x0000000000000000000000000000000000001010'],
  324: ['0x000000000000000000000000000000000000800a'],
}

export interface OwnerTokensOptions extends CallOverrides {
  /** 代币来源，默认 defaultTokenSource()（MetaMask 列表 → CoinGecko 列表，免费免 Key） */
  source?: TokenSource
  /** 查美元价格：true 用 DefiLlama，也可以传自己的 PriceSource。传了 minUsd 而没设置 prices 时自动用 DefiLlama */
  prices?: boolean | PriceSource
  /** 只保留价值 ≥ minUsd 的代币（没有价格的代币也会被去掉；主币不受影响）。与 prices: false 同时使用会报错 */
  minUsd?: number
  /** 第一项返回主币（用 Provider 的 nativeTokens 配置里的第一个地址查，默认 0xeeee…eeee；配置成 [] 时不返回）。默认 true */
  includeNative?: boolean
  /** 自定义 fetch（代理等场景）；默认全局 fetch */
  fetch?: typeof fetch
  /**
   * 增量扫描开关（默认关闭）：开启后，额外合并“从第一次调用开始，该地址收到过的 ERC20 代币”（扫描 Transfer 事件），
   * 用来补充代币列表里没有的新代币。传对象可以配置进度存储、回扫区块数等，见 TransferScanOptions
   */
  scanTransfers?: boolean | TransferScanOptions
}

export interface OwnedToken {
  token: string
  native: boolean
  /** 余额（最小单位的十进制字符串），由 multicall 在链上核对 */
  balance: string
  /** 精度，由 multicall 在链上核对（不使用来源给的值） */
  decimals: number
  formatted: string
  symbol: string | null
  name: string | null
  logo: string | null
  /** 美元单价；未开启价格或没有价格时为 null */
  price: number | null
  /** 美元价值（formatted × price） */
  value: number | null
  /** 发现这个代币的来源（如 metamask / coingecko / alchemy）；主币为 'native' */
  source: string
}

export async function ownerTokens(provider: Provider, owner: string, options: OwnerTokensOptions = {}): Promise<OwnedToken[]> {
  const { source: baseSource = defaultTokenSource(), prices, minUsd, includeNative = true, fetch: fetchOption, scanTransfers, ...overrides } = options
  const source = scanTransfers ? combine(baseSource, transferScan(scanTransfers === true ? {} : scanTransfers)) : baseSource
  if (minUsd !== undefined && prices === false) {
    throw new Error('minUsd requires prices; remove prices: false or pass a PriceSource')
  }
  const priceSource = prices === true || (prices === undefined && minUsd !== undefined) ? defillamaPrices() : prices || null
  const fetchFn = fetchOption ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const chainId = await provider.getChainId()

  const discovered = await source.discover({ chainId, owner, fetch: fetchFn, provider })
  if (!discovered) {
    throw new Error(`No token source supports chain ${chainId}; pass options.source (e.g. tokenList(url), alchemy({ apiKey }))`)
  }
  const aliases = new Set(NATIVE_ALIASES[chainId] ?? [])
  const candidates = dedupe(discovered).filter(
    (t) =>
      (/^0x[0-9a-fA-F]{40}$/.test(t.address) || isTronAddress(t.address)) &&
      t.address !== ZERO_ADDRESS &&
      !provider.isNativeToken(t.address) &&
      !aliases.has(t.address.toLowerCase()),
  )

  // 主币用 Provider 配置里的主币地址查（默认 0xeeee…eeee）；配置成 [] 时不返回主币
  const nativeAddress = includeNative ? (provider.nativeTokens[0] ?? null) : null
  // 余额在链上核对；来源给的 decimals 先用于这一步（省一次查询），有余额的代币之后再核对精度
  const inputs: BalanceToken[] = candidates.map((t) => (typeof t.decimals === 'number' ? { address: t.address, decimals: t.decimals } : t.address))
  const balances = await provider.balances(owner, nativeAddress ? [nativeAddress, ...inputs] : inputs, overrides)
  const nativeBalance = nativeAddress ? balances[0] : undefined
  const tokenBalances = nativeAddress ? balances.slice(1) : balances
  const held = candidates
    .map((meta, i) => ({ meta, balance: tokenBalances[i] }))
    .filter((x): x is { meta: Tagged; balance: NonNullable<typeof x.balance> } => !!x.balance?.success && x.balance.balance !== '0')

  // 并行：有余额的代币在链上核对精度（并补齐来源没给的 name / symbol）、主币信息（含 nativeSymbol 等配置）、价格
  const [onchain, [nativeInfo]] = await Promise.all([
    held.length ? provider.tokens(held.map((x) => x.meta.address), { ...overrides, fields: ['decimals', 'name', 'symbol'] }) : Promise.resolve([]),
    nativeAddress ? provider.tokens([nativeAddress], { fields: ['name', 'symbol'] }) : Promise.resolve([undefined]),
  ])
  const priceMap = priceSource
    ? await priceSource.prices({ chainId, tokens: held.map((x) => x.meta.address), nativeSymbol: nativeAddress ? (nativeInfo?.symbol ?? null) : null, fetch: fetchFn })
    : new Map<string, number>()
  const valueOf = (formatted: string, price: number | undefined) => (price === undefined ? null : Number(formatted) * price)

  let list: OwnedToken[] = held.flatMap(({ meta, balance }, i) => {
    const chain = onchain[i]
    // 链上读不到精度的不是正常 ERC20，去掉
    if (!chain || chain.decimals === null) {
      return []
    }
    const decimals = chain.decimals
    const formatted = decimals === balance.decimals ? balance.formatted : formatAmount(BigInt(balance.balance), decimals)
    const price = priceMap.get(addressKey(meta.address))
    return [
      {
        token: meta.address,
        native: false,
        balance: balance.balance,
        decimals,
        formatted,
        symbol: meta.symbol || chain.symbol || null,
        name: meta.name || chain.name || null,
        logo: meta.logo ?? null,
        price: price ?? null,
        value: valueOf(formatted, price),
        source: meta[SOURCE] ?? source.name,
      },
    ]
  })
  if (minUsd !== undefined && priceSource) {
    list = list.filter((t) => t.value !== null && t.value >= minUsd)
  }
  // 有价格时按价值从高到低，没有价格的排在后面（保持来源里的顺序）
  if (priceSource) {
    list.sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
  }
  if (nativeAddress && nativeBalance?.success) {
    const price = priceMap.get('native')
    list.unshift({
      token: nativeAddress === NATIVE_TOKEN.toLowerCase() ? NATIVE_TOKEN : nativeAddress,
      native: true,
      balance: nativeBalance.balance,
      decimals: nativeBalance.decimals,
      formatted: nativeBalance.formatted,
      symbol: nativeInfo?.symbol ?? null,
      name: nativeInfo?.name ?? null,
      logo: null,
      price: price ?? null,
      value: valueOf(nativeBalance.formatted, price),
      source: 'native',
    })
  }
  return list
}
