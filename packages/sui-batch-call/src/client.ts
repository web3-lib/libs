import { SUI_COIN_TYPE, coinTypeOfObject, isValidSuiAddress, normalizeStructTag, normalizeSuiAddress } from './address.js'
import { DEFAULT_GRPC_URLS, SUI_DECIMALS, type SuiNetwork } from './constants.js'
import { formatUnits } from './format.js'
import { FallbackTransport, GrpcWebTransport, type CallOptions, type GrpcTransport, type GrpcWebOptions } from './grpc.js'
import { batchGetObjects, getBalance, getCoinInfo, getServiceInfo, listBalances, listOwnedObjects, type CoinInfo, type ServiceInfo, type SuiObject } from './services.js'

/** 节点：gRPC-web 的 URL，或自己的 GrpcTransport */
export type SuiSource = string | GrpcTransport

export interface ClientConfig extends Pick<GrpcWebOptions, 'timeout' | 'headers' | 'fetch' | 'retries'> {
  /** 网络，默认 'mainnet'：不传节点时用它的内置公共节点；传了节点时按响应头核对节点的网络 */
  network?: SuiNetwork
  /** 同时发出的请求数上限，默认 16（每个代币 / 每页一个请求，大批量时限流） */
  concurrency?: number
}

export interface RequestOptions {
  signal?: AbortSignal
  /** 要求节点至少到这个 checkpoint（如刚执行的交易所在的 checkpoint）；落后的节点换下一个，都落后时等一会儿再试 */
  minCheckpoint?: number
}

export type FailureReason = 'invalid-address' | 'invalid-type' | 'not-found'

export interface TokenBalance {
  /** 代币类型（规范化后的完整格式，如 0x000…002::sui::SUI） */
  token: string
  /** 是否是 SUI */
  native: boolean
  /** 余额（最小单位的十进制字符串） */
  balance: string
  /** 读不到代币信息时为 null（这时 formatted 也为 null） */
  decimals: number | null
  formatted: string | null
  /** symbol: true 时返回 */
  symbol?: string | null
  success: boolean
  error?: FailureReason
  /** withCheckpoint / minCheckpoint 时返回：读取时节点的 checkpoint（多个请求时取最小的） */
  checkpoint?: number
}

export interface BalancesOptions extends RequestOptions {
  /** 同时返回 symbol（多读代币信息，有缓存） */
  symbol?: boolean
  /** 返回读取时节点的 checkpoint */
  withCheckpoint?: boolean
}

export interface CoinDetails {
  /** 代币类型（规范化后） */
  token: string
  decimals: number | null
  name: string | null
  symbol: string | null
  description: string | null
  iconUrl: string | null
  /** 总供应量（最小单位）；读不到 TreasuryCap 时为 null */
  totalSupply: string | null
  success: boolean
  error?: FailureReason
}

/** objects 可以读的字段（对应 gRPC 的 read mask） */
export type ObjectField = 'type' | 'owner' | 'json' | 'display' | 'balance' | 'previousTransaction' | 'storageRebate' | 'contents'

const FIELD_PATHS: Record<ObjectField, string> = {
  type: 'object_type',
  owner: 'owner',
  json: 'json',
  display: 'display',
  balance: 'balance',
  previousTransaction: 'previous_transaction',
  storageRebate: 'storage_rebate',
  contents: 'contents',
}

export interface ObjectsOptions extends RequestOptions {
  /** 默认 ['type', 'owner']；对象 ID、版本、摘要总是返回 */
  fields?: readonly ObjectField[]
}

export interface OwnedObjectsOptions extends ObjectsOptions {
  /** 类型过滤：完整类型或前缀（如 '0x2::coin::Coin'、某个包的地址） */
  type?: string
  /** 最多返回多少个，默认全部（自动翻页） */
  limit?: number
}

export interface NftDetails {
  objectId: string
  type: string | null
  /** Display 里的常用字段；没有 Display 或没有这个字段时为 null */
  name: string | null
  description: string | null
  imageUrl: string | null
  link: string | null
  projectUrl: string | null
  creator: string | null
  /** Display 渲染出的全部字段；没有 Display 时为 null（这时上面的字段取自对象内容） */
  display: Record<string, unknown> | null
}

