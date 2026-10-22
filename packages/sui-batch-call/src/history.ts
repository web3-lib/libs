/**
 * 地址的交易历史：从数据源（默认 GraphQL，备用节点的 gRPC ListTransactions）取交易，按这个地址的余额变化整理成 Activity
 * （兑换 = 付出一种币收到另一种；转账；流动性；铸造 NFT；失败的）
 */
import { normalizeSuiAddress } from './address.js'
import { classify, coinKey, decodeCalls, describeObjectChanges, isSui, perspective, summarize, type ActivityKind, type NamedChange } from './analyze.js'
import type { SuiClient } from './client.js'
import { SUI_DECIMALS } from './constants.js'
import { formatUnits } from './format.js'
import { graphqlHistory, grpcHistory, type HistoryAdapter, type HistoryPage } from './historyAdapters.js'
import { balanceChangesWithoutGas, feeOf, type RawTx } from './rawTx.js'

export type ActivityType = ActivityKind

export interface ActivityChange {
  /** 代币类型（规范化） */
  asset: string
  symbol: string | null
  decimals: number | null
  /** 带符号的最小单位数量（SUI 不含 gas，见 fee） */
  delta: string
  formatted: string
}

export interface Activity {
  /** 交易摘要 */
  hash: string
  /** 秒 */
  time: number
  /** checkpoint */
  block?: number
  status: 'success' | 'failed'
  type: ActivityType
  direction?: 'in' | 'out' | 'self'
  counterparty?: string
  /** 一句话描述 */
  label: string
  /** 这个地址的代币余额变化 */
  changes: ActivityChange[]
  /** 收到 / 送出的非 Coin 对象（NFT 等） */
  objects?: Array<{ id: string; type: string | null; direction: 'in' | 'out' }>
  /** 手续费（MIST，计算 + 存储 − 返还）：只在这个地址付 gas 时有 */
  fee?: string
  protocol?: string
  /** 交易的发送者 */
  sender?: string
  /** 出错时的原因 */
  error?: string
}

export interface HistoryOptions {
  /** 一次最多取几笔交易，默认 20，最多 50 */
  limit?: number
  /** 上一页返回的 nextCursor */
  cursor?: string
  /** 只要这个 checkpoint 及之后的 / 及之前的 */
  fromBlock?: number
  toBlock?: number
  /** 只要这些类型：筛选在取回之后做，没取够 limit 时再取下一页（最多 5 页） */
  types?: readonly ActivityType[]
  /** 数据源，按顺序用（前面的出错换下一个），默认 [GraphQL（完整历史）, 节点的 gRPC（最近一段时间）] */
  adapters?: readonly HistoryAdapter[]
  signal?: AbortSignal
}

export interface HistoryResult {
  items: Activity[]
  /** 还有更早的交易时给出 */
  nextCursor?: string
}

const MAX_LIMIT = 50
const MAX_PAGES = 5

/** 游标：`数据源:checkpoint:数据源自己的游标`；checkpoint 用来在换数据源时接着往下取 */
const encodeCursor = (adapter: string, block: number | null, raw: string) => `${adapter}:${block ?? ''}:${raw}`
function decodeCursor(cursor: string): { adapter: string; block: number | null; raw: string } {
  const m = /^([^:]+):(\d*):(.*)$/s.exec(cursor)
  if (!m) throw new Error(`Invalid history cursor: ${JSON.stringify(cursor)}`)
  return { adapter: m[1] as string, block: m[2] ? Number(m[2]) : null, raw: m[3] as string }
}

/**
 * 查地址的交易历史（新的在前）。
 *
 * - 游标跟着数据源走：下一页优先用同一个数据源；它出错时换下一个，从游标记录的 checkpoint 接着取（这个 checkpoint 里的交易可能重复，按 hash 去重）
 * - 数据源只返回这个地址"受影响"的交易（拥有的对象变了、余额变了），包括别人转给它的
 */
export async function getHistoryOf(client: SuiClient, address: string, options: HistoryOptions = {}): Promise<HistoryResult> {
  const owner = normalizeSuiAddress(address)
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 20)), MAX_LIMIT)
  const adapters = options.adapters ?? [graphqlHistory({ network: client.network }), grpcHistory(client.transport)]
  if (!adapters.length) throw new Error('getHistory needs at least one adapter')
  const types = options.types ? new Set(options.types) : null
  const { signal } = options
  let cursor = options.cursor ? decodeCursor(options.cursor) : null
  const items: Activity[] = []
  const seen = new Set<string>()
  let next: string | undefined

  for (let page = 0; page < (types ? MAX_PAGES : 1); page++) {
    const result = await listWithFailover(adapters, owner, { limit, cursor, fromBlock: options.fromBlock, toBlock: options.toBlock, signal })
    const fresh = result.page.txs.filter((t) => t.digest && !seen.has(t.digest))
    for (const t of fresh) seen.add(t.digest as string)
    const activities = await toActivities(client, fresh, owner, signal)
    items.push(...(types ? activities.filter((a) => types.has(a.type)) : activities))
    const last = result.page.txs.at(-1)
    next = result.page.nextCursor ? encodeCursor(result.adapter, last?.checkpoint ?? cursor?.block ?? null, result.page.nextCursor) : undefined
    if (!next || items.length >= limit) break
    cursor = decodeCursor(next)
  }
  return { items, ...(next ? { nextCursor: next } : {}) }
}

