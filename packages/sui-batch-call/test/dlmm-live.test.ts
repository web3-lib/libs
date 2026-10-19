/**
 * Cetus DLMM 的仓位和加减流动性连主网（只读、模拟，不发送），默认跳过：
 * `LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/dlmm-live.test.ts`
 * 地址是 2026-10 时有仓位 / 持币的真实地址，之后可能变化
 */
import { describe, expect, it } from 'vitest'

import { SuiClient } from '../src/index.js'
import { lpPositions, type SuiLpDlmmPosition } from '../src/lp.js'
import { addLiquidity, buildAddLiquidity, buildCollectFees, buildRemoveLiquidity, removeLiquidity } from '../src/subpaths/liquidity.js'
import { batchCall } from '../src/subpaths/write.js'

const live = process.env.LIVE ? describe : describe.skip
const sui = new SuiClient(process.env.SUI_GRPC)
/** 持有 USDC 和 SUI */
const HOLDER = '0x9f63425709069336fec108bd4ba69a8f3d23e8ab237311f3ce58ae2bb0ed4d7f'
/** 有一个 USDC / SUI 仓位 */
const OWNER = '0x68e3d704f4ca71a3188a5b1a4e4899e6e59d3ceff0e1cb6e23121f2fe88012b4'
const POSITION = '0xff7e679577e2541720a2c23b95f574e35e898da5ac7f0b9871d15c8d74e6fa80'
/** USDC / SUI，bin step 50 */
const POOL = '0x64e590b0e4d4f7dfc7ae9fae8e9983cd80ad83b658d8499bf550a9d4f6667076'

const watchOnly = (address: string) => ({ address, signTransaction: async (): Promise<string> => Promise.reject(new Error('watch-only')) })

const position = async () => {
  const [p] = (await lpPositions(sui, OWNER, { positions: [POSITION] })).filter((x): x is SuiLpDlmmPosition => x.type === 'dlmm')
  if (!p) throw new Error('no position')
  return p
}

live('Cetus DLMM（主网）', { timeout: 180_000 }, () => {
  it('仓位：数量、手续费、奖励由合约算出', async () => {
    const p = await position()
    expect(p).toMatchObject({ protocol: 'cetus-dlmm', position: POSITION, binStep: 50 })
    expect(p.binLower).toBeLessThanOrEqual(p.binUpper)
    expect(p.fees0).not.toBe(null)
    expect(p.rewards?.length).toBeGreaterThan(0)
    expect(p.inRange).toBe(p.binLower <= p.activeBin && p.activeBin <= p.binUpper)
  })

  it('部分移除 / 领取 / 全部移除并关闭（模拟）', async () => {
    const p = await position()
    const plans = [
      await buildRemoveLiquidity(sui, OWNER, { position: p, percent: 50 }),
      await buildCollectFees(sui, OWNER, { position: p }),
      await buildRemoveLiquidity(sui, OWNER, { position: p, burn: true }),
    ]
    expect(plans[0]).toMatchObject({ type: 'dlmm', liquidity: '5000', binStep: 50 })
    expect(BigInt(plans[0]?.amount1 ?? 0)).toBe(BigInt(p.amount1 ?? 0) / 2n)
    // 持有人不一定有 SUI 付 gas：由 HOLDER 赞助
    const results = await batchCall(sui, plans.map((x) => ({ from: watchOnly(OWNER), kind: x.kind, sponsor: watchOnly(HOLDER) })), { dryRun: true, continueOnError: true })
    expect(results.map((r) => [r.status, r.error])).toEqual(plans.map(() => ['simulated', null]))
    const r = await removeLiquidity(sui, watchOnly(OWNER), { position: p, percent: 10 }, { dryRun: true, sponsor: watchOnly(HOLDER) })
    expect([r.status, r.error]).toEqual(['simulated', null])
    await expect(buildRemoveLiquidity(sui, OWNER, { position: p, liquidity: 1n })).rejects.toThrow(/by percent/)
  })

  it('新建仓位：跨当前价格两边、价格上方只放 token0（模拟）；追加到已有仓位', async () => {
    // 按价格给区间：报价里的 tick 是池子当前的 bin
    const quote = await buildAddLiquidity(sui, HOLDER, { pool: POOL, priceLower: 0.5, priceUpper: 2, amount0Formatted: '1', amount1Formatted: '1' })
    expect(quote).toMatchObject({ type: 'dlmm', fixed: null, amount0Min: '0' })
    expect((quote.tickLower as number) <= (quote.tick as number) && (quote.tick as number) <= (quote.tickUpper as number)).toBe(true)
    const active = quote.tick as number
    const plans = [
      await buildAddLiquidity(sui, HOLDER, { pool: POOL, tickLower: active - 10, tickUpper: active + 10, amount0Formatted: '1', amount1Formatted: '1' }),
      await buildAddLiquidity(sui, HOLDER, { pool: POOL, tickLower: active + 2, tickUpper: active + 12, amount0Formatted: '1' }),
      await buildAddLiquidity(sui, HOLDER, { pool: POOL, tickLower: active - 12, tickUpper: active - 2, amount1Formatted: '1' }),
    ]
    expect(plans[1]?.amount1Max).toBe('0')
    expect(plans[2]?.amount0Max).toBe('0')
    const results = await batchCall(sui, plans.map((x) => ({ from: watchOnly(HOLDER), kind: x.kind })), { dryRun: true, continueOnError: true })
    expect(results.map((r) => [r.status, r.error])).toEqual(plans.map(() => ['simulated', null]))
    const r = await addLiquidity(sui, watchOnly(HOLDER), { pool: POOL, tickLower: active - 5, tickUpper: active + 5, amount0Formatted: '0.5', amount1Formatted: '0.5' }, { dryRun: true })
    expect([r.status, r.error]).toEqual(['simulated', null])
    await expect(buildAddLiquidity(sui, HOLDER, { pool: POOL, tickLower: active + 2, tickUpper: active + 12, amount1Formatted: '1' })).rejects.toThrow(/only token0/)
    // 追加到持有人的仓位（2026-10 时持有人有少量 USDC 和 SUI）
    const p = await position()
    const append = await buildAddLiquidity(sui, OWNER, { position: p, amount0: 1000n, amount1: 1_000_000n })
    expect(append).toMatchObject({ position: POSITION, tickLower: p.binLower, tickUpper: p.binUpper })
    const [a] = await batchCall(sui, [{ from: watchOnly(OWNER), kind: append.kind }], { dryRun: true })
    expect([a?.status, a?.error]).toEqual(['simulated', null])
  })
})
