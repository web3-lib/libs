import type { BoundCall, FailureReason } from './call.js'
import type { BoundMethod, Contract } from './contract.js'

export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
] as const

type Method<Args extends unknown[], T> = ((...params: Args) => BoundCall<T>) & Pick<BoundMethod<T>, 'staticCall'>

/** `provider.erc20(address)` 返回的绑定合约（带结果类型） */
export interface Erc20Contract extends Contract {
  name: Method<[], string>
  symbol: Method<[], string>
  decimals: Method<[], bigint>
  totalSupply: Method<[], bigint>
  balanceOf: Method<[owner: string], bigint>
  allowance: Method<[owner: string, spender: string], bigint>
  approve: Method<[spender: string, amount: bigint | string | number], boolean>
  transfer: Method<[to: string, amount: bigint | string | number], boolean>
  transferFrom: Method<[from: string, to: string, amount: bigint | string | number], boolean>
}

/** allowances() / getAllowances() 的单项结果 */
export interface TokenAllowance {
  token: string
  spender: string
  /** 主币不需要授权，视为无限额度 */
  native: boolean
  /** 授权额度（最小单位的十进制字符串） */
  allowance: string
  decimals: number
  /** 按 decimals 换算后的额度 */
  formatted: string
  /** 额度 ≥ uint96 最大值时为 true（覆盖 MaxUint256，以及 UNI / COMP 等把额度截断为 uint96 的代币） */
  unlimited: boolean
  /** 仅在 withBlock / minBlock 时返回：读取时的区块号（读取失败为 null） */
  blockNumber?: number | null
  success: boolean
  /** 仅在 success 为 false 时返回：失败原因 */
  error?: FailureReason
  /** 仅在 success 为 false 时返回：哪一项没读到 */
  errorField?: 'allowance' | 'decimals'
}

/** allowances(..., { decimals: false }) 的单项结果：不查 decimals，不带 decimals / formatted */
export type RawTokenAllowance = Omit<TokenAllowance, 'decimals' | 'formatted'>

/** unlimited 的判定阈值：uint96 最大值 */
export const UNLIMITED_ALLOWANCE_THRESHOLD = 2n ** 96n - 1n

const MAX_UINT256 = 2n ** 256n - 1n

export { MAX_UINT256 }

/** tokens() / getTokens() 可选的字段 */
export type TokenField = 'name' | 'symbol' | 'decimals' | 'totalSupply'

/** 不指定 fields 时返回的字段 */
export const DEFAULT_TOKEN_FIELDS = ['name', 'symbol', 'decimals'] as const satisfies readonly TokenField[]

export type DefaultTokenField = (typeof DEFAULT_TOKEN_FIELDS)[number]

interface TokenFieldTypes {
  name: string | null
  symbol: string | null
  decimals: number | null
  /** 最小单位的十进制字符串 */
  totalSupply: string | null
}

/**
 * tokens() / getTokens() 的单项结果，只包含请求的字段（读取失败的字段为 null）。
 * 请求 totalSupply 时额外带 totalSupplyFormatted（按 decimals 换算）。
 */
export type TokenDetails<F extends TokenField = DefaultTokenField> = {
  address: string
  /** 是否是主币占位地址（信息来自内置链信息表 / nativeSymbol 等配置） */
  native: boolean
  /** 仅在 withBlock / minBlock 时返回：读取时的区块号（读取失败为 null） */
  blockNumber?: number | null
  /** 请求的字段都读到时为 true（主币没有 totalSupply，不计入） */
  success: boolean
  /** 仅在 success 为 false 时返回：第一个没读到的字段的失败原因 */
  error?: FailureReason
  /** 仅在 success 为 false 时返回：第一个没读到的字段 */
  errorField?: TokenField
} & { [K in F]: TokenFieldTypes[K] } & ('totalSupply' extends F ? { totalSupplyFormatted: string | null } : unknown)

/** 主币占位地址（多数聚合器、钱包的约定），传给 balances() 时按主币处理 */
export const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

/** balances() 默认视为主币的地址：0xeeee…eeee 和零地址 */
export const DEFAULT_NATIVE_TOKENS: readonly string[] = [NATIVE_TOKEN, '0x0000000000000000000000000000000000000000']

/** balances() 的代币参数：地址，或带已知 decimals 的对象（跳过 decimals 查询） */
export type BalanceToken = string | { address: string; decimals?: number }

