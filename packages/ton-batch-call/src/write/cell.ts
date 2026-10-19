/**
 * TON 的 Cell / BOC：普通 Cell（最多 1023 位数据、4 个引用）的构建、读取、哈希和 BOC 序列化。
 * 哈希和序列化与 @ton/core 一致（BOC 默认带 CRC32C、不带索引，Cell 顺序相同）
 */
import { sha256 } from '@noble/hashes/sha2.js'

import { parseTonAddress, type TonAddress } from '../address.js'

const MAX_BITS = 1023
const MAX_REFS = 4

export class Cell {
  /** 数据（按位，最后不足一字节的部分在高位，其余为 0） */
  readonly data: Uint8Array
  readonly bits: number
  readonly refs: readonly Cell[]
  #hash: Uint8Array | null = null
  #depth: number | null = null

  constructor(data: Uint8Array, bits: number, refs: readonly Cell[] = []) {
    if (bits > MAX_BITS) throw new Error(`Cell overflow: ${bits} bits`)
    if (refs.length > MAX_REFS) throw new Error(`Cell overflow: ${refs.length} refs`)
    this.data = data.slice(0, Math.ceil(bits / 8))
    this.bits = bits
    this.refs = refs
  }

  static readonly EMPTY = new Cell(new Uint8Array(0), 0)

  /** 最大深度：没有引用为 0 */
  depth(): number {
    if (this.#depth === null) this.#depth = this.refs.length ? Math.max(...this.refs.map((r) => r.depth())) + 1 : 0
    return this.#depth
  }

  /** 表示哈希（representation hash），合约地址、消息哈希都是它 */
  hash(): Uint8Array {
    if (this.#hash) return this.#hash
    const dataBytes = paddedBytes(this.data, this.bits)
    const repr = new Uint8Array(2 + dataBytes.length + this.refs.length * 34)
    repr[0] = this.refs.length
    repr[1] = Math.ceil(this.bits / 8) + Math.floor(this.bits / 8)
    repr.set(dataBytes, 2)
    let at = 2 + dataBytes.length
    for (const r of this.refs) {
      const d = r.depth()
      repr[at++] = d >> 8
      repr[at++] = d & 0xff
    }
    for (const r of this.refs) {
      repr.set(r.hash(), at)
      at += 32
    }
    const hash = sha256(repr)
    this.#hash = hash
    return hash
  }

  equals(other: Cell): boolean {
    const a = this.hash()
    const b = other.hash()
    return a.every((x, i) => x === b[i])
  }

  beginParse(): Slice {
    return new Slice(this)
  }

  asBuilder(): Builder {
    return new Builder().storeSlice(this.beginParse())
  }

  /** BOC 序列化（单根，带 CRC32C） */
  toBoc(): Uint8Array {
    return serializeBoc(this)
  }

  toBase64(): string {
    return bytesToBase64(this.toBoc())
  }

  static fromBoc(bytes: Uint8Array): Cell {
    return parseBoc(bytes)
  }

  static fromBase64(text: string): Cell {
    return parseBoc(base64ToBytes(text))
  }
}

/** 不足一字节时补一个 1 再补 0（TON 的 augmented 格式） */
function paddedBytes(data: Uint8Array, bits: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits / 8))
  out.set(data.subarray(0, out.length))
  if (bits % 8) out[out.length - 1] = ((out[out.length - 1] as number) & (0xff << (8 - (bits % 8)))) | (0x80 >> bits % 8)
  return out
}

export class Builder {
  readonly #data = new Uint8Array(128)
  #bits = 0
  readonly #refs: Cell[] = []

  get bits(): number {
    return this.#bits
  }

  get refs(): number {
    return this.#refs.length
  }

  get availableBits(): number {
    return MAX_BITS - this.#bits
  }

  get availableRefs(): number {
    return MAX_REFS - this.#refs.length
  }

