import { base58, base64 } from '@scure/base'

import type { SolanaClient } from '../client.js'
import type { RpcSource } from '../source.js'
import { mapPool } from '../util.js'
import { Chain, isRecentMessage, remember, type Blockhash } from './chain.js'
import { errorText, isBudgetExceeded, isRejection, transactionErrorText } from './errors.js'
import { MAX_COMPUTE_UNITS } from './instructions.js'
import { budgetInstructions, packUnits } from './pack.js'
import type { LocalSigner, ResolvedSigner, SignerInput, WalletSigner } from './signer.js'
import { MAX_ACCOUNT_LOCKS, PACKET_DATA_SIZE, compileMessage, messageBlockhash, sameBytes, serializeTransaction, type CompiledMessage, type Instruction } from './transaction.js'
import { Tracker } from './tracker.js'

// 拆出去的部分仍从这里导出（包内其他模块和外部引用的路径不变）
export { priorityFeeFor } from './chain.js'
export { transactionErrorText } from './errors.js'

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
  /**
   * 发送交易用的节点（如专门的发送服务、质押连接的节点）：URL、URL 数组、web3.js Connection 或自定义传输。
   * 不传时用 client 的节点；模拟、查确认状态仍用 client
   */
  sendRpc?: RpcSource | readonly RpcSource[]
  /**
   * 广播给哪些节点（sendRpc，不传时 client 的节点）：
   * - 'first'（默认）：按故障切换顺序只发给第一个可用的节点
   * - 'all'：同时发给所有节点，任一接受即可（多个节点各自转发给出块节点，拥堵时更容易上链；等待确认期间的重发也会发给所有节点）。
   * 默认 'first'：公共节点对 sendTransaction 限频严，每两次轮询就重发一次时，全部广播会成倍增加请求；官方节点在浏览器里总是 403，发给它只是白费请求
   */
  broadcast?: 'first' | 'all'
  /**
   * 计算单元上限 = 模拟消耗 × ratio + extra（默认 ratio 1.1、extra 1000），不超过 140 万。
   * 消耗会随链上状态变化的调用（如兑换穿过的 tick 数不同）可以调大，避免上链时超出上限失败；固定手续费的调用（扫空 SOL）不受影响
   */
  computeUnitMargin?: { ratio?: number; extra?: number }
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

/** 每个签名的基础手续费（lamports） */
export const LAMPORTS_PER_SIGNATURE = 5000n

/** 交易手续费：签名数 × 5000 + 优先费用（单价 × 计算单元上限，向上取整） */
export function transactionFee(signatures: number, computeUnits: number, price: bigint): bigint {
  return LAMPORTS_PER_SIGNATURE * BigInt(signatures) + (price * BigInt(computeUnits) + 999_999n) / 1_000_000n
}

// ---- 发送 ----

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

/** 免租下限：0 字节系统账户（手续费支付者付完手续费后不能掉到它和 0 之间） */
const RENT_EXEMPT_MINIMUM = 890_880n

/**
 * 取舍：以前有优先费用时总是按真实的上限和单价再模拟一次，它挡住的是两种情况：
 * - 付款方付不起优先费用：这里用模拟后余额 + 当前余额判断，付不起（或拿不到余额）时照旧再模拟一次，这层保护没有丢；
 * - 收紧后的计算单元上限（消耗 × 1.1 + 1000）不够用：第二次模拟和第一次只隔几百毫秒、基于几乎同一个状态，
 *   消耗与第一次相同，上限按定义高于它，几乎不可能在这里失败；真正的风险是发送时状态已经变了（如兑换路径穿过更多 tick），
 *   第二次模拟同样看不到。所以默认跳过，消耗会波动的调用用 SendOptions.computeUnitMargin 调大余量
 *
 * 第一次模拟（计算单元上限取最大、单价 0，节点已扣基础手续费）后，付款方能否再付得起优先费用（单价 × 真实的上限）：
 * 模拟后的余额和当前余额（手续费在执行前从当前余额里扣）各减去基础手续费 / 优先费用后都不低于免租下限才算付得起；
 * 拿不到余额时按付不起处理（再完整模拟一次，同以前）
 */
function canAffordPriority(signatures: number, limit: number, price: bigint, before: bigint | null, sim: { accounts?: Array<{ lamports: number | string } | null> | null }): boolean {
  const after = sim.accounts?.[0]?.lamports
  if (before === null || after === undefined || after === null) {
    return false
  }
  const priority = transactionFee(0, limit, price)
  const base = LAMPORTS_PER_SIGNATURE * BigInt(signatures)
  return BigInt(after) - priority >= RENT_EXEMPT_MINIMUM && before - base - priority >= RENT_EXEMPT_MINIMUM
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

async function sendGroup(chain: Chain, tracker: Tracker, units: readonly Unit[], options: SendOptions, batchSize: number): Promise<void> {
  const { signal, dryRun = false, wait = true, retries = 2 } = options
  const marginRatio = Math.max(1, options.computeUnitMargin?.ratio ?? 1.1)
  const marginExtra = Math.max(0, Math.ceil(options.computeUnitMargin?.extra ?? 1000))
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
        // 有优先费用时同时拿付款方模拟后的余额和当前余额（和模拟合并在同一个批量请求里），判断付不付得起优先费用，付得起就不再模拟第二次
        const affordCheck = !fixed && price > 0n
        const [sim, payerBefore] = await Promise.all([
          chain.simulate(simMessage, minSlot, affordCheck ? [payer.address] : undefined),
          affordCheck ? chain.balance(payer.address, minSlot) : null,
        ])
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
        const limit = fixed?.computeUnits ?? (consumed ? Math.min(MAX_COMPUTE_UNITS, Math.ceil(consumed * marginRatio) + marginExtra) : MAX_COMPUTE_UNITS)
        if (affordCheck && !canAffordPriority(simMessage.signers.length, limit, price, payerBefore, sim)) {
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
      while (!p.fixed && isRecentMessage(message.bytes)) {
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

  // 打包（packUnits：相邻的调用放进同一笔，不超过交易大小 / 账户数上限；固定手续费的调用单独一笔），按顺序逐笔取出
  const packs = packUnits(payer.address, units, { batchSize, alone: (i) => Boolean((units[i] as Unit).fixed) })
  let packIndex = 0
  /** 下一个还没取出的调用下标 */
  let next = 0
  const nextBatch = (): Unit[] | null => {
    while (packIndex < packs.length) {
      const pack = packs[packIndex++] as (typeof packs)[number]
      next = (pack.indices[pack.indices.length - 1] as number) + 1
      if (pack.tooLarge) {
        const first = units[pack.indices[0] as number] as Unit
        update(first, { status: 'failed', error: `transaction too large (over ${PACKET_DATA_SIZE} bytes or ${MAX_ACCOUNT_LOCKS} accounts)` })
        if (!first.continueOnError) stopped = true
        if (stopped) return null
        continue
      }
      return pack.indices.map((i) => units[i] as Unit)
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
