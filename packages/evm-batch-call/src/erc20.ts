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

/** 常见的主币占位地址：多数聚合器用 0xeeee…eeee，部分协议用零地址 */
export const DEFAULT_NATIVE_TOKENS: readonly string[] = [
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  '0x0000000000000000000000000000000000000000',
]
