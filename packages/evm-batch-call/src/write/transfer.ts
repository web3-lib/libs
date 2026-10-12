import { Interface, getAddress, getBigInt, parseUnits, type BigNumberish } from 'ethers'

import { ERC20_ABI, NATIVE_TOKEN, formatUnits } from '../erc20.js'
import type { Provider } from '../provider.js'
import { send7702, sendEach, tronModule, type NormalizedCall } from './batch.js'
import { WriteRpc } from './rpc.js'
import { emptyOutcome, sendJobs, toWriteResult, type SendOptions, type TronSendOptions, type TxJob, type TxOutcome, type WriteResult } from './send.js'
import { resolveSigner, type ResolvedSigner, type SignerInput } from './signer.js'

/**
 * Disperse 合约（disperse.app），各主流链上地址相同：一笔交易把主币 / 代币分发给多个地址。
 * 代币分发前需要 approve 给它；它只会从调用者自己的账户 transferFrom，别人无法动用这份额度
 */
export const DISPERSE_ADDRESS = '0xD152f549545093347A162Dce210e7293f1452150'

const disperseInterface = new Interface([
  'function disperseEther(address[] recipients, uint256[] values) payable',
  'function disperseToken(address token, address[] recipients, uint256[] values)',
])
const erc20Interface = new Interface(ERC20_ABI as unknown as string[])

/** 一个收款项：amount（最小单位）和 formatted（按精度换算后，如 '1.5'）二选一 */
export interface TransferItem {
  to: string
  /** 数量，最小单位（wei），bigint 或十进制字符串 */
  amount?: BigNumberish
  /** 按 decimals 换算后的数量，如 '1.5'；小数位超过精度时报错（不四舍五入） */
  formatted?: string
  /** 这一项转的代币，默认 options.token */
  token?: string
}

/**
 * - 'disperse'（默认）：通过 Disperse 合约，每种代币每 batchSize 个收款人一笔交易。以下情况自动改为逐笔发送：
 *   链上没有 Disperse 合约；某种代币只有一个收款人；某一批预估 revert（收款地址拒收主币、转账收税的代币等，逐笔发送能把出问题的那一个单独标成失败）
 * - 'tx'：每个收款人一笔交易
 * - '7702'：EIP-7702 批量执行，每 batchSize 个收款人一笔（见 BatchCallOptions.mode）
 */
export type TransferMode = 'disperse' | 'tx' | '7702'

export interface BatchTransferOptions extends SendOptions, TronSendOptions {
  /** 默认转的代币，默认主币（NATIVE_TOKEN）；每项也可以单独指定 token */
  token?: string
  mode?: TransferMode
  /** 每笔交易最多几个收款人：disperse 默认 200，7702 默认 50 */
  batchSize?: number
  /** Disperse 合约地址，默认 DISPERSE_ADDRESS */
  disperse?: string
  /** 发送前检查余额够不够（按代币汇总），不够时抛错、什么都不发。默认 true（主币不含手续费） */
  checkBalance?: boolean
  /** 7702：委托的合约，见 BatchCallOptions.delegate */
  delegate?: string
  /** 7702：见 BatchCallOptions.redelegate */
  redelegate?: boolean
}

/** 单个收款项的结果，to 是收款地址 */
export interface TransferResult extends WriteResult {
  token: string
  native: boolean
  /** 数量（最小单位） */
  amount: string
  /** 按精度换算后的数量；精度查不到时为 null */
  formatted: string | null
  /** 实际的发送方式（disperse 自动退回逐笔时为 'tx'） */
  via: TransferMode
  /**
   * 这一项的代币为了走 Disperse 发出的 approve 交易（额度不够时才有；USDT 等先归零时有两笔）。
   * 同一种代币的各项相同；主币、逐笔发送、额度已够时为空数组
   */
  approvals: ApproveResult[]
}

