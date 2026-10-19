import { toFriendlyAddress, toRawAddress } from '../address.js'
import type { TonClient } from '../client.js'
import { isNodeFault } from '../http.js'
import { Cell, base64ToBytes, bytesToBase64, bytesToHex } from './cell.js'
import { externalMessageCell, normalizedMessageHash, stateInitCell, type OutMessage, type StateInit } from './message.js'
import { resolveTonSigner, type ResolvedTonSigner, type TonConnectRequest, type TonSignerInput } from './signer.js'
import { MAX_MESSAGES, defaultWalletId, signedBody, walletAddress, walletInit, type WalletVersion } from './wallet.js'

/**
 * 每笔交易（调用）的状态：
 * - confirmed：钱包交易执行成功，后续的消息链（Jetton 转账等）也没有失败退回
 * - reverted：上链了但失败（钱包交易失败、消息被跳过，或后续消息失败退回），手续费已扣
 * - failed：没有上链（模拟失败、过期、钱包里拒绝等），不花手续费
 * - sent：已发出（wait: false）
 * - pending：等到超时还没确认（或消息链还没走完）
 * - skipped：没有执行（同一钱包前面的交易失败、已取消）
 * - simulated：dryRun 模拟通过
 */
export type WriteStatus = 'confirmed' | 'reverted' | 'failed' | 'sent' | 'pending' | 'skipped' | 'simulated'

export interface SendOptions {
  /** 只模拟（toncenter 的 emulateTrace），不发送 */
  dryRun?: boolean
  /** 发送前先模拟，失败的不发，默认 true。模拟服务不可用时跳过模拟照常发送 */
  simulate?: boolean
  /** 交易的有效期（秒），默认 60 */
  validFor?: number
  /** 等待确认，默认 true；false 时发出即返回 'sent'（同一钱包的下一笔要等前一笔上链，所以只发每个钱包的第一笔） */
  wait?: boolean
  /** 每笔交易等待确认的超时（毫秒），默认 120000 */
  timeout?: number
  /** 轮询间隔（毫秒），默认 3000 */
  pollInterval?: number
  /** 过期没上链时重新签名发送的次数（私钥钱包），默认 1 */
  retries?: number
  /** 同时处理的钱包数（同一钱包的交易依次执行），默认 4 */
  concurrency?: number
  signal?: AbortSignal
  /** 每个结果状态变化时回调 */
  onUpdate?: (result: WriteResult) => void
}

/** 每个调用的结果，可以直接 JSON.stringify */
export interface WriteResult {
  index: number
  /** 发送的钱包（用户友好格式） */
  from: string
  status: WriteStatus
  /** 外部消息的规范化哈希（TEP-467，十六进制），同一笔交易里的调用相同；可以在浏览器里搜 */
  hash: string | null
  /** 钱包交易的哈希（十六进制） */
  txHash: string | null
  /** 钱包交易的手续费（nanoTON，不含随消息附带的 TON） */
  fee: string | null
  error: string | null
}

export interface TxOutcome {
  status: WriteStatus
  hash: string | null
  txHash: string | null
  fee: bigint | null
  error: string | null
  /** 每条消息的结果（与 job.messages 对应）：null 为成功，否则是失败原因；不知道时整个为 null */
  messages: Array<string | null> | null
}

export const emptyOutcome = (status: WriteStatus, error: string | null = null): TxOutcome => ({ status, hash: null, txHash: null, fee: null, error, messages: null })

export function toWriteResult(index: number, from: string, o: TxOutcome): WriteResult {
  return { index, from, status: o.status, hash: o.hash, txHash: o.txHash, fee: o.fee === null ? null : o.fee.toString(), error: o.error }
}

