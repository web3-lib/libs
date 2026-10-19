import { ProtoMessage } from './proto.js'

/** gRPC 状态码 */
export const GrpcStatus = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const

/** 节点返回的 gRPC 错误（grpc-status 不为 0） */
export class GrpcError extends Error {
  constructor(
    readonly code: number,
    readonly details: string,
    readonly node?: string,
  ) {
    super(`gRPC ${statusName(code)}${details ? `: ${details}` : ''}`)
    this.name = 'GrpcError'
  }
}

/** HTTP 层错误（非 200、网络错误、超时） */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly timeout = false,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** 节点高度（checkpoint）还没到请求要求的 minCheckpoint */
export class BehindError extends Error {
  constructor(
    readonly checkpoint: number,
    readonly minCheckpoint: number,
    readonly node?: string,
  ) {
    super(`Node is at checkpoint ${checkpoint}, below the required ${minCheckpoint}`)
    this.name = 'BehindError'
  }
}

/** 节点所在的网络与配置的不一致（如把测试网节点配成了主网） */
export class NetworkMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
    readonly node?: string,
  ) {
    super(`Node${node ? ` ${node}` : ''} is on ${actual}, expected ${expected}`)
    this.name = 'NetworkMismatchError'
  }
}

/** 所有节点都失败 */
export class AllNodesFailedError extends Error {
  constructor(readonly errors: ReadonlyArray<{ node: string; error: unknown }>) {
    super(`All nodes failed: ${errors.map((e) => `${e.node}: ${e.error instanceof Error ? e.error.message : String(e.error)}`).join('; ')}`)
    this.name = 'AllNodesFailedError'
  }
}

function statusName(code: number): string {
  return Object.entries(GrpcStatus).find(([, v]) => v === code)?.[0] ?? String(code)
}

export interface CallOptions {
  signal?: AbortSignal
  /** 要求节点至少到这个 checkpoint（读到刚执行的交易之后的状态）；不够时换节点 */
  minCheckpoint?: number
}

/** 一次调用的结果：响应消息，以及节点在响应头里报告的高度和网络 */
export interface GrpcResponse {
  message: ProtoMessage
  /** x-sui-checkpoint-height；节点没给时为 null */
  checkpoint: number | null
  /** x-sui-chain（'mainnet' / 'testnet' …）；节点没给时为 null */
  chain: string | null
}

/** gRPC 传输：可以传自己的实现（如带鉴权的代理） */
export interface GrpcTransport {
  readonly label?: string
  /** method 如 'sui.rpc.v2.StateService/GetBalance'；request 是编码好的请求消息 */
  unary(method: string, request: Uint8Array, options?: CallOptions): Promise<GrpcResponse>
}

export interface GrpcWebOptions {
  /** 单次请求超时（毫秒），<= 0 不限。默认 10000 */
  timeout?: number
  /** 额外的请求头（如服务商的 API Key） */
  headers?: Record<string, string>
  /** 遇到限频（HTTP 429 / RESOURCE_EXHAUSTED）时的重试次数（指数退避，从 500ms 开始）。默认 2 */
  retries?: number
  /** 自定义 fetch */
  fetch?: typeof fetch
  /** 日志 / 报错里的节点名称，默认 URL 的 host */
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

/** grpc-message 是百分号编码的 */
function decodeGrpcMessage(value: string | null): string {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 解析 trailer 帧（"grpc-status:0\r\ngrpc-message:…"） */
function parseTrailers(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) map.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim())
  }
  return map
}

const toInt = (v: string | null) => {
  const n = v === null ? NaN : Number(v)
  return Number.isSafeInteger(n) ? n : null
}

/**
 * gRPC-web 传输（application/grpc-web+proto，fetch 发送，浏览器和 Node 都能用）。
 * Sui 全节点直接支持 gRPC-web，并允许跨域
 */
export class GrpcWebTransport implements GrpcTransport {
  readonly label: string
  readonly #url: string
  readonly #timeout: number
  readonly #headers: Record<string, string>
  readonly #retries: number
  readonly #fetch: typeof fetch

