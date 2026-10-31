/**
 * aggregate3 的手写 ABI 编解码（大批量时 ethers 的通用编解码器是主线程瓶颈：解码时每个动态元素都复制一遍剩余数据）。
 * 只处理规范编码；输入不规范时退回 ethers，结果、报错与原来一致
 */
import { AbiCoder } from 'ethers'

import { checksumAddress, type RawResult } from './call.js'

const CALL3_TUPLE = 'tuple(address target, bool allowFailure, bytes callData)[]'
const RESULT_TUPLE = 'tuple(bool success, bytes returnData)[]'

export interface Call3 {
  target: string
  allowFailure: boolean
  callData: string
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const HEX_RE = /^0x[0-9a-fA-F]*$/

/** 与 ethers 的地址编码规则一致：全小写 / 全大写直接接受，大小写混合的要 checksum 正确 */
function isEncodableAddress(address: string): boolean {
  if (!ADDRESS_RE.test(address)) {
    return false
  }
  const body = address.slice(2)
  if (body === body.toLowerCase() || body === body.toUpperCase()) {
    return true
  }
  // 大小写混合的要 checksum 正确：与 encodeCall 共用一份缓存（encodeCall 产出的 target 已经在里面）
  try {
    return checksumAddress(address) === address
  } catch {
    return false
  }
}
const HEX_BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/
const ZERO_WORD = '0'.repeat(64)
const TRUE_WORD = `${'0'.repeat(63)}1`

function word(value: number): string {
  return value.toString(16).padStart(64, '0')
}

/**
 * `(address,bool,bytes)[]` 的 ABI 编码（不带 0x、不带函数选择器），与 ethers AbiCoder 的结果逐字节一致。
 * 地址 / calldata 格式不对时交给 ethers（照常报错）
 */
export function encodeCall3Array(calls: readonly Call3[]): string {
  for (const c of calls) {
    if (typeof c.target !== 'string' || typeof c.callData !== 'string' || !isEncodableAddress(c.target) || !HEX_BYTES_RE.test(c.callData)) {
      return AbiCoder.defaultAbiCoder().encode([CALL3_TUPLE], [calls]).slice(2)
    }
  }
  const n = calls.length
  const heads: string[] = new Array(n)
  const tails: string[] = new Array(n)
  // 元素偏移相对于长度字之后：先是 n 个偏移字，然后依次是各元素
  let offset = n * 32
  for (let i = 0; i < n; i++) {
    const c = calls[i] as Call3
    const data = c.callData.slice(2).toLowerCase()
    const length = data.length / 2
    const padded = data + '0'.repeat((64 - (data.length % 64)) % 64)
    heads[i] = word(offset)
    // 元组：address、bool、bytes 偏移（固定 0x60）、bytes 长度、数据
    tails[i] = `${'0'.repeat(24)}${c.target.slice(2).toLowerCase()}${c.allowFailure ? TRUE_WORD : ZERO_WORD}${word(96)}${word(length)}${padded}`
    offset += 128 + padded.length / 2
  }
  return `${word(32)}${word(n)}${heads.join('')}${tails.join('')}`
}

/**
 * `(bool,bytes)[]` 的 ABI 解码（data 带 0x、不带选择器）。只接受规范编码（偏移连续、不重叠、数据不越界），
 * 否则交给 ethers：ethers 能解的结果相同，解不了的照常抛错
 */
export function decodeResult3Array(data: string): RawResult[] {
  const fast = tryDecodeResult3(data)
  if (fast) {
    return fast
  }
  const [rows] = AbiCoder.defaultAbiCoder().decode([RESULT_TUPLE], data)
  return (rows as ReadonlyArray<readonly [boolean, string]>).map(([success, returnData]) => ({ success, returnData }))
}

/** 按字（32 字节）读十六进制：hex 不带 0x，pos 为字节位置；超出范围或数值过大时为 -1 */
function readIndex(hex: string, pos: number): number {
  if (pos * 2 + 64 > hex.length) {
    return -1
  }
  const w = hex.slice(pos * 2, pos * 2 + 64)
  // 偏移 / 长度不会超过 2^48：前 52 个十六进制位必须是 0
  if (!/^0{52}/.test(w)) {
    return -1
  }
  return Number.parseInt(w.slice(52), 16)
}

function tryDecodeResult3(data: string): RawResult[] | null {
  if (typeof data !== 'string' || data.length % 2 !== 0 || !HEX_RE.test(data)) {
    return null
  }
  const hex = data.slice(2)
  const size = hex.length / 2
  if (readIndex(hex, 0) !== 32) {
    return null
  }
  const n = readIndex(hex, 32)
  if (n < 0 || 64 + n * 32 > size) {
    return null
  }
  const base = 64
  const results: RawResult[] = new Array(n)
  let expected = n * 32
  for (let i = 0; i < n; i++) {
    const offset = readIndex(hex, base + i * 32)
    if (offset !== expected) {
      return null
    }
    const tuple = base + offset
    if ((tuple + 96) * 2 > hex.length) {
      return null
    }
    const flag = hex.slice(tuple * 2, tuple * 2 + 64)
    if (readIndex(hex, tuple + 32) !== 64) {
      return null
    }
    const length = readIndex(hex, tuple + 64)
    const padded = Math.ceil(length / 32) * 32
    if (length < 0 || tuple + 96 + padded > size) {
      return null
    }
    results[i] = { success: !/^0+$/.test(flag), returnData: `0x${hex.slice((tuple + 96) * 2, (tuple + 96 + length) * 2).toLowerCase()}` }
    expected += 96 + padded
  }
  return results
}
