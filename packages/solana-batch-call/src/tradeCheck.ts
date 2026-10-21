/**
 * 能不能买、能不能卖（/risk 的 tradeChecks）：用 /swap 构建“SOL 买入 → 全部卖回 SOL”，放进一笔交易在主网模拟（simulateTransaction，不验签名、不上链），
 * 看哪一步失败、来回损失多少。和 tokenRisks 分开：不用时打包不会带上 /swap 的代码
 */
import { base64 } from '@scure/base'

import { getAssociatedTokenAddress, isAddress } from './address.js'
import type { RequestOptions, SolanaClient } from './client.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from './constants.js'
import { parseTokenAccount, parseUnits } from './layout.js'
import { buildSwap, type SolanaSwapOptions, type SolanaSwapPlan } from './swap/index.js'
import { MAX_COMPUTE_UNITS, setComputeUnitLimit } from './write/instructions.js'
import { transactionErrorText } from './write/send.js'
import { MAX_ACCOUNT_LOCKS, PACKET_DATA_SIZE, compileMessage, serializeTransaction, transactionSize, type Instruction } from './write/transaction.js'

export type TradeStage = 'ok' | 'no-pool' | 'buy-failed' | 'sell-failed'

export interface SolanaTradeCheck {
  mint: string
  /** ok：买入、卖出都成功；no-pool：内置协议里找不到能报价的路线；buy-failed：买不进；sell-failed：买得进、卖不出（貔貅盘）；模拟没做成时为 null */
  stage: TradeStage | null
  /** 卖不出 */
  honeypot: boolean | null
  /** 买入用的路线（池子、协议） */
  buyRoute: Array<{ protocol: string; pool: string }> | null
  /** 花的 SOL、买到的代币、卖回的 SOL（最小单位） */
  spent: string
  bought: string | null
  sold: string | null
  /** 来回损失（0~1）：1 − 卖回的 SOL / 花的 SOL（卖出的是买入的最少收到，按卖出的比例折算），含两次的池子手续费、价格影响和转账手续费 */
  roundTripLoss: number | null
  /** 失败原因（模拟的报错或报价的报错） */
  error: string | null
  /** 汇总的标记：no-pool、cannot-buy、honeypot、high-round-trip-loss（> 10%） */
  flags: string[]
}

export interface TradeCheckOptions extends RequestOptions, Pick<SolanaSwapOptions, 'protocols' | 'intermediates' | 'pools' | 'discover'> {
  /**
   * 模拟用的钱包（要有足够的 SOL；不验签名，可以是任何有 SOL 的系统账户，如自己的地址）。
   * 模拟时它创建代币账户的租金和手续费都不会真的扣
   */
  owner: string
  /** 买入花多少 SOL：amount（lamports）和 amountFormatted 二选一，默认 0.05 SOL */
  amount?: bigint | number | string
  amountFormatted?: string
}

/**
 * 模拟买入再卖出，判断能不能交易（每个代币两次报价 + 一次 simulateTransaction）。
 *
 * ```ts
 * const [check] = await tradeChecks(client, [mint], { owner: myAddress })
 * // { stage: 'ok', honeypot: false, roundTripLoss: 0.0061, flags: [] }
 * ```
 */
export async function tradeChecks(client: SolanaClient, mints: readonly string[], options: TradeCheckOptions): Promise<SolanaTradeCheck[]> {
  if (!isAddress(options.owner)) throw new Error(`Invalid owner address: ${options.owner}`)
  if (options.amount !== undefined && options.amountFormatted !== undefined) throw new Error('Pass either amount or amountFormatted, not both')
  const spent = options.amountFormatted !== undefined ? parseUnits(options.amountFormatted, 9) : options.amount !== undefined ? BigInt(options.amount) : 50_000_000n
  if (spent <= 0n) throw new RangeError('amount must be greater than 0')
  const [sol] = await client.solBalances([options.owner], { signal: options.signal })
  // 留出两个代币账户的租金和手续费
  if (!sol?.success || BigInt(sol.balance) < spent + 10_000_000n) {
    throw new Error(`${options.owner} does not have enough SOL to simulate the trades (needs about ${spent + 10_000_000n} lamports)`)
  }
  return Promise.all(mints.map((mint) => checkOne(client, mint, spent, options)))
}

