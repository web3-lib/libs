/**
 * DEX 适配层的公共部分（不连网络）：类型参数、I32、交易环境里留给 owner 的币怎么处理
 */
import { describe, expect, it } from 'vitest'

import { normalizeStructTag, normalizeSuiAddress } from '../src/index.js'
import { createEnv } from '../src/dex/env.js'
import { guardMin } from '../src/dex/pay.js'
import { stringFieldId, typeNameOf } from '../src/dynamicField.js'
import { coinTypeOf, i32, i32Bits, typeArgs } from '../src/dex/util.js'
import { PtbBuilder } from '../src/write/ptb.js'
import { dipcoin } from '../src/amm/dipcoin.js'
import { flowxV2 } from '../src/amm/flowxV2.js'
import { kriyaAmm } from '../src/amm/kriya.js'
import { binPrice, parseDlmmPool, parseDlmmPosition } from '../src/dlmm.js'
import { maybeAftermathLp, parseAftermathFees, parseAftermathPool, protocolFeeOf, withdrawAllAmounts } from '../src/aftermath.js'
import type { SuiObject } from '../src/services.js'

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

  it('动态字段的对象 ID：本地算出（主网 FlowX V2 的 pairs 表里 SUI / SUISUNG 那一项）', () => {
    const key = `LP-${typeNameOf(SUI)}-${typeNameOf('0x0006b2b3d65d58fb2de4d53c10e30fa5e9c3db9eacdd7423d9a2d995eafa9eb0::suisung::SUISUNG')}`
    expect(key).toBe('LP-0000000000000000000000000000000000000000000000000000000000000002::sui::SUI-0006b2b3d65d58fb2de4d53c10e30fa5e9c3db9eacdd7423d9a2d995eafa9eb0::suisung::SUISUNG')
    expect(stringFieldId('0xd15e209f5a250d6055c264975fee57ec09bf9d6acdda3b5f866f76023d1563e6', key)).toBe('0x9a8c766f54892cf89b989fe3ef9326652b0c4200ce8ff79c0153ba5fc8f71356')
  })

  it('I32：u32 的位表示 ↔ 有符号整数', () => {
    expect(i32(2 ** 32 - 1)).toBe(-1)
    expect(i32({ bits: '4294523660' })).toBe(-443636)
    expect(i32(443636)).toBe(443636)
    expect(i32Bits(-443636)).toBe(4294523660)
    expect(i32Bits(5)).toBe(5)
  })
})

