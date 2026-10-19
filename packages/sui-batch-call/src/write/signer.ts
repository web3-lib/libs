import { blake2b } from '@noble/hashes/blake2.js'
import { base64, base64urlnopad, bech32 } from '@scure/base'

import { normalizeSuiAddress } from '../address.js'

/**
 * 自定义签名器（KMS / 硬件钱包 / 自己的签名服务）：对交易字节签名，返回 Sui 序列化签名
 * （1 字节方案标志 + 签名 + 公钥）的 base64 或字节
 */
export interface SuiSigner {
  address: string
  signTransaction(transaction: Uint8Array): Promise<string | Uint8Array>
}

/** Wallet Standard 钱包（Sui Wallet / Slush / Suiet / OKX …）：`getWallets().get()` 拿到的对象 */
export interface SuiWalletLike {
  readonly accounts: ReadonlyArray<{ readonly address: string; readonly chains?: readonly string[] }>
  readonly features: Readonly<Record<string, unknown>>
}

/** @mysten/sui 的 Keypair（Ed25519Keypair 等） */
export interface MystenKeypairLike {
  toSuiAddress(): string
  signTransaction(bytes: Uint8Array): Promise<{ signature: string }>
}

/**
 * 发交易的钱包，以下都可以：
 * - 私钥字符串：`suiprivkey1…`（Sui CLI / 钱包导出的格式），32 字节十六进制（0x 可省略），或 32 / 33 字节的 base64（旧版 keystore）
 * - 私钥字节：32 字节种子（或 64 字节，前 32 字节是种子）
 * - @mysten/sui 的 Keypair、自定义签名器 SuiSigner
 * - 浏览器钱包：Wallet Standard 钱包对象（用第一个账户；指定账户传 `{ wallet, account }`）
 *
 * 私钥只支持 Ed25519（Sui 最常用的方案）；私钥只在本地用 WebCrypto 签名
 */
export type SignerInput = string | Uint8Array | SuiSigner | MystenKeypairLike | SuiWalletLike | { wallet: SuiWalletLike; account: string }

/** 归一化后的签名器 */
export interface ResolvedSigner {
  address: string
  /** local：本地签名；wallet：交给钱包（每次签名可能弹窗确认） */
  kind: 'local' | 'wallet'
  /**
   * 签名：返回序列化签名（base64）。钱包可能改动交易（如调整 gas），这时 bytes 是钱包签名的交易，执行时要用它
   */
  sign(transaction: Uint8Array, network: string): Promise<{ signature: string; bytes?: Uint8Array }>
}

const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
const view = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Ed25519 公钥 → Sui 地址：blake2b-256(0x00 || 公钥) */
export function ed25519Address(publicKey: Uint8Array): string {
  return `0x${hex(blake2b(new Uint8Array([0x00, ...publicKey]), { dkLen: 32 }))}`
}

/** 交易签名的消息摘要：blake2b-256(意图 [0, 0, 0] || 交易字节) */
export function transactionDigestToSign(transaction: Uint8Array): Uint8Array {
  const message = new Uint8Array(3 + transaction.length)
  message.set(transaction, 3)
  return blake2b(message, { dkLen: 32 })
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('WebCrypto is not available in this runtime; pass a SuiSigner instead of a private key')
  return s
}

/** 32 字节种子 → 本地签名器（私钥导入 WebCrypto 后不可导出） */
async function fromSeed(seed: Uint8Array): Promise<ResolvedSigner> {
  if (seed.length !== 32) throw new Error('Invalid private key: expected 32 bytes')
  const crypto = subtle()
  const pkcs8 = new Uint8Array(48)
  pkcs8.set(PKCS8_PREFIX)
  pkcs8.set(seed, 16)
  let publicKey: Uint8Array
  let key: CryptoKey
  try {
    const extractable = await crypto.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'])
    publicKey = base64urlnopad.decode((await crypto.exportKey('jwk', extractable)).x as string)
    key = await crypto.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign'])
  } catch (err) {
    if ((err as Error).name === 'NotSupportedError' || /algorithm|not supported|unrecognized/i.test((err as Error).message)) {
      throw new Error('Ed25519 is not supported by this runtime’s WebCrypto; pass a SuiSigner instead of a private key')
    }
    throw new Error('Invalid private key')
  } finally {
    pkcs8.fill(0)
  }
  const address = ed25519Address(publicKey)
  return {
    address,
    kind: 'local',
    sign: async (transaction) => {
      const signature = new Uint8Array(await subtle().sign('Ed25519', key, view(transactionDigestToSign(transaction))))
      return { signature: base64.encode(new Uint8Array([0x00, ...signature, ...publicKey])) }
    },
  }
}

