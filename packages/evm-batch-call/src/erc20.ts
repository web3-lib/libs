import type { BoundCall } from './call.js'
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
  success: boolean
}

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
  /** 请求的字段都读到时为 true（主币没有 totalSupply，不计入） */
  success: boolean
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
  /** 余额和 decimals 都查到时为 true；失败时 balance、formatted 都为 "0" */
  success: boolean
}

/**
 * 按精度格式化：formatAmount(1234500000n, 6) === '1234.5'，formatAmount(10n ** 18n, 18) === '1'。
 * 不做四舍五入，保留全部有效小数位。
 */
export function formatAmount(value: bigint, decimals: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

// decimals / symbol / name 不会变，按 chainId + 地址缓存，轮询余额时只需要查 balanceOf
interface TokenMeta {
  decimals?: number
  symbol?: string
  name?: string
  /** NFT 集合标准（nftCollections 识别后缓存）；null 表示确认不是 ERC721 / ERC1155 */
  standard?: 'ERC721' | 'ERC1155' | null
}

const tokenMetaCache = new Map<string, TokenMeta>()

export function getCachedTokenMeta(chainId: number, token: string): TokenMeta {
  return tokenMetaCache.get(`${chainId}:${token.toLowerCase()}`) ?? {}
}

export function setCachedTokenMeta(chainId: number, token: string, meta: TokenMeta): void {
  if (Object.keys(meta).length === 0) {
    return // 没有新数据（如查询失败）时不写入空条目
  }
  const key = `${chainId}:${token.toLowerCase()}`
  tokenMetaCache.set(key, { ...tokenMetaCache.get(key), ...meta })
}

/** 测试用：清空 decimals / symbol 缓存 */
export function resetDecimalsCache(): void {
  tokenMetaCache.clear()
}
