/**
 * 资产列表（子路径 `@w3lib/evm-batch-call/owner`）：从代币来源发现候选代币，multicall 核对余额；含代币来源、价格源、
 * Transfer 事件增量扫描。不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getOwnerTokens, ownerTokens, alchemy } from '@w3lib/evm-batch-call/owner'
 *
 * await getOwnerTokens(user, { chainId: 56 })
 * await ownerTokens(multi, user, { source: alchemy({ apiKey }) })   // 或传已创建的 Provider
 * ```
 */
import { ownerTokens, type OwnedToken, type OwnerTokensOptions } from '../owner.js'
import { resolve, type ShortcutProviderOptions } from '../shortcuts.js'

export {
  ALCHEMY_NETWORKS,
  COINGECKO_PLATFORMS,
  DEFILLAMA_CHAINS,
  alchemy,
  clearTokenListCache,
  coingeckoTokenList,
  combine,
  defaultTokenSource,
  defillamaPrices,
  firstAvailable,
  metamaskTokenList,
  nodereal,
  ownerTokens,
  staticTokens,
  tokenList,
  type DiscoveredToken,
  type IndexerSourceOptions,
  type OwnedToken,
  type OwnerTokensOptions,
  type PriceSource,
  type PriceSourceContext,
  type TokenSource,
  type TokenSourceContext,
} from '../owner.js'
export {
  getTransferScanState,
  keyValueScanStorage,
  memoryScanStorage,
  transferScan,
  type TransferScanOptions,
  type TransferScanState,
  type TransferScanStorage,
} from '../scan.js'

export interface GetOwnerTokensOptions extends OwnerTokensOptions, ShortcutProviderOptions {}

/**
 * 列出持有人拥有的代币（资产列表）。默认用免费公开代币列表发现代币，余额用 multicall 在链上核对。
 *
 * ```ts
 * await getOwnerTokens(user, { chainId: 56 })                                  // 免费，只能发现公开列表里的代币
 * await getOwnerTokens(user, { chainId: 1, prices: true, minUsd: 1 })          // 带美元价值，过滤零头和垃圾币
 * await getOwnerTokens(user, { chainId: 56, source: alchemy({ apiKey }) })     // 用 Alchemy 查全部历史持仓
 * ```
 *
 * @deprecated 不推荐使用：EVM 链上无法只靠节点可靠地列出地址持有的全部代币，这个方法只是尽力而为——
 * 默认来源只能发现公开列表里的代币，依赖第三方免费服务（可能限流、改格式或停止服务），要查几千个代币的余额、耗时数秒，
 * 价格也不一定可信；传 `alchemy` / `nodereal` 来源能查全，但同样受第三方服务的额度和可用性约束。
 * 已知要查哪些代币时请用 `getBalances`；需要可靠的完整持仓请直接接入索引服务的接口或自己的索引。局限性详见 README「资产列表」。
 */
export function getOwnerTokens(owner: string, options: GetOwnerTokensOptions = {}): Promise<OwnedToken[]> {
  const { provider, overrides, own } = resolve(options, ['source', 'prices', 'minUsd', 'includeNative', 'fetch', 'scanTransfers'])
  return ownerTokens(provider, owner, { ...overrides, ...own })
}
