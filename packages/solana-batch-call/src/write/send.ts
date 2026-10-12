import { sha256 } from '@noble/hashes/sha2.js'
import { base58, base64 } from '@scure/base'

import type { SolanaClient } from '../client.js'
import { SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../constants.js'
import { RpcError, isNodeFault } from '../rpc.js'
import { MAX_COMPUTE_UNITS, setComputeUnitLimit, setComputeUnitPrice } from './instructions.js'
import type { LocalSigner, ResolvedSigner, SignerInput, WalletSigner } from './signer.js'
import { MAX_ACCOUNT_LOCKS, PACKET_DATA_SIZE, compileMessage, messageBlockhash, sameBytes, serializeTransaction, transactionSize, type CompiledMessage, type Instruction } from './transaction.js'

/**
 * 每个调用的状态：
 * - confirmed：已上链且执行成功
 * - reverted：已上链但执行失败（手续费已扣）；同一笔交易里的其他调用也一起回滚，同样是 reverted
 * - failed：没有发出去（模拟失败、SOL 不够付手续费、交易过期且重试次数用完等），不花手续费
 * - sent：已广播，没等确认（wait: false，或等待中途取消）。广播时节点都连不上（交易可能已经发出）也算 sent，error 里有说明
 * - pending：等到 timeout 还没确认，交易的 blockhash 过期前仍可能上链
 * - skipped：没有执行：前面的调用失败（continueOnError 为 false 时）、已取消、余额为 0 等
 * - simulated：dryRun 模拟通过
 */
export type WriteStatus = 'confirmed' | 'reverted' | 'failed' | 'sent' | 'pending' | 'skipped' | 'simulated'

/** 发送参数（batchCall / batchTransfer / batchCollect 共用） */
export interface SendOptions {
  /** 等待确认。默认 true；false 时广播后即返回，status 为 'sent'（不会在过期后重发） */
  wait?: boolean
  /** 每笔交易等待确认的最长时间（毫秒），超时 status 为 'pending'。默认 120000 */
  timeout?: number
  /** 查询确认状态的间隔（毫秒），默认 2000。等待期间每次都重发一次原交易（同一笔签名交易重复发送是安全的） */
  pollInterval?: number
  /** 同时处理的手续费支付者数（同一支付者的交易按顺序发出，不等上一笔确认），默认 8 */
  concurrency?: number
  /**
   * 手续费支付者：所有交易的手续费（以及新建代币账户的租金）由它付，发送方的钱包不需要有 SOL。
   * 不传时每个钱包自己付
   */
  feePayer?: SignerInput
  /**
   * 优先费用（每个计算单元多少 micro-lamports），或 'auto'（默认）：按 getRecentPrioritizationFees 里这笔交易可写账户的最近费用取 75 分位，
   * 不超过 maxPriorityFee。计算单元上限按模拟结果设置（× 1.1 + 1000），优先费用 = 单价 × 上限
   */
  priorityFee?: number | bigint | 'auto'
  /** 'auto' 时优先费用单价的上限（micro-lamports），默认 1000000 */
  maxPriorityFee?: number | bigint
  /** 交易过期（blockhash 失效）仍未上链时，重新模拟、换新 blockhash 重发的次数。默认 2 */
  retries?: number
  /** 等到什么确认级别，默认 'confirmed' */
  commitment?: 'confirmed' | 'finalized'
  /** 只模拟、不发送，status 为 'simulated' 或 'failed'。注意：依赖前一笔交易结果的调用模拟会失败 */
  dryRun?: boolean
  /** 取消：不再发新交易，已发出的不再等待确认（status 为 'sent'） */
  signal?: AbortSignal
  /** 每个结果状态变化时回调，用于展示进度 */
  onUpdate?: (result: WriteResult) => void
}

/** 每个调用的结果，都是字符串 / 数字 / null，可以直接 JSON.stringify */
export interface WriteResult {
  /** 在输入里的下标 */
  index: number
  /** 发送的钱包地址 */
  from: string
  status: WriteStatus
  /** 交易签名（同一笔交易里的多个调用相同） */
  signature: string | null
  /** 上链的 slot */
  slot: number | null
  /** 整笔交易的手续费（lamports）：每个签名 5000 + 优先费用；同一笔交易里的多个调用相同，不含新建账户的租金 */
  fee: string | null
  /** 模拟时整笔交易消耗的计算单元 */
  computeUnits: number | null
  error: string | null
}

/** 交易层面的结果 */
export interface TxOutcome {
  status: WriteStatus
  signature: string | null
  slot: number | null
  fee: bigint | null
  computeUnits: number | null
  error: string | null
}

/** 一个调用：要原子执行的一组指令（同一笔交易里的多个调用，任一失败整笔回滚） */
export interface Unit {
  instructions: Instruction[]
  /** 手续费支付者 */
  payer: ResolvedSigner
  /** 指令需要的其他签名者 */
  signers: ResolvedSigner[]
  /** 单独成一笔交易，计算单元上限和优先费用固定（扫空 SOL 时手续费要事先算好） */
  fixed?: { computeUnits: number; price: bigint }
  /** 发送前失败时后面的调用是否继续，默认 false */
  continueOnError?: boolean
  onUpdate(outcome: TxOutcome): void
}

export function emptyOutcome(status: WriteStatus, error: string | null = null): TxOutcome {
  return { status, signature: null, slot: null, fee: null, computeUnits: null, error }
}

export function toWriteResult(index: number, from: string, outcome: TxOutcome): WriteResult {
  return {
    index,
    from,
    status: outcome.status,
    signature: outcome.signature,
    slot: outcome.slot,
    fee: outcome.fee?.toString() ?? null,
    computeUnits: outcome.computeUnits,
    error: outcome.error,
  }
}

/** 并发数为 limit 的 map，结果按输入顺序 */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return results
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** 每个签名的基础手续费（lamports） */
export const LAMPORTS_PER_SIGNATURE = 5000n

/** 交易手续费：签名数 × 5000 + 优先费用（单价 × 计算单元上限，向上取整） */
export function transactionFee(signatures: number, computeUnits: number, price: bigint): bigint {
  return LAMPORTS_PER_SIGNATURE * BigInt(signatures) + (price * BigInt(computeUnits) + 999_999n) / 1_000_000n
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---- 交易错误 ----

interface SimulationValue {
  err: unknown
  logs?: string[] | null
  unitsConsumed?: number
}

const TX_ERRORS: Record<string, string> = {
  InsufficientFundsForFee: 'insufficient SOL for the transaction fee',
  AccountNotFound: 'fee payer account not found (it has no SOL)',
  BlockhashNotFound: 'blockhash not found',
  AlreadyProcessed: 'transaction already processed',
}

/**
 * 日志里最有用的一行：程序打印的 “Program log: Error: …”，其次是系统程序直接打印的说明（如 “Transfer: insufficient lamports …”，
 * 不以 “Program ” 开头），最后才是运行时的 “Program … failed: custom program error: 0x1”
 */
function logDetail(logs: readonly string[]): string | undefined {
  const reversed = [...logs].reverse()
  const programError = reversed.find((line) => /^Program log: (Error|error)/.test(line))
  if (programError) return programError.replace(/^Program log: /, '')
  const plain = reversed.find((line) => !line.startsWith('Program '))
  if (plain) return plain
  return reversed.find((line) => / failed: /.test(line))?.replace(/^Program \w+ failed: /, '')
}

// 常见程序的自定义错误码（上链失败时没有日志，只有错误码）
const SYSTEM_ERRORS = ['account already in use', 'insufficient lamports', 'invalid program id', 'invalid account data length']
const TOKEN_ERRORS: Record<number, string> = {
  0: 'account not rent-exempt',
  1: 'insufficient funds',
  2: 'invalid mint',
  3: 'account not associated with this mint',
  4: 'owner does not match',
  9: 'account is not initialized',
  11: 'non-native account can only be closed if its balance is zero',
  17: 'account is frozen',
  18: 'mint decimals mismatch',
}

function customErrorText(program: string | undefined, code: number): string | undefined {
  if (program === SYSTEM_PROGRAM_ID) return SYSTEM_ERRORS[code]
  if (program === TOKEN_PROGRAM_ID || program === TOKEN_2022_PROGRAM_ID) return TOKEN_ERRORS[code]
  return undefined
}

/**
 * 交易错误的可读说明：优先取日志（见 logDetail），否则按错误类型；
 * programs 是每条指令的程序（按下标），用来翻译常见程序的自定义错误码
 */
export function transactionErrorText(err: unknown, logs?: readonly string[] | null, programs?: readonly string[]): string {
  const detail = logDetail(logs ?? [])
  if (typeof err === 'string') {
    return TX_ERRORS[err] ?? err
  }
  const instruction = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError
  if (instruction) {
    const [index, reason] = instruction
    const custom = (reason as { Custom?: number } | null)?.Custom
    const known = custom === undefined ? undefined : customErrorText(programs?.[index], custom)
    return detail ?? known ?? (typeof reason === 'string' ? reason : JSON.stringify(reason))
  }
  if ((err as { InsufficientFundsForRent?: unknown } | null)?.InsufficientFundsForRent) {
    return 'account would be left with less SOL than the rent-exempt minimum'
  }
  return detail ?? JSON.stringify(err)
}

function isBudgetExceeded(err: unknown, logs?: readonly string[] | null): boolean {
  const reason = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError?.[1]
  return reason === 'ComputationalBudgetExceeded' || (logs ?? []).some((l) => /exceeded CUs meter|compute units/i.test(l) && /exceed/i.test(l))
}

// ---- 节点访问 ----

/**
 * 最近发出过的交易消息（sha256）：同样的消息签名也相同，再发一次只会被节点当成同一笔。
 * 在签名之前检查（钱包签名的交易也适用），重复时调整计算单元上限让消息不同
 */
const recentMessages = new Set<string>()

function messageKey(message: Uint8Array): string {
  return base64.encode(sha256(message))
}

function remember(message: Uint8Array): void {
  recentMessages.add(messageKey(message))
  if (recentMessages.size > 10_000) {
    recentMessages.delete(recentMessages.values().next().value as string)
  }
}

interface Blockhash {
  blockhash: string
  lastValidBlockHeight: number
}

/** 一批发送共用的节点访问：blockhash（缓存 10 秒）、优先费用（按账户缓存 10 秒） */
class Chain {
  #blockhash: { at: number; value: Promise<Blockhash> } | null = null
  readonly #fees = new Map<string, { at: number; value: Promise<bigint> }>()

  constructor(
    readonly client: SolanaClient,
    readonly options: SendOptions,
  ) {}

  get commitment(): 'confirmed' | 'finalized' {
    return this.options.commitment ?? 'confirmed'
  }

  #walletChain: Promise<string | undefined> | null = null

  /** Wallet Standard 的链标识（'solana:mainnet' 等）；网络未知时为 undefined */
  walletChain(): Promise<string | undefined> {
    this.#walletChain ??= this.client.getCluster().then(
      (cluster) => (cluster ? `solana:${cluster}` : undefined),
      () => undefined,
    )
    return this.#walletChain
  }

  blockhash(fresh = false): Promise<Blockhash> {
    if (fresh || !this.#blockhash || Date.now() - this.#blockhash.at > 10_000) {
      const value = this.client
        .request<{ value: Blockhash }>('getLatestBlockhash', [{ commitment: 'confirmed' }])
        .then((res) => res.value)
      value.catch(() => {
        if (this.#blockhash?.value === value) this.#blockhash = null
      })
      this.#blockhash = { at: Date.now(), value }
    }
    return this.#blockhash.value
  }

  async priorityFee(writable: readonly string[]): Promise<bigint> {
    const option = this.options.priorityFee ?? 'auto'
    if (option !== 'auto') {
      return BigInt(option)
    }
    const accounts = [...writable].sort().slice(0, 128)
    const key = accounts.join(',')
    let cached = this.#fees.get(key)
    if (!cached || Date.now() - cached.at > 10_000) {
      const cap = BigInt(this.options.maxPriorityFee ?? 1_000_000)
      const value = this.client
        .request<Array<{ prioritizationFee: number }>>('getRecentPrioritizationFees', [accounts])
        .then((list) => {
          const fees = list.map((f) => BigInt(f.prioritizationFee)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          const p75 = fees.length ? (fees[Math.min(fees.length - 1, Math.floor(fees.length * 0.75))] as bigint) : 0n
          return p75 < cap ? p75 : cap
        })
        .catch(() => 0n) // 节点不支持时不加优先费用
      cached = { at: Date.now(), value }
      this.#fees.set(key, cached)
    }
    return cached.value
  }

  async simulate(message: CompiledMessage, minContextSlot: number | undefined): Promise<SimulationValue> {
    const raw = base64.encode(serializeTransaction(message, message.signers.map(() => null)))
    const config: Record<string, unknown> = { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }
    if (minContextSlot !== undefined) {
      config.minContextSlot = minContextSlot
    }
    // 节点暂时的问题（限频、高度还没到 minContextSlot 等）重试几次，不当成调用失败
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.client.request<{ value: SimulationValue }>('simulateTransaction', [raw, config])
        return res.value
      } catch (err) {
        if (attempt >= 3 || (err instanceof RpcError && !isNodeFault(err))) throw err
        await sleep(500 * (attempt + 1), this.options.signal)
      }
    }
  }

  /** 广播：'accepted'；节点明确拒绝时抛出；节点都连不上时返回错误说明（交易可能已经发出） */
  async broadcast(raw: string): Promise<'accepted' | { uncertain: string }> {
    try {
      await this.client.request('sendTransaction', [raw, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }])
      return 'accepted'
    } catch (err) {
      if (/already (been )?processed/i.test(errorText(err))) {
        return 'accepted'
      }
      if (err instanceof RpcError && !isNodeFault(err)) {
        throw err
      }
      return { uncertain: `broadcast not acknowledged: ${errorText(err)}` }
    }
  }
}

