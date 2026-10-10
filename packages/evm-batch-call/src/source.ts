import { BrowserProvider, FetchRequest, JsonRpcProvider, makeError, type Eip1193Provider, type TransactionRequest } from 'ethers'

import type { EthersLikeProvider } from './aggregate.js'
import { canDetectChainId, detectChainId, detectChainIdCached } from './detect.js'
import { FallbackRpc, type FallbackNodeInfo, type FallbackOptions } from './fallback.js'
import { DEFAULT_RPC_URLS, DEFAULT_TRON_HOSTS } from './rpcNodes.js'
import { TRON_CHAIN_ID, TronProvider, isTronChain, type TronProviderOptions, type TronWebLike } from './tron.js'

/**
 * 可传给 Provider 的底层连接（也可以传数组，按顺序作为主节点 + 备用节点）：
 * - RPC URL 字符串（Tron 链上是全节点 HTTP 地址）
 * - ethers v6 Provider（JsonRpcProvider / BrowserProvider / FallbackProvider …）
 * - 浏览器插件钱包注入的 EIP-1193 对象（window.ethereum、OKX、Rabby …），内部用 BrowserProvider 包装
 * - Tron：TronProvider，或钱包注入的 tronWeb（TronLink / OKX …）
 */
export type ProviderSource = string | EthersLikeProvider | Eip1193Provider | TronWebLike

export interface SourceOptions {
  /** 多节点故障切换参数；单节点时 timeout 也作为 URL 节点的请求超时 */
  fallback?: FallbackOptions
  /** 用 URL 创建的 TronProvider 的参数（apiKey、minInterval 等） */
  tron?: Omit<TronProviderOptions, 'fullHost' | 'request'>
}

export { isTronChain }

/** 链的默认节点：EVM 用内置公共节点表，Tron 主网用内置全节点列表 */
export function getDefaultRpcUrls(chainId: number): readonly string[] {
  if (chainId === TRON_CHAIN_ID.mainnet) {
    return DEFAULT_TRON_HOSTS
  }
  return DEFAULT_RPC_URLS[chainId] ?? []
}

export function resolveSource(
  chainId: number,
  source: ProviderSource | readonly ProviderSource[] | undefined,
  options: SourceOptions = {},
): EthersLikeProvider {
  const list = source === undefined ? getDefaultRpcUrls(chainId) : Array.isArray(source) ? source : [source]
  if (!list.length) {
    throw new Error(
      source === undefined
        ? `No default RPC for chain ${chainId}, please pass a provider or RPC URLs`
        : 'Provider list is empty',
    )
  }
  // 多节点时 Tron 节点不在单节点内重试 429，直接切到下一个节点
  const multiple = list.length > 1
  const timeout = options.fallback?.timeout ?? 10_000
  const nodes = list.map((item) => {
    const node = toEthersLike(chainId, item, options, multiple)
    // 内置公共节点本来就是按 chainId 选出来的，不需要再校验
    return source === undefined ? node : withChainCheck(chainId, item, node, timeout)
  })
  const info: FallbackNodeInfo[] = list.map((item) => ({ label: nodeLabel(item), key: item as string | object, chainId: Number.isFinite(chainId) ? chainId : undefined }))
  // 单节点也经过 FallbackRpc（统一触发 onRequest 事件、抛原始错误）。外层超时只对单个 EVM URL 节点加（FetchRequest 本来就有同样的超时）；
  // 钱包等对象节点、Tron URL（TronProvider 有自己的超时和 429 退避、限流队列，外层超时会把排队 / 退避中的请求截断）不传 timeout 时不加，与原来一致
  const singleEvmUrl = typeof list[0] === 'string' && !isTronChain(chainId)
  const fallback = multiple || singleEvmUrl || options.fallback?.timeout !== undefined ? options.fallback : { ...options.fallback, timeout: 0 }
  return new FallbackRpc(nodes, fallback, info)
}

/** 节点标识（错误信息、onRequest 事件用）：URL 只取 host，不含 path / query（常带 API Key） */
export function nodeLabel(source: ProviderSource): string {
  if (typeof source === 'string') {
    try {
      return new URL(source).host || 'url'
    } catch {
      return 'url'
    }
  }
  const value = source as Partial<EthersLikeProvider & Eip1193Provider & TronWebLike>
  if (value instanceof JsonRpcProvider) {
    try {
      return new URL(value._getConnection().url).host || 'provider'
    } catch {
      return 'provider'
    }
  }
  if (value.fullNode) {
    return 'tronWeb'
  }
  if (typeof value.call !== 'function' && typeof value.request === 'function') {
    return 'wallet'
  }
  return 'provider'
}

/** 识别失败后多久内不再重试识别（期间请求照常发出，不做校验） */
const CHECK_RETRY_INTERVAL = 60_000

/**
 * 校验节点所在的链与 Provider 的 chainId 一致，避免把另一条链的数据当成这条链的返回：
 * 比如 [钱包, 公共节点] 自动识别出钱包的链后，公共节点其实在另一条链上；或者配错了节点 URL。
 *
 * - 不一致时抛 NETWORK_ERROR（多节点时 FallbackRpc 会换下一个节点）
 * - 通过已配置好的节点连接识别（带 Tron apiKey / 限流等），结果按来源缓存，每个节点只多一次请求
 * - 识别与实际请求并行发出，不增加延迟；不一致时丢弃请求结果
 * - 识别本身失败时不拦截（交给实际请求去报错），并在一段时间内不再重试，避免每次请求都多一次识别
 */
