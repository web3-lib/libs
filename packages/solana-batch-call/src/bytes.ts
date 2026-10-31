import { encodeAddress } from './address.js'

/**
 * 小端读取二进制数据（账户数据、指令数据共用）。两种用法：
 * - 传偏移量：按绝对位置读，不移动游标（如 `b.u64(333)`）
 * - 不传：从游标处顺序读并前进（如 `r.u32(); r.pubkey()`）
 * 越界时抛 RangeError
 */
export class Bytes {
  readonly view: DataView
  /** 顺序读取的游标 */
  offset: number

  constructor(
    readonly data: Uint8Array,
    offset = 0,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    this.offset = offset
  }

  get bytes(): Uint8Array {
    return this.data
  }

  /** 要读的位置：传了 at 用它，否则用游标并前进 n 字节；检查越界 */
  #pos(at: number | undefined, n: number): number {
    const pos = at ?? this.offset
    if (pos < 0 || pos + n > this.data.length) {
      throw new RangeError('Account data is shorter than expected')
    }
    if (at === undefined) {
      this.offset += n
    }
    return pos
  }

  skip(n: number): void {
    this.#pos(undefined, n)
  }

  u8(at?: number): number {
    return this.data[this.#pos(at, 1)] as number
  }

  u16(at?: number): number {
    return this.view.getUint16(this.#pos(at, 2), true)
  }

  u32(at?: number): number {
    return this.view.getUint32(this.#pos(at, 4), true)
  }

  i32(at?: number): number {
    return this.view.getInt32(this.#pos(at, 4), true)
  }

  u64(at?: number): bigint {
    return this.view.getBigUint64(this.#pos(at, 8), true)
  }

  u128(at?: number): bigint {
    const pos = this.#pos(at, 16)
    return (this.view.getBigUint64(pos + 8, true) << 64n) | this.view.getBigUint64(pos, true)
  }

  /** 32 字节地址（base58） */
  key(at?: number): string {
    const pos = this.#pos(at, 32)
    return encodeAddress(this.data.subarray(pos, pos + 32))
  }

  /** 同 key（顺序读取时的习惯叫法） */
  pubkey(at?: number): string {
    return this.key(at)
  }

  /** borsh string：u32 长度 + UTF-8；去掉 Metaplex 用来补齐长度的 \0 */
  string(): string {
    const len = this.u32()
    const pos = this.#pos(undefined, len)
    return new TextDecoder().decode(this.data.subarray(pos, pos + len)).replace(/\0+$/, '').trim()
  }

  /** borsh Option：u8 标记（1 有）+ 值 */
  option<T>(read: () => T): T | null {
    return this.u8() === 1 ? read() : null
  }
}