export interface TokenBalance {
  /** 传入的代币地址（原样） */
  token: string
  /** 是否按主币查询 */
  native: boolean
  /** 原始余额（最小单位）的十进制字符串，如 "1234500000"；需要计算时用 BigInt(balance) */
  balance: string
  decimals: number
  /** 按 decimals 换算后的十进制字符串，如 "1234.5"；整数不带小数点 */
  formatted: string
  /** 仅在 symbol: true 时返回；读取失败或主币 symbol 未知时为 null */
  symbol?: string | null
  /** 仅在 withBlock / minBlock 时返回：读取时的区块号（与余额在同一次 eth_call 里读出；读取失败为 null） */
  blockNumber?: number | null
  /** 余额和 decimals 都查到时为 true；失败时 balance、formatted 都为 "0" */
  success: boolean
  /**
   * 仅在 success 为 false 时返回：失败原因（invalid-address 地址非法、no-contract 地址上没有合约、
   * reverted 执行 revert、decode-failed 返回值无法解码）。symbol 读不到不算失败（symbol 为 null）
   */
  error?: FailureReason
  /** 仅在 success 为 false 时返回：哪一项没读到（两项都失败时为 balance） */
  errorField?: 'balance' | 'decimals'
}

/** balances(..., { decimals: false }) 的单项结果：不查 decimals，不带 decimals / formatted */
export type RawTokenBalance = Omit<TokenBalance, 'decimals' | 'formatted' | 'errorField'> & { errorField?: 'balance' }

/**
 * 按精度格式化（与 ethers 的 formatUnits 同名同义）：formatUnits(1234500000n, 6) === '1234.5'，formatUnits(10n ** 18n, 18) === '1'。
 * 不做四舍五入，保留全部有效小数位，整数不带小数点（与 ethers 不同：ethers 会返回 '1.0'）。
 */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/** @deprecated 改用 formatUnits（同一个函数；formatAmount 容易与项目里的数字展示函数撞名） */
export const formatAmount = formatUnits

// 代币信息缓存（按 chainId + 地址）：decimals / NFT 标准不会变，永久缓存；name / symbol 在可升级合约上可能改，缓存 1 小时。
// 条目数有上限，超出时淘汰最早写入的（与 solana-batch-call 一致）。轮询余额时只需要查 balanceOf
interface TokenMeta {
  decimals?: number
  symbol?: string
  name?: string
  /** NFT 集合标准（nftCollections 识别后缓存）；null 表示确认不是 ERC721 / ERC1155 */
  standard?: 'ERC721' | 'ERC1155' | null
}

interface CachedMeta extends TokenMeta {
  /** name / symbol 各自的写入时间（分开计：只刷新其中一个时，另一个照常过期） */
  nameAt?: number
  symbolAt?: number
}

const NAME_TTL = 60 * 60 * 1000
const MAX_CACHED_TOKENS = 50_000
const tokenMetaCache = new Map<string, CachedMeta>()
const cacheListeners = new Set<() => void>()

export function getCachedTokenMeta(chainId: number, token: string): TokenMeta {
  const cached = tokenMetaCache.get(`${chainId}:${token.toLowerCase()}`)
  if (!cached) {
    return {}
  }
  const { nameAt, symbolAt, ...meta } = cached
  const now = Date.now()
  if (nameAt === undefined || now - nameAt > NAME_TTL) {
    delete meta.name
  }
  if (symbolAt === undefined || now - symbolAt > NAME_TTL) {
    delete meta.symbol
  }
  return meta
}

export function setCachedTokenMeta(chainId: number, token: string, meta: TokenMeta): void {
  if (Object.keys(meta).length === 0) {
    return // 没有新数据（如查询失败）时不写入空条目
  }
  const defined: CachedMeta = { ...meta }
  if ('name' in meta) {
    defined.nameAt = Date.now()
  }
  if ('symbol' in meta) {
    defined.symbolAt = Date.now()
  }
  const key = `${chainId}:${token.toLowerCase()}`
  const merged = { ...tokenMetaCache.get(key), ...defined }
  tokenMetaCache.delete(key) // 重新插入，保持“最近写入在后”的顺序
  tokenMetaCache.set(key, merged)
  if (tokenMetaCache.size > MAX_CACHED_TOKENS) {
    tokenMetaCache.delete(tokenMetaCache.keys().next().value as string)
  }
  cacheListeners.forEach((listener) => listener())
}

/** 测试用：清空 decimals / symbol 缓存 */
export function resetDecimalsCache(): void {
  tokenMetaCache.clear()
}

