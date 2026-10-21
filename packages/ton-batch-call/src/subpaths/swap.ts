/**
 * 兑换（子路径 `@w3lib/ton-batch-call/swap`）：在 STON.fi v2 / v1、DeDust 的池子里找最好的路线（直接或经过 TON / USD₮ 两跳），
 * 报价并构建 / 发送兑换的消息。不放在主入口，不用时打包不会带上这部分代码；发送的代码按需加载。
 *
 * ```ts
 * import { NATIVE_TON } from '@w3lib/ton-batch-call'
 * import { getSwapQuote, swap } from '@w3lib/ton-batch-call/swap'
 *
 * const plan = await getSwapQuote(owner, { tokenIn: NATIVE_TON, tokenOut: USDT, amountInFormatted: '1' })
 * await swap(ton, mnemonic, { tokenIn: NATIVE_TON, tokenOut: USDT, amountInFormatted: '1' })
 * ```
 */
import { split, type ShortcutOptions } from '../shortcuts.js'
import { buildSwap, type SwapOptions, type SwapParams, type TonSwapPlan } from '../swap.js'

export {
  SWAP_GAS,
  buildSwap,
  receivedInTrace,
  stonfiV2SwapOut,
  swap,
  type SwapOptions,
  type SwapParams,
  type SwapResult,
  type SwapSendOptions,
  type TonSwapPlan,
  type TonSwapRoute,
} from '../swap.js'
export { TON_USDT } from '../price.js'

export interface GetSwapQuoteOptions extends SwapOptions, ShortcutOptions {}

/** 报价并构建兑换的消息（同 buildSwap），节点参数同其他快捷函数 */
export function getSwapQuote(owner: string, params: SwapParams, options: GetSwapQuoteOptions = {}): Promise<TonSwapPlan> {
  const [client, rest] = split(options)
  return buildSwap(client, owner, params, rest as SwapOptions)
}
