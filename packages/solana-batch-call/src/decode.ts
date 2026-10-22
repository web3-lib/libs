/**
 * 指令解码（/simulate 和 /history 共用）：System、SPL Token / Token-2022、关联代币账户、计算预算、Memo、升级程序加载器，
 * 以及 programs.ts 里认得的 DEX / 聚合器（协议 + 指令名 + 大类）。其他程序只给程序名（认得时）和大类 contract / unknown
 */
import { encodeAddress } from './address.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants.js'
import { BPF_LOADER_UPGRADEABLE, COMPUTE_BUDGET, MEMO_V1, MEMO_V2, PROGRAMS, knownMethod, type IxType } from './programs.js'

export interface DecodedInstruction {
  /** 在交易里的下标（顶层指令） */
  index: number
  programId: string
  /** 程序名；不认识时为 null */
  program: string | null
  type: IxType
  protocol?: string
  method?: string
  summary: string
  /** 金额都是最小单位的十进制字符串 */
  args?: Record<string, unknown>
}

/** Token 的 SetAuthority 的权限类型 */
export const AUTHORITY_TYPES = [
  'MintTokens', 'FreezeAccount', 'AccountOwner', 'CloseAccount', 'TransferFeeConfig', 'WithheldWithdraw', 'CloseMint', 'InterestRate',
  'PermanentDelegate', 'ConfidentialTransferMint', 'TransferHookProgramId', 'ConfidentialTransferFeeConfig', 'MetadataPointer', 'GroupPointer', 'GroupMemberPointer',
] as const

const short = (a: string | undefined) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '?')

class Data {
  readonly view: DataView
  offset = 0
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  u8() {
    return this.view.getUint8(this.offset++)
  }
  u32() {
    const v = this.view.getUint32(this.offset, true)
    this.offset += 4
    return v
  }
  u64() {
    const v = this.view.getBigUint64(this.offset, true)
    this.offset += 8
    return v
  }
  key() {
    const v = encodeAddress(this.bytes.slice(this.offset, this.offset + 32))
    this.offset += 32
    return v
  }
}

/**
 * 解码一条指令。accounts 是指令用到的账户地址（已按指令里的下标解析，包含地址查找表里的），data 是指令数据。
 * 数据格式不对时不抛错，按“不认识的指令”返回
 */
export function decodeInstruction(index: number, programId: string, accounts: readonly string[], data: Uint8Array): DecodedInstruction {
  const info = PROGRAMS[programId]
  const base = { index, programId, program: info?.name ?? null }
  try {
    const decoded = decodeKnown(programId, accounts, data)
    if (decoded) return { ...base, ...decoded }
    const known = knownMethod(programId, data)
    if (known) {
      return { ...base, type: known[1], protocol: info?.protocol, method: known[0], summary: `${info?.protocol ?? info?.name} ${known[0]}` }
    }
  } catch {
    // 数据不符合格式：当作不认识
  }
  if (info) return { ...base, type: 'contract', protocol: info.protocol, summary: `Call ${info.name}` }
  return { ...base, type: 'unknown', summary: `Call unknown program ${short(programId)}` }
}

type Partial_ = Pick<DecodedInstruction, 'type' | 'summary'> & Partial<Pick<DecodedInstruction, 'method' | 'args' | 'protocol'>>

function decodeKnown(programId: string, a: readonly string[], data: Uint8Array): Partial_ | null {
  const d = new Data(data)
  switch (programId) {
    case SYSTEM_PROGRAM_ID:
      return decodeSystem(d, a)
    case TOKEN_PROGRAM_ID:
    case TOKEN_2022_PROGRAM_ID:
      return decodeToken(d, a)
    case ASSOCIATED_TOKEN_PROGRAM_ID: {
      const method = data.length === 0 || data[0] === 0 ? 'create' : data[0] === 1 ? 'createIdempotent' : 'recoverNested'
      return { type: 'setup', method, summary: `Create token account for ${short(a[2])}`, args: { payer: a[0], account: a[1], owner: a[2], mint: a[3] } }
    }
    case COMPUTE_BUDGET: {
      const tag = d.u8()
      if (tag === 2) return { type: 'budget', method: 'setComputeUnitLimit', summary: 'Set compute unit limit', args: { units: d.u32() } }
      if (tag === 3) return { type: 'budget', method: 'setComputeUnitPrice', summary: 'Set priority fee', args: { microLamports: d.u64().toString() } }
      return { type: 'budget', summary: 'Compute budget' }
    }
    case MEMO_V1:
    case MEMO_V2:
      return { type: 'memo', method: 'memo', summary: 'Memo', args: { text: new TextDecoder().decode(data) } }
    case BPF_LOADER_UPGRADEABLE: {
      const tag = d.u32()
      const method = ['initializeBuffer', 'write', 'deploy', 'upgrade', 'setAuthority', 'close', 'extendProgram', 'setAuthorityChecked'][tag]
      return { type: 'contract', method, summary: `Program loader: ${method ?? `instruction ${tag}`}`, args: { program: a[tag === 3 ? 1 : 0] } }
    }
    default:
      return null
  }
}

