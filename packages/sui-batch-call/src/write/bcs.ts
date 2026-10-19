/**
 * Sui 交易的 BCS 编码（TransactionData V1），布局与 @mysten/sui 的 bcs 定义一致。
 * 交易在本地编码后签名：不签节点返回的交易字节（节点不可信时可能被改成别的交易）
 */
import { base58 } from '@scure/base'

import { normalizeStructTag, normalizeSuiAddress } from '../address.js'

/** BCS 写入器 */
export class BcsWriter {
  readonly #bytes: number[] = []

  uleb(value: number): this {
    let n = value
    do {
      let byte = n & 0x7f
      n = Math.floor(n / 128)
      if (n) byte |= 0x80
      this.#bytes.push(byte)
    } while (n)
    return this
  }

  u8(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new RangeError(`value out of range for u8: ${v}`)
    this.#bytes.push(v)
    return this
  }

  u16(v: number): this {
    return this.#le(BigInt(v), 2)
  }

  u32(v: number): this {
    return this.#le(BigInt(v), 4)
  }

  u64(v: bigint | number): this {
    return this.#le(BigInt(v), 8)
  }

  u128(v: bigint): this {
    return this.#le(v, 16)
  }

  u256(v: bigint): this {
    return this.#le(v, 32)
  }

  #le(v: bigint, size: number): this {
    if (v < 0n || v >= 1n << BigInt(size * 8)) throw new RangeError(`value out of range for u${size * 8}: ${v}`)
    let n = v
    for (let i = 0; i < size; i++) {
      this.#bytes.push(Number(n & 0xffn))
      n >>= 8n
    }
    return this
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0)
  }

  /** 定长字节（地址等） */
  fixed(bytes: Uint8Array): this {
    for (const b of bytes) this.#bytes.push(b)
    return this
  }

  /** 变长字节：ULEB128 长度 + 内容 */
  bytes(bytes: Uint8Array): this {
    return this.uleb(bytes.length).fixed(bytes)
  }

  string(s: string): this {
    return this.bytes(new TextEncoder().encode(s))
  }

  address(address: string): this {
    const hex = normalizeSuiAddress(address).slice(2)
    const out = new Uint8Array(32)
    for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return this.fixed(out)
  }

  vector<T>(items: readonly T[], write: (w: this, item: T) => void): this {
    this.uleb(items.length)
    for (const item of items) write(this, item)
    return this
  }

  option<T>(value: T | null | undefined, write: (w: this, item: T) => void): this {
    if (value === null || value === undefined) return this.u8(0)
    this.u8(1)
    write(this, value)
    return this
  }

  finish(): Uint8Array {
    return new Uint8Array(this.#bytes)
  }
}

/** 对象引用（ID、版本、摘要） */
export interface ObjectRef {
  objectId: string
  version: bigint
  /** base58 */
  digest: string
}

export type ObjectArg =
  | { kind: 'owned'; ref: ObjectRef }
  | { kind: 'shared'; objectId: string; initialSharedVersion: bigint; mutable: boolean }
  | { kind: 'receiving'; ref: ObjectRef }

export type CallArg =
  | { kind: 'pure'; bytes: Uint8Array }
  | { kind: 'object'; object: ObjectArg }
  /** 从地址余额取款（Address Balances）：最多 amount，类型 Balance<coinType>，从发送者扣 */
  | { kind: 'withdrawal'; amount: bigint; coinType: string }

export type Argument = { kind: 'gas' } | { kind: 'input'; index: number } | { kind: 'result'; index: number } | { kind: 'nested'; index: number; result: number }

export type Command =
  | { kind: 'moveCall'; package: string; module: string; function: string; typeArguments: string[]; arguments: Argument[] }
  | { kind: 'transferObjects'; objects: Argument[]; address: Argument }
  | { kind: 'splitCoins'; coin: Argument; amounts: Argument[] }
  | { kind: 'mergeCoins'; destination: Argument; sources: Argument[] }
  | { kind: 'makeMoveVec'; type: string | null; elements: Argument[] }

export interface ProgrammableTransaction {
  inputs: CallArg[]
  commands: Command[]
}

export type Expiration = { kind: 'none' } | { kind: 'epoch'; epoch: bigint } | { kind: 'validDuring'; minEpoch: bigint; maxEpoch: bigint; chain: string; nonce: number }

export interface TransactionData {
  /** ProgrammableTransaction，或别处（如 @mysten/sui 的 onlyTransactionKind）编码好的 TransactionKind 字节 */
  kind: ProgrammableTransaction | Uint8Array
  sender: string
  gas: { payment: ObjectRef[]; owner: string; price: bigint; budget: bigint }
  expiration: Expiration
}

function writeDigest(w: BcsWriter, digest: string): void {
  const bytes = base58.decode(digest)
  if (bytes.length !== 32) throw new Error(`Invalid object digest: ${digest}`)
  w.bytes(bytes)
}

function writeObjectRef(w: BcsWriter, ref: ObjectRef): void {
  w.address(ref.objectId).u64(ref.version)
  writeDigest(w, ref.digest)
}

