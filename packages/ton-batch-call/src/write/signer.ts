/**
 * TON 的签名器：助记词 / 私钥（本地用 WebCrypto 的 Ed25519 签名）、自定义签名器、TON Connect 钱包
 */
import { parseTonAddress, toRawAddress } from '../address.js'
import { bytesToHex } from './cell.js'
import type { WalletVersion } from './wallet.js'

/** 自定义签名器（KMS / 硬件钱包）：对 32 字节的哈希签名，返回 64 字节 Ed25519 签名 */
export interface TonKeySigner {
  /** 32 字节公钥（字节或十六进制） */
  publicKey: Uint8Array | string
  sign(hash: Uint8Array): Promise<Uint8Array>
}

/** @tonconnect/sdk 的 TonConnect 或 @tonconnect/ui 的 TonConnectUI（只用到这些） */
export interface TonConnectLike {
  readonly wallet: {
    readonly account?: { readonly address: string; readonly publicKey?: string; readonly chain?: string } | null
    readonly device?: { readonly features?: ReadonlyArray<string | { readonly name: string; readonly maxMessages?: number }> } | null
  } | null
  sendTransaction(transaction: TonConnectRequest): Promise<{ boc: string }>
}

/** TON Connect 的 sendTransaction 请求 */
export interface TonConnectRequest {
  /** unix 秒 */
  validUntil: number
  network?: string
  from?: string
  messages: Array<{ address: string; amount: string; payload?: string; stateInit?: string }>
}

/**
 * 发交易的钱包，以下都可以：
 * - 24 个词的 TON 助记词（空格分隔）
 * - 私钥：32 字节种子或 64 字节（种子 + 公钥，tweetnacl / @ton/crypto 的 secretKey 格式），十六进制字符串（0x 可省略）或 Uint8Array
 * - 自定义签名器 `{ publicKey, sign(hash) }`
 * - TON Connect（@tonconnect/sdk 的 TonConnect、@tonconnect/ui 的 TonConnectUI，已连接）
 * - `{ key, version, walletId }`：指定钱包版本（'v4r2' / 'v5r1'）、wallet_id。不指定时按链上状态判断：已部署的那个版本，都没部署时用 v5r1
 */
export type TonSignerInput = string | Uint8Array | TonKeySigner | TonConnectLike | { key: string | Uint8Array | TonKeySigner; version?: WalletVersion; walletId?: number }

export interface KeySigner {
  kind: 'key'
  publicKey: Uint8Array
  version: WalletVersion | null
  walletId: number | null
  sign(hash: Uint8Array): Promise<Uint8Array>
}

export interface ConnectSigner {
  kind: 'tonconnect'
  /** 原始格式 0:… */
  address: string
  publicKey: Uint8Array | null
  /** 钱包一次最多发几条消息（TON Connect 的 SendTransaction 功能里声明，默认 4） */
  maxMessages: number
  send(request: TonConnectRequest): Promise<{ boc: string }>
}

export type ResolvedTonSigner = KeySigner | ConnectSigner

const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
const view = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>
const utf8 = (s: string) => new TextEncoder().encode(s)

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('WebCrypto is not available in this runtime; pass a TonKeySigner instead of a private key')
  return s
}

function hexToBytes(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) as string[], (h) => parseInt(h, 16))
}

function base64UrlToBytes(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '='))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

async function pbkdf2(key: Uint8Array, salt: string, iterations: number): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', view(key), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt: utf8(salt), iterations }, k, 512))
}

