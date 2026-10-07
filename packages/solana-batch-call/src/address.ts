import { ed25519 } from '@noble/curves/ed25519.js'
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

/** 32 字节是否在 ed25519 曲线上（PDA 必须不在曲线上） */
function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes)
    return true
  } catch {
    return false
  }
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

// PDA 推导是纯计算但要做多次 sha256 + 曲线判断，结果缓存
const pdaCache = new Map<string, string>()

/**
 * 推导 PDA（与 web3.js PublicKey.findProgramAddressSync 相同），返回地址。
 * seeds 每项不超过 32 字节。
 */
export function findProgramAddress(seeds: Uint8Array[], programId: string): string {
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
