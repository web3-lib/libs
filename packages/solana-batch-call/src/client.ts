import { base64 } from '@scure/base'

import { getAssociatedTokenAddress, getMetadataAddress, isAddress } from './address.js'
import {
  NATIVE_MINT,
  SOL_DECIMALS,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  clusterOfGenesis,
  type Cluster,
} from './constants.js'
import {
  formatUnits,
  parseMetaplexMetadata,
  parseMint,
  parseTokenAccount,
  parseTransferFeeConfig,
  type AccountInfo,
  type MetaplexMetadata,
  type MintInfo,
  type TransferFeeInfo,
} from './layout.js'
import { AllNodesFailedError, HttpError, RpcError, isBehind, type RpcTransport } from './rpc.js'
import { NetworkMismatchError, resolveSource, type RpcSource, type SourceOptions } from './source.js'
import {
  DEFAULT_TOKEN_FIELDS,
  type Commitment,
  type DefaultTokenField,
  type FailureReason,
  type NftDetails,
  type NftOwner,
  type OwnedToken,
  type SolBalance,
  type TokenBalance,
  type TokenDetails,
  type TokenField,
  type TokenProgramOption,
  type TokenStandard,
  type TransferFee,
  type TransferFeeConfig,
} from './types.js'

export interface ClientConfig extends SourceOptions {
  /** 网络。不传 provider 时用于选择内置节点（默认 mainnet）；传了 provider 时用于校验节点所在网络 */
  cluster?: Cluster
  /** 默认 'confirmed' */
  commitment?: Commitment
  /**
   * 视为原生 SOL 的 mint，默认 [So111…112（Wrapped SOL）, 11111…1（System Program）]。
   * 可以包含非 Solana 地址（如 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE），作为调用方自己的“主币”标识：
   * balances / tokens 遇到它时按 SOL 返回，token 原样带回（这是支持的用法，不会做地址校验）
   */
  nativeMints?: readonly string[]
}

/** 所有查询共用：取消 */
export interface RequestOptions {
  /**
   * 取消查询：已取消时直接 reject（不发请求）；中途取消时立即 reject（reason 为 signal.reason）。
   * 已经发出、和其他查询合并在一起的底层请求会继续完成（结果给其他调用方），不会中断
   */
  signal?: AbortSignal
}

/** 读余额类查询共用：指定最低 slot、返回读取时的 slot */
export interface SlotOptions {
  /**
   * 最低 slot：节点高度不到这个 slot 时（如刚成交、公共节点还落后一两个 slot）换下一个节点；
   * 所有节点都不够时每 500ms 重试，最多约 10 秒后抛错。传了它时结果项带 slot
   */
  minContextSlot?: number
  /** 结果项带 slot（读取时节点的 context.slot；一次查询发了多个请求时取最小的）。默认 false */
  withSlot?: boolean
}

export interface BalancesOptions extends RequestOptions, SlotOptions {
  /** 同时返回 symbol（代币查一次后缓存，主币为 SOL）。默认 false */
  symbol?: boolean
  /**
   * 用 getTokenAccountsByOwner 扫描持有人的全部代币账户（含非 ATA 账户、同一代币的多个账户合计）。
   * 不传 mints 时总是扫描。注意：免费公共节点大多不支持这个方法，需要自己的节点。
   */
  scan?: boolean
  /**
   * 指定 mints 时统计哪些代币账户（不传 mints 或 scan: true 时不起作用，总是统计全部账户）：
   * - 'ata'（默认）：只看关联代币账户（ATA），本地推导地址 + getMultipleAccounts，免费节点也能用
   * - 'all'：每个代币发一次按 mint 过滤的 getTokenAccountsByOwner（同一 tick 发出，合并成批量请求），统计该代币的全部账户并合计。
   *   只关心少数几个代币、又要算上非 ATA 账户时比 scan 轻得多；同样需要支持索引方法的节点
   */
  accounts?: 'ata' | 'all'
  /**
   * 只返回这些类型的代币：'spl'（SPL Token）、'token-2022'，也可以传程序地址。默认两种都返回。
   * 如传 ['spl']：结果里不含 Token-2022 代币（扫描时也不再请求 Token-2022 的代币账户）。主币 SOL 不受影响
   */
  tokenPrograms?: readonly TokenProgramOption[]
}

export interface OwnerTokensOptions extends RequestOptions, SlotOptions {
  /** 只返回这些类型的代币：'spl'、'token-2022' 或程序地址，默认两种都返回；主币 SOL 不受影响（用 includeNative 控制） */
  tokenPrograms?: readonly TokenProgramOption[]
  /** 返回 name / symbol（代币查一次后缓存）。默认 true */
  metadata?: boolean
  /** 第一项返回 SOL。默认 true */
  includeNative?: boolean
  /** 包含余额为 0 的代币账户（如已清空但未关闭的 ATA）。默认 false */
  includeZero?: boolean
  /** 包含 NFT（精度 0 且数量 1）。默认 false */
  includeNfts?: boolean
}

export interface TokensOptions<F extends TokenField = DefaultTokenField> extends RequestOptions {
  /** 要返回的字段，默认 ['name', 'symbol', 'decimals'] */
  fields?: readonly F[]
}

/** accounts() 的参数 */
export interface AccountsOptions extends RequestOptions {
  /** 最低 slot，见 SlotOptions.minContextSlot */
  minContextSlot?: number
}

/** solBalances() 的参数 */
export interface SolBalancesOptions extends RequestOptions, SlotOptions {}

/** multiBalances() 的单项：一个钱包和要查的代币 */
export interface BalanceQuery {
  owner: string
  mints: readonly string[]
}

/** 一次查询的上下文：取消、最低 slot，以及读到的 slot（各请求 context.slot 的最小值） */
interface QueryContext {
  signal?: AbortSignal
  minContextSlot?: number
  slot?: number
}

/** 节点高度不够时的重试间隔与总时长 */
const BEHIND_RETRY_INTERVAL = 500
const BEHIND_RETRY_TIMEOUT = 10_000

const MAX_ACCOUNTS_PER_REQUEST = 100
/** 同时进行的 getMultipleAccounts 请求数上限 */
const MAX_PARALLEL_ACCOUNT_REQUESTS = 3
/** #fetchAccounts 里没能读到（节点问题）的账户 */
const FAILED = Symbol('failed')

/** 可以降级处理的错误：网络 / HTTP 错误、节点限制（限频、需要 Key 等）、节点不在期望的网络上、所有节点都失败；其他（参数错误、程序 bug）照常抛出 */
function isRecoverable(err: unknown): boolean {
  return err instanceof HttpError || (err instanceof RpcError && err.nodeFault) || err instanceof NetworkMismatchError || err instanceof AllNodesFailedError
}

/** 查询带上取消：已取消时不执行；中途取消时立即 reject，查询本身继续（结果丢弃） */
function abortable<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  if (!signal) {
    return run()
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    run()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const TOKEN_PROGRAMS: readonly string[] = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]

// 用 Map：普通对象会让 'constructor' 等原型上的名字通过校验
const PROGRAM_ALIASES = new Map<string, string>([
  ['spl', TOKEN_PROGRAM_ID],
  ['token-2022', TOKEN_2022_PROGRAM_ID],
  [TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID],
  [TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM_ID],
])

/**
 * 简写 / 程序地址转成程序地址（顺序固定为 Token、Token-2022）。
 * 不认识的值和空数组报错，避免拼错或漏选时悄悄过滤掉全部代币
 */