  constructor(url: string, options: GrpcWebOptions = {}) {
    this.#url = url.replace(/\/+$/, '')
    this.#timeout = options.timeout ?? 10_000
    this.#headers = options.headers ?? {}
    this.#retries = Math.max(0, options.retries ?? 2)
    this.#fetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    let host = url
    try {
      host = new URL(url).host
    } catch {
      // 非法 URL：请求时会报错
    }
    this.label = options.label ?? host
  }

  async unary(method: string, request: Uint8Array, options: CallOptions = {}): Promise<GrpcResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#once(method, request, options.signal)
      } catch (err) {
        const limited = (err instanceof HttpError && err.status === 429) || (err instanceof GrpcError && err.code === GrpcStatus.RESOURCE_EXHAUSTED)
        if (!limited || attempt >= this.#retries || options.signal?.aborted) throw err
        await sleep(500 * 2 ** attempt, options.signal)
      }
    }
  }

  async #once(method: string, request: Uint8Array, signal: AbortSignal | undefined): Promise<GrpcResponse> {
    // 已经取消的不发出（下面的监听只管之后的取消）
    signal?.throwIfAborted()
    // gRPC-web 帧：1 字节标志（0 = 数据）+ 4 字节大端长度 + 消息
    const body = new Uint8Array(5 + request.length)
    new DataView(body.buffer).setUint32(1, request.length)
    body.set(request, 5)
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timer = this.#timeout > 0 ? setTimeout(() => ((timedOut = true), controller.abort()), this.#timeout) : null
    let res: Response
    let buf: Uint8Array
    try {
      res = await this.#fetch(`${this.#url}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1', ...this.#headers },
        body,
        signal: controller.signal,
      })
      buf = new Uint8Array(await res.arrayBuffer())
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err
      throw new HttpError(timedOut ? `Request to ${this.label} timed out after ${this.#timeout}ms` : `Request to ${this.label} failed: ${(err as Error)?.message ?? err}`, undefined, timedOut)
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const checkpoint = toInt(res.headers.get('x-sui-checkpoint-height'))
    const chain = res.headers.get('x-sui-chain')
    // 只有状态、没有数据的响应（trailers-only）：状态在响应头里
    const headerStatus = res.headers.get('grpc-status')
    if (!res.ok) {
      if (headerStatus !== null && headerStatus !== '0') {
        throw new GrpcError(Number(headerStatus), decodeGrpcMessage(res.headers.get('grpc-message')), this.label)
      }
      throw new HttpError(`HTTP ${res.status} from ${this.label}`, res.status)
    }
    let data: Uint8Array | null = null
    let trailers: Map<string, string> | null = null
    for (let o = 0; o + 5 <= buf.length; ) {
      const flag = buf[o] as number
      const length = new DataView(buf.buffer, buf.byteOffset + o + 1, 4).getUint32(0)
      const frame = buf.subarray(o + 5, o + 5 + length)
      if (frame.length < length) throw new HttpError(`Truncated gRPC-web response from ${this.label}`)
      if (flag & 0x80) trailers = parseTrailers(new TextDecoder().decode(frame))
      else data = frame
      o += 5 + length
    }
    const status = trailers?.get('grpc-status') ?? headerStatus
    if (status === null || status === undefined) {
      throw new HttpError(`Malformed gRPC-web response from ${this.label} (no grpc-status)`)
    }
    if (status !== '0') {
      throw new GrpcError(Number(status), decodeGrpcMessage(trailers?.get('grpc-message') ?? res.headers.get('grpc-message')), this.label)
    }
    return { message: ProtoMessage.decode(data ?? new Uint8Array()), checkpoint, chain }
  }
}

/** 这个错误是不是节点的问题（应换节点重试）；参数错误、对象不存在等确定性错误不是 */
export function isNodeFault(err: unknown): boolean {
  if (err instanceof GrpcError) {
    return !(
      [GrpcStatus.INVALID_ARGUMENT, GrpcStatus.NOT_FOUND, GrpcStatus.ALREADY_EXISTS, GrpcStatus.FAILED_PRECONDITION, GrpcStatus.OUT_OF_RANGE, GrpcStatus.CANCELLED] as number[]
    ).includes(err.code)
  }
  return err instanceof HttpError || err instanceof BehindError || err instanceof NetworkMismatchError || err instanceof AllNodesFailedError
}

