/**
 * Aftermath（多币池）的 LP 和加减流动性连主网（只读、模拟，不发送），默认跳过：
 * `LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/aftermath-live.test.ts`
 * 地址是 2026-10 时持有 LP / 持币的真实地址，之后可能变化
 */
import { describe, expect, it } from 'vitest'

import { SUI_COIN_TYPE, SuiClient } from '../src/index.js'
import { lpPositions, type SuiLpMultiPosition } from '../src/lp.js'
import { addLiquidity, buildAddLiquidity, buildCollectFees, buildRemoveLiquidity, removeLiquidity } from '../src/subpaths/liquidity.js'
import { batchCall } from '../src/subpaths/write.js'

const live = process.env.LIVE ? describe : describe.skip
const sui = new SuiClient(process.env.SUI_GRPC)
/** 持有 SUI 和 USDC（添加用，也给别人赞助 gas） */
const HOLDER = '0x9f63425709069336fec108bd4ba69a8f3d23e8ab237311f3ce58ae2bb0ed4d7f'
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
/** SUI / USDC（20 / 80 的加权池） */
const SUI_USDC = '0xb0cc4ce941a6c6ac0ca6d8e6875ae5d86edbec392c3333d008ca88f377e5e181'

const watchOnly = (address: string) => ({ address, signTransaction: async (): Promise<string> => Promise.reject(new Error('watch-only')) })

interface Case {
  name: string
  owner: string
  /** 池子（Pool 的 ID） */
  pool: string
  coins: number
  dao: boolean
}

const CASES: Case[] = [
  { name: 'SUI / USDC', owner: '0x3c8bc43457d8cebfbe739a9bd682ff3a4764172cc1c7b38d9d2110468696fdaa', pool: SUI_USDC, coins: 2, dao: false },
  { name: '5 种稳定币（stable）', owner: '0x8c90d1c14730cc251d15e7d228bf2f34266cbbc2ee4b1518fd34b1cd96acb238', pool: '0x41ef59cccc07e3422238cbd904de574610354e49e2e0b2193b461c6c25d50b35', coins: 5, dao: false },
  { name: 'DAO 费池子（Arbitrage Turdle）', owner: '0x19da5781026aeb4e04d804a05182cf9985d5a01dde2f6ae6b87f49a06994e0be', pool: '0x92939455e5112ad8f438035285a8dc52d632a031d79bad03f56cf1ff094b3f10', coins: 2, dao: true },
]

const positionOf = async (c: Case) => {
  const list = (await lpPositions(sui, c.owner, { protocols: ['aftermath'] })).filter((p): p is SuiLpMultiPosition => p.type === 'multi')
  const p = list.find((x) => x.pool === c.pool)
  if (!p) throw new Error(`no LP in ${c.pool}`)
  return p
}

for (const c of CASES) {
  live(`Aftermath ${c.name}（主网）`, { timeout: 180_000 }, () => {
    it('LP：每种币按比例取回的数量（扣协议手续费和 DAO 费）', async () => {
      const p = await positionOf(c)
      expect(p).toMatchObject({ type: 'multi', protocol: 'aftermath', position: null, protocolFee: 500 })
      expect(p.coins).toHaveLength(c.coins)
      expect(p.daoFee !== null).toBe(c.dao)
      expect(p.coins.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1, 9)
    })

    it('按比例移除一半 / 全部、只取一种币（模拟）；没有可领取的手续费', async () => {
      const p = await positionOf(c)
      const half = await buildRemoveLiquidity(sui, c.owner, { position: p, percent: 50 })
      expect(half).toMatchObject({ type: 'multi', liquidity: (BigInt(p.balance) / 2n).toString() })
      expect(half.coins).toHaveLength(c.coins)
      const all = await buildRemoveLiquidity(sui, c.owner, { position: p })
      // 全部取回的数量就是仓位里算的
      expect(all.coins?.map((x) => x.amount)).toEqual(p.coins.map((x) => x.amount))
      const one = await buildRemoveLiquidity(sui, c.owner, { position: p, percent: 10, outCoin: p.coins[0]?.coinType as string })
      expect(BigInt(one.coins?.[0]?.amountMin ?? 0)).toBeGreaterThan(0n)
      expect(one.coins?.slice(1).every((x) => x.amount === '0')).toBe(true)
      // LP 持有人不一定有 SUI 付 gas：由 HOLDER 赞助
      const results = await batchCall(sui, [half, all, one].map((x) => ({ from: watchOnly(c.owner), kind: x.kind, sponsor: watchOnly(HOLDER) })), { dryRun: true, continueOnError: true })
      expect(results.map((r) => [r.status, r.error])).toEqual([
        ['simulated', null],
        ['simulated', null],
        ['simulated', null],
      ])
      const r = await removeLiquidity(sui, watchOnly(c.owner), { pool: c.pool, protocol: 'aftermath', percent: 5 }, { dryRun: true, sponsor: watchOnly(HOLDER) })
      expect([r.status, r.error]).toEqual(['simulated', null])
      await expect(buildCollectFees(sui, c.owner, { position: p })).rejects.toThrow(/part of the LP share/)
    })
  })
}

