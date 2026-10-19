/**
 * 添加 / 移除流动性（子路径 `@w3lib/sui-batch-call/liquidity`）：与 /lp 相同的协议（集中流动性和传统 AMM）。
 *
 * ```ts
 * import { addLiquidity, buildAddLiquidity, collectFees, removeLiquidity } from '@w3lib/sui-batch-call/liquidity'
 * await addLiquidity(sui, key, { pool, priceLower: 3, priceUpper: 4, amount1Formatted: '10' })
 * ```
 */
export {
  addLiquidity,
  buildAddLiquidity,
  buildCollectFees,
  buildRemoveLiquidity,
  collectFees,
  removeLiquidity,
  type AddLiquidityParams,
  type AddLiquidityPlan,
  type CollectFeesParams,
  type LiquidityOptions,
  type LiquidityPlanCoin,
  type LiquidityPlanBase,
  type LiquidityResult,
  type LiquiditySendOptions,
  type RemoveLiquidityParams,
  type RemoveLiquidityPlan,
} from '../liquidity.js'