export interface NftsOptions extends RequestOptions {
  /** 只要这个类型（或前缀）的对象 */
  type?: string
  /**
   * 默认只返回像 NFT 的对象：有 Display，或内容里有图片字段（image_url / img_url / url）。
   * true 时返回拥有的全部非代币对象
   */
  all?: boolean
  limit?: number
}

/** 代币信息缓存：精度 / 名称 / symbol 基本不变，按网络 + 类型缓存（进程内共享） */
const coinCache = new Map<string, CoinInfo | null>()
const MAX_CACHED_COINS = 10_000

/** 测试用：清空代币信息缓存 */
export function resetCoinCache(): void {
  coinCache.clear()
}

/** 并发数为 limit 的 map，结果按输入顺序 */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

const minOf = (values: ReadonlyArray<number | null>) => {
  const list = values.filter((v): v is number => v !== null)
  return list.length ? Math.min(...list) : undefined
}

/**
 * Sui 的批量读取：通过 gRPC-web 访问全节点（Sui 已停用 JSON-RPC），多节点故障切换。
 *
 * ```ts
 * const sui = new SuiClient()                                    // 主网内置公共节点
 * const sui = new SuiClient(['https://my-node…', 'https://fullnode.mainnet.sui.io'])
 * await sui.balances(owner)                                      // 持有的全部代币
 * await sui.balances(owner, [SUI_COIN_TYPE, USDC])               // 指定代币
 * ```
 */
export class SuiClient {
  readonly network: SuiNetwork
  readonly transport: GrpcTransport
  readonly #concurrency: number

  constructor(source?: SuiSource | readonly SuiSource[], config: ClientConfig = {}) {
    this.network = config.network ?? 'mainnet'
    const list = source === undefined ? DEFAULT_GRPC_URLS[this.network] : Array.isArray(source) ? source : [source as SuiSource]
    if (!list.length) throw new Error('No Sui node configured')
    const nodes = list.map((s: SuiSource) => (typeof s === 'string' ? new GrpcWebTransport(s, { timeout: config.timeout, headers: config.headers, fetch: config.fetch, retries: config.retries }) : s))
    this.transport = new FallbackTransport(nodes, { network: this.network })
    this.#concurrency = Math.max(1, config.concurrency ?? 16)
  }

