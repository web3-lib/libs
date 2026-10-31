import { mapPool, sleep } from './util.js'

/** RpcTransport.request 的第三个参数（可选，自定义传输可以忽略） */
export interface RpcRequestOptions {
  /**
   * 取消：已取消时不发请求，中途取消时 reject（reason 为 signal.reason）。
   * HttpRpc 会把它传到 fetch：还在排队的调用直接移出队列，已发出的批量请求在所有成员都取消后中止；FallbackRpc 取消后不再换节点
   */
  signal?: AbortSignal
}

/** 最小的 JSON-RPC 传输接口：可以传入自己的实现（如包一层 @solana/kit 的 rpc）；options 是 0.6.1 新增的可选参数，不处理也能照常工作 */
export interface RpcTransport {
  request<T = unknown>(method: string, params?: readonly unknown[], options?: RpcRequestOptions): Promise<T>
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
const TOO_MANY_ACCOUNTS = /too many accounts|maximum of \d+ accounts/i
/**
 * publicnode 对单次超过 10 个账户的 getMultipleAccounts 返回 HTTP 403 +“Request blocked”（2026-10，而且要等 3 秒多才返回）：
 * 账户数超过 BLOCKED_LIMIT 时直接按它拆分（逐次减半要多等好几轮），还被拒绝再减半；
 * 账户数已经很少（≤ BLOCKED_FLOOR）还被拒绝时，是节点真的拒绝访问，交给上层换节点
 */
const REQUEST_BLOCKED = /request blocked/i
const BLOCKED_LIMIT = 10
const BLOCKED_FLOOR = 8

/** 节点的限制：单个方法在一个批量里的数量、单次 getMultipleAccounts 的账户数 */
interface NodeLimits {
  methods: Map<string, number>
  maxAccounts?: number
}

/** 按节点地址记的表（健康状态、学到的限制、在途请求数）的条目上限，超出时淘汰最早加入的 */
const MAX_TRACKED_URLS = 1000

/** 按节点地址取条目，没有时创建；表的条目数有上限（淘汰最早加入的） */
function trackedEntry<V>(map: Map<string, V>, url: string, create: () => V): V {
  let entry = map.get(url)
  if (!entry) {
    entry = create()
    map.set(url, entry)
    if (map.size > MAX_TRACKED_URLS) {
      map.delete(map.keys().next().value as string)
    }
  }
  return entry
}

/**
 * 已知节点的限制（2026-10 实测），首次请求就按它拆分，不必先撞一次报错：
 * publicnode 单次 getMultipleAccounts 最多 10 个账户、一个批量里最多 1 个 getMultipleAccounts，
 * 超过账户数要等 3 秒多才返回 403
 */
function presetLimits(url: string): NodeLimits {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    // 地址不合法：没有预置限制
  }
  if (/^solana[\w-]*\.publicnode\.com$/i.test(host)) {
    return { methods: new Map([['getMultipleAccounts', 1]]), maxAccounts: BLOCKED_LIMIT }
  }
  return { methods: new Map() }
}

/** 从报错里学到的节点限制（含预置的已知限制），按节点地址共享（同一个节点的多个客户端不用各自再试一遍） */
const learnedLimits = new Map<string, NodeLimits>()

function learnedFor(url: string): NodeLimits {
  return trackedEntry(learnedLimits, url, () => presetLimits(url))
}

