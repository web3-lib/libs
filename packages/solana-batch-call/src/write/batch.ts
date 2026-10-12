import type { SolanaClient } from '../client.js'
import { emptyOutcome, sendUnits, toWriteResult, type SendOptions, type Unit, type WriteResult } from './send.js'
import { resolveSigner, type SignerInput } from './signer.js'
import { COMPUTE_BUDGET_PROGRAM_ID } from './instructions.js'
import { normalizeInstruction, type InstructionInput } from './transaction.js'

/** 一个写调用：一组要原子执行的指令 */
export interface WriteCall {
  /** 发送的钱包（指令里的签名者之一）；不传 feePayer 时也由它付手续费 */
  from: SignerInput
  /** 指令：@solana/web3.js 的 TransactionInstruction、@solana/kit 的 Instruction 或本库格式，一个或多个 */
  instructions: InstructionInput | readonly InstructionInput[]
  /** 指令需要的其他签名者（如新建账户的 Keypair） */
  signers?: readonly SignerInput[]
}

/**
 * - 'pack'（默认）：同一手续费支付者的相邻调用打包进同一笔交易（不超过 1232 字节、64 个账户），
 *   模拟时失败的调用会被剔除、其余照常发送；同一笔交易上链后才失败时一起回滚
 * - 'tx'：每个调用一笔交易
 */
export type BatchCallMode = 'pack' | 'tx'

export interface BatchCallOptions extends SendOptions {
  mode?: BatchCallMode
  /** 'pack' 时每笔交易最多几个调用，默认不限（只受交易大小限制） */
  batchSize?: number
  /**
   * 某个调用发送前失败（模拟失败等）后，同一支付者后面的调用是否继续。默认 false（后面的标记为 skipped）。
   * 交易不等上一笔确认就连续发出，已经发出、之后上链失败的交易拦不住后面已发出的交易
   */
  continueOnError?: boolean
}

/**
 * 批量调用程序（写操作）。结果与 calls 一一对应。
 *
 * ```ts
 * await batchCall(client, [
 *   { from: key1, instructions: [ix1, ix2] },   // 同一个调用里的指令原子执行
 *   { from: key2, instructions: ix3 },
 * ], { feePayer: gasKey })                       // 手续费都由 gasKey 付，不同钱包的调用也能打包进同一笔交易
 * ```
 */
export async function batchCall(client: SolanaClient, calls: readonly WriteCall[], options: BatchCallOptions = {}): Promise<WriteResult[]> {
  const cache = new Map()
  const feePayer = options.feePayer === undefined ? undefined : await resolveSigner(options.feePayer, cache)
  const prepared = await Promise.all(
    calls.map(async (call, i) => {
      const from = await resolveSigner(call.from, cache)
      const signers = [from, ...(await Promise.all((call.signers ?? []).map((s) => resolveSigner(s, cache))))]
      const list = Array.isArray(call.instructions) ? (call.instructions as readonly InstructionInput[]) : [call.instructions as InstructionInput]
      // 库会自动加计算单元上限和优先费用指令；调用里自带的同类指令去掉（重复会让整笔交易失败），优先费用用 priorityFee 选项
      const instructions = list.map(normalizeInstruction).filter((ix) => !(ix.programId === COMPUTE_BUDGET_PROGRAM_ID && (ix.data[0] === 2 || ix.data[0] === 3)))
      const payer = feePayer ?? from
      const known = new Set([payer.address, ...signers.map((s) => s.address)])
      const missing = instructions.flatMap((ix) => ix.keys).find((k) => k.isSigner && !known.has(k.pubkey))
      if (missing) {
        throw new Error(`calls[${i}]: an instruction requires the signature of ${missing.pubkey}; pass it in signers`)
      }
      return { from, signers, instructions, payer }
    }),
  )
  const results = prepared.map((p, i) => toWriteResult(i, p.from.address, emptyOutcome('skipped')))
  const units: Unit[] = prepared.map((p, i) => ({
    instructions: p.instructions,
    payer: p.payer,
    signers: p.signers.filter((s) => s.address !== p.payer.address),
    continueOnError: options.continueOnError,
    onUpdate: (outcome) => {
      results[i] = toWriteResult(i, p.from.address, outcome)
      options.onUpdate?.(results[i] as WriteResult)
    },
  }))
  await sendUnits(client, units, options, { batchSize: (options.mode ?? 'pack') === 'tx' ? 1 : options.batchSize })
  return results
}

