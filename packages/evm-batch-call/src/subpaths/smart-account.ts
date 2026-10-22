/**
 * 智能账户批量执行（子路径 `@w3lib/evm-batch-call/smart-account`）：ERC-4337（EntryPoint v0.7 / v0.8）UserOperation 的构建 / 哈希 / 签名、
 * bundler 与 ERC-7677 paymaster 客户端、自己打包（handleOps）、EIP-5792（wallet_sendCalls）。
 * 通常通过 `/write` 的 `mode: '4337' | '5792'`、`mode: '7702' + sponsor` 使用，这里是底层积木。
 *
 * ```ts
 * import { BundlerClient } from '@w3lib/evm-batch-call/smart-account'
 * const bundler = new BundlerClient('https://public.pimlico.io/v2/8453/rpc')
 * await bundler.supportedEntryPoints()
 * ```
 */
export { BundlerClient, PaymasterClient, type GasEstimate, type PaymasterContext, type PaymasterFields, type PaymasterHook, type RpcClientOptions, type UserOperationReceipt } from '../smartAccount/clients.js'
export {
  DUMMY_SIGNATURE,
  EIP7702_MARKER,
  ENTRY_POINT_V07,
  ENTRY_POINT_V08,
  entryPointAddress,
  getUserOpHash,
  packUserOp,
  userOpToRpc,
  userOpTypedData,
  type EntryPointVersion,
  type PackedUserOperation,
  type UserOperation,
} from '../smartAccount/userOp.js'
import type { Provider } from '../provider.js'
import { WriteRpc } from '../write/rpc.js'
import { resolveSimpleAccount } from '../smartAccount/account.js'
import type { SmartAccountOptions } from '../smartAccount/send.js'
export { SIMPLE_ACCOUNT_FACTORY_V07, SIMPLE_ACCOUNT_FACTORY_V08, encodeExecuteBatch, type SmartAccountKind } from '../smartAccount/account.js'
export { getCallsStatus, getWalletCapabilities, sendCalls, waitForCalls, type CallsStatus, type Eip1193Like, type SendCallsRequest, type WalletCapabilities } from '../smartAccount/eip5792.js'
export type { SmartAccountOptions }

/** owner 对应的 SimpleAccount 地址（部署前就能算出，向它转入资产后再用 `mode: '4337'` 发送） */
export async function getSimpleAccount(provider: Provider, owner: string, options: Pick<SmartAccountOptions, 'entryPoint' | 'salt' | 'factory'> = {}): Promise<{ address: string; deployed: boolean }> {
  const rpc = await WriteRpc.from(provider)
  const { address, deployed } = await resolveSimpleAccount(rpc, owner, options.entryPoint ?? '0.7', options.salt, options.factory)
  return { address, deployed }
}
