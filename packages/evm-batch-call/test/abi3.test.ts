/** 手写的 aggregate3 编解码：和 ethers 的结果逐字节对照 */
import { AbiCoder, getAddress, hexlify, randomBytes } from 'ethers'
import { describe, expect, it } from 'vitest'

import { decodeResult3Array, encodeCall3Array, type Call3 } from '../src/abi3.js'
import { AGGREGATE3_SELECTOR, multicall3Interface } from '../src/aggregate.js'

const coder = AbiCoder.defaultAbiCoder()
const CALL3 = 'tuple(address target, bool allowFailure, bytes callData)[]'
const RESULT = 'tuple(bool success, bytes returnData)[]'

/** 固定种子的伪随机数，失败时能复现 */
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

function randomCalls(rand: () => number, n: number): Call3[] {
  return Array.from({ length: n }, () => {
    const address = hexlify(randomBytes(20))
    const style = rand()
    const target = style < 0.33 ? address : style < 0.66 ? getAddress(address) : `0x${address.slice(2).toUpperCase()}`
    const length = Math.floor(rand() * 200)
    return { target, allowFailure: rand() < 0.5, callData: hexlify(randomBytes(length)) }
  })
}

describe('encodeCall3Array', () => {
  it('与 ethers AbiCoder 逐字节一致（随机 + 边界：空数组、空 calldata、长度不是 32 的倍数、各种地址大小写）', () => {
    const rand = rng(42)
    const cases: Call3[][] = [[], [{ target: getAddress(hexlify(randomBytes(20))), allowFailure: true, callData: '0x' }]]
    for (let i = 0; i < 50; i++) cases.push(randomCalls(rand, Math.floor(rand() * 30)))
    for (const calls of cases) {
      expect(`0x${encodeCall3Array(calls)}`).toBe(coder.encode([CALL3], [calls]))
    }
  })

  it('选择器 + 编码与 Interface.encodeFunctionData 一致', () => {
    const calls = randomCalls(rng(7), 12)
    expect(AGGREGATE3_SELECTOR).toBe(multicall3Interface.getFunction('aggregate3')!.selector)
    expect(`${AGGREGATE3_SELECTOR}${encodeCall3Array(calls)}`).toBe(multicall3Interface.encodeFunctionData('aggregate3', [calls]))
  })

  it('非法地址（含 checksum 错误的大小写混合地址）与 ethers 一样报错', () => {
    const good = getAddress(hexlify(randomBytes(20)))
    // 翻转一个字母的大小写，checksum 就不对了
    const i = [...good].findIndex((c, k) => k > 1 && /[a-fA-F]/.test(c))
    const bad = good.slice(0, i) + (good[i] === good[i]!.toUpperCase() ? good[i]!.toLowerCase() : good[i]!.toUpperCase()) + good.slice(i + 1)
    for (const target of [bad, '0x1234', 'not-an-address']) {
      const calls = [{ target, allowFailure: true, callData: '0x' }]
      expect(() => coder.encode([CALL3], [calls])).toThrow()
      expect(() => encodeCall3Array(calls)).toThrow()
    }
  })
})

describe('decodeResult3Array', () => {
  it('与 ethers 解码结果一致（随机 + 边界）', () => {
    const rand = rng(99)
    for (let k = 0; k < 50; k++) {
      const rows = Array.from({ length: Math.floor(rand() * 30) }, () => [rand() < 0.5, hexlify(randomBytes(Math.floor(rand() * 150)))] as const)
      const data = coder.encode([RESULT], [rows])
      const [expected] = coder.decode([RESULT], data)
      expect(decodeResult3Array(data)).toEqual((expected as Array<[boolean, string]>).map(([success, returnData]) => ({ success, returnData })))
    }
  })

  it('不规范的编码退回 ethers：bool 非 0/1、偏移不连续时结果相同；越界、截断时同样报错', () => {
    const data = coder.encode([RESULT], [[[true, '0x1234'], [false, '0x']]]).slice(2)
    const words = data.match(/.{64}/g) as string[]
    // bool 写成 2：ethers 按非 0 为 true
    const boolTwo = [...words]
    boolTwo[4] = `${'0'.repeat(63)}2`
    const two = `0x${boolTwo.join('')}`
    expect(decodeResult3Array(two)).toEqual([...(coder.decode([RESULT], two)[0] as Array<[boolean, string]>)].map(([success, returnData]) => ({ success, returnData })))
    // 两个元素的偏移对调（不规范但 ethers 能解）：退回 ethers，结果相同
    const swapped = [...words]
    ;[swapped[2], swapped[3]] = [words[3] as string, words[2] as string]
    const sw = `0x${swapped.join('')}`
    const ethersSwapped = [...(coder.decode([RESULT], sw)[0] as Array<[boolean, string]>)].map(([success, returnData]) => ({ success, returnData }))
    expect(ethersSwapped[0]?.returnData).toBe('0x')
    expect(decodeResult3Array(sw)).toEqual(ethersSwapped)
    // 末尾多出数据：ethers 不在意
    const trailing = `0x${data}${'00'.repeat(32)}`
    expect(decodeResult3Array(trailing)).toEqual(decodeResult3Array(`0x${data}`))
    // 截断：两边都报错
    const truncated = `0x${data.slice(0, data.length - 64)}`
    expect(() => coder.decode([RESULT], truncated)).toThrow()
    expect(() => decodeResult3Array(truncated)).toThrow()
    expect(() => decodeResult3Array('0x')).toThrow()
  })
})
