/**
 * 用到的 gRPC 方法（sui.rpc.v2，字段号按 MystenLabs/sui-apis 的 proto）：请求编码、响应解析
 */
import type { CallOptions, GrpcResponse, GrpcTransport } from './grpc.js'
import { GrpcError } from './grpc.js'
import { ProtoMessage, ProtoWriter, decodeValue, fieldMask } from './proto.js'

const STATE = 'sui.rpc.v2.StateService'
const LEDGER = 'sui.rpc.v2.LedgerService'

export interface ServiceInfo {
  /** 创世 checkpoint 的摘要（base58） */
  chainId: string | null
  /** 'mainnet' / 'testnet' / … */
  chain: string | null
  epoch: bigint | null
  checkpointHeight: bigint | null
}

export async function getServiceInfo(t: GrpcTransport, options?: CallOptions): Promise<ServiceInfo> {
  const { message: m } = await t.unary(`${LEDGER}/GetServiceInfo`, new Uint8Array(), options)
  return { chainId: m.string(1), chain: m.string(2), epoch: m.uint(3), checkpointHeight: m.uint(4) }
}

export interface BalanceEntry {
  coinType: string
  /** 总余额（Coin 对象 + 地址余额） */
  balance: bigint
  /** 地址余额（Address Balances，不在 Coin 对象里的部分） */
  addressBalance: bigint
  /** Coin 对象里的部分 */
  coinBalance: bigint
}

function parseBalance(m: ProtoMessage): BalanceEntry {
  const balance = m.uint(3) ?? 0n
  const addressBalance = m.uint(4) ?? 0n
  return { coinType: m.string(1) ?? '', balance, addressBalance, coinBalance: m.uint(5) ?? balance - addressBalance }
}

export async function getBalance(t: GrpcTransport, owner: string, coinType: string, options?: CallOptions): Promise<{ balance: BalanceEntry; checkpoint: number | null }> {
  const res = await t.unary(`${STATE}/GetBalance`, new ProtoWriter().string(1, owner).string(2, coinType).finish(), options)
  const b = res.message.message(1)
  return { balance: b ? parseBalance(b) : { coinType, balance: 0n, addressBalance: 0n, coinBalance: 0n }, checkpoint: res.checkpoint }
}

/** 地址持有的全部代币余额（自动翻页）；checkpoint 是各页读取时节点高度的最小值 */
export async function listBalances(t: GrpcTransport, owner: string, options?: CallOptions & { maxPages?: number }): Promise<{ balances: BalanceEntry[]; checkpoint: number | null }> {
  const out: BalanceEntry[] = []
  let checkpoint: number | null = null
  let token: Uint8Array | null = null
  for (let page = 0; page < (options?.maxPages ?? 50); page++) {
    const res: GrpcResponse = await t.unary(`${STATE}/ListBalances`, new ProtoWriter().string(1, owner).uint(2, 1000).bytes(3, token).finish(), options)
    out.push(...res.message.messages(1).map(parseBalance))
    if (res.checkpoint !== null) checkpoint = checkpoint === null ? res.checkpoint : Math.min(checkpoint, res.checkpoint)
    token = res.message.bytes(2)
    if (!token?.length) break
  }
  return { balances: out, checkpoint }
}

export interface CoinInfo {
  coinType: string
  decimals: number | null
  name: string | null
  symbol: string | null
  description: string | null
  iconUrl: string | null
  /** CoinMetadata 对象的 ID */
  metadataId: string | null
  /** TreasuryCap 记录的总供应量（读不到时为 null） */
  totalSupply: bigint | null
}

/** 代币信息；代币不存在时为 null */
export async function getCoinInfo(t: GrpcTransport, coinType: string, options?: CallOptions): Promise<CoinInfo | null> {
  let m: ProtoMessage
  try {
    m = (await t.unary(`${STATE}/GetCoinInfo`, new ProtoWriter().string(1, coinType).finish(), options)).message
  } catch (err) {
    if (err instanceof GrpcError && err.code === 5) return null // NOT_FOUND
    throw err
  }
  const meta = m.message(2)
  const treasury = m.message(3)
  const empty = (s: string | null) => (s === '' ? null : s)
  return {
    coinType: m.string(1) ?? coinType,
    decimals: meta?.number(2) ?? null,
    name: empty(meta?.string(3) ?? null),
    symbol: empty(meta?.string(4) ?? null),
    description: empty(meta?.string(5) ?? null),
    iconUrl: empty(meta?.string(6) ?? null),
    metadataId: meta?.string(1) ?? null,
    totalSupply: treasury?.uint(2) ?? null,
  }
}

/** 所有者：kind 1 地址、2 对象、3 共享、4 不可变、5 共识地址 */
export type OwnerKind = 'address' | 'object' | 'shared' | 'immutable' | 'consensus-address' | 'unknown'

export interface ObjectOwner {
  kind: OwnerKind
  /** address / object / consensus-address 时为所有者地址 */
  address: string | null
  /** shared 时为初始共享版本 */
  initialSharedVersion: bigint | null
}

