/**
 * 历史记录的数据来源（适配器）。每个适配器按 HistoryQuery 返回原始的交易和转账（RawPage），合并和分类由 history.ts 完成。
 *
 * - blockscout：各链的 Blockscout 实例（免 Key）的 Etherscan 兼容接口（`/api?module=account&action=txlist …`）。
 *   没用 v2 REST（`/api/v2/addresses/…`）：同样的数据，v2 每页带大量标签 / 元数据（50 条约 500KB），这个接口只有必要字段，
 *   并且与 Etherscan 系完全相同，一套解析两处用
 * - etherscan：Etherscan v2（一个 Key 覆盖 60+ 条链）及其他 Etherscan 兼容的接口
 * - rpc：只用 `eth_getLogs`（ERC20 / 721 / 1155 的 Transfer 日志按地址所在的 topic 查）+ 交易 / 回执 / 区块。没有主币转账（顶层的 value 只有
 *   带代币转账的交易才有）、没有内部交易；要按区块窗口往回扫，稀疏的地址一次调用可能扫不到记录（返回 nextCursor 继续）
 * - trongrid：TronGrid 的 `/v1/accounts/{address}/transactions` 和 `/transactions/trc20`（内部的 TRX 转账查不到）
 */
import { AbiCoder, id, zeroPadValue } from 'ethers'

import { HttpStatusError, fetchJson } from './http.js'
import type { HistoryAdapter, HistoryQuery, RawMove, RawPage, RawTx } from './history.js'
import { errorText } from './fallback.js'
import { isTronChain, toTronAddress } from './tron.js'

export type HistorySource = 'blockscout' | 'etherscan' | 'rpc' | 'trongrid' | HistoryAdapter

/**
 * 各链的 Blockscout 实例。2026-10 验证过可用：1、10、100、534352、324、130、42220、34443、57073；
 * 8453 / 42161 / 137 的官方实例前面有 Cloudflare 人机验证，脚本请求可能被 403（此时自动换下一个来源）
 */
export const BLOCKSCOUT_APIS: Readonly<Record<number, string>> = {
  1: 'https://eth.blockscout.com/api',
  10: 'https://explorer.optimism.io/api',
  100: 'https://gnosisscan.io/api',
  130: 'https://unichain.blockscout.com/api',
  137: 'https://polygon.blockscout.com/api',
  324: 'https://zksync.blockscout.com/api',
  8453: 'https://base.blockscout.com/api',
  34443: 'https://explorer.mode.network/api',
  42161: 'https://arbitrum.blockscout.com/api',
  42220: 'https://celo.blockscout.com/api',
  57073: 'https://explorer.inkonchain.com/api',
  534352: 'https://scrollscan.com/api',
}

