import { BrowserProvider, FetchRequest, JsonRpcProvider, type Eip1193Provider } from 'ethers'

import type { EthersLikeProvider } from './aggregate.js'
import { FallbackRpc, type FallbackOptions } from './fallback.js'
import { DEFAULT_RPC_URLS, DEFAULT_TRON_HOSTS } from './rpcNodes.js'
import { TRON_CHAIN_ID, TronProvider, type TronProviderOptions, type TronWebLike } from './tron.js'

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

const TRON_CHAIN_IDS = new Set<number>(Object.values(TRON_CHAIN_ID))

export function isTronChain(chainId: number): boolean {
  return TRON_CHAIN_IDS.has(chainId)
}

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
  const nodes = list.map((item) => toEthersLike(chainId, item, options, multiple))
  return multiple ? new FallbackRpc(nodes, options.fallback) : (nodes[0] as EthersLikeProvider)
}

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
    return new BrowserProvider(source as Eip1193Provider)
  }
  throw new Error('Unsupported provider: expected an RPC URL, an ethers Provider, an EIP-1193 provider or a tronWeb instance')
}