/** approve 交易的结果：to 是代币地址，spender 是 Disperse 合约 */
export interface ApproveResult extends Omit<WriteResult, 'index'> {
  spender: string
  /** approve 的额度（最小单位） */
  amount: string
}

/** 解析后的收款项 */
interface Planned {
  index: number
  to: string
  token: string
  native: boolean
  amount: bigint
  decimals: number | null
}

/** 链上有没有 Disperse 合约（按 chainId + 地址缓存） */
const disperseDeployed = new Map<string, boolean>()

/** 测试用 */
export function resetDisperseCache(): void {
  disperseDeployed.clear()
}

async function hasCode(rpc: WriteRpc, address: string): Promise<boolean> {
  const key = `${rpc.chainId}:${address.toLowerCase()}`
  let deployed = disperseDeployed.get(key)
  if (deployed === undefined) {
    const code = await rpc.code(address)
    deployed = Boolean(code && code !== '0x')
    disperseDeployed.set(key, deployed)
  }
  return deployed
}

/**
 * 一对多批量转账（主币 / ERC20，可混合）。结果与 recipients 一一对应。
 *
 * ```ts
 * await batchTransfer(multi, privateKey, [
 *   { to: a, formatted: '1.5' },                  // 默认代币（options.token，默认主币）
 *   { to: b, amount: 10n ** 18n },
 *   { to: c, token: USDT, formatted: '20' },
 * ], { token: NATIVE_TOKEN })
 * // [{ index: 0, to: a, token, native: true, amount: '1500000000000000000', formatted: '1.5', status: 'confirmed', hash, via: 'disperse', … }, …]
 * ```
 *
 * - 默认通过 Disperse 合约分发（见 TransferMode），代币会先 approve 本次的精确总额
 * - 默认先检查余额，不够时抛错，一笔都不发
 * - 某个收款项失败不影响其他收款项
 */
export async function batchTransfer(provider: Provider, from: SignerInput, recipients: readonly TransferItem[], options: BatchTransferOptions = {}): Promise<TransferResult[]> {
  const tron = await tronModule(provider)
  if (tron) {
    return tron.tronBatchTransfer(provider, from, recipients, options)
  }
  const rpc = await WriteRpc.from(provider)
  const signer = await resolveSigner(from)
  const planned = await plan(provider, signer.address, recipients, options)
  const mode = options.mode ?? 'disperse'
  if (mode === 'tx' || mode === '7702') {
    return sendDirect(rpc, signer, planned, mode, options)
  }
  return sendDisperse(rpc, provider, signer, planned, options)
}

