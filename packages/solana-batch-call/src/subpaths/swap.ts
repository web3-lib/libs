/**
 * 兑换（子路径 `@w3lib/solana-batch-call/swap`）：在 Raydium CLMM、Orca Whirlpool、Raydium CPMM、Raydium AMM v4 的池子里找最好的路线
 * （直接或经过 SOL / USDC / USDT 的两跳），本地报价并构建 / 发送兑换交易。不放在主入口，不用时打包不会带上这部分代码。不依赖各 DEX 的 SDK。
 *
 * ```ts
 * import { NATIVE_MINT } from '@w3lib/solana-batch-call'
 * import { getSwapQuote, swap } from '@w3lib/solana-batch-call/swap'
 *
 * const plan = await getSwapQuote(owner, { tokenIn: NATIVE_MINT, tokenOut: USDC, amountInFormatted: '0.5' })
 * await swap(client, secretKey, { tokenIn: NATIVE_MINT, tokenOut: USDC, amountInFormatted: '0.5' }, { slippage: 0.01 })
 * ```
 */
import { resolve, type ShortcutOptions } from '../shortcuts.js'
import { buildSwap, type SolanaSwapOptions, type SolanaSwapParams, type SolanaSwapPlan } from '../swap/index.js'

export {
  SWAP_INTERMEDIATES,
  SWAP_PROTOCOLS,
  buildSwap,
  swap,
  type SolanaSwapHop,
  type SolanaSwapOptions,
  type SolanaSwapParams,
  type SolanaSwapPlan,
  type SolanaSwapProtocol,
  type SolanaSwapResult,
  type SolanaSwapRoute,
  type SolanaSwapSendOptions,
  type SolanaSwapStep,
  type SolanaSwapStepResult,
} from '../swap/index.js'
export type { Instruction } from '../write/transaction.js'
export type { SignerInput, WriteResult, WriteStatus } from '../subpaths/write.js'

export interface GetSwapQuoteOptions extends SolanaSwapOptions, ShortcutOptions {}

/** 报价并构建兑换的指令（同 buildSwap），节点参数与 getBalances 相同 */
export function getSwapQuote(owner: string, params: SolanaSwapParams, options: GetSwapQuoteOptions = {}): Promise<SolanaSwapPlan> {
  const { client, own } = resolve(options, ['slippage', 'native', 'protocols', 'intermediates', 'pools', 'discover', 'signal'])
  return buildSwap(client, owner, params, own)
}
