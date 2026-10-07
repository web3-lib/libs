/** 最小的 JSON-RPC 传输接口：可以传入自己的实现（如包一层 @solana/kit 的 rpc） */
export interface RpcTransport {
  request<T = unknown>(method: string, params?: readonly unknown[]): Promise<T>
}

/** 节点返回的 JSON-RPC 错误 */
export class RpcError extends Error {
  readonly code: number | undefined
  readonly data: unknown
  /** 是否是节点自身的限制（限频、需要 API Key、禁止访问等），换节点可能成功 */
  readonly nodeFault: boolean

  constructor(message: string, code?: number, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
    this.nodeFault =
      code === 403 ||
      code === 429 ||
      code === -32005 ||
      /forbidden|blocked|personal token|api.?key|rate.?limit|too many|not allowed|unauthori[sz]ed|limit exceeded|disabled|not available|not supported/i.test(message)
  }
}

/** HTTP 层错误（非 2xx、网络错误、超时） */
export class HttpError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** 是否是节点问题（应换节点重试）：除了确定性的 JSON-RPC 错误（如参数错误），其余都算 */
export function isNodeFault(err: unknown): boolean {
  if (err instanceof RpcError) {
    return err.nodeFault
  }
  return true
}

export interface HttpRpcOptions {
  /** 单次 HTTP 请求超时（毫秒），<= 0 不限制。默认 10000 */
  timeout?: number
  headers?: Record<string, string>
  /** 一个 HTTP 批量请求最多包含的调用数。默认 20 */
  maxBatchSize?: number
  /** 是否合并成 JSON-RPC 批量请求。默认 true；节点不支持时会自动关闭 */
  batch?: boolean
  /** 收集窗口（毫秒），窗口内的调用合并成一个 HTTP 请求。默认 0（同一 tick） */
  batchWait?: number
  /** 遇到 HTTP 429 时的重试次数（指数退避，从 500ms 开始）。默认 2 */
  retries?: number
  /** 自定义 fetch（如需要代理时） */
  fetch?: typeof fetch
}

interface Pending {
  method: string
  params: readonly unknown[]
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

interface RpcResponse {
  id?: number | string | null
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

let nextId = 1

/** 批量请求被拒绝、可以降级为逐条请求的 HTTP 状态 */
const BATCH_REJECTED_STATUS = new Set([400, 404, 405, 415, 422])

function isBatchLimitError(message: string | undefined): boolean {
  return !!message && /batch/i.test(message) && /more than \d+|too (large|many|big)|not (allowed|supported)|exceed/i.test(message)
}

/**
 * 基于 fetch 的 JSON-RPC 传输：同一收集窗口内的调用合并成一个 JSON-RPC 批量请求。
 * 节点不支持批量（返回非数组）或限制批量大小（如 drpc 免费档最多 3 条）时自动降级。
 */
export class HttpRpc implements RpcTransport {
  readonly url: string
  readonly #timeout: number
  readonly #headers: Record<string, string>
  readonly #batchWait: number
  readonly #retries: number
  readonly #fetch: typeof fetch
  #maxBatchSize: number
  #batch: boolean
  #queue: Pending[] = []
  #timer: ReturnType<typeof setTimeout> | null = null

  constructor(url: string, options: HttpRpcOptions = {}) {
    this.url = url
    this.#timeout = options.timeout ?? 10_000
    this.#headers = { 'content-type': 'application/json', ...options.headers }
    this.#maxBatchSize = Math.max(1, options.maxBatchSize ?? 20)
    this.#batch = options.batch ?? true
    this.#batchWait = options.batchWait ?? 0
    this.#retries = Math.max(0, options.retries ?? 2)
    this.#fetch = options.fetch ?? ((...args) => fetch(...args))
  }

