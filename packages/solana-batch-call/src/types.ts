export type Commitment = 'processed' | 'confirmed' | 'finalized'

/** balances() 的单项结果，字段都是字符串 / 数字 / 布尔 / null，可以直接 JSON.stringify */
export interface TokenBalance {
  /** 代币的 mint（原样） */
  token: string
  /** 是否按原生 SOL 查询 */
  native: boolean
  /** 余额（最小单位的十进制字符串）；需要计算时用 BigInt(balance) */
  balance: string
  decimals: number
  /** 按 decimals 换算后的十进制字符串，如 "1234.5"；整数不带小数点 */
  formatted: string
  /** 代币所属程序（SPL Token / Token-2022）；主币或未知时为 null */
  tokenProgram: string | null
  /** 仅在 symbol: true 时返回；读不到时为 null */
  symbol?: string | null
  /** 查询失败（mint 不存在、地址非法等）时为 false，balance / formatted 为 "0" */
  success: boolean
}

/** ownerTokens() / getOwnerTokens() 的单项结果 */
export interface OwnedToken extends Omit<TokenBalance, 'symbol'> {
  /** 该代币的代币账户数量；大于 1 时 balance 为所有账户的合计 */
  accounts: number
  /** metadata 为 true（默认）时返回；没有元数据或读取失败时为 null（见 metadataStatus） */
  name?: string | null
  symbol?: string | null
  /** metadata 为 true 时返回：ok 读到了；missing 确认没有元数据；failed 节点问题没能读到（可以稍后单独用 getTokens 重查） */
  metadataStatus?: 'ok' | 'missing' | 'failed'
}

export interface SolBalance {
  address: string
  /** lamports（十进制字符串） */
  balance: string
  /** 按 9 位精度换算后的 SOL */
  formatted: string
  success: boolean
}

/** tokens() / getTokens() 可选的字段 */
export type TokenField = 'name' | 'symbol' | 'uri' | 'decimals' | 'supply' | 'tokenProgram' | 'mintAuthority' | 'freezeAuthority'

export const DEFAULT_TOKEN_FIELDS = ['name', 'symbol', 'decimals'] as const satisfies readonly TokenField[]

export type DefaultTokenField = (typeof DEFAULT_TOKEN_FIELDS)[number]

interface TokenFieldTypes {
  /** 优先取 Token-2022 TokenMetadata 扩展，其次 Metaplex 元数据 */
  name: string | null
  symbol: string | null
  uri: string | null
  decimals: number | null
  /** 最小单位的十进制字符串 */
  supply: string | null
  tokenProgram: string | null
  /** 没有 mint 权限（已放弃）时为 null */
  mintAuthority: string | null
  freezeAuthority: string | null
}

/**
 * tokens() / getTokens() 的单项结果，只包含请求的字段。
 * 请求 supply 时额外带 supplyFormatted（按 decimals 换算）。
 */
export type TokenDetails<F extends TokenField = DefaultTokenField> = {
  /** mint 地址 */
  address: string
  native: boolean
  /** mint 存在且请求的 name / symbol / uri / decimals / supply 都读到时为 true */
  success: boolean
} & { [K in F]: TokenFieldTypes[K] } & ('supply' extends F ? { supplyFormatted: string | null } : unknown)

export type TokenStandard =
  | 'NonFungible'
  | 'FungibleAsset'
  | 'Fungible'
  | 'NonFungibleEdition'
  | 'ProgrammableNonFungible'
  | 'ProgrammableNonFungibleEdition'

/** nfts() / getNfts() 的单项结果（Metaplex 元数据；Token-2022 NFT 只有 name / symbol / uri） */
export interface NftDetails {
  mint: string
  name: string | null
  symbol: string | null
  /** 链下元数据 JSON 的地址 */
  uri: string | null
  /** 所属集合；verified 为 false 表示未经集合方签名确认 */
  collection: { address: string; verified: boolean } | null
  creators: Array<{ address: string; verified: boolean; share: number }>
  /** 版税，万分比 */
  sellerFeeBasisPoints: number | null
  tokenStandard: TokenStandard | null
  isMutable: boolean | null
  updateAuthority: string | null
  success: boolean
}

export interface NftOwner {
  mint: string
  /** 持有人钱包地址 */
  owner: string | null
  /** 持有该 NFT 的代币账户 */
  tokenAccount: string | null
  success: boolean
}
