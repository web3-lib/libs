import { decodeAddress, encodeAddress } from '../address.js'

/** 交易里的一个账户 */
export interface AccountMeta {
  pubkey: string
  isSigner: boolean
  isWritable: boolean
}

/** 一条指令（本库内部格式） */
export interface Instruction {
  programId: string
  keys: AccountMeta[]
  data: Uint8Array
}

type AddressLike = string | { toBase58(): string }

/**
 * 可以传入的指令格式：
 * - @solana/web3.js 的 TransactionInstruction（`{ programId: PublicKey, keys: [{ pubkey, isSigner, isWritable }], data: Buffer }`）
 * - @solana/kit 的 Instruction（`{ programAddress, accounts: [{ address, role }], data }`）
 * - 本库的 Instruction（地址都是 base58 字符串）
 */
export type InstructionInput =
  | { programId: AddressLike; keys: ReadonlyArray<{ pubkey: AddressLike; isSigner: boolean; isWritable: boolean }>; data?: Uint8Array }
  | { programAddress: string; accounts?: ReadonlyArray<{ address: string; role: number }>; data?: Uint8Array }

/** 单笔交易序列化后的大小上限（字节） */
export const PACKET_DATA_SIZE = 1232

/** 单笔交易最多锁定的账户数 */
export const MAX_ACCOUNT_LOCKS = 64

function toAddress(value: AddressLike): string {
  return typeof value === 'string' ? value : value.toBase58()
}

/** 统一成本库的指令格式；地址非法时抛错 */
export function normalizeInstruction(input: InstructionInput): Instruction {
  if ('programAddress' in input) {
    // @solana/kit 的 AccountRole：0 只读、1 可写、2 只读签名、3 可写签名
    const keys = (input.accounts ?? []).map((a) => ({ pubkey: a.address, isSigner: a.role >= 2, isWritable: (a.role & 1) === 1 }))
    return checked({ programId: input.programAddress, keys, data: input.data ?? new Uint8Array() })
  }
  const keys = input.keys.map((k) => ({ pubkey: toAddress(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable }))
  return checked({ programId: toAddress(input.programId), keys, data: input.data ? new Uint8Array(input.data) : new Uint8Array() })
}

function checked(ix: Instruction): Instruction {
  decodeAddress(ix.programId)
  ix.keys.forEach((k) => decodeAddress(k.pubkey))
  return ix
}

function compactU16(n: number): number[] {
  const out: number[] = []
  let rest = n
  for (;;) {
    const byte = rest & 0x7f
    rest >>= 7
    if (rest === 0) {
      out.push(byte)
      return out
    }
    out.push(byte | 0x80)
  }
}

/** 编译好的消息（legacy 格式） */
export interface CompiledMessage {
  /** 要签名的消息字节 */
  bytes: Uint8Array
  /** 需要签名的地址，按交易里的签名顺序（第一个是手续费支付者） */
  signers: string[]
  /** 所有账户（去重后） */
  accountKeys: string[]
  /** 可写账户（查优先费用时用） */
  writable: string[]
}

/**
 * 编译 legacy 消息：账户按 [可写签名, 只读签名, 可写非签名, 只读非签名] 排序，手续费支付者排第一；
 * 同一账户在多条指令里出现时，签名 / 可写取并集
 */
export function compileMessage(payer: string, instructions: readonly Instruction[], blockhash: string): CompiledMessage {
  const metas = new Map<string, { signer: boolean; writable: boolean; order: number }>()
  const add = (pubkey: string, signer: boolean, writable: boolean) => {
    const meta = metas.get(pubkey)
    if (meta) {
      meta.signer ||= signer
      meta.writable ||= writable
    } else {
      metas.set(pubkey, { signer, writable, order: metas.size })
    }
  }
  add(payer, true, true)
  for (const ix of instructions) {
    ix.keys.forEach((k) => add(k.pubkey, k.isSigner, k.isWritable))
    add(ix.programId, false, false)
  }
  const rank = (m: { signer: boolean; writable: boolean }) => (m.signer ? (m.writable ? 0 : 1) : m.writable ? 2 : 3)
  const keys = [...metas.entries()].sort(([a, x], [b, y]) => (a === payer ? -1 : b === payer ? 1 : rank(x) - rank(y) || x.order - y.order)).map(([key]) => key)
  const index = new Map(keys.map((k, i) => [k, i]))
  const count = (r: number) => keys.filter((k) => rank(metas.get(k) as { signer: boolean; writable: boolean }) === r).length
  const signers = keys.filter((k) => metas.get(k)?.signer)

  const out: number[] = [signers.length, count(1), count(3)]
  out.push(...compactU16(keys.length))
  keys.forEach((k) => out.push(...decodeAddress(k)))
  out.push(...decodeAddress(blockhash))
  out.push(...compactU16(instructions.length))
  for (const ix of instructions) {
    out.push(index.get(ix.programId) as number)
    out.push(...compactU16(ix.keys.length))
    ix.keys.forEach((k) => out.push(index.get(k.pubkey) as number))
    out.push(...compactU16(ix.data.length))
    out.push(...ix.data)
  }
  return { bytes: new Uint8Array(out), signers, accountKeys: keys, writable: keys.filter((k) => (metas.get(k) as { writable: boolean }).writable) }
}

/** 签名后的交易字节数（签名数 + 每个签名 64 字节 + 消息） */
export function transactionSize(message: CompiledMessage): number {
  return compactU16(message.signers.length).length + 64 * message.signers.length + message.bytes.length
}

/** 拼成完整的交易：signatures 与 message.signers 顺序一致；没有签名的位置填 0（模拟时用） */
export function serializeTransaction(message: Pick<CompiledMessage, 'bytes' | 'signers'>, signatures: ReadonlyArray<Uint8Array | null>): Uint8Array {
  const prefix = compactU16(message.signers.length)
  const out = new Uint8Array(prefix.length + 64 * message.signers.length + message.bytes.length)
  out.set(prefix, 0)
  signatures.forEach((sig, i) => sig && out.set(sig, prefix.length + 64 * i))
  out.set(message.bytes, prefix.length + 64 * message.signers.length)
  return out
}

function readCompactU16(bytes: Uint8Array, offset: number): [value: number, next: number] {
  let value = 0
  let o = offset
  for (let shift = 0; shift < 21; shift += 7) {
    const b = bytes[o++]
    if (b === undefined) throw new Error('Invalid transaction: truncated')
    value |= (b & 0x7f) << shift
    if (!(b & 0x80)) return [value, o]
  }
  throw new Error('Invalid transaction: bad length prefix')
}

/** 拆开完整交易：签名列表 + 消息字节 */
export function splitTransaction(bytes: Uint8Array): { signatures: Uint8Array[]; message: Uint8Array } {
  const [count, start] = readCompactU16(bytes, 0)
  const signatures: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    signatures.push(bytes.slice(start + 64 * i, start + 64 * (i + 1)))
  }
  const message = bytes.slice(start + 64 * count)
  if (signatures.some((s) => s.length !== 64) || message.length < 3) throw new Error('Invalid transaction: truncated')
  return { signatures, message }
}

