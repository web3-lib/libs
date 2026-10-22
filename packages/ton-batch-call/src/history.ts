/**
 * 交易历史（子路径 `@w3lib/ton-batch-call/history`）：一个地址的活动，统一成 Activity（兑换、转账、流动性、增发、失败）。
 * 数据源是可插拔的适配器：默认先用 toncenter v3 的 `/actions`（索引器已分类的动作：jetton_swap、jetton_transfer、ton_transfer、
 * nft_transfer、dex_deposit_liquidity …，同一条交易链的动作合成一条活动），出错时退回 `/transactions` + `/jetton/transfers`；
 * 应用有自己的服务（带 Key 的 toncenter、tonapi 等）时传 `adapters`。请求都走 TonClient 的传输层（限频、重试、多节点故障切换）
 */
import { isValidTonAddress, toFriendlyAddress, toRawAddress } from './address.js'
import type { TonClient } from './client.js'
import { TON_DECIMALS } from './constants.js'
import { formatUnits } from './format.js'
import { base64ToBytes, bytesToHex } from './write/cell.js'

export type ActivityType = 'transfer' | 'swap' | 'approve' | 'liquidity' | 'mint' | 'contract' | 'other'

export interface ActivityChange {
  /** 'native'（TON）或 Jetton 主合约（用户友好格式） */
  asset: string
  symbol: string
  decimals: number
  /** 带符号的最小单位（对这个地址来说：负为付出，正为收到） */
  delta: string
  formatted: string
}

export interface Activity {
  /** 交易链的外部消息规范化哈希（十六进制，同 /write 的 hash），拿不到时为 trace id 的十六进制 */
  hash: string
  /** unix 秒 */
  time: number
  /** 主链区块号 */
  block?: number
  status: 'success' | 'failed'
  type: ActivityType
  direction?: 'in' | 'out' | 'self'
  /** 对方（用户友好格式），多个对方时没有 */
  counterparty?: string
  /** 一句话说明，如 “Swapped 1 USD₮ for 0.74 TON on STON.fi v2” */
  label?: string
  changes: ActivityChange[]
  /** 钱包付的手续费（nanoTON）；数据源给不出时没有 */
  fee?: string
  protocol?: string
}

export interface HistoryPage {
  items: Activity[]
  /** 下一页的游标；没有更多时没有 */
  nextCursor?: string
}

export interface HistoryQuery {
  /** 地址（原始格式 0:…） */
  address: string
  /** 一页多少条（适配器按自己的单位分页，/actions 是动作数，同一条交易链的动作合成一条，所以可能少于它） */
  limit: number
  /** 适配器自己的游标（getHistory 的 cursor 去掉适配器名前缀） */
  cursor?: string
  /** 只要这个时间（unix 秒）之前 / 之后的 */
  before?: number
  after?: number
  client: TonClient
  signal?: AbortSignal
}

/** 数据源：把一页历史转成 Activity。自己的服务（带 Key 的 toncenter、tonapi …）实现它传给 `adapters` */
export interface HistoryAdapter {
  /** 名字：放在游标前面，翻页时用同一个适配器 */
  readonly name: string
  fetch(query: HistoryQuery): Promise<HistoryPage>
}

export interface HistoryOptions {
  /** 一页多少条，默认 20，最多 100 */
  limit?: number
  /** 上一页的 nextCursor */
  cursor?: string
  /** unix 秒：只要这个时间之前 / 之后的 */
  before?: number
  after?: number
  /** 只要这些类型。在拿到的结果里过滤，会连续翻页（最多 maxPages 页）直到凑够 limit 条，所以可能多于 limit */
  types?: readonly ActivityType[]
  /** 数据源，依次尝试（出错换下一个），默认 [toncenterActions(), toncenterTransactions()] */
  adapters?: readonly HistoryAdapter[]
  /** 带 types 过滤时最多翻几页，默认 5 */
  maxPages?: number
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// 共用
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>
interface Book {
  [raw: string]: { user_friendly?: string | null } | undefined
}
interface Meta {
  [raw: string]: { token_info?: Array<{ valid?: boolean; type?: string; symbol?: string | null; extra?: { decimals?: unknown } | null }> } | undefined
}

const DEX: Record<string, string> = { stonfi_v2: 'STON.fi v2', stonfi: 'STON.fi v1', dedust: 'DeDust' }
const hexOf = (b64: string | null | undefined) => (b64 ? bytesToHex(base64ToBytes(b64)) : null)
const addr = (v: unknown): string | null => (typeof v === 'string' && isValidTonAddress(v) ? toRawAddress(v) : null)
const big = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? '0'))
  } catch {
    return 0n
  }
}