function resolvePrograms(tokenPrograms: readonly TokenProgramOption[] | undefined): readonly string[] {
  if (tokenPrograms === undefined) {
    return TOKEN_PROGRAMS
  }
  if (tokenPrograms.length === 0) {
    throw new Error(`tokenPrograms is empty (expected 'spl' and / or 'token-2022'; omit it to include both)`)
  }
  const wanted = new Set(
    tokenPrograms.map((value) => {
      const program = PROGRAM_ALIASES.get(value)
      if (!program) {
        throw new Error(`Unknown token program: ${value} (expected 'spl', 'token-2022' or a token program id)`)
      }
      return program
    }),
  )
  return TOKEN_PROGRAMS.filter((program) => wanted.has(program))
}

/** 所属程序已知且不在允许范围内 */
function isExcluded(tokenProgram: string | undefined, allowed: readonly string[]): boolean {
  return tokenProgram !== undefined && !allowed.includes(tokenProgram)
}

/** 按 mint 汇总后精度 0、数量 1 的持仓视为 NFT（ownerTokens 与 ownerNfts 共用） */
function isNftHolding(holding: Holding): boolean {
  return holding.decimals === 0 && holding.amount === 1n
}

const TOKEN_STANDARDS: readonly TokenStandard[] = [
  'NonFungible',
  'FungibleAsset',
  'Fungible',
  'NonFungibleEdition',
  'ProgrammableNonFungible',
  'ProgrammableNonFungibleEdition',
]

interface TokenMeta {
  decimals?: number
  tokenProgram?: string
  /** null：确认没有元数据 */
  name?: string | null
  symbol?: string | null
}

interface CachedMeta extends TokenMeta {
  /** name / symbol 的写入时间 */
  namesAt?: number
}

// 代币信息缓存（按 网络 + mint）：decimals / 所属程序不会变，永久缓存；
// name / symbol 来自可修改的元数据，缓存 1 小时。条目数有上限，超出时淘汰最早写入的
const NAME_TTL = 60 * 60 * 1000
const MAX_CACHED_TOKENS = 50_000
const tokenMetaCache = new Map<string, CachedMeta>()

let clientIds = 0

/** 缓存写入监听（persistTokenMetaCache 用） */
const cacheWriteListeners = new Set<() => void>()

/** 测试用：清空代币信息缓存 */
export function resetTokenMetaCache(): void {
  tokenMetaCache.clear()
}

/** exportTokenMetaCache() 的结果，可以 JSON 序列化 */
export interface TokenMetaSnapshot {
  version: 1
  /** [网络:mint, 信息]；namesAt 是 name / symbol 的写入时间（毫秒时间戳），导入后继续按 1 小时过期 */
  entries: Array<[string, { decimals?: number; tokenProgram?: string; name?: string | null; symbol?: string | null; namesAt?: number }]>
}

const SHARED_SCOPES = new Set<string>(['mainnet', 'devnet', 'testnet'])

/**
 * 导出代币信息缓存（decimals / 所属程序 / name / symbol），用于持久化：刷新页面后导入，不必重查 decimals。
 * 只导出按网络共享的条目（自定义节点且没指定 cluster 的客户端，缓存只在该客户端内，不导出）。
 * maxEntries：只导出最近写入的这么多条
 */
export function exportTokenMetaCache(maxEntries = Number.POSITIVE_INFINITY): TokenMetaSnapshot {
  const entries: TokenMetaSnapshot['entries'] = []
  for (const [key, meta] of tokenMetaCache) {
    if (SHARED_SCOPES.has(key.slice(0, key.indexOf(':')))) {
      entries.push([key, { ...meta }])
    }
  }
  return { version: 1, entries: entries.slice(Math.max(0, entries.length - maxEntries)) }
}

/** 导入 exportTokenMetaCache() 的结果；格式不对的条目跳过，内存里已有的条目不覆盖 */
export function importTokenMetaCache(snapshot: unknown): void {
  const entries = (snapshot as Partial<TokenMetaSnapshot> | null)?.entries
  if ((snapshot as Partial<TokenMetaSnapshot> | null)?.version !== 1 || !Array.isArray(entries)) {
    return
  }
  for (const entry of entries) {
    const meta = validMeta(entry)
    if (meta && !tokenMetaCache.has(entry[0])) {
      tokenMetaCache.set(entry[0], meta)
      if (tokenMetaCache.size > MAX_CACHED_TOKENS) {
        tokenMetaCache.delete(tokenMetaCache.keys().next().value as string)
      }
    }
  }
}

function validMeta(entry: unknown): CachedMeta | null {
  if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
    return null
  }
  const [key, raw] = entry as [string, Record<string, unknown>]
  const colon = key.indexOf(':')
  if (!SHARED_SCOPES.has(key.slice(0, colon)) || !isAddress(key.slice(colon + 1)) || !raw || typeof raw !== 'object') {
    return null
  }
  const meta: CachedMeta = {}
  if (typeof raw.decimals === 'number' && Number.isInteger(raw.decimals) && raw.decimals >= 0 && raw.decimals <= 255) meta.decimals = raw.decimals
  if (raw.tokenProgram === TOKEN_PROGRAM_ID || raw.tokenProgram === TOKEN_2022_PROGRAM_ID) meta.tokenProgram = raw.tokenProgram
  if (typeof raw.namesAt === 'number' && (typeof raw.name === 'string' || raw.name === null) && (typeof raw.symbol === 'string' || raw.symbol === null)) {
    meta.name = raw.name
    meta.symbol = raw.symbol
    meta.namesAt = raw.namesAt
  }
  return Object.keys(meta).length ? meta : null
}

export interface PersistTokenMetaOptions {
  /** 存储的键，默认 'w3lib:solana-token-meta' */
  key?: string
  /** 最多保存多少条（最近写入的优先），默认 5000 */
  maxEntries?: number
}

/**
 * 把代币信息缓存持久化到同步的键值存储（如 localStorage）：调用时读入，之后缓存有写入就防抖（约 1 秒）整体写回。
 * 返回停止函数（会立即写回还没写的变化）。读到格式不对的数据会丢弃；写入失败（如存储已满）忽略。
 *
 * ```ts
 * persistTokenMetaCache(localStorage) // 刷新页面后 decimals 不必重查
 * ```
 */
