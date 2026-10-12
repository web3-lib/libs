import { BaseWallet, JsonRpcSigner, SigningKey, getAddress, type Authorization, type AuthorizationRequest, type TransactionRequest } from 'ethers'

/**
 * 发交易的钱包，两种都可以：
 * - 私钥字符串（0x 开头的 32 字节十六进制），内部用 ethers BaseWallet 在本地签名
 * - ethers Signer：Wallet / HDNodeWallet 等能本地签名的（signTransaction），
 *   或浏览器钱包的 JsonRpcSigner（`await new BrowserProvider(window.ethereum).getSigner()`，由钱包签名并发送，每笔需要用户确认）
 */
export type SignerInput = string | WriteSigner | TronSigner | TronWalletLike

/**
 * Tron 浏览器钱包：注入的 tronWeb（`window.tronWeb`，TronLink / OKX 等），或 @tronweb3/tronwallet-adapter 的 adapter。
 * 每笔交易钱包弹一次确认（Tron 钱包不支持一次签多笔）
 */
export type TronWalletLike =
  | { defaultAddress?: { base58?: string | boolean }; trx: { sign(transaction: any): Promise<any> } }
  | { address: string | null; signTransaction(transaction: any): Promise<any> }

/**
 * Tron 上的自定义签名器：对交易 ID（32 字节摘要，0x 开头）做 secp256k1 签名，返回 65 字节签名（r、s、v）的十六进制。
 * 用于 KMS / 硬件钱包等；Tron 上私钥和 ethers Wallet 也可以直接传
 */
export interface TronSigner {
  /** T 开头或 0x 格式的地址 */
  address: string
  signDigest(digest: string): Promise<string>
}

/** 只用到 ethers Signer 的这几个方法 */
export interface WriteSigner {
  getAddress(): Promise<string>
  /** 本地签名（Wallet 等）。浏览器钱包不支持，改用 sendTransaction */
  signTransaction?(tx: TransactionRequest): Promise<string>
  /** 由钱包签名并广播（浏览器钱包），返回交易哈希 */
  sendTransaction?(tx: TransactionRequest): Promise<{ hash: string }>
  /** EIP-7702 授权签名（ethers Wallet 支持；'7702' 模式需要） */
  authorize?(auth: AuthorizationRequest): Promise<Authorization>
}

/** 归一化后的钱包 */
export interface ResolvedSigner {
  address: string
  signer: WriteSigner
  /** true：本地签名，自己管 nonce、可以重发；false：交给钱包发送（浏览器钱包） */
  local: boolean
}

const PRIVATE_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/

export function isPrivateKey(value: unknown): value is string {
  return typeof value === 'string' && PRIVATE_KEY_RE.test(value)
}

/**
 * 把输入归一化成钱包；同一个私钥 / Signer 对象只解析一次（cache 由调用方按批次传入）。
 * 私钥格式不对时抛错，错误信息里不带私钥内容
 */
export async function resolveSigner(input: SignerInput, cache: Map<SignerInput, Promise<ResolvedSigner>> = new Map()): Promise<ResolvedSigner> {
  let resolved = cache.get(input)
  if (!resolved) {
    resolved = toSigner(input)
    cache.set(input, resolved)
  }
  return resolved
}

async function toSigner(input: SignerInput): Promise<ResolvedSigner> {
  if (typeof input === 'string') {
    if (!isPrivateKey(input)) {
      throw new Error('Invalid private key: expected 32 bytes of hex')
    }
    // BaseWallet 而不是 Wallet：Wallet 带 JSON keystore 加解密（scrypt / AES），打包体积大很多，这里用不到
    const wallet = new BaseWallet(new SigningKey(input.startsWith('0x') ? input : `0x${input}`))
    return { address: wallet.address, signer: wallet, local: true }
  }
  if (!input || typeof (input as WriteSigner).getAddress !== 'function') {
    throw new Error('Invalid signer: expected a private key or an ethers Signer')
  }
  return fromEthersSigner(input as WriteSigner)
}

async function fromEthersSigner(input: WriteSigner): Promise<ResolvedSigner> {
  const address = getAddress(await input.getAddress())
  // JsonRpcSigner 的 signTransaction 走 eth_signTransaction，浏览器钱包基本都不支持，只能让钱包自己发送
  const local = typeof input.signTransaction === 'function' && !(input instanceof JsonRpcSigner)
  if (!local && typeof input.sendTransaction !== 'function') {
    throw new Error('Signer must implement signTransaction or sendTransaction')
  }
  return { address, signer: input, local }
}