/** 一个地址的币种信息：先用响应里的元数据，缺的向索引器问一次 */
async function assetInfo(client: TonClient, masters: readonly string[], meta: Meta | undefined, signal?: AbortSignal): Promise<Map<string, { symbol: string; decimals: number; address: string }>> {
  const out = new Map<string, { symbol: string; decimals: number; address: string }>()
  const missing: string[] = []
  for (const m of masters) {
    const info = (meta?.[m.toUpperCase()] ?? meta?.[m])?.token_info?.find((t) => t.valid !== false && t.type === 'jetton_masters')
    const decimals = Number(info?.extra?.decimals)
    if (info?.symbol && Number.isInteger(decimals)) out.set(m, { symbol: info.symbol, decimals, address: toFriendlyAddress(m, { testOnly: client.network === 'testnet' }) })
    else missing.push(m)
  }
  if (missing.length) {
    const details = await client.jettons(missing, { signal }).catch(() => [])
    details.forEach((d, i) => out.set(missing[i] as string, { symbol: d.symbol ?? `${d.address.slice(0, 6)}…`, decimals: d.decimals, address: d.address }))
  }
  return out
}

/** 同一资产的变化合并，去掉 0；asset 为 null 表示 TON */
function toChanges(raw: Array<{ asset: string | null; delta: bigint }>, info: Map<string, { symbol: string; decimals: number; address: string }>): ActivityChange[] {
  const sums = new Map<string, bigint>()
  for (const c of raw) sums.set(c.asset ?? 'native', (sums.get(c.asset ?? 'native') ?? 0n) + c.delta)
  const out: ActivityChange[] = []
  for (const [key, delta] of sums) {
    if (delta === 0n) continue
    const i = key === 'native' ? { symbol: 'TON', decimals: TON_DECIMALS, address: 'native' } : (info.get(key) ?? { symbol: `${key.slice(2, 8)}…`, decimals: TON_DECIMALS, address: key })
    out.push({ asset: i.address, symbol: i.symbol, decimals: i.decimals, delta: delta.toString(), formatted: formatUnits(delta, i.decimals) })
  }
  return out
}

const describeChanges = (changes: readonly ActivityChange[], sign: 1 | -1) =>
  changes
    .filter((c) => (BigInt(c.delta) > 0n ? 1 : -1) === sign)
    .map((c) => `${c.formatted.replace('-', '')} ${c.symbol}`)
    .join(' + ')

// ---------------------------------------------------------------------------
// 适配器 1：toncenter /actions
// ---------------------------------------------------------------------------

interface ActionRow {
  trace_id?: string | null
  start_utime?: number
  trace_mc_seqno_end?: number
  trace_external_hash?: string | null
  trace_external_hash_norm?: string | null
  success?: boolean
  type: string
  details?: Json
}

/** call_contract 里不值得单独成一条的：多余 TON 退回（excess） */
const OP_EXCESS = '0xd53276db'
const PRIORITY: Record<ActivityType, number> = { swap: 6, liquidity: 5, mint: 4, transfer: 3, approve: 3, contract: 2, other: 1 }

interface Classified {
  type: ActivityType
  noise: boolean
  protocol?: string
  /** 'in' | 'out'：这个地址是收款还是付款方（转账） */
  dir?: 'in' | 'out'
  counterparty?: string | null
  changes: Array<{ asset: string | null; delta: bigint }>
  label: string
}