function decodeSystem(d: Data, a: readonly string[]): Partial_ {
  const tag = d.u32()
  switch (tag) {
    case 0: {
      const lamports = d.u64()
      const space = d.u64()
      return { type: 'setup', method: 'createAccount', summary: `Create account ${short(a[1])}`, args: { from: a[0], account: a[1], lamports: lamports.toString(), space: space.toString(), owner: d.key() } }
    }
    case 1: {
      const owner = d.key()
      return { type: 'approve', method: 'assign', summary: `Assign ${short(a[0])} to program ${short(owner)}`, args: { account: a[0], owner } }
    }
    case 2: {
      const lamports = d.u64()
      return { type: 'transfer', method: 'transfer', summary: `Transfer SOL to ${short(a[1])}`, args: { from: a[0], to: a[1], lamports: lamports.toString() } }
    }
    case 11: {
      const lamports = d.u64()
      return { type: 'transfer', method: 'transferWithSeed', summary: `Transfer SOL to ${short(a[2])}`, args: { from: a[0], to: a[2], lamports: lamports.toString() } }
    }
    case 5: {
      const lamports = d.u64()
      return { type: 'transfer', method: 'withdrawNonce', summary: `Withdraw nonce account to ${short(a[1])}`, args: { from: a[0], to: a[1], lamports: lamports.toString() } }
    }
    case 10:
      return { type: 'approve', method: 'assignWithSeed', summary: `Assign ${short(a[0])} to another program`, args: { account: a[0] } }
    default:
      return { type: 'setup', summary: 'System instruction', method: ['createAccount', 'assign', 'transfer', 'createAccountWithSeed', 'advanceNonce', 'withdrawNonce', 'initializeNonce', 'authorizeNonce', 'allocate', 'allocateWithSeed'][tag] }
  }
}

function decodeToken(d: Data, a: readonly string[]): Partial_ {
  const tag = d.u8()
  const amountArgs = (extra: Record<string, unknown>, amount: bigint) => ({ ...extra, amount: amount.toString() })
  switch (tag) {
    case 3: {
      const amount = d.u64()
      return { type: 'transfer', method: 'transfer', summary: `Transfer tokens to ${short(a[1])}`, args: amountArgs({ source: a[0], destination: a[1], authority: a[2] }, amount) }
    }
    case 12: {
      const amount = d.u64()
      return { type: 'transfer', method: 'transferChecked', summary: `Transfer tokens to ${short(a[2])}`, args: amountArgs({ source: a[0], mint: a[1], destination: a[2], authority: a[3] }, amount) }
    }
    case 26: {
      const sub = d.u8()
      if (sub === 1) {
        const amount = d.u64()
        return { type: 'transfer', method: 'transferCheckedWithFee', summary: `Transfer tokens to ${short(a[2])}`, args: amountArgs({ source: a[0], mint: a[1], destination: a[2], authority: a[3] }, amount) }
      }
      return { type: 'setup', method: 'transferFeeExtension', summary: 'Token-2022 transfer fee instruction' }
    }
    case 4: {
      const amount = d.u64()
      return { type: 'approve', method: 'approve', summary: `Approve ${short(a[1])} to spend tokens`, args: amountArgs({ account: a[0], delegate: a[1], owner: a[2] }, amount) }
    }
    case 13: {
      const amount = d.u64()
      return { type: 'approve', method: 'approveChecked', summary: `Approve ${short(a[2])} to spend tokens`, args: amountArgs({ account: a[0], mint: a[1], delegate: a[2], owner: a[3] }, amount) }
    }
    case 5:
      return { type: 'approve', method: 'revoke', summary: 'Revoke token delegate', args: { account: a[0], owner: a[1] } }
    case 6: {
      const authorityType = AUTHORITY_TYPES[d.u8()] ?? 'Unknown'
      const newAuthority = d.u8() === 1 ? d.key() : null
      return {
        type: 'approve',
        method: 'setAuthority',
        summary: newAuthority ? `Set ${authorityType} authority to ${short(newAuthority)}` : `Remove ${authorityType} authority`,
        args: { account: a[0], authorityType, newAuthority },
      }
    }
    case 7:
    case 14: {
      const amount = d.u64()
      return { type: 'mint', method: tag === 7 ? 'mintTo' : 'mintToChecked', summary: `Mint tokens to ${short(a[1])}`, args: amountArgs({ mint: a[0], destination: a[1] }, amount) }
    }
    case 8:
    case 15: {
      const amount = d.u64()
      return { type: 'burn', method: tag === 8 ? 'burn' : 'burnChecked', summary: 'Burn tokens', args: amountArgs({ account: a[0], mint: a[1] }, amount) }
    }
    case 9:
      return { type: 'close', method: 'closeAccount', summary: `Close token account ${short(a[0])}`, args: { account: a[0], destination: a[1], owner: a[2] } }
    case 17:
      return { type: 'setup', method: 'syncNative', summary: 'Sync wrapped SOL', args: { account: a[0] } }
    case 10:
    case 11:
      return { type: 'contract', method: tag === 10 ? 'freezeAccount' : 'thawAccount', summary: tag === 10 ? 'Freeze token account' : 'Thaw token account', args: { account: a[0] } }
    default:
      return { type: 'setup', summary: tag <= 25 ? 'Initialize token account / mint' : 'Token-2022 extension instruction' }
  }
}
