import { parseTonAddress, toFriendlyAddress, toRawAddress } from '../address.js'
import type { TonClient } from '../client.js'
import { NATIVE_TON, TON_DECIMALS } from '../constants.js'
import { formatUnits, parseUnits } from '../format.js'
import type { Cell } from './cell.js'
import { commentCell, jettonTransferBody, type OutMessage } from './message.js'
import { emptyOutcome, messageOutcome, resolveWallets, sendJobs, toWriteResult, type SendMessage, type SendOptions, type TxJob, type TxOutcome, type WalletContext, type WriteResult } from './send.js'
import type { TonSignerInput } from './signer.js'

/** 一个收款项：amount（最小单位）和 formatted（按精度换算，如 '1.5'）二选一 */
export interface TransferItem {
  to: string
  amount?: bigint | number | string
  formatted?: string
  /** NATIVE_TON（'TON'）或 Jetton 主合约地址，默认 options.token（默认 TON） */
  token?: string
  /** 文本备注（交易所充值的 memo 等） */
  comment?: string
}

export interface BatchTransferOptions extends SendOptions {
  /** 默认代币，默认 NATIVE_TON */
  token?: string
  /** 每笔 Jetton 转账附带的 TON（付 Jetton 合约的 gas，多余的退回发送者），默认 0.05 TON */
  jettonGas?: bigint
  /** Jetton 转账给收款人的通知附带的 TON（> 0 时收款人收到 transfer_notification，交易所靠它识别充值），默认 1 nanoTON */
  forwardAmount?: bigint
  /** 发送前检查余额，默认 true */
  checkBalance?: boolean
}

export interface TransferResult extends WriteResult {
  to: string
  token: string
  amount: string
  formatted: string
}

/** 余额检查时预留的手续费：每笔交易 0.01 TON + 每条消息 0.001 TON（转发费） */
export const FEE_RESERVE = 10_000_000n
export const MESSAGE_FEE_RESERVE = 1_000_000n
export const DEFAULT_JETTON_GAS = 50_000_000n

interface Planned {
  index: number
  to: string
  token: string
  amount: bigint
  decimals: number
  comment: string | null
}

/**
 * 一对多转账：多个收款人打包进同一笔交易（v5r1 每笔最多 255 条消息，v4r2 最多 4 条），TON 和 Jetton 可以混在一起。
 *
 * ```ts
 * await batchTransfer(ton, mnemonic, [
 *   { to: a, formatted: '1.5' },                         // 默认 TON
 *   { to: b, token: USDT, formatted: '20', comment: 'order 42' },
 * ])
 * ```
 *
 * - Jetton 转账发给发送者自己的 Jetton 钱包，附带 jettonGas（默认 0.05 TON），多余的退回发送者
 * - 发给没部署的地址时 TON 不可回弹（否则会被退回）；发给合约时可回弹
 * - 发送者的钱包还没部署时，第一笔交易自动部署
 */
