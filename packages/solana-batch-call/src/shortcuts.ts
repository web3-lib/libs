import {
  SolanaClient,
  type BalanceQuery,
  type BalancesOptions,
  type ClientConfig,
  type OwnerTokensOptions,
  type RequestOptions,
  type SolBalancesOptions,
  type TokensOptions,
} from './client.js'
import type { RpcSource } from './source.js'
import type { DefaultTokenField, NftDetails, NftOwner, OwnedToken, SolBalance, TokenBalance, TokenDetails, TokenField } from './types.js'

/** 各函数共用的节点参数 */
export interface ShortcutOptions extends ClientConfig {
  /**
   * 节点：RPC URL、URL 数组（主节点 + 备用节点）、web3.js Connection、自定义传输（request(method, params)）。
   * 不传则使用 cluster（默认 mainnet）的内置公共节点
   */
  provider?: RpcSource | readonly RpcSource[]
}

// 复用客户端：多次调用共享连接、批量合并与故障切换状态。按 “配置内容” 分组，组内 URL 按字符串、对象按引用（WeakMap）。
// 配置里有函数（如自定义 fetch）或节点数组含对象时不缓存。
const MAX_CACHED = 32

interface ClientGroup {
  byString: Map<string, SolanaClient>
  byObject: WeakMap<object, SolanaClient>
}

const clientCache = new Map<string, ClientGroup>()

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value)
  if (map.size > MAX_CACHED) {
    map.delete(map.keys().next().value as K)
  }
}

// 配置里的函数（如自定义 fetch）按对象编号参与缓存键：同一个函数对象复用同一个客户端（WeakMap 不阻止回收）
const functionIds = new WeakMap<object, number>()
let nextFunctionId = 0

/** 配置的缓存键：对象的键按字母排序（写法顺序不同视为同一份配置），函数按对象编号；无法序列化时返回 null（不缓存） */
function configKey(config: ClientConfig): string | null {
  try {
    return JSON.stringify(config, (_key, value: unknown) => {
      if (typeof value === 'function') {
        let id = functionIds.get(value)
        if (id === undefined) {
          id = ++nextFunctionId
          functionIds.set(value, id)
        }
        return `function#${id}`
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      }
      return value
    })
  } catch {
    return null
  }
}

function sourceKey(source: ShortcutOptions['provider']): string | object | null {
  if (source === undefined) {
    return 'default'
  }
  if (typeof source === 'string') {
    return `url:${source}`
  }
  if (Array.isArray(source)) {
    return source.every((item) => typeof item === 'string') ? `urls:${source.join('\n')}` : null
  }
  return source as object
}

/**
 * 拆出节点参数和函数自己的参数（ownKeys），其余作为客户端配置；值为 undefined 的参数忽略。
 * signal 总是作为函数自己的参数（放进客户端配置会让每次调用都新建客户端）
 */
function resolve<T extends ShortcutOptions, K extends keyof T & string = never>(
  options: T,
  ownKeys: readonly K[] = [],
): { client: SolanaClient; own: Pick<T, K> } {
  const { provider, ...others } = options
  const own: Record<string, unknown> = {}
  const config: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(others)) {
    if (value !== undefined) {
      ;((ownKeys as readonly string[]).includes(key) ? own : key === 'signal' ? {} : config)[key] = value
    }
  }
  return { client: getClient(provider, config as ClientConfig), own: own as Pick<T, K> }
}

function getClient(source: ShortcutOptions['provider'], config: ClientConfig): SolanaClient {
  const cfg = configKey(config)
  const key = sourceKey(source)
  if (cfg === null || key === null) {
    return new SolanaClient(source, config)
  }
  let group = clientCache.get(cfg)
  if (!group) {
    group = { byString: new Map(), byObject: new WeakMap() }
    setBounded(clientCache, cfg, group)
  }
  let client = typeof key === 'string' ? group.byString.get(key) : group.byObject.get(key)
  if (!client) {
    client = new SolanaClient(source, config)
    if (typeof key === 'string') {
      setBounded(group.byString, key, client)
    } else {
      group.byObject.set(key, client)
    }
  }
  return client
}

export interface GetBalancesOptions extends BalancesOptions, ShortcutOptions {}

/**
 * 批量查余额（SOL + SPL Token + Token-2022），返回原始余额、decimals 和换算后的数值。
 *
 * ```ts
 * import { NATIVE_MINT, getBalances } from '@w3lib/solana-batch-call'
 *
 * await getBalances(owner, [NATIVE_MINT, USDC])                        // 指定代币：免费公共节点也能用
 * await getBalances(owner, [NATIVE_MINT, USDC], { symbol: true })
 * await getBalances(owner, undefined, { tokenPrograms: ['spl'] })            // 不含 Token-2022 代币
 * await getBalances(owner, [USDC], { accounts: 'all' })                      // 算上非 ATA 账户：需要支持 getTokenAccountsByOwner 的节点
 * await getBalances(owner, undefined, { provider: 'https://my-rpc…' })  // 全部持仓：需要支持 getTokenAccountsByOwner 的节点
 * ```
 */
