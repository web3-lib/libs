/**
 * 域名解析（子路径 `@w3lib/ton-batch-call/names`）：TON DNS（.ton）和 Telegram 用户名（.t.me，Fragment 上的 NFT），
 * 名字 → 钱包地址（合约的 dnsresolve get 方法，链上读），地址 → 名字（索引器的地址簿，再正查核对）
 */
import { isValidTonAddress, sameTonAddress, toFriendlyAddress, toRawAddress } from './address.js'
import type { TonClient } from './client.js'
import type { TonNetwork } from './constants.js'
import type { RequestOptions } from './http.js'

export interface TonNameService {
  id: string
  name: string
  network: TonNetwork
  /** 名字后缀（如 'ton'、't.me'） */
  suffix: string
  /** 这个后缀的 DNS 解析合约（NFT 集合）：根 DNS 对这个后缀返回的 dns_next_resolver */
  resolver: string
}

/** 根 DNS 合约（配置参数 4） */
export const TON_DNS_ROOT: Readonly<Record<TonNetwork, string>> = {
  mainnet: '-1:e56754f83426f69b09267bd876ac97c44821345b7e266bd956a7bfbfb98df35c',
  testnet: '-1:efe71d13860afaa6aeaeaf636f9168487f80f1031b0bf8d939ae49d3ea7f7da0',
}

/** 内置的域名服务（2026-10 在链上核对过：根 DNS 对这些后缀返回的就是这里的解析合约） */
export const NAME_SERVICES: readonly TonNameService[] = [
  { id: 'ton', name: 'TON DNS', network: 'mainnet', suffix: 'ton', resolver: 'EQC3dNlesgVD8YbAazcauIrXBPfiVhMMr5YYk2in0Mtsz0Bz' },
  { id: 't.me', name: 'Telegram Usernames', network: 'mainnet', suffix: 't.me', resolver: 'EQCA14o1-VWhS2efqoh_9M1b_A9DtKTuoqfmkn83AbJzwnPi' },
  { id: 'ton', name: 'TON DNS', network: 'testnet', suffix: 'ton', resolver: 'EQDjPtM6QusgMgWfl9kMcG-EALslbTITnKcH8VZK1pnH3UZA' },
]

export interface NamesOptions extends RequestOptions {
  /** 用哪些域名服务，默认 NAME_SERVICES 里客户端这个网络的 */
  services?: readonly TonNameService[]
}

export interface LookupAddressesOptions extends NamesOptions {
  /** 正查核对（名字确实解析回这个地址），默认 true；false 时直接用索引器的结果，少一半以上的请求 */
  verify?: boolean
}

export interface ResolvedName {
  /** 传入的名字（原样） */
  name: string
  /** 规范化后的名字（小写、去掉末尾的点）；名字不合法时为 null */
  normalized: string | null
  /** 名字的 wallet 记录（用户友好格式，不可回弹 UQ…）；没有注册、没有设置钱包、名字不合法时为 null */
  address: string | null
  /** 解析这个名字的服务 id；没有服务认这个后缀时为 null */
  service: string | null
}

export interface AddressName {
  /** 传入的地址（原样） */
  address: string
  /** 地址自己持有、并且 wallet 记录指向自己的名字（正查核对过）；没有时为 null */
  name: string | null
  service: string | null
}

/** dnsresolve 的类别：sha256("wallet") */
const CATEGORY_WALLET = 0xe8d44050873dba865aa7c170ab4cce64d90839a34dcfd6cf71d14e0205443b1bn
const DNS_NEXT_RESOLVER = 0xba93
const DNS_SMC_ADDRESS = 0x9fd3
/** 解析链最多跟几次 dns_next_resolver（子域名） */
const MAX_HOPS = 8
/** 名字编码后最多 126 字节（TEP-81；dnsresolve 的参数是一个 Cell 的 slice，最多 1023 位） */
const MAX_BYTES = 126
const CHUNK = 100

function servicesOf(client: TonClient, options: NamesOptions): readonly TonNameService[] {
  return options.services ?? NAME_SERVICES.filter((s) => s.network === client.network)
}

/** 名字归哪个服务：后缀最长的匹配优先；名字要比后缀多至少一级 */
function serviceFor(name: string, services: readonly TonNameService[]): TonNameService | null {
  let best: TonNameService | null = null
  for (const s of services) {
    if (name.endsWith(`.${s.suffix}`) && (!best || s.suffix.length > best.suffix.length)) best = s
  }
  return best
}

/** TEP-81：每一级非空，字符在 0x21..0x7E（没有空格、控制字符和非 ASCII），按小写解析 */
function normalize(name: string): string | null {
  if (typeof name !== 'string') return null
  const n = name.trim().toLowerCase().replace(/\.$/, '')
  if (!n.includes('.') || n.length > MAX_BYTES) return null
  return n.split('.').every((label) => /^[\x21-\x2d\x2f-\x7e]+$/.test(label)) ? n : null
}