/** 解析私钥字符串：suiprivkey1…、0x 十六进制、base64 */
function seedOf(text: string): Uint8Array {
  const s = text.trim()
  if (s.startsWith('suiprivkey')) {
    let bytes: Uint8Array
    try {
      const decoded = bech32.decode(s as `${string}1${string}`, 200)
      if (decoded.prefix !== 'suiprivkey') throw new Error()
      bytes = bech32.fromWords(decoded.words)
    } catch {
      throw new Error('Invalid private key: malformed suiprivkey')
    }
    if (bytes.length !== 33) throw new Error('Invalid private key: malformed suiprivkey')
    if (bytes[0] !== 0x00) throw new Error('Only Ed25519 private keys are supported (this key uses another signature scheme)')
    return bytes.slice(1)
  }
  // hex（0x 可省略；64 个 hex 字符按 base64 解出来是 48 字节，不会有歧义）
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) {
    return Uint8Array.from(s.replace(/^0x/, '').match(/../g) as string[], (h) => parseInt(h, 16))
  }
  let bytes: Uint8Array
  try {
    bytes = base64.decode(s)
  } catch {
    throw new Error('Invalid private key: expected suiprivkey…, 0x hex or base64')
  }
  if (bytes.length === 33) {
    if (bytes[0] !== 0x00) throw new Error('Only Ed25519 private keys are supported (this key uses another signature scheme)')
    return bytes.slice(1)
  }
  if (bytes.length === 32) return bytes
  throw new Error('Invalid private key: expected 32 bytes')
}

const SIGN_FEATURE = 'sui:signTransaction'

function walletSigner(wallet: SuiWalletLike, accountAddress?: string): ResolvedSigner {
  const feature = wallet.features[SIGN_FEATURE] as { signTransaction?: (input: unknown) => Promise<{ bytes: string; signature: string }> } | undefined
  if (typeof feature?.signTransaction !== 'function') {
    throw new Error(`This wallet doesn't support ${SIGN_FEATURE}`)
  }
  const account = accountAddress ? wallet.accounts.find((a) => normalizeSuiAddress(a.address) === normalizeSuiAddress(accountAddress)) : wallet.accounts[0]
  if (!account) throw new Error(accountAddress ? `Account ${accountAddress} is not connected in this wallet` : 'Wallet is not connected')
  const address = normalizeSuiAddress(account.address)
  const signTransaction = feature.signTransaction.bind(feature)
  return {
    address,
    kind: 'wallet',
    sign: async (transaction, network) => {
      // 钱包按 Transaction.from(…) 解析：base64 的 BCS 交易字节可以直接用
      const serialized = base64.encode(transaction)
      const result = await signTransaction({ transaction: { toJSON: async () => serialized }, account, chain: `sui:${network}` })
      const bytes = base64.decode(result.bytes)
      return { signature: result.signature, bytes }
    },
  }
}

/** 把输入归一化成签名器；同一个输入只解析一次（cache 由调用方按批次传入） */
export function resolveSigner(input: SignerInput, cache: Map<unknown, Promise<ResolvedSigner>> = new Map()): Promise<ResolvedSigner> {
  let resolved = cache.get(input)
  if (!resolved) {
    resolved = toSigner(input)
    cache.set(input, resolved)
  }
  return resolved
}

async function toSigner(input: SignerInput): Promise<ResolvedSigner> {
  if (typeof input === 'string') return fromSeed(seedOf(input))
  if (input instanceof Uint8Array) {
    if (input.length === 64) return fromSeed(input.slice(0, 32))
    return fromSeed(input)
  }
  const o = input as Partial<SuiSigner & MystenKeypairLike & SuiWalletLike & { wallet: SuiWalletLike; account: string }>
  if (o.wallet && typeof o.account === 'string') return walletSigner(o.wallet, o.account)
  if (o.features && Array.isArray(o.accounts)) return walletSigner(o as SuiWalletLike)
  if (typeof o.toSuiAddress === 'function' && typeof o.signTransaction === 'function') {
    const keypair = o as MystenKeypairLike
    return { address: normalizeSuiAddress(keypair.toSuiAddress()), kind: 'local', sign: async (tx) => ({ signature: (await keypair.signTransaction(tx)).signature }) }
  }
  if (typeof o.address === 'string' && typeof o.signTransaction === 'function') {
    const custom = o as SuiSigner
    return {
      address: normalizeSuiAddress(custom.address),
      kind: 'local',
      sign: async (tx) => {
        const signature = await custom.signTransaction(tx)
        return { signature: typeof signature === 'string' ? signature : base64.encode(signature) }
      },
    }
  }
  throw new Error('Invalid signer: expected a private key, an @mysten/sui Keypair, a SuiSigner or a Wallet Standard wallet')
}
