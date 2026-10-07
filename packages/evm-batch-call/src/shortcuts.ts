import type { CallOverrides } from './aggregate.js'
import type { BalanceToken, TokenBalance } from './erc20.js'
import { Provider, type ProviderConfig } from './provider.js'
import type { ProviderSource } from './source.js'

export interface GetBalancesOptions extends CallOverrides, ProviderConfig {
  /**
   * 节点，与 `new Provider(chainId, provider)` 相同，不传则使用内置公共节点：
   * - RPC URL，或 URL 数组（主节点 + 备用节点）
   * - ethers Provider
   * - 浏览器插件钱包：`window.ethereum`（EIP-1193）、`window.tronWeb`
   * - 混合数组，如 `[window.ethereum, 'https://…']`：钱包出错或不在这条链上时自动用后面的节点
   */
  provider?: ProviderSource | readonly ProviderSource[]
}

// 按 chainId + 节点复用 Provider：多次调用共享连接、multicall 地址判定和自动合并队列。
// 只缓存不带额外配置的调用（带配置的每次新建，避免不同配置串用）
const providerCache = new Map<number, Map<unknown, Provider>>()

function cacheKey(source: GetBalancesOptions['provider']): unknown {
  if (source === undefined || typeof source === 'string') {
    return source
  }
  if (Array.isArray(source)) {
    // URL 数组每次调用都是新数组，按内容缓存；含对象的数组没有稳定的 key，不缓存
    return source.every((item) => typeof item === 'string') ? `urls:${source.join('\n')}` : null
  }
  return source // 钱包 / ethers Provider 按对象引用缓存
}

function getProvider(chainId: number, source: GetBalancesOptions['provider'], config: ProviderConfig): Provider {
  const key = Object.keys(config).length === 0 ? cacheKey(source) : null
  if (key === null) {
    return new Provider(chainId, source, config)
  }
  let byChain = providerCache.get(chainId)
  if (!byChain) {
    byChain = new Map()
    providerCache.set(chainId, byChain)
  }
  let provider = byChain.get(key)
  if (!provider) {
    provider = new Provider(chainId, source)
    byChain.set(key, provider)
  }
  return provider
}

/**
 * 一行查批量余额（主币 + 代币，一次请求），返回原始余额、decimals 和换算后的数值。
 *
 * ```ts
 * import { NATIVE_TOKEN, getBalances } from '@w3lib/evm-batch-call'
 *
 * await getBalances(56, user, [NATIVE_TOKEN, USDT])                                       // 内置公共节点
 * await getBalances(56, user, tokens, { provider: 'https://bsc-dataseed.bnbchain.org' }) // 指定节点
 * await getBalances(56, user, tokens, { provider: window.ethereum })                      // 浏览器插件钱包
 * await getBalances(56, user, tokens, { provider: [window.ethereum, 'https://…'] })       // 钱包优先，失败用公共节点
 * // [{ token: NATIVE_TOKEN, native: true, balance: '1500000000000000000', decimals: 18, formatted: '1.5', success: true }, ...]
 * ```
 *
 * 等价于 `new Provider(chainId, provider, config).balances(owner, tokens, { blockTag, from })`。
 */
export function getBalances(
  chainId: number | string,
  owner: string,
  tokens: readonly BalanceToken[],
  options: GetBalancesOptions = {},
): Promise<TokenBalance[]> {
  const { provider, blockTag, from, ...config } = options
  return getProvider(Number(chainId), provider, config).balances(owner, tokens, { blockTag, from })
}

/** 测试用：清空 getBalances 的 Provider 缓存 */
export function resetBalancesProviderCache(): void {
  providerCache.clear()
}
