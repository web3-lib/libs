/**
 * 域名解析（子路径 `@w3lib/solana-batch-call/names`）：SNS（Bonfida，`.sns`），名字 → 地址、地址 → 主域名。
 * 不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getAddressNames, getNameAddresses } from '@w3lib/solana-batch-call/names'
 *
 * await getNameAddresses(['bonfida.sns', 'toly.sns'])
 * await getAddressNames([wallet])
 * ```
 */
import type { RequestOptions } from '../client.js'
import { lookupAddresses, resolveNames, type AddressName, type NamesOptions, type ResolvedName } from '../names.js'
import { resolve, type ShortcutOptions } from '../shortcuts.js'

export { NAME_PROGRAM_ID, SNS_ROOT_DOMAIN, lookupAddresses, resolveNames, snsDomainKey, type AddressName, type NameSource, type NamesOptions, type ResolvedName } from '../names.js'

export interface GetNamesOptions extends NamesOptions, ShortcutOptions {}

/**
 * 名字 → 地址，节点参数与 getBalances 相同。
 *
 * ```ts
 * await getNameAddresses(['bonfida.sns', 'toly.sns'])
 * // [{ name: 'bonfida.sns', normalized: 'bonfida.sns', address: 'Fw1E…Lb1v', owner: 'Fw1E…Lb1v', source: 'owner', service: 'sns' }, …]
 * ```
 */
export function getNameAddresses(names: readonly string[], options: GetNamesOptions = {}): Promise<ResolvedName[]> {
  const { client, own } = resolve(options, ['legacySol', 'allowPda', 'signal'])
  return resolveNames(client, names, own)
}

export interface GetAddressNamesOptions extends RequestOptions, ShortcutOptions {}

/**
 * 地址 → 主域名（核对过属于这个地址）。
 *
 * ```ts
 * await getAddressNames([wallet])   // [{ address: wallet, name: 'bonfida.sns', service: 'sns' }]
 * ```
 */
export function getAddressNames(addresses: readonly string[], options: GetAddressNamesOptions = {}): Promise<AddressName[]> {
  const { client, own } = resolve(options, ['signal'])
  return lookupAddresses(client, addresses, own)
}