function classify(a: ActionRow, me: string): Classified {
  const d = a.details ?? {}
  const base = (type: ActivityType, label: string, extra: Partial<Classified> = {}): Classified => ({ type, noise: false, changes: [], label, ...extra })
  switch (a.type) {
    case 'ton_transfer': {
      const [from, to, value] = [addr(d.source), addr(d.destination), big(d.value)]
      const out = from === me
      return base('transfer', '', { dir: out ? 'out' : 'in', counterparty: out ? to : from, changes: [{ asset: null, delta: out ? -value : to === me ? value : 0n }] })
    }
    case 'jetton_transfer': {
      const [from, to, amount, asset] = [addr(d.sender), addr(d.receiver), big(d.amount), addr(d.asset)]
      const out = from === me
      return base('transfer', '', { dir: out ? 'out' : 'in', counterparty: out ? to : from, changes: [{ asset, delta: out ? -amount : to === me ? amount : 0n }] })
    }
    case 'nft_transfer': {
      const [from, to] = [addr(d.old_owner), addr(d.new_owner)]
      const out = from === me
      return base('transfer', out ? 'Sent an NFT' : 'Received an NFT', { dir: out ? 'out' : 'in', counterparty: out ? to : from })
    }
    case 'jetton_swap': {
      const inc = (d.dex_incoming_transfer ?? {}) as Json
      const outg = (d.dex_outgoing_transfer ?? {}) as Json
      if (addr(d.sender) !== me) return base('other', 'Swap', { noise: true })
      const protocol = DEX[String(d.dex)] ?? (d.dex ? String(d.dex) : undefined)
      return base('swap', '', { ...(protocol ? { protocol } : {}), changes: [{ asset: addr(inc.asset), delta: -big(inc.amount) }, { asset: addr(outg.asset), delta: big(outg.amount) }] })
    }
    case 'dex_deposit_liquidity':
    case 'dex_withdraw_liquidity': {
      const deposit = a.type === 'dex_deposit_liquidity'
      const sign = deposit ? -1n : 1n
      const protocol = DEX[String(d.dex)] ?? (d.dex ? String(d.dex) : undefined)
      const side = (asset: unknown, amount: unknown) => (amount === null || amount === undefined ? [] : [{ asset: addr(asset), delta: sign * big(amount) }])
      return base('liquidity', '', { ...(protocol ? { protocol } : {}), counterparty: addr(d.pool), changes: addr(d.source) === me ? [...side(d.asset_1, d.amount_1), ...side(d.asset_2, d.amount_2)] : [] })
    }
    case 'jetton_mint':
      return base('mint', '', { changes: addr(d.receiver) === me ? [{ asset: addr(d.asset), delta: big(d.amount) }] : [] })
    case 'nft_mint':
      return base('mint', 'Minted an NFT', { counterparty: addr(d.nft_collection) })
    case 'jetton_burn':
      return base('other', '', { changes: addr(d.owner) === me ? [{ asset: addr(d.asset), delta: -big(d.amount) }] : [] })
    case 'call_contract':
      return base('contract', 'Contract call', { noise: d.opcode === OP_EXCESS, counterparty: addr(d.destination) === me ? addr(d.source) : addr(d.destination) })
    case 'contract_deploy':
      return base('contract', 'Deployed a contract', { counterparty: addr(d.destination) })
    default:
      return base('other', a.type.replace(/_/g, ' '))
  }
}

/** 同一条交易链里属于这个地址的动作 → 一条 Activity */
async function groupActivity(client: TonClient, group: ActionRow[], me: string, book: Book | undefined, meta: Meta | undefined, signal?: AbortSignal): Promise<Activity | null> {
  const classified = group.map((a) => classify(a, me))
  const real = classified.filter((c) => !c.noise)
  // 只有多余 TON 退回之类：不单独成一条
  if (!real.length) return null
  const type = real.reduce((best, c) => (PRIORITY[c.type] > PRIORITY[best] ? c.type : best), real[0]?.type as ActivityType)
  const used = real.filter((c) => c.type === type)
  const first = group[0] as ActionRow
  const raws = used.flatMap((c) => c.changes.map((x) => x.asset)).filter((x): x is string => x !== null)
  const info = await assetInfo(client, [...new Set(raws)], meta, signal)
  const changes = toChanges(used.flatMap((c) => c.changes), info)
  const friendly = (raw: string) => book?.[raw.toUpperCase()]?.user_friendly ?? book?.[raw]?.user_friendly ?? toFriendlyAddress(raw, { testOnly: client.network === 'testnet' })
  const counterparties = [...new Set(used.map((c) => c.counterparty).filter((x): x is string => !!x && x !== me))]
  const counterparty = counterparties.length === 1 ? friendly(counterparties[0] as string) : undefined
  const dirs = new Set(used.map((c) => c.dir).filter(Boolean))
  const protocol = used.find((c) => c.protocol)?.protocol
  const direction = type === 'transfer' ? (dirs.size === 1 ? (dirs.values().next().value as 'in' | 'out') : dirs.size > 1 && counterparties.length === 0 ? 'self' : undefined) : undefined
  const sent = describeChanges(changes, -1)
  const got = describeChanges(changes, 1)
  let label = used.find((c) => c.label)?.label
  if (type === 'swap') label = `Swapped ${sent} for ${got}${protocol ? ` on ${protocol}` : ''}`
  else if (type === 'liquidity') label = `${group.some((a) => a.type === 'dex_withdraw_liquidity') ? 'Removed' : 'Added'} liquidity${sent || got ? ` (${sent || got})` : ''}${protocol ? ` on ${protocol}` : ''}`
  else if (type === 'mint' && got) label = `Minted ${got}`
  else if (type === 'transfer' && !label) {
    const n = used.length
    label = n > 1 ? `${direction === 'out' ? 'Sent' : direction === 'in' ? 'Received' : 'Moved'} ${n} transfers` : direction === 'out' ? `Sent ${sent}${counterparty ? ` to ${counterparty}` : ''}` : `Received ${got}${counterparty ? ` from ${counterparty}` : ''}`
  } else if (type === 'other' && sent) label = `${label ?? 'Action'}: ${sent}`
  return {
    hash: hexOf(first.trace_external_hash_norm) ?? hexOf(first.trace_external_hash) ?? hexOf(first.trace_id) ?? '',
    time: first.start_utime ?? 0,
    ...(first.trace_mc_seqno_end === undefined ? {} : { block: first.trace_mc_seqno_end }),
    status: group.every((a) => a.success !== false) ? 'success' : 'failed',
    type,
    ...(direction ? { direction } : {}),
    ...(counterparty ? { counterparty } : {}),
    ...(label ? { label } : {}),
    changes,
    ...(protocol ? { protocol } : {}),
  }
}

