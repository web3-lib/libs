/** 批量领取：奖励的结算公式、预览（手续费 + 奖励 + 美元价值）、构建 / 模拟 / 发送（模拟节点，不连网络） */
import { beforeEach, describe, expect, it } from 'vitest'

import { SolanaClient, TOKEN_PROGRAM_ID, decodeAddress, findProgramAddress, getAssociatedTokenAddress } from '../src/index.js'
import { ORCA_WHIRLPOOL_PROGRAM_ID, utf8 } from '../src/lp.js'
import { getRewardGrowthInside, rewardGrowthGlobal, type RewardEmission } from '../src/lpMath.js'
import { anchorIx } from '../src/liquidity/common.js'
import { resetNodeHealth } from '../src/rpc.js'
import { resetClientCache } from '../src/shortcuts.js'
import { buildClaimAll, claimAll, claimable, getClaimable, simulateClaim } from '../src/subpaths/claim.js'
import { createFakeSolana, keypair } from './fakeSolana.js'
import { createMockNode, mintData, tokenAccountData, type MockAccount } from './mock.js'

const Q64 = 1n << 64n
const wrap = (x: bigint) => ((x % (1n << 128n)) + (1n << 128n)) % (1n << 128n)

describe('挖矿奖励的结算（照搬程序）', () => {
  const emission = (o: Partial<RewardEmission> = {}): RewardEmission => ({ initialized: true, emissionsPerSecondX64: 10n * Q64, growthGlobalX64: 100n, lastUpdated: 1000n, openTime: 0n, endTime: (1n << 64n) - 1n, ...o })

  it('全局增长：Δt · 每秒排放 / 流动性；没有流动性 / 未开始 / 已结束 / 未初始化时不动或只到结束时间', () => {
    expect(rewardGrowthGlobal(1000n, emission(), 1005n)).toBe(100n + (5n * 10n * Q64) / 1000n)
    expect(rewardGrowthGlobal(0n, emission(), 1005n)).toBe(100n)
    expect(rewardGrowthGlobal(1000n, emission({ openTime: 2000n }), 1500n)).toBe(100n) // Raydium：还没到开始时间
    expect(rewardGrowthGlobal(1000n, emission({ endTime: 1002n }), 1500n)).toBe(100n + (2n * 10n * Q64) / 1000n) // 到结束时间为止
    expect(rewardGrowthGlobal(1000n, emission({ initialized: false }), 1005n)).toBe(100n)
    expect(rewardGrowthGlobal(1000n, emission(), 900n)).toBe(100n) // 时间倒退（时钟差）不扣
  })

  it('区间内增长：区间内 = 全局 − 下方 − 上方；价格在区间外时用全局减去外侧；tick 未初始化按程序的约定', () => {
    const tick = (out: bigint, initialized = true) => ({ initialized, feeGrowthOutside0: 0n, feeGrowthOutside1: 0n, rewardGrowthsOutside: [out, 0n, 0n] })
    expect(getRewardGrowthInside(0, -10, tick(30n), 10, tick(20n), 0, 100n)).toBe(50n)
    expect(getRewardGrowthInside(-20, -10, tick(30n), 10, tick(20n), 0, 100n)).toBe(wrap(100n - (100n - 30n) - 20n)) // 价格在下方
    expect(getRewardGrowthInside(20, -10, tick(30n), 10, tick(20n), 0, 100n)).toBe(wrap(100n - 30n - (100n - 20n))) // 价格在上方
    expect(getRewardGrowthInside(0, -10, tick(0n, false), 10, tick(0n, false), 0, 100n)).toBe(0n) // 下限未初始化：下方 = 全局，上限：上方 = 0
    expect(getRewardGrowthInside(0, -10, tick(150n), 10, tick(0n), 0, 100n)).toBe(wrap(100n - 150n)) // u128 回绕
  })
})

const OWNER = keypair(1)
const POOL = keypair(70).address
const [MINT0, MINT1, REWARD, NFT] = [71, 72, 73, 74].map((n) => keypair(n).address)
const VAULT = keypair(75).address
const ata = (mint: string) => getAssociatedTokenAddress(OWNER.address, mint, TOKEN_PROGRAM_ID)
const positionPda = findProgramAddress([utf8('position'), decodeAddress(NFT as string)], ORCA_WHIRLPOOL_PROGRAM_ID)

