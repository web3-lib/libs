/**
 * Jetton 风险检查（子路径 `@w3lib/ton-batch-call/risk`）：主合约的 admin（能不能增发、有没有放弃）、mintable，
 * 索引器的诈骗标记，Jetton 钱包代码是不是认识的标准代码（不标准的钱包代码可能禁止转账），可选模拟买入、卖出（`/swap` 的模拟）
 */
import { isValidTonAddress, toFriendlyAddress, toRawAddress } from './address.js'
import type { TonClient } from './client.js'
import { NATIVE_TON, TON_DECIMALS } from './constants.js'
import { runGetMethod } from './getters.js'
import { isNodeFault } from './http.js'
import type { TonLpProtocol } from './lp.js'
import { base64ToBytes, bytesToHex, Cell } from './write/cell.js'

/**
 * 认识的 Jetton 钱包代码：代码哈希（hex；钱包代码是库 Cell 时为库里代码的哈希）→ 名字。
 * 2026-10 在主网上统计的（抽查索引器里 2000 个 Jetton 主合约，约 88% 用这里的代码；加上主流代币用的）。不在表里不一定有问题，
 * 但仿冒 USD₮、DOGS、TON 的空投代币用的都是不在表里的代码
 */
export const KNOWN_JETTON_WALLET_CODES: Readonly<Record<string, string>> = {
  /** TEP-74 参考实现（ton-blockchain/token-contract），如 CATI */
  beb0683ebeb8927fe9fc8ec0a18bc7dd17899689825a121eab46c5a3a860d0ce: 'standard',
  /** DeDust 的 LP Jetton 和用同一份代码发行的 Jetton（如 STON） */
  a760d629d5343e76d045017d9dc216fc8a307a8377815feb2b0a5c490e733486: 'dedust',
  /** STON.fi v2 的 LP Jetton（库 Cell） */
  c00836440d084e44fb94316132ac5a21417ef4f429ee09b5560b5678b334c3e8: 'stonfi-lp',
  /** USD₮ 等用的带治理的钱包（ton-blockchain/stablecoin-contract，库 Cell）：admin 可以冻结、强制转出持有人的余额 */
  '8f452d7a4dfd74066b682365177259ed05734435be76b5fd4bd5d8af2b7c3d68': 'stablecoin',
  /** NOT、DOGS 用的钱包（notcoin-contract，库 Cell） */
  ba2918c8947e9b25af9ac1b883357754173e5812f807a3d6e642a14709595395: 'notcoin',
  /** Blum memepad / bigpump 等发射平台的 Jetton */
  '226830546dc9ab1687dc72bc8a5edcc60210391a7c60698c4fe226618d778d68': 'blum-memepad',
  a46ef8746f4ea669c2ce9455be129b693cd1c638cb021faaac58c7df01e0a163: 'blum-memepad',
  '9db2219b2f2aaf9a29122a1163fa342c74dda4c87927a9b23efb789c288db857': 'memepad',
  /** HMSTR（库 Cell） */
  '0f1ad3d8a46bd283321dde639195fb72602e9b31b1727fecc25e2edc10966df4': 'hamster',
  /** Tonstakers 的 tsTON（库 Cell） */
  '12bebb0dc8e202b7e26f721e2547e16bb9ebaec934f657d19f22e76d62bec878': 'tonstakers',
  /** 跨链桥的 Jetton（如 jUSDT） */
  '9e06ca30e508a6d9fb21167cbb8f66399edd1190b0b01e0bbd14c546cc97a72b': 'bridge',
}

/** 带治理的钱包代码：admin 没放弃时可以冻结、强制转出持有人的余额（标记 governed） */
export const GOVERNED_JETTON_WALLET_CODES: ReadonlySet<string> = new Set(['8f452d7a4dfd74066b682365177259ed05734435be76b5fd4bd5d8af2b7c3d68'])

export type TradeStage = 'ok' | 'buy-failed' | 'sell-failed' | 'no-pool' | 'no-holder'

export interface TonTradeCheck {
  /** ok：买得到也卖得出；buy-failed：买入失败；sell-failed：卖出失败（貔貅盘）；no-pool：没有池子；no-holder：找不到能模拟卖出的持有人 */
  stage: TradeStage
  /** 模拟用的协议（买入那一笔的最好路线） */
  protocol: TonLpProtocol | null
  /** 买入：报价和模拟里实际收到的 Jetton；卖出：报价和实际收到的 TON（最小单位） */
  buyQuote: string | null
  bought: string | null
  sellQuote: string | null
  sold: string | null
  /** 税率（0~1）：实际数量比报价少多少；对应的步骤没跑到时为 null */
  buyTax: number | null
  sellTax: number | null
  /** 模拟用的钱包（持有这个 Jetton 和足够 TON 的 v4r2 / v5r1 钱包） */
  holder: string | null
  /** 失败原因 */
  error: string | null
}