/** toncenter v3 `/actions`：索引器已分类的动作（推荐，一次请求）。游标是 toncenter 的游标 */
export function toncenterActions(): HistoryAdapter {
  return {
    name: 'actions',
    async fetch(q) {
      const me = q.address
      // 游标：toncenter 的 cursor，加上 “|trace_id”：上一页末尾那条交易链已经完整给过了，这页开头属于它的动作要跳过
      const [cursor, skip] = (q.cursor ?? '').split('|')
      type Res = { actions?: ActionRow[]; address_book?: Book; metadata?: Meta; next_cursor?: string | null }
      const res = await q.client.transport.get<Res>('actions', { account: me, limit: q.limit, cursor: cursor || undefined, start_utime: q.after, end_utime: q.before }, { signal: q.signal })
      const rows = (res.actions ?? []).filter((a) => !skip || a.trace_id !== skip)
      const full = (res.actions ?? []).length >= q.limit && !!res.next_cursor
      let book = res.address_book
      let meta = res.metadata
      // 页末的交易链可能没取完：单独取完整的一条，下一页跳过它
      let boundary: string | undefined
      const last = rows.at(-1)
      if (full && last?.trace_id) {
        boundary = last.trace_id
        const rest = await q.client.transport.get<Res>('actions', { account: me, trace_id: boundary, limit: 100 }, { signal: q.signal }).catch(() => null)
        if (rest?.actions?.length) {
          const kept = rows.filter((a) => a.trace_id !== boundary)
          rows.length = 0
          rows.push(...kept, ...rest.actions)
          book = { ...book, ...rest.address_book }
          meta = { ...meta, ...rest.metadata }
        }
      }
      // 按交易链分组（同一条交易链的动作相邻，顺序保持）
      const groups = new Map<string, ActionRow[]>()
      for (const a of rows) {
        const key = a.trace_id ?? `${a.start_utime}:${groups.size}`
        groups.set(key, [...(groups.get(key) ?? []), a])
      }
      const items: Activity[] = []
      for (const g of groups.values()) {
        const item = await groupActivity(q.client, g, me, book, meta, q.signal)
        if (item) items.push(item)
      }
      return { items, ...(res.next_cursor ? { nextCursor: `${res.next_cursor}${boundary ? `|${boundary}` : ''}` } : {}) }
    },
  }
}

// ---------------------------------------------------------------------------
// 适配器 2：toncenter /transactions + /jetton/transfers（退路）
// ---------------------------------------------------------------------------

interface TxRow {
  hash: string
  now: number
  mc_block_seqno?: number
  trace_id?: string | null
  total_fees?: string
  description?: { aborted?: boolean; compute_ph?: { success?: boolean } }
  in_msg?: { source?: string | null; value?: string | null } | null
  out_msgs?: Array<{ destination?: string | null; value?: string | null }>
  account_state_before?: { balance?: string | null } | null
  account_state_after?: { balance?: string | null } | null
}

