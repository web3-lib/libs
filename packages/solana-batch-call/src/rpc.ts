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
    const kind = classifyRpcError(code, message)
    this.nodeFault =
      code === 403 ||
      code === -32005 ||
      // 节点高度没到 minContextSlot、限频、服务端临时故障（繁忙、过载、暂不可用、超时）：换节点可能成功；
      // 临时故障也不应据此关闭批量（降级只会加重负载）
      kind === 'min-slot' ||
      kind === 'rate-limited' ||
      kind === 'transient' ||
      (/forbidden|blocked|personal token|api.?key|too many|not allowed|unauthori[sz]ed|limit exceeded|disabled|not available|not supported/i.test(message) &&
        kind !== 'too-many-accounts')
  }
}

/**
 * JSON-RPC 错误的分类（RpcError.nodeFault、HTTP 5xx 的处理共用，避免两份清单各自维护）：
 * - method-limit / too-many-accounts：节点对批量 / 单次账户数的限制，按限制重新分批或缩小
 * - invalid-params：参数错误（-32602），确定性的
 * - min-slot / rate-limited / transient：节点落后、限频、服务端临时故障，换节点
 * - internal：-32603 internal error，含义不明确（可能是临时故障，也可能是节点拒绝批量）
 */
type RpcErrorKind = 'method-limit' | 'too-many-accounts' | 'invalid-params' | 'min-slot' | 'rate-limited' | 'transient' | 'internal' | 'other'

function classifyRpcError(code: number | undefined, message: string): RpcErrorKind {
  if (METHOD_LIMIT.test(message)) return 'method-limit'
  if (TOO_MANY_ACCOUNTS.test(message)) return 'too-many-accounts'
  if (code === -32602) return 'invalid-params'
  if (code === MIN_CONTEXT_SLOT_NOT_REACHED || /minimum context slot/i.test(message)) return 'min-slot'
  if (code === 429 || RATE_LIMITED.test(message)) return 'rate-limited'
  if (TRANSIENT.test(message)) return 'transient'
  if (code === -32603) return 'internal'
  return 'other'
}

/** 节点限制单个方法在批量里的数量（如 publicnode：“Maximum number of 'getMultipleAccounts' calls in a batch request is 1”） */
const METHOD_LIMIT = /maximum number of '([^']+)' calls in a batch request is (\d+)/i

/** 限频的报错 */
const RATE_LIMITED = /rate.?limit|too many requests/i

/** 服务端临时故障的报错（如 -32000 server is busy、-32603 + 503 overloaded） */
const TRANSIENT = /\bbusy\b|overload|temporar(il)?y|unavailable|try again|timed? ?out|timeout/i

/** 节点限制单次 getMultipleAccounts 的账户数（如 “Too many accounts requested”）：缩小每次的账户数后重试，不是节点故障 */
const TOO_MANY_ACCOUNTS = /too many accounts/i

/** HTTP 层错误（非 2xx、网络错误、超时） */
export class HttpError extends Error {
  readonly status: number | undefined
  /** 请求超时（HttpRpcOptions.timeout） */
  readonly timeout: boolean

  /** 5xx 的响应体是 JSON-RPC 错误（服务端故障，或节点用 5xx 拒绝批量请求） */
  readonly rpcError: boolean

  constructor(message: string, status?: number, timeout = false, rpcError = false) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.timeout = timeout
    this.rpcError = rpcError
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

/** 节点不支持批量时，多久后重新尝试批量 */
const BATCH_RETRY_AFTER = 10 * 60 * 1000

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
  /** 节点对单个方法在一个批量里的数量限制（如 publicnode：getMultipleAccounts 最多 1 个），从报错里学到 */
  readonly #methodLimits = new Map<string, number>()
  /** options.batch：调用方是否允许批量 */
  readonly #batchOption: boolean
  /** 节点明确表示不支持批量时，在这之前逐条请求（之后重新尝试批量） */
  #batchDisabledUntil = 0
  /** 节点限制单次 getMultipleAccounts 的账户数时学到的上限 */
  #maxAccounts: number | undefined
  #queue: Pending[] = []
  #timer: ReturnType<typeof setTimeout> | null = null

  constructor(url: string, options: HttpRpcOptions = {}) {
    this.url = url
    this.#safeUrl = safeOrigin(url)
    this.#timeout = options.timeout ?? 10_000
    this.#headers = { 'content-type': 'application/json', ...options.headers }
    this.#maxBatchSize = Math.max(1, options.maxBatchSize ?? 20)
    this.#batchOption = options.batch ?? true
    this.#batchWait = options.batchWait ?? 0
    this.#retries = Math.max(0, options.retries ?? 2)
    this.#fetch = options.fetch ?? ((...args) => fetch(...args))
  }

  request<T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> {
    if (method === 'getMultipleAccounts' && Array.isArray(params[0])) {
      return this.#getMultipleAccounts(params) as Promise<T>
    }
    return this.#enqueue<T>(method, params)
  }

