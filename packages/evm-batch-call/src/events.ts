/** 一次对某个节点的请求（onRequest 的事件） */
export interface RequestEvent {
  /** 节点标识：URL 节点只取 host（不含 path / query，避免泄露 API Key）；钱包为 'wallet'，tronWeb 为 'tronWeb'，其他对象为 'provider' */
  node: string
  /** 'call' | 'getBalance' | 'getChainId' | 'getBlockNumber' | 'getLogs' */
  method: string
  /** 耗时（毫秒） */
  ms: number
  ok: boolean
  /** 失败时的错误 */
  error?: unknown
  /** 本次请求按故障切换顺序的第几个节点（0 起）；大于 0 表示换过节点 */
  attempt: number
}

export type RequestListener = (event: RequestEvent) => void

const listeners = new Set<RequestListener>()

/**
 * 订阅所有节点请求（全局，对所有 Provider 生效），用于观察哪个节点返回、换过几次节点、每次耗时。返回取消订阅的函数。
 *
 * ```ts
 * const off = onRequest((e) => console.log(e.node, e.method, e.ms, e.ok, e.attempt))
 * ```
 */
export function onRequest(listener: RequestListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitRequest(event: RequestEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // 监听函数出错不影响请求
    }
  }
}