export interface SuiObject {
  objectId: string
  version: bigint | null
  digest: string | null
  type: string | null
  owner: ObjectOwner | null
  /** Move 对象的内容（JSON，需要 read mask 包含 json） */
  json: unknown
  /** Display 渲染结果（需要 read mask 包含 display）；没有 Display 时为 null */
  display: Record<string, unknown> | null
  /** Coin 对象的余额 */
  balance: bigint | null
  previousTransaction: string | null
  storageRebate: bigint | null
  /** BCS 编码的内容（需要 read mask 包含 contents） */
  contents: Uint8Array | null
}

const OWNER_KINDS: Record<number, OwnerKind> = { 1: 'address', 2: 'object', 3: 'shared', 4: 'immutable', 5: 'consensus-address' }

export function parseObject(m: ProtoMessage): SuiObject {
  const owner = m.message(5)
  const display = m.message(102)
  const output = display ? decodeValue(display.message(1)) : null
  const contents = m.message(8)
  return {
    objectId: m.string(2) ?? '',
    version: m.uint(3),
    digest: m.string(4),
    type: m.string(6),
    owner: owner
      ? {
          kind: OWNER_KINDS[owner.number(1) ?? 0] ?? 'unknown',
          address: owner.string(2),
          initialSharedVersion: owner.number(1) === 3 ? owner.uint(3) : null,
        }
      : null,
    json: m.has(100) ? decodeValue(m.message(100)) : null,
    display: output && typeof output === 'object' && !Array.isArray(output) ? (output as Record<string, unknown>) : null,
    balance: m.uint(101),
    previousTransaction: m.string(10),
    storageRebate: m.uint(11),
    // Bcs { name = 1, value = 2 }
    contents: contents?.bytes(2) ?? null,
  }
}

/** 一次读多个对象：结果与 ids 一一对应，不存在的为 null */
export async function batchGetObjects(t: GrpcTransport, ids: readonly string[], paths: readonly string[], options?: CallOptions): Promise<Array<SuiObject | null>> {
  const w = new ProtoWriter()
  for (const id of ids) w.message(1, new ProtoWriter().string(1, id))
  w.message(2, fieldMask(paths))
  const { message } = await t.unary(`${LEDGER}/BatchGetObjects`, w.finish(), options)
  const results = message.messages(1)
  return ids.map((_, i) => {
    const r = results[i]
    const object = r?.message(1)
    return object ? parseObject(object) : null
  })
}

/** 地址拥有的对象（一页）；type 可以是完整类型或模块 / 包前缀（如 '0x2::coin::Coin'） */
export async function listOwnedObjects(
  t: GrpcTransport,
  owner: string,
  paths: readonly string[],
  page: { type?: string; pageSize?: number; pageToken?: Uint8Array | null },
  options?: CallOptions,
): Promise<{ objects: SuiObject[]; nextPageToken: Uint8Array | null }> {
  const w = new ProtoWriter()
    .string(1, owner)
    .uint(2, page.pageSize ?? 1000)
    .bytes(3, page.pageToken ?? null)
    .message(4, fieldMask(paths))
    .string(5, page.type)
  const { message } = await t.unary(`${STATE}/ListOwnedObjects`, w.finish(), options)
  const token = message.bytes(2)
  return { objects: message.messages(1).map(parseObject), nextPageToken: token?.length ? token : null }
}

// ---------------------------------------------------------------------------
// 写操作用到的：epoch（参考 gas 价格）、模拟、执行、查交易
// ---------------------------------------------------------------------------

const EXECUTION = 'sui.rpc.v2.TransactionExecutionService'

export async function getEpoch(t: GrpcTransport, options?: CallOptions): Promise<{ epoch: bigint; referenceGasPrice: bigint }> {
  const { message } = await t.unary(`${LEDGER}/GetEpoch`, new ProtoWriter().message(2, fieldMask(['epoch', 'reference_gas_price'])).finish(), options)
  const e = message.message(1)
  return { epoch: e?.uint(1) ?? 0n, referenceGasPrice: e?.uint(8) ?? 0n }
}

export interface GasUsed {
  computationCost: bigint
  storageCost: bigint
  storageRebate: bigint
  nonRefundableStorageFee: bigint
}

export interface ChangedObjectRef {
  objectId: string
  /** 交易后的版本和摘要（被删除 / 包装的对象没有） */
  version: bigint | null
  digest: string | null
}

export interface ExecutionResult {
  digest: string | null
  success: boolean
  /** 失败原因（Move abort、余额不足等） */
  error: string | null
  gasUsed: GasUsed | null
  changedObjects: ChangedObjectRef[]
  checkpoint: bigint | null
  /** 余额变化（地址、代币类型、数量，可能为负）；只在请求了 balanceChanges 时有 */
  balanceChanges?: BalanceChange[]
}

export interface BalanceChange {
  address: string
  coinType: string
  amount: bigint
}

