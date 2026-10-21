/**
 * 域名解析（子路径 `@w3lib/evm-batch-call/names`）：ENS、SPACE ID（.bnb）、Basenames（.base.eth），名字 → 地址、地址 → 名字。
 * 不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getAddressNames, getNameAddresses } from '@w3lib/evm-batch-call/names'
 *
 * await getNameAddresses(['vitalik.eth'], { chainId: 1 })
 * await getAddressNames([user], { chainId: 56 })
 * ```
 */
import { lookupAddresses, resolveNames, type AddressName, type NamesOptions, type ResolvedName } from '../names.js'
import { resolve, type ShortcutProviderOptions } from '../shortcuts.js'

export { NAME_SERVICES, lookupAddresses, resolveNames, type AddressName, type NameService, type NamesOptions, type ResolvedName } from '../names.js'

export interface GetNamesOptions extends NamesOptions, ShortcutProviderOptions {}

/**
 * 名字 → 地址，节点参数与 getBalances 相同（用这条链的域名服务：Ethereum 是 ENS，BSC 是 SPACE ID，Base 是 Basenames）。
 *
 * ```ts
 * await getNameAddresses(['vitalik.eth', 'nick.eth'], { chainId: 1 })
 * // [{ name: 'vitalik.eth', normalized: 'vitalik.eth', address: '0xd8dA…6045', service: 'ens' }, …]
 * ```
 */
export function getNameAddresses(names: readonly string[], options: GetNamesOptions = {}): Promise<ResolvedName[]> {
  const { provider, own } = resolve(options, ['services'])
  return resolveNames(provider, names, own)
}

/**
 * 地址 → 名字（反查的主名字，正查核对过）。
 *
 * ```ts
 * await getAddressNames(['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'], { chainId: 1 })
 * // [{ address: '0xd8dA…', name: 'vitalik.eth', service: 'ens' }]
 * ```
 */
export function getAddressNames(addresses: readonly string[], options: GetNamesOptions = {}): Promise<AddressName[]> {
  const { provider, own } = resolve(options, ['services'])
  return lookupAddresses(provider, addresses, own)
}
