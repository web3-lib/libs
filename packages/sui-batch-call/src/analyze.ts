/**
 * /simulate 和 /history 共用的分析：Move 调用 → 协议、交易类型、错误解码、对象变化。
 * 协议认的是本库已有的包（兑换、LP 用到的各 DEX）；调用里的包是升级后的 storage id，用 ListPackageVersions 的第一项（原始 id）对照
 */
import { SUI_COIN_TYPE, normalizeStructTag, normalizeSuiAddress } from './address.js'
import type { GrpcTransport } from './grpc.js'
import type { RawCommand, RawError, RawObjectChange, RawTx } from './rawTx.js'
import { listPackageVersions } from './services.js'

/**
 * 协议的包（原始 id）。和 swapTx 的 SWAP_PACKAGES + Cetus 核心包一致（test/simulate.test.ts 核对）；
 * 这里写成常量表，不 import 兑换的代码，/history 和 /simulate 的打包就不会带上各 DEX 的交易构建
 */
export const PROTOCOL_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  cetus: ['0x996c4d9480708fb8b92aa7acf819fb0497b5ec8e65ba06601cae2fb6db3312c3', '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb'],
  magma: ['0x668909f9f30380dd1b63834534dc2bd19b274e6312a0dfa9be0ee5b0cef73446'],
  bluefin: ['0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267'],
  momentum: ['0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860'],
  'kriya-clmm': ['0xf6c05e2d9301e6e91dc6ab6c3ca918f7d55896e1f1edd64adc0e615cde27ebf1'],
  turbos: ['0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1'],
  flowx: ['0x25929e7f29e0a30eb4e692952ba1b5b65a3a4d65ab5f2a32e1ba3edcb587f26d'],
  'cetus-dlmm': ['0x5664f9d3fd82c84023870cfbda8ea84e14c8dd56ce557ad2116e0668581a682b'],
  dipcoin: ['0xdae28ab9ab072c647c4e8f2057a8f17dcc4847e42d6a8258df4b376ae183c872'],
  'flowx-v2': ['0xba153169476e8c3114962261d1edc70de5ad9781b83cc617ecc8c1923191cae0'],
  'kriya-amm': ['0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66'],
  aftermath: ['0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c', '0x6f60a091637054e23915b8745c0c0d47b1d49618ee3435b5f68eccf6a44fb53d'],
}

const PROTOCOLS: ReadonlyMap<string, string> = new Map(Object.entries(PROTOCOL_PACKAGES).flatMap(([protocol, ids]) => ids.map((id): [string, string] => [normalizeSuiAddress(id), protocol])))

/** 协议的显示名 */
export const PROTOCOL_NAMES: Readonly<Record<string, string>> = {
  cetus: 'Cetus',
  magma: 'Magma',
  bluefin: 'Bluefin',
  momentum: 'Momentum',
  'kriya-clmm': 'Kriya CLMM',
  turbos: 'Turbos',
  flowx: 'FlowX',
  'cetus-dlmm': 'Cetus DLMM',
  dipcoin: 'DipCoin',
  'flowx-v2': 'FlowX V2',
  'kriya-amm': 'Kriya AMM',
  aftermath: 'Aftermath',
}

/** 系统包（0x1 std、0x2 sui framework、0x3 sui system 等） */
export const isFrameworkPackage = (id: string): boolean => /^0x0*[0-9a-f]$/i.test(id)

/** 包的 storage id → 原始 id（不会变，进程内一直缓存） */
const originals = new Map<string, Promise<string | null>>()

async function originalPackage(t: GrpcTransport, id: string, signal?: AbortSignal): Promise<string | null> {
  const key = normalizeSuiAddress(id)
  if (PROTOCOLS.has(key) || isFrameworkPackage(key)) return key
  let p = originals.get(key)
  if (!p) {
    p = listPackageVersions(t, key, { signal }).then((v) => (v[0] ? normalizeSuiAddress(v[0].packageId) : null))
    originals.set(key, p)
    p.catch(() => originals.delete(key))
    if (originals.size > 2000) originals.delete(originals.keys().next().value as string)
  }
  return p
}

export interface CallInfo {
  package: string
  module: string
  function: string
  /** 'package::module::function'（包为原始 id 的完整地址） */
  target: string
  /** 本库认得的协议（'cetus'、'bluefin'…）；不认得时为 null */
  protocol: string | null
  framework: boolean
}

