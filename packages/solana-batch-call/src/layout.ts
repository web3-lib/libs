import { encodeAddress } from './address.js'

/** getMultipleAccounts 解析后的账户 */
export interface AccountInfo {
  address: string
  lamports: bigint
  /** 所属程序 */
  owner: string
  data: Uint8Array
  executable: boolean
}

class Reader {
  #offset: number
  readonly #view: DataView

  constructor(
    readonly bytes: Uint8Array,
    offset = 0,
  ) {
    this.#offset = offset
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get offset(): number {
    return this.#offset
  }

  #need(n: number): void {
    if (this.#offset + n > this.bytes.length) {
      throw new RangeError('Account data is shorter than expected')
    }
  }

  skip(n: number): void {
    this.#need(n)
    this.#offset += n
  }

  u8(): number {
    this.#need(1)
    return this.bytes[this.#offset++] as number
  }

  u16(): number {
    this.#need(2)
    const v = this.#view.getUint16(this.#offset, true)
    this.#offset += 2
    return v
  }

  u32(): number {
    this.#need(4)
    const v = this.#view.getUint32(this.#offset, true)
    this.#offset += 4
    return v
  }

  u64(): bigint {
    this.#need(8)
    const v = this.#view.getBigUint64(this.#offset, true)
    this.#offset += 8
    return v
  }

  pubkey(): string {
    this.#need(32)
    const v = encodeAddress(this.bytes.slice(this.#offset, this.#offset + 32))
    this.#offset += 32
    return v
  }

  /** borsh string：u32 长度 + UTF-8；去掉 Metaplex 用来补齐长度的 \0 */
  string(): string {
    const len = this.u32()
    this.#need(len)
    const v = new TextDecoder().decode(this.bytes.slice(this.#offset, this.#offset + len))
    this.#offset += len
    return v.replace(/\0+$/, '').trim()
  }

  option<T>(read: () => T): T | null {
    return this.u8() === 1 ? read() : null
  }
}

export interface MintInfo {
  mintAuthority: string | null
  supply: bigint
  decimals: number
  isInitialized: boolean
  freezeAuthority: string | null
  /** Token-2022 TokenMetadata 扩展（如有） */
  metadata: TokenMetadata | null
}

export interface TokenMetadata {
  name: string
  symbol: string
  uri: string
}

const MINT_SIZE = 82
/** Token-2022 扩展从账户类型字节之后开始：基础布局补齐到 165（Account 的大小）+ 1 字节账户类型 */
const EXTENSIONS_OFFSET = 166
const EXTENSION_TOKEN_METADATA = 19

/** 解析 Mint 账户（SPL Token / Token-2022 通用，Token-2022 额外解析 TokenMetadata 扩展） */
export function parseMint(data: Uint8Array): MintInfo {
  if (data.length < MINT_SIZE) {
    throw new RangeError('Not a mint account')
  }
  const r = new Reader(data)
  const hasMintAuthority = r.u32() === 1
  const mintAuthority = r.pubkey()
  const supply = r.u64()
  const decimals = r.u8()
  const isInitialized = r.u8() === 1
  const hasFreezeAuthority = r.u32() === 1
  const freezeAuthority = r.pubkey()
  return {
    mintAuthority: hasMintAuthority ? mintAuthority : null,
    supply,
    decimals,
    isInitialized,
    freezeAuthority: hasFreezeAuthority ? freezeAuthority : null,
    metadata: data.length > EXTENSIONS_OFFSET ? parseTokenMetadataExtension(data) : null,
  }
}

function parseTokenMetadataExtension(data: Uint8Array): TokenMetadata | null {
  try {
    const r = new Reader(data, EXTENSIONS_OFFSET)
    while (r.offset + 4 <= data.length) {
      const type = r.u16()
      const length = r.u16()
      if (type === 0 && length === 0) {
        return null // 未初始化的填充
      }
      if (type === EXTENSION_TOKEN_METADATA) {
        const m = new Reader(data.slice(r.offset, r.offset + length))
        m.pubkey() // updateAuthority
        m.pubkey() // mint
        return { name: m.string(), symbol: m.string(), uri: m.string() }
      }
      r.skip(length)
    }
  } catch {
    // 扩展数据不完整：当作没有
  }
  return null
}

export interface TokenAccountInfo {
  mint: string
  owner: string
  amount: bigint
}

/** 解析代币账户（SPL Token / Token-2022 前 72 字节相同） */
export function parseTokenAccount(data: Uint8Array): TokenAccountInfo {
  if (data.length < 165) {
    throw new RangeError('Not a token account')
  }
  const r = new Reader(data)
  return { mint: r.pubkey(), owner: r.pubkey(), amount: r.u64() }
}

export interface MetaplexMetadata extends TokenMetadata {
  updateAuthority: string
  mint: string
  sellerFeeBasisPoints: number
  creators: Array<{ address: string; verified: boolean; share: number }>
  primarySaleHappened: boolean
  isMutable: boolean
  /** 0 NonFungible，1 FungibleAsset，2 Fungible，3 NonFungibleEdition，4 ProgrammableNonFungible，5 ProgrammableNonFungibleEdition */
  tokenStandard: number | null
  collection: { address: string; verified: boolean } | null
}

/** 解析 Metaplex Token Metadata 账户；老版本账户缺少后面的字段时，缺的部分为默认值 */
export function parseMetaplexMetadata(data: Uint8Array): MetaplexMetadata {
  const r = new Reader(data)
  if (r.u8() !== 4) {
    throw new RangeError('Not a Metaplex metadata account') // Key::MetadataV1 = 4
  }
  const updateAuthority = r.pubkey()
  const mint = r.pubkey()
  const name = r.string()
  const symbol = r.string()
  const uri = r.string()
  const sellerFeeBasisPoints = r.u16()
  const creators =
    r.option(() => {
      const count = r.u32()
      return Array.from({ length: count }, () => ({ address: r.pubkey(), verified: r.u8() === 1, share: r.u8() }))
    }) ?? []
  const result: MetaplexMetadata = {
    updateAuthority,
    mint,
    name,
    symbol,
    uri,
    sellerFeeBasisPoints,
    creators,
    primarySaleHappened: false,
    isMutable: false,
    tokenStandard: null,
    collection: null,
  }
  try {
    result.primarySaleHappened = r.u8() === 1
    result.isMutable = r.u8() === 1
    r.option(() => r.u8()) // editionNonce
    result.tokenStandard = r.option(() => r.u8())
    result.collection = r.option(() => {
      const verified = r.u8() === 1
      return { address: r.pubkey(), verified }
    })
  } catch {
    // 老版本账户没有这些字段
  }
  return result
}

/** 按精度格式化：formatAmount(1_500_000_000n, 9) === '1.5' */
export function formatAmount(value: bigint, decimals: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}
