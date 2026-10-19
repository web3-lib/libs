import { describe, expect, it } from 'vitest'

import { amountsForLiquidity, liquidityForAmount, sqrtPriceAtTick } from '../src/clmmMath.js'

describe('集中流动性的数学（Q64.64）', () => {
  it('tick → sqrt 价格与 Cetus 合约的 tick_math::get_sqrt_price_at_tick 一致', () => {
    // 期望值是主网上只读调用合约得到的（Cetus、Momentum、Turbos、Magma、FlowX 的 tick_math 结果相同，Bluefin 直接用 Cetus 的）
    const onChain: Array<[number, bigint]> = [
      [-443636, 4295048016n],
      [-1000, 17547129613991598777n],
      [-1, 18445821805675392311n],
      [0, 2n ** 64n],
      [1, 18447666387855959850n],
      [1000, 19392480388906836277n],
      [443636, 79226673515401279992447579055n],
    ]
    for (const [t, v] of onChain) expect(sqrtPriceAtTick(t)).toBe(v)
    for (const t of [-200001, -69113, -1, 1, 7, 50000, 300003]) {
      const s = sqrtPriceAtTick(t)
      // 与 1.0001^(t/2) × 2^64 的浮点值相对误差很小
      expect(Math.abs(Number(s) / 2 ** 64 / Math.sqrt(1.0001 ** t) - 1)).toBeLessThan(1e-9)
    }
    expect(() => sqrtPriceAtTick(443637)).toThrow(RangeError)
  })

  it('按数量算流动性，再按流动性算数量（往返不多于给的数量）', () => {
    const [sa, sb, p] = [sqrtPriceAtTick(-1000), sqrtPriceAtTick(1000), sqrtPriceAtTick(120)]
    const l0 = liquidityForAmount(p, sa, sb, 1_000_000_000n, true)
    const [a0, a1] = amountsForLiquidity(p, sa, sb, l0, true)
    expect(a0).toBeLessThanOrEqual(1_000_000_000n)
    expect(a0).toBeGreaterThan(999_999_000n)
    expect(a1).toBeGreaterThan(0n)
    const [r0, r1] = amountsForLiquidity(p, sa, sb, l0, false)
    expect(r0).toBeLessThanOrEqual(a0)
    expect(r1).toBeLessThanOrEqual(a1)
  })

  it('价格在区间一侧：只需要一种代币', () => {
    const [sa, sb] = [sqrtPriceAtTick(100), sqrtPriceAtTick(200)]
    const below = sqrtPriceAtTick(0)
    const above = sqrtPriceAtTick(300)
    expect(liquidityForAmount(below, sa, sb, 1000n, false)).toBe(0n)
    expect(liquidityForAmount(above, sa, sb, 1000n, true)).toBe(0n)
    const l = liquidityForAmount(below, sa, sb, 1_000_000n, true)
    expect(amountsForLiquidity(below, sa, sb, l)[1]).toBe(0n)
    expect(amountsForLiquidity(above, sa, sb, l)[0]).toBe(0n)
  })
})
