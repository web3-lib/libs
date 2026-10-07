import { DEFAULT_RPC_URLS, GENESIS_HASHES, type Cluster } from './constants.js'
import { FallbackRpc, HttpRpc, type FallbackOptions, type HttpRpcOptions, type RpcTransport } from './rpc.js'

/**
 * 节点来源（也可以传数组：主节点 + 备用节点）：
 * - RPC URL 字符串
 * - @solana/web3.js 的 Connection（使用其 rpcEndpoint）
 * - 自定义传输：实现 `request(method, params)` 的对象（如包一层 @solana/kit 的 rpc）
 */
export type RpcSource = string | RpcTransport | { rpcEndpoint: string }

export interface SourceOptions extends HttpRpcOptions, FallbackOptions {}

function toTransport(source: RpcSource, options: SourceOptions, multiple: boolean): RpcTransport {
  if (typeof source === 'string') {
    // 多节点时不在单节点内重试 429，直接切到下一个节点
    return new HttpRpc(source, { ...options, retries: multiple ? 0 : options.retries })
  }
  if (typeof (source as RpcTransport).request === 'function') {
    return source as RpcTransport
  }
  const endpoint = (source as { rpcEndpoint?: unknown }).rpcEndpoint
  if (typeof endpoint === 'string') {
    return new HttpRpc(endpoint, { ...options, retries: multiple ? 0 : options.retries })
  }
  throw new Error('Unsupported RPC source: expected a URL, a web3.js Connection or an object with request(method, params)')
}

// 各节点的创世区块哈希缓存：失败（含超时）时删除，下次重试
const genesisCache = new WeakMap<RpcTransport, Promise<string>>()

export function genesisOf(transport: RpcTransport): Promise<string> {
  let cached = genesisCache.get(transport)
  if (!cached) {
    const promise = transport.request<string>('getGenesisHash')
    genesisCache.set(transport, promise)
    promise.catch(() => {
      if (genesisCache.get(transport) === promise) {
        genesisCache.delete(transport)
      }
    })
    cached = promise
  }
  return cached
}

/** 识别失败后多久内不再重试（期间请求照常发出，不做校验） */
const CHECK_RETRY_INTERVAL = 60_000

export class NetworkMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`Network mismatch: expected genesis ${expected}, but the node is on ${actual}`)
    this.name = 'NetworkMismatchError'
  }
}

/**
 * 校验节点所在的网络（创世区块哈希），避免把 devnet 的数据当成 mainnet 的返回。
 * 校验与请求并行发出，不增加延迟；结果缓存，每个节点只多一次请求；识别失败时不拦截，并在一段时间内不再重试。
 */
export class NetworkCheckedRpc implements RpcTransport {
  #checkFailedAt = 0

  constructor(
    readonly inner: RpcTransport,
    readonly expected: () => Promise<string>,
  ) {}

  async #check(): Promise<void> {
    if (this.#checkFailedAt && Date.now() - this.#checkFailedAt < CHECK_RETRY_INTERVAL) {
      return
    }
    let expected: string
    let actual: string
    try {
      ;[expected, actual] = await Promise.all([this.expected(), genesisOf(this.inner)])
    } catch {
      this.#checkFailedAt = Date.now()
      return
    }
    this.#checkFailedAt = 0
    if (expected !== actual) {
      throw new NetworkMismatchError(expected, actual)
    }
  }

  async request<T = unknown>(method: string, params?: readonly unknown[]): Promise<T> {
    const [checked, result] = await Promise.allSettled([this.#check(), this.inner.request<T>(method, params)])
    if (checked.status === 'rejected') {
      throw checked.reason
    }
    if (result.status === 'rejected') {
      throw result.reason
    }
    return result.value
  }
}

export interface ResolvedSource {
  transport: RpcTransport
  /** 期望的创世区块哈希：指定了 cluster 时取对应值，否则取第一个响应节点的 */
  genesis: () => Promise<string>
}

export function resolveSource(
  source: RpcSource | readonly RpcSource[] | undefined,
  cluster: Cluster | undefined,
  options: SourceOptions = {},
): ResolvedSource {
  const isDefault = source === undefined
  const list: readonly RpcSource[] = isDefault ? DEFAULT_RPC_URLS[cluster ?? 'mainnet'] : Array.isArray(source) ? source : [source as RpcSource]
  if (!list.length) {
    throw new Error('RPC source list is empty')
  }
  const multiple = list.length > 1
  const raw = list.map((item) => toTransport(item, options, multiple))

  let detecting: Promise<string> | null = null
  const genesis = (): Promise<string> => {
    if (cluster) {
      return Promise.resolve(GENESIS_HASHES[cluster])
    }
    if (!detecting) {
      const promise = (async () => {
        let lastError: unknown
        for (const node of raw) {
          try {
            return await genesisOf(node)
          } catch (err) {
            lastError = err
          }
        }
        throw lastError
      })()
      detecting = promise
      promise.catch(() => {
        if (detecting === promise) detecting = null
      })
    }
    return detecting
  }

  // 内置节点本来就是按 cluster 选的，不校验；单个节点且没指定 cluster 时，期望值就是它自己，也不需要校验
  const check = !isDefault && (multiple || cluster !== undefined)
  const nodes = check ? raw.map((node) => new NetworkCheckedRpc(node, genesis)) : raw
  return {
    transport: multiple ? new FallbackRpc(nodes, options) : (nodes[0] as RpcTransport),
    genesis,
  }
}
