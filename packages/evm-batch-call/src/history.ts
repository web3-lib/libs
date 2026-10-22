/**
 * 交易历史（子路径 `@w3lib/evm-batch-call/history`）：一个地址的转账 / 兑换 / 授权 / 流动性 / 铸造记录，统一成 Activity。
 * 数据来源是可替换的适配器（见 historySources.ts）：Blockscout、Etherscan 系（需要 Key）、纯 RPC 日志、Tron 的 TronGrid；
 * `source: [a, b]` 按顺序故障切换。适配器只返回原始记录（交易、转账），这里负责合并、解码和分类。
 */
import { getAddress } from 'ethers'

import { getNativeCurrency } from './chains.js'
import { formatUnits } from './erc20.js'
import type { Provider } from './provider.js'
import { decodeCalldata, type DecodedCall } from './simulateDecode.js'
import { historySourcesFor, type HistorySource } from './historySources.js'
import { isTronChain, toEvmAddress, toTronAddress } from './tron.js'

export type ActivityType = 'transfer' | 'swap' | 'approve' | 'liquidity' | 'mint' | 'contract' | 'other'

export interface ActivityChange {
  /** 代币 / NFT 合约地址；主币是 'native' */
  asset: string
  symbol: string | null
  decimals: number
  /** 带符号的最小单位数量 */
  delta: string
  formatted: string
  /** NFT（721 / 1155）：tokenId */
  tokenId?: string
}

export interface Activity {
  hash: string
  /** 秒级时间戳 */
  time: number
  block?: number
  status: 'success' | 'failed'
  type: ActivityType
  /** 转账 / 铸造的方向（自己转给自己是 self）；兑换等没有 */
  direction?: 'in' | 'out' | 'self'
  /** 对方地址（转账的另一方；合约调用是合约地址） */
  counterparty?: string
  /** 一句话描述 */
  label?: string
  /** 这个地址的资产变化（失败的交易没有） */
  changes: ActivityChange[]
  /** 手续费（最小单位的主币，只有这个地址是发送者时）。Tron 为 sun */
  fee?: string
  protocol?: string
  /** 调用的方法名（能解码时） */
  method?: string
}

// ---------------------------------------------------------------------------
// 适配器返回的原始记录
// ---------------------------------------------------------------------------

export interface RawTx {
  hash: string
  /** 位置：EVM 是区块号，Tron 是毫秒时间戳（分页用） */
  pos: number
  block?: number
  time: number
  from: string
  to?: string | null
  /** 附带的主币 */
  value: bigint
  /** calldata（0x 开头） */
  input: string
  ok: boolean
  fee?: bigint
}

export interface RawMove {
  hash: string
  pos: number
  block?: number
  time: number
  /** 'native' 或代币合约地址 */
  asset: string
  from: string
  to: string
  value: bigint
  tokenId?: string
  symbol?: string | null
  decimals?: number | null
}

export interface RawPage {
  txs: RawTx[]
  moves: RawMove[]
  /** 位置 ≥ 这个值的记录是完整的（列表按条数截断时，最后一个位置上的记录可能只拿到一部分）；没有更多历史时为 0 */
  completeFrom: number
  /** 下一页查到这个位置（含）为止，往旧的方向；没有更多历史时没有 */
  next?: number
}

export interface HistoryQuery {
  /** 要查的地址：EVM 是 0x 小写，Tron 是 T 开头 */
  address: string
  chainId: number
  /** 每次从各个列表取多少条 */
  limit: number
  /** 只查位置 ≤ 这个值的记录（分页用，不传从最新开始） */
  endPos?: number
  /** 是否包含 NFT 转账 */
  nft: boolean
  provider: Provider
  fetch: typeof fetch
  signal?: AbortSignal
}

/** 数据来源适配器：按查询返回原始记录 */
export interface HistoryAdapter {
  name: string
  /** 这个来源是否支持这条链（不支持的在故障切换里直接跳过） */
  supports?(chainId: number): boolean
  fetch(query: HistoryQuery): Promise<RawPage>
}

