import { WalletError } from '../core/errors.js'
import { base64, toBytes } from '../core/encoding.js'
import type { Connector } from '../core/types.js'
import { standardConnector, type KnownWallet } from '../standard/connector.js'
import type { StandardAccount, StandardWallet } from '../standard/registry.js'

export interface SuiConnectorOptions {
  /** 网络，默认 'mainnet' */
  network?: 'mainnet' | 'testnet' | 'devnet'
  /** 没检测到时也列出来的钱包，默认 Slush、Suiet、OKX Wallet、Bitget Wallet；传 [] 不列 */
  known?: readonly KnownWallet[]
  exclude?: readonly string[]
  /** 恢复上次连接时等插件注册的最长时间（毫秒），默认 1500 */
  restoreTimeout?: number
}

export const DEFAULT_SUI_WALLETS: readonly KnownWallet[] = [
  { name: 'Slush', downloadUrl: 'https://slush.app' },
  { name: 'Suiet', downloadUrl: 'https://suiet.app' },
  { name: 'OKX Wallet', downloadUrl: 'https://web3.okx.com/download' },
  { name: 'Bitget Wallet', downloadUrl: 'https://web3.bitget.com/wallet-download' },
]

interface PersonalMessageFeature {
  signPersonalMessage(input: { message: Uint8Array; account: StandardAccount; chain?: string }): Promise<{ bytes: string; signature: string }>
}
interface LegacyMessageFeature {
  signMessage(input: { message: Uint8Array; account: StandardAccount }): Promise<{ messageBytes: string; signature: string }>
}

/**
 * Sui 连接器：Wallet Standard 钱包（Slush、Suiet、OKX 等）。
 * signMessage 用 sui:signPersonalMessage（老钱包退回 sui:signMessage），返回 base64 的签名（Sui 序列化签名格式）
 */
export function sui(options: SuiConnectorOptions = {}): Connector {
  return standardConnector({
    namespace: 'sui',
    chain: `sui:${options.network ?? 'mainnet'}`,
    transactionFeatures: ['sui:signAndExecuteTransaction', 'sui:signTransaction', 'sui:signAndExecuteTransactionBlock', 'sui:signTransactionBlock'],
    known: options.known ?? DEFAULT_SUI_WALLETS,
    exclude: options.exclude,
    restoreTimeout: options.restoreTimeout ?? 1500,
    async signMessage(wallet: StandardWallet, account, message, chain) {
      const personal = wallet.features['sui:signPersonalMessage'] as PersonalMessageFeature | undefined
      if (personal) return normalize((await personal.signPersonalMessage({ message, account, chain })).signature)
      const legacy = wallet.features['sui:signMessage'] as LegacyMessageFeature | undefined
      if (legacy) return normalize((await legacy.signMessage({ message, account })).signature)
      throw new WalletError('unsupported', `${wallet.name} does not support signing messages`)
    },
  })
}

function normalize(signature: unknown): string {
  if (typeof signature === 'string') return signature
  const bytes = toBytes(signature)
  if (!bytes) throw new WalletError('unknown', 'The wallet returned no signature')
  return base64(bytes)
}

export type { KnownWallet }
