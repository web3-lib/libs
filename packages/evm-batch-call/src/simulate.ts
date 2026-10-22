/**
 * 交易模拟（子路径 `@w3lib/evm-batch-call/simulate`）：发送前先看会发生什么——成不成功、花多少 gas、哪些资产进出、给了什么授权、风险提示。
 *
 * - EVM：`eth_simulateV1`（公共节点 publicnode / drpc / mainnet.base.org / bsc-dataseed 等都支持）：一次请求执行一串交易、状态逐笔延续，
 *   `traceTransfers` 把主币转账也变成日志；资产变化和授权变化都从日志里算（ERC20 / 721 / 1155 Transfer、WETH Deposit / Withdrawal、Approval、
 *   ApprovalForAll、Permit2 Approval）。不支持时退回 `eth_call` + `eth_estimateGas`：只能知道成不成功和 gas，资产变化只能按 calldata 估
 * - Tron：`triggerconstantcontract`（能量、日志里的 TRC20 Transfer / Approval）；TRX 的变化只有 call_value
 */
import { getBigInt, id, toBeHex, type BigNumberish } from 'ethers'

import { knownSpenders } from './approvals.js'
import type { BlockTag } from './aggregate.js'
import { getNativeCurrency } from './chains.js'
import { NATIVE_TOKEN, UNLIMITED_ALLOWANCE_THRESHOLD, formatUnits } from './erc20.js'
import { isExecutionError } from './errors.js'
import { errorText } from './fallback.js'
import type { Provider } from './provider.js'
import { decodeCalldata, decodeRevert, type DecodedCall } from './simulateDecode.js'
import { TronProvider, isTronChain, toEvmAddress, toTronAddress } from './tron.js'

export { decodeCalldata, decodeRevert, type DecodedCall, type DecodedType } from './simulateDecode.js'

/** 要模拟的交易，字段与 buildSwap / buildRevokes / 流动性构建的 transactions 里的一致（多出来的字段忽略） */
export interface SimulateTx {
  from?: string
  to?: string
  data?: string
  /** 附带的主币（最小单位；Tron 是 sun） */
  value?: BigNumberish
  gas?: BigNumberish
}

/** 状态覆盖（eth_call / eth_simulateV1 的格式）：改余额、nonce、代码、存储 */
export type StateOverrides = Record<string, { balance?: string; nonce?: string; code?: string; state?: Record<string, string>; stateDiff?: Record<string, string> }>

export interface SimulateOptions {
  /** 发送者（交易里没有 from 时用），也是资产变化 / 授权变化的主体 */
  from?: string
  /** 另外要统计资产变化、授权的地址（默认只有 from） */
  watch?: readonly string[]
  /** 按这个区块的状态模拟（默认最新） */
  blockTag?: BlockTag
  stateOverrides?: StateOverrides
  /** 每笔交易的 gas 上限，默认 min(1000 万, 2500 万 / 笔数)：不同节点限制一个模拟里的总 gas */
  gas?: bigint
  /** 估算手续费（gasUsed × 当前 gas 价格；不含 L1 数据费），默认 true */
  fee?: boolean
  /** 给资产变化带美元价值（用 /price，按需加载）：true 用默认价格源，或传 tokenPrices 的 sources */
  usd?: boolean | import('./price.js').TokenPricesOptions['sources']
  /** 对收到的代币做风险检查（用 /risk，按需加载，只支持 EVM 的 V2 池子能买卖的代币），有问题时加进 warnings */
  risk?: boolean
  /** 不用 eth_simulateV1，直接 eth_call + estimateGas（调试 / 节点行为不一致时） */
  forceCall?: boolean
}

export type WarningSeverity = 'info' | 'warn' | 'danger'

export interface SimulationWarning {
  severity: WarningSeverity
  /**
   * unlimited-approval / unknown-spender / approve-to-eoa / unlimited-nft-approval / no-code / large-value /
   * token-risk / unknown-method / no-logs / no-state / reverted
   */
  code: string
  message: string
  /** 相关地址：授权类提示是被授权方，token-risk 是代币 */
  address?: string
}

export interface BalanceChange {
  address: string
  /** 代币地址；主币是 'native' */
  asset: string
  symbol: string | null
  decimals: number
  /** 带符号的最小单位数量 */
  delta: string
  formatted: string
  usd?: number | null
  /** NFT（721 / 1155）：tokenId，数量是个数 */
  tokenId?: string
  standard: 'native' | 'erc20' | 'erc721' | 'erc1155'
}

export interface ApprovalChange {
  type: 'erc20' | 'permit2' | 'nft' | 'nft-token'
  owner: string
  /** 代币 / NFT 合约 */
  token: string
  symbol: string | null
  /** 被授权方（ERC20 的 spender、Permit2 的 spender、NFT 的 operator / approved） */
  spender: string
  spenderName?: string
  /** 新的额度（最小单位）；NFT 的 ApprovalForAll 是 '1' / '0'，单个 NFT 是 tokenId */
  amount: string
  unlimited: boolean
  /** 授权被取消（额度 0 / setApprovalForAll false） */
  revoked: boolean
  /** Permit2：授权到期的时间（秒） */
  expiration?: number
}