/** 按 SendOptions 取优先费用单价（micro-lamports / 计算单元）；writable 是交易里的可写账户 */
export function priorityFeeFor(client: SolanaClient, options: SendOptions, writable: readonly string[]): Promise<bigint> {
  return new Chain(client, options).priorityFee(writable)
}

// ---- 确认 ----

interface SignatureStatus {
  slot: number
  err: unknown
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null
}

type WatchResult = { kind: 'landed'; slot: number; err: unknown } | { kind: 'expired' } | { kind: 'timeout' } | { kind: 'aborted' }

interface Watched {
  signature: string
  raw: string
  /** blockhash 的有效期；Infinity 表示不知道（钱包换了 blockhash），这时不判断过期、不自动重发 */
  lastValidBlockHeight: number
  deadline: number
  polls: number
  resolve(result: WatchResult): void
}

/** 统一轮询所有待确认的交易：一次 getSignatureStatuses 查全部（每 256 个一组），未确认的每次重发，blockhash 过期后再查一次历史确认没上链 */
class Tracker {
  readonly #watched = new Set<Watched>()
  #running = false

  constructor(readonly chain: Chain) {}

  watch(signature: string, raw: string, lastValidBlockHeight: number): Promise<WatchResult> {
    const { timeout = 120_000 } = this.chain.options
    return new Promise((resolve) => {
      this.#watched.add({ signature, raw, lastValidBlockHeight, deadline: Date.now() + timeout, polls: 0, resolve })
      if (!this.#running) {
        this.#running = true
        void this.#loop()
      }
    })
  }