export class ChainCheckedProvider implements EthersLikeProvider {
  #checkFailedAt = 0

  constructor(
    readonly inner: EthersLikeProvider,
    readonly chainId: number,
    readonly source: ProviderSource,
    readonly timeout: number,
  ) {}

  async #check(): Promise<void> {
    if (this.#checkFailedAt && Date.now() - this.#checkFailedAt < CHECK_RETRY_INTERVAL) {
      return
    }
    let actual: number
    try {
      actual = await detectChainIdCached(this.source, () => detectViaNode(this.inner, this.source), this.timeout)
    } catch {
      this.#checkFailedAt = Date.now()
      return
    }
    this.#checkFailedAt = 0
    if (actual !== this.chainId) {
      throw makeError(`chainId mismatch: expected ${this.chainId}, but the node is on ${actual}`, 'NETWORK_ERROR', {
        event: 'chainIdMismatch',
      })
    }
  }

  async #run<T>(request: () => Promise<T>): Promise<T> {
    const [checked, result] = await Promise.allSettled([this.#check(), request()])
    if (checked.status === 'rejected') {
      throw checked.reason
    }
    if (result.status === 'rejected') {
      throw result.reason
    }
    return result.value
  }

  call(tx: TransactionRequest): Promise<string> {
    return this.#run(() => this.inner.call(tx))
  }

  getBalance(...args: Parameters<EthersLikeProvider['getBalance']>): Promise<bigint> {
    return this.#run(() => this.inner.getBalance(...args))
  }

  getBlockNumber(): Promise<number> {
    const inner = this.inner
    if (!inner.getBlockNumber) {
      return Promise.reject(new Error('getBlockNumber is not supported by this node'))
    }
    return this.#run(() => (inner.getBlockNumber as () => Promise<number>)())
  }

  getLogs(filter: Parameters<NonNullable<EthersLikeProvider['getLogs']>>[0]): Promise<Awaited<ReturnType<NonNullable<EthersLikeProvider['getLogs']>>>> {
    const inner = this.inner
    if (!inner.getLogs) {
      return Promise.reject(new Error('getLogs is not supported by this node'))
    }
    return this.#run(() => (inner.getLogs as NonNullable<EthersLikeProvider['getLogs']>)(filter))
  }

  async getChainId(): Promise<number> {
    return this.chainId
  }
}

/** 通过已创建的节点连接识别它实际所在的链 */
function detectViaNode(node: EthersLikeProvider, source: ProviderSource): Promise<number> {
  if (node instanceof TronProvider) {
    return node.getChainId()
  }
  // JsonRpcProvider（staticNetwork）/ BrowserProvider（'any' 网络）的 getNetwork 不反映节点实际的链，直接问节点
  if (node instanceof JsonRpcProvider) {
    return node.send('eth_chainId', []).then(Number)
  }
  return detectChainId(source, Number.POSITIVE_INFINITY)
}

function withChainCheck(chainId: number, source: ProviderSource, node: EthersLikeProvider, timeout: number): EthersLikeProvider {
  if (!Number.isFinite(chainId) || !canDetectChainId(source) || pinnedWallets.has(node)) {
    return node
  }
  return new ChainCheckedProvider(node, chainId, source, timeout)
}

/** 由 EIP-1193 钱包创建、已固定在 chainId 上的 BrowserProvider（每次请求 ethers 都会校验链），不需要再包一层 */
const pinnedWallets = new WeakSet<EthersLikeProvider>()

function toEthersLike(chainId: number, source: ProviderSource, options: SourceOptions, multiple: boolean): EthersLikeProvider {
  if (typeof source === 'string') {
    if (isTronChain(chainId)) {
      return new TronProvider({ retries: multiple ? 0 : undefined, ...options.tron, fullHost: source })
    }
    // 静态网络（不发 eth_chainId 探测）+ 单次请求超时
    const request = new FetchRequest(source)
    const timeout = options.fallback?.timeout ?? 10_000
    // timeout <= 0 表示不限制（与 FallbackRpc 一致）；FetchRequest 的 0 是立即超时，所以这里不设
    if (timeout > 0 && Number.isFinite(timeout)) {
      request.timeout = timeout
    }
    return Number.isFinite(chainId)
      ? new JsonRpcProvider(request, chainId, { staticNetwork: true })
      : new JsonRpcProvider(request)
  }
  const value = source as Partial<EthersLikeProvider & Eip1193Provider & TronWebLike>
  if (typeof value.call === 'function') {
    return source as EthersLikeProvider
  }
  if (value.fullNode && typeof value.fullNode.request === 'function') {
    return TronProvider.fromTronWeb(source as TronWebLike, options.tron)
  }
  if (typeof value.request === 'function') {
    // 传入 chainId：钱包当前所在的链与之不符时请求报 NETWORK_ERROR（network changed），
    // 而不是静默返回另一条链的数据；在多节点列表里会据此自动切到下一个节点
    const wallet = new BrowserProvider(source as Eip1193Provider, Number.isFinite(chainId) ? chainId : undefined)
    if (Number.isFinite(chainId)) {
      pinnedWallets.add(wallet)
    }
    return wallet
  }
  throw new Error('Unsupported provider: expected an RPC URL, an ethers Provider, an EIP-1193 provider or a tronWeb instance')
}
