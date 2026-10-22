/** 交易的类型和一句话说明（/simulate 和 /history 共用）：指令的大类 + 钱包的余额变化 */
import type { DecodedInstruction } from './decode.js'
import { PROGRAMS } from './programs.js'

export interface AssetDelta {
  asset: string
  symbol: string
  decimals: number
  /** 带符号的最小单位十进制字符串 */
  delta: string
  formatted: string
}

export type TxKind = 'transfer' | 'swap' | 'approve' | 'liquidity' | 'mint' | 'contract' | 'unknown'

export interface Classified {
  type: TxKind
  protocol?: string
  method?: string
  /** 没有认得的指令、按余额变化（一个资产减少、另一个增加）推断为 swap */
  inferred?: boolean
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

/**
 * 判断类型：先看认得的指令（流动性 > 兑换 > 授权 > 铸造），再看是不是只有转账；有不认得的程序时，
 * 钱包一个资产减少、另一个增加就推断为兑换，否则是合约调用（程序认得）或未知。没有任何有意义的指令（只有建账户、关闭等）时为 null
 */
export function classify(ixs: readonly DecodedInstruction[], changes: readonly Pick<AssetDelta, 'asset' | 'delta'>[]): Classified | null {
  const pick = (type: DecodedInstruction['type']) => ixs.find((ix) => ix.type === type)
  const result = (ix: DecodedInstruction, type: TxKind): Classified => ({ type, protocol: ix.protocol, method: ix.method })
  for (const type of ['liquidity', 'swap', 'approve', 'mint'] as const) {
    const ix = pick(type)
    if (ix) return result(ix, type)
  }
  const others = ixs.filter((ix) => ix.type === 'contract' || ix.type === 'unknown')
  const out = changes.filter((c) => c.delta.startsWith('-'))
  const received = changes.filter((c) => !c.delta.startsWith('-') && c.delta !== '0')
  if (others.length) {
    const first = others.find((ix) => ix.protocol) ?? others[0]!
    if (out.length && received.some((r) => out.some((o) => o.asset !== r.asset))) return { type: 'swap', protocol: first.protocol, inferred: true }
    return { type: others.some((ix) => PROGRAMS[ix.programId]) ? 'contract' : 'unknown', protocol: first.protocol, method: first.method }
  }
  const transfer = pick('transfer')
  if (transfer) return result(transfer, 'transfer')
  return null
}

const amount = (c: AssetDelta) => `${c.formatted.replace(/^-/, '')} ${c.symbol}`
const join = (list: readonly AssetDelta[]) => list.map(amount).join(' + ')

/** 一句话说明，如 “Swap 1 SOL for 150.2 USDC on Jupiter” */
export function describe(kind: Classified | null, ixs: readonly DecodedInstruction[], changes: readonly AssetDelta[], counterparty?: string): string {
  const out = changes.filter((c) => c.delta.startsWith('-'))
  const received = changes.filter((c) => !c.delta.startsWith('-') && c.delta !== '0')
  const via = kind?.protocol ? ` on ${kind.protocol}` : ''
  switch (kind?.type) {
    case 'swap':
      return out.length && received.length ? `Swap ${join(out)} for ${join(received)}${via}` : `Swap${via}`
    case 'transfer':
      if (out.length && !received.length) return `Send ${join(out)}${counterparty ? ` to ${short(counterparty)}` : ''}`
      if (received.length && !out.length) return `Receive ${join(received)}${counterparty ? ` from ${short(counterparty)}` : ''}`
      return ixs.find((ix) => ix.type === 'transfer')?.summary ?? 'Transfer'
    case 'liquidity':
      return `${kind.method ? kind.method.replace(/_/g, ' ') : 'Liquidity'}${via}${out.length ? `: pay ${join(out)}` : ''}${received.length ? `${out.length ? ',' : ':'} receive ${join(received)}` : ''}`
    case 'approve':
      return ixs.find((ix) => ix.type === 'approve')?.summary ?? 'Approve'
    case 'mint':
      return `Mint${received.length ? `: receive ${join(received)}` : ''}${via}`
    case 'contract':
    case 'unknown':
      return `${ixs.find((ix) => ix.type === kind.type)?.summary ?? 'Call program'}${out.length ? `, pay ${join(out)}` : ''}${received.length ? `, receive ${join(received)}` : ''}`
    default:
      return ixs.find((ix) => ix.type === 'close')?.summary ?? (changes.length ? `Balance change: ${join(changes)}` : 'No balance change')
  }
}
