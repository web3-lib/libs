/**
 * 模拟（子路径 `@w3lib/ton-batch-call/simulate`）：用 toncenter 的 emulateTrace 模拟一笔交易引起的整条交易链
 * （钱包 → Jetton 钱包 → DEX → …），不检查签名、不发送。输入是本包构建器（buildSwap、buildAddLiquidity、batchCall 的消息…）的消息，
 * 或外部消息 / 内部消息的 BOC。输出：成功与否和可读的错误、每个地址的 TON / Jetton 余额变化、手续费明细、消息体解码和警告
 */
import { isValidTonAddress, parseTonAddress, toFriendlyAddress, toRawAddress } from './address.js'
import type { TonClient } from './client.js'
import { NATIVE_TON, TON_DECIMALS } from './constants.js'
import { decodeExternalMessage, decodeMessage, describeExitCode, describeSkipReason, parseInternalMessage, type DecodedExternal, type DecodedMessage, type DecodedType, type ExitContext } from './decode.js'
import { resolveCallWallets, traceCosts } from './fees.js'
import { formatUnits } from './format.js'
import { toSendMessage, type CallMessage } from './write/batch.js'
import { Cell, bytesToBase64 } from './write/cell.js'
import { buildExternal, emulate, evaluateTrace, type Trace, type TraceMessage, type TraceTx, type WalletContext } from './write/send.js'
import type { TonSignerInput } from './write/signer.js'
import { walletCode } from './write/wallet.js'

/** 一笔要模拟的交易 */
export type SimulateInput =
  /** 一个钱包的一笔交易（与 batchCall / estimateCost 相同）：`from` 可以是钱包地址（只读）、助记词、私钥、TON Connect；messages 可以直接用构建器的 `plan.messages` */
  | { from: TonSignerInput; messages: readonly CallMessage[] }
  /** 外部消息的 BOC（发给钱包的、已签名的；不检查签名，seqno 要对得上），或内部消息的 BOC（要同时给 from） */
  | { boc: string; from?: TonSignerInput }

export interface SimulateOptions {
  /** 外部消息的有效期（秒），默认 60（只影响模拟用的消息） */
  validFor?: number
  /** 也列出合约（DEX、Jetton 钱包…）的余额变化，默认只列钱包 / 普通地址 */
  includeContracts?: boolean
  /** 总是列出这些地址的变化 */
  watch?: readonly string[]
  /** 算美元价值（`/price` 的 tokenPrices，按需加载），默认 false */
  usd?: boolean
  /** 对收到的 Jetton 做风险检查（`/risk`，按需加载），默认 false */
  risk?: boolean
  /** Jetton 转账的 forward TON 超过它时警告（nanoTON），默认 1 TON */
  maxForwardTon?: bigint
  /** 结果里带上原始交易链 */
  includeTrace?: boolean
  signal?: AbortSignal
}

export interface BalanceChange {
  /** 地址（用户友好格式） */
  address: string
  /** 'native'（TON）或 Jetton 主合约（用户友好格式） */
  asset: string
  symbol: string
  decimals: number
  /** 带符号的最小单位 */
  delta: string
  formatted: string
  usd?: number | null
}

export interface SimulationWarning {
  code: string
  severity: 'info' | 'warn' | 'danger'
  message: string
}

export interface SimulationFailure {
  /** 失败的合约 */
  account: string
  phase: 'compute' | 'action' | 'skipped'
  exitCode?: number
  message: string
  /** 消息可回弹，失败后退回给发送者 */
  bounced: boolean
}

export interface SimulationFees {
  /** 整条交易链的手续费（nanoTON）：所有交易的手续费 + 所有消息的转发费 */
  total: string
  /** 钱包付的（交易费 + 发出消息的转发费 + 链上之后钱包自己的交易） */
  wallet: string
  gas: string
  forward: string
  storage: string
  /** 导入外部消息等其他费用 */
  other: string
}