/** 一条转账（所有地址之间的，不只是 from 的） */
export interface SimulatedTransfer {
  asset: string
  from: string
  to: string
  amount: string
  tokenId?: string
  standard: BalanceChange['standard']
}

export interface SimulationResult {
  success: boolean
  /** 失败原因：解码后的 revert 原因（Error / Panic / 常见自定义错误）或节点给的错误信息 */
  error?: string
  /** revert 的原始数据 */
  revertData?: string
  /** 消耗的 gas（Tron 是能量） */
  gasUsed: string
  /** 估算的手续费（wei），不含 L1 数据费；Tron 没有 */
  fee?: string
  balanceChanges: BalanceChange[]
  approvalChanges: ApprovalChange[]
  decoded: {
    type: DecodedCall['type']
    protocol?: string
    method?: string
    summary: string
    args?: Record<string, unknown>
    calls?: DecodedCall[]
  }
  warnings: SimulationWarning[]
  transfers: SimulatedTransfer[]
  /** 原始日志 */
  logs?: Array<{ address: string; topics: string[]; data: string }>
  /** 用的模拟方式：'simulateV1'（有日志）、'eth_call'（只有成败和 gas）、'tron' */
  mode: 'simulateV1' | 'eth_call' | 'tron'
  returnData?: string
}

export interface BatchSimulationResult {
  /** 全部成功 */
  success: boolean
  /** 每笔交易的结果，与输入一一对应 */
  results: SimulationResult[]
  /** 第一笔失败的下标 */
  failedIndex?: number
  gasUsed: string
  fee?: string
  /** 汇总（同一个资产、同一个地址的变化相加；授权取最后的状态） */
  balanceChanges: BalanceChange[]
  approvalChanges: ApprovalChange[]
  warnings: SimulationWarning[]
  mode: SimulationResult['mode']
}

type RawLog = { address: string; topics: string[]; data: string }

interface RawCall {
  success: boolean
  gasUsed: bigint
  returnData: string
  error?: string
  logs: RawLog[]
}

const NATIVE_LOG_ADDRESS = NATIVE_TOKEN.toLowerCase()
const ZERO = '0x0000000000000000000000000000000000000000'
const T = {
  transfer: id('Transfer(address,address,uint256)'),
  single: id('TransferSingle(address,address,address,uint256,uint256)'),
  batch: id('TransferBatch(address,address,address,uint256[],uint256[])'),
  deposit: id('Deposit(address,uint256)'),
  withdrawal: id('Withdrawal(address,uint256)'),
  approval: id('Approval(address,address,uint256)'),
  approvalAll: id('ApprovalForAll(address,address,bool)'),
  permit2Approval: id('Approval(address,address,address,uint160,uint48)'),
  permit2Permit: id('Permit(address,address,address,uint160,uint48,uint48)'),
  lockdown: id('Lockdown(address,address,address)'),
}
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'

const addr = (topic: string | undefined) => `0x${(topic ?? '').slice(-40)}`.toLowerCase()
const num = (hex: string | undefined) => (hex && hex !== '0x' ? BigInt(hex) : 0n)
const word = (data: string, i: number) => `0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`

// ---------------------------------------------------------------------------
// 日志 → 转账 / 授权
// ---------------------------------------------------------------------------

type Move = SimulatedTransfer & { fromL: string; toL: string; value: bigint }

function parseTransfers(logs: readonly RawLog[]): Move[] {
  const moves: Move[] = []
  const push = (asset: string, from: string, to: string, value: bigint, standard: Move['standard'], tokenId?: string) =>
    moves.push({ asset, from, to, amount: value.toString(), standard, ...(tokenId === undefined ? {} : { tokenId }), fromL: from.toLowerCase(), toL: to.toLowerCase(), value })
  const has = (log: RawLog, from: string, to: string, value: bigint) =>
    logs.some((l) => l.address.toLowerCase() === log.address && l.topics[0] === T.transfer && l.topics.length === 3 && addr(l.topics[1]) === from && addr(l.topics[2]) === to && num(l.data) === value)
  for (const log of logs) {
    const [topic0] = log.topics
    const address = log.address.toLowerCase()
    if (topic0 === T.transfer && log.topics.length === 3) {
      push(address === NATIVE_LOG_ADDRESS ? 'native' : address, addr(log.topics[1]), addr(log.topics[2]), num(log.data), address === NATIVE_LOG_ADDRESS ? 'native' : 'erc20')
    } else if (topic0 === T.transfer && log.topics.length === 4) {
      push(address, addr(log.topics[1]), addr(log.topics[2]), 1n, 'erc721', BigInt(log.topics[3] as string).toString())
    } else if (topic0 === T.single && log.topics.length === 4) {
      push(address, addr(log.topics[2]), addr(log.topics[3]), num(word(log.data, 1)), 'erc1155', num(word(log.data, 0)).toString())
    } else if (topic0 === T.batch && log.topics.length === 4) {
      // data: ids 偏移、values 偏移、ids 长度 + 元素、values 长度 + 元素
      const n = Number(num(word(log.data, 2)))
      if (n > 0 && n < 1000) for (let i = 0; i < n; i++) push(address, addr(log.topics[2]), addr(log.topics[3]), num(word(log.data, 4 + n + i)), 'erc1155', num(word(log.data, 3 + i)).toString())
    } else if ((topic0 === T.deposit || topic0 === T.withdrawal) && log.topics.length === 2) {
      // WETH9 的存入 / 取出只有 Deposit / Withdrawal 事件，没有 Transfer；同时发了 Transfer 的合约不重复算
      const who = addr(log.topics[1])
      const value = num(log.data)
      const [from, to] = topic0 === T.deposit ? [ZERO, who] : [who, ZERO]
      if (!has({ ...log, address }, from, to, value)) push(address, from, to, value, 'erc20')
    }
  }
  return moves
}

