/**
 * 添加 / 移除流动性（子路径 `@w3lib/evm-batch-call/liquidity`）：V2（Router）、V3（仓位 NFT）、Uniswap V4（PositionManager + Permit2），
 * 包括 Tron 上的 SunSwap V2 / V3。不放在主入口，不用时打包不会带上这部分代码。
 *
 * - build*：只读取、不签名，返回预计的数量和要按顺序发送的交易（授权在前），可以当作报价，也可以交给钱包自己发送
 * - addLiquidity / removeLiquidity / collectFees：构建后用私钥 / ethers Signer / 浏览器钱包签名发送（同 /write 的 batchCall）
 *
 * ```ts
 * import { getLpPositions } from '@w3lib/evm-batch-call/lp'
 * import { addLiquidity, buildAddLiquidity, removeLiquidity } from '@w3lib/evm-batch-call/liquidity'
 *
 * const plan = await buildAddLiquidity(multi, owner, { protocol: 'pancakeswap-v3', tokenA: WBNB, tokenB: USDT, fee: 500, priceLower: 550, priceUpper: 650, amountAFormatted: '1' })
 * await addLiquidity(multi, privateKey, { protocol: 'pancakeswap-v2', tokenA: NATIVE_TOKEN, tokenB: USDT, amountAFormatted: '0.1' })
 * const [position] = await getLpPositions(owner, { chainId: 56 })
 * await removeLiquidity(multi, privateKey, { position, percent: 50 })
 * ```
 */
export {
  addLiquidity,
  buildAddLiquidity,
  buildCollectFees,
  buildRemoveLiquidity,
  collectFees,
  removeLiquidity,
} from '../liquidity/index.js'
export { PERMIT2_ADDRESS } from '../liquidity/common.js'
export type {
  AddLiquidityParams,
  CollectFeesParams,
  IncreaseLiquidityParams,
  LiquidityOptions,
  LiquidityPlan,
  LiquidityResult,
  LiquiditySendOptions,
  LiquidityTx,
  LiquidityTxResult,
  NewPositionParams,
  PositionRef,
  RemoveLiquidityParams,
} from '../liquidity/types.js'
export {
  getLiquidityForAmounts,
  getMaxAmounts,
  getMinAmounts,
  getMintAmounts,
  getTickAtSqrtRatio,
  nearestUsableTick,
  priceToSqrtPriceX96,
  priceToTick,
} from '../lpMath.js'
export type { LpPosition, LpProtocol, LpToken } from '../lp.js'
export type { SignerInput, WriteResult, WriteStatus } from '../subpaths/write.js'
