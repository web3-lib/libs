/** Tron 交易的 protobuf 编码、签名与签名器解析（私钥 / ethers Wallet / 自定义签名 / tronWeb / TronWallet adapter） */
import { Signature, SigningKey, computeAddress, getBytes, hexlify, toBeHex, toUtf8Bytes } from 'ethers'

import { isTronAddress, toEvmAddress, toTronAddress } from '../../tron.js'
import { isPrivateKey, type SignerInput, type TronSigner } from '../signer.js'

/** 要签名的交易 */
export interface Unsigned {
  txId: string
  /** raw_data 的 protobuf 编码 */
  raw: Uint8Array
  contract: TronContract
  ref: RefBlock
  expiration: number
  timestamp: number
  feeLimit: bigint
}

export interface TronKey {
  /** T 开头的地址 */
  address: string
  /** 浏览器钱包（签名要用户确认，交易过期时间放宽） */
  wallet: boolean
  /** 返回 65 字节签名的十六进制（不带 0x） */
  sign(tx: Unsigned): Promise<string>
}

/** 注入的 tronWeb（TronLink / OKX 等浏览器钱包）：只用到这两个字段 */
interface TronWebSignerLike {
  defaultAddress?: { base58?: string | boolean }
  trx: { sign(transaction: unknown): Promise<{ signature?: string[] }> }
}

/** @tronweb3/tronwallet-adapter 的 adapter */
interface TronAdapterLike {
  address: string | null
  signTransaction(transaction: unknown): Promise<{ signature?: string[] }>
}

/**
 * TronWeb 格式的交易 JSON（钱包按 raw_data 展示交易内容，按 raw_data_hex / txID 签名）。
 * raw_data 与 encodeRawData 的编码一一对应（TronWeb 的 txJsonToPb 编码结果与 raw_data_hex 相同）
 */
export function toTronWebTransaction(tx: Pick<Unsigned, 'txId' | 'raw' | 'contract' | 'ref' | 'expiration' | 'timestamp' | 'feeLimit'>): Record<string, unknown> {
  const c = tx.contract
  const sun = (value: bigint) => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount too large for a wallet-signed transaction')
    return Number(value)
  }
  const value =
    c.type === 'transfer'
      ? { owner_address: toTronHex(c.owner), to_address: toTronHex(c.to), amount: sun(c.amount) }
      : { data: c.data.replace(/^0x/, ''), owner_address: toTronHex(c.owner), contract_address: toTronHex(c.contract), ...(c.callValue ? { call_value: sun(c.callValue) } : {}) }
  const type = c.type === 'transfer' ? 'TransferContract' : 'TriggerSmartContract'
  const number = new Uint8Array(8)
  new DataView(number.buffer).setBigUint64(0, BigInt(tx.ref.number))
  return {
    visible: false,
    txID: tx.txId,
    raw_data: {
      contract: [{ parameter: { value, type_url: `type.googleapis.com/protocol.${type}` }, type }],
      ref_block_bytes: hexlify(number.slice(6, 8)).slice(2),
      ref_block_hash: tx.ref.hash.slice(16, 32),
      expiration: tx.expiration,
      timestamp: tx.timestamp,
      ...(c.type === 'trigger' && tx.feeLimit ? { fee_limit: sun(tx.feeLimit) } : {}),
    },
    raw_data_hex: hexlify(tx.raw).slice(2),
  }
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/**
 * 外部签名（钱包 / 自定义签名器）的核对和规范化：65 字节 r、s、v；v 可以是 0/1 或 27/28；
 * s 在上半区（旧版 TronWeb 等不做规范化的实现约一半是这样）时换成 n − s 并翻转 v（同一个签名的另一种写法，java-tron 两种都接受）。
 * 从签名恢复出的地址必须是发送方：钱包切了账户、或改了交易内容时对不上
 */
