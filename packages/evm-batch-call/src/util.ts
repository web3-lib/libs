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
