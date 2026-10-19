import { sha256 } from '@noble/hashes/sha2.js'

import { encodeAddress, getAssociatedTokenAddress, isAddress } from '../address.js'
import type { SolanaClient } from '../client.js'
import { NATIVE_MINT, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../constants.js'
import { formatUnits, parseMint, parseTokenAccount, parseTransferFeeConfig, parseUnits, type AccountInfo } from '../layout.js'
import type { SolanaLpPosition, SolanaLpToken } from '../lp.js'
import { closeAccount, createAssociatedTokenAccountIdempotent, systemTransfer } from '../write/instructions.js'
import type { Instruction } from '../write/transaction.js'
import type { SolanaLiquidityOptions, SolanaLiquidityPlan, SolanaPositionRef } from './types.js'

export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
export const RENT_SYSVAR_ID = 'SysvarRent111111111111111111111111111111111'
export const DEFAULT_ADDRESS = SYSTEM_PROGRAM_ID

export interface Ctx {
  client: SolanaClient
  owner: string
  recipient: string
  slippage: number
  native: boolean
  signal: AbortSignal | undefined
}

export function createCtx(client: SolanaClient, owner: string, options: SolanaLiquidityOptions): Ctx {
  for (const address of [owner, options.recipient ?? owner]) {
    if (!isAddress(address)) {
      throw new Error(`Invalid address: ${address}`)
    }
  }
  const slippage = options.slippage ?? 0.005
  if (!(slippage >= 0 && slippage < 1)) {
    throw new RangeError(`slippage must be in [0, 1): ${slippage}`)
  }
  return { client, owner, recipient: options.recipient ?? owner, slippage, native: options.native ?? true, signal: options.signal }
}

export { Bytes } from '../lp.js'

/** 按字段顺序写指令数据（小端） */
export class Writer {
  readonly #parts: number[] = []
  bytes(values: ArrayLike<number>): this {
    for (let i = 0; i < values.length; i++) this.#parts.push(values[i] as number)
    return this
  }
  u8(v: number): this {
    return this.bytes([v & 0xff])
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0)
  }
  i32(v: number): this {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setInt32(0, v, true)
    return this.bytes(b)
  }
  u64(v: bigint): this {
    if (v < 0n || v >= 1n << 64n) throw new RangeError(`u64 out of range: ${v}`)
    const b = new Uint8Array(8)
    new DataView(b.buffer).setBigUint64(0, v, true)
    return this.bytes(b)
  }
  u128(v: bigint): this {
    if (v < 0n || v >= 1n << 128n) throw new RangeError(`u128 out of range: ${v}`)
    return this.u64(v & ((1n << 64n) - 1n)).u64(v >> 64n)
  }
  build(): Uint8Array {
    return new Uint8Array(this.#parts)
  }
}

/** Anchor 指令判别符：sha256("global:<名称>") 的前 8 字节 */
export function anchorIx(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8)
}

export const w = (pubkey: string, isSigner = false) => ({ pubkey, isSigner, isWritable: true })
export const r = (pubkey: string, isSigner = false) => ({ pubkey, isSigner, isWritable: false })

/** 读账户，缺失时报错 */
export async function mustAccounts(ctx: Ctx, addresses: readonly string[], what: (i: number) => string): Promise<AccountInfo[]> {
  const accounts = await ctx.client.accounts(addresses, { signal: ctx.signal })
  return accounts.map((a, i) => {
    if (!a) {
      throw new Error(`${what(i)} not found: ${addresses[i]}`)
    }
    return a
  })
}

/** 代币的 mint 信息：所属的代币程序、精度 */
export interface MintMeta {
  mint: string
  program: string
  decimals: number
}

/**
 * pool：池子里的两种代币。带转账手续费的 Token-2022 代币不支持（程序按扣费前 / 后的数量检查上下限，计划里的数量会对不上，
 * 手续费超过滑点时交易一定失败），构建时报错；挖矿奖励的代币不检查（只影响到账数量）
 */
