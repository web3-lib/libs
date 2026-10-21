import { blake2b } from '@noble/hashes/blake2.js'
import { base58, base64 } from '@scure/base'

import { SUI_COIN_TYPE, normalizeSuiAddress } from '../address.js'
import type { SuiClient } from '../client.js'
import type { CallOptions } from '../grpc.js'
import { isNodeFault } from '../grpc.js'
import { batchGetObjects, executeTransaction, getBalance, getEpoch, getServiceInfo, getTransaction, listOwnedObjects, simulateTransaction, type ExecutionResult, type GasUsed } from '../services.js'
import { decodeKindInputs, encodeTransactionData, kindInputs, type Expiration, type ObjectRef, type ProgrammableTransaction } from './bcs.js'
import type { ResolvedSigner } from './signer.js'

/**
 * 每笔交易（调用）的状态：
 * - confirmed：已执行成功
 * - reverted：已上链但执行失败（Move abort 等，gas 已扣）
 * - failed：没有发出（模拟失败、余额不够付 gas、钱包里拒绝等），不花 gas
 * - sent：已提交，但节点都连不上、不能确认结果（可以用 digest 查）
 * - skipped：没有执行（同一付款钱包前面的交易失败、已取消）
 * - simulated：dryRun 模拟通过
 */
export type WriteStatus = 'confirmed' | 'reverted' | 'failed' | 'sent' | 'skipped' | 'simulated'

export interface SendOptions {
  /** gas 价格（MIST），默认参考价格（当前 epoch 的 reference gas price） */
  gasPrice?: bigint
  /** 固定 gas 上限（MIST），不模拟估算 */
  gasBudget?: bigint
  /** 模拟消耗 × 这个倍数作为 gas 上限，默认 1.2 */
  gasMultiplier?: number
  /** 只模拟、不发送，status 为 'simulated' 或 'failed' */
  dryRun?: boolean
  /** 同时处理的付款钱包数（同一付款钱包的交易依次执行），默认 8 */
  concurrency?: number
  signal?: AbortSignal
  /** 每个结果状态变化时回调 */
  onUpdate?: (result: WriteResult) => void
}

/** 每个调用的结果，可以直接 JSON.stringify */
export interface WriteResult {
  index: number
  /** 发送者地址 */
  from: string
  status: WriteStatus
  /** 交易摘要（同一笔交易里的多个调用相同） */
  digest: string | null
  /** 实际花的 gas（MIST）：计算 + 存储 − 存储返还，可能为负（返还多于花费） */
  fee: string | null
  checkpoint: number | null
  error: string | null
}

/** 交易层面的结果 */
export interface TxOutcome {
  status: WriteStatus
  digest: string | null
  fee: bigint | null
  checkpoint: number | null
  error: string | null
  /** dryRun 模拟通过时：gas 明细、gas 价格、发送时会用的 gas 上限 */
  simulation?: { gasUsed: GasUsed | null; gasPrice: bigint; gasBudget: bigint }
}

export const emptyOutcome = (status: WriteStatus, error: string | null = null): TxOutcome => ({ status, digest: null, fee: null, checkpoint: null, error })

export function toWriteResult(index: number, from: string, o: TxOutcome): WriteResult {
  return { index, from, status: o.status, digest: o.digest, fee: o.fee === null ? null : o.fee.toString(), checkpoint: o.checkpoint, error: o.error }
}

/** 一笔要发的交易：build 在发出前才调用（拿到最新的对象版本） */
export interface TxJob {
  sender: ResolvedSigner
  /** 付 gas 的钱包（赞助交易）；不传时发送者自己付 */
  sponsor?: ResolvedSigner
  build(ctx: BuildContext): Promise<ProgrammableTransaction | Uint8Array | BuiltTransaction>
  /** 失败后同一付款钱包后面的交易是否继续，默认 false */
  continueOnError?: boolean
  onUpdate(outcome: TxOutcome): void
}

