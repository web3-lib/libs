import { getAssociatedTokenAddress, isAddress } from '../address.js'
import type { SolanaClient } from '../client.js'
import { NATIVE_MINT } from '../constants.js'
import { formatUnits, parseUnits } from '../layout.js'
import { createAssociatedTokenAccountIdempotent, systemTransfer, transferChecked } from './instructions.js'
import { emptyOutcome, sendUnits, toWriteResult, type SendOptions, type TxOutcome, type Unit, type WriteResult } from './send.js'
import { resolveSigner, type ResolvedSigner, type SignerInput } from './signer.js'
import type { Instruction } from './transaction.js'

/** 一个收款项：amount（最小单位）和 formatted（按精度换算后，如 '1.5'）二选一 */
export interface TransferItem {
  /** 收款钱包地址（代币转到它的关联代币账户 ATA，没有时自动创建） */
  to: string
  /** 数量，最小单位（lamports / 代币最小单位），bigint 或十进制字符串 */
  amount?: bigint | number | string
  /** 按精度换算后的数量，如 '1.5'；小数位超过精度时报错（不四舍五入） */
  formatted?: string
  /** 这一项转的代币 mint，默认 options.token */
  token?: string
}

/**
 * - 'pack'（默认）：同一笔交易里打包多个收款人（Solana 原生支持一笔交易多条转账指令，不需要 Disperse 这样的合约），
 *   按交易大小上限自动分笔；模拟失败的收款项（如收款账户被冻结）单独标记失败，其余照常发送
 * - 'tx'：每个收款人一笔交易
 */
export type TransferMode = 'pack' | 'tx'

export interface BatchTransferOptions extends SendOptions {
  /** 默认转的代币 mint，默认原生 SOL（NATIVE_MINT）；每项也可以单独指定 token */
  token?: string
  mode?: TransferMode
  /** 'pack' 时每笔交易最多几个收款人，默认不限（按交易大小，SOL 约 20 个一笔，代币约 10 个） */
  batchSize?: number
  /** 发送前检查余额够不够（按代币汇总），不够时抛错、什么都不发。默认 true（SOL 不含手续费和新建账户的租金） */
  checkBalance?: boolean
  /** 收款人没有该代币的 ATA 时自动创建（租金约 0.00204 SOL，由手续费支付者付）。默认 true；false 时这些收款项失败 */
  createAccounts?: boolean
}

/** 单个收款项的结果 */
export interface TransferResult extends WriteResult {
  /** 收款钱包 */
  to: string
  token: string
  native: boolean
  /** 数量（最小单位） */
  amount: string
  /** 按精度换算后的数量；精度查不到时为 null */
  formatted: string | null
  /** 是否为收款人新建了代币账户（这一项额外付了租金） */
  createdAccount: boolean
}

/** 解析后的收款项 */
interface Planned {
  index: number
  to: string
  token: string
  native: boolean
  amount: bigint
  decimals: number | null
  tokenProgram: string | null
}

/**
 * 一对多批量转账（SOL / SPL Token / Token-2022，可混合）。结果与 recipients 一一对应。
 *
 * ```ts
 * await batchTransfer(client, privateKey, [
 *   { to: a, formatted: '0.5' },                 // 默认代币（options.token，默认 SOL）
 *   { to: b, token: USDC, formatted: '20' },     // 代币：收款人没有 ATA 时自动创建
 * ])
 * ```
 */
export async function batchTransfer(client: SolanaClient, from: SignerInput, recipients: readonly TransferItem[], options: BatchTransferOptions = {}): Promise<TransferResult[]> {
  const cache = new Map()
  const signer = await resolveSigner(from, cache)
  const payer = options.feePayer === undefined ? signer : await resolveSigner(options.feePayer, cache)
  const planned = await plan(client, signer.address, recipients, options)

  // 收款人的 ATA 是否存在：一次 getMultipleAccounts
  const atas = planned.map((p) => (p.native ? null : getAssociatedTokenAddress(p.to, p.token, p.tokenProgram as string)))
  const needed = [...new Set(atas.filter((a): a is string => a !== null))]
  const existing = new Set<string>()
  if (needed.length) {
    const accounts = await client.accounts(needed, { signal: options.signal })
    needed.forEach((a, i) => accounts[i] && existing.add(a))
  }

  const results = planned.map((p) => toTransferResult(p, toWriteResult(p.index, signer.address, emptyOutcome('skipped')), false))
  const units: Unit[] = []
  /** 已经安排创建的 ATA：同一个收款人同一种代币有多项时只在第一项创建（后面的项在同一组里按顺序发送，模拟失败时会等前面的确认） */
  const creating = new Set<string>()
  planned.forEach((p, i) => {
    const ata = atas[i] ?? null
    const create = ata !== null && !existing.has(ata) && !creating.has(ata)
    if (create) creating.add(ata)
    if (create && options.createAccounts === false) {
      results[i] = toTransferResult(p, toWriteResult(p.index, signer.address, emptyOutcome('failed', 'recipient has no token account (createAccounts is false)')), false)
      return
    }
    units.push({
      instructions: transferInstructions(signer, payer, p, ata, create),
      payer,
      signers: payer.address === signer.address ? [] : [signer],
      continueOnError: true,
      onUpdate: (outcome: TxOutcome) => {
        results[i] = toTransferResult(p, toWriteResult(p.index, signer.address, outcome), create && outcome.status === 'confirmed')
        options.onUpdate?.(results[i] as TransferResult)
      },
    })
  })
  await sendUnits(client, units, options, { batchSize: (options.mode ?? 'pack') === 'tx' ? 1 : options.batchSize })
  return results
}

