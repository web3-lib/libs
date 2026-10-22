/**
 * 模拟交易（TransactionExecutionService.SimulateTransaction，不需要签名）：余额变化、对象变化、gas、错误解码、
 * Move 调用解码（本库认得的 DEX）和风险提示。交易可以是 BCS 字节，也可以是本库构建器（buildSwap、buildAddLiquidity…）的结果
 */
import { base64 } from '@scure/base'
import { SUI_COIN_TYPE, normalizeSuiAddress } from './address.js'
import {
  classify,
  coinKey,
  decodeCalls,
  decodeError,
  describeObjectChanges,
  isCoinType,
  isSui,
  perspective,
  shortAddress,
  summarize,
  type ActivityKind,
  type CallInfo,
  type DecodedError,
  type NamedChange,
  type ObjectChangeInfo,
} from './analyze.js'
import type { SuiClient } from './client.js'
import { SUI_DECIMALS } from './constants.js'
import { formatUnits } from './format.js'
import { ProtoWriter, fieldMask } from './proto.js'
import { RAW_TX_PATHS, balanceChangesWithoutGas, feeOf, rawFromProto } from './rawTx.js'
import { getEpoch } from './services.js'
import { encodeTransactionData, type ProgrammableTransaction } from './write/bcs.js'

const EXECUTION = 'sui.rpc.v2.TransactionExecutionService'

/** 模拟一笔交易需要的内容：完整的 TransactionData（BCS 字节或 base64），或只有命令的交易 + 发送者 */
export type SimulateInput =
  | Uint8Array
  | string
  | ProgrammableTransaction
  /** 构建器的结果（SwapPlan、AddLiquidityPlan…）或 { kind }：kind 可以是 TransactionKind 的 BCS（@mysten/sui 的 onlyTransactionKind） */
  | { kind: ProgrammableTransaction | Uint8Array | string }

export interface SimulateOptions {
  /** 发送者：只有命令（没有 TransactionData）时必填 */
  sender?: string
  /** 只有命令时的 gas 上限（MIST），默认 5 SUI（模拟用，节点按实际消耗算费用） */
  gasBudget?: bigint
  /** 给 balanceChanges 填美元价值（用 /price，按需加载；查不到的为 null），默认 true */
  prices?: boolean
  /** 检查收到的代币的风险（用 /risk，不模拟卖出），默认 false */
  risk?: boolean
  /** 已知的收款地址：转给不在列表里的地址时提醒（不传不检查） */
  trustedRecipients?: readonly string[]
  /** 完整交易里的 gas 上限超过这个数时提醒（MIST），默认 0.5 SUI */
  maxGasBudget?: bigint
  signal?: AbortSignal
}

export type WarningSeverity = 'info' | 'warn' | 'danger'

export interface SimulationWarning {
  /** unknown-package、publish、upgrade、object-transfer、unknown-recipient、high-gas-budget、risky-token、failed */
  code: string
  severity: WarningSeverity
  message: string
  /** 相关的对象 / 包 / 地址 / 代币 */
  subject?: string
}

export interface SimulatedBalanceChange {
  address: string
  /** 代币类型（规范化） */
  asset: string
  symbol: string | null
  decimals: number | null
  /** 带符号的最小单位数量；SUI 不含 gas（见 fee） */
  delta: string
  formatted: string
  usd?: number | null
}

export interface SimulationResult {
  success: boolean
  /** 失败原因（可读） */
  error?: string
  /** 错误的结构化信息（Move abort 的包 / 模块 / 函数、码、常量名） */
  errorInfo?: DecodedError
  /** 计算 + 存储费用（MIST，未扣返还） */
  gasUsed: string
  /** 实际花的 gas：计算 + 存储 − 返还（MIST） */
  fee?: string
  /** gas 明细（MIST） */
  gas: { computation: string; storage: string; rebate: string; budget: string | null; price: string | null }
  /** 所有地址的代币余额变化（含对方） */
  balanceChanges: SimulatedBalanceChange[]
  /** Sui 没有授权；与其他链保持字段一致 */
  approvalChanges: []
  /** 对象变化：新建 / 删除 / 换了所有者 / 只是改了内容 */
  objectChanges: ObjectChangeInfo[]
  decoded: {
    type: ActivityKind | 'unknown'
    protocol?: string
    method?: string
    summary: string
    /** 交易里的 Move 调用（按顺序） */
    args?: { calls: CallInfo[] }
  }
  warnings: SimulationWarning[]
  /** 模拟时的发送者 */
  sender: string | null
}

