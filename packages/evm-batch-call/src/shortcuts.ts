import type { CallOverrides } from './aggregate.js'
import type { BalanceToken, DefaultTokenField, RawTokenAllowance, RawTokenBalance, TokenAllowance, TokenBalance, TokenDetails, TokenField } from './erc20.js'
import { Provider, type AllowancesOptions, type BalancesOptions, type BalancesQuery, type ProviderConfig, type TokensOptions } from './provider.js'
import type { ProviderSource } from './source.js'

/** getBalances / getTokens 共用的节点参数 */
export interface ShortcutProviderOptions extends ProviderConfig {
  /** 链 ID。传了 provider 时可省略（从节点识别，结果会缓存）；不传 provider 时必填（用于选择内置公共节点） */
  chainId?: number | string
  /**
   * 节点，与 `new Provider(...)` 相同，不传则使用内置公共节点：
   * - RPC URL，或 URL 数组（主节点 + 备用节点）
   * - ethers Provider
   * - 浏览器插件钱包：`window.ethereum`（EIP-1193）、`window.tronWeb`
   * - 混合数组，如 `[window.ethereum, 'https://…']`：钱包出错或不在这条链上时自动用后面的节点
   * - 已创建的 Provider 实例：直接使用（chainId 和其他节点配置以实例为准，不能再传）
   */
  provider?: ProviderSource | readonly ProviderSource[] | Provider
}

export interface GetBalancesOptions extends BalancesOptions, ShortcutProviderOptions {}

export interface GetTokensOptions<F extends TokenField = DefaultTokenField> extends TokensOptions<F>, ShortcutProviderOptions {}

export interface GetAllowancesOptions extends AllowancesOptions, ShortcutProviderOptions {}

// 复用 Provider：多次调用共享连接、multicall 地址判定和自动合并队列。
// 按 “chainId + 配置内容” 分组，组内 URL 按字符串、钱包 / Provider 对象按引用（WeakMap，不阻止回收）；
// 钱包 + URL 的混合数组按 “对象编号 + URL” 组合成字符串 key（对象编号用 WeakMap 分配，缓存条数有上限）。
// 不缓存的情况：配置里有函数等无法比较内容的值；没传 chainId 且节点里有对象
// （钱包可能切链，每次按当前链新建；chainId 识别本身有缓存，切链时自动失效，不会每次都发请求）
interface ProviderGroup {
  byString: Map<string, Provider>
  byObject: WeakMap<object, Provider>
}

const providerCache = new Map<string, ProviderGroup>()

/** 缓存上限（分组数、每组 URL 数），超出时淘汰最早加入的；对象来源用 WeakMap，随对象回收 */
const MAX_CACHED = 32

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value)
  if (map.size > MAX_CACHED) {
    map.delete(map.keys().next().value as K)
  }
}

function configKey(config: ProviderConfig): string | null {
  try {
    return JSON.stringify(config, (_key, value: unknown) => {
      if (typeof value === 'function') {
        throw new Error('not comparable')
      }
      return typeof value === 'bigint' ? value.toString() : value
    })
  } catch {
    return null
  }
}

/** 对象来源（钱包、ethers Provider）的编号，用于混合数组的缓存 key；WeakMap 不阻止对象被回收 */
const objectIds = new WeakMap<object, number>()
let nextObjectId = 0

function objectId(value: object): number {
  let id = objectIds.get(value)
  if (id === undefined) {
    id = ++nextObjectId
    objectIds.set(value, id)
  }
  return id
}

function sourceKey(chainId: number | undefined, source: ProviderSource | readonly ProviderSource[] | undefined): string | object | null {
  if (source === undefined) {
    return 'default'
  }
  if (typeof source === 'string') {
    return `url:${source}`
  }
  if (Array.isArray(source)) {
    // URL 数组每次调用都是新数组，按内容缓存
    if (source.every((item) => typeof item === 'string')) {
      return `urls:${source.join('\n')}`
    }
    // 钱包 + URL：对象按编号、URL 按内容
    return chainId === undefined ? null : `mixed:${source.map((item) => (typeof item === 'string' ? `url:${item}` : `obj:${objectId(item as object)}`)).join('\n')}`
  }
  return chainId === undefined ? null : (source as object)
}

