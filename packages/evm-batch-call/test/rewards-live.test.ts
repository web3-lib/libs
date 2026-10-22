/**
 * 领取手续费（Tron SunSwap V3）：连主网读真实用户的仓位，默认跳过。
 *
 * ```sh
 * LIVE=1 npx vitest run test/rewards-live.test.ts
 * ```
 *
 * 从仓位合约最近的几个 NFT 里找持有者，读他们未领取的手续费，再以他们的身份用 triggerconstantcontract 预执行构建出的领取交易（不上链）
 */
import { Interface, getAddress } from 'ethers'
import { describe, expect, it } from 'vitest'

import { Provider, TRON_CHAIN_ID, TronProvider } from '../src/index.js'
import { buildClaimAll, claimable } from '../src/subpaths/rewards.js'

const live = process.env.LIVE ? describe : describe.skip
const V3_NPM = 'TLSWrv7eC1AZCXkRjpqMZUmvgd99cj7pPF'

const tron = new TronProvider({ apiKey: process.env.TRON_API_KEY, minInterval: process.env.TRON_API_KEY ? 0 : 300 })
const multi = new Provider(TRON_CHAIN_ID.mainnet, tron)
const npm = new Interface([
  'function totalSupply() view returns (uint256)',
  'function tokenByIndex(uint256 index) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
])

live('领取手续费（Tron SunSwap V3，主网）', { timeout: 300_000 }, () => {
  it('读到真实用户的手续费，构建的领取交易预执行成功', async () => {
    const c = multi.contract(V3_NPM, npm)
    const supply = Number(await multi.call<bigint>(c.totalSupply()))
    const owners = new Set<string>()
    for (let i = 0; i < 40 && owners.size < 12; i++) {
      const id = await multi.call<bigint>(c.tokenByIndex(supply - 1 - i * 3))
      owners.add(await multi.call<string>(c.ownerOf(id)))
    }
    let checked = 0
    for (const owner of owners) {
      const found = await claimable(multi, owner, { protocols: ['sunswap-v3'] })
      if (!found.items.length) continue
      expect(found.errors).toEqual([])
      expect(found.items.every((i) => i.kind === 'fees' && i.version === 'v3' && !i.staked)).toBe(true)
      const plan = await buildClaimAll(multi, owner, { items: found.items })
      expect(plan.skipped).toEqual([])
      expect(plan.transactions.length).toBe(1)
      expect(plan.transactions[0]?.to).toBe(V3_NPM)
      expect(plan.transactions[0]?.simulation?.success).toBe(true)
      checked++
      if (checked >= 2) break
    }
    expect(checked).toBeGreaterThan(0)
  })
})

/** 2026-10 在 Aerodrome Slipstream gauge 里质押了仓位的真实地址 */
const AERO_STAKER = '0xa1f2b434ae23314d0586f835e908729d6b041e8c'

live('Aerodrome gauge（Base 主网）', { timeout: 300_000 }, () => {
  it('经 Voter 枚举全部池子的 gauge（缓存后不再枚举），读到质押的仓位和 AERO 奖励（带美元价值）', async () => {
    const base = new Provider(8453, 'https://base-rpc.publicnode.com')
    const c = await claimable(base, AERO_STAKER, { protocols: ['aerodrome-slipstream'], prices: true })
    expect(c.errors).toEqual([])
    expect(c.items.length).toBeGreaterThan(0)
    for (const i of c.items) {
      expect(i).toMatchObject({ kind: 'gauge', staked: true })
      expect(i.amounts[0]?.token.symbol).toBe('AERO')
      expect(BigInt(i.amounts[0]?.amount ?? 0)).toBeGreaterThan(0n)
      expect(i.usd).toBeGreaterThan(0)
    }
    // 第二次：gauge 列表来自缓存，只读质押的仓位
    const again = await claimable(base, AERO_STAKER, { protocols: ['aerodrome-slipstream'] })
    expect(again.items.map((i) => i.id).sort()).toEqual(c.items.map((i) => i.id).sort())
    const plan = await buildClaimAll(base, AERO_STAKER, { items: c.items })
    expect(plan.skipped).toEqual([])
    expect(plan.transactions).toHaveLength(c.items.length)
    expect(plan.transactions.every((t) => t.simulation?.success)).toBe(true)
    expect(plan.transactions.map((t) => getAddress(t.to)).sort()).toEqual(c.items.map((i) => getAddress(i.target)).sort())
  })
})