/** 转账指令：SOL 直接转；代币按需先创建收款人的 ATA，再 TransferChecked */
export function transferInstructions(signer: ResolvedSigner, payer: ResolvedSigner, p: Pick<Planned, 'to' | 'token' | 'native' | 'amount' | 'decimals' | 'tokenProgram'>, ata: string | null, create: boolean): Instruction[] {
  if (p.native) {
    return [systemTransfer(signer.address, p.to, p.amount)]
  }
  const program = p.tokenProgram as string
  const source = getAssociatedTokenAddress(signer.address, p.token, program)
  const destination = ata ?? getAssociatedTokenAddress(p.to, p.token, program)
  return [
    ...(create ? [createAssociatedTokenAccountIdempotent(payer.address, destination, p.to, p.token, program)] : []),
    transferChecked(source, p.token, destination, signer.address, p.amount, p.decimals as number, program),
  ]
}

/** 解析数量（formatted 按精度换算）、代币程序，并检查余额 */
async function plan(client: SolanaClient, owner: string, recipients: readonly TransferItem[], options: BatchTransferOptions): Promise<Planned[]> {
  const defaultToken = options.token ?? NATIVE_MINT
  const tokens = [...new Set(recipients.map((r) => r.token ?? defaultToken))]
  const balances = tokens.length ? await client.balances(owner, tokens, { signal: options.signal }) : []
  const info = new Map(balances.map((b, i) => [tokens[i] as string, b]))
  const planned = recipients.map((item, index): Planned => {
    const token = item.token ?? defaultToken
    const balance = info.get(token)
    if (!isAddress(item.to)) {
      throw new Error(`recipients[${index}]: invalid address ${item.to}`)
    }
    if ((item.amount === undefined) === (item.formatted === undefined)) {
      throw new Error(`recipients[${index}]: pass exactly one of amount / formatted`)
    }
    const native = client.isNativeMint(token)
    if (!native && (!balance?.success || !balance.tokenProgram)) {
      throw new Error(`recipients[${index}]: cannot read token ${token} (${balance?.error ?? 'unknown error'})`)
    }
    const decimals = balance?.success ? balance.decimals : null
    let amount: bigint
    if (item.formatted !== undefined) {
      if (decimals === null) {
        throw new Error(`recipients[${index}]: cannot read decimals of ${token}, pass amount instead of formatted`)
      }
      amount = parseUnits(item.formatted, decimals)
    } else {
      amount = BigInt(item.amount as bigint | number | string)
    }
    if (amount < 0n || amount >= 2n ** 64n) {
      throw new Error(`recipients[${index}]: amount out of range`)
    }
    return { index, to: item.to, token, native, amount, decimals, tokenProgram: native ? null : (balance?.tokenProgram ?? null) }
  })
  if (options.checkBalance ?? true) {
    const totals = new Map<string, bigint>()
    planned.forEach((p) => totals.set(p.token, (totals.get(p.token) ?? 0n) + p.amount))
    for (const [token, total] of totals) {
      const balance = info.get(token)
      if (!balance?.success) {
        throw new Error(`Cannot read the balance of ${token} (${balance?.error ?? 'unknown error'}); pass checkBalance: false to skip the check`)
      }
      if (BigInt(balance.balance) < total) {
        throw new Error(`Insufficient balance of ${token}: need ${total}, have ${balance.balance}`)
      }
    }
  }
  return planned
}

function toTransferResult(p: Planned, result: WriteResult, createdAccount: boolean): TransferResult {
  return {
    ...result,
    to: p.to,
    token: p.token,
    native: p.native,
    amount: p.amount.toString(),
    formatted: p.decimals === null ? null : formatUnits(p.amount, p.decimals),
    createdAccount,
  }
}