async function checkOne(client: SolanaClient, mint: string, spent: bigint, options: TradeCheckOptions): Promise<SolanaTradeCheck> {
  const base: SolanaTradeCheck = { mint, stage: null, honeypot: null, buyRoute: null, spent: spent.toString(), bought: null, sold: null, roundTripLoss: null, error: null, flags: [] }
  const swapOptions: SolanaSwapOptions = { protocols: options.protocols, intermediates: options.intermediates, pools: options.pools, discover: options.discover, signal: options.signal }
  let buy: SolanaSwapPlan
  try {
    // 先只找直接兑换（买入、卖出放进一笔交易更容易放得下），没有时再找两跳
    buy = await buildSwap(client, options.owner, { tokenIn: NATIVE_MINT, tokenOut: mint, amountIn: spent }, { ...swapOptions, intermediates: options.intermediates ?? [] }).catch((err: unknown) => {
      if (options.intermediates || options.signal?.aborted) throw err
      return buildSwap(client, options.owner, { tokenIn: NATIVE_MINT, tokenOut: mint, amountIn: spent }, swapOptions)
    })
  } catch (err) {
    if (options.signal?.aborted) throw err
    return { ...base, stage: 'no-pool', error: errorText(err), flags: ['no-pool'] }
  }
  const buyRoute = buy.route.hops.map((h) => ({ protocol: h.protocol, pool: h.pool }))
  let sell: SolanaSwapPlan
  try {
    // 卖出按买入的最少收到算，走买入的同一条路线（反过来），最少换回不设下限（只看能不能卖、卖回多少）
    sell = await buildSwap(
      client,
      options.owner,
      { tokenIn: mint, tokenOut: NATIVE_MINT, amountIn: buy.amountOutMin },
      { protocols: options.protocols, discover: false, pools: buy.route.hops.map((h) => h.pool), intermediates: buy.route.path.slice(1, -1), slippage: 0.999999, signal: options.signal },
    )
  } catch (err) {
    if (options.signal?.aborted) throw err
    // 同一条路线反过来报不了价（如走得超出 Orca 的 3 个 tick 数组）：不能断定卖不出
    return { ...base, buyRoute, error: `Cannot quote the sell: ${errorText(err)}` }
  }
  const tokenProgram = (await client.accounts([mint], { signal: options.signal }))[0]?.owner ?? TOKEN_PROGRAM_ID
  const tokenAccount = getAssociatedTokenAddress(options.owner, mint, tokenProgram)
  const wsol = getAssociatedTokenAddress(options.owner, NATIVE_MINT, TOKEN_PROGRAM_ID)
  const buyIxs = buy.steps.flatMap((s) => s.instructions)
  // 卖出最后不关闭 wSOL 账户：读模拟后的余额就是卖回的 SOL
  const sellIxs = sell.steps.flatMap((s) => s.instructions).filter((ix, i, all) => !(i === all.length - 1 && ix.programId === TOKEN_PROGRAM_ID && ix.data[0] === 9))
  const instructions: Instruction[] = [setComputeUnitLimit(MAX_COMPUTE_UNITS), ...buyIxs, ...sellIxs]
  const message = compileMessage(options.owner, instructions, '11111111111111111111111111111111')
  if (transactionSize(message) > PACKET_DATA_SIZE || message.accountKeys.length > MAX_ACCOUNT_LOCKS) {
    return { ...base, buyRoute, error: 'The buy and sell routes do not fit in one transaction' }
  }
  const [[before, tokenBefore], sim] = await Promise.all([
    client.accounts([wsol, tokenAccount], { signal: options.signal }),
    client.request<{ value: { err: unknown; logs: string[] | null; accounts: Array<{ data: [string, string] } | null> | null } }>(
      'simulateTransaction',
      [
        base64.encode(serializeTransaction(message, message.signers.map(() => null))),
        { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [tokenAccount, wsol] } },
      ],
      { signal: options.signal },
    ),
  ])
  if (sim.value.err) {
    const failed = (sim.value.err as { InstructionError?: [number, unknown] }).InstructionError?.[0]
    const error = transactionErrorText(sim.value.err, sim.value.logs)
    // 第 0 条是计算单元上限；之后是买入的指令
    if (failed === undefined) return { ...base, buyRoute, error }
    if (failed <= buyIxs.length) return { ...base, buyRoute, stage: 'buy-failed', error, flags: ['cannot-buy'] }
    return { ...base, buyRoute, stage: 'sell-failed', honeypot: true, error, flags: ['honeypot'] }
  }
  const amountOf = (a: { data: [string, string] } | null | undefined) => {
    try {
      return a ? parseTokenAccount(base64.decode(a.data[0])).amount : 0n
    } catch {
      return 0n
    }
  }
  const [afterToken, afterWsol] = sim.value.accounts ?? []
  const prior = before ? safeAmount(before.data) : 0n
  // 原来就有 wSOL：买入先用掉已有的 wSOL，不够的部分包装
  const sold = amountOf(afterWsol) - (prior > spent ? prior - spent : 0n)
  // 实际买到的 = 卖出的（买入的最少收到）+ 卖完后代币账户里多出来的
  const bought = BigInt(buy.amountOutMin) + amountOf(afterToken) - (tokenBefore ? safeAmount(tokenBefore.data) : 0n)
  // 只卖出了买入的最少收到（买到的一部分）：按卖出的比例折算花掉的 SOL
  const sellAmount = BigInt(buy.amountOutMin)
  const roundTripLoss = bought > 0n ? Math.max(0, 1 - (Number(sold) * Number(bought)) / (Number(spent) * Number(sellAmount))) : null
  const flags = roundTripLoss !== null && roundTripLoss > 0.1 ? ['high-round-trip-loss'] : []
  return {
    ...base,
    buyRoute,
    stage: 'ok',
    honeypot: false,
    bought: bought.toString(),
    sold: sold.toString(),
    roundTripLoss,
    flags,
  }
}

function safeAmount(data: Uint8Array): bigint {
  try {
    return parseTokenAccount(data).amount
  } catch {
    return 0n
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))