export interface SimulationResult {
  /** 有没有拿到模拟结果：钱包拒绝外部消息、模拟服务不可用、不知道钱包版本时为 false */
  simulated: boolean
  /** 钱包交易成功、消息都发出、后续合约没有失败退回 */
  success: boolean
  /** 失败原因（含退出码的可读说明） */
  error?: string
  /** 整条交易链的 gas（单位） */
  gasUsed: string
  /** 钱包付的手续费（nanoTON，同 fees.wallet） */
  fee?: string
  fees?: SimulationFees
  balanceChanges: BalanceChange[]
  /** TON 没有授权（approve），恒为空 */
  approvalChanges: never[]
  decoded: { type: DecodedType; protocol?: string; method?: string; summary: string; args?: Record<string, unknown> }
  warnings: SimulationWarning[]
  /** 交易链里所有失败的交易 */
  failures: SimulationFailure[]
  /** 钱包发出的消息和它们的解码 */
  messages: Array<{ to: string; value: string; bounce: boolean; decoded: DecodedMessage }>
  /** 发送的钱包（用户友好格式） */
  wallet: string | null
  /** 交易链太长被截断：余额变化、手续费只算了已有的部分 */
  incomplete: boolean
  /** 输入是外部消息 BOC 时：钱包版本、seqno、有效期、各条消息的发送模式 */
  external?: DecodedExternal
  trace?: Trace
}

// ---------------------------------------------------------------------------
// toncenter emulateTrace 的响应（用到的字段）
// ---------------------------------------------------------------------------

interface StateRef {
  balance?: string | null
  account_status?: string | null
  data_hash?: string | null
  code_hash?: string | null
}

interface EmuTx extends TraceTx {
  orig_status?: string
  account_state_before?: StateRef | null
  account_state_after?: StateRef | null
}

interface EmuAction {
  type: string
  success?: boolean
  details?: Record<string, unknown>
}

interface EmuTrace extends Trace {
  actions?: EmuAction[]
  address_book?: Record<string, { user_friendly?: string | null; interfaces?: string[] | null } | undefined>
  data_cells?: Record<string, string>
}

const OP_JETTON_TRANSFER = 0x0f8a7ea5
const OP_JETTON_INTERNAL = 0x178d4519
const OP_BURN = 0x595f07bc
const JETTON_OPS = new Set([OP_JETTON_TRANSFER, OP_JETTON_INTERNAL, OP_BURN])

const DEX: Record<string, string> = { stonfi_v2: 'STON.fi v2', stonfi: 'STON.fi v1', dedust: 'DeDust' }

/** 风险检查里要警告的标记 */
const RISK_WARN = new Set(['scam', 'honeypot', 'cannot-buy', 'high-buy-tax', 'high-sell-tax', 'not-found'])

const num = (v: string | null | undefined) => BigInt(v ?? '0')
const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n)
const internalOuts = (tx: TraceTx) => (tx.out_msgs ?? []).filter((m): m is TraceMessage & { destination: string } => !!m.destination)

let walletCodeHashes: Set<string> | null = null
function isWalletCode(hash: string | null | undefined): boolean {
  walletCodeHashes ??= new Set((['v4r2', 'v5r1'] as const).map((v) => bytesToBase64(walletCode(v).hash())))
  return !!hash && walletCodeHashes.has(hash)
}

/** Jetton 钱包的存储：status:uint4 balance:Coins owner:MsgAddress master:MsgAddress（…） */
function parseJettonWallet(boc: string | undefined): { balance: bigint; owner: string; master: string } | null {
  if (!boc) return null
  try {
    const s = Cell.fromBase64(boc).beginParse()
    s.loadUint(4)
    const balance = s.loadCoins()
    const owner = s.loadAddress()
    const master = s.loadAddress()
    if (!owner || !master) return null
    return { balance, owner: toRawAddress(owner), master: toRawAddress(master) }
  } catch {
    return null
  }
}

function rejectedMessage(reason: string): string {
  const code = /exit code[:=\s]+(-?\d+)/i.exec(reason)
  return code ? `${reason} (${describeExitCode(Number(code[1]), 'wallet')})` : reason
}

