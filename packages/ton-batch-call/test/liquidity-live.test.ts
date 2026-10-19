/**
 * LP 仓位和加减流动性连主网（只读 + emulateTrace 模拟，不发送），默认跳过：
 * `LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/liquidity-live.test.ts`（TONCENTER_API_KEY 可选，快很多）
 * 地址是 2026-10 时的真实 LP 持有人
 */
import { describe, expect, it } from 'vitest'

import { TonClient } from '../src/index.js'
import { lpPositions } from '../src/lp.js'
import { addLiquidity, buildAddLiquidity, buildRemoveLiquidity, removeLiquidity } from '../src/subpaths/liquidity.js'
import type { TonConnectLike } from '../src/subpaths/write.js'

const live = process.env.LIVE ? describe : describe.skip
const ton = new TonClient(undefined, process.env.TONCENTER_API_KEY ? { apiKey: process.env.TONCENTER_API_KEY } : {})
/** v4r2：STON.fi v2 USD₮/TON、NOT/TON，DeDust JETTON/USD₮ */
const HOLDER_A = '0:C3AC62A4A83FCB5C4ED3F8FB6C70C260708F9C3D0883D11F080850E71197D480'
/** 不是 v4r2 / v5r1 钱包（模拟不了）：DeDust TON/USD₮，STON.fi v2 USD₮/TON */
const HOLDER_B = '0:489595F65115A45C24A0DD0176309654FB00B95E40682F0C3E85D5A4D86DFB25'
/** v4r2：DeDust TON/USD₮，STON.fi v1 CATI/TON */
const HOLDER_C = '0:30B06FA3D9E8087CA8AC5012C1BA245831AB9117C350A25F719A0A7741EE713B'

const watchOnly = (address: string): TonConnectLike => ({
  wallet: { account: { address }, device: { features: [{ name: 'SendTransaction', maxMessages: 4 }] } },
  sendTransaction: async () => Promise.reject(new Error('watch-only')),
})

live('TON LP（主网）', { timeout: 300_000 }, () => {
  it('仓位：三个协议，按份额算出数量', async () => {
    const list = await lpPositions(ton, HOLDER_B)
    const dedust = list.find((p) => p.protocol === 'dedust')
    expect(dedust).toMatchObject({ type: 'amm', token0: { address: 'TON', decimals: 9 }, poolType: 'volatile' })
    expect(BigInt(dedust?.amount0 ?? '0')).toBe((BigInt(dedust?.balance ?? '0') * BigInt(dedust?.reserve0 ?? '0')) / BigInt(dedust?.totalSupply ?? '1'))
    expect(list.some((p) => p.protocol === 'stonfi-v2')).toBe(true)
    expect((await lpPositions(ton, HOLDER_C)).some((p) => p.protocol === 'stonfi-v1')).toBe(true)
  })

  it('移除（模拟）：STON.fi v2 / v1、DeDust，取回的代币到账', async () => {
    for (const [holder, protocol] of [
      [HOLDER_A, 'stonfi-v2'],
      [HOLDER_C, 'dedust'],
      [HOLDER_C, 'stonfi-v1'],
    ] as const) {
      const position = (await lpPositions(ton, holder, { protocols: [protocol] }))[0]
      if (!position) throw new Error(`no ${protocol} position`)
      const r = await removeLiquidity(ton, watchOnly(holder), { position, percent: 10 }, { dryRun: true })
      expect([protocol, r.status, r.error]).toEqual([protocol, 'simulated', null])
      expect(BigInt(r.plan.lpAmount ?? '0')).toBe(BigInt(position.balance) / 10n)
    }
  })

  it('添加（模拟）：STON.fi v2 和 DeDust 的 TON / 代币池，LP 发到用户的 LP 钱包', async () => {
    const v2 = (await lpPositions(ton, HOLDER_A, { protocols: ['stonfi-v2'] })).find((p) => p.token1.address === 'TON' || p.token0.address === 'TON')
    const dedust = (await lpPositions(ton, HOLDER_C, { protocols: ['dedust'] }))[0]
    if (!v2 || !dedust) throw new Error('no positions')
    const plan = await buildAddLiquidity(ton, HOLDER_A, { position: v2, amount1Formatted: '0.1' })
    expect(plan.messages.length).toBe(2)
    expect(BigInt(plan.minLpOut ?? '0')).toBeLessThan(BigInt(plan.lpAmount ?? '0'))
    for (const [holder, position] of [
      [HOLDER_A, v2],
      [HOLDER_C, dedust],
    ] as const) {
      const tonSide = position.token0.address === 'TON' ? { amount0Formatted: '0.1' } : { amount1Formatted: '0.1' }
      const r = await addLiquidity(ton, watchOnly(holder), { position, ...tonSide }, { dryRun: true })
      expect([position.protocol, r.status, r.error]).toEqual([position.protocol, 'simulated', null])
    }
  })

  it('移除超过持有的 LP、v1 添加报错', async () => {
    const [position] = await lpPositions(ton, HOLDER_C, { protocols: ['stonfi-v1'] })
    if (!position) throw new Error('no position')
    await expect(buildRemoveLiquidity(ton, HOLDER_C, { position, lpAmount: BigInt(position.balance) + 1n })).rejects.toThrow(/Only/)
    await expect(buildAddLiquidity(ton, HOLDER_C, { position, amount0: 1n })).rejects.toThrow(/v1/)
    void HOLDER_B
  })
})