/** 交易里的 Move 调用，按顺序；包解析失败（节点出错）时当作不认得 */
export async function decodeCalls(t: GrpcTransport, commands: readonly RawCommand[], signal?: AbortSignal): Promise<CallInfo[]> {
  const calls = commands.filter((c) => c.kind === 'moveCall')
  const ids = [...new Set(calls.map((c) => normalizeSuiAddress(c.package ?? '')))]
  const resolved = new Map(await Promise.all(ids.map(async (id) => [id, await originalPackage(t, id, signal).catch(() => null)] as const)))
  return calls.map((c) => {
    const pkg = normalizeSuiAddress(c.package ?? '')
    const original = resolved.get(pkg) ?? null
    return { package: pkg, module: c.module ?? '', function: c.function ?? '', target: `${pkg}::${c.module}::${c.function}`, protocol: original ? (PROTOCOLS.get(original) ?? null) : null, framework: isFrameworkPackage(pkg) }
  })
}

const SWAP_FN = /swap|exchange/i
const LIQUIDITY_FN = /liquidity|position|collect|add_|remove_|deposit|withdraw|claim|harvest/i

export type ActivityKind = 'transfer' | 'swap' | 'liquidity' | 'mint' | 'contract' | 'other'

export interface Classified {
  type: ActivityKind
  protocol: string | null
  /** 'module::function'（最后一个非系统调用；没有时为 null） */
  method: string | null
}

/**
 * 交易是什么：本库认得的 DEX 的 swap / 流动性函数；没有非系统调用的是转账；
 * 不认得的合约里发送者付出一种币、收到另一种币的当作兑换，收到新建的对象且函数名带 mint 的当作铸造
 */
export function classify(calls: readonly CallInfo[], tx: RawTx, owner: string, changes: ReadonlyArray<{ coinType: string; amount: bigint }>): Classified {
  const user = calls.filter((c) => !c.framework)
  const last = user.at(-1)
  const known = user.find((c) => c.protocol)
  const method = last ? `${last.module}::${last.function}` : null
  const base = { protocol: known?.protocol ?? null, method }
  if (tx.commands.some((c) => c.kind === 'publish' || c.kind === 'upgrade')) return { type: 'contract', ...base }
  const me = normalizeSuiAddress(owner)
  const received = changes.filter((c) => c.amount > 0n)
  const paid = changes.filter((c) => c.amount < 0n)
  const swapped = paid.some((p) => received.some((r) => r.coinType !== p.coinType))
  const gotObject = tx.objectChanges.some((o) => o.created && !isCoinType(o.type) && o.outputOwner?.address && normalizeSuiAddress(o.outputOwner.address) === me)
  if (known) {
    const fn = user.filter((c) => c.protocol).map((c) => c.function)
    if (fn.some((f) => SWAP_FN.test(f))) return { type: 'swap', ...base }
    if (fn.some((f) => LIQUIDITY_FN.test(f))) return { type: 'liquidity', ...base }
    return { type: swapped ? 'swap' : 'contract', ...base }
  }
  if (!user.length) return { type: tx.system ? 'other' : 'transfer', ...base }
  if (gotObject && user.some((c) => /mint/i.test(c.function))) return { type: 'mint', ...base }
  if (swapped) return { type: 'swap', ...base }
  if (user.some((c) => LIQUIDITY_FN.test(c.function) && /pool|liquidity|position/i.test(`${c.module}${c.function}`))) return { type: 'liquidity', ...base }
  return { type: 'contract', ...base }
}

export const isCoinType = (type: string | null): boolean => !!type && /^0x0*2::coin::Coin</.test(type)

/** 对象变化的分类（站在 owner 的角度） */
export interface ObjectChangeInfo {
  objectId: string
  type: string | null
  /** created 新建；deleted 删除（或包装）；transferred 所有者变了；mutated 只是内容变了 */
  kind: 'created' | 'deleted' | 'transferred' | 'mutated'
  /** 交易前 / 后的所有者（地址、共享、对象所有…）；没有时为 null */
  from: string | null
  to: string | null
  /** 是 Coin 对象（Coin 的数量变化已经在余额变化里） */
  coin: boolean
}

const ownerLabel = (o: RawObjectChange['inputOwner']): string | null => (!o ? null : o.address ? normalizeSuiAddress(o.address) : o.kind)

