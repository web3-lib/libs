import type { SolanaClient } from '../client.js'
import { getAssociatedTokenAddress } from '../address.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '../constants.js'
import { parseTokenAccount } from '../layout.js'
import type { SolanaLpPosition, SolanaLpProtocol } from '../lp.js'
import { batchCall } from '../write/batch.js'
import { MAX_COMPUTE_UNITS, setComputeUnitLimit, setComputeUnitPrice } from '../write/instructions.js'
import type { WriteResult } from '../write/send.js'
import { PACKET_DATA_SIZE, compileMessage, transactionSize } from '../write/transaction.js'
import { resolveSigner, type SignerInput } from '../write/signer.js'
import { ammAdd, ammRemove } from './amm.js'
import { createCtx } from './common.js'
import { orcaAdd, orcaRemove } from './orca.js'
import { raydiumAdd, raydiumRemove } from './raydiumClmm.js'
import type {
  SolanaAddLiquidityParams,
  SolanaCollectFeesParams,
  SolanaLiquidityOptions,
  SolanaLiquidityPlan,
  SolanaLiquidityResult,
  SolanaLiquiditySendOptions,
  SolanaLiquidityStep,
  SolanaLiquidityStepResult,
  SolanaPositionRef,
  SolanaRemoveLiquidityParams,
} from './types.js'

function protocolOf(params: SolanaAddLiquidityParams | { position: SolanaPositionRef | SolanaLpPosition }): SolanaLpProtocol {
  const protocol = 'position' in params ? params.position.protocol : params.protocol
  if (protocol !== 'raydium-clmm' && protocol !== 'orca-whirlpool' && protocol !== 'raydium-amm' && protocol !== 'raydium-cpmm') {
    throw new Error(`Unknown LP protocol: ${String(protocol)}`)
  }
  return protocol
}

/**
 * 添加流动性的计划（不签名、不发送）：新建仓位（集中流动性的新 NFT / AMM 的 LP 代币），或往已有仓位追加。
 * 返回预计的数量和按顺序执行的指令；只做读取，也可以当作报价
 *
 * ```ts
 * // Raydium CLMM：价格区间按 token1 / token0（池子的方向），给一边的数量
 * const plan = await buildAddLiquidity(client, owner, { protocol: 'raydium-clmm', pool, priceLower: 120, priceUpper: 180, amount0Formatted: '1' })
 * plan.amount1Formatted   // 需要的另一种代币
 * plan.steps              // [{ kind: 'setup', instructions }, { kind: 'add', instructions }]；plan.signers 是新仓位 NFT 的临时密钥
 * ```
 */
export async function buildAddLiquidity(client: SolanaClient, owner: string, params: SolanaAddLiquidityParams, options: SolanaLiquidityOptions = {}): Promise<SolanaLiquidityPlan> {
  const ctx = createCtx(client, owner, options)
  const protocol = protocolOf(params)
  if (protocol === 'raydium-clmm') return raydiumAdd(ctx, params)
  if (protocol === 'orca-whirlpool') return orcaAdd(ctx, params)
  return ammAdd(ctx, protocol, params)
}

/** 移除流动性的计划（不签名、不发送）：按比例或指定数量移除；集中流动性同时领取手续费和挖矿奖励 */
export async function buildRemoveLiquidity(client: SolanaClient, owner: string, params: SolanaRemoveLiquidityParams, options: SolanaLiquidityOptions = {}): Promise<SolanaLiquidityPlan> {
  const ctx = createCtx(client, owner, options)
  const protocol = protocolOf(params)
  if (protocol === 'raydium-clmm') return raydiumRemove(ctx, params)
  if (protocol === 'orca-whirlpool') return orcaRemove(ctx, params)
  return ammRemove(ctx, protocol, params)
}

/** 只领取集中流动性仓位的手续费和挖矿奖励（不动流动性）的计划 */
export async function buildCollectFees(client: SolanaClient, owner: string, params: SolanaCollectFeesParams, options: SolanaLiquidityOptions = {}): Promise<SolanaLiquidityPlan> {
  const ctx = createCtx(client, owner, options)
  const protocol = protocolOf(params)
  if (protocol === 'raydium-clmm') return raydiumRemove(ctx, { position: params.position }, true)
  if (protocol === 'orca-whirlpool') return orcaRemove(ctx, { position: params.position }, true)
  throw new Error('Raydium AMM v4 / CPMM have no separate fees: they are part of the LP tokens, remove liquidity to get them')
}

/**
 * 添加流动性：构建计划后用 from 签名发送（钱包同 /write 的 batchCall：私钥、Keypair、Wallet Standard 钱包等）。
 * 准备工作（创建代币账户、初始化 tick 数组、包装 SOL）和主指令能放进同一笔交易时合并成一笔
 *
 * ```ts
 * const { status, plan } = await addLiquidity(client, secretKey, { protocol: 'orca-whirlpool', pool, fullRange: true, amount0Formatted: '0.5' })
 * plan.positionMint   // 新仓位的 NFT
 * ```
 */
export async function addLiquidity(client: SolanaClient, from: SignerInput, params: SolanaAddLiquidityParams, options: SolanaLiquiditySendOptions = {}): Promise<SolanaLiquidityResult> {
  const plan = await buildAddLiquidity(client, (await resolveSigner(from)).address, params, options)
  if (options.checkBalance ?? true) {
    await checkBalance(client, plan, options.signal)
  }
  return execute(client, from, plan, options)
}