/** 消息里需要签名的地址（前 numRequiredSignatures 个账户），legacy 和 v0 消息都支持 */
export function messageSigners(message: Uint8Array): string[] {
  const versioned = ((message[0] as number) & 0x80) !== 0
  const header = versioned ? 1 : 0
  const required = message[header] as number
  const [, keysStart] = readCompactU16(message, header + 3)
  return Array.from({ length: required }, (_, i) => encodeAddress(message.slice(keysStart + 32 * i, keysStart + 32 * (i + 1))))
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** 消息里的 recent blockhash（legacy 和 v0 消息都支持） */
export function messageBlockhash(message: Uint8Array): string {
  const header = ((message[0] as number) & 0x80) !== 0 ? 1 : 0
  const [keys, keysStart] = readCompactU16(message, header + 3)
  const start = keysStart + 32 * keys
  return encodeAddress(message.slice(start, start + 32))
}

/** 解析后的消息（legacy / v0） */
export interface ParsedMessage {
  version: 'legacy' | 0
  /** 需要的签名数 */
  signatures: number
  /** 消息里直接列出的账户 */
  staticKeys: string[]
  /** staticKeys 里可写的 */
  writable: string[]
  instructions: Array<{ programId: string; accounts: number[]; data: Uint8Array }>
  /** v0 的地址查找表：表地址 + 要用的可写 / 只读下标 */
  lookups: Array<{ table: string; writable: number[]; readonly: number[] }>
}

/** 解析 legacy / v0 消息；其他版本抛错 */
export function parseMessage(message: Uint8Array): ParsedMessage {
  const first = message[0] as number
  const versioned = (first & 0x80) !== 0
  if (versioned && (first & 0x7f) !== 0) {
    throw new Error(`Unsupported transaction version ${first & 0x7f} (only legacy and v0)`)
  }
  let o = versioned ? 1 : 0
  const byte = () => {
    const b = message[o++]
    if (b === undefined) throw new Error('Invalid transaction: truncated')
    return b
  }
  const take = (n: number) => {
    if (o + n > message.length) throw new Error('Invalid transaction: truncated')
    const out = message.slice(o, o + n)
    o += n
    return out
  }
  const compact = () => {
    const [value, next] = readCompactU16(message, o)
    o = next
    return value
  }
  const [required, readonlySigned, readonlyUnsigned] = [byte(), byte(), byte()]
  const keyCount = compact()
  const staticKeys = Array.from({ length: keyCount }, () => encodeAddress(take(32)))
  take(32) // blockhash
  const instructions = Array.from({ length: compact() }, () => {
    const program = byte()
    const accounts = Array.from({ length: compact() }, byte)
    const data = take(compact())
    const programId = staticKeys[program]
    if (programId === undefined) throw new Error('Invalid transaction: bad program index')
    return { programId, accounts, data }
  })
  const lookups = versioned
    ? Array.from({ length: compact() }, () => {
        const table = encodeAddress(take(32))
        const writable = Array.from({ length: compact() }, byte)
        const readonly = Array.from({ length: compact() }, byte)
        return { table, writable, readonly }
      })
    : []
  const writable = staticKeys.filter((_, i) => (i < required ? i < required - readonlySigned : i < keyCount - readonlyUnsigned))
  return { version: versioned ? 0 : 'legacy', signatures: required, staticKeys, writable, instructions, lookups }
}
