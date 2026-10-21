/**
 * 域名解析（子路径 `@w3lib/sui-batch-call/names`）：SuiNS，名字 → 地址、地址 → 默认名字（反查后再正查核对）。
 * 名字记录是注册表（Table<Domain, NameRecord>）的动态字段，对象 ID 在本地算出，按 ID 一次 BatchGetObjects 读完
 */
import { isValidSuiAddress, normalizeSuiAddress } from './address.js'
import type { SuiClient } from './client.js'
import type { SuiNetwork } from './constants.js'
import { json } from './dex/util.js'
import { dynamicFieldId } from './dynamicField.js'
import type { SuiObject } from './services.js'
import { BcsWriter } from './write/bcs.js'

export interface SuinsConfig {
  /** SuiNS 最初版本的包地址（domain::Domain 类型的地址，动态字段的键类型用它） */
  package: string
  /** registry::Registry 的 registry（Table<Domain, NameRecord>）的 ID */
  registry: string
  /** registry::Registry 的 reverse_registry（Table<address, Domain>，地址的默认名字）的 ID */
  reverseRegistry: string
}

/**
 * 内置的 SuiNS 部署（2026-10 在链上核对过：SuiNS 对象的动态字段 RegistryKey<Registry> 里的两个表）。
 * 主网 SuiNS 对象 0x6e0d…2871，测试网 0x3003…e5a3
 */
export const SUINS: Readonly<Partial<Record<SuiNetwork, SuinsConfig>>> = {
  mainnet: {
    package: '0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0',
    registry: '0xe64cd9db9f829c6cc405d9790bd71567ae07259855f4fba6f02c84f52298c106',
    reverseRegistry: '0x2fd099e17a292d2bc541df474f9fafa595653848cbabb2d7a4656ec786a1969f',
  },
  testnet: {
    package: '0x22fa05f21b1ad71442491220bb9338f7b7095fe35000ef88d5400d28523bdd93',
    registry: '0xb120c0d55432630fce61f7854795a3463deb6e3b443cc4ae72e1282073ff56e4',
    reverseRegistry: '0xcee9dbb070db70936c3a374439a6adb16f3ba97eac5468d2e1e6fff6ed93e465',
  },
}

export interface NamesOptions {
  /** 用哪个 SuiNS 部署，默认 SUINS 里客户端这个网络的（devnet 没有，要自己传） */
  suins?: SuinsConfig
  signal?: AbortSignal
}

export interface ResolvedName {
  /** 传入的名字（原样） */
  name: string
  /** 规范化后的名字（小写、点分格式，如 'example.sui'；'@example' 也是它）；名字不合法时为 null */
  normalized: string | null
  /** 解析出的地址；没有注册、没有设置地址、已过期、名字不合法时为 null */
  address: string | null
  /**
   * 到期时间（毫秒时间戳）；过期的名字 address 为 null、expiresAt 早于现在。
   * 叶子子域名（没有自己的到期时间）取父域名的；没有注册、父域名对不上时为 null
   */
  expiresAt: number | null
}

export interface AddressName {
  /** 传入的地址（原样） */
  address: string
  /** 默认名字（反查记录，正查核对过：没过期、指回这个地址），点分格式；没有时为 null */
  name: string | null
}

/** 一个标签：小写字母、数字、连字符，1~63 个字符，不以连字符开头或结尾 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/** 整个名字最长 235 个字符（SuiNS 的限制） */
const MAX_NAME_LENGTH = 235

/**
 * 规范化 SuiNS 名字：小写，'@' 格式换成点分格式（'@example' → 'example.sui'，'sub@example' → 'sub.example.sui'）。
 * 只认 .sui 结尾的名字；不合法时为 null
 */