export interface TonTokenRisk {
  /** 传入的地址（原样） */
  token: string
  /** 主合约（用户友好格式）；地址非法时为 null */
  address: string | null
  name: string | null
  symbol: string | null
  /** 链上 get_jetton_data：总量、mintable、admin（null 表示已放弃：addr_none 或零地址） */
  totalSupply: string | null
  mintable: boolean | null
  admin: string | null
  /** 索引器标记的诈骗代币 */
  isScam: boolean
  /** 主合约给出的 Jetton 钱包代码的哈希（hex，钱包代码是库 Cell 时为库里代码的哈希） */
  walletCodeHash: string | null
  /** 认识的钱包代码的名字（KNOWN_JETTON_WALLET_CODES）；不认识时为 null */
  walletCode: string | null
  /** simulate: true 时的买入 / 卖出模拟，否则为 null */
  trade: TonTradeCheck | null
  /**
   * 汇总的风险标记：not-found、scam、mintable（有 admin 且可以增发）、admin（没放弃 admin）、governed（带治理的钱包代码且有 admin：
   * 可以冻结、强制转出持有人的余额，如 USD₮）、unknown-wallet-code；
   * 模拟时还有 no-pool、cannot-buy、honeypot（卖不出）、high-buy-tax / high-sell-tax（> 10%）、has-tax（> 0.5%）
   */
  flags: string[]
  error?: 'invalid-address' | 'not-found'
}

export interface TokenRiskOptions {
  /** 模拟买入、卖出（用索引器找持有人，按 `/swap` 的路线模拟两笔，不发送），默认 false。每个代币多约 30 次请求 */
  simulate?: boolean
  /** 模拟买入用的 TON（nanoTON），默认 1 TON */
  buyAmount?: bigint
  /** 模拟用的钱包（要持有这个 Jetton 和足够的 TON，v4r2 / v5r1）；不传时从持有人里找 */
  holder?: string
  /** 模拟兑换用的协议，默认全部 */
  protocols?: readonly TonLpProtocol[]
  /** 额外认可的钱包代码：代码哈希（hex）→ 名字 */
  knownWalletCodes?: Readonly<Record<string, string>>
  signal?: AbortSignal
}

/**
 * 代码 Cell（BOC 的 base64）的哈希：库 Cell（exotic 类型 2：8 位类型 + 256 位哈希）为它引用的代码的哈希，
 * 其他为 Cell 的表示哈希。读不出时为 null
 */
export function codeHashOf(boc: string): string | null {
  try {
    const bytes = base64ToBytes(boc)
    // 头：magic(4) flags(1) offset 字节数(1) cells roots absent(各 size 字节) 总大小(offset 字节数) 根的序号(size 字节)
    const flags = bytes[4] as number
    const size = flags & 0x07
    const offsetBytes = bytes[5] as number
    const uint = (at: number, n: number) => {
      let v = 0
      for (let i = 0; i < n; i++) v = v * 256 + (bytes[at + i] as number)
      return v
    }
    const cells = uint(6, size)
    let pos = 6 + size * 3 + offsetBytes
    const root = uint(pos, size)
    pos += size
    if (flags & 0x80) pos += cells * offsetBytes // 索引
    // 只有一个 Cell、是库 Cell 时直接取引用的哈希
    if (cells === 1 && root === 0) {
      const d1 = bytes[pos] as number
      const d2 = bytes[pos + 1] as number
      if (d1 & 0x08 && d2 === 66 && bytes[pos + 2] === 2) return bytesToHex(bytes.subarray(pos + 3, pos + 35))
    }
    return bytesToHex(Cell.fromBase64(boc).hash())
  } catch {
    return null
  }
}

interface JettonData {
  totalSupply: bigint
  mintable: boolean
  admin: string | null
  walletCodeHash: string | null
}

async function jettonData(client: TonClient, master: string, signal?: AbortSignal): Promise<JettonData | null> {
  try {
    const s = await runGetMethod(client.transport, master, 'get_jetton_data', [], { signal })
    const totalSupply = s.num()
    const mintable = s.num() !== 0n
    const raw = s.address()
    // 零地址也算放弃（有的 Jetton 把 admin 改成 0:000…）
    const admin = raw && /^-?\d+:0{64}$/.test(raw) ? null : raw
    s.skip() // content
    const code = s.entries[4]
    return { totalSupply, mintable, admin, walletCodeHash: code && (code.type === 'cell' || code.type === 'slice') ? codeHashOf(String(code.value)) : null }
  } catch (err) {
    if (signal?.aborted || isNodeFault(err)) throw err
    return null
  }
}

const TON = 10n ** BigInt(TON_DECIMALS)
/** 模拟时持有人钱包里要留给 gas 的 TON */
const GAS_RESERVE = TON / 2n

