// 第二阶段：PDA 缓存（LRU；推导结果不变由 lp / client 测试里的主网地址覆盖）、InvalidAddressError、balances(owner, { mints }) 新写法、options 命名别名
import { describe, expect, expectTypeOf, it } from 'vitest'

import { InvalidAddressError, SolanaClient, TOKEN_PROGRAM_ID, findProgramAddress, getAssociatedTokenAddress, type BalancesQueryOptions } from '../src/index.js'
import { isPdaCached } from '../src/address.js'
import type { ApprovalsOptions, ApprovalsQuery } from '../src/subpaths/approvals.js'
import type { ClaimableOptions, ClaimQuery } from '../src/subpaths/claim.js'
import type { ReclaimableOptions, ReclaimQuery } from '../src/subpaths/reclaim.js'
import { createMockNode, mintData, tokenAccountData } from './mock.js'

const OWNER = 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'

describe('PDA 缓存', () => {
  it('满了按 LRU 淘汰：最近用过的保留（之前满了整表清空）', () => {
    const seed = (i: number) => [new TextEncoder().encode(`lru-${i}`)]
    const hot = seed(-1)
    findProgramAddress(hot, PROGRAM)
    for (let i = 0; i < 10_000; i++) {
      findProgramAddress(seed(i), PROGRAM)
      if (i % 1000 === 0) findProgramAddress(hot, PROGRAM) // 经常用到
    }
    expect(isPdaCached(hot, PROGRAM)).toBe(true)
    expect(isPdaCached(seed(9_999), PROGRAM)).toBe(true)
    expect(isPdaCached(seed(0), PROGRAM)).toBe(false) // 最久没用的被淘汰
  }, 30_000) // 1 万次 PDA 推导（每次多轮 sha256 + 曲线判断），CI 上和其他包并行跑时超过默认的 5 秒
})

describe('InvalidAddressError', () => {
  it('owner 非法时抛 InvalidAddressError：继承 Error、message 不变、带 code 和 address', async () => {
    const sol = new SolanaClient(createMockNode())
    const err = await sol.balances('not-an-address', [USDC]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InvalidAddressError)
    expect(err).toBeInstanceOf(Error)
    expect((err as InvalidAddressError).message).toBe('Invalid owner address: not-an-address')
    expect((err as InvalidAddressError).code).toBe('INVALID_ADDRESS')
    expect((err as InvalidAddressError).address).toBe('not-an-address')
    await expect(sol.ownerTokens('bad')).rejects.toBeInstanceOf(InvalidAddressError)
  })
})

describe('balances(owner, { mints, ...options })', () => {
  it('新写法与旧写法结果相同；旧写法照常可用', async () => {
    const node = createMockNode({
      accounts: {
        [USDC]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) },
        [getAssociatedTokenAddress(OWNER, USDC, TOKEN_PROGRAM_ID)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(USDC, OWNER, 2_500_000n) },
      },
    })
    const sol = new SolanaClient(node)
    const legacy = await sol.balances(OWNER, [USDC], { withSlot: true })
    const modern = await sol.balances(OWNER, { mints: [USDC], withSlot: true })
    expect(modern).toEqual(legacy)
    expect(modern[0]).toMatchObject({ token: USDC, balance: '2500000', formatted: '2.5', slot: 1 })
    expectTypeOf<BalancesQueryOptions['mints']>().toEqualTypeOf<readonly string[] | undefined>()
  })
})

describe('options 命名统一（旧名是别名）', () => {
  it('新旧类型名相同', () => {
    expectTypeOf<ApprovalsQuery>().toEqualTypeOf<ApprovalsOptions>()
    expectTypeOf<ClaimQuery>().toEqualTypeOf<ClaimableOptions>()
    expectTypeOf<ReclaimQuery>().toEqualTypeOf<ReclaimableOptions>()
  })
})