  /**
   * getMultipleAccounts：节点限制单次账户数时（“Too many accounts requested”），减半后分多次请求、合并结果，
   * 并记下上限，之后直接按上限拆分。合并后 context.slot 取最小值
   */
  async #getMultipleAccounts(params: readonly unknown[]): Promise<unknown> {
    const [addresses, ...rest] = params as [unknown[], ...unknown[]]
    const max = this.#maxAccounts
    if (max !== undefined && addresses.length > max) {
      const parts: unknown[][] = []
      for (let i = 0; i < addresses.length; i += max) {
        parts.push(addresses.slice(i, i + max))
      }
      const results = (await Promise.all(parts.map((part) => this.#getMultipleAccounts([part, ...rest])))) as Array<{
        context?: { slot?: number }
        value?: unknown[]
      }>
      const slots = results.map((r) => r?.context?.slot).filter((slot): slot is number => typeof slot === 'number')
      return {
        ...results[0],
        context: { ...results[0]?.context, ...(slots.length ? { slot: Math.min(...slots) } : {}) },
        value: results.flatMap((r) => r?.value ?? []),
      }
    }
    try {
      return await this.#enqueue('getMultipleAccounts', params)
    } catch (err) {
      if (err instanceof RpcError && TOO_MANY_ACCOUNTS.test(err.message) && addresses.length > 1) {
        this.#maxAccounts = Math.max(1, Math.min(this.#maxAccounts ?? Number.POSITIVE_INFINITY, Math.floor(addresses.length / 2)))
        return this.#getMultipleAccounts(params)
      }
      throw err
    }
  }

  /** 是否合并成批量请求：调用方允许，且不在 “节点不支持批量” 的冷却期内 */
  get #batch(): boolean {
    return this.#batchOption && Date.now() >= this.#batchDisabledUntil
  }

