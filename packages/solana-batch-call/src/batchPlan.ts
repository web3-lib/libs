/**
 * 批量计划的公共部分（/reclaim、/claim 用）：一组“调用”（每个调用的指令原子执行）按交易大小打包、先模拟再发送。
 * 打包规则同 batchCall（相邻的调用放进同一笔交易，不超过 1232 字节和 64 个账户）
 */
import type { SolanaClient } from './client.js'
import { isAddress } from './address.js'
import type { SimulationResult } from './simulate.js'
import type { BatchCallOptions } from './write/batch.js'
import { MAX_COMPUTE_UNITS, setComputeUnitLimit, setComputeUnitPrice } from './write/instructions.js'
import type { WriteResult } from './write/send.js'
import type { SignerInput } from './write/signer.js'
import { MAX_ACCOUNT_LOCKS, PACKET_DATA_SIZE, compileMessage, transactionSize, type Instruction } from './write/transaction.js'

/** 一个调用：要签名的地址（代币账户 / 仓位的 owner）和原子执行的指令 */
export interface PlannedCall {
  owner: string
  instructions: Instruction[]
}

/** 把调用按顺序打包成交易，返回每笔交易包含的调用下标。单个调用放不进一笔交易时自己成一笔（发送时会报“transaction too large”） */
export function packCalls(payer: string, calls: readonly PlannedCall[], batchSize = Number.POSITIVE_INFINITY): number[][] {
  const packs: number[][] = []
  let current: number[] = []
  let instructions: Instruction[] = []
  const fits = (list: readonly Instruction[]) => {
    const probe = compileMessage(payer, [setComputeUnitLimit(MAX_COMPUTE_UNITS), setComputeUnitPrice(1n), ...list], '11111111111111111111111111111111')
    return transactionSize(probe) <= PACKET_DATA_SIZE && probe.accountKeys.length <= MAX_ACCOUNT_LOCKS
  }
  calls.forEach((call, i) => {
    const next = [...instructions, ...call.instructions]
    if (current.length && (current.length >= batchSize || !fits(next))) {
      packs.push(current)
      current = []
      instructions = []
    }
    current.push(i)
    instructions.push(...call.instructions)
  })
  if (current.length) {
    packs.push(current)
  }
  return packs
}

export interface PlanSimulationOptions {
  /** 手续费支付者，默认第一个调用的 owner */
  feePayer?: string
  /** 每笔交易最多几个调用，默认不限（只受交易大小限制） */
  batchSize?: number
  /** 额外要看的地址（如收款地址） */
  watch?: readonly string[]
  signal?: AbortSignal
  /** 算美元价值（/simulate 的 prices） */
  prices?: boolean
  fetch?: typeof fetch
}

export interface PlanSimulation {
  /** 所有交易都模拟通过 */
  success: boolean
  /** 打包后的每笔交易：包含的调用下标和 /simulate 的结果 */
  transactions: Array<{ calls: number[]; simulation: SimulationResult }>
  /** 模拟失败的调用（整笔失败时逐个重新模拟找出来）：下标和原因 */
  failed: Array<{ index: number; error: string }>
  /** 各笔交易手续费之和（lamports，十进制字符串） */
  fee: string
  /** 手续费支付者的 SOL 变化之和（lamports，带符号，不含手续费：/simulate 的 SOL 余额变化已经把手续费加回） */
  payerNativeDelta: string
}

/** 打包后逐笔用 /simulate 模拟（不签名、不发送）；失败的交易逐个调用重新模拟，找出是哪些调用失败 */
export async function simulatePlan(client: SolanaClient, calls: readonly PlannedCall[], options: PlanSimulationOptions = {}): Promise<PlanSimulation> {
  const first = calls[0]
  if (!first) {
    return { success: true, transactions: [], failed: [], fee: '0', payerNativeDelta: '0' }
  }
  const payer = options.feePayer ?? first.owner
  if (!isAddress(payer)) {
    throw new Error(`Invalid fee payer: ${payer}`)
  }
  const { simulate } = await import('./simulate.js')
  const run = (list: readonly PlannedCall[]) =>
    simulate(
      client,
      { feePayer: payer, instructions: list.flatMap((c) => c.instructions) },
      { signers: [...new Set(list.map((c) => c.owner))], watch: options.watch, signal: options.signal, prices: options.prices, fetch: options.fetch },
    )
  const packs = packCalls(payer, calls, options.batchSize)
  const transactions: PlanSimulation['transactions'] = []
  const failed: PlanSimulation['failed'] = []
  for (const pack of packs) {
    const simulation = await run(pack.map((i) => calls[i] as PlannedCall))
    transactions.push({ calls: pack, simulation })
    if (!simulation.success) {
      if (pack.length === 1) {
        failed.push({ index: pack[0] as number, error: simulation.error ?? 'simulation failed' })
        continue
      }
      for (const i of pack) {
        const single = await run([calls[i] as PlannedCall])
        if (!single.success) {
          failed.push({ index: i, error: single.error ?? 'simulation failed' })
        }
      }
    }
  }
  let fee = 0n
  let delta = 0n
  for (const { simulation } of transactions) {
    fee += BigInt(simulation.fee ?? '0')
    for (const change of simulation.balanceChanges) {
      if (change.address === payer && change.asset === 'native') {
        delta += BigInt(change.delta)
      }
    }
  }
  return { success: transactions.every((t) => t.simulation.success), transactions, failed, fee: fee.toString(), payerNativeDelta: delta.toString() }
}

/** 用 from 签名发送：调用的 owner 都必须是签名者本人；一个调用失败不影响后面的（continueOnError），feePayer 可以替 owner 付手续费 */
export async function sendCalls(client: SolanaClient, from: SignerInput, calls: readonly PlannedCall[], options: BatchCallOptions = {}): Promise<WriteResult[]> {
  if (!calls.length) {
    return []
  }
  // 发送的代码按需加载：只查询、模拟时打包不会带上
  const [{ batchCall }, { resolveSigner }] = await Promise.all([import('./write/batch.js'), import('./write/signer.js')])
  const { address } = await resolveSigner(from)
  const other = calls.find((c) => c.owner !== address)
  if (other) {
    throw new Error(`The account belongs to ${other.owner}, not the signer ${address}`)
  }
  return batchCall(
    client,
    calls.map((c) => ({ from, instructions: c.instructions })),
    { continueOnError: true, ...options },
  )
}