export function mintMeta(mint: string, account: AccountInfo, pool = true): MintMeta {
  if (account.owner !== TOKEN_PROGRAM_ID && account.owner !== TOKEN_2022_PROGRAM_ID) {
    throw new Error(`${mint} is not a token mint`)
  }
  if (pool && account.owner === TOKEN_2022_PROGRAM_ID) {
    const fee = parseTransferFeeConfig(account.data)
    if (fee && (fee.older.basisPoints > 0 || fee.newer.basisPoints > 0)) {
      throw new Error(`${mint} is a Token-2022 token with a transfer fee, which is not supported`)
    }
  }
  return { mint, program: account.owner, decimals: parseMint(account.data).decimals }
}

/** 代币信息（symbol / 精度），与 getLpPositions 的格式一致 */
export async function tokenInfo(ctx: Ctx, mints: readonly MintMeta[]): Promise<SolanaLpToken[]> {
  const details = await ctx.client.tokens(
    mints.map((m) => m.mint),
    { fields: ['symbol', 'decimals'], signal: ctx.signal },
  )
  return mints.map((m, i) => ({ mint: m.mint, symbol: details[i]?.symbol ?? null, decimals: details[i]?.decimals ?? m.decimals }))
}

export function fmt(value: bigint, token: SolanaLpToken): string | null {
  return token.decimals === null ? null : formatUnits(value, token.decimals)
}

/** 解析输入的数量：amount（最小单位）和 formatted 二选一，都没给时返回 undefined */
export function parseAmount(raw: bigint | number | string | undefined, formatted: string | undefined, decimals: number, name: string): bigint | undefined {
  if (raw !== undefined && formatted !== undefined) {
    throw new Error(`Pass either ${name} or ${name}Formatted, not both`)
  }
  let value: bigint
  if (formatted !== undefined) {
    value = parseUnits(formatted, decimals)
  } else if (raw !== undefined) {
    if (typeof raw === 'number' && !Number.isSafeInteger(raw)) {
      throw new RangeError(`${name} must be an integer (raw units); use ${name}Formatted for decimals`)
    }
    value = BigInt(raw)
  } else {
    return undefined
  }
  if (value < 0n) {
    throw new RangeError(`${name} must not be negative`)
  }
  return value
}

/** 按滑点向下取：value × (1 − slippage) */
export function minus(value: bigint, slippage: number): bigint {
  return (value * (1_000_000n - BigInt(Math.round(slippage * 1e6)))) / 1_000_000n
}

/** 按滑点向上取：value × (1 + slippage)，向上取整 */
export function plus(value: bigint, slippage: number): bigint {
  return (value * (1_000_000n + BigInt(Math.round(slippage * 1e6))) + 999_999n) / 1_000_000n
}

/** 移除的数量：percent（百分数）或 liquidity，二选一，默认全部 */
export function removeAmount(total: bigint, percent: number | undefined, liquidity: bigint | number | string | undefined): bigint {
  if (percent !== undefined && liquidity !== undefined) {
    throw new Error('Pass either percent or liquidity, not both')
  }
  if (liquidity !== undefined) {
    const value = BigInt(liquidity)
    if (value <= 0n || value > total) {
      throw new RangeError(`liquidity must be in (0, ${total}]: ${value}`)
    }
    return value
  }
  const p = percent ?? 100
  if (!(p > 0 && p <= 100)) {
    throw new RangeError(`percent must be in (0, 100]: ${p}`)
  }
  const amount = p === 100 ? total : (total * BigInt(Math.round(p * 10_000))) / 1_000_000n
  if (amount === 0n) {
    throw new RangeError(`${p}% of ${total} rounds to 0`)
  }
  return amount
}

/** 用 SOL 的是哪一边 */
export const nativeSide = (index: number | null) => (index === 0 ? 'token0' : index === 1 ? 'token1' : null)

/** SPL Token SyncNative：把 wSOL 账户的 SOL 余额同步成代币余额 */
function syncNative(account: string): Instruction {
  return { programId: TOKEN_PROGRAM_ID, keys: [w(account)], data: new Uint8Array([17]) }
}

/**
 * owner 的代币账户（ATA）：添加时要付出的、移除时要收到的。
 * 不存在时创建（setup）；wSOL 且 native 时：添加前把差额 SOL 包装进去，最后（原来没有的）关闭换回 SOL
 */
