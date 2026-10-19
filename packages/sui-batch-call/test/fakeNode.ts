/**
 * 假的 Sui 全节点：用 ProtoWriter 编码响应，按 gRPC-web 的帧格式返回，测试传输层和客户端
 */
import { ProtoMessage, ProtoWriter } from '../src/proto.js'

export interface FakeCoin {
  decimals: number
  symbol: string
  name?: string
  totalSupply?: bigint
}

export interface FakeObject {
  id: string
  type: string
  owner?: string
  json?: unknown
  display?: Record<string, string>
  version?: bigint
}

export interface FakeState {
  /** owner → coinType → 余额 */
  balances: Record<string, Record<string, bigint>>
  coins: Record<string, FakeCoin>
  objects: FakeObject[]
  checkpoint: number
  chain: string
}

/** google.protobuf.Value 编码 */
export function encodeValue(v: unknown): ProtoWriter {
  const w = new ProtoWriter()
  if (v === null || v === undefined) return w.uint(1, 0)
  if (typeof v === 'number') {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setFloat64(0, v, true)
    // double 是 fixed64（线型 1）：ProtoWriter 没有，手写 key
    return new RawWriter().raw([(2 << 3) | 1, ...b])
  }
  if (typeof v === 'string') return w.string(3, v)
  if (typeof v === 'boolean') return w.uint(4, v)
  if (Array.isArray(v)) {
    const list = new ProtoWriter()
    for (const item of v) list.message(1, encodeValue(item))
    return w.message(6, list)
  }
  const struct = new ProtoWriter()
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    struct.message(1, new ProtoWriter().string(1, key).message(2, encodeValue(value)))
  }
  return w.message(5, struct)
}