/** build 的结果：交易内容，以及它从 gas 币里拆走多少 SUI */
export interface BuiltTransaction {
  kind: ProgrammableTransaction | Uint8Array
  /** 交易从 gas 币里拆走的 SUI：gas 上限要从 gas 币剩下的部分里出（Sui 先从 gas 币里预留 gas 上限） */
  gasSpend?: bigint
}

/** 交易的命令是否用到了 gas 币（这时必须用 SUI Coin 付 gas，不能改用地址余额） */
function usesGasCoin(kind: ProgrammableTransaction): boolean {
  const walk = (v: unknown): boolean =>
    Array.isArray(v) ? v.some(walk) : typeof v === 'object' && v !== null && !(v instanceof Uint8Array) ? (v as { kind?: unknown }).kind === 'gas' || Object.values(v).some(walk) : false
  return walk(kind.commands)
}

/** 一笔交易最多几次地址余额取款（Sui 协议的上限，用地址余额付 gas 也算一次） */
export const MAX_WITHDRAWALS = 10
/** 链信息（epoch、参考 gas 价格）最多用多久再重新读：一批交易可能跨 epoch */
const CHAIN_INFO_TTL = 10 * 60_000

/** 构建交易时可用的：最新的对象引用（含本批前面交易改过的） */
export interface BuildContext {
  /**
   * 发送者拥有的某类 Coin（按余额从大到小），版本按本批的缓存更新。
   * 最多看 MAX_COIN_SCAN 个（Coin 特别多的钱包不全部翻页）；给了 enough 时凑够就不再翻页
   */
  coins(owner: string, coinType: string, enough?: bigint): Promise<Array<ObjectRef & { balance: bigint }>>
  /** 发送者在地址余额里的部分（不在 Coin 对象里的余额） */
  addressBalance(owner: string, coinType: string): Promise<bigint>
  /** 读取参数（signal；本批执行过交易后带 minCheckpoint，读到执行后的状态） */
  readOptions(): CallOptions
}

/** 一批交易共用：对象的最新版本（执行后从 effects 更新，下一笔交易不用等节点同步） */
export class ObjectCache {
  readonly #refs = new Map<string, { version: bigint; digest: string } | null>()

  apply(result: ExecutionResult): void {
    for (const c of result.changedObjects) {
      const id = normalizeSuiAddress(c.objectId)
      this.#refs.set(id, c.version !== null && c.digest ? { version: c.version, digest: c.digest } : null)
    }
  }

  /** 用缓存里更新的版本替换；被删除 / 合并掉的返回 null。stale 为 true 时缓存的版本更新：读到的其他字段（如余额）是旧的 */
  fresh<T extends ObjectRef>(ref: T): { ref: T; stale: boolean } | null {
    const id = normalizeSuiAddress(ref.objectId)
    if (!this.#refs.has(id)) return { ref, stale: false }
    const cached = this.#refs.get(id)
    if (!cached) return null
    return cached.version > ref.version ? { ref: { ...ref, version: cached.version, digest: cached.digest }, stale: true } : { ref, stale: false }
  }
}

const MAX_GAS_COINS = 255
/** 选 Coin 时最多看几个（每页 1000） */
const MAX_COIN_SCAN = 3000
/** 执行后最多等多久进 checkpoint（毫秒） */
const CHECKPOINT_WAIT = 15_000
/**
 * 模拟时用的 gas 上限（Sui 先从 gas 币里预留 gas 上限，上限太大会让交易拆不出 SUI）：
 * 先用 0.2 SUI；gas 不够时用 50 SUI 再试；SUI 不够拆时用 0.02 SUI 再试。都不超过可用的部分
 */
const SIMULATION_BUDGET = 200_000_000n
const LARGE_BUDGET = 50_000_000_000n
const SMALL_BUDGET = 20_000_000n
/** gas 上限的下限（0.002 SUI），避免估算太紧 */
const MIN_BUDGET = 2_000_000n
/** gas 币扣掉交易拆走的部分后不到这么多（0.01 SUI）、地址余额更多时，改用地址余额付 gas */
const DUST_GAS = 10_000_000n

/** Sui 交易摘要：blake2b-256("TransactionData::" || 交易字节)，base58 */
export function transactionDigest(bytes: Uint8Array): string {
  const prefix = new TextEncoder().encode('TransactionData::')
  const data = new Uint8Array(prefix.length + bytes.length)
  data.set(prefix)
  data.set(bytes, prefix.length)
  return base58.encode(blake2b(data, { dkLen: 32 }))
}

const feeOf = (r: ExecutionResult) => (r.gasUsed ? r.gasUsed.computationCost + r.gasUsed.storageCost - r.gasUsed.storageRebate : null)

async function mapPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++] as T)
    }),
  )
}

