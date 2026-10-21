/**
 * 授权管理（子路径 `@w3lib/evm-batch-call/approvals`）：批量查地址给出的授权（ERC20、Permit2、NFT 的 setApprovalForAll），
 * 按 Approval 事件发现授权过的代币，批量撤销。不放在主入口，不用时打包不会带上这部分代码；发送的代码按需加载。
 *
 * ```ts
 * import { getApprovals, revokeApprovals } from '@w3lib/evm-batch-call/approvals'
 *
 * const list = await getApprovals(user, { chainId: 56, tokens: [USDT, CAKE] })
 * await revokeApprovals(provider, key, list.filter((a) => a.type !== 'nft' && a.unlimited))
 * ```
 */
import { approvals, type Approval, type ApprovalsQuery } from '../approvals.js'
import { resolve, type ShortcutProviderOptions } from '../shortcuts.js'

export {
  PERMIT2_ADDRESS,
  approvals,
  buildRevokes,
  knownSpenders,
  revokeApprovals,
  scanApprovals,
  type Approval,
  type ApprovalScanOptions,
  type ApprovalScanProgress,
  type ApprovalScanResult,
  type ApprovalsQuery,
  type Erc20Approval,
  type KnownSpender,
  type NftApproval,
  type Permit2Approval,
  type RevokeResult,
  type RevokeTx,
} from '../approvals.js'

export interface GetApprovalsOptions extends ApprovalsQuery, ShortcutProviderOptions {}

/**
 * 查地址给出的授权，节点参数与 getBalances 相同。默认检查已知的 Router / 聚合器 / NFT 市场。
 *
 * ```ts
 * await getApprovals(user, { chainId: 56, tokens: [USDT, CAKE] })
 * // [{ type: 'erc20', token: USDT, symbol: 'USDT', spender: '0x1111…', spenderName: '1inch Router v6', amount: '…', unlimited: true }, …]
 * ```
 */
export function getApprovals(owner: string, options: GetApprovalsOptions): Promise<Approval[]> {
  const { provider, own } = resolve(options, ['tokens', 'spenders', 'pairs', 'permit2', 'nfts', 'operators', 'nftPairs', 'includeZero'])
  return approvals(provider, owner, own)
}
