/**
 * 动态字段（Table / Bag 里的条目）的对象 ID：可以在本地算出来，再按 ID 读，不用翻页列出整个表
 */
import { blake2b } from '@noble/hashes/blake2.js'

import { normalizeStructTag } from './address.js'
import { BcsWriter, writeTypeTag } from './write/bcs.js'

/** blake2b256(0xf0 ‖ 父对象 ‖ u64le(键的 BCS 长度) ‖ 键的 BCS ‖ 键类型的 BCS TypeTag) */
export function dynamicFieldId(parent: string, keyType: string, keyBcs: Uint8Array): string {
  const tag = new BcsWriter()
  writeTypeTag(tag, keyType)
  const data = new BcsWriter().u8(0xf0).address(parent).u64(keyBcs.length).fixed(keyBcs).fixed(tag.finish()).finish()
  return `0x${[...blake2b(data, { dkLen: 32 })].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** 键是 0x1::string::String 的动态字段 */
export const stringFieldId = (parent: string, key: string) => dynamicFieldId(parent, '0x1::string::String', new BcsWriter().string(key).finish())

/** 类型名不带 0x、地址补足 64 位（Move 的 type_name::into_string 格式，部分 DEX 拿它拼池子的键） */
export const typeNameOf = (coinType: string) => normalizeStructTag(coinType).replace(/^0x/, '').replace(/([<,\s])0x/g, '$1')