/** 测试用：清空学到的节点限制（预置的已知限制在下次创建连接时重新带上） */
export function resetLearnedLimits(): void {
  learnedLimits.clear()
}

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
  /**
   * 单次 HTTP 请求超时（毫秒），<= 0 不限制。默认 10000。排队等并发名额（maxConcurrency）最多也等这么久，
   * 等不到按超时处理（多节点时换节点）；拿到名额、真正发出后重新计时
   */
  timeout?: number
  headers?: Record<string, string>
  /** 一个 HTTP 批量请求最多包含的调用数。默认 20 */
  maxBatchSize?: number
  /** 是否合并成 JSON-RPC 批量请求。默认 true；节点不支持时会自动关闭 */
  batch?: boolean
  /** 收集窗口（毫秒），窗口内的调用合并成一个 HTTP 请求。默认 0（同一 tick） */
  batchWait?: number
  /** 遇到 HTTP 429 时的重试次数（指数退避，从 500ms 开始，带随机抖动；有 Retry-After 头时按它等）。默认 2 */
  retries?: number
  /** 自定义 fetch（如需要代理时） */
  fetch?: typeof fetch
  /**
   * 同一节点地址同时在途的 HTTP 请求数上限（按 URL 在所有 HttpRpc 实例间共享，超出的排队）。默认 4；<= 0 或 Infinity 不限制
   */
  maxConcurrency?: number
  /** 同一个批量请求里 method 和 params 完全相同的只读调用只发一次、结果分给各调用方。默认 true */
  dedupe?: boolean
}

/** 一个调用方（同一调用去重后可能有多个） */
interface Waiter {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  signal?: AbortSignal
  cleanup?: () => void
}

/** 队列里的一个调用（去重后：method + params 相同的调用方共用一个） */
interface Pending {
  method: string
  params: readonly unknown[]
  /** 去重用的 key；不参与去重时为 undefined */
  key: string | undefined
  waiters: Waiter[]
  /** 已经有结果（或已移出队列） */
  done: boolean
  /** 包含它、正在进行的 HTTP 请求 */
  posts: Set<Post>
}

/** 一次 HTTP 请求（单个或批量）：成员都取消后中止 */
interface Post {
  items: readonly Pending[]
  controller: AbortController
}

interface RpcResponse {
  id?: number | string | null
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

let nextId = 1

/** 批量请求被拒绝、可以降级为逐条请求的 HTTP 状态 */
const BATCH_REJECTED_STATUS = new Set([400, 404, 405, 415, 422])

/** 节点不支持批量 / 限制批量大小时，多久后重新尝试（批量、原来的批量大小） */
const BATCH_RETRY_AFTER = 10 * 60 * 1000

/** 有副作用、不能去重的方法 */
const WRITE_METHOD = /^(send|requestAirdrop)/

/** 429 时 Retry-After 超过这个时间（毫秒）就不等了，直接报错（交给上层换节点） */
const MAX_RETRY_AFTER = 10_000

function isBatchLimitError(message: string | undefined): boolean {
  return !!message && /batch/i.test(message) && /more than \d+|too (large|many|big)|not (allowed|supported)|exceed/i.test(message)
}

/**
 * 429 后的等待时间：有 Retry-After（秒数或 HTTP 日期）时按它，超过 MAX_RETRY_AFTER 时返回 null（不等，直接报错）；
 * 否则指数退避（500ms 起）加 ±25% 随机抖动，避免同时被限频的请求又同时重试
 */
export function retryDelay(attempt: number, retryAfter: string | null | undefined): number | null {
  const header = retryAfter?.trim()
  if (header) {
    const seconds = Number(header)
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
    if (Number.isFinite(ms)) {
      return ms > MAX_RETRY_AFTER ? null : Math.max(0, ms)
    }
  }
  return Math.round(500 * 2 ** attempt * (0.75 + Math.random() * 0.5))
}

/** 合并多个 AbortSignal（AbortSignal.any 不可用的旧环境手动合并） */
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (signals.length === 1) {
    return signals[0] as AbortSignal
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(signals as AbortSignal[])
  }
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true, signal: controller.signal })
  }
  return controller.signal
}

/** 同一节点地址的在途 HTTP 请求数（所有 HttpRpc 实例共享）；waiting 里每项带自己的上限 */
interface Slots {
  active: number
  waiting: Array<{ limit: number; start: () => void }>
}

const slotsByUrl = new Map<string, Slots>()

