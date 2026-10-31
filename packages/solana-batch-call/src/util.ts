/** 内部公共工具：并发池、可取消的等待、多个调用方共用一次操作时的取消 */

/** 并发数为 limit 的 map，结果按输入顺序。某一项出错时整体 reject，其余 worker 不再取后面的项（已开始的照常结束） */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++
      try {
        results[i] = await fn(items[i] as T, i)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return results
}

/**
 * 等待 ms 毫秒。signal 取消时：rejectOnAbort 为 true（默认）时立即 reject（reason 为 signal.reason），
 * 为 false 时提前 resolve（用于“取消后不再等，由调用方自己检查 signal”的场景）
 */
export function sleep(ms: number, signal?: AbortSignal, rejectOnAbort = true): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      if (rejectOnAbort) {
        reject(signal.reason)
      } else {
        resolve()
      }
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      if (rejectOnAbort) {
        reject(signal?.reason)
      } else {
        resolve()
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 多个调用方共用一次操作（在途去重）时的取消：所有加入的调用方都取消后才中止；
 * 有一个调用方没传 signal 就永远不会中止。操作结束后调用 done() 移除监听
 */
export class SharedAbort {
  readonly #controller = new AbortController()
  /** 还没取消的调用方数量（只算传了 signal 的） */
  #active = 0
  /** 有调用方没传 signal */
  #forever = false
  #cleanups: Array<() => void> = []
  #done = false

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  /** 加入；已经中止或已结束时返回 false（调用方应另起一次操作） */
  join(signal: AbortSignal | undefined): boolean {
    if (this.#controller.signal.aborted || this.#done) {
      return false
    }
    if (!signal) {
      this.#forever = true
      return true
    }
    if (signal.aborted) {
      // 调用方已经取消（外层会直接 reject）：不计入
      return true
    }
    this.#active++
    const onAbort = () => {
      if (--this.#active === 0 && !this.#forever && !this.#done) {
        this.#controller.abort(signal.reason)
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    this.#cleanups.push(() => signal.removeEventListener('abort', onAbort))
    return true
  }

  done(): void {
    this.#done = true
    for (const cleanup of this.#cleanups) {
      cleanup()
    }
    this.#cleanups = []
  }
}

/** 往有条目上限的 Map 里写入（先删再插保持“最近写入在后”），超出时淘汰最早写入的 */
export function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) {
    map.delete(map.keys().next().value as K)
  }
}
