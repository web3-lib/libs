/**
 * 交易历史（子路径 `@w3lib/solana-batch-call/history`）：把地址的交易整理成统一的 Activity（类型、方向、对手方、资产变化、手续费）。
 * 数据源可以换：默认 rpcHistory（getSignaturesForAddress 翻页 + getTransaction，免费节点就能用，节点失败自动切换），
 * 也可以传 heliusHistory 等；传多个时按顺序尝试。游标就是最后一条签名，换数据源也能接着翻
 */
import { base58 } from '@scure/base'

import { isAddress } from './address.js'
import type { RequestOptions, SolanaClient } from './client.js'
import { NATIVE_MINT, SOL_DECIMALS, SYSTEM_PROGRAM_ID } from './constants.js'
import { decodeInstruction, type DecodedInstruction } from './decode.js'
import { classify, describe, type AssetDelta, type Classified } from './describe.js'
import { formatUnits } from './layout.js'

export type ActivityType = 'transfer' | 'swap' | 'approve' | 'liquidity' | 'mint' | 'contract' | 'other'

export interface ActivityChange extends AssetDelta {}

export interface Activity {
  /** 交易签名 */
  hash: string
  /** 区块时间（unix 秒）；节点没有给时为 0 */
  time: number
  /** slot */
  block?: number
  status: 'success' | 'failed'
  type: ActivityType
  /** 对这个地址来说：资产只增加 in、只减少 out、转给自己 self；兑换等有增有减时不填 */
  direction?: 'in' | 'out' | 'self'
  /** 转账的对手方 */
  counterparty?: string
  /** 一句话说明，如 “Swap 1 SOL for 150 USDC on Jupiter” */
  label?: string
  /** 这个地址的资产变化（SOL 不含手续费，Wrapped SOL 并入 SOL；asset 原生为 'native'，其他是 mint） */
  changes: ActivityChange[]
  /** 这个地址付的手续费（lamports，十进制字符串）；不是手续费支付者时不填 */
  fee?: string
  protocol?: string
}

export interface HistoryPage {
  items: Activity[]
  /** 还有更多时：下一页的游标（最后一条处理过的签名）；没有更多时不返回 */
  nextCursor?: string
}

export interface HistoryContext {
  client: SolanaClient
  address: string
  limit: number
  cursor?: string
  /** 只要这个时间（unix 秒）之前 / 之后的 */
  before?: number
  after?: number
  types?: readonly ActivityType[]
  fetch: typeof fetch
  signal?: AbortSignal
}

/** 历史数据源：返回统一格式的 Activity（代币的 symbol 先用缩写的 mint，getHistory 统一补全）；游标是签名 */
export interface HistorySource {
  readonly name: string
  getHistory(ctx: HistoryContext): Promise<HistoryPage>
}

export interface HistoryOptions extends RequestOptions {
  /** 每页条数，默认 20，最多 100 */
  limit?: number
  /** 上一页的 nextCursor */
  cursor?: string
  /** 区块时间上限（不含）/ 下限（含），unix 秒 */
  before?: number
  after?: number
  /** 只要这些类型（不够 limit 时会往后多找，最多看 limit × 5 笔） */
  types?: readonly ActivityType[]
  /** 数据源，默认 rpcHistory()；传数组时按顺序尝试，前一个失败换下一个 */
  source?: HistorySource | readonly HistorySource[]
  /** 补全代币符号（读 mint 的元数据），默认 true */
  symbols?: boolean
  fetch?: typeof fetch
}

export const MAX_HISTORY_LIMIT = 100
/** getTransaction 支持的交易版本：主网已经有 v1 格式的交易（2026-10），只给 0 时遇到它们整个请求报错（-32015）；json 编码下 v1 的账户和指令字段与 v0 相同 */
const MAX_TX_VERSION = 1

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

/**
 * 查地址的交易历史。
 *
 * ```ts
 * const page = await history(client, address, { limit: 20 })
 * const next = await history(client, address, { cursor: page.nextCursor })
 * ```
 */
