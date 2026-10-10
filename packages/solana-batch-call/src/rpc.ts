/** 最小的 JSON-RPC 传输接口：可以传入自己的实现（如包一层 @solana/kit 的 rpc） */
export interface RpcTransport {
  request<T = unknown>(method: string, params?: readonly unknown[]): Promise<T>
  /** 节点名称，用于 AllNodesFailedError / onRequest 里标识节点；不传时自定义传输显示为 'custom' */
  readonly label?: string
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
      // 节点高度没到 minContextSlot：换节点可能成功
      code === MIN_CONTEXT_SLOT_NOT_REACHED ||
      /minimum context slot/i.test(message) ||
      /forbidden|blocked|personal token|api.?key|rate.?limit|too many|not allowed|unauthori[sz]ed|limit exceeded|disabled|not available|not supported/i.test(message)
  }
}

/** HTTP 层错误（非 2xx、网络错误、超时） */
export class HttpError extends Error {
  readonly status: number | undefined
  /** 请求超时（HttpRpcOptions.timeout） */
  readonly timeout: boolean

  constructor(message: string, status?: number, timeout = false) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.timeout = timeout
  }
}

/** JSON-RPC 错误码：节点高度还没到请求的 minContextSlot */
export const MIN_CONTEXT_SLOT_NOT_REACHED = -32016

/** 是否是请求超时（HttpRpc 的超时，或自定义传输抛出的 TimeoutError） */
export function isTimeout(err: unknown): boolean {
  return (err instanceof HttpError && err.timeout) || (err as { name?: unknown } | null)?.name === 'TimeoutError'
}

/** 是否是“节点高度没到 minContextSlot”（所有节点都落后时也算） */
export function isBehind(err: unknown): boolean {
  if (err instanceof AllNodesFailedError) {
    return err.errors.length > 0 && err.errors.every((e) => isBehind(e.error))
  }
  return err instanceof RpcError && (err.code === MIN_CONTEXT_SLOT_NOT_REACHED || /minimum context slot/i.test(err.message))
}

/**
 * 多节点时所有节点都失败（都是节点问题）。errors 是各节点的错误，按尝试顺序；
 * node 是节点名称（URL 只保留 host，不会带出 path / query 里的 API Key）
 */
export class AllNodesFailedError extends Error {
  readonly errors: ReadonlyArray<{ node: string; error: unknown }>

