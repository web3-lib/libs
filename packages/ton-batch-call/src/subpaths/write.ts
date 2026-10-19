/**
 * 批量写操作（子路径 `@w3lib/ton-batch-call/write`）：一对多转账、多钱包归集、批量执行交易。
 * 钱包 v4r2 / v5r1，交易在本地编码、用 WebCrypto 的 Ed25519 签名；也可以用 TON Connect 钱包。只做查询时打包不会带上这部分代码。
 *
 * ```ts
 * import { NATIVE_TON, TonClient } from '@w3lib/ton-batch-call'
 * import { batchCall, batchCollect, batchTransfer } from '@w3lib/ton-batch-call/write'
 *
 * const ton = new TonClient('https://toncenter.com/api/v3', { apiKey })
 * await batchTransfer(ton, mnemonic, [{ to: a, formatted: '1.5' }, { to: b, token: USDT, formatted: '20' }])
 * await batchCollect(ton, [m1, m2], hotWallet, { tokens: [USDT, NATIVE_TON], gasFunder: gasMnemonic })
 * ```
 */
export { batchCall, type CallMessage, type WriteCall } from '../write/batch.js'
export { batchCollect, type BatchCollectOptions, type CollectResult } from '../write/collect.js'
export { batchTransfer, type BatchTransferOptions, type TransferItem, type TransferResult } from '../write/transfer.js'
export {
  evaluateTrace,
  resolveWallets,
  type ResolveWalletsOptions,
  type SendMessage,
  type SendOptions,
  type Trace,
  type TraceMessage,
  type TraceTx,
  type WalletContext,
  type WriteResult,
  type WriteStatus,
} from '../write/send.js'
export { keyFromSeed, mnemonicToSeed, resolveTonSigner, type ResolvedTonSigner, type TonConnectLike, type TonConnectRequest, type TonKeySigner, type TonSignerInput } from '../write/signer.js'
export { MAX_MESSAGES, defaultWalletId, signedBody, walletAddress, walletInit, type WalletTransfer, type WalletVersion } from '../write/wallet.js'
export { Builder, Cell, Slice, beginCell, crc32c } from '../write/cell.js'
export {
  commentCell,
  contractAddress,
  externalMessageCell,
  jettonTransferBody,
  normalizedMessageHash,
  outMessageCell,
  stateInitCell,
  type JettonTransfer,
  type OutMessage,
  type StateInit,
} from '../write/message.js'
