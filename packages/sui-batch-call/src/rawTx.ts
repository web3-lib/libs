/**
 * 已执行 / 模拟过的交易的统一表示：/simulate（SimulateTransaction 的响应）和 /history（ListTransactions、GraphQL）都先转成它，
 * 再各自分析。gRPC 的响应按 sui.rpc.v2 的 proto 解析，GraphQL 的 transactionJson / effectsJson 是同一套消息的 JSON 形式
 */
import { SUI_COIN_TYPE, normalizeStructTag, normalizeSuiAddress } from './address.js'
import { ProtoMessage } from './proto.js'
import type { BalanceChange, GasUsed, ObjectOwner, OwnerKind } from './services.js'

export interface RawMoveAbort {
  code: bigint
  /** 中止的包（storage id）、模块、函数名 */
  package: string | null
  module: string | null
  function: string | null
  /** 新式错误（#[error] 常量）：常量名和渲染出来的消息 */
  constant: string | null
  message: string | null
}

export interface RawError {
  /** 节点给的描述（英文） */
  description: string
  /** 错误类型（如 MOVE_ABORT、INSUFFICIENT_COIN_BALANCE、INSUFFICIENT_GAS） */
  kind: string | null
  /** 出错的命令序号 */
  command: number | null
  abort: RawMoveAbort | null
}

export interface RawCommand {
  kind: 'moveCall' | 'transferObjects' | 'splitCoins' | 'mergeCoins' | 'publish' | 'upgrade' | 'makeMoveVector'
  package?: string
  module?: string
  function?: string
  typeArguments?: string[]
}

export interface RawObjectChange {
  objectId: string
  /** 完整类型；包没有 */
  type: string | null
  /** 交易前不存在、交易后存在 */
  created: boolean
  /** 交易前存在、交易后不存在（删除 / 包装） */
  deleted: boolean
  inputOwner: ObjectOwner | null
  outputOwner: ObjectOwner | null
}

export interface RawTx {
  digest: string | null
  sender: string | null
  /** 付 gas 的地址（赞助交易时不是发送者） */
  gasOwner: string | null
  gasBudget: bigint | null
  gasPrice: bigint | null
  /** 秒 */
  timestamp: number | null
  checkpoint: number | null
  success: boolean
  error: RawError | null
  gas: GasUsed | null
  balanceChanges: BalanceChange[]
  commands: RawCommand[]
  objectChanges: RawObjectChange[]
  /** 不是可编程交易（系统交易） */
  system: boolean
}

/** gRPC / ListTransactions 要取的字段（相对 ExecutedTransaction） */
export const RAW_TX_PATHS = [
  'digest',
  'checkpoint',
  'timestamp',
  'transaction.sender',
  'transaction.gas_payment',
  'transaction.kind',
  'effects.status',
  'effects.gas_used',
  'effects.changed_objects',
  'balance_changes',
] as const

/** ExecutionError.ExecutionErrorKind（proto 里的序号） */
const ERROR_KINDS = [
  'UNKNOWN', 'INSUFFICIENT_GAS', 'INVALID_GAS_OBJECT', 'INVARIANT_VIOLATION', 'FEATURE_NOT_YET_SUPPORTED', 'OBJECT_TOO_BIG', 'PACKAGE_TOO_BIG',
  'CIRCULAR_OBJECT_OWNERSHIP', 'INSUFFICIENT_COIN_BALANCE', 'COIN_BALANCE_OVERFLOW', 'PUBLISH_ERROR_NON_ZERO_ADDRESS', 'SUI_MOVE_VERIFICATION_ERROR',
  'MOVE_PRIMITIVE_RUNTIME_ERROR', 'MOVE_ABORT', 'VM_VERIFICATION_OR_DESERIALIZATION_ERROR', 'VM_INVARIANT_VIOLATION', 'FUNCTION_NOT_FOUND',
  'ARITY_MISMATCH', 'TYPE_ARITY_MISMATCH', 'NON_ENTRY_FUNCTION_INVOKED', 'COMMAND_ARGUMENT_ERROR', 'TYPE_ARGUMENT_ERROR', 'UNUSED_VALUE_WITHOUT_DROP',
  'INVALID_PUBLIC_FUNCTION_RETURN_TYPE', 'INVALID_TRANSFER_OBJECT', 'EFFECTS_TOO_LARGE', 'PUBLISH_UPGRADE_MISSING_DEPENDENCY',
  'PUBLISH_UPGRADE_DEPENDENCY_DOWNGRADE', 'PACKAGE_UPGRADE_ERROR', 'WRITTEN_OBJECTS_TOO_LARGE', 'CERTIFICATE_DENIED', 'SUI_MOVE_VERIFICATION_TIMEDOUT',
  'CONSENSUS_OBJECT_OPERATION_NOT_ALLOWED', 'INPUT_OBJECT_DELETED', 'EXECUTION_CANCELED_DUE_TO_CONSENSUS_OBJECT_CONGESTION', 'ADDRESS_DENIED_FOR_COIN',
  'COIN_TYPE_GLOBAL_PAUSE', 'EXECUTION_CANCELED_DUE_TO_RANDOMNESS_UNAVAILABLE', 'MOVE_VECTOR_ELEM_TOO_BIG', 'MOVE_RAW_VALUE_TOO_BIG', 'INVALID_LINKAGE',
  'INSUFFICIENT_FUNDS_FOR_WITHDRAW', 'NON_EXCLUSIVE_WRITE_INPUT_OBJECT_MODIFIED',
]

