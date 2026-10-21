/**
 * 域名解析（子路径 `@w3lib/sui-batch-call/names`）：SuiNS，名字 → 地址、地址 → 默认名字。
 * 不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getAddressNames, getNameAddresses } from '@w3lib/sui-batch-call/names'
 *
 * await getNameAddresses(['example.sui', '@adeniyi'])
 * await getAddressNames([owner])
 * ```
 */
import { lookupAddresses, resolveNames, type AddressName, type NamesOptions, type ResolvedName } from '../names.js'
import { clientFor, type ShortcutOptions } from '../shortcuts.js'

export { SUINS, formatSuiName, lookupAddresses, normalizeSuiName, resolveNames, type AddressName, type NamesOptions, type ResolvedName, type SuinsConfig } from '../names.js'

export interface GetNamesOptions extends NamesOptions, ShortcutOptions {}

const split = (options: GetNamesOptions) => {
  const { provider, network, timeout, headers, fetch, retries, concurrency, ...rest } = options
  return [clientFor({ provider, network, timeout, headers, fetch, retries, concurrency }), rest] as const
}

/**
 * 名字 → 地址（SuiNS），节点参数同其他快捷函数（provider、network…）。
 *
 * ```ts
 * await getNameAddresses(['example.sui', '@adeniyi'])
 * // [{ name: 'example.sui', normalized: 'example.sui', address: '0x214a…9db0', expiresAt: 1912952738221 }, …]
 * ```
 */
export function getNameAddresses(names: readonly string[], options: GetNamesOptions = {}): Promise<ResolvedName[]> {
  const [client, rest] = split(options)
  return resolveNames(client, names, rest)
}

/**
 * 地址 → 默认名字（反查记录，正查核对过）。
 *
 * ```ts
 * await getAddressNames(['0x1eb7…e0b1'])   // [{ address: '0x1eb7…e0b1', name: 'adeniyi.sui' }]
 * ```
 */
export function getAddressNames(addresses: readonly string[], options: GetNamesOptions = {}): Promise<AddressName[]> {
  const [client, rest] = split(options)
  return lookupAddresses(client, addresses, rest)
}
