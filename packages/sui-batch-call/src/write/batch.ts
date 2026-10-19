import { base64 } from '@scure/base'

import type { SuiClient } from '../client.js'
import type { ProgrammableTransaction } from './bcs.js'
import { emptyOutcome, sendJobs, toWriteResult, type SendOptions, type TxJob, type WriteResult } from './send.js'
import { resolveSigner, type SignerInput } from './signer.js'

/** 一个写调用：一笔交易的内容 */
export interface WriteCall {
  /** 发送者 */
  from: SignerInput
  /**
   * 交易内容（TransactionKind）：
   * - @mysten/sui 构建的：`await tx.build({ client, onlyTransactionKind: true })` 的字节或其 base64
   * - 本库的 ProgrammableTransaction（write/bcs 里的结构）
   */
  kind: Uint8Array | string | ProgrammableTransaction
  /** 付 gas 的钱包（赞助交易） */
  sponsor?: SignerInput
}

export interface BatchCallOptions extends SendOptions {
  /** 某笔失败后，同一付款钱包后面的交易是否继续，默认 false */
  continueOnError?: boolean
}

/**
 * 批量执行交易：本库补上 gas（选 gas 币、模拟估算上限）、签名、执行。同一付款钱包的交易依次执行，不同钱包并发。
 *
 * ```ts
 * const tx = new Transaction()                         // @mysten/sui
 * tx.moveCall({ target: '0x…::pool::swap', arguments: [...] })
 * const kind = await tx.build({ client, onlyTransactionKind: true })
 * await batchCall(sui, [{ from: key1, kind }, { from: key2, kind: kind2, sponsor: gasKey }])
 * ```
 */
export async function batchCall(client: SuiClient, calls: readonly WriteCall[], options: BatchCallOptions = {}): Promise<WriteResult[]> {
  const cache = new Map()
  const prepared = await Promise.all(
    calls.map(async (c) => ({
      sender: await resolveSigner(c.from, cache),
      sponsor: c.sponsor === undefined ? undefined : await resolveSigner(c.sponsor, cache),
      kind: typeof c.kind === 'string' ? base64.decode(c.kind) : c.kind,
    })),
  )
  const results = prepared.map((p, i) => toWriteResult(i, p.sender.address, emptyOutcome('skipped')))
  const jobs: TxJob[] = prepared.map((p, i) => ({
    sender: p.sender,
    sponsor: p.sponsor,
    continueOnError: options.continueOnError,
    build: async () => p.kind,
    onUpdate: (outcome) => {
      results[i] = toWriteResult(i, p.sender.address, outcome)
      options.onUpdate?.(results[i] as WriteResult)
    },
  }))
  await sendJobs(client, jobs, options)
  return results
}
