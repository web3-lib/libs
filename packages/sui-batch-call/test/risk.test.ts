/**
 * 代币风险检查：监管币、TreasuryCap / 元数据的权限、全局暂停 / 地址冻结、模拟买入再卖出（假节点，不连网络）
 */
import { describe, expect, it } from 'vitest'

import { SUI_COIN_TYPE, SuiClient, normalizeStructTag, normalizeSuiAddress } from '../src/index.js'
import { ProtoWriter } from '../src/proto.js'
import { coinRisks } from '../src/subpaths/risk.js'
import { FakeSui, hasId } from './swapFake.js'

const COIN = normalizeStructTag('0xc0::usd::USD')
const MEME = normalizeStructTag('0xc1::meme::MEME')
const OWNER = normalizeSuiAddress('0xa1')
const id = (n: number) => normalizeSuiAddress(`0x${n.toString(16)}`)
const DIPCOIN = '0xdae28ab9ab072c647c4e8f2057a8f17dcc4847e42d6a8258df4b376ae183c872'

/** GetCoinInfo 的响应：CoinMetadata(2)、CoinTreasury(3)、RegulatedCoinMetadata(4) */
function coinInfo(coinType: string, f: { meta: string; capState: number; capId?: string; treasury?: string; supplyState?: number; regulated?: number; denyCap?: string }) {
  const meta = new ProtoWriter().string(1, f.meta).uint(2, 6).string(3, 'X').string(4, coinType.split('::').pop()).string(7, f.capId).uint(8, f.capState)
  const treasury = new ProtoWriter().string(1, f.treasury).uint(2, 1_000_000n).uint(3, f.supplyState ?? 0)
  const regulated = new ProtoWriter().string(3, f.denyCap).uint(6, f.regulated ?? 2)
  return new ProtoWriter().string(1, coinType).message(2, meta).message(3, treasury).message(4, regulated)
}