/** 解析 Move 类型字符串写成 TypeTag */
export function writeTypeTag(w: BcsWriter, type: string): void {
  const t = type.trim()
  const primitives: Record<string, number> = { bool: 0, u8: 1, u64: 2, u128: 3, address: 4, signer: 5, u16: 8, u32: 9, u256: 10 }
  if (Object.hasOwn(primitives, t)) {
    w.u8(primitives[t] as number)
    return
  }
  const vec = /^vector\s*<(.+)>$/s.exec(t)
  if (vec) {
    w.u8(6)
    writeTypeTag(w, vec[1] as string)
    return
  }
  // 结构体：地址::模块::名称<参数…>
  const normalized = normalizeStructTag(t)
  const lt = normalized.indexOf('<')
  const head = lt === -1 ? normalized : normalized.slice(0, lt)
  const [address, module, name] = head.split('::') as [string, string, string]
  const params = lt === -1 ? [] : splitTypeArgs(normalized.slice(lt + 1, -1))
  w.u8(7).address(address).string(module).string(name)
  w.vector(params, (ww, p) => writeTypeTag(ww, p))
}

/** 按顶层逗号拆分泛型参数 */
function splitTypeArgs(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '<') depth++
    else if (c === '>') depth--
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(text.slice(start).trim())
  return out.filter((s) => s.length)
}

function writeArgument(w: BcsWriter, a: Argument): void {
  if (a.kind === 'gas') w.u8(0)
  else if (a.kind === 'input') w.u8(1).u16(a.index)
  else if (a.kind === 'result') w.u8(2).u16(a.index)
  else w.u8(3).u16(a.index).u16(a.result)
}

function writeCallArg(w: BcsWriter, arg: CallArg): void {
  if (arg.kind === 'pure') {
    w.u8(0).bytes(arg.bytes)
  } else if (arg.kind === 'object') {
    w.u8(1)
    const o = arg.object
    if (o.kind === 'owned') {
      w.u8(0)
      writeObjectRef(w, o.ref)
    } else if (o.kind === 'shared') {
      w.u8(1).address(o.objectId).u64(o.initialSharedVersion).bool(o.mutable)
    } else {
      w.u8(2)
      writeObjectRef(w, o.ref)
    }
  } else {
    // FundsWithdrawal { reservation: MaxAmountU64(u64), typeArg: Balance(TypeTag), withdrawFrom: Sender }
    w.u8(2).u8(0).u64(arg.amount).u8(0)
    writeTypeTag(w, arg.coinType)
    w.u8(0)
  }
}

function writeCommand(w: BcsWriter, c: Command): void {
  switch (c.kind) {
    case 'moveCall':
      w.u8(0).address(c.package).string(c.module).string(c.function)
      w.vector(c.typeArguments, (ww, t) => writeTypeTag(ww, t))
      w.vector(c.arguments, (ww, a) => writeArgument(ww, a))
      return
    case 'transferObjects':
      w.u8(1).vector(c.objects, (ww, a) => writeArgument(ww, a))
      writeArgument(w, c.address)
      return
    case 'splitCoins':
      w.u8(2)
      writeArgument(w, c.coin)
      w.vector(c.amounts, (ww, a) => writeArgument(ww, a))
      return
    case 'mergeCoins':
      w.u8(3)
      writeArgument(w, c.destination)
      w.vector(c.sources, (ww, a) => writeArgument(ww, a))
      return
    case 'makeMoveVec':
      w.u8(5).option(c.type, (ww, t) => writeTypeTag(ww, t))
      w.vector(c.elements, (ww, a) => writeArgument(ww, a))
      return
  }
}

/** TransactionKind::ProgrammableTransaction 的 BCS（可以单独用于模拟只看结果的调用） */
export function encodeTransactionKind(ptb: ProgrammableTransaction): Uint8Array {
  const w = new BcsWriter().u8(0)
  w.vector(ptb.inputs, (ww, i) => writeCallArg(ww, i))
  w.vector(ptb.commands, (ww, c) => writeCommand(ww, c))
  return w.finish()
}

/** TransactionData::V1 的 BCS（签名的就是它） */
export function encodeTransactionData(tx: TransactionData): Uint8Array {
  const w = new BcsWriter().u8(0)
  w.fixed(tx.kind instanceof Uint8Array ? tx.kind : encodeTransactionKind(tx.kind))
  w.address(tx.sender)
  w.vector(tx.gas.payment, (ww, r) => writeObjectRef(ww, r))
  w.address(tx.gas.owner).u64(tx.gas.price).u64(tx.gas.budget)
  const e = tx.expiration
  if (e.kind === 'none') w.u8(0)
  else if (e.kind === 'epoch') w.u8(1).u64(e.epoch)
  else {
    // ValidDuring { minEpoch, maxEpoch, minTimestamp, maxTimestamp, chain, nonce }
    w.u8(2).option(e.minEpoch, (ww, v) => ww.u64(v)).option(e.maxEpoch, (ww, v) => ww.u64(v)).u8(0).u8(0)
    writeDigest(w, e.chain)
    w.u32(e.nonce)
  }
  return w.finish()
}

