import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

import { base64 } from '@scure/base'
import { beforeEach, describe, expect, it } from 'vitest'

import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '../src/index.js'
import type { AccountInfo } from '../src/layout.js'
import { anchorIx } from '../src/liquidity/common.js'
import { RAYDIUM_CPMM_PROGRAM_ID } from '../src/lp.js'
import { resetNodeHealth } from '../src/rpc.js'
import { buildSwap, swap } from '../src/subpaths/swap.js'
import { amount0Delta, amount1Delta, computeSwapStep } from '../src/swap/clmmMath.js'
import { CLOCK_SYSVAR_ID, parseClock, swapMint, transferFee } from '../src/swap/common.js'
import { cpmmSwapBaseInput } from '../src/swap/cpmm.js'
import { parseSwapPool } from '../src/swap/index.js'
import { SOL, SOL_USDC, TKN, TKN_SOL, USDC, USER, fast, setupCpmmChain as setup, u64 } from './fakeCpmm.js'
import { mintData } from './mock.js'

// ---------------------------------------------------------------------------
// 主网快照重放：swap-live.test.ts 在同一 slot 读账户 + 模拟交易，记录模拟后实际收到的数量；这里用同一份账户离线重新报价
// ---------------------------------------------------------------------------

interface Fixture {
  capturedAt: string
  cases: Array<{
    label: string
    hops: Array<{ protocol: string; pool: string; tokenIn: string; amountIn: string; quoted: string; crossed: number | null; orders: number | null }>
    simulatedOut: string
    simulatedLeftover: string | null
    accounts: Record<string, { owner: string; data: string } | null>
  }>
}

const fixture = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/swap-mainnet.json.gz', import.meta.url))).toString('utf8')) as Fixture