/** 一笔交易里第 k 条消息的结果：交易确认了但这条消息失败时为 reverted（同一笔里其他消息可能成功） */
export function messageOutcome(o: TxOutcome, k: number): TxOutcome {
  const error = o.messages?.[k]
  if (error === undefined || (o.status !== 'confirmed' && o.status !== 'reverted' && o.status !== 'simulated' && o.status !== 'failed')) return o
  if (error === null) {
    // 整笔没发（模拟时别的消息失败）：这条也没发
    if (o.status === 'failed') return { ...o, error: `not sent: another message in the same transaction failed (${o.error})` }
    return { ...o, status: o.status === 'reverted' ? 'confirmed' : o.status, error: null }
  }
  return { ...o, status: o.status === 'simulated' || o.status === 'failed' ? 'failed' : 'reverted', error }
}

/** 一个准备好的钱包：地址、版本、链上状态 */
export interface WalletContext {
  signer: ResolvedTonSigner
  /** 原始格式 0:… */
  address: string
  /** 用户友好格式（不可回弹） */
  friendly: string
  /** 钱包版本：TON Connect 钱包按链上的钱包类型判断，不是 v4r2 / v5r1 时为 null（不能模拟） */
  version: WalletVersion | null
  walletId: number
  publicKey: Uint8Array | null
  /** active / uninit / nonexist / frozen */
  status: string
  seqno: number
  /** nanoTON */
  balance: bigint
  /** 一笔交易最多几条消息 */
  maxMessages: number
}

export interface SendMessage {
  message: OutMessage
  /** 发送模式，默认 3（手续费另付 + 忽略错误）；128 = 带上剩下的全部余额 */
  mode?: number
}

/** 一笔要发的交易 */
export interface TxJob {
  wallet: WalletContext
  messages: readonly SendMessage[]
  /** 额外检查交易链（模拟和上链后都会调用）：返回失败原因或 null。如加流动性时要求 LP 真的发到了用户的 LP 钱包（失败时 DEX 是退款，不是退回） */
  check?: (trace: Trace) => string | null
  onUpdate(outcome: TxOutcome): void
}

const WALLET_TYPES: Record<string, WalletVersion> = { 'wallet v4 r2': 'v4r2', 'wallet v5 r1': 'v5r1' }
const NETWORK_ID = { mainnet: '-239', testnet: '-3' } as const
/** valid_until 之后再等多久（秒）才判断过期（索引器和本地时钟的误差） */
const EXPIRY_GRACE = 30

interface WalletRow {
  walletType: string | null
  walletId: number | null
  seqno: number | null
  balance: string
  status: string
}

export interface ResolveWalletsOptions {
  signal?: AbortSignal
  /**
   * 私钥钱包没指定版本时用来挑版本：返回其中持有资产的地址（如持有要归集的 Jetton），它们优先于只有 TON 余额的地址。
   * 顺序：已部署 > 持有资产 > TON 余额多
   */
  holders?: (addresses: readonly string[]) => Promise<Set<string>>
}

/**
 * 解析钱包：私钥钱包没指定版本时，算出 v5r1 和 v4r2 两个地址，用已部署（或持有资产、有余额）的那个，都没有时用 v5r1；
 * 一次请求读出所有钱包的状态
 */