const decode = (input: string | Uint8Array) => (typeof input === 'string' ? base64.decode(input) : input)
const isKindInput = (tx: SimulateInput): tx is { kind: ProgrammableTransaction | Uint8Array | string } => typeof tx === 'object' && !(tx instanceof Uint8Array) && 'kind' in tx
/** 5 SUI */
const DEFAULT_BUDGET = 5_000_000_000n
/** 0.5 SUI */
const HIGH_BUDGET = 500_000_000n

/** 模拟（节点可用 FallbackTransport 切换） */
export async function simulateTx(client: SuiClient, tx: SimulateInput, options: SimulateOptions = {}): Promise<SimulationResult> {
  const { signal } = options
  let bytes: Uint8Array
  let selectGas = false
  let userBudget = true
  if (typeof tx === 'string' || tx instanceof Uint8Array) bytes = decode(tx)
  else {
    const kind = isKindInput(tx) ? tx.kind : tx
    if (!options.sender) throw new Error('simulate: options.sender is required when the transaction has no sender (builder output / TransactionKind)')
    const sender = normalizeSuiAddress(options.sender)
    const { referenceGasPrice } = await getEpoch(client.transport, { signal })
    bytes = encodeTransactionData({
      kind: typeof kind === 'string' ? base64.decode(kind) : kind,
      sender,
      gas: { payment: [], owner: sender, price: referenceGasPrice, budget: options.gasBudget ?? DEFAULT_BUDGET },
      expiration: { kind: 'none' },
    })
    selectGas = true
    userBudget = false
  }
  const req = new ProtoWriter()
    .message(1, new ProtoWriter().message(1, new ProtoWriter().bytes(2, bytes)))
    .message(2, fieldMask(RAW_TX_PATHS.map((p) => `transaction.${p}`)))
    .uint(4, selectGas)
  const { message } = await client.transport.unary(`${EXECUTION}/SimulateTransaction`, req.finish(), { signal })
  const executed = message.message(1)
  if (!executed) throw new Error('SimulateTransaction returned no transaction')
  const raw = rawFromProto(executed)
  const sender = raw.sender ?? options.sender ?? null
  const calls = await decodeCalls(client.transport, raw.commands, signal)
  const changes = balanceChangesWithoutGas(raw)
  const objects = describeObjectChanges(raw.objectChanges.filter((o) => !isGasCoinChange(o, raw.gasOwner)))

  // 代币信息（精度、symbol）
  const types = [...new Set(changes.map((c) => coinKey(c.coinType)))]
  const infos = types.length ? await client.coins(types, { signal }) : []
  const meta = new Map(types.map((t, i) => [t, infos[i]] as const))
  const decimalsOf = (t: string) => (isSui(t) ? SUI_DECIMALS : (meta.get(coinKey(t))?.decimals ?? null))
  const symbolOf = (t: string) => (isSui(t) ? 'SUI' : (meta.get(coinKey(t))?.symbol ?? null))

  const balanceChanges: SimulatedBalanceChange[] = changes.map((c) => {
    const decimals = decimalsOf(c.coinType)
    return { address: c.address, asset: coinKey(c.coinType), symbol: symbolOf(c.coinType), decimals, delta: c.amount.toString(), formatted: decimals === null ? c.amount.toString() : formatUnits(c.amount, decimals) }
  })
  if (options.prices ?? true) await fillUsd(client, balanceChanges, options)

  const view = sender ? perspective(raw, sender, changes, objects) : null
  const named: NamedChange[] = (view?.mine ?? []).map((c) => {
    const decimals = decimalsOf(c.coinType)
    return { coinType: coinKey(c.coinType), symbol: symbolOf(c.coinType), amount: c.amount, formatted: decimals === null ? c.amount.toString() : formatUnits(c.amount, decimals) }
  })
  const classified = classify(calls, raw, sender ?? '0x0', view?.mine ?? [])
  const type = raw.commands.length ? classified.type : 'unknown'
  const decoded = decodeError(raw.error) ?? undefined
  // 本库构建的兑换 / 移除用 SplitCoins 检查最少收到的数量：数量不够时报的是余额不足
  const errorInfo = decoded?.kind === 'INSUFFICIENT_COIN_BALANCE' && (type === 'swap' || type === 'liquidity') ? { ...decoded, message: `${decoded.message}; in a swap or liquidity change this usually means the amount received is below the minimum (slippage)` } : decoded
  const warnings = await collectWarnings({ client, raw, calls, objects, sender, options, userBudget, balanceChanges, errorInfo })

  const fee = feeOf(raw)
  return {
    success: raw.success,
    ...(errorInfo ? { error: errorInfo.message, errorInfo } : {}),
    gasUsed: raw.gas ? (raw.gas.computationCost + raw.gas.storageCost).toString() : '0',
    ...(fee === null ? {} : { fee: fee.toString() }),
    gas: {
      computation: (raw.gas?.computationCost ?? 0n).toString(),
      storage: (raw.gas?.storageCost ?? 0n).toString(),
      rebate: (raw.gas?.storageRebate ?? 0n).toString(),
      budget: raw.gasBudget?.toString() ?? null,
      price: raw.gasPrice?.toString() ?? null,
    },
    balanceChanges,
    approvalChanges: [],
    objectChanges: objects,
    decoded: {
      type,
      ...(classified.protocol ? { protocol: classified.protocol } : {}),
      ...(classified.method ? { method: classified.method } : {}),
      summary: view ? summarize(type, classified, view, named, calls, !raw.success) : 'Transaction',
      args: { calls },
    },
    warnings,
    sender,
  }
}

