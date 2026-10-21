/**
 * 代币风险检查连主网（只读调用，不发送），默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/risk-live.test.ts`
 * 2026-10 的状态：USDC 是监管币（Circle 的 Treasury 共享对象里放着 TreasuryCap 和 DenyCapV2），CETUS 的 TreasuryCap 已冻结，
 * FUD 的 TreasuryCap 转给了 0x0，DEEP 的 TreasuryCap 放在 ProtectedTreasury 里
 */
import { describe, expect, it } from 'vitest'

import { SUI_COIN_TYPE, SuiClient } from '../src/index.js'
import { coinRisks } from '../src/subpaths/risk.js'

const live = process.env.LIVE ? describe : describe.skip
const retryFetch: typeof fetch = async (input, init) => {
  for (let i = 0; ; i++) {
    try {
      return await fetch(input, init)
    } catch (err) {
      if (i >= 4 || init?.signal?.aborted) throw err
      await new Promise((r) => setTimeout(r, 300 * (i + 1)))
    }
  }
}
const sui = new SuiClient(process.env.SUI_GRPC, { fetch: retryFetch, concurrency: 6 })
const HOLDER = '0x9f63425709069336fec108bd4ba69a8f3d23e8ab237311f3ce58ae2bb0ed4d7f'
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
const CETUS = '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS'
const FUD = '0x76cb819b01abed502bee8a702b4c2d547532c12f25001c9dea795a5e631c26f1::fud::FUD'
const DEEP = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP'

live('代币风险（Sui 主网）', { timeout: 300_000 }, () => {
  it('USDC、SUI、CETUS、FUD、DEEP', async () => {
    const [usdc, s, cetus, fud, deep] = await coinRisks(sui, [USDC, SUI_COIN_TYPE, CETUS, FUD, DEEP], { address: HOLDER, swap: { concurrency: 6 } })
    expect(usdc).toMatchObject({ regulated: true, allowGlobalPause: true, paused: false, denied: false, supply: 'mintable', honeypot: false })
    expect(usdc?.treasuryCap).toMatchObject({ owner: 'object', root: { owner: 'shared' } })
    expect(usdc?.treasuryCap?.root?.type).toMatch(/::treasury::Treasury</)
    expect(usdc?.denyCap?.owner).toBe('object')
    expect(usdc?.flags).toEqual(expect.arrayContaining(['regulated', 'global-pause', 'mintable']))
    expect(usdc?.sell).toMatchObject({ stage: 'ok' })
    expect(usdc?.sell?.roundTripLoss).toBeLessThan(0.05)

    expect(s).toMatchObject({ regulated: false, supply: 'fixed', metadataMutable: false, sell: null, flags: [] })

    expect(cetus).toMatchObject({ regulated: false, supply: 'fixed', treasuryCap: { owner: 'immutable' }, metadataCap: { owner: 'address' }, metadataMutable: true, honeypot: false })
    expect(cetus?.flags).toEqual(['mutable-metadata'])

    expect(fud).toMatchObject({ exists: true, regulated: false, supply: 'fixed', treasuryCap: { owner: 'burned' }, metadataMutable: false, honeypot: false })
    expect(fud?.sell?.stage).toBe('ok')
    expect(fud?.flags).toEqual([])

    expect(deep).toMatchObject({ supply: 'mintable', treasuryCap: { owner: 'object' } })
    expect(deep?.treasuryCap?.root?.type).toMatch(/::deep::ProtectedTreasury/)
    for (const r of [usdc, s, cetus, fud, deep]) console.log(r?.symbol, r?.supply, r?.metadataMutable, r?.sell?.stage, r?.sell?.roundTripLoss, r?.flags.join(','))
  })

  it('不存在的代币；没有池子的代币（不检查卖出时不找路线）', async () => {
    const [missing] = await coinRisks(sui, ['0x1234::nope::NOPE'], { sell: false })
    expect(missing).toMatchObject({ exists: false, supply: 'unknown', regulated: null, sell: null, flags: ['not-found'] })
    const [noPool] = await coinRisks(sui, ['0x1234::nope::NOPE'], { swap: { concurrency: 6 } })
    expect(noPool?.sell?.stage).toBe('no-pool')
    expect(noPool?.flags).toEqual(['not-found', 'no-pool'])
  })
})
