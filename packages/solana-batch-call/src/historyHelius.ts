/** Helius 增强交易历史数据源（需要应用自己的 API key）：把 `/v0/addresses/{address}/transactions` 的结果整理成和 rpcHistory 一样的 Activity */
import { NATIVE_MINT, SOL_DECIMALS } from './constants.js'
import { formatUnits } from './layout.js'
import type { Activity, ActivityChange, ActivityType, HistorySource } from './history.js'

export interface HeliusHistoryOptions {
  apiKey: string
  /** 默认 https://api.helius.xyz */
  baseUrl?: string
}

interface HeliusItem {
  signature: string
  timestamp?: number
  slot?: number
  fee?: number
  feePayer?: string
  type?: string
  source?: string
  description?: string
  transactionError?: unknown
  nativeTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; amount: number }>
  tokenTransfers?: Array<{ fromUserAccount: string | null; toUserAccount: string | null; tokenAmount: number; mint: string }>
  accountData?: Array<{
    account: string
    nativeBalanceChange?: number
    tokenBalanceChanges?: Array<{ userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }>
  }>
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

/** Helius 的交易类型 → Activity 类型（认不出的按资产变化判断） */
function typeOf(item: HeliusItem, changes: readonly ActivityChange[]): ActivityType {
  const t = item.type ?? ''
  if (/SWAP/.test(t)) return 'swap'
  if (t === 'TRANSFER') return 'transfer'
  if (/LIQUIDITY|POSITION|POOL/.test(t)) return 'liquidity'
  if (/MINT/.test(t)) return 'mint'
  if (/APPROVE|REVOKE|DELEGATE/.test(t)) return 'approve'
  const out = changes.filter((c) => c.delta.startsWith('-'))
  if (out.length && changes.some((c) => !c.delta.startsWith('-') && out.some((o) => o.asset !== c.asset))) return 'swap'
  return t && t !== 'UNKNOWN' ? 'contract' : 'other'
}

export function activityFromHelius(address: string, item: HeliusItem): Activity {
  const me = item.accountData?.find((a) => a.account === address)
  const isPayer = item.feePayer === address
  const fee = BigInt(item.fee ?? 0)
  let native = BigInt(me?.nativeBalanceChange ?? 0) + (isPayer ? fee : 0n)
  const tokens = new Map<string, { delta: bigint; decimals: number }>()
  for (const entry of item.accountData ?? []) {
    for (const t of entry.tokenBalanceChanges ?? []) {
      if (t.userAccount !== address) continue
      const prev = tokens.get(t.mint)
      tokens.set(t.mint, { delta: (prev?.delta ?? 0n) + BigInt(t.rawTokenAmount.tokenAmount), decimals: t.rawTokenAmount.decimals })
    }
  }
  const wsol = tokens.get(NATIVE_MINT)
  if (wsol) {
    native += wsol.delta
    tokens.delete(NATIVE_MINT)
  }
  const failed = item.transactionError !== null && item.transactionError !== undefined
  const changes: ActivityChange[] = []
  if (!failed) {
    if (native !== 0n) changes.push({ asset: 'native', symbol: 'SOL', decimals: SOL_DECIMALS, delta: native.toString(), formatted: formatUnits(native, SOL_DECIMALS) })
    for (const [asset, { delta, decimals }] of tokens) {
      if (delta !== 0n) changes.push({ asset, symbol: short(asset), decimals, delta: delta.toString(), formatted: formatUnits(delta, decimals) })
    }
  }
  const type = typeOf(item, changes)
  let counterparty: string | undefined
  for (const t of [...(item.nativeTransfers ?? []), ...(item.tokenTransfers ?? []).map((x) => ({ fromUserAccount: x.fromUserAccount ?? '', toUserAccount: x.toUserAccount ?? '' }))]) {
    if (t.fromUserAccount === address && t.toUserAccount) counterparty = t.toUserAccount
    else if (t.toUserAccount === address && t.fromUserAccount) counterparty = t.fromUserAccount
    if (counterparty) break
  }
  const negative = changes.filter((c) => c.delta.startsWith('-')).length
  const protocol = item.source && !/^(SYSTEM_PROGRAM|UNKNOWN)$/.test(item.source) ? item.source[0] + item.source.slice(1).toLowerCase().replace(/_/g, ' ') : undefined
  return {
    hash: item.signature,
    time: item.timestamp ?? 0,
    block: item.slot,
    status: failed ? 'failed' : 'success',
    type,
    direction: (type === 'transfer' || type === 'other') && changes.length ? (negative === 0 ? 'in' : negative === changes.length ? 'out' : undefined) : undefined,
    counterparty,
    label: item.description || undefined,
    changes,
    ...(isPayer ? { fee: fee.toString() } : {}),
    protocol,
  }
}

/**
 * Helius 增强交易历史（`GET /v0/addresses/{address}/transactions`，按 before 签名翻页）。apiKey 由应用传入，库里不带。
 * 按交易类型过滤时翻页最多再取 3 页
 *
 * ```ts
 * await getHistory(address, { source: [heliusHistory({ apiKey }), rpcHistory()] })   // Helius 失败时用节点
 * ```
 */
export function heliusHistory(options: HeliusHistoryOptions): HistorySource {
  if (!options.apiKey) throw new Error('heliusHistory needs an apiKey')
  const base = (options.baseUrl ?? 'https://api.helius.xyz').replace(/\/+$/, '')
  return {
    name: 'helius',
    async getHistory(ctx) {
      const items: Activity[] = []
      let cursor = ctx.cursor
      let more = true
      for (let page = 0; page < (ctx.types ? 4 : 1) && items.length < ctx.limit && more; page++) {
        const url = `${base}/v0/addresses/${ctx.address}/transactions?api-key=${encodeURIComponent(options.apiKey)}&limit=${Math.min(100, ctx.limit)}${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`
        const res = await ctx.fetch(url, { signal: ctx.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const raw = (await res.json()) as HeliusItem[]
        if (!Array.isArray(raw)) throw new Error('Unexpected response')
        more = raw.length >= Math.min(100, ctx.limit)
        for (const item of raw) {
          cursor = item.signature
          const t = item.timestamp ?? 0
          if (ctx.before !== undefined && t >= ctx.before) continue
          if (ctx.after !== undefined && t < ctx.after) {
            more = false
            break
          }
          const activity = activityFromHelius(ctx.address, item)
          if (!ctx.types || ctx.types.includes(activity.type)) items.push(activity)
          if (items.length >= ctx.limit) break
        }
      }
      return { items, ...(more && cursor ? { nextCursor: cursor } : {}) }
    },
  }
}