  #call(options?: RequestOptions): CallOptions {
    return { signal: options?.signal, minCheckpoint: options?.minCheckpoint }
  }

  /** 节点信息：网络、epoch、最新 checkpoint */
  serviceInfo(options?: RequestOptions): Promise<ServiceInfo> {
    return getServiceInfo(this.transport, this.#call(options))
  }

  /**
   * 代币余额。不传 coinTypes 时返回地址持有的全部代币（余额为 0 的不返回）；传了时与 coinTypes 一一对应。
   * 精度和 symbol 从代币信息读（有缓存）
   */
  async balances(owner: string, coinTypes?: readonly string[], options: BalancesOptions = {}): Promise<TokenBalance[]> {
    const fail = (token: string, error: FailureReason): TokenBalance => ({ token, native: false, balance: '0', decimals: null, formatted: null, ...(options.symbol ? { symbol: null } : {}), success: false, error })
    if (!isValidSuiAddress(owner)) {
      // 指定了代币时逐项标记失败（与输入一一对应）；查全部代币时没有可对应的项，直接报错
      if (coinTypes === undefined) throw new Error(`Invalid Sui address: ${owner}`)
      return coinTypes.map((t) => fail(t, 'invalid-address'))
    }
    const address = normalizeSuiAddress(owner)
    const call = this.#call(options)
    let entries: Array<{ token: string; balance: bigint | null; error?: FailureReason }>
    const checkpoints: Array<number | null> = []
    if (coinTypes === undefined) {
      const all = await listBalances(this.transport, address, call)
      checkpoints.push(all.checkpoint)
      entries = all.balances.filter((b) => b.balance > 0n).map((b) => ({ token: b.coinType, balance: b.balance }))
    } else {
      entries = await mapPool(coinTypes, this.#concurrency, async (raw) => {
        let token: string
        try {
          token = normalizeStructTag(raw)
        } catch {
          return { token: raw, balance: null, error: 'invalid-type' as const }
        }
        const { balance, checkpoint } = await getBalance(this.transport, address, token, call)
        checkpoints.push(checkpoint)
        return { token, balance: balance.balance }
      })
    }
    const infos = await this.#coinInfos(
      entries.filter((e) => !e.error).map((e) => e.token),
      options,
    )
    const checkpoint = options.withCheckpoint || options.minCheckpoint !== undefined ? minOf(checkpoints) : undefined
    return entries.map((e): TokenBalance => {
      if (e.error) return fail(e.token, e.error)
      const info = infos.get(e.token)
      const native = e.token === SUI_COIN_TYPE
      // 没有代币信息、余额也是 0：多半是类型写错了（不存在的代币）
      if (!native && !info && (e.balance ?? 0n) === 0n) return fail(e.token, 'not-found')
      const decimals = native ? SUI_DECIMALS : (info?.decimals ?? null)
      const balance = e.balance ?? 0n
      return {
        token: e.token,
        native,
        balance: balance.toString(),
        decimals,
        formatted: decimals === null ? null : formatUnits(balance, decimals),
        ...(options.symbol ? { symbol: native ? 'SUI' : (info?.symbol ?? null) } : {}),
        success: true,
        ...(checkpoint !== undefined ? { checkpoint } : {}),
      }
    })
  }

  /** 多个地址一次查：结果与 queries 一一对应 */
  multiBalances(queries: ReadonlyArray<{ owner: string; coinTypes?: readonly string[] }>, options: BalancesOptions = {}): Promise<TokenBalance[][]> {
    return mapPool(queries, Math.max(1, Math.floor(this.#concurrency / 4)), (q) => this.balances(q.owner, q.coinTypes, options))
  }

  /** 读代币信息（带缓存）；代币不存在时值为 null */
  async #coinInfos(types: readonly string[], options: RequestOptions): Promise<Map<string, CoinInfo | null>> {
    const out = new Map<string, CoinInfo | null>()
    const missing: string[] = []
    for (const t of new Set(types)) {
      const key = `${this.network}:${t}`
      if (coinCache.has(key)) out.set(t, coinCache.get(key) ?? null)
      else missing.push(t)
    }
    const fetched = await mapPool(missing, this.#concurrency, (t) => getCoinInfo(this.transport, t, this.#call(options)))
    missing.forEach((t, i) => {
      const info = fetched[i] ?? null
      out.set(t, info)
      // 读到了才缓存；不存在的不缓存（可能是刚发行、节点还没索引到）
      if (info) {
        coinCache.set(`${this.network}:${t}`, info)
        if (coinCache.size > MAX_CACHED_COINS) coinCache.delete(coinCache.keys().next().value as string)
      }
    })
    return out
  }

  /** 代币信息：精度、名称、symbol、图标、总供应量。结果与 coinTypes 一一对应 */
  async coins(coinTypes: readonly string[], options: RequestOptions = {}): Promise<CoinDetails[]> {
    const normalized = coinTypes.map((t) => {
      try {
        return normalizeStructTag(t)
      } catch {
        return null
      }
    })
    const infos = await this.#coinInfos(
      normalized.filter((t): t is string => t !== null),
      options,
    )
    return coinTypes.map((raw, i): CoinDetails => {
      const token = normalized[i]
      const empty = { decimals: null, name: null, symbol: null, description: null, iconUrl: null, totalSupply: null }
      if (!token) return { token: raw, ...empty, success: false, error: 'invalid-type' }
      const info = infos.get(token)
      if (!info) return { token, ...empty, success: false, error: 'not-found' }
      return {
        token,
        decimals: info.decimals,
        name: info.name,
        symbol: info.symbol,
        description: info.description,
        iconUrl: info.iconUrl,
        totalSupply: info.totalSupply === null ? null : info.totalSupply.toString(),
        success: true,
      }
    })
  }

  /** 按 ID 读对象（每次请求最多 50 个，自动分批）；结果与 ids 一一对应，不存在或 ID 非法时为 null */
  async objects(ids: readonly string[], options: ObjectsOptions = {}): Promise<Array<SuiObject | null>> {
    const paths = objectPaths(options.fields)
    const valid = ids.map((id) => (isValidSuiAddress(id) ? normalizeSuiAddress(id) : null))
    const unique = [...new Set(valid.filter((id): id is string => id !== null))]
    const chunks: string[][] = []
    for (let i = 0; i < unique.length; i += 50) chunks.push(unique.slice(i, i + 50))
    const results = await mapPool(chunks, this.#concurrency, (chunk) => batchGetObjects(this.transport, chunk, paths, this.#call(options)))
    const byId = new Map<string, SuiObject | null>()
    chunks.forEach((chunk, c) => chunk.forEach((id, i) => byId.set(id, results[c]?.[i] ?? null)))
    return valid.map((id) => (id === null ? null : (byId.get(id) ?? null)))
  }

  /** 地址拥有的对象（自动翻页；limit 限制总数）。注意不包括放在 Kiosk 等容器里的对象 */
  async ownedObjects(owner: string, options: OwnedObjectsOptions = {}): Promise<SuiObject[]> {
    const address = normalizeSuiAddress(owner)
    const paths = objectPaths(options.fields)
    const limit = options.limit ?? Number.POSITIVE_INFINITY
    const out: SuiObject[] = []
    let token: Uint8Array | null = null
    do {
      const page = await listOwnedObjects(
        this.transport,
        address,
        paths,
        { type: options.type === undefined ? undefined : normalizeTypeFilter(options.type), pageSize: Math.min(1000, Math.max(1, limit - out.length)), pageToken: token },
        this.#call(options),
      )
      out.push(...page.objects)
      token = page.nextPageToken
    } while (token && out.length < limit)
    return out.slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit)
  }

  /** 地址持有的 NFT（拥有的对象中去掉代币，Display 由节点渲染） */
  async nfts(owner: string, options: NftsOptions = {}): Promise<NftDetails[]> {
    const objects = await this.ownedObjects(owner, { type: options.type, fields: ['type', 'display', 'json'], signal: options.signal, minCheckpoint: options.minCheckpoint })
    const list = objects
      .filter((o) => !(o.type && coinTypeOfObject(o.type)))
      .map((o): NftDetails & { looksLikeNft: boolean } => {
        const d = o.display
        // 没有 Display 的 NFT 常把名称、图片直接放在字段里（如 name、image_url）
        const content = o.json && typeof o.json === 'object' && !Array.isArray(o.json) ? (o.json as Record<string, unknown>) : null
        const text = (...keys: string[]) => {
          for (const source of [d, content]) {
            for (const key of keys) {
              const v = source?.[key]
              if (typeof v === 'string' && v !== '') return v
            }
            if (d) break // 有 Display 时只用 Display
          }
          return null
        }
        const imageUrl = text('image_url', 'img_url', 'url')
        return {
          objectId: o.objectId,
          type: o.type,
          name: text('name'),
          description: text('description'),
          imageUrl,
          link: text('link'),
          projectUrl: text('project_url'),
          creator: text('creator'),
          display: d,
          looksLikeNft: d !== null || imageUrl !== null,
        }
      })
      .filter((n) => options.all || n.looksLikeNft)
      .map(({ looksLikeNft: _, ...n }) => n)
    return options.limit === undefined ? list : list.slice(0, options.limit)
  }
}

function objectPaths(fields: readonly ObjectField[] | undefined): string[] {
  return ['object_id', 'version', 'digest', ...(fields ?? ['type', 'owner']).map((f) => FIELD_PATHS[f])]
}

/** 类型过滤可以是完整类型、模块前缀或包地址：地址部分补足 64 位 */
function normalizeTypeFilter(type: string): string {
  const [address, ...rest] = type.trim().split('::')
  if (!address || !isValidSuiAddress(address)) throw new Error(`Invalid type filter: ${type}`)
  if (rest.length === 2 || type.includes('<')) {
    try {
      return normalizeStructTag(type)
    } catch {
      // 模块::名称 但带不完整的泛型等：按原样传
    }
  }
  return [normalizeSuiAddress(address), ...rest].join('::')
}