/** TEP-81 的编码：各级倒序，每级后面一个 \0（foundation.ton → "ton\0foundation\0"） */
const encode = (name: string) => new TextEncoder().encode(`${name.split('.').reverse().join('\0')}\0`)

// ---------------------------------------------------------------------------
// dnsresolve 的参数和结果只用到单个 Cell：在这里直接编解码 BOC，不带上 Cell / SHA-256（打包小十几 KB）
// ---------------------------------------------------------------------------

/** CRC32-C（BOC 的校验） */
function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of bytes) {
    crc ^= b
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0x82f63b78 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

/** 只有数据（整字节、最多 127 字节）、没有引用的 Cell 的 BOC（与 Cell.toBase64 相同：带 CRC32C、不带索引） */
export function bytesCellBoc(data: Uint8Array): string {
  if (data.length > 127) throw new Error('Name too long')
  // 魔数、标志（带 CRC32C，大小 1 字节）、偏移 1 字节、1 个 Cell、1 个根、0 个 absent、Cell 总大小、根的下标；Cell：0 个引用、数据长度 × 2
  const head = [0xb5, 0xee, 0x9c, 0x72, 0x41, 1, 1, 1, 0, 2 + data.length, 0, 0, data.length * 2]
  const body = Uint8Array.from([...head, ...data])
  const crc = crc32c(body)
  return toBase64(Uint8Array.from([...body, crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24]))
}

/** BOC 的根 Cell 的数据（引用不读）；格式不对时为 null */
export function rootCellData(boc: string): { data: Uint8Array; bits: number } | null {
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(boc.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
  let pos = 0
  const uint = (n: number) => {
    let v = 0
    for (let i = 0; i < n; i++) v = v * 256 + (bytes[pos++] ?? 0)
    return v
  }
  if (uint(4) !== 0xb5ee9c72) return null
  const flags = uint(1)
  const size = flags & 7
  const offset = uint(1)
  if (size < 1 || size > 4 || offset < 1 || offset > 8) return null
  const count = uint(size)
  const roots = uint(size)
  uint(size) // absent
  uint(offset) // Cell 总大小
  const root = uint(size)
  pos += (roots - 1) * size + (flags & 0x80 ? count * offset : 0)
  for (let i = 0; i < count && pos < bytes.length; i++) {
    const d1 = uint(1)
    const d2 = uint(1)
    // 存了哈希的 Cell（level 不为 0 的特殊 Cell）这里不需要支持
    if (d1 & 0x10) return null
    const length = Math.ceil(d2 / 2)
    if (i === root) {
      const data = bytes.slice(pos, pos + length)
      if (data.length !== length) return null
      let bits = length * 8
      if (d2 & 1) {
        // 不足一字节：去掉补位（最后一个 1 及之后的 0）
        const last = data[length - 1] as number
        if (!last) return null
        const trailing = Math.log2(last & -last)
        bits -= trailing + 1
        data[length - 1] = last & (0xff << (trailing + 1)) & 0xff
      }
      return { data, bits }
    }
    pos += length + (d1 & 7) * size
  }
  return null
}

/**
 * 记录的地址：dns_next_resolver#ba93 / dns_smc_address#9fd3 后面跟 MsgAddressInt（addr_std，不带 anycast），
 * 都在 Cell 的前 283 位里；类型不对、读不出时为 null
 */
export function recordAddress(boc: string, tag: number): string | null {
  const cell = rootCellData(boc)
  if (!cell || cell.bits < 16 + 11 + 256) return null
  const bit = (i: number) => ((cell.data[i >> 3] as number) >> (7 - (i & 7))) & 1
  const read = (from: number, n: number) => {
    let v = 0
    for (let i = 0; i < n; i++) v = v * 2 + bit(from + i)
    return v
  }
  // 标签、addr_std$10、不带 anycast
  if (read(0, 16) !== tag || read(16, 2) !== 2 || read(18, 1) !== 0) return null
  const workchain = read(19, 8)
  const hash = Array.from({ length: 32 }, (_, k) => read(27 + k * 8, 8).toString(16).padStart(2, '0')).join('')
  return `${workchain > 127 ? workchain - 256 : workchain}:${hash}`
}

/**
 * 从 resolver 开始解析剩下的字节（root 已经解析了后缀那部分）。按 TEP-81：dnsresolve 返回解析了多少位和记录，
 * 没解析完时记录是下一个 resolver，接着解析剩下的部分。合约里没有这个名字（NFT 没部署 / 没初始化、没有记录）时为 null
 */
async function resolveFrom(client: TonClient, resolver: string, bytes: Uint8Array, options: RequestOptions): Promise<string | null> {
  let at = resolver
  let rest = bytes
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const res = await client.transport.post<{ exit_code?: number; stack?: Array<{ type: string; value: unknown }> }>(
      'runGetMethod',
      { address: at, method: 'dnsresolve', stack: [{ type: 'slice', value: bytesCellBoc(rest) }, { type: 'num', value: `0x${CATEGORY_WALLET.toString(16)}` }] },
      options,
    )
    // get 方法失败（合约没部署 -13、NFT 还没初始化等）：没有这个名字；节点问题（HTTP 错误）照常抛出
    const code = res.exit_code ?? 0
    if (code !== 0 && code !== 1) return null
    const [count, record] = res.stack ?? []
    if (count?.type !== 'num') return null
    const value = String(count.value)
    const bits = value.startsWith('-') ? -1 : Number(BigInt(value))
    const boc = record && (record.type === 'cell' || record.type === 'slice') && typeof record.value === 'string' ? record.value : null
    if (bits <= 0 || bits % 8 !== 0 || bits > rest.length * 8 || !boc) return null
    if (bits === rest.length * 8) return recordAddress(boc, DNS_SMC_ADDRESS)
    const next = recordAddress(boc, DNS_NEXT_RESOLVER)
    if (!next) return null
    at = next
    rest = rest.slice(bits / 8)
  }
  return null
}

/**
 * 名字 → 钱包地址：读 .ton / .t.me 的 NFT 集合和域名 NFT 的 dnsresolve（链上，不经过索引器），每个名字 2 次 get 方法调用，
 * 子域名每多一级多一次。toncenter 没有 API Key 时每秒 1 次请求
 *
 * ```ts
 * await resolveNames(ton, ['foundation.ton', 'stud.t.me'])
 * // [{ name: 'foundation.ton', normalized: 'foundation.ton', address: 'UQCD39VS…', service: 'ton' }, …]
 * ```
 */
export async function resolveNames(client: TonClient, names: readonly string[], options: NamesOptions = {}): Promise<ResolvedName[]> {
  const services = servicesOf(client, options)
  const items = names.map((name) => {
    const normalized = normalize(name)
    return { name, normalized, service: normalized ? serviceFor(normalized, services) : null }
  })
  // 同一个名字只解析一次；不同名字一起发出（同一个节点的请求自动排队）
  const unique = new Map<string, TonNameService>()
  for (const x of items) if (x.normalized && x.service) unique.set(x.normalized, x.service)
  const resolved = new Map(
    await Promise.all(
      [...unique].map(async ([name, s]): Promise<[string, string | null]> => {
        // 根 DNS 解析掉的是后缀那部分（"ton" / "me\0t"，不含后面的 \0），从后缀的解析合约开始解析剩下的
        const bytes = encode(name).slice(encode(s.suffix).length - 1)
        return [name, await resolveFrom(client, toRawAddress(s.resolver), bytes, options)]
      }),
    ),
  )
  const testOnly = client.network === 'testnet'
  return items.map((x) => {
    const raw = x.normalized ? (resolved.get(x.normalized) ?? null) : null
    return { name: x.name, normalized: x.normalized, address: raw ? toFriendlyAddress(raw, { bounceable: false, testOnly }) : null, service: x.service?.id ?? null }
  })
}

/**
 * 地址 → 名字：用索引器的地址簿（toncenter v3 的 addressBook，每 100 个地址一次请求）里的 domain——地址自己持有、并且
 * wallet 记录指向自己的 .ton / .t.me 名字；再正查核对名字确实解析回这个地址（索引器可能落后，名字可能已经转走或过期）。
 * 只是指向这个地址、但 NFT 在别人手里的名字不返回
 *
 * ```ts
 * await lookupAddresses(ton, ['UQCdqXGvONLwOr3zCNX5FjapflorB6ZsOdcdfLrjsDLt3AF4'])
 * // [{ address: 'UQCdqXGv…', name: 'tolya.ton', service: 'ton' }]
 * ```
 */
export async function lookupAddresses(client: TonClient, addresses: readonly string[], options: LookupAddressesOptions = {}): Promise<AddressName[]> {
  const services = servicesOf(client, options)
  const valid = [...new Set(addresses.filter(isValidTonAddress).map((a) => toRawAddress(a)))]
  const domains = new Map<string, string>()
  for (let i = 0; i < valid.length; i += CHUNK) {
    const book = await client.transport.get<Record<string, { domain?: string | null } | undefined>>('addressBook', { address: valid.slice(i, i + CHUNK) }, options)
    for (const [key, row] of Object.entries(book ?? {})) {
      if (row?.domain && isValidTonAddress(key)) domains.set(toRawAddress(key), row.domain)
    }
  }
  const claimed = valid.flatMap((raw) => {
    const name = domains.get(raw)
    const normalized = name ? normalize(name) : null
    const service = normalized ? serviceFor(normalized, services) : null
    return normalized && service ? [{ raw, name: normalized, service }] : []
  })
  const forward = options.verify === false ? null : await resolveNames(client, claimed.map((c) => c.name), { ...options, services })
  const found = new Map<string, { name: string; service: string }>()
  claimed.forEach((c, i) => {
    const f = forward?.[i]
    if (!forward || (f?.address && sameTonAddress(f.address, c.raw))) found.set(c.raw, { name: c.name, service: c.service.id })
  })
  return addresses.map((address) => {
    const hit = isValidTonAddress(address) ? found.get(toRawAddress(address)) : undefined
    return { address, name: hit?.name ?? null, service: hit?.service ?? null }
  })
}