const num = (v: unknown) => Number(v ?? 0)
const big = (v: unknown) => {
  try {
    return BigInt(String(v ?? '0') || '0')
  } catch {
    return 0n
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Row = Record<string, string>

/** 各个列表（每个都按位置从新到旧、最多 limit 条）合成一页：列表满了说明后面还有，被截断的位置要留到下一页 */
function paged(txs: RawTx[], moves: RawMove[], lists: ReadonlyArray<{ count: number; lastPos: number }>, limit: number): RawPage {
  const full = lists.filter((l) => l.count >= limit && l.count > 0)
  if (!full.length) return { txs, moves, completeFrom: 0 }
  const last = Math.max(...full.map((l) => l.lastPos))
  return { txs, moves, completeFrom: last + 1, next: last }
}

// ---------------------------------------------------------------------------
// Etherscan 兼容接口（Blockscout / Etherscan v2）
// ---------------------------------------------------------------------------

const ACTIONS = { txs: 'txlist', internal: 'txlistinternal', tokens: 'tokentx', nfts: 'tokennfttx', multi: 'token1155tx' } as const

async function explorerCall(q: HistoryQuery, base: string, action: string, secret?: string): Promise<Row[]> {
  const url = new URL(base)
  const params: Record<string, string> = { module: 'account', action, address: q.address, startblock: '0', page: '1', offset: String(q.limit), sort: 'desc' }
  if (q.endPos !== undefined) params.endblock = String(q.endPos)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  for (let attempt = 0; ; attempt++) {
    let json: { status?: string; message?: string; result?: unknown }
    try {
      json = await fetchJson(q.fetch, url.toString(), undefined, secret)
    } catch (err) {
      // 公共实例限流（HTTP 429）：等一下重试
      if (err instanceof HttpStatusError && err.status === 429 && attempt < 3) {
        await sleep(1200 * (attempt + 1))
        continue
      }
      throw err
    }
    if (Array.isArray(json.result)) {
      const rows = json.result as Row[]
      // 个别实例的某些列表不认 endblock，返回的还是最新的记录：翻页会重复 / 漏记录，换下一个来源
      if (q.endPos !== undefined && rows.some((r) => num(r.blockNumber) > (q.endPos as number))) throw new Error(`${new URL(base).host}: ${action} ignores endblock`)
      return rows
    }
    const text = typeof json.result === 'string' ? json.result : (json.message ?? 'unexpected response')
    if (/no (transactions|records|token)/i.test(`${json.message} ${text}`)) return []
    if (/rate limit|too many/i.test(text) && attempt < 3) {
      await sleep(1200 * (attempt + 1))
      continue
    }
    throw new Error(`${new URL(base).host}: ${text}`)
  }
}

/** Blockscout / Etherscan 系适配器：`url` 是接口地址（可以带 chainid 等固定参数） */
export function explorerSource(name: string, url: (chainId: number) => string | undefined, secret?: string): HistoryAdapter {
  return {
    name,
    supports: (chainId) => url(chainId) !== undefined,
    async fetch(q) {
      const base = url(q.chainId)
      if (!base) throw new Error(`${name}: chain ${q.chainId} is not supported`)
      const call = (action: string) => explorerCall(q, base, action, secret)
      // 依次请求（公共实例按请求频率限流，并发会触发 429）
      const txRows = await call(ACTIONS.txs)
      const internalRows = await call(ACTIONS.internal)
      const tokenRows = await call(ACTIONS.tokens)
      const nftRows = q.nft ? await call(ACTIONS.nfts) : []
      const multiRows = q.nft ? await call(ACTIONS.multi) : []
      const txs: RawTx[] = txRows.map((r) => ({
        hash: r.hash as string,
        pos: num(r.blockNumber),
        block: num(r.blockNumber),
        time: num(r.timeStamp),
        from: r.from as string,
        to: r.to || r.contractAddress || null,
        value: big(r.value),
        input: r.input || '0x',
        ok: r.isError !== '1' && r.txreceipt_status !== '0',
        fee: big(r.gasUsed) * big(r.gasPrice),
      }))
      const moves: RawMove[] = []
      const base0 = (r: Row) => ({ hash: (r.hash ?? r.transactionHash) as string, pos: num(r.blockNumber), block: num(r.blockNumber), time: num(r.timeStamp), from: r.from as string, to: r.to as string })
      for (const r of internalRows) if (r.isError !== '1' && big(r.value) > 0n) moves.push({ ...base0(r), asset: 'native', value: big(r.value) })
      for (const r of tokenRows) moves.push({ ...base0(r), asset: r.contractAddress as string, value: big(r.value), symbol: r.tokenSymbol || null, decimals: r.tokenDecimal ? num(r.tokenDecimal) : null })
      for (const r of nftRows) moves.push({ ...base0(r), asset: r.contractAddress as string, value: 1n, tokenId: r.tokenID as string, symbol: r.tokenSymbol || null })
      for (const r of multiRows) moves.push({ ...base0(r), asset: r.contractAddress as string, value: big(r.tokenValue || '1'), tokenId: r.tokenID as string, symbol: r.tokenSymbol || null })
      const lists = [txRows, internalRows, tokenRows, nftRows, multiRows].map((rows) => ({ count: rows.length, lastPos: rows.length ? Math.min(...rows.map((r) => num(r.blockNumber))) : 0 }))
      return paged(txs, moves, lists, q.limit)
    },
  }
}

/** Blockscout：`urls` 覆盖 / 补充内置的实例表（chainId → 接口地址） */
export function blockscoutSource(urls: Readonly<Record<number, string>> = {}): HistoryAdapter {
  return explorerSource('blockscout', (chainId) => urls[chainId] ?? BLOCKSCOUT_APIS[chainId])
}

/** Etherscan v2：一个 Key 覆盖多条链；`baseUrl` 可换成其他 Etherscan 兼容的地址 */
export function etherscanSource(options: { apiKey: string; baseUrl?: string }): HistoryAdapter {
  if (!options.apiKey) throw new Error('etherscan source requires an apiKey')
  return explorerSource('etherscan', (chainId) => `${options.baseUrl ?? 'https://api.etherscan.io/v2/api'}?chainid=${chainId}&apikey=${encodeURIComponent(options.apiKey)}`, options.apiKey)
}

// ---------------------------------------------------------------------------
// 纯 RPC 日志
// ---------------------------------------------------------------------------

const TRANSFER = id('Transfer(address,address,uint256)')
const SINGLE = id('TransferSingle(address,address,address,uint256,uint256)')
const BATCH = id('TransferBatch(address,address,address,uint256[],uint256[])')
const coder = AbiCoder.defaultAbiCoder()
const topicAddr = (hex: string) => `0x${hex.slice(-40)}`.toLowerCase()

export interface RpcSourceOptions {
  /** 每次 getLogs 的区块窗口，默认 2000（节点嫌大时自动对半缩小） */
  window?: number
  /** 一次最多扫多少个窗口，默认 10（凑够条数就提前停；扫不到记录时用 nextCursor 继续） */
  maxWindows?: number
}

type Log = { address: string; topics: readonly string[]; data: string; blockNumber: number; transactionHash: string }
type LogNode = { getTransaction(hash: string): Promise<{ from: string; to: string | null; value: bigint; data: string } | null>; getTransactionReceipt(hash: string): Promise<{ status: number | null; gasUsed: bigint; gasPrice: bigint } | null>; getBlock(n: number): Promise<{ timestamp: number } | null> }

async function pool<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await work(items[i] as T)
      }
    }),
  )
  return out
}