function getProvider(chainId: number | undefined, input: ShortcutProviderOptions['provider'], config: ProviderConfig): Provider {
  if (input instanceof Provider) {
    if (chainId !== undefined || Object.keys(config).length) {
      throw new Error('chainId and provider config must be set on the Provider instance itself, not passed alongside it')
    }
    return input
  }
  const source = input
  if (chainId === undefined && source === undefined) {
    throw new Error('getBalances / getTokens requires chainId or provider')
  }
  const create = () => (chainId === undefined ? new Provider(source as ProviderSource, config) : new Provider(chainId, source, config))
  const cfg = configKey(config)
  const key = sourceKey(chainId, source)
  if (cfg === null || key === null) {
    return create()
  }
  const groupKey = `${chainId ?? 'auto'}|${cfg}`
  let group = providerCache.get(groupKey)
  if (!group) {
    group = { byString: new Map(), byObject: new WeakMap() }
    setBounded(providerCache, groupKey, group)
  }
  let provider = typeof key === 'string' ? group.byString.get(key) : group.byObject.get(key)
  if (!provider) {
    provider = create()
    if (typeof key === 'string') {
      setBounded(group.byString, key, provider)
    } else {
      group.byObject.set(key, provider)
    }
  }
  return provider
}

// ---- 各查询函数：节点参数都相同 ----

export interface ShortcutOptions extends CallOverrides, ShortcutProviderOptions {}

/**
 * 拆出节点参数、调用参数和函数自己的参数（ownKeys），其余作为 Provider 配置；值为 undefined 的参数忽略。
 * 子路径（/nft、/owner）的快捷函数也用它，与 getBalances 共享 Provider 缓存
 */
export function resolve<T extends ShortcutOptions, K extends keyof T & string = never>(
  options: T,
  ownKeys: readonly K[] = [],
): { provider: Provider; overrides: CallOverrides; own: Pick<T, K> } {
  const { chainId, provider, blockTag, from, signal, minBlock, ...others } = options
  const own: Record<string, unknown> = {}
  const config: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(others)) {
    if (value !== undefined) {
      ;((ownKeys as readonly string[]).includes(key) ? own : config)[key] = value
    }
  }
  return {
    // null / 空字符串（如状态里还没有 chainId）按“未传”处理，走自动识别，而不是变成 chainId 0
    provider: getProvider(chainId === undefined || chainId === null || chainId === '' ? undefined : Number(chainId), provider, config as ProviderConfig),
    overrides: { blockTag, from, signal, minBlock },
    own: own as Pick<T, K>,
  }
}

/**
 * 批量查余额（主币 + 代币，一次请求），返回原始余额、decimals 和换算后的数值。
 *
 * ```ts
 * import { NATIVE_TOKEN, getBalances } from '@w3lib/evm-batch-call'
 *
 * await getBalances(user, [NATIVE_TOKEN, USDT], { chainId: 56 })                 // 内置公共节点
 * await getBalances(user, tokens, { provider: window.ethereum })                  // 钱包，chainId 自动识别
 * await getBalances(user, tokens, { provider: 'https://bsc-dataseed.bnbchain.org' })
 * await getBalances(user, tokens, { chainId: 56, provider: [window.ethereum, 'https://…'] }) // 钱包优先，失败用公共节点
 * await getBalances(user, tokens, { chainId: 56, symbol: true })                 // 同时返回 symbol
 * await getBalances(user, tokens, { chainId: 56, decimals: false })             // 只查余额，不带 decimals / formatted
 * // [{ token: NATIVE_TOKEN, native: true, balance: '1500000000000000000', decimals: 18, formatted: '1.5', success: true }, ...]
 * ```
 */