/** 常用的 pure 参数编码 */
export const pure = {
  u8: (v: number) => new BcsWriter().u8(v).finish(),
  u16: (v: number) => new BcsWriter().u16(v).finish(),
  u32: (v: number) => new BcsWriter().u32(v).finish(),
  u64: (v: bigint | number) => new BcsWriter().u64(v).finish(),
  u128: (v: bigint) => new BcsWriter().u128(v).finish(),
  bool: (v: boolean) => new BcsWriter().bool(v).finish(),
  address: (v: string) => new BcsWriter().address(v).finish(),
  string: (v: string) => new BcsWriter().string(v).finish(),
  /** vector<u64> 等：传元素的编码函数 */
  vector: <T>(items: readonly T[], write: (w: BcsWriter, item: T) => void) => new BcsWriter().vector(items, write).finish(),
}

/** 从 TransactionKind 字节里读出的输入（只读出发送前要知道的） */
export interface KindInputs {
  /** 用到的自有对象（owned / receiving）ID */
  owned: string[]
  /** 从地址余额取款：数量、代币类型（规范化）、从谁那里取（sender / sponsor） */
  withdrawals: Array<{ amount: bigint; coinType: string; from: 'sender' | 'sponsor' | 'other' }>
}

/** 读 BCS 编码的 TransactionKind（如 @mysten/sui 构建的）的输入部分 */
export function decodeKindInputs(bytes: Uint8Array): KindInputs {
  let pos = 0
  const need = (n: number) => {
    if (pos + n > bytes.length) throw new Error('Invalid TransactionKind bytes: unexpected end')
  }
  const u8 = () => {
    need(1)
    return bytes[pos++] as number
  }
  const uleb = () => {
    let value = 0
    let shift = 0
    for (;;) {
      const b = u8()
      value += (b & 0x7f) * 2 ** shift
      if (!(b & 0x80)) return value
      shift += 7
      if (shift > 35) throw new Error('Invalid TransactionKind bytes: bad length')
    }
  }
  const skip = (n: number) => {
    need(n)
    pos += n
  }
  const u64 = () => {
    need(8)
    let v = 0n
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[pos + i] as number)
    pos += 8
    return v
  }
  const address = () => {
    need(32)
    const hex = [...bytes.subarray(pos, pos + 32)].map((b) => b.toString(16).padStart(2, '0')).join('')
    pos += 32
    return `0x${hex}`
  }
  const string = () => {
    const n = uleb()
    need(n)
    const s = new TextDecoder().decode(bytes.subarray(pos, pos + n))
    pos += n
    return s
  }
  const typeTag = (): string => {
    const tag = u8()
    const primitives = ['bool', 'u8', 'u64', 'u128', 'address', 'signer', '', '', 'u16', 'u32', 'u256']
    if (tag === 6) return `vector<${typeTag()}>`
    if (tag === 7) {
      const head = `${address()}::${string()}::${string()}`
      const params = Array.from({ length: uleb() }, typeTag)
      return params.length ? `${head}<${params.join(', ')}>` : head
    }
    const name = primitives[tag]
    if (!name) throw new Error(`Invalid TransactionKind bytes: unknown type tag ${tag}`)
    return name
  }
  if (u8() !== 0) throw new Error('Only ProgrammableTransaction kinds are supported')
  const out: KindInputs = { owned: [], withdrawals: [] }
  const count = uleb()
  for (let i = 0; i < count; i++) {
    const kind = u8()
    if (kind === 0) skip(uleb())
    else if (kind === 1) {
      const objectKind = u8()
      const id = address()
      if (objectKind === 1) skip(9) // 共享对象：initial_shared_version + mutable
      else if (objectKind === 0 || objectKind === 2) {
        skip(8)
        skip(uleb()) // 摘要
        out.owned.push(id)
      } else throw new Error(`Invalid TransactionKind bytes: unknown object arg ${objectKind}`)
    } else if (kind === 2) {
      if (u8() !== 0) throw new Error('Invalid TransactionKind bytes: unknown reservation')
      const amount = u64()
      if (u8() !== 0) throw new Error('Invalid TransactionKind bytes: unknown withdrawal type')
      const coinType = normalizeStructTag(typeTag())
      const from = u8()
      if (from === 2) skip(64)
      else if (from > 2) throw new Error('Invalid TransactionKind bytes: unknown withdrawal source')
      out.withdrawals.push({ amount, coinType, from: from === 0 ? 'sender' : from === 1 ? 'sponsor' : 'other' })
    } else throw new Error(`Invalid TransactionKind bytes: unknown input kind ${kind}`)
  }
  return out
}

/** 本库格式的交易的输入（与 decodeKindInputs 相同的结构） */
export function kindInputs(kind: ProgrammableTransaction): KindInputs {
  const out: KindInputs = { owned: [], withdrawals: [] }
  for (const i of kind.inputs) {
    if (i.kind === 'object' && i.object.kind !== 'shared') out.owned.push(normalizeSuiAddress(i.object.ref.objectId))
    if (i.kind === 'withdrawal') out.withdrawals.push({ amount: i.amount, coinType: normalizeStructTag(i.coinType), from: 'sender' })
  }
  return out
}
