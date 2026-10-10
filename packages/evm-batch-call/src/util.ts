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
 * 支持 AbortSignal：已取消时直接 reject（不执行 work，不发请求）；执行中取消时立即 reject（reason 为 signal.reason），
 * 底层请求不中断（可能与其他调用合并在同一个请求里），结果丢弃
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
