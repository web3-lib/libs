/**
 * 各 DEX 的 LP 仓位和加减流动性连主网（只读调用、模拟，不发送），默认跳过：
 * `LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/dex-live.test.ts`（DEX=bluefin 只跑一个）
 * 地址是 2026-10 时有仓位 / 持币的真实地址，之后可能变化
 */
import { describe, expect, it } from 'vitest'

import { SuiClient } from '../src/index.js'
import { lpPositions as allPositions, type LpPositionsOptions, type SuiLpClmmPosition } from '../src/lp.js'
import { addLiquidity, buildAddLiquidity, buildCollectFees, buildRemoveLiquidity, removeLiquidity } from '../src/subpaths/liquidity.js'
import { batchCall } from '../src/subpaths/write.js'

/** 这里只看集中流动性的仓位 */
const lpPositions = async (client: SuiClient, owner: string, options?: LpPositionsOptions) =>
  (await allPositions(client, owner, options)).filter((p): p is SuiLpClmmPosition => p.type === 'clmm')

const live = process.env.LIVE ? describe : describe.skip
const sui = new SuiClient(process.env.SUI_GRPC)
/** 持有 USDC 和 SUI（新建仓位用） */
const HOLDER = '0x9f63425709069336fec108bd4ba69a8f3d23e8ab237311f3ce58ae2bb0ed4d7f'
const watchOnly = (address: string) => ({ address, signTransaction: async (): Promise<string> => Promise.reject(new Error('watch-only')) })

interface Case {
  protocol: 'bluefin' | 'momentum' | 'turbos' | 'flowx' | 'magma' | 'kriya-clmm'
  /** 有仓位的地址和仓位 */
  owner: string
  position: string
  /** 新建仓位用的 SUI / USDC 池子 */
  pool: string
}

const CASES: Case[] = [
  {
    protocol: 'bluefin',
    owner: '0x95b9f5ad34c4c987d011e00472591b835906ff2c0381409ccf7038b7c54ebec7',
    position: '0x00071152cab50d0d2708765869273818e9aa1ec982fc88c93fc6331b1765f478',
    pool: '0x3b585786b13af1d8ea067ab37101b6513a05d2f90cfe60e8b1d9e1b46a63c4fa',
  },
  {
    protocol: 'momentum',
    owner: '0xd296f7f43c8c48f1de676eb898398bd36401a16cec5000245c19626b2897c359',
    position: '0x00017c08b581aef1bb6e742cc072b1c2c17d9cec629fa5f9dbaad466f47c620e',
    pool: '0x455cf8d2ac91e7cb883f515874af750ed3cd18195c970b7a2d46235ac2b0c388',
  },
  {
    protocol: 'turbos',
    owner: '0xa7b9ddd98dbcde45276dc204a1a20a1ff15c129da6a5ec997301cbc9ba179a24',
    position: '0xd4f9ddf81688146dd1843d00e9ff3f092ce6b55a7d01f4d337e2df05255e32b2',
    pool: '0x0df4f02d0e210169cb6d5aabd03c3058328c06f2c4dbb0804faa041159c78443',
  },
  {
    protocol: 'flowx',
    owner: '0xc02b3a404ff72ffede0f6ebf0356f4f5c0ba5431c0e052fb1eb086ebf0713334',
    position: '0x09adb02c9a250c04360da87466bd15500d5b8b8fffcc42f79092f80e2a803d92',
    pool: '0x325239132e2b619147c00052986461cea02815172ea9d000c58e68484f514a90',
  },
  {
    protocol: 'magma',
    owner: '0x9b42721c812a1eccf083038313b05833c0c7bd1be47d77382066e77623329b0f',
    position: '0xfe57d2b1cd66230b0b157b92b710183f8a333742c1bdec57a383b23b7a097ab7',
    // USDC / SUI（token0 是 USDC）
    pool: '0xff8c47de1f04e4889bd3dbe06e87ceb61d44c2380f43d2a4fb2bc582ff8e51dd',
  },
  {
    protocol: 'kriya-clmm',
    owner: '0x0f2671a9f2aa80018889ade3e6d5a2222cb015c5e45d7ecd8dd4f2209137b6d9',
    position: '0xffcf4aaed73c787c271d6d980cb4af01e520d732867ec492cc05c056870a9866',
    // SUI / wUSDC（Wormhole）
    pool: '0x367e02acb99632e18db69c3e93d89d21eb721e1d1fcebc0f6853667337450acc',
  },
]

