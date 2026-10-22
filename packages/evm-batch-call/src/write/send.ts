import { isError, type TransactionReceipt, type TransactionRequest } from 'ethers'

import { WriteRpc, failureText, revertData, signedHash, type FeeData } from './rpc.js'
import type { ResolvedSigner } from './signer.js'

/**
 * 每个调用的状态：
 * - confirmed：已上链且执行成功
 * - reverted：已上链但执行失败（手续费已扣）
 * - failed：没有发出去（预估 revert、余额不足、节点拒绝、用户在钱包里拒绝等），不花手续费
 * - sent：已广播，没等确认（wait: false，或等待中途取消）。广播时超时 / 节点都连不上（交易可能已进交易池）也算 sent，error 里有说明
 * - pending：等到超时还没确认，之后仍可能上链（可用 hash 自行查询）
 * - skipped：没有执行：同一钱包前面的调用失败（continueOnError 为 false 时）、已取消，或同一笔批量交易里的其他调用失败
 * - simulated：dryRun 预估通过
 */
export type WriteStatus = 'confirmed' | 'reverted' | 'failed' | 'sent' | 'pending' | 'skipped' | 'simulated'

/** 发送参数（batchCall / batchTransfer / batchCollect 共用） */
export interface SendOptions {
  /** 等待上链确认。默认 true；false 时广播后即返回，status 为 'sent' */
  wait?: boolean
  /** 等待确认的最长时间（毫秒），超时的交易 status 为 'pending'。默认 180000 */
  timeout?: number
  /** 查询回执的间隔（毫秒），默认 2000。等待期间每 5 次查询重发一次原交易（防止被交易池丢弃，重发同一笔签名交易是安全的） */
  pollInterval?: number
  /** 同时处理的钱包数（同一钱包的交易总是按 nonce 顺序发），默认 8 */
  concurrency?: number
  /** gas 预估值的放大倍数，默认 1.2（预估值正好 21000 的普通转账不放大） */
  gasMultiplier?: number
  /** 固定 gasPrice（legacy 交易） */
  gasPrice?: bigint
  /** 固定 EIP-1559 费用，不传时按节点的 getFeeData（maxFee = 2 × baseFee + priorityFee） */
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  /** 只预估 gas、不发送，status 为 'simulated' 或 'failed'。注意：依赖前一笔交易结果的调用（如先 approve 再 transferFrom）预估会失败 */
  dryRun?: boolean
  /** 取消：不再发新交易，已发出的不再等待确认（status 为 'sent'） */
  signal?: AbortSignal
  /** 每个结果状态变化时回调（sent / confirmed / failed …），用于展示进度 */
  onUpdate?: (result: WriteResult) => void
}

/** 只在 Tron 上生效的发送参数 */
export interface TronSendOptions {
  /**
   * 合约调用的 fee_limit（sun，最多烧多少 TRX 换能量）。默认按模拟的能量 × 能量单价 × 1.5。
   * 能量不够时交易上链但执行失败（OUT_OF_ENERGY），已烧的 TRX 不退
   */
  feeLimit?: bigint
  /** 交易过期仍未上链时（按固化区块判断），换新的参考区块重发的次数。默认 2 */
  retries?: number
}

/** 每个调用的结果，都是字符串 / 数字 / null，可以直接 JSON.stringify */
export interface WriteResult {
  /** 在输入里的下标 */
  index: number
  /** 发送的钱包地址 */
  from: string
  /** 调用的目标地址（7702 批量交易里是每个子调用的目标） */
  to: string
  status: WriteStatus
  /** 交易哈希（7702 / Disperse 里同一笔交易的多个调用相同） */
  hash: string | null
  nonce: number | null
  gasLimit: string | null
  gasUsed: string | null
  /** 实际手续费（wei），gasUsed × effectiveGasPrice，不含 OP Stack 的 L1 数据费 */
  fee: string | null
  blockNumber: number | null
  error: string | null
  /** 智能账户模式（'4337' / sponsored '7702'）：UserOperation 哈希；此时 from 是账户地址，gasUsed / fee 是 UserOperation 的 */
  userOpHash?: string | null
  /** 智能账户 / EIP-5792 模式：同一批的调用是否在一笔里原子执行（5792 钱包不支持而退回逐笔发送时为 false） */
  atomic?: boolean
}

