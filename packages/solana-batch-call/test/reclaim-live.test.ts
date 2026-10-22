/**
 * 账户回收连主网（只模拟，不发送、不需要私钥），默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/reclaim-live.test.ts`
 * - SOLANA_RPC：自己的节点（要支持 getTokenAccountsByOwner）；默认官方节点（关闭批量合并）
 * 钱包是 2026-10 从主网上找到的：有大量空仓位（Orca SPL NFT、Raydium SPL NFT / Token-2022 NFT）、空代币账户和垃圾币的地址。
 * 状态会变：只检查现在仍然存在的项；模拟的 SOL 变化必须和预计退回的一致（预计值是读账户余额算的，模拟是主网程序真实执行的结果）
 */
import { describe, expect, it } from 'vitest'

import { HttpRpc, SolanaClient } from '../src/index.js'
import { buildReclaim, reclaimable, simulateReclaim } from '../src/subpaths/reclaim.js'

const live = process.env.LIVE ? describe : describe.skip
const client = new SolanaClient(new HttpRpc(process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com', { batch: false, timeout: 60_000 }), { cluster: 'mainnet' })

const WALLETS = [
  '93dfUDxGc3G19BsuHUr9VnAH2N1Hg1BLMCDN4rtqY2y4', // Orca / Raydium（SPL NFT）空仓位、空代币账户、尘埃币
  '9TYKEE6cUCY2zMe9mvLUmoSFhDv7fpiGsDKXsJTRvNnf', // Raydium Token-2022 NFT 空仓位（mint 一起关闭）
]

live('主网：扫描、构建、模拟', () => {
  for (const owner of WALLETS) {
    it(`${owner.slice(0, 6)}…：模拟通过，退回的 SOL 与预计一致`, async () => {
      const r = await reclaimable(client, owner)
      const picked = r.items.filter((i) => i.selected)
      expect(picked.length).toBeGreaterThan(0)
      const plan = await buildReclaim(client, owner, picked)
      const sim = await simulateReclaim(client, plan)
      expect(sim.failed).toEqual([])
      expect(sim.success).toBe(true)
      expect(sim.lamportsSource).toBe('simulation')
      expect(sim.lamports).toBe(plan.lamports)
    }, 300_000)
  }
})