export function persistTokenMetaCache(
  store: { getItem(key: string): string | null; setItem(key: string, value: string): void },
  options: PersistTokenMetaOptions = {},
): () => void {
  const key = options.key ?? 'w3lib:solana-token-meta'
  const maxEntries = options.maxEntries ?? 5000
  try {
    const raw = store.getItem(key)
    if (raw) {
      importTokenMetaCache(JSON.parse(raw))
    }
  } catch {
    // 格式不对：丢弃
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const write = () => {
    timer = null
    try {
      store.setItem(key, JSON.stringify(exportTokenMetaCache(maxEntries)))
    } catch {
      // 存储已满等：忽略
    }
  }
  const onWrite = () => {
    if (!timer) {
      timer = setTimeout(write, 1000)
      ;(timer as { unref?: () => void }).unref?.()
    }
  }
  cacheWriteListeners.add(onWrite)
  return () => {
    cacheWriteListeners.delete(onWrite)
    if (timer) {
      clearTimeout(timer)
      write()
    }
  }
}

/** #loadMeta 没能补上 decimals 的原因；failed 为节点问题（tolerant 时） */
type MetaFailure = 'failed' | 'not-found' | 'not-token'

interface Holding {
  amount: bigint
  decimals: number
  program: string
  /** 代币账户数量 */
  accounts: number
}

interface ParsedTokenAccount {
  pubkey: string
  account: { owner: string; data: { parsed?: { info?: { mint?: string; owner?: string; tokenAmount?: { amount?: string; decimals?: number } } } } }
}

/**
 * Solana 批量读取客户端。
 *
 * ```ts
 * const sol = new SolanaClient()                                  // 内置公共节点（mainnet）
 * const sol = new SolanaClient('https://my-rpc.example')          // 自己的节点
 * const sol = new SolanaClient([connection, 'https://backup…'])   // web3.js Connection + 备用节点
 *
 * await sol.balances(owner, [NATIVE_MINT, USDC])
 * await sol.tokens([USDC, PYUSD], { fields: ['name', 'symbol', 'decimals', 'supply'] })
 * ```
 *
 * 同一 tick 内发起的 RPC 调用会合并成一个 JSON-RPC 批量请求；账户读取按 100 个一组用 getMultipleAccounts。
 */
/** ATA 模式下单个代币的查询计划（multiBalances 时多个钱包共用一次 getMultipleAccounts） */
type AtaItem =
  | { kind: 'native'; mint: string; owner: number }
  | { kind: 'invalid'; mint: string }
  | { kind: 'excluded'; mint: string }
  | { kind: 'token'; mint: string; mintIndex: number; metadataIndex: number; atas: Array<{ program: string; index: number }> }

export class SolanaClient {
  readonly transport: RpcTransport
  readonly #genesis: () => Promise<string>
  readonly #cluster: Cluster | undefined
  readonly #commitment: Commitment
  readonly #nativeMints: Set<string>
  readonly #scopeId: string

  constructor(provider?: RpcSource | readonly RpcSource[], config: ClientConfig = {}) {
    const resolved = resolveSource(provider, config.cluster ?? (provider === undefined ? 'mainnet' : undefined), config)
    this.transport = resolved.transport
    this.#genesis = resolved.genesis
    this.#cluster = config.cluster ?? (provider === undefined ? 'mainnet' : undefined)
    this.#commitment = config.commitment ?? 'confirmed'
    this.#nativeMints = new Set(config.nativeMints ?? [NATIVE_MINT, SYSTEM_PROGRAM_ID])
    // 网络已知时按网络共享缓存；未知（自定义节点且没指定 cluster）时缓存只在本客户端内使用，避免不同网络串数据
    this.#scopeId = this.#cluster ?? `client-${++clientIds}`
  }

  /** 节点所在网络（按创世区块哈希识别）；不是 mainnet / devnet / testnet 时为 null */
  async getCluster(): Promise<Cluster | null> {
    return this.#cluster ?? clusterOfGenesis(await this.#genesis())
  }

  /** 直接发 JSON-RPC 调用（同样参与自动合并与故障切换） */
  request<T = unknown>(method: string, params?: readonly unknown[], options: RequestOptions = {}): Promise<T> {
    return abortable(options.signal, () => this.transport.request<T>(method, params))
  }

  /**
   * 发一个读账户类的请求：params 最后一项是配置对象，传了 minContextSlot 时带上；
   * 节点高度不够（所有节点都落后）时每 500ms 重试，最多约 10 秒；记录返回的 context.slot（取最小值）
   */
  async #call<T>(ctx: QueryContext, method: string, params: unknown[]): Promise<T> {
    const last = params[params.length - 1]
    const sent =
      ctx.minContextSlot === undefined ? params : [...params.slice(0, -1), { ...(last as object), minContextSlot: ctx.minContextSlot }]
    const started = Date.now()
    for (;;) {
      try {
        const res = await this.transport.request<T>(method, sent)
        const slot = (res as { context?: { slot?: unknown } } | null)?.context?.slot
        if (typeof slot === 'number') {
          ctx.slot = ctx.slot === undefined ? slot : Math.min(ctx.slot, slot)
        }
        return res
      } catch (err) {
        if (ctx.minContextSlot === undefined || !isBehind(err) || Date.now() - started + BEHIND_RETRY_INTERVAL > BEHIND_RETRY_TIMEOUT) {
          throw err
        }
        await sleep(BEHIND_RETRY_INTERVAL, ctx.signal)
      }
    }
  }

  /** 结果项带上 slot（传了 withSlot / minContextSlot，且这次查询发了请求时） */
  #attachSlot<T extends object>(items: T[], ctx: QueryContext, options: SlotOptions): T[] {
    if ((!options.withSlot && options.minContextSlot === undefined) || ctx.slot === undefined) {
      return items
    }
    const slot = ctx.slot
    return items.map((item) => ({ ...item, slot }))
  }

  /**
   * 批量读取账户（getMultipleAccounts，按 100 个一组，去重），结果与 addresses 一一对应。
   * 账户不存在或地址非法时为 null。
   */
  accounts(addresses: readonly string[], options: AccountsOptions = {}): Promise<(AccountInfo | null)[]> {
    return abortable(options.signal, () => this.#accounts(addresses, { signal: options.signal, minContextSlot: options.minContextSlot }))
  }

  async #accounts(addresses: readonly string[], ctx: QueryContext): Promise<(AccountInfo | null)[]> {
    const fetched = await this.#fetchAccounts(addresses, false, ctx)
    return addresses.map((address) => (fetched.get(address) as AccountInfo | null | undefined) ?? null)
  }

  /**
   * getMultipleAccounts：去重、按 100 个一组，最多同时 3 组（避免大批量时触发节点限频）。
   * tolerant 为 true 时，某组因节点问题（网络、限频等）失败不抛错：该组标记为 FAILED，并且不再发后面的组（节点已经在限频了）。
   */
  async #fetchAccounts(addresses: readonly string[], tolerant: boolean, ctx: QueryContext): Promise<Map<string, AccountInfo | null | typeof FAILED>> {
    const unique = [...new Set(addresses.filter((a) => isAddress(a)))]
    const chunks: string[][] = []
    for (let i = 0; i < unique.length; i += MAX_ACCOUNTS_PER_REQUEST) {
      chunks.push(unique.slice(i, i + MAX_ACCOUNTS_PER_REQUEST))
    }
    const result = new Map<string, AccountInfo | null | typeof FAILED>()
    let aborted = false
    for (let i = 0; i < chunks.length; i += MAX_PARALLEL_ACCOUNT_REQUESTS) {
      const wave = chunks.slice(i, i + MAX_PARALLEL_ACCOUNT_REQUESTS)
      // 已取消的查询不再发后面的组
      if (ctx.signal?.aborted) {
        throw ctx.signal.reason
      }
      if (aborted) {
        wave.flat().forEach((address) => result.set(address, FAILED))
        continue
      }
      await Promise.all(
        wave.map(async (chunk) => {
          try {
            const res = await this.#call<{ value: Array<RawAccount | null> }>(ctx, 'getMultipleAccounts', [
              chunk,
              { encoding: 'base64', commitment: this.#commitment },
            ])
            chunk.forEach((address, j) => result.set(address, toAccountInfo(address, res?.value?.[j] ?? null)))
          } catch (err) {
            if (!tolerant || !isRecoverable(err)) {
              throw err
            }
            aborted = true
            chunk.forEach((address) => result.set(address, FAILED))
          }
        }),
      )
    }
    return result
  }

  /** 批量查多个地址的 SOL 余额（一次 getMultipleAccounts；账户不存在视为 0） */
  solBalances(addresses: readonly string[], options: SolBalancesOptions = {}): Promise<SolBalance[]> {
    return abortable(options.signal, async () => {
      const ctx = this.#context(options)
      const accounts = await this.#accounts(addresses, ctx)
      const list = addresses.map((address, i): SolBalance => {
        if (!isAddress(address)) {
          return { address, balance: '0', formatted: '0', success: false, error: 'invalid-address' }
        }
        const lamports = accounts[i]?.lamports ?? 0n
        return { address, balance: lamports.toString(), formatted: formatUnits(lamports, SOL_DECIMALS), success: true }
      })
      return this.#attachSlot(list, ctx, options)
    })
  }

  #context(options: RequestOptions & SlotOptions): QueryContext {
    return { signal: options.signal, minContextSlot: options.minContextSlot }
  }

  /**
   * 批量查余额（主币 SOL + SPL Token + Token-2022），返回原始余额、decimals 和换算后的数值。
   *
   * - 传 mints：本地推导 ATA，与主币账户、mint 账户一起用 getMultipleAccounts 一次读完，免费节点也能用
   * - 传 mints 且 accounts: 'all'：每个代币按 mint 过滤查 getTokenAccountsByOwner，统计全部代币账户（含非 ATA）
   * - 不传 mints（或 scan: true）：用 getTokenAccountsByOwner 扫描全部代币账户，返回所有余额大于 0 的代币
   * - 失败项（success: false）带 error：invalid-address（mint 地址非法）/ not-found（mint 不存在）/ not-token（不是代币 mint）
   * - tokenPrograms：只返回这些类型的代币，如 ['spl'] 不含 Token-2022（传了 mints 时，结果里去掉不符合的代币）
   * - minContextSlot / withSlot：要求节点高度、返回读取时的 slot，见 SlotOptions
   */
  balances(owner: string, mints?: readonly string[], options: BalancesOptions = {}): Promise<TokenBalance[]> {
    return abortable(options.signal, async () => {
      if (!isAddress(owner)) {
        throw new Error(`Invalid owner address: ${owner}`)
      }
      const ctx = this.#context(options)
      const list = await this.#balances(ctx, owner, mints, options, resolvePrograms(options.tokenPrograms))
      return this.#attachSlot(list, ctx, options)
    })
  }

  #balances(ctx: QueryContext, owner: string, mints: readonly string[] | undefined, options: BalancesOptions, programs: readonly string[]): Promise<TokenBalance[]> {
    const withSymbol = options.symbol ?? false
    if (mints === undefined || options.scan) {
      return this.#scanBalances(ctx, owner, mints, withSymbol, programs)
    }
    if (options.accounts === 'all') {
      return this.#mintAccountBalances(ctx, owner, mints, withSymbol, programs)
    }
    return this.#ataBalances(ctx, [{ owner, mints }], withSymbol, programs).then((lists) => lists[0] as TokenBalance[])
  }

  /**
   * 多个钱包一次查（如多钱包的持仓列表），结果与 queries 一一对应。
   * ATA 模式（默认）下所有钱包的账户合并成一次（按 100 个一组的）getMultipleAccounts；
   * scan / accounts: 'all' 时每个钱包各自查询（同一 tick 发出，合并成批量请求）。其他选项与 balances() 相同；
   * withSlot 时所有钱包的结果带同一个 slot（整次查询的最小值）。任一 owner 非法时报错
   *
   * ```ts
   * await sol.multiBalances([{ owner: a, mints: [NATIVE_MINT, USDC] }, { owner: b, mints: [USDC] }])
   * ```
   */
  multiBalances(queries: readonly BalanceQuery[], options: BalancesOptions = {}): Promise<TokenBalance[][]> {
    return abortable(options.signal, async () => {
      for (const { owner } of queries) {
        if (!isAddress(owner)) {
          throw new Error(`Invalid owner address: ${owner}`)
        }
      }
      const programs = resolvePrograms(options.tokenPrograms)
      const ctx = this.#context(options)
      const lists =
        options.scan || options.accounts === 'all'
          ? await Promise.all(queries.map(({ owner, mints }) => this.#balances(ctx, owner, mints, options, programs)))
          : await this.#ataBalances(ctx, queries, options.symbol ?? false, programs)
      return lists.map((list) => this.#attachSlot(list, ctx, options))
    })
  }

  /** ATA 模式：所有钱包的 主币账户 / mint / 元数据 / ATA 一起读，结果按钱包分组 */
  async #ataBalances(ctx: QueryContext, queries: readonly BalanceQuery[], withSymbol: boolean, allowed: readonly string[]): Promise<TokenBalance[][]> {
    const scope = this.#scope()
    const addresses: string[] = []
    const plans = queries.map(({ owner, mints }) => mints.map((mint) => this.#ataPlan(scope, owner, mint, withSymbol, allowed, addresses)))
    const accounts = addresses.length ? await this.#accounts(addresses, ctx) : []
    return plans.map((plan) => plan.flatMap((item) => this.#ataResult(scope, item, accounts, withSymbol, allowed)))
  }

  #ataPlan(scope: string, owner: string, mint: string, withSymbol: boolean, allowed: readonly string[], addresses: string[]): AtaItem {
    if (this.#nativeMints.has(mint)) {
      return { kind: 'native', mint, owner: addresses.push(owner) - 1 }
    }
    if (!isAddress(mint)) {
      return { kind: 'invalid', mint }
    }
    const meta = getMeta(scope, mint)
    if (isExcluded(meta.tokenProgram, allowed)) {
      return { kind: 'excluded', mint }
    }
    const needMint = meta.decimals === undefined || meta.tokenProgram === undefined || (withSymbol && meta.symbol === undefined)
    // 所属程序未知时只推导允许的程序的 ATA，读到 mint 账户后再确认
    const programs = meta.tokenProgram ? [meta.tokenProgram] : allowed
    return {
      kind: 'token',
      mint,
      mintIndex: needMint ? addresses.push(mint) - 1 : -1,
      metadataIndex: withSymbol && meta.symbol === undefined ? addresses.push(getMetadataAddress(mint)) - 1 : -1,
      atas: programs.map((program) => ({ program, index: addresses.push(getAssociatedTokenAddress(owner, mint, program)) - 1 })),
    }
  }

  #ataResult(scope: string, item: AtaItem, accounts: readonly (AccountInfo | null)[], withSymbol: boolean, allowed: readonly string[]): TokenBalance[] {
    if (item.kind === 'native') {
      const lamports = accounts[item.owner]?.lamports ?? 0n
      return [
        withSymbolField(
          { token: item.mint, native: true, balance: lamports.toString(), decimals: SOL_DECIMALS, formatted: formatUnits(lamports, SOL_DECIMALS), tokenProgram: null, success: true },
          withSymbol,
          'SOL',
        ),
      ]
    }
    if (item.kind === 'excluded') {
      return []
    }
    if (item.kind === 'invalid') {
      return [failedBalance(item.mint, 'invalid-address', null, withSymbol, null)]
    }
    const mintAccount = item.mintIndex === -1 ? null : (accounts[item.mintIndex] ?? null)
    const meta = this.#learn(
      scope,
      item.mint,
      mintAccount,
      item.metadataIndex === -1 ? null : (accounts[item.metadataIndex] ?? null),
      item.metadataIndex !== -1 && item.mintIndex !== -1,
    )
    // 代币账户由哪个程序持有就是哪个；mint 账户的 owner 也能确定程序
    let amount = 0n
    for (const ata of item.atas) {
      const account = accounts[ata.index]
      if (account && account.owner === ata.program) {
        try {
          amount = parseTokenAccount(account.data).amount
          if (meta.tokenProgram === undefined) {
            setMeta(scope, item.mint, { tokenProgram: ata.program })
            meta.tokenProgram = ata.program
          }
        } catch {
          // 不是代币账户
        }
      }
    }
    // 读到 mint 账户后才知道是不允许的程序
    if (isExcluded(meta.tokenProgram, allowed)) {
      return []
    }
    if (meta.decimals === undefined) {
      // decimals 未知时一定读了 mint 账户：不存在 / 存在但不是 mint
      return [failedBalance(item.mint, mintAccount ? 'not-token' : 'not-found', meta.tokenProgram ?? null, withSymbol, meta.symbol ?? null)]
    }
    return [
      withSymbolField(
        {
          token: item.mint,
          native: false,
          balance: amount.toString(),
          decimals: meta.decimals,
          formatted: formatUnits(amount, meta.decimals),
          tokenProgram: meta.tokenProgram ?? null,
          success: true,
        },
        withSymbol,
        meta.symbol ?? null,
      ),
    ]
  }

  /** 扫描持有人的 SOL 余额和全部代币账户（默认 Token + Token-2022，只请求 programs 里的程序），同一代币的多个账户合计 */
  async #scanHoldings(ctx: QueryContext, owner: string, programs: readonly string[] = TOKEN_PROGRAMS): Promise<{ sol: bigint; held: Map<string, Holding> }> {
    const scope = this.#scope()
    const [lamports, ...results] = await Promise.all([
      this.#call<{ value: number | string }>(ctx, 'getBalance', [owner, { commitment: this.#commitment }]),
      ...programs.map((programId) =>
        this.#call<{ value: ParsedTokenAccount[] }>(ctx, 'getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: this.#commitment }]),
      ),
    ])
    const held = new Map<string, Holding>()
    programs.forEach((program, i) => {
      for (const entry of results[i]?.value ?? []) {
        const info = entry.account?.data?.parsed?.info
        const mint = info?.mint
        const decimals = info?.tokenAmount?.decimals
        if (!mint || decimals === undefined) {
          continue
        }
        const prev = held.get(mint)
        const amount = BigInt(info?.tokenAmount?.amount ?? '0')
        held.set(mint, { amount: (prev?.amount ?? 0n) + amount, decimals, program, accounts: (prev?.accounts ?? 0) + 1 })
        setMeta(scope, mint, { decimals, tokenProgram: program })
      }
    })
    return { sol: BigInt(lamports.value), held }
  }

  /**
   * 列出持有人拥有的全部代币（SOL 在第一位），带 name / symbol，适合做资产列表。
   * 需要支持 getTokenAccountsByOwner 的节点（免费公共节点大多不支持）。
   *
   * - 默认不含 NFT（精度 0 且数量 1）和余额为 0 的代币账户（如已清空的 ATA），可用 includeNfts / includeZero 打开
   * - accounts 是该代币的代币账户数量；大于 1 时余额为所有账户的合计
   * - 顺序：SOL，然后 SPL Token 的代币，再然后 Token-2022 的代币（各自按节点返回的顺序；没有价格信息，不按价值排序）
   * - tokenPrograms: ['spl'] 时不含 Token-2022 代币
   * - withSlot 的 slot 只算余额扫描（元数据读取不计入）
   */
  ownerTokens(owner: string, options: OwnerTokensOptions = {}): Promise<OwnedToken[]> {
    return abortable(options.signal, async () => {
      if (!isAddress(owner)) {
        throw new Error(`Invalid owner address: ${owner}`)
      }
      const { metadata = true, includeNative = true, includeZero = false, includeNfts = false } = options
      const scope = this.#scope()
      const ctx = this.#context(options)
      const { sol, held } = await this.#scanHoldings(ctx, owner, resolvePrograms(options.tokenPrograms))
      const scanSlot = ctx.slot
      // Wrapped SOL 是独立的代币账户（需要 unwrap 才是 SOL），资产列表里单独列出（native: false）
      const tokens = [...held].filter(([, h]) => (includeZero || h.amount > 0n) && (includeNfts || !isNftHolding(h)))
      // 元数据不受 minContextSlot 约束（不会因为刚成交而变化）
      const failures = metadata ? await this.#loadMeta({ signal: options.signal }, scope, tokens.map(([mint]) => mint), true, true) : new Map<string, MetaFailure>()

      const list: OwnedToken[] = tokens.map(([mint, h]) => {
        const item: OwnedToken = {
          token: mint,
          native: false,
          balance: h.amount.toString(),
          decimals: h.decimals,
          formatted: formatUnits(h.amount, h.decimals),
          tokenProgram: h.program,
          accounts: h.accounts,
          success: true,
        }
        if (!metadata) {
          return item
        }
        const meta = getMeta(scope, mint)
        const status = failures.get(mint) === 'failed' ? 'failed' : meta.name == null && meta.symbol == null ? 'missing' : 'ok'
        return { ...item, name: meta.name ?? null, symbol: meta.symbol ?? null, metadataStatus: status }
      })
      if (includeNative) {
        const sol_: OwnedToken = { token: NATIVE_MINT, native: true, balance: sol.toString(), decimals: SOL_DECIMALS, formatted: formatUnits(sol, SOL_DECIMALS), tokenProgram: null, accounts: 1, success: true }
        list.unshift(metadata ? { ...sol_, name: 'Solana', symbol: 'SOL', metadataStatus: 'ok' } : sol_)
      }
      return this.#attachSlot(list, { slot: scanSlot }, options)
    })
  }

  async #scanBalances(ctx: QueryContext, owner: string, mints: readonly string[] | undefined, withSymbol: boolean, allowed: readonly string[]): Promise<TokenBalance[]> {
    const scope = this.#scope()
    // held 里只有允许的程序的代币
    const { sol, held } = await this.#scanHoldings(ctx, owner, allowed)

    // Wrapped SOL（So111…112）默认按原生 SOL 处理：余额列表里只有一项 SOL，不再列出 wSOL 代币账户
    // 第一项是主币：用 nativeMints 里的地址（nativeMints 不含 So111…112 时 wSOL 作为普通代币列出，不能再拿它当 SOL）
    const nativeLead = this.#nativeMints.has(NATIVE_MINT) ? NATIVE_MINT : this.#nativeMints.values().next().value
    const targets = mints ?? [
      ...(nativeLead === undefined ? [] : [nativeLead]),
      ...[...held].filter(([mint, h]) => h.amount > 0n && !this.#nativeMints.has(mint)).map(([mint]) => mint),
    ]
    // 没持有的代币（拿不到 decimals）和缺 symbol 的代币：只读 mint / 元数据账户补上，不需要 ATA
    const failures = await this.#loadMeta(
      ctx,
      scope,
      targets.filter((mint) => !this.#nativeMints.has(mint) && isAddress(mint)),
      withSymbol,
    )

    return targets.flatMap((mint): TokenBalance[] => {
      if (this.#nativeMints.has(mint)) {
        return [
          withSymbolField(
            { token: mint, native: true, balance: sol.toString(), decimals: SOL_DECIMALS, formatted: formatUnits(sol, SOL_DECIMALS), tokenProgram: null, success: true },
            withSymbol,
            'SOL',
          ),
        ]
      }
      return this.#heldBalance(scope, mint, held.get(mint), failures, withSymbol, allowed)
    })
  }

  /**
   * 指定 mints、统计全部代币账户：每个代币一次按 mint 过滤的 getTokenAccountsByOwner（同一 tick 发出，自动合并）。
   * mint 不存在 / 不是代币时节点返回参数错误，按“没持有”处理，再由 #loadMeta 确认原因
   */
  async #mintAccountBalances(ctx: QueryContext, owner: string, mints: readonly string[], withSymbol: boolean, allowed: readonly string[]): Promise<TokenBalance[]> {
    const scope = this.#scope()
    const queried = [...new Set(mints.filter((mint) => !this.#nativeMints.has(mint) && isAddress(mint) && !isExcluded(getMeta(scope, mint).tokenProgram, allowed)))]
    const [lamports, ...results] = await Promise.all([
      mints.some((mint) => this.#nativeMints.has(mint))
        ? this.#call<{ value: number | string }>(ctx, 'getBalance', [owner, { commitment: this.#commitment }])
        : Promise.resolve(null),
      ...queried.map((mint) =>
        this.#call<{ value: ParsedTokenAccount[] }>(ctx, 'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: this.#commitment }]).catch(
          (err: unknown) => {
            // "Invalid param: could not find mint" 等参数错误：mint 不存在或不是代币；节点问题照常抛出
            if (err instanceof RpcError && !err.nodeFault && err.code === -32602) return null
            throw err
          },
        ),
      ),
    ])
    const held = new Map<string, Holding>()
    queried.forEach((mint, i) => {
      for (const entry of results[i]?.value ?? []) {
        const decimals = entry.account?.data?.parsed?.info?.tokenAmount?.decimals
        const program = entry.account?.owner
        if (decimals === undefined || !program) {
          continue
        }
        const prev = held.get(mint)
        const amount = BigInt(entry.account.data.parsed?.info?.tokenAmount?.amount ?? '0')
        held.set(mint, { amount: (prev?.amount ?? 0n) + amount, decimals, program, accounts: (prev?.accounts ?? 0) + 1 })
        setMeta(scope, mint, { decimals, tokenProgram: program })
      }
    })
    // 没持有的代币补 decimals（同时确认 mint 是否存在），需要时补 symbol
    const failures = await this.#loadMeta(ctx, scope, queried, withSymbol)
    const sol = BigInt(lamports?.value ?? 0)

    return mints.flatMap((mint): TokenBalance[] => {
      if (this.#nativeMints.has(mint)) {
        return [
          withSymbolField(
            { token: mint, native: true, balance: sol.toString(), decimals: SOL_DECIMALS, formatted: formatUnits(sol, SOL_DECIMALS), tokenProgram: null, success: true },
            withSymbol,
            'SOL',
          ),
        ]
      }
      return this.#heldBalance(scope, mint, held.get(mint), failures, withSymbol, allowed)
    })
  }

  /** 扫描类查询（scan / accounts: 'all'）里单个代币的结果；不允许的程序返回空数组 */
  #heldBalance(scope: string, mint: string, h: Holding | undefined, failures: Map<string, MetaFailure>, withSymbol: boolean, allowed: readonly string[]): TokenBalance[] {
    if (!isAddress(mint)) {
      return [failedBalance(mint, 'invalid-address', null, withSymbol, null)]
    }
    const meta = getMeta(scope, mint)
    if (!h) {
      // 没持有（或属于不允许的程序）：余额为 0；decimals 来自 mint 账户
      if (isExcluded(meta.tokenProgram, allowed)) {
        return []
      }
      if (meta.decimals === undefined) {
        const failure = failures.get(mint)
        return [failedBalance(mint, failure === 'not-token' ? 'not-token' : 'not-found', meta.tokenProgram ?? null, withSymbol, meta.symbol ?? null)]
      }
      return [withSymbolField({ token: mint, native: false, balance: '0', decimals: meta.decimals, formatted: '0', tokenProgram: meta.tokenProgram ?? null, success: true }, withSymbol, meta.symbol ?? null)]
    }
    if (isExcluded(h.program, allowed)) {
      return []
    }
    return [
      withSymbolField(
        { token: mint, native: false, balance: h.amount.toString(), decimals: h.decimals, formatted: formatUnits(h.amount, h.decimals), tokenProgram: h.program, success: true },
        withSymbol,
        meta.symbol ?? null,
      ),
    ]
  }

  /**
   * 补齐 decimals / 所属程序（以及需要时的 symbol / name）：只读缺的 mint 账户和元数据账户。
   * 返回没能补上 decimals 的 mint 及原因：failed（tolerant 为 true 时的节点问题，信息保持未知、不写缓存）、not-found、not-token
   */
  async #loadMeta(ctx: QueryContext, scope: string, mints: readonly string[], withSymbol: boolean, tolerant = false): Promise<Map<string, MetaFailure>> {
    const plan = [...new Set(mints)].flatMap((mint) => {
      const meta = getMeta(scope, mint)
      const needSymbol = withSymbol && meta.symbol === undefined
      if (meta.decimals !== undefined && meta.tokenProgram !== undefined && !needSymbol) {
        return []
      }
      return [{ mint, metadata: needSymbol ? getMetadataAddress(mint) : null }]
    })
    const failures = new Map<string, MetaFailure>()
    if (!plan.length) {
      return failures
    }
    const fetched = await this.#fetchAccounts(
      plan.flatMap(({ mint, metadata }) => (metadata ? [mint, metadata] : [mint])),
      tolerant,
      ctx,
    )
    for (const { mint, metadata } of plan) {
      const mintAccount = fetched.get(mint)
      const metadataAccount = metadata ? fetched.get(metadata) : null
      // mint 和元数据账户可能落在不同的请求里：任一个没读到都算失败，不能当成“没有元数据”缓存
      if (mintAccount === FAILED || metadataAccount === FAILED) {
        failures.set(mint, 'failed')
        continue
      }
      if (this.#learn(scope, mint, mintAccount ?? null, metadataAccount ?? null, metadata !== null).decimals === undefined) {
        failures.set(mint, mintAccount ? 'not-token' : 'not-found')
      }
    }
    return failures
  }

  /**
   * 批量查代币详情（一次 getMultipleAccounts），可以选择返回哪些字段。
   * name / symbol / uri 优先取 Token-2022 TokenMetadata 扩展，其次 Metaplex 元数据。
   * transferFee：Token-2022 转账手续费，请求时会顺带发一次 getEpochInfo（同一个批量请求里）选出当前生效的配置
   */
  tokens<const F extends TokenField = DefaultTokenField>(mints: readonly string[], options: TokensOptions<F> = {}): Promise<TokenDetails<F>[]> {
    return abortable(options.signal, () => this.#tokens<F>(mints, options))
  }

  async #tokens<F extends TokenField>(mints: readonly string[], options: TokensOptions<F>): Promise<TokenDetails<F>[]> {
    const fields = (options.fields ?? DEFAULT_TOKEN_FIELDS) as readonly F[]
    const wanted = new Set<TokenField>(fields)
    const scope = this.#scope()
    const ctx: QueryContext = { signal: options.signal }
    const needsNames = wanted.has('name') || wanted.has('symbol') || wanted.has('uri')
    const addresses: string[] = []
    const plan = mints.map((mint) => {
      if (this.#nativeMints.has(mint) || !isAddress(mint)) {
        return { mint, mintIndex: -1, metadataIndex: -1 }
      }
      const meta = getMeta(scope, mint)
      // uri / supply / 权限 / 手续费不缓存，需要时总要读 mint；name / symbol 命中缓存时可以省掉元数据账户
      const cachedOnly =
        !wanted.has('uri') &&
        !wanted.has('supply') &&
        !wanted.has('mintAuthority') &&
        !wanted.has('freezeAuthority') &&
        !wanted.has('transferFee') &&
        (!wanted.has('decimals') || meta.decimals !== undefined) &&
        (!wanted.has('tokenProgram') || meta.tokenProgram !== undefined) &&
        (!wanted.has('name') || meta.name !== undefined) &&
        (!wanted.has('symbol') || meta.symbol !== undefined)
      if (cachedOnly) {
        return { mint, mintIndex: -1, metadataIndex: -1 }
      }
      const namesCached = (!wanted.has('name') || meta.name !== undefined) && (!wanted.has('symbol') || meta.symbol !== undefined) && !wanted.has('uri')
      return {
        mint,
        mintIndex: addresses.push(mint) - 1,
        metadataIndex: needsNames && !namesCached ? addresses.push(getMetadataAddress(mint)) - 1 : -1,
      }
    })
    const [accounts, epoch] = await Promise.all([
      addresses.length ? this.#accounts(addresses, ctx) : Promise.resolve([] as (AccountInfo | null)[]),
      // 手续费按当前 epoch 选新 / 旧配置；和账户读取在同一个批量请求里
      wanted.has('transferFee') && addresses.length
        ? this.#call<{ epoch: number | string }>(ctx, 'getEpochInfo', [{ commitment: this.#commitment }]).then((res) => BigInt(res.epoch))
        : Promise.resolve(null),
    ])

    return plan.map(({ mint, mintIndex, metadataIndex }) => {
      const native = this.#nativeMints.has(mint)
      const values: Record<TokenField, unknown> & { exists: boolean } = native
        ? { exists: true, name: 'Solana', symbol: 'SOL', uri: null, decimals: SOL_DECIMALS, supply: null, tokenProgram: null, mintAuthority: null, freezeAuthority: null, transferFee: null }
        : this.#tokenValues(
            scope,
            mint,
            mintIndex === -1 ? null : (accounts[mintIndex] ?? null),
            metadataIndex === -1 ? null : (accounts[metadataIndex] ?? null),
            mintIndex !== -1,
            mintIndex !== -1 && metadataIndex !== -1,
            epoch,
          )
      const out: Record<string, unknown> = { address: mint, native }
      let missing: F | undefined
      for (const field of fields) {
        out[field] = values[field] ?? null
        // 权限为 null 表示没有权限、手续费为 null 表示没有手续费，都是有效值；主币没有 uri / supply / tokenProgram
        const nullable =
          field === 'mintAuthority' || field === 'freezeAuthority' || field === 'transferFee' || (native && (field === 'uri' || field === 'supply' || field === 'tokenProgram'))
        if (out[field] === null && !nullable) {
          missing ??= field
        }
      }
      if (wanted.has('supply')) {
        const supply = values.supply as string | null
        const decimals = values.decimals as number | null
        out.supplyFormatted = supply === null || decimals === null ? null : formatUnits(BigInt(supply), decimals)
      }
      const error: FailureReason | undefined = native
        ? undefined
        : !isAddress(mint)
          ? 'invalid-address'
          : !values.exists
            ? accounts[mintIndex]
              ? 'not-token'
              : 'not-found'
            : missing
              ? 'missing-field'
              : undefined
      out.success = error === undefined
      if (error) {
        out.error = error
        if (error === 'missing-field') {
          out.errorField = missing
        }
      }
      return out as TokenDetails<F>
    })
  }

  #tokenValues(
    scope: string,
    mint: string,
    mintAccount: AccountInfo | null,
    metadataAccount: AccountInfo | null,
    fetchedMint: boolean,
    lookedForNames: boolean,
    epoch: bigint | null,
  ): Record<TokenField, unknown> & { exists: boolean } {
    const meta = this.#learn(scope, mint, mintAccount, metadataAccount, lookedForNames)
    const info = mintAccount ? safeParseMint(mintAccount) : null
    const uri = info?.metadata?.uri ?? (metadataAccount ? (safeParseMetaplex(metadataAccount)?.uri ?? null) : null)
    const feeConfig = info && mintAccount?.owner === TOKEN_2022_PROGRAM_ID ? parseTransferFeeConfig(mintAccount.data) : null
    return {
      // 读了 mint 账户就以它为准（不存在则 false）；没读说明请求的字段全部命中缓存
      exists: fetchedMint ? info !== null : true,
      name: meta.name ?? null,
      symbol: meta.symbol ?? null,
      uri,
      decimals: meta.decimals ?? null,
      supply: info ? info.supply.toString() : null,
      tokenProgram: meta.tokenProgram ?? null,
      mintAuthority: info?.mintAuthority ?? null,
      freezeAuthority: info?.freezeAuthority ?? null,
      transferFee: feeConfig ? toTransferFeeConfig(feeConfig.older, feeConfig.newer, epoch) : null,
    }
  }

  /** 批量查 NFT 元数据（Metaplex；Token-2022 NFT 取 TokenMetadata 扩展），一次 getMultipleAccounts */
  nfts(mints: readonly string[], options: RequestOptions = {}): Promise<NftDetails[]> {
    return abortable(options.signal, async () => {
      const scope = this.#scope()
      const addresses: string[] = []
      const plan = mints.map((mint) =>
        isAddress(mint) ? { mint, metadataIndex: addresses.push(getMetadataAddress(mint)) - 1, mintIndex: addresses.push(mint) - 1 } : { mint, metadataIndex: -1, mintIndex: -1 },
      )
      const accounts = addresses.length ? await this.#accounts(addresses, { signal: options.signal }) : []
      return plan.map(({ mint, metadataIndex, mintIndex }): NftDetails => {
        const metadataAccount = metadataIndex === -1 ? null : (accounts[metadataIndex] ?? null)
        const mintAccount = mintIndex === -1 ? null : (accounts[mintIndex] ?? null)
        this.#learn(scope, mint, mintAccount, metadataAccount, mintIndex !== -1)
        const metaplex = metadataAccount ? safeParseMetaplex(metadataAccount) : null
        const ext = mintAccount ? (safeParseMint(mintAccount)?.metadata ?? null) : null
        if (!metaplex && !ext) {
          const error: FailureReason = mintIndex === -1 ? 'invalid-address' : !mintAccount ? 'not-found' : !safeParseMint(mintAccount) ? 'not-token' : 'no-metadata'
          return { mint, name: null, symbol: null, uri: null, collection: null, creators: [], sellerFeeBasisPoints: null, tokenStandard: null, isMutable: null, updateAuthority: null, success: false, error }
        }
        return {
          mint,
          name: ext?.name ?? metaplex?.name ?? null,
          symbol: ext?.symbol ?? metaplex?.symbol ?? null,
          uri: ext?.uri ?? metaplex?.uri ?? null,
          collection: metaplex?.collection ?? null,
          creators: metaplex?.creators ?? [],
          sellerFeeBasisPoints: metaplex?.sellerFeeBasisPoints ?? null,
          tokenStandard: metaplex?.tokenStandard == null ? null : (TOKEN_STANDARDS[metaplex.tokenStandard] ?? null),
          isMutable: metaplex?.isMutable ?? null,
          updateAuthority: metaplex?.updateAuthority ?? null,
          success: true,
        }
      })
    })
  }

  /**
   * 批量查 NFT 持有人：getTokenLargestAccounts（合并成一个批量请求）+ 一次 getMultipleAccounts。
   * 节点拒绝的 mint（不存在 / 不是代币）在同一次 getMultipleAccounts 里读 mint 账户区分原因
   */
  nftOwners(mints: readonly string[], options: RequestOptions = {}): Promise<NftOwner[]> {
    return abortable(options.signal, async () => {
      const ctx: QueryContext = { signal: options.signal }
      const largest = await Promise.all(
        mints.map((mint): Promise<{ tokenAccount: string | null; rejected: boolean }> =>
          isAddress(mint)
            ? this.#call<{ value: Array<{ address: string; amount: string }> }>(ctx, 'getTokenLargestAccounts', [mint, { commitment: this.#commitment }])
                .then((res) => ({ tokenAccount: res.value.find((a) => a.amount !== '0')?.address ?? null, rejected: false }))
                .catch((err: unknown) => {
                  // mint 不存在 / 不是代币：该项失败；节点问题照常抛出
                  if (err instanceof RpcError && !err.nodeFault) return { tokenAccount: null, rejected: true }
                  throw err
                })
            : Promise.resolve({ tokenAccount: null, rejected: false }),
        ),
      )
      const toRead = largest.flatMap(({ tokenAccount, rejected }, i) => (tokenAccount ? [tokenAccount] : rejected ? [mints[i] as string] : []))
      const accounts = toRead.length ? await this.#accounts(toRead, ctx) : []
      const byAddress = new Map(toRead.map((a, i) => [a, accounts[i] ?? null]))
      return mints.map((mint, i): NftOwner => {
        const { tokenAccount, rejected } = largest[i] ?? { tokenAccount: null, rejected: false }
        if (!isAddress(mint)) {
          return { mint, owner: null, tokenAccount: null, success: false, error: 'invalid-address' }
        }
        if (rejected) {
          return { mint, owner: null, tokenAccount: null, success: false, error: byAddress.get(mint) ? 'not-token' : 'not-found' }
        }
        const account = tokenAccount ? byAddress.get(tokenAccount) : null
        let owner: string | null = null
        if (account) {
          try {
            owner = parseTokenAccount(account.data).owner
          } catch {
            owner = null
          }
        }
        // 没有余额大于 0 的代币账户（供应量为 0 / 已销毁），或代币账户刚被关闭
        return owner ? { mint, owner, tokenAccount, success: true } : { mint, owner: null, tokenAccount: null, success: false, error: 'no-holder' }
      })
    })
  }

  /** 查某地址持有的全部 NFT（扫描代币账户：数量 1、精度 0），再批量读元数据。需要支持 getTokenAccountsByOwner 的节点 */
  ownerNfts(owner: string, options: RequestOptions = {}): Promise<NftDetails[]> {
    return abortable(options.signal, async () => {
      if (!isAddress(owner)) {
        throw new Error(`Invalid owner address: ${owner}`)
      }
      const { held } = await this.#scanHoldings({ signal: options.signal }, owner)
      const mints = [...held].filter(([, h]) => isNftHolding(h)).map(([mint]) => mint)
      return mints.length ? (await this.nfts(mints, options)).filter((nft) => nft.success) : []
    })
  }

  #scope(): string {
    return this.#scopeId
  }

  /**
   * 从 mint 账户 / 元数据账户里学到的信息写入缓存，返回合并后的结果。
   * lookedForNames：本次同时读了 mint 和元数据账户，都没有 name / symbol 时记为“确认没有”（null），之后不再重查
   */
  #learn(scope: string, mint: string, mintAccount: AccountInfo | null, metadataAccount: AccountInfo | null, lookedForNames = false): TokenMeta {
    const update: TokenMeta = {}
    const info = mintAccount ? safeParseMint(mintAccount) : null
    if (info && mintAccount) {
      update.decimals = info.decimals
      update.tokenProgram = mintAccount.owner
      if (info.metadata) {
        update.name = info.metadata.name
        update.symbol = info.metadata.symbol
      }
    }
    if (metadataAccount && update.name === undefined) {
      const metaplex = safeParseMetaplex(metadataAccount)
      if (metaplex) {
        update.name = metaplex.name
        update.symbol = metaplex.symbol
      }
    }
    if (lookedForNames && info && update.name === undefined) {
      update.name = null
      update.symbol = null
    }
    setMeta(scope, mint, update)
    return getMeta(scope, mint)
  }
}

