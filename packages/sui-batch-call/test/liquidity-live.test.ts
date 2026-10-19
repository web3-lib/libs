/**
 * LP 仓位和加减流动性连主网（只读调用、模拟，不发送），默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/liquidity-live.test.ts`
 * 地址是 2026-10 时的真实地址（有 Cetus 仓位 / 持有 USDC 和 SUI），之后可能变化
 */
import { describe, expect, it } from 'vitest'

import { SuiClient } from '../src/index.js'
import { lpPositions } from '../src/lp.js'
import { addLiquidity, buildAddLiquidity, buildCollectFees, buildRemoveLiquidity, collectFees, removeLiquidity } from '../src/subpaths/liquidity.js'
import { batchCall } from '../src/subpaths/write.js'

const live = process.env.LIVE ? describe : describe.skip
const sui = new SuiClient(process.env.SUI_GRPC)
/** 有一个 Cetus USDC / SCA 仓位（在区间外，只有 SCA） */
const LP_OWNER = '0xa2b525b3a6061b515448c72812af6efbcee34eee377cc2f97d550e61acf926cd'
/** 持有 USDC 和 SUI */
const HOLDER = '0x9f63425709069336fec108bd4ba69a8f3d23e8ab237311f3ce58ae2bb0ed4d7f'
/** 一个普通的 Cetus 仓位（GIGATRUMP / SUI） */
const NORMAL_OWNER = '0x4ae27fc3d16fd33bc017ceaed23d5b6242cfe95b9c073a3546b2242f6b354b50'
const NORMAL_POSITION = '0xfffa73532099a5b655d5d0c3a7827780718c9df98625edc19d61ed4ef617c215'
/** Cetus USDC / SUI 0.05% */
const POOL = '0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab'

const watchOnly = (address: string) => ({ address, signTransaction: async (): Promise<string> => Promise.reject(new Error('watch-only')) })

