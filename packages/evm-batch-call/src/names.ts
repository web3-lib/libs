/**
 * 域名解析（子路径 `@w3lib/evm-batch-call/names`）：ENS（Ethereum）、SPACE ID（BSC 的 .bnb）、Basenames（Base 的 .base.eth），
 * 名字 → 地址、地址 → 名字（反查后再正查核对）。都是 ENS 式的注册表合约，读取合成几次 multicall
 */
import { ensNormalize, namehash } from 'ethers'

import type { Provider } from './provider.js'
import { isTronChain } from './tron.js'

export interface NameService {
  id: string
  name: string
  chainId: number
  /** ENS 式的注册表合约（resolver(node)） */
  registry: string
  /** 这个服务的名字后缀（如 ['bnb']）；null 表示任意名字都交给它（ENS 还支持导入的 DNS 域名） */
  suffixes: readonly string[] | null
  /** 反查用的节点后缀：ENS 是 addr.reverse，L2 上按 ENSIP-19 是 <coinType 十六进制>.reverse */
  reverseSuffix: string
}

/** 内置的域名服务（2026-10 在链上核对过注册表和正查 / 反查） */
export const NAME_SERVICES: readonly NameService[] = [
  { id: 'ens', name: 'ENS', chainId: 1, registry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e', suffixes: null, reverseSuffix: 'addr.reverse' },
  { id: 'spaceid', name: 'SPACE ID', chainId: 56, registry: '0x08CEd32a7f3eeC915Ba84415e9C07a7286977956', suffixes: ['bnb'], reverseSuffix: 'addr.reverse' },
  { id: 'basenames', name: 'Basenames', chainId: 8453, registry: '0xb94704422c2a1e396835a571837aa5ae53285a95', suffixes: ['base.eth'], reverseSuffix: '80002105.reverse' },
]

export interface NamesOptions {
  /** 用哪些域名服务，默认 NAME_SERVICES 里 Provider 这条链的 */
  services?: readonly NameService[]
}

export interface ResolvedName {
  /** 传入的名字（原样） */
  name: string
  /** 规范化后的名字（ENSIP-15）；名字不合法时为 null */
  normalized: string | null
  /** 解析出的地址；没有注册、没有设置地址、名字不合法时为 null */
  address: string | null
  /** 解析这个名字的服务 id；没有服务认这个后缀时为 null */
  service: string | null
}

export interface AddressName {
  /** 传入的地址（原样） */
  address: string
  /** 反查到、并且正查回到同一个地址的名字；没有时为 null */
  name: string | null
  service: string | null
}

const REGISTRY_ABI = ['function resolver(bytes32 node) view returns (address)']
const RESOLVER_ABI = ['function addr(bytes32 node) view returns (address)', 'function name(bytes32 node) view returns (string)']
const ZERO = '0x0000000000000000000000000000000000000000'
const present = (a: string | null | undefined): a is string => !!a && a.toLowerCase() !== ZERO

function servicesOf(chainId: number, options: NamesOptions): readonly NameService[] {
  return options.services ?? NAME_SERVICES.filter((s) => s.chainId === chainId)
}

/** 名字归哪个服务：后缀最长的匹配优先，其次是不限后缀的服务 */
function serviceFor(name: string, services: readonly NameService[]): NameService | null {
  let best: { s: NameService; len: number } | null = null
  for (const s of services) {
    for (const suffix of s.suffixes ?? []) {
      if ((name === suffix || name.endsWith(`.${suffix}`)) && (!best || suffix.length > best.len)) best = { s, len: suffix.length }
    }
  }
  return best?.s ?? services.find((s) => s.suffixes === null) ?? null
}

function normalize(name: string): string | null {
  try {
    const n = ensNormalize(name.trim())
    return n.includes('.') ? n : null
  } catch {
    return null
  }
}

/**
 * 名字 → 地址（读注册表的 resolver，再读 resolver 的 addr，两次 multicall）。
 * 不支持通配解析（ENSIP-10）和链下解析（CCIP-Read，如 cb.id 等子域名），这些名字返回 null
 *
 * ```ts
 * await resolveNames(new Provider(1), ['vitalik.eth', 'nick.eth'])
 * // [{ name: 'vitalik.eth', normalized: 'vitalik.eth', address: '0xd8dA…6045', service: 'ens' }, …]
 * ```
 */
export async function resolveNames(provider: Provider, names: readonly string[], options: NamesOptions = {}): Promise<ResolvedName[]> {
  const chainId = await provider.getChainId()
  const services = isTronChain(chainId) ? [] : servicesOf(chainId, options)
  const items = names.map((name) => {
    const normalized = normalize(name)
    const service = normalized ? serviceFor(normalized, services) : null
    return { name, normalized, service, node: normalized && service ? namehash(normalized) : null }
  })
  const todo = items.filter((x) => x.node && x.service)
  const resolvers = todo.length ? await provider.tryAll<string>(todo.map((x) => provider.contract((x.service as NameService).registry, REGISTRY_ABI).resolver(x.node as string))) : []
  const withResolver = todo.flatMap((x, i) => (present(resolvers[i]) ? [{ x, resolver: resolvers[i] as string }] : []))
  const addresses = withResolver.length ? await provider.tryAll<string>(withResolver.map(({ x, resolver }) => provider.contract(resolver, RESOLVER_ABI).addr(x.node as string))) : []
  const found = new Map(withResolver.map(({ x }, i) => [x, present(addresses[i]) ? (addresses[i] as string) : null]))
  return items.map((x) => ({ name: x.name, normalized: x.normalized, address: found.get(x) ?? null, service: x.service?.id ?? null }))
}

/**
 * 地址 → 名字：读反查记录（主名字），再正查核对名字确实指回这个地址（没有核对的反查记录可以随便设置，不能信）。
 * 共四次 multicall；Tron 上没有域名服务，都返回 null
 *
 * ```ts
 * await lookupAddresses(new Provider(56), [user])   // [{ address: user, name: 'alice.bnb', service: 'spaceid' }]
 * ```
 */
export async function lookupAddresses(provider: Provider, addresses: readonly string[], options: NamesOptions = {}): Promise<AddressName[]> {
  const chainId = await provider.getChainId()
  const services = isTronChain(chainId) ? [] : servicesOf(chainId, options)
  const queries = addresses.flatMap((address, i) =>
    /^0x[0-9a-fA-F]{40}$/.test(address) ? services.map((s) => ({ i, s, node: namehash(`${address.slice(2).toLowerCase()}.${s.reverseSuffix}`) })) : [],
  )
  const resolvers = queries.length ? await provider.tryAll<string>(queries.map((q) => provider.contract(q.s.registry, REGISTRY_ABI).resolver(q.node))) : []
  const withResolver = queries.flatMap((q, j) => (present(resolvers[j]) ? [{ q, resolver: resolvers[j] as string }] : []))
  const names = withResolver.length ? await provider.tryAll<string>(withResolver.map(({ q, resolver }) => provider.contract(resolver, RESOLVER_ABI).name(q.node))) : []
  const claimed = withResolver.flatMap(({ q }, j) => (typeof names[j] === 'string' && names[j] ? [{ q, name: names[j] as string }] : []))
  // 正查核对：名字要由同一个服务解析回这个地址
  const forward = await resolveNames(
    provider,
    claimed.map((c) => c.name),
    { services },
  )
  const result: AddressName[] = addresses.map((address) => ({ address, name: null, service: null }))
  claimed.forEach((c, j) => {
    const f = forward[j]
    const out = result[c.q.i] as AddressName
    if (out.name === null && f?.address && f.service === c.q.s.id && f.address.toLowerCase() === out.address.toLowerCase()) {
      out.name = f.normalized
      out.service = c.q.s.id
    }
  })
  return result
}