type Approve = Omit<ApprovalChange, 'symbol' | 'spenderName'>

function parseApprovals(logs: readonly RawLog[]): Approve[] {
  const out: Approve[] = []
  for (const log of logs) {
    const [topic0] = log.topics
    const token = log.address.toLowerCase()
    if (topic0 === T.approval && log.topics.length === 3) {
      const amount = num(log.data)
      out.push({ type: 'erc20', owner: addr(log.topics[1]), token, spender: addr(log.topics[2]), amount: amount.toString(), unlimited: amount >= UNLIMITED_ALLOWANCE_THRESHOLD, revoked: amount === 0n })
    } else if (topic0 === T.approval && log.topics.length === 4) {
      const spender = addr(log.topics[2])
      out.push({ type: 'nft-token', owner: addr(log.topics[1]), token, spender, amount: BigInt(log.topics[3] as string).toString(), unlimited: false, revoked: spender === ZERO })
    } else if (topic0 === T.approvalAll && log.topics.length === 3) {
      const on = num(log.data) !== 0n
      out.push({ type: 'nft', owner: addr(log.topics[1]), token, spender: addr(log.topics[2]), amount: on ? '1' : '0', unlimited: on, revoked: !on })
    } else if (token === PERMIT2 && (topic0 === T.permit2Approval || topic0 === T.permit2Permit) && log.topics.length === 4) {
      const amount = num(word(log.data, 0))
      out.push({
        type: 'permit2',
        owner: addr(log.topics[1]),
        token: addr(log.topics[2]),
        spender: addr(log.topics[3]),
        amount: amount.toString(),
        unlimited: amount >= UNLIMITED_ALLOWANCE_THRESHOLD,
        revoked: amount === 0n,
        expiration: Number(num(word(log.data, 1))),
      })
    } else if (token === PERMIT2 && topic0 === T.lockdown && log.topics.length === 2) {
      // Lockdown(address indexed owner, address token, address spender)：只有 owner 是 indexed，token / spender 在 data 里
      out.push({ type: 'permit2', owner: addr(log.topics[1]), token: addr(word(log.data, 0)), spender: addr(word(log.data, 1)), amount: '0', unlimited: false, revoked: true })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 节点请求
// ---------------------------------------------------------------------------

type Sender = { send(method: string, params: unknown[]): Promise<unknown> }

async function nodes() {
  const { runOnNodes } = await import('./write/rpc.js')
  return runOnNodes
}

const hex = (value: BigNumberish) => toBeHex(getBigInt(value))

interface NormalizedTx {
  from: string
  to?: string
  data: string
  value: bigint
  gas?: bigint
}

function normalize(tx: SimulateTx, from: string | undefined, tron: boolean): NormalizedTx {
  const f = tx.from ?? from
  if (!f) throw new Error('simulate requires a sender: pass tx.from or options.from')
  const conv = (a: string) => (tron ? toEvmAddress(a) : a)
  return { from: conv(f), ...(tx.to ? { to: conv(tx.to) } : {}), data: tx.data && tx.data !== '0x' ? tx.data : '0x', value: tx.value === undefined ? 0n : getBigInt(tx.value), ...(tx.gas === undefined ? {} : { gas: getBigInt(tx.gas) }) }
}

const UNSUPPORTED_RE = /not (supported|available|whitelisted|allowed|found)|does not exist|unknown method|method not|-32601|disabled|discontinued|adjustable limit|invalid (params|argument)|unrecognized|too many|rate.?limit/i
/** ethers 把节点的错误包成 “…; could not coalesce error”，去掉这段噪音 */
const cleanError = (err: unknown) => errorText(err).replace(/;\s*could not coalesce error.*$/s, '')

// 交易本身的问题（换节点结果一样）：直接作为模拟失败的原因
const TX_ERROR_RE = /insufficient funds|intrinsic gas|max fee per gas|nonce too|execution reverted|invalid sender/i

async function simulateV1(provider: Provider, txs: NormalizedTx[], options: SimulateOptions): Promise<RawCall[]> {
  const run = await nodes()
  const perCall = options.gas ?? BigInt(Math.min(10_000_000, Math.floor(25_000_000 / txs.length)))
  const calls = txs.map((t) => ({ from: t.from, ...(t.to ? { to: t.to } : {}), data: t.data, value: hex(t.value), gas: hex(t.gas ?? perCall) }))
  const block = { calls, ...(options.stateOverrides ? { stateOverrides: options.stateOverrides } : {}) }
  const tag = options.blockTag === undefined ? 'latest' : typeof options.blockTag === 'number' ? hex(options.blockTag) : options.blockTag
  const result = (await run(
    provider.rpc,
    'simulate',
    async (node) => {
      if (typeof (node as Partial<Sender>).send !== 'function') throw new Error('eth_simulateV1 is not supported by this node')
      return (node as unknown as Sender).send('eth_simulateV1', [{ blockStateCalls: [block], traceTransfers: true, validation: false }, tag])
    },
    (err) => TX_ERROR_RE.test(errorText(err)) && !UNSUPPORTED_RE.test(errorText(err)),
  )) as Array<{ calls?: Array<{ status?: string; returnData?: string; gasUsed?: string; logs?: RawLog[]; error?: { message?: string; data?: string } }> }>
  const done = result?.[0]?.calls
  if (!Array.isArray(done) || done.length !== txs.length) throw new Error('eth_simulateV1 returned an unexpected result')
  return done.map((c) => {
    const ok = c.status === '0x1'
    const returnData = c.returnData && c.returnData !== '0x' ? c.returnData : (c.error?.data ?? '0x')
    return {
      success: ok,
      gasUsed: num(c.gasUsed),
      returnData,
      ...(ok ? {} : { error: decodeRevert(returnData) ?? c.error?.message ?? 'execution reverted' }),
      logs: (c.logs ?? []).map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
    }
  })
}

/** 退回方式：每笔单独 eth_call + estimateGas（状态不延续） */
async function callEach(provider: Provider, txs: NormalizedTx[], options: SimulateOptions): Promise<RawCall[]> {
  const run = await nodes()
  const tag = options.blockTag === undefined ? 'latest' : typeof options.blockTag === 'number' ? hex(options.blockTag) : options.blockTag
  return Promise.all(
    txs.map(async (t): Promise<RawCall> => {
      const req = { from: t.from, ...(t.to ? { to: t.to } : {}), data: t.data, value: hex(t.value), ...(t.gas === undefined ? {} : { gas: hex(t.gas) }) }
      const send = (method: string, params: unknown[]) =>
        run(provider.rpc, method, async (node) => {
          if (typeof (node as Partial<Sender>).send !== 'function') throw new Error(`${method} is not supported by this node; pass an RPC URL or an ethers Provider`)
          return (node as unknown as Sender).send(method, params)
        }, isExecutionError)
      try {
        const returnData = (await send('eth_call', options.stateOverrides ? [req, tag, options.stateOverrides] : [req, tag])) as string
        const gas = await send('eth_estimateGas', options.stateOverrides ? [req, tag, options.stateOverrides] : [req, tag]).then((g) => BigInt(g as string), () => 0n)
        return { success: true, gasUsed: gas, returnData, logs: [] }
      } catch (err) {
        const data = (err as { data?: unknown } | null)?.data
        const returnData = typeof data === 'string' ? data : '0x'
        const msg = cleanError(err)
        return { success: false, gasUsed: 0n, returnData, error: decodeRevert(returnData) ?? (isExecutionError(err) ? msg.replace(/^.*?execution reverted:?\s*/i, '') || 'execution reverted' : msg), logs: [] }
      }
    }),
  )
}

async function simulateTronCalls(provider: Provider, txs: NormalizedTx[]): Promise<RawCall[]> {
  const run = await nodes()
  const hexAddr = (a: string) => `41${toEvmAddress(a).slice(2).toLowerCase()}`
  const out: RawCall[] = []
  for (const t of txs) {
    const body: Record<string, unknown> = { owner_address: hexAddr(t.from), data: t.data.replace(/^0x/, '') }
    if (t.to) body.contract_address = hexAddr(t.to)
    if (t.value) body.call_value = Number(t.value)
    const res = (await run(provider.rpc, 'simulate', async (node) => {
      if (!(node instanceof TronProvider)) throw new Error('This node is not a Tron node')
      return node.request('wallet/triggerconstantcontract', body)
    })) as { result?: { code?: string; message?: string; result?: boolean }; constant_result?: string[]; energy_used?: number; logs?: Array<{ address: string; topics?: string[]; data?: string }>; transaction?: { ret?: Array<{ ret?: string }> } } | undefined
    const result = res?.result ?? {}
    const output = `0x${res?.constant_result?.[0] ?? ''}`
    const message = typeof result.message === 'string' ? safeUtf8(result.message) : ''
    const failed = Boolean(result.code) || result.result === false || res?.transaction?.ret?.[0]?.ret === 'FAILED'
    out.push({
      success: !failed,
      gasUsed: BigInt(res?.energy_used ?? 0),
      returnData: output,
      ...(failed ? { error: decodeRevert(output) ?? (message || String(result.code ?? 'REVERT')) } : {}),
      logs: (res?.logs ?? []).map((l) => ({ address: `0x${l.address}`, topics: (l.topics ?? []).map((x) => `0x${x}`), data: `0x${l.data ?? ''}` })),
    })
    // Tron 的模拟不延续状态：每笔都按当前链上状态算
  }
  return out
}

function safeUtf8(hexText: string): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(hexText.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? []))
  } catch {
    return hexText
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

interface Ctx {
  provider: Provider
  chainId: number
  tron: boolean
  subjects: Set<string>
  meta: Map<string, { symbol: string | null; decimals: number }>
}

const outAddr = (ctx: Ctx, a: string) => (ctx.tron && a !== 'native' ? toTronAddress(a) : a)

async function loadMeta(ctx: Ctx, assets: readonly string[]): Promise<void> {
  const want = [...new Set(assets)].filter((a) => !ctx.meta.has(a))
  if (!want.length) return
  const native = getNativeCurrency(ctx.chainId)
  const tokens = want.filter((a) => a !== 'native')
  if (want.includes('native')) ctx.meta.set('native', { symbol: native?.symbol ?? null, decimals: native?.decimals ?? 18 })
  if (!tokens.length) return
  const details = await ctx.provider.tokens(tokens.map((a) => outAddr(ctx, a)), { fields: ['symbol', 'decimals'] }).catch(() => [])
  tokens.forEach((a, i) => {
    const d = details[i]
    ctx.meta.set(a, { symbol: d?.symbol ?? null, decimals: typeof d?.decimals === 'number' ? d.decimals : 0 })
  })
}

function changesOf(ctx: Ctx, moves: readonly Move[]): BalanceChange[] {
  const net = new Map<string, BalanceChange & { raw: bigint }>()
  for (const m of moves) {
    for (const [who, sign] of [[m.fromL, -1n], [m.toL, 1n]] as const) {
      if (!ctx.subjects.has(who) || who === ZERO) continue
      const key = `${who}|${m.asset}|${m.tokenId ?? ''}`
      const meta = ctx.meta.get(m.asset)
      const entry = net.get(key) ?? {
        address: outAddr(ctx, who),
        asset: outAddr(ctx, m.asset),
        symbol: meta?.symbol ?? null,
        decimals: m.standard === 'erc721' || m.standard === 'erc1155' ? 0 : (meta?.decimals ?? 18),
        delta: '0',
        formatted: '0',
        standard: m.standard,
        ...(m.tokenId === undefined ? {} : { tokenId: m.tokenId }),
        raw: 0n,
      }
      entry.raw += sign * m.value
      net.set(key, entry)
    }
  }
  return [...net.values()]
    .filter((e) => e.raw !== 0n)
    .map(({ raw, ...e }) => ({ ...e, delta: raw.toString(), formatted: formatUnits(raw, e.decimals) }))
}

const label = (c: BalanceChange) => `${c.formatted} ${c.symbol ?? (c.tokenId === undefined ? c.asset.slice(0, 8) : `NFT #${c.tokenId}`)}`

function summarize(decoded: DecodedCall, changes: readonly BalanceChange[], from: string, approvals: readonly ApprovalChange[]): string {
  const mine = changes.filter((c) => c.address.toLowerCase() === from.toLowerCase())
  const outs = mine.filter((c) => c.delta.startsWith('-')).map((c) => label({ ...c, formatted: c.formatted.slice(1) }))
  const ins = mine.filter((c) => !c.delta.startsWith('-')).map(label)
  if (decoded.type === 'swap' && outs.length && ins.length) return `Swap ${outs.join(' + ')} for ${ins.join(' + ')}${decoded.protocol ? ` on ${decoded.protocol}` : ''}`
  if (decoded.type === 'transfer' && outs.length && !ins.length) return `Send ${outs.join(' + ')}`
  if (decoded.type === 'approve' && approvals.length) {
    const a = approvals[0] as ApprovalChange
    const what = a.revoked ? 'Revoke' : 'Approve'
    return `${what} ${a.symbol ?? a.token.slice(0, 8)}${a.unlimited ? ' (unlimited)' : ''} ${a.revoked ? 'from' : 'to'} ${a.spenderName ?? a.spender}`
  }
  if (outs.length || ins.length) return `${decoded.summary}: ${[...outs.map((o) => `-${o}`), ...ins.map((i) => `+${i}`)].join(', ')}`
  return decoded.summary
}

async function codeOf(ctx: Ctx, address: string, cache: Map<string, Promise<boolean | null>>): Promise<boolean | null> {
  const key = address.toLowerCase()
  let hit = cache.get(key)
  if (!hit) {
    const run = nodes()
    hit = run
      .then((r) =>
        r(ctx.provider.rpc, 'getCode', async (node) => {
          if (ctx.tron) {
            if (!(node instanceof TronProvider)) throw new Error('not a Tron node')
            const c = await node.request('wallet/getcontract', { value: `41${key.slice(2)}` })
            return Boolean(c && (c.bytecode || c.contract_address))
          }
          return (await (node as unknown as { getCode(a: string): Promise<string> }).getCode(address)) !== '0x'
        }),
      )
      .catch(() => null)
    cache.set(key, hit)
  }
  return hit
}

async function buildResult(ctx: Ctx, tx: NormalizedTx, raw: RawCall, mode: SimulationResult['mode'], codes: Map<string, Promise<boolean | null>>, fallbackMoves: Move[] = []): Promise<SimulationResult> {
  const moves = [...parseTransfers(raw.logs), ...fallbackMoves]
  const approvals = parseApprovals(raw.logs).filter((a) => ctx.subjects.has(a.owner))
  // 失败的交易没有效果
  const effective = raw.success ? moves : []
  const decoded = decodeCalldata(tx.data, { to: tx.to, chainId: ctx.chainId, value: tx.value })
  await loadMeta(ctx, [...effective.filter((m) => ctx.subjects.has(m.fromL) || ctx.subjects.has(m.toL)).map((m) => m.asset), ...(raw.success ? approvals.map((a) => a.token) : [])])
  const balanceChanges = changesOf(ctx, effective)
  const known = knownSpenders(ctx.chainId)
  const approvalChanges: ApprovalChange[] = (raw.success ? approvals : []).map((a) => ({
    ...a,
    owner: outAddr(ctx, a.owner),
    token: outAddr(ctx, a.token),
    spender: outAddr(ctx, a.spender),
    symbol: ctx.meta.get(a.token)?.symbol ?? null,
    ...(known.find((s) => toEvmAddress(s.address).toLowerCase() === a.spender)?.name ? { spenderName: known.find((s) => toEvmAddress(s.address).toLowerCase() === a.spender)?.name } : {}),
  }))

  const warnings: SimulationWarning[] = []
  if (!raw.success) warnings.push({ severity: 'danger', code: 'reverted', message: raw.error ?? 'execution reverted' })
  if (mode === 'eth_call') warnings.push({ severity: 'info', code: 'no-logs', message: 'The node does not support eth_simulateV1: balance changes are estimated from calldata only' })
  if (decoded.type === 'unknown' && tx.data !== '0x') warnings.push({ severity: 'info', code: 'unknown-method', message: decoded.summary })
  for (const a of approvalChanges) {
    if (a.revoked) continue
    const common = { address: a.spender }
    if (a.unlimited) warnings.push({ severity: 'warn', code: a.type === 'nft' ? 'unlimited-nft-approval' : 'unlimited-approval', message: a.type === 'nft' ? `Approves ${a.spenderName ?? a.spender} to move all of your NFTs in ${a.symbol ?? a.token}` : `Unlimited ${a.symbol ?? a.token} approval to ${a.spenderName ?? a.spender}`, ...common })
    if (!a.spenderName) {
      const hasCode = await codeOf(ctx, a.spender, codes)
      if (hasCode === false) warnings.push({ severity: 'danger', code: 'approve-to-eoa', message: `Approval to ${a.spender}, which has no contract code (an ordinary wallet)`, ...common })
      else warnings.push({ severity: 'warn', code: 'unknown-spender', message: `${a.spender} is not a known router / spender on this chain`, ...common })
    }
  }
  if (tx.to && tx.data !== '0x') {
    if ((await codeOf(ctx, tx.to, codes)) === false) warnings.push({ severity: 'danger', code: 'no-code', message: `${outAddr(ctx, tx.to)} has no contract code: the call does nothing${tx.value > 0n ? ' and the value is just sent to it' : ''}` })
  }

  const decodedOut = { type: decoded.type, ...(decoded.protocol ? { protocol: decoded.protocol } : {}), ...(decoded.method ? { method: decoded.method } : {}), summary: summarize(decoded, balanceChanges, outAddr(ctx, tx.from), approvalChanges), ...(decoded.args ? { args: decoded.args } : {}), ...(decoded.calls ? { calls: decoded.calls } : {}) }
  return {
    success: raw.success,
    ...(raw.error ? { error: raw.error } : {}),
    ...(!raw.success && raw.returnData !== '0x' ? { revertData: raw.returnData } : {}),
    gasUsed: raw.gasUsed.toString(),
    balanceChanges,
    approvalChanges,
    decoded: decodedOut,
    warnings,
    transfers: effective.map(({ fromL, toL, value, ...t }) => ({ ...t, asset: outAddr(ctx, t.asset), from: outAddr(ctx, fromL), to: outAddr(ctx, toL) })),
    logs: raw.logs,
    mode,
    ...(raw.success && raw.returnData !== '0x' ? { returnData: raw.returnData } : {}),
  }
}

/** eth_call 模式：按 calldata 估一下主币和 ERC20 转出（没有日志，只是估计） */
function estimateMoves(tx: NormalizedTx, decoded: DecodedCall): Move[] {
  const moves: Move[] = []
  const from = tx.from.toLowerCase()
  const push = (asset: string, to: string, value: bigint, standard: Move['standard']) => moves.push({ asset, from, to, amount: value.toString(), standard, fromL: from, toL: to.toLowerCase(), value })
  if (tx.value > 0n && tx.to) push('native', tx.to, tx.value, 'native')
  if (decoded.method === 'transfer' && tx.to && decoded.args) push(tx.to.toLowerCase(), String(decoded.args.to), BigInt(String(decoded.args.amount)), 'erc20')
  return moves
}

async function gasPrice(provider: Provider): Promise<bigint | undefined> {
  try {
    const run = await nodes()
    return BigInt((await run(provider.rpc, 'gasPrice', async (node) => (node as unknown as Sender).send('eth_gasPrice', []))) as string)
  } catch {
    return undefined
  }
}

async function enrich(ctx: Ctx, results: SimulationResult[], from: string, options: SimulateOptions): Promise<void> {
  const all = results.flatMap((r) => r.balanceChanges)
  if (options.usd && all.length) {
    try {
      const { tokenPrices } = await import('./price.js')
      const assets = [...new Set(all.filter((c) => c.standard === 'native' || c.standard === 'erc20').map((c) => (c.standard === 'native' ? NATIVE_TOKEN : c.asset)))]
      const prices = await tokenPrices(ctx.provider, assets, options.usd === true ? {} : { sources: options.usd })
      for (const c of all) {
        const p = prices.find((x) => x.token.toLowerCase() === (c.standard === 'native' ? NATIVE_TOKEN : c.asset).toLowerCase())
        c.usd = c.standard === 'erc721' || c.standard === 'erc1155' ? null : p?.price == null ? null : Number(c.formatted) * p.price
      }
    } catch {
      for (const c of all) c.usd = null
    }
  }
  if (options.risk && !ctx.tron) {
    const incoming = [...new Set(all.filter((c) => c.standard === 'erc20' && !c.delta.startsWith('-') && c.address.toLowerCase() === from.toLowerCase()).map((c) => c.asset))]
    if (incoming.length) {
      try {
        const { tokenRisks } = await import('./risk.js')
        const risks = await tokenRisks(ctx.provider, incoming)
        for (const r of risks) {
          const bad = r.flags.filter((f) => f === 'honeypot' || f === 'cannot-buy' || f.startsWith('high-'))
          if (bad.length) results[0]?.warnings.push({ severity: 'danger', code: 'token-risk', address: r.token, message: `${r.token}: ${bad.join(', ')}` })
          else if (r.flags.includes('has-tax')) results[0]?.warnings.push({ severity: 'warn', code: 'token-risk', address: r.token, message: `${r.token}: has transfer tax (buy ${r.buyTax}, sell ${r.sellTax})` })
        }
      } catch {
        // 风险检查失败不影响模拟结果
      }
    }
  }
}

async function large(ctx: Ctx, from: string, results: SimulationResult[]): Promise<void> {
  const native = results.flatMap((r) => r.balanceChanges).filter((c) => c.standard === 'native' && c.address.toLowerCase() === from.toLowerCase() && c.delta.startsWith('-'))
  if (!native.length) return
  try {
    const out = native.reduce((s, c) => s - BigInt(c.delta), 0n)
    const [balance] = await ctx.provider.balances(from, [NATIVE_TOKEN], { decimals: false })
    const have = BigInt(balance?.balance ?? '0')
    if (have > 0n && out * 10n >= have * 9n) results[0]?.warnings.push({ severity: 'warn', code: 'large-value', message: `Sends ${Math.round(Number((out * 1000n) / have) / 10)}% of the native balance` })
  } catch {
    // 余额查不到就不提示
  }
}

async function run(provider: Provider, txs: SimulateTx[], options: SimulateOptions): Promise<{ results: SimulationResult[]; ctx: Ctx; from: string }> {
  if (!txs.length) throw new Error('No transactions to simulate')
  if (txs.length > 50) throw new RangeError('Too many transactions to simulate at once (max 50)')
  const chainId = await provider.getChainId()
  const tron = isTronChain(chainId)
  const normalized = txs.map((t) => normalize(t, options.from, tron))
  const from = normalized[0]?.from as string
  const subjects = new Set([from, ...(options.watch ?? []).map((a) => (tron ? toEvmAddress(a) : a)), ...normalized.map((t) => t.from)].map((a) => a.toLowerCase()))
  const ctx: Ctx = { provider, chainId, tron, subjects, meta: new Map() }
  const codes = new Map<string, Promise<boolean | null>>()

  let raws: RawCall[] | null = null
  let mode: SimulationResult['mode'] = 'simulateV1'
  if (tron) {
    raws = await simulateTronCalls(provider, normalized)
    mode = 'tron'
  } else {
    if (!options.forceCall) {
      try {
        raws = await simulateV1(provider, normalized, options)
      } catch (err) {
        const text = cleanError(err)
        // 交易本身有问题（余额不足等）：换节点结果一样，直接作为失败结果；其他（不支持、节点故障）退回 eth_call
        if (TX_ERROR_RE.test(text) && !UNSUPPORTED_RE.test(text)) raws = normalized.map(() => ({ success: false, gasUsed: 0n, returnData: '0x', error: text, logs: [] }))
      }
    }
    if (!raws) {
      raws = await callEach(provider, normalized, options)
      mode = 'eth_call'
    }
  }
  const results: SimulationResult[] = []
  for (const [i, raw] of raws.entries()) {
    const t = normalized[i] as NormalizedTx
    // eth_call 没有日志：按 calldata 估；Tron 日志里没有 TRX 的变化，只有 call_value
    const moves = mode === 'eth_call' ? estimateMoves(t, decodeCalldata(t.data, { to: t.to, chainId, value: t.value })) : mode === 'tron' ? estimateMoves({ ...t, data: '0x' }, { type: 'unknown', summary: '' }) : []
    const result = await buildResult(ctx, t, raw, mode, codes, moves)
    if (mode === 'eth_call' && i > 0) result.warnings.push({ severity: 'info', code: 'no-state', message: 'Without eth_simulateV1 each transaction is simulated against the current state, not after the previous ones' })
    if (mode === 'tron' && i > 0) result.warnings.push({ severity: 'info', code: 'no-state', message: 'Tron simulates each call against the current state, not after the previous ones' })
    results.push(result)
  }
  await enrich(ctx, results, from, options)
  await large(ctx, from, results)
  if (options.fee !== false && !tron && results.some((r) => r.gasUsed !== '0')) {
    const price = await gasPrice(provider)
    if (price !== undefined) for (const r of results) r.fee = (price * BigInt(r.gasUsed)).toString()
  }
  return { results, ctx, from }
}

/**
 * 模拟一笔交易（不签名、不发送）。可以直接传 `buildSwap` / `buildRevokes` / 流动性构建里的交易。
 *
 * ```ts
 * const plan = await buildSwap(provider, user, { tokenIn, tokenOut, amountInFormatted: '1' })
 * const sim = await simulate(provider, plan.transactions[1], { from: user })      // 兑换这一笔（授权在前，没发出去时用 simulateBatch）
 * if (!sim.success) throw new Error(sim.error)
 * sim.balanceChanges   // [{ asset: 'native', delta: '-1000…', formatted: '-1', … }, { asset: USDC, formatted: '2300.5', … }]
 * sim.warnings         // [{ severity: 'warn', code: 'unknown-spender', … }]
 * ```
 */
export async function simulate(provider: Provider, tx: SimulateTx, options: SimulateOptions = {}): Promise<SimulationResult> {
  const { results } = await run(provider, [tx], options)
  return results[0] as SimulationResult
}

/**
 * 按顺序模拟一串依赖前一笔的交易（如先 approve 再兑换：`plan.transactions`）。eth_simulateV1 在同一个区块里依次执行，状态延续；
 * 不支持的节点退回单笔 eth_call，后面的交易看不到前面的结果（结果里有 `no-state` 提示；Tron 同理）。
 *
 * ```ts
 * const sim = await simulateBatch(provider, plan.transactions, { from: user, usd: true })
 * sim.success; sim.balanceChanges   // 汇总：整个流程你付出 / 收到什么
 * ```
 */
export async function simulateBatch(provider: Provider, txs: readonly SimulateTx[] | { transactions: readonly SimulateTx[] }, options: SimulateOptions = {}): Promise<BatchSimulationResult> {
  const list = 'transactions' in txs ? txs.transactions : txs
  const { results, ctx } = await run(provider, [...list], options)
  const failedIndex = results.findIndex((r) => !r.success)
  const sum = new Map<string, BalanceChange & { raw: bigint }>()
  for (const r of results) {
    for (const c of r.balanceChanges) {
      const key = `${c.address}|${c.asset}|${c.tokenId ?? ''}`
      const entry = sum.get(key) ?? { ...c, usd: undefined, raw: 0n }
      entry.raw += BigInt(c.delta)
      if (c.usd != null) entry.usd = (entry.usd ?? 0) + c.usd
      sum.set(key, entry)
    }
  }
  const latest = new Map<string, ApprovalChange>()
  for (const r of results) for (const a of r.approvalChanges) latest.set(`${a.type}|${a.owner}|${a.token}|${a.spender}`, a)
  const seen = new Set<string>()
  const warnings = results.flatMap((r) => r.warnings).filter((w) => !seen.has(`${w.code}|${w.message}`) && seen.add(`${w.code}|${w.message}`))
  const gas = results.reduce((s, r) => s + BigInt(r.gasUsed), 0n)
  const fees = results.map((r) => r.fee)
  return {
    success: failedIndex < 0,
    results,
    ...(failedIndex < 0 ? {} : { failedIndex }),
    gasUsed: gas.toString(),
    ...(fees.every((f) => f !== undefined) ? { fee: fees.reduce((s, f) => s + BigInt(f as string), 0n).toString() } : {}),
    balanceChanges: [...sum.values()].filter((e) => e.raw !== 0n).map(({ raw, ...e }) => ({ ...e, delta: raw.toString(), formatted: formatUnits(raw, e.decimals) })),
    approvalChanges: [...latest.values()],
    warnings,
    mode: ctx.tron ? 'tron' : (results[0] as SimulationResult).mode,
  }
}

/**
 * 模拟通过才发送的一行守卫：`simulate` 失败或有 danger 级别的提示时抛错，否则返回模拟结果，由调用方继续发送。
 *
 * ```ts
 * await assertSimulation(simulate(provider, tx, { from }))
 * await batchCall(provider, key, [{ to: tx.to, data: tx.data, value: tx.value }])
 * ```
 */
export async function assertSimulation<T extends Pick<SimulationResult, 'success' | 'error' | 'warnings'> | Pick<BatchSimulationResult, 'success' | 'warnings'> & { results: Array<Pick<SimulationResult, 'error'>> }>(
  simulation: Promise<T> | T,
  options: { allowDanger?: boolean } = {},
): Promise<T> {
  const sim = await simulation
  if (!sim.success) {
    const error = 'error' in sim ? sim.error : (sim as { results: Array<{ error?: string }> }).results.find((r) => r.error)?.error
    throw new Error(`Simulation failed: ${error ?? 'execution reverted'}`)
  }
  const danger = sim.warnings.filter((w) => w.severity === 'danger')
  if (danger.length && !options.allowDanger) throw new Error(`Simulation warning: ${danger.map((w) => w.message).join('; ')}`)
  return sim
}
