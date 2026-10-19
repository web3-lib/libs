/**
 * 添加 / 移除流动性（子路径 `@w3lib/solana-batch-call/liquidity`）：Raydium CLMM、Orca Whirlpool（仓位 NFT），
 * Raydium AMM v4、CPMM（LP 代币）。不放在主入口，不用时打包不会带上这部分代码。不依赖各 DEX 的 SDK。
 *
 * - build*：只读取、不签名，返回预计的数量和按顺序执行的指令，可以当作报价，也可以自己组交易发送
 * - addLiquidity / removeLiquidity / collectFees：构建后签名发送（同 /write 的 batchCall），SOL 自动包装 / 解包
 *
 * ```ts
 * import { getLpPositions } from '@w3lib/solana-batch-call/lp'
 * import { addLiquidity, removeLiquidity } from '@w3lib/solana-batch-call/liquidity'
 *
 * await addLiquidity(client, secretKey, { protocol: 'raydium-clmm', pool, priceLower: 120, priceUpper: 180, amount0Formatted: '1' })
 * const [position] = await getLpPositions(owner, { provider: rpc })
 * await removeLiquidity(client, secretKey, { position, percent: 50 })
 * ```
 */
export { addLiquidity, buildAddLiquidity, buildCollectFees, buildRemoveLiquidity, collectFees, removeLiquidity } from '../liquidity/index.js'
export type {
  SolanaAddLiquidityParams,
  SolanaCollectFeesParams,
  SolanaIncreaseLiquidityParams,
  SolanaLiquidityOptions,
  SolanaLiquidityPlan,
  SolanaLiquidityResult,
  SolanaLiquiditySendOptions,
  SolanaLiquidityStep,
  SolanaLiquidityStepResult,
  SolanaNewPositionParams,
  SolanaPositionRef,
  SolanaRemoveLiquidityParams,
} from '../liquidity/types.js'
export {
  getLiquidityForAmounts,
  getMaxAmounts,
  getMinAmounts,
  getMintAmounts,
  nearestUsableTick,
  priceToTick,
  sqrtPriceAtTick,
  tickAtSqrtPrice,
  type ClmmProgram,
} from '../lpMath.js'
export type { SolanaLpPosition, SolanaLpProtocol, SolanaLpToken } from '../lp.js'
export type { Instruction } from '../write/transaction.js'
export type { SignerInput, WriteResult, WriteStatus } from '../subpaths/write.js'