  #enqueue<T>(method: string, params: readonly unknown[]): Promise<T> {
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
    for (const chunk of this.#split(queue)) {
      void this.#dispatch(chunk)
    }
  }

  /** 按 maxBatchSize 和各方法的数量限制分批（保持顺序；不受限的方法照常合并） */
  #split(items: readonly Pending[]): Pending[][] {
    const chunks: Pending[][] = []
    let current: Pending[] = []
    let counts = new Map<string, number>()
    for (const item of items) {
      const limit = this.#methodLimits.get(item.method)
      const count = counts.get(item.method) ?? 0
      if (current.length >= this.#maxBatchSize || (limit !== undefined && count >= limit)) {
        chunks.push(current)
        current = []
        counts = new Map()
      }
      current.push(item)
      counts.set(item.method, (counts.get(item.method) ?? 0) + 1)
    }
    if (current.length) {
      chunks.push(current)
    }
    return chunks
  }

  /**
   * 报错是 “某方法在批量里的数量超限” 时（如 “Maximum number of 'getMultipleAccounts' calls in a batch request is 1”），
   * 记下限制并按限制重新分批，返回 true；限制解析不出或这批本来就没超限（避免无限重发）时返回 false
   */
  async #retryWithMethodLimit(items: Pending[], message: string | undefined): Promise<boolean> {
    const match = METHOD_LIMIT.exec(message ?? '')
    const method = match?.[1]
    const limit = Number(match?.[2])
    if (!method || !Number.isFinite(limit) || limit < 1 || items.filter((item) => item.method === method).length <= limit) {
      return false
    }
    this.#methodLimits.set(method, limit)
    await Promise.all(this.#split(items).map((chunk) => this.#dispatch(chunk)))
    return true
  }

  /** retriedServerError：这一批已经因 5xx + JSON-RPC 错误重试过一次 */
  async #dispatch(items: Pending[], retriedServerError = false): Promise<void> {
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
      // 5xx + -32603（含义不明确：临时故障，或节点用 5xx 拒绝批量）：先原样重试一次批量（偶发故障这次就成功了，不降级）；
      // 仍然失败时只用第一条单独试探——成功说明是批量本身被拒，暂停批量（10 分钟后重试）并逐条发送其余的；
      // 失败则是临时故障，其余的直接报错（换节点），不给出问题的节点加量
      if (err instanceof HttpError && err.rpcError && items.length > 1) {
        if (!retriedServerError) {
          await this.#dispatch(items, true)
          return
        }
        const [first, ...rest] = items as [Pending, ...Pending[]]
        if (await this.#single(first)) {
          this.#disableBatch()
          await Promise.all(rest.map((item) => this.#single(item)))
        } else {
          rest.forEach((item) => item.reject(err))
        }
        return
      }
      items.forEach((item) => item.reject(err))
      return
    }
    if (!Array.isArray(body)) {
      const error = (body as RpcResponse)?.error
      // 单个方法在批量里的数量超限（整批被拒）：按限制重新分批，不当成节点问题
      if (await this.#retryWithMethodLimit(items, error?.message)) {
        return
      }
      const rpcError = new RpcError(error?.message ?? 'Invalid JSON-RPC batch response', error?.code, error?.data)
      // 限频 / 鉴权等节点问题：原样报错，不降级（降级成逐条请求只会让限频更严重）
      if (rpcError.nodeFault) {
        items.forEach((item) => item.reject(rpcError))
        return
      }
      // 整批被拒（不是账户数超限）：节点多半不支持批量（各家错误码不同：-32600 / -32601 / -32700 …），
      // 一段时间内改为逐条请求（10 分钟后重新尝试批量，偶发的错误不会永久关闭）；不关的话每批都要先失败一次再逐条重发。
      // 账户数超限只把这一批逐条重发（由 HTTP 层按节点缩小单次读取数量）
      if (!TOO_MANY_ACCOUNTS.test(error?.message ?? '')) {
        this.#disableBatch()
      }
      await Promise.all(items.map((item) => this.#single(item)))
      return
    }
    const byId = new Map((body as RpcResponse[]).map((res) => [res.id, res]))
    // 有的节点把 “方法数量超限” 放在批量结果的某一项里
    const methodLimited = (body as RpcResponse[]).find((res) => METHOD_LIMIT.test(res.error?.message ?? ''))
    if (methodLimited && (await this.#retryWithMethodLimit(items, methodLimited.error?.message))) {
      return
    }
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
    // 批量里个别调用被限频（JSON-RPC 429）：只把这些调用退避后单独重试一次（不再叠加 #post 的重试）；
    // 整批都是 429 时 #post 已经退避重试过整批，不再逐条重试——否则请求数会成倍放大
    const allLimited = isRateLimited(body)
    const limitedItems: Pending[] = []
    items.forEach((item, i) => {
      const response = byId.get(ids[i])
      if (response?.error?.code === 429 && this.#retries > 0 && !allLimited) {
        limitedItems.push(item)
      } else {
        settle(item, response)
      }
    })
    if (limitedItems.length) {
      await new Promise((r) => setTimeout(r, 500))
      await Promise.all(limitedItems.map((item) => this.#single(item, 0)))
    }
  }

  /** 按当前的 maxBatchSize 重新分批发送（每批都比原来小，不会无限循环） */
  async #redispatch(items: Pending[]): Promise<void> {
    await Promise.all(this.#split(items).map((chunk) => this.#dispatch(chunk)))
  }

  /** 逐条发送一个调用；返回是否拿到了结果（没有出错） */
  async #single(item: Pending, retries = this.#retries): Promise<boolean> {
    try {
      const body = (await this.#post({ jsonrpc: '2.0', id: nextId++, method: item.method, params: item.params }, retries)) as RpcResponse
      settle(item, body)
      return !body?.error
    } catch (err) {
      item.reject(err)
      return false
    }
  }

  /** 节点明确表示不支持批量：10 分钟内逐条请求，之后重新尝试批量（节点可能只是临时出错或已经升级） */
  #disableBatch(): void {
    this.#batchDisabledUntil = Date.now() + BATCH_RETRY_AFTER
  }

  async #post(payload: unknown, retries = this.#retries): Promise<unknown> {
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
      if (response.status === 429 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
        continue
      }
      let text: string
      try {
        text = await response.text()
      } catch (err) {
        // 读响应体时超时或连接中断：同样包装成 HttpError（原生 DOMException / TypeError 不会被当成可恢复的节点问题）
        const timeout = (err as { name?: unknown } | null)?.name === 'TimeoutError'
        throw new HttpError(`Reading response from ${this.#safeUrl} failed: ${(err as Error)?.message ?? err}`, response.status, timeout)
      }
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
      // 5xx + 单个 JSON-RPC 错误：
      // - 繁忙、过载等明确的临时故障：按 HTTP 错误处理，直接换节点（不重试、不逐条，不给过载的节点加量）
      // - -32603 internal error：含义不明确，标记 rpcError，由 #dispatch 判断是临时故障还是节点用 5xx 拒绝批量
      // 其他错误（方法数量超限、账户数超限、参数错误、minContextSlot、限频等）照常交给上层按类型处理
      const bodyError = response.status >= 500 && !Array.isArray(body) ? (body as RpcResponse)?.error : undefined
      const kind = bodyError ? classifyRpcError(bodyError.code, bodyError.message ?? '') : undefined
      if (kind === 'transient' || kind === 'internal') {
        const message = bodyError?.message
        throw new HttpError(`HTTP ${response.status} from ${this.#safeUrl}${message ? `: ${message}` : ''}`, response.status, false, kind === 'internal')
      }
      // 有的节点限频时返回 HTTP 200 + JSON-RPC 错误码 429：同样退避重试
      if (attempt < retries && isRateLimited(body)) {
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
  return JSON.parse(quoteBigIntegers(text))
}

/**
 * 把 JSON 文本里数值位置上 16 位以上的整数改成字符串（不支持 source text access 的环境用）。
 * 跳过字符串字面量：错误信息等字符串里的长数字不会被改动
 */
export function quoteBigIntegers(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) =>
    token[0] !== '"' && /^-?\d{16,}$/.test(token) ? `"${token}"` : token,
  )
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