describe('coinRisks', () => {
  it('监管币：DenyCapV2 和 TreasuryCap 放在共享对象的动态字段里（找到最外层）；全局暂停、地址冻结由只读调用读出', async () => {
    const node = new FakeSui()
    node.coins.set(COIN, { decimals: 6, symbol: 'USD', raw: coinInfo(COIN, { meta: id(0x10), capState: 2, treasury: id(0x11), regulated: 1, denyCap: id(0x12) }) })
    node.add(
      { id: id(0x10), type: `0x2::coin_registry::Currency<${COIN}>`, owner: 'shared', json: {} },
      { id: id(0x11), type: `0x2::coin::TreasuryCap<${COIN}>`, owner: { object: id(0x20) }, json: {} },
      { id: id(0x12), type: `0x2::coin::DenyCapV2<${COIN}>`, owner: { object: id(0x21) }, json: { allow_global_pause: true } },
      { id: id(0x20), type: '0x2::dynamic_field::Field<…>', owner: { object: id(0x30) } },
      { id: id(0x21), type: '0x2::dynamic_field::Field<…>', owner: { object: id(0x30) } },
      { id: id(0x30), type: `0xc0::treasury::Treasury<${COIN}>`, owner: 'shared' },
      { id: '0x403', type: '0x2::deny_list::DenyList', owner: 'shared' },
    )
    let denyTx: Uint8Array | null = null
    node.inspect = (tx) => {
      denyTx = tx
      return [true, false]
    }
    const [r] = await coinRisks(new SuiClient(node), [COIN], { address: OWNER, sell: false })
    expect(r).toMatchObject({
      token: COIN,
      exists: true,
      symbol: 'USD',
      regulated: true,
      allowGlobalPause: true,
      paused: true,
      denied: false,
      supply: 'mintable',
      totalSupply: '1000000',
      treasuryCap: { id: id(0x11), owner: 'object', root: { id: id(0x30), type: `0xc0::treasury::Treasury<${COIN}>`, owner: 'shared' } },
      denyCap: { id: id(0x12), owner: 'object', root: { id: id(0x30) } },
      metadata: { id: id(0x10), type: 'currency', owner: 'shared' },
      metadataMutable: true,
      sell: null,
      honeypot: null,
    })
    expect(r?.flags).toEqual(['regulated', 'global-pause', 'paused', 'mintable', 'mutable-metadata'])
    // 只读调用里查的是 DenyList（0x403）和传入的地址
    expect(hasId(denyTx as unknown as Uint8Array, '0x403')).toBe(true)
    expect(hasId(denyTx as unknown as Uint8Array, OWNER)).toBe(true)
  })

  it('TreasuryCap 转给了 0x0、旧的 CoinMetadata 已冻结：不能增发、元数据不能改；不是监管币不做只读调用；不存在的代币', async () => {
    const node = new FakeSui()
    node.coins.set(MEME, { decimals: 9, symbol: 'MEME', raw: coinInfo(MEME, { meta: id(0x40), capState: 0, treasury: id(0x41), regulated: 2 }) })
    node.add(
      { id: id(0x40), type: `0x2::coin::CoinMetadata<${MEME}>`, owner: 'immutable', json: {} },
      { id: id(0x41), type: `0x2::coin::TreasuryCap<${MEME}>`, owner: '0x0', json: {} },
    )
    const [r, missing] = await coinRisks(new SuiClient(node), [MEME, '0xc2::nope::NOPE'], { sell: false })
    expect(r).toMatchObject({ regulated: false, allowGlobalPause: false, paused: false, denied: null, supply: 'fixed', treasuryCap: { owner: 'burned' }, metadataMutable: false, metadata: { type: 'coin-metadata', owner: 'immutable' }, flags: [] })
    expect(missing).toMatchObject({ exists: false, regulated: null, supply: 'unknown', treasuryCap: null, flags: ['not-found'] })
    expect(node.count('SimulateTransaction')).toBe(0)
  })

  it('MetadataCap 已删除 / 已领取；TreasuryCap 已冻结 = 固定供应；节点读不到 TreasuryCap = 不知道', async () => {
    const node = new FakeSui()
    const a = normalizeStructTag('0xc3::a::A')
    const b = normalizeStructTag('0xc4::b::B')
    node.coins.set(a, { decimals: 9, symbol: 'A', raw: coinInfo(a, { meta: id(0x50), capState: 3, treasury: id(0x51) }) })
    node.coins.set(b, { decimals: 9, symbol: 'B', raw: coinInfo(b, { meta: id(0x60), capState: 1, capId: id(0x62), treasury: id(0x61) }) })
    node.add(
      { id: id(0x50), type: `0x2::coin_registry::Currency<${a}>`, owner: 'shared' },
      { id: id(0x51), type: `0x2::coin::TreasuryCap<${a}>`, owner: 'immutable' },
      { id: id(0x60), type: `0x2::coin_registry::Currency<${b}>`, owner: 'shared' },
      { id: id(0x62), type: `0x2::coin_registry::MetadataCap<${b}>`, owner: OWNER },
    )
    const [ra, rb] = await coinRisks(new SuiClient(node), [a, b], { sell: false })
    expect(ra).toMatchObject({ supply: 'fixed', treasuryCap: { owner: 'immutable' }, metadataMutable: false, flags: [] })
    expect(rb).toMatchObject({ supply: 'unknown', treasuryCap: { owner: 'not-found' }, metadataMutable: true, metadataCap: { owner: 'address', address: OWNER } })
    expect(rb?.flags).toEqual(['supply-unknown', 'mutable-metadata'])
  })

  it('权限对象没人能用：TreasuryCap 在冻结的对象里 = 不能增发；DenyCapV2 的最外层对象转给了 0x0 = 不能冻结（不标记 regulated）；已领取的 MetadataCap 转给了 0x0 = 元数据不能改', async () => {
    const node = new FakeSui()
    node.coins.set(COIN, { decimals: 6, symbol: 'USD', raw: coinInfo(COIN, { meta: id(0x10), capState: 1, capId: id(0x13), treasury: id(0x11), regulated: 1, denyCap: id(0x12) }) })
    node.add(
      { id: id(0x10), type: `0x2::coin_registry::Currency<${COIN}>`, owner: 'shared' },
      { id: id(0x11), type: `0x2::coin::TreasuryCap<${COIN}>`, owner: { object: id(0x20) } },
      { id: id(0x20), type: '0xc0::vault::Vault', owner: 'immutable' },
      { id: id(0x12), type: `0x2::coin::DenyCapV2<${COIN}>`, owner: { object: id(0x21) }, json: { allow_global_pause: true } },
      { id: id(0x21), type: '0xc0::vault::Holder', owner: '0x0' },
      { id: id(0x13), type: `0x2::coin_registry::MetadataCap<${COIN}>`, owner: '0x0' },
      { id: '0x403', type: '0x2::deny_list::DenyList', owner: 'shared' },
    )
    node.inspect = () => [false]
    const [r] = await coinRisks(new SuiClient(node), [COIN], { sell: false })
    expect(r).toMatchObject({
      regulated: true,
      canFreeze: false,
      allowGlobalPause: true,
      supply: 'fixed',
      treasuryCap: { owner: 'object', root: { owner: 'immutable' } },
      denyCap: { owner: 'object', root: { owner: 'burned' } },
      metadataCap: { owner: 'burned' },
      metadataMutable: false,
    })
    expect(r?.flags).toEqual([])
  })

  it('v1 监管币（coin::DenyCap）：地址名单用 coin::deny_list_contains 查，没有全局暂停（paused 为 null）', async () => {
    const node = new FakeSui()
    node.coins.set(COIN, { decimals: 6, symbol: 'USD', raw: coinInfo(COIN, { meta: id(0x10), capState: 2, treasury: id(0x11), regulated: 1, denyCap: id(0x12) }) })
    node.add(
      { id: id(0x10), type: `0x2::coin_registry::Currency<${COIN}>`, owner: 'shared' },
      { id: id(0x11), type: `0x2::coin::TreasuryCap<${COIN}>`, owner: OWNER },
      { id: id(0x12), type: `0x2::coin::DenyCap<${COIN}>`, owner: OWNER },
      { id: '0x403', type: '0x2::deny_list::DenyList', owner: 'shared' },
    )
    const calls: string[] = []
    node.inspect = (tx) => {
      const text = new TextDecoder('latin1').decode(tx)
      calls.push(['deny_list_contains', 'deny_list_v2_contains_current_epoch', 'deny_list_v2_is_global_pause_enabled_current_epoch'].filter((f) => text.includes(f)).join(','))
      return [true]
    }
    const [r] = await coinRisks(new SuiClient(node), [COIN], { sell: false, address: OWNER })
    expect(calls).toEqual(['deny_list_contains'])
    expect(r).toMatchObject({ regulated: true, canFreeze: true, allowGlobalPause: false, paused: null, denied: true, supply: 'mintable', metadataMutable: true })
    expect(r?.flags).toEqual(['regulated', 'denied', 'mintable', 'mutable-metadata'])
    // 不传地址时 v1 不需要只读调用
    calls.length = 0
    const [r2] = await coinRisks(new SuiClient(node), [COIN], { sell: false })
    expect(calls).toEqual([])
    expect(r2).toMatchObject({ paused: null, denied: null })
  })

  it('能不能卖：同一笔只读调用里买入再卖出；卖不出时是 honeypot；SUI 不检查', async () => {
    const node = new FakeSui()
    const pool = id(0x70)
    node.coins.set(MEME, { decimals: 9, symbol: 'MEME', raw: coinInfo(MEME, { meta: id(0x40), capState: 3, treasury: id(0x41), regulated: 2 }) })
    node.add(
      { id: id(0x40), type: `0x2::coin_registry::Currency<${MEME}>`, owner: 'shared' },
      { id: id(0x41), type: `0x2::coin::TreasuryCap<${MEME}>`, owner: 'immutable' },
      { id: pool, type: `${DIPCOIN}::manage::Pool<${SUI_COIN_TYPE}, ${MEME}>`, owner: 'shared', json: { bal_x: '1000000000000', bal_y: '1000000000000', lp_supply: { value: '1' }, fee_rate: '30' } },
    )
    const text = (tx: Uint8Array) => new TextDecoder('latin1').decode(tx)
    let sellWorks = true
    node.inspect = (tx) => {
      const selling = text(tx).includes('swap_exact_y_to_x_with_return')
      if (selling && !sellWorks) return null
      return Array.from({ length: 20 }, (_, i) => (selling && i > 3 ? '99000000' : '50000000'))
    }
    const options = { swap: { protocols: [], pools: [pool] } }
    const [ok, s] = await coinRisks(new SuiClient(node), [MEME, SUI_COIN_TYPE], options)
    expect(ok?.sell).toMatchObject({ stage: 'ok', route: [{ protocol: 'dipcoin', pool }], amountIn: '100000000', bought: '50000000', back: '99000000', error: null })
    expect(ok?.sell?.roundTripLoss).toBeCloseTo(0.01)
    expect(ok?.honeypot).toBe(false)
    expect(s?.sell).toBe(null)
    sellWorks = false
    const [bad] = await coinRisks(new SuiClient(node), [MEME], options)
    expect(bad).toMatchObject({ honeypot: true, sell: { stage: 'sell-failed', bought: '50000000', back: null } })
    expect(bad?.flags).toEqual(['honeypot'])
    const [none] = await coinRisks(new SuiClient(node), [MEME], { swap: { protocols: [], pools: [] } })
    expect(none).toMatchObject({ honeypot: null, sell: { stage: 'no-pool' }, flags: ['no-pool'] })
  })
})
