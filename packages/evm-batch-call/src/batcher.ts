import { decodeCall, encodeCall, type Call, type CallRequest, type RawResult } from './call.js'
import type { CallOverrides } from './aggregate.js'
import { CallFailedError } from './errors.js'

export interface BatchOptions {
  /** 收集窗口（毫秒），窗口内发起的 call 合并成一次 multicall。默认 0：同一事件循环 tick 内的调用合并 */
  wait?: number
  /** 队列达到这个数量立即发出，不再等窗口结束。默认 500 */
  maxSize?: number
}

type Runner = (requests: CallRequest[], overrides: CallOverrides) => Promise<RawResult[]>

interface Pending {
  call: Call
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

interface Queue {
  overrides: CallOverrides
  entries: Pending[]
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * DataLoader 式的自动合并：各处独立调用 `provider.call(x)`，
 * 落在同一个收集窗口、且 blockTag/from 相同的调用会合成一次 aggregate3。
 * 相同的 (target, callData) 只请求一次。
 */
export class Batcher {
  readonly #run: Runner
  readonly #wait: number
  readonly #maxSize: number
  readonly #queues = new Map<string, Queue>()

  constructor(run: Runner, options: BatchOptions = {}) {
    this.#run = run
    this.#wait = options.wait ?? 0
    this.#maxSize = Math.max(1, options.maxSize ?? 500)
  }

  load<T>(call: Call, overrides: CallOverrides = {}): Promise<T> {
    const key = `${String(overrides.blockTag ?? 'latest')}|${overrides.from ?? ''}`
    let queue = this.#queues.get(key)
    if (!queue) {
      queue = { overrides, entries: [], timer: null }
      this.#queues.set(key, queue)
    }
    const promise = new Promise<T>((resolve, reject) => {
      queue.entries.push({ call, resolve: resolve as (value: unknown) => void, reject })
    })
    if (queue.entries.length >= this.#maxSize) {
      this.#flush(key)
    } else if (!queue.timer) {
      queue.timer = setTimeout(() => this.#flush(key), this.#wait)
    }
    return promise
  }

  #flush(key: string): void {
    const queue = this.#queues.get(key)
    if (!queue) {
      return
    }
    this.#queues.delete(key)
    if (queue.timer) {
      clearTimeout(queue.timer)
    }
    void this.#dispatch(queue)
  }

  async #dispatch({ entries, overrides }: Queue): Promise<void> {
    const requests: CallRequest[] = []
    const indexByKey = new Map<string, number>()
    const requestIndex: number[] = []

    for (const entry of entries) {
      let request: CallRequest
      try {
        request = encodeCall(entry.call, true)
      } catch (err) {
        entry.reject(err)
        requestIndex.push(-1)
        continue
      }
      const dedupeKey = `${request.ethBalanceOf ? 'eth' : request.target.toLowerCase()}|${request.callData}`
      let index = indexByKey.get(dedupeKey)
      if (index === undefined) {
        index = requests.push(request) - 1
        indexByKey.set(dedupeKey, index)
      }
      requestIndex.push(index)
    }

    if (requests.length === 0) {
      return
    }

    let results: RawResult[]
    try {
      results = await this.#run(requests, overrides)
    } catch (err) {
      entries.forEach((entry, i) => requestIndex[i] !== -1 && entry.reject(err))
      return
    }

    entries.forEach((entry, i) => {
      const index = requestIndex[i] as number
      if (index === -1) {
        return
      }
      const result = results[index] as RawResult
      if (!result.success) {
        entry.reject(new CallFailedError(entry.call, result.returnData))
        return
      }
      try {
        entry.resolve(decodeCall(entry.call, result.returnData))
      } catch (err) {
        // 解码失败：多半是目标地址没有合约（返回空数据）
        entry.reject(new CallFailedError(entry.call, result.returnData, err))
      }
    })
  }
}
