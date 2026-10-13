import { describe, expect, it } from 'vitest'

import { MAX_TICK, MIN_TICK, getAmountsForLiquidity, getFeeGrowthInside, getFeesEarned, getSqrtRatioAtTick, sqrtPriceToPrice, tickToPrice } from '../src/lpMath.js'

const Q96 = 2n ** 96n
const Q128 = 2n ** 128n

describe('TickMath', () => {
  it('与 Uniswap 合约的已知值一致', () => {
    expect(getSqrtRatioAtTick(0)).toBe(Q96)
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(4295128739n)
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(1461446703485210103287273052203988822378723970342n)
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow(RangeError)
  })

  it('任意 tick 与 sqrt(1.0001^tick) 的相对误差很小', () => {
    for (const tick of [-500000, -200000, -50000, -1234, -1, 1, 7, 1234, 50000, 200000, 500000]) {
      const exact = Number(getSqrtRatioAtTick(tick)) / Number(Q96)
      const approx = Math.sqrt(1.0001 ** tick)
      expect(Math.abs(exact / approx - 1)).toBeLessThan(1e-9)
    }
  })
})

describe('LiquidityAmounts', () => {
  const L = 10n ** 18n
  const a = getSqrtRatioAtTick(-600)
  const b = getSqrtRatioAtTick(600)

  it('价格在区间下方只有 token0，上方只有 token1，区间内两种都有', () => {
    const [below0, below1] = getAmountsForLiquidity(getSqrtRatioAtTick(-1000), a, b, L)
    expect(below0 > 0n && below1 === 0n).toBe(true)
    const [above0, above1] = getAmountsForLiquidity(getSqrtRatioAtTick(1000), a, b, L)
    expect(above0 === 0n && above1 > 0n).toBe(true)
    const [in0, in1] = getAmountsForLiquidity(Q96, a, b, L)
    expect(in0 > 0n && in1 > 0n).toBe(true)
    // 区间对称、价格 1：两边数量相等（取整误差 1 以内）
    expect(in0 - in1 <= 1n && in1 - in0 <= 1n).toBe(true)
    // 区间两端顺序颠倒结果一样；流动性 0 时都是 0
    expect(getAmountsForLiquidity(Q96, b, a, L)).toEqual([in0, in1])
    expect(getAmountsForLiquidity(Q96, a, b, 0n)).toEqual([0n, 0n])
  })
})

describe('手续费', () => {
  it('区间内的手续费增长：当前 tick 在区间内 / 下方 / 上方', () => {
    // global 100，下端外侧 10，上端外侧 20
    expect(getFeeGrowthInside(0, -10, 10, 100n, 10n, 20n)).toBe(70n)
    // 当前在区间下方：below = global - lowerOutside = 90，above = upperOutside = 20 → 100 - 90 - 20 = -10（uint256 回绕）
    expect(getFeeGrowthInside(-20, -10, 10, 100n, 10n, 20n)).toBe(2n ** 256n - 10n)
    // 当前在区间上方：below = lowerOutside = 10，above = global - upperOutside = 80 → 100 - 10 - 80 = 10
    expect(getFeeGrowthInside(20, -10, 10, 100n, 10n, 20n)).toBe(10n)
  })

  it('新产生的手续费：L × 差值 / 2^128，差值按 uint256 回绕', () => {
    expect(getFeesEarned(2n, 5n * Q128, 3n * Q128)).toBe(4n)
    // inside 回绕到比 last 小：差值仍是正的
    expect(getFeesEarned(1n, Q128, 2n ** 256n - Q128)).toBe(2n)
  })
})

describe('价格', () => {
  it('sqrtPrice / tick 换算成 token1 / token0 的价格（考虑精度）', () => {
    expect(sqrtPriceToPrice(Q96, 18, 18)).toBeCloseTo(1, 12)
    // token0 18 位、token1 6 位：原始比例 1 时价格是 1e12
    expect(sqrtPriceToPrice(Q96, 18, 6)).toBeCloseTo(1e12, 0)
    // 价格很小时不丢精度（meme 币 / USDC：token0 18 位、token1 6 位）
    for (const tick of [-376324, -400000, -600000, 600000]) {
      expect(sqrtPriceToPrice(getSqrtRatioAtTick(tick), 18, 6) / tickToPrice(tick, 18, 6)).toBeCloseTo(1, 8)
    }
    expect(tickToPrice(0, 18, 18)).toBe(1)
    expect(tickToPrice(23027, 18, 18)).toBeCloseTo(10, 2)
  })
})