export function getBalances(owner: string, mints?: readonly string[], options: GetBalancesOptions = {}): Promise<TokenBalance[]> {
  const { client, own } = resolve(options, BALANCE_KEYS)
  return client.balances(owner, mints, own)
}

const BALANCE_KEYS = ['symbol', 'scan', 'accounts', 'tokenPrograms', 'signal', 'minContextSlot', 'withSlot'] as const

/**
 * 多个钱包一次查，结果与 queries 一一对应；ATA 模式下所有钱包合并成一次 getMultipleAccounts。参数同 getBalances。
 *
 * ```ts
 * await getMultiBalances([{ owner: a, mints: [NATIVE_MINT, USDC] }, { owner: b, mints: [USDC] }])
 * ```
 */
export function getMultiBalances(queries: readonly BalanceQuery[], options: GetBalancesOptions = {}): Promise<TokenBalance[][]> {
  const { client, own } = resolve(options, BALANCE_KEYS)
  return client.multiBalances(queries, own)
}

export interface GetSolBalancesOptions extends SolBalancesOptions, ShortcutOptions {}

/** 批量查多个地址的 SOL 余额（一次 getMultipleAccounts） */
export function getSolBalances(addresses: readonly string[], options: GetSolBalancesOptions = {}): Promise<SolBalance[]> {
  const { client, own } = resolve(options, ['signal', 'minContextSlot', 'withSlot'])
  return client.solBalances(addresses, own)
}

export interface GetTokensOptions<F extends TokenField = DefaultTokenField> extends TokensOptions<F>, ShortcutOptions {}

/**
 * 批量查代币详情，字段可选（默认 name / symbol / decimals）。
 *
 * ```ts
 * await getTokens([USDC, PYUSD], { fields: ['name', 'symbol', 'decimals', 'supply', 'tokenProgram'] })
 * ```
 */
export function getTokens<const F extends TokenField = DefaultTokenField>(mints: readonly string[], options: GetTokensOptions<F> = {}): Promise<TokenDetails<F>[]> {
  const { client, own } = resolve(options, ['fields', 'signal'])
  return client.tokens<F>(mints, own)
}

export interface GetNftsOptions extends RequestOptions, ShortcutOptions {}

/** 批量查 NFT 元数据（名称、uri、所属集合、版税、创作者等） */
export function getNfts(mints: readonly string[], options: GetNftsOptions = {}): Promise<NftDetails[]> {
  const { client, own } = resolve(options, ['signal'])
  return client.nfts(mints, own)
}

/** 批量查 NFT 持有人 */
export function getNftOwners(mints: readonly string[], options: GetNftsOptions = {}): Promise<NftOwner[]> {
  const { client, own } = resolve(options, ['signal'])
  return client.nftOwners(mints, own)
}

/** 查某地址持有的全部 NFT（需要支持 getTokenAccountsByOwner 的节点） */
export function getOwnerNfts(owner: string, options: GetNftsOptions = {}): Promise<NftDetails[]> {
  const { client, own } = resolve(options, ['signal'])
  return client.ownerNfts(owner, own)
}

export interface GetOwnerTokensOptions extends OwnerTokensOptions, ShortcutOptions {}

/**
 * 列出持有人拥有的全部代币（SOL 在第一位），带 name / symbol，适合做资产列表。
 * 需要支持 getTokenAccountsByOwner 的节点。
 *
 * ```ts
 * await getOwnerTokens(owner, { provider: 'https://my-rpc…' })
 * // [{ token: NATIVE_MINT, native: true, name: 'Solana', symbol: 'SOL', formatted: '1.5', … }, { token: USDC, name: 'USD Coin', … }]
 * ```
 */
export function getOwnerTokens(owner: string, options: GetOwnerTokensOptions = {}): Promise<OwnedToken[]> {
  const { client, own } = resolve(options, ['metadata', 'includeNative', 'includeZero', 'includeNfts', 'tokenPrograms', 'signal', 'minContextSlot', 'withSlot'])
  return client.ownerTokens(owner, own)
}

export interface WatchBalancesOptions extends Omit<GetBalancesOptions, 'signal' | 'minContextSlot'> {
  /** 轮询间隔（毫秒），默认 15000；多处订阅同一份时取最小的 */
  interval?: number
  /** 第一次拿到结果、以及之后余额（balance）变化时调用；previous 是上一次通知的结果（第一次为 null） */
  onChange: (balances: TokenBalance[], previous: TokenBalance[] | null) => void
  /** 某次轮询失败时调用（之后照常继续轮询） */
  onError?: (err: unknown) => void
}

interface Watcher {
  interval: number
  onChange: WatchBalancesOptions['onChange']
  onError?: WatchBalancesOptions['onError']
}

