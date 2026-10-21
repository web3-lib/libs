/** 滑点计算（添加 / 移除流动性和兑换共用）：滑点是 0~1 的比例（默认 0.005），按百万分之一取整 */
export function slippagePpm(s: number | undefined): bigint {
  const v = s ?? 0.005
  if (!(v >= 0 && v < 1)) throw new Error(`Invalid slippage: ${v}`)
  return BigInt(Math.round(v * 1_000_000))
}

/** 下限：amount × (1 − slippage)，向下取整 */
export const withSlippageDown = (amount: bigint, ppm: bigint): bigint => (amount * (1_000_000n - ppm)) / 1_000_000n
