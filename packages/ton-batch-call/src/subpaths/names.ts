/**
 * 域名解析（子路径 `@w3lib/ton-batch-call/names`）：TON DNS（.ton）、Telegram 用户名（.t.me），名字 → 钱包地址、地址 → 名字。
 * 不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getAddressNames, getNameAddresses } from '@w3lib/ton-batch-call/names'
 *
 * await getNameAddresses(['foundation.ton', 'stud.t.me'])
 * await getAddressNames([owner])
 * ```
 */
import { lookupAddresses, resolveNames, type AddressName, type LookupAddressesOptions, type NamesOptions, type ResolvedName } from '../names.js'
import { split, type ShortcutOptions } from '../shortcuts.js'

export {
  NAME_SERVICES,
  TON_DNS_ROOT,
  lookupAddresses,
  resolveNames,
  type AddressName,
  type LookupAddressesOptions,
  type NamesOptions,
  type ResolvedName,
  type TonNameService,
} from '../names.js'

export interface GetNameAddressesOptions extends NamesOptions, ShortcutOptions {}

/**
 * 名字 → 钱包地址（链上的 dnsresolve），节点参数同其他快捷函数。
 *
 * ```ts
 * await getNameAddresses(['foundation.ton', 'stud.t.me'])
 * // [{ name: 'foundation.ton', normalized: 'foundation.ton', address: 'UQCD39VS…', service: 'ton' }, …]
 * ```
 */
export function getNameAddresses(names: readonly string[], options: GetNameAddressesOptions = {}): Promise<ResolvedName[]> {
  const [client, rest] = split(options)
  return resolveNames(client, names, rest)
}

export interface GetAddressNamesOptions extends LookupAddressesOptions, ShortcutOptions {}

/**
 * 地址 → 名字（索引器的地址簿，正查核对过）。
 *
 * ```ts
 * await getAddressNames(['UQCdqXGvONLwOr3zCNX5FjapflorB6ZsOdcdfLrjsDLt3AF4'])
 * // [{ address: 'UQCdqXGv…', name: 'tolya.ton', service: 'ton' }]
 * ```
 */
export function getAddressNames(addresses: readonly string[], options: GetAddressNamesOptions = {}): Promise<AddressName[]> {
  const [client, rest] = split(options)
  return lookupAddresses(client, addresses, rest)
}
