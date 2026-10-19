/**
 * 批量写操作（子路径 `@w3lib/sui-batch-call/write`）：批量执行交易、一对多转账、多钱包归集。
 * 交易在本地按 BCS 编码、用 WebCrypto 的 Ed25519 签名；只做查询时打包不会带上这部分代码。
 *
 * ```ts
 * import { SuiClient } from '@w3lib/sui-batch-call'
 * import { batchCall, batchCollect, batchTransfer } from '@w3lib/sui-batch-call/write'
 *
 * const sui = new SuiClient()
 * await batchTransfer(sui, privateKey, [{ to: a, formatted: '1.5' }, { to: b, token: USDC, formatted: '20' }])
 * await batchCollect(sui, [key1, key2], hotWallet, { tokens: [USDC, SUI_COIN_TYPE], sponsor: gasKey })
 * await batchCall(sui, [{ from: key1, kind }])   // kind：@mysten/sui 的 tx.build({ onlyTransactionKind: true })
 * ```
 */
export { batchCall, type BatchCallOptions, type WriteCall } from '../write/batch.js'
export { batchCollect, type BatchCollectOptions, type CollectResult } from '../write/collect.js'
export { batchTransfer, type BatchTransferOptions, type TransferItem, type TransferResult } from '../write/transfer.js'
export { transactionDigest, type SendOptions, type WriteResult, type WriteStatus } from '../write/send.js'
export { ed25519Address, resolveSigner, transactionDigestToSign, type MystenKeypairLike, type ResolvedSigner, type SignerInput, type SuiSigner, type SuiWalletLike } from '../write/signer.js'
export { PtbBuilder } from '../write/ptb.js'
export {
  BcsWriter,
  encodeTransactionData,
  encodeTransactionKind,
  pure,
  type Argument,
  type CallArg,
  type Command,
  type Expiration,
  type ObjectArg,
  type ObjectRef,
  type ProgrammableTransaction,
  type TransactionData,
} from '../write/bcs.js'