export async function resolveWallets(client: TonClient, inputs: readonly TonSignerInput[], options: ResolveWalletsOptions | AbortSignal = {}): Promise<WalletContext[]> {
  const { signal, holders } = options instanceof AbortSignal ? { signal: options, holders: undefined } : options
  const cache = new Map()
  const signers = await Promise.all(inputs.map((i) => resolveTonSigner(i, cache)))
  const network = client.network
  const candidates = signers.map((s): Array<{ version: WalletVersion | null; walletId: number | null; address: string }> => {
    if (s.kind === 'tonconnect') return [{ version: null, walletId: null, address: s.address }]
    const versions: WalletVersion[] = s.version ? [s.version] : ['v5r1', 'v4r2']
    return versions.map((version) => {
      const walletId = s.walletId ?? defaultWalletId(version, network)
      return { version, walletId, address: toRawAddress(walletAddress(version, s.publicKey, walletId)) }
    })
  })
  const addresses = [...new Set(candidates.flat().map((c) => c.address))]
  const states = new Map<string, WalletRow>()
  const [rows, held] = await Promise.all([
    client.walletStates(addresses, { signal }),
    holders && candidates.some((c) => c.length > 1) ? holders(addresses) : Promise.resolve(new Set<string>()),
  ])
  rows.forEach((r, i) => states.set(addresses[i] as string, r))
  return signers.map((signer, i) => {
    const options = (candidates[i] as Array<{ version: WalletVersion | null; walletId: number | null; address: string }>).map((c) => ({ ...c, state: states.get(c.address) }))
    const score = (o: (typeof options)[number]) => (o.state?.status === 'active' ? 2n ** 130n : 0n) + (held.has(o.address) ? 2n ** 128n : 0n) + BigInt(o.state?.balance ?? '0')
    const best = options.reduce((a, b) => (score(b) > score(a) ? b : a))
    const state = best.state
    const detected = state?.walletType ? (WALLET_TYPES[state.walletType] ?? null) : null
    const version = signer.kind === 'tonconnect' ? detected : best.version
    const ctx: WalletContext = {
      signer,
      address: best.address,
      friendly: toFriendlyAddress(best.address, { bounceable: false, testOnly: network === 'testnet' }),
      version,
      // TON Connect 钱包用链上的 wallet_id（可能不是默认的 subwallet）
      walletId: best.walletId ?? state?.walletId ?? (version ? defaultWalletId(version, network) : 0),
      publicKey: signer.publicKey,
      status: 'nonexist',
      seqno: 0,
      balance: 0n,
      maxMessages: Math.min(signer.kind === 'tonconnect' ? signer.maxMessages : 255, version ? MAX_MESSAGES[version] : 4),
    }
    return applyState(ctx, state)
  })
}

function applyState(ctx: WalletContext, state: WalletRow | undefined): WalletContext {
  return { ...ctx, status: state?.status ?? 'nonexist', seqno: state?.seqno ?? 0, balance: BigInt(state?.balance ?? '0') }
}

/** 重新读钱包状态（地址、版本不变） */
export async function refreshWallets(client: TonClient, wallets: readonly WalletContext[], signal?: AbortSignal): Promise<WalletContext[]> {
  const rows = await client.walletStates(
    wallets.map((w) => w.address),
    { signal },
  )
  return wallets.map((w, i) => applyState(w, rows[i]))
}

async function mapPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++] as T)
    }),
  )
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

/**
 * 发一批交易：按钱包分组，组内依次执行（每笔用下一个 seqno，等上一笔上链），不同钱包并发
 */
export async function sendJobs(client: TonClient, jobs: readonly TxJob[], options: SendOptions = {}): Promise<TxOutcome[]> {
  const outcomes: TxOutcome[] = jobs.map(() => emptyOutcome('skipped'))
  const update = (i: number, o: TxOutcome) => {
    outcomes[i] = o
    try {
      ;(jobs[i] as TxJob).onUpdate(o)
    } catch {
      // 调用方的回调出错不打断发送
    }
  }
  const groups = new Map<string, number[]>()
  jobs.forEach((job, i) => groups.set(job.wallet.address, [...(groups.get(job.wallet.address) ?? []), i]))
  await mapPool([...groups.values()], Math.max(1, options.concurrency ?? 4), async (indexes) => {
    const wallet = (jobs[indexes[0] as number] as TxJob).wallet
    // 本组的状态（seqno、是否已部署）随交易推进
    const state = { seqno: wallet.seqno, deployed: wallet.status === 'active' }
    let blocked: string | null = null
    for (const i of indexes) {
      const job = jobs[i] as TxJob
      if (options.signal?.aborted) {
        update(i, emptyOutcome('skipped', 'aborted'))
        continue
      }
      if (blocked) {
        update(i, emptyOutcome('skipped', blocked))
        continue
      }
      const { outcome, executed } = await sendOne(client, job, state, options).catch((err: unknown) => ({
        outcome: emptyOutcome('failed', err instanceof Error ? err.message : String(err)),
        executed: false,
      }))
      update(i, outcome)
      // dryRun 不改变链上状态：同一钱包的每笔都按当前状态模拟
      if (executed && !options.dryRun) {
        state.seqno++
        state.deployed = true
      }
      // 结果不确定（不知道 seqno 有没有用掉）、或者不等确认时，同一钱包后面的交易不能发
      if (outcome.status === 'sent') blocked = 'skipped: wait is false, only the first transaction of each wallet is sent'
      else if (outcome.status === 'pending' && !executed) blocked = 'skipped: a previous transaction of the same wallet is still pending'
      else if ((outcome.status === 'failed' || outcome.status === 'reverted') && !options.dryRun) blocked = 'skipped: a previous transaction of the same wallet failed'
    }
  })
  return outcomes
}