/** 构建交易用的读取：Coin 按余额从大到小，版本按缓存更新；read 给出每次读取的参数（如 minCheckpoint） */
export function buildContext(client: SuiClient, cache: ObjectCache | null, read: () => CallOptions): BuildContext {
  return {
    async coins(owner, coinType, enough) {
      const out: Array<ObjectRef & { balance: bigint }> = []
      // 本批前面的交易改过、节点还没反映出来的 Coin（节点不报 checkpoint 时 minCheckpoint 不起作用）：余额要重新读
      const stale: Array<ObjectRef & { balance: bigint }> = []
      let sum = 0n
      let token: Uint8Array | null = null
      do {
        const page = await listOwnedObjects(client.transport, normalizeSuiAddress(owner), ['object_id', 'version', 'digest', 'balance'], { type: `0x2::coin::Coin<${coinType}>`, pageSize: 1000, pageToken: token }, read())
        for (const o of page.objects) {
          const ref = o.version === null || !o.digest ? null : { objectId: o.objectId, version: o.version, digest: o.digest, balance: o.balance ?? 0n }
          const c = !ref ? null : cache ? cache.fresh(ref) : { ref, stale: false }
          if (!c) continue
          if (c.stale) stale.push(c.ref)
          else {
            out.push(c.ref)
            sum += c.ref.balance
          }
        }
        token = page.nextPageToken
      } while (token && out.length + stale.length < MAX_COIN_SCAN && (enough === undefined || sum < enough))
      for (let i = 0; i < stale.length; i += 50) {
        const chunk = stale.slice(i, i + 50)
        const objects = await batchGetObjects(client.transport, chunk.map((c) => c.objectId), ['object_id', 'version', 'digest', 'balance'], read())
        objects.forEach((o, k) => {
          const ref = chunk[k] as ObjectRef & { balance: bigint }
          // 读到的就是缓存里的版本才用（节点更旧时不知道余额，跳过这个 Coin）
          if (o?.version === ref.version && o.digest && o.balance !== null) {
            out.push({ ...ref, digest: o.digest, balance: o.balance })
          }
        })
      }
      return out.sort((a, b) => (a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : 0))
    },
    async addressBalance(owner, coinType) {
      return (await getBalance(client.transport, normalizeSuiAddress(owner), coinType, read())).balance.addressBalance
    },
    readOptions: read,
  }
}

/**
 * 发一批交易：按付 gas 的钱包分组，组内依次执行（gas 币的版本每笔都会变），不同组并发。
 * 结果通过 job.onUpdate 回调，返回各 job 的最终结果
 */
