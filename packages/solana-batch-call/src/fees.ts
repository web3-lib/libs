/**
 * 手续费估算（子路径 `@w3lib/solana-batch-call/fees`）：三档优先费（getRecentPrioritizationFees 的百分位，可以只看交易会写的账户），
 * 一笔交易的花费：基础费（每个签名 5000 lamports）+ 优先费（模拟得到的计算单元上限 × 单价）+ 新建账户的免租押金
 */
import { base64 } from '@scure/base'

import { encodeAddress } from './address.js'
import type { RequestOptions, SolanaClient } from './client.js'
import { SOL_DECIMALS, SYSTEM_PROGRAM_ID } from './constants.js'
import { formatUnits } from './layout.js'
import type { InstructionInput } from './write/transaction.js'

export type FeeLevel = 'slow' | 'normal' | 'fast'

/** 三档优先费单价（每个计算单元多少 micro-lamports，十进制字符串） */
export interface PriorityFeeEstimate {
  slow: string
  normal: string
  fast: string
  /** 统计了多少个 slot（节点返回最近 150 个） */
  slots: number
}

export interface EstimateFeesOptions extends RequestOptions {
  /** 只看会写这些账户的交易（如交易的可写账户，最多 128 个）；不传时看全网 */
  accounts?: readonly string[]
  /** 三档取各 slot 最低落块费用的百分位，默认 [50, 75, 90]（normal 与 /write 的 priorityFee: 'auto' 相同） */
  percentiles?: readonly [number, number, number]
}

interface PrioritizationFee {
  slot: number
  prioritizationFee: number
}

/**
 * 当前的优先费建议：getRecentPrioritizationFees 返回最近 150 个 slot 里（会写这些账户的）落块交易的最低单价，三档取它们的百分位。
 * 不传 accounts 时大多是 0（每个区块总有不加优先费的交易），要估某笔交易时传它的可写账户（estimateCost 自动这样做）
 *
 * ```ts
 * await estimateFees(client, { accounts: [poolAddress] })   // { slow: '0', normal: '12000', fast: '150000', slots: 150 }
 * ```
 */
