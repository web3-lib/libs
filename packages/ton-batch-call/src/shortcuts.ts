import { TonClient, type BalancesOptions, type ClientConfig, type JettonDetails, type NftDetails, type NftsOptions, type TokenBalance, type TonBalance, type TonSource, type WalletState } from './client.js'
import type { RequestOptions } from './http.js'

/** 各函数共用的节点参数 */
export interface ShortcutOptions extends ClientConfig {
  /** 节点：toncenter v3 URL、URL 数组（主节点 + 备用节点）或自己的 TonTransport。不传时用 network（默认 mainnet）的 toncenter */
  provider?: TonSource | readonly TonSource[]
}

// 复用客户端：同一个节点共享限频队列（toncenter 免费额度按 IP 计，多个客户端同时发会超）
const MAX_CACHED = 32
const clients = new Map<string, TonClient>()

function clientFor(options: ShortcutOptions): TonClient {
  const { provider, ...config } = options
  const sources = provider === undefined ? [] : Array.isArray(provider) ? provider : [provider]
  const cacheable = sources.every((s) => typeof s === 'string') && config.fetch === undefined
  if (!cacheable) return new TonClient(provider as TonSource | readonly TonSource[] | undefined, config)
  const key = JSON.stringify([sources, config.network ?? 'mainnet', config.apiKey, config.minInterval, config.timeout, config.retries, config.headers])
  let client = clients.get(key)
  if (!client) {
    client = new TonClient(provider as TonSource | readonly TonSource[] | undefined, config)
    clients.set(key, client)
    if (clients.size > MAX_CACHED) clients.delete(clients.keys().next().value as string)
  }
  return client
}

export function split<T extends ShortcutOptions>(options: T): [TonClient, Omit<T, keyof ShortcutOptions>] {
  const { provider, network, apiKey, minInterval, timeout, retries, headers, fetch, ...rest } = options
  return [clientFor({ provider, network, apiKey, minInterval, timeout, retries, headers, fetch }), rest]
}

export interface GetBalancesOptions extends BalancesOptions, ShortcutOptions {
  /** 只查这些（NATIVE_TON 或 Jetton 主合约地址），结果与它一一对应；不传时返回 TON 和持有的全部 Jetton */
  tokens?: readonly string[]
}

/**
 * 查一个地址的 TON 和 Jetton 余额。
 *
 * ```ts
 * await getBalances(owner)                                           // TON + 持有的全部 Jetton
 * await getBalances(owner, { tokens: [NATIVE_TON, USDT], apiKey })
 * ```
 */
export function getBalances(owner: string, options: GetBalancesOptions = {}): Promise<TokenBalance[]> {
  const [client, { tokens, ...rest }] = split(options)
  return client.balances(owner, tokens, rest)
}

/** 多个地址一次查（每 100 个地址一个请求） */
export function getMultiBalances(queries: ReadonlyArray<{ owner: string; tokens?: readonly string[] }>, options: BalancesOptions & ShortcutOptions = {}): Promise<TokenBalance[][]> {
  const [client, rest] = split(options)
  return client.multiBalances(queries, rest)
}

/** 多个地址的 TON 余额 */
export function getTonBalances(addresses: readonly string[], options: RequestOptions & ShortcutOptions = {}): Promise<TonBalance[]> {
  const [client, rest] = split(options)
  return client.tonBalances(addresses, rest)
}

/** Jetton 信息 */
export function getJettons(masters: readonly string[], options: RequestOptions & ShortcutOptions = {}): Promise<JettonDetails[]> {
  const [client, rest] = split(options)
  return client.jettons(masters, rest)
}

/** 钱包状态（类型、seqno） */
export function getWalletStates(addresses: readonly string[], options: RequestOptions & ShortcutOptions = {}): Promise<WalletState[]> {
  const [client, rest] = split(options)
  return client.walletStates(addresses, rest)
}

/** 地址持有的 NFT */
export function getNfts(owner: string, options: NftsOptions & ShortcutOptions = {}): Promise<NftDetails[]> {
  const [client, rest] = split(options)
  return client.nfts(owner, rest)
}
