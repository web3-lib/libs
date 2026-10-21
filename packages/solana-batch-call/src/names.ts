/**
 * 域名解析（子路径 `@w3lib/solana-batch-call/names`）：SNS（Solana Name Service，Bonfida），名字 → 地址、地址 → 主域名（反查后核对）。
 * 账户地址都在本地按 PDA 推导，读取合成 getMultipleAccounts，不需要索引节点（代币化的域名除外）
 */
import { sha256 } from '@noble/hashes/sha2.js'

import { decodeAddress, encodeAddress, findProgramAddress, getAssociatedTokenAddress, isAddress, isOnCurve } from './address.js'
import type { RequestOptions, SolanaClient } from './client.js'
import { TOKEN_PROGRAM_ID } from './constants.js'
import type { AccountInfo } from './layout.js'

/** SPL Name Service 程序 */
export const NAME_PROGRAM_ID = 'namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX'
/** SNS 顶级域（`.sns`，2026-10 之前叫 `.sol`，链上是同一批账户）的根账户 */
export const SNS_ROOT_DOMAIN = '58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx'
/** 反查记录的 class（同时是 SNS 注册程序的中心状态账户） */
const REVERSE_LOOKUP_CLASS = '33m47vH6Eav6jr5Ry86XjhRft2jRBLDnDgPSHoquXi2Z'
/** V2 记录的 class：sns-records 程序（HP3D4D1Z…）的中心状态 PDA */
const RECORDS_V2_CLASS = '2pMnqHvei2N5oDcVGCRdZx48gqti199wr5CsyTTafsbo'
/** 主域名（favourite domain）所在的程序 */
const PRIMARY_DOMAIN_PROGRAM = '85iDfUvr3HJyLM2zcq5BXSiDvUWfw6cSE1FfNBo8Ap29'
/** 域名代币化（NFT）程序 */
const NAME_TOKENIZER_ID = 'nftD3vbNkNqfj2Sd3HZwbpw4BxxKWr4AjGb9X38JeZk'
/** 名字账户的头部：parent（32）+ owner（32）+ class（32），之后是数据 */
const HEADER_LEN = 96

const encoder = new TextEncoder()
const ZERO = new Uint8Array(32)

export interface NamesOptions extends RequestOptions {
  /**
   * 也按 SNS 解析 `.sol` 名字（当作同名的 `.sns`）。默认 false：`.sol` 正在迁到另一个注册服务（SRS），
   * SNS 官方 SDK 从 slot 452,825,395（约 2026-10-15）起不再解析 `.sol`，以后同一个 `.sol` 名字可能属于别人
   */
  legacySol?: boolean
  /**
   * 域名的 owner 是 PDA（程序账户，不是钱包）时也作为地址返回，默认 false（与官方 SDK 一致：转给 PDA 的资产可能取不出来，address 为 null）
   */
  allowPda?: boolean
}

/**
 * 地址的来源（与 SNS 官方 SDK 的解析顺序相同）：
 * - nft：域名代币化成了 NFT，地址是 NFT 的持有人（要用 getTokenLargestAccounts 找，节点不支持时 address 为 null）
 * - record-v2 / record-v1：域名设置的 SOL 记录（V2 要求 owner 验证过、没有过期；V1 要求 owner 的签名）
 * - owner：域名的 owner
 */
export type NameSource = 'nft' | 'record-v2' | 'record-v1' | 'owner'

export interface ResolvedName {
  /** 传入的名字（原样） */
  name: string
  /** 规范化后的名字（小写、去掉空格，后缀为 .sns）；名字不合法时为 null */
  normalized: string | null
  /** 解析出的地址（SOL 记录，没有时为 owner）；没有注册、名字不合法、记录不合法时为 null */
  address: string | null
  /** 域名的 owner（代币化的域名是 NFT 的持有人） */
  owner: string | null
  source: NameSource | null
  /** 解析这个名字的服务（'sns'）；名字不归 SNS 管时为 null */
  service: 'sns' | null
}