  /** 查交易状态；contextSlot 是各次响应里最小的 context.slot（节点的数据新到哪个 slot） */
  async #statuses(signatures: string[], history: boolean): Promise<{ found: Map<string, SignatureStatus>; contextSlot: number }> {
    const found = new Map<string, SignatureStatus>()
    let contextSlot = Number.POSITIVE_INFINITY
    for (let i = 0; i < signatures.length; i += 256) {
      const chunk = signatures.slice(i, i + 256)
      const res = await this.chain.client.request<{ context?: { slot?: number }; value: Array<SignatureStatus | null> }>('getSignatureStatuses', [
        chunk,
        { searchTransactionHistory: history },
      ])
      contextSlot = Math.min(contextSlot, res.context?.slot ?? 0)
      res.value.forEach((s, k) => s && found.set(chunk[k] as string, s))
    }
    return { found, contextSlot }
  }

  #done(status: SignatureStatus): boolean {
    const level = status.confirmationStatus
    return this.chain.commitment === 'finalized' ? level === 'finalized' : level === 'confirmed' || level === 'finalized'
  }

  #settle(item: Watched, result: WatchResult): void {
    this.#watched.delete(item)
    item.resolve(result)
  }

  async #loop(): Promise<void> {
    const { pollInterval = 2_000, signal } = this.chain.options
    try {
      while (this.#watched.size) {
        await sleep(pollInterval, signal)
        if (signal?.aborted) {
          ;[...this.#watched].forEach((w) => this.#settle(w, { kind: 'aborted' }))
          return
        }
        const items = [...this.#watched]
        try {
          const { found: statuses } = await this.#statuses(
            items.map((w) => w.signature),
            false,
          )
          for (const item of items) {
            const status = statuses.get(item.signature)
            if (status && this.#done(status)) {
              this.#settle(item, { kind: 'landed', slot: status.slot, err: status.err })
            }
          }
          const waiting = items.filter((w) => this.#watched.has(w))
          if (!waiting.length) {
            continue
          }
          // 区块高度和对应的 slot 一起取（同一个节点、同一个时刻）
          const epoch = await this.chain.client.request<{ blockHeight: number; absoluteSlot: number }>('getEpochInfo', [{ commitment: 'confirmed' }])
          const expired = waiting.filter((w) => epoch.blockHeight > w.lastValidBlockHeight)
          if (expired.length) {
            // 过期了：再查一次历史确认确实没上链。请求可能落到另一个节点（多节点 / 负载均衡），
            // 它的数据必须不早于看到过期的那个 slot，否则可能只是它还没看到这笔交易，这一轮先不判断
            const history = await this.#statuses(
              expired.map((w) => w.signature),
              true,
            )
            const caughtUp = history.contextSlot >= epoch.absoluteSlot
            for (const item of expired) {
              const status = history.found.get(item.signature)
              if (!status) {
                if (!caughtUp) continue
                this.#settle(item, { kind: 'expired' })
              } else if (this.#done(status)) {
                this.#settle(item, { kind: 'landed', slot: status.slot, err: status.err })
              }
            }
          }
        } catch {
          // 节点暂时出错：下次再查
        }
        const now = Date.now()
        for (const item of [...this.#watched]) {
          if (now >= item.deadline) {
            this.#settle(item, { kind: 'timeout' })
          } else if (++item.polls % 2 === 0) {
            // 每两次轮询重发一次（每笔都重发会让待确认交易多时很快触发节点限频）
            void this.chain.broadcast(item.raw).catch(() => {})
          }
        }
      }
    } finally {
      this.#running = false
      if (this.#watched.size) {
        this.#running = true
        void this.#loop()
      }
    }
  }
}