  request<T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({ method, params, resolve: resolve as (value: unknown) => void, reject })
      if (!this.#batch || this.#queue.length >= this.#maxBatchSize) {
        this.#flush()
      } else if (!this.#timer) {
        this.#timer = setTimeout(() => this.#flush(), this.#batchWait)
      }
    })
  }

  #flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    const queue = this.#queue
    this.#queue = []
    for (let i = 0; i < queue.length; i += this.#maxBatchSize) {
      void this.#dispatch(queue.slice(i, i + this.#maxBatchSize))
    }
  }

  async #dispatch(items: Pending[]): Promise<void> {
    if (items.length === 1 || !this.#batch) {
      await Promise.all(items.map((item) => this.#single(item)))
      return
    }
    const ids = items.map(() => nextId++)
    let body: unknown
    try {
      body = await this.#post(items.map((item, i) => ({ jsonrpc: '2.0', id: ids[i], method: item.method, params: item.params })))
    } catch (err) {
      if (err instanceof HttpError && err.status === 413 && items.length > 1) {
        // 请求体太大：批量减半后重发
        this.#maxBatchSize = Math.max(1, Math.floor(items.length / 2))
        await this.#redispatch(items)
        return
      }
      // 400 / 404 / 405 / 415 / 422 等：节点多半不接受批量请求，降级为逐条请求
      // （401 / 403 / 429 / 5xx 是鉴权、限频或节点本身的问题，降级没有用，原样报错）
      if (err instanceof HttpError && err.status !== undefined && BATCH_REJECTED_STATUS.has(err.status)) {
        this.#disableBatch()
        await Promise.all(items.map((item) => this.#single(item)))
        return
      }
      items.forEach((item) => item.reject(err))
      return
    }
    if (!Array.isArray(body)) {
      const error = (body as RpcResponse)?.error
      const rpcError = new RpcError(error?.message ?? 'Invalid JSON-RPC batch response', error?.code, error?.data)
      // 限频 / 鉴权等节点问题：原样报错，不降级（降级成逐条请求只会让限频更严重）
      if (rpcError.nodeFault) {
        items.forEach((item) => item.reject(rpcError))
        return
      }
      // 其他（如 -32600 invalid request）：节点不支持批量，降级为逐条请求
      this.#disableBatch()
      await Promise.all(items.map((item) => this.#single(item)))
      return
    }
    const byId = new Map((body as RpcResponse[]).map((res) => [res.id, res]))
    const limited = (body as RpcResponse[]).find((res) => isBatchLimitError(res.error?.message))
    if (limited) {
      // 如 “Batch of more than 3 requests are not allowed”：按限制缩小批量后重发；
      // 限制不小于当前批量（节点的上限判断有偏差）或解析不出数字时，降级为逐条请求，避免无限重发
      const max = Number(/more than (\d+)/i.exec(limited.error?.message ?? '')?.[1])
      if (Number.isFinite(max) && max > 1 && max < items.length) {
        this.#maxBatchSize = max
        await this.#redispatch(items)
      } else {
        this.#disableBatch()
        await Promise.all(items.map((item) => this.#single(item)))
      }
      return
    }
    // 批量里个别调用被限频（JSON-RPC 429）：只把这些调用退避后单独重试
    const limitedItems: Pending[] = []
    items.forEach((item, i) => {
      const response = byId.get(ids[i])
      if (response?.error?.code === 429 && this.#retries > 0) {
        limitedItems.push(item)
      } else {
        settle(item, response)
      }
    })
    if (limitedItems.length) {
      await new Promise((r) => setTimeout(r, 500))
      await Promise.all(limitedItems.map((item) => this.#single(item)))
    }
  }

  /** 按当前的 maxBatchSize 重新分批发送（每批都比原来小，不会无限循环） */
  async #redispatch(items: Pending[]): Promise<void> {
    const size = this.#maxBatchSize
    const chunks: Pending[][] = []
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size))
    }
    await Promise.all(chunks.map((chunk) => this.#dispatch(chunk)))
  }

  async #single(item: Pending): Promise<void> {
    try {
      const body = (await this.#post({ jsonrpc: '2.0', id: nextId++, method: item.method, params: item.params })) as RpcResponse
      settle(item, body)
    } catch (err) {
      item.reject(err)
    }
  }

  #disableBatch(): void {
    this.#batch = false
  }

  async #post(payload: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await this.#fetch(this.url, {
          method: 'POST',
          headers: this.#headers,
          body: JSON.stringify(payload),
          signal: this.#timeout > 0 && Number.isFinite(this.#timeout) ? AbortSignal.timeout(this.#timeout) : undefined,
        })
      } catch (err) {
        throw new HttpError(`Request to ${this.url} failed: ${(err as Error)?.message ?? err}`)
      }
      if (response.status === 429 && attempt < this.#retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
        continue
      }
      const text = await response.text()
      let body: unknown
      try {
        body = parseJson(text)
      } catch {
        throw new HttpError(`Invalid JSON from ${this.url} (HTTP ${response.status})`, response.status)
      }
      // 非 2xx 但返回了 JSON-RPC 结构（如 403 Access forbidden、drpc 的 500 + 批量错误数组）：交给上层解析
      if (!response.ok && !Array.isArray(body) && !(body as RpcResponse)?.error) {
        throw new HttpError(`HTTP ${response.status} from ${this.url}`, response.status)
      }
      // 有的节点限频时返回 HTTP 200 + JSON-RPC 错误码 429：同样退避重试
      if (attempt < this.#retries && isRateLimited(body)) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
        continue
      }
      return body
    }
  }
}