export async function sendJobs(client: SuiClient, jobs: readonly TxJob[], options: SendOptions = {}): Promise<TxOutcome[]> {
  const outcomes: TxOutcome[] = jobs.map(() => emptyOutcome('skipped'))
  const cache = new ObjectCache()
  const update = (i: number, o: TxOutcome) => {
    outcomes[i] = o
    try {
      ;(jobs[i] as TxJob).onUpdate(o)
    } catch {
      // 调用方的回调出错不打断发送
    }
  }
  // 链信息（地址余额付 gas 时要用）和 gas 价格，整批共用
  let chainInfo: Promise<{ epoch: bigint; price: bigint; chainId: string }> | null = null
  let chainInfoAt = 0
  const chain = () => {
    if (chainInfo && Date.now() - chainInfoAt > CHAIN_INFO_TTL) chainInfo = null
    if (!chainInfo) chainInfoAt = Date.now()
    return (chainInfo ??= Promise.all([getEpoch(client.transport, { signal: options.signal }), getServiceInfo(client.transport, { signal: options.signal })]).then(
      ([e, s]) => {
        if (!s.chainId) throw new Error('The node did not report its chain id')
        return { epoch: e.epoch, price: options.gasPrice ?? e.referenceGasPrice, chainId: s.chainId }
      },
      (err: unknown) => {
        // 暂时的错误不缓存：下一笔交易再查
        chainInfo = null
        throw err
      },
    ))
  }
  // 本批已执行的交易所在的最高 checkpoint：之后的读取要求节点至少到这里（不读到执行前的余额）
  let seen = 0
  const read = () => ({ signal: options.signal, ...(seen ? { minCheckpoint: seen } : {}) })

  const ctx = buildContext(client, cache, read)

  // 分组：共用发送者或付款钱包的交易（会用到同一批对象）放进同一组，组内依次执行
  const parent = new Map<string, string>()
  const root = (a: string): string => {
    const p = parent.get(a) ?? a
    if (p === a) return a
    const r = root(p)
    parent.set(a, r)
    return r
  }
  for (const job of jobs) parent.set(root(job.sender.address), root((job.sponsor ?? job.sender).address))
  const groups = new Map<string, number[]>()
  jobs.forEach((job, i) => {
    const key = root(job.sender.address)
    groups.set(key, [...(groups.get(key) ?? []), i])
  })

  await mapPool([...groups.values()], Math.max(1, options.concurrency ?? 8), async (indexes) => {
    let blocked = false
    for (const i of indexes) {
      const job = jobs[i] as TxJob
      if (options.signal?.aborted) {
        update(i, emptyOutcome('skipped', 'aborted'))
        continue
      }
      if (blocked) {
        update(i, emptyOutcome('skipped', 'skipped: a previous transaction of the same wallet failed'))
        continue
      }
      const outcome = await sendOne(client, job, ctx, cache, chain, options).catch((err: unknown): TxOutcome => emptyOutcome('failed', err instanceof Error ? err.message : String(err)))
      if (outcome.checkpoint !== null && outcome.checkpoint > seen) seen = outcome.checkpoint
      update(i, outcome)
      // sent：不知道是否执行了（对象版本不确定），后面的交易不能再用这些对象，无论 continueOnError
      if (outcome.status === 'sent' || ((outcome.status === 'failed' || outcome.status === 'reverted') && !job.continueOnError)) blocked = true
    }
  })
  return outcomes
}