/** 解析数量（formatted 按精度换算）并检查余额 */
async function plan(provider: Provider, owner: string, recipients: readonly TransferItem[], options: BatchTransferOptions): Promise<Planned[]> {
  const defaultToken = options.token ?? NATIVE_TOKEN
  const tokens = [...new Set(recipients.map((r) => (r.token ?? defaultToken).toLowerCase()))]
  const balances = tokens.length ? await provider.balances(owner, tokens) : []
  const info = new Map(balances.map((b, i) => [tokens[i] as string, b]))
  const planned = recipients.map((item, index): Planned => {
    const tokenKey = (item.token ?? defaultToken).toLowerCase()
    const balance = info.get(tokenKey)
    const native = provider.isNativeToken(tokenKey)
    const decimals = balance?.success ? balance.decimals : null
    if ((item.amount === undefined) === (item.formatted === undefined)) {
      throw new Error(`recipients[${index}]: pass exactly one of amount / formatted`)
    }
    let amount: bigint
    if (item.formatted !== undefined) {
      if (decimals === null) {
        throw new Error(`recipients[${index}]: cannot read decimals of ${item.token ?? defaultToken}, pass amount instead of formatted`)
      }
      amount = parseUnits(item.formatted, decimals)
    } else {
      amount = getBigInt(item.amount as BigNumberish)
    }
    if (amount < 0n) {
      throw new Error(`recipients[${index}]: amount must not be negative`)
    }
    return { index, to: getAddress(item.to), token: native ? (item.token ?? defaultToken) : getAddress(tokenKey), native, amount, decimals }
  })
  if (options.checkBalance ?? true) {
    const totals = new Map<string, bigint>()
    planned.forEach((p) => totals.set(p.token.toLowerCase(), (totals.get(p.token.toLowerCase()) ?? 0n) + p.amount))
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

/** 收款项对应的调用：主币直接转，代币调 transfer */
function transferCall(signer: ResolvedSigner, p: Planned): NormalizedCall {
  return p.native
    ? { signer, to: p.to, data: '0x', value: p.amount }
    : { signer, to: p.token, data: erc20Interface.encodeFunctionData('transfer', [p.to, p.amount]), value: 0n }
}

function toTransferResult(p: Planned, result: WriteResult, via: TransferMode): TransferResult {
  return {
    ...result,
    index: p.index,
    to: p.to,
    token: p.token,
    native: p.native,
    amount: p.amount.toString(),
    formatted: p.decimals === null ? null : formatUnits(p.amount, p.decimals),
    via,
    approvals: [],
  }
}

/** 'tx' / '7702'：直接转账 */
async function sendDirect(rpc: WriteRpc, signer: ResolvedSigner, planned: readonly Planned[], mode: 'tx' | '7702', options: BatchTransferOptions): Promise<TransferResult[]> {
  const calls = planned.map((p) => transferCall(signer, p))
  const callOptions = {
    ...options,
    mode,
    continueOnError: true,
    onUpdate: options.onUpdate && ((r: WriteResult) => options.onUpdate?.(toTransferResult(planned[r.index] as Planned, r, mode))),
  }
  const results = mode === '7702' ? await send7702(rpc, calls, callOptions) : await sendEach(rpc, calls, callOptions)
  return results.map((r, i) => toTransferResult(planned[i] as Planned, r, mode))
}

/** 预估 / 执行时合约 revert（换成逐笔发送可能成功，或至少能定位到是哪个收款项） */
function isReverted(outcome: TxOutcome): boolean {
  return outcome.status === 'reverted' || (outcome.status === 'failed' && (outcome.revertData !== null || /revert/i.test(outcome.error ?? '')))
}

/** 'disperse'：每种代币每 batchSize 个收款人一笔；不适用 / 失败的部分逐笔发送 */
async function sendDisperse(rpc: WriteRpc, provider: Provider, signer: ResolvedSigner, planned: readonly Planned[], options: BatchTransferOptions): Promise<TransferResult[]> {
  const disperse = getAddress(options.disperse ?? DISPERSE_ADDRESS)
  const batchSize = Math.max(1, options.batchSize ?? 200)
  // 初始结果（没有执行到的项保持 skipped），不触发 onUpdate
  const results = planned.map((p) => toTransferResult(p, toWriteResult(p.index, signer.address, p.to, emptyOutcome('skipped')), 'disperse'))
  const report = (p: Planned, outcome: TxOutcome, via: TransferMode) => {
    results[p.index] = toTransferResult(p, toWriteResult(p.index, signer.address, p.to, outcome), via)
    options.onUpdate?.(results[p.index] as TransferResult)
  }

  // 按代币分组（数量为 0 的项也照常转，与逐笔发送一致）
  const groups = new Map<string, Planned[]>()
  planned.forEach((p) => groups.set(p.token.toLowerCase(), [...(groups.get(p.token.toLowerCase()) ?? []), p]))
  const direct: Planned[] = []
  const useDisperse = planned.length > 1 && (await hasCode(rpc, disperse))
  const jobs: TxJob[] = []
  /** 每个 disperse 批次的收款项（与 jobs 里的位置对应，approve 为 null） */
  const batches: Array<Planned[] | null> = []
  /** 代币（小写）→ 发出的 approve */
  const approvals = new Map<string, ApproveResult[]>()
  const approve = (token: string, amount: bigint) => {
    const list = approvals.get(token.toLowerCase()) ?? []
    approvals.set(token.toLowerCase(), list)
    const k = list.length
    const result = (outcome: TxOutcome): ApproveResult => {
      const { index: _index, ...rest } = toWriteResult(0, signer.address, token, outcome)
      return { ...rest, spender: disperse, amount: amount.toString() }
    }
    list.push(result(emptyOutcome('skipped')))
    jobs.push({
      signer,
      continueOnError: true,
      build: async () => ({ to: token, data: erc20Interface.encodeFunctionData('approve', [disperse, amount]), value: 0n }),
      onUpdate: (outcome) => (list[k] = result(outcome)),
    })
    batches.push(null)
  }

  for (const items of groups.values()) {
    if (!useDisperse || items.length < 2) {
      direct.push(...items)
      continue
    }
    const first = items[0] as Planned
    if (!first.native) {
      const total = items.reduce((sum, p) => sum + p.amount, 0n)
      const [allowance] = await provider.allowances(signer.address, disperse, [first.token], { decimals: false })
      const current = allowance?.success ? BigInt(allowance.allowance) : 0n
      if (current < total) {
        if (options.dryRun) {
          // 还没 approve，Disperse 的调用没法预估：只预估 approve，分发批次直接标记 simulated
          approve(first.token, total)
          items.forEach((p) => report(p, { ...emptyOutcome('simulated') }, 'disperse'))
          continue
        }
        // USDT 等代币要求额度先归零才能改成另一个非零值
        if (current > 0n) {
          approve(first.token, 0n)
        }
        approve(first.token, total)
      }
    }
    for (let start = 0; start < items.length; start += batchSize) {
      const chunk = items.slice(start, start + batchSize)
      const recipients = chunk.map((p) => p.to)
      const values = chunk.map((p) => p.amount)
      const value = first.native ? values.reduce((a, b) => a + b, 0n) : 0n
      const data = first.native
        ? disperseInterface.encodeFunctionData('disperseEther', [recipients, values])
        : disperseInterface.encodeFunctionData('disperseToken', [first.token, recipients, values])
      jobs.push({
        signer,
        continueOnError: true,
        build: async () => ({ to: disperse, data, value }),
        onUpdate: (outcome) => {
          // 预估 revert 的批次稍后逐笔重发，先不报告失败
          if (!(outcome.status === 'failed' && isReverted(outcome))) {
            chunk.forEach((p) => report(p, outcome, 'disperse'))
          }
        },
      })
      batches.push(chunk)
    }
  }

  const outcomes = await sendJobs(rpc, jobs, options)
  // 预估就 revert 的批次（没有花手续费）改为逐笔发送；已上链但 revert 的批次不重发，避免重复支付
  outcomes.forEach((outcome, i) => {
    const chunk = batches[i]
    if (chunk && outcome.status === 'failed' && isReverted(outcome)) {
      direct.push(...chunk)
    }
  })
  if (direct.length && !options.signal?.aborted) {
    direct.sort((a, b) => a.index - b.index)
    const calls = direct.map((p) => transferCall(signer, p))
    await sendEach(rpc, calls, {
      ...options,
      mode: 'tx',
      continueOnError: true,
      onUpdate: (r) => report(direct[r.index] as Planned, outcomeOf(r), 'tx'),
    })
  }
  return results.map((r) => ({ ...r, approvals: [...(approvals.get(r.token.toLowerCase()) ?? [])] }))
}

/** WriteResult 转回 TxOutcome（逐笔重发的结果并入 report） */
function outcomeOf(r: WriteResult): TxOutcome {
  return {
    status: r.status,
    hash: r.hash,
    nonce: r.nonce,
    gasLimit: r.gasLimit === null ? null : BigInt(r.gasLimit),
    gasUsed: r.gasUsed === null ? null : BigInt(r.gasUsed),
    fee: r.fee === null ? null : BigInt(r.fee),
    blockNumber: r.blockNumber,
    error: r.error,
    revertData: null,
  }
}
