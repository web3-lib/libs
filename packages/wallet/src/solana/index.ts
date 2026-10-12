import { WalletError } from '../core/errors.js'
import { base58, toBytes } from '../core/encoding.js'
import type { Connector } from '../core/types.js'
import { standardConnector, type KnownWallet } from '../standard/connector.js'
import type { StandardAccount, StandardWallet } from '../standard/registry.js'

export interface SolanaConnectorOptions {
  /** 网络，默认 'mainnet' */
  cluster?: 'mainnet' | 'devnet' | 'testnet'
  /** 没检测到时也列出来的钱包（引导下载），默认 Phantom、Solflare、Backpack、OKX Wallet、Bitget Wallet；传 [] 不列 */
  known?: readonly KnownWallet[]
  /** 不显示的钱包名 */
  exclude?: readonly string[]
  /** 恢复上次连接时等插件注册的最长时间（毫秒），默认 1500 */
  restoreTimeout?: number
}

export const DEFAULT_SOLANA_WALLETS: readonly KnownWallet[] = [
  { name: 'Phantom', downloadUrl: 'https://phantom.com/download' },
  { name: 'Solflare', downloadUrl: 'https://solflare.com/download' },
  { name: 'Backpack', downloadUrl: 'https://backpack.app/download' },
  { name: 'OKX Wallet', downloadUrl: 'https://web3.okx.com/download' },
  { name: 'Bitget Wallet', downloadUrl: 'https://web3.bitget.com/wallet-download' },
]

interface SignMessageFeature {
  signMessage(...inputs: Array<{ account: StandardAccount; message: Uint8Array }>): Promise<ReadonlyArray<{ signature: Uint8Array }> | { signature: Uint8Array }>
}

/**
 * Solana 连接器：Wallet Standard 钱包（Phantom、Solflare、Backpack、OKX 等）。
 * 连接后 connection.provider 是 Wallet Standard 钱包，可以直接传给 @w3lib/solana-batch-call 的写操作；signMessage 返回 base58 签名
 */
export function solana(options: SolanaConnectorOptions = {}): Connector {
  return standardConnector({
    namespace: 'solana',
    chain: `solana:${options.cluster ?? 'mainnet'}`,
    transactionFeatures: ['solana:signTransaction', 'solana:signAndSendTransaction'],
    known: options.known ?? DEFAULT_SOLANA_WALLETS,
    exclude: options.exclude,
    restoreTimeout: options.restoreTimeout ?? 1500,
    async signMessage(wallet: StandardWallet, account, message) {
      const feature = wallet.features['solana:signMessage'] as SignMessageFeature | undefined
      if (!feature) throw new WalletError('unsupported', `${wallet.name} does not support signing messages`)
      const output = await feature.signMessage({ account, message })
      // 规范返回数组；有的钱包直接返回对象
      const first = Array.isArray(output) ? output[0] : output
      const signature = toBytes((first as { signature?: unknown } | undefined)?.signature)
      if (!signature) throw new WalletError('unknown', `${wallet.name} returned no signature`)
      return base58(signature)
    },
  })
}

export type { KnownWallet }