const OWNER_KINDS: Record<number, OwnerKind> = { 1: 'address', 2: 'object', 3: 'shared', 4: 'immutable', 5: 'consensus-address' }
const OWNER_NAMES: Record<string, OwnerKind> = { ADDRESS: 'address', OBJECT: 'object', SHARED: 'shared', IMMUTABLE: 'immutable', CONSENSUS_ADDRESS: 'consensus-address' }
const COMMAND_FIELDS: Array<[number, RawCommand['kind']]> = [
  [1, 'moveCall'], [2, 'transferObjects'], [3, 'splitCoins'], [4, 'mergeCoins'], [5, 'publish'], [6, 'makeMoveVector'], [7, 'upgrade'],
]

const ownerOf = (m: ProtoMessage | null): ObjectOwner | null =>
  m ? { kind: OWNER_KINDS[m.number(1) ?? 0] ?? 'unknown', address: m.string(2), initialSharedVersion: m.number(1) === 3 ? m.uint(3) : null } : null

function parseError(status: ProtoMessage | null): RawError | null {
  const e = status?.message(2)
  if (!e) return null
  const abort = e.message(4)
  const loc = abort?.message(2)
  const clever = abort?.message(3)
  return {
    description: e.string(1) ?? 'execution failed',
    kind: ERROR_KINDS[e.number(3) ?? 0] ?? null,
    command: e.number(2),
    abort: abort
      ? {
          code: abort.uint(1) ?? 0n,
          package: loc?.string(1) ?? null,
          module: loc?.string(2) ?? null,
          function: loc?.string(5) ?? null,
          constant: clever?.string(3) ?? null,
          message: clever?.string(5) ?? null,
        }
      : null,
  }
}

function parseCommand(m: ProtoMessage): RawCommand {
  const [field, kind] = COMMAND_FIELDS.find(([f]) => m.has(f)) ?? [0, 'moveCall' as const]
  if (kind !== 'moveCall') return { kind }
  const c = m.message(field)
  return { kind, package: c?.string(1) ?? '', module: c?.string(2) ?? '', function: c?.string(3) ?? '', typeArguments: c?.strings(4) ?? [] }
}

/** gRPC 的 ExecutedTransaction */
export function rawFromProto(m: ProtoMessage): RawTx {
  const tx = m.message(2)
  const kind = tx?.message(4)
  const ptb = kind?.message(2)
  const effects = m.message(4)
  const status = effects?.message(4)
  const gas = effects?.message(6)
  const payment = tx?.message(6)
  const stamp = m.message(7)
  return {
    digest: m.string(1),
    sender: tx?.string(5) ?? null,
    gasOwner: payment?.string(2) ?? null,
    gasBudget: payment?.uint(4) ?? null,
    gasPrice: payment?.uint(3) ?? null,
    timestamp: stamp ? Number(stamp.uint(1) ?? 0n) : null,
    checkpoint: m.number(6),
    success: status?.bool(1) ?? false,
    error: status?.bool(1) ? null : parseError(status ?? null),
    gas: gas ? { computationCost: gas.uint(1) ?? 0n, storageCost: gas.uint(2) ?? 0n, storageRebate: gas.uint(3) ?? 0n, nonRefundableStorageFee: gas.uint(4) ?? 0n } : null,
    balanceChanges: m.messages(8).map((b) => ({ address: b.string(1) ?? '', coinType: b.string(2) ?? '', amount: BigInt(b.string(3) ?? '0') })),
    commands: (ptb?.messages(2) ?? []).map(parseCommand),
    objectChanges: (effects?.messages(12) ?? []).map((c) => {
      const inExists = c.number(2) === 2
      const outExists = c.number(6) === 2 || c.number(6) === 3
      return { objectId: c.string(1) ?? '', type: c.string(11), created: !inExists && outExists, deleted: inExists && !outExists, inputOwner: ownerOf(c.message(5)), outputOwner: ownerOf(c.message(9)) }
    }),
    system: !!kind && kind.number(1) !== 1,
  }
}

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const jOwner = (o: Json | null | undefined): ObjectOwner | null => (o ? { kind: OWNER_NAMES[o.kind] ?? 'unknown', address: o.address ?? null, initialSharedVersion: o.version != null ? BigInt(o.version) : null } : null)