live('Sui LP（主网）', { timeout: 120_000 }, () => {
  it('仓位：数量、手续费、奖励由合约算出', async () => {
    const list = await lpPositions(sui, LP_OWNER, { includeClosed: true })
    const p = list.find((x) => x.liquidity !== '0')
    expect(p).toMatchObject({ type: 'clmm', protocol: 'cetus', token0: { symbol: 'USDC', decimals: 6 } })
    expect(p?.fees0).not.toBe(null)
    expect(p?.rewards?.length).toBeGreaterThan(0)
    expect(p?.inRange).toBe((p?.tickLower ?? 0) <= (p?.tick ?? 0) && (p?.tick ?? 0) < (p?.tickUpper ?? 0))
  })

  it('新建仓位：报价（合约的数学函数）+ 模拟', async () => {
    const plan = await buildAddLiquidity(sui, HOLDER, { pool: POOL, fullRange: false, priceLower: 0.0001, priceUpper: 10_000, amount0Formatted: '1' })
    expect(plan.fixed).toBe('token0')
    expect(plan.amount0).toBe('1000000')
    expect(BigInt(plan.amount1Max)).toBeGreaterThan(BigInt(plan.amount1))
    const [sim] = await batchCall(sui, [{ from: watchOnly(HOLDER), kind: plan.kind }], { dryRun: true })
    expect([sim?.status, sim?.error]).toEqual(['simulated', null])
    // 发送接口的 dryRun（SUI 从 gas 币拆）
    const r = await addLiquidity(sui, watchOnly(HOLDER), { pool: POOL, priceLower: 0.1, priceUpper: 10, amount1Formatted: '0.5' }, { dryRun: true })
    expect([r.status, r.error]).toEqual(['simulated', null])
    expect(r.plan.fixed).toBe('token1')
  })

  it('已有仓位：部分移除 / 领取 / 全部移除并关闭（模拟）', async () => {
    const [position] = (await lpPositions(sui, NORMAL_OWNER, { positions: [NORMAL_POSITION] })).filter((x) => x.liquidity !== '0')
    if (!position) throw new Error('no position')
    expect(position.restricted).toBe(false)
    const remove = await buildRemoveLiquidity(sui, NORMAL_OWNER, { position, percent: 50 })
    expect(BigInt(remove.liquidity)).toBe(BigInt(position.liquidity ?? '0') / 2n)
    expect(BigInt(remove.amount1Min)).toBeLessThanOrEqual(BigInt(remove.amount1))
    const collect = await buildCollectFees(sui, NORMAL_OWNER, { position })
    const burn = await buildRemoveLiquidity(sui, NORMAL_OWNER, { position: position.position, burn: true })
    expect(burn.burn).toBe(true)
    const results = await batchCall(sui, [remove, collect, burn].map((p) => ({ from: watchOnly(NORMAL_OWNER), kind: p.kind })), { dryRun: true, continueOnError: true })
    expect(results.map((r) => [r.status, r.error])).toEqual([
      ['simulated', null],
      ['simulated', null],
      ['simulated', null],
    ])
    const r1 = await removeLiquidity(sui, watchOnly(NORMAL_OWNER), { position, percent: 10 }, { dryRun: true })
    const r2 = await collectFees(sui, watchOnly(NORMAL_OWNER), { position }, { dryRun: true })
    expect([r1.status, r2.status]).toEqual(['simulated', 'simulated'])
  })

  it('受攻击影响的仓位：部分移除可以，全部移除提前报错', async () => {
    const [position] = (await lpPositions(sui, LP_OWNER)).filter((x) => x.liquidity !== '0')
    if (!position) throw new Error('no position')
    expect(position.restricted).toBe(true)
    const r = await removeLiquidity(sui, watchOnly(LP_OWNER), { position, percent: 50 }, { dryRun: true })
    expect([r.status, r.error]).toEqual(['simulated', null])
    await expect(buildRemoveLiquidity(sui, LP_OWNER, { position, burn: true })).rejects.toThrow(/is_attacked_position/)
  })

  it('追加到已有仓位（模拟）', async () => {
    const [position] = (await lpPositions(sui, NORMAL_OWNER, { positions: [NORMAL_POSITION] })).filter((x) => x.liquidity !== '0')
    if (!position) throw new Error('no position')
    // 只加 SUI 那一边（区间外时另一边为 0）或按比例
    const side = position.amount1 !== '0' ? { amount1: 1_000_000n } : { amount0: 1_000_000n }
    const plan = await buildAddLiquidity(sui, NORMAL_OWNER, { position, ...side })
    expect(plan.position).toBe(position.position)
    const [r] = await batchCall(sui, [{ from: watchOnly(NORMAL_OWNER), kind: plan.kind }], { dryRun: true })
    expect([r?.status, r?.error]).toEqual(['simulated', null])
  })

  it('区间在价格一侧（只需要一种代币）、窄区间靠近边界', async () => {
    const quote = await buildAddLiquidity(sui, HOLDER, { pool: POOL, fullRange: true, amount0: 1_000_000n })
    const price = quote.price as number
    // 区间在当前价格上方：只要 token0（USDC）
    const above = await buildAddLiquidity(sui, HOLDER, { pool: POOL, priceLower: price * 1.05, priceUpper: price * 1.2, amount0Formatted: '1' })
    expect(above.amount1Max).toBe('0')
    await expect(buildAddLiquidity(sui, HOLDER, { pool: POOL, priceLower: price * 1.05, priceUpper: price * 1.2, amount1Formatted: '1' })).rejects.toThrow(/only token0/)
    // 两边都给时只用需要的一边
    const both = await buildAddLiquidity(sui, HOLDER, { pool: POOL, priceLower: price * 1.05, priceUpper: price * 1.2, amount0Formatted: '1', amount1Formatted: '1' })
    expect([both.fixed, both.amount1Max]).toEqual(['token0', '0'])
    // 窄区间：当前 tick 离上边界一格，固定 token0，滑点场景不越过边界
    const t = Math.floor(quote.tick / 10) * 10
    const narrow = await buildAddLiquidity(sui, HOLDER, { pool: POOL, tickLower: t - 100, tickUpper: t + 10, amount0Formatted: '1' })
    const results = await batchCall(sui, [above, narrow].map((p) => ({ from: watchOnly(HOLDER), kind: p.kind })), { dryRun: true, continueOnError: true })
    expect(results.map((r) => [r.status, r.error])).toEqual([
      ['simulated', null],
      ['simulated', null],
    ])
  })

  it('参数错误', async () => {
    await expect(buildAddLiquidity(sui, HOLDER, { pool: POOL, priceLower: 2, priceUpper: 1, amount0: 1n })).rejects.toThrow(/Invalid range/)
    await expect(buildAddLiquidity(sui, HOLDER, { pool: POOL, fullRange: true })).rejects.toThrow(/amount/)
    await expect(buildAddLiquidity(sui, HOLDER, { pool: LP_OWNER, fullRange: true, amount0: 1n })).rejects.toThrow(/supported pool/)
  })
})