/** Whirlpool（653 字节）：tick_spacing 41、liquidity 49、sqrt_price 65、tick 81、mint_a 101、vault_a 133、mint_b 181、vault_b 213、奖励 269 起（mint +0、vault +32） */
function whirlpool(): Uint8Array {
  const out = new Uint8Array(653)
  const view = new DataView(out.buffer)
  view.setUint16(41, 64, true)
  view.setBigUint64(65, Q64, true) // sqrt_price = 1
  out.set(decodeAddress(MINT0 as string), 101)
  out.set(decodeAddress(keypair(76).address), 133)
  out.set(decodeAddress(MINT1 as string), 181)
  out.set(decodeAddress(keypair(77).address), 213)
  out.set(decodeAddress(REWARD as string), 269)
  out.set(decodeAddress(VAULT), 269 + 32)
  return out
}

/** 没有流动性、记账了 1.5 个 token0 的手续费和 42 个奖励的 Position（216 字节） */
function position(): Uint8Array {
  const out = new Uint8Array(216)
  const view = new DataView(out.buffer)
  out.set(decodeAddress(POOL), 8)
  out.set(decodeAddress(NFT as string), 40)
  view.setInt32(88, -64, true)
  view.setInt32(92, 64, true)
  view.setBigUint64(112, 1_500_000n, true) // fee_owed_a
  view.setBigUint64(144 + 16, 42n, true) // reward_infos[0].amount_owed
  return out
}

function accounts(): Record<string, MockAccount> {
  const mint = (decimals: number) => ({ owner: TOKEN_PROGRAM_ID, lamports: 1_461_600n, data: mintData({ decimals }) })
  return {
    [POOL]: { owner: ORCA_WHIRLPOOL_PROGRAM_ID, data: whirlpool() },
    [positionPda]: { owner: ORCA_WHIRLPOOL_PROGRAM_ID, data: position() },
    [MINT0 as string]: mint(6),
    [MINT1 as string]: mint(6),
    [REWARD as string]: mint(6),
    [NFT as string]: mint(0),
    [ata(NFT as string)]: { owner: TOKEN_PROGRAM_ID, lamports: 2_039_280n, data: tokenAccountData(NFT as string, OWNER.address, 1n) },
    [ata(MINT0 as string)]: { owner: TOKEN_PROGRAM_ID, lamports: 2_039_280n, data: tokenAccountData(MINT0 as string, OWNER.address, 0n) },
  }
}

const prices = { name: 'test', prices: async () => new Map([[MINT0 as string, 2], [REWARD as string, 10]]) }

beforeEach(() => {
  resetNodeHealth()
  resetClientCache()
})