export function getBalances(owner: string, tokens: readonly BalanceToken[], options: GetBalancesOptions & { decimals: false }): Promise<RawTokenBalance[]>
export function getBalances(owner: string, tokens: readonly BalanceToken[], options?: GetBalancesOptions): Promise<TokenBalance[]>
export function getBalances(owner: string, tokens: readonly BalanceToken[], options: GetBalancesOptions = {}): Promise<Array<TokenBalance | RawTokenBalance>> {
  const { provider, overrides, own } = resolve(options, ['symbol', 'decimals', 'withBlock'])
  return provider.balances(owner, tokens, { ...overrides, ...own })
}

/**
 * 多个钱包一次查（同一条链上合成一次 multicall），结果与 queries 一一对应。节点参数与 getBalances 相同。
 *
 * ```ts
 * const [a, b] = await getMultiBalances([{ owner: walletA, tokens: [NATIVE_TOKEN, USDT] }, { owner: walletB, tokens: [USDT] }], { chainId: 56 })
 * ```
 */
export function getMultiBalances(queries: readonly BalancesQuery[], options: GetBalancesOptions & { decimals: false }): Promise<RawTokenBalance[][]>
export function getMultiBalances(queries: readonly BalancesQuery[], options?: GetBalancesOptions): Promise<TokenBalance[][]>
export function getMultiBalances(queries: readonly BalancesQuery[], options: GetBalancesOptions = {}): Promise<Array<Array<TokenBalance | RawTokenBalance>>> {
  const { provider, overrides, own } = resolve(options, ['symbol', 'decimals', 'withBlock'])
  return provider.multiBalances(queries, { ...overrides, ...own })
}

/**
 * 批量查 ERC20 代币详情（一次请求），可以选择返回哪些字段。节点参数与 getBalances 相同。
 *
 * ```ts
 * import { NATIVE_TOKEN, getTokens } from '@w3lib/evm-batch-call'
 *
 * await getTokens([USDT, NATIVE_TOKEN], { chainId: 56 })            // 默认 name / symbol / decimals
 * await getTokens([USDT], { provider: window.ethereum, fields: ['symbol', 'decimals', 'totalSupply'] })
 * // [{ address: USDT, native: false, symbol: 'USDT', decimals: 18, totalSupply: '…', totalSupplyFormatted: '…', success: true }]
 * ```
 */
export function getTokens<const F extends TokenField = DefaultTokenField>(
  tokens: readonly string[],
  options: GetTokensOptions<F> = {},
): Promise<TokenDetails<F>[]> {
  const { provider, overrides, own } = resolve(options, ['fields', 'withBlock'])
  return provider.tokens<F>(tokens, { ...overrides, ...own })
}

/**
 * 批量查 ERC20 授权额度（一次请求）。
 *
 * ```ts
 * const [usdt] = await getAllowances(user, router, [USDT], { chainId: 56 })
 * if (!usdt.unlimited && BigInt(usdt.allowance) < amount) { // 需要 approve
 * ```
 */
export function getAllowances(
  owner: string,
  spender: string,
  tokens: readonly BalanceToken[],
  options: GetAllowancesOptions & { decimals: false },
): Promise<RawTokenAllowance[]>
export function getAllowances(owner: string, spender: string, tokens: readonly BalanceToken[], options?: GetAllowancesOptions): Promise<TokenAllowance[]>
export function getAllowances(
  owner: string,
  spender: string,
  tokens: readonly BalanceToken[],
  options: GetAllowancesOptions = {},
): Promise<Array<TokenAllowance | RawTokenAllowance>> {
  const { provider, overrides, own } = resolve(options, ['decimals', 'withBlock'])
  return provider.allowances(owner, spender, tokens, { ...overrides, ...own })
}

/** 测试用：按参数取（或创建）Provider，用于验证缓存复用（不在包的公开导出里） */
export function resolveProviderForTest(options: ShortcutOptions): Provider {
  return resolve(options).provider
}

/** 测试用：清空 getBalances / getTokens 的 Provider 缓存 */
export function resetBalancesProviderCache(): void {
  providerCache.clear()
}
