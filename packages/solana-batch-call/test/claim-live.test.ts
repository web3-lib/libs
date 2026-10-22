/**
 * 批量领取连主网（只模拟，不发送、不需要私钥），默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/claim-live.test.ts`
 * - SOLANA_RPC：自己的节点（要支持 getTokenAccountsByOwner）；默认官方节点（关闭批量合并）
 * 钱包是 2026-10 从主网上找到的：Raydium CLMM SOL-USDC 池（奖励 RAY）里有手续费和奖励的仓位。
 * 状态会变：要求至少有一个仓位；预览里的数量（按程序公式算的）与模拟时程序真实转出的数量对比，允许几秒的累积误差
 */
import { describe, expect, it } from 'vitest'

import { HttpRpc, SolanaClient } from '../src/index.js'
import { buildClaimAll, claimable, simulateClaim } from '../src/subpaths/claim.js'

const live = process.env.LIVE ? describe : describe.skip
const client = new SolanaClient(new HttpRpc(process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com', { batch: false, timeout: 60_000 }), { cluster: 'mainnet' })

const OWNERS = ['DXNUd5Dh5M1sTcduuaRKmgEG4u4TcerdZGfnwpxZUTgW', '7MNmCGMgdSzMzwNhQKCAs82pd5odi4xjg4VtUU7WiCNk']

live('主网：预览、构建、模拟', () => {
  for (const owner of OWNERS) {
    it(`${owner.slice(0, 6)}…：模拟收到的手续费和奖励与预览一致`, async () => {
      const c = await claimable(client, owner)
      expect(c.positions.length).toBeGreaterThan(0)
      const plan = await buildClaimAll(client, owner, c.positions)
      expect(plan.failed).toEqual([])
      const sim = await simulateClaim(client, plan)
      expect(sim.failed).toEqual([])
      expect(sim.success).toBe(true)
      for (const t of c.tokens) {
        if (t.mint === 'So11111111111111111111111111111111111111112') continue // SOL 要扣新建代币账户的租金，不对比
        const got = BigInt(sim.received.find((x) => x.asset === t.mint)?.delta ?? 0)
        const want = BigInt(t.amount ?? 0)
        // 预览是几秒前算的：手续费 / 奖励随交易和时间继续累积，模拟的只会略多
        expect(got).toBeGreaterThanOrEqual(want)
        expect(Number(got - want)).toBeLessThanOrEqual(Number(want) * 0.01 + 5)
      }
    }, 300_000)
  }
})