export interface AddressName {
  /** 传入的地址（原样） */
  address: string
  /** 主域名（如 'bonfida.sns'），核对过属于这个地址；没有设置或已经转给别人时为 null */
  name: string | null
  service: 'sns' | null
}

const hashName = (name: string) => sha256(encoder.encode(`SPL Name Service${name}`))

/** 名字账户：sha256('SPL Name Service' + name)、class、parent 推导的 PDA（没有 class / parent 时用 32 个 0） */
function nameAccount(name: string, nameClass?: string, parent?: string): string {
  return findProgramAddress([hashName(name), nameClass ? decodeAddress(nameClass) : ZERO, parent ? decodeAddress(parent) : ZERO], NAME_PROGRAM_ID)
}

/** 域名对应的名字账户：'bonfida' 或子域名 'sub.bonfida'（不带后缀）；子域名的种子是 '\0' + 子域名，parent 是父域名 */
export function snsDomainKey(domain: string): { key: string; parent: string | null } {
  const labels = domain.split('.')
  if (labels.length === 2) {
    const parent = nameAccount(labels[1] as string, undefined, SNS_ROOT_DOMAIN)
    return { key: nameAccount(`\0${labels[0]}`, undefined, parent), parent }
  }
  if (labels.length !== 1) {
    throw new Error(`Invalid SNS domain: ${domain}`)
  }
  return { key: nameAccount(domain, undefined, SNS_ROOT_DOMAIN), parent: null }
}

/** 反查记录：sha256 的是名字账户地址的 base58，class 是 REVERSE_LOOKUP_CLASS，子域名的 parent 是父域名 */
function reverseKey(domainKey: string, parent?: string | null): string {
  return nameAccount(domainKey, REVERSE_LOOKUP_CLASS, parent ?? undefined)
}

/** 规范化：小写、去掉首尾空格；只认 name.sns / sub.name.sns（legacySol 时也认 .sol），返回不带后缀的部分 */
function parseName(name: string, legacySol: boolean): { domain: string; normalized: string } | null {
  const n = name.trim().toLowerCase()
  const suffix = n.endsWith('.sns') ? '.sns' : legacySol && n.endsWith('.sol') ? '.sol' : null
  if (!suffix) {
    return null
  }
  const domain = n.slice(0, -suffix.length)
  const labels = domain.split('.')
  if (labels.length > 2 || labels.some((l) => !l || l.includes('\0'))) {
    return null
  }
  return { domain, normalized: `${domain}.sns` }
}

interface Registry {
  parent: string
  owner: string
  data: Uint8Array
}

function registryOf(account: AccountInfo | null | undefined): Registry | null {
  if (!account || account.owner !== NAME_PROGRAM_ID || account.data.length < HEADER_LEN) {
    return null
  }
  return { parent: encodeAddress(account.data.slice(0, 32)), owner: encodeAddress(account.data.slice(32, 64)), data: account.data.slice(HEADER_LEN) }
}

/** NftRecord：tag（1）+ nonce（1）+ 名字账户（32）+ owner（32）+ NFT mint（32）；tag 2 表示域名正在代币化 */
function tokenized(account: AccountInfo | null | undefined): boolean {
  return !!account && account.owner === NAME_TOKENIZER_ID && account.data[0] === 2
}

const nftRecordKey = (domainKey: string) => findProgramAddress([encoder.encode('nft_record'), decodeAddress(domainKey)], NAME_TOKENIZER_ID)
const nftMint = (domainKey: string) => findProgramAddress([encoder.encode('tokenized_name'), decodeAddress(domainKey)], NAME_TOKENIZER_ID)