export interface FallbackOptions {
  /** 节点所在的网络（'mainnet' / 'testnet' / 'devnet'）：按响应头 x-sui-chain 核对，不一致的节点不用 */
  network?: string
  /** 节点出错后冷却多久（毫秒）再优先使用，默认 30000 */
  cooldown?: number
}

/**
 * 多个节点故障切换：按健康状态排序（出错的节点冷却一段时间后再优先用），节点问题时依次换下一个，
 * 确定性错误（参数错误、对象不存在等）直接抛出。也负责核对网络和 minCheckpoint
 */
export class FallbackTransport implements GrpcTransport {
  readonly label: string
  readonly #nodes: readonly GrpcTransport[]
  readonly #network: string | undefined
  readonly #cooldown: number
  /** 每个节点最近一次出错的时间 */
  readonly #failedAt: Array<number | null>

  constructor(nodes: readonly GrpcTransport[], options: FallbackOptions = {}) {
    if (!nodes.length) throw new Error('FallbackTransport needs at least one node')
    this.#nodes = nodes
    this.#network = options.network
    this.#cooldown = options.cooldown ?? 30_000
    this.#failedAt = nodes.map(() => null)
    this.label = nodes.map((n, i) => n.label ?? `node${i}`).join(',')
  }

  #order(): number[] {
    const now = Date.now()
    const healthy = (i: number) => {
      const t = this.#failedAt[i]
      return t === null || t === undefined || now - t > this.#cooldown
    }
    const indexes = this.#nodes.map((_, i) => i)
    return [...indexes.filter(healthy), ...indexes.filter((i) => !healthy(i)).sort((a, b) => (this.#failedAt[a] ?? 0) - (this.#failedAt[b] ?? 0))]
  }

  async unary(method: string, request: Uint8Array, options: CallOptions = {}): Promise<GrpcResponse> {
    // 所有节点都只是落后于 minCheckpoint 时，等一会儿再试（节点通常一两秒内就跟上），最多约 10 秒
    const deadline = Date.now() + 10_000
    for (let round = 0; ; round++) {
      try {
        return await this.#round(method, request, options)
      } catch (err) {
        const allBehind = err instanceof BehindError || (err instanceof AllNodesFailedError && err.errors.every((e) => e.error instanceof BehindError))
        if (!allBehind || Date.now() + 500 > deadline || options.signal?.aborted) throw err
        await sleep(Math.min(500 * (round + 1), 2000), options.signal)
      }
    }
  }

  async #round(method: string, request: Uint8Array, options: CallOptions): Promise<GrpcResponse> {
    const errors: Array<{ node: string; error: unknown }> = []
    for (const i of this.#order()) {
      const node = this.#nodes[i] as GrpcTransport
      const label = node.label ?? `node${i}`
      try {
        const res = await node.unary(method, request, options)
        // devnet 每次重置后网络标识都会变，节点报告的是 'unknown'：只排除明确是主网 / 测试网的节点
        const mismatch = this.#network === 'devnet' ? res.chain === 'mainnet' || res.chain === 'testnet' : res.chain !== this.#network
        if (this.#network && res.chain && mismatch) {
          throw new NetworkMismatchError(this.#network, res.chain, label)
        }
        if (options.minCheckpoint !== undefined && res.checkpoint !== null && res.checkpoint < options.minCheckpoint) {
          throw new BehindError(res.checkpoint, options.minCheckpoint, label)
        }
        this.#failedAt[i] = null
        return res
      } catch (err) {
        if (options.signal?.aborted) throw err
        if (!isNodeFault(err)) throw err
        // 落后不算故障（只是这次要求的高度没到），不冷却
        if (!(err instanceof BehindError)) this.#failedAt[i] = Date.now()
        errors.push({ node: label, error: err })
      }
    }
    if (errors.length === 1) throw errors[0]?.error
    throw new AllNodesFailedError(errors)
  }
}