describe('链上的数量下限', () => {
  it('从币里拆出下限再合并回去（不够时 SplitCoins 失败）；下限为 0 时不加命令', () => {
    const ptb = new PtbBuilder()
    const coin = ptb.moveCall('0x2::coin::zero', [USDC], [])
    guardMin(ptb, coin, 0n)
    expect(ptb.build().commands).toHaveLength(1)
    guardMin(ptb, coin, 100n)
    const cmds = ptb.build().commands
    expect(cmds.slice(1)).toMatchObject([
      { kind: 'splitCoins', coin },
      { kind: 'mergeCoins', destination: coin, sources: [{ kind: 'nested', index: 1, result: 0 }] },
    ])
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

/** 测试用的对象（只填解析用到的字段） */
const object = (o: { objectId: string; type: string; json: unknown; shared?: bigint; owner?: string }): SuiObject => ({
  objectId: normalizeSuiAddress(o.objectId),
  version: 5n,
  digest: '11111111111111111111111111111111',
  type: o.type,
  owner: o.shared !== undefined ? { kind: 'shared', address: null, initialSharedVersion: o.shared } : { kind: 'address', address: normalizeSuiAddress(o.owner ?? '0x7'), initialSharedVersion: null },
  json: o.json,
  display: null,
  balance: null,
  previousTransaction: null,
  storageRebate: null,
  contents: null,
})

describe('传统 AMM 的池子和 LP', () => {
  it('DipCoin：储备、LP 总量、手续费（万分之一 → 百万分之一）、每次添加的最少 LP', () => {
    const pool = dipcoin.parsePool(
      object({
        objectId: '0x7fbd',
        type: `0xdae28ab9ab072c647c4e8f2057a8f17dcc4847e42d6a8258df4b376ae183c872::manage::Pool<0x2::sui::SUI, ${USDC}>`,
        json: { bal_x: '253544603363410', bal_y: '255663027166', fee_bal_x: '9', lp_supply: { value: '7499359456770' }, fee_rate: '5', min_add_liquidity_lp_amount: '1000000' },
        shared: 560713748n,
      }),
    )
    expect(pool).toMatchObject({ protocol: 'dipcoin', coinA: SUI, coinB: USDC, reserveA: 253544603363410n, lpSupply: 7499359456770n, fee: 500, minLp: 1000000n, stable: false })
    expect(pool?.lpCoinType).toBe(`0xdae28ab9ab072c647c4e8f2057a8f17dcc4847e42d6a8258df4b376ae183c872::manage::LP<${SUI}, ${USDC}>`)
  })

  it('FlowX V2：池子是 pairs 表里的字段对象（Field<String, PairMetadata<X, Y>>），没有共享对象', () => {
    const pool = flowxV2.parsePool(
      object({
        objectId: '0x8eba',
        type: `0x2::dynamic_field::Field<0x1::string::String, 0xba153169476e8c3114962261d1edc70de5ad9781b83cc617ecc8c1923191cae0::pair::PairMetadata<0x2::sui::SUI, ${USDC}>>`,
        json: { name: 'LP-…', value: { fee_rate: '30', lp_supply: { value: '1000' }, reserve_x: { balance: '1' }, reserve_y: { balance: '2208631' } } },
        owner: '0xd15e',
      }),
    )
    expect(pool).toMatchObject({ protocol: 'flowx-v2', id: normalizeSuiAddress('0x8eba'), coinA: SUI, coinB: USDC, reserveB: 2208631n, fee: 3000, shared: null })
    expect(flowxV2.isPool(normalizeStructTag('0x2::sui::SUI'))).toBe(false)
  })

  it('Kriya：KriyaLPToken 是一个仓位；手续费是 LP + 协议（百万分之一）', () => {
    const type = `0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66::spot_dex::KriyaLPToken<${USDC}, 0x2::sui::SUI>`
    const holding = kriyaAmm.parseHolding?.(object({ objectId: '0xfff', type: normalizeStructTag(type), json: { pool_id: '0x5af4', lsp: { balance: '3903' } } }))
    expect(holding).toMatchObject({ protocol: 'kriya-amm', coinA: USDC, coinB: SUI, balance: 3903n, position: normalizeSuiAddress('0xfff'), pool: normalizeSuiAddress('0x5af4') })
    const pool = kriyaAmm.parsePool(
      object({
        objectId: '0x5af4',
        type: `0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66::spot_dex::Pool<${USDC}, 0x2::sui::SUI>`,
        json: { token_x: '57637382745', token_y: '57238272007639', lsp_supply: { value: '1354974443961' }, lp_fee_percent: '1330', protocol_fee_percent: '670', is_stable: false, is_deposit_enabled: true, is_withdraw_enabled: false },
        shared: 1841618n,
      }),
    )
    expect(pool).toMatchObject({ fee: 2000, stable: false, depositEnabled: true, withdrawEnabled: false })
  })
})

describe('Cetus DLMM', () => {
  it('池子：active bin（I32）、bin step、手续费（十亿分之一 → 百万分之一）、奖励代币、权限', () => {
    const pool = parseDlmmPool(
      object({
        objectId: '0x64e5',
        type: `0x5664f9d3fd82c84023870cfbda8ea84e14c8dd56ce557ad2116e0668581a682b::pool::Pool<${USDC}, 0x2::sui::SUI>`,
        json: {
          active_id: { bits: 4294967290 },
          base_fee_rate: '4000000',
          bin_manager: { bin_step: 50 },
          reward_manager: { rewards: [{ reward_coin: '06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS' }] },
          permissions: { disable_add: false, disable_remove: true },
        },
        shared: 643563051n,
      }),
    )
    expect(pool).toMatchObject({ activeBin: -6, binStep: 50, fee: 4000, canAdd: true, canRemove: false })
    expect(pool?.rewardCoins).toEqual([normalizeStructTag('0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS')])
  })

  it('仓位：区间的两个 bin；bin 的价格 (1 + binStep / 10000)^bin', () => {
    const pos = parseDlmmPosition(
      object({ objectId: '0xff7e', type: '0x5664f9d3fd82c84023870cfbda8ea84e14c8dd56ce557ad2116e0668581a682b::position::Position', json: { pool_id: '0x64e5', lower_bin_id: { bits: 4294967286 }, upper_bin_id: { bits: 3 } } }),
    )
    expect(pos).toMatchObject({ pool: normalizeSuiAddress('0x64e5'), binLower: -10, binUpper: 3 })
    expect(binPrice(0, 50)).toBe(1)
    expect(binPrice(100, 50)).toBeCloseTo(1.005 ** 100, 12)
  })
})

describe('Aftermath（多币池）', () => {
  // 主网 SUI / mUSD 池子（20 / 80）的字段
  const LP = '0x84c853d28dac001038015d8580bf6b078c670817434f06c5ecad44fd181d7252::af_lp::AF_LP'
  const raw = object({
    objectId: '0x98327d7d07581bf78dfe277d8a88de39b4766962e8859b2050a1ca03e9fa2a16',
    type: `0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c::pool::Pool<${LP}>`,
    json: {
      decimal_scalars: ['1000000000000000000', '1000000000000000000'],
      fees_swap_in: ['3000000000000000', '3000000000000000'],
      flatness: '0',
      lp_supply: { value: '17776259583237' },
      normalized_balances: ['6776087705199000000000000000000', '25349891832633000000000000000000'],
      type_names: ['0000000000000000000000000000000000000000000000000000000000000002::sui::SUI', 'e44df51c0b21a27ab915fa1fe2ca610cd3eaa6d9666fe5e62b988bf7f0bd8722::musd::MUSD'],
      weights: ['200000000000000000', '800000000000000000'],
    },
    shared: 477830601n,
  })
  const fees = parseAftermathFees(null)

  it('池子：币的顺序、储备 = normalized / scalar、权重、手续费（1e18 → 百万分之一）', () => {
    const pool = parseAftermathPool(raw)
    expect(pool).toMatchObject({ lpCoinType: LP, reserves: [6776087705199n, 25349891832633n], lpSupply: 17776259583237n, fee: 3000, stable: false })
    expect(pool?.coins).toEqual([SUI, normalizeStructTag('0xe44df51c0b21a27ab915fa1fe2ca610cd3eaa6d9666fe5e62b988bf7f0bd8722::musd::MUSD')])
    expect(maybeAftermathLp(LP)).toBe(true)
    expect(maybeAftermathLp(SUI)).toBe(false)
  })

  it('协议手续费：0.05%，国库 / 保险基金 / 开发者各自向下取整（主网交易 26S6aouo… 的数字）', () => {
    expect(protocolFeeOf(75394313164n, fees)).toBe(37697155n)
  })

  it('按比例取回：r = lp / 总量，每种币 = 储备 × r，再扣协议手续费；DAO 费池子再扣 fee_bps', () => {
    const base = parseAftermathPool(raw)
    if (!base) throw new Error('parse')
    const pool = { ...base, shared: null, dao: null }
    const lp = 1_000_000_000_000n
    const r = (lp * 10n ** 18n) / pool.lpSupply
    const gross = pool.normalized.map((n) => (n * r) / 10n ** 18n / 10n ** 18n)
    expect(withdrawAllAmounts(pool, lp, fees)).toEqual(gross.map((g) => g - protocolFeeOf(g, fees)))
    const dao = withdrawAllAmounts({ ...pool, dao: { id: '0x1', shared: { objectId: '0x1', initialSharedVersion: 1n }, feeBps: 100 } }, lp, fees)
    expect(dao).toEqual(gross.map((g) => g - protocolFeeOf(g, fees)).map((x) => x - x / 100n))
  })
})