/** GraphQL 的 transactionJson + effectsJson + balanceChanges（JSON 形式的同一套消息） */
export function rawFromJson(input: { digest: string; transaction: Json | null; effects: Json | null; balanceChanges: ReadonlyArray<{ address: string; coinType: string; amount: string }>; timestamp?: string | null; checkpoint?: number | null }): RawTx {
  const { transaction: tx, effects } = input
  const ptb = tx?.kind?.programmableTransaction as Json | undefined
  const err = effects?.status?.error as Json | undefined
  const abort = err?.abort as Json | undefined
  const gas = effects?.gasUsed as Json | undefined
  const success = effects?.status?.success === true
  return {
    digest: input.digest,
    sender: tx?.sender ?? null,
    gasOwner: tx?.gasPayment?.owner ?? null,
    gasBudget: tx?.gasPayment?.budget != null ? BigInt(tx.gasPayment.budget) : null,
    gasPrice: tx?.gasPayment?.price != null ? BigInt(tx.gasPayment.price) : null,
    timestamp: input.timestamp ? Math.floor(Date.parse(input.timestamp) / 1000) : null,
    checkpoint: input.checkpoint ?? null,
    success,
    error: success
      ? null
      : {
          description: err?.description ?? 'execution failed',
          kind: typeof err?.kind === 'string' ? err.kind : null,
          command: err?.command != null ? Number(err.command) : null,
          abort: abort
            ? {
                code: BigInt(abort.abortCode ?? 0),
                package: abort.location?.package ?? null,
                module: abort.location?.module ?? null,
                function: abort.location?.functionName ?? null,
                constant: abort.cleverError?.constantName ?? null,
                message: abort.cleverError?.rendered ?? null,
              }
            : null,
        },
    gas: gas ? { computationCost: BigInt(gas.computationCost ?? 0), storageCost: BigInt(gas.storageCost ?? 0), storageRebate: BigInt(gas.storageRebate ?? 0), nonRefundableStorageFee: BigInt(gas.nonRefundableStorageFee ?? 0) } : null,
    balanceChanges: input.balanceChanges.map((b) => ({ address: b.address, coinType: b.coinType, amount: BigInt(b.amount) })),
    commands: ((ptb?.commands as Json[] | undefined) ?? []).map((c): RawCommand => {
      if (c.moveCall) return { kind: 'moveCall', package: c.moveCall.package, module: c.moveCall.module, function: c.moveCall.function, typeArguments: c.moveCall.typeArguments ?? [] }
      const kind = (['transferObjects', 'splitCoins', 'mergeCoins', 'publish', 'makeMoveVector', 'upgrade'] as const).find((k) => c[k]) ?? 'moveCall'
      return { kind }
    }),
    objectChanges: ((effects?.changedObjects as Json[] | undefined) ?? []).map((c) => {
      const inExists = c.inputState === 'INPUT_OBJECT_STATE_EXISTS'
      const outExists = c.outputState === 'OUTPUT_OBJECT_STATE_OBJECT_WRITE' || c.outputState === 'OUTPUT_OBJECT_STATE_PACKAGE_WRITE'
      return { objectId: c.objectId, type: c.objectType ?? null, created: !inExists && outExists, deleted: inExists && !outExists, inputOwner: jOwner(c.inputOwner), outputOwner: jOwner(c.outputOwner) }
    }),
    system: !!tx?.kind && tx.kind.kind !== 'PROGRAMMABLE_TRANSACTION',
  }
}

/** 实际花的 gas（计算 + 存储 − 返还）；没有 gas 信息时为 null */
export const feeOf = (tx: RawTx): bigint | null => (tx.gas ? tx.gas.computationCost + tx.gas.storageCost - tx.gas.storageRebate : null)

/**
 * 去掉 gas 的余额变化：付 gas 的地址的 SUI 变化里加回手续费（余额变化里 gas 已经扣掉了），变成 0 的不保留。
 * 手续费单独用 feeOf 报告
 */
export function balanceChangesWithoutGas(tx: RawTx): BalanceChange[] {
  const fee = feeOf(tx) ?? 0n
  const payer = tx.gasOwner ?? tx.sender
  return tx.balanceChanges
    .map((b) => (payer && fee && normalizeStructTag(b.coinType) === SUI_COIN_TYPE && normalizeSuiAddress(b.address) === normalizeSuiAddress(payer) ? { ...b, amount: b.amount + fee } : b))
    .filter((b) => b.amount !== 0n)
}
