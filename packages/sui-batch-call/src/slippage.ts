/** 滑点计算（添加 / 移除流动性和兑换共用）：滑点是 0~1 的比例，按百万分之一取整 */
const SCALE = 1_000_000n

/** 滑点（0~1）→ 百万分之一 */
export function slippageOf(slippage: number): bigint {
  if (!(slippage >= 0 && slippage < 1)) throw new Error(`Invalid slippage: ${slippage}`)
  return BigInt(Math.round(slippage * 1e6))
}

/** 上限：向上取整 */
export const withSlippageUp = (v: bigint, s: bigint): bigint => (v * (SCALE + s) + SCALE - 1n) / SCALE
/** 下限：向下取整 */
export const withSlippageDown = (v: bigint, s: bigint): bigint => (v * (SCALE - s)) / SCALE
