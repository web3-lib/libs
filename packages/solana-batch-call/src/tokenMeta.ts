// 代币信息缓存（decimals / 所属程序 / name / symbol）和“数据为空的钱包账户”记录：余额、代币详情共用

import { isAddress } from './address.js'
import { SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants.js'
import { parseMetaplexMetadata, parseMint, type AccountInfo, type MetaplexMetadata, type MintInfo } from './layout.js'

export interface TokenMeta {
  decimals?: number
  tokenProgram?: string
  /** tokenProgram 来自导入的缓存、还没从链上确认过：ATA 模式第一次用时按程序未知处理（推导两个程序的 ATA、读 mint 确认） */
  programUnverified?: boolean
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

// 已知数据为空的钱包账户（系统账户或不存在）：ATA 模式下和代币账户放在同一个请求里读，不必单独带 dataSlice 多发一个请求。
// 按 scope + 地址记，最多 1 万个，超出淘汰最早的；读到不是系统账户（如程序账户）时移除
const MAX_SMALL_OWNERS = 10_000
const smallOwners = new Set<string>()

export function isSmallOwner(scope: string, owner: string): boolean {
  return smallOwners.has(`${scope}:${owner}`)
}

/** 根据只读 lamports 的结果判断钱包账户是否“数据为空”（dataSlice 读不到数据长度，按所属程序判断：系统账户的数据为空） */
export function learnOwner(scope: string, owner: string, account: AccountInfo | null): void {
  const key = `${scope}:${owner}`
  if (account === null || account.owner === SYSTEM_PROGRAM_ID) {
    smallOwners.delete(key)
    smallOwners.add(key)
    if (smallOwners.size > MAX_SMALL_OWNERS) {
      smallOwners.delete(smallOwners.values().next().value as string)
    }
  } else {
    smallOwners.delete(key)
  }
}

/** 缓存写入监听（persistTokenMetaCache 用） */
const cacheWriteListeners = new Set<() => void>()

/** 测试用：清空代币信息缓存 */
export function resetTokenMetaCache(): void {
  smallOwners.clear()
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
      const { programUnverified: _, ...exported } = meta
      entries.push([key, exported])
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
  if (raw.tokenProgram === TOKEN_PROGRAM_ID || raw.tokenProgram === TOKEN_2022_PROGRAM_ID) {
    meta.tokenProgram = raw.tokenProgram
    meta.programUnverified = true
  }
  // 写入时间只接受有限值、且不晚于现在（留 1 分钟时钟误差）：未来的时间会让 name / symbol 永不过期，截到现在
  if (
    typeof raw.namesAt === 'number' &&
    Number.isFinite(raw.namesAt) &&
    (typeof raw.name === 'string' || raw.name === null) &&
    (typeof raw.symbol === 'string' || raw.symbol === null)
  ) {
    meta.name = raw.name
    meta.symbol = raw.symbol
    meta.namesAt = Math.min(raw.namesAt, Date.now())
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

/**
 * 从 mint 账户 / 元数据账户里学到的信息写入缓存，返回合并后的结果。
 * lookedForNames：本次同时读了 mint 和元数据账户，都没有 name / symbol 时记为“确认没有”（null），之后不再重查
 */
export function learnMeta(scope: string, mint: string, mintAccount: AccountInfo | null, metadataAccount: AccountInfo | null, lookedForNames = false): TokenMeta {
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

export function safeParseMint(account: AccountInfo): MintInfo | null {
  if (account.owner !== TOKEN_PROGRAM_ID && account.owner !== TOKEN_2022_PROGRAM_ID) {
    return null
  }
  try {
    const mint = parseMint(account.data)
    // 未初始化的 mint（创建和初始化分在两笔交易里，恰好在中间读到）：decimals 还是 0，不能当真、更不能永久缓存
    return mint.isInitialized ? mint : null
  } catch {
    return null
  }
}

export function safeParseMetaplex(account: AccountInfo): MetaplexMetadata | null {
  try {
    return parseMetaplexMetadata(account.data)
  } catch {
    return null
  }
}

export function getMeta(scope: string, mint: string): TokenMeta {
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

export function setMeta(scope: string, mint: string, meta: TokenMeta): void {
  const defined: CachedMeta = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined))
  if (Object.keys(defined).length === 0) {
    return
  }
  if ('name' in defined || 'symbol' in defined) {
    defined.namesAt = Date.now()
  }
  const key = `${scope}:${mint}`
  const merged = { ...tokenMetaCache.get(key), ...defined }
  if ('tokenProgram' in defined && !defined.programUnverified) {
    delete merged.programUnverified // 从链上学到了所属程序
  }
  tokenMetaCache.delete(key) // 重新插入，保持“最近写入在后”的顺序
  tokenMetaCache.set(key, merged)
  if (tokenMetaCache.size > MAX_CACHED_TOKENS) {
    tokenMetaCache.delete(tokenMetaCache.keys().next().value as string)
  }
  for (const listener of cacheWriteListeners) {
    listener()
  }
}
