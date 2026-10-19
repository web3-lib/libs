import { SUI_COIN_TYPE, normalizeStructTag, normalizeSuiAddress } from '../address.js'
import type { SuiClient } from '../client.js'
import { SUI_DECIMALS } from '../constants.js'
import { formatUnits, parseUnits } from '../format.js'
import { getBalance } from '../services.js'
import { pure, type Argument } from './bcs.js'
import { PtbBuilder } from './ptb.js'
import { emptyOutcome, sendJobs, toWriteResult, type BuildContext, type SendOptions, type TxJob, type TxOutcome, type WriteResult } from './send.js'
import { resolveSigner, type SignerInput } from './signer.js'

/** 一个收款项：amount（最小单位）和 formatted（按精度换算，如 '1.5'）二选一 */
export interface TransferItem {
  to: string
  amount?: bigint | number | string
  formatted?: string
  /** 代币类型，默认 options.token（默认 SUI） */
  token?: string
}

export interface BatchTransferOptions extends SendOptions {
  /** 默认代币类型，默认 SUI */
  token?: string
  /** 付 gas 的钱包（赞助交易）：发送者不需要 SUI */
  sponsor?: SignerInput
  /** 每笔交易最多几个收款项，默认 200，最多 500（一条命令最多 512 个参数） */
  batchSize?: number
  /** 发送前检查余额，默认 true */
  checkBalance?: boolean
}

export interface TransferResult extends WriteResult {
  to: string
  token: string
  amount: string
  formatted: string | null
}

/** 一笔交易里最多用几个 Coin 对象（交易最多 2048 个输入对象、128 KB；另外还有最多 255 个 gas 币） */
export const MAX_MERGE_COINS = 1000

/** 每笔交易最多几个收款项：SplitCoins / TransferObjects 一条命令最多 512 个参数 */
const MAX_BATCH_SIZE = 500

/** 判断 gas 币够不够拆时，至少要多出这么多留给 gas（0.001 SUI，实际够不够由模拟决定） */
const GAS_MARGIN = 1_000_000n

interface Planned {
  index: number
  to: string
  token: string
  amount: bigint
  decimals: number | null
}

/**
 * 一对多转账：多个收款人打包进同一笔可编程交易（每笔最多 batchSize 个），SUI 和各种代币可以混在一起。
 *
 * ```ts
 * await batchTransfer(sui, privateKey, [
 *   { to: a, formatted: '1.5' },                   // 默认 SUI
 *   { to: b, token: USDC, formatted: '20' },
 * ])
 * ```
 *
 * - SUI 从 gas 币里拆出（赞助交易时从发送者的 SUI Coin 里拆）；代币先合并发送者的 Coin 再拆分
 * - Coin 对象不够时用地址余额（Address Balances）补：`coin::redeem_funds` 取出后一起拆分
 * - 收款人收到的是 Coin 对象
 */
export async function batchTransfer(client: SuiClient, from: SignerInput, recipients: readonly TransferItem[], options: BatchTransferOptions = {}): Promise<TransferResult[]> {
  const cache = new Map()
  const sender = await resolveSigner(from, cache)
  const sponsor = options.sponsor === undefined ? undefined : await resolveSigner(options.sponsor, cache)
  const planned = await plan(client, recipients, options)
  if (options.checkBalance ?? true) await checkBalances(client, sender.address, planned)

  const results: TransferResult[] = planned.map((p) => toTransferResult(p, sender.address, emptyOutcome('skipped')))
  const size = Math.min(MAX_BATCH_SIZE, Math.max(1, options.batchSize ?? 200))
  const chunks: Planned[][] = []
  for (let i = 0; i < planned.length; i += size) chunks.push(planned.slice(i, i + size))
  const jobs: TxJob[] = chunks.map((chunk) => ({
    sender,
    sponsor,
    build: (ctx) => buildTransfers(ctx, sender.address, chunk, !!sponsor && sponsor.address !== sender.address),
    onUpdate: (outcome) =>
      chunk.forEach((p) => {
        results[p.index] = toTransferResult(p, sender.address, outcome)
        options.onUpdate?.(results[p.index] as TransferResult)
      }),
  }))
  await sendJobs(client, jobs, options)
  return results
}

function toTransferResult(p: Planned, from: string, outcome: TxOutcome): TransferResult {
  return { ...toWriteResult(p.index, from, outcome), to: p.to, token: p.token, amount: p.amount.toString(), formatted: p.decimals === null ? null : formatUnits(p.amount, p.decimals) }
}

/** 解析数量（formatted 按精度换算） */
async function plan(client: SuiClient, recipients: readonly TransferItem[], options: BatchTransferOptions): Promise<Planned[]> {
  const token = (item: TransferItem) => normalizeStructTag(item.token ?? options.token ?? SUI_COIN_TYPE)
  const types = [...new Set(recipients.map(token))].filter((t) => t !== SUI_COIN_TYPE)
  const coins = await client.coins(types, { signal: options.signal })
  const decimalsOf = new Map<string, number | null>([[SUI_COIN_TYPE, SUI_DECIMALS], ...coins.map((c): [string, number | null] => [c.token, c.decimals])])
  return recipients.map((item, index) => {
    const t = token(item)
    const decimals = decimalsOf.get(t) ?? null
    if ((item.amount === undefined) === (item.formatted === undefined)) throw new Error(`recipients[${index}]: pass exactly one of amount / formatted`)
    let amount: bigint
    if (item.formatted !== undefined) {
      if (decimals === null) throw new Error(`recipients[${index}]: cannot read the decimals of ${t}; pass amount instead of formatted`)
      amount = parseUnits(item.formatted, decimals)
    } else {
      amount = BigInt(item.amount as bigint | number | string)
    }
    if (amount <= 0n) throw new Error(`recipients[${index}]: amount must be greater than 0`)
    return { index, to: normalizeSuiAddress(item.to), token: t, amount, decimals }
  })
}