interface Watch {
  client: SolanaClient
  owner: string
  mints: readonly string[] | undefined
  options: BalancesOptions
  watchers: Set<Watcher>
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
  stopped: boolean
  last: TokenBalance[] | null
  lastKey: string | null
}

// 共享轮询：按客户端（同样的节点配置会复用同一个客户端）+ owner + mints（顺序无关）+ 影响结果的选项
const watches = new WeakMap<SolanaClient, Map<string, Watch>>()

/**
 * 轮询余额，多处订阅同一个钱包时合并成一份轮询，只在余额变化时通知。返回取消订阅的函数；最后一个订阅者取消时停止轮询。
 * 参数同 getBalances（不支持 signal / minContextSlot）；上一次请求没完成时不会发起下一次。
 * 结果顺序按第一个订阅者传的 mints；新订阅者加入时如果已有结果，立即收到一次（previous 为 null）
 *
 * ```ts
 * const stop = watchBalances(owner, [NATIVE_MINT, USDC], { interval: 10_000, onChange: (list) => render(list) })
 * stop()
 * ```
 */
export function watchBalances(owner: string, mints: readonly string[] | undefined, options: WatchBalancesOptions): () => void {
  const { onChange, onError, interval = 15_000, ...rest } = options
  if (!(interval > 0)) {
    throw new Error(`Invalid interval: ${interval}`)
  }
  const { client, own } = resolve(rest, ['symbol', 'scan', 'accounts', 'tokenPrograms', 'withSlot'])
  const key = JSON.stringify([
    owner,
    mints === undefined ? null : [...new Set(mints)].sort(),
    own.symbol ?? false,
    own.scan ?? false,
    own.accounts ?? 'ata',
    own.tokenPrograms === undefined ? null : [...own.tokenPrograms].sort(),
    own.withSlot ?? false,
  ])
  let group = watches.get(client)
  if (!group) {
    group = new Map()
    watches.set(client, group)
  }
  let watch = group.get(key)
  const watcher: Watcher = { interval, onChange, onError }
  if (!watch) {
    watch = { client, owner, mints, options: own, watchers: new Set([watcher]), timer: null, running: false, stopped: false, last: null, lastKey: null }
    group.set(key, watch)
    poll(watch)
  } else {
    watch.watchers.add(watcher)
    const current = watch
    if (current.last) {
      const last = current.last
      queueMicrotask(() => current.watchers.has(watcher) && safely(() => watcher.onChange(last, null)))
    }
    // 间隔变小：按新的间隔重新安排下一次
    if (current.timer && interval < nextInterval(current, watcher)) {
      clearTimeout(current.timer)
      current.timer = null
      schedule(current)
    }
  }
  const owned = watch
  const ownedGroup = group
  return () => {
    if (!owned.watchers.delete(watcher) || owned.watchers.size) {
      return
    }
    owned.stopped = true
    if (owned.timer) {
      clearTimeout(owned.timer)
      owned.timer = null
    }
    if (ownedGroup.get(key) === owned) {
      ownedGroup.delete(key)
    }
  }
}

/** 除了 except 以外订阅者的最小间隔（用于判断新订阅者是否让间隔变小） */
function nextInterval(watch: Watch, except?: Watcher): number {
  let min = Number.POSITIVE_INFINITY
  for (const w of watch.watchers) {
    if (w !== except) min = Math.min(min, w.interval)
  }
  return min
}

function schedule(watch: Watch): void {
  if (watch.stopped || watch.timer || watch.running) {
    return
  }
  watch.timer = setTimeout(() => poll(watch), nextInterval(watch))
}

function poll(watch: Watch): void {
  watch.timer = null
  if (watch.running || watch.stopped) {
    return
  }
  watch.running = true
  watch.client
    .balances(watch.owner, watch.mints, watch.options)
    .then(
      (balances) => {
        // 只比较余额（slot 每次都会变）
        const key = JSON.stringify(balances.map((b) => [b.token, b.balance, b.success]))
        if (watch.stopped || key === watch.lastKey) {
          return
        }
        const previous = watch.last
        watch.last = balances
        watch.lastKey = key
        for (const w of [...watch.watchers]) {
          safely(() => w.onChange(balances, previous))
        }
      },
      (err: unknown) => {
        if (!watch.stopped) {
          for (const w of [...watch.watchers]) {
            safely(() => w.onError?.(err))
          }
        }
      },
    )
    .finally(() => {
      watch.running = false
      schedule(watch)
    })
}

function safely(fn: () => void): void {
  try {
    fn()
  } catch {
    // 订阅者的回调出错不影响轮询
  }
}

/** 测试用：按参数取（或创建）客户端，用于验证缓存复用（不在包的公开导出里） */
export function resolveClientForTest(options: ShortcutOptions): SolanaClient {
  return resolve(options).client
}

/** 测试用：清空客户端缓存 */
export function resetClientCache(): void {
  clientCache.clear()
}