interface GroupState {
  seqno: number
  deployed: boolean
}

/** 按版本签好的外部消息 */
async function buildExternal(wallet: WalletContext, state: GroupState, messages: readonly SendMessage[], validUntil: number, fakeSignature: boolean): Promise<Cell> {
  const version = wallet.version as WalletVersion
  const publicKey = wallet.publicKey
  let init: StateInit | null = null
  if (!state.deployed) {
    if (!publicKey) throw new Error('Cannot deploy the wallet: unknown public key')
    init = walletInit(version, publicKey, wallet.walletId)
  }
  const sign = fakeSignature || wallet.signer.kind !== 'key' ? async () => new Uint8Array(64) : wallet.signer.sign
  const body = await signedBody(version, { walletId: wallet.walletId, seqno: state.seqno, validUntil, messages: messages.map((m) => ({ message: m.message, mode: m.mode ?? 3 })) }, sign)
  return externalMessageCell(wallet.address, body, init)
}

/** 钱包拒绝外部消息（签名、seqno、过期、余额不够付手续费等）时节点的报错 */
export const REJECTED = /message rejected|rejected by account|cannot apply external|cannot run message/i

/** 外部消息签名部分里的 valid_until（TON Connect 钱包可能改了有效期） */
function validUntilOf(ext: Cell, version: WalletVersion | null): number | null {
  if (!version) return null
  try {
    const s = ext.beginParse()
    s.loadUint(2)
    s.loadAddress()
    s.loadAddress()
    s.loadCoins()
    if (s.loadBit()) {
      if (s.loadBit()) s.loadRef()
      else return null
    }
    const body = s.loadBit() ? s.loadRef().beginParse() : s
    if (version === 'v4r2') body.loadBytes(64)
    else body.loadUint(32)
    body.loadUint(32) // wallet_id
    return body.loadUintNumber(32)
  } catch {
    return null
  }
}

