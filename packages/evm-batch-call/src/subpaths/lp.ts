/**
 * LP 仓位（子路径 `@w3lib/evm-batch-call/lp`）：查一个地址在各 DEX 的流动性仓位——V2 的 LP 代币、V3 / V4 的仓位 NFT，
 * 代币数量、未领取的手续费、可选的美元价值。不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getLpPositions } from '@w3lib/evm-batch-call/lp'
 *
 * await getLpPositions(user, { chainId: 56 })                     // 节点参数与 getBalances 相同
 * await getLpPositions(user, { chainId: 56, prices: true })       // 带美元价值（DefiLlama）
 * ```
 */
import { lpPositions, type LpPosition, type LpPositionsOptions } from '../lp.js'
import { resolve, type ShortcutProviderOptions } from '../shortcuts.js'

export {
  LP_PROTOCOLS,
  LP_QUOTE_TOKENS,
  lpPositions,
  resolveLpProtocols,
  type LpConcentratedPosition,
  type LpPosition,
  type LpPositionsOptions,
  type LpProtocol,
  type LpToken,
  type LpV2Position,
  type LpVersion,
} from '../lp.js'
export {
  decodePositionInfo,
  keyValueLpScanStorage,
  memoryLpScanStorage,
  poolIdOf,
  type LpScanStorage,
  type LpV4Options,
  type V4ScanOptions,
  type V4ScanProgress,
} from '../lpV4.js'
export {
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  getAmountsForLiquidity,
  getFeeGrowthInside,
  getFeesEarned,
  getLiquidityForAmounts,
  getMaxAmounts,
  getMinAmounts,
  getMintAmounts,
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
  nearestUsableTick,
  priceToSqrtPriceX96,
  priceToTick,
  sqrtPriceToPrice,
  tickToPrice,
} from '../lpMath.js'
export { defillamaPrices, type PriceSource } from '../owner.js'

export interface GetLpPositionsOptions extends LpPositionsOptions, ShortcutProviderOptions {}

/**
 * 查一个地址的 LP 仓位（V2 LP 代币、V3 仓位 NFT；V4 仓位 NFT 需要传 v4.tokenIds 或开启 v4.scan），所有合约读取用 multicall 批量完成。
 *
 * ```ts
 * await getLpPositions(user, { chainId: 56 })
 * // [{ version: 'v3', protocol: 'pancakeswap-v3', pool, tokenId: '123', token0: { symbol: 'WBNB', … }, token1: { symbol: 'USDT', … },
 * //    amount0Formatted: '1.2', amount1Formatted: '700', fees0Formatted: '0.003', fees1Formatted: '1.8', inRange: true, … },
 * //  { version: 'v2', protocol: 'pancakeswap-v2', pool, balance, share: 0.0001, amount0Formatted, amount1Formatted, … }]
 * await getLpPositions(user, { chainId: 56, tokens: heldTokens })    // V2：用持有的代币 × 计价币找池子
 * await getLpPositions(user, { chainId: 56, prices: true })          // 带美元价值，按价值排序
 * ```
 */
export function getLpPositions(owner: string, options: GetLpPositionsOptions = {}): Promise<LpPosition[]> {
  const { provider, overrides, own } = resolve(options, [
    'protocols',
    'versions',
    'pools',
    'tokens',
    'quoteTokens',
    'source',
    'includeClosed',
    'maxPositions',
    'v4',
    'prices',
    'onPriceError',
    'fetch',
  ])
  return lpPositions(provider, owner, { ...overrides, ...own })
}