export function rpcSource(options: RpcSourceOptions = {}): HistoryAdapter {
  const window = Math.max(10, Math.floor(options.window ?? 2000))
  const maxWindows = Math.max(1, Math.floor(options.maxWindows ?? 10))
  return {
    name: 'rpc',
    supports: (chainId) => !isTronChain(chainId),
    async fetch(q) {
      const addr = zeroPadValue(q.address, 32)
      const filters: Array<Array<string | string[] | null>> = [[TRANSFER, null, addr], [TRANSFER, addr], ...(q.nft ? [[[SINGLE, BATCH], null, addr], [[SINGLE, BATCH], null, null, addr]] : [])]
      const logsIn = async (from: number, to: number, depth = 0): Promise<Log[]> => {
        try {
          const lists = await Promise.all(filters.map((topics) => q.provider.getLogs({ fromBlock: from, toBlock: to, topics } as never)))
          // ERC-721 的 Transfer 和 ERC-20 同一个 topic（4 个 topic）：不要 NFT 时丢掉
          return lists.flat().filter((l) => q.nft || l.topics.length === 3) as unknown as Log[]
        } catch (err) {
          // 范围太大 / 结果太多：对半拆开重试（最多拆 4 层）
          if (depth < 4 && to > from && /range|too (large|wide|big|many)|exceed|limit|more than|response size/i.test(errorText(err))) {
            const mid = from + Math.floor((to - from) / 2)
            return [...(await logsIn(from, mid, depth + 1)), ...(await logsIn(mid + 1, to, depth + 1))]
          }
          throw err
        }
      }
      let to = q.endPos ?? (await q.provider.getBlockNumber())
      let from = to
      const logs: Log[] = []
      for (let w = 0; w < maxWindows; w++) {
        from = Math.max(0, to - window + 1)
        logs.push(...(await logsIn(from, to)))
        if (new Set(logs.map((l) => l.transactionHash)).size >= q.limit || from === 0) break
        to = from - 1
      }
      const next = from > 0 ? from - 1 : undefined

      // 只保留最新的 limit 笔交易；被丢掉的更老的交易所在的区块留给下一页
      const byBlock = new Map<string, number>()
      for (const l of logs) byBlock.set(l.transactionHash, Math.max(byBlock.get(l.transactionHash) ?? 0, l.blockNumber))
      const hashes = [...byBlock.entries()].sort((a, b) => b[1] - a[1])
      const kept = hashes.slice(0, q.limit)
      const dropped = hashes.slice(q.limit)
      const completeFrom = dropped.length ? (dropped[0] as [string, number])[1] + 1 : from
      const keepSet = new Set(kept.map(([h]) => h))

      const { runOnNodes } = await import('./write/rpc.js')
      const node = <T>(method: string, fn: (n: LogNode) => Promise<T>) => runOnNodes(q.provider.rpc, method, (n) => fn(n as unknown as LogNode))
      const blockTimes = new Map<number, number>()
      const blocks = [...new Set(kept.map(([, b]) => b))]
      await pool(blocks, 6, async (b) => {
        blockTimes.set(b, (await node('getBlock', (n) => n.getBlock(b)))?.timestamp ?? 0)
      })
      const txs = (
        await pool(kept, 6, async ([hash, block]): Promise<RawTx | null> => {
          const [tx, receipt] = await Promise.all([node('getTransaction', (n) => n.getTransaction(hash)), node('getTransactionReceipt', (n) => n.getTransactionReceipt(hash))])
          if (!tx) return null
          return { hash, pos: block, block, time: blockTimes.get(block) ?? 0, from: tx.from, to: tx.to, value: tx.value, input: tx.data, ok: receipt?.status !== 0, ...(receipt ? { fee: receipt.gasUsed * receipt.gasPrice } : {}) }
        })
      ).filter((t): t is RawTx => t !== null)

      const moves: RawMove[] = []
      for (const l of logs) {
        if (!keepSet.has(l.transactionHash)) continue
        const base = { hash: l.transactionHash, pos: l.blockNumber, block: l.blockNumber, time: blockTimes.get(l.blockNumber) ?? 0, asset: l.address.toLowerCase() }
        if (l.topics[0] === TRANSFER && l.topics.length === 3) moves.push({ ...base, from: topicAddr(l.topics[1] as string), to: topicAddr(l.topics[2] as string), value: big(l.data) })
        else if (l.topics[0] === TRANSFER && l.topics.length === 4) moves.push({ ...base, from: topicAddr(l.topics[1] as string), to: topicAddr(l.topics[2] as string), value: 1n, tokenId: BigInt(l.topics[3] as string).toString() })
        else if (l.topics[0] === SINGLE) {
          const [tokenId, value] = coder.decode(['uint256', 'uint256'], l.data) as unknown as [bigint, bigint]
          moves.push({ ...base, from: topicAddr(l.topics[2] as string), to: topicAddr(l.topics[3] as string), value, tokenId: tokenId.toString() })
        } else if (l.topics[0] === BATCH) {
          const [ids, values] = coder.decode(['uint256[]', 'uint256[]'], l.data) as unknown as [bigint[], bigint[]]
          ids.forEach((tokenId, i) => moves.push({ ...base, from: topicAddr(l.topics[2] as string), to: topicAddr(l.topics[3] as string), value: values[i] as bigint, tokenId: tokenId.toString() }))
        }
      }
      // 代币的 symbol / decimals（一次 multicall）；NFT 合约没有 decimals，symbol 能读到就用
      const assets = [...new Set(moves.map((m) => m.asset))]
      if (assets.length) {
        const details = await q.provider.tokens(assets, { fields: ['symbol', 'decimals'] }).catch(() => [])
        const meta = new Map(assets.map((a, i) => [a, details[i]]))
        for (const m of moves) {
          const d = meta.get(m.asset)
          m.symbol = d?.symbol ?? null
          m.decimals = typeof d?.decimals === 'number' ? d.decimals : null
        }
      }
      return { txs, moves, completeFrom: dropped.length ? completeFrom : from, ...(dropped.length ? { next: completeFrom - 1 } : next === undefined ? {} : { next }) }
    },
  }
}

