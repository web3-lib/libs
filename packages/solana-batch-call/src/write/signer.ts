import { base58, base64urlnopad } from '@scure/base'

import { encodeAddress } from '../address.js'
import { messageSigners, serializeTransaction, splitTransaction } from './transaction.js'

/**
 * 自定义签名器：对交易消息做 ed25519 签名，返回 64 字节签名。用于 KMS / HSM / 硬件钱包，
 * 或运行环境的 WebCrypto 不支持 Ed25519 时（如 React Native）自己用 @noble/curves 签名：
 * `{ address, sign: async (msg) => ed25519.sign(msg, seed) }`
 */
export interface WriteSigner {
  address: string
  sign(message: Uint8Array): Promise<Uint8Array>
}

/** Wallet Standard 钱包（Phantom / Solflare / Backpack / OKX 等浏览器钱包都实现了）：`getWallets().get()` 拿到的对象 */
export interface StandardWalletLike {
  readonly accounts: ReadonlyArray<{ readonly address: string }>
  readonly features: Readonly<Record<string, unknown>>
}

/** @solana/wallet-adapter 的 adapter（`useWallet().wallet.adapter`），或 `useWallet()` 的返回值 */
export interface WalletAdapterLike {
  readonly publicKey: { toBase58(): string } | null
  readonly wallet?: StandardWalletLike | { readonly adapter?: unknown } | null
}

/** @solana/kit 里的交易（消息字节 + 各签名者的签名） */
export interface KitTransactionLike {
  readonly messageBytes: Uint8Array
  readonly signatures: Readonly<Record<string, Uint8Array | null>>
}

/**
 * @solana/kit 的 TransactionSigner：TransactionPartialSigner（signTransactions）或
 * TransactionModifyingSigner（modifyAndSignTransactions，如 @solana/react 的 useWalletAccountTransactionSigner）。
 * 也可以用它把不支持 Wallet Standard 的钱包接进来，见 README
 */
export interface KitSignerLike {
  readonly address: string
  signTransactions?(transactions: readonly KitTransactionLike[]): Promise<ReadonlyArray<Readonly<Record<string, Uint8Array>>>>
  modifyAndSignTransactions?(transactions: readonly KitTransactionLike[]): Promise<readonly KitTransactionLike[]>
}

/**
 * 发交易的钱包，以下都可以：
 * - 私钥字符串：base58（Phantom 等钱包导出的 64 字节格式，或 32 字节种子），或 solana-keygen 生成的 JSON 数组 `"[12,34,…]"`
 * - 私钥字节：Uint8Array（64 字节 secretKey 或 32 字节种子）
 * - @solana/web3.js 的 Keypair（取 secretKey）
 * - @solana/kit 的 KeyPairSigner（`{ address, keyPair }`，用它的 CryptoKey 签名）或其他 TransactionSigner
 * - 自定义签名器 WriteSigner
 * - 浏览器钱包：Wallet Standard 钱包对象（用第一个已连接的账户；指定账户传 `{ wallet, account }`）、
 *   @solana/wallet-adapter 的 adapter 或 useWallet() 的返回值（钱包需支持 Wallet Standard，主流钱包都支持）。
 *   同一批交易先全部模拟、再让钱包一次确认全部签名，然后发送
 *
 * 私钥只在本地用 WebCrypto 的 Ed25519 签名，错误信息里不会带出私钥内容
 */
export type SignerInput =
  | string
  | Uint8Array
  | { secretKey: Uint8Array }
  | { address: string; keyPair: CryptoKeyPair }
  | WriteSigner
  | StandardWalletLike
  | { wallet: StandardWalletLike; account: { readonly address: string } | string }
  | WalletAdapterLike
  | KitSignerLike

/** 本地签名器：直接对消息签名 */
export interface LocalSigner {
  kind: 'local'
  address: string
  sign(message: Uint8Array): Promise<Uint8Array>
}

/** 要外部钱包签的交易：消息 + 已有的签名（按 signers 顺序，没签的为 null） */
export interface SignRequest {
  message: Uint8Array
  signers: readonly string[]
  signatures: ReadonlyArray<Uint8Array | null>
}

/** 外部钱包签好的交易：钱包可能改了消息（如加了指令），signatures 按新消息的签名者顺序 */
export interface SignedTransaction {
  message: Uint8Array
  signers: string[]
  signatures: Array<Uint8Array | null>
}

/** 外部钱包：一次签多笔交易（只弹一次确认） */
export interface WalletSigner {
  kind: 'wallet'
  address: string
  /** chain：Wallet Standard 的链标识，如 'solana:mainnet'（网络未知时不传） */
  signTransactions(requests: readonly SignRequest[], chain?: string): Promise<SignedTransaction[]>
}