export interface TokenAccounts {
  /** 每个 mint 的 ATA */
  accounts: string[]
  /** 创建缺少的代币账户 */
  setup: Instruction[]
  /** 包装 SOL（转入 + SyncNative）：放在主指令前、同一步里（主指令失败时不会留下包装好的 SOL） */
  wrap: Instruction[]
  cleanup: Instruction[]
  /** 哪一边用 SOL（下标），没有时为 null */
  nativeIndex: number | null
}

export async function prepareTokenAccounts(ctx: Ctx, mints: readonly MintMeta[], pay: ReadonlyArray<bigint | null>): Promise<TokenAccounts> {
  const accounts = mints.map((m) => getAssociatedTokenAddress(ctx.owner, m.mint, m.program))
  const existing = await ctx.client.accounts(accounts, { signal: ctx.signal })
  const setup: Instruction[] = []
  const wrap: Instruction[] = []
  const cleanup: Instruction[] = []
  let nativeIndex: number | null = null
  mints.forEach((m, i) => {
    const account = accounts[i] as string
    const info = existing[i]
    if (!info) {
      setup.push(createAssociatedTokenAccountIdempotent(ctx.owner, account, ctx.owner, m.mint, m.program))
    }
    if (m.mint === NATIVE_MINT && ctx.native) {
      // 添加时用 SOL 支付（包装差额）；收取时只有原来没有 wSOL 账户（用完关闭）才是收到 SOL，否则留在原有的 wSOL 账户里
      if (pay[i] != null || !info) {
        nativeIndex = i
      }
      const need = pay[i] ?? 0n
      const balance = info ? safeAmount(info) : 0n
      if (need > balance) {
        wrap.push(systemTransfer(ctx.owner, account, need - balance), syncNative(account))
      }
      if (!info) {
        // 原来没有 wSOL 账户：用完关闭，剩余的 wSOL 和租金换回 SOL
        cleanup.push(closeAccount(account, ctx.owner, ctx.owner, TOKEN_PROGRAM_ID))
      }
    }
  })
  return { accounts, setup, wrap, cleanup, nativeIndex }
}

function safeAmount(account: AccountInfo): bigint {
  try {
    return parseTokenAccount(account.data).amount
  } catch {
    return 0n
  }
}

/** 仓位引用里的字段 */
export function refMint(ref: SolanaPositionRef | SolanaLpPosition): string {
  const mint = 'positionMint' in ref ? ref.positionMint : undefined
  if (!mint || !isAddress(mint)) {
    throw new Error('position.positionMint is required for Raydium CLMM / Orca Whirlpool positions')
  }
  return mint
}

export function refPool(ref: SolanaPositionRef | SolanaLpPosition): string {
  if (!ref.pool || !isAddress(ref.pool)) {
    throw new Error('position.pool is required for Raydium AMM v4 / CPMM positions')
  }
  return ref.pool
}

/** 新的仓位 NFT mint：WebCrypto 生成 Ed25519 密钥，secretKey 是 32 字节种子（PKCS#8 的最后 32 字节） */
export async function newMintKeypair(): Promise<{ address: string; secretKey: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
  const [publicKey, pkcs8] = await Promise.all([crypto.subtle.exportKey('raw', pair.publicKey), crypto.subtle.exportKey('pkcs8', pair.privateKey)])
  return { address: encodeAddress(new Uint8Array(publicKey)), secretKey: new Uint8Array(pkcs8).slice(-32) }
}

type PlanInput = Omit<SolanaLiquidityPlan, 'owner' | 'amount0Formatted' | 'amount1Formatted' | 'fees0Formatted' | 'fees1Formatted'>

export function makePlan(ctx: Ctx, input: PlanInput): SolanaLiquidityPlan {
  const { token0, token1 } = input
  return {
    ...input,
    owner: ctx.owner,
    amount0Formatted: fmt(BigInt(input.amount0), token0),
    amount1Formatted: fmt(BigInt(input.amount1), token1),
    fees0Formatted: fmt(BigInt(input.fees0), token0),
    fees1Formatted: fmt(BigInt(input.fees1), token1),
    // 空的步骤去掉（如不需要创建账户时的 setup）
    steps: input.steps.filter((s) => s.instructions.length > 0),
  }
}
