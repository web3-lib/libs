/**
 * 兑换（子路径 `@w3lib/evm-batch-call/swap`）：在内置协议的 V2 / V3 池子里找最好的路线（直接或两跳），报价并构建 / 发送兑换交易。
 * 不放在主入口，不用时打包不会带上这部分代码；发送的代码按需加载。
 *
 * ```ts
 * import { getSwapQuote, swap } from '@w3lib/evm-batch-call/swap'
 *
 * const plan = await getSwapQuote(user, { tokenIn: NATIVE_TOKEN, tokenOut: USDT, amountInFormatted: '0.1' }, { chainId: 56 })
 * await swap(provider, key, { tokenIn: NATIVE_TOKEN, tokenOut: USDT, amountInFormatted: '0.1' })
 * ```
 */
import { buildSwap, type SwapOptions, type SwapParams, type SwapPlan } from '../swap.js'
import { resolve, type ShortcutProviderOptions } from '../shortcuts.js'

export {
  V3_SWAP_CONTRACTS,
  buildSwap,
  swap,
  swapProtocols,
  type SwapOptions,
  type SwapParams,
  type SwapPlan,
  type SwapResult,
  type SwapRoute,
  type SwapSendOptions,
  type SwapTx,
  type SwapTxResult,
} from '../swap.js'

export interface GetSwapQuoteOptions extends SwapOptions, ShortcutProviderOptions {}

/** 报价并构建兑换的交易（同 buildSwap），节点参数与 getBalances 相同 */
export function getSwapQuote(owner: string, params: SwapParams, options: GetSwapQuoteOptions = {}): Promise<SwapPlan> {
  const { provider, overrides, own } = resolve(options, ['slippage', 'deadline', 'recipient', 'approve', 'protocols', 'intermediates', 'route'])
  return buildSwap(provider, owner, params, { ...own, ...(overrides.blockTag === undefined ? {} : { blockTag: overrides.blockTag }) })
}