export function normalizeSuiName(name: string): string | null {
  const n = name.trim().toLowerCase()
  const at = n.indexOf('@')
  let labels: string[]
  if (at >= 0) {
    if (n.includes('@', at + 1)) return null
    const sub = n.slice(0, at)
    labels = [...(sub ? sub.split('.') : []), n.slice(at + 1), 'sui']
  } else {
    labels = n.split('.')
    if (labels.length < 2 || labels[labels.length - 1] !== 'sui') return null
  }
  if (!labels.every((l) => LABEL.test(l))) return null
  const out = labels.join('.')
  return out.length <= MAX_NAME_LENGTH ? out : null
}

/**
 * 名字换成另一种写法：'dot' 是 'sub.example.sui'，'at' 是 'sub@example'（Sui 钱包常用的显示格式）。名字不合法时为 null
 *
 * ```ts
 * formatSuiName('example.sui', 'at')   // '@example'
 * formatSuiName('@example', 'dot')     // 'example.sui'
 * ```
 */
export function formatSuiName(name: string, format: 'dot' | 'at'): string | null {
  const normalized = normalizeSuiName(name)
  if (!normalized || format === 'dot') return normalized
  const labels = normalized.split('.').slice(0, -1)
  const sld = labels.pop() as string
  return `${labels.join('.')}@${sld}`
}

function configOf(client: SuiClient, options: NamesOptions): SuinsConfig {
  const config = options.suins ?? SUINS[client.network]
  if (!config) throw new Error(`No SuiNS deployment is built in for ${client.network}; pass options.suins`)
  return config
}

/** domain::Domain { labels: vector<String> }：标签倒序（'sub.example.sui' → ['sui', 'example', 'sub']） */
const domainBcs = (domain: string) =>
  new BcsWriter()
    .vector(domain.split('.').reverse(), (w, label) => w.string(label))
    .finish()

/** 名字记录的对象 ID（注册表的动态字段，键是 Domain） */
const recordId = (config: SuinsConfig, domain: string) => dynamicFieldId(config.registry, `${config.package}::domain::Domain`, domainBcs(domain))
/** 反查记录的对象 ID（反查表的动态字段，键是 address） */
const reverseId = (config: SuinsConfig, address: string) => dynamicFieldId(config.reverseRegistry, 'address', new BcsWriter().address(address).finish())

/** 时钟对象（0x6），时间按链上的算（与 SuiNS 合约、节点的解析一致），不依赖本机时间 */
const CLOCK = '0x6'

interface NameRecord {
  nftId: string | null
  /** 0 表示叶子子域名（没有自己的 NFT 和到期时间，跟随父域名） */
  expiration: number
  target: string | null
}

/** Field<Domain, NameRecord> → NameRecord */
function recordOf(o: SuiObject | null): NameRecord | null {
  const v = o ? json(o).value : null
  if (!v || typeof v !== 'object') return null
  const expiration = Number(v.expiration_timestamp_ms)
  if (!Number.isSafeInteger(expiration) || expiration < 0) return null
  return {
    nftId: isValidSuiAddress(v.nft_id) ? normalizeSuiAddress(v.nft_id) : null,
    expiration,
    target: isValidSuiAddress(v.target_address) ? normalizeSuiAddress(v.target_address) : null,
  }
}

const parentOf = (domain: string) => domain.slice(domain.indexOf('.') + 1)

/**
 * 读名字记录（一轮 BatchGetObjects：记录、子域名的父域名记录、时钟），按 SuiNS 的规则判断是否有效：
 * 普通记录没过期才有效；叶子子域名要父域名存在、NFT 相同（父域名没有重新注册过）、没过期
 */
