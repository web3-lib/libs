export type Commitment = 'processed' | 'confirmed' | 'finalized'

/**
 * tokenPrograms 参数的取值：简写 'spl'（SPL Token）/ 'token-2022'，也可以直接传程序地址
 * （TOKEN_PROGRAM_ID / TOKEN_2022_PROGRAM_ID）
 */
export type TokenProgramName = 'spl' | 'token-2022'
// (string & {})：保留 'spl' / 'token-2022' 的自动补全
export type TokenProgramOption = TokenProgramName | (string & {})

/**
 * 单项失败（success: false）的原因：
 * - invalid-address：地址格式非法（不是 base58 的 32 字节）
 * - not-found：地址合法，但链上没有这个账户（如 mint 不存在）
 * - not-token：账户存在，但不是代币 mint（或代币账户）
 * - no-metadata：代币存在，但没有元数据（nfts）
 * - no-holder：没有持有人（nftOwners：供应量为 0 或已销毁）
 * - missing-field：代币存在，但请求的字段读不到（tokens），见 errorField
 */
export type FailureReason = 'invalid-address' | 'not-found' | 'not-token' | 'no-metadata' | 'no-holder' | 'missing-field'

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
  /** 失败原因，仅 success 为 false 时返回 */
  error?: FailureReason
  /** 传了 withSlot / minContextSlot 时返回：读取时节点的 slot（一次查询发了多个请求时取最小的） */
  slot?: number
}

/** ownerTokens() / getOwnerTokens() 的单项结果（总是 success: true） */
export interface OwnedToken extends Omit<TokenBalance, 'symbol' | 'error'> {
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
  /** 失败原因（只有 invalid-address），仅 success 为 false 时返回 */
  error?: FailureReason
  /** 传了 withSlot / minContextSlot 时返回：读取时节点的 slot（多个请求时取最小的）；没有发请求（地址全部非法）时不返回 */
  slot?: number
}

/** tokens() / getTokens() 可选的字段 */
export type TokenField = 'name' | 'symbol' | 'uri' | 'decimals' | 'supply' | 'tokenProgram' | 'mintAuthority' | 'freezeAuthority' | 'transferFee'

/** Token-2022 转账手续费的一套配置 */
export interface TransferFee {
  /** 费率，万分比（100 = 1%） */
  basisPoints: number
  /** 单笔最多收取的手续费（最小单位的十进制字符串） */
  maximumFee: string
  /** 从这个 epoch 开始生效 */
  epoch: string
}

/**
 * tokens() 的 transferFee 字段：顶层是**当前 epoch** 生效的配置（按 getEpochInfo 选 newer / older），
 * older / newer 是扩展里的两套原始配置。收到的数量 = 转账数量 - min(数量 × basisPoints / 10000 向上取整, maximumFee)
 */
export interface TransferFeeConfig extends TransferFee {
  older: TransferFee
  newer: TransferFee
}

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
  /** Token-2022 转账手续费；SPL Token、没有这个扩展、主币时为 null（不算失败） */
  transferFee: TransferFeeConfig | null
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
  /** 失败原因，仅 success 为 false 时返回 */
  error?: FailureReason
  /** error 为 missing-field 时：第一个读不到的字段 */
  errorField?: F
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
  /** 失败原因，仅 success 为 false 时返回 */
  error?: FailureReason
}

export interface NftOwner {
  mint: string
  /** 持有人钱包地址 */
  owner: string | null
  /** 持有该 NFT 的代币账户 */
  tokenAccount: string | null
  success: boolean
  /** 失败原因，仅 success 为 false 时返回 */
  error?: FailureReason
}
