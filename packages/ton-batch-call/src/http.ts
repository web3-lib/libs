/**
 * toncenter v3（索引器）HTTP 访问：限频（没有 API Key 时约每秒 1 次）、限频重试、多节点故障切换
 */

/** HTTP 层错误（非 2xx、网络错误、超时） */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly timeout = false,
    readonly node?: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** 节点返回的业务错误（如参数错误、合约不存在），换节点也一样 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly node?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export class AllNodesFailedError extends Error {
  constructor(readonly errors: ReadonlyArray<{ node: string; error: unknown }>) {
    super(`All nodes failed: ${errors.map((e) => `${e.node}: ${e.error instanceof Error ? e.error.message : String(e.error)}`).join('; ')}`)
    this.name = 'AllNodesFailedError'
  }
}

export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined | null

export interface RequestOptions {
  signal?: AbortSignal
}

/** toncenter v3 风格的传输：可以传自己的实现（如带鉴权的代理） */
export interface TonTransport {
  readonly label?: string
  /** GET /api/v3/<path>，数组参数按重复的 key 传（address=a&address=b） */
  get<T = unknown>(path: string, query: Record<string, QueryValue>, options?: RequestOptions): Promise<T>
  /** POST /api/v3/<path>，JSON 请求体 */
  post<T = unknown>(path: string, body: unknown, options?: RequestOptions): Promise<T>
}

export interface ToncenterOptions {
  /** API Key（X-API-Key 请求头）：toncenter 没有 Key 时约每秒 1 次请求 */
  apiKey?: string
  /**
   * 两次请求的最小间隔（毫秒）。默认：有 apiKey 时 0，没有时 1100（toncenter 的免费额度）。
   * 自建索引器或别的服务商按需设置
   */
  minInterval?: number
  /** 单次请求超时（毫秒），<= 0 不限。默认 15000 */
  timeout?: number
  /** 限频（HTTP 429）时的重试次数（退避从 1 秒开始）。默认 3 */
  retries?: number
  headers?: Record<string, string>
  fetch?: typeof fetch
  label?: string
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })

function queryString(query: Record<string, QueryValue>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v))
    else params.append(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

/**
 * toncenter v3 节点（https://toncenter.com/api/v3 或兼容的自建索引器 / 服务商）。
 * 同一个对象发出的请求按 minInterval 排队，不会超过免费额度
 */
export class ToncenterTransport implements TonTransport {
  readonly label: string
  readonly #base: string
  readonly #headers: Record<string, string>
  readonly #minInterval: number
  readonly #timeout: number
  readonly #retries: number
  readonly #fetch: typeof fetch
  /** 下一个请求最早可以发出的时间 */
  #nextAt = 0

  constructor(url: string, options: ToncenterOptions = {}) {
    this.#base = url.replace(/\/+$/, '')
    this.#headers = { ...(options.apiKey ? { 'X-API-Key': options.apiKey } : {}), ...(options.headers ?? {}) }
    this.#minInterval = options.minInterval ?? (options.apiKey ? 0 : 1100)
    this.#timeout = options.timeout ?? 15_000
    this.#retries = Math.max(0, options.retries ?? 3)
    this.#fetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    let host = url
    try {
      host = new URL(url).host
    } catch {
      // 非法 URL：请求时会报错
    }
    this.label = options.label ?? host
  }

  get<T = unknown>(path: string, query: Record<string, QueryValue>, options: RequestOptions = {}): Promise<T> {
    return this.#request<T>(`${this.#base}/${path}${queryString(query)}`, { method: 'GET' }, options.signal)
  }

  post<T = unknown>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return this.#request<T>(`${this.#base}/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, options.signal)
  }

  /** 按 minInterval 排队：返回这个请求可以发出的时刻 */
  async #slot(signal: AbortSignal | undefined): Promise<void> {
    const now = Date.now()
    const at = Math.max(now, this.#nextAt)
    this.#nextAt = at + this.#minInterval
    if (at > now) await sleep(at - now, signal)
  }

  async #request<T>(url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.#slot(signal)
      try {
        return await this.#once<T>(url, init, signal)
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 429) || attempt >= this.#retries || signal?.aborted) throw err
        // 被限频：整个节点往后推，后面排队的请求也一起等
        const wait = 1000 * 2 ** attempt
        this.#nextAt = Math.max(this.#nextAt, Date.now() + wait)
      }
    }
  }

  async #once<T>(url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<T> {
    // 已经取消的不发出（下面的监听只管之后的取消）
    signal?.throwIfAborted()
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timer = this.#timeout > 0 ? setTimeout(() => ((timedOut = true), controller.abort()), this.#timeout) : null
    let res: Response
    let text: string
    try {
      res = await this.#fetch(url, { ...init, headers: { ...this.#headers, ...((init.headers as Record<string, string>) ?? {}) }, signal: controller.signal })
      text = await res.text()
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err
      throw new HttpError(timedOut ? `Request to ${this.label} timed out after ${this.#timeout}ms` : `Request to ${this.label} failed: ${(err as Error)?.message ?? err}`, undefined, timedOut, this.label)
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    let body: unknown
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (!res.ok) {
      const message = (body as { error?: unknown } | null)?.error
      const detail = typeof message === 'string' ? message : text.slice(0, 200)
      // 4xx（限频、鉴权除外）是请求本身的问题，换节点也一样；钱包拒绝外部消息时 toncenter 返回 500，也是确定性的
      const rejected = res.status === 500 && /message rejected|rejected by account|cannot apply external|cannot run message/i.test(detail)
      if (rejected || (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 401 && res.status !== 403)) {
        throw new ApiError(`${this.label}: HTTP ${res.status} ${detail}`, res.status, this.label)
      }
      throw new HttpError(`HTTP ${res.status} from ${this.label}: ${detail}`, res.status, false, this.label)
    }
    if (body === null) throw new HttpError(`Invalid JSON from ${this.label}`, res.status, false, this.label)
    return body as T
  }
}