/** 移除流动性：构建计划后用 from 签名发送 */
export async function removeLiquidity(client: SolanaClient, from: SignerInput, params: SolanaRemoveLiquidityParams, options: SolanaLiquiditySendOptions = {}): Promise<SolanaLiquidityResult> {
  const plan = await buildRemoveLiquidity(client, (await resolveSigner(from)).address, params, options)
  return execute(client, from, plan, options)
}

/** 领取集中流动性仓位的手续费和挖矿奖励 */
export async function collectFees(client: SolanaClient, from: SignerInput, params: SolanaCollectFeesParams, options: SolanaLiquiditySendOptions = {}): Promise<SolanaLiquidityResult> {
  const plan = await buildCollectFees(client, (await resolveSigner(from)).address, params, options)
  return execute(client, from, plan, options)
}

/** 添加前检查余额：代币按预计数量；SOL 那一边按上限减去已有的 wSOL（只包装差额），不含手续费和租金 */
async function checkBalance(client: SolanaClient, plan: SolanaLiquidityPlan, signal: AbortSignal | undefined): Promise<void> {
  const needs: Array<{ mint: string; amount: bigint; native: boolean }> = []
  for (const [token, amount, max, native] of [
    [plan.token0, plan.amount0, plan.amount0Max, plan.native === 'token0'],
    [plan.token1, plan.amount1, plan.amount1Max, plan.native === 'token1'],
  ] as const) {
    const need = native ? BigInt(max ?? amount) : BigInt(amount)
    if (need > 0n) {
      needs.push({ mint: token.mint, amount: need, native })
    }
  }
  if (!needs.length) {
    return
  }
  const wsol = getAssociatedTokenAddress(plan.owner, NATIVE_MINT, TOKEN_PROGRAM_ID)
  const [balances, [wsolAccount]] = await Promise.all([
    // NATIVE_MINT 在 balances 里读的是原生 SOL（lamports）
    client.balances(plan.owner, needs.map((n) => n.mint), { signal }),
    needs.some((n) => n.mint === NATIVE_MINT) ? client.accounts([wsol], { signal }) : Promise.resolve([null]),
  ])
  needs.forEach((n, i) => {
    const b = balances[i]
    if (!b?.success) {
      return // 读不到的不拦（模拟时也会失败）
    }
    let have = BigInt(b.balance)
    if (n.mint === NATIVE_MINT && !n.native) {
      // 不包装 SOL 时用的是 wSOL 账户里的代币余额（balances 对 NATIVE_MINT 读的是原生 SOL）
      have = 0n
    }
    if (n.mint === NATIVE_MINT && wsolAccount) {
      try {
        have += parseTokenAccount(wsolAccount.data).amount
      } catch {
        // 不是代币账户：只算原生 SOL
      }
    }
    if (have < n.amount) {
      throw new Error(`Insufficient balance of ${n.native ? 'SOL' : n.mint}: need ${n.amount}, have ${have}`)
    }
  })
}

async function execute(client: SolanaClient, from: SignerInput, plan: SolanaLiquidityPlan, options: SolanaLiquiditySendOptions): Promise<SolanaLiquidityResult> {
  const { steps } = plan
  const nftSigners = plan.signers.map((s) => s.secretKey)
  // 准备工作和主指令能放进同一笔交易时作为一个调用发送（原子执行：主指令模拟失败时准备工作也不发）；
  // 放不下时分开发送（准备工作只有创建代币账户、初始化 tick 数组，SOL 的包装和解包都在主指令那一步）
  const payer = (await resolveSigner(options.feePayer ?? from)).address
  const all = steps.flatMap((s) => s.instructions)
  const probe = compileMessage(payer, [setComputeUnitLimit(MAX_COMPUTE_UNITS), setComputeUnitPrice(1n), ...all], '11111111111111111111111111111111')
  const merged = steps.length > 1 && transactionSize(probe) <= PACKET_DATA_SIZE
  const groups: number[][] = merged ? [steps.map((_, i) => i)] : steps.map((_, i) => [i])
  const main = steps.length - 1
  const kindOf = (i: number) => (steps[i] as SolanaLiquidityStep).kind
  const raw = await batchCall(
    client,
    groups.map((group) => ({
      from,
      instructions: group.flatMap((i) => (steps[i] as SolanaLiquidityStep).instructions),
      // 新仓位 NFT 的 mint 要在主指令所在的交易里签名
      signers: group.includes(main) ? nftSigners : [],
    })),
    {
      ...options,
      mode: 'pack',
      // 准备工作失败时不发主指令
      continueOnError: false,
      onUpdate: options.onUpdate ? (r) => (groups[r.index] as number[]).forEach((i) => options.onUpdate?.({ ...r, index: i, kind: kindOf(i) })) : undefined,
    },
  )
  const results = groups.flatMap((group, g) => group.map((i): SolanaLiquidityStepResult => ({ ...(raw[g] as WriteResult), index: i, kind: kindOf(i) })))
  const last = results[main] as SolanaLiquidityStepResult
  return { plan, results, status: last.status, signature: last.signature }
}
