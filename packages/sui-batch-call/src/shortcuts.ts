import { SuiClient, type BalancesOptions, type ClientConfig, type CoinDetails, type NftDetails, type NftsOptions, type ObjectsOptions, type OwnedObjectsOptions, type RequestOptions, type SuiSource, type TokenBalance } from './client.js'
import type { SuiObject } from './services.js'

/** 各函数共用的节点参数 */
export interface ShortcutOptions extends ClientConfig {
  /** 节点：gRPC-web URL、URL 数组（主节点 + 备用节点）或自己的 GrpcTransport。不传时用 network（默认 mainnet）的内置公共节点 */
  provider?: SuiSource | readonly SuiSource[]
}

// 复用客户端：多次调用共享故障切换状态。按节点 URL + 网络 + 其他可序列化的配置分组；配置里有函数或自定义传输对象时不缓存
const MAX_CACHED = 32
const clients = new Map<string, SuiClient>()

export function clientFor(options: ShortcutOptions): SuiClient {
  const { provider, ...config } = options
  const sources = provider === undefined ? [] : Array.isArray(provider) ? provider : [provider]
  const cacheable = sources.every((s) => typeof s === 'string') && config.fetch === undefined
  if (!cacheable) return new SuiClient(provider as SuiSource | readonly SuiSource[] | undefined, config)
  const key = JSON.stringify([sources, config.network ?? 'mainnet', config.timeout, config.headers, config.retries, config.concurrency])
  let client = clients.get(key)
  if (!client) {
    client = new SuiClient(provider as SuiSource | readonly SuiSource[] | undefined, config)
    clients.set(key, client)
    if (clients.size > MAX_CACHED) clients.delete(clients.keys().next().value as string)
  }
  return client
}

/** 从选项里分出节点参数和查询参数 */
function split<T extends ShortcutOptions>(options: T): [SuiClient, Omit<T, keyof ShortcutOptions>] {
  const { provider, network, timeout, headers, fetch, retries, concurrency, ...rest } = options
  return [clientFor({ provider, network, timeout, headers, fetch, retries, concurrency }), rest]
}

export interface GetBalancesOptions extends BalancesOptions, ShortcutOptions {
  /** 只查这些代币（结果与它一一对应）；不传时返回持有的全部代币 */
  coinTypes?: readonly string[]
}

/**
 * 查一个地址的代币余额。
 *
 * ```ts
 * await getBalances(owner)                                  // 持有的全部代币（主网公共节点）
 * await getBalances(owner, { coinTypes: [SUI_COIN_TYPE, USDC], provider: 'https://my-node…' })
 * ```
 */
export function getBalances(owner: string, options: GetBalancesOptions = {}): Promise<TokenBalance[]> {
  const [client, { coinTypes, ...rest }] = split(options)
  return client.balances(owner, coinTypes, rest)
}

/** 多个地址一次查 */
export function getMultiBalances(queries: ReadonlyArray<{ owner: string; coinTypes?: readonly string[] }>, options: BalancesOptions & ShortcutOptions = {}): Promise<TokenBalance[][]> {
  const [client, rest] = split(options)
  return client.multiBalances(queries, rest)
}

/** 代币信息（精度、名称、symbol、图标、总供应量） */
export function getCoins(coinTypes: readonly string[], options: RequestOptions & ShortcutOptions = {}): Promise<CoinDetails[]> {
  const [client, rest] = split(options)
  return client.coins(coinTypes, rest)
}

/** 按 ID 读对象 */
export function getObjects(ids: readonly string[], options: ObjectsOptions & ShortcutOptions = {}): Promise<Array<SuiObject | null>> {
  const [client, rest] = split(options)
  return client.objects(ids, rest)
}

/** 地址拥有的对象 */
export function getOwnedObjects(owner: string, options: OwnedObjectsOptions & ShortcutOptions = {}): Promise<SuiObject[]> {
  const [client, rest] = split(options)
  return client.ownedObjects(owner, rest)
}

/** 地址持有的 NFT（Display 由节点渲染） */
export function getNfts(owner: string, options: NftsOptions & ShortcutOptions = {}): Promise<NftDetails[]> {
  const [client, rest] = split(options)
  return client.nfts(owner, rest)
}