export function describeObjectChanges(changes: readonly RawObjectChange[]): ObjectChangeInfo[] {
  return changes.map((c) => {
    const from = ownerLabel(c.inputOwner)
    const to = ownerLabel(c.outputOwner)
    return { objectId: c.objectId, type: c.type, kind: c.created ? 'created' : c.deleted ? 'deleted' : from !== to ? 'transferred' : 'mutated', from, to, coin: isCoinType(c.type) }
  })
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 系统包里常见的 abort 码（0x2 的函数里报的） */
const FRAMEWORK_ABORTS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  balance: { 0: 'ENonZero (balance is not zero)', 1: 'EOverflow (balance overflow)', 2: 'ENotEnough (not enough balance)' },
  coin: { 0: 'EBadWitness', 1: 'EInvalidArg', 2: 'ENotEnough (not enough balance to split)', 3: 'EGlobalPauseNotAllowed' },
  transfer: { 0: 'EBCSSerializationFailure', 1: 'EReceivingObjectTypeMismatch', 2: 'EUnableToReceiveObject', 3: 'EShareEventNotSupported' },
}

const KIND_TEXT: Readonly<Record<string, string>> = {
  INSUFFICIENT_GAS: 'Gas budget is too low for this transaction',
  INSUFFICIENT_COIN_BALANCE: 'Not enough coin balance',
  INSUFFICIENT_FUNDS_FOR_WITHDRAW: 'Not enough address balance to withdraw',
  COIN_BALANCE_OVERFLOW: 'Coin balance overflow',
  ADDRESS_DENIED_FOR_COIN: 'An address involved is denied (frozen) for this coin',
  COIN_TYPE_GLOBAL_PAUSE: 'This coin is globally paused',
  INPUT_OBJECT_DELETED: 'An input object no longer exists',
  EXECUTION_CANCELED_DUE_TO_CONSENSUS_OBJECT_CONGESTION: 'Cancelled: a shared object is congested',
  FUNCTION_NOT_FOUND: 'The called function does not exist',
  NON_ENTRY_FUNCTION_INVOKED: 'The function is not callable from a transaction',
  INVALID_GAS_OBJECT: 'Invalid gas object',
  MOVE_PRIMITIVE_RUNTIME_ERROR: 'Move runtime error (arithmetic overflow, out of bounds, …)',
}

export interface DecodedError {
  /** 可读的错误说明 */
  message: string
  /** 错误类型（MOVE_ABORT、INSUFFICIENT_GAS…） */
  kind: string | null
  /** Move abort 的信息 */
  abort?: { code: string; target: string | null; name: string | null }
}

/** 把节点给的执行错误转成可读的说明：Move abort 带上函数、码和（新式错误的）常量名，系统包的常见码给出名字 */
export function decodeError(error: RawError | null): DecodedError | null {
  if (!error) return null
  const a = error.abort
  if (a) {
    const pkg = a.package ? normalizeSuiAddress(a.package) : null
    const target = pkg && a.module ? `${pkg}::${a.module}${a.function ? `::${a.function}` : ''}` : null
    const framework = pkg && isFrameworkPackage(pkg) && a.module ? FRAMEWORK_ABORTS[a.module]?.[Number(a.code)] : undefined
    const name = a.constant ?? framework ?? null
    const detail = a.message ? `: ${a.message}` : ''
    return { kind: error.kind, message: `Move abort${target ? ` in ${target}` : ''} with code ${a.code}${name ? ` (${name})` : ''}${detail}`, abort: { code: a.code.toString(), target, name } }
  }
  const text = error.kind ? KIND_TEXT[error.kind] : undefined
  return { kind: error.kind, message: text ? `${text} (${error.description})` : error.description }
}

/** 币类型规范化（节点给的已经是规范格式；以防万一） */
export const coinKey = (coinType: string): string => {
  try {
    return normalizeStructTag(coinType)
  } catch {
    return coinType
  }
}

export const isSui = (coinType: string): boolean => coinKey(coinType) === SUI_COIN_TYPE

// ---------------------------------------------------------------------------
// 站在某个地址的角度看一笔交易
// ---------------------------------------------------------------------------

export const shortAddress = (a: string): string => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a)
const shortType = (t: string): string => t.split('::').slice(1).join('::') || t

