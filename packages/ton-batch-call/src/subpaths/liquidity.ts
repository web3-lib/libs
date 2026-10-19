/**
 * 添加 / 移除流动性（子路径 `@w3lib/ton-batch-call/liquidity`）：STON.fi v2、DeDust 添加和移除，STON.fi v1 移除。
 *
 * ```ts
 * import { lpPositions } from '@w3lib/ton-batch-call/lp'
 * import { addLiquidity, removeLiquidity } from '@w3lib/ton-batch-call/liquidity'
 * const [position] = await lpPositions(ton, owner)
 * await removeLiquidity(ton, mnemonic, { position, percent: 50 })
 * ```
 */
export {
  LIQUIDITY_GAS,
  addLiquidity,
  buildAddLiquidity,
  buildRemoveLiquidity,
  removeLiquidity,
  type AddLiquidityParams,
  type LiquidityOptions,
  type LiquidityPlan,
  type LiquidityResult,
  type LiquiditySendOptions,
  type RemoveLiquidityParams,
} from '../liquidity.js'