/** 交易层面的结果（一笔交易可能对应多个调用的结果） */
export interface TxOutcome {
  status: WriteStatus
  hash: string | null
  nonce: number | null
  gasLimit: bigint | null
  gasUsed: bigint | null
  fee: bigint | null
  blockNumber: number | null
  error: string | null
  /** 预估失败时的 revert 数据 */
  revertData: string | null
}

/** 要发送的一笔交易 */
export interface TxJob {
  signer: ResolvedSigner
  /** 生成交易内容；nonce 是这笔交易将使用的 nonce（7702 授权签名要用），交给钱包发送时为 null */
  build(nonce: number | null): Promise<Pick<TransactionRequest, 'to' | 'data' | 'value' | 'authorizationList'>>
  /** 指定 gasLimit 时不预估 */
  gasLimit?: bigint
  /** 发送前失败后同一钱包后面的交易是否继续（默认 false：后面的标记为 skipped）。已发出、之后上链 revert 的不影响后面的交易 */
  continueOnError?: boolean
  /** 状态变化时回调 */
  onUpdate?(outcome: TxOutcome): void
}

export interface TxFees {
  type: 0 | 2
  gasPrice?: bigint
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  /** 每单位 gas 最多花多少（预留余额用）：legacy 为 gasPrice，1559 为 maxFeePerGas */
  perGas: bigint
}

const FEE_TTL = 30_000

/** 交易费用参数：用户指定的优先，否则按节点的 getFeeData；结果缓存 30 秒，同一批交易共用 */
export class FeeSource {
  #cached: { at: number; fees: Promise<TxFees> } | null = null

  constructor(
    readonly rpc: WriteRpc,
    readonly options: Pick<SendOptions, 'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas'> = {},
  ) {}

  /** 固定为给定的费用，不再查节点（预留余额和实际发送要用同一个价格时） */
  static fixed(rpc: WriteRpc, fee: TxFees): FeeSource {
    return new FeeSource(rpc, fee.type === 0 ? { gasPrice: fee.gasPrice } : { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas })
  }

  get(): Promise<TxFees> {
    const { gasPrice, maxFeePerGas, maxPriorityFeePerGas } = this.options
    if (gasPrice !== undefined) {
      return Promise.resolve({ type: 0, gasPrice, perGas: gasPrice })
    }
    if (maxFeePerGas !== undefined && maxPriorityFeePerGas !== undefined) {
      return Promise.resolve({ type: 2, maxFeePerGas, maxPriorityFeePerGas, perGas: maxFeePerGas })
    }
    if (!this.#cached || Date.now() - this.#cached.at > FEE_TTL) {
      const fees = this.rpc.feeData().then((data) => toFees(data, maxFeePerGas, maxPriorityFeePerGas))
      fees.catch(() => {
        if (this.#cached?.fees === fees) {
          this.#cached = null
        }
      })
      this.#cached = { at: Date.now(), fees }
    }
    return this.#cached.fees
  }
}

function toFees(data: FeeData, maxFee?: bigint, priority?: bigint): TxFees {
  if (data.maxFeePerGas === null || data.maxPriorityFeePerGas === null) {
    if (data.gasPrice === null) {
      throw new Error('Unable to get gas price from the node')
    }
    return { type: 0, gasPrice: data.gasPrice, perGas: data.gasPrice }
  }
  const maxPriorityFeePerGas = priority ?? data.maxPriorityFeePerGas
  let maxFeePerGas = maxFee ?? data.maxFeePerGas
  if (maxFeePerGas < maxPriorityFeePerGas) {
    maxFeePerGas = maxPriorityFeePerGas
  }
  return { type: 2, maxFeePerGas, maxPriorityFeePerGas, perGas: maxFeePerGas }
}

/** gas 预估值乘以放大倍数（正好 21000 的普通转账不放大） */
export function applyGasMultiplier(gas: bigint, multiplier = 1.2): bigint {
  if (gas === 21_000n || multiplier <= 1) {
    return gas
  }
  return (gas * BigInt(Math.round(multiplier * 1000))) / 1000n
}