async function sendOne(client: TonClient, job: TxJob, state: GroupState, options: SendOptions): Promise<{ outcome: TxOutcome; executed: boolean }> {
  const { wallet, messages } = job
  if (!messages.length) return { outcome: emptyOutcome('skipped', 'nothing to send'), executed: false }
  if (messages.length > wallet.maxMessages) throw new Error(`Too many messages for one transaction: ${messages.length} > ${wallet.maxMessages}`)
  if (wallet.status === 'frozen') return { outcome: emptyOutcome('failed', 'The wallet is frozen'), executed: false }
  const validFor = options.validFor ?? 60
  const connect = wallet.signer.kind === 'tonconnect' ? wallet.signer : null
  if (connect && messages.some((m) => (m.mode ?? 3) !== 3)) {
    return { outcome: emptyOutcome('failed', 'TON Connect wallets only support the default send mode (sending the whole balance is not possible)'), executed: false }
  }
  const out = messages.map((m) => m)

  // 模拟：私钥钱包用真签名；TON Connect 钱包（知道版本时）用空签名、跳过签名检查
  if (options.dryRun || (options.simulate ?? true)) {
    if (!wallet.version) {
      if (options.dryRun) return { outcome: emptyOutcome('failed', 'Cannot simulate: unknown wallet version'), executed: false }
    } else {
      const ext = await buildExternal(wallet, state, messages, Math.floor(Date.now() / 1000) + validFor, !!connect)
      const emulated = await emulate(client, ext, !!connect, options.signal)
      // TON Connect 钱包用的是空签名：被拒绝时（如钱包的参数和推断的不同）不能说明真实交易会失败，跳过模拟
      if (emulated.rejected && (options.dryRun || !connect)) return { outcome: emptyOutcome('failed', `simulation failed: ${emulated.rejected}`), executed: false }
      if (emulated.unavailable && options.dryRun) return { outcome: emptyOutcome('failed', `simulation unavailable: ${emulated.unavailable}`), executed: false }
      if (emulated.trace) {
        // 模拟结果不完整（交易链太长被截断）时看不到后面的结果：不做 job.check（如“LP 发到了用户的钱包”）
        const evaluated = evaluateTrace(emulated.trace, wallet.address, out)
        const verdict = emulated.trace.is_incomplete ? evaluated : checked(evaluated, job, emulated.trace)
        const hash = bytesToHex(normalizedMessageHash(ext))
        if (verdict.error) return { outcome: { ...emptyOutcome('failed', `simulation failed: ${verdict.error}`), fee: verdict.fee, messages: verdict.messages }, executed: false }
        if (options.dryRun) return { outcome: { status: 'simulated', hash: connect ? null : hash, txHash: null, fee: verdict.fee, error: null, messages: verdict.messages }, executed: true }
      }
    }
  }
  if (options.dryRun) return { outcome: emptyOutcome('simulated'), executed: true }

  // 同一个 seqno 发出过的所有外部消息（过期重发时有多条，最多一条能执行）
  const sent: Array<{ hash: string; validUntil: number }> = []
  // 钱包已经发出、但返回的 BOC 读不出来（拿不到哈希，查不了结果）
  let unreadable: string | null = null
  const post = async (): Promise<string | null> => {
    const validUntil = Math.floor(Date.now() / 1000) + validFor
    let ext: Cell
    if (connect) {
      const request: TonConnectRequest = {
        validUntil,
        network: NETWORK_ID[client.network],
        from: wallet.address,
        messages: messages.map(({ message: m }) => ({
          address: toFriendlyAddress(typeof m.to === 'string' ? m.to : toRawAddress(m.to), { bounceable: m.bounce, testOnly: client.network === 'testnet' }),
          amount: m.value.toString(),
          ...(m.body ? { payload: m.body.toBase64() } : {}),
          ...(m.init ? { stateInit: (m.init instanceof Cell ? m.init : stateInitCell(m.init)).toBase64() } : {}),
        })),
      }
      let boc: string
      try {
        boc = (await connect.send(request)).boc
      } catch (err) {
        return walletError(err)
      }
      try {
        ext = Cell.fromBase64(boc)
        // 钱包可能改了有效期：按它签的算；读不出来时多等一会儿
        sent.push({ hash: bytesToHex(normalizedMessageHash(ext)), validUntil: validUntilOf(ext, wallet.version) ?? validUntil + 600 })
      } catch (err) {
        unreadable = `the wallet sent the transaction, but its BOC could not be read: ${err instanceof Error ? err.message : String(err)}`
      }
      return null
    }
    ext = await buildExternal(wallet, state, messages, validUntil, false)
    sent.push({ hash: bytesToHex(normalizedMessageHash(ext)), validUntil })
    try {
      await client.transport.post('message', { boc: ext.toBase64() }, { signal: options.signal })
    } catch (err) {
      // 节点问题：可能已经发出去了，按哈希等结果；被拒绝时，第一次发送直接失败，重发时继续等之前发出的
      const message = err instanceof Error ? err.message : String(err)
      if (!isNodeFault(err) || REJECTED.test(message)) {
        if (sent.length === 1) return message
        sent.pop()
      }
    }
    return null
  }
  const first = await post()
  if (first !== null) return { outcome: emptyOutcome('failed', first), executed: false }
  // 可能已经上链：不能当作失败（同一钱包后面的交易也不能再发）
  if (unreadable !== null) return { outcome: emptyOutcome('pending', unreadable), executed: false }
  if (options.wait === false) return { outcome: { ...emptyOutcome('sent'), hash: sent[0]?.hash ?? null }, executed: false }

  const deadline = Date.now() + (options.timeout ?? 120_000)
  const interval = options.pollInterval ?? 3000
  let partial: { trace: Trace; hash: string } | null = null
  let advanced = false
  let retries = connect ? 0 : (options.retries ?? 1)
  let resent = false
  // 查结果时最近一次出错（超时后放进 pending 的原因里，如 API Key 不对）
  let pollError: string | null = null
  for (;;) {
    await sleep(interval, options.signal)
    if (options.signal?.aborted) break
    for (const s of sent) {
      const res = await client.transport.get<{ traces?: Trace[] }>('traces', { msg_hash: s.hash, limit: 1 }, { signal: options.signal }).catch((err: unknown) => {
        pollError = err instanceof Error ? err.message : String(err)
        return null
      })
      const trace = res?.traces?.[0]
      if (!trace) continue
      partial = { trace, hash: s.hash }
      if (!trace.is_incomplete && trace.trace_info?.trace_state !== 'pending' && (trace.trace_info?.pending_messages ?? 0) === 0) {
        const verdict = checked(evaluateTrace(trace, wallet.address, out), job, trace)
        const root = verdict.root
        return {
          outcome: { status: verdict.error ? 'reverted' : 'confirmed', hash: s.hash, txHash: root ? b64ToHex(root.hash) : null, fee: verdict.fee, error: verdict.error, messages: verdict.messages },
          executed: true,
        }
      }
    }
    const last = sent.at(-1) as { validUntil: number }
    if (!partial && !advanced && Date.now() / 1000 > last.validUntil + EXPIRY_GRACE) {
      // 都过期了还没查到：按节点（不是索引器）上的 seqno 判断有没有执行
      const seqno = await nodeSeqno(client, wallet.address, options.signal)
      if (seqno !== null && seqno > state.seqno) advanced = true
      else if (seqno !== null) {
        if (retries-- <= 0) return { outcome: { ...emptyOutcome('failed', 'expired: the transaction was not included before valid_until'), hash: sent[0]?.hash ?? null }, executed: false }
        await post()
        resent = true
      }
    }
    // 重发过时等到重发的那条也过期、能判断结果为止（可能超过 timeout）：否则返回 pending 后它仍可能上链
    if (Date.now() > deadline && !(resent && !partial && !advanced && Date.now() / 1000 <= (sent.at(-1)?.validUntil ?? 0) + EXPIRY_GRACE + 10)) break
  }
  if (partial) {
    const verdict = evaluateTrace(partial.trace, wallet.address, out)
    if (verdict.error && verdict.root && !verdict.messages?.every((m) => m === null)) {
      return { outcome: { status: 'reverted', hash: partial.hash, txHash: b64ToHex(verdict.root.hash), fee: verdict.fee, error: verdict.error, messages: verdict.messages }, executed: true }
    }
    const root = verdict.root
    return {
      outcome: { ...emptyOutcome('pending', 'the wallet transaction is confirmed, but later messages are still being processed'), hash: partial.hash, txHash: root ? b64ToHex(root.hash) : null, fee: verdict.fee },
      executed: true,
    }
  }
  const error = options.signal?.aborted
    ? 'aborted while waiting for the result'
    : advanced
      ? 'the wallet seqno advanced, but the transaction is not indexed yet'
      : `not confirmed before the timeout${pollError ? ` (last error while checking: ${pollError})` : ''}`
  return { outcome: { ...emptyOutcome('pending', error), hash: sent.at(-1)?.hash ?? null }, executed: advanced }
}

