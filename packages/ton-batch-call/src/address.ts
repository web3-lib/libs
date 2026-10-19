/**
 * TON 地址（TEP-2）：
 * - 原始格式 `0:1a2b…`（工作链 : 32 字节哈希的十六进制）
 * - 用户友好格式：36 字节 base64（标志位 1 字节 + 工作链 1 字节 + 哈希 32 字节 + CRC16 2 字节），48 个字符。
 *   标志位 0x11 可回弹（EQ… / Ef…）、0x51 不可回弹（UQ… / Uf…），再加 0x80 表示只在测试网用（kQ… / 0Q…）
 */

export interface TonAddress {
  workchain: number
  /** 32 字节 */
  hash: Uint8Array
  /** 从用户友好格式解析时的标志；原始格式为 null */
  bounceable: boolean | null
  testOnly: boolean | null
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64Decode(text: string): Uint8Array | null {
  const s = text.replace(/-/g, '+').replace(/_/g, '/')
  if (s.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(s)) return null
  const out: number[] = []
  for (let i = 0; i < s.length; i += 4) {
    const chunk = s.slice(i, i + 4)
    const v = [...chunk].map((c) => (c === '=' ? 0 : B64.indexOf(c)))
    const n = ((v[0] as number) << 18) | ((v[1] as number) << 12) | ((v[2] as number) << 6) | (v[3] as number)
    out.push((n >> 16) & 0xff)
    if (chunk[2] !== '=') out.push((n >> 8) & 0xff)
    if (chunk[3] !== '=') out.push(n & 0xff)
  }
  return new Uint8Array(out)
}

function base64Encode(bytes: Uint8Array, urlSafe: boolean): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63] as string
    out += B64[(n >> 12) & 63] as string
    out += i + 1 < bytes.length ? (B64[(n >> 6) & 63] as string) : '='
    out += i + 2 < bytes.length ? (B64[n & 63] as string) : '='
  }
  return urlSafe ? out.replace(/\+/g, '-').replace(/\//g, '_') : out
}

/** CRC16-XMODEM（多项式 0x1021，初值 0），TON 用户友好地址的校验 */
export function crc16(data: Uint8Array): number {
  let crc = 0
  for (const byte of data) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/** 解析任意格式的 TON 地址；不合法时返回 null */
export function parseTonAddress(value: string): TonAddress | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const raw = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(text)
  if (raw) {
    const workchain = Number(raw[1])
    if (workchain < -128 || workchain > 127) return null
    const hash = new Uint8Array(32)
    for (let i = 0; i < 32; i++) hash[i] = parseInt((raw[2] as string).slice(i * 2, i * 2 + 2), 16)
    return { workchain, hash, bounceable: null, testOnly: null }
  }
  if (text.length !== 48) return null
  const bytes = base64Decode(text)
  if (!bytes || bytes.length !== 36) return null
  const tag = bytes[0] as number
  const testOnly = (tag & 0x80) !== 0
  const flag = tag & 0x7f
  if (flag !== 0x11 && flag !== 0x51) return null
  if (crc16(bytes.subarray(0, 34)) !== (((bytes[34] as number) << 8) | (bytes[35] as number))) return null
  const workchain = (bytes[1] as number) > 127 ? (bytes[1] as number) - 256 : (bytes[1] as number)
  return { workchain, hash: bytes.slice(2, 34), bounceable: flag === 0x11, testOnly }
}

export function isValidTonAddress(value: unknown): value is string {
  return typeof value === 'string' && parseTonAddress(value) !== null
}

function mustParse(value: string): TonAddress {
  const a = parseTonAddress(value)
  if (!a) throw new Error(`Invalid TON address: ${value}`)
  return a
}

/** 原始格式（`0:` + 64 位小写十六进制），toncenter 返回的是大写，比较前都转成这个 */
export function toRawAddress(value: string | TonAddress): string {
  const a = typeof value === 'string' ? mustParse(value) : value
  return `${a.workchain}:${hex(a.hash)}`
}

export interface FriendlyOptions {
  /** 可回弹（合约地址用 true；钱包按 TEP-2 推荐用 false，即 UQ… 格式）。默认 true */
  bounceable?: boolean
  /** 测试网地址（kQ… / 0Q…），默认 false */
  testOnly?: boolean
  /** URL 安全的 base64（- 和 _），默认 true */
  urlSafe?: boolean
}

/** 用户友好格式 */
export function toFriendlyAddress(value: string | TonAddress, options: FriendlyOptions = {}): string {
  const a = typeof value === 'string' ? mustParse(value) : value
  const bytes = new Uint8Array(36)
  bytes[0] = ((options.bounceable ?? true) ? 0x11 : 0x51) | (options.testOnly ? 0x80 : 0)
  bytes[1] = a.workchain & 0xff
  bytes.set(a.hash, 2)
  const crc = crc16(bytes.subarray(0, 34))
  bytes[34] = crc >> 8
  bytes[35] = crc & 0xff
  return base64Encode(bytes, options.urlSafe ?? true)
}

/** 两个地址是否相同（忽略格式和标志） */
export function sameTonAddress(a: string, b: string): boolean {
  const x = parseTonAddress(a)
  const y = parseTonAddress(b)
  return !!x && !!y && x.workchain === y.workchain && hex(x.hash) === hex(y.hash)
}