/** 归一化后的签名器 */
export type ResolvedSigner = LocalSigner | WalletSigner

// PKCS#8 封装 ed25519 种子的固定前缀（RFC 8410）
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])

/** WebCrypto 的类型要求 ArrayBuffer 背书的视图 */
const view = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle
  if (!s) {
    throw new Error('WebCrypto is not available in this runtime; pass a signer with sign(message) instead of a private key')
  }
  return s
}

/** 用 32 字节种子生成签名器：私钥导入 WebCrypto 后不可导出 */
async function fromSeed(seed: Uint8Array, expected?: Uint8Array): Promise<ResolvedSigner> {
  const pkcs8 = new Uint8Array(48)
  pkcs8.set(PKCS8_PREFIX)
  pkcs8.set(seed, 16)
  let address: string
  let key: CryptoKey
  try {
    // 先以可导出方式导入一次取公钥（JWK 的 x），再以不可导出方式导入用于签名
    const extractable = await subtle().importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'])
    const jwk = await subtle().exportKey('jwk', extractable)
    const publicKey = base64urlnopad.decode(jwk.x as string)
    address = encodeAddress(publicKey)
    if (expected && encodeAddress(expected) !== address) {
      throw new Error('mismatch')
    }
    key = await subtle().importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign'])
  } catch (err) {
    if ((err as Error).message === 'mismatch') {
      throw new Error('Invalid private key: the public key part does not match')
    }
    if ((err as Error).name === 'NotSupportedError' || /algorithm|not supported|unrecognized/i.test((err as Error).message)) {
      throw new Error('Ed25519 is not supported by this runtime’s WebCrypto; pass a signer with sign(message) instead of a private key')
    }
    throw new Error('Invalid private key')
  } finally {
    pkcs8.fill(0)
  }
  return { kind: 'local', address, sign: async (message) => new Uint8Array(await subtle().sign('Ed25519', key, view(message))) }
}

function fromBytes(bytes: Uint8Array): Promise<ResolvedSigner> {
  if (bytes.length === 64) {
    return fromSeed(bytes.slice(0, 32), bytes.slice(32))
  }
  if (bytes.length === 32) {
    return fromSeed(bytes.slice())
  }
  throw new Error('Invalid private key: expected 64 or 32 bytes')
}

function parseKeyString(value: string): Uint8Array {
  const text = value.trim()
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed) && parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        return Uint8Array.from(parsed as number[])
      }
    } catch {
      // 下面统一报错
    }
    throw new Error('Invalid private key: expected a JSON array of bytes')
  }
  let bytes: Uint8Array
  try {
    bytes = base58.decode(text)
  } catch {
    throw new Error('Invalid private key: expected base58 or a JSON array of bytes')
  }
  // 32 字节的 base58 字符串和地址长得一样：传错成地址时会悄悄变成另一个钱包，这里不接受（32 字节种子请传 Uint8Array）
  if (bytes.length === 32) {
    throw new Error('Invalid private key: a 32-byte base58 string looks like an address; pass the 64-byte secret key (or the seed as a Uint8Array)')
  }
  return bytes
}

async function toSigner(input: SignerInput): Promise<ResolvedSigner> {
  if (typeof input === 'string') {
    return fromBytes(parseKeyString(input))
  }
  if (input instanceof Uint8Array) {
    return fromBytes(input)
  }
  if (!input || typeof input !== 'object') {
    throw new Error(INVALID_SIGNER)
  }
  const o = input as Record<string, unknown>
  if (o.secretKey instanceof Uint8Array) {
    return fromBytes(o.secretKey)
  }
  const keyPair = o.keyPair as CryptoKeyPair | undefined
  if (keyPair?.privateKey && typeof o.address === 'string') {
    const key = keyPair.privateKey
    return { kind: 'local', address: o.address, sign: async (message) => new Uint8Array(await subtle().sign('Ed25519', key, view(message))) }
  }
  if (typeof o.sign === 'function' && typeof o.address === 'string') {
    const signer = input as WriteSigner
    return { kind: 'local', address: signer.address, sign: (message) => signer.sign(message) }
  }
  // Wallet Standard 钱包
  if (isStandardWallet(input)) {
    return fromStandardWallet(input, undefined)
  }
  // { wallet, account }
  if (isStandardWallet(o.wallet) && (typeof o.account === 'string' || typeof (o.account as { address?: unknown } | undefined)?.address === 'string')) {
    return fromStandardWallet(o.wallet, typeof o.account === 'string' ? o.account : (o.account as { address: string }).address)
  }
  // wallet-adapter：adapter.wallet 是 Wallet Standard 钱包；useWallet() 的返回值是 { wallet: { adapter }, publicKey }
  if ('publicKey' in o) {
    const publicKey = (o.publicKey as { toBase58?: () => string } | null)?.toBase58?.()
    const adapter = (o.wallet as { adapter?: Record<string, unknown> } | null | undefined)?.adapter ?? o
    const standard = adapter.wallet
    if (!publicKey) {
      throw new Error('Wallet is not connected')
    }
    if (isStandardWallet(standard)) {
      return fromStandardWallet(standard, publicKey)
    }
    throw new Error("This wallet adapter doesn't support Wallet Standard; wrap it as { address, signTransactions } (see README)")
  }
  // @solana/kit 的 TransactionSigner
  if (typeof o.address === 'string' && (typeof o.signTransactions === 'function' || typeof o.modifyAndSignTransactions === 'function')) {
    return fromKitSigner(input as KitSignerLike)
  }
  throw new Error(INVALID_SIGNER)
}

