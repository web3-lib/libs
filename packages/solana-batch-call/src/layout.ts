import { Bytes } from './bytes.js'

/** getMultipleAccounts 解析后的账户 */
export interface AccountInfo {
  address: string
  lamports: bigint
  /** 所属程序 */
  owner: string
  data: Uint8Array
  executable: boolean
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
const ACCOUNT_SIZE = 165
/** Token-2022 带扩展的账户：基础布局补齐到 165（Account 的大小），第 165 字节是账户类型，之后是扩展 */
const ACCOUNT_TYPE_OFFSET = 165
const EXTENSIONS_OFFSET = 166
const ACCOUNT_TYPE_MINT = 1
const ACCOUNT_TYPE_ACCOUNT = 2
const EXTENSION_TRANSFER_FEE_CONFIG = 1
const EXTENSION_TOKEN_METADATA = 19

/** 解析 Mint 账户（SPL Token / Token-2022 通用，Token-2022 额外解析 TokenMetadata 扩展） */
export function parseMint(data: Uint8Array): MintInfo {
  // 只接受真正的 mint：SPL Token 恰好 82 字节；Token-2022 带扩展时账户类型必须是 Mint（避免把代币账户 / 多签账户当成 mint）
  if (data.length !== MINT_SIZE && !(data.length > ACCOUNT_TYPE_OFFSET && data[ACCOUNT_TYPE_OFFSET] === ACCOUNT_TYPE_MINT)) {
    throw new RangeError('Not a mint account')
  }
  const r = new Bytes(data)
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

/** 在 Token-2022 账户的扩展（TLV：u16 类型 + u16 长度 + 数据）里找指定类型，返回其数据；没有或数据不完整时为 null（包内使用，不从主入口导出） */
export function findExtension(data: Uint8Array, extensionType: number): Uint8Array | null {
  if (data.length <= EXTENSIONS_OFFSET) {
    return null
  }
  try {
    const r = new Bytes(data, EXTENSIONS_OFFSET)
    while (r.offset + 4 <= data.length) {
      const type = r.u16()
      const length = r.u16()
      if (type === 0 && length === 0) {
        return null // 未初始化的填充
      }
      if (type === extensionType) {
        if (r.offset + length > data.length) {
          return null
        }
        return data.slice(r.offset, r.offset + length)
      }
      r.skip(length)
    }
  } catch {
    // 扩展数据不完整：当作没有
  }
  return null
}

function parseTokenMetadataExtension(data: Uint8Array): TokenMetadata | null {
  const ext = findExtension(data, EXTENSION_TOKEN_METADATA)
  if (!ext) {
    return null
  }
  try {
    const m = new Bytes(ext)
    m.pubkey() // updateAuthority
    m.pubkey() // mint
    return { name: m.string(), symbol: m.string(), uri: m.string() }
  } catch {
    return null
  }
}

/** Token-2022 转账手续费的一套配置：从 epoch 开始生效，费率 basisPoints（万分比），单笔最多 maximumFee（最小单位） */
export interface TransferFeeInfo {
  epoch: bigint
  maximumFee: bigint
  basisPoints: number
}

/** Token-2022 TransferFeeConfig 扩展 */
export interface TransferFeeConfigInfo {
  /** 可以修改手续费的地址；null 表示不能再改 */
  transferFeeConfigAuthority: string | null
  withdrawWithheldAuthority: string | null
  /** mint 上暂存的、已收取未提取的手续费 */
  withheldAmount: bigint
  /** 旧配置：当前 epoch < newer.epoch 时生效 */
  older: TransferFeeInfo
  /** 新配置：从 newer.epoch 起生效 */
  newer: TransferFeeInfo
}

const ZERO_PUBKEY = '11111111111111111111111111111111'

/**
 * 解析 mint 账户里的 Token-2022 TransferFeeConfig 扩展（类型 1，108 字节）；
 * SPL Token、没有这个扩展或数据不完整时为 null。
 * 当前生效的是 `epoch >= newer.epoch ? newer : older`
 */
export function parseTransferFeeConfig(data: Uint8Array): TransferFeeConfigInfo | null {
  if (!(data.length > ACCOUNT_TYPE_OFFSET && data[ACCOUNT_TYPE_OFFSET] === ACCOUNT_TYPE_MINT)) {
    return null
  }
  const ext = findExtension(data, EXTENSION_TRANSFER_FEE_CONFIG)
  if (!ext) {
    return null
  }
  try {
    const r = new Bytes(ext)
    // OptionalNonZeroPubkey：全 0 表示没有
    const configAuthority = r.pubkey()
    const withdrawAuthority = r.pubkey()
    const withheldAmount = r.u64()
    const fee = (): TransferFeeInfo => ({ epoch: r.u64(), maximumFee: r.u64(), basisPoints: r.u16() })
    const older = fee()
    const newer = fee()
    return {
      transferFeeConfigAuthority: configAuthority === ZERO_PUBKEY ? null : configAuthority,
      withdrawWithheldAuthority: withdrawAuthority === ZERO_PUBKEY ? null : withdrawAuthority,
      withheldAmount,
      older,
      newer,
    }
  } catch {
    return null
  }
}

export interface TokenAccountInfo {
  mint: string
  owner: string
  amount: bigint
}

function isTokenAccountData(data: Uint8Array): boolean {
  return data.length === ACCOUNT_SIZE || (data.length > ACCOUNT_TYPE_OFFSET && data[ACCOUNT_TYPE_OFFSET] === ACCOUNT_TYPE_ACCOUNT)
}

/** 解析代币账户（SPL Token / Token-2022 前 72 字节相同） */
export function parseTokenAccount(data: Uint8Array): TokenAccountInfo {
  if (!isTokenAccountData(data)) {
    throw new RangeError('Not a token account')
  }
  const r = new Bytes(data)
  return { mint: r.pubkey(), owner: r.pubkey(), amount: r.u64() }
}

/** 代币账户的完整基础布局（前 165 字节，SPL Token / Token-2022 相同） */
export interface TokenAccountState extends TokenAccountInfo {
  delegate: string | null
  /** 0 未初始化、1 正常、2 冻结 */
  state: number
  frozen: boolean
  /** Wrapped SOL 账户（is_native 有值） */
  native: boolean
  delegatedAmount: bigint
  closeAuthority: string | null
}

/** 解析代币账户的完整基础布局；不是代币账户或未初始化时为 null（包内使用：/approvals、/simulate） */
export function parseTokenAccountState(data: Uint8Array): TokenAccountState | null {
  if (!isTokenAccountData(data)) {
    return null
  }
  const b = new Bytes(data)
  const state = b.u8(108)
  if (state === 0) {
    return null
  }
  // COption：u32 标记（1 有、0 没有）+ 值
  return {
    mint: b.key(0),
    owner: b.key(32),
    amount: b.u64(64),
    delegate: b.u32(72) === 1 ? b.key(76) : null,
    state,
    frozen: state === 2,
    native: b.u32(109) === 1,
    delegatedAmount: b.u64(121),
    closeAuthority: b.u32(129) === 1 ? b.key(133) : null,
  }
}

/** 计算预算指令里的计算单元上限（SetComputeUnitLimit）和单价（SetComputeUnitPrice，micro-lamports）；没有时 limit 为 null、price 为 0 */
export function computeBudgetOf(instructions: Iterable<{ programId: string; data: Uint8Array }>): { limit: number | null; price: bigint } {
  let limit: number | null = null
  let price = 0n
  for (const ix of instructions) {
    if (ix.programId !== COMPUTE_BUDGET_PROGRAM) continue
    const b = new Bytes(ix.data)
    if (ix.data[0] === 2 && ix.data.length >= 5) limit = b.u32(1)
    if (ix.data[0] === 3 && ix.data.length >= 9) price = b.u64(1)
  }
  return { limit, price }
}

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'

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
  const r = new Bytes(data)
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

/** 按精度格式化（与 ethers 的 formatUnits 同名同义）：formatUnits(1_500_000_000n, 9) === '1.5'；不四舍五入，整数不带小数点 */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/**
 * formatUnits 的逆运算（与 ethers 的 parseUnits 同名同义）：parseUnits('1.5', 9) === 1_500_000_000n。
 * 小数位超过精度时报错（不四舍五入；多出的只有 0 时允许）
 */
export function parseUnits(value: string, decimals: number): bigint {
  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(value.trim())
  if (!match || (!match[2] && !match[3])) {
    throw new Error(`Invalid amount: ${JSON.stringify(value)}`)
  }
  const fraction = match[3] ?? ''
  if (/[1-9]/.test(fraction.slice(decimals))) {
    throw new Error(`Too many decimals: ${value} (max ${decimals})`)
  }
  const amount = BigInt((match[2] || '0') + fraction.slice(0, decimals).padEnd(decimals, '0'))
  return match[1] ? -amount : amount
}

/**
 * 同 formatUnits。
 * @deprecated 改用 formatUnits：formatAmount 这个名字容易和项目里的数字展示函数撞名
 */
export const formatAmount = formatUnits
