/**
 * 最小的 protobuf 编解码：只用到 gRPC 请求 / 响应里的几种线型（varint、64 位、长度前缀），够用即可，不依赖 protobuf 库。
 * 解码结果按字段号分组，取值时由调用方按 proto 定义指定类型
 */

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

/** 按字段写 protobuf 消息 */
export class ProtoWriter {
  readonly #bytes: number[] = []

  #varint(value: bigint | number): void {
    let n = BigInt(value)
    if (n < 0n) {
      // int64 / int32 的负数按 64 位补码写（protobuf 的规则）
      n += 1n << 64n
    }
    do {
      let byte = Number(n & 0x7fn)
      n >>= 7n
      if (n) byte |= 0x80
      this.#bytes.push(byte)
    } while (n)
  }

  #key(field: number, wire: number): void {
    this.#varint((field << 3) | wire)
  }

  /** uint32 / uint64 / int64 / enum / bool；undefined 时不写 */
  uint(field: number, value: bigint | number | boolean | undefined | null): this {
    if (value === undefined || value === null) return this
    this.#key(field, 0)
    this.#varint(typeof value === 'boolean' ? (value ? 1 : 0) : value)
    return this
  }

  bytes(field: number, value: Uint8Array | undefined | null): this {
    if (value === undefined || value === null) return this
    this.#key(field, 2)
    this.#varint(value.length)
    for (const b of value) this.#bytes.push(b)
    return this
  }

  string(field: number, value: string | undefined | null): this {
    return value === undefined || value === null ? this : this.bytes(field, utf8Encoder.encode(value))
  }

  /** 嵌套消息 */
  message(field: number, value: ProtoWriter | Uint8Array | undefined | null): this {
    if (value === undefined || value === null) return this
    return this.bytes(field, value instanceof ProtoWriter ? value.finish() : value)
  }

  finish(): Uint8Array {
    return new Uint8Array(this.#bytes)
  }
}

type RawValue = bigint | Uint8Array

/** 解码后的消息：字段号 → 该字段出现过的值（重复字段按顺序） */
export class ProtoMessage {
  constructor(readonly fields: ReadonlyMap<number, readonly RawValue[]>) {}

  static decode(data: Uint8Array): ProtoMessage {
    const fields = new Map<number, RawValue[]>()
    let o = 0
    const varint = (): bigint => {
      let result = 0n
      let shift = 0n
      for (;;) {
        if (o >= data.length) throw new ProtoError('truncated varint')
        const byte = data[o++] as number
        result |= BigInt(byte & 0x7f) << shift
        if (!(byte & 0x80)) return result
        shift += 7n
        if (shift > 70n) throw new ProtoError('varint too long')
      }
    }
    while (o < data.length) {
      const key = Number(varint())
      const field = key >>> 3
      const wire = key & 7
      let value: RawValue
      if (wire === 0) {
        value = varint()
      } else if (wire === 1) {
        // fixed64 / double：按原始 8 字节保存
        if (o + 8 > data.length) throw new ProtoError('truncated fixed64')
        value = data.subarray(o, o + 8)
        o += 8
      } else if (wire === 2) {
        const length = Number(varint())
        if (o + length > data.length) throw new ProtoError('truncated length-delimited field')
        value = data.subarray(o, o + length)
        o += length
      } else if (wire === 5) {
        if (o + 4 > data.length) throw new ProtoError('truncated fixed32')
        value = data.subarray(o, o + 4)
        o += 4
      } else {
        throw new ProtoError(`unsupported wire type ${wire}`)
      }
      const list = fields.get(field)
      if (list) list.push(value)
      else fields.set(field, [value])
    }
    return new ProtoMessage(fields)
  }

  has(field: number): boolean {
    return this.fields.has(field)
  }

  /** 最后一次出现的值（protobuf：标量字段重复出现时以最后一个为准） */
  #last(field: number): RawValue | undefined {
    const list = this.fields.get(field)
    return list?.[list.length - 1]
  }

  uint(field: number): bigint | null {
    const v = this.#last(field)
    return typeof v === 'bigint' ? v : null
  }

  /** uint32 / 不超过 2^53 的整数；没有时为 null */
  number(field: number): number | null {
    const v = this.uint(field)
    return v === null ? null : Number(v)
  }

  /** int32 / int64（补码） */
  int(field: number): bigint | null {
    const v = this.uint(field)
    return v === null ? null : BigInt.asIntN(64, v)
  }

  bool(field: number): boolean | null {
    const v = this.uint(field)
    return v === null ? null : v !== 0n
  }

  bytes(field: number): Uint8Array | null {
    const v = this.#last(field)
    return v instanceof Uint8Array ? v : null
  }

  string(field: number): string | null {
    const v = this.bytes(field)
    return v ? utf8Decoder.decode(v) : null
  }

  /** double（fixed64） */
  double(field: number): number | null {
    const v = this.#last(field)
    return v instanceof Uint8Array && v.length === 8 ? new DataView(v.buffer, v.byteOffset, 8).getFloat64(0, true) : null
  }

  message(field: number): ProtoMessage | null {
    const v = this.bytes(field)
    return v ? ProtoMessage.decode(v) : null
  }

  messages(field: number): ProtoMessage[] {
    return (this.fields.get(field) ?? []).flatMap((v) => (v instanceof Uint8Array ? [ProtoMessage.decode(v)] : []))
  }

  strings(field: number): string[] {
    return (this.fields.get(field) ?? []).flatMap((v) => (v instanceof Uint8Array ? [utf8Decoder.decode(v)] : []))
  }
}

export class ProtoError extends Error {
  constructor(message: string) {
    super(`protobuf: ${message}`)
    this.name = 'ProtoError'
  }
}

/** google.protobuf.FieldMask：要返回的字段路径 */
export function fieldMask(paths: readonly string[]): ProtoWriter {
  const w = new ProtoWriter()
  for (const p of paths) w.string(1, p)
  return w
}

/**
 * google.protobuf.Value → JSON 值（Object.json、Display.output 用）：
 * null_value = 1、number_value = 2、string_value = 3、bool_value = 4、struct_value = 5、list_value = 6
 */
export function decodeValue(m: ProtoMessage | null): unknown {
  if (!m) return null
  if (m.has(1)) return null
  if (m.has(2)) return m.double(2)
  if (m.has(3)) return m.string(3)
  if (m.has(4)) return m.bool(4)
  if (m.has(5)) {
    // Struct：map<string, Value> fields = 1（每项是 { key = 1, value = 2 } 的消息）
    const out: Record<string, unknown> = {}
    for (const entry of (m.message(5) as ProtoMessage).messages(1)) {
      const key = entry.string(1)
      if (key !== null) out[key] = decodeValue(entry.message(2))
    }
    return out
  }
  if (m.has(6)) {
    return (m.message(6) as ProtoMessage).messages(1).map((v) => decodeValue(v))
  }
  return null
}