/** 是不是节点的问题（应换节点重试） */
export function isNodeFault(err: unknown): boolean {
  return err instanceof HttpError || err instanceof AllNodesFailedError
}

export interface FallbackOptions {
  /** 节点出错后冷却多久（毫秒）再优先使用，默认 30000 */
  cooldown?: number
}

/** 多个节点故障切换：按健康状态排序，节点问题时依次换下一个，业务错误直接抛出 */
export class FallbackTransport implements TonTransport {
  readonly label: string
  readonly #nodes: readonly TonTransport[]
  readonly #cooldown: number
  readonly #failedAt: Array<number | null>

  constructor(nodes: readonly TonTransport[], options: FallbackOptions = {}) {
    if (!nodes.length) throw new Error('FallbackTransport needs at least one node')
    this.#nodes = nodes
    this.#cooldown = options.cooldown ?? 30_000
    this.#failedAt = nodes.map(() => null)
    this.label = nodes.map((n, i) => n.label ?? `node${i}`).join(',')
  }

  get<T = unknown>(path: string, query: Record<string, QueryValue>, options?: RequestOptions): Promise<T> {
    return this.#run((n) => n.get<T>(path, query, options), options)
  }

  post<T = unknown>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.#run((n) => n.post<T>(path, body, options), options)
  }

  async #run<T>(fn: (node: TonTransport) => Promise<T>, options?: RequestOptions): Promise<T> {
    const now = Date.now()
    const healthy = (i: number) => {
      const t = this.#failedAt[i]
      return t === null || t === undefined || now - t > this.#cooldown
    }
    const indexes = this.#nodes.map((_, i) => i)
    const order = [...indexes.filter(healthy), ...indexes.filter((i) => !healthy(i)).sort((a, b) => (this.#failedAt[a] ?? 0) - (this.#failedAt[b] ?? 0))]
    const errors: Array<{ node: string; error: unknown }> = []
    for (const i of order) {
      const node = this.#nodes[i] as TonTransport
      try {
        const result = await fn(node)
        this.#failedAt[i] = null
        return result
      } catch (err) {
        if (options?.signal?.aborted || !isNodeFault(err)) throw err
        this.#failedAt[i] = Date.now()
        errors.push({ node: node.label ?? `node${i}`, error: err })
      }
    }
    if (errors.length === 1) throw errors[0]?.error
    throw new AllNodesFailedError(errors)
  }
}