/** 能直接写原始字节的 writer（double 用） */
class RawWriter extends ProtoWriter {
  #extra: number[] = []
  raw(bytes: number[]): this {
    this.#extra.push(...bytes)
    return this
  }
  override finish(): Uint8Array {
    return new Uint8Array([...super.finish(), ...this.#extra])
  }
}

const frame = (flag: number, data: Uint8Array) => {
  const out = new Uint8Array(5 + data.length)
  out[0] = flag
  new DataView(out.buffer).setUint32(1, data.length)
  out.set(data, 5)
  return out
}

export function grpcWebBody(message: Uint8Array | null, status = 0, details = ''): Uint8Array {
  const trailer = new TextEncoder().encode(`grpc-status:${status}\r\n${details ? `grpc-message:${encodeURIComponent(details)}\r\n` : ''}`)
  const parts = [...(message ? [frame(0, message)] : []), frame(0x80, trailer)]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** 一个按 FakeState 应答的 fetch；calls 记录请求的方法名 */
export function createFakeNode(state: FakeState) {
  const calls: string[] = []
  const pad = (a: string) => `0x${a.replace(/^0x/, '').padStart(64, '0')}`
  const handle = (method: string, req: ProtoMessage): { message?: Uint8Array; status?: number; details?: string } => {
    switch (method) {
      case 'sui.rpc.v2.LedgerService/GetServiceInfo':
        return { message: new ProtoWriter().string(1, 'fake-chain-id').string(2, state.chain).uint(3, 7).uint(4, state.checkpoint).finish() }
      case 'sui.rpc.v2.StateService/GetBalance': {
        const owner = req.string(1) as string
        const coinType = req.string(2) as string
        const balance = state.balances[owner]?.[coinType] ?? 0n
        return { message: new ProtoWriter().message(1, new ProtoWriter().string(1, coinType).uint(3, balance)).finish() }
      }
      case 'sui.rpc.v2.StateService/ListBalances': {
        const owner = req.string(1) as string
        const pageSize = req.number(2) ?? 1000
        const start = req.bytes(3) ? Number(new TextDecoder().decode(req.bytes(3) as Uint8Array)) : 0
        const entries = Object.entries(state.balances[owner] ?? {})
        const w = new ProtoWriter()
        for (const [coinType, balance] of entries.slice(start, start + pageSize)) w.message(1, new ProtoWriter().string(1, coinType).uint(3, balance))
        if (start + pageSize < entries.length) w.bytes(2, new TextEncoder().encode(String(start + pageSize)))
        return { message: w.finish() }
      }
      case 'sui.rpc.v2.StateService/GetCoinInfo': {
        const coinType = req.string(1) as string
        const coin = state.coins[coinType]
        if (!coin) return { status: 5, details: `coin ${coinType} not found` }
        const w = new ProtoWriter()
          .string(1, coinType)
          .message(2, new ProtoWriter().string(1, '0xmeta').uint(2, coin.decimals).string(3, coin.name ?? coin.symbol).string(4, coin.symbol).string(5, '').string(6, ''))
        if (coin.totalSupply !== undefined) w.message(3, new ProtoWriter().uint(2, coin.totalSupply))
        return { message: w.finish() }
      }
      case 'sui.rpc.v2.LedgerService/BatchGetObjects': {
        const paths = new Set(req.message(2)?.strings(1) ?? [])
        const w = new ProtoWriter()
        for (const r of req.messages(1)) {
          const id = r.string(1) as string
          const o = state.objects.find((x) => pad(x.id) === id)
          w.message(1, o ? new ProtoWriter().message(1, encodeObject(o, paths)) : new ProtoWriter().message(2, new ProtoWriter().uint(1, 5)))
        }
        return { message: w.finish() }
      }
      case 'sui.rpc.v2.StateService/ListOwnedObjects': {
        const owner = req.string(1) as string
        const pageSize = req.number(2) ?? 1000
        const start = req.bytes(3) ? Number(new TextDecoder().decode(req.bytes(3) as Uint8Array)) : 0
        const paths = new Set(req.message(4)?.strings(1) ?? [])
        const type = req.string(5)
        const list = state.objects.filter((o) => o.owner && pad(o.owner) === owner && (!type || o.type.startsWith(type)))
        const w = new ProtoWriter()
        for (const o of list.slice(start, start + pageSize)) w.message(1, encodeObject(o, paths))
        if (start + pageSize < list.length) w.bytes(2, new TextEncoder().encode(String(start + pageSize)))
        return { message: w.finish() }
      }
      default:
        return { status: 12, details: `unimplemented ${method}` }
    }
  }
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = String(url).replace(/^https?:\/\/[^/]+\//, '')
    calls.push(method)
    const body = new Uint8Array(init?.body as ArrayBuffer)
    const length = new DataView(body.buffer, body.byteOffset).getUint32(1)
    const req = ProtoMessage.decode(body.subarray(5, 5 + length))
    const out = handle(method, req)
    return new Response(grpcWebBody(out.message ?? null, out.status ?? 0, out.details ?? '') as BodyInit, {
      status: 200,
      headers: { 'content-type': 'application/grpc-web+proto', 'x-sui-checkpoint-height': String(state.checkpoint), 'x-sui-chain': state.chain },
    })
  }
  return { fetch: fetch as typeof globalThis.fetch, calls }
}

function encodeObject(o: FakeObject, paths: ReadonlySet<string>): ProtoWriter {
  const pad = (a: string) => `0x${a.replace(/^0x/, '').padStart(64, '0')}`
  const w = new ProtoWriter().string(2, pad(o.id)).uint(3, o.version ?? 1n).string(4, 'digest')
  if (paths.has('object_type')) w.string(6, o.type)
  if (paths.has('owner') && o.owner) w.message(5, new ProtoWriter().uint(1, 1).string(2, pad(o.owner)))
  if (paths.has('json') && o.json !== undefined) w.message(100, encodeValue(o.json))
  if (paths.has('display') && o.display) w.message(102, new ProtoWriter().message(1, encodeValue(o.display)))
  return w
}