describe('claimable / buildClaimAll', () => {
  it('预览：手续费、奖励、美元价值、按代币汇总；没有可领的仓位不列', async () => {
    const client = new SolanaClient(createMockNode({ accounts: accounts() }))
    const c = await claimable(client, OWNER.address, { mints: [NFT as string], prices })
    expect(c.positions).toHaveLength(1)
    const p = c.positions[0]!
    expect(p).toMatchObject({ protocol: 'orca-whirlpool', positionMint: NFT, pool: POOL, liquidity: '0' })
    expect(p.fees.map((f) => f.formatted)).toEqual(['1.5', '0'])
    expect(p.rewards).toMatchObject([{ index: 0, mint: REWARD, amount: '42', formatted: '0.000042' }])
    expect(p.rewards[0]?.usd).toBeCloseTo(0.00042, 10)
    // token1 没有价格但数量为 0：不影响合计
    expect(p.feesUsd).toBe(3)
    expect(c.totalUsd).toBeCloseTo(3.00042, 8)
    expect(c.tokens.map((t) => [t.mint, t.amount])).toEqual([[MINT0, '1500000'], [REWARD, '42']])

    // 价格关闭：usd 为 null，数量照常
    const off = await claimable(client, OWNER.address, { mints: [NFT as string], prices: false })
    expect(off.totalUsd).toBeNull()
    expect(off.positions[0]?.fees[0]?.formatted).toBe('1.5')

    // 领完（记账清零）后不再列出
    const empty = accounts()
    const cleared = position()
    cleared.fill(0, 112, 120) // fee_owed_a
    cleared.fill(0, 160, 168) // reward_infos[0].amount_owed
    empty[positionPda] = { owner: ORCA_WHIRLPOOL_PROGRAM_ID, data: cleared }
    expect((await claimable(new SolanaClient(createMockNode({ accounts: empty })), OWNER.address, { mints: [NFT as string], prices })).positions).toEqual([])
    await expect(claimable(client, 'bad')).rejects.toThrow(/Invalid owner/)
    expect((await getClaimable(OWNER.address, { provider: createMockNode({ accounts: accounts() }), mints: [NFT as string], prices })).positions).toHaveLength(1)
  })

  it('读不到 tick 数据的仓位：代币行保留并标记 incomplete，合计为 null', async () => {
    const acc = accounts()
    const live = position()
    new DataView(live.buffer).setBigUint64(72, 1_000n, true) // liquidity > 0，但没有 tick 数组账户
    acc[positionPda] = { owner: ORCA_WHIRLPOOL_PROGRAM_ID, data: live }
    const c = await claimable(new SolanaClient(createMockNode({ accounts: acc })), OWNER.address, { mints: [NFT as string], prices })
    expect(c.positions[0]?.fees[0]?.amount).toBeNull()
    expect(c.incomplete).toBe(true)
    expect(c.totalUsd).toBeNull()
    const t0 = c.tokens.find((t) => t.mint === MINT0)
    expect(t0).toMatchObject({ incomplete: true, usd: null })
    expect(c.warnings.some((w) => /tick arrays/.test(w))).toBe(true)
    // 数量都读得到时 incomplete 为 false
    const ok = await claimable(new SolanaClient(createMockNode({ accounts: accounts() })), OWNER.address, { mints: [NFT as string], prices })
    expect(ok.incomplete).toBe(false)
  })

  it('构建：每个仓位一个调用（创建缺少的代币账户 + collect_fees_v2 + collect_reward_v2）；失败的仓位不影响其他的', async () => {
    const client = new SolanaClient(createMockNode({ accounts: accounts() }))
    const c = await claimable(client, OWNER.address, { mints: [NFT as string], prices: false })
    const plan = await buildClaimAll(client, OWNER.address, c.positions)
    expect(plan.failed).toEqual([])
    expect(plan.calls).toHaveLength(1)
    const data = plan.calls[0]!.instructions.map((i) => [...i.data.slice(0, 8)].join())
    expect(data).toContain([...anchorIx('collect_fees_v2')].join())
    expect(data).toContain([...anchorIx('collect_reward_v2')].join())
    expect(plan.calls[0]!.plan.rewardMints).toEqual([REWARD])
    // 不在 owner 名下的仓位：构建失败、列在 failed
    const other = await buildClaimAll(client, keypair(2).address, [...c.positions, { protocol: 'orca-whirlpool', positionMint: NFT as string }])
    expect(other.calls).toEqual([])
    expect(other.failed).toHaveLength(1)
    expect(other.failed[0]?.error).toMatch(/does not hold/)
  })
})

describe('claimAll（假链）', () => {
  it('dryRun 只模拟；模拟失败的仓位不发送（假链没有 Whirlpool 程序：全部失败，状态 failed）', { timeout: 30_000 }, async () => {
    const chain = createFakeSolana()
    Object.assign(chain.accounts, accounts())
    chain.setSol(OWNER.address, 1_000_000_000n)
    const client = new SolanaClient(chain.transport)
    const result = await claimAll(client, OWNER.secretKey, undefined, { dryRun: true, pollInterval: 1, timeout: 5_000, priorityFee: 0 })
    expect(result.plan.calls).toHaveLength(1)
    expect(result.results.map((r) => [r.status, r.positionMint])).toEqual([['failed', NFT]])
    expect(result.results[0]?.error).toMatch(/unsupported by the fake|failed/)
    expect(chain.sent).toHaveLength(0)
    const sim = await simulateClaim(client, result.plan)
    expect(sim.success).toBe(false)
    expect(sim.failed.map((f) => f.index)).toEqual([0])
  })

  it('模拟和发送用同样的打包参数（batchSize / mode）', async () => {
    const chain = createFakeSolana()
    Object.assign(chain.accounts, accounts())
    const client = new SolanaClient(chain.transport)
    const plan = await buildClaimAll(client, OWNER.address, [{ protocol: 'orca-whirlpool', positionMint: NFT as string }, { protocol: 'orca-whirlpool', positionMint: NFT as string, pool: POOL }])
    const call = plan.calls[0]!
    const two = { ...plan, calls: [call, { ...call, positionMint: 'x' }] }
    expect((await simulateClaim(client, two, { batchSize: 1 })).transactions).toHaveLength(2)
    expect((await simulateClaim(client, two)).transactions).toHaveLength(1)
  })
})
