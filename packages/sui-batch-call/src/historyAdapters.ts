/**
 * 历史数据源。Sui 的 gRPC 里没有"某个地址的交易"这个接口，但有按过滤条件列交易的 LedgerService.ListTransactions（affected_address 过滤）：
 * 公共全节点只保留最近一段时间（x-sui-lowest-available-checkpoint 之前的被裁掉，主网约几周）。
 * GraphQL（graphql.mainnet.sui.io）的 transactions(filter: { affectedAddress }) 有完整历史，是默认的主数据源，gRPC 作为备用。
 * 两个适配器都转成统一的 RawTx，换成其他数据源（带 Key 的索引服务）只需要实现 HistoryAdapter
 */
import { normalizeSuiAddress } from './address.js'
import type { GrpcTransport } from './grpc.js'
import { ProtoWriter, fieldMask } from './proto.js'
import { RAW_TX_PATHS, rawFromJson, rawFromProto, type RawTx } from './rawTx.js'
import type { SuiNetwork } from './constants.js'

export interface HistoryQuery {
  /** 最多取几笔（适配器可以再往下限制） */
  limit: number
  /** 适配器自己的游标（上一页返回的 nextCursor），没有时从最新的开始 */
  cursor?: string
  /** 只要 checkpoint 大于它的（不含） */
  afterBlock?: number
  /** 只要 checkpoint 小于它的（不含） */
  beforeBlock?: number
  signal?: AbortSignal
}

export interface HistoryPage {
  /** 新的在前 */
  txs: RawTx[]
  /** 还有更早的时给出下一页的游标 */
  nextCursor?: string
}

/** 历史数据源：按地址列交易，新的在前 */
export interface HistoryAdapter {
  readonly name: string
  list(address: string, query: HistoryQuery): Promise<HistoryPage>
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

/** Mysten 的公共 GraphQL（限频；正式环境请用自己的 / 服务商的） */
export const DEFAULT_GRAPHQL_URLS: Readonly<Record<SuiNetwork, string>> = {
  mainnet: 'https://graphql.mainnet.sui.io/graphql',
  testnet: 'https://graphql.testnet.sui.io/graphql',
  devnet: 'https://graphql.devnet.sui.io/graphql',
}

export interface GraphqlHistoryOptions {
  /** GraphQL 端点，默认 network 的公共端点 */
  url?: string
  network?: SuiNetwork
  headers?: Record<string, string>
  fetch?: typeof fetch
  /** 超时（毫秒），默认 20000 */
  timeout?: number
}

const QUERY = `query($addr: SuiAddress!, $n: Int, $before: String, $bc: UInt53, $ac: UInt53) {
  transactions(last: $n, before: $before, filter: { affectedAddress: $addr, beforeCheckpoint: $bc, afterCheckpoint: $ac }) {
    pageInfo { hasPreviousPage startCursor }
    nodes { digest transactionJson effects { timestamp checkpoint { sequenceNumber } effectsJson balanceChangesJson } }
  }
}`

/** 一页最多这么多笔（响应里带整笔交易的 JSON，每笔十几 KB） */
const GRAPHQL_MAX = 50

export function graphqlHistory(options: GraphqlHistoryOptions = {}): HistoryAdapter {
  const url = options.url ?? DEFAULT_GRAPHQL_URLS[options.network ?? 'mainnet']
  const timeout = options.timeout ?? 20_000
  return {
    name: 'graphql',
    async list(address, q) {
      const controller = new AbortController()
      const abort = () => controller.abort(q.signal?.reason)
      q.signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(new Error(`GraphQL request to ${url} timed out`)), timeout)
      try {
        const res = await (options.fetch ?? fetch)(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...options.headers },
          body: JSON.stringify({ query: QUERY, variables: { addr: normalizeSuiAddress(address), n: Math.min(q.limit, GRAPHQL_MAX), before: q.cursor ?? null, bc: q.beforeBlock ?? null, ac: q.afterBlock ?? null } }),
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`GraphQL HTTP ${res.status} from ${url}`)
        const body = (await res.json()) as { data?: { transactions: GqlConnection } | null; errors?: Array<{ message: string }> }
        if (body.errors?.length || !body.data) throw new Error(`GraphQL error: ${body.errors?.map((e) => e.message).join('; ') ?? 'no data'}`)
        const { nodes, pageInfo } = body.data.transactions
        // last / before 的每一页是从旧到新排的
        const txs = [...nodes].reverse().map((n) =>
          rawFromJson({ digest: n.digest, transaction: n.transactionJson, effects: n.effects?.effectsJson ?? null, balanceChanges: n.effects?.balanceChangesJson ?? [], timestamp: n.effects?.timestamp, checkpoint: n.effects?.checkpoint?.sequenceNumber ?? null }),
        )
        return { txs, ...(pageInfo.hasPreviousPage && pageInfo.startCursor ? { nextCursor: pageInfo.startCursor } : {}) }
      } catch (err) {
        if (q.signal?.aborted) throw q.signal.reason ?? err
        throw err
      } finally {
        clearTimeout(timer)
        q.signal?.removeEventListener('abort', abort)
      }
    },
  }
}

interface GqlConnection {
  pageInfo: { hasPreviousPage: boolean; startCursor: string | null }
  nodes: Array<{
    digest: string
    transactionJson: Record<string, unknown> | null
    effects: { timestamp: string | null; checkpoint: { sequenceNumber: number } | null; effectsJson: Record<string, unknown> | null; balanceChangesJson: Array<{ address: string; coinType: string; amount: string }> } | null
  }>
}

// ---------------------------------------------------------------------------
// gRPC
// ---------------------------------------------------------------------------

const LEDGER = 'sui.rpc.v2.LedgerService'
/** QueryEndReason：1 达到条数、2 扫描量到上限（还没扫完）、3 到了 checkpoint 范围的边界、4 游标边界、5 到了账本末尾 */
const END_MORE = new Set([1, 2])

/** 节点自己的 ListTransactions（没有时间限制之外的依赖；公共节点只有最近一段时间的数据） */
export function grpcHistory(transport: GrpcTransport): HistoryAdapter {
  return {
    name: 'grpc',
    async list(address, q) {
      const options = new ProtoWriter().uint(1, Math.min(q.limit, 100)).uint(4, 1) // 倒序
      if (q.cursor) options.bytes(3, base64ToBytes(q.cursor))
      const filter = new ProtoWriter().message(1, new ProtoWriter().message(1, new ProtoWriter().message(3, new ProtoWriter().string(1, normalizeSuiAddress(address)))))
      const req = new ProtoWriter().message(1, fieldMask(RAW_TX_PATHS)).uint(2, q.afterBlock === undefined ? undefined : q.afterBlock + 1).uint(3, q.beforeBlock).message(4, filter).message(5, options)
      const res = await transport.unary(`${LEDGER}/ListTransactions`, req.finish(), { signal: q.signal })
      const frames = res.frames ?? [res.message]
      const txs: RawTx[] = []
      let cursor: Uint8Array | null = null
      let reason: number | null = null
      for (const f of frames) {
        const tx = f.message(1)
        if (tx) txs.push(rawFromProto(tx))
        cursor = f.message(2)?.bytes(1) ?? cursor
        reason = f.message(3)?.number(1) ?? reason
      }
      return { txs, ...(reason !== null && END_MORE.has(reason) && cursor ? { nextCursor: bytesToBase64(cursor) } : {}) }
    },
  }
}

const bytesToBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const base64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