/** exportTokenMetaCache() 的结果，可以 JSON.stringify */
export interface TokenMetaSnapshot {
  version: 1
  /** [chainId:小写地址, 信息]，按写入时间先后 */
  entries: Array<[string, CachedMeta]>
}

/**
 * 导出代币信息缓存（decimals / symbol / name / NFT 标准），可存到任意地方，下次用 importTokenMetaCache 导入，
 * 页面刷新后不必重查精度。name / symbol 带写入时间，导入后仍按 1 小时过期。
 *
 * @param maxEntries 最多导出多少条（最近写入的优先），默认全部
 */
export function exportTokenMetaCache(maxEntries = Number.POSITIVE_INFINITY): TokenMetaSnapshot {
  const entries = [...tokenMetaCache]
  return { version: 1, entries: entries.slice(Math.max(0, entries.length - maxEntries)) }
}

/** 导入 exportTokenMetaCache 的结果；格式不对的数据忽略。已有的条目以缓存里的为准（更新） */
export function importTokenMetaCache(snapshot: unknown): void {
  const entries = (snapshot as Partial<TokenMetaSnapshot> | null)?.entries
  if ((snapshot as Partial<TokenMetaSnapshot> | null)?.version !== 1 || !Array.isArray(entries)) {
    return
  }
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !/^\d+:\S+$/.test(entry[0]) || !entry[1] || typeof entry[1] !== 'object') {
      continue
    }
    const [rawKey, value] = entry as [string, CachedMeta]
    // 与 getCachedTokenMeta 的 key 一致：地址部分小写
    const separator = rawKey.indexOf(':')
    const key = `${rawKey.slice(0, separator)}:${rawKey.slice(separator + 1).toLowerCase()}`
    const meta: CachedMeta = {}
    if (Number.isInteger(value.decimals) && (value.decimals as number) >= 0 && (value.decimals as number) <= 255) meta.decimals = value.decimals
    const nameAt = validTimestamp(value.nameAt)
    if (typeof value.name === 'string' && nameAt !== null) {
      meta.name = value.name
      meta.nameAt = nameAt
    }
    const symbolAt = validTimestamp(value.symbolAt)
    if (typeof value.symbol === 'string' && symbolAt !== null) {
      meta.symbol = value.symbol
      meta.symbolAt = symbolAt
    }
    if (value.standard === 'ERC721' || value.standard === 'ERC1155' || value.standard === null) meta.standard = value.standard
    if (Object.keys(meta).length && !tokenMetaCache.has(key)) {
      tokenMetaCache.set(key, meta)
    }
  }
  while (tokenMetaCache.size > MAX_CACHED_TOKENS) {
    tokenMetaCache.delete(tokenMetaCache.keys().next().value as string)
  }
}

/**
 * 导入的写入时间：只接受有限的数值；晚于当前时间的（时钟不准、数据被改过）截到当前时间——否则永不过期。
 * 不合格时为 null（丢弃 name / symbol，之后重新查）
 */
function validTimestamp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  return Math.min(value, Date.now())
}

/** persistTokenMetaCache 的存储：localStorage / sessionStorage 可以直接传，也可以自己实现 */
export interface TokenMetaStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * 把代币信息缓存持久化到同步的键值存储（如 localStorage）：调用时先读入，之后缓存有更新就防抖（1 秒）整体写回。
 * 返回停止持久化的函数。存储读写出错（如超出配额）时忽略。
 *
 * ```ts
 * persistTokenMetaCache(localStorage) // 刷新页面后不必重查 decimals
 * ```
 */
export function persistTokenMetaCache(store: TokenMetaStore, options: { key?: string; maxEntries?: number } = {}): () => void {
  const { key = 'w3lib:evm-token-meta', maxEntries = 5000 } = options
  try {
    const raw = store.getItem(key)
    if (raw) {
      importTokenMetaCache(JSON.parse(raw))
    }
  } catch {
    // 数据损坏：忽略，之后会被覆盖
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    timer = undefined
    try {
      store.setItem(key, JSON.stringify(exportTokenMetaCache(maxEntries)))
    } catch {
      // 超出配额等：忽略
    }
  }
  const listener = () => {
    timer ??= setTimeout(save, 1000)
  }
  cacheListeners.add(listener)
  return () => {
    cacheListeners.delete(listener)
    if (timer !== undefined) {
      clearTimeout(timer)
      save()
    }
  }
}