function parseExecuted(m: ProtoMessage | null): ExecutionResult {
  const effects = m?.message(4)
  const status = effects?.message(4)
  const gas = effects?.message(6)
  const error = status?.message(2)
  return {
    digest: m?.string(1) ?? effects?.string(7) ?? null,
    success: status?.bool(1) ?? false,
    error: status?.bool(1) ? null : (error?.string(1) ?? 'execution failed'),
    gasUsed: gas ? { computationCost: gas.uint(1) ?? 0n, storageCost: gas.uint(2) ?? 0n, storageRebate: gas.uint(3) ?? 0n, nonRefundableStorageFee: gas.uint(4) ?? 0n } : null,
    changedObjects: (effects?.messages(12) ?? []).map((c) => ({ objectId: c.string(1) ?? '', version: c.uint(7), digest: c.string(8) })),
    checkpoint: m?.uint(6) ?? null,
    ...(m?.has(8) ? { balanceChanges: m.messages(8).map((b) => ({ address: b.string(1) ?? '', coinType: b.string(2) ?? '', amount: BigInt(b.string(3) ?? '0') })) } : {}),
  }
}

const EFFECT_PATHS = ['digest', 'effects.status', 'effects.gas_used', 'effects.changed_objects', 'effects.transaction_digest', 'checkpoint']

/** 模拟执行（交易字节已编码好）：返回执行结果，不需要签名；balanceChanges 为 true 时同时返回余额变化 */
export async function simulateTransaction(t: GrpcTransport, transaction: Uint8Array, options?: CallOptions, extra?: { balanceChanges?: boolean }): Promise<ExecutionResult> {
  const paths = extra?.balanceChanges ? [...EFFECT_PATHS, 'balance_changes'] : EFFECT_PATHS
  const req = new ProtoWriter()
    .message(1, new ProtoWriter().message(1, new ProtoWriter().bytes(2, transaction)))
    .message(2, fieldMask(paths.map((p) => `transaction.${p}`)))
  const { message } = await t.unary(`${EXECUTION}/SimulateTransaction`, req.finish(), options)
  const result = parseExecuted(message.message(1))
  // 请求了余额变化但没有变化时为 []（响应里没有这个字段）
  return extra?.balanceChanges ? { ...result, balanceChanges: result.balanceChanges ?? [] } : result
}

/**
 * 只读调用（不检查交易：可以调用任何 public 函数、发送者随意、不需要 gas 币）：返回每条命令的返回值（节点解码的 JSON）。
 * 用来读合约里算出来的值（如未领取的手续费）
 */
export async function inspectTransaction(
  t: GrpcTransport,
  transaction: Uint8Array,
  options?: CallOptions,
): Promise<{ result: ExecutionResult; outputs: unknown[][] }> {
  const req = new ProtoWriter()
    .message(1, new ProtoWriter().message(1, new ProtoWriter().bytes(2, transaction)))
    .message(2, fieldMask([...EFFECT_PATHS.map((p) => `transaction.${p}`), 'command_outputs']))
    .uint(3, 1) // checks: DISABLED
  const { message } = await t.unary(`${EXECUTION}/SimulateTransaction`, req.finish(), options)
  return {
    result: parseExecuted(message.message(1)),
    outputs: message.messages(2).map((c) => c.messages(1).map((o) => decodeValue(o.message(3)))),
  }
}

/** 执行已签名的交易（同一笔签名交易重复提交是安全的：同样的对象版本只能执行一次） */
export async function executeTransaction(t: GrpcTransport, transaction: Uint8Array, signatures: readonly Uint8Array[], options?: CallOptions): Promise<ExecutionResult> {
  const req = new ProtoWriter().message(1, new ProtoWriter().message(1, new ProtoWriter().bytes(2, transaction)))
  for (const s of signatures) req.message(2, new ProtoWriter().message(1, new ProtoWriter().bytes(2, s)))
  req.message(3, fieldMask(EFFECT_PATHS))
  const { message } = await t.unary(`${EXECUTION}/ExecuteTransaction`, req.finish(), options)
  return parseExecuted(message.message(1))
}

/** 按摘要查交易的执行结果；节点上还没有时为 null */
export async function getTransaction(t: GrpcTransport, digest: string, options?: CallOptions): Promise<ExecutionResult | null> {
  try {
    const { message } = await t.unary(`${LEDGER}/GetTransaction`, new ProtoWriter().string(1, digest).message(2, fieldMask(EFFECT_PATHS)).finish(), options)
    return parseExecuted(message.message(1))
  } catch (err) {
    if (err instanceof GrpcError && err.code === 5) return null
    throw err
  }
}

const PACKAGES = 'sui.rpc.v2.MovePackageService'

/** 一个包的全部版本（升级后的各个 storage id），按版本从低到高 */
export async function listPackageVersions(t: GrpcTransport, packageId: string, options?: CallOptions): Promise<Array<{ packageId: string; version: bigint }>> {
  const out: Array<{ packageId: string; version: bigint }> = []
  let token: Uint8Array | null = null
  do {
    const res: GrpcResponse = await t.unary(`${PACKAGES}/ListPackageVersions`, new ProtoWriter().string(1, packageId).uint(2, 1000).bytes(3, token).finish(), options)
    for (const v of res.message.messages(1)) out.push({ packageId: v.string(1) ?? '', version: v.uint(2) ?? 0n })
    const next = res.message.bytes(2)
    token = next?.length ? next : null
  } while (token)
  return out.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0))
}
