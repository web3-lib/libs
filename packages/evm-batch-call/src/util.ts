import type { TransactionRequest } from 'ethers'

import type { EthersLikeProvider } from './aggregate.js'

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`RPC request timed out after ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

/** ms <= 0 或非有限值表示不限制 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return promise
  }
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(ms)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * 支持 AbortSignal：已取消时直接 reject（不执行 work，不发请求）；执行中取消时立即 reject（reason 为 signal.reason）。
 * signal 同时传给底层：还没发出的分片 / 节点切换 / Tron 排队中的请求不再发出，Tron 的 fetch 直接中断；
 * 与其他调用方合并在同一个请求里时，只有所有调用方都取消才中止（见 Batcher）
 */
export function withSignal<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (!signal) {
    return work()
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    work().then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/**
 * 合并多个 signal：任一取消即取消，reason 取先取消的那个（Node 18 没有 AbortSignal.any，这里手动实现）。
 * 用完调用 dispose，移除挂在各个 signal 上的监听（调用方可能用一个长期存在的 signal 发起很多次查询）
 */
export function anySignal(signals: ReadonlyArray<AbortSignal | undefined>): { signal: AbortSignal | undefined; dispose: () => void } {
  const list = signals.filter((s): s is AbortSignal => s !== undefined)
  if (list.length <= 1) {
    return { signal: list[0], dispose: () => {} }
  }
  const controller = new AbortController()
  const aborted = list.find((s) => s.aborted)
  if (aborted) {
    controller.abort(aborted.reason)
    return { signal: controller.signal, dispose: () => {} }
  }
  const listeners = list.map((s) => {
    const onAbort = () => {
      controller.abort(s.reason)
      dispose()
    }
    s.addEventListener('abort', onAbort, { once: true })
    return () => s.removeEventListener('abort', onAbort)
  })
  const dispose = () => listeners.forEach((remove) => remove())
  return { signal: controller.signal, dispose }
}

/** 可取消的等待：取消时 reject signal.reason 并清掉定时器 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason)
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 等待 ms 毫秒；signal 取消时提前结束（resolve，不抛错，调用方自己检查 signal.aborted）。
 * 发送模块轮询回执时用：取消后要把剩下的项标成 aborted / pending，而不是整体抛错
 */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

export interface PoolOptions {
  /** 取消后不再取新的条目，整体以 signal.reason reject（已开始的条目由 fn 自己处理取消） */
  signal?: AbortSignal
  /** 有条目失败后不再取新的条目（默认 false：其余 worker 照常跑完剩下的条目） */
  failFast?: boolean
}

/** 并发数为 limit 的 map，结果按输入顺序；任一条目失败时整体 reject */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>, options: PoolOptions = {}): Promise<R[]> {
  const { signal, failFast = false } = options
  signal?.throwIfAborted()
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false
  const worker = async () => {
    while (next < items.length && !(failFast && failed)) {
      signal?.throwIfAborted()
      const i = next++
      try {
        results[i] = await fn(items[i] as T, i)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  const size = Math.min(Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : items.length), items.length)
  await Promise.all(Array.from({ length: size }, worker))
  return results
}

/**
 * 并发闸门（信号量）：同时最多 limit 个任务在执行，其余按先来后到排队；
 * 排队中取消的任务直接出队并 reject signal.reason，不占名额
 */
export function createLimiter(limit: number): <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T> {
  const max = Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : Number.MAX_SAFE_INTEGER)
  let active = 0
  const waiting: Array<() => void> = []
  const release = () => {
    // 名额直接转交给排队的下一个（active 不变），避免被唤醒前被新来的任务抢走而超出上限
    const nextTask = waiting.shift()
    if (nextTask) {
      nextTask()
    } else {
      active--
    }
  }
  const acquire = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) {
      return Promise.reject(signal.reason)
    }
    if (active < max) {
      active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = waiting.indexOf(wake)
        if (i !== -1) {
          waiting.splice(i, 1)
        }
        reject(signal?.reason)
      }
      const wake = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      waiting.push(wake)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  return async (task, signal) => {
    await acquire(signal)
    try {
      return await task()
    } finally {
      release()
    }
  }
}

/**
 * 内部约定：call / getBalance 接受最后一个可选参数 `{ signal }` 的节点（TronProvider，及包装它的 ChainCheckedProvider）。
 * 其他节点（ethers Provider、钱包）不认这个参数，不传给它们
 */
const signalAwareNodes = new WeakSet<object>()

export function markSignalAware(node: object): void {
  signalAwareNodes.add(node)
}

export function isSignalAware(node: unknown): boolean {
  return typeof node === 'object' && node !== null && signalAwareNodes.has(node)
}

/** eth_call：支持取消的节点（见 markSignalAware）把 `{ signal }` 作为第二个参数传进去，其他节点只传 tx */
export function callNode(node: EthersLikeProvider, tx: TransactionRequest, signal?: AbortSignal): Promise<string> {
  if (signal && isSignalAware(node)) {
    return (node.call as (tx: TransactionRequest, options: { signal?: AbortSignal }) => Promise<string>)(tx, { signal })
  }
  return node.call(tx)
}

/** eth_getBalance：signal 的传法同 callNode */
export function balanceOfNode(
  node: EthersLikeProvider,
  address: Parameters<EthersLikeProvider['getBalance']>[0],
  blockTag?: Parameters<EthersLikeProvider['getBalance']>[1],
  signal?: AbortSignal,
): Promise<bigint> {
  if (signal && isSignalAware(node)) {
    return (node.getBalance as (a: unknown, b: unknown, options: { signal?: AbortSignal }) => Promise<bigint>)(address, blockTag, { signal })
  }
  return node.getBalance(address, blockTag)
}

/** 按最近使用淘汰的缓存（满了删最久没用的一条，不整表清空） */
export class LruCache<K, V> {
  readonly #map = new Map<K, V>()
  constructor(readonly max: number) {}

  get(key: K): V | undefined {
    const value = this.#map.get(key)
    if (value !== undefined) {
      // 重新插入，移到“最近使用”的一端
      this.#map.delete(key)
      this.#map.set(key, value)
    }
    return value
  }

  set(key: K, value: V): void {
    this.#map.delete(key)
    this.#map.set(key, value)
    if (this.#map.size > this.max) {
      this.#map.delete(this.#map.keys().next().value as K)
    }
  }

  get size(): number {
    return this.#map.size
  }
}
