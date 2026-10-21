/**
 * 授权管理连主网（只模拟，不发送），默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/approvals-live.test.ts`
 * - SOLANA_RPC：自己的节点（要支持 getTokenAccountsByOwner）；默认官方节点（关闭批量合并）
 * 账户是 2026-10 从主网区块里找到的：Star Atlas 游戏代币的授权（游戏程序作为 delegate）、清空了的 USDC / Wrapped SOL / Token-2022 账户（含有暂存转账手续费的）。
 * 状态会变：只检查现在仍然符合条件的账户，并要求至少各有一个
 */
import { describe, expect, it } from 'vitest'

import { HttpRpc, SolanaClient } from '../src/index.js'
import { approvals, closeTokenAccounts, revokeApprovals, type TokenAccountApproval } from '../src/subpaths/approvals.js'

const live = process.env.LIVE ? describe : describe.skip
const client = new SolanaClient(new HttpRpc(process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com', { batch: false, timeout: 30_000 }), { cluster: 'mainnet' })

/** 模拟用的签名器：dryRun 不会签名 */
const watchOnly = (address: string) => ({
  address,
  sign: async (): Promise<Uint8Array> => {
    throw new Error('dry run only')
  },
})
// 手续费支付者：余额很多的普通钱包（这些 owner 有的是程序账户，不能付手续费）
const FEE_PAYER = watchOnly('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9')
const dryRun = { dryRun: true, feePayer: FEE_PAYER }

const SPL = {
  AMMO: 'ammoK8AkX2wnebQb35cDAZtTkvsXQbi82cGeTnUvvfK',
  FOOD: 'foodQJAztMzX1DKpLaiounNe2BDMds5RNuPC6jsNrDG',
  FUEL: 'fueL3hBZjLLLJHiFH9cqZoozTG3XQZ53diwFPwbzNim',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  WSOL: 'So11111111111111111111111111111111111111112',
  SPYX: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', // Token-2022，带 PermanentDelegate
}
const DELEGATED = [
  { owner: '2Z6VWiY19a5aUnC4eWLZHgmvLDtgYtPHq4s36QgzSiJ3', mints: [SPL.AMMO, SPL.FOOD] },
  { owner: 'BxiJJY1dZ657VFYmUfvymfiYxabjs8oR2e96nj9GBQ3k', mints: [SPL.FUEL] },
  { owner: '6f47EKpVndioCYcdxAqG8Ha27dpHLJPN8azyoj1nxDia', mints: [SPL.AMMO, SPL.FOOD] },
]
const EMPTY = [
  { owner: '8pt1HxbMrPdPfYXi6AfstJkJ2TMoPB6QJRbUiwcBfJCu', mints: [SPL.USDC] },
  { owner: 'HrTBFGGaV1Z6wWhK4kmNNWmuKdUptcL2iRma6rH59H3D', mints: [SPL.WSOL] },
  { owner: 'En3NPq8o9Cynf1Q3eP69AqZmPKmBaDugYnE832o2YuzP', mints: [SPL.SPYX] },
]

// 清空了、但还有暂存转账手续费的 Token-2022 账户（2026-10 从主网区块里找到）
const WITHHELD = [
  { owner: '27SiSfJFV2YmEWQdjRSfotoU1HZ95P4ujJdS67UUPET2', mint: 'Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw' },
  { owner: 'AHT9cXtaJXvGk9PboxH1ie9d1269sB4NsubsMKLdLJar', mint: 'Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd' },
]

live('授权管理（Solana 主网，只模拟）', { timeout: 120_000 }, () => {
  it('有授权的账户：Revoke 模拟通过，同一个 owner 的打包进一笔', async () => {
    let checked = 0
    for (const c of DELEGATED) {
      const list = (await approvals(client, c.owner, { mints: c.mints })).filter((a) => a.revocable)
      if (!list.length) continue
      const results = await revokeApprovals(client, watchOnly(c.owner), list, dryRun)
      expect(results.map((r) => [r.account, r.status, r.error])).toEqual(list.map((a) => [a.account, 'simulated', null]))
      checked += list.length
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('空账户：CloseAccount 模拟通过（SPL Token、Wrapped SOL、Token-2022）；有余额的账户链上拒绝关闭', async () => {
    const closable: TokenAccountApproval[] = []
    for (const c of EMPTY) {
      const list = (await approvals(client, c.owner, { mints: c.mints })).filter((a) => a.closable && a.amount === '0')
      if (!list.length) continue
      const results = await closeTokenAccounts(client, watchOnly(c.owner), list, dryRun)
      expect(results.map((r) => [r.status, r.error])).toEqual(list.map(() => ['simulated', null]))
      closable.push(...list)
    }
    expect(closable.length).toBeGreaterThan(0)
    const spyx = closable.find((a) => a.mint === SPL.SPYX)
    if (spyx) expect(spyx.permanentDelegate).not.toBe(null)

    // 有余额的账户：库判断为不能关闭；强行关闭时链上报错
    for (const c of DELEGATED) {
      const [held] = (await approvals(client, c.owner, { mints: c.mints, all: true })).filter((a) => BigInt(a.amount) > 0n)
      if (!held) continue
      expect([held.closable, held.closeBlocker]).toEqual([false, 'balance'])
      const [forced] = await closeTokenAccounts(client, watchOnly(c.owner), [{ ...held, closable: true, closeBlocker: null }], dryRun)
      expect(forced?.status).toBe('failed')
      expect(forced?.error).toMatch(/balance is zero/)
      return
    }
  })

  it('Token-2022 空账户里有暂存的转账手续费：先 Harvest 再关闭能模拟通过；不 Harvest 时链上拒绝', async () => {
    let checked = 0
    for (const c of WITHHELD) {
      const list = (await approvals(client, c.owner, { mints: [c.mint] })).filter((a) => a.amount === '0' && BigInt(a.withheldAmount) > 0n)
      if (!list.length) continue
      const [ok] = await closeTokenAccounts(client, watchOnly(c.owner), list, dryRun)
      expect([ok?.status, ok?.error]).toEqual(['simulated', null])
      const [bad] = await closeTokenAccounts(client, watchOnly(c.owner), list.map((a) => ({ ...a, withheldAmount: '0' })), dryRun)
      expect(bad?.error).toMatch(/withheld fee balance is zero/)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('列出全部代币账户（getTokenAccountsByOwner）和按 ATA 读的结果一致', async () => {
    const { owner, mints } = EMPTY[0] as (typeof EMPTY)[number]
    const all = await approvals(client, owner, { all: true })
    const byAta = await approvals(client, owner, { mints, all: true })
    for (const a of byAta) expect(all.find((x) => x.account === a.account)).toEqual(a)
  })
})