  storeBit(value: boolean | number): this {
    if (this.#bits >= MAX_BITS) throw new Error('Cell overflow: more than 1023 bits')
    if (value) this.#data[this.#bits >> 3] = (this.#data[this.#bits >> 3] as number) | (0x80 >> (this.#bits & 7))
    this.#bits++
    return this
  }

  storeUint(value: bigint | number, bits: number): this {
    const v = BigInt(value)
    if (v < 0n || (bits < 1024 && v >= 1n << BigInt(bits))) throw new RangeError(`Value ${v} does not fit in ${bits} bits`)
    for (let i = bits - 1; i >= 0; i--) this.storeBit((v >> BigInt(i)) & 1n ? 1 : 0)
    return this
  }

  storeInt(value: bigint | number, bits: number): this {
    const v = BigInt(value)
    const limit = 1n << BigInt(bits - 1)
    if (v < -limit || v >= limit) throw new RangeError(`Value ${v} does not fit in ${bits} signed bits`)
    return this.storeUint(v < 0n ? (1n << BigInt(bits)) + v : v, bits)
  }

  storeBytes(bytes: Uint8Array): this {
    for (const b of bytes) this.storeUint(b, 8)
    return this
  }

  /** Coins / VarUInteger 16：4 位字节数 + 数值 */
  storeCoins(value: bigint | number): this {
    const v = BigInt(value)
    if (v < 0n) throw new RangeError(`Negative coins: ${v}`)
    if (v === 0n) return this.storeUint(0, 4)
    const bytes = Math.ceil(v.toString(16).length / 2)
    if (bytes > 15) throw new RangeError(`Coins value too large: ${v}`)
    return this.storeUint(bytes, 4).storeUint(v, bytes * 8)
  }

  /** MsgAddress：null 为 addr_none（2 位 0），否则 addr_std（不带 anycast） */
  storeAddress(address: string | TonAddress | null): this {
    if (address === null) return this.storeUint(0, 2)
    const a = typeof address === 'string' ? parseTonAddress(address) : address
    if (!a) throw new Error(`Invalid TON address: ${String(address)}`)
    return this.storeUint(2, 2).storeUint(0, 1).storeInt(a.workchain, 8).storeBytes(a.hash)
  }

  storeRef(cell: Cell | Builder): this {
    if (this.#refs.length >= MAX_REFS) throw new Error('Cell overflow: more than 4 refs')
    this.#refs.push(cell instanceof Builder ? cell.endCell() : cell)
    return this
  }

  storeMaybeRef(cell: Cell | Builder | null | undefined): this {
    if (!cell) return this.storeBit(0)
    return this.storeBit(1).storeRef(cell)
  }

  /** 把一个 Slice 剩下的位和引用接上 */
  storeSlice(slice: Slice): this {
    const s = slice.clone()
    while (s.remainingBits > 0) this.storeBit(s.loadBit())
    while (s.remainingRefs > 0) this.storeRef(s.loadRef())
    return this
  }

  storeBuilder(builder: Builder): this {
    return this.storeSlice(builder.endCell().beginParse())
  }

  store(fn: (b: Builder) => void): this {
    fn(this)
    return this
  }

  endCell(): Cell {
    return new Cell(this.#data, this.#bits, [...this.#refs])
  }
}

export const beginCell = () => new Builder()

export class Slice {
  readonly #cell: Cell
  #bit = 0
  #ref = 0

  constructor(cell: Cell, bit = 0, ref = 0) {
    this.#cell = cell
    this.#bit = bit
    this.#ref = ref
  }

  get remainingBits(): number {
    return this.#cell.bits - this.#bit
  }

  get remainingRefs(): number {
    return this.#cell.refs.length - this.#ref
  }

  clone(): Slice {
    return new Slice(this.#cell, this.#bit, this.#ref)
  }

  loadBit(): boolean {
    if (this.#bit >= this.#cell.bits) throw new Error('Slice underflow')
    const v = ((this.#cell.data[this.#bit >> 3] as number) >> (7 - (this.#bit & 7))) & 1
    this.#bit++
    return v === 1
  }

  loadUint(bits: number): bigint {
    let v = 0n
    for (let i = 0; i < bits; i++) v = (v << 1n) | (this.loadBit() ? 1n : 0n)
    return v
  }

  loadUintNumber(bits: number): number {
    return Number(this.loadUint(bits))
  }

  loadInt(bits: number): bigint {
    const v = this.loadUint(bits)
    return v >= 1n << BigInt(bits - 1) ? v - (1n << BigInt(bits)) : v
  }

  loadBytes(n: number): Uint8Array {
    return Uint8Array.from({ length: n }, () => Number(this.loadUint(8)))
  }

  loadCoins(): bigint {
    return this.loadUint(this.loadUintNumber(4) * 8)
  }

  /** MsgAddress：addr_none 为 null；只支持 addr_std（不带 anycast） */
  loadAddress(): TonAddress | null {
    const tag = this.loadUintNumber(2)
    if (tag === 0) return null
    if (tag !== 2) throw new Error(`Unsupported address type ${tag}`)
    if (this.loadBit()) throw new Error('Anycast addresses are not supported')
    const workchain = Number(this.loadInt(8))
    return { workchain, hash: this.loadBytes(32), bounceable: null, testOnly: null }
  }

  loadRef(): Cell {
    const r = this.#cell.refs[this.#ref]
    if (!r) throw new Error('Slice underflow: no more refs')
    this.#ref++
    return r
  }

  loadMaybeRef(): Cell | null {
    return this.loadBit() ? this.loadRef() : null
  }
}

// ---------------------------------------------------------------------------
// BOC
// ---------------------------------------------------------------------------

const BOC_MAGIC = 0xb5ee9c72

/** 与 @ton/core 的 topologicalSort 相同的顺序（根在前，被引用的在后，重复的 Cell 只出现一次） */
function topologicalSort(root: Cell): Array<{ cell: Cell; refs: number[] }> {
  const key = (c: Cell) => bytesToHex(c.hash())
  let pending = [root]
  const all = new Map<string, { cell: Cell; refs: string[] }>()
  const notPerm = new Set<string>()
  while (pending.length) {
    const cells = pending
    pending = []
    for (const cell of cells) {
      const k = key(cell)
      if (all.has(k)) continue
      notPerm.add(k)
      all.set(k, { cell, refs: cell.refs.map(key) })
      pending.push(...cell.refs)
    }
  }
  const sorted: string[] = []
  const temp = new Set<string>()
  const visit = (k: string) => {
    if (!notPerm.has(k)) return
    if (temp.has(k)) throw new Error('Not a DAG')
    temp.add(k)
    const refs = (all.get(k) as { refs: string[] }).refs
    for (let i = refs.length - 1; i >= 0; i--) visit(refs[i] as string)
    sorted.push(k)
    temp.delete(k)
    notPerm.delete(k)
  }
  while (notPerm.size) visit(notPerm.values().next().value as string)
  const indexes = new Map<string, number>()
  sorted.forEach((k, i) => indexes.set(k, sorted.length - i - 1))
  return sorted.reverse().map((k) => {
    const e = all.get(k) as { cell: Cell; refs: string[] }
    return { cell: e.cell, refs: e.refs.map((r) => indexes.get(r) as number) }
  })
}

const bytesFor = (n: number) => Math.max(1, Math.ceil(n.toString(2).length / 8))

function serializeBoc(root: Cell): Uint8Array {
  const cells = topologicalSort(root)
  const sizeBytes = bytesFor(cells.length)
  const cellSize = (c: Cell) => 2 + Math.ceil(c.bits / 8) + c.refs.length * sizeBytes
  const total = cells.reduce((s, c) => s + cellSize(c.cell), 0)
  const offsetBytes = bytesFor(total)
  const out: number[] = []
  const uint = (v: number, bytes: number) => {
    for (let i = bytes - 1; i >= 0; i--) out.push(Math.floor(v / 2 ** (8 * i)) & 0xff)
  }
  uint(BOC_MAGIC, 4)
  out.push(0x40 | sizeBytes) // 没有索引、带 CRC32C、没有 cache bits
  out.push(offsetBytes)
  uint(cells.length, sizeBytes)
  uint(1, sizeBytes) // 根的数量
  uint(0, sizeBytes) // absent
  uint(total, offsetBytes)
  uint(0, sizeBytes) // 根的下标
  for (const { cell, refs } of cells) {
    out.push(cell.refs.length, Math.ceil(cell.bits / 8) + Math.floor(cell.bits / 8))
    out.push(...paddedBytes(cell.data, cell.bits))
    for (const r of refs) uint(r, sizeBytes)
  }
  const crc = crc32c(Uint8Array.from(out))
  out.push(crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24)
  return Uint8Array.from(out)
}

function parseBoc(bytes: Uint8Array): Cell {
  let pos = 0
  const need = (n: number) => {
    if (pos + n > bytes.length) throw new Error('Invalid BOC: unexpected end')
  }
  const uint = (n: number) => {
    need(n)
    let v = 0
    for (let i = 0; i < n; i++) v = v * 256 + (bytes[pos++] as number)
    return v
  }
  if (uint(4) !== BOC_MAGIC) throw new Error('Invalid BOC: unsupported magic')
  const flags = uint(1)
  const hasIdx = (flags & 0x80) !== 0
  const hasCrc = (flags & 0x40) !== 0
  if (flags & 0x18) throw new Error('Invalid BOC: unsupported flags')
  const sizeBytes = flags & 0x07
  if (sizeBytes < 1 || sizeBytes > 4) throw new Error('Invalid BOC: bad size bytes')
  const offsetBytes = uint(1)
  const count = uint(sizeBytes)
  const roots = uint(sizeBytes)
  uint(sizeBytes) // absent
  const total = uint(offsetBytes)
  if (roots < 1) throw new Error('Invalid BOC: no root')
  const rootIndex = uint(sizeBytes)
  for (let i = 1; i < roots; i++) uint(sizeBytes)
  if (hasIdx) pos += count * offsetBytes
  if (hasCrc) {
    const end = bytes.length - 4
    const expected = (bytes[end] as number) | ((bytes[end + 1] as number) << 8) | ((bytes[end + 2] as number) << 16) | ((bytes[end + 3] as number) << 24)
    if (crc32c(bytes.subarray(0, end)) !== expected >>> 0) throw new Error('Invalid BOC: CRC32C mismatch')
  }
  const start = pos
  const raw: Array<{ data: Uint8Array; bits: number; refs: number[] }> = []
  for (let i = 0; i < count; i++) {
    const d1 = uint(1)
    const d2 = uint(1)
    if (d1 & 0x08) throw new Error('Exotic cells are not supported')
    if (d1 & 0x10) throw new Error('Cells with stored hashes are not supported')
    if (d1 >> 5) throw new Error('Cells with a non-zero level are not supported')
    const refCount = d1 & 0x07
    const length = Math.ceil(d2 / 2)
    need(length)
    const data = bytes.slice(pos, pos + length)
    pos += length
    let bits = length * 8
    if (d2 & 1) {
      // 去掉补位：最后一个 1 及之后的 0
      const last = data[length - 1] as number
      if (!last) throw new Error('Invalid BOC: bad padding')
      const trailing = Math.log2(last & -last)
      bits = length * 8 - trailing - 1
      data[length - 1] = last & (0xff << (trailing + 1)) & 0xff
    }
    raw.push({ data, bits, refs: Array.from({ length: refCount }, () => uint(sizeBytes)) })
  }
  if (pos - start !== total) throw new Error('Invalid BOC: size mismatch')
  const built: Array<Cell | undefined> = []
  const build = (i: number): Cell => {
    const existing = built[i]
    if (existing) return existing
    const r = raw[i]
    if (!r) throw new Error('Invalid BOC: bad reference')
    if (r.refs.some((x) => x <= i)) throw new Error('Invalid BOC: references must point forward')
    const cell = new Cell(r.data, r.bits, r.refs.map(build))
    built[i] = cell
    return cell
  }
  return build(rootIndex)
}

let crcTable: Uint32Array | null = null

/** CRC32-C（Castagnoli），BOC 的校验 */
export function crc32c(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1
      crcTable[i] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of bytes) crc = (crcTable[(crc ^ b) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export const bytesToHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function base64ToBytes(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}
