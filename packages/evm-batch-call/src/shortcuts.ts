import type { CallOverrides } from './aggregate.js'
import type { OwnedToken, OwnerTokensOptions } from './owner.js'
import type { BalanceToken, DefaultTokenField, TokenAllowance, TokenBalance, TokenDetails, TokenField } from './erc20.js'
import type {
  DefaultNftCollectionField,
  Erc1155Balance,
  NftBalance,
  NftCollection,
  NftCollectionField,
  NftCollectionsOptions,
  NftItem,
  NftOwner,
  NftTokenUri,
} from './nft.js'
import { Provider, type BalancesOptions, type ProviderConfig, type TokensOptions } from './provider.js'
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
   */
  provider?: ProviderSource | readonly ProviderSource[]
}

export interface GetBalancesOptions extends BalancesOptions, ShortcutProviderOptions {}

export interface GetTokensOptions<F extends TokenField = DefaultTokenField> extends TokensOptions<F>, ShortcutProviderOptions {}

// 复用 Provider：多次调用共享连接、multicall 地址判定和自动合并队列。
// 按 “chainId + 配置内容” 分组，组内 URL 按字符串、钱包 / Provider 对象按引用（WeakMap，不阻止回收）。
// 不缓存的情况：配置里有函数等无法比较内容的值；含对象的节点数组；没传 chainId 且节点是对象
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

function sourceKey(chainId: number | undefined, source: ShortcutProviderOptions['provider']): string | object | null {
  if (source === undefined) {
    return 'default'
  }
  if (typeof source === 'string') {
    return `url:${source}`
  }
  if (Array.isArray(source)) {
    // URL 数组每次调用都是新数组，按内容缓存
    return source.every((item) => typeof item === 'string') ? `urls:${source.join('\n')}` : null
  }
  return chainId === undefined ? null : (source as object)
}