/** TON 助记词 → 32 字节种子（与 @ton/crypto 的 mnemonicToPrivateKey 相同，不支持密码） */
export async function mnemonicToSeed(mnemonic: string | readonly string[]): Promise<Uint8Array> {
  const words = (typeof mnemonic === 'string' ? mnemonic.trim().split(/\s+/) : [...mnemonic]).map((w) => w.trim().toLowerCase())
  if (words.length !== 24) throw new Error(`Invalid mnemonic: expected 24 words, got ${words.length}`)
  const hmacKey = await subtle().importKey('raw', utf8(words.join(' ')), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'])
  const entropy = new Uint8Array(await subtle().sign('HMAC', hmacKey, new Uint8Array(0)))
  // 合法的 TON 助记词（不带密码）满足：PBKDF2(entropy, 'TON seed version', 390 次) 的第一个字节为 0
  if ((await pbkdf2(entropy, 'TON seed version', Math.floor(100_000 / 256)))[0] !== 0) {
    throw new Error('Invalid mnemonic: not a TON mnemonic (BIP-39 mnemonics and mnemonics with a password are not supported)')
  }
  return (await pbkdf2(entropy, 'TON default seed', 100_000)).slice(0, 32)
}

/** 32 字节种子 → 公钥和签名函数（私钥导入 WebCrypto 后不可导出） */
export async function keyFromSeed(seed: Uint8Array): Promise<{ publicKey: Uint8Array; sign(hash: Uint8Array): Promise<Uint8Array> }> {
  if (seed.length !== 32) throw new Error('Invalid private key: expected 32 bytes')
  const crypto = subtle()
  const pkcs8 = new Uint8Array(48)
  pkcs8.set(PKCS8_PREFIX)
  pkcs8.set(seed, 16)
  let publicKey: Uint8Array
  let key: CryptoKey
  try {
    const extractable = await crypto.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'])
    publicKey = base64UrlToBytes((await crypto.exportKey('jwk', extractable)).x as string)
    key = await crypto.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign'])
  } catch (err) {
    if ((err as Error).name === 'NotSupportedError' || /algorithm|not supported|unrecognized/i.test((err as Error).message)) {
      throw new Error('Ed25519 is not supported by this runtime’s WebCrypto; pass a TonKeySigner instead of a private key')
    }
    throw new Error('Invalid private key')
  } finally {
    pkcs8.fill(0)
  }
  return { publicKey, sign: async (hash) => new Uint8Array(await subtle().sign('Ed25519', key, view(hash))) }
}

async function fromKey(key: string | Uint8Array | TonKeySigner): Promise<{ publicKey: Uint8Array; sign(hash: Uint8Array): Promise<Uint8Array> }> {
  if (typeof key === 'string') {
    const s = key.trim()
    if (/\s/.test(s)) return keyFromSeed(await mnemonicToSeed(s))
    const hex = s.replace(/^0x/, '')
    if (/^[0-9a-fA-F]{64}$/.test(hex) || /^[0-9a-fA-F]{128}$/.test(hex)) return fromKey(hexToBytes(hex))
    throw new Error('Invalid private key: expected a 24-word mnemonic or a 32 / 64-byte hex key')
  }
  if (key instanceof Uint8Array) {
    if (key.length === 64) {
      const signer = await keyFromSeed(key.slice(0, 32))
      if (bytesToHex(signer.publicKey) !== bytesToHex(key.subarray(32))) throw new Error('Invalid private key: the public key part does not match the seed')
      return signer
    }
    return keyFromSeed(key)
  }
  const publicKey = typeof key.publicKey === 'string' ? hexToBytes(key.publicKey.replace(/^0x/, '')) : key.publicKey
  if (publicKey.length !== 32) throw new Error('Invalid signer: publicKey must be 32 bytes')
  return { publicKey, sign: (hash) => key.sign(hash) }
}

function isTonConnect(input: unknown): input is TonConnectLike {
  return typeof input === 'object' && input !== null && 'sendTransaction' in input && typeof (input as TonConnectLike).sendTransaction === 'function'
}

function connectSigner(connector: TonConnectLike): ConnectSigner {
  const account = connector.wallet?.account
  if (!account) throw new Error('The TON Connect wallet is not connected')
  const raw = parseTonAddress(account.address)
  if (!raw) throw new Error(`Invalid wallet address: ${account.address}`)
  const feature = connector.wallet?.device?.features?.find((f) => typeof f === 'object' && f.name === 'SendTransaction') as { maxMessages?: number } | undefined
  return {
    kind: 'tonconnect',
    address: toRawAddress(raw),
    publicKey: account.publicKey ? hexToBytes(account.publicKey.replace(/^0x/, '')) : null,
    maxMessages: Math.max(1, feature?.maxMessages ?? 4),
    send: (request) => connector.sendTransaction(request),
  }
}

/** 把输入归一化成签名器；同一个输入只解析一次（cache 由调用方按批次传入） */
export function resolveTonSigner(input: TonSignerInput, cache: Map<unknown, Promise<ResolvedTonSigner>> = new Map()): Promise<ResolvedTonSigner> {
  let resolved = cache.get(input)
  if (!resolved) {
    resolved = toSigner(input)
    cache.set(input, resolved)
  }
  return resolved
}

async function toSigner(input: TonSignerInput): Promise<ResolvedTonSigner> {
  if (isTonConnect(input)) return connectSigner(input)
  if (typeof input === 'object' && !(input instanceof Uint8Array) && 'key' in input) {
    const { publicKey, sign } = await fromKey(input.key)
    return { kind: 'key', publicKey, sign, version: input.version ?? null, walletId: input.walletId ?? null }
  }
  if (typeof input === 'string' || input instanceof Uint8Array || (typeof input === 'object' && input !== null && 'publicKey' in input && typeof input.sign === 'function')) {
    const { publicKey, sign } = await fromKey(input as string | Uint8Array | TonKeySigner)
    return { kind: 'key', publicKey, sign, version: null, walletId: null }
  }
  throw new Error('Invalid signer: expected a mnemonic, a private key, a TonKeySigner or a TON Connect instance')
}