function toTransferFee(fee: TransferFeeInfo): TransferFee {
  return { basisPoints: fee.basisPoints, maximumFee: fee.maximumFee.toString(), epoch: fee.epoch.toString() }
}

/** 当前生效的配置：epoch >= newer.epoch 用 newer，否则 older；不知道当前 epoch 时按 newer */
function toTransferFeeConfig(older: TransferFeeInfo, newer: TransferFeeInfo, epoch: bigint | null): TransferFeeConfig {
  const current = epoch === null || epoch >= newer.epoch ? newer : older
  return { ...toTransferFee(current), older: toTransferFee(older), newer: toTransferFee(newer) }
}

interface RawAccount {
  lamports: number | string
  owner: string
  data: [string, string] | string
  executable: boolean
}

function toAccountInfo(address: string, raw: RawAccount | null): AccountInfo | null {
  if (!raw) {
    return null
  }
  const encoded = Array.isArray(raw.data) ? raw.data[0] : raw.data
  return {
    address,
    lamports: BigInt(raw.lamports),
    owner: raw.owner,
    data: base64.decode(encoded),
    executable: raw.executable,
  }
}

function safeParseMint(account: AccountInfo): MintInfo | null {
  if (account.owner !== TOKEN_PROGRAM_ID && account.owner !== TOKEN_2022_PROGRAM_ID) {
    return null
  }
  try {
    return parseMint(account.data)
  } catch {
    return null
  }
}