/** 找能模拟的持有人：余额最多的 Jetton 钱包里 owner 是 v4r2 / v5r1、TON 够付买入和 gas 的 */
async function findHolder(client: TonClient, master: string, need: bigint, signal?: AbortSignal): Promise<{ owner: string; balance: bigint } | null> {
  const res = await client.transport.get<{ jetton_wallets?: Array<{ owner: string; balance: string }> }>('jetton/wallets', { jetton_address: master, exclude_zero_balance: true, sort: 'desc', limit: 50 }, { signal })
  const rows = (res.jetton_wallets ?? []).filter((w) => BigInt(w.balance) > 0n)
  if (!rows.length) return null
  const states = await client.walletStates(
    rows.map((w) => w.owner),
    { signal },
  )
  const i = states.findIndex((s) => s.status === 'active' && (s.walletType === 'wallet v4 r2' || s.walletType === 'wallet v5 r1') && BigInt(s.balance) >= need)
  return i < 0 ? null : { owner: toRawAddress((rows[i] as { owner: string }).owner), balance: BigInt((rows[i] as { balance: string }).balance) }
}

const tax = (actual: bigint | null, quote: bigint | null) => (actual === null || quote === null || quote <= 0n ? null : Math.max(0, 1 - Number((actual * 1_000_000n) / quote) / 1_000_000))

async function tradeCheck(client: TonClient, master: string, options: TokenRiskOptions): Promise<TonTradeCheck> {
  const { signal } = options
  const { swap } = await import('./swap.js')
  const buyAmount = options.buyAmount ?? TON
  const empty: TonTradeCheck = { stage: 'no-holder', protocol: null, buyQuote: null, bought: null, sellQuote: null, sold: null, buyTax: null, sellTax: null, holder: null, error: null }
  let holder: { owner: string; balance: bigint } | null
  if (options.holder) {
    const owner = toRawAddress(options.holder)
    const [b] = await client.multiBalances([{ owner, tokens: [master] }], { signal })
    holder = { owner, balance: BigInt(b?.[0]?.balance ?? '0') }
  } else holder = await findHolder(client, master, buyAmount + GAS_RESERVE, signal)
  if (!holder) {
    // 没有能模拟的持有人：只报价，至少分清有没有池子
    const { buildSwap } = await import('./swap.js')
    try {
      const plan = await buildSwap(client, master, { tokenIn: NATIVE_TON, tokenOut: master, amountIn: buyAmount }, { protocols: options.protocols, signal })
      return { ...empty, protocol: plan.route.protocol, buyQuote: plan.amountOut, error: 'no v4r2 / v5r1 holder with enough TON to simulate with' }
    } catch (err) {
      if (signal?.aborted || isNodeFault(err)) throw err
      const message = err instanceof Error ? err.message : String(err)
      return { ...empty, stage: /No route/.test(message) ? 'no-pool' : 'no-holder', error: message }
    }
  }
  const from = holder.owner
  // 只读的 TON Connect 钱包：dryRun 只模拟（空签名），不会弹窗也不会发送
  const watch = { wallet: { account: { address: from }, device: { features: [{ name: 'SendTransaction', maxMessages: 4 }] } }, sendTransaction: () => Promise.reject(new Error('read-only')) }
  const base = { ...empty, holder: toFriendlyAddress(from, { bounceable: false }) }
  // 滑点放宽到 99%：要量出实际收到的数量（有转账税时比报价少），不让合约按最少数量退款
  const opts = { dryRun: true, slippage: 0.99, protocols: options.protocols, signal }
  let buy
  try {
    buy = await swap(client, watch, { tokenIn: NATIVE_TON, tokenOut: master, amountIn: buyAmount }, opts)
  } catch (err) {
    if (signal?.aborted || isNodeFault(err)) throw err
    const message = err instanceof Error ? err.message : String(err)
    return { ...base, stage: /No route/.test(message) ? 'no-pool' : 'buy-failed', error: message }
  }
  const buyQuote = BigInt(buy.plan.amountOut)
  const bought = buy.amountReceived === null ? null : BigInt(buy.amountReceived)
  const afterBuy = { ...base, protocol: buy.plan.route.protocol, buyQuote: buy.plan.amountOut, bought: buy.amountReceived, buyTax: buy.status === 'simulated' ? tax(bought, buyQuote) : null }
  if (buy.status !== 'simulated') return { ...afterBuy, stage: 'buy-failed', error: buy.error }
  // 卖出：持有人卖出不超过刚买到的数量（模拟不出买入后的状态，用持有人现有的 Jetton）
  const sellAmount = holder.balance < (bought ?? buyQuote) ? holder.balance : (bought ?? buyQuote)
  if (sellAmount <= 0n) return { ...afterBuy, stage: 'no-holder', error: 'the wallet holds none of the jetton to simulate selling' }
  let sell
  try {
    sell = await swap(client, watch, { tokenIn: master, tokenOut: NATIVE_TON, amountIn: sellAmount }, opts)
  } catch (err) {
    if (signal?.aborted || isNodeFault(err)) throw err
    return { ...afterBuy, stage: 'sell-failed', error: err instanceof Error ? err.message : String(err) }
  }
  const sold = sell.amountReceived === null ? null : BigInt(sell.amountReceived)
  return {
    ...afterBuy,
    stage: sell.status === 'simulated' ? 'ok' : 'sell-failed',
    sellQuote: sell.plan.amountOut,
    sold: sell.amountReceived,
    sellTax: sell.status === 'simulated' ? tax(sold, BigInt(sell.plan.amountOut)) : null,
    error: sell.status === 'simulated' ? null : sell.error,
  }
}