// ---- 发送 ----

/** 打包用的占位 blockhash（大小与真实值相同） */
const PLACEHOLDER_BLOCKHASH = '11111111111111111111111111111111'

function budgetInstructions(units: number, price: bigint): Instruction[] {
  return [setComputeUnitLimit(units), setComputeUnitPrice(price)]
}

function fits(payer: string, units: readonly Unit[]): boolean {
  const message = compileMessage(payer, [...budgetInstructions(MAX_COMPUTE_UNITS, 0n), ...units.flatMap((u) => u.instructions)], PLACEHOLDER_BLOCKHASH)
  return transactionSize(message) <= PACKET_DATA_SIZE && message.accountKeys.length <= MAX_ACCOUNT_LOCKS
}

/** 交易错误对应的调用：InstructionError 的指令下标（前两条是计算预算指令），或租金不足的账户所在的调用 */
function failingUnit(err: unknown, units: readonly Unit[], message: CompiledMessage): number | null {
  const instruction = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError
  if (instruction) {
    let offset = instruction[0] - 2
    for (let i = 0; i < units.length; i++) {
      const count = (units[i] as Unit).instructions.length
      if (offset < count) {
        return offset >= 0 ? i : null
      }
      offset -= count
    }
    return null
  }
  const rent = (err as { InsufficientFundsForRent?: { account_index?: number } } | null)?.InsufficientFundsForRent
  if (rent?.account_index !== undefined) {
    // 账户余额是按顺序被扣的：从最后一个用到它的调用开始剔除（如付款方转出太多时，先剔除最后的转账）
    const account = message.accountKeys[rent.account_index]
    for (let i = units.length - 1; i >= 0; i--) {
      if ((units[i] as Unit).instructions.some((ix) => ix.keys.some((k) => k.pubkey === account && k.isWritable))) return i
    }
    return null
  }
  return null
}

