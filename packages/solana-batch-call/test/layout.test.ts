import { describe, expect, it } from 'vitest'

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  METADATA_PROGRAM_ID,
  NATIVE_MINT,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  formatAmount,
  getAssociatedTokenAddress,
  getMetadataAddress,
  isAddress,
  parseMetaplexMetadata,
  parseMint,
  parseTokenAccount,
} from '../src/index.js'
import { metaplexData, mintData, tokenAccountData } from './mock.js'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const OWNER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
const AUTHORITY = 'BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG'

describe('地址', () => {
  it('内置程序地址都是合法的 32 字节地址', () => {
    for (const id of [SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, METADATA_PROGRAM_ID, NATIVE_MINT]) {
      expect(isAddress(id)).toBe(true)
    }
  })

  it('PDA / ATA 推导与主网实际地址一致', () => {
    // 2026-10 主网实测：USDC 的 Metaplex 元数据账户、OWNER 的 USDC ATA
    expect(getMetadataAddress(USDC)).toBe('5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq')
    expect(getAssociatedTokenAddress(OWNER, USDC, TOKEN_PROGRAM_ID)).toBe('FzbcyEZ9m8xjtergWgWDq7mfPoHEbboBF791B6cTpzbq')
  })

  it('isAddress', () => {
    expect(isAddress(USDC)).toBe(true)
    expect(isAddress('0x1234')).toBe(false)
    expect(isAddress('not-base58-0OIl')).toBe(false)
    expect(isAddress(123)).toBe(false)
  })
})

describe('账户解析', () => {
  it('Mint（SPL Token）', () => {
    const info = parseMint(mintData({ decimals: 6, supply: 123_000_000n, mintAuthority: AUTHORITY }))
    expect(info).toMatchObject({ decimals: 6, supply: 123_000_000n, mintAuthority: AUTHORITY, freezeAuthority: null, isInitialized: true, metadata: null })
  })

  it('Mint（Token-2022，TokenMetadata 扩展，跳过前面的其他扩展）', () => {
    const info = parseMint(mintData({ decimals: 6, metadata: { name: 'PayPal USD', symbol: 'PYUSD', uri: 'https://x' } }))
    expect(info.metadata).toEqual({ name: 'PayPal USD', symbol: 'PYUSD', uri: 'https://x' })
  })

  it('代币账户', () => {
    expect(parseTokenAccount(tokenAccountData(USDC, OWNER, 42n))).toEqual({ mint: USDC, owner: OWNER, amount: 42n })
    expect(() => parseTokenAccount(new Uint8Array(10))).toThrow()
  })

  it('Metaplex 元数据：去掉补齐的 \\0，解析集合、创作者、标准', () => {
    const meta = parseMetaplexMetadata(
      metaplexData({
        mint: USDC,
        name: 'Mad Lad #1',
        symbol: 'MAD',
        uri: 'https://meta/1.json',
        sellerFeeBasisPoints: 420,
        creators: [{ address: AUTHORITY, verified: true, share: 100 }],
        isMutable: true,
        tokenStandard: 4,
        collection: { address: OWNER, verified: true },
      }),
    )
    expect(meta).toMatchObject({
      mint: USDC,
      name: 'Mad Lad #1',
      symbol: 'MAD',
      uri: 'https://meta/1.json',
      sellerFeeBasisPoints: 420,
      isMutable: true,
      tokenStandard: 4,
      collection: { address: OWNER, verified: true },
    })
    expect(meta.creators).toEqual([{ address: AUTHORITY, verified: true, share: 100 }])
  })

  it('老版本 Metaplex 账户（缺少后面的字段）也能解析', () => {
    const meta = parseMetaplexMetadata(metaplexData({ mint: USDC, name: 'Old', symbol: 'OLD', legacy: true }))
    expect(meta).toMatchObject({ name: 'Old', symbol: 'OLD', collection: null, tokenStandard: null })
  })

  it('formatAmount', () => {
    expect(formatAmount(1_500_000_000n, 9)).toBe('1.5')
    expect(formatAmount(1n, 9)).toBe('0.000000001')
    expect(formatAmount(0n, 6)).toBe('0')
    expect(formatAmount(1_000_000n, 6)).toBe('1')
  })
})