/** 加上 job.check 的结果 */
function checked(verdict: ReturnType<typeof evaluateTrace>, job: TxJob, trace: Trace): ReturnType<typeof evaluateTrace> {
  if (verdict.error || !job.check) return verdict
  const error = job.check(trace)
  return error ? { ...verdict, error, messages: verdict.messages ? verdict.messages.map(() => error) : null } : verdict
}

/** 节点上钱包合约的 seqno（get 方法，不经过索引器）；没部署为 0，读不到为 null */
async function nodeSeqno(client: TonClient, address: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await client.transport.post<{ exit_code?: number; stack?: Array<{ type: string; value: string }> }>('runGetMethod', { address, method: 'seqno', stack: [] }, { signal })
    if (res.exit_code === -13) return 0 // 账户不存在 / 没部署
    if (res.exit_code !== 0 || res.stack?.[0]?.type !== 'num') return null
    return Number(BigInt(res.stack[0].value))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 交易链（trace）：模拟结果和链上结果是同一个格式
// ---------------------------------------------------------------------------

export interface TraceMessage {
  hash: string
  destination?: string | null
  value?: string | null
  bounce?: boolean | null
  bounced?: boolean | null
  opcode?: string | null
  message_content?: { hash?: string } | null
}

export interface TraceTx {
  hash: string
  account: string
  total_fees?: string
  description?: {
    aborted?: boolean
    compute_ph?: { skipped?: boolean; success?: boolean; exit_code?: number; reason?: string }
    action?: { success?: boolean; result_code?: number; skipped_actions?: number; no_funds?: boolean }
  }
  in_msg?: TraceMessage | null
  out_msgs?: TraceMessage[]
}

interface TraceNode {
  tx_hash: string
  in_msg_hash?: string
  children?: TraceNode[]
}

export interface Trace {
  trace: TraceNode
  transactions: Record<string, TraceTx>
  is_incomplete?: boolean
  trace_info?: { trace_state?: string; pending_messages?: number }
}

const b64ToHex = (b64: string) => bytesToHex(base64ToBytes(b64))

/** 子树里第一个失败退回的交易（收到可回弹消息却失败的；不可回弹消息的失败，如通知发给没部署的钱包，不算） */
function bounceIn(trace: Trace, node: TraceNode): string | null {
  const tx = trace.transactions[node.tx_hash]
  if (tx?.description?.aborted && tx.in_msg?.bounce && !tx.in_msg.bounced) {
    const c = tx.description.compute_ph
    const why = c?.skipped ? `skipped (${c.reason ?? 'no state'})` : `exit code ${c?.exit_code ?? tx.description.action?.result_code}`
    return `message to ${toFriendlyAddress(tx.account)} failed: ${why}; it was bounced`
  }
  for (const child of node.children ?? []) {
    const e = bounceIn(trace, child)
    if (e) return e
  }
  return null
}

/**
 * 判断交易链的结果：钱包交易要执行成功；传了 messages 时逐条判断（有没有发出、后面的合约有没有失败退回），
 * W5 和默认的发送模式会忽略发不出的消息，所以同一笔里可能有的成功有的失败。error 是第一个失败原因
 */
export function evaluateTrace(
  trace: Trace,
  wallet: string,
  messages?: readonly SendMessage[],
): { error: string | null; fee: bigint | null; root: TraceTx | null; messages: Array<string | null> | null } {
  const root = trace.transactions[trace.trace.tx_hash] ?? null
  if (!root) return { error: 'the wallet transaction is missing from the trace', fee: null, root: null, messages: null }
  const fee = root.total_fees === undefined ? null : BigInt(root.total_fees)
  const d = root.description ?? {}
  const all = (error: string) => ({ error, fee, root, messages: messages ? messages.map(() => error) : null })
  if (toRawAddress(root.account) !== toRawAddress(wallet)) return all('the trace does not start at the wallet')
  if (d.compute_ph?.skipped) return all(`wallet transaction skipped (${d.compute_ph.reason ?? 'unknown reason'})`)
  if (!d.compute_ph?.success) return all(`wallet transaction failed with exit code ${d.compute_ph?.exit_code}`)
  if (d.action && !d.action.success) return all(`wallet action phase failed with result code ${d.action.result_code}${d.action.no_funds ? ' (not enough TON)' : ''}`)
  const children = trace.trace.children ?? []
  if (!messages) {
    if ((d.action?.skipped_actions ?? 0) > 0) return all(`${d.action?.skipped_actions} message(s) were not sent (not enough TON?)`)
    for (const child of children) {
      const e = bounceIn(trace, child)
      if (e) return all(e)
    }
    return { error: null, fee, root, messages: null }
  }
  // 按 目标地址 + 消息体哈希（+ 金额）对应到发出的消息。金额：带全部余额的模式（+64 / +128）不比较；
  // 没有 +1（手续费另付）时转发手续费从金额里扣，链上的金额会少一些
  const used = new Set<number>()
  const outs = root.out_msgs ?? []
  const results = messages.map((m): string | null => {
    const dest = toRawAddress(typeof m.message.to === 'string' ? m.message.to : toRawAddress(m.message.to))
    const body = bytesToBase64((m.message.body ?? Cell.EMPTY).hash())
    const mode = m.mode ?? 3
    const value = m.message.value
    const valueOk = (o: TraceMessage) => {
      if ((mode & (64 | 128)) !== 0) return true
      if (o.value === undefined || o.value === null) return false
      return (mode & 1) !== 0 ? o.value === value.toString() : BigInt(o.value) <= value
    }
    const k = outs.findIndex((o, n) => !used.has(n) && !!o.destination && toRawAddress(o.destination) === dest && o.message_content?.hash === body && valueOk(o))
    if (k < 0) return 'the message was not sent (not enough TON?)'
    used.add(k)
    const node = children.find((c) => c.in_msg_hash === (outs[k] as TraceMessage).hash)
    return node ? bounceIn(trace, node) : null
  })
  return { error: results.find((r) => r !== null) ?? null, fee, root, messages: results }
}

/**
 * toncenter 的 emulateTrace：模拟外部消息引起的整条交易链（与 v3 接口同一个服务，路径 /api/emulate/v1）。
 * rejected：钱包不接受这条外部消息（签名、seqno、过期、余额不够付手续费等）；unavailable：模拟服务不可用
 */
async function emulate(client: TonClient, ext: Cell, ignoreSignature: boolean, signal?: AbortSignal): Promise<{ trace: Trace | null; rejected: string | null; unavailable: string | null }> {
  try {
    const trace = await client.transport.post<Trace>('../emulate/v1/emulateTrace', { boc: ext.toBase64(), ignore_chksig: ignoreSignature }, { signal })
    if (!trace?.trace || !trace.transactions) return { trace: null, rejected: null, unavailable: 'unexpected response' }
    return { trace, rejected: null, unavailable: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 只有钱包拒绝外部消息才算模拟失败；其他错误（节点问题、模拟服务的限制如消息太大）按模拟不可用处理
    if (!REJECTED.test(message)) return { trace: null, rejected: null, unavailable: message }
    const reason = /rejected by account/i.test(message) ? `the wallet rejected the message (wrong key or wallet version, seqno, expired, or not enough TON to pay fees): ${message}` : message
    return { trace: null, rejected: reason, unavailable: null }
  }
}

function walletError(err: unknown): string {
  const text = `${(err as { name?: string })?.name ?? ''} ${(err as Error)?.message ?? String(err)}`
  // @tonconnect/sdk 的 UserRejectsError；钱包的其他错误（含 “rejected by account” 等）原样返回
  return /UserRejects|user reject|rejected by user|denied|cancel|declined/i.test(text) ? 'rejected by user' : ((err as Error)?.message ?? String(err))
}
