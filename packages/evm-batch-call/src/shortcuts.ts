import type { BalanceToken, TokenBalance } from './erc20.js'
import { Provider, type BalancesOptions, type ProviderConfig } from './provider.js'
import type { ProviderSource } from './source.js'

export interface GetBalancesOptions extends BalancesOptions, ProviderConfig {
  /** 链 ID。传了 provider 时可省略（从节点识别，结果会缓存）；不传 provider 时必填（用于选择内置公共节点） */
  chainId?: number | string
  /**
   * 节点，与 `new Provider(...)` 相同，不传则使用内置公共节点：
   * - RPC URL，或 URL 数组（主节点 + 备用节点）
   * - ethers Provider
   * - 浏览器插件钱包：`window.ethereum`（EIP-1193）、`window.tronWeb`
   * - 混合数组，如 `[window.ethereum, 'https://…']`：钱包出错或不在这条链上时自动用后面的节点
   */
  provider?: ProviderSource | readonly ProviderSource[]
}

// 复用 Provider：多次调用共享连接、multicall 地址判定和自动合并队列。
// 不缓存的情况：带额外配置（避免不同配置串用）；没传 chainId 且节点含钱包等对象
// （用户可能切链，每次按当前链新建；chainId 识别本身有缓存，钱包切链时自动失效，不会每次都发请求）
const providerCache = new Map<string, Map<unknown, Provider>>()

function cacheKey(chainId: number | undefined, source: GetBalancesOptions['provider']): unknown {
  if (source === undefined || typeof source === 'string') {
    return source
  }
  if (Array.isArray(source)) {
    // URL 数组每次调用都是新数组，按内容缓存；含对象的数组没有稳定的 key，不缓存
    return source.every((item) => typeof item === 'string') ? `urls:${source.join('\n')}` : null
  }
  return chainId === undefined ? null : source // 钱包 / ethers Provider 按对象引用缓存
}

function getProvider(chainId: number | undefined, source: GetBalancesOptions['provider'], config: ProviderConfig): Provider {
  if (chainId === undefined && source === undefined) {
    throw new Error('getBalances requires chainId or provider')
  }
  const create = () => (chainId === undefined ? new Provider(source as ProviderSource, config) : new Provider(chainId, source, config))
  const key = Object.keys(config).length === 0 ? cacheKey(chainId, source) : null
  if (key === null) {
    return create()
  }
  const chainKey = String(chainId ?? 'auto')
  let byChain = providerCache.get(chainKey)
  if (!byChain) {
    byChain = new Map()
    providerCache.set(chainKey, byChain)
  }
  let provider = byChain.get(key)
  if (!provider) {
    provider = create()
    byChain.set(key, provider)
  }
  return provider
}

/**
 * 批量查余额（主币 + 代币，一次请求），返回原始余额、decimals 和换算后的数值。
 *
 * ```ts
 * import { NATIVE_TOKEN, getBalances } from '@w3lib/evm-batch-call'
 *
 * await getBalances(user, [NATIVE_TOKEN, USDT], { chainId: 56 })                 // 内置公共节点
 * await getBalances(user, tokens, { provider: window.ethereum })                  // 钱包，chainId 自动识别
 * await getBalances(user, tokens, { provider: 'https://bsc-dataseed.bnbchain.org' })
 * await getBalances(user, tokens, { chainId: 56, provider: [window.ethereum, 'https://…'] }) // 钱包优先，失败用公共节点
 * await getBalances(user, tokens, { chainId: 56, symbol: true })                 // 同时返回 symbol
 * // [{ token: NATIVE_TOKEN, native: true, balance: '1500000000000000000', decimals: 18, formatted: '1.5', success: true }, ...]
 * ```
 */
export function getBalances(owner: string, tokens: readonly BalanceToken[], options: GetBalancesOptions = {}): Promise<TokenBalance[]> {
  const { chainId, provider, symbol, blockTag, from, ...config } = options
  return getProvider(chainId === undefined ? undefined : Number(chainId), provider, config).balances(owner, tokens, {
    symbol,
    blockTag,
    from,
  })
}

/** 测试用：清空 getBalances 的 Provider 缓存 */
export function resetBalancesProviderCache(): void {
  providerCache.clear()
}