live('Aftermath 添加（主网模拟）', { timeout: 180_000 }, () => {
  it('按比例：给一种币，其余按储备比例；只存一种币：按模拟报价、LP 下限按滑点', async () => {
    const proportional = await buildAddLiquidity(sui, HOLDER, { pool: SUI_USDC, coin: USDC, amountFormatted: '10' })
    expect(proportional).toMatchObject({ type: 'multi', action: 'add', tickLower: null })
    expect(proportional.coins?.map((x) => BigInt(x.amount) > 0n)).toEqual([true, true])
    expect(BigInt(proportional.liquidity)).toBeGreaterThan(0n)
    const single = await buildAddLiquidity(sui, HOLDER, { pool: SUI_USDC, coin: SUI_COIN_TYPE, amountFormatted: '1', single: true })
    expect(single.coins?.[1]?.amount).toBe('0')
    const results = await batchCall(sui, [proportional, single].map((x) => ({ from: watchOnly(HOLDER), kind: x.kind })), { dryRun: true, continueOnError: true })
    expect(results.map((r) => [r.status, r.error])).toEqual([
      ['simulated', null],
      ['simulated', null],
    ])
    const r = await addLiquidity(sui, watchOnly(HOLDER), { pool: SUI_USDC, amount1Formatted: '5' }, { dryRun: true })
    expect([r.status, r.error]).toEqual(['simulated', null])
    await expect(buildAddLiquidity(sui, HOLDER, { pool: SUI_USDC, coin: '0x2::coin::COIN', amount: 1n })).rejects.toThrow(/not in the pool/)
  })

  it('DAO 费池子：按比例、只存一种币（调用外壳包的函数）', async () => {
    const c = CASES[2] as Case
    // 2026-10 时这个地址有少量 TURD 和 ARBTKN（池子的两种币）
    const TURD = '0x10ef03277df19661589c48452632fe858cd7098a42bd2a878a3e76804436db76::turd::TURD'
    const ARBTKN = '0xf4e17e530f036d0316df3599576c3b9d743a6d6e681a926fb29b87b044e10613::arbtkn::ARBTKN'
    const proportional = await buildAddLiquidity(sui, c.owner, { pool: c.pool, coin: TURD, amountFormatted: '0.1' })
    const single = await buildAddLiquidity(sui, c.owner, { pool: c.pool, coin: ARBTKN, amountFormatted: '0.05', single: true })
    expect([proportional.type, single.type]).toEqual(['multi', 'multi'])
    const results = await batchCall(sui, [proportional, single].map((x) => ({ from: watchOnly(c.owner), kind: x.kind, sponsor: watchOnly(HOLDER) })), { dryRun: true, continueOnError: true })
    expect(results.map((r) => [r.status, r.error])).toEqual([
      ['simulated', null],
      ['simulated', null],
    ])
  })
})