async function checkBalances(client: SuiClient, owner: string, planned: readonly Planned[]): Promise<void> {
  const totals = new Map<string, bigint>()
  for (const p of planned) totals.set(p.token, (totals.get(p.token) ?? 0n) + p.amount)
  await Promise.all(
    [...totals].map(async ([token, total]) => {
      const { balance } = await getBalance(client.transport, owner, token)
      if (balance.balance < total) throw new Error(`Insufficient balance of ${token}: need ${total}, have ${balance.balance}`)
    }),
  )
}

/**
 * 发送者的 coinType 凑出 total：选余额最大的 Coin（合并，最多 maxCoins 个），不够时从地址余额取差额。
 * 返回合并后的那一个 Coin（可以再拆分）和用了几个 Coin 对象；temporary 为 true 时它是交易里新建的（全部来自地址余额），
 * 拆完后要用 `0x2::coin::destroy_zero` 销毁（Coin 不能丢弃）
 */
export async function gatherCoin(
  ptb: PtbBuilder,
  ctx: BuildContext,
  owner: string,
  coinType: string,
  total: bigint,
  maxCoins = MAX_MERGE_COINS,
): Promise<{ coin: Argument; temporary: boolean; used: number }> {
  const coins = await ctx.coins(owner, coinType, total)
  const picked: typeof coins = []
  let sum = 0n
  for (const c of coins) {
    if (sum >= total || picked.length >= maxCoins) break
    picked.push(c)
    sum += c.balance
  }
  const temporary = picked.length === 0
  let primary: Argument | null = temporary ? null : ptb.owned(picked[0] as (typeof coins)[number])
  // 合并其余的（每条 MergeCoins 最多 500 个来源）
  const rest = picked.slice(1).map((c) => ptb.owned(c))
  for (let i = 0; i < rest.length; i += 500) {
    ptb.command({ kind: 'mergeCoins', destination: primary as Argument, sources: rest.slice(i, i + 500) })
  }
  if (sum < total) {
    // Coin 对象不够：从地址余额取差额。Coin 太多、只能用一部分时差额可能比地址余额大：直接报错（交易一定失败）
    const addressBalance = await ctx.addressBalance(owner, coinType)
    if (addressBalance < total - sum) {
      throw new Error(
        `Cannot gather ${total} of ${coinType} in one transaction: the ${picked.length} largest coins (at most ${maxCoins} per transaction) hold ${sum} and the address balance ${addressBalance}. Send less per transaction (batchSize), or merge the coins first (e.g. batchCollect to yourself)`,
      )
    }
    const redeemed = ptb.moveCall('0x2::coin::redeem_funds', [coinType], [ptb.withdrawal(total - sum, coinType)])
    if (primary) ptb.command({ kind: 'mergeCoins', destination: primary, sources: [redeemed] })
    else primary = redeemed
  }
  if (!primary) throw new Error(`No ${coinType} to send`)
  return { coin: primary, temporary, used: picked.length }
}

async function buildTransfers(ctx: BuildContext, owner: string, chunk: readonly Planned[], sponsored: boolean) {
  const ptb = new PtbBuilder()
  let gasSpend = 0n
  // 一笔交易里所有代币合计最多用 MAX_MERGE_COINS 个 Coin 对象
  let used = 0
  const byToken = new Map<string, Planned[]>()
  for (const p of chunk) byToken.set(p.token, [...(byToken.get(p.token) ?? []), p])
  for (const [token, items] of byToken) {
    const total = items.reduce((s, p) => s + p.amount, 0n)
    // SUI：发送者自己付 gas、SUI Coin 足够（多出一点留给 gas）时直接从 gas 币拆；
    // 赞助交易里 gas 币是付款钱包的，Coin 不够（SUI 在地址余额里）时也不能从 gas 币拆：按代币的方式凑（Coin + 地址余额）
    let fromGas = false
    if (token === SUI_COIN_TYPE && !sponsored) {
      const coinTotal = (await ctx.coins(owner, SUI_COIN_TYPE, total + GAS_MARGIN)).slice(0, 255).reduce((sum, c) => sum + c.balance, 0n)
      fromGas = coinTotal >= total + GAS_MARGIN
    }
    if (fromGas) gasSpend += total
    const source = fromGas ? { coin: ptb.gas, temporary: false, used: 0 } : await gatherCoin(ptb, ctx, owner, token, total, Math.max(0, MAX_MERGE_COINS - used))
    used += source.used
    const split = ptb.command({ kind: 'splitCoins', coin: source.coin, amounts: items.map((p) => ptb.pure(pure.u64(p.amount))) })
    // 从地址余额取出的正好是 total，拆完剩 0
    if (source.temporary) ptb.moveCall('0x2::coin::destroy_zero', [token], [source.coin])
    // 同一个收款人收到的多个币一次转
    const byRecipient = new Map<string, Argument[]>()
    items.forEach((p, i) => byRecipient.set(p.to, [...(byRecipient.get(p.to) ?? []), ptb.nested(split, i)]))
    for (const [to, objects] of byRecipient) ptb.command({ kind: 'transferObjects', objects, address: ptb.pure(pure.address(to)) })
  }
  return { kind: ptb.build(), gasSpend }
}
