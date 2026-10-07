import { BrowserProvider, FetchRequest } from 'ethers'

import type { EthersLikeProvider } from './aggregate.js'
import type { ProviderSource } from './source.js'
import { TronProvider, type TronWebLike } from './tron.js'
import { withTimeout } from './util.js'

type Eip1193Like = { request: (args: { method: string }) => Promise<unknown>; on?: (event: string, listener: () => void) => unknown }

// 识别结果缓存，避免每次都请求。缓存的是 Promise：同时发起的识别共用一个请求；失败（含超时）时删除，下次重试。
// 只缓存“链不会悄悄变”或“变了能感知到”的来源：
// - URL：同一个地址的链不会变，按 URL 缓存
// - tronWeb：TronLink 切网络时换的是 fullNode.host，按 host 缓存
// - EIP-1193 钱包：有 on() 的监听 chainChanged，切链时清掉；没有 on() 的不缓存（无法感知切链）
// - ethers BrowserProvider：底下是钱包，可能切链，不缓存（getNetwork 只问本地钱包，开销很小）
// - 其他 ethers Provider / TronProvider 等对象：按对象缓存
const keyedCache = new Map<string, Promise<number>>()
let objectCache = new WeakMap<object, Promise<number>>()
const watched = new WeakSet<object>()

type CacheSlot = { kind: 'key'; key: string } | { kind: 'object'; key: object } | null

function cacheSlot(source: ProviderSource): CacheSlot {
  if (typeof source === 'string') {
    return { kind: 'key', key: `url:${source}` }
  }
  const value = source as Partial<EthersLikeProvider & Eip1193Like & TronWebLike> & { fullNode?: { host?: unknown } }
  if (source instanceof BrowserProvider) {
    return null
  }
  if (typeof value.call === 'function') {
    return { kind: 'object', key: source }
  }
  if (value.fullNode && typeof value.fullNode.request === 'function') {
    return typeof value.fullNode.host === 'string' ? { kind: 'key', key: `tronweb:${value.fullNode.host}` } : null
  }
  if (typeof value.request === 'function') {
    return watchChainChanged(source as Eip1193Like) ? { kind: 'object', key: source } : null
  }
  return null
}

/**
 * 按来源缓存地执行一次识别（与 detectChainId 共用缓存）。
 * 链校验用它通过已配置好的节点连接识别（带 apiKey / 限流等），而不是重新创建连接。
 */
export function detectChainIdCached(source: ProviderSource, detect: () => Promise<number>, timeout = 10_000): Promise<number> {
  return cached(source, () => withTimeout(detect(), timeout))
}

function cached(source: ProviderSource, detect: () => Promise<number>): Promise<number> {
  const slot = cacheSlot(source)
  if (!slot) {
    return detect()
  }
  const hit = slot.kind === 'key' ? keyedCache.get(slot.key) : objectCache.get(slot.key)
  if (hit) {
    return hit
  }
  const promise = detect()
  if (slot.kind === 'key') {
    keyedCache.set(slot.key, promise)
  } else {
    objectCache.set(slot.key, promise)
  }
  promise.catch(() => {
    if (slot.kind === 'key') {
      if (keyedCache.get(slot.key) === promise) keyedCache.delete(slot.key)
    } else if (objectCache.get(slot.key) === promise) {
      objectCache.delete(slot.key)
    }
  })
  return promise
}

/** EIP-1193 钱包切链时会触发 chainChanged，清掉该钱包的缓存。返回是否成功监听 */
function watchChainChanged(wallet: Eip1193Like): boolean {
  if (watched.has(wallet)) {
    return true
  }
  if (typeof wallet.on !== 'function') {
    return false
  }
  try {
    const result = wallet.on('chainChanged', () => objectCache.delete(wallet))
    // 个别实现的 on() 返回 Promise
    ;(result as Promise<unknown> | undefined)?.catch?.(() => {})
    watched.add(wallet)
    return true
  } catch {
    return false
  }
}

/** 清空 chainId 识别缓存 */
export function clearChainIdCache(): void {
  keyedCache.clear()
  objectCache = new WeakMap()
}

/**
 * 从节点识别 chainId（不传 chainId 时使用），结果会缓存。数组按顺序探测，第一个成功的为准：
 * - RPC URL：先按 EVM 节点发 eth_chainId，失败再按 Tron 全节点读创世区块
 * - 浏览器插件钱包（EIP-1193）：eth_chainId；tronWeb：Tron 创世区块
 * - ethers Provider：getNetwork()；TronProvider / FallbackRpc：getChainId()
 *
 * @param timeout 单个节点的超时（毫秒）；URL 的 EVM / Tron 两次尝试各自计时
 */
export async function detectChainId(source: ProviderSource | readonly ProviderSource[], timeout = 10_000): Promise<number> {
  const list: readonly ProviderSource[] = Array.isArray(source) ? source : [source as ProviderSource]
  let lastError: unknown = new Error('Provider list is empty')
  for (const item of list) {
    try {
      // 超时包在缓存里面：挂住的识别超时后会从缓存删除，不会让后续调用一直等
      return await cached(item, () => (typeof item === 'string' ? detectUrl(item, timeout) : withTimeout(detectOne(item), timeout)))
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

/** 能否从这个来源识别 chainId（不能的来源跳过链校验，见 source.ts） */
export function canDetectChainId(source: ProviderSource): boolean {
  if (typeof source === 'string') {
    return true
  }
  const value = source as { getChainId?: unknown; getNetwork?: unknown; request?: unknown; call?: unknown; fullNode?: { request?: unknown } }
  if (typeof value.call === 'function') {
    return typeof value.getChainId === 'function' || typeof value.getNetwork === 'function'
  }
  return typeof value.fullNode?.request === 'function' || typeof value.request === 'function'
}

/** 已创建的连接对象上识别 chainId */
export async function detectChainIdOf(node: EthersLikeProvider): Promise<number> {
  const value = node as {
    getChainId?: () => Promise<number>
    send?: (method: string, params: unknown[]) => Promise<unknown>
    getNetwork?: () => Promise<{ chainId: bigint }>
  }
  if (typeof value.getChainId === 'function') {
    return Number(await value.getChainId())
  }
  // ethers JsonRpcProvider / BrowserProvider：直接问节点。getNetwork 在 staticNetwork 或 'any' 网络下
  // 返回的是配置 / 首次识别的值，节点（钱包）切链后不会变
  if (typeof value.send === 'function') {
    return Number(await value.send('eth_chainId', []))
  }
  if (typeof value.getNetwork === 'function') {
    return Number((await value.getNetwork()).chainId)
  }
  throw new Error('Unable to detect chainId from this provider, please pass chainId explicitly')
}

async function detectOne(source: Exclude<ProviderSource, string>): Promise<number> {
  const value = source as Partial<EthersLikeProvider & Eip1193Like & TronWebLike>
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
    // 不是 EVM 节点：按 Tron 全节点 HTTP API 再试一次（单独计时）
    try {
      return await new TronProvider({ fullHost: url, retries: 0, timeout }).getChainId()
    } catch {
      throw evmError
    }
  }
}
