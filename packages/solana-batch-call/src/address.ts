import { sha256 } from '@noble/hashes/sha2.js'
import { base58 } from '@scure/base'

import { ASSOCIATED_TOKEN_PROGRAM_ID, METADATA_PROGRAM_ID } from './constants.js'

/** 是否是合法的 Solana 地址（base58，32 字节） */
export function isAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) {
    return false
  }
  try {
    return base58.decode(value).length === 32
  } catch {
    return false
  }
}

export function decodeAddress(address: string): Uint8Array {
  const bytes = base58.decode(address)
  if (bytes.length !== 32) {
    throw new Error(`Invalid Solana address: ${address}`)
  }
  return bytes
}

export function encodeAddress(bytes: Uint8Array): string {
  return base58.encode(bytes)
}

// ed25519：-x² + y² = 1 + d·x²·y²（mod p）
const P = 2n ** 255n - 19n
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n

/** x^(2^k) mod p */
function pow2k(x: bigint, k: number): bigint {
  let r = x
  for (let i = 0; i < k; i++) r = (r * r) % P
  return r
}

/** x^((p-1)/2) mod p（欧拉判别法），(p-1)/2 = (2^250 - 1)·2^4 + 6，用加法链：约 254 次平方 + 12 次乘法 */
function legendre(x: bigint): bigint {
  const b2 = (((x * x) % P) * x) % P // x^(2^2-1)
  const b4 = (pow2k(b2, 2) * b2) % P
  const b5 = (pow2k(b4, 1) * x) % P
  const b10 = (pow2k(b5, 5) * b5) % P
  const b20 = (pow2k(b10, 10) * b10) % P
  const b40 = (pow2k(b20, 20) * b20) % P
  const b80 = (pow2k(b40, 40) * b40) % P
  const b160 = (pow2k(b80, 80) * b80) % P
  const b240 = (pow2k(b160, 80) * b80) % P
  const b250 = (pow2k(b240, 10) * b10) % P
  return (pow2k(b250, 4) * ((b2 * b2) % P)) % P
}

/**
 * 32 字节是否是合法的 ed25519 压缩点（PDA 必须不在曲线上）。
 * 按 RFC 8032 5.1.3 解压缩，与 @noble/curves 的 Point.fromBytes（web3.js 的 isOnCurve 同样如此）一致：
 * y ≥ p、x = 0 但符号位为 1 都算不在曲线上。只需判断 x² = (y² - 1) / (d·y² + 1) 有没有解，不必真的开方
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) {
    return false
  }
  let y = 0n
  for (let i = 31; i >= 0; i--) {
    y = (y << 8n) | BigInt(i === 31 ? (bytes[i] as number) & 0x7f : (bytes[i] as number))
  }
  if (y >= P) {
    return false
  }
  const y2 = (y * y) % P
  const u = (y2 - 1n + P) % P
  const v = (D * y2 + 1n) % P // d 不是平方数，v 不会为 0
  if (u === 0n) {
    // x = 0：符号位必须为 0
    return ((bytes[31] as number) & 0x80) === 0
  }
  // u / v 是平方数 ⇔ u·v 是平方数（欧拉判别法）
  return legendre((u * v) % P) === 1n
}

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress')

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const MAX_SEED_LENGTH = 32
const MAX_SEEDS = 16

// PDA 推导是纯计算但要做多次 sha256 + 曲线判断，结果缓存
const pdaCache = new Map<string, string>()

/**
 * 推导 PDA（与 web3.js PublicKey.findProgramAddressSync 相同），返回地址。
 * seeds 每项不超过 32 字节、最多 15 个（加上 bump 共 16 个，链上上限），超出时抛错。
 */
export function findProgramAddress(seeds: Uint8Array[], programId: string): string {
  // 与链上和 web3.js 一致：每个种子最多 32 字节；种子加上 bump 最多 16 个
  if (seeds.some((seed) => seed.length > MAX_SEED_LENGTH)) {
    throw new TypeError('Max seed length exceeded')
  }
  if (seeds.length + 1 > MAX_SEEDS) {
    throw new TypeError('Max seeds exceeded')
  }
  const key = `${programId}:${seeds.map((s) => encodeAddress(s)).join(',')}`
  const cached = pdaCache.get(key)
  if (cached) {
    return cached
  }
  const program = decodeAddress(programId)
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(concat([...seeds, new Uint8Array([bump]), program, PDA_MARKER]))
    if (!isOnCurve(hash)) {
      const address = encodeAddress(hash)
      if (pdaCache.size > 10_000) {
        pdaCache.clear()
      }
      pdaCache.set(key, address)
      return address
    }
  }
  throw new Error('Unable to find a viable program address bump seed')
}

/** 关联代币账户（ATA）地址 */
export function getAssociatedTokenAddress(owner: string, mint: string, tokenProgram: string): string {
  return findProgramAddress([decodeAddress(owner), decodeAddress(tokenProgram), decodeAddress(mint)], ASSOCIATED_TOKEN_PROGRAM_ID)
}

/** Metaplex Token Metadata 账户地址 */
export function getMetadataAddress(mint: string): string {
  return findProgramAddress(
    [new TextEncoder().encode('metadata'), decodeAddress(METADATA_PROGRAM_ID), decodeAddress(mint)],
    METADATA_PROGRAM_ID,
  )
}