export async function history(client: SolanaClient, address: string, options: HistoryOptions = {}): Promise<HistoryPage> {
  if (!isAddress(address)) throw new Error(`Invalid address: ${address}`)
  const limit = options.limit ?? 20
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) throw new RangeError(`limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}`)
  const sources = options.source === undefined ? [rpcHistory()] : Array.isArray(options.source) ? options.source : [options.source as HistorySource]
  if (!sources.length) throw new Error('No history source')
  const ctx: HistoryContext = {
    client,
    address,
    limit,
    cursor: options.cursor,
    before: options.before,
    after: options.after,
    types: options.types?.length ? options.types : undefined,
    fetch: options.fetch ?? ((...args) => fetch(...args)),
    signal: options.signal,
  }
  const errors: string[] = []
  for (const source of sources) {
    try {
      const page = await (source as HistorySource).getHistory(ctx)
      if (options.symbols !== false) await fillSymbols(client, page.items, options.signal)
      return page
    } catch (err) {
      if (options.signal?.aborted) throw err
      errors.push(`${(source as HistorySource).name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`All history sources failed (${errors.join('; ')})`)
}

/** 补全还是缩写 mint 的 symbol（一次 tokens 查询，label 里的同步替换）；读不到的用缩写的 mint */
async function fillSymbols(client: SolanaClient, items: Activity[], signal: AbortSignal | undefined): Promise<void> {
  const pending = (c: ActivityChange) => c.symbol === short(c.asset)
  const missing = [...new Set(items.flatMap((a) => a.changes.filter(pending).map((c) => c.asset)))]
  if (!missing.length) return
  const details = await client.tokens(missing, { fields: ['symbol'], signal }).catch(() => null)
  const symbols = new Map(missing.map((m, i) => [m, details?.[i]?.symbol ?? short(m)]))
  for (const a of items) {
    for (const c of a.changes) {
      if (!pending(c)) continue
      const symbol = symbols.get(c.asset) as string
      if (a.label) a.label = a.label.split(c.symbol).join(symbol)
      c.symbol = symbol
    }
  }
}

// ---------------------------------------------------------------------------
// RPC 数据源
// ---------------------------------------------------------------------------

export interface RpcHistoryOptions {
  /** 同时取多少笔交易的详情，默认 6（公共节点限频很严，节点自己会对 429 退避重试） */
  concurrency?: number
  /** 一次翻页最多检查多少笔签名（含被 types / 时间过滤掉的），默认 limit × 5，最多 500 */
  maxScan?: number
}

interface RawTransaction {
  slot: number
  blockTime: number | null
  meta: {
    err: unknown
    fee: number
    preBalances: number[]
    postBalances: number[]
    preTokenBalances?: RawTokenBalance[]
    postTokenBalances?: RawTokenBalance[]
    loadedAddresses?: { writable: string[]; readonly: string[] }
  } | null
  transaction: {
    signatures: string[]
    message: { accountKeys: string[]; instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }> }
  }
}

interface RawTokenBalance {
  accountIndex: number
  mint: string
  owner?: string
  uiTokenAmount: { amount: string; decimals: number }
}

interface SignatureInfo {
  signature: string
  slot: number
  err: unknown
  blockTime: number | null
}

async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return results
}

/**
 * 默认数据源：getSignaturesForAddress（用 before 翻页）+ getTransaction（逐笔，json 编码、支持 v0）。
 * 先按区块时间过滤签名再取详情，只取需要的笔数；失败的交易也列出（status 为 failed）。每页的请求数 ≈ limit + 1
 */
export function rpcHistory(options: RpcHistoryOptions = {}): HistorySource {
  const concurrency = options.concurrency ?? 6
  return {
    name: 'rpc',
    async getHistory(ctx) {
      const { client, address, limit, signal } = ctx
      const maxScan = Math.min(options.maxScan ?? limit * 5, 500)
      const items: Activity[] = []
      let cursor = ctx.cursor
      let scanned = 0
      let more = true
      while (items.length < limit && scanned < maxScan && more) {
        const pageSize = Math.min(1000, Math.max(limit, 20) * (ctx.types ? 3 : 1))
        const commitment = client.commitment === 'processed' ? 'confirmed' : client.commitment
        const sigs = await client.request<SignatureInfo[]>('getSignaturesForAddress', [address, { limit: pageSize, ...(cursor ? { before: cursor } : {}), commitment }], { signal })
        if (!sigs.length) {
          more = false
          break
        }
        // 按时间过滤：比 before 新的跳过；比 after 旧的之后都不用看了（签名按从新到旧排列）
        let rows = sigs.filter((s) => ctx.before === undefined || s.blockTime === null || s.blockTime < ctx.before)
        const old = ctx.after === undefined ? -1 : rows.findIndex((s) => s.blockTime !== null && s.blockTime < (ctx.after as number))
        if (old >= 0) rows = rows.slice(0, old)
        let i = 0
        while (i < rows.length && items.length < limit && scanned < maxScan) {
          const chunk = rows.slice(i, i + Math.max(1, Math.min(limit - items.length, maxScan - scanned)))
          const txs = await pool(chunk, concurrency, (row) => client.request<RawTransaction | null>('getTransaction', [row.signature, { encoding: 'json', maxSupportedTransactionVersion: MAX_TX_VERSION, commitment }], { signal }))
          for (const [j, tx] of txs.entries()) {
            i++
            scanned++
            cursor = (chunk[j] as SignatureInfo).signature
            const activity = tx ? activityFromTransaction(address, tx) : null
            if (activity && (!ctx.types || ctx.types.includes(activity.type))) items.push(activity)
            if (items.length >= limit) break
          }
        }
        if (i >= rows.length) {
          // 这一页看完了：接着从这一页最后一条往后翻；没有更多（不足一页、或已经到 after）时结束
          cursor = (sigs[sigs.length - 1] as SignatureInfo).signature
          more = sigs.length >= pageSize && old < 0
        }
      }
      return { items, ...(more && cursor ? { nextCursor: cursor } : {}) }
    },
  }
}

const SOL: Pick<AssetDelta, 'asset' | 'symbol' | 'decimals'> = { asset: 'native', symbol: 'SOL', decimals: SOL_DECIMALS }

/** 合并资产变化：同一资产相加，去掉 0 */
function toChanges(native: bigint, tokens: Map<string, { delta: bigint; decimals: number }>): ActivityChange[] {
  const out: ActivityChange[] = []
  if (native !== 0n) out.push({ ...SOL, delta: native.toString(), formatted: formatUnits(native, SOL_DECIMALS) })
  for (const [asset, { delta, decimals }] of tokens) {
    if (delta !== 0n) out.push({ asset, symbol: short(asset), decimals, delta: delta.toString(), formatted: formatUnits(delta, decimals) })
  }
  return out
}

function directionOf(changes: readonly ActivityChange[], counterparty: string | undefined, address: string): Activity['direction'] {
  if (!changes.length) return counterparty === address ? 'self' : undefined
  const negative = changes.filter((c) => c.delta.startsWith('-')).length
  if (negative === 0) return 'in'
  return negative === changes.length ? 'out' : undefined
}

const toActivityType = (kind: Classified | null): ActivityType => (kind ? (kind.type === 'unknown' ? 'contract' : kind.type) : 'other')

/** 一笔 getTransaction（json 编码）整理成 Activity，address 的角度；导出供测试和自己取到交易的场景使用 */
export function activityFromTransaction(address: string, tx: RawTransaction): Activity | null {
  const meta = tx.meta
  const hash = tx.transaction.signatures[0]
  if (!meta || !hash) return null
  const message = tx.transaction.message
  const keys = [...message.accountKeys, ...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? [])]
  const failed = meta.err !== null && meta.err !== undefined
  const ixs: DecodedInstruction[] = message.instructions.map((ix, i) => {
    const programId = keys[ix.programIdIndex] as string
    return decodeInstruction(i, programId, ix.accounts.map((a) => keys[a] as string), base58.decode(ix.data))
  })

  const index = keys.indexOf(address)
  const isPayer = index === 0
  const fee = BigInt(meta.fee)
  let native = index >= 0 ? BigInt(meta.postBalances[index] ?? 0) - BigInt(meta.preBalances[index] ?? 0) + (isPayer ? fee : 0n) : 0n
  const tokens = new Map<string, { delta: bigint; decimals: number }>()
  const ownerOf = new Map<number, string>()
  for (const [list, sign] of [[meta.preTokenBalances ?? [], -1n], [meta.postTokenBalances ?? [], 1n]] as const) {
    for (const b of list) {
      if (b.owner) ownerOf.set(b.accountIndex, b.owner)
      if (b.owner !== address) continue
      const prev = tokens.get(b.mint)
      tokens.set(b.mint, { delta: (prev?.delta ?? 0n) + sign * BigInt(b.uiTokenAmount.amount), decimals: b.uiTokenAmount.decimals })
    }
  }
  // Wrapped SOL 并入 SOL
  const wsol = tokens.get(NATIVE_MINT)
  if (wsol) {
    native += wsol.delta
    tokens.delete(NATIVE_MINT)
  }
  const changes = failed ? [] : toChanges(native, tokens)

  // 对手方：第一笔转账的另一头（代币转账取代币账户的 owner）
  let counterparty: string | undefined
  for (const ix of ixs) {
    if (ix.type !== 'transfer') continue
    const args = ix.args as Record<string, string> | undefined
    const owner = (account: string | undefined) => (account ? (ownerOf.get(keys.indexOf(account)) ?? (ix.programId === SYSTEM_PROGRAM_ID ? account : undefined)) : undefined)
    const from = owner(args?.from ?? args?.source)
    const to = owner(args?.to ?? args?.destination)
    counterparty = from === address ? to : from
    if (counterparty) break
  }

  const kind = classify(ixs, changes)
  const type = toActivityType(kind)
  const label = describe(kind, ixs, changes, counterparty)
  return {
    hash,
    time: tx.blockTime ?? 0,
    block: tx.slot,
    status: failed ? 'failed' : 'success',
    type,
    direction: type === 'transfer' || type === 'other' ? directionOf(changes, counterparty, address) : undefined,
    counterparty,
    label: failed ? `Failed: ${label}` : label,
    changes,
    ...(isPayer ? { fee: fee.toString() } : {}),
    protocol: kind?.protocol,
  }
}