describe('本地报价与主网模拟逐位一致（快照重放）', () => {
  it('快照覆盖四个协议、两个方向、两跳、限价单、自适应费率、转账手续费', () => {
    const protocols = new Set(fixture.cases.flatMap((c) => c.hops.map((h) => h.protocol)))
    expect([...protocols].sort()).toEqual(['orca-whirlpool', 'raydium-amm', 'raydium-clmm', 'raydium-cpmm'])
    expect(fixture.cases.some((c) => c.hops.length === 2)).toBe(true)
    expect(fixture.cases.some((c) => c.hops.some((h) => (h.orders ?? 0) > 0))).toBe(true)
    expect(fixture.cases.some((c) => c.hops.some((h) => (h.crossed ?? 0) > 50))).toBe(true)
  })

  for (const c of fixture.cases) {
    it(c.label, () => {
      const map = new Map<string, AccountInfo | null>(
        Object.entries(c.accounts).map(([address, a]) => [address, a ? { address, lamports: 0n, owner: a.owner, data: base64.decode(a.data), executable: false } : null]),
      )
      const get = (address: string) => map.get(address)
      const env = parseClock((map.get(CLOCK_SYSVAR_ID) as AccountInfo).data)
      const outs = c.hops.map((h) => {
        const pool = parseSwapPool(map.get(h.pool) as AccountInfo)
        expect(pool?.protocol).toBe(h.protocol)
        const q = (pool as NonNullable<typeof pool>).quote(get, BigInt(h.amountIn), pool?.mint0 === h.tokenIn, env)
        expect(q.amountOut.toString()).toBe(h.quoted)
        expect(q.crossed ?? null).toBe(h.crossed)
        return q.amountOut
      })
      expect(outs[outs.length - 1]?.toString()).toBe(c.simulatedOut)
      if (c.simulatedLeftover !== null) {
        expect(((outs[0] as bigint) - BigInt((c.hops[1] as (typeof c.hops)[number]).amountIn)).toString()).toBe(c.simulatedLeftover)
      }
    })
  }
  it('Raydium 的 fee_on（手续费从输出扣）和动态费率：主网暂时没有这样的池子，用快照改字段检查方向', () => {
    const c = fixture.cases.find((x) => x.label === 'raydium-clmm 大额 SOL→USDC') as Fixture['cases'][number]
    const hop = c.hops[0] as Fixture['cases'][number]['hops'][number]
    const quoteWith = (patch: (data: Uint8Array) => void) => {
      const map = new Map<string, AccountInfo | null>(
        Object.entries(c.accounts).map(([address, a]) => [address, a ? { address, lamports: 0n, owner: a.owner, data: base64.decode(a.data), executable: false } : null]),
      )
      const poolAccount = map.get(hop.pool) as AccountInfo
      patch(poolAccount.data)
      const pool = parseSwapPool(poolAccount) as NonNullable<ReturnType<typeof parseSwapPool>>
      return pool.quote((a) => map.get(a), BigInt(hop.amountIn), pool.mint0 === hop.tokenIn, parseClock((map.get(CLOCK_SYSVAR_ID) as AccountInfo).data))
    }
    const base = quoteWith(() => {})
    expect(base.amountOut.toString()).toBe(hop.quoted)
    // fee_on = 2（只收 token1）：卖 token0 时手续费从输出扣，数量接近但不同
    const onOutput = quoteWith((d) => {
      d[390] = 2
    })
    expect(onOutput.amountOut).not.toBe(base.amountOut)
    expect(Number(onOutput.amountOut) / Number(base.amountOut)).toBeGreaterThan(0.995)
    expect(Number(onOutput.amountOut) / Number(base.amountOut)).toBeLessThan(1.005)
    // 动态费率：穿过的 tick 组越多、波动参考值越大，手续费越高，输出越少（波动累计在兑换开始时按参考值重算）
    const dynamic = (reference: number) =>
      quoteWith((d) => {
        const v = new DataView(d.buffer, d.byteOffset)
        v.setUint16(1096, 10, true) // filter_period
        v.setUint16(1098, 600, true) // decay_period
        v.setUint16(1100, 5000, true) // reduction_factor
        v.setUint32(1102, 40_000, true) // dynamic_fee_control
        v.setUint32(1106, 350_000, true) // max_volatility_accumulator
        v.setInt32(1110, v.getInt32(269, true), true) // tick_spacing_index_reference = 当前 tick（spacing 1）
        v.setUint32(1114, reference, true) // volatility_reference
        // 刚更新过（小于 filter_period）：参考值不衰减
        v.setBigUint64(1122, parseClock(base64.decode((c.accounts[CLOCK_SYSVAR_ID] as { data: string }).data)).timestamp, true)
      })
    const calm = dynamic(0)
    const volatile = dynamic(300_000)
    expect(calm.amountOut).toBeLessThan(base.amountOut) // 穿过 tick 时波动累计增加
    expect(volatile.amountOut).toBeLessThan(calm.amountOut)
    expect(volatile.crossed).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 公式
// ---------------------------------------------------------------------------

describe('兑换的公式', () => {
  it('CPMM：手续费向上取整，输出向下取整；创建者手续费从输入或输出扣', () => {
    // 输入 1_000_000，费率 0.25%：手续费 2500；输出 = floor(997500 × 2e9 / (1e9 + 997500)) = 1_993_011
    expect(cpmmSwapBaseInput(1_000_000n, 1_000_000_000n, 2_000_000_000n, 2500n, 0n, true)).toBe(1_993_011n)
    // 手续费 ceil(1001 × 0.25%) = 3（向上取整）
    expect(cpmmSwapBaseInput(1001n, 1_000_000_000n, 1_000_000_000n, 2500n, 0n, true)).toBe(997n)
    // 创建者手续费 0.1% 从输入扣：合计 0.35%；从输出扣：先换再扣 ceil(输出 × 0.1%)
    expect(cpmmSwapBaseInput(1_000_000n, 1_000_000_000n, 2_000_000_000n, 2500n, 1000n, true)).toBe((996_500n * 2_000_000_000n) / 1_000_996_500n)
    const swapped = (997_500n * 2_000_000_000n) / 1_000_997_500n
    expect(cpmmSwapBaseInput(1_000_000n, 1_000_000_000n, 2_000_000_000n, 2500n, 1000n, false)).toBe(swapped - (swapped * 1000n + 999_999n) / 1_000_000n)
  })

  it('Token-2022 转账手续费：向上取整、不超过单笔上限、按 epoch 选新旧配置', () => {
    const data = mintData({ decimals: 6, transferFee: { older: { epoch: 0n, maximumFee: 50n, basisPoints: 100 }, newer: { epoch: 600n, maximumFee: 1000n, basisPoints: 269 } } })
    const mint = swapMint('m', { address: 'm', lamports: 0n, owner: TOKEN_2022_PROGRAM_ID, data, executable: false })
    expect(transferFee(mint, 10_000n, 599n)).toBe(50n) // 旧配置 1%：100，超过上限 50
    expect(transferFee(mint, 10_000n, 600n)).toBe(269n)
    expect(transferFee(mint, 1n, 600n)).toBe(1n) // 不足 1 也收 1
    expect(transferFee(mint, 0n, 600n)).toBe(0n)
    expect(transferFee(mint, 10n ** 9n, 600n)).toBe(1000n)
    const spl = swapMint('s', { address: 's', lamports: 0n, owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }), executable: false })
    expect(transferFee(spl, 10_000n, 600n)).toBe(0n)
  })

  it('集中流动性一步：输入够走到目标价格时停在目标；不够时用完输入，手续费是剩下的', () => {
    const Q64 = 1n << 64n
    const L = 10n ** 12n
    const target = Q64 - Q64 / 100n
    const full = amount0Delta(target, Q64, L, true)
    // 输入足够：停在目标价格，手续费 = ceil(输入 × 费率 / (1 − 费率))
    const reach = computeSwapStep(Q64, target, L, 10n ** 12n, 3000n, true, true, 'orca')
    expect(reach.sqrtPrice).toBe(target)
    expect(reach.amountIn).toBe(full)
    expect(reach.feeAmount).toBe((full * 3000n + 997_000n - 1n) / 997_000n)
    expect(reach.amountOut).toBe(amount1Delta(target, Q64, L, false))
    // 输入不够：价格停在中间，输入 + 手续费 = 全部
    const part = computeSwapStep(Q64, target, L, 1_000_000n, 3000n, true, true, 'raydium')
    expect(part.sqrtPrice > target && part.sqrtPrice < Q64).toBe(true)
    expect(part.amountIn + part.feeAmount).toBe(1_000_000n)
    // 手续费从输出扣（Raydium fee_on）：输入全部用掉，输出扣 ceil(输出 × 费率)
    const onOut = computeSwapStep(Q64, target, L, 1_000_000n, 3000n, true, false, 'raydium')
    expect(onOut.amountIn).toBe(1_000_000n)
    const gross = onOut.amountOut + onOut.feeAmount
    expect(onOut.feeAmount).toBe((gross * 3000n + 999_999n) / 1_000_000n)
  })
})

// ---------------------------------------------------------------------------
// 假的链：两个 CPMM 池子（SOL / USDC、TKN / SOL）+ 假的 CPMM 程序（fakeCpmm.ts）
// ---------------------------------------------------------------------------

const constantProduct = (amountIn: bigint, rIn: bigint, rOut: bigint) => {
  const afterFee = amountIn - (amountIn * 2500n + 999_999n) / 1_000_000n
  return (afterFee * rOut) / (rIn + afterFee)
}
const programs = (ixs: ReadonlyArray<{ programId: string; data: Uint8Array }>) => ixs.map((ix) => `${ix.programId.slice(0, 6)}:${ix.data[0]}`)

beforeEach(() => {
  resetNodeHealth()
})

describe('buildSwap / swap（假的链）', () => {
  it('SOL → USDC：报价、最少收到、包装 SOL、创建 USDC 账户、用完关闭 wSOL', async () => {
    const { client } = setup()
    const plan = await buildSwap(client, USER.address, { tokenIn: NATIVE_MINT, tokenOut: USDC, amountInFormatted: '1' }, { discover: false, pools: [SOL_USDC.address] })
    const expected = constantProduct(SOL, 100n * SOL, 15_000n * 10n ** 6n)
    expect(plan).toMatchObject({ amountIn: String(SOL), amountOut: String(expected), native: 'tokenIn', leftover: null })
    expect(plan.amountOutMin).toBe(String((expected * 995_000n) / 1_000_000n))
    expect(plan.route.hops).toEqual([expect.objectContaining({ protocol: 'raydium-cpmm', pool: SOL_USDC.address, tokenIn: NATIVE_MINT, tokenOut: USDC, amountOutMin: plan.amountOutMin })])
    expect(plan.priceImpact).toBeGreaterThan(0.009) // 1 SOL / 100 SOL 储备：约 1%
    expect(plan.priceImpact).toBeLessThan(0.011)
    expect(plan.price).toBeCloseTo(Number(expected) / 1e6, 6)
    const [setupStep, main] = plan.steps
    expect(setupStep?.kind).toBe('setup')
    expect(programs(setupStep?.instructions ?? [])).toEqual(['AToken:1', 'AToken:1'])
    expect(programs(main?.instructions ?? [])).toEqual(['111111:2', 'Tokenk:17', `${RAYDIUM_CPMM_PROGRAM_ID.slice(0, 6)}:${anchorIx('swap_base_input')[0]}`, 'Tokenk:9'])
    const ix = main?.instructions[2]
    expect(u64(ix?.data as Uint8Array, 8)).toBe(SOL)
    expect(u64(ix?.data as Uint8Array, 16)).toBe(BigInt(plan.amountOutMin))
    // 输入是 wSOL 的 ATA，输出是 USDC 的 ATA
    expect(ix?.keys[4]?.pubkey).toBe(getAssociatedTokenAddress(USER.address, NATIVE_MINT, TOKEN_PROGRAM_ID))
    expect(ix?.keys[5]?.pubkey).toBe(getAssociatedTokenAddress(USER.address, USDC, TOKEN_PROGRAM_ID))
  })

  it('两跳 TKN → SOL → USDC：第二跳卖第一跳的最少收到，多出的 SOL 随 wSOL 账户关闭退回', async () => {
    const { chain, client } = setup()
    const plan = await buildSwap(client, USER.address, { tokenIn: TKN, tokenOut: USDC, amountInFormatted: '500' }, { discover: false, pools: [SOL_USDC.address, TKN_SOL.address] })
    const q1 = constantProduct(500n * 10n ** 6n, 50_000n * 10n ** 6n, 100n * SOL)
    const min1 = (q1 * 995_000n) / 1_000_000n
    const out = constantProduct(min1, 100n * SOL, 15_000n * 10n ** 6n)
    expect(plan.route.path).toEqual([TKN, NATIVE_MINT, USDC])
    expect(plan.route.hops.map((h) => [h.amountIn, h.amountOut, h.amountOutMin])).toEqual([
      [String(500n * 10n ** 6n), String(q1), String(min1)],
      [String(min1), String(out), String((out * 995_000n) / 1_000_000n)],
    ])
    expect(plan.amountOut).toBe(String(out))
    expect(plan.route.value).toBe(String(constantProduct(q1, 100n * SOL, 15_000n * 10n ** 6n)))
    expect(plan.leftover).toEqual({ mint: NATIVE_MINT, amount: String(q1 - min1) })
    expect(plan.native).toBe(null)

    const solBefore = chain.sol(USER.address)
    const result = await swap(client, USER.secretKey, { tokenIn: TKN, tokenOut: USDC, amountInFormatted: '500' }, { ...fast, discover: false, pools: [SOL_USDC.address, TKN_SOL.address] })
    expect(result.status).toBe('confirmed')
    expect(chain.token(USER.address, USDC)).toBe(out)
    expect(chain.token(USER.address, TKN)).toBe(500n * 10n ** 6n)
    expect(chain.token(USER.address, NATIVE_MINT)).toBe(null) // 中间的 wSOL 账户已关闭
    // 退回的：多出的 SOL（q1 − min1）；花掉的：USDC 账户的租金 + 手续费
    expect(chain.sol(USER.address) - solBefore).toBe(q1 - min1 - 2_039_280n - 5000n)
  })

  it('发送 SOL → USDC：余额变化与报价一致', async () => {
    const { chain, client } = setup()
    const result = await swap(client, USER.secretKey, { tokenIn: NATIVE_MINT, tokenOut: USDC, amountInFormatted: '2' }, { ...fast, discover: false, pools: [SOL_USDC.address] })
    expect(result.status).toBe('confirmed')
    expect(result.results.map((r) => r.kind)).toEqual(['setup', 'swap'])
    expect(chain.token(USER.address, USDC)).toBe(BigInt(result.plan.amountOut))
    expect(chain.token(USER.address, NATIVE_MINT)).toBe(null)
    expect(10n * SOL - chain.sol(USER.address)).toBe(2n * SOL + 2_039_280n + 5000n)
  })

  it('余额不够时发送前报错；参数错误', async () => {
    const { client } = setup()
    const options = { ...fast, discover: false, pools: [SOL_USDC.address] }
    await expect(swap(client, USER.secretKey, { tokenIn: NATIVE_MINT, tokenOut: USDC, amountInFormatted: '20' }, options)).rejects.toThrow(/Insufficient balance of SOL/)
    await expect(buildSwap(client, USER.address, { tokenIn: USDC, tokenOut: USDC, amountIn: 1 }, options)).rejects.toThrow(/same/)
    await expect(buildSwap(client, USER.address, { tokenIn: NATIVE_MINT, tokenOut: NATIVE_MINT, amountIn: 1 }, options)).rejects.toThrow(/Wrapping/)
    await expect(buildSwap(client, USER.address, { tokenIn: NATIVE_MINT, tokenOut: USDC, amountIn: 0 }, options)).rejects.toThrow(/greater than 0/)
    await expect(buildSwap(client, USER.address, { tokenIn: NATIVE_MINT, tokenOut: USDC, amountIn: 1, amountInFormatted: '1' }, options)).rejects.toThrow(/either/)
    await expect(buildSwap(client, USER.address, { tokenIn: TKN, tokenOut: USDC, amountIn: 1 }, { ...options, intermediates: [] })).rejects.toThrow(/No pool found/)
    await expect(buildSwap(client, USER.address, { tokenIn: NATIVE_MINT, tokenOut: USDC, amountIn: 1 }, { ...options, protocols: ['uniswap' as never] })).rejects.toThrow(/Unknown swap protocol/)
  })

  it('池子禁止兑换时跳过并给出原因', async () => {
    const { chain, client } = setup()
    ;(chain.accounts[SOL_USDC.address]?.data as Uint8Array)[329] = 4 // status 的 Swap 位
    await expect(buildSwap(client, USER.address, { tokenIn: NATIVE_MINT, tokenOut: USDC, amountIn: SOL }, { discover: false, pools: [SOL_USDC.address] })).rejects.toThrow(/Swap is disabled/)
  })
})
