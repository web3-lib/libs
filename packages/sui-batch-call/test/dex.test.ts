/**
 * DEX 适配层的公共部分（不连网络）：类型参数、I32、交易环境里留给 owner 的币怎么处理
 */
import { describe, expect, it } from 'vitest'

import { normalizeStructTag, normalizeSuiAddress } from '../src/index.js'
import { createEnv } from '../src/dex/env.js'
import { coinTypeOf, i32, i32Bits, typeArgs } from '../src/dex/util.js'
import { PtbBuilder } from '../src/write/ptb.js'

const USDC = normalizeStructTag('0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC')
const SUI = normalizeStructTag('0x2::sui::SUI')
const OWNER = normalizeSuiAddress('0x7')

describe('工具', () => {
  it('typeArgs：按顶层逗号拆开（嵌套的泛型不拆），规范化', () => {
    expect(typeArgs(`0x1::pool::Pool<0x2::sui::SUI, 0xa::lp::LP<0x2::sui::SUI, ${USDC}>>`)).toEqual([SUI, normalizeStructTag(`0xa::lp::LP<0x2::sui::SUI, ${USDC}>`)])
    expect(typeArgs('0x1::pool::Pool')).toBe(null)
  })

  it('coinTypeOf：TypeName 的字符串（地址不带 0x，泛型参数里的也是）', () => {
    expect(coinTypeOf({ name: 'dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC' })).toBe(USDC)
    expect(coinTypeOf('0000000000000000000000000000000000000000000000000000000000000002::sui::SUI')).toBe(SUI)
  })

  it('I32：u32 的位表示 ↔ 有符号整数', () => {
    expect(i32(2 ** 32 - 1)).toBe(-1)
    expect(i32({ bits: '4294523660' })).toBe(-443636)
    expect(i32(443636)).toBe(443636)
    expect(i32Bits(-443636)).toBe(4294523660)
    expect(i32Bits(5)).toBe(5)
  })
})

describe('交易环境：留给 owner 的币', () => {
  const commandsOf = (ptb: PtbBuilder) => ptb.build().commands.map((c) => c.kind)

  it('同类的 Coin 合并成一个再转给 owner', () => {
    const ptb = new PtbBuilder()
    const env = createEnv(ptb, OWNER, new Map())
    const a = ptb.moveCall('0x2::coin::zero', [USDC], [])
    const b = ptb.moveCall('0x2::coin::zero', [USDC], [])
    const c = ptb.moveCall('0x2::coin::zero', [SUI], [])
    env.keepCoin(a, USDC)
    env.keepCoin(b, USDC)
    env.keepCoin(c, SUI)
    env.finish()
    const cmds = ptb.build().commands
    expect(cmds.slice(3).map((x) => x.kind)).toEqual(['mergeCoins', 'transferObjects'])
    expect(cmds[3]).toMatchObject({ destination: a, sources: [b] })
    expect(cmds[4]).toMatchObject({ objects: [a, c] })
  })

  it('有 sink 时合并进 owner 已有的 Coin（不新建对象）；传函数的 sink 只在要合并时才加进交易', () => {
    const ptb = new PtbBuilder()
    const env = createEnv(ptb, OWNER, new Map())
    const existing = { objectId: '0x99', version: 3n, digest: '11111111111111111111111111111111' }
    let used = 0
    env.sink(USDC, () => (used++, ptb.owned(existing)))
    env.sink(SUI, () => (used++, ptb.owned({ ...existing, objectId: '0x98' })))
    const fee = ptb.moveCall('0x2::coin::zero', [USDC], [])
    env.keepCoin(fee, USDC)
    env.finish()
    expect(commandsOf(ptb)).toEqual(['moveCall', 'mergeCoins'])
    // SUI 没有要留下的币：不碰 0x98
    expect(used).toBe(1)
    expect(ptb.build().inputs).toHaveLength(1)
  })
})