// lamports 等 u64 以 JSON 数字返回，超过 2^53（约 900 万 SOL）时 JSON.parse 会丢精度：
// 支持 JSON.parse source text access 的环境（Node 21+、新版浏览器）直接取原文；否则先把超长整数改成字符串再解析
let sourceAccess: boolean | undefined

function parseJson(text: string): unknown {
  sourceAccess ??= (() => {
    let supported = false
    JSON.parse('1', (_key, value, context?: { source?: string }) => {
      supported = typeof context?.source === 'string'
      return value
    })
    return supported
  })()
  if (sourceAccess) {
    return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
      typeof value === 'number' && !Number.isSafeInteger(value) && Number.isInteger(value) && context?.source ? context.source : value,
    )
  }
  return JSON.parse(text.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'))
}

function isRateLimited(body: unknown): boolean {
  const responses = (Array.isArray(body) ? body : [body]) as RpcResponse[]
  return responses.length > 0 && responses.every((res) => res?.error?.code === 429)
}

function settle(item: Pending, response: RpcResponse | undefined): void {
  if (!response) {
    item.reject(new HttpError('Missing response in JSON-RPC batch'))
  } else if (response.error) {
    item.reject(new RpcError(response.error.message ?? 'JSON-RPC error', response.error.code, response.error.data))
  } else {
    item.resolve(response.result)
  }
}

export interface FallbackOptions {
  /** 出错节点的冷却时间（毫秒），期间排到最后。默认 30000 */
  cooldown?: number
}

/**
 * 多节点故障切换：按顺序使用，节点问题（网络、超时、限频、需要 Key、403 等）换下一个；
 * 参数错误等确定性错误直接抛出。出错的节点在冷却期内排到最后。
 */
export class FallbackRpc implements RpcTransport {
  readonly nodes: readonly RpcTransport[]
  readonly #cooldown: number
  readonly #failedAt: number[]

  constructor(nodes: readonly RpcTransport[], options: FallbackOptions = {}) {
    if (!nodes.length) {
      throw new Error('FallbackRpc requires at least one node')
    }
    this.nodes = nodes
    this.#cooldown = options.cooldown ?? 30_000
    this.#failedAt = nodes.map(() => 0)
  }

  async request<T = unknown>(method: string, params?: readonly unknown[]): Promise<T> {
    let lastError: unknown
    for (const index of this.#order()) {
      try {
        const result = await (this.nodes[index] as RpcTransport).request<T>(method, params)
        this.#failedAt[index] = 0
        return result
      } catch (err) {
        if (!isNodeFault(err)) {
          throw err
        }
        this.#failedAt[index] = Date.now()
        lastError = err
      }
    }
    throw lastError
  }

  #order(): number[] {
    const now = Date.now()
    const healthy: number[] = []
    const cooling: number[] = []
    this.#failedAt.forEach((at, i) => (at && now - at < this.#cooldown ? cooling : healthy).push(i))
    cooling.sort((a, b) => (this.#failedAt[a] as number) - (this.#failedAt[b] as number))
    return [...healthy, ...cooling]
  }
}
