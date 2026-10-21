/**
 * 找池子（链上价格 `/price` 和兑换 `/swap` 共用）：STON.fi router 的 Jetton 钱包、router 类型、
 * router / factory 的 get_pool_address，带进程内缓存
 */
import { toRawAddress } from './address.js'
import type { TonClient } from './client.js'
import { NATIVE_TON } from './constants.js'
import { runGetMethod } from './getters.js'
import { isNodeFault } from './http.js'
import { DEDUST_FACTORY, PTON_V1_MASTER, PTON_V2_MASTER, STONFI_V1_ROUTER, STONFI_V2_ROUTERS, dedustAssetCell, hashKey } from './lp.js'

/** 进程内缓存：池子地址、router 类型、DeDust 池子的资产不会变；router 的 Jetton 钱包（含余额，用来选 router）缓存一小时。null（查不到）不缓存 */
const cache = new Map<string, { value: unknown; until: number }>()
const MAX_CACHED = 10_000

export const INFINITE = Number.POSITIVE_INFINITY
export const HOUR = 3_600_000

export async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && hit.until > Date.now()) return hit.value as T
  const value = await load()
  if (value === null) return value
  cache.set(key, { value, until: Date.now() + ttl })
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string)
  return value
}

/** 测试用：清空找池子的缓存 */
export function resetPoolCache(): void {
  cache.clear()
}

export interface PoolEnv {
  client: TonClient
  signal: AbortSignal | undefined
  /** STON.fi 的全部 router（v1 + v2，原始地址）和它在缓存键里的标识 */
  routers: readonly string[]
  routersKey: string
}

/** STON.fi v2 router 的地址哈希（hashKey）→ 原始地址 */
function routerAddress(key: string): string {
  const bin = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (key.length % 4)) % 4))
  let hex = ''
  for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0')
  return `0:${hex}`
}

/** STON.fi 的全部 router：v1 + 内置的 v2 + 额外认可的 v2 */
export function stonfiRouters(extra: readonly string[] = []): Pick<PoolEnv, 'routers' | 'routersKey'> {
  const keys = extra.map((r) => hashKey(toRawAddress(r))).filter(Boolean)
  return { routers: [STONFI_V1_ROUTER, ...[...new Set([...STONFI_V2_ROUTERS, ...keys])].map(routerAddress)], routersKey: keys.join(',') }
}

/** get 方法失败（池子没部署、不是这种合约）返回 null；节点问题（限频、超时等）抛出 */
export function orNull<T>(env: Pick<PoolEnv, 'signal'>, p: Promise<T>): Promise<T | null> {
  return p.catch((err: unknown) => {
    if (env.signal?.aborted || isNodeFault(err)) throw err
    return null
  })
}

export interface RouterWallet {
  router: string
  wallet: string
  balance: bigint
}

/** router 的 Jetton 钱包（索引器，一个 Jetton 一次请求，owner 是全部 router），按余额从多到少 */
export function routerWallets(env: PoolEnv, master: string): Promise<RouterWallet[]> {
  const { routers } = env
  return cached(`wallets:${master}:${env.routersKey}`, HOUR, async () => {
    const out: RouterWallet[] = []
    for (let i = 0; i < routers.length; i += 100) {
      const res = await env.client.transport.get<{ jetton_wallets?: Array<{ address: string; owner: string; balance: string }> }>(
        'jetton/wallets',
        { owner_address: routers.slice(i, i + 100), jetton_address: master, limit: 100 },
        { signal: env.signal },
      )
      for (const w of res.jetton_wallets ?? []) out.push({ router: toRawAddress(w.owner), wallet: toRawAddress(w.address), balance: BigInt(w.balance) })
    }
    return out.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))
  })
}

/** STON.fi v2 router 的类型（get_router_data 的第二项，如 constant_product / stableswap）；v1 为 constant_product */
export function routerType(env: PoolEnv, router: string): Promise<string | null> {
  if (router === STONFI_V1_ROUTER) return Promise.resolve('constant_product')
  return cached(`router:${router}`, INFINITE, () => orNull(env, runGetMethod(env.client.transport, router, 'get_router_data', [], { signal: env.signal }).then((s) => s.skip().string())))
}

/** STON.fi 里 TON 用 pTON：v1 的 router 用 pTON v1，v2 用 pTON v2.1 */
export const stonfiMaster = (token: string, router: string) => (token === NATIVE_TON ? (router === STONFI_V1_ROUTER ? PTON_V1_MASTER : PTON_V2_MASTER) : token)

/** router 上两个 Jetton 钱包的池子地址（router 的 get_pool_address） */
export function stonfiPoolAddress(env: PoolEnv, router: string, wallet0: string, wallet1: string): Promise<string | null> {
  return cached(`stonfi:${router}:${wallet0}:${wallet1}`, INFINITE, () =>
    orNull(env, runGetMethod(env.client.transport, router, 'get_pool_address', [{ type: 'address', address: wallet0 }, { type: 'address', address: wallet1 }], { signal: env.signal }).then((s) => s.address())),
  )
}

/** DeDust volatile 池子的地址（factory 的 get_pool_address，两个资产按地址排序） */
export function dedustPoolAddress(env: Pick<PoolEnv, 'client' | 'signal'>, tokenA: string, tokenB: string): Promise<string | null> {
  const [a, b] = [tokenA, tokenB].sort()
  return cached(`dedust:${a}:${b}`, INFINITE, () =>
    orNull(
      env,
      runGetMethod(env.client.transport, DEDUST_FACTORY, 'get_pool_address', [{ type: 'num', value: 0 }, { type: 'slice', cell: dedustAssetCell(a as string) }, { type: 'slice', cell: dedustAssetCell(b as string) }], { signal: env.signal }).then((s) => s.address()),
    ),
  )
}
