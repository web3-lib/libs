import { SolanaClient, type BalancesOptions, type ClientConfig, type OwnerTokensOptions, type TokensOptions } from './client.js'
import type { RpcSource } from './source.js'
import type { DefaultTokenField, NftDetails, NftOwner, OwnedToken, SolBalance, TokenBalance, TokenDetails, TokenField } from './types.js'

/** 各函数共用的节点参数 */
export interface ShortcutOptions extends ClientConfig {
  /**
   * 节点：RPC URL、URL 数组（主节点 + 备用节点）、web3.js Connection、自定义传输（request(method, params)）。
   * 不传则使用 cluster（默认 mainnet）的内置公共节点
   */
  provider?: RpcSource | readonly RpcSource[]
}

// 复用客户端：多次调用共享连接、批量合并与故障切换状态。按 “配置内容” 分组，组内 URL 按字符串、对象按引用（WeakMap）。
// 配置里有函数（如自定义 fetch）或节点数组含对象时不缓存。
const MAX_CACHED = 32

interface ClientGroup {
  byString: Map<string, SolanaClient>
  byObject: WeakMap<object, SolanaClient>
}

const clientCache = new Map<string, ClientGroup>()

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value)
  if (map.size > MAX_CACHED) {
    map.delete(map.keys().next().value as K)
  }
}

function configKey(config: ClientConfig): string | null {
  try {
    return JSON.stringify(config, (_key, value: unknown) => {
      if (typeof value === 'function') {
        throw new Error('not comparable')
      }
      return value
    })
  } catch {
    return null
  }
}

function sourceKey(source: ShortcutOptions['provider']): string | object | null {
  if (source === undefined) {
    return 'default'
  }
  if (typeof source === 'string') {
    return `url:${source}`
  }
  if (Array.isArray(source)) {
    return source.every((item) => typeof item === 'string') ? `urls:${source.join('\n')}` : null
  }
  return source as object
}

/** 拆出节点参数和函数自己的参数（ownKeys），其余作为客户端配置；值为 undefined 的参数忽略 */
function resolve<T extends ShortcutOptions, K extends keyof T & string = never>(
  options: T,
  ownKeys: readonly K[] = [],
): { client: SolanaClient; own: Pick<T, K> } {
  const { provider, ...others } = options
  const own: Record<string, unknown> = {}
  const config: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(others)) {
    if (value !== undefined) {
      ;((ownKeys as readonly string[]).includes(key) ? own : config)[key] = value
    }
  }
  return { client: getClient(provider, config as ClientConfig), own: own as Pick<T, K> }
}

function getClient(source: ShortcutOptions['provider'], config: ClientConfig): SolanaClient {
  const cfg = configKey(config)
  const key = sourceKey(source)
  if (cfg === null || key === null) {
    return new SolanaClient(source, config)
  }
  let group = clientCache.get(cfg)
  if (!group) {
    group = { byString: new Map(), byObject: new WeakMap() }
    setBounded(clientCache, cfg, group)
  }
  let client = typeof key === 'string' ? group.byString.get(key) : group.byObject.get(key)
  if (!client) {
    client = new SolanaClient(source, config)
    if (typeof key === 'string') {
      setBounded(group.byString, key, client)
    } else {
      group.byObject.set(key, client)
    }
  }
  return client
}

export interface GetBalancesOptions extends BalancesOptions, ShortcutOptions {}

/**
 * 批量查余额（SOL + SPL Token + Token-2022），返回原始余额、decimals 和换算后的数值。
 *
 * ```ts
 * import { NATIVE_MINT, getBalances } from '@w3lib/solana-batch-call'
 *
 * await getBalances(owner, [NATIVE_MINT, USDC])                        // 指定代币：免费公共节点也能用
 * await getBalances(owner, [NATIVE_MINT, USDC], { symbol: true })
 * await getBalances(owner, undefined, { provider: 'https://my-rpc…' })  // 全部持仓：需要支持 getTokenAccountsByOwner 的节点
 * ```
 */
export function getBalances(owner: string, mints?: readonly string[], options: GetBalancesOptions = {}): Promise<TokenBalance[]> {
  const { client, own } = resolve(options, ['symbol', 'scan'])
  return client.balances(owner, mints, own)
}

/** 批量查多个地址的 SOL 余额（一次 getMultipleAccounts） */
export function getSolBalances(addresses: readonly string[], options: ShortcutOptions = {}): Promise<SolBalance[]> {
  return resolve(options).client.solBalances(addresses)
}

export interface GetTokensOptions<F extends TokenField = DefaultTokenField> extends TokensOptions<F>, ShortcutOptions {}

/**
 * 批量查代币详情，字段可选（默认 name / symbol / decimals）。
 *
 * ```ts
 * await getTokens([USDC, PYUSD], { fields: ['name', 'symbol', 'decimals', 'supply', 'tokenProgram'] })
 * ```
 */
export function getTokens<const F extends TokenField = DefaultTokenField>(mints: readonly string[], options: GetTokensOptions<F> = {}): Promise<TokenDetails<F>[]> {
  const { client, own } = resolve(options, ['fields'])
  return client.tokens<F>(mints, { fields: own.fields })
}

/** 批量查 NFT 元数据（名称、uri、所属集合、版税、创作者等） */
export function getNfts(mints: readonly string[], options: ShortcutOptions = {}): Promise<NftDetails[]> {
  return resolve(options).client.nfts(mints)
}

/** 批量查 NFT 持有人 */
export function getNftOwners(mints: readonly string[], options: ShortcutOptions = {}): Promise<NftOwner[]> {
  return resolve(options).client.nftOwners(mints)
}

/** 查某地址持有的全部 NFT（需要支持 getTokenAccountsByOwner 的节点） */
export function getOwnerNfts(owner: string, options: ShortcutOptions = {}): Promise<NftDetails[]> {
  return resolve(options).client.ownerNfts(owner)
}

export interface GetOwnerTokensOptions extends OwnerTokensOptions, ShortcutOptions {}

/**
 * 列出持有人拥有的全部代币（SOL 在第一位），带 name / symbol，适合做资产列表。
 * 需要支持 getTokenAccountsByOwner 的节点。
 *
 * ```ts
 * await getOwnerTokens(owner, { provider: 'https://my-rpc…' })
 * // [{ token: NATIVE_MINT, native: true, name: 'Solana', symbol: 'SOL', formatted: '1.5', … }, { token: USDC, name: 'USD Coin', … }]
 * ```
 */
export function getOwnerTokens(owner: string, options: GetOwnerTokensOptions = {}): Promise<OwnedToken[]> {
  const { client, own } = resolve(options, ['metadata', 'includeNative', 'includeZero', 'includeNfts'])
  return client.ownerTokens(owner, own)
}

/** 测试用：按参数取（或创建）客户端，用于验证缓存复用（不在包的公开导出里） */
export function resolveClientForTest(options: ShortcutOptions): SolanaClient {
  return resolve(options).client
}

/** 测试用：清空客户端缓存 */
export function resetClientCache(): void {
  clientCache.clear()
}