export function checkedSignature(signature: unknown, txId: string, address: string, who = 'Signer'): string {
  const hex = typeof signature === 'string' ? signature.replace(/^0x/, '') : ''
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) {
    throw new Error(`${who} did not return a 65-byte signature`)
  }
  let s = BigInt(`0x${hex.slice(64, 128)}`)
  let v = Number.parseInt(hex.slice(128), 16)
  if (v < 27) v += 27
  if ((v !== 27 && v !== 28) || s === 0n || s >= SECP256K1_N) {
    throw new Error(`${who} returned an invalid signature`)
  }
  if (s > SECP256K1_N / 2n) {
    s = SECP256K1_N - s
    v = v === 27 ? 28 : 27
  }
  let normalized: Signature
  let signer: string
  try {
    normalized = Signature.from({ r: `0x${hex.slice(0, 64)}`, s: toBeHex(s, 32), v })
    signer = toTronAddress(computeAddress(SigningKey.recoverPublicKey(`0x${txId}`, normalized)))
  } catch {
    throw new Error(`${who} returned an invalid signature`)
  }
  if (signer !== address) {
    throw new Error(`${who} signed with ${signer}, expected ${address}${who === 'Wallet' ? ' (switched account?)' : ''}`)
  }
  return normalized.serialized.slice(2)
}

function walletSignature(signed: { signature?: string[] } | null | undefined, tx: Unsigned, address: string): string {
  return checkedSignature(signed?.signature?.[signed.signature.length - 1], tx.txId, address, 'Wallet')
}

/** 同一个钱包的签名请求排队：钱包同时只能处理一个确认窗口（过期重发时可能和主流程同时请求） */
const walletQueues = new WeakMap<object, Promise<unknown>>()

function queued<T>(owner: object, task: () => Promise<T>): Promise<T> {
  const run = (walletQueues.get(owner) ?? Promise.resolve()).then(task, task)
  walletQueues.set(
    owner,
    run.catch(() => {}),
  )
  return run
}

/** 用户在钱包里拒绝签名（不是节点拒绝，见 write/rpc.ts 的 isNodeRejection） */
export function isUserRejection(err: unknown): boolean {
  const text = typeof err === 'string' ? err : `${String((err as { name?: unknown } | null)?.name ?? '')} ${String((err as { message?: unknown } | null)?.message ?? '')}`
  return (err as { code?: unknown } | null)?.code === 4001 || /reject|denied|cancel|declined/i.test(text)
}

export function resolveTronSigner(input: SignerInput, cache: Map<unknown, Promise<TronKey>>): Promise<TronKey> {
  let resolved = cache.get(input)
  if (!resolved) {
    resolved = (async (): Promise<TronKey> => {
      const fromKey = (key: SigningKey): TronKey => ({ address: toTronAddress(computeAddress(key.publicKey)), wallet: false, sign: async (tx) => key.sign(`0x${tx.txId}`).serialized.slice(2) })
      if (typeof input === 'string') {
        if (!isPrivateKey(input)) {
          throw new Error('Invalid private key: expected 32 bytes of hex')
        }
        return fromKey(new SigningKey(input.startsWith('0x') ? input : `0x${input}`))
      }
      const signingKey = (input as { signingKey?: unknown }).signingKey
      if (signingKey instanceof SigningKey) {
        return fromKey(signingKey)
      }
      const custom = input as Partial<TronSigner>
      if (typeof custom.address === 'string' && typeof custom.signDigest === 'function') {
        const sign = custom.signDigest.bind(custom)
        const address = canonical(custom.address)
        return { address, wallet: false, sign: async (tx) => checkedSignature(await sign(`0x${tx.txId}`), tx.txId, address) }
      }
      // 浏览器钱包：注入的 tronWeb（TronLink / OKX 等）
      const tronWeb = input as Partial<TronWebSignerLike>
      if (typeof tronWeb.trx?.sign === 'function') {
        const address = tronWeb.defaultAddress?.base58
        if (typeof address !== 'string' || !address) {
          throw new Error('Wallet is not connected (tronWeb.defaultAddress is empty)')
        }
        const trx = tronWeb.trx
        return { address, wallet: true, sign: (tx) => queued(tronWeb, async () => walletSignature(await trx.sign(toTronWebTransaction(tx)), tx, address)) }
      }
      // @tronweb3/tronwallet-adapter 的 adapter（ethers 的 Signer 有 getAddress，不会走到这里）
      const adapter = input as Partial<TronAdapterLike> & { getAddress?: unknown }
      if (typeof adapter.signTransaction === 'function' && 'address' in adapter && typeof adapter.getAddress !== 'function') {
        const address = adapter.address
        if (!address) {
          throw new Error('Wallet is not connected')
        }
        const target = adapter as TronAdapterLike
        return { address: canonical(address), wallet: true, sign: (tx) => queued(target, async () => walletSignature(await target.signTransaction(toTronWebTransaction(tx)), tx, canonical(address))) }
      }
      throw new Error('Invalid Tron signer: expected a private key, an ethers Wallet, { address, signDigest }, tronWeb or a TronWallet adapter')
    })()
    cache.set(input, resolved)
  }
  return resolved
}

