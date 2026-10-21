import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../constants.js'
import { findExtension, parseMint, parseTransferFeeConfig, type AccountInfo } from '../layout.js'
import { Bytes } from '../lp.js'
import type { Instruction } from '../write/transaction.js'

export type SolanaSwapProtocol = 'raydium-clmm' | 'orca-whirlpool' | 'raydium-cpmm' | 'raydium-amm'

/** 报价时的链上环境：Clock sysvar 的时间（秒）和 epoch（Token-2022 转账手续费按 epoch 选配置；动态费率按时间衰减） */
export interface SwapEnv {
  timestamp: bigint
  epoch: bigint
}

export const CLOCK_SYSVAR_ID = 'SysvarC1ock11111111111111111111111111111111'

/** Clock：slot u64、epoch_start_timestamp i64、epoch u64、leader_schedule_epoch u64、unix_timestamp i64 */
export function parseClock(data: Uint8Array): SwapEnv {
  if (data.length < 40) throw new Error('Unexpected Clock sysvar data')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return { epoch: view.getBigUint64(16, true), timestamp: view.getBigInt64(32, true) }
}

/** 读到的账户：address → 账户（不存在为 null）；没读的为 undefined */
export type AccountGetter = (address: string) => AccountInfo | null | undefined

/** 池子不支持本地报价 / 兑换（跳过这个池子，原因在 plan 里能看到） */
export class UnsupportedPool extends Error {}

/** 报价还需要读这些账户（如兑换走得比预读的 tick 数组更远）：读完后重新报价 */
export class NeedAccounts extends Error {
  constructor(readonly addresses: string[]) {
    super(`Need ${addresses.length} more accounts`)
  }
}

export const U64_MAX = (1n << 64n) - 1n
export const mulDivFloor = (a: bigint, b: bigint, d: bigint) => (a * b) / d
export const mulDivCeil = (a: bigint, b: bigint, d: bigint) => (a * b + d - 1n) / d

export function need(get: AccountGetter, address: string, what: string): AccountInfo {
  const account = get(address)
  if (account === undefined) throw new Error(`${what} was not loaded: ${address}`)
  if (account === null) throw new UnsupportedPool(`${what} not found: ${address}`)
  return account
}

/** 交易里要用的代币信息 */
export interface SwapMint {
  mint: string
  program: string
  decimals: number
  /** 原始 mint 账户（算 Token-2022 转账手续费） */
  account: AccountInfo
}

const EXTENSION_TRANSFER_HOOK = 14

/**
 * 解析池子里一种代币的 mint：SPL Token / Token-2022；带转账 hook（需要额外账户）的不支持。
 * 带转账手续费的支持（按当前 epoch 的费率算）
 */
export function swapMint(mint: string, account: AccountInfo): SwapMint {
  if (account.owner !== TOKEN_PROGRAM_ID && account.owner !== TOKEN_2022_PROGRAM_ID) {
    throw new UnsupportedPool(`${mint} is not a token mint`)
  }
  if (account.owner === TOKEN_2022_PROGRAM_ID) {
    const hook = findExtension(account.data, EXTENSION_TRANSFER_HOOK)
    if (hook && hook.length >= 64 && hook.subarray(32, 64).some((b) => b !== 0)) {
      throw new UnsupportedPool(`${mint} has a transfer hook, which is not supported`)
    }
  }
  return { mint, program: account.owner, decimals: parseMint(account.data).decimals, account }
}

/** Token-2022 转账手续费：ceil(amount × 费率 / 10000)，不超过单笔上限；SPL Token 为 0（与 Token-2022 的 calculate_epoch_fee 一致） */
export function transferFee(mint: SwapMint, amount: bigint, epoch: bigint): bigint {
  if (mint.program !== TOKEN_2022_PROGRAM_ID || amount === 0n) return 0n
  const config = parseTransferFeeConfig(mint.account.data)
  if (!config) return 0n
  const fee = epoch >= config.newer.epoch ? config.newer : config.older
  if (fee.basisPoints === 0) return 0n
  const raw = (amount * BigInt(fee.basisPoints) + 9999n) / 10000n
  return raw < fee.maximumFee ? raw : fee.maximumFee
}

/** 一跳的报价：用户付出 amountIn（含输入代币的转账手续费），实际收到 amountOut（已扣输出代币的转账手续费） */
export interface HopQuote {
  amountIn: bigint
  amountOut: bigint
  /** 交易里要传的额外账户（tick 数组等），由各协议的 instruction 使用 */
  accounts: string[]
  /** 集中流动性：穿过的已初始化 tick 数、成交的限价单 tick 数（Raydium） */
  crossed?: number
  orders?: number
}

/** 一个可以兑换的池子（已解析） */
export interface SwapPool {
  protocol: SolanaSwapProtocol
  address: string
  mint0: string
  mint1: string
  /** 报价要读的账户（池子账户之外）：按方向（zeroForOne：卖出 mint0） */
  accounts(zeroForOne: boolean): string[]
  /** 本地报价（只用读到的账户，纯计算）；池子不支持时抛 UnsupportedPool */
  quote(get: AccountGetter, amountIn: bigint, zeroForOne: boolean, env: SwapEnv): HopQuote
  /** 兑换指令：从 input 代币账户卖出 amountIn，output 代币账户至少收到 minOut */
  instruction(get: AccountGetter, owner: string, input: string, output: string, zeroForOne: boolean, quote: HopQuote, minOut: bigint): Instruction
  /** 两种代币的 mint 信息（报价后可用） */
  mints(get: AccountGetter): [SwapMint, SwapMint]
}

export { Bytes }
