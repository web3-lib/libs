import { isValidTonAddress, toFriendlyAddress, toRawAddress } from './address.js'
import { DEFAULT_URLS, NATIVE_TON, TON_DECIMALS, type TonNetwork } from './constants.js'
import { formatUnits } from './format.js'
import { FallbackTransport, ToncenterTransport, type QueryValue, type RequestOptions, type TonTransport, type ToncenterOptions } from './http.js'

/** 节点：toncenter v3 的 URL（如 https://toncenter.com/api/v3），或自己的 TonTransport */
export type TonSource = string | TonTransport

export interface ClientConfig extends Pick<ToncenterOptions, 'apiKey' | 'minInterval' | 'timeout' | 'retries' | 'headers' | 'fetch'> {
  /** 网络，默认 'mainnet'：不传节点时用它的 toncenter；也决定输出地址是不是测试网格式 */
  network?: TonNetwork
}

export type FailureReason = 'invalid-address' | 'not-found'

export interface TokenBalance {
  /** 'TON'（NATIVE_TON）或 Jetton 主合约地址（用户友好格式） */
  token: string
  native: boolean
  /** owner 的 Jetton 钱包地址；TON 为 null */
  wallet: string | null
  /** 余额（最小单位的十进制字符串） */
  balance: string
  /** 精度：元数据里没有时按 TEP-64 的默认值 9 */
  decimals: number
  /** 精度未知：Jetton 的元数据在链下、索引器还没读到，decimals 暂按 9（formatted 不可信） */
  decimalsUnknown?: true
  formatted: string
  /** symbol: true 时返回；读不到时为 null */
  symbol?: string | null
  /** symbol: true 时返回：索引器标记的诈骗代币（常见的是仿冒 USDT 等的空投） */
  isScam?: boolean
  success: boolean
  error?: FailureReason
}

export interface BalancesOptions extends RequestOptions {
  /** 同时返回 symbol 和 isScam */
  symbol?: boolean
}

export interface TonBalance {
  /** 用户友好格式 */
  address: string
  /** nanoTON */
  balance: string
  formatted: string
  /** active / uninit / frozen / nonexist */
  status: string
  success: boolean
  error?: FailureReason
}

export interface JettonDetails {
  /** 主合约地址（用户友好格式） */
  address: string
  name: string | null
  symbol: string | null
  decimals: number
  /** 精度未知：元数据在链下、索引器还没读到，decimals 暂按 9 */
  decimalsUnknown?: true
  description: string | null
  image: string | null
  /** 总供应量（最小单位） */
  totalSupply: string | null
  mintable: boolean | null
  admin: string | null
  /** 索引器标记的诈骗代币 */
  isScam: boolean
  success: boolean
  error?: FailureReason
}

export interface WalletState {
  address: string
  /** 是不是钱包合约 */
  isWallet: boolean
  /** 如 'wallet v4 r2'、'wallet v5 r1'；不是钱包或没部署时为 null */
  walletType: string | null
  seqno: number | null
  walletId: number | null
  balance: string
  status: string
  success: boolean
  error?: FailureReason
}

export interface NftDetails {
  address: string
  /** 在集合里的编号 */
  index: string | null
  collection: string | null
  collectionName: string | null
  name: string | null
  description: string | null
  image: string | null
  /** 元数据的链下地址（链上元数据时为 null） */
  contentUri: string | null
  /** 正在出售（放在了销售合约里）；这时 owner 是 realOwner */
  onSale: boolean
  owner: string | null
}

export interface NftsOptions extends RequestOptions {
  /** 只要这个集合的 */
  collection?: string
  /** 最多返回多少个，默认全部（自动翻页） */
  limit?: number
}

// ---------------------------------------------------------------------------
// toncenter v3 的响应
// ---------------------------------------------------------------------------

interface AddressBook {
  [raw: string]: { user_friendly?: string | null } | undefined
}

interface TokenInfo {
  valid?: boolean
  type?: string
  name?: string | null
  symbol?: string | null
  description?: string | null
  image?: string | null
  is_scam?: boolean
  extra?: Record<string, unknown> | null
}

interface MetadataMap {
  [raw: string]: { is_indexed?: boolean; token_info?: TokenInfo[] } | undefined
}