/** 交易的失败（不成功的计算 / 动作阶段，或可回弹的消息发给没有代码的账户） */
function failureOf(tx: EmuTx, ctx: ExitContext, label: string, root: boolean): { failure: SimulationFailure; consequential: boolean } | null {
  const d = tx.description
  if (!d) return null
  const bounceable = !!tx.in_msg?.bounce && !tx.in_msg.bounced
  const opName = (tx.in_msg as { decoded_opcode?: string } | null | undefined)?.decoded_opcode
  const via = opName ? ` while handling ${opName}` : ''
  const make = (phase: SimulationFailure['phase'], message: string, exitCode?: number): { failure: SimulationFailure; consequential: boolean } => ({
    failure: { account: label, phase, ...(exitCode === undefined ? {} : { exitCode }), message: `${message}${bounceable ? '; the message bounced' : ''}`, bounced: bounceable },
    consequential: root || bounceable,
  })
  const c = d.compute_ph
  if (c?.skipped) {
    // 不可回弹的消息发给没部署的地址（如给新钱包转 TON）是正常的，不算失败
    return root || bounceable ? make('skipped', `${label}: ${describeSkipReason(c.reason)}${via}`) : null
  }
  if (c && c.success === false) return make('compute', `${label}: ${describeExitCode(c.exit_code ?? -1, ctx)}${via}`, c.exit_code)
  if (d.action && !d.action.success) return make('action', `${label}: ${describeExitCode(d.action.result_code ?? -1, 'action')}${d.action.no_funds ? ' (not enough TON)' : ''}${via}`, d.action.result_code)
  return null
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/**
 * 模拟一笔交易：整条交易链的结果、余额变化、手续费、警告。emulateTrace 不检查签名（外部消息的签名是空的），
 * seqno 用索引器里钱包当前的 seqno
 *
 * ```ts
 * const plan = await buildSwap(ton, owner, { tokenIn: NATIVE_TON, tokenOut: USDT, amountInFormatted: '1' })
 * const sim = await simulateTransaction(ton, { from: owner, messages: plan.messages })
 * if (!sim.success) throw new Error(sim.error)
 * sim.balanceChanges   // [{ address, asset: 'native', delta: '-1203000000', … }, { asset: 'EQCxE6…', delta: '1341803', formatted: '1.341803', … }]
 * ```
 */
export async function simulateTransaction(client: TonClient, input: SimulateInput, options: SimulateOptions = {}): Promise<SimulationResult> {
  const { signal } = options
  const empty = (error: string, simulated = false, extra: Partial<SimulationResult> = {}): SimulationResult => ({
    simulated,
    success: false,
    error,
    gasUsed: '0',
    balanceChanges: [],
    approvalChanges: [],
    decoded: { type: 'unknown', summary: 'Not simulated' },
    warnings: [],
    failures: [],
    messages: [],
    wallet: null,
    incomplete: false,
    ...extra,
  })

  // 1. 外部消息：BOC 直接给，或由消息和钱包构建
  let ext: Cell
  let wallet: WalletContext | null = null
  let external: DecodedExternal | undefined
  let messages: readonly CallMessage[] | null = null
  if ('boc' in input) {
    const root = Cell.fromBase64(input.boc)
    const tag = root.bits >= 2 ? (root.data[0] as number) >> 6 : -1
    if (tag === 2) {
      ext = root
      try {
        external = decodeExternalMessage(root)
      } catch {
        // 不是 v4r2 / v5r1 的消息：照样模拟，只是没有解码
      }
    } else if (tag === 0 || tag === 1) {
      // 内部消息的第一位是 0，第二位是 ihr_disabled（本库的构建器置 1）
      if (input.from === undefined) throw new Error('An internal message BOC needs `from` (the wallet that sends it)')
      const m = parseInternalMessage(root)
      if (m.init === 'inline') throw new Error('Internal messages with an inline StateInit are not supported: pass `messages` with `init` instead')
      messages = [{ to: m.to, value: m.value, bounce: m.bounce, body: m.body, init: m.init }]
      ext = Cell.EMPTY
    } else throw new Error('Unsupported message BOC: expected an external-in or an internal message')
  } else {
    messages = input.messages
    ext = Cell.EMPTY
  }
  if (messages) {
    if (!messages.length) return empty('nothing to send')
    const [w] = await resolveCallWallets(client, [(input as { from: TonSignerInput }).from as TonSignerInput], signal)
    wallet = w as WalletContext
    if (wallet.status === 'frozen') return empty('The wallet is frozen', false, { wallet: wallet.friendly })
    if (!wallet.version) return empty('Cannot simulate: unknown wallet version (the wallet is not deployed, or not a v4r2 / v5r1 wallet)', false, { wallet: wallet.friendly })
    if (messages.length > wallet.maxMessages) return empty(`Too many messages for one transaction: ${messages.length} > ${wallet.maxMessages}`, false, { wallet: wallet.friendly })
    ext = await buildExternal(wallet, { seqno: wallet.seqno, deployed: wallet.status === 'active' }, messages.map(toSendMessage), Math.floor(Date.now() / 1000) + (options.validFor ?? 60), true)
  }

  // 2. 模拟（带上交易链里的动作分类、地址簿）
  const emulated = await emulate(client, ext, true, signal, { with_actions: true, include_address_book: true, include_metadata: true })
  if (emulated.rejected) return empty(`simulation failed: ${rejectedMessage(emulated.rejected)}`, false, { wallet: wallet?.friendly ?? external?.wallet ?? null, ...(external ? { external } : {}) })
  // 钱包不接受外部消息时 toncenter 返回 500 “EmulationExternalNotAccepted: <退出码>”
  const notAccepted = /EmulationExternalNotAccepted:\s*(-?\d+)/.exec(emulated.unavailable ?? '')
  if (notAccepted) return empty(`simulation failed: the wallet rejected the message (${describeExitCode(Number(notAccepted[1]), 'wallet')})`, false, { wallet: wallet?.friendly ?? external?.wallet ?? null, ...(external ? { external } : {}) })
  if (!emulated.trace) return empty(`simulation unavailable: ${emulated.unavailable}`, false, { wallet: wallet?.friendly ?? external?.wallet ?? null, ...(external ? { external } : {}) })
  const trace = emulated.trace as EmuTrace
  const result = await analyze(client, trace, wallet, options)
  return { ...result, ...(external ? { external } : {}), ...(options.includeTrace ? { trace } : {}) }
}

async function analyze(client: TonClient, trace: EmuTrace, walletCtx: WalletContext | null, options: SimulateOptions): Promise<SimulationResult> {
  const { signal } = options
  const testOnly = client.network === 'testnet'
  const txs = Object.values(trace.transactions) as EmuTx[]
  const root = trace.transactions[trace.trace.tx_hash] as EmuTx
  const walletRaw = toRawAddress(root.account)
  const book = new Map(Object.entries(trace.address_book ?? {}).map(([k, v]) => [toRawAddress(k), v]))
  const friendly = (raw: string, wallet = false) => book.get(raw)?.user_friendly ?? toFriendlyAddress(raw, { testOnly, bounceable: !wallet })
  const incomplete = !!trace.is_incomplete

  // 账户：每个账户的交易、是不是普通地址（钱包 / 没部署的），Jetton 钱包的余额变化
  const accountTxs = new Map<string, EmuTx[]>()
  for (const tx of txs) {
    const raw = toRawAddress(tx.account)
    accountTxs.set(raw, [...(accountTxs.get(raw) ?? []), tx])
  }
  const isUser = (raw: string): boolean => {
    const list = accountTxs.get(raw)
    if (!list) return true
    if (jettonWallets.has(raw)) return false
    const first = list[0] as EmuTx
    const interfaces = book.get(raw)?.interfaces ?? []
    return raw === walletRaw || interfaces.some((i) => i.startsWith('wallet')) || (!!first.orig_status && first.orig_status !== 'active') || isWalletCode(first.account_state_before?.code_hash ?? first.account_state_after?.code_hash)
  }
  const tonDelta = new Map<string, bigint>()
  const jettonDelta = new Map<string, { owner: string; master: string; delta: bigint }>()
  const jettonWallets = new Map<string, { owner: string; master: string }>()
  const cells = trace.data_cells ?? {}
  for (const tx of txs) {
    const raw = toRawAddress(tx.account)
    const before = tx.account_state_before
    const after = tx.account_state_after
    tonDelta.set(raw, (tonDelta.get(raw) ?? 0n) + num(after?.balance) - num(before?.balance))
    const op = Number(tx.in_msg?.opcode ?? -1)
    if (!JETTON_OPS.has(op) && !tx.in_msg?.bounced) continue
    const a = parseJettonWallet(after?.data_hash ? cells[after.data_hash] : undefined)
    if (!a) continue
    const b = before?.data_hash ? parseJettonWallet(cells[before.data_hash]) : null
    jettonWallets.set(raw, { owner: a.owner, master: a.master })
    const key = `${a.owner}|${a.master}`
    const prev = jettonDelta.get(key)
    jettonDelta.set(key, { owner: a.owner, master: a.master, delta: (prev?.delta ?? 0n) + a.balance - (b?.balance ?? 0n) })
  }

  // 元数据：涉及的 Jetton
  const actions = trace.actions ?? []
  const actionMasters = actions.flatMap((a) => [a.details?.asset_in, a.details?.asset_out, a.details?.asset, a.details?.asset_1, a.details?.asset_2]).filter((x): x is string => typeof x === 'string' && isValidTonAddress(x))
  const masters = [...new Set([...[...jettonDelta.values()].map((j) => j.master), ...actionMasters.map(toRawAddress)])]
  const metas = new Map<string, { symbol: string; decimals: number; isScam: boolean; address: string }>()
  if (masters.length) {
    const details = await client.jettons(masters, { signal }).catch(() => [])
    details.forEach((d, i) => {
      const raw = masters[i] as string
      metas.set(raw, { symbol: d.symbol ?? short(d.address), decimals: d.decimals, isScam: d.isScam, address: d.address })
    })
  }
  const meta = (raw: string) => metas.get(raw) ?? { symbol: short(friendly(raw)), decimals: TON_DECIMALS, isScam: false, address: friendly(raw) }
  const fmtAsset = (raw: string | null, amount: bigint) => (raw === null ? `${formatUnits(amount, TON_DECIMALS)} TON` : `${formatUnits(amount, meta(raw).decimals)} ${meta(raw).symbol}`)

  // 余额变化
  const watch = new Set((options.watch ?? []).filter(isValidTonAddress).map(toRawAddress))
  const shown = (raw: string) => options.includeContracts || watch.has(raw) || isUser(raw)
  const changes: BalanceChange[] = []
  const owners = [walletRaw, ...[...tonDelta.keys(), ...[...jettonDelta.values()].map((j) => j.owner), ...watch].filter((o) => o !== walletRaw)]
  for (const raw of [...new Set(owners)]) {
    if (!shown(raw)) continue
    const address = friendly(raw, isUser(raw))
    const ton = tonDelta.get(raw) ?? 0n
    if (ton !== 0n) changes.push({ address, asset: 'native', symbol: 'TON', decimals: TON_DECIMALS, delta: ton.toString(), formatted: formatUnits(ton, TON_DECIMALS) })
    for (const j of jettonDelta.values()) {
      if (j.owner !== raw || j.delta === 0n) continue
      const m = meta(j.master)
      changes.push({ address, asset: m.address, symbol: m.symbol, decimals: m.decimals, delta: j.delta.toString(), formatted: formatUnits(j.delta, m.decimals) })
    }
  }
  if (options.usd && changes.length) {
    try {
      const { tokenPrices } = await import('./price.js')
      const tokens = [...new Set(changes.map((c) => (c.asset === 'native' ? NATIVE_TON : c.asset)))]
      const prices = await tokenPrices(client, tokens, { signal })
      const byToken = new Map(prices.map((p) => [p.token, p.price]))
      for (const c of changes) {
        const price = byToken.get(c.asset === 'native' ? NATIVE_TON : c.asset)
        c.usd = price == null ? null : Number(c.formatted) * price
      }
    } catch {
      for (const c of changes) c.usd = null
    }
  }

  // 失败
  const failures: SimulationFailure[] = []
  let firstError: string | null = null
  const visit = (node: Trace['trace'], depth: number) => {
    const tx = trace.transactions[node.tx_hash] as EmuTx | undefined
    if (tx) {
      const raw = toRawAddress(tx.account)
      const ctx: ExitContext = depth === 0 ? 'wallet' : jettonWallets.has(raw) ? 'jetton' : 'compute'
      const f = failureOf(tx, ctx, friendly(raw, isUser(raw)), depth === 0)
      if (f) {
        failures.push(f.failure)
        if (f.consequential && firstError === null) firstError = f.failure.message
      }
    }
    for (const child of node.children ?? []) visit(child as Trace['trace'], depth + 1)
  }
  visit(trace.trace, 0)
  const verdict = evaluateTrace(trace, root.account)
  const error = firstError ?? verdict.error
  // 交易链被截断时看不到后面的失败
  const success = error === null

  // 手续费
  const costs = traceCosts(trace, walletRaw)
  const allFees = sum(txs.map((tx) => num(tx.total_fees) + sum(internalOuts(tx).map((m) => num(m.fwd_fee)))))
  const gas = sum(txs.map((tx) => num(tx.description?.compute_ph?.gas_fees)))
  const storage = sum(txs.map((tx) => num(tx.description?.storage_ph?.storage_fees_collected)))
  const forward = sum(txs.map((tx) => num(tx.description?.action?.total_action_fees) + sum(internalOuts(tx).map((m) => num(m.fwd_fee)))))
  const fees: SimulationFees = { total: allFees.toString(), wallet: costs.fee.toString(), gas: gas.toString(), forward: forward.toString(), storage: storage.toString(), other: (allFees - gas - storage - forward).toString() }
  const gasUsed = sum(txs.map((tx) => num((tx.description?.compute_ph as { gas_used?: string } | undefined)?.gas_used)))

  // 消息解码：钱包发出的内部消息
  const sent = internalOuts(root).map((m) => ({ to: friendly(toRawAddress(m.destination)), toRaw: toRawAddress(m.destination), value: m.value ?? '0', bounce: !!m.bounce, decoded: decodeMessage(m.message_content?.body) }))
  const warnings: SimulationWarning[] = []
  const warn = (code: string, severity: SimulationWarning['severity'], message: string) => warnings.push({ code, severity, message })
  if (incomplete) warn('trace-incomplete', 'info', 'The transaction chain is too long and was cut off: balance changes and fees only cover the part that was emulated')
  const maxForward = options.maxForwardTon ?? 1_000_000_000n
  for (const m of sent) {
    if (!m.decoded.known) warn('unknown-opcode', 'info', `Message to ${m.to} has an unknown op ${m.decoded.opcode ?? '(no op)'}: its effect cannot be shown`)
    const forwardTon = m.decoded.name === 'jetton_transfer' ? BigInt(String(m.decoded.args.forwardTonAmount ?? '0')) : 0n
    if (forwardTon > maxForward) warn('high-forward-amount', 'warn', `Jetton transfer forwards ${formatUnits(forwardTon, TON_DECIMALS)} TON to the recipient`)
  }
  // 可回弹的消息发给没部署的账户：会弹回
  for (const tx of txs) {
    if (tx === root || !tx.in_msg?.bounce || tx.in_msg.bounced || !tx.in_msg.source || toRawAddress(tx.in_msg.source) !== walletRaw) continue
    if ((tx.orig_status === 'uninit' || tx.orig_status === 'nonexist') && tx.description?.compute_ph?.skipped) {
      warn('bounceable-to-uninit', 'warn', `The message to ${friendly(toRawAddress(tx.account))} is bounceable but the account is not deployed: it bounces back (use bounce: false for plain transfers to new wallets)`)
    }
  }
  // 掏空余额
  const balanceBefore = num(root.account_state_before?.balance)
  const spent = -(tonDelta.get(walletRaw) ?? 0n)
  if (balanceBefore > 0n && spent * 10n > balanceBefore * 9n) warn('drains-balance', 'warn', `This transaction spends ${formatUnits(spent, TON_DECIMALS)} of the wallet's ${formatUnits(balanceBefore, TON_DECIMALS)} TON`)
  // Jetton 转账的收款地址是合约（不是钱包）：Jetton 可能卡在里面
  const targets = [...new Set(sent.filter((m) => m.decoded.name === 'jetton_transfer' && m.decoded.type === 'transfer' && typeof m.decoded.args.destination === 'string').map((m) => m.decoded.args.destination as string))]
  if (targets.length) {
    const states = await client.walletStates(targets, { signal }).catch(() => [])
    states.forEach((s, i) => {
      if (s.success && s.status === 'active' && !s.isWallet) warn('jetton-to-contract', 'warn', `${targets[i]} is a contract, not a wallet: the jettons sent there may be stuck`)
    })
  }
  // 收到的 Jetton：索引器的诈骗标记，可选的风险检查
  const received = [...new Set(changes.filter((c) => c.asset !== 'native' && BigInt(c.delta) > 0n && parseTonAddress(c.address) && toRawAddress(c.address) === walletRaw).map((c) => c.asset))]
  for (const asset of received) if (metas.get(toRawAddress(asset))?.isScam) warn('scam-token', 'danger', `${metas.get(toRawAddress(asset))?.symbol} (${asset}) is flagged as a scam token by the indexer`)
  if (options.risk && received.length) {
    try {
      const { tokenRisks } = await import('./risk.js')
      for (const r of await tokenRisks(client, received, { signal })) {
        const hit = r.flags.filter((f) => RISK_WARN.has(f) && f !== 'scam')
        if (hit.length) warn('token-risk', 'danger', `${r.symbol ?? r.token} (${r.address ?? r.token}): ${hit.join(', ')}`)
      }
    } catch {
      warn('risk-unavailable', 'info', 'The token risk check failed and was skipped')
    }
  }

  // 汇总的解码
  const done = (type: string) => actions.find((a) => a.type === type && a.success !== false)
  const swapAction = done('jetton_swap')
  const deposit = done('dex_deposit_liquidity')
  const withdraw = done('dex_withdraw_liquidity')
  const dexOf = (a: EmuAction) => DEX[String(a.details?.dex)] ?? (a.details?.dex ? String(a.details.dex) : undefined)
  const rawOf = (v: unknown) => (typeof v === 'string' && isValidTonAddress(v) ? toRawAddress(v) : null)
  const amountOf = (v: unknown) => BigInt(String(v ?? '0'))
  let decoded: SimulationResult['decoded']
  const argsOf = { messages: sent.map((m) => m.decoded), actions: actions.map((a) => a.type) }
  if (swapAction) {
    const d = swapAction.details as { dex_incoming_transfer?: { asset?: unknown; amount?: unknown }; dex_outgoing_transfer?: { asset?: unknown; amount?: unknown } }
    const protocol = dexOf(swapAction)
    const sold = fmtAsset(rawOf(d.dex_incoming_transfer?.asset), amountOf(d.dex_incoming_transfer?.amount))
    const bought = fmtAsset(rawOf(d.dex_outgoing_transfer?.asset), amountOf(d.dex_outgoing_transfer?.amount))
    decoded = { type: 'swap', ...(protocol ? { protocol } : {}), method: 'jetton_swap', summary: `Swap ${sold} for ${bought}${protocol ? ` on ${protocol}` : ''}`, args: { ...argsOf, sold, bought } }
  } else if (deposit || withdraw) {
    const a = (deposit ?? withdraw) as EmuAction
    const protocol = dexOf(a)
    const d = a.details as { amount_1?: unknown; amount_2?: unknown; asset_1?: unknown; asset_2?: unknown; lp_tokens_minted?: unknown; lp_tokens_burnt?: unknown }
    const parts = [d.amount_1 != null ? fmtAsset(rawOf(d.asset_1), amountOf(d.amount_1)) : null, d.amount_2 != null ? fmtAsset(rawOf(d.asset_2), amountOf(d.amount_2)) : d.asset_2 === null && d.amount_2 === null ? null : null].filter(Boolean)
    decoded = { type: 'liquidity', ...(protocol ? { protocol } : {}), method: a.type, summary: `${deposit ? 'Add' : 'Remove'} liquidity${parts.length ? ` (${parts.join(' + ')})` : ''}${protocol ? ` on ${protocol}` : ''}`, args: argsOf }
  } else {
    decoded = summarize(sent, argsOf, jettonWallets, fmtAsset)
  }
  // 兑换发出了、但没有兑换的结果：多半被退款了
  if (success && !incomplete && decoded.type === 'swap' && !swapAction && actions.length) warn('swap-not-executed', 'danger', 'The swap message was sent but the chain shows no executed swap: it was probably refunded (price moved beyond the minimum, or the pool rejected it)')

  return {
    simulated: true,
    success,
    ...(error === null ? {} : { error }),
    gasUsed: gasUsed.toString(),
    fee: fees.wallet,
    fees,
    balanceChanges: changes,
    approvalChanges: [],
    decoded,
    warnings,
    failures,
    messages: sent.map(({ toRaw: _raw, ...m }) => m),
    wallet: walletCtx?.friendly ?? friendly(walletRaw, true),
    incomplete,
  }
}

/** 没有 DEX 动作时，从钱包发出的消息的解码里汇总 */
function summarize(
  sent: Array<{ to: string; toRaw: string; value: string; decoded: DecodedMessage }>,
  args: Record<string, unknown>,
  jettonWallets: Map<string, { owner: string; master: string }>,
  fmtAsset: (raw: string | null, amount: bigint) => string,
): SimulationResult['decoded'] {
  if (!sent.length) return { type: 'unknown', summary: 'The wallet sent no messages', args }
  const describe = (m: (typeof sent)[number]): string => {
    const d = m.decoded
    if (d.name === 'empty' || d.name === 'comment') return `Send ${fmtAsset(null, BigInt(m.value))} to ${m.to}${d.name === 'comment' ? ` (comment ${JSON.stringify(d.args.comment)})` : ''}`
    if (d.name === 'jetton_transfer' && d.type === 'transfer') {
      const master = jettonWallets.get(m.toRaw)?.master ?? null
      const amount = BigInt(String(d.args.amount))
      return `Send ${master ? fmtAsset(master, amount) : `${amount} jetton units`} to ${d.args.destination}`
    }
    return d.summary
  }
  const types = new Set(sent.map((m) => m.decoded.type))
  const single = sent.length === 1 ? (sent[0] as (typeof sent)[number]) : null
  const type: DecodedType = types.size === 1 ? (types.values().next().value as DecodedType) : 'contract'
  const protocols = [...new Set(sent.map((m) => m.decoded.protocol).filter((p): p is string => !!p))]
  const lines = sent.slice(0, 3).map(describe)
  const summary = sent.length === 1 ? lines[0] : `${sent.length} messages: ${lines.join('; ')}${sent.length > 3 ? `; +${sent.length - 3} more` : ''}`
  return { type, ...(protocols.length === 1 ? { protocol: protocols[0] } : {}), ...(single ? { method: single.decoded.name } : {}), summary: summary as string, args }
}
