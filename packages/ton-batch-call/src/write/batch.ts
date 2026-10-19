import type { TonClient } from '../client.js'
import { Cell } from './cell.js'
import type { StateInit } from './message.js'
import { emptyOutcome, resolveWallets, sendJobs, toWriteResult, type SendMessage, type SendOptions, type TxJob, type WalletContext, type WriteResult } from './send.js'
import type { TonSignerInput } from './signer.js'

/** 钱包发出的一条消息 */
export interface CallMessage {
  to: string
  /** 附带的 TON（nanoTON） */
  value: bigint | number | string
  /** 消息体：Cell 或 BOC 的 base64 */
  body?: Cell | string | null
  /** 部署合约时的 StateInit：{ code, data }、StateInit Cell 或它的 BOC base64 */
  init?: StateInit | Cell | string | null
  /** 目标出错时退回，默认 true（发给钱包、尤其是没部署的钱包时用 false） */
  bounce?: boolean
  /** 发送模式，默认 3（手续费另付 + 忽略错误）；128 = 带上剩下的全部余额（必须是最后一条） */
  mode?: number
}

/** 一个调用：一个钱包的一笔交易 */
export interface WriteCall {
  from: TonSignerInput
  messages: readonly CallMessage[]
}

const cellOf = (v: Cell | string) => (typeof v === 'string' ? Cell.fromBase64(v) : v)

/** 编码好的 StateInit 原样使用（带 split_depth / library 等字段时重新编码会改变哈希） */
const stateInitOf = (v: StateInit | Cell | string): StateInit | Cell => (typeof v === 'string' ? Cell.fromBase64(v) : v)

/**
 * 批量执行交易：每个调用是一个钱包的一笔交易（最多 255 / 4 条消息，看钱包版本）。同一钱包的调用依次执行，不同钱包并发。
 *
 * ```ts
 * await batchCall(ton, [
 *   { from: key1, messages: [{ to: pool, value: toNano('0.3'), body: swapBody }] },
 *   { from: key2, messages: [{ to: a, value: 1_000_000n, bounce: false }] },
 * ])
 * ```
 */
export async function batchCall(client: TonClient, calls: readonly WriteCall[], options: SendOptions = {}): Promise<WriteResult[]> {
  const wallets = await resolveWallets(client, calls.map((c) => c.from), options.signal)
  const results = calls.map((_, i) => toWriteResult(i, (wallets[i] as WalletContext).friendly, emptyOutcome('skipped')))
  const jobs: TxJob[] = calls.map((call, i) => {
    const wallet = wallets[i] as WalletContext
    const messages = call.messages.map(
      (m): SendMessage => ({
        message: { to: m.to, value: BigInt(m.value), bounce: m.bounce ?? true, body: m.body ? cellOf(m.body) : null, init: m.init ? stateInitOf(m.init) : null },
        mode: m.mode,
      }),
    )
    return {
      wallet,
      messages,
      onUpdate: (outcome) => {
        results[i] = toWriteResult(i, wallet.friendly, outcome)
        options.onUpdate?.(results[i] as WriteResult)
      },
    }
  })
  await sendJobs(client, jobs, options)
  return results
}