/** 签名器的地址（T 地址），不发交易、不弹钱包 */
export async function tronSignerAddress(input: SignerInput): Promise<string> {
  return (await resolveTronSigner(input, new Map())).address
}

// ---- 交易编码（protobuf） ----

function varint(value: bigint | number): number[] {
  let v = BigInt(value)
  const out: number[] = []
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  out.push(Number(v))
  return out
}

/** proto3：默认值（0 / 空）不写 */
const varintField = (field: number, value: bigint | number) => (BigInt(value) === 0n ? [] : [...varint((field << 3) | 0), ...varint(value)])
const bytesField = (field: number, bytes: ArrayLike<number>) => (bytes.length === 0 ? [] : [...varint((field << 3) | 2), ...varint(bytes.length), ...Array.from(bytes)])

/** 21 字节地址（0x41 + 20 字节） */
function addressBytes(address: string): Uint8Array {
  return getBytes(`0x41${toEvmAddress(address).slice(2)}`)
}

export type TronContract =
  | { type: 'transfer'; owner: string; to: string; amount: bigint }
  | { type: 'trigger'; owner: string; contract: string; data: string; callValue: bigint }

/** int64 字段：0 ≤ v < 2^63（负数或更大的值编出来是畸形或语义不同的交易） */
function int64(value: bigint, name: string): bigint {
  if (value < 0n || value >= 2n ** 63n) throw new Error(`${name} out of range: ${value}`)
  return value
}

function encodeContract(c: TronContract): number[] {
  if (c.type === 'transfer') int64(c.amount, 'amount')
  else int64(c.callValue, 'value')
  const param =
    c.type === 'transfer'
      ? [...bytesField(1, addressBytes(c.owner)), ...bytesField(2, addressBytes(c.to)), ...varintField(3, c.amount)]
      : [...bytesField(1, addressBytes(c.owner)), ...bytesField(2, addressBytes(c.contract)), ...varintField(3, c.callValue), ...bytesField(4, getBytes(c.data))]
  const typeUrl = `type.googleapis.com/protocol.${c.type === 'transfer' ? 'TransferContract' : 'TriggerSmartContract'}`
  const any = [...bytesField(1, toUtf8Bytes(typeUrl)), ...bytesField(2, param)]
  return [...varintField(1, c.type === 'transfer' ? 1 : 31), ...bytesField(2, any)]
}

export interface RefBlock {
  number: number
  hash: string
  timestamp: number
}

/** 交易的 raw_data：参考区块、过期时间、合约、时间戳、fee_limit（字段按编号顺序写，与节点重新序列化的结果一致，txID 才对得上） */
export function encodeRawData(contract: TronContract, ref: RefBlock, expiration: number, timestamp: number, feeLimit: bigint): Uint8Array {
  const number = new Uint8Array(8)
  new DataView(number.buffer).setBigUint64(0, BigInt(ref.number))
  return new Uint8Array([
    ...bytesField(1, number.slice(6, 8)),
    ...bytesField(4, getBytes(`0x${ref.hash}`).slice(8, 16)),
    ...varintField(8, expiration),
    ...bytesField(11, encodeContract(contract)),
    ...varintField(14, timestamp),
    ...varintField(18, int64(feeLimit, 'fee_limit')),
  ])
}

/** 签名后的完整交易：Transaction { raw_data = 1; signature = 2 } */
export function encodeTransaction(raw: Uint8Array, signature: string): Uint8Array {
  return new Uint8Array([...bytesField(1, raw), ...bytesField(2, getBytes(`0x${signature}`))])
}

/** 0x / T / 41 开头的地址 → 41 开头的 hex（HTTP API 用） */
export function toTronHex(address: string): string {
  return `41${toEvmAddress(address).slice(2).toLowerCase()}`
}

/** 任意形式的地址 → 规范的 T 地址 */
export function canonical(address: string): string {
  return toTronAddress(toEvmAddress(address))
}

/** 是否是合法的收款地址（T 地址或 0x 地址） */
export function isRecipientAddress(address: string): boolean {
  return isTronAddress(address) || /^0x[0-9a-fA-F]{40}$/.test(address)
}
