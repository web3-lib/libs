/**
 * 浏览器钱包连接（框架无关、不带界面）。各条链的连接器在子路径里：
 * `@w3lib/wallet/evm`、`/solana`、`/sui`、`/tron`、`/ton`，只用到的链才会打包进来。
 *
 * ```ts
 * import { createWallet } from '@w3lib/wallet'
 * import { evm } from '@w3lib/wallet/evm'
 * import { solana } from '@w3lib/wallet/solana'
 *
 * const wallet = createWallet({ connectors: [evm({ chains }), solana()] })
 * wallet.subscribe((state) => render(state))
 * await wallet.connect('evm', 'io.metamask')
 * ```
 */
export { createWallet, type WalletConfig, type WalletManager } from './core/manager.js'
export { WalletError, isUserRejected, toWalletError, type WalletErrorCode } from './core/errors.js'
export { groupWallets, walletKey, type WalletGroup } from './core/groups.js'
export type {
  ChainId,
  ConnectOptions,
  Connection,
  Connector,
  Namespace,
  SavedConnection,
  Session,
  SessionHandlers,
  StorageLike,
  WalletEvent,
  WalletInfo,
  WalletOption,
  WalletState,
} from './core/types.js'
export { isMobileBrowser, openInWalletUrl, type DeepLinkOptions, type DeepLinkWallet } from './core/mobile.js'