export interface SendUnitsOptions {
  /** 每笔交易最多打包几个调用，默认不限（按交易大小 1232 字节和 64 个账户的上限） */
  batchSize?: number
}

/**
 * 发送一批调用：按手续费支付者分组，组内按顺序把相邻的调用打包成交易（不超过交易大小上限），
 * 逐笔模拟（失败的调用剔除后重新模拟其余的）、签名、发送，不等上一笔确认；不同支付者并发。
 * 模拟失败且同一支付者还有未确认的交易时，先等它们确认再模拟一次（后一笔依赖前一笔时自动正确处理）
 */
export async function sendUnits(client: SolanaClient, units: readonly Unit[], options: SendOptions, pack: SendUnitsOptions = {}): Promise<void> {
  const chain = new Chain(client, options)
  const tracker = new Tracker(chain)
  const groups = new Map<string, Unit[]>()
  units.forEach((u) => {
    const list = groups.get(u.payer.address)
    if (list) list.push(u)
    else groups.set(u.payer.address, [u])
  })
  await mapPool([...groups.values()], options.concurrency ?? 8, (list) => sendGroup(chain, tracker, list, options, pack.batchSize ?? Number.POSITIVE_INFINITY))
}

/** 模拟通过、等待签名的一笔交易 */
interface Prepared {
  units: Unit[]
  instructions: Instruction[]
  blockhash: Blockhash
  price: bigint
  limit: number
  consumed: number | null
  fixed: boolean
}

function isRejection(err: unknown): boolean {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null
  return e?.code === 4001 || /reject|denied|cancel|declined/i.test(`${String(e?.name ?? '')} ${String(e?.message ?? '')}`)
}

