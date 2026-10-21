/**
 * 兑换（子路径 `@w3lib/sui-batch-call/swap`）：在支持的 DEX 里找最好的路线（直接或经过 SUI / USDC 两跳），
 * 每条候选路线用只读调用执行一遍兑换来报价，构建 / 发送兑换的交易（最少收到的数量在交易里检查）。
 * 不放在主入口，不用时打包不会带上这部分代码。
 *
 * ```ts
 * import { getSwapQuote, swap } from '@w3lib/sui-batch-call/swap'
 *
 * const plan = await getSwapQuote(owner, { tokenIn: SUI_COIN_TYPE, tokenOut: USDC, amountInFormatted: '10' })
 * await swap(sui, key, { tokenIn: SUI_COIN_TYPE, tokenOut: USDC, amountInFormatted: '10' })
 * ```
 */
import { buildSwap, type SwapOptions, type SwapParams, type SwapPlan } from '../swap.js'
import { clientFor, type ShortcutOptions } from '../shortcuts.js'

export {
  SWAP_INTERMEDIATES,
  buildSwap,
  swap,
  type SwapHop,
  type SwapOptions,
  type SwapParams,
  type SwapPlan,
  type SwapResult,
  type SwapRoute,
  type SwapSendOptions,
} from '../swap.js'
export type { PoolLookupProtocol } from '../pools.js'

export interface GetSwapQuoteOptions extends SwapOptions, ShortcutOptions {}

/**
 * 报价并构建兑换的交易（同 buildSwap），节点参数同其他快捷函数（provider、network…）。
 *
 * ```ts
 * const plan = await getSwapQuote(owner, { tokenIn: USDC, tokenOut: SUI_COIN_TYPE, amountInFormatted: '100' }, { slippage: 0.01 })
 * plan.amountOutMinFormatted
 * ```
 */
export function getSwapQuote(owner: string, params: SwapParams, options: GetSwapQuoteOptions = {}): Promise<SwapPlan> {
  const { provider, network, timeout, headers, fetch, retries, concurrency, ...rest } = options
  return buildSwap(clientFor({ provider, network, timeout, headers, fetch, retries, concurrency }), owner, params, rest)
}
