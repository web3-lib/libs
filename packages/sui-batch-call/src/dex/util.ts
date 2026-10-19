import { normalizeStructTag, normalizeSuiAddress } from '../address.js'
import type { SuiObject } from '../services.js'
import type { ObjectRef } from '../write/bcs.js'
import type { SharedRef } from './types.js'

/** 类型的泛型参数（按顶层逗号拆分，规范化） */
export function typeArgs(type: string | null): string[] | null {
  const m = type ? /<(.+)>$/.exec(type) : null
  if (!m) return null
  const s = m[1] as string
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '<') depth++
    else if (s[i] === '>') depth--
    else if (s[i] === ',' && depth === 0) {
      out.push(normalizeStructTag(s.slice(start, i).trim()))
      start = i + 1
    }
  }
  out.push(normalizeStructTag(s.slice(start).trim()))
  return out
}

/** TypeName 的字符串（地址不带 0x，泛型参数里的也是）→ 规范化的类型 */
export const coinTypeOf = (v: unknown) => normalizeStructTag(String((v as { name?: string })?.name ?? v).replace(/(^|[<,\s])(?:0x)?([0-9a-fA-F]{1,64})::/g, '$10x$2::'))

/** I32 的位表示（u32）→ 有符号整数 */
export const i32 = (bits: unknown) => {
  const v = Number((bits as { bits?: unknown })?.bits ?? bits)
  return v >= 2 ** 31 ? v - 2 ** 32 : v
}

/** 有符号整数 → I32 的位表示 */
export const i32Bits = (v: number) => (v < 0 ? v + 2 ** 32 : v)

export const sharedOf = (o: SuiObject): SharedRef | null =>
  o.owner?.kind === 'shared' && o.owner.initialSharedVersion !== null ? { objectId: normalizeSuiAddress(o.objectId), initialSharedVersion: o.owner.initialSharedVersion } : null

export const refOf = (o: SuiObject): ObjectRef | null => (o.version !== null && o.digest ? { objectId: o.objectId, version: o.version, digest: o.digest } : null)

export const json = (o: SuiObject) => (o.json ?? {}) as Record<string, any>