async function sendGroup(chain: Chain, tracker: Tracker, units: readonly Unit[], options: SendOptions, batchSize: number): Promise<void> {
  const { signal, dryRun = false, wait = true, retries = 2 } = options
  const payer = (units[0] as Unit).payer
  /** 有浏览器钱包等外部签名者：先准备好全部交易，再让钱包一次签完 */
  const deferred = units.some((u) => u.payer.kind === 'wallet' || u.signers.some((s) => s.kind === 'wallet'))
  /** 已发出的交易：sent 为 true 表示还没有结果；watch() 开始等待确认（wait 为 false 时只在需要时才等） */
  const inFlight: Array<{ sent: boolean; watch: () => Promise<void> }> = []
  /** 同一支付者已上链交易的最高 slot（之后的模拟不早于它） */
  let minSlot: number | undefined
  let stopped = false
  const settle = async () => {
    // 等待期间可能有过期重发的新交易加进来：直到没有新的为止
    for (let seen = -1; seen !== inFlight.length; ) {
      seen = inFlight.length
      await Promise.all(inFlight.map((f) => f.watch()))
    }
  }
  const update = (unit: Unit, patch: Partial<TxOutcome> & { status: WriteStatus }) => {
    try {
      unit.onUpdate({ ...emptyOutcome(patch.status), ...patch })
    } catch {
      // 调用方的进度回调出错不能打断发送（已经发出的交易还要继续跟踪）
    }
  }
  const skip = (list: readonly Unit[], error: string) => list.forEach((u) => update(u, { status: 'skipped', error }))
  const fail = (list: readonly Unit[], error: string) => {
    list.forEach((u) => update(u, { status: 'failed', error }))
    if (list.some((u) => !u.continueOnError)) stopped = true
  }

  /**
   * 准备一批调用：模拟，剔除失败的调用后重新模拟其余的，计算单元超出单笔上限时拆成两笔。返回待签名的交易（可能 0 笔或多笔）。
   * attempt：过期后第几次重发
   */
  const prepare = async (batch: readonly Unit[], attempt: number): Promise<Prepared[]> => {
    let pending = [...batch]
    // 过期重发时不再等其他交易：这次调用本身就在某笔交易的等待回调里，等全部交易会等到自己（死锁）；依赖的交易早已上链
    let waited = attempt > 0
    while (pending.length) {
      if (signal?.aborted) {
        skip(pending, 'aborted')
        return []
      }
      try {
        const fixed = pending.length === 1 ? (pending[0] as Unit).fixed : undefined
        const instructions = pending.flatMap((u) => u.instructions)
        const blockhash = await chain.blockhash(attempt > 0)
        const probe = compileMessage(payer.address, [...budgetInstructions(MAX_COMPUTE_UNITS, 0n), ...instructions], blockhash.blockhash)
        const price = fixed?.price ?? (await chain.priorityFee(probe.writable))
        // 模拟时计算单元上限取最大值，优先费用单价按 0（否则节点按 140 万 × 单价预扣手续费，余额少的付款方会被误判为付不起）；
        // 算出真实的上限后再按真实费用复核一次
        const simMessage = compileMessage(payer.address, [...budgetInstructions(fixed?.computeUnits ?? MAX_COMPUTE_UNITS, fixed ? price : 0n), ...instructions], blockhash.blockhash)
        const sim = await chain.simulate(simMessage, minSlot)
        if (sim.err) {
          if (!waited && inFlight.some((f) => f.sent)) {
            // 可能依赖前面还没确认的交易：等它们确认后重新模拟
            waited = true
            await settle()
            continue
          }
          if (isBudgetExceeded(sim.err, sim.logs) && pending.length > 1) {
            // 计算单元超出单笔上限：拆成两笔
            const half = Math.ceil(pending.length / 2)
            const first = await prepare(pending.slice(0, half), attempt)
            if (stopped) {
              skip(pending.slice(half), 'skipped: a previous call failed')
              return first
            }
            return [...first, ...(await prepare(pending.slice(half), attempt))]
          }
          const text = transactionErrorText(sim.err, sim.logs)
          const index = failingUnit(sim.err, pending, simMessage)
          if (index === null || pending.length === 1) {
            fail(pending, text)
            return []
          }
          const failed = pending[index] as Unit
          update(failed, { status: 'failed', error: text })
          if (!failed.continueOnError) {
            // 后面的调用不再执行；前面的照常发送
            stopped = true
            skip(pending.slice(index + 1), 'skipped: a previous call failed')
            pending = pending.slice(0, index)
          } else {
            pending.splice(index, 1)
          }
          continue
        }
        const consumed = sim.unitsConsumed ?? null
        const limit = fixed?.computeUnits ?? (consumed ? Math.min(MAX_COMPUTE_UNITS, Math.ceil(consumed * 1.1) + 1000) : MAX_COMPUTE_UNITS)
        if (!fixed && price > 0n) {
          const check = await chain.simulate(compileMessage(payer.address, [...budgetInstructions(limit, price), ...instructions], blockhash.blockhash), minSlot)
          if (check.err) {
            fail(pending, transactionErrorText(check.err, check.logs))
            return []
          }
        }
        if (dryRun) {
          const fee = transactionFee(simMessage.signers.length, limit, price)
          pending.forEach((u) => update(u, { status: 'simulated', fee, computeUnits: consumed }))
          return []
        }
        return [{ units: pending, instructions, blockhash, price, limit, consumed, fixed: Boolean(fixed) }]
      } catch (err) {
        fail(pending, errorText(err))
        return []
      }
    }
    return []
  }

  /** 签名（外部钱包一次签完）并发送，等待确认；过期时重新准备、签名、发送 */
  const finish = async (list: readonly Prepared[], attempt: number): Promise<void> => {
    if (!list.length) return
    const txs = list.map((p) => {
      // 同样的消息签名也相同、会被节点当成同一笔：调整计算单元上限让消息不同
      let limit = p.limit
      let message = compileMessage(payer.address, [...budgetInstructions(limit, p.price), ...p.instructions], p.blockhash.blockhash)
      while (!p.fixed && recentMessages.has(messageKey(message.bytes))) {
        limit += 1
        message = compileMessage(payer.address, [...budgetInstructions(limit, p.price), ...p.instructions], p.blockhash.blockhash)
      }
      remember(message.bytes)
      const signers = new Map<string, ResolvedSigner>([[payer.address, payer]])
      p.units.forEach((u) => u.signers.forEach((s) => signers.set(s.address, s)))
      return {
        prepared: p,
        message: message.bytes,
        signerList: message.signers,
        signatures: message.signers.map((): Uint8Array | null => null),
        signers,
        fee: transactionFee(message.signers.length, limit, p.price) as bigint | null,
        failed: null as string | null,
        modified: false,
        lastValidBlockHeight: p.blockhash.lastValidBlockHeight,
      }
    })
    for (const tx of txs) {
      const missing = tx.signerList.find((s) => !tx.signers.has(s))
      if (missing) tx.failed = `missing signer ${missing}`
    }

    // 外部钱包先签（有的钱包只在没有其他签名时才会往交易里加指令），一个钱包一次签完所有交易
    const wallets = new Map<string, WalletSigner>()
    txs.forEach((tx) => tx.signers.forEach((s) => s.kind === 'wallet' && wallets.set(s.address, s)))
    for (const wallet of wallets.values()) {
      const needing = txs.filter((tx) => !tx.failed && tx.signerList.includes(wallet.address))
      if (!needing.length) continue
      try {
        const signed = await wallet.signTransactions(
          needing.map((tx) => ({ message: tx.message, signers: tx.signerList, signatures: tx.signatures })),
          await chain.walletChain(),
        )
        needing.forEach((tx, k) => {
          const result = signed[k] as (typeof signed)[number]
          if (sameBytes(result.message, tx.message)) {
            const index = tx.signerList.indexOf(wallet.address)
            tx.signatures[index] = result.signatures[result.signers.indexOf(wallet.address)] ?? null
            if (!tx.signatures[index]) tx.failed = 'wallet did not sign the transaction'
            return
          }
          // 钱包改了交易（如加了优先费用指令）：只有它一个签名者时接受（用户在钱包里确认过）；还有其他签名者时不让本地私钥去签钱包改过的内容
          if (tx.signerList.length > 1 || result.signers.length > 1) {
            tx.failed = 'the wallet modified the transaction; this is not supported when other signers are involved'
            return
          }
          tx.message = result.message
          tx.signerList = result.signers
          tx.signatures = result.signatures
          tx.fee = null // 钱包可能改了计算单元或优先费用
          tx.modified = true
          remember(result.message)
          // 钱包换了 blockhash：不知道新 blockhash 的有效期，不判断过期、不自动重发（误判过期再发一笔可能两笔都上链）
          if (messageBlockhash(result.message) !== tx.prepared.blockhash.blockhash) tx.lastValidBlockHeight = Number.POSITIVE_INFINITY
          if (!tx.signatures[0]) tx.failed = 'wallet did not sign the transaction'
        })
      } catch (err) {
        const text = isRejection(err) ? 'rejected by user' : errorText(err)
        needing.forEach((tx) => (tx.failed = text))
      }
    }
    // 本地签名
    for (const tx of txs) {
      if (tx.failed) continue
      try {
        await Promise.all(
          tx.signerList.map(async (s, i) => {
            const signer = tx.signers.get(s)
            if (signer?.kind === 'local') tx.signatures[i] = await (signer as LocalSigner).sign(tx.message)
          }),
        )
      } catch (err) {
        tx.failed = errorText(err)
      }
    }

    /** 这一轮里签名 / 发送失败、且不允许继续的交易之后的交易都跳过（模拟阶段失败的调用排在已准备好的交易之后，不影响它们） */
    let halted = false
    const halt = (units: readonly Unit[], error: string) => {
      fail(units, error)
      if (units.some((u) => !u.continueOnError)) halted = true
    }
    for (const tx of txs) {
      const { prepared } = tx
      if (signal?.aborted || halted) {
        skip(prepared.units, signal?.aborted ? 'aborted' : 'skipped: a previous call failed')
        continue
      }
      if (tx.failed) {
        halt(prepared.units, tx.failed)
        continue
      }
      const signature = base58.encode(tx.signatures[0] as Uint8Array)
      const raw = base64.encode(serializeTransaction({ bytes: tx.message, signers: tx.signerList }, tx.signatures))
      let sent: Awaited<ReturnType<Chain['broadcast']>>
      try {
        sent = await chain.broadcast(raw)
      } catch (err) {
        halt(prepared.units, errorText(err))
        continue
      }
      const fee = tx.fee
      const consumed = prepared.consumed
      const note = sent === 'accepted' ? null : sent.uncertain
      prepared.units.forEach((u) => update(u, { status: 'sent', signature, fee, computeUnits: consumed, error: note }))
      const landed = prepared.units
      /** 交易里每条指令的程序（翻译上链失败的错误码用）；钱包改过的交易不知道对应关系 */
      const programs = tx.modified ? undefined : [...budgetInstructions(0, 0n), ...prepared.instructions].map((ix) => ix.programId)
      const layout = compileMessage(payer.address, [...budgetInstructions(0, 0n), ...prepared.instructions], prepared.blockhash.blockhash)
      let watching: Promise<void> | null = null
      const flight = { sent: true, watch: () => (watching ??= follow()) }
      const follow = () =>
        tracker.watch(signature, raw, tx.lastValidBlockHeight).then(async (result) => {
          flight.sent = false
          const base = { signature, fee, computeUnits: consumed }
          if (result.kind === 'landed') {
            minSlot = Math.max(minSlot ?? 0, result.slot)
            if (result.err === null || result.err === undefined) {
              landed.forEach((u) => update(u, { ...base, status: 'confirmed', slot: result.slot }))
            } else {
              const index = tx.modified ? null : failingUnit(result.err, landed, layout)
              const text = transactionErrorText(result.err, null, programs)
              landed.forEach((u, k) =>
                update(u, { ...base, status: 'reverted', slot: result.slot, error: index === null || k === index ? text : 'reverted: another call in the same transaction failed' }),
              )
            }
          } else if (result.kind === 'expired') {
            if (attempt < retries) {
              await finish(await prepare(landed, attempt + 1), attempt + 1)
            } else {
              landed.forEach((u) => update(u, { status: 'failed', error: 'transaction expired before it was confirmed (blockhash no longer valid)' }))
            }
          } else if (result.kind === 'timeout') {
            landed.forEach((u) => update(u, { ...base, status: 'pending', error: `not confirmed within ${options.timeout ?? 120_000}ms` }))
          }
          // aborted：保持 sent
        })
      inFlight.push(flight)
      if (wait) {
        void flight.watch()
      }
    }
  }

  // 打包：从下一个调用开始，依次加入后面的调用，直到超出交易大小 / 账户数上限
  let next = 0
  const nextBatch = (): Unit[] | null => {
    while (next < units.length) {
      const first = units[next] as Unit
      next++
      if (!fits(payer.address, [first])) {
        update(first, { status: 'failed', error: `transaction too large (over ${PACKET_DATA_SIZE} bytes or ${MAX_ACCOUNT_LOCKS} accounts)` })
        if (!first.continueOnError) stopped = true
        if (stopped) return null
        continue
      }
      const batch: Unit[] = [first]
      while (!first.fixed && next < units.length && batch.length < batchSize) {
        const candidate = units[next] as Unit
        if (candidate.fixed || !fits(payer.address, [...batch, candidate])) break
        batch.push(candidate)
        next++
      }
      return batch
    }
    return null
  }
  const skipRest = () => skip(units.slice(next), signal?.aborted ? 'aborted' : 'skipped: a previous call failed')

  if (deferred) {
    // 先全部准备好（模拟），再一次签名、发送：钱包只弹一次确认。依赖同一批里前面交易结果的调用模拟会失败（还没有交易发出）
    const prepared: Prepared[] = []
    for (let batch = nextBatch(); batch; batch = stopped || signal?.aborted ? null : nextBatch()) {
      prepared.push(...(await prepare(batch, 0)))
    }
    if (stopped || signal?.aborted) skipRest()
    await finish(prepared, 0)
  } else {
    for (let batch = nextBatch(); batch; batch = stopped || signal?.aborted ? null : nextBatch()) {
      await finish(await prepare(batch, 0), 0)
    }
    if (stopped || signal?.aborted) skipRest()
  }
  if (wait) {
    await settle()
  }
}