function flagsOf(r: Omit<TonTokenRisk, 'flags'>): string[] {
  const flags: string[] = []
  if (r.error === 'not-found') flags.push('not-found')
  if (r.isScam) flags.push('scam')
  if (r.admin && r.mintable) flags.push('mintable')
  if (r.admin) flags.push('admin')
  if (r.admin && r.walletCodeHash && GOVERNED_JETTON_WALLET_CODES.has(r.walletCodeHash)) flags.push('governed')
  if (r.error === undefined && r.walletCodeHash !== null && r.walletCode === null) flags.push('unknown-wallet-code')
  const t = r.trade
  if (t) {
    if (t.stage === 'no-pool') flags.push('no-pool')
    if (t.stage === 'buy-failed') flags.push('cannot-buy')
    if (t.stage === 'sell-failed' || (t.sellTax !== null && t.sellTax >= 0.9)) flags.push('honeypot')
    if (t.buyTax !== null && t.buyTax > 0.1) flags.push('high-buy-tax')
    if (t.sellTax !== null && t.sellTax > 0.1) flags.push('high-sell-tax')
    if ([t.buyTax, t.sellTax].some((v) => v !== null && v > 0.005)) flags.push('has-tax')
  }
  return flags
}

/**
 * 检查 Jetton 的风险：每个代币一次 get_jetton_data（链上），加上一次索引器请求读名称和诈骗标记；simulate: true 时再模拟买入、卖出。
 *
 * ```ts
 * const [risk] = await tokenRisks(ton, [jetton])
 * // { admin: null, mintable: false, isScam: false, walletCode: 'standard', flags: [], … }
 * const [r] = await tokenRisks(ton, [jetton], { simulate: true })
 * r.trade   // { stage: 'ok', buyTax: 0, sellTax: 0, … }
 * ```
 */
export async function tokenRisks(client: TonClient, tokens: readonly string[], options: TokenRiskOptions = {}): Promise<TonTokenRisk[]> {
  const { signal } = options
  const known = { ...KNOWN_JETTON_WALLET_CODES, ...options.knownWalletCodes }
  const valid = tokens.filter((t) => t !== NATIVE_TON && isValidTonAddress(t))
  const details = valid.length ? await client.jettons(valid, { signal }) : []
  const meta = new Map(details.map((d) => [toRawAddress(d.address), d]))
  const out: TonTokenRisk[] = []
  for (const token of tokens) {
    const empty = { token, address: null, name: null, symbol: null, totalSupply: null, mintable: null, admin: null, isScam: false, walletCodeHash: null, walletCode: null, trade: null }
    if (token === NATIVE_TON || !isValidTonAddress(token)) {
      const r = { ...empty, error: 'invalid-address' as const }
      out.push({ ...r, flags: flagsOf(r) })
      continue
    }
    const raw = toRawAddress(token)
    const d = meta.get(raw)
    const data = await jettonData(client, raw, signal)
    const address = toFriendlyAddress(raw, { testOnly: client.network === 'testnet' })
    if (!data) {
      const r = { ...empty, address, name: d?.name ?? null, symbol: d?.symbol ?? null, isScam: d?.isScam ?? false, error: 'not-found' as const }
      out.push({ ...r, flags: flagsOf(r) })
      continue
    }
    const r = {
      ...empty,
      address,
      name: d?.name ?? null,
      symbol: d?.symbol ?? null,
      totalSupply: data.totalSupply.toString(),
      mintable: data.mintable,
      admin: data.admin ? toFriendlyAddress(data.admin, { testOnly: client.network === 'testnet' }) : null,
      isScam: d?.isScam ?? false,
      walletCodeHash: data.walletCodeHash,
      walletCode: data.walletCodeHash ? (known[data.walletCodeHash] ?? null) : null,
      trade: options.simulate ? await tradeCheck(client, raw, options) : null,
    }
    out.push({ ...r, flags: flagsOf(r) })
  }
  return out
}