async function readRecords(client: SuiClient, config: SuinsConfig, domains: readonly string[], signal?: AbortSignal): Promise<Map<string, { address: string | null; expiresAt: number | null }>> {
  const out = new Map<string, { address: string | null; expiresAt: number | null }>()
  if (!domains.length) return out
  // 子域名的父域名一起读：读到之前不知道它是不是叶子
  const all = [...new Set(domains.flatMap((d) => (d.split('.').length > 2 ? [d, parentOf(d)] : [d])))]
  const objects = await client.objects([...all.map((d) => recordId(config, d)), CLOCK], { fields: ['json'], signal })
  const records = new Map(all.map((d, i) => [d, recordOf(objects[i] ?? null)]))
  const clockObject = objects[all.length]
  const clock = clockObject ? Number(json(clockObject).timestamp_ms) : Number.NaN
  const now = Number.isFinite(clock) && clock > 0 ? clock : Date.now()
  for (const d of domains) {
    const r = records.get(d)
    if (!r) {
      out.set(d, { address: null, expiresAt: null })
      continue
    }
    let expiresAt: number | null = r.expiration
    if (r.expiration === 0) {
      const parent = d.split('.').length > 2 ? records.get(parentOf(d)) : null
      expiresAt = parent && parent.expiration !== 0 && parent.nftId !== null && parent.nftId === r.nftId ? parent.expiration : null
    }
    // SuiNS 的判断：到期时间早于现在算过期
    out.set(d, { address: expiresAt !== null && expiresAt >= now ? r.target : null, expiresAt })
  }
  return out
}

/**
 * 名字 → 地址（SuiNS）。名字可以是 'example.sui'、'@example'、'sub.example.sui'、'sub@example'，大小写不限；
 * 一轮 BatchGetObjects（每次 50 个，自动分批）
 *
 * ```ts
 * await resolveNames(sui, ['example.sui', '@adeniyi', 'nobody-here.sui'])
 * // [{ name: 'example.sui', normalized: 'example.sui', address: '0x214a…9db0', expiresAt: 1912952738221 }, …, { …, address: null, expiresAt: null }]
 * ```
 */
export async function resolveNames(client: SuiClient, names: readonly string[], options: NamesOptions = {}): Promise<ResolvedName[]> {
  const config = configOf(client, options)
  const items = names.map((name) => ({ name, normalized: normalizeSuiName(name) }))
  const records = await readRecords(
    client,
    config,
    [...new Set(items.flatMap((x) => (x.normalized ? [x.normalized] : [])))],
    options.signal,
  )
  return items.map((x) => {
    const r = x.normalized ? records.get(x.normalized) : undefined
    return { name: x.name, normalized: x.normalized, address: r?.address ?? null, expiresAt: r?.expiresAt ?? null }
  })
}

/**
 * 地址 → 默认名字：读反查记录，再正查核对名字没过期、确实指回这个地址（名字转手或改了指向后，旧的反查记录可能还在）。
 * 两轮 BatchGetObjects；不合法的地址为 null
 *
 * ```ts
 * await lookupAddresses(sui, [owner])   // [{ address: owner, name: 'adeniyi.sui' }]
 * ```
 */
export async function lookupAddresses(client: SuiClient, addresses: readonly string[], options: NamesOptions = {}): Promise<AddressName[]> {
  const config = configOf(client, options)
  const valid = addresses.map((a) => (isValidSuiAddress(a) ? normalizeSuiAddress(a) : null))
  const unique = [...new Set(valid.filter((a): a is string => a !== null))]
  const entries = unique.length ? await client.objects(unique.map((a) => reverseId(config, a)), { fields: ['json'], signal: options.signal }) : []
  // Field<address, Domain>：value 是 Domain（标签倒序）
  const claimed = new Map<string, string>()
  unique.forEach((address, i) => {
    const labels = (entries[i] ? json(entries[i]).value?.labels : null) as unknown
    if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string')) return
    const domain = normalizeSuiName([...labels].reverse().join('.'))
    if (domain) claimed.set(address, domain)
  })
  const records = await readRecords(client, config, [...new Set(claimed.values())], options.signal)
  return addresses.map((address, i) => {
    const a = valid[i]
    const domain = a ? claimed.get(a) : undefined
    return { address, name: domain && records.get(domain)?.address === a ? domain : null }
  })
}