export function emptyOutcome(status: WriteStatus, error: string | null = null): TxOutcome {
  return { status, hash: null, nonce: null, gasLimit: null, gasUsed: null, fee: null, blockNumber: null, error, revertData: null }
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

/** 已发出、等待确认的交易 */
interface InFlight {
  job: TxJob
  outcome: TxOutcome
  hash: string
  /** 本地签名的原交易（等待期间重发用）；交给钱包发送的没有 */
  signed: string | null
  watching?: Promise<void>
}

/**
 * 发送一批交易：同一钱包按顺序、用本地维护的 nonce 连续发出（不等上一笔确认），不同钱包并发。
 * 预估失败且同一钱包还有未确认的交易时，先等它们确认再重新预估一次——后一笔依赖前一笔的结果时（先 approve 再调用）自动正确处理。
 * 返回值与 jobs 一一对应
 */
export async function sendJobs(rpc: WriteRpc, jobs: readonly TxJob[], options: SendOptions, fees = new FeeSource(rpc, options)): Promise<TxOutcome[]> {
  const outcomes = jobs.map(() => emptyOutcome('skipped'))
  const groups = new Map<string, number[]>()
  jobs.forEach((job, i) => {
    const key = job.signer.address.toLowerCase()
    const list = groups.get(key)
    if (list) {
      list.push(i)
    } else {
      groups.set(key, [i])
    }
  })
  await mapPool([...groups.values()], options.concurrency ?? 8, (indexes) => sendGroup(rpc, jobs, indexes, outcomes, options, fees))
  return outcomes
}

async function sendGroup(rpc: WriteRpc, jobs: readonly TxJob[], indexes: readonly number[], outcomes: TxOutcome[], options: SendOptions, fees: FeeSource): Promise<void> {
  const { signal, dryRun = false, wait = true } = options
  const first = jobs[indexes[0] as number] as TxJob
  const { signer, address, local } = first.signer
  const inFlight: InFlight[] = []
  const update = (job: TxJob, outcome: TxOutcome, patch: Partial<TxOutcome>) => {
    Object.assign(outcome, patch)
    try {
      job.onUpdate?.(outcome)
    } catch {
      // 调用方的进度回调出错不能打断发送（已经发出的交易还要继续跟踪）
    }
  }
  const watch = (item: InFlight): Promise<void> => (item.watching ??= confirm(rpc, item, options, update))
  /** 等同一钱包已发出的交易都确认（后面的调用依赖它们的结果时） */
  const settle = async () => {
    await Promise.all(inFlight.map(watch))
  }

  let nonce: number | null = null
  /** 上一笔带了 7702 授权：等它确认后再发下一笔 */
  let authorized: TxOutcome | null = null
  let stopped = false
  /** 浏览器钱包当前所在的链已核对过 */
  let chainChecked = false
  for (const i of indexes) {
    const job = jobs[i] as TxJob
    const outcome = outcomes[i] as TxOutcome
    if (authorized && !stopped && !signal?.aborted) {
      // 自己签的授权会让账户 nonce 再加一（授权无效时不加），而且委托状态变了：等上链后重新取 nonce、重新生成
      await settle()
      const done = authorized.status === 'confirmed' || authorized.status === 'reverted'
      authorized = null
      nonce = null
      if (!done) {
        // 授权交易还没上链：之后的 nonce 不确定（上链后账户 nonce 会加 2），后面的交易发了也上不了链
        stopped = true
        update(job, outcome, { status: 'skipped', error: 'skipped: the delegation transaction is not confirmed yet' })
        continue
      }
    }
    if (stopped || signal?.aborted) {
      update(job, outcome, { status: 'skipped', error: signal?.aborted ? 'aborted' : 'skipped: a previous call from this wallet failed' })
      continue
    }
    const fail = (error: string, extra: Partial<TxOutcome> = {}) => {
      update(job, outcome, { status: 'failed', error, ...extra })
      if (!job.continueOnError) {
        stopped = true
      }
    }
    try {
      if (local && nonce === null) {
        nonce = await rpc.nonce(address)
      }
      let tx = await job.build(local ? nonce : null)
      let gasLimit = job.gasLimit
      if (gasLimit === undefined) {
        const estimate = () => rpc.estimateGas({ ...tx, from: address })
        try {
          gasLimit = await estimate()
        } catch (err) {
          if (!inFlight.some((item) => item.outcome.status === 'sent')) {
            throw err
          }
          // 可能依赖前面还没确认的交易：等它们确认后重新生成（7702 授权的 nonce 不变）、重新预估
          await settle()
          if (signal?.aborted) {
            update(job, outcome, { status: 'skipped', error: 'aborted' })
            continue
          }
          tx = await job.build(local ? nonce : null)
          gasLimit = await estimate()
        }
        gasLimit = applyGasMultiplier(gasLimit, options.gasMultiplier)
      }
      if (dryRun) {
        update(job, outcome, { status: 'simulated', gasLimit })
        continue
      }
      if (!local) {
        if (!chainChecked) {
          // 浏览器钱包在它当前所在的链上签名发送：先确认和 Provider 是同一条链，否则会在别的链上真的转账
          const walletChain = await walletChainId(signer)
          if (walletChain !== null && walletChain !== rpc.chainId) {
            throw new Error(`The wallet is on chain ${walletChain}, expected ${rpc.chainId}; switch the network in the wallet first`)
          }
          chainChecked = true
        }
        let hash: string
        let note: string | null = null
        try {
          // 带上 chainId：钱包（如 MetaMask）会拒绝与当前链不一致的交易
          hash = (await (signer.sendTransaction as NonNullable<typeof signer.sendTransaction>)({ ...tx, gasLimit, chainId: rpc.chainId })).hash
        } catch (err) {
          // ethers 在钱包广播之后还会查一次交易，查询失败（如用户切换了网络）时错误里带着已经发出的哈希：不能报 failed
          const sentHash = (err as { info?: { sendTransactionHash?: unknown } } | null)?.info?.sendTransactionHash
          if (typeof sentHash !== 'string') throw err
          hash = sentHash
          note = `sent, but the wallet reported: ${failureText(err)}`
        }
        update(job, outcome, { status: 'sent', hash, gasLimit, error: note })
        inFlight.push({ job, outcome, hash, signed: null })
      } else {
        const fee = await fees.get()
        /** 广播结果不确定时的说明（超时、节点都连不上等）：交易可能已经进了交易池，不能报 failed（用户会重试、重复付款），按已发出继续跟踪 */
        let uncertain: string | null = null
        const broadcast = async (raw: string): Promise<'accepted' | 'nonce-used'> => {
          const result = await rpc.broadcast(raw)
          if (typeof result === 'object') {
            uncertain = result.uncertain
            return 'accepted'
          }
          return result
        }
        const sign = (n: number, request: typeof tx) =>
          (signer.signTransaction as NonNullable<typeof signer.signTransaction>)({
            ...request,
            ...txFeeFields(fee, request.authorizationList ? 4 : undefined),
            chainId: rpc.chainId,
            nonce: n,
            gasLimit,
          })
        let used = nonce as number
        let signed = await sign(used, tx)
        let hash = signedHash(signed)
        if ((await broadcast(signed)) === 'nonce-used') {
          // nonce 被用掉了：可能就是这笔已经上链（节点超时后换节点重发、或重复执行同一批），也可能被钱包在别处发的交易占用。
          // 多查几次回执（节点可能落后），确定这笔没上链才换 nonce 重发；查询出错时不确定，按已发出跟踪，绝不重发
          const state = await minedState(rpc, hash, options)
          if (state === 'unknown') {
            uncertain = 'nonce already used; unable to confirm whether this transaction was mined'
          } else if (state === 'absent') {
            rpc.useNonce(address, used)
            used = await rpc.nonce(address)
            tx = await job.build(used)
            signed = await sign(used, tx)
            hash = signedHash(signed)
            if ((await broadcast(signed)) === 'nonce-used') {
              rpc.useNonce(address, used)
              nonce = null // 下一笔重新取 nonce
              fail('nonce already used by another transaction')
              continue
            }
          }
        }
        nonce = used + 1
        rpc.useNonce(address, used)
        authorized = tx.authorizationList?.length ? outcome : null
        update(job, outcome, { status: 'sent', hash, nonce: used, gasLimit, error: uncertain })
        inFlight.push({ job, outcome, hash, signed })
      }
      const item = inFlight[inFlight.length - 1] as InFlight
      if (wait) {
        void watch(item)
      }
    } catch (err) {
      if (isError(err, 'ACTION_REJECTED')) {
        fail('rejected by user')
        continue
      }
      fail(failureText(err), { revertData: revertData(err) })
    }
  }
  if (wait) {
    await settle()
  }
}

/** 浏览器钱包当前所在的链；问不到时为 null（这时靠交易里的 chainId 让钱包校验） */
async function walletChainId(signer: object): Promise<number | null> {
  const provider = (signer as { provider?: { send?: (method: string, params: unknown[]) => Promise<unknown> } | null }).provider
  if (typeof provider?.send !== 'function') return null
  try {
    return Number(await provider.send('eth_chainId', []))
  } catch {
    return null
  }
}

/** 这笔交易有没有上链：多查几次回执（节点可能落后）。查到为 'mined'；每次都成功查询但都没有为 'absent'；有查询出错为 'unknown' */
async function minedState(rpc: WriteRpc, hash: string, options: SendOptions): Promise<'mined' | 'absent' | 'unknown'> {
  let errors = 0
  for (let i = 0; i < 5; i++) {
    if (i > 0) await sleep(options.pollInterval ?? 2_000, options.signal)
    // 已取消：不再发新交易，也就不需要判断是否换 nonce 重发；没查够几轮也不能断定没上链
    if (options.signal?.aborted) return 'unknown'
    try {
      if (await rpc.receipt(hash)) return 'mined'
    } catch {
      errors++
    }
  }
  return errors ? 'unknown' : 'absent'
}

/** 7702 授权交易（type 4）也必须用 1559 费用字段 */
function txFeeFields(fee: TxFees, type?: 4): Pick<TransactionRequest, 'type' | 'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas'> {
  if (type === 4) {
    return fee.type === 2
      ? { type: 4, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
      : { type: 4, maxFeePerGas: fee.gasPrice, maxPriorityFeePerGas: fee.gasPrice }
  }
  return fee.type === 2 ? { type: 2, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas } : { type: 0, gasPrice: fee.gasPrice }
}

/** 轮询回执直到确认 / 超时 / 取消；等待期间定期重发原交易 */
async function confirm(rpc: WriteRpc, item: InFlight, options: SendOptions, update: (job: TxJob, outcome: TxOutcome, patch: Partial<TxOutcome>) => void): Promise<void> {
  const { timeout = 180_000, pollInterval = 2_000, signal } = options
  const deadline = Date.now() + timeout
  let polls = 0
  while (!signal?.aborted) {
    let receipt: TransactionReceipt | null = null
    try {
      receipt = await rpc.receipt(item.hash)
    } catch {
      // 节点暂时出错：下次再查
    }
    if (receipt) {
      update(item.job, item.outcome, {
        status: receipt.status === 1 ? 'confirmed' : 'reverted',
        gasUsed: receipt.gasUsed,
        fee: receipt.fee,
        blockNumber: receipt.blockNumber,
        error: receipt.status === 1 ? null : 'execution reverted',
      })
      return
    }
    if (Date.now() >= deadline) {
      const note = `not confirmed within ${timeout}ms`
      update(item.job, item.outcome, { status: 'pending', error: item.outcome.error ? `${item.outcome.error}; ${note}` : note })
      return
    }
    if (item.signed && ++polls % 5 === 0) {
      void rpc.broadcast(item.signed).catch(() => {})
    }
    await sleep(Math.min(pollInterval, Math.max(0, deadline - Date.now())), signal)
  }
}

/** 交易结果转成调用结果（字符串 / 数字，可 JSON 序列化） */
export function toWriteResult(index: number, from: string, to: string, outcome: TxOutcome): WriteResult {
  return {
    index,
    from,
    to,
    status: outcome.status,
    hash: outcome.hash,
    nonce: outcome.nonce,
    gasLimit: outcome.gasLimit?.toString() ?? null,
    gasUsed: outcome.gasUsed?.toString() ?? null,
    fee: outcome.fee?.toString() ?? null,
    blockNumber: outcome.blockNumber,
    error: outcome.error,
  }
}
