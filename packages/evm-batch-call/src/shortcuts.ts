import type { CallOverrides } from './aggregate.js'
import type { BalanceToken, TokenBalance } from './erc20.js'
import { Provider, type ProviderConfig } from './provider.js'
import type { ProviderSource } from './source.js'

export interface GetBalancesOptions extends CallOverrides, ProviderConfig {
  /** 节点（URL / ethers Provider / 钱包，或数组）。不传则使用内置公共节点 */
  rpc?: ProviderSource | readonly ProviderSource[]
}

// 不传 rpc 时按链复用 Provider：多次调用共享 multicall 地址判定与 decimals 缓存
const defaultProviders = new Map<number, Provider>()

function getDefaultProvider(chainId: number): Provider {
  let provider = defaultProviders.get(chainId)
  if (!provider) {
    provider = new Provider(chainId)
    defaultProviders.set(chainId, provider)
  }
  return provider
}

/**
 * 一行查批量余额（主币 + 代币，一次请求），返回原始余额、decimals 和换算后的数值。
 *
 * ```ts
 * import { NATIVE_TOKEN, getBalances } from '@w3lib/evm-batch-call'
 *
 * const list = await getBalances(56, user, [NATIVE_TOKEN, USDT])
 * // [{ token: NATIVE_TOKEN, native: true, balance: 1500000000000000000n, decimals: 18, formatted: '1.5', success: true }, ...]
 * ```
 *
 * 等价于 `new Provider(chainId, rpc, config).balances(owner, tokens, { blockTag, from })`。
 */
export function getBalances(
  chainId: number | string,
  owner: string,
  tokens: readonly BalanceToken[],
  options: GetBalancesOptions = {},
): Promise<TokenBalance[]> {
  const { rpc, blockTag, from, ...config } = options
  const id = Number(chainId)
  const provider = rpc === undefined && Object.keys(config).length === 0 ? getDefaultProvider(id) : new Provider(id, rpc, config)
  return provider.balances(owner, tokens, { blockTag, from })
}
