/**
 * 批量写操作（子路径 `@w3lib/evm-batch-call/write`）：批量调用合约、一对多转账、多钱包归集。
 * 不放在主入口，只做查询时打包不会带上这部分代码。
 *
 * ```ts
 * import { Provider, NATIVE_TOKEN } from '@w3lib/evm-batch-call'
 * import { batchCall, batchCollect, batchTransfer } from '@w3lib/evm-batch-call/write'
 *
 * const multi = new Provider(56, rpcUrl)
 * await batchTransfer(multi, privateKey, [{ to: a, formatted: '1.5' }, { to: b, formatted: '2' }], { token: USDT })
 * await batchCollect(multi, [key1, key2], hotWallet, { tokens: [USDT, NATIVE_TOKEN], gasWallet: gasKey })
 * await batchCall(multi, [{ from: privateKey, call: usdt.approve(router, amount) }, { from: privateKey, to: router, data }])
 * ```
 */
export {
  SIMPLE_7702_ACCOUNT,
  batchCall,
  revokeDelegation,
  type BatchCallMode,
  type BatchCallOptions,
  type WriteCall,
} from '../write/batch.js'
export { batchCollect, type BatchCollectOptions, type CollectItemResult, type CollectResult } from '../write/collect.js'
export { DISPERSE_ADDRESS, batchTransfer, type ApproveResult, type BatchTransferOptions, type TransferItem, type TransferMode, type TransferResult } from '../write/transfer.js'
export type { SendOptions, TronSendOptions, WriteResult, WriteStatus } from '../write/send.js'
export type { SignerInput, TronSigner, TronWalletLike, WriteSigner } from '../write/signer.js'