/** 记录账户：V1 的种子是 '\x01' + 记录名，parent 是域名；V2 是 '\x02' + 记录名，class 是 RECORDS_V2_CLASS */
const recordV1Key = (domainKey: string, record: string) => nameAccount(`\x01${record}`, undefined, domainKey)
const recordV2Key = (domainKey: string, record: string) => nameAccount(`\x02${record}`, RECORDS_V2_CLASS, domainKey)

/** V2 记录的验证方式和对应 id 的长度：0 None，1 Solana（32），2 Ethereum（20），3 UnverifiedSolana（32） */
const VALIDATION_LENGTH = [0, 32, 20, 32]
const VALIDATION_SOLANA = 1

/**
 * V2 的 SOL 记录（与官方 SDK 相同）：数据是 u16 过期验证方式 + u16 关联验证方式 + u32 内容长度，然后是两个验证 id 和内容。
 * 返回记录的地址；记录过期（过期验证的 id 不是当前 owner）时为 undefined（继续看 V1 / owner）；记录不合法时为 null（不解析）
 */
function solRecordV2(registry: Registry | null, owner: string): string | null | undefined {
  if (!registry || registry.data.length < 8) {
    return undefined
  }
  const view = new DataView(registry.data.buffer, registry.data.byteOffset, registry.data.byteLength)
  const staleness = view.getUint16(0, true)
  const roa = view.getUint16(2, true)
  const stalenessLength = VALIDATION_LENGTH[staleness]
  const roaLength = VALIDATION_LENGTH[roa]
  if (stalenessLength === undefined || roaLength === undefined) {
    return null
  }
  const body = registry.data.slice(8)
  const content = body.slice(stalenessLength + roaLength)
  if (content.length !== 32 || staleness !== VALIDATION_SOLANA || roa !== VALIDATION_SOLANA) {
    return null
  }
  if (encodeAddress(body.slice(0, 32)) !== owner) {
    return undefined // owner 换了：记录过期
  }
  // 关联验证的 id 必须就是内容本身（内容地址签过名）
  return encodeAddress(body.slice(32, 64)) === encodeAddress(content) ? encodeAddress(content) : null
}

