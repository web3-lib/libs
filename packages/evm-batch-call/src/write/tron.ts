import { Interface, Signature, SigningKey, computeAddress, getBytes, hexlify, parseUnits, sha256, toBeHex, toUtf8Bytes, toUtf8String, type BigNumberish } from 'ethers'

import type { EthersLikeProvider } from '../aggregate.js'
import { encodeCall } from '../call.js'
import { ERC20_ABI, NATIVE_TOKEN, formatUnits, type TokenBalance } from '../erc20.js'
import { decodeRevertReason } from '../errors.js'
import { errorText } from '../fallback.js'
import type { Provider } from '../provider.js'
import { TronProvider, isTronAddress, toEvmAddress, toTronAddress } from '../tron.js'
import type { BatchCallOptions, WriteCall } from './batch.js'
import type { BatchCollectOptions, CollectItemResult, CollectResult } from './collect.js'
import { runOnNodes } from './rpc.js'
import { emptyOutcome, mapPool, toWriteResult, type SendOptions, type TronSendOptions, type TxOutcome, type WriteResult } from './send.js'
import { isPrivateKey, type SignerInput, type TronSigner } from './signer.js'
import type { BatchTransferOptions, TransferItem, TransferResult } from './transfer.js'

const erc20Interface = new Interface(ERC20_ABI as unknown as string[])

/** 要签名的交易 */
interface Unsigned {
  txId: string
  /** raw_data 的 protobuf 编码 */
  raw: Uint8Array
  contract: TronContract
  ref: RefBlock
  expiration: number
  timestamp: number
  feeLimit: bigint
}