export interface HistoryOptions {
  /** 数据来源：名字（'blockscout' | 'etherscan' | 'rpc' | 'trongrid'）、适配器对象，或它们的数组（按顺序故障切换）。默认：有 Blockscout 的链 [blockscout, rpc]，否则 [rpc]；传了 apiKey 时 etherscan 排最前；Tron 是 trongrid */
  source?: HistorySource | readonly HistorySource[]
  /** Etherscan 系（v2，一个 Key 覆盖多条链）/ TronGrid 的 API Key */
  apiKey?: string
  /** 至少返回多少条（按区块整块取，可能略多；历史到头时可能不足） */
  limit?: number
  /** 上一次返回的 nextCursor */
  cursor?: string
  /** 只要这些类型（过滤后不够 limit 会继续往前翻页，直到 maxPages） */
  types?: readonly ActivityType[]
  /** 时间范围（秒级时间戳）：只要这个时间之前 / 之后的；往前翻到早于 after 就停 */
  before?: number
  after?: number
  /** 是否包含 NFT 转账，默认 true */
  nft?: boolean
  /** 为凑够 limit 最多翻几页，默认 5 */
  maxPages?: number
  fetch?: typeof fetch
  signal?: AbortSignal
}

export interface HistoryResult {
  items: Activity[]
  /** 还有更早的历史时给出，传给下一次的 cursor */
  nextCursor?: string
  /** 实际用的数据来源 */
  source: string
}

export class HistorySourceError extends Error {
  constructor(readonly errors: ReadonlyArray<{ source: string; error: unknown }>) {
    super(`All history sources failed: ${errors.map((e) => `${e.source}: ${e.error instanceof Error ? e.error.message : String(e.error)}`).join(' | ')}`)
    this.name = 'HistorySourceError'
  }
}

const ZERO = '0x0000000000000000000000000000000000000000'
const CURSOR_RE = /^p:(\d+)$/

// ---------------------------------------------------------------------------
// 合并 + 分类
// ---------------------------------------------------------------------------

