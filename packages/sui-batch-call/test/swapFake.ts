/**
 * /swap、/risk 测试用的假节点（GrpcTransport）：对象、代币信息、余额、Coin、包版本、模拟（只读调用的返回值由测试给出）
 */
import { normalizeStructTag, normalizeSuiAddress } from '../src/index.js'
import { GrpcError, type GrpcResponse, type GrpcTransport } from '../src/grpc.js'
import { ProtoMessage, ProtoWriter } from '../src/proto.js'
import { encodeValue } from './fakeNode.js'

export const D = '11111111111111111111111111111111'

export interface Obj {
  id: string
  type: string
  /** 所有者：地址、'shared'（初始版本 1）、'immutable'、{ object: 父对象 } */
  owner: string | 'shared' | 'immutable' | { object: string }
  json?: unknown
}

export class FakeSui implements GrpcTransport {
  readonly label = 'fake'
  readonly calls: Array<[string, ProtoMessage]> = []
  objects = new Map<string, Obj>()
  /** coinType → { decimals, symbol }，以及 GetCoinInfo 原样返回的字段（风险检查用） */
  coins = new Map<string, { decimals: number; symbol: string; raw?: ProtoWriter }>()
  /** owner → coinType → Coin 余额（每个一个 Coin 对象） */
  owned = new Map<string, Map<string, bigint[]>>()
  /** 只读调用：交易字节 → 每条命令的第一个返回值（null 表示执行失败） */
  inspect: (tx: Uint8Array) => unknown[] | null = () => null

  add(...objs: Obj[]): this {
    for (const o of objs) this.objects.set(normalizeSuiAddress(o.id), o)
    return this
  }

  hold(owner: string, coinType: string, ...balances: bigint[]): this {
    const o = normalizeSuiAddress(owner)
    if (!this.owned.has(o)) this.owned.set(o, new Map())
    this.owned.get(o)?.set(normalizeStructTag(coinType), balances)
    return this
  }

  count(name: string): number {
    return this.calls.filter(([n]) => n === name).length
  }

  async unary(method: string, request: Uint8Array): Promise<GrpcResponse> {
    const name = method.split('/').pop() as string
    const req = ProtoMessage.decode(request)
    this.calls.push([name, req])
    const w = new ProtoWriter()
    switch (name) {
      case 'GetEpoch':
        w.message(1, new ProtoWriter().uint(1, 900).uint(8, 500))
        break
      case 'GetServiceInfo':
        w.string(1, 'fake-chain').string(2, 'mainnet').uint(3, 1).uint(4, 100)
        break
      case 'GetCoinInfo': {
        const t = normalizeStructTag(req.string(1) as string)
        const c = this.coins.get(t)
        if (!c) throw new GrpcError(5, 'not found')
        if (c.raw) return { message: ProtoMessage.decode(c.raw.finish()), checkpoint: 100, chain: 'mainnet' }
        w.string(1, t).message(2, new ProtoWriter().string(1, normalizeSuiAddress('0x99')).uint(2, c.decimals).string(3, c.symbol).string(4, c.symbol))
        break
      }
      case 'GetBalance': {
        const list = this.owned.get(normalizeSuiAddress(req.string(1) as string))?.get(normalizeStructTag(req.string(2) as string)) ?? []
        const sum = list.reduce((s, b) => s + b, 0n)
        w.message(1, new ProtoWriter().string(1, req.string(2) as string).uint(3, sum).uint(4, 0).uint(5, sum))
        break
      }
      case 'ListOwnedObjects': {
        const owner = normalizeSuiAddress(req.string(1) as string)
        const type = req.string(5) ?? ''
        const coinType = /^0x0*2::coin::Coin<(.+)>$/.exec(type)?.[1]
        const list = coinType ? (this.owned.get(owner)?.get(normalizeStructTag(coinType)) ?? []) : []
        list.forEach((balance, i) => {
          w.message(1, new ProtoWriter().string(2, normalizeSuiAddress(`0x${(i + 0x100).toString(16)}${coinType?.length ?? 0}`)).uint(3, 5).string(4, D).string(6, type).uint(101, balance))
        })
        break
      }
      case 'BatchGetObjects':
        for (const r of req.messages(1)) {
          const o = this.objects.get(normalizeSuiAddress(r.string(1) as string))
          w.message(1, o ? new ProtoWriter().message(1, encode(o)) : new ProtoWriter().message(2, new ProtoWriter().uint(1, 5)))
        }
        break
      case 'ListPackageVersions':
        w.message(1, new ProtoWriter().string(1, req.string(1) as string).uint(2, 1))
        break
      case 'SimulateTransaction': {
        const tx = req.message(1)?.message(1)?.bytes(2) as Uint8Array
        const out = this.inspect(tx)
        const status = out ? new ProtoWriter().uint(1, 1) : new ProtoWriter().uint(1, 0).message(2, new ProtoWriter().string(1, 'MoveAbort(…) in command 3'))
        w.message(1, new ProtoWriter().message(4, new ProtoWriter().message(4, status)))
        for (const v of out ?? []) w.message(2, new ProtoWriter().message(1, new ProtoWriter().message(3, encodeValue(v))))
        break
      }
      default:
        throw new GrpcError(12, `unimplemented ${method}`)
    }
    return { message: ProtoMessage.decode(w.finish()), checkpoint: 100, chain: 'mainnet' }
  }
}

function encode(o: Obj): ProtoWriter {
  const owner =
    o.owner === 'shared'
      ? new ProtoWriter().uint(1, 3).uint(3, 1)
      : o.owner === 'immutable'
        ? new ProtoWriter().uint(1, 4)
        : typeof o.owner === 'object'
          ? new ProtoWriter().uint(1, 2).string(2, normalizeSuiAddress(o.owner.object))
          : new ProtoWriter().uint(1, 1).string(2, normalizeSuiAddress(o.owner))
  const w = new ProtoWriter().string(2, normalizeSuiAddress(o.id)).uint(3, 7).string(4, D).string(6, o.type).message(5, owner)
  if (o.json !== undefined) w.message(100, encodeValue(o.json))
  return w
}

/** 交易字节里有没有这个对象 ID / u64 */
export const hasId = (tx: Uint8Array, id: string) => indexOf(tx, Uint8Array.from(normalizeSuiAddress(id).slice(2).match(/../g) as string[], (h) => parseInt(h, 16))) >= 0
export const hasU64 = (tx: Uint8Array, v: bigint) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, v, true)
  return indexOf(tx, Uint8Array.from([8, ...b])) >= 0
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}