  constructor(errors: ReadonlyArray<{ node: string; error: unknown }>) {
    super(`All RPC nodes failed: ${errors.map((e) => `${e.node}: ${errorMessage(e.error)}`).join(' | ')}`, { cause: errors[errors.length - 1]?.error })
    this.name = 'AllNodesFailedError'
    this.errors = errors
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 是否是节点问题（应换节点重试）：除了确定性的 JSON-RPC 错误（如参数错误），其余都算（包括 AllNodesFailedError） */
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
  /** 报错信息里用的地址：只保留 origin，不带 path / query（常含 API Key） */
  readonly #safeUrl: string
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
    this.#safeUrl = safeOrigin(url)
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
        // AbortSignal.timeout 触发时是 TimeoutError（DOMException）
        const timeout = (err as { name?: unknown } | null)?.name === 'TimeoutError'
        throw new HttpError(`Request to ${this.#safeUrl} failed: ${(err as Error)?.message ?? err}`, undefined, timeout)
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
        throw new HttpError(`Invalid JSON from ${this.#safeUrl} (HTTP ${response.status})`, response.status)
      }
      // 非 2xx 但返回了 JSON-RPC 结构（如 403 Access forbidden、drpc 的 500 + 批量错误数组）：交给上层解析
      if (!response.ok && !Array.isArray(body) && !(body as RpcResponse)?.error) {
        throw new HttpError(`HTTP ${response.status} from ${this.#safeUrl}`, response.status)
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

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'invalid URL'
  }
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

/**
 * onRequest 的事件：每个 JSON-RPC 调用对每个节点的每次尝试一条（合并成批量 HTTP 请求时，批里每个调用各一条，
 * ms 是该调用从发出到返回的时间；HttpRpc 内部的 429 退避重试算在同一条里）
 */
export interface RequestEvent {
  /** 节点名称：URL 的 host，自定义传输的 label（没有时为 'custom'） */
  node: string
  method: string
  ms: number
  ok: boolean
  /** 失败时的错误 */
  error?: unknown
  /** 本次调用按故障切换顺序尝试的第几个节点（0 起）；大于 0 说明换过节点 */
  attempt: number
}

const requestListeners = new Set<(event: RequestEvent) => void>()

/**
 * 监听所有客户端发出的 JSON-RPC 调用（节点、方法、耗时、成功与否、第几次尝试），用于统计和排查。返回取消监听的函数。
 *
 * ```ts
 * const stop = onRequest((e) => console.log(e.node, e.method, e.ms, e.ok, e.attempt))
 * ```
 */
export function onRequest(listener: (event: RequestEvent) => void): () => void {
  requestListeners.add(listener)
  return () => {
    requestListeners.delete(listener)
  }
}

function emit(event: RequestEvent): void {
  for (const listener of requestListeners) {
    try {
      listener(event)
    } catch {
      // 监听函数出错不影响请求
    }
  }
}

/** 节点名称：优先用传输自带的 label；HttpRpc 取 URL 的 host（不带 path / query，避免泄露 API Key） */
export function nodeLabel(node: RpcTransport): string {
  if (typeof node.label === 'string') {
    return node.label
  }
  const base = unwrap(node)
  if (base !== node && typeof base.label === 'string') {
    return base.label
  }
  if (base instanceof HttpRpc) {
    try {
      return new URL(base.url).host || 'custom'
    } catch {
      return 'custom'
    }
  }
  return 'custom'
}

/** 去掉校验层等包装（有 inner 属性的传输），取底层节点 */
function unwrap(node: RpcTransport): RpcTransport {
  let current = node
  for (let inner = (current as { inner?: RpcTransport }).inner; inner && typeof inner.request === 'function'; inner = (current as { inner?: RpcTransport }).inner) {
    current = inner
  }
  return current
}

interface NodeHealth {
  /** 上次出错（进入冷却）的时间，0 表示健康 */
  failedAt: number
  /** 连续超时次数 */
  timeouts: number
}

// 节点健康状态按节点共享（模块级）：客户端重建后，刚出过错的节点仍排在后面。URL 节点按完整 URL，其他按对象
const healthByUrl = new Map<string, NodeHealth>()
let healthByObject = new WeakMap<object, NodeHealth>()
const MAX_TRACKED_URLS = 1000
/** 连续超时这么多次才冷却（单次超时多半只是这次请求慢） */
const TIMEOUTS_BEFORE_COOLDOWN = 3

/** 健康状态的 key：HttpRpc 按完整 URL（不同连接对象共享），其他节点按对象（去掉校验层） */
function healthKeyOf(node: RpcTransport): string | object {
  const base = unwrap(node)
  return base instanceof HttpRpc ? base.url : base
}

/** 每次用时按 key 从全局表里取：表淘汰条目后，各实例仍取到同一个对象 */
function healthOf(key: string | object): NodeHealth {
  if (typeof key === 'string') {
    let health = healthByUrl.get(key)
    if (!health) {
      health = { failedAt: 0, timeouts: 0 }
      healthByUrl.set(key, health)
      if (healthByUrl.size > MAX_TRACKED_URLS) {
        healthByUrl.delete(healthByUrl.keys().next().value as string)
      }
    }
    return health
  }
  let health = healthByObject.get(key)
  if (!health) {
    health = { failedAt: 0, timeouts: 0 }
    healthByObject.set(key, health)
  }
  return health
}

/** 测试用：清空节点健康状态 */
export function resetNodeHealth(): void {
  healthByUrl.clear()
  healthByObject = new WeakMap()
}

export interface FallbackOptions {
  /** 出错节点的冷却时间（毫秒），期间排到最后。默认 30000 */
  cooldown?: number
}

/**
 * 多节点故障切换：按顺序使用，节点问题（网络、超时、限频、需要 Key、403、高度不够等）换下一个；
 * 参数错误等确定性错误直接抛出。单个节点也用它包一层（统一 onRequest 事件），此时失败抛原始错误。
 *
 * - 出错的节点在冷却期内排到最后；健康状态按节点全局共享（URL 相同即同一节点），客户端重建后仍然有效
 * - 超时只换节点、不冷却（大批量查询慢一点很正常），同一节点连续 3 次超时才冷却
 * - 节点高度没到 minContextSlot 只换节点、不冷却（只是这次请求要求的 slot 太新）
 * - 多个节点都失败时抛 AllNodesFailedError，带上每个节点的错误
 */
export class FallbackRpc implements RpcTransport {
  readonly nodes: readonly RpcTransport[]
  readonly #cooldown: number
  /** 节点标识和健康状态的 key 不会变，构造时算好（每次请求只做一次 Map 查找） */
  readonly #labels: readonly string[]
  readonly #healthKeys: ReadonlyArray<string | object>

  constructor(nodes: readonly RpcTransport[], options: FallbackOptions = {}) {
    if (!nodes.length) {
      throw new Error('FallbackRpc requires at least one node')
    }
    this.nodes = nodes
    this.#cooldown = options.cooldown ?? 30_000
    this.#labels = nodes.map(nodeLabel)
    this.#healthKeys = nodes.map(healthKeyOf)
  }

  async request<T = unknown>(method: string, params?: readonly unknown[]): Promise<T> {
    const errors: Array<{ node: string; error: unknown }> = []
    const order = this.#order()
    for (let attempt = 0; attempt < order.length; attempt++) {
      const index = order[attempt] as number
      const node = this.nodes[index] as RpcTransport
      const label = this.#labels[index] as string
      const health = healthOf(this.#healthKeys[index] as string | object)
      const started = Date.now()
      try {
        const result = await node.request<T>(method, params)
        health.failedAt = 0
        health.timeouts = 0
        emit({ node: label, method, ms: Date.now() - started, ok: true, attempt })
        return result
      } catch (err) {
        emit({ node: label, method, ms: Date.now() - started, ok: false, error: err, attempt })
        if (!isNodeFault(err)) {
          throw err
        }
        if (isTimeout(err)) {
          if (++health.timeouts >= TIMEOUTS_BEFORE_COOLDOWN) {
            health.failedAt = Date.now()
            health.timeouts = 0
          }
        } else if (!isBehind(err)) {
          health.failedAt = Date.now()
        }
        errors.push({ node: label, error: err })
      }
    }
    if (this.nodes.length === 1) {
      throw errors[0]?.error
    }
    throw new AllNodesFailedError(errors)
  }

  #order(): number[] {
    const now = Date.now()
    const failedAt = this.#healthKeys.map((key) => healthOf(key).failedAt)
    const healthy: number[] = []
    const cooling: number[] = []
    failedAt.forEach((at, i) => (at && now - at < this.#cooldown ? cooling : healthy).push(i))
    cooling.sort((a, b) => (failedAt[a] as number) - (failedAt[b] as number))
    return [...healthy, ...cooling]
  }
}