const INVALID_SIGNER = 'Invalid signer: expected a private key, a Keypair, a KeyPairSigner, { address, sign }, a browser wallet or a TransactionSigner'

const SIGN_FEATURE = 'solana:signTransaction'

function isStandardWallet(value: unknown): value is StandardWalletLike {
  const features = (value as { features?: Record<string, unknown> } | null | undefined)?.features
  return Boolean(features && typeof features === 'object' && SIGN_FEATURE in features && Array.isArray((value as { accounts?: unknown }).accounts))
}

/** 同一个钱包的签名请求排队：钱包同时只能处理一个确认窗口 */
const queues = new WeakMap<object, Promise<unknown>>()

function queued<T>(owner: object, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(owner) ?? Promise.resolve()
  const run = previous.then(task, task)
  queues.set(
    owner,
    run.catch(() => {}),
  )
  return run
}

interface StandardSignFeature {
  signTransaction(...inputs: Array<{ account: unknown; transaction: Uint8Array; chain?: string }>): Promise<ReadonlyArray<{ signedTransaction: Uint8Array }>>
}

function fromStandardWallet(wallet: StandardWalletLike, address: string | undefined): WalletSigner {
  const account = address === undefined ? wallet.accounts[0] : wallet.accounts.find((a) => a.address === address)
  if (!account) {
    throw new Error(address === undefined ? 'Wallet is not connected (no accounts)' : `Wallet account ${address} is not connected`)
  }
  const feature = wallet.features[SIGN_FEATURE] as StandardSignFeature
  return {
    kind: 'wallet',
    address: account.address,
    signTransactions: (requests, chain) =>
      queued(wallet, async () => {
        const outputs = await feature.signTransaction(
          ...requests.map((r) => ({ account, transaction: serializeTransaction({ bytes: r.message, signers: [...r.signers] }, r.signatures), ...(chain ? { chain } : {}) })),
        )
        if (outputs.length !== requests.length) {
          throw new Error('Wallet returned a different number of transactions')
        }
        return outputs.map((o) => {
          const { signatures, message } = splitTransaction(o.signedTransaction)
          return { message, signers: messageSigners(message), signatures: signatures.map((sig) => (sig.some((b) => b !== 0) ? sig : null)) }
        })
      }),
  }
}

function fromKitSigner(signer: KitSignerLike): WalletSigner {
  const toKit = (r: SignRequest): KitTransactionLike => ({ messageBytes: r.message, signatures: Object.fromEntries(r.signers.map((s, i) => [s, r.signatures[i] ?? null])) })
  return {
    kind: 'wallet',
    address: signer.address,
    signTransactions: (requests) =>
      queued(signer, async () => {
        if (typeof signer.modifyAndSignTransactions === 'function') {
          const signed = await signer.modifyAndSignTransactions(requests.map(toKit))
          return signed.map((t) => {
            const signers = messageSigners(t.messageBytes)
            return { message: t.messageBytes, signers, signatures: signers.map((s) => t.signatures[s] ?? null) }
          })
        }
        const dictionaries = await (signer.signTransactions as NonNullable<KitSignerLike['signTransactions']>)(requests.map(toKit))
        return requests.map((r, k) => ({ message: r.message, signers: [...r.signers], signatures: r.signers.map((s, i) => dictionaries[k]?.[s] ?? r.signatures[i] ?? null) }))
      }),
  }
}

/** 归一化钱包；同一个输入只解析一次（cache 由调用方按批次传入） */
export function resolveSigner(input: SignerInput, cache: Map<unknown, Promise<ResolvedSigner>> = new Map()): Promise<ResolvedSigner> {
  let resolved = cache.get(input)
  if (!resolved) {
    resolved = toSigner(input)
    cache.set(input, resolved)
  }
  return resolved
}