async function listWithFailover(
  adapters: readonly HistoryAdapter[],
  owner: string,
  q: { limit: number; cursor: { adapter: string; block: number | null; raw: string } | null; fromBlock?: number; toBlock?: number; signal?: AbortSignal },
): Promise<{ adapter: string; page: HistoryPage }> {
  const errors: Error[] = []
  // 游标是哪个数据源给的就先用它
  const order = q.cursor ? [...adapters].sort((a, b) => Number(b.name === q.cursor?.adapter) - Number(a.name === q.cursor?.adapter)) : adapters
  for (const adapter of order) {
    const own = !q.cursor || q.cursor.adapter === adapter.name
    // 换了数据源：游标不通用，按 checkpoint 接着取（包含游标所在的 checkpoint，可能重复）
    const toBlock = own ? q.toBlock : Math.min(q.toBlock ?? Infinity, q.cursor?.block ?? Infinity)
    try {
      const page = await adapter.list(owner, {
        limit: q.limit,
        ...(own && q.cursor ? { cursor: q.cursor.raw } : {}),
        ...(q.fromBlock !== undefined ? { afterBlock: q.fromBlock - 1 } : {}),
        ...(toBlock !== undefined && Number.isFinite(toBlock) ? { beforeBlock: toBlock + 1 } : {}),
        signal: q.signal,
      })
      return { adapter: adapter.name, page }
    } catch (err) {
      if (q.signal?.aborted) throw err
      errors.push(err instanceof Error ? err : new Error(String(err)))
    }
  }
  throw errors.length === 1 ? errors[0] : new AggregateError(errors, `All history adapters failed: ${errors.map((e) => e.message).join('; ')}`)
}

async function toActivities(client: SuiClient, txs: readonly RawTx[], owner: string, signal?: AbortSignal): Promise<Activity[]> {
  if (!txs.length) return []
  const coinTypes = [...new Set(txs.flatMap((t) => balanceChangesWithoutGas(t).filter((c) => normalizeSuiAddress(c.address) === owner).map((c) => coinKey(c.coinType))))].filter((t) => !isSui(t))
  const infos = coinTypes.length ? await client.coins(coinTypes, { signal }) : []
  const meta = new Map(coinTypes.map((t, i) => [t, infos[i]] as const))
  const decimalsOf = (t: string) => (isSui(t) ? SUI_DECIMALS : (meta.get(coinKey(t))?.decimals ?? null))
  const symbolOf = (t: string) => (isSui(t) ? 'SUI' : (meta.get(coinKey(t))?.symbol ?? null))
  return Promise.all(
    txs.map(async (tx): Promise<Activity> => {
      const calls = await decodeCalls(client.transport, tx.commands, signal)
      const changes = balanceChangesWithoutGas(tx)
      const objects = describeObjectChanges(tx.objectChanges)
      const view = perspective(tx, owner, changes, objects)
      const named: NamedChange[] = view.mine.map((c) => {
        const decimals = decimalsOf(c.coinType)
        return { coinType: coinKey(c.coinType), symbol: symbolOf(c.coinType), amount: c.amount, formatted: decimals === null ? c.amount.toString() : formatUnits(c.amount, decimals) }
      })
      const classified = classify(calls, tx, owner, view.mine)
      const sender = tx.sender ? normalizeSuiAddress(tx.sender) : null
      // 别人发起的：对这个地址来说只是收到东西（空投、别人转账），不是它自己的兑换 / 合约调用
      let type: ActivityType = classified.type
      if (sender !== owner && !tx.system) type = view.direction === 'in' ? 'transfer' : 'other'
      const failed = !tx.success
      const fee = feeOf(tx)
      const payer = tx.gasOwner ?? tx.sender
      return {
        hash: tx.digest as string,
        time: tx.timestamp ?? 0,
        ...(tx.checkpoint !== null ? { block: tx.checkpoint } : {}),
        status: failed ? 'failed' : 'success',
        type,
        ...(view.direction ? { direction: view.direction } : {}),
        ...(view.counterparty ? { counterparty: normalizeSuiAddress(view.counterparty) } : {}),
        label: summarize(type, classified, view, named, calls, failed),
        changes: named.map((c) => ({ asset: c.coinType, symbol: c.symbol, decimals: decimalsOf(c.coinType), delta: c.amount.toString(), formatted: c.formatted })),
        ...(view.objectsIn.length || view.objectsOut.length
          ? { objects: [...view.objectsIn.map((o) => ({ id: o.objectId, type: o.type, direction: 'in' as const })), ...view.objectsOut.map((o) => ({ id: o.objectId, type: o.type, direction: 'out' as const }))] }
          : {}),
        ...(fee !== null && payer && normalizeSuiAddress(payer) === owner ? { fee: fee.toString() } : {}),
        ...(classified.protocol ? { protocol: classified.protocol } : {}),
        ...(sender ? { sender } : {}),
        ...(tx.error ? { error: tx.error.abort ? `Move abort ${tx.error.abort.code}${tx.error.abort.constant ? ` (${tx.error.abort.constant})` : ''}` : tx.error.description } : {}),
      }
    }),
  )
}