export async function estimateFees(client: SolanaClient, options: EstimateFeesOptions = {}): Promise<PriorityFeeEstimate> {
  const [p1, p2, p3] = options.percentiles ?? [50, 75, 90]
  const accounts = [...new Set(options.accounts ?? [])].slice(0, 128)
  const list = await client.request<PrioritizationFee[]>('getRecentPrioritizationFees', accounts.length ? [accounts] : [], { signal: options.signal })
  const fees = list.map((f) => BigInt(f.prioritizationFee)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  // 与 /write 的 'auto' 相同的取法：排序后第 ⌊n × p⌋ 个
  const pick = (p: number) => (fees.length ? (fees[Math.min(fees.length - 1, Math.max(0, Math.floor((fees.length * p) / 100)))] as bigint) : 0n)
  const slow = pick(p1)
  const normal = pick(p2) > slow ? pick(p2) : slow
  const fast = pick(p3) > normal ? pick(p3) : normal
  return { slow: slow.toString(), normal: normal.toString(), fast: fast.toString(), slots: list.length }
}

/**
 * 要估算的交易：
 * - 指令 + 手续费支付者：按 /write 的方式发送时的花费（计算单元上限 = 模拟值 × 1.1 + 1000，单价按这一档）。指令里自带的计算预算指令会被去掉
 * - 已经构建好的交易（序列化的字节或 base64，legacy / v0，签名可以是空的）：按交易自带的计算预算指令算（没有 SetComputeUnitPrice 时优先费为 0）
 */
export type CostInput = { feePayer: string; instructions: InstructionInput | readonly InstructionInput[] } | { transaction: Uint8Array | string }

export interface EstimateCostOptions extends Omit<EstimateFeesOptions, 'accounts'> {
  /** 用哪一档优先费，默认 'normal'（只对指令有效） */
  level?: FeeLevel
  /** 直接指定优先费单价（micro-lamports / 计算单元），不查建议（只对指令有效） */
  priorityFee?: number | bigint
  /** 已经查好的费用建议（多笔交易共用）；不传时按交易的可写账户查 */
  fees?: PriorityFeeEstimate
}

export interface CreatedAccount {
  address: string
  /** 所属程序 */
  owner: string
  /** 数据大小（字节） */
  space: number
  /** 免租押金（lamports） */
  rent: string
}

export interface CostEstimate {
  /** 模拟消耗的计算单元 */
  computeUnits: number
  /** 计算单元上限（优先费按它收） */
  computeUnitLimit: number
  /** 优先费单价（micro-lamports / 计算单元） */
  priorityFee: string
  signatures: number
  /** 基础费：每个签名 5000 lamports */
  baseFee: string
  /** 优先费：单价 × 上限（lamports，向上取整） */
  priorityFeeLamports: string
  /** 手续费：baseFee + priorityFeeLamports（lamports） */
  fee: string
  /** 新建账户的免租押金合计（lamports，关闭账户时退回） */
  rent: string
  createdAccounts: CreatedAccount[]
  /** fee + rent（lamports）和按 SOL 换算的值 */
  total: string
  totalFormatted: string
  symbol: 'SOL'
}

interface SimulatedAccount {
  lamports: number
  owner: string
  data: [string, string]
}

interface Simulation {
  err: unknown
  logs?: string[] | null
  unitsConsumed?: number
  accounts?: Array<SimulatedAccount | null> | null
}

/** 没有 SetComputeUnitLimit 时每条（非计算预算）指令的默认上限 */
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000
/** 地址查找表账户的头部大小，之后每 32 字节一个地址 */
const LOOKUP_TABLE_META_SIZE = 56

/**
 * 估算一笔交易的花费（模拟一次，sigVerify: false，不需要签名、不会发送）。模拟失败时抛出（带程序日志里的原因）。
 * 新建账户：交易前不存在（lamports 为 0）、模拟后存在、有数据或不归 System Program 的可写账户，押金按 getMinimumBalanceForRentExemption 算；
 * 普通转账给新地址（System 账户、没有数据）不算押金
 *
 * ```ts
 * await estimateCost(client, { feePayer: owner, instructions: [ix1, ix2] })
 * // { computeUnits: 41230, computeUnitLimit: 46353, priorityFee: '12000', fee: '5557', rent: '1488440', totalFormatted: '0.001493997', … }
 * await estimateCost(client, { transaction: base64FromJupiter })
 * ```
 */
export async function estimateCost(client: SolanaClient, input: CostInput, options: EstimateCostOptions = {}): Promise<CostEstimate> {
  const { signal } = options
  // 构建交易的代码按需加载：只查费用建议时打包不会带上
  const [{ MAX_COMPUTE_UNITS, COMPUTE_BUDGET_PROGRAM_ID, setComputeUnitLimit, setComputeUnitPrice }, tx, { transactionErrorText, transactionFee }] = await Promise.all([
    import('./write/instructions.js'),
    import('./write/transaction.js'),
    import('./write/send.js'),
  ])

  let raw: string
  let signatures: number
  let writable: string[]
  /** 交易自带的计算预算（只对构建好的交易） */
  let budget: { limit: number; price: bigint } | null = null
  if ('transaction' in input) {
    const bytes = typeof input.transaction === 'string' ? base64.decode(input.transaction) : input.transaction
    // legacy / v0 的交易以签名数（compact-u16，不会超过 127）开头；v1 等新格式以版本字节（0x80 | 版本）开头，布局不同
    if (((bytes[0] ?? 0) & 0x80) !== 0) {
      throw new Error(`Unsupported transaction format (version ${(bytes[0] as number) & 0x7f}); only legacy and v0 transactions can be estimated, pass the instructions instead`)
    }
    const message = tx.parseMessage(tx.splitTransaction(bytes).message)
    raw = base64.encode(bytes)
    signatures = message.signatures
    writable = [...message.writable, ...(await lookupWritable(client, message.lookups, signal))]
    let limit: number | null = null
    let price = 0n
    for (const ix of message.instructions) {
      if (ix.programId !== COMPUTE_BUDGET_PROGRAM_ID) continue
      const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength)
      if (ix.data[0] === 2 && ix.data.length >= 5) limit = view.getUint32(1, true)
      if (ix.data[0] === 3 && ix.data.length >= 9) price = view.getBigUint64(1, true)
    }
    const others = message.instructions.filter((ix) => ix.programId !== COMPUTE_BUDGET_PROGRAM_ID).length
    budget = { limit: Math.min(MAX_COMPUTE_UNITS, limit ?? DEFAULT_UNITS_PER_INSTRUCTION * others), price }
  } else {
    const list = Array.isArray(input.instructions) ? (input.instructions as readonly InstructionInput[]) : [input.instructions as InstructionInput]
    // 和 batchCall 一样：去掉自带的计算单元上限 / 单价指令，模拟时上限取最大、单价为 0
    const instructions = list.map(tx.normalizeInstruction).filter((ix) => !(ix.programId === COMPUTE_BUDGET_PROGRAM_ID && (ix.data[0] === 2 || ix.data[0] === 3)))
    const message = tx.compileMessage(input.feePayer, [setComputeUnitLimit(MAX_COMPUTE_UNITS), setComputeUnitPrice(0n), ...instructions], SYSTEM_PROGRAM_ID)
    raw = base64.encode(tx.serializeTransaction(message, message.signers.map(() => null)))
    signatures = message.signers.length
    writable = message.writable
  }

  // 交易前不存在的可写账户：模拟后读回它们的状态，判断是否新建
  const before = writable.length ? await client.solBalances(writable, { signal }) : []
  const fresh = writable.filter((_, i) => before[i]?.balance === '0')
  const priceFor = async () => {
    if (budget) return budget.price
    if (options.priorityFee !== undefined) return BigInt(options.priorityFee)
    const fees = options.fees ?? (await estimateFees(client, { accounts: writable, percentiles: options.percentiles, signal }))
    return BigInt(fees[options.level ?? 'normal'])
  }
  const [simulation, price] = await Promise.all([
    client.request<{ value: Simulation }>(
      'simulateTransaction',
      [
        raw,
        {
          encoding: 'base64',
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: 'confirmed',
          ...(fresh.length ? { accounts: { encoding: 'base64', addresses: fresh } } : {}),
        },
      ],
      { signal },
    ),
    priceFor(),
  ])
  const sim = simulation.value
  if (sim.err) {
    throw new Error(`Simulation failed: ${transactionErrorText(sim.err, sim.logs)}`)
  }
  const consumed = sim.unitsConsumed ?? 0
  const limit = budget?.limit ?? Math.min(MAX_COMPUTE_UNITS, Math.ceil(consumed * 1.1) + 1000)

  const created = fresh.flatMap((address, i) => {
    const a = sim.accounts?.[i]
    if (!a || !(a.lamports > 0)) return []
    const space = base64.decode(a.data[0]).length
    return space > 0 || a.owner !== SYSTEM_PROGRAM_ID ? [{ address, owner: a.owner, space }] : []
  })
  const sizes = [...new Set(created.map((c) => c.space))]
  const rents = await Promise.all(sizes.map((size) => client.request<number>('getMinimumBalanceForRentExemption', [size], { signal })))
  const rentOf = new Map(sizes.map((size, i) => [size, BigInt(rents[i] as number)]))
  const createdAccounts = created.map((c) => ({ ...c, rent: (rentOf.get(c.space) as bigint).toString() }))
  const rent = createdAccounts.reduce((sum, c) => sum + BigInt(c.rent), 0n)

  const fee = transactionFee(signatures, limit, price)
  const baseFee = 5000n * BigInt(signatures)
  const total = fee + rent
  return {
    computeUnits: consumed,
    computeUnitLimit: limit,
    priorityFee: price.toString(),
    signatures,
    baseFee: baseFee.toString(),
    priorityFeeLamports: (fee - baseFee).toString(),
    fee: fee.toString(),
    rent: rent.toString(),
    createdAccounts,
    total: total.toString(),
    totalFormatted: formatUnits(total, SOL_DECIMALS),
    symbol: 'SOL',
  }
}

/** v0 交易的地址查找表里要写的账户（读查找表账户：56 字节头部之后每 32 字节一个地址）；表读不到时跳过 */
async function lookupWritable(client: SolanaClient, lookups: ReadonlyArray<{ table: string; writable: number[] }>, signal: AbortSignal | undefined): Promise<string[]> {
  const used = lookups.filter((l) => l.writable.length)
  if (!used.length) return []
  const tables = await client.accounts(
    used.map((l) => l.table),
    { signal },
  )
  return used.flatMap((l, i) => {
    const data = tables[i]?.data
    if (!data) return []
    return l.writable.flatMap((index) => {
      const start = LOOKUP_TABLE_META_SIZE + 32 * index
      return start + 32 <= data.length ? [encodeAddress(data.slice(start, start + 32))] : []
    })
  })
}