/** gas 币的变化（每笔交易都有；自动选 gas 币时还会合并 / 删除一堆 SUI Coin），不算对象变化：余额变化里已经有数量 */
const isGasCoinChange = (o: { type: string | null; outputOwner: { address: string | null } | null; inputOwner: { address: string | null } | null }, gasOwner: string | null): boolean => {
  const owner = o.inputOwner?.address
  if (!gasOwner || !owner || !isCoinType(o.type) || !/<0x0*2::sui::SUI>$/.test(o.type ?? '') || normalizeSuiAddress(owner) !== normalizeSuiAddress(gasOwner)) return false
  return !o.outputOwner || o.outputOwner.address === o.inputOwner?.address
}

async function fillUsd(client: SuiClient, changes: SimulatedBalanceChange[], options: SimulateOptions): Promise<void> {
  const types = [...new Set(changes.filter((c) => c.decimals !== null).map((c) => c.asset))]
  if (!types.length) return
  try {
    const { tokenPrices } = await import('./price.js')
    const prices = await tokenPrices(client, types, { signal: options.signal })
    const byType = new Map(types.map((t, i) => [t, prices[i]?.price ?? null] as const))
    for (const c of changes) {
      const price = byType.get(c.asset)
      c.usd = price === null || price === undefined || c.decimals === null ? null : Number(formatUnits(BigInt(c.delta), c.decimals)) * price
    }
  } catch {
    // 价格是附加信息：查不到时 usd 留空
  }
}

interface WarnInput {
  client: SuiClient
  raw: ReturnType<typeof rawFromProto>
  calls: CallInfo[]
  objects: ObjectChangeInfo[]
  sender: string | null
  options: SimulateOptions
  userBudget: boolean
  balanceChanges: SimulatedBalanceChange[]
  errorInfo: DecodedError | undefined
}

