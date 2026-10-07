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

export interface TokenInfo {
  address: string
  /** 读取失败（如 symbol 是 bytes32 的老代币）时为 null */
  symbol: string | null
  name: string | null
  decimals: number
}

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

// decimals 不会变，按 chainId + 地址缓存，轮询余额时只需要查 balanceOf
const decimalsCache = new Map<string, number>()

export function getCachedDecimals(chainId: number, token: string): number | undefined {
  return decimalsCache.get(`${chainId}:${token.toLowerCase()}`)
}

export function setCachedDecimals(chainId: number, token: string, decimals: number): void {
  decimalsCache.set(`${chainId}:${token.toLowerCase()}`, decimals)
}

/** 测试用：清空 decimals 缓存 */
export function resetDecimalsCache(): void {
  decimalsCache.clear()
}