function getProvider(chainId: number | undefined, source: ShortcutProviderOptions['provider'], config: ProviderConfig): Provider {
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

/** 拆出节点参数、调用参数和函数自己的参数（ownKeys），其余作为 Provider 配置；值为 undefined 的参数忽略 */
function resolve<T extends ShortcutOptions, K extends keyof T & string = never>(
  options: T,
  ownKeys: readonly K[] = [],
): { provider: Provider; overrides: CallOverrides; own: Pick<T, K> } {
  const { chainId, provider, blockTag, from, ...others } = options
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
    overrides: { blockTag, from },
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
 * // [{ token: NATIVE_TOKEN, native: true, balance: '1500000000000000000', decimals: 18, formatted: '1.5', success: true }, ...]
 * ```
 */
export function getBalances(owner: string, tokens: readonly BalanceToken[], options: GetBalancesOptions = {}): Promise<TokenBalance[]> {
  const { provider, overrides, own } = resolve(options, ['symbol'])
  return provider.balances(owner, tokens, { ...overrides, symbol: own.symbol })
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
  const { provider, overrides, own } = resolve(options, ['fields'])
  return provider.tokens<F>(tokens, { ...overrides, fields: own.fields })
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
  options: ShortcutOptions = {},
): Promise<TokenAllowance[]> {
  const { provider, overrides } = resolve(options)
  return provider.allowances(owner, spender, tokens, overrides)
}

export interface GetNftCollectionsOptions<F extends NftCollectionField = DefaultNftCollectionField>
  extends NftCollectionsOptions<F>,
    ShortcutProviderOptions {}

/**
 * 批量查 NFT 集合信息，字段可选（默认 standard / name / symbol）。
 *
 * ```ts
 * await getNftCollections([BAYC, MAYC], { chainId: 1, fields: ['standard', 'name', 'totalSupply'] })
 * // [{ address: BAYC, standard: 'ERC721', name: 'BoredApeYachtClub', totalSupply: '10000', success: true }, ...]
 * ```
 */
export function getNftCollections<const F extends NftCollectionField = DefaultNftCollectionField>(
  collections: readonly string[],
  options: GetNftCollectionsOptions<F> = {},
): Promise<NftCollection<F>[]> {
  const { provider, overrides, own } = resolve(options, ['fields'])
  return provider.nftCollections<F>(collections, { ...overrides, fields: own.fields })
}

/** 批量查 ERC721 持有数量：`await getNftBalances(user, [BAYC, MAYC], { chainId: 1 })` */
export function getNftBalances(owner: string, collections: readonly string[], options: ShortcutOptions = {}): Promise<NftBalance[]> {
  const { provider, overrides } = resolve(options)
  return provider.nftBalances(owner, collections, overrides)
}

/** 批量查 ERC721 持有人：`await getNftOwners([{ contract: BAYC, tokenId: 1 }], { chainId: 1 })` */
export function getNftOwners(items: readonly NftItem[], options: ShortcutOptions = {}): Promise<NftOwner[]> {
  const { provider, overrides } = resolve(options)
  return provider.nftOwners(items, overrides)
}

export interface GetNftTokenUrisOptions extends ShortcutOptions {
  /** 把 ipfs://xxx 转成 `${ipfsGateway}xxx`，如 'https://ipfs.io/ipfs/' */
  ipfsGateway?: string
}

/**
 * 批量查 NFT 元数据地址（ERC721 tokenURI / ERC1155 uri 自动兼容）。
 *
 * ```ts
 * await getNftTokenUris([{ contract: BAYC, tokenId: 1 }], { chainId: 1, ipfsGateway: 'https://ipfs.io/ipfs/' })
 * // [{ contract: BAYC, tokenId: '1', uri: 'https://ipfs.io/ipfs/Qm…/1', success: true }]
 * ```
 */
export function getNftTokenUris(items: readonly NftItem[], options: GetNftTokenUrisOptions = {}): Promise<NftTokenUri[]> {
  const { provider, overrides, own } = resolve(options, ['ipfsGateway'])
  return provider.nftTokenUris(items, { ...overrides, ipfsGateway: own.ipfsGateway })
}

/** 批量查 ERC1155 余额：`await getErc1155Balances(user, [{ contract, tokenId: 1 }], { chainId: 137 })` */
export function getErc1155Balances(owner: string, items: readonly NftItem[], options: ShortcutOptions = {}): Promise<Erc1155Balance[]> {
  const { provider, overrides } = resolve(options)
  return provider.erc1155Balances(owner, items, overrides)
}

export interface GetOwnerTokensOptions extends OwnerTokensOptions, ShortcutProviderOptions {}

/**
 * 列出持有人拥有的代币（资产列表）。默认用免费公开代币列表发现代币，余额用 multicall 在链上核对。
 *
 * ```ts
 * await getOwnerTokens(user, { chainId: 56 })                                  // 免费，只能发现公开列表里的代币
 * await getOwnerTokens(user, { chainId: 1, prices: true, minUsd: 1 })          // 带美元价值，过滤零头和垃圾币
 * await getOwnerTokens(user, { chainId: 56, source: alchemy({ apiKey }) })     // 用 Alchemy 查全部历史持仓
 * ```
 */
export function getOwnerTokens(owner: string, options: GetOwnerTokensOptions = {}): Promise<OwnedToken[]> {
  const { provider, overrides, own } = resolve(options, ['source', 'prices', 'minUsd', 'includeNative', 'fetch'])
  return provider.ownerTokens(owner, { ...overrides, ...own })
}

/** 测试用：按参数取（或创建）Provider，用于验证缓存复用（不在包的公开导出里） */
export function resolveProviderForTest(options: ShortcutOptions): Provider {
  return resolve(options).provider
}

/** 测试用：清空 getBalances / getTokens 的 Provider 缓存 */
export function resetBalancesProviderCache(): void {
  providerCache.clear()
}