interface JettonWalletRow {
  address: string
  balance: string
  owner: string
  jetton: string
}

/** 进程内缓存的 Jetton 元数据（按网络 + 原始地址）：精度、名称基本不变 */
interface JettonMeta {
  name: string | null
  symbol: string | null
  decimals: number
  decimalsUnknown?: true
  description: string | null
  image: string | null
  isScam: boolean
}
const metaCache = new Map<string, JettonMeta>()
const MAX_CACHED = 10_000

/** 测试用：清空元数据缓存 */
export function resetMetadataCache(): void {
  metaCache.clear()
}

/** 地址统一成小写的原始格式（比较、作 map 的 key） */
const rawKey = (address: string) => toRawAddress(address)

/** 一次请求最多带多少个地址（toncenter 允许 1000 个，URL 太长时部分网关会拒绝，取 100） */
const CHUNK = 100

function chunks<T>(list: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * jetton/wallets 的请求怎么拆：toncenter 不接受多个 owner 同时带多个 jetton_address
 * （HTTP 422 “exact one owner_address required for multiple jetton_address”），这时按 Jetton 拆（每个 Jetton、每 100 个 owner 一次）
 * 或按 owner 拆（每个 owner、每 100 个 Jetton 一次），取请求少的。每个 (owner, Jetton) 只在一个请求里，结果与不拆相同
 */
function walletQueries(owners: readonly string[], masters: readonly string[] | null): Array<{ owners: string[]; masters?: string[] }> {
  if (!masters) return chunks(owners).map((o) => ({ owners: o }))
  if (owners.length <= 1 || masters.length <= 1) return chunks(owners).flatMap((o) => chunks(masters).map((m) => ({ owners: o, masters: m })))
  const byJetton = masters.length * Math.ceil(owners.length / CHUNK)
  const byOwner = owners.length * Math.ceil(masters.length / CHUNK)
  return byJetton <= byOwner
    ? masters.flatMap((m) => chunks(owners).map((o) => ({ owners: o, masters: [m] })))
    : owners.flatMap((o) => chunks(masters).map((m) => ({ owners: [o], masters: m })))
}

/**
 * info 是索引器读到的元数据；没有时用主合约的链上内容（content）。
 * 链上内容只有链下地址（uri）、索引器又还没读到时不知道精度：暂按 9，标记 decimalsUnknown（不缓存）
 */
function jettonMeta(info: TokenInfo | undefined, content?: Record<string, unknown>): JettonMeta {
  const c = content ?? {}
  const source = info ?? { name: c.name as string | undefined, symbol: c.symbol as string | undefined, description: c.description as string | undefined, image: c.image as string | undefined }
  const decimalsRaw = info?.extra?.decimals ?? c.decimals
  const decimals = Number(decimalsRaw)
  const valid = Number.isInteger(decimals) && decimals >= 0 && decimals <= 255
  const unknown = !valid && !info && typeof c.uri === 'string' && c.uri !== ''
  return {
    name: source.name ?? null,
    symbol: source.symbol ?? null,
    // TEP-64：元数据没有 decimals 时默认 9
    decimals: valid ? decimals : TON_DECIMALS,
    ...(unknown ? { decimalsUnknown: true as const } : {}),
    description: source.description ?? null,
    image: source.image ?? null,
    isScam: info?.is_scam ?? false,
  }
}

/** metadata 里第一个有效的某类条目 */
function tokenInfoOf(metadata: MetadataMap | undefined, raw: string, type: string): TokenInfo | undefined {
  const entry = metadata?.[raw.toUpperCase()] ?? metadata?.[raw]
  return entry?.token_info?.find((t) => t.valid !== false && t.type === type)
}

/**
 * TON 的批量读取：通过 toncenter v3 索引器（或兼容的自建索引器），多个地址合成一个请求，多节点故障切换。
 *
 * ```ts
 * const ton = new TonClient()                                         // 主网 toncenter（没有 Key 时每秒 1 次请求）
 * const ton = new TonClient('https://toncenter.com/api/v3', { apiKey })
 * await ton.balances(owner)                                           // TON + 持有的全部 Jetton
 * await ton.multiBalances([{ owner: a }, { owner: b, tokens: [USDT] }])  // 多个地址合成一次请求
 * ```
 */
export class TonClient {
  readonly network: TonNetwork
  readonly transport: TonTransport

  constructor(source?: TonSource | readonly TonSource[], config: ClientConfig = {}) {
    const given = source === undefined ? [] : Array.isArray(source) ? (source as readonly TonSource[]) : [source as TonSource]
    // 没指定网络时按节点 URL 判断（testnet.toncenter.com 等）
    this.network = config.network ?? (given.some((s) => typeof s === 'string' && /testnet/i.test(s)) ? 'testnet' : 'mainnet')
    const list = source === undefined ? DEFAULT_URLS[this.network] : given
    if (!list.length) throw new Error('No TON node configured')
    const nodes = list.map((s: TonSource) =>
      typeof s === 'string'
        ? new ToncenterTransport(s, { apiKey: config.apiKey, minInterval: config.minInterval, timeout: config.timeout, retries: config.retries, headers: config.headers, fetch: config.fetch })
        : s,
    )
    this.transport = nodes.length === 1 ? (nodes[0] as TonTransport) : new FallbackTransport(nodes)
  }

  #get<T>(path: string, query: Record<string, QueryValue>, options?: RequestOptions): Promise<T> {
    return this.transport.get<T>(path, query, options)
  }

  /** 输出的地址：优先用索引器给的用户友好格式（钱包是不可回弹的 UQ…，合约是 EQ…），否则按可回弹格式算 */
  #friendly(raw: string, book?: AddressBook): string {
    const known = book?.[raw.toUpperCase()]?.user_friendly ?? book?.[raw]?.user_friendly
    return known ?? toFriendlyAddress(raw, { testOnly: this.network === 'testnet' })
  }

  /** TON 余额（accountStates，每 100 个地址一个请求）；结果与 addresses 一一对应 */
  async tonBalances(addresses: readonly string[], options: RequestOptions = {}): Promise<TonBalance[]> {
    const valid = [...new Set(addresses.filter(isValidTonAddress).map(rawKey))]
    const states = new Map<string, { balance: string; status: string; friendly: string }>()
    for (const chunk of chunks(valid)) {
      const res = await this.#get<{ accounts?: Array<{ address: string; balance: string; status: string }>; address_book?: AddressBook }>(
        'accountStates',
        { address: chunk, include_boc: false },
        options,
      )
      for (const a of res.accounts ?? []) {
        states.set(rawKey(a.address), { balance: a.balance ?? '0', status: a.status ?? 'nonexist', friendly: this.#friendly(a.address, res.address_book) })
      }
    }
    return addresses.map((address): TonBalance => {
      if (!isValidTonAddress(address)) return { address, balance: '0', formatted: '0', status: 'nonexist', success: false, error: 'invalid-address' }
      const raw = rawKey(address)
      // 从没用过的地址索引器里没有：余额 0
      const s = states.get(raw)
      const balance = s?.balance ?? '0'
      return { address: s?.friendly ?? this.#friendly(raw), balance, formatted: formatUnits(BigInt(balance), TON_DECIMALS), status: s?.status ?? 'nonexist', success: true }
    })
  }

  /**
   * 一个地址的余额：不传 tokens 时返回 TON 和持有的全部 Jetton（余额为 0 的 Jetton 不返回）；
   * 传了时与 tokens 一一对应（NATIVE_TON 表示 TON，其余是 Jetton 主合约地址）
   */
  async balances(owner: string, tokens?: readonly string[], options: BalancesOptions = {}): Promise<TokenBalance[]> {
    const [result] = await this.multiBalances([{ owner, tokens }], options)
    return result as TokenBalance[]
  }

  /**
   * 多个地址的余额：所有地址的 Jetton 合成每 100 个地址一次 jetton/wallets 请求，TON 余额合成 accountStates 请求。
   * 多个地址都指定了多个 Jetton 时（toncenter 不接受一次查多个 owner 的多个 Jetton），按 Jetton 或按地址拆开，取请求少的。
   * 结果与 queries 一一对应
   */
  async multiBalances(queries: ReadonlyArray<{ owner: string; tokens?: readonly string[] }>, options: BalancesOptions = {}): Promise<TokenBalance[][]> {
    const owners = [...new Set(queries.filter((q) => isValidTonAddress(q.owner)).map((q) => rawKey(q.owner)))]
    const listAll = queries.some((q) => q.tokens === undefined)
    // 明确要查的 Jetton 主合约（全部查询都指定了 tokens 时只查这些）
    const explicit = [...new Set(queries.flatMap((q) => (q.tokens ?? []).filter((t) => t !== NATIVE_TON && isValidTonAddress(t)).map(rawKey)))]
    const wanted = listAll ? null : explicit
    const needTon = queries.some((q) => q.tokens === undefined || q.tokens.includes(NATIVE_TON))

    const [tonStates, jettonRows] = await Promise.all([
      needTon ? this.tonBalances(owners, options) : Promise.resolve([]),
      wanted && !wanted.length ? Promise.resolve({ rows: [], book: {}, metadata: {} }) : this.#jettonWallets(owners, wanted, options),
    ])
    const tonOf = new Map(owners.map((o, i) => [o, tonStates[i]]))
    // owner → 主合约 → 钱包
    const walletsOf = new Map<string, Map<string, JettonWalletRow>>()
    for (const row of jettonRows.rows) {
      const owner = rawKey(row.owner)
      let map = walletsOf.get(owner)
      if (!map) walletsOf.set(owner, (map = new Map()))
      map.set(rawKey(row.jetton), row)
    }
    // 元数据：响应里带的（索引过的）优先，其余（如没有余额的指定代币）单独查
    // 指定了的代币即使没有余额（不在结果里）也要读元数据：判断是不是 Jetton、取精度
    const masters = new Set([...jettonRows.rows.map((r) => rawKey(r.jetton)), ...explicit])
    const metas = await this.#jettonMetas([...masters], jettonRows.metadata, options)

    return queries.map((q): TokenBalance[] => {
      const symbol = options.symbol
      const fail = (token: string, error: FailureReason): TokenBalance => ({ token, native: token === NATIVE_TON, wallet: null, balance: '0', decimals: TON_DECIMALS, formatted: '0', ...(symbol ? { symbol: null, isScam: false } : {}), success: false, error })
      if (!isValidTonAddress(q.owner)) {
        if (q.tokens === undefined) throw new Error(`Invalid TON address: ${q.owner}`)
        return q.tokens.map((t) => fail(t, 'invalid-address'))
      }
      const owner = rawKey(q.owner)
      const ton = (): TokenBalance => {
        const s = tonOf.get(owner)
        return { token: NATIVE_TON, native: true, wallet: null, balance: s?.balance ?? '0', decimals: TON_DECIMALS, formatted: s?.formatted ?? '0', ...(symbol ? { symbol: 'TON', isScam: false } : {}), success: true }
      }
      const jetton = (master: string, row: JettonWalletRow | undefined): TokenBalance => {
        const meta = metas.get(master)
        const balance = row?.balance ?? '0'
        const decimals = meta?.decimals ?? TON_DECIMALS
        return {
          token: this.#friendly(master, jettonRows.book),
          native: false,
          wallet: row ? this.#friendly(row.address, jettonRows.book) : null,
          balance,
          decimals,
          ...(meta?.decimalsUnknown ? { decimalsUnknown: true as const } : {}),
          formatted: formatUnits(BigInt(balance), decimals),
          ...(symbol ? { symbol: meta?.symbol ?? null, isScam: meta?.isScam ?? false } : {}),
          success: true,
        }
      }
      if (q.tokens === undefined) {
        const held = [...(walletsOf.get(owner)?.entries() ?? [])].filter(([, row]) => BigInt(row.balance) > 0n)
        return [ton(), ...held.map(([master, row]) => jetton(master, row))]
      }
      return q.tokens.map((t) => {
        if (t === NATIVE_TON) return ton()
        if (!isValidTonAddress(t)) return fail(t, 'invalid-address')
        const master = rawKey(t)
        const row = walletsOf.get(owner)?.get(master)
        // 没有钱包、也读不到元数据：多半不是 Jetton 主合约
        if (!row && !metas.get(master)) return fail(this.#friendly(master, jettonRows.book), 'not-found')
        return jetton(master, row)
      })
    })
  }

  /** jetton/wallets：每 100 个 owner 一个请求（指定了 Jetton 时见 walletQueries），按 offset 翻页 */
  async #jettonWallets(owners: readonly string[], masters: readonly string[] | null, options: RequestOptions) {
    const rows: JettonWalletRow[] = []
    const book: AddressBook = {}
    const metadata: MetadataMap = {}
    for (const q of walletQueries(owners, masters)) {
      for (let offset = 0; ; offset += 1000) {
        const res = await this.#get<{ jetton_wallets?: JettonWalletRow[]; address_book?: AddressBook; metadata?: MetadataMap }>(
          'jetton/wallets',
          { owner_address: q.owners, jetton_address: q.masters, exclude_zero_balance: masters ? undefined : true, limit: 1000, offset },
          options,
        )
        const page = res.jetton_wallets ?? []
        rows.push(...page)
        Object.assign(book, res.address_book ?? {})
        Object.assign(metadata, res.metadata ?? {})
        if (page.length < 1000) break
      }
    }
    return { rows, book, metadata }
  }

  /** Jetton 元数据：先看缓存和已有的 metadata，缺的用 jetton/masters 读（带 jetton_content 里的 decimals） */
  async #jettonMetas(masters: readonly string[], known: MetadataMap, options: RequestOptions): Promise<Map<string, JettonMeta | null>> {
    const out = new Map<string, JettonMeta | null>()
    const missing: string[] = []
    for (const m of masters) {
      const cached = metaCache.get(`${this.network}:${m}`)
      if (cached) {
        out.set(m, cached)
        continue
      }
      const info = tokenInfoOf(known, m, 'jetton_masters')
      // 元数据里有 decimals 时直接用；没有时要看主合约的 jetton_content
      if (info && info.extra?.decimals !== undefined) {
        out.set(m, this.#remember(m, jettonMeta(info)))
      } else {
        missing.push(m)
      }
    }
    for (const chunk of chunks(missing)) {
      const res = await this.#get<{ jetton_masters?: Array<{ address: string; jetton_content?: Record<string, unknown> | null }>; metadata?: MetadataMap }>(
        'jetton/masters',
        { address: chunk, limit: chunk.length },
        options,
      )
      const found = new Set<string>()
      for (const master of res.jetton_masters ?? []) {
        const m = rawKey(master.address)
        found.add(m)
        const info = tokenInfoOf(res.metadata, m, 'jetton_masters') ?? tokenInfoOf(known, m, 'jetton_masters')
        out.set(m, this.#remember(m, jettonMeta(info, master.jetton_content ?? {})))
      }
      for (const m of chunk) if (!found.has(m)) out.set(m, null)
    }
    return out
  }

  #remember(master: string, meta: JettonMeta): JettonMeta {
    // 精度未知的不缓存：索引器读到元数据后再查就对了
    if (meta.decimalsUnknown) return meta
    metaCache.set(`${this.network}:${master}`, meta)
    if (metaCache.size > MAX_CACHED) metaCache.delete(metaCache.keys().next().value as string)
    return meta
  }

  /** Jetton 信息：名称、symbol、精度、图片、总供应量。结果与 masters 一一对应 */
  async jettons(masters: readonly string[], options: RequestOptions = {}): Promise<JettonDetails[]> {
    const valid = [...new Set(masters.filter(isValidTonAddress).map(rawKey))]
    const rows = new Map<string, { total_supply?: string; mintable?: boolean; admin_address?: string | null; jetton_content?: Record<string, unknown> | null }>()
    let book: AddressBook = {}
    let metadata: MetadataMap = {}
    for (const chunk of chunks(valid)) {
      const res = await this.#get<{ jetton_masters?: Array<{ address: string; total_supply?: string; mintable?: boolean; admin_address?: string | null; jetton_content?: Record<string, unknown> | null }>; address_book?: AddressBook; metadata?: MetadataMap }>(
        'jetton/masters',
        { address: chunk, limit: chunk.length },
        options,
      )
      for (const r of res.jetton_masters ?? []) rows.set(rawKey(r.address), r)
      book = { ...book, ...(res.address_book ?? {}) }
      metadata = { ...metadata, ...(res.metadata ?? {}) }
    }
    return masters.map((address): JettonDetails => {
      const empty = { name: null, symbol: null, decimals: TON_DECIMALS, description: null, image: null, totalSupply: null, mintable: null, admin: null, isScam: false }
      if (!isValidTonAddress(address)) return { address, ...empty, success: false, error: 'invalid-address' }
      const raw = rawKey(address)
      const row = rows.get(raw)
      if (!row) return { address: this.#friendly(raw, book), ...empty, success: false, error: 'not-found' }
      const meta = this.#remember(raw, jettonMeta(tokenInfoOf(metadata, raw, 'jetton_masters'), row.jetton_content ?? {}))
      return {
        address: this.#friendly(raw, book),
        ...meta,
        totalSupply: row.total_supply ?? null,
        mintable: row.mintable ?? null,
        admin: row.admin_address ? this.#friendly(row.admin_address, book) : null,
        success: true,
      }
    })
  }

  /** 钱包状态：钱包类型（v4r2 / v5r1 …）、seqno、余额、部署状态。结果与 addresses 一一对应 */
  async walletStates(addresses: readonly string[], options: RequestOptions = {}): Promise<WalletState[]> {
    const valid = [...new Set(addresses.filter(isValidTonAddress).map(rawKey))]
    const states = new Map<string, { is_wallet?: boolean; wallet_type?: string; seqno?: number; wallet_id?: number; balance?: string; status?: string }>()
    let book: AddressBook = {}
    for (const chunk of chunks(valid)) {
      const res = await this.#get<{ wallets?: Array<{ address: string; is_wallet?: boolean; wallet_type?: string; seqno?: number; wallet_id?: number; balance?: string; status?: string }>; address_book?: AddressBook }>(
        'walletStates',
        { address: chunk },
        options,
      )
      for (const w of res.wallets ?? []) states.set(rawKey(w.address), w)
      book = { ...book, ...(res.address_book ?? {}) }
    }
    return addresses.map((address): WalletState => {
      if (!isValidTonAddress(address)) return { address, isWallet: false, walletType: null, seqno: null, walletId: null, balance: '0', status: 'nonexist', success: false, error: 'invalid-address' }
      const raw = rawKey(address)
      const s = states.get(raw)
      return {
        address: this.#friendly(raw, book),
        isWallet: s?.is_wallet ?? false,
        walletType: s?.wallet_type ?? null,
        seqno: s?.seqno ?? null,
        walletId: s?.wallet_id ?? null,
        balance: s?.balance ?? '0',
        status: s?.status ?? 'nonexist',
        success: true,
      }
    })
  }

  /** 地址持有的 NFT（含正在出售的），自动翻页 */
  async nfts(owner: string, options: NftsOptions = {}): Promise<NftDetails[]> {
    if (!isValidTonAddress(owner)) throw new Error(`Invalid TON address: ${owner}`)
    const limit = options.limit ?? Number.POSITIVE_INFINITY
    const out: NftDetails[] = []
    for (let offset = 0; out.length < limit; offset += 1000) {
      const size = Math.min(1000, limit - out.length)
      const res = await this.#get<{
        nft_items?: Array<{ address: string; index?: string; collection_address?: string | null; owner_address?: string | null; real_owner?: string | null; on_sale?: boolean; content?: Record<string, unknown> | null }>
        address_book?: AddressBook
        metadata?: MetadataMap
      }>('nft/items', { owner_address: rawKey(owner), collection_address: options.collection ? rawKey(options.collection) : undefined, include_on_sale: true, limit: size, offset }, options)
      const page = res.nft_items ?? []
      for (const item of page) {
        const raw = rawKey(item.address)
        const info = tokenInfoOf(res.metadata, raw, 'nft_items')
        const collectionInfo = item.collection_address ? tokenInfoOf(res.metadata, rawKey(item.collection_address), 'nft_collections') : undefined
        const content = item.content ?? {}
        const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
        out.push({
          address: this.#friendly(raw, res.address_book),
          index: item.index ?? null,
          collection: item.collection_address ? this.#friendly(item.collection_address, res.address_book) : null,
          collectionName: text(collectionInfo?.name),
          name: text(info?.name) ?? text(content.name),
          description: text(info?.description) ?? text(content.description),
          image: text(info?.image) ?? text(content.image),
          contentUri: text(content.uri),
          onSale: item.on_sale ?? false,
          owner: item.real_owner ?? item.owner_address ? this.#friendly((item.real_owner ?? item.owner_address) as string, res.address_book) : null,
        })
      }
      if (page.length < size) break
    }
    return out
  }
}