function safeParseMetaplex(account: AccountInfo): MetaplexMetadata | null {
  try {
    return parseMetaplexMetadata(account.data)
  } catch {
    return null
  }
}

function getMeta(scope: string, mint: string): TokenMeta {
  const cached = tokenMetaCache.get(`${scope}:${mint}`)
  if (!cached) {
    return {}
  }
  const { namesAt, ...meta } = cached
  if (namesAt === undefined || Date.now() - namesAt > NAME_TTL) {
    delete meta.name
    delete meta.symbol
  }
  return meta
}

function setMeta(scope: string, mint: string, meta: TokenMeta): void {
  const defined: CachedMeta = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined))
  if (Object.keys(defined).length === 0) {
    return
  }
  if ('name' in defined || 'symbol' in defined) {
    defined.namesAt = Date.now()
  }
  const key = `${scope}:${mint}`
  const merged = { ...tokenMetaCache.get(key), ...defined }
  tokenMetaCache.delete(key) // 重新插入，保持“最近写入在后”的顺序
  tokenMetaCache.set(key, merged)
  if (tokenMetaCache.size > MAX_CACHED_TOKENS) {
    tokenMetaCache.delete(tokenMetaCache.keys().next().value as string)
  }
  for (const listener of cacheWriteListeners) {
    listener()
  }
}

function withSymbolField(balance: TokenBalance, withSymbol: boolean, symbol: string | null): TokenBalance {
  return withSymbol ? { ...balance, symbol } : balance
}

/** 失败项：余额为 0，带原因 */
function failedBalance(token: string, error: FailureReason, tokenProgram: string | null, withSymbol: boolean, symbol: string | null): TokenBalance {
  return { ...withSymbolField({ token, native: false, balance: '0', decimals: 0, formatted: '0', tokenProgram, success: false }, withSymbol, symbol), error }
}