async function sendOne(
  client: SuiClient,
  job: TxJob,
  ctx: BuildContext,
  cache: ObjectCache,
  chain: () => Promise<{ epoch: bigint; price: bigint; chainId: string }>,
  options: SendOptions,
): Promise<TxOutcome> {
  options.signal?.throwIfAborted()
  const built = await job.build(ctx)
  const { kind, gasSpend = 0n } = built instanceof Uint8Array || !('kind' in built) ? { kind: built } : built
  const payer = job.sponsor ?? job.sender
  const sponsored = payer.address !== job.sender.address
  const { epoch, price, chainId } = await chain()
  const inputs = kind instanceof Uint8Array ? decodeKindInputs(kind) : kindInputs(kind)
  const excluded = new Set(inputs.owned.map(normalizeSuiAddress))
  // 交易从付款钱包的地址余额里取走的 SUI（用地址余额付 gas 时要留出来）
  const withdrawn = inputs.withdrawals
    .filter((w) => w.coinType === SUI_COIN_TYPE && (w.from === 'sponsor' || (w.from === 'sender' && !sponsored)))
    .reduce((sum, w) => sum + w.amount, 0n)

  // gas：付款钱包的 SUI Coin（交易里用到的除外）；没有 Coin（或只剩零头、地址余额更多）时用地址余额付（payment 为空、ValidDuring 过期规则）
  let coins = (await ctx.coins(payer.address, SUI_COIN_TYPE)).filter((c) => !excluded.has(normalizeSuiAddress(c.objectId))).slice(0, MAX_GAS_COINS)
  let available = coins.reduce((s, c) => s + c.balance, 0n) - gasSpend
  let expiration: Expiration = { kind: 'none' }
  // 用到 gas 币的交易（如把 gas 币整个转走）只能用 Coin 付 gas；解码的字节看不到命令，按用到了算
  const needsGasCoin = kind instanceof Uint8Array || usesGasCoin(kind)
  if (!coins.length || (gasSpend === 0n && !needsGasCoin && available < DUST_GAS)) {
    const fromBalance = (await ctx.addressBalance(payer.address, SUI_COIN_TYPE)) - withdrawn
    if (!coins.length || fromBalance > available) {
      coins = []
      available = fromBalance
      expiration = { kind: 'validDuring', minEpoch: epoch, maxEpoch: epoch + 1n, chain: chainId, nonce: crypto.getRandomValues(new Uint32Array(1))[0] as number }
    }
  }
  if (available <= 0n) {
    return emptyOutcome('failed', `${payer.address} does not have enough SUI to pay gas`)
  }
  const withdrawals = inputs.withdrawals.length + (expiration.kind === 'validDuring' ? 1 : 0)
  if (withdrawals > MAX_WITHDRAWALS) {
    return emptyOutcome('failed', `The transaction withdraws from address balances ${withdrawals} times (gas paid from the address balance counts once); Sui allows at most ${MAX_WITHDRAWALS}`)
  }
  const cap = (b: bigint) => (b < available ? b : available)
  const encode = (budget: bigint) =>
    encodeTransactionData({ kind, sender: job.sender.address, gas: { payment: coins.map(({ balance: _, ...ref }) => ref), owner: payer.address, price, budget }, expiration })

  // gas 上限：模拟一次按实际消耗 × 倍数
  let budget = options.gasBudget
  if (budget === undefined || options.dryRun) {
    let sim: ExecutionResult | null = null
    const tried = new Set<bigint>()
    let simBudget = budget ?? cap(SIMULATION_BUDGET)
    for (;;) {
      tried.add(simBudget)
      try {
        sim = await simulateTransaction(client.transport, encode(simBudget), { signal: options.signal })
      } catch (err) {
        return emptyOutcome('failed', `simulation failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (sim.success || budget !== undefined) break
      // gas 不够：换大的上限；拆不出 SUI（预留的 gas 上限占了 gas 币）：换小的上限
      const next = /InsufficientGas/i.test(sim.error ?? '') ? cap(LARGE_BUDGET) : /InsufficientCoinBalance|InsufficientFunds/i.test(sim.error ?? '') ? cap(SMALL_BUDGET) : null
      if (next === null || tried.has(next)) break
      simBudget = next
    }
    if (!sim.success) return emptyOutcome('failed', `simulation failed: ${sim.error}`)
    const used = (sim.gasUsed?.computationCost ?? 0n) + (sim.gasUsed?.storageCost ?? 0n)
    const multiplier = BigInt(Math.round((options.gasMultiplier ?? 1.2) * 1000))
    let estimated = (used * multiplier + 999n) / 1000n
    if (estimated < MIN_BUDGET) estimated = MIN_BUDGET
    estimated = cap(estimated)
    if (options.dryRun) return { ...emptyOutcome('simulated'), fee: feeOf(sim), simulation: { gasUsed: sim.gasUsed, gasPrice: price, gasBudget: budget ?? estimated } }
    budget = estimated
  }
  let bytes = encode(budget)

  // 签名：发送者；赞助交易时付款钱包也签
  options.signal?.throwIfAborted()
  let senderSig: { signature: string; bytes?: Uint8Array }
  try {
    senderSig = await job.sender.sign(bytes, client.network)
  } catch (err) {
    return emptyOutcome('failed', walletError(err))
  }
  if (senderSig.bytes && !sameBytes(senderSig.bytes, bytes)) {
    // 钱包改了交易（如调整 gas）：赞助交易里付款钱包的签名就对不上了
    if (sponsored) return emptyOutcome('failed', 'The wallet modified the sponsored transaction')
    bytes = senderSig.bytes
  }
  const signatures = [base64.decode(senderSig.signature)]
  if (sponsored) {
    try {
      const sponsorSig = await payer.sign(bytes, client.network)
      if (sponsorSig.bytes && !sameBytes(sponsorSig.bytes, bytes)) return emptyOutcome('failed', 'The sponsor wallet modified the transaction')
      signatures.push(base64.decode(sponsorSig.signature))
    } catch (err) {
      return emptyOutcome('failed', walletError(err))
    }
  }
  const digest = transactionDigest(bytes)
  // 钱包确认期间取消了：不再发送
  if (options.signal?.aborted) return emptyOutcome('skipped', 'aborted')

  // 执行：节点问题时（FallbackTransport 已经换过节点）按摘要查一下是否已经执行；同一笔签名交易可以安全地再提交
  let result: ExecutionResult | null = null
  // 前面的尝试可能已经送到了节点（超时、连接断开）：之后的错误不能说明交易没有执行
  let maybeSent = false
  for (let attempt = 0; attempt < 3 && !result; attempt++) {
    try {
      result = await executeTransaction(client.transport, bytes, signatures, { signal: options.signal })
    } catch (err) {
      if (options.signal?.aborted) return { ...emptyOutcome('sent', 'aborted while waiting for the result'), digest }
      const message = err instanceof Error ? err.message : String(err)
      if (!isNodeFault(err)) {
        if (!maybeSent) return { ...emptyOutcome('failed', message), digest }
        result = await getTransaction(client.transport, digest, { signal: options.signal }).catch(() => null)
        if (!result) return { ...emptyOutcome('sent', `could not confirm the result: ${message}`), digest }
        break
      }
      maybeSent = true
      result = await getTransaction(client.transport, digest, { signal: options.signal }).catch(() => null)
    }
  }
  if (!result) return { ...emptyOutcome('sent', 'could not confirm the result: all nodes failed'), digest }
  cache.apply(result)
  // 执行完通常还没进 checkpoint：等它进了再返回，调用方用 checkpoint 作 minCheckpoint 就能读到执行后的状态
  const deadline = Date.now() + CHECKPOINT_WAIT
  while (result.checkpoint === null && Date.now() < deadline && !options.signal?.aborted) {
    await new Promise((r) => setTimeout(r, 300))
    const found: ExecutionResult | null = await getTransaction(client.transport, result.digest ?? digest, { signal: options.signal }).catch(() => null)
    if (found?.checkpoint != null) result = { ...result, checkpoint: found.checkpoint }
  }
  return {
    status: result.success ? 'confirmed' : 'reverted',
    digest: result.digest ?? digest,
    fee: feeOf(result),
    checkpoint: result.checkpoint === null ? null : Number(result.checkpoint),
    error: result.success ? null : result.error,
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

function walletError(err: unknown): string {
  const text = `${(err as { name?: string })?.name ?? ''} ${(err as Error)?.message ?? String(err)}`
  return /reject|denied|cancel|declined/i.test(text) ? 'rejected by user' : (err as Error)?.message ?? String(err)
}