for (const c of CASES.filter((x) => !process.env.DEX || x.protocol === process.env.DEX)) {
  live(`${c.protocol}（主网）`, { timeout: 180_000 }, () => {
    it('仓位：手续费、奖励由合约算出', async () => {
      const [p] = await lpPositions(sui, c.owner, { positions: [c.position] })
      expect(p).toMatchObject({ protocol: c.protocol, position: c.position })
      expect(p?.fees0).not.toBe(null)
      expect(p?.rewards).not.toBe(null)
      expect(p?.amount0).not.toBe(null)
    })

    it('部分移除 / 领取 / 全部移除并关闭（模拟）', async () => {
      const [position] = await lpPositions(sui, c.owner, { positions: [c.position] })
      if (!position) throw new Error('no position')
      const plans = [
        await buildRemoveLiquidity(sui, c.owner, { position, percent: 50 }),
        await buildCollectFees(sui, c.owner, { position }),
        await buildRemoveLiquidity(sui, c.owner, { position, burn: true }),
      ]
      const results = await batchCall(sui, plans.map((p) => ({ from: watchOnly(c.owner), kind: p.kind })), { dryRun: true, continueOnError: true })
      expect(results.map((r) => [r.status, r.error])).toEqual(plans.map(() => ['simulated', null]))
      const r = await removeLiquidity(sui, watchOnly(c.owner), { position, percent: 10 }, { dryRun: true })
      expect([r.status, r.error]).toEqual(['simulated', null])
    })

    it('追加到已有仓位（模拟）', async (ctx) => {
      const [position] = await lpPositions(sui, c.owner, { positions: [c.position] })
      if (!position) throw new Error('no position')
      // 仓位持有人不一定有另一种币：选一个持有人付得起的方向（两边都付不起时跳过）
      const balances = await sui.balances(c.owner, [position.token0.coinType, position.token1.coinType])
      const have = balances.map((b) => BigInt(b.balance))
      for (const side of [{ amount0: 1000n }, { amount1: 1000n }]) {
        // 数量很小、价格在窄区间里一直在动：滑点放宽到 5%（1000 个单位的 0.5% 只有 5）
        const plan = await buildAddLiquidity(sui, c.owner, { position, slippage: 0.05, ...side }).catch(() => null)
        if (!plan || BigInt(plan.amount0Max) > (have[0] ?? 0n) / 2n || BigInt(plan.amount1Max) > (have[1] ?? 0n) / 2n) continue
        const [r] = await batchCall(sui, [{ from: watchOnly(c.owner), kind: plan.kind }], { dryRun: true })
        expect([r?.status, r?.error]).toEqual(['simulated', null])
        return
      }
      console.log(`${c.protocol}: the position owner cannot afford either side, skipped`)
      ctx.skip()
    })

    it('新建仓位：区间内两边、区间一侧（模拟）', async () => {
      const quote = await buildAddLiquidity(sui, HOLDER, { pool: c.pool, fullRange: true, amount0Formatted: '0.1' })
      const price = quote.price as number
      const plans = [
        await buildAddLiquidity(sui, HOLDER, { pool: c.pool, priceLower: price * 0.8, priceUpper: price * 1.25, amount0Formatted: '0.1' }),
        await buildAddLiquidity(sui, HOLDER, { pool: c.pool, priceLower: price * 0.8, priceUpper: price * 1.25, amount1Formatted: '0.1' }),
        await buildAddLiquidity(sui, HOLDER, { pool: c.pool, priceLower: price * 1.1, priceUpper: price * 1.3, amount0Formatted: '0.1' }),
      ]
      const results = await batchCall(sui, plans.map((p) => ({ from: watchOnly(HOLDER), kind: p.kind })), { dryRun: true, continueOnError: true })
      expect(results.map((r) => [r.status, r.error])).toEqual(plans.map(() => ['simulated', null]))
      const r = await addLiquidity(sui, watchOnly(HOLDER), { pool: c.pool, priceLower: price * 0.9, priceUpper: price * 1.1, amount1Formatted: '0.1' }, { dryRun: true })
      expect([r.status, r.error]).toEqual(['simulated', null])
    })
  })
}