async function collectWarnings(w: WarnInput): Promise<SimulationWarning[]> {
  const { raw, calls, objects, sender, options } = w
  const out: SimulationWarning[] = []
  const me = sender ? normalizeSuiAddress(sender) : null
  const isMe = (a: string | null) => !!me && !!a && a.startsWith('0x') && normalizeSuiAddress(a) === me
  if (!raw.success) out.push({ code: 'failed', severity: 'danger', message: `The transaction would fail: ${w.errorInfo?.message ?? 'unknown error'}` })
  if (raw.commands.some((c) => c.kind === 'publish')) out.push({ code: 'publish', severity: 'warn', message: 'The transaction publishes a new Move package' })
  if (raw.commands.some((c) => c.kind === 'upgrade')) out.push({ code: 'upgrade', severity: 'warn', message: 'The transaction upgrades a Move package' })
  for (const pkg of new Set(calls.filter((c) => !c.framework && !c.protocol).map((c) => c.package))) {
    out.push({ code: 'unknown-package', severity: 'info', message: `Calls package ${pkg}, which is not a protocol this library knows`, subject: pkg })
  }
  for (const o of objects) {
    if (o.coin || o.kind !== 'transferred' || !isMe(o.from) || !o.to?.startsWith('0x') || isMe(o.to)) continue
    out.push({ code: 'object-transfer', severity: 'warn', message: `Sends object ${o.type ?? o.objectId} (${o.objectId}) to ${shortAddress(o.to)}`, subject: o.objectId })
  }
  if (options.trustedRecipients && me) {
    const trusted = new Set(options.trustedRecipients.map(normalizeSuiAddress))
    const outgoing = new Set(w.balanceChanges.filter((c) => BigInt(c.delta) > 0n && !isMe(c.address)).map((c) => normalizeSuiAddress(c.address)))
    for (const o of objects) if (o.kind === 'transferred' && isMe(o.from) && o.to?.startsWith('0x') && !isMe(o.to)) outgoing.add(normalizeSuiAddress(o.to))
    // 只看发送者付出了币（或送出了对象）的情况
    if (w.balanceChanges.some((c) => isMe(c.address) && BigInt(c.delta) < 0n) || objects.some((o) => isMe(o.from) && o.kind === 'transferred')) {
      for (const a of outgoing) if (!trusted.has(a) && a !== me) out.push({ code: 'unknown-recipient', severity: 'warn', message: `${shortAddress(a)} is not in the trusted recipients`, subject: a })
    }
  }
  const limit = options.maxGasBudget ?? HIGH_BUDGET
  if (w.userBudget && raw.gasBudget !== null && raw.gasBudget > limit) {
    out.push({ code: 'high-gas-budget', severity: 'info', message: `Gas budget is ${formatUnits(raw.gasBudget, SUI_DECIMALS)} SUI (above ${formatUnits(limit, SUI_DECIMALS)} SUI)` })
  }
  if (options.risk && me) {
    const received = [...new Set(w.balanceChanges.filter((c) => isMe(c.address) && BigInt(c.delta) > 0n && c.asset !== SUI_COIN_TYPE).map((c) => c.asset))]
    if (received.length) {
      try {
        const { coinRisks } = await import('./risk.js')
        const risks = await coinRisks(w.client, received, { sell: false, address: me, signal: options.signal })
        for (const r of risks) {
          const bad = r.flags.filter((f) => ['not-found', 'denied', 'paused', 'regulated', 'global-pause', 'mintable'].includes(f))
          if (bad.length) out.push({ code: 'risky-token', severity: r.flags.some((f) => f === 'denied' || f === 'paused') ? 'danger' : 'warn', message: `${r.symbol ?? r.token}: ${bad.join(', ')}`, subject: r.token })
        }
      } catch {
        // 风险检查是附加信息：失败时不影响模拟结果
      }
    }
  }
  return out
}
