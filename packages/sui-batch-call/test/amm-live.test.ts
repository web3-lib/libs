/**
 * 传统 AMM（DipCoin、FlowX V2、Kriya）的 LP 和加减流动性连主网（只读、模拟，不发送），默认跳过：
 * `LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/amm-live.test.ts`（DEX=dipcoin 只跑一个）
 * 地址是 2026-10 时持有 LP / 持币的真实地址，之后可能变化
 */
import { describe, expect, it } from 'vitest'

import { SuiClient } from '../src/index.js'
import { lpPositions, type SuiLpAmmPosition } from '../src/lp.js'
import { addLiquidity, buildAddLiquidity, buildCollectFees, buildRemoveLiquidity, removeLiquidity } from '../src/subpaths/liquidity.js'
import { batchCall } from '../src/subpaths/write.js'

const live = process.env.LIVE ? describe : describe.skip
const sui = new SuiClient(process.env.SUI_GRPC)
/** 持有 SUI、USDC 和 Wormhole USDC（添加用） */
const HOLDER = '0x9f63425709069336fec108bd4ba69a8f3d23e8ab237311f3ce58ae2bb0ed4d7f'
const watchOnly = (address: string) => ({ address, signTransaction: async (): Promise<string> => Promise.reject(new Error('watch-only')) })

interface Case {
  protocol: 'dipcoin' | 'flowx-v2' | 'kriya-amm'
  /** 持有 LP 的地址 */
  owner: string
  /** 添加用的池子（HOLDER 有这两种币） */
  pool: string
}

const CASES: Case[] = [
  // SUI / USDC
  { protocol: 'dipcoin', owner: '0x3283b58910842620120028e8f0300781dac502be1d5350f95b75c38c044472eb', pool: '0x7fbd7f609fcecd84329359cb6ea4eadbcd84d02a28fec9ce4652712d06474b3e' },
  // SUI / USDC（pairs 表里的字段对象）
  { protocol: 'flowx-v2', owner: '0x2568ff0ef7709f5a7ca5fea3ae5766cfe64e1fe94ca48552395744dba1c5e30a', pool: '0x8eba28d4fef9750f52baaaed896d096b0765973ca6c8f193870236b5451a413c' },
  // Wormhole USDC / SUI
  { protocol: 'kriya-amm', owner: '0x8eaa6a3d4fa4a5a41e6f78c1c4ce7e887ac3f980ca558a6df053bf1d78907783', pool: '0x5af4976b871fa1813362f352fa4cada3883a96191bb7212db1bd5d13685ae305' },
]

const ammOf = async (owner: string, protocol: Case['protocol']) =>
  (await lpPositions(sui, owner, { protocols: [protocol] })).filter((p): p is SuiLpAmmPosition => p.type === 'amm')

for (const c of CASES.filter((x) => !process.env.DEX || x.protocol === process.env.DEX)) {
  live(`${c.protocol}（主网）`, { timeout: 180_000 }, () => {
    it('LP：按份额算出数量（LP × 储备 / 总量）', async () => {
      const [p] = await ammOf(c.owner, c.protocol)
      expect(p).toMatchObject({ type: 'amm', protocol: c.protocol })
      expect(BigInt(p?.amount0 ?? 0)).toBe((BigInt(p?.balance ?? 0) * BigInt(p?.reserve0 ?? 0)) / BigInt(p?.totalSupply ?? 1))
      expect(p?.position === null).toBe(c.protocol !== 'kriya-amm')
    })

    it('移除一半 / 全部（模拟）；没有可领取的手续费', async () => {
      const [position] = await ammOf(c.owner, c.protocol)
      if (!position) throw new Error('no LP')
      const half = await buildRemoveLiquidity(sui, c.owner, { position, percent: 50 })
      expect(BigInt(half.liquidity)).toBe(BigInt(position.balance) / 2n)
      const all = await buildRemoveLiquidity(sui, c.owner, { position })
      expect(all.liquidity).toBe(position.balance)
      // LP 持有人不一定有 SUI 付 gas：由 HOLDER 赞助
      const results = await batchCall(sui, [half, all].map((p) => ({ from: watchOnly(c.owner), kind: p.kind, sponsor: watchOnly(HOLDER) })), { dryRun: true, continueOnError: true })
      expect(results.map((r) => [r.status, r.error])).toEqual([
        ['simulated', null],
        ['simulated', null],
      ])
      const r = await removeLiquidity(sui, watchOnly(c.owner), { position, percent: 10 }, { dryRun: true, sponsor: watchOnly(HOLDER) })
      expect([r.status, r.error]).toEqual(['simulated', null])
      await expect(buildCollectFees(sui, c.owner, { position })).rejects.toThrow(/part of the LP share/)
    })

    it('添加：给一边，另一边按储备比例（模拟）', async () => {
      const plan = await buildAddLiquidity(sui, HOLDER, { pool: c.pool, amount0Formatted: '1' })
      expect(plan).toMatchObject({ type: 'amm', action: 'add', fixed: null, tickLower: null })
      expect(BigInt(plan.liquidity)).toBeGreaterThan(0n)
      const other = await buildAddLiquidity(sui, HOLDER, { pool: c.pool, amount1: plan.amount1Max })
      const [r1, r2] = await batchCall(sui, [plan, other].map((p) => ({ from: watchOnly(HOLDER), kind: p.kind })), { dryRun: true, continueOnError: true })
      expect([r1?.status, r1?.error, r2?.status, r2?.error]).toEqual(['simulated', null, 'simulated', null])
      const r = await addLiquidity(sui, watchOnly(HOLDER), { pool: c.pool, amount0Formatted: '0.5' }, { dryRun: true })
      expect([r.status, r.error]).toEqual(['simulated', null])
      await expect(buildAddLiquidity(sui, HOLDER, { pool: c.pool, priceLower: 1, priceUpper: 2, amount0: 1n })).rejects.toThrow(/no price range/)
    })
  })
}
