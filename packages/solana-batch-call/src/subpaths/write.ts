/**
 * 批量写操作（子路径 `@w3lib/solana-batch-call/write`）：批量调用程序、一对多转账、多钱包归集。
 * 不放在主入口，只做查询时打包不会带上这部分代码。不依赖 Solana SDK，签名用运行环境的 WebCrypto（Ed25519）。
 *
 * ```ts
 * import { SolanaClient, NATIVE_MINT } from '@w3lib/solana-batch-call'
 * import { batchCall, batchCollect, batchTransfer } from '@w3lib/solana-batch-call/write'
 *
 * const client = new SolanaClient(rpcUrl)
 * await batchTransfer(client, secretKey, [{ to: a, formatted: '0.5' }, { to: b, token: USDC, formatted: '20' }])
 * await batchCollect(client, [key1, key2], hotWallet, { tokens: [USDC, NATIVE_MINT], feePayer: gasKey })
 * await batchCall(client, [{ from: key1, instructions: [ix1, ix2] }])
 * ```
 */
export { batchCall, type BatchCallMode, type BatchCallOptions, type WriteCall } from '../write/batch.js'
export { batchCollect, type BatchCollectOptions, type CollectItemResult, type CollectResult } from '../write/collect.js'
export { batchTransfer, type BatchTransferOptions, type TransferItem, type TransferMode, type TransferResult } from '../write/transfer.js'
export {
  COMPUTE_BUDGET_PROGRAM_ID,
  closeAccount,
  createAssociatedTokenAccountIdempotent,
  harvestWithheldTokensToMint,
  revoke,
  setComputeUnitLimit,
  setComputeUnitPrice,
  systemTransfer,
  transferChecked,
} from '../write/instructions.js'
export type { SendOptions, WriteResult, WriteStatus } from '../write/send.js'
export type { SignerInput, WriteSigner } from '../write/signer.js'
export type { AccountMeta, Instruction, InstructionInput } from '../write/transaction.js'