/** 拿一个并发名额（先来先得）；signal 取消时不再等 */
function acquireSlot(slots: Slots, limit: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason)
  }
  if (slots.active < limit && !slots.waiting.length) {
    slots.active++
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const entry = {
      limit,
      start: () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
    }
    const onAbort = () => {
      const i = slots.waiting.indexOf(entry)
      if (i !== -1) {
        slots.waiting.splice(i, 1)
        drainSlots(slots)
      }
      reject(signal.reason)
    }
    slots.waiting.push(entry)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function releaseSlot(slots: Slots): void {
  slots.active--
  drainSlots(slots)
}

function drainSlots(slots: Slots): void {
  for (let head = slots.waiting[0]; head && slots.active < head.limit; head = slots.waiting[0]) {
    slots.waiting.shift()
    slots.active++
    head.start()
  }
}

/** 调用方是否都已取消（没有调用方传 signal 时不会） */
function abandoned(item: Pending): boolean {
  return item.waiters.every((w) => w.signal?.aborted)
}

/** 还需要结果：没有结果、也没被所有调用方放弃 */
function live(item: Pending): boolean {
  return !item.done && !abandoned(item)
}

/** 去重后的结果按调用方各给一份：第一个调用方拿原对象，其余的拿副本（调用方修改结果不会影响别人） */
function copyResult(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
}

function resolveItem(item: Pending, value: unknown): void {
  if (item.done) return
  item.done = true
  item.waiters.forEach((waiter, i) => {
    waiter.cleanup?.()
    waiter.resolve(i === 0 ? value : copyResult(value))
  })
}

function rejectItem(item: Pending, reason: unknown): void {
  if (item.done) return
  item.done = true
  for (const waiter of item.waiters) {
    waiter.cleanup?.()
    waiter.reject(reason)
  }
}

/**
 * 基于 fetch 的 JSON-RPC 传输：同一收集窗口内的调用合并成一个 JSON-RPC 批量请求。
 * 节点不支持批量（返回非数组）或限制批量大小（如 drpc 免费档最多 3 条）时自动降级。
 * 同一节点地址同时在途的 HTTP 请求数有上限（maxConcurrency，默认 4）；request 的 signal 会传到 fetch
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
  readonly #maxBatchSize: number
  readonly #maxConcurrency: number
  readonly #dedupe: boolean
  /** 节点限制批量大小（413、“more than N”）时临时调小的批量大小，到期恢复 maxBatchSize */
  #batchLimit: { size: number; until: number } | null = null
  /** 从报错里学到的限制（按节点地址共享，含预置的已知限制）：单个方法在一个批量里的数量（如 publicnode：getMultipleAccounts 最多 1 个）、单次的账户数 */
  readonly #learned: NodeLimits
  /** options.batch：调用方是否允许批量 */
  readonly #batchOption: boolean
  /** 节点明确表示不支持批量时，在这之前逐条请求（之后重新尝试批量） */
  #batchDisabledUntil = 0
  #queue: Pending[] = []
  /** 队列里可去重的调用（key → 调用），flush 时清空 */
  #queuedByKey = new Map<string, Pending>()
  #timer: ReturnType<typeof setTimeout> | null = null

  constructor(url: string, options: HttpRpcOptions = {}) {
    this.url = url
    this.#safeUrl = safeOrigin(url)
    this.#learned = learnedFor(url)
    this.#timeout = options.timeout ?? 10_000
    this.#headers = { 'content-type': 'application/json', ...options.headers }
    this.#maxBatchSize = Math.max(1, options.maxBatchSize ?? 20)
    this.#batchOption = options.batch ?? true
    this.#batchWait = options.batchWait ?? 0
    this.#retries = Math.max(0, options.retries ?? 2)
    this.#fetch = options.fetch ?? ((...args) => fetch(...args))
    const concurrency = options.maxConcurrency ?? 4
    this.#maxConcurrency = concurrency > 0 ? concurrency : Number.POSITIVE_INFINITY
    this.#dedupe = options.dedupe ?? true
  }

  request<T = unknown>(method: string, params: readonly unknown[] = [], options?: RpcRequestOptions): Promise<T> {
    const signal = options?.signal
    if (method === 'getMultipleAccounts' && Array.isArray(params[0])) {
      return this.#getMultipleAccounts(params, signal) as Promise<T>
    }
    return this.#enqueue<T>(method, params, signal)
  }

  /**
   * getMultipleAccounts：节点限制单次账户数时（“Too many accounts requested”），减半后分多次请求、合并结果，
   * 并记下上限，之后直接按上限拆分。合并后 context.slot 取最小值。
   * 拆分后的子请求用并发池发出：一个失败后不再发后面的（节点多半在限频或拒绝），取消后也不再发
   */
  async #getMultipleAccounts(params: readonly unknown[], signal: AbortSignal | undefined): Promise<unknown> {
    const [addresses, ...rest] = params as [unknown[], ...unknown[]]
    const max = this.#learned.maxAccounts
    if (max !== undefined && addresses.length > max) {
      const parts: unknown[][] = []
      for (let i = 0; i < addresses.length; i += max) {
        parts.push(addresses.slice(i, i + max))
      }
      // 同时排队的子请求数：够把所有并发名额用满即可（每个 HTTP 请求能带几个 getMultipleAccounts × 并发上限）
      const perPost = this.#batch ? (this.#learned.methods.get('getMultipleAccounts') ?? this.#batchSize) : 1
      const limit = Number.isFinite(this.#maxConcurrency) ? this.#maxConcurrency * perPost : parts.length
      const results = (await mapPool(parts, limit, (part) => this.#getMultipleAccounts([part, ...rest], signal))) as Array<{
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
      return await this.#enqueue('getMultipleAccounts', params, signal)
    } catch (err) {
      const tooMany = err instanceof RpcError && TOO_MANY_ACCOUNTS.test(err.message) && addresses.length > 1
      const blocked = err instanceof RpcError && REQUEST_BLOCKED.test(err.message) && addresses.length > BLOCKED_FLOOR
      if (tooMany || blocked) {
        // publicnode（2026-10）：“A maximum of 10 accounts is allowed”，报错里直接给出上限
        const stated = Number(/maximum of (\d+) accounts/i.exec(err.message)?.[1])
        const next = stated >= 1 ? stated : blocked && addresses.length > BLOCKED_LIMIT ? BLOCKED_LIMIT : Math.floor(addresses.length / 2)
        this.#learned.maxAccounts = Math.max(1, Math.min(this.#learned.maxAccounts ?? Number.POSITIVE_INFINITY, next))
        return this.#getMultipleAccounts(params, signal)
      }
      throw err
    }
  }

  /** 是否合并成批量请求：调用方允许，且不在 “节点不支持批量” 的冷却期内 */
  get #batch(): boolean {
    return this.#batchOption && Date.now() >= this.#batchDisabledUntil
  }

  /** 当前的批量大小：节点限制过批量大小时，冷却期内用调小后的值，到期恢复 */
  get #batchSize(): number {
    const limit = this.#batchLimit
    if (limit && Date.now() < limit.until) {
      return limit.size
    }
    this.#batchLimit = null
    return this.#maxBatchSize
  }

  /** 节点限制批量大小：10 分钟内按 size 分批，之后恢复（偶发的 413 不会永久缩小批量） */
  #limitBatchSize(size: number): void {
    this.#batchLimit = { size: Math.max(1, Math.min(size, this.#batchSize)), until: Date.now() + BATCH_RETRY_AFTER }
  }

  #enqueue<T>(method: string, params: readonly unknown[], signal: AbortSignal | undefined): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason)
    }
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = { resolve: resolve as (value: unknown) => void, reject, signal }
      let key: string | undefined
      if (this.#dedupe && !WRITE_METHOD.test(method)) {
        try {
          key = `${method}\u0000${JSON.stringify(params)}`
        } catch {
          key = undefined // 参数不能序列化（如 bigint）：不去重，发送时照常报错
        }
      }
      const existing = key === undefined ? undefined : this.#queuedByKey.get(key)
      const item: Pending = existing ?? { method, params, key, waiters: [], done: false, posts: new Set() }
      item.waiters.push(waiter)
      if (signal) {
        const onAbort = () => this.#abortWaiter(item, waiter)
        signal.addEventListener('abort', onAbort, { once: true })
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort)
      }
      if (existing) {
        return // 同一批里相同的调用：共用一个结果
      }
      this.#queue.push(item)
      if (key !== undefined) {
        this.#queuedByKey.set(key, item)
      }
      if (!this.#batch || this.#queue.length >= this.#batchSize) {
        this.#flush()
      } else if (!this.#timer) {
        this.#timer = setTimeout(() => this.#flush(), this.#batchWait)
      }
    })
  }

  /**
   * 调用方取消：立即 reject 这个调用方；同一调用的其他调用方都取消时，还在排队的移出队列，
   * 已发出的 HTTP 请求在所有成员都被取消后中止
   */
  #abortWaiter(item: Pending, waiter: Waiter): void {
    waiter.cleanup?.()
    waiter.reject(waiter.signal?.reason)
    if (item.done || !abandoned(item)) {
      return
    }
    const index = this.#queue.indexOf(item)
    if (index !== -1) {
      this.#queue.splice(index, 1)
      if (item.key !== undefined && this.#queuedByKey.get(item.key) === item) {
        this.#queuedByKey.delete(item.key)
      }
      item.done = true
      return
    }
    for (const post of item.posts) {
      if (post.items.every(abandoned)) {
        post.controller.abort(waiter.signal?.reason)
      }
    }
  }

  #flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    const queue = this.#queue
    this.#queue = []
    this.#queuedByKey = new Map()
    for (const chunk of this.#split(queue)) {
      void this.#dispatch(chunk)
    }
  }

  /** 按批量大小和各方法的数量限制分批（保持顺序；不受限的方法照常合并） */
  #split(items: readonly Pending[]): Pending[][] {
    const chunks: Pending[][] = []
    const batchSize = this.#batchSize
    let current: Pending[] = []
    let counts = new Map<string, number>()
    for (const item of items) {
      const limit = this.#learned.methods.get(item.method)
      const count = counts.get(item.method) ?? 0
      if (current.length >= batchSize || (limit !== undefined && count >= limit)) {
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
    this.#learned.methods.set(method, limit)
    await this.#redispatch(items)
    return true
  }

  /** retriedServerError：这一批已经因 5xx + JSON-RPC 错误重试过一次 */
  async #dispatch(chunk: Pending[], retriedServerError = false): Promise<void> {
    // 已被所有调用方取消的不再发
    const items = chunk.filter(live)
    if (!items.length) {
      return
    }
    if (items.length === 1 || !this.#batch) {
      await Promise.all(items.map((item) => this.#single(item)))
      return
    }
    const ids = items.map(() => nextId++)
    let posted: { body: unknown; retryAfter: string | null }
    try {
      posted = await this.#post(
        items.map((item, i) => ({ jsonrpc: '2.0', id: ids[i], method: item.method, params: item.params })),
        items,
      )
    } catch (err) {
      if (items.every((item) => !live(item))) {
        return // 调用方都取消了（各自已经 reject）
      }
      if (err instanceof HttpError && err.status === 413 && items.length > 1) {
        // 请求体太大：批量减半后重发（一段时间后恢复原来的批量大小）
        this.#limitBatchSize(Math.floor(items.length / 2))
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
        // 试探用还需要结果的第一条（期间被取消的不再发）
        const remaining = items.filter(live)
        if (!remaining.length) {
          return
        }
        const [first, ...rest] = remaining as [Pending, ...Pending[]]
        if (await this.#single(first)) {
          this.#disableBatch()
          await Promise.all(rest.map((item) => this.#single(item)))
        } else {
          rest.forEach((item) => rejectItem(item, err))
        }
        return
      }
      items.forEach((item) => rejectItem(item, err))
      return
    }
    const { body } = posted
    if (!Array.isArray(body)) {
      const error = (body as RpcResponse)?.error
      // 单个方法在批量里的数量超限（整批被拒）：按限制重新分批，不当成节点问题
      if (await this.#retryWithMethodLimit(items, error?.message)) {
        return
      }
      const rpcError = new RpcError(error?.message ?? 'Invalid JSON-RPC batch response', error?.code, error?.data)
      // 限频 / 鉴权等节点问题：原样报错，不降级（降级成逐条请求只会让限频更严重）
      if (rpcError.nodeFault) {
        items.forEach((item) => rejectItem(item, rpcError))
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
      // 如 “Batch of more than 3 requests are not allowed”：按限制缩小批量后重发（一段时间后恢复）；
      // 限制不小于当前批量（节点的上限判断有偏差）或解析不出数字时，降级为逐条请求，避免无限重发
      const max = Number(/more than (\d+)/i.exec(limited.error?.message ?? '')?.[1])
      if (Number.isFinite(max) && max > 1 && max < items.length) {
        this.#limitBatchSize(max)
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
      const wait = retryDelay(0, posted.retryAfter)
      if (wait === null) {
        limitedItems.forEach((item) => settle(item, byId.get(ids[items.indexOf(item)])))
        return
      }
      await sleep(wait)
      await Promise.all(limitedItems.map((item) => this.#single(item, 0)))
    }
  }

  /** 按当前的批量大小重新分批发送（每批都比原来小，不会无限循环） */
  async #redispatch(items: Pending[]): Promise<void> {
    await Promise.all(this.#split(items.filter(live)).map((chunk) => this.#dispatch(chunk)))
  }

  /** 逐条发送一个调用；返回是否拿到了结果（没有出错） */
  async #single(item: Pending, retries = this.#retries): Promise<boolean> {
    if (!live(item)) {
      return false
    }
    try {
      const { body } = await this.#post({ jsonrpc: '2.0', id: nextId++, method: item.method, params: item.params }, [item], retries)
      settle(item, body as RpcResponse)
      return !(body as RpcResponse)?.error
    } catch (err) {
      rejectItem(item, err)
      return false
    }
  }

  /** 节点明确表示不支持批量：10 分钟内逐条请求，之后重新尝试批量（节点可能只是临时出错或已经升级） */
  #disableBatch(): void {
    this.#batchDisabledUntil = Date.now() + BATCH_RETRY_AFTER
  }

  /**
   * 发一次 HTTP 请求（含 429 退避重试）。items 是这次请求的成员：都被调用方取消时中止 fetch / 退避等待，抛出取消的 reason。
   * 同一节点地址同时在途的请求数受 maxConcurrency 限制：排队最多等 timeout 毫秒（超时抛 HttpError timeout，交给上层换节点），发出后重新计时
   */
  async #post(payload: unknown, items: readonly Pending[], retries = this.#retries): Promise<{ body: unknown; retryAfter: string | null }> {
    const post: Post = { items, controller: new AbortController() }
    const cancel = post.controller.signal
    items.forEach((item) => item.posts.add(post))
    const slots = trackedEntry(slotsByUrl, this.url, () => ({ active: 0, waiting: [] }))
    try {
      for (let attempt = 0; ; attempt++) {
        const limited = this.#timeout > 0 && Number.isFinite(this.#timeout)
        // 排队等名额也受 timeout 限制：同一地址的其他连接把名额占住不放（如 timeout: 0 的请求挂住）时不会无限等下去
        const queueTimeout = limited ? AbortSignal.timeout(this.#timeout) : null
        try {
          await acquireSlot(slots, this.#maxConcurrency, queueTimeout ? anySignal([cancel, queueTimeout]) : cancel)
        } catch (err) {
          if (cancel.aborted) {
            throw cancel.reason
          }
          throw new HttpError(`Request to ${this.#safeUrl} timed out waiting for a free connection slot (maxConcurrency ${this.#maxConcurrency})`, undefined, true)
        }
        let response: Response
        let text = ''
        /** 429 后要等多久再重试；null 表示不重试 */
        let wait: number | null = null
        try {
          const signal = limited ? anySignal([cancel, AbortSignal.timeout(this.#timeout)]) : cancel
          try {
            response = await this.#fetch(this.url, { method: 'POST', headers: this.#headers, body: JSON.stringify(payload), signal })
          } catch (err) {
            if (cancel.aborted) {
              throw cancel.reason
            }
            // AbortSignal.timeout 触发时是 TimeoutError（DOMException）
            const timeout = (err as { name?: unknown } | null)?.name === 'TimeoutError'
            throw new HttpError(`Request to ${this.#safeUrl} failed: ${(err as Error)?.message ?? err}`, undefined, timeout)
          }
          if (response.status === 429 && attempt < retries) {
            wait = retryDelay(attempt, response.headers?.get?.('retry-after'))
          }
          if (wait !== null) {
            void response.body?.cancel().catch(() => {})
          } else {
            try {
              text = await response.text()
            } catch (err) {
              if (cancel.aborted) {
                throw cancel.reason
              }
              // 读响应体时超时或连接中断：同样包装成 HttpError（原生 DOMException / TypeError 不会被当成可恢复的节点问题）
              const timeout = (err as { name?: unknown } | null)?.name === 'TimeoutError'
              throw new HttpError(`Reading response from ${this.#safeUrl} failed: ${(err as Error)?.message ?? err}`, response.status, timeout)
            }
          }
        } finally {
          releaseSlot(slots)
        }
        if (wait !== null) {
          // 退避期间不占并发名额
          await sleep(wait, cancel)
          continue
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
        const retryAfter = response.headers?.get?.('retry-after') ?? null
        // 有的节点限频时返回 HTTP 200 + JSON-RPC 错误码 429：同样退避重试
        if (attempt < retries && isRateLimited(body)) {
          const wait = retryDelay(attempt, retryAfter)
          if (wait !== null) {
            await sleep(wait, cancel)
            continue
          }
        }
        return { body, retryAfter }
      }
    } finally {
      items.forEach((item) => item.posts.delete(post))
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
    rejectItem(item, new HttpError('Missing response in JSON-RPC batch'))
  } else if (response.error) {
    rejectItem(item, new RpcError(response.error.message ?? 'JSON-RPC error', response.error.code, response.error.data))
  } else {
    resolveItem(item, response.result)
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
    return trackedEntry(healthByUrl, key, () => ({ failedAt: 0, timeouts: 0 }))
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

  async request<T = unknown>(method: string, params?: readonly unknown[], options?: RpcRequestOptions): Promise<T> {
    const signal = options?.signal
    const errors: Array<{ node: string; error: unknown }> = []
    const order = this.#order()
    for (let attempt = 0; attempt < order.length; attempt++) {
      // 已取消：不再发、不再换节点
      if (signal?.aborted) {
        throw signal.reason
      }
      const index = order[attempt] as number
      const node = this.nodes[index] as RpcTransport
      const label = this.#labels[index] as string
      const health = healthOf(this.#healthKeys[index] as string | object)
      const started = Date.now()
      try {
        // 没有 signal 时按两个参数调用（自定义传输不受影响）
        const result = await (signal ? node.request<T>(method, params, { signal }) : node.request<T>(method, params))
        health.failedAt = 0
        health.timeouts = 0
        emit({ node: label, method, ms: Date.now() - started, ok: true, attempt })
        return result
      } catch (err) {
        emit({ node: label, method, ms: Date.now() - started, ok: false, error: err, attempt })
        // 调用方取消导致的失败：不算节点故障，也不换节点
        if (signal?.aborted) {
          throw signal.reason
        }
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