interface TronKey {
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

function isRejection(err: unknown): boolean {
  const text = typeof err === 'string' ? err : `${String((err as { name?: unknown } | null)?.name ?? '')} ${String((err as { message?: unknown } | null)?.message ?? '')}`
  return (err as { code?: unknown } | null)?.code === 4001 || /reject|denied|cancel|declined/i.test(text)
}

function resolveTronSigner(input: SignerInput, cache: Map<unknown, Promise<TronKey>>): Promise<TronKey> {
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

interface RefBlock {
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
function encodeTransaction(raw: Uint8Array, signature: string): Uint8Array {
  return new Uint8Array([...bytesField(1, raw), ...bytesField(2, getBytes(`0x${signature}`))])
}

// ---- 节点访问 ----

interface ChainParams {
  /** 每单位能量烧多少 sun */
  energyFee: bigint
  /** 每字节带宽烧多少 sun */
  bandwidthFee: bigint
  /** 转 TRX 给没激活的地址时的激活费（1 TRX） */
  newAccountFee: bigint
  /** 创建账户的带宽：质押带宽不够时烧的 TRX（0.1 TRX） */
  createAccountFee: bigint
}

/** 账户状态：余额和可用资源 */
interface Resources {
  exists: boolean
  balance: bigint
  /** 剩余免费带宽（没激活的账户没有） */
  free: number
  /** 剩余质押带宽 */
  staked: number
  /** 剩余能量（质押得到的） */
  energy: number
}

/**
 * 按 java-tron 的顺序用带宽：质押带宽够就用质押的，否则免费带宽够就用免费的，两者不能凑在一起用；都不够时整笔按字节烧 TRX。
 * 会扣减 r 里的剩余带宽，返回要烧的 sun
 */
function bandwidthBurn(r: { free: number; staked: number }, bytes: number, fee: bigint): bigint {
  if (r.staked >= bytes) {
    r.staked -= bytes
    return 0n
  }
  if (r.free >= bytes) {
    r.free -= bytes
    return 0n
  }
  return BigInt(bytes) * fee
}

/**
 * 转 TRX 的手续费：给没激活的地址转时，java-tron 按创建账户计费：激活费 + 创建账户的带宽（质押带宽够时用质押的，否则烧 createAccountFee），
 * 不再收普通带宽费，也不能用免费带宽；给已激活的地址转时按普通带宽。会扣减 r 里的剩余带宽，返回要烧的 sun
 */
function transferBurn(r: { free: number; staked: number }, bytes: number, params: ChainParams, activates: boolean): bigint {
  if (!activates) return bandwidthBurn(r, bytes, params.bandwidthFee)
  if (r.staked >= bytes) {
    r.staked -= bytes
    return params.newAccountFee
  }
  return params.newAccountFee + params.createAccountFee
}

/** 按预估能量（× 1.2 余量）扣减账户能量，返回要烧的 sun */
function energyBurn(r: { energy: number }, energy: number, fee: bigint): bigint {
  const need = Math.ceil(energy * 1.2)
  const burned = Math.max(0, need - r.energy)
  r.energy = Math.max(0, r.energy - need)
  return BigInt(burned) * fee
}

/** 带宽按交易字节数 + 64（节点给交易结果预留的大小）计 */
const RESULT_RESERVE = 64

class TronRpc {
  #ref: { at: number; value: Promise<RefBlock> } | null = null
  #params: Promise<ChainParams> | null = null
  /** 最近发出的交易 ID：同样内容、同一毫秒生成的交易 ID 相同，要错开 */
  readonly #recent = new Set<string>()

  constructor(
    readonly rpc: EthersLikeProvider,
    readonly options: SendOptions & TronSendOptions,
  ) {}

  request<T = any>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    return runOnNodes(this.rpc, path, async (node) => tronNode(node).request(path, body) as Promise<T>)
  }

  /** 参考区块（缓存 3 秒） */
  refBlock(fresh = false): Promise<RefBlock> {
    if (fresh || !this.#ref || Date.now() - this.#ref.at > 3_000) {
      const value = this.request('wallet/getblock', { detail: false })
        .catch(() => this.request('wallet/getnowblock'))
        .then((block: { blockID?: string; block_header?: { raw_data?: { number?: number; timestamp?: number } } }) => {
          const header = block?.block_header?.raw_data
          if (!block?.blockID || header?.number === undefined || header.timestamp === undefined) {
            throw new Error('Unable to read the latest Tron block')
          }
          return { number: header.number, hash: block.blockID, timestamp: header.timestamp }
        })
      value.catch(() => {
        if (this.#ref?.value === value) this.#ref = null
      })
      this.#ref = { at: Date.now(), value }
    }
    return this.#ref.value
  }

  params(): Promise<ChainParams> {
    this.#params ??= this.request<{ chainParameter?: Array<{ key: string; value?: number }> }>('wallet/getchainparameters').then((res) => {
      const map = new Map((res?.chainParameter ?? []).map((p) => [p.key, BigInt(p.value ?? 0)]))
      return {
        energyFee: map.get('getEnergyFee') ?? 210n,
        bandwidthFee: map.get('getTransactionFee') ?? 1000n,
        newAccountFee: map.get('getCreateNewAccountFeeInSystemContract') ?? 1_000_000n,
        createAccountFee: map.get('getCreateAccountFee') ?? 100_000n,
      }
    })
    this.#params.catch(() => (this.#params = null))
    return this.#params
  }

  async resources(address: string): Promise<Resources> {
    const hex = toTronHex(address)
    const [account, res] = await Promise.all([
      this.request<{ address?: string; balance?: number }>('wallet/getaccount', { address: hex }),
      this.request<Record<string, number>>('wallet/getaccountresource', { address: hex }),
    ])
    const n = (key: string) => Number(res?.[key] ?? 0)
    const exists = Boolean(account?.address)
    return {
      exists,
      balance: BigInt(account?.balance ?? 0),
      free: exists ? Math.max(0, n('freeNetLimit') - n('freeNetUsed')) : 0,
      staked: Math.max(0, n('NetLimit') - n('NetUsed')),
      energy: Math.max(0, n('EnergyLimit') - n('EnergyUsed')),
    }
  }

  readonly #exists = new Map<string, Promise<boolean>>()
  readonly #contracts = new Map<string, Promise<boolean>>()

  /** 账户是否已激活（转 TRX 给没激活的地址要付激活费） */
  accountExists(address: string): Promise<boolean> {
    let cached = this.#exists.get(address)
    if (!cached) {
      cached = this.request<{ address?: string }>('wallet/getaccount', { address: toTronHex(address) }).then((a) => Boolean(a?.address))
      cached.catch(() => this.#exists.delete(address))
      this.#exists.set(address, cached)
    }
    return cached
  }

  /** 地址是不是合约（主网禁止用 TransferContract 给合约转 TRX，要用合约调用带 call_value） */
  isContract(address: string): Promise<boolean> {
    let cached = this.#contracts.get(address)
    if (!cached) {
      cached = this.request<Record<string, unknown>>('wallet/getcontract', { value: toTronHex(address) }).then((c) => Boolean(c && (c.bytecode || c.contract_address)))
      cached.catch(() => this.#contracts.delete(address))
      this.#contracts.set(address, cached)
    }
    return cached
  }

  /**
   * 确认交易过期且没有上链：在同一个节点上先读固化的最新区块（时间要超过过期时间 + 60 秒），再查固化的交易信息。
   * 固化的数据不会回滚、也不会落后于先读到的那个区块；查询出错、节点返回错误时一律当作“不确定”（返回 false）
   */
  async expiredForSure(txId: string, expiration: number): Promise<boolean> {
    try {
      return await runOnNodes(this.rpc, 'walletsolidity', async (any) => {
        const node = tronNode(any)
        const block = await node.request('walletsolidity/getblock', { detail: false }).catch(() => node.request('walletsolidity/getnowblock'))
        const time = block?.block_header?.raw_data?.timestamp
        if (typeof time !== 'number' || time <= expiration + 60_000) return false
        const info = await node.request('walletsolidity/gettransactioninfobyid', { value: txId })
        if (!info || typeof info !== 'object' || 'Error' in info) return false
        return !info.id
      })
    } catch {
      return false
    }
  }

  /** 模拟合约调用：返回消耗的能量；revert 时抛出（带原因） */
  async simulate(c: Extract<TronContract, { type: 'trigger' }>): Promise<number> {
    const body: Record<string, unknown> = { owner_address: toTronHex(c.owner), contract_address: toTronHex(c.contract), data: c.data.replace(/^0x/, '') }
    if (c.callValue) body.call_value = Number(c.callValue)
    const res = await this.request('wallet/triggerconstantcontract', body)
    const result = res?.result ?? {}
    if (result.code || res?.transaction?.ret?.[0]?.ret === 'FAILED' || result.result === false) {
      const output = res?.constant_result?.[0]
      const reason = (output && decodeRevertReason(`0x${output}`)) || (typeof result.message === 'string' ? decodeHex(result.message) : '') || String(result.code ?? 'REVERT')
      throw new TronTxError(`execution reverted: ${reason}`)
    }
    return Number(res?.energy_used ?? 0)
  }

  /** 广播：'accepted'；交易本身的问题抛 TronTxError；节点出错（换了节点也不行）返回说明（交易可能已经发出） */
  async broadcast(signed: Uint8Array): Promise<'accepted' | { uncertain: string }> {
    let res: { result?: boolean; code?: string; message?: string }
    try {
      res = await this.request('wallet/broadcasthex', { transaction: hexlify(signed).slice(2) })
    } catch (err) {
      return { uncertain: `broadcast not acknowledged: ${errorText(err)}` }
    }
    if (res?.result || res?.code === 'DUP_TRANSACTION_ERROR') {
      return 'accepted'
    }
    const message = res?.message ? decodeHex(res.message) : ''
    const text = `${res?.code ?? (res as { Error?: string } | null)?.Error ?? 'unknown response'}${message ? `: ${message}` : ''}`
    // 只有交易本身的问题（签名、合约校验、带宽不够、太大）才确定没发出去。其余（TAPOS 参考区块对不上、节点忙、
    // 未固化等）可能只是这个节点的问题，而前一个超时的节点也许已经收下了这笔：按“不确定”继续跟踪，直到确认过期
    if (res?.code && FINAL_BROADCAST_CODES.has(res.code)) {
      throw new TronTxError(text)
    }
    return { uncertain: `broadcast not acknowledged: ${text}` }
  }

  remember(txId: string): boolean {
    if (this.#recent.has(txId)) return false
    this.#recent.add(txId)
    return true
  }
}

class TronTxError extends Error {}

function tronNode(node: EthersLikeProvider): TronProvider {
  if (!(node instanceof TronProvider)) throw new Error('Not a Tron node')
  return node
}

/** 确定交易没被收下的广播错误码 */
const FINAL_BROADCAST_CODES = new Set(['SIGERROR', 'CONTRACT_VALIDATE_ERROR', 'CONTRACT_EXE_ERROR', 'BANDWITH_ERROR', 'TOO_BIG_TRANSACTION_ERROR', 'TOO_BIG_TRANSACTION_RESULT_ERROR'])

function toTronHex(address: string): string {
  return `41${toEvmAddress(address).slice(2).toLowerCase()}`
}

function decodeHex(hex: string): string {
  try {
    return toUtf8String(`0x${hex}`)
  } catch {
    return hex
  }
}

// ---- 发送 ----

/** 交易过期时间：参考区块时间 + 60 秒 */
const EXPIRATION = 60_000
/** 浏览器钱包签名的交易：参考区块时间 + 3 分钟（用户确认需要时间） */
const WALLET_EXPIRATION = 180_000

interface TronJob {
  signer: TronKey
  contract: TronContract
  /** 合约调用的 fee_limit；不传时按模拟结果 */
  feeLimit?: bigint
  continueOnError?: boolean
  onUpdate(outcome: TxOutcome): void
}

interface TransactionInfo {
  id?: string
  fee?: number
  blockNumber?: number
  result?: string
  resMessage?: string
  contractResult?: string[]
  receipt?: { result?: string; energy_usage_total?: number }
}

/** 构造并签名交易；txID 与最近发出的重复时（同样内容、同一毫秒）错开时间戳 */
async function buildSigned(rpc: TronRpc, job: TronJob, feeLimit: bigint, fresh: boolean): Promise<{ txId: string; signed: Uint8Array; expiration: number }> {
  const ref = await rpc.refBlock(fresh)
  // 浏览器钱包要等用户确认，过期时间放宽
  const expiration = ref.timestamp + (job.signer.wallet ? WALLET_EXPIRATION : EXPIRATION)
  for (let timestamp = Date.now(); ; timestamp++) {
    const limit = job.contract.type === 'trigger' ? feeLimit : 0n
    const raw = encodeRawData(job.contract, ref, expiration, timestamp, limit)
    const txId = sha256(raw).slice(2)
    if (!rpc.remember(txId)) continue
    let signature: string
    try {
      signature = await job.signer.sign({ txId, raw, contract: job.contract, ref, expiration, timestamp, feeLimit: limit })
    } catch (err) {
      throw job.signer.wallet && isRejection(err) ? new Error('rejected by user') : err
    }
    return { txId, signed: encodeTransaction(raw, signature), expiration }
  }
}

/** 签名后交易的字节数（估算带宽）；参考区块等字段长度固定，用占位值即可 */
function transactionBytes(contract: TronContract, feeLimit: bigint): number {
  const raw = encodeRawData(contract, { number: 2 ** 40, hash: '00'.repeat(32), timestamp: 2 ** 41 }, 2 ** 41, 2 ** 41, contract.type === 'trigger' ? feeLimit : 0n)
  return encodeTransaction(raw, '00'.repeat(65)).length + RESULT_RESERVE
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** 按 fee_limit 选项或模拟的能量算 fee_limit */
async function feeLimitFor(rpc: TronRpc, job: TronJob, energy: number): Promise<bigint> {
  if (job.feeLimit !== undefined) return job.feeLimit
  if (rpc.options.feeLimit !== undefined) return rpc.options.feeLimit
  const { energyFee } = await rpc.params()
  const limit = (BigInt(Math.ceil(energy * 1.5)) * energyFee) || 1_000_000n
  return limit > 15_000_000_000n ? 15_000_000_000n : limit // 上限 15000 TRX
}

/**
 * 发送一批 Tron 交易：同一钱包按顺序发出（不等上一笔确认），不同钱包并发。Tron 没有 nonce，交易之间互不阻塞；
 * 合约调用先模拟，模拟失败且同一钱包还有未确认的交易时先等它们确认再模拟一次（先 approve 再调用的情况）
 */
async function sendTronJobs(rpc: TronRpc, jobs: readonly TronJob[], options: SendOptions & TronSendOptions): Promise<void> {
  const groups = new Map<string, TronJob[]>()
  jobs.forEach((job) => {
    const list = groups.get(job.signer.address)
    if (list) list.push(job)
    else groups.set(job.signer.address, [job])
  })
  await mapPool([...groups.values()], options.concurrency ?? 8, (list) => sendTronGroup(rpc, list, options))
}

async function sendTronGroup(rpc: TronRpc, jobs: readonly TronJob[], options: SendOptions & TronSendOptions): Promise<void> {
  const { signal, dryRun = false, wait = true, timeout = 180_000, pollInterval = 3_000, retries = 2 } = options
  const inFlight: Array<{ sent: boolean; watch: () => Promise<void> }> = []
  const settle = async () => {
    for (let seen = -1; seen !== inFlight.length; ) {
      seen = inFlight.length
      await Promise.all(inFlight.map((f) => f.watch()))
    }
  }
  let stopped = false
  const update = (job: TronJob, patch: Partial<TxOutcome> & { status: TxOutcome['status'] }) => {
    try {
      job.onUpdate({ ...emptyOutcome(patch.status), ...patch })
    } catch {
      // 调用方的进度回调出错不能打断发送
    }
  }
  /** 这个钱包的余额和资源（第一次发送前读一次，之后按每笔的预估花费扣减） */
  let account: Promise<Resources> | null = null
  /**
   * 发送前检查 TRX 够不够：Tron 上能量不够的合约调用照样上链、执行失败（OUT_OF_ENERGY）并烧掉 TRX，
   * 不像 EVM 那样在广播时就被拒。按每笔的金额 + 能量（× 1.2）+ 带宽 + 激活费累计；不够时返回原因
   */
  const shortOf = async (job: TronJob, energy: number, feeLimit: bigint): Promise<string | null> => {
    const r = await (account ??= rpc.resources(job.signer.address))
    if (!r.exists) return 'account is not activated (it needs to receive TRX first)'
    const params = await rpc.params()
    const next = { ...r }
    const bytes = transactionBytes(job.contract, feeLimit)
    let spend: bigint
    if (job.contract.type === 'trigger') {
      spend = bandwidthBurn(next, bytes, params.bandwidthFee) + energyBurn(next, energy, params.energyFee) + job.contract.callValue
    } else {
      spend = transferBurn(next, bytes, params, !(await rpc.accountExists(job.contract.to))) + job.contract.amount
    }
    if (next.balance < spend) return `insufficient TRX: this transaction needs about ${spend} sun (amount + fees), the wallet has ${next.balance} left`
    Object.assign(r, next, { balance: next.balance - spend })
    return null
  }

  /** 发出一笔（attempt：过期后第几次重发） */
  const submit = async (job: TronJob, attempt: number): Promise<void> => {
    let energy = 0
    if (job.contract.type === 'trigger') {
      try {
        energy = await rpc.simulate(job.contract)
      } catch (err) {
        if (!(err instanceof TronTxError) || attempt > 0 || !inFlight.some((f) => f.sent)) throw err
        // 可能依赖前面还没确认的交易：等它们确认后重新模拟
        await settle()
        if (signal?.aborted) {
          update(job, { status: 'skipped', error: 'aborted' })
          return
        }
        energy = await rpc.simulate(job.contract)
      }
    }
    const feeLimit = job.contract.type === 'trigger' ? await feeLimitFor(rpc, job, energy) : 0n
    const gasLimit = job.contract.type === 'trigger' ? BigInt(energy) : null
    // 过期重发的这笔之前已经扣过预估花费（原交易没执行，不再重复扣）
    const short = attempt === 0 ? await shortOf(job, energy, feeLimit) : null
    if (short) throw new TronTxError(short)
    if (dryRun) {
      update(job, { status: 'simulated', gasLimit })
      return
    }
    const { txId, signed, expiration } = await buildSigned(rpc, job, feeLimit, attempt > 0)
    const sent = await rpc.broadcast(signed)
    update(job, { status: 'sent', hash: txId, gasLimit, error: sent === 'accepted' ? null : sent.uncertain })
    let watching: Promise<void> | null = null
    const flight = { sent: true, watch: () => (watching ??= follow()) }
    const follow = async (): Promise<void> => {
      const deadline = Date.now() + timeout
      let polls = 0
      let expiredChecks = 0
      while (!signal?.aborted) {
        await sleep(pollInterval, signal)
        if (signal?.aborted) break
        let info: TransactionInfo | null = null
        try {
          info = await rpc.request<TransactionInfo>('wallet/gettransactioninfobyid', { value: txId })
        } catch {
          // 节点暂时出错：下次再查
        }
        if (info?.id) {
          flight.sent = false
          const result = info.receipt?.result ?? 'SUCCESS'
          const ok = result === 'SUCCESS' && info.result !== 'FAILED'
          const output = info.contractResult?.[0]
          const reason = ok ? null : (output && decodeRevertReason(`0x${output}`)) || (info.resMessage ? decodeHex(info.resMessage) : result)
          update(job, {
            status: ok ? 'confirmed' : 'reverted',
            hash: txId,
            gasLimit,
            gasUsed: info.receipt?.energy_usage_total === undefined ? null : BigInt(info.receipt.energy_usage_total),
            fee: BigInt(info.fee ?? 0),
            blockNumber: info.blockNumber ?? null,
            error: reason === null ? null : `execution reverted: ${reason}`,
          })
          return
        }
        // 过期判断按固化数据（见 expiredForSure），连续两次确认才算：误判过期后重发会重复执行。本地时钟只用来决定什么时候开始查
        if (Date.now() > expiration && (await rpc.expiredForSure(txId, expiration))) {
          expiredChecks++
        } else {
          expiredChecks = 0
        }
        if (expiredChecks >= 2) {
          flight.sent = false
          if (attempt < retries) {
            await submit(job, attempt + 1).catch((err: unknown) => update(job, { status: 'failed', error: errorText(err) }))
          } else {
            update(job, { status: 'failed', error: 'transaction expired before it was confirmed' })
          }
          return
        }
        if (Date.now() >= deadline) {
          flight.sent = false
          update(job, { status: 'pending', hash: txId, gasLimit, error: `not confirmed within ${timeout}ms` })
          return
        }
        if (++polls % 3 === 0) {
          void rpc.broadcast(signed).catch(() => {})
        }
      }
      flight.sent = false
    }
    inFlight.push(flight)
    if (wait) void flight.watch()
  }

  for (const job of jobs) {
    if (stopped || signal?.aborted) {
      update(job, { status: 'skipped', error: signal?.aborted ? 'aborted' : 'skipped: a previous call from this wallet failed' })
      continue
    }
    try {
      await submit(job, 0)
    } catch (err) {
      update(job, { status: 'failed', error: errorText(err) })
      if (!job.continueOnError) stopped = true
    }
  }
  if (wait) await settle()
}

// ---- 批量调用 / 转账 / 归集 ----

async function tronRpc(provider: Provider, options: SendOptions & TronSendOptions): Promise<TronRpc> {
  return new TronRpc(provider.rpc, options)
}

function canonical(address: string): string {
  return toTronAddress(toEvmAddress(address))
}

/** 转 TRX：普通地址用 TransferContract；合约地址用合约调用（空 calldata 带 call_value，主网禁止 TransferContract 转给合约） */
async function trxContract(rpc: TronRpc, owner: string, to: string, amount: bigint): Promise<TronContract> {
  return (await rpc.isContract(to)) ? { type: 'trigger', owner, contract: to, data: '0x', callValue: amount } : { type: 'transfer', owner, to, amount }
}

export async function tronBatchCall(provider: Provider, calls: readonly WriteCall[], options: BatchCallOptions & TronSendOptions = {}): Promise<WriteResult[]> {
  if (options.mode === '7702') {
    throw new Error("mode '7702' is not supported on Tron")
  }
  const rpc = await tronRpc(provider, options)
  const cache = new Map()
  const prepared = await Promise.all(
    calls.map(async (item, i) => {
      const signer = await resolveTronSigner(item.from, cache)
      let to: string
      let data: string
      let value: bigint
      if (item.call) {
        const request = encodeCall(item.call, false)
        to = request.target
        data = request.callData
        value = BigInt(item.value ?? item.call.overrides?.value ?? 0n)
      } else {
        if (!item.to) throw new Error(`calls[${i}]: either to or call is required`)
        to = item.to
        data = item.data ? hexlify(item.data) : '0x'
        value = BigInt(item.value ?? 0n)
      }
      // 没有 calldata：转 TRX；否则调用合约
      const contract: TronContract =
        data === '0x' ? await trxContract(rpc, signer.address, canonical(to), value) : { type: 'trigger', owner: signer.address, contract: canonical(to), data, callValue: value }
      return { signer, to: canonical(to), contract }
    }),
  )
  const results = prepared.map((p, i) => toWriteResult(i, p.signer.address, p.to, emptyOutcome('skipped')))
  const jobs: TronJob[] = prepared.map((p, i) => ({
    signer: p.signer,
    contract: p.contract,
    continueOnError: options.continueOnError,
    onUpdate: (outcome) => {
      results[i] = toWriteResult(i, p.signer.address, p.to, outcome)
      options.onUpdate?.(results[i] as WriteResult)
    },
  }))
  await sendTronJobs(rpc, jobs, options)
  return results
}

interface Planned {
  index: number
  to: string
  token: string
  native: boolean
  amount: bigint
  decimals: number | null
}

async function plan(provider: Provider, owner: string, recipients: readonly TransferItem[], options: BatchTransferOptions): Promise<Planned[]> {
  const defaultToken = options.token ?? NATIVE_TOKEN
  const keyOf = (token: string) => (provider.isNativeToken(token) ? token.toLowerCase() : canonical(token))
  const tokens = [...new Set(recipients.map((r) => keyOf(r.token ?? defaultToken)))]
  const balances = tokens.length ? await provider.balances(owner, tokens) : []
  const info = new Map(balances.map((b, i) => [tokens[i] as string, b]))
  const planned = recipients.map((item, index): Planned => {
    const token = keyOf(item.token ?? defaultToken)
    const balance = info.get(token)
    const native = provider.isNativeToken(token)
    const decimals = balance?.success ? balance.decimals : null
    if (!isTronAddress(item.to) && !/^0x[0-9a-fA-F]{40}$/.test(item.to)) {
      throw new Error(`recipients[${index}]: invalid address ${item.to}`)
    }
    if ((item.amount === undefined) === (item.formatted === undefined)) {
      throw new Error(`recipients[${index}]: pass exactly one of amount / formatted`)
    }
    let amount: bigint
    if (item.formatted !== undefined) {
      if (decimals === null) {
        throw new Error(`recipients[${index}]: cannot read decimals of ${token}, pass amount instead of formatted`)
      }
      amount = parseUnits(item.formatted, decimals)
    } else {
      amount = BigInt(item.amount as BigNumberish)
    }
    if (amount < 0n || (native && amount === 0n)) {
      throw new Error(`recipients[${index}]: amount must be positive`)
    }
    return { index, to: canonical(item.to), token: native ? (item.token ?? defaultToken) : token, native, amount, decimals }
  })
  if (options.checkBalance ?? true) {
    const totals = new Map<string, bigint>()
    planned.forEach((p) => totals.set(keyOf(p.token), (totals.get(keyOf(p.token)) ?? 0n) + p.amount))
    for (const [token, total] of totals) {
      const balance = info.get(token)
      if (!balance?.success) {
        throw new Error(`Cannot read the balance of ${token} (${balance?.error ?? 'unknown error'}); pass checkBalance: false to skip the check`)
      }
      if (BigInt(balance.balance) < total) {
        throw new Error(`Insufficient balance of ${token}: need ${total}, have ${balance.balance}`)
      }
    }
  }
  return planned
}

function tokenTransfer(owner: string, token: string, to: string, amount: bigint): Extract<TronContract, { type: 'trigger' }> {
  return { type: 'trigger', owner, contract: token, data: erc20Interface.encodeFunctionData('transfer', [toEvmAddress(to), amount]), callValue: 0n }
}

/** Tron 一对多转账：每个收款人一笔交易（Tron 上没有通用的 Disperse 合约），结果的 via 为 'tx' */
export async function tronBatchTransfer(
  provider: Provider,
  from: SignerInput,
  recipients: readonly TransferItem[],
  options: BatchTransferOptions & TronSendOptions = {},
): Promise<TransferResult[]> {
  if (options.mode === '7702') {
    throw new Error("mode '7702' is not supported on Tron")
  }
  const rpc = await tronRpc(provider, options)
  const signer = await resolveTronSigner(from, new Map())
  const planned = await plan(provider, signer.address, recipients, options)
  const toResult = (p: Planned, outcome: TxOutcome): TransferResult => ({
    ...toWriteResult(p.index, signer.address, p.to, outcome),
    token: p.token,
    native: p.native,
    amount: p.amount.toString(),
    formatted: p.decimals === null ? null : formatUnits(p.amount, p.decimals),
    via: 'tx',
    approvals: [],
  })
  const results = planned.map((p) => toResult(p, emptyOutcome('skipped')))
  const contracts = await Promise.all(planned.map((p) => (p.native ? trxContract(rpc, signer.address, p.to, p.amount) : tokenTransfer(signer.address, p.token, p.to, p.amount))))
  const jobs: TronJob[] = planned.map((p, k) => ({
    signer,
    contract: contracts[k] as TronContract,
    continueOnError: true,
    onUpdate: (outcome) => {
      results[p.index] = toResult(p, outcome)
      options.onUpdate?.(results[p.index] as TransferResult)
    },
  }))
  await sendTronJobs(rpc, jobs, options)
  return results
}

interface CollectItem {
  index: number
  signer: TronKey
  token: string
  native: boolean
  amount: bigint
  decimals: number | null
  result: CollectItemResult
}

/**
 * Tron 归集：与 EVM 相同的流程（补 gas → 归集代币 → 扫空 TRX）。手续费按 Tron 的资源模型算：
 * 合约调用烧能量（模拟的能量 × 能量单价，减去账户已有的能量，加 20% 余量），每笔交易烧带宽（免费 / 质押带宽不够时按字节计费）。
 * 没激活的子钱包由补 gas 的转账激活（激活费由 gasWallet 付）
 */
export async function tronBatchCollect(provider: Provider, wallets: readonly SignerInput[], to: string, options: BatchCollectOptions & TronSendOptions): Promise<CollectResult> {
  const rpc = await tronRpc(provider, options)
  const target = canonical(to)
  const cache = new Map()
  const signers = await Promise.all(wallets.map((w) => resolveTronSigner(w, cache)))
  const tokens = options.tokens
  const nativeIndex = tokens.findIndex((t) => provider.isNativeToken(t))
  const sweep = nativeIndex >= 0
  const queryTokens = sweep ? [...tokens] : [...tokens, NATIVE_TOKEN]
  const nativeAt = sweep ? nativeIndex : tokens.length
  const balances = await provider.multiBalances(signers.map((s) => ({ owner: s.address, tokens: queryTokens })))
  const minAmount = new Map(Object.entries(options.minAmount ?? {}).map(([k, v]) => [provider.isNativeToken(k) ? k.toLowerCase() : canonical(k), BigInt(v)]))

  const items: CollectItem[] = []
  const seen = new Set<string>()
  signers.forEach((signer, w) => {
    const duplicate = seen.has(signer.address)
    seen.add(signer.address)
    tokens.forEach((token, t) => {
      const balance = balances[w]?.[t] as TokenBalance
      const native = t === nativeIndex
      const item: CollectItem = {
        index: w * tokens.length + t,
        signer,
        token: native ? token : canonical(token),
        native,
        amount: native || !balance.success ? 0n : BigInt(balance.balance),
        decimals: balance.success ? balance.decimals : null,
        result: null as unknown as CollectItemResult,
      }
      const skip = !balance.success
        ? `cannot read balance: ${balance.error ?? 'unknown error'}`
        : signer.address === target
          ? 'skipped: wallet is the collect address'
          : duplicate
            ? 'skipped: duplicate wallet'
            : !native && item.amount === 0n
              ? 'skipped: zero balance'
              : !native && item.amount < (minAmount.get(item.token) ?? 0n)
                ? 'skipped: below minAmount'
                : null
      item.result = collectResult(item, target, emptyOutcome(skip ? (balance.success ? 'skipped' : 'failed') : 'skipped', skip))
      items.push(item)
    })
  })
  const results = items.map((i) => i.result)
  const report = (item: CollectItem, outcome: TxOutcome) => {
    item.result = collectResult(item, target, outcome)
    results[item.index] = item.result
    options.onUpdate?.(item.result)
  }
  const active = (item: CollectItem) => item.result.error === null

  // 估算每个钱包的手续费：模拟能量 + 带宽
  const params = await rpc.params()
  const { energyFee, bandwidthFee } = params
  const byWallet = new Map<string, CollectItem[]>()
  items.filter((i) => !i.native && active(i)).forEach((i) => byWallet.set(i.signer.address, [...(byWallet.get(i.signer.address) ?? []), i]))
  /** 每项的 fee_limit：按全部预估能量算（fee_limit 限制的是总能量，包括账户质押得到的能量），只是上限，实际按用量扣 */
  const feeLimits = new Map<CollectItem, bigint>()
  const plans = await mapPool([...byWallet.entries()], options.concurrency ?? 8, async ([address, list]) => {
    const wallet = signers.findIndex((s) => s.address === address)
    const native = balances[wallet]?.[nativeAt] as TokenBalance
    if (!native.success) {
      // TRX 余额读不到：不知道要补多少，不补（多补的 TRX 也不会被扫回）
      list.forEach((item) => report(item, emptyOutcome('failed', `cannot read the TRX balance: ${native.error ?? 'unknown error'}`)))
      return { address, list, shortfall: 0n, exists: true }
    }
    const resources = await rpc.resources(address)
    let need = 0n
    for (const item of list) {
      const contract = tokenTransfer(address, item.token, target, item.amount)
      let energy: number
      try {
        energy = await rpc.simulate(contract)
      } catch (err) {
        report(item, emptyOutcome('failed', errorText(err)))
        continue
      }
      const feeLimit = options.feeLimit ?? (BigInt(Math.ceil(energy * 1.5)) * energyFee || 1_000_000n)
      feeLimits.set(item, feeLimit)
      // 没激活的账户 resources 里没有免费带宽：补 gas 的转账激活它之后才有，这里按要烧 TRX 算（多出来的扫 TRX 时会转走）
      need += bandwidthBurn(resources, transactionBytes(contract, feeLimit), bandwidthFee) + energyBurn(resources, energy, energyFee)
    }
    const nativeBalance = BigInt(native.balance)
    const buffered = (need * BigInt(Math.round((options.gasBuffer ?? 1) * 1000))) / 1000n
    return { address, list, shortfall: buffered > nativeBalance ? buffered - nativeBalance : 0n, exists: resources.exists }
  })

  // 补 gas（TRX）
  let topUps: TransferResult[] = []
  const short = plans.filter((p) => p.shortfall > 0n && p.list.some(active))
  if (short.length) {
    if (!options.gasWallet) {
      short.forEach((p) => p.list.filter(active).forEach((i) => report(i, emptyOutcome('failed', `insufficient TRX for fees: need ${p.shortfall} more sun (pass gasWallet to top up automatically)`))))
    } else {
      const { tokens: _t, gasWallet, gasMode: _m, gasBuffer: _b, minAmount: _min, onUpdate: _u, ...send } = options
      // 先确认 gasWallet 付得起全部补 gas（金额 + 激活没激活的钱包 + 带宽），不够时什么都不发
      const gas = await resolveTronSigner(gasWallet, cache)
      const gasAccount = await rpc.resources(gas.address)
      const total = short.reduce((sum, p) => {
        const bytes = transactionBytes({ type: 'transfer', owner: gas.address, to: p.address, amount: p.shortfall }, 0n)
        return sum + p.shortfall + transferBurn(gasAccount, bytes, params, !p.exists)
      }, 0n)
      if (gasAccount.balance < total) {
        throw new Error(`Insufficient TRX in gasWallet: the top-ups need about ${total} sun (including activation and bandwidth fees), it has ${gasAccount.balance}`)
      }
      topUps = await tronBatchTransfer(
        provider,
        gasWallet,
        short.map((p) => ({ to: p.address, amount: p.shortfall, token: NATIVE_TOKEN })),
        { ...send, mode: 'tx', wait: true },
      )
      topUps.forEach((t, k) => {
        if (!(t.status === 'confirmed' || (options.dryRun && t.status === 'simulated'))) {
          ;(short[k] as (typeof short)[number]).list.filter(active).forEach((i) => report(i, emptyOutcome('failed', `gas top-up ${t.status}: ${t.error ?? ''}`.trim())))
        }
      })
    }
  }

  const tokenItems = items.filter((i) => !i.native && active(i))
  if (options.dryRun) {
    tokenItems.forEach((i) => report(i, { ...emptyOutcome('simulated') }))
    if (sweep) items.filter((i) => i.native && active(i)).forEach((i) => report(i, emptyOutcome('simulated')))
    return { results, topUps }
  }
  const jobs: TronJob[] = tokenItems.map((item) => ({
    signer: item.signer,
    contract: tokenTransfer(item.signer.address, item.token, target, item.amount),
    feeLimit: feeLimits.get(item),
    continueOnError: true,
    onUpdate: (outcome) => report(item, outcome),
  }))
  await sendTronJobs(rpc, jobs, sweep ? { ...options, wait: true } : options)

  if (!sweep) return { results, topUps }
  // 代币没有全部归集成功的钱包不扫 TRX
  items
    .filter((i) => i.native && active(i))
    .forEach((native) => {
      const unfinished = items.find((i) => !i.native && i.signer.address === native.signer.address && i.result.status !== 'confirmed' && i.result.status !== 'skipped')
      if (unfinished) report(native, emptyOutcome('skipped', `skipped: collecting ${unfinished.token} did not succeed (${unfinished.result.status})`))
    })
  const sweepItems = items.filter((i) => i.native && active(i))
  if (!sweepItems.length || options.signal?.aborted) return { results, topUps }
  // 扫空 TRX：最新余额减去这笔的手续费（带宽够用时为 0；归集地址是合约时用合约调用，还要算能量）
  let targetIsContract: boolean
  try {
    targetIsContract = await rpc.isContract(target)
  } catch (err) {
    // 代币归集已经发出：不能整体抛错，扫 TRX 的项标记失败
    sweepItems.forEach((i) => report(i, emptyOutcome('failed', `cannot check the collect address: ${errorText(err)}`)))
    return { results, topUps }
  }
  const sweepJobs = await mapPool(sweepItems, options.concurrency ?? 8, async (item): Promise<TronJob | null> => {
    const owner = item.signer.address
    try {
      const resources = await rpc.resources(owner)
      const balance = resources.balance
      let energy = 0
      let feeLimit = 0n
      if (targetIsContract) {
        energy = await rpc.simulate({ type: 'trigger', owner, contract: target, data: '0x', callValue: 1n })
        feeLimit = options.feeLimit ?? (BigInt(Math.ceil(energy * 1.5)) * energyFee || 1_000_000n)
      }
      const probe: TronContract = targetIsContract ? { type: 'trigger', owner, contract: target, data: '0x', callValue: balance } : { type: 'transfer', owner, to: target, amount: balance }
      const fee = bandwidthBurn(resources, transactionBytes(probe, feeLimit), bandwidthFee) + (targetIsContract ? energyBurn(resources, energy, energyFee) : 0n)
      const amount = balance - fee
      const min = minAmount.get(item.token.toLowerCase()) ?? 0n
      if (amount <= 0n || amount < min) {
        report(item, emptyOutcome('skipped', amount <= 0n ? 'skipped: TRX balance does not cover the fee' : 'skipped: below minAmount'))
        return null
      }
      item.amount = amount
      const contract: TronContract = targetIsContract ? { type: 'trigger', owner, contract: target, data: '0x', callValue: amount } : { type: 'transfer', owner, to: target, amount }
      return { signer: item.signer, contract, feeLimit: targetIsContract ? feeLimit : undefined, continueOnError: true, onUpdate: (outcome) => report(item, outcome) }
    } catch (err) {
      report(item, emptyOutcome('failed', errorText(err)))
      return null
    }
  })
  await sendTronJobs(
    rpc,
    sweepJobs.filter((j): j is TronJob => j !== null),
    options,
  )
  return { results, topUps }
}

function collectResult(item: CollectItem, to: string, outcome: TxOutcome): CollectItemResult {
  return {
    ...toWriteResult(item.index, item.signer.address, to, outcome),
    token: item.token,
    native: item.native,
    amount: item.amount.toString(),
    formatted: item.decimals === null ? null : formatUnits(item.amount, item.decimals),
  }
}