export interface Perspective {
  /** 这个地址的余额变化（已去掉 gas） */
  mine: Array<{ coinType: string; amount: bigint }>
  direction: 'in' | 'out' | 'self' | undefined
  /** 对方：转出时是收到同一种币的地址（没有币时是收到对象的地址），转入时是发送者 */
  counterparty: string | undefined
  /** 这个地址收到 / 送出的非 Coin 对象（NFT 等） */
  objectsIn: ObjectChangeInfo[]
  objectsOut: ObjectChangeInfo[]
}

export function perspective(tx: RawTx, owner: string, changes: ReadonlyArray<{ address: string; coinType: string; amount: bigint }>, objects: readonly ObjectChangeInfo[]): Perspective {
  const me = normalizeSuiAddress(owner)
  const same = (a: string | null) => !!a && a.startsWith('0x') && normalizeSuiAddress(a) === me
  const mine = changes.filter((c) => normalizeSuiAddress(c.address) === me)
  const objectsIn = objects.filter((o) => !o.coin && o.kind !== 'mutated' && same(o.to) && !same(o.from))
  const objectsOut = objects.filter((o) => !o.coin && o.kind === 'transferred' && same(o.from) && !same(o.to))
  const sender = tx.sender ? normalizeSuiAddress(tx.sender) : null
  const out = mine.find((c) => c.amount < 0n)
  const into = mine.find((c) => c.amount > 0n)
  let counterparty: string | undefined
  if (out && !into) counterparty = changes.find((c) => c.coinType === out.coinType && c.amount > 0n && normalizeSuiAddress(c.address) !== me)?.address
  else if (into && !out) counterparty = sender && sender !== me ? sender : undefined
  counterparty ??= objectsOut[0]?.to?.startsWith('0x') ? (objectsOut[0].to ?? undefined) : objectsIn[0] && sender !== me ? (sender ?? undefined) : undefined
  const outflow = !!out || objectsOut.length > 0
  const inflow = !!into || objectsIn.length > 0
  const direction = outflow && !inflow ? 'out' : inflow && !outflow ? 'in' : undefined
  return { mine, direction: direction ?? (sender === me && !mine.length && counterparty === me ? 'self' : undefined), counterparty, objectsIn, objectsOut }
}

export interface NamedChange {
  coinType: string
  symbol: string | null
  formatted: string
  amount: bigint
}

const amountText = (c: NamedChange) => `${c.formatted.replace(/^-/, '')} ${c.symbol ?? shortType(c.coinType)}`

/** 一句话描述（英文，同其他链的 summary / label） */
export function summarize(kind: ActivityKind | 'unknown', c: Classified, p: Perspective, changes: readonly NamedChange[], calls: readonly CallInfo[], failed = false): string {
  const proto = c.protocol ? (PROTOCOL_NAMES[c.protocol] ?? c.protocol) : null
  const paid = changes.filter((x) => x.amount < 0n)
  const got = changes.filter((x) => x.amount > 0n)
  const list = (xs: readonly NamedChange[]) => xs.map(amountText).join(' + ')
  let text: string
  if (kind === 'swap') text = `Swap ${list(paid) || '?'} for ${list(got) || '?'}${proto ? ` on ${proto}` : ''}`
  else if (kind === 'liquidity') {
    const parts = [paid.length ? `pay ${list(paid)}` : '', got.length ? `receive ${list(got)}` : ''].filter(Boolean).join(', ')
    text = `Liquidity change${proto ? ` on ${proto}` : ''}${c.method ? ` (${c.method})` : ''}${parts ? `: ${parts}` : ''}`
  } else if (kind === 'transfer') {
    const nft = p.objectsOut[0] ?? p.objectsIn[0]
    const what = paid.length ? list(paid) : got.length ? list(got) : nft ? `object ${shortType(nft.type ?? nft.objectId)}` : 'objects'
    const who = p.counterparty ? shortAddress(p.counterparty) : null
    text = p.direction === 'in' ? `Receive ${what}${who ? ` from ${who}` : ''}` : `Send ${what}${who ? ` to ${who}` : ''}`
  } else if (kind === 'mint') text = `Mint ${p.objectsIn[0] ? shortType(p.objectsIn[0].type ?? 'object') : 'object'}${proto ? ` on ${proto}` : ''}`
  else if (c.method) {
    const last = calls.filter((x) => !x.framework).at(-1)
    text = `Call ${proto ? `${proto} ` : last ? `${shortAddress(last.package)}::` : ''}${c.method}`
  } else text = kind === 'other' ? 'System transaction' : 'Transaction'
  return failed ? `${text} (failed)` : text
}