export async function batchTransfer(client: TonClient, from: TonSignerInput, recipients: readonly TransferItem[], options: BatchTransferOptions = {}): Promise<TransferResult[]> {
  const [wallet] = await resolveWallets(client, [from], options.signal)
  const w = wallet as WalletContext
  const defaultToken = options.token ?? NATIVE_TON
  const tokenOf = (item: TransferItem) => {
    const t = item.token ?? defaultToken
    return t === NATIVE_TON ? NATIVE_TON : toRawAddress(t)
  }
  const jettons = [...new Set(recipients.map(tokenOf).filter((t) => t !== NATIVE_TON))]
  // 发送者的余额和 Jetton 钱包（一次请求），收款人的部署状态（决定 TON 是否可回弹）
  const [held] = await client.multiBalances([{ owner: w.address, tokens: [NATIVE_TON, ...jettons] }], { signal: options.signal })
  const byToken = new Map((held ?? []).map((b, i) => [i === 0 ? NATIVE_TON : (jettons[i - 1] as string), b]))
  const planned = recipients.map((item, index): Planned => {
    const token = tokenOf(item)
    const info = byToken.get(token)
    if (token !== NATIVE_TON && info && !info.success) throw new Error(`recipients[${index}]: ${toFriendlyAddress(token)} is not a jetton (${info.error})`)
    const decimals = token === NATIVE_TON ? TON_DECIMALS : (info?.decimals ?? TON_DECIMALS)
    if ((item.amount === undefined) === (item.formatted === undefined)) throw new Error(`recipients[${index}]: pass exactly one of amount / formatted`)
    if (item.formatted !== undefined && info?.decimalsUnknown) throw new Error(`recipients[${index}]: the decimals of ${toFriendlyAddress(token)} are not known yet (its metadata is off-chain and not indexed); pass amount instead of formatted`)
    const amount = item.formatted !== undefined ? parseUnits(item.formatted, decimals) : BigInt(item.amount as bigint | number | string)
    if (amount <= 0n) throw new Error(`recipients[${index}]: amount must be greater than 0`)
    const to = parseTonAddress(item.to)
    if (!to) throw new Error(`recipients[${index}]: invalid address ${item.to}`)
    return { index, to: item.to, token, amount, decimals, comment: item.comment ?? null }
  })
  const jettonGas = options.jettonGas ?? DEFAULT_JETTON_GAS
  const forwardAmount = options.forwardAmount ?? 1n
  const txCount = Math.ceil(planned.length / w.maxMessages)
  if (options.checkBalance ?? true) {
    const need = new Map<string, bigint>()
    for (const p of planned) {
      need.set(p.token, (need.get(p.token) ?? 0n) + p.amount)
      if (p.token !== NATIVE_TON) need.set(NATIVE_TON, (need.get(NATIVE_TON) ?? 0n) + jettonGas + forwardAmount)
    }
    need.set(NATIVE_TON, (need.get(NATIVE_TON) ?? 0n) + FEE_RESERVE * BigInt(txCount) + MESSAGE_FEE_RESERVE * BigInt(planned.length))
    for (const [token, total] of need) {
      const have = BigInt(byToken.get(token)?.balance ?? '0')
      if (have < total) throw new Error(`Insufficient balance of ${token === NATIVE_TON ? 'TON' : toFriendlyAddress(token)}: need ${total} (including gas), have ${have}`)
    }
  }

  const tonTargets = [...new Set(planned.filter((p) => p.token === NATIVE_TON).map((p) => toRawAddress(p.to)))]
  const deployed = new Map<string, boolean>()
  if (tonTargets.length) {
    const states = await client.tonBalances(tonTargets, { signal: options.signal })
    tonTargets.forEach((t, i) => deployed.set(t, states[i]?.status === 'active'))
  }
  const messageOf = (p: Planned): SendMessage => {
    const body: Cell | null = p.comment === null ? null : commentCell(p.comment)
    if (p.token === NATIVE_TON) {
      const parsed = parseTonAddress(p.to)
      // 没部署的地址不可回弹；已部署的按地址格式的标志（原始格式按可回弹）
      const bounce = (deployed.get(toRawAddress(p.to)) ?? false) && (parsed?.bounceable ?? true)
      const message: OutMessage = { to: p.to, value: p.amount, bounce, body }
      return { message }
    }
    const jettonWallet = byToken.get(p.token)?.wallet
    if (!jettonWallet) throw new Error(`${w.friendly} has no ${toFriendlyAddress(p.token)} jetton wallet`)
    const transfer = jettonTransferBody({ amount: p.amount, destination: p.to, responseDestination: w.address, forwardTonAmount: forwardAmount, forwardPayload: body })
    return { message: { to: jettonWallet, value: jettonGas + forwardAmount, bounce: true, body: transfer } }
  }

  const results: TransferResult[] = planned.map((p) => toTransferResult(p, w.friendly, emptyOutcome('skipped')))
  const jobs: TxJob[] = []
  for (let i = 0; i < planned.length; i += w.maxMessages) {
    const chunk = planned.slice(i, i + w.maxMessages)
    jobs.push({
      wallet: w,
      messages: chunk.map(messageOf),
      // 同一笔交易里可能有的消息成功、有的失败（TON 不够时后面的消息被跳过、某个 Jetton 转账退回）：逐条给结果
      onUpdate: (outcome) =>
        chunk.forEach((p, k) => {
          results[p.index] = toTransferResult(p, w.friendly, messageOutcome(outcome, k))
          options.onUpdate?.(results[p.index] as TransferResult)
        }),
    })
  }
  await sendJobs(client, jobs, options)
  return results
}

function toTransferResult(p: Planned, from: string, outcome: TxOutcome): TransferResult {
  return {
    ...toWriteResult(p.index, from, outcome),
    to: p.to,
    token: p.token === NATIVE_TON ? NATIVE_TON : toFriendlyAddress(p.token),
    amount: p.amount.toString(),
    formatted: formatUnits(p.amount, p.decimals),
  }
}
