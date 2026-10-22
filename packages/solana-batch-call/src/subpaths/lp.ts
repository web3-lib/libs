/**
 * LP 仓位（子路径 `@w3lib/solana-batch-call/lp`）：Raydium CLMM / Orca Whirlpool 的仓位 NFT，Raydium AMM v4 / CPMM 的 LP 代币，
 * 代币数量、未领取的手续费、可选的美元价值。不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getLpPositions } from '@w3lib/solana-batch-call/lp'
 *
 * await getLpPositions(owner, { provider: 'https://my-rpc…' })                  // 扫描全部代币账户（需要支持 getTokenAccountsByOwner 的节点）
 * await getLpPositions(owner, { mints: [positionNftMint], prices: true })        // 只看这些代币：免费公共节点也能用
 * ```
 */
import { lpPositions, type LpPositionsOptions, type SolanaLpPosition } from '../lp.js'
import { resolve, type ShortcutOptions } from '../shortcuts.js'

export {
  ORCA_WHIRLPOOL_PROGRAM_ID,
  RAYDIUM_AMM_PROGRAM_ID,
  RAYDIUM_CLMM_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID,
  SOLANA_LP_PROTOCOLS,
  defillamaPrices,
  lpPositions,
  type LpPositionsOptions,
  type SolanaLpAmmPosition,
  type SolanaLpClmmPosition,
  type SolanaLpPosition,
  type SolanaLpProtocol,
  type SolanaLpReward,
  type SolanaLpToken,
  type SolanaPriceSource,
} from '../lp.js'
export {
  MAX_TICK,
  MIN_TICK,
  getAmountsForLiquidity,
  getFeeGrowthInside,
  getFeesOwed,
  getLiquidityForAmounts,
  getMaxAmounts,
  getMinAmounts,
  getMintAmounts,
  getRewardGrowthInside,
  nearestUsableTick,
  orcaSqrtPriceAtTick,
  priceToTick,
  raydiumSqrtPriceAtTick,
  rewardGrowthGlobal,
  sqrtPriceAtTick,
  sqrtPriceToPrice,
  tickAtSqrtPrice,
  tickToPrice,
  type ClmmProgram,
  type RewardEmission,
  type TickFeeData,
} from '../lpMath.js'

export interface GetLpPositionsOptions extends LpPositionsOptions, ShortcutOptions {}

/**
 * 查一个地址的 LP 仓位。
 *
 * ```ts
 * await getLpPositions(owner, { provider: 'https://my-rpc…' })
 * // [{ type: 'clmm', protocol: 'raydium-clmm', pool, positionMint, token0: { symbol: 'SOL', … }, token1: { symbol: 'USDC', … },
 * //    amount0Formatted: '140.26', amount1Formatted: '6852.2', fees0Formatted: '0.546', fees1Formatted: '59.5', inRange: true, … },
 * //  { type: 'amm', protocol: 'raydium-amm', pool, lpMint, balance, share: 0.18, amount0Formatted, amount1Formatted, … }]
 * await getLpPositions(owner, { mints: [nftMint, lpMint], pools: [ammPool] })   // 免费公共节点：指定代币和池子
 * await getLpPositions(owner, { provider, prices: true })                        // 带美元价值（DefiLlama），按价值排序
 * ```
 */
export function getLpPositions(owner: string, options: GetLpPositionsOptions = {}): Promise<SolanaLpPosition[]> {
  // fetch 同时给节点请求（客户端配置）和查价用，与其他快捷函数一致
  const { client, own } = resolve(options, ['protocols', 'mints', 'pools', 'includeClosed', 'rewards', 'now', 'prices', 'onPriceError', 'signal'])
  return lpPositions(client, owner, { ...own, ...(options.fetch ? { fetch: options.fetch } : {}) })
}