/** V1 的 SOL 记录：32 字节地址 + 64 字节 owner 的签名（签的是 hex(地址 ‖ 记录账户地址) 的 UTF-8）；签名不对时为 null */
async function solRecordV1(registry: Registry | null, recordKey: string, owner: string): Promise<string | null> {
  if (!registry || registry.data.length < 96) {
    return null
  }
  const target = registry.data.slice(0, 32)
  const signature = registry.data.slice(32, 96)
  const hex = [...target, ...decodeAddress(recordKey)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return (await verifyEd25519(decodeAddress(owner), signature, encoder.encode(hex))) ? encodeAddress(target) : null
}

/** Ed25519 验签（WebCrypto）；运行环境不支持时当作验签失败 */
async function verifyEd25519(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return false
  try {
    const key = await subtle.importKey('raw', publicKey as Uint8Array<ArrayBuffer>, { name: 'Ed25519' }, false, ['verify'])
    return await subtle.verify('Ed25519', key, signature as Uint8Array<ArrayBuffer>, message as Uint8Array<ArrayBuffer>)
  } catch {
    return false
  }
}

/**
 * 代币化域名的 NFT 持有人：getTokenLargestAccounts 找到唯一的持有账户，再读出它的 owner（与官方 SDK 相同）。
 * 免费公共节点大多不支持 getTokenLargestAccounts，这时为 null
 */
async function nftHolders(client: SolanaClient, domainKeys: readonly string[], signal: AbortSignal | undefined): Promise<Map<string, string | null>> {
  const largest = await Promise.all(
    domainKeys.map((key) =>
      client
        .request<{ value: Array<{ address: string; amount: string }> }>('getTokenLargestAccounts', [nftMint(key), { commitment: client.commitment }], { signal })
        .then((res) => res.value.find((a) => a.amount === '1')?.address ?? null)
        .catch((err: unknown) => {
          if (signal?.aborted) throw err
          return null
        }),
    ),
  )
  const holders = largest.filter((a): a is string => a !== null)
  const accounts = holders.length ? await client.accounts(holders, { signal }) : []
  const ownerOf = new Map(holders.map((a, i) => [a, accounts[i]?.owner === TOKEN_PROGRAM_ID ? encodeAddress((accounts[i] as AccountInfo).data.slice(32, 64)) : null]))
  return new Map(domainKeys.map((key, i) => [key, largest[i] ? (ownerOf.get(largest[i] as string) ?? null) : null]))
}

/**
 * 名字 → 地址（一次 getMultipleAccounts 读域名、NFT 记录、两版 SOL 记录；代币化的域名另外找 NFT 持有人）。
 * 解析顺序同官方 SDK：代币化 → NFT 持有人；V2 SOL 记录（验证过、没过期）；V1 SOL 记录（owner 签过名）；owner（是 PDA 时默认不返回）
 *
 * ```ts
 * await resolveNames(client, ['bonfida.sns', 'toly.sns'])
 * // [{ name: 'bonfida.sns', normalized: 'bonfida.sns', address: 'Fw1E…Lb1v', owner: 'Fw1E…Lb1v', source: 'owner', service: 'sns' }, …]
 * ```
 */
export async function resolveNames(client: SolanaClient, names: readonly string[], options: NamesOptions = {}): Promise<ResolvedName[]> {
  const { signal, legacySol = false, allowPda = false } = options
  const items = names.map((name) => {
    const parsed = parseName(name, legacySol)
    if (!parsed) return { name, parsed: null, key: null }
    const { key } = snsDomainKey(parsed.domain)
    return { name, parsed, key, nft: nftRecordKey(key), v1: recordV1Key(key, 'SOL'), v2: recordV2Key(key, 'SOL') }
  })
  const keys = items.flatMap((x) => (x.key ? [x.key, x.nft, x.v1, x.v2] : [])) as string[]
  const accounts = keys.length ? await client.accounts(keys, { signal }) : []
  const byKey = new Map(keys.map((k, i) => [k, accounts[i] ?? null]))
  const nfts = items.filter((x) => x.key && registryOf(byKey.get(x.key)) && tokenized(byKey.get(x.nft as string))).map((x) => x.key as string)
  const holders = nfts.length ? await nftHolders(client, nfts, signal) : new Map<string, string | null>()

  return Promise.all(
    items.map(async (x): Promise<ResolvedName> => {
      const base = { name: x.name, normalized: x.parsed?.normalized ?? null, service: x.parsed ? ('sns' as const) : null }
      const registry = x.key ? registryOf(byKey.get(x.key)) : null
      if (!x.key || !registry) {
        return { ...base, address: null, owner: null, source: null }
      }
      if (holders.has(x.key)) {
        const holder = holders.get(x.key) ?? null
        return { ...base, address: holder, owner: holder, source: 'nft' }
      }
      const owner = registry.owner
      const v2 = solRecordV2(registryOf(byKey.get(x.v2 as string)), owner)
      if (v2 !== undefined) {
        return { ...base, address: v2, owner, source: 'record-v2' }
      }
      const v1 = await solRecordV1(registryOf(byKey.get(x.v1 as string)), x.v1 as string, owner)
      if (v1) {
        return { ...base, address: v1, owner, source: 'record-v1' }
      }
      return { ...base, address: allowPda || isOnCurve(decodeAddress(owner)) ? owner : null, owner, source: 'owner' }
    }),
  )
}

/** 反查记录的数据：u32 长度 + 名字（子域名的以 \0 开头） */
function reverseName(account: AccountInfo | null | undefined): string | null {
  const registry = registryOf(account)
  if (!registry || registry.data.length < 4) {
    return null
  }
  const length = new DataView(registry.data.buffer, registry.data.byteOffset).getUint32(0, true)
  if (registry.data.length < 4 + length) {
    return null
  }
  return new TextDecoder().decode(registry.data.slice(4, 4 + length)).replace(/^\0/, '') || null
}

/**
 * 地址 → 主域名：读地址设置的主域名（favourite domain），再读域名和反查记录拼出名字，核对名字确实推导出这个域名账户、
 * 并且域名属于这个地址（owner 是它，或代币化后它持有 NFT）——换了 owner 的旧设置不算。通常两次 getMultipleAccounts（子域名三次）
 *
 * ```ts
 * await lookupAddresses(client, [wallet])   // [{ address: wallet, name: 'bonfida.sns', service: 'sns' }]
 * ```
 */
export async function lookupAddresses(client: SolanaClient, addresses: readonly string[], options: RequestOptions = {}): Promise<AddressName[]> {
  const { signal } = options
  const wallets = [...new Set(addresses.filter((a) => isAddress(a)))]
  const primaryKeys = wallets.map((w) => findProgramAddress([encoder.encode('favourite_domain'), decodeAddress(w)], PRIMARY_DOMAIN_PROGRAM))
  const primaries = primaryKeys.length ? await client.accounts(primaryKeys, { signal }) : []
  // 主域名账户：tag（1）+ 名字账户（32）
  const chosen = wallets.flatMap((wallet, i) => {
    const a = primaries[i]
    return a && a.owner === PRIMARY_DOMAIN_PROGRAM && a.data.length >= 33 ? [{ wallet, domain: encodeAddress(a.data.slice(1, 33)) }] : []
  })
  // 先按顶级域名读反查记录（大多数情况）；是子域名时再读一次
  const round2 = chosen.flatMap((c) => [c.domain, reverseKey(c.domain), getAssociatedTokenAddress(c.wallet, nftMint(c.domain), TOKEN_PROGRAM_ID)])
  const accounts2 = round2.length ? await client.accounts(round2, { signal }) : []
  const found = chosen.map((c, i) => ({ ...c, registry: registryOf(accounts2[3 * i]), reverse: accounts2[3 * i + 1] ?? null, nft: accounts2[3 * i + 2] ?? null }))
  const subs = found.filter((f) => f.registry && f.registry.parent !== SNS_ROOT_DOMAIN)
  const round3 = subs.flatMap((f) => [reverseKey(f.domain, f.registry?.parent), reverseKey(f.registry?.parent as string)])
  const accounts3 = round3.length ? await client.accounts(round3, { signal }) : []
  const subNames = new Map(
    subs.map((f, i) => {
      const [sub, parent] = [reverseName(accounts3[2 * i]), reverseName(accounts3[2 * i + 1])]
      return [f, sub && parent ? `${sub}.${parent}` : null]
    }),
  )

  const names = new Map<string, string>()
  for (const f of found) {
    if (!f.registry) continue
    const domain = f.registry.parent === SNS_ROOT_DOMAIN ? reverseName(f.reverse) : (subNames.get(f) ?? null)
    if (!domain) continue
    // 正查核对：名字推导出的账户就是主域名指向的账户（反查记录的内容格式不对时不会拼出别的名字）
    let key: string
    try {
      key = snsDomainKey(domain).key
    } catch {
      continue
    }
    // 代币化的域名：钱包的 ATA 里有这个域名的 NFT（数量 1）
    const holdsNft = !!f.nft && f.nft.owner === TOKEN_PROGRAM_ID && f.nft.data.length >= 72 && new DataView(f.nft.data.buffer, f.nft.data.byteOffset).getBigUint64(64, true) === 1n
    if (key === f.domain && (f.registry.owner === f.wallet || holdsNft)) {
      names.set(f.wallet, `${domain}.sns`)
    }
  }
  return addresses.map((address) => {
    const name = names.get(address) ?? null
    return { address, name, service: name ? 'sns' : null }
  })
}