interface JettonTransferRow {
  source: string
  destination: string
  amount: string
  jetton_master: string
  transaction_now: number
  transaction_aborted?: boolean
  trace_id?: string | null
}

/**
 * toncenter v3 `/transactions` + `/jetton/transfers`：没有动作分类时的退路。每条交易链一条活动：TON 变化按账户余额的变化（含手续费），
 * Jetton 变化来自 jetton/transfers；付出和收到两个以上的资产（扣掉 0.1 TON 以内的 gas）按兑换算，其余是转账。
 * 游标是 `<transactions 的 offset>,<jetton/transfers 的 offset>`，翻页是尽力而为（一条交易链的数据可能跨页）
 */
export function toncenterTransactions(): HistoryAdapter {
  return {
    name: 'transactions',
    async fetch(q) {
      const me = q.address
      const [txOffset = 0, jtOffset = 0] = (q.cursor ?? '').split(',').map((n) => Number(n) || 0)
      const time = { start_utime: q.after, end_utime: q.before }
      const [txs, jts] = await Promise.all([
        q.client.transport.get<{ transactions?: TxRow[]; address_book?: Book }>('transactions', { account: me, limit: q.limit, offset: txOffset, sort: 'desc', ...time }, { signal: q.signal }),
        q.client.transport.get<{ jetton_transfers?: JettonTransferRow[]; address_book?: Book; metadata?: Meta }>('jetton/transfers', { owner_address: me, direction: 'both', limit: q.limit, offset: jtOffset, sort: 'desc', start_utime: q.after, end_utime: q.before }, { signal: q.signal }),
      ])
      const book: Book = { ...txs.address_book, ...jts.address_book }
      const friendly = (raw: string) => book[raw.toUpperCase()]?.user_friendly ?? toFriendlyAddress(raw, { testOnly: q.client.network === 'testnet' })
      interface Group {
        key: string
        time: number
        block?: number
        failed: boolean
        fee: bigint
        ton: bigint
        counterparties: Set<string>
        jetton: Array<{ asset: string | null; delta: bigint }>
        txCount: number
        jtCount: number
      }
      const groups = new Map<string, Group>()
      const get = (key: string, time: number): Group => {
        let g = groups.get(key)
        if (!g) groups.set(key, (g = { key, time, failed: false, fee: 0n, ton: 0n, counterparties: new Set(), jetton: [], txCount: 0, jtCount: 0 }))
        g.time = Math.max(g.time, time)
        return g
      }
      for (const t of txs.transactions ?? []) {
        const g = get(t.trace_id ?? t.hash, t.now)
        g.block ??= t.mc_block_seqno
        g.failed ||= !!t.description?.aborted || t.description?.compute_ph?.success === false
        g.ton += big(t.account_state_after?.balance) - big(t.account_state_before?.balance)
        // 钱包自己发起的（外部消息）才付手续费
        if (!t.in_msg?.source) g.fee += big(t.total_fees)
        for (const raw of [t.in_msg?.source, ...(t.out_msgs ?? []).map((m) => m.destination)]) {
          const a = addr(raw)
          if (a && a !== me) g.counterparties.add(a)
        }
        g.txCount++
      }
      for (const j of jts.jetton_transfers ?? []) {
        if (j.transaction_aborted) continue
        const g = get(j.trace_id ?? `${j.transaction_now}`, j.transaction_now)
        const [from, to] = [addr(j.source), addr(j.destination)]
        g.jetton.push({ asset: addr(j.jetton_master), delta: from === me ? -big(j.amount) : to === me ? big(j.amount) : 0n })
        const other = from === me ? to : from
        if (other && other !== me) g.counterparties.add(other)
        g.jtCount++
      }
      const ordered = [...groups.values()].sort((a, b) => b.time - a.time).slice(0, q.limit)
      const masters = [...new Set(ordered.flatMap((g) => g.jetton.map((j) => j.asset)).filter((x): x is string => x !== null))]
      const info = await assetInfo(q.client, masters, jts.metadata, q.signal)
      const items = ordered.map((g): Activity => {
        // 钱包的 TON 变化（手续费已经单独给出，不算在内）；有 Jetton 变化时，0.1 TON 以内的当作 gas 的进出
        const tonMoved = g.ton + g.fee
        const dust = 100_000_000n
        const changes = toChanges([...(!g.jetton.length || tonMoved > dust || tonMoved < -dust ? [{ asset: null, delta: tonMoved }] : []), ...g.jetton], info)
        const swap = changes.some((c) => BigInt(c.delta) < 0n) && changes.some((c) => BigInt(c.delta) > 0n)
        const direction = swap ? undefined : changes.every((c) => BigInt(c.delta) <= 0n) && changes.length ? 'out' : changes.length ? 'in' : undefined
        const counterparty = g.counterparties.size === 1 && !swap ? friendly([...g.counterparties][0] as string) : undefined
        const sent = describeChanges(changes, -1)
        const got = describeChanges(changes, 1)
        const label = swap ? `Swapped ${sent} for ${got}` : direction === 'out' ? `Sent ${sent}${counterparty ? ` to ${counterparty}` : ''}` : direction === 'in' ? `Received ${got}${counterparty ? ` from ${counterparty}` : ''}` : 'Contract call'
        return {
          hash: hexOf(g.key) ?? '',
          time: g.time,
          ...(g.block === undefined ? {} : { block: g.block }),
          status: g.failed ? 'failed' : 'success',
          type: swap ? 'swap' : direction ? 'transfer' : 'contract',
          ...(direction ? { direction } : {}),
          ...(counterparty ? { counterparty } : {}),
          label,
          changes,
          ...(g.fee > 0n ? { fee: g.fee.toString() } : {}),
        }
      })
      const used = new Set(ordered.map((g) => g.key))
      const nextTx = txOffset + [...groups.values()].filter((g) => used.has(g.key)).reduce((s, g) => s + g.txCount, 0)
      const nextJt = jtOffset + [...groups.values()].filter((g) => used.has(g.key)).reduce((s, g) => s + g.jtCount, 0)
      const more = (txs.transactions?.length ?? 0) >= q.limit || (jts.jetton_transfers?.length ?? 0) >= q.limit
      return { items, ...(more && items.length ? { nextCursor: `${nextTx},${nextJt}` } : {}) }
    },
  }
}

