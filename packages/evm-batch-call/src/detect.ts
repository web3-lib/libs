import { FetchRequest } from 'ethers'

import type { EthersLikeProvider } from './aggregate.js'
import type { ProviderSource } from './source.js'
import { TronProvider, type TronWebLike } from './tron.js'
import { withTimeout } from './util.js'

// 识别结果缓存，避免每次都请求：
// - URL：同一个地址的链不会变，长期缓存
// - 对象（钱包 / ethers Provider / tronWeb …）：按对象缓存；EIP-1193 钱包监听 chainChanged，切链后自动失效
// 缓存的是 Promise：同时发起的识别共用一个请求；失败时删除，下次重试
const urlCache = new Map<string, Promise<number>>()
let objectCache = new WeakMap<object, Promise<number>>()
const watched = new WeakSet<object>()

function cached(source: ProviderSource, detect: () => Promise<number>): Promise<number> {
  const isUrl = typeof source === 'string'
  const hit = isUrl ? urlCache.get(source) : objectCache.get(source as object)
  if (hit) {
    return hit
  }
  const promise = detect()
  if (isUrl) {
    urlCache.set(source, promise)
  } else {
    objectCache.set(source as object, promise)
    watchChainChanged(source as object)
  }
  promise.catch(() => {
    if (isUrl) {
      if (urlCache.get(source) === promise) urlCache.delete(source)
    } else if (objectCache.get(source as object) === promise) {
      objectCache.delete(source as object)
    }
  })
  return promise
}

/** EIP-1193 钱包切链时会触发 chainChanged，清掉该钱包的缓存 */
function watchChainChanged(source: object): void {
  const wallet = source as { on?: (event: string, listener: () => void) => unknown; request?: unknown; call?: unknown }
  // 只监听原生 EIP-1193 钱包：ethers Provider 也有 on()，但它是异步的且不认识 chainChanged，会产生未处理的 rejection
  if (watched.has(source) || typeof wallet.on !== 'function' || typeof wallet.request !== 'function' || typeof wallet.call === 'function') {
    return
  }
  watched.add(source)
  try {
    const result = wallet.on('chainChanged', () => objectCache.delete(source))
    // 个别实现的 on() 返回 Promise
    ;(result as Promise<unknown> | undefined)?.catch?.(() => {})
  } catch {
    // 不支持该事件的实现：忽略，缓存不会自动失效，可调用 clearChainIdCache()
  }
}

/** 清空 chainId 识别缓存 */
export function clearChainIdCache(): void {
  urlCache.clear()
  objectCache = new WeakMap()
}

/**
 * 从节点识别 chainId（不传 chainId 时使用），结果会缓存。数组按顺序探测，第一个成功的为准：
 * - RPC URL：先按 EVM 节点发 eth_chainId，失败再按 Tron 全节点读创世区块
 * - 浏览器插件钱包（EIP-1193）：eth_chainId；tronWeb：Tron 创世区块
 * - ethers Provider：getNetwork()；TronProvider / FallbackRpc：getChainId()
 */
export async function detectChainId(source: ProviderSource | readonly ProviderSource[], timeout = 10_000): Promise<number> {
  const list: readonly ProviderSource[] = Array.isArray(source) ? source : [source as ProviderSource]
  let lastError: unknown = new Error('Provider list is empty')
  for (const item of list) {
    try {
      return await withTimeout(cached(item, () => detectOne(item, timeout)), timeout)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

/** 已创建的连接对象上识别 chainId */
export async function detectChainIdOf(node: EthersLikeProvider): Promise<number> {
  const value = node as { getChainId?: () => Promise<number>; getNetwork?: () => Promise<{ chainId: bigint }> }
  if (typeof value.getChainId === 'function') {
    return Number(await value.getChainId())
  }
  if (typeof value.getNetwork === 'function') {
    return Number((await value.getNetwork()).chainId)
  }
  throw new Error('Unable to detect chainId from this provider, please pass chainId explicitly')
}

async function detectOne(source: ProviderSource, timeout: number): Promise<number> {
  if (typeof source === 'string') {
    return detectUrl(source, timeout)
  }
  const value = source as Partial<EthersLikeProvider & { request: (args: { method: string }) => Promise<unknown> } & TronWebLike>
  if (typeof value.call === 'function') {
    return detectChainIdOf(source as EthersLikeProvider)
  }
  if (value.fullNode && typeof value.fullNode.request === 'function') {
    return TronProvider.fromTronWeb(source as TronWebLike).getChainId()
  }
  if (typeof value.request === 'function') {
    return Number(await value.request({ method: 'eth_chainId' }))
  }
  throw new Error('Unsupported provider: expected an RPC URL, an ethers Provider, an EIP-1193 provider or a tronWeb instance')
}

async function detectUrl(url: string, timeout: number): Promise<number> {
  try {
    const request = new FetchRequest(url)
    if (timeout > 0 && Number.isFinite(timeout)) {
      request.timeout = timeout
    }
    request.setHeader('content-type', 'application/json')
    request.body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })
    const response = await request.send()
    response.assertOk()
    const json = response.bodyJson as { result?: string; error?: { message?: string } }
    if (!json?.result) {
      throw new Error(`eth_chainId failed: ${json?.error?.message ?? 'empty result'}`)
    }
    return Number(json.result)
  } catch (evmError) {
    // 不是 EVM 节点：按 Tron 全节点 HTTP API 再试一次
    try {
      return await new TronProvider({ fullHost: url, retries: 0 }).getChainId()
    } catch {
      throw evmError
    }
  }
}
