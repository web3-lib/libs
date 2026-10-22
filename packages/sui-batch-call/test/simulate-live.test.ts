/**
 * 模拟 + 历史连主网（不发送），默认跳过：
 * `LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/simulate-live.test.ts`
 * 地址是 2026-10 时持币的真实地址，之后可能变化
 */
import { describe, expect, it } from 'vitest'

import { SUI_COIN_TYPE, SuiClient } from '../src/index.js'
import { buildSwap } from '../src/subpaths/swap.js'
import { getHistory, grpcHistory } from '../src/subpaths/history.js'
import { simulateTx } from '../src/subpaths/simulate.js'
import { pure } from '../src/write/bcs.js'
import { PtbBuilder } from '../src/write/ptb.js'

const live = process.env.LIVE ? describe : describe.skip
const retryFetch: typeof fetch = async (input, init) => {
  for (let i = 0; ; i++) {
    try {
      return await fetch(input, init)
    } catch (err) {
      if (i >= 4 || init?.signal?.aborted) throw err
      await new Promise((r) => setTimeout(r, 300 * (i + 1)))
    }
  }
}
const sui = new SuiClient(process.env.SUI_GRPC, { fetch: retryFetch })
/** 持有 SUI、USDC 等 */
const HOLDER = '0x9f63425709069336fec108bd4ba69a8f3d23e8ab237311f3ce58ae2bb0ed4d7f'
const OTHER = '0x0000000000000000000000000000000000000000000000000000000000000abc'
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'

live('simulate (mainnet)', () => {
  it('transfer: balance changes without gas, recipient, fee', async () => {
    const ptb = new PtbBuilder()
    const coin = ptb.command({ kind: 'splitCoins', coin: { kind: 'gas' }, amounts: [ptb.pure(pure.u64(1_000_000n))] })
    ptb.command({ kind: 'transferObjects', objects: [ptb.nested(coin, 0)], address: ptb.pure(pure.address(OTHER)) })
    const sim = await simulateTx(sui, { kind: ptb.build() }, { sender: HOLDER, prices: false })
    expect(sim.error).toBeUndefined()
    expect(sim.success).toBe(true)
    expect(sim.decoded.type).toBe('transfer')
    expect(sim.balanceChanges.find((c) => c.address === HOLDER)?.delta).toBe('-1000000')
    expect(sim.balanceChanges.find((c) => c.address === OTHER)?.formatted).toBe('0.001')
    expect(BigInt(sim.gasUsed)).toBeGreaterThan(0n)
    expect(sim.objectChanges.some((o) => o.kind === 'created' && o.coin && o.to === OTHER)).toBe(true)
    expect(sim.decoded.summary).toMatch(/^Send 0\.001 SUI to /)
    console.log(sim.decoded.summary, sim.fee)
  })

  it('failed: balance split below the holder balance aborts', async () => {
    const ptb = new PtbBuilder()
    const coin = ptb.command({ kind: 'splitCoins', coin: { kind: 'gas' }, amounts: [ptb.pure(pure.u64(10n ** 18n))] })
    ptb.command({ kind: 'transferObjects', objects: [ptb.nested(coin, 0)], address: ptb.pure(pure.address(OTHER)) })
    const sim = await simulateTx(sui, ptb.build(), { sender: HOLDER, prices: false })
    expect(sim.success).toBe(false)
    expect(sim.error).toBeTruthy()
    expect(sim.warnings.some((w) => w.code === 'failed')).toBe(true)
    console.log(sim.error)
  })

  it('failed: Move abort is decoded (0x2::pay::split, balance ENotEnough)', async () => {
    const ptb = new PtbBuilder()
    ptb.moveCall(`${'0x2'}::pay::split`, [SUI_COIN_TYPE], [{ kind: 'gas' }, ptb.pure(pure.u64(10n ** 18n))])
    const sim = await simulateTx(sui, ptb.build(), { sender: HOLDER, prices: false })
    expect(sim.success).toBe(false)
    expect(sim.errorInfo?.abort).toMatchObject({ code: '2', name: 'ENotEnough (not enough balance)' })
    console.log(sim.error)
  })

  it('swap plan from buildSwap: protocol decoded, in/out balance changes, usd', async () => {
    const plan = await buildSwap(sui, HOLDER, { tokenIn: SUI_COIN_TYPE, tokenOut: USDC, amountInFormatted: '0.5' }, {})
    const sim = await simulateTx(sui, plan, { sender: HOLDER })
    expect(sim.error).toBeUndefined()
    expect(sim.success).toBe(true)
    expect(sim.decoded.type).toBe('swap')
    expect(sim.decoded.protocol).toBeTruthy()
    const mine = sim.balanceChanges.filter((c) => c.address === HOLDER)
    expect(mine.find((c) => c.asset === USDC)?.delta).toBeDefined()
    expect(BigInt(mine.find((c) => c.asset === USDC)?.delta ?? '0')).toBeGreaterThanOrEqual(BigInt(plan.amountOutMin))
    console.log(sim.decoded.summary, JSON.stringify(mine))
  }, 60_000)
})

live('history (mainnet)', () => {
  /** 2026-10 时有转账、兑换的真实地址 */
  const WALLET = '0x692cc49cde1d2b37c5005603285fa06920e7fe025ce88005cfc692cec3ce4269'

  it('GraphQL pages back in time with cursors, newest first', async () => {
    const first = await getHistory(WALLET, { limit: 5, fetch: retryFetch })
    expect(first.items.length).toBeGreaterThan(0)
    for (const a of first.items) expect(a.hash).toBeTruthy()
    expect(first.items.map((a) => a.time)).toEqual([...first.items.map((a) => a.time)].sort((a, b) => b - a))
    expect(first.nextCursor).toMatch(/^graphql:/)
    const second = await getHistory(WALLET, { limit: 5, cursor: first.nextCursor })
    expect(second.items[0]?.time).toBeLessThanOrEqual(first.items.at(-1)?.time ?? 0)
    expect(second.items.some((a) => first.items.some((b) => b.hash === a.hash))).toBe(false)
    console.log(first.items.map((a) => `${a.type} ${a.status} ${a.label}`))
  }, 60_000)

  it('gRPC adapter returns the same newest transactions (recent history only)', async () => {
    const g = await getHistory(WALLET, { limit: 5, adapters: [grpcHistory(sui.transport)] })
    const q = await getHistory(WALLET, { limit: 5 })
    // 两个数据源整理出的 Activity 逐项一致
    expect(g.items).toEqual(q.items)
    if (g.nextCursor) expect((await getHistory(WALLET, { limit: 5, cursor: g.nextCursor, adapters: [grpcHistory(sui.transport)] })).items.length).toBeGreaterThan(0)
  }, 60_000)

  it('fails over to gRPC when GraphQL is down; type filter', async () => {
    const down = { name: 'graphql', list: async () => Promise.reject(new Error('down')) }
    const r = await getHistory(WALLET, { limit: 5, adapters: [down, grpcHistory(sui.transport)] })
    expect(r.items.length).toBeGreaterThan(0)
    const swaps = await getHistory(WALLET, { limit: 3, types: ['swap', 'transfer'] })
    expect(swaps.items.every((a) => a.type === 'swap' || a.type === 'transfer')).toBe(true)
  }, 60_000)
})
