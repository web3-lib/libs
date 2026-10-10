import { ed25519 } from '@noble/curves/ed25519.js'
import { describe, expect, it } from 'vitest'

import { decodeAddress, findProgramAddress, getAssociatedTokenAddress, isOnCurve } from '../src/index.js'

// 对照：@noble/curves（只在测试里用）。web3.js 的 PublicKey.isOnCurve 同样是 noble 的 RFC 8032 严格模式
function nobleOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes)
    return true
  } catch {
    return false
  }
}

const P = 2n ** 255n - 19n

function le(value: bigint, signBit = false): Uint8Array {
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = Number((value >> BigInt(8 * i)) & 0xffn)
  if (signBit) out[31] = (out[31] as number) | 0x80
  return out
}

// 可复现的伪随机字节（xorshift）
function* randomBytes(count: number, seed = 0x9e3779b9): Generator<Uint8Array> {
  let s = seed
  for (let n = 0; n < count; n++) {
    const out = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      out[i] = s & 0xff
    }
    yield out
  }
}

describe('isOnCurve（与 @noble/curves 对拍）', () => {
  it('随机 32 字节', () => {
    let onCurve = 0
    for (const bytes of randomBytes(5000)) {
      const expected = nobleOnCurve(bytes)
      expect(isOnCurve(bytes), Buffer.from(bytes).toString('hex')).toBe(expected)
      if (expected) onCurve++
    }
    // 大约一半的 y 有解，确认两种情况都覆盖到了
    expect(onCurve).toBeGreaterThan(2000)
    expect(onCurve).toBeLessThan(3000)
  }, 30_000) // 5000 次 bigint 运算，和其他测试并行跑时可能超过默认的 5 秒

  it('曲线上的点（随机私钥的公钥，含符号位两种取值）', () => {
    for (const seed of randomBytes(300, 12345)) {
      const pub = ed25519.getPublicKey(seed)
      expect(isOnCurve(pub)).toBe(true)
      const flipped = pub.slice()
      flipped[31] = (flipped[31] as number) ^ 0x80
      expect(isOnCurve(flipped)).toBe(nobleOnCurve(flipped))
    }
  })

  it('边界值：y ≥ p、x = 0 且符号位为 1、全 0、全 1', () => {
    const cases: Uint8Array[] = [
      le(0n),
      le(1n), // y = 1 → x = 0
      le(1n, true), // x = 0 但符号位为 1
      le(P - 1n), // y = -1 → x = 0
      le(P - 1n, true),
      le(P - 2n),
      ...Array.from({ length: 19 }, (_, i) => le(P + BigInt(i))), // p ≤ y < 2^255
      ...Array.from({ length: 19 }, (_, i) => le(P + BigInt(i), true)),
      new Uint8Array(32).fill(0xff),
      new Uint8Array(32).fill(0x7f),
      ed25519.Point.BASE.toBytes(),
    ]
    for (const bytes of cases) {
      expect(isOnCurve(bytes), Buffer.from(bytes).toString('hex')).toBe(nobleOnCurve(bytes))
    }
    expect(isOnCurve(le(1n))).toBe(true)
    expect(isOnCurve(le(1n, true))).toBe(false)
    expect(isOnCurve(le(P))).toBe(false)
    expect(isOnCurve(new Uint8Array(31))).toBe(false)
  })

  it('真实地址：钱包在曲线上，PDA / ATA 不在', () => {
    expect(isOnCurve(decodeAddress('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'))).toBe(nobleOnCurve(decodeAddress('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9')))
    const ata = getAssociatedTokenAddress('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'TokenkegQfeZyiNwAJbNbGqPXZjtyQpq9GE6DjGfr6w')
    expect(isOnCurve(decodeAddress(ata))).toBe(false)
    const pda = findProgramAddress([new TextEncoder().encode('seed')], '11111111111111111111111111111111')
    expect(isOnCurve(decodeAddress(pda))).toBe(false)
  })
})
