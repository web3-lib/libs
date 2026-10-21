/**
 * 授权管理（子路径 `@w3lib/solana-batch-call/approvals`）：批量查地址的代币账户给出的授权（delegate）、可以关闭回收租金的空账户，
 * 批量撤销 / 关闭。不放在主入口，不用时打包不会带上这部分代码；发送的代码按需加载。
 *
 * ```ts
 * import { closeTokenAccounts, getApprovals, revokeApprovals } from '@w3lib/solana-batch-call/approvals'
 *
 * const list = await getApprovals(owner, { mints: [USDC, BONK] })
 * await revokeApprovals(client, key, list)
 * await closeTokenAccounts(client, key, list.filter((a) => a.amount === '0'))
 * ```
 */
import { approvals, type ApprovalsQuery, type TokenAccountApproval } from '../approvals.js'
import { resolve, type ShortcutOptions } from '../shortcuts.js'

export {
  approvals,
  buildCloses,
  buildRevokes,
  closeTokenAccounts,
  parseTokenAccountState,
  revokeApprovals,
  type ApprovalCall,
  type ApprovalResult,
  type ApprovalsQuery,
  type BuildClosesOptions,
  type CloseAccountsOptions,
  type CloseBlocker,
  type TokenAccountApproval,
} from '../approvals.js'
export { closeAccount, harvestWithheldTokensToMint, revoke } from '../write/instructions.js'

export interface GetApprovalsOptions extends ApprovalsQuery, ShortcutOptions {}

/**
 * 查地址的代币账户给出的授权和可以关闭的空账户，节点参数与 getBalances 相同。
 *
 * ```ts
 * await getApprovals(owner, { mints: [USDC, BONK] })                  // 指定代币：读 ATA，免费公共节点也能用
 * await getApprovals(owner, { provider: 'https://my-rpc…' })         // 全部代币账户：需要支持 getTokenAccountsByOwner 的节点
 * // [{ account, mint: USDC, symbol: 'USDC', delegate: 'GYFk…', delegatedAmount: '6993125', revocable: true, closable: false, closeBlocker: 'balance', … }]
 * ```
 */
export function getApprovals(owner: string, options: GetApprovalsOptions = {}): Promise<TokenAccountApproval[]> {
  const { client, own } = resolve(options, ['mints', 'all', 'signal'])
  return approvals(client, owner, own)
}