interface BuildCtx {
  chainId: number
  tron: boolean
  /** 比较用的 0x 小写地址 */
  me: string
  native: { symbol: string | null; decimals: number }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** 地址的比较键：EVM 小写 0x；Tron 的 T 地址 / 41 开头的 hex 地址转成 0x 小写 */
function key(ctx: BuildCtx, address: string): string {
  if (!ctx.tron) return address.toLowerCase()
  try {
    return toEvmAddress(address).toLowerCase()
  } catch {
    return address.toLowerCase()
  }
}

const show = (ctx: BuildCtx, address: string): string => {
  try {
    return ctx.tron ? toTronAddress(address) : getAddress(address)
  } catch {
    return address
  }
}

function changesOf(ctx: BuildCtx, moves: readonly RawMove[]): { changes: ActivityChange[]; mints: boolean; partners: Map<string, bigint> } {
  const net = new Map<string, ActivityChange & { raw: bigint }>()
  const partners = new Map<string, bigint>()
  let mints = false
  for (const m of moves) {
    const from = key(ctx, m.from)
    const to = key(ctx, m.to)
    if (from === to) continue
    const sign = to === ctx.me ? 1n : from === ctx.me ? -1n : 0n
    if (!sign) continue
    const nft = m.tokenId !== undefined
    const k = `${m.asset}|${m.tokenId ?? ''}`
    const decimals = nft ? 0 : (m.decimals ?? (m.asset === 'native' ? ctx.native.decimals : 18))
    const entry = net.get(k) ?? { asset: m.asset === 'native' ? 'native' : show(ctx, m.asset), symbol: m.asset === 'native' ? ctx.native.symbol : (m.symbol ?? null), decimals, delta: '0', formatted: '0', ...(nft ? { tokenId: m.tokenId } : {}), raw: 0n }
    entry.raw += sign * m.value
    net.set(k, entry)
    const other = sign > 0n ? from : to
    partners.set(other, (partners.get(other) ?? 0n) + m.value)
    if (sign > 0n && from === ZERO && (nft || m.asset !== 'native')) mints = true
  }
  const changes = [...net.values()].filter((e) => e.raw !== 0n).sort((a, b) => Number(a.raw > 0n) - Number(b.raw > 0n)).map(({ raw, ...e }) => ({ ...e, delta: raw.toString(), formatted: formatUnits(raw, e.decimals) }))
  return { changes, mints, partners }
}

const amount = (c: ActivityChange) => `${c.formatted.replace('-', '')} ${c.symbol ?? (c.tokenId === undefined ? short(c.asset) : `#${c.tokenId}`)}`

function classify(ctx: BuildCtx, tx: RawTx | undefined, decoded: DecodedCall | null, changes: ActivityChange[], mints: boolean): ActivityType {
  const outs = changes.filter((c) => c.delta.startsWith('-'))
  const ins = changes.filter((c) => !c.delta.startsWith('-'))
  const sender = tx !== undefined && key(ctx, tx.from) === ctx.me
  if (sender && decoded?.type === 'approve') return 'approve'
  if (sender && decoded?.type === 'liquidity') return 'liquidity'
  if (mints && ins.length) return 'mint'
  if (outs.length && ins.length && new Set([...outs, ...ins].map((c) => `${c.asset}|${c.tokenId ?? ''}`)).size > 1) return 'swap'
  if (decoded?.type === 'swap') return 'swap'
  if (changes.length || (tx && tx.input === '0x') || decoded?.type === 'transfer') return 'transfer'
  if (decoded) return 'contract'
  return 'other'
}

export function buildActivities(page: Pick<RawPage, 'txs' | 'moves'>, ctx: BuildCtx, minPos = 0): Activity[] {
  const groups = new Map<string, { tx?: RawTx; moves: RawMove[]; pos: number; time: number; block?: number }>()
  const group = (hash: string, pos: number, time: number, block?: number) => {
    let g = groups.get(hash)
    if (!g) groups.set(hash, (g = { moves: [], pos, time, block }))
    return g
  }
  for (const tx of page.txs) if (tx.pos >= minPos) group(tx.hash, tx.pos, tx.time, tx.block).tx = tx
  for (const m of page.moves) if (m.pos >= minPos) group(m.hash, m.pos, m.time, m.block).moves.push(m)

  const items: Activity[] = []
  for (const [hash, g] of groups) {
    const { tx } = g
    const moves = [...g.moves]
    // 顶层的主币转账（explorer 的转账列表里没有）；失败的交易没有任何资产变化
    if (tx?.ok && tx.value > 0n && tx.to) moves.push({ hash, pos: g.pos, time: g.time, asset: 'native', from: tx.from, to: tx.to, value: tx.value })
    const { changes, mints, partners } = tx && !tx.ok ? { changes: [], mints: false, partners: new Map<string, bigint>() } : changesOf(ctx, moves)
    const decoded = tx && tx.input !== '0x' && tx.to ? decodeCalldata(tx.input, { to: show(ctx, tx.to), chainId: ctx.chainId, value: tx.value }) : null
    const type = classify(ctx, tx, decoded, changes, mints)
    const sender = tx !== undefined && key(ctx, tx.from) === ctx.me
    const outs = changes.filter((c) => c.delta.startsWith('-'))
    const ins = changes.filter((c) => !c.delta.startsWith('-'))

    let direction: Activity['direction']
    if (type === 'transfer' || type === 'mint') {
      if (tx?.to && key(ctx, tx.to) === ctx.me && sender) direction = 'self'
      else if (outs.length && !ins.length) direction = 'out'
      else if (ins.length && !outs.length) direction = 'in'
      else if (!changes.length) direction = sender ? 'out' : 'in'
    }
    // 对方：转账是出入金额最大的那一方；其他是合约（自己发起时）或发起者
    let counterparty: string | undefined
    if (type === 'transfer' || type === 'mint') {
      const top = [...partners.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1))[0]?.[0]
      counterparty = top && top !== ZERO ? top : tx?.to && !sender ? tx.from : (tx?.to ?? undefined)
    } else if (tx) {
      counterparty = sender ? (tx.to ?? undefined) : tx.from
    }

    const protocol = decoded?.protocol
    const failed = tx ? !tx.ok : false
    let label: string
    if (failed) label = `Failed ${decoded?.method ?? 'transaction'}${protocol ? ` on ${protocol}` : ''}`
    else if (type === 'swap') label = `Swapped ${outs.map(amount).join(' + ')} for ${ins.map(amount).join(' + ')}${protocol ? ` on ${protocol}` : ''}`
    else if (type === 'approve') label = `Approved ${decoded?.args?.spender ? short(String(decoded.args.spender)) : (decoded?.method ?? 'spending')}${decoded?.args?.amount === '0' || decoded?.args?.approved === false ? ' (revoked)' : ''}`
    else if (type === 'liquidity') label = `${decoded?.method ?? 'Liquidity'}${protocol ? ` on ${protocol}` : ''}: ${changes.map((c) => `${c.delta.startsWith('-') ? '-' : '+'}${amount(c)}`).join(', ')}`
    else if (type === 'mint') label = `Minted ${ins.map(amount).join(' + ')}`
    else if (type === 'transfer') {
      const cp = counterparty ? short(show(ctx, counterparty)) : ''
      label = direction === 'in' ? `Received ${ins.map(amount).join(' + ')}${cp ? ` from ${cp}` : ''}` : direction === 'self' ? 'Sent to self' : `Sent ${outs.map(amount).join(' + ') || 'a transaction'}${cp ? ` to ${cp}` : ''}`
    } else label = decoded?.summary ?? 'Transaction'

    items.push({
      hash,
      time: g.time,
      ...(g.block === undefined ? {} : { block: g.block }),
      status: failed ? 'failed' : 'success',
      type,
      ...(direction ? { direction } : {}),
      ...(counterparty ? { counterparty: show(ctx, counterparty) } : {}),
      label,
      changes,
      ...(sender && tx?.fee !== undefined ? { fee: tx.fee.toString() } : {}),
      ...(protocol ? { protocol } : {}),
      ...(decoded?.method ? { method: decoded.method } : {}),
    })
  }
  // 位置新的在前（同一个位置保持原来的顺序）
  const posOf = new Map([...groups].map(([h, g]) => [h, g.pos]))
  return items.sort((a, b) => (posOf.get(b.hash) as number) - (posOf.get(a.hash) as number))
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 查一个地址的历史活动（最新的在前），分页用 nextCursor。
 *
 * ```ts
 * const page = await history(provider, user, { limit: 20 })                       // Blockscout，失败换 RPC 日志
 * const next = await history(provider, user, { cursor: page.nextCursor, types: ['swap'] })
 * await history(provider, user, { source: ['etherscan', 'rpc'], apiKey })         // Etherscan v2 的 Key 覆盖多条链
 * ```
 */
export async function history(provider: Provider, address: string, options: HistoryOptions = {}): Promise<HistoryResult> {
  const chainId = await provider.getChainId()
  const tron = isTronChain(chainId)
  const me = tron ? toTronAddress(address) : address.toLowerCase()
  if (!tron && !/^0x[0-9a-f]{40}$/.test(me)) throw new Error(`Invalid address: ${address}`)
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 25)))
  const cursor = options.cursor === undefined ? undefined : Number(CURSOR_RE.exec(options.cursor)?.[1] ?? Number.NaN)
  if (cursor !== undefined && !Number.isFinite(cursor)) throw new Error(`Invalid cursor: ${options.cursor}`)
  const adapters = historySourcesFor(chainId, options.source, options.apiKey)
  if (!adapters.length) throw new Error(`No history source for chain ${chainId}: pass options.source`)
  const nativeCurrency = getNativeCurrency(chainId)
  const ctx: BuildCtx = { chainId, tron, me: tron ? toEvmAddress(me).toLowerCase() : me, native: { symbol: nativeCurrency?.symbol ?? null, decimals: nativeCurrency?.decimals ?? 18 } }
  const query = (endPos?: number): HistoryQuery => ({ address: me, chainId, limit: Math.max(limit, 10), ...(endPos === undefined ? {} : { endPos }), nft: options.nft ?? true, provider, fetch: options.fetch ?? fetch, ...(options.signal ? { signal: options.signal } : {}) })

  const items: Activity[] = []
  const seen = new Set<string>()
  let pos = cursor
  let used = adapters[0]?.name ?? ''
  let more = true
  for (let pages = 0; pages < (options.maxPages ?? 5) && more; pages++) {
    let page: RawPage | undefined
    const errors: Array<{ source: string; error: unknown }> = []
    for (const adapter of adapters) {
      try {
        page = await adapter.fetch(query(pos))
        used = adapter.name
        break
      } catch (err) {
        if (options.signal?.aborted) throw err
        errors.push({ source: adapter.name, error: err })
      }
    }
    if (!page) throw new HistorySourceError(errors)
    // 整页都落在同一个位置、被条数截断时放不下完整记录：宁可收下这一页，也不能原地打转
    const hasComplete = [...page.txs, ...page.moves].some((r) => r.pos >= page.completeFrom)
    const batch = buildActivities(page, ctx, hasComplete ? page.completeFrom : 0)
    for (const a of batch) {
      if (seen.has(a.hash)) continue
      seen.add(a.hash)
      if (options.before !== undefined && a.time >= options.before) continue
      if (options.after !== undefined && a.time < options.after) continue
      if (options.types && !options.types.includes(a.type)) continue
      items.push(a)
    }
    const oldest = batch.length ? Math.min(...batch.map((a) => a.time)) : Number.POSITIVE_INFINITY
    pos = hasComplete ? page.next : page.next === undefined ? undefined : page.next - 1
    more = pos !== undefined && pos >= 0 && !(options.after !== undefined && oldest < options.after)
    if (items.length >= limit) break
  }
  return { items, ...(more && pos !== undefined ? { nextCursor: `p:${pos}` } : {}), source: used }
}

export type { HistorySource } from './historySources.js'