// ---------------------------------------------------------------------------
// getHistory
// ---------------------------------------------------------------------------

/**
 * 一个地址的历史：`items` 按时间从新到旧，`nextCursor` 传给下一次调用翻页。
 *
 * ```ts
 * const page = await history(ton, owner, { limit: 20 })
 * const swaps = await history(ton, owner, { types: ['swap'], after: Math.floor(Date.now() / 1000) - 86400 })
 * const next = await history(ton, owner, { cursor: page.nextCursor })
 * ```
 */
export async function history(client: TonClient, address: string, options: HistoryOptions = {}): Promise<HistoryPage> {
  if (!isValidTonAddress(address)) throw new Error(`Invalid TON address: ${address}`)
  const raw = toRawAddress(address)
  const adapters = options.adapters ?? [toncenterActions(), toncenterTransactions()]
  if (!adapters.length) throw new Error('No history adapter configured')
  const limit = Math.min(100, Math.max(1, options.limit ?? 20))
  const types = options.types?.length ? new Set(options.types) : null
  const maxPages = types ? Math.max(1, options.maxPages ?? 5) : 1

  // 游标：<适配器名>:<适配器的游标>；翻页只能用同一个适配器
  let name: string | null = null
  let cursor: string | undefined
  if (options.cursor) {
    const i = options.cursor.indexOf(':')
    name = options.cursor.slice(0, i)
    cursor = options.cursor.slice(i + 1)
    if (i < 0 || !adapters.some((a) => a.name === name)) throw new Error('Invalid history cursor (the adapter that produced it is not configured)')
  }
  const candidates = name ? adapters.filter((a) => a.name === name) : adapters
  const items: Activity[] = []
  let used = null as HistoryAdapter | null
  let next: string | undefined = cursor
  for (let page = 0; page < maxPages; page++) {
    const query: HistoryQuery = { address: raw, limit, cursor: next, before: options.before, after: options.after, client, signal: options.signal }
    let res: HistoryPage | null = null
    const errors: string[] = []
    const tryList: readonly HistoryAdapter[] = used ? [used] : candidates
    for (const adapter of tryList) {
      try {
        res = await adapter.fetch(query)
        used = adapter
        break
      } catch (err) {
        if (options.signal?.aborted) throw err
        errors.push(`${adapter.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (!res || !used) throw new Error(`All history sources failed: ${errors.join('; ')}`)
    items.push(...(types ? res.items.filter((a) => types.has(a.type)) : res.items))
    next = res.nextCursor
    if (!next || items.length >= limit) break
  }
  return { items, ...(next && used ? { nextCursor: `${used.name}:${next}` } : {}) }
}