// ---------------------------------------------------------------------------
// TronGrid
// ---------------------------------------------------------------------------

export interface TrongridSourceOptions {
  /** 全节点地址，默认 https://api.trongrid.io */
  host?: string
  apiKey?: string
}

interface TronTx {
  txID: string
  blockNumber?: number
  block_timestamp?: number
  net_fee?: number
  energy_fee?: number
  ret?: Array<{ contractRet?: string; fee?: number }>
  raw_data?: { contract?: Array<{ type?: string; parameter?: { value?: Record<string, unknown> } }> }
}

interface TronTrc20 {
  transaction_id: string
  block_timestamp: number
  from: string
  to: string
  value: string
  type?: string
  token_info?: { symbol?: string; address?: string; decimals?: number }
}

export function trongridSource(options: TrongridSourceOptions = {}): HistoryAdapter {
  const host = (options.host ?? 'https://api.trongrid.io').replace(/\/+$/, '')
  return {
    name: 'trongrid',
    supports: isTronChain,
    async fetch(q) {
      const headers: Record<string, string> = options.apiKey ? { 'TRON-PRO-API-KEY': options.apiKey } : {}
      const qs = `limit=${Math.min(200, q.limit)}&order_by=block_timestamp,desc&only_confirmed=true${q.endPos === undefined ? '' : `&max_timestamp=${q.endPos}`}`
      const get = async <T>(path: string): Promise<T[]> => {
        const json = await fetchJson<{ success?: boolean; data?: T[]; error?: string }>(q.fetch, `${host}/v1/accounts/${q.address}/${path}?${qs}`, { headers }, options.apiKey)
        if (json.success === false || !Array.isArray(json.data)) throw new Error(`trongrid: ${json.error ?? 'unexpected response'}`)
        return json.data
      }
      const [txRows, trc20Rows] = await Promise.all([get<TronTx>('transactions'), get<TronTrc20>('transactions/trc20')])
      const txs: RawTx[] = txRows.map((r) => {
        const c = r.raw_data?.contract?.[0]
        const v = (c?.parameter?.value ?? {}) as Record<string, string | number | undefined>
        const hexAddr = (a: unknown) => (typeof a === 'string' && a ? toTronAddress(a) : undefined)
        const trigger = c?.type === 'TriggerSmartContract'
        const ms = r.block_timestamp ?? 0
        return {
          hash: r.txID,
          pos: ms,
          ...(r.blockNumber === undefined ? {} : { block: r.blockNumber }),
          time: Math.floor(ms / 1000),
          from: hexAddr(v.owner_address) ?? q.address,
          to: hexAddr(trigger ? v.contract_address : v.to_address) ?? null,
          value: big(trigger ? v.call_value : v.amount),
          input: trigger && typeof v.data === 'string' && v.data ? `0x${v.data}` : '0x',
          ok: r.ret?.[0]?.contractRet === 'SUCCESS',
          fee: big(r.ret?.[0]?.fee ?? (r.net_fee ?? 0) + (r.energy_fee ?? 0)),
        }
      })
      const moves: RawMove[] = trc20Rows
        .filter((r) => (r.type ?? 'Transfer') === 'Transfer')
        .map((r) => ({ hash: r.transaction_id, pos: r.block_timestamp, time: Math.floor(r.block_timestamp / 1000), asset: r.token_info?.address ?? '', from: r.from, to: r.to, value: big(r.value), symbol: r.token_info?.symbol ?? null, decimals: r.token_info?.decimals ?? null }))
        .filter((m) => m.asset)
      const lists = [txRows.map((r) => r.block_timestamp ?? 0), trc20Rows.map((r) => r.block_timestamp)].map((ts) => ({ count: ts.length, lastPos: ts.length ? Math.min(...ts) : 0 }))
      return paged(txs, moves, lists, Math.min(200, q.limit))
    },
  }
}

// ---------------------------------------------------------------------------

/** 来源列表 → 适配器：名字按默认配置创建；没传时按链选默认（传了 apiKey 时 etherscan 排最前） */
export function historySourcesFor(chainId: number, source: HistorySource | readonly HistorySource[] | undefined, apiKey?: string): HistoryAdapter[] {
  const tron = isTronChain(chainId)
  const defaults: HistorySource[] = tron ? ['trongrid'] : [...(apiKey ? (['etherscan'] as const) : []), ...(BLOCKSCOUT_APIS[chainId] ? (['blockscout'] as const) : []), 'rpc']
  const list = source === undefined ? defaults : Array.isArray(source) ? source : [source as HistorySource]
  return (list as readonly HistorySource[])
    .map((s): HistoryAdapter => {
      if (typeof s !== 'string') return s
      if (s === 'blockscout') return blockscoutSource()
      if (s === 'etherscan') return etherscanSource({ apiKey: apiKey ?? '' })
      if (s === 'rpc') return rpcSource()
      return trongridSource({ ...(apiKey ? { apiKey } : {}) })
    })
    .filter((a) => a.supports?.(chainId) !== false)
}
