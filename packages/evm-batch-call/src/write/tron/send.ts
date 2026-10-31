/** Tron 交易的发送与确认：构造签名、余额 / 资源预检、广播、轮询确认、过期重发 */
import { sha256 } from 'ethers'

import { decodeRevertReason } from '../../errors.js'
import { errorText } from '../../fallback.js'
import { mapPool, pause as sleep } from '../../util.js'
import { emptyOutcome, type SendOptions, type TronSendOptions, type TxOutcome } from '../send.js'
import { encodeRawData, encodeTransaction, isUserRejection, type TronContract, type TronKey } from './codec.js'
import { TronRpc, TronTxError, bandwidthBurn, decodeHex, energyBurn, transactionBytes, transferBurn, type Resources } from './rpc.js'

/** 交易过期时间：参考区块时间 + 60 秒 */
const EXPIRATION = 60_000
/** 浏览器钱包签名的交易：参考区块时间 + 3 分钟（用户确认需要时间） */
const WALLET_EXPIRATION = 180_000

export interface TronJob {
  signer: TronKey
  contract: TronContract
  /** 合约调用的 fee_limit；不传时按模拟结果 */
  feeLimit?: bigint
  continueOnError?: boolean
  onUpdate(outcome: TxOutcome): void
}

interface TransactionInfo {
  id?: string
  fee?: number
  blockNumber?: number
  result?: string
  resMessage?: string
  contractResult?: string[]
  receipt?: { result?: string; energy_usage_total?: number }
}

/** 构造并签名交易；txID 与最近发出的重复时（同样内容、同一毫秒）错开时间戳 */
async function buildSigned(rpc: TronRpc, job: TronJob, feeLimit: bigint, fresh: boolean): Promise<{ txId: string; signed: Uint8Array; expiration: number }> {
  const ref = await rpc.refBlock(fresh)
  // 浏览器钱包要等用户确认，过期时间放宽
  const expiration = ref.timestamp + (job.signer.wallet ? WALLET_EXPIRATION : EXPIRATION)
  for (let timestamp = Date.now(); ; timestamp++) {
    const limit = job.contract.type === 'trigger' ? feeLimit : 0n
    const raw = encodeRawData(job.contract, ref, expiration, timestamp, limit)
    const txId = sha256(raw).slice(2)
    if (!rpc.remember(txId)) continue
    let signature: string
    try {
      signature = await job.signer.sign({ txId, raw, contract: job.contract, ref, expiration, timestamp, feeLimit: limit })
    } catch (err) {
      throw job.signer.wallet && isUserRejection(err) ? new Error('rejected by user') : err
    }
    return { txId, signed: encodeTransaction(raw, signature), expiration }
  }
}

/** 按 fee_limit 选项或模拟的能量算 fee_limit */
async function feeLimitFor(rpc: TronRpc, job: TronJob, energy: number): Promise<bigint> {
  if (job.feeLimit !== undefined) return job.feeLimit
  if (rpc.options.feeLimit !== undefined) return rpc.options.feeLimit
  const { energyFee } = await rpc.params()
  const limit = (BigInt(Math.ceil(energy * 1.5)) * energyFee) || 1_000_000n
  return limit > 15_000_000_000n ? 15_000_000_000n : limit // 上限 15000 TRX
}

/**
 * 发送一批 Tron 交易：同一钱包按顺序发出（不等上一笔确认），不同钱包并发。Tron 没有 nonce，交易之间互不阻塞；
 * 合约调用先模拟，模拟失败且同一钱包还有未确认的交易时先等它们确认再模拟一次（先 approve 再调用的情况）
 */
export async function sendTronJobs(rpc: TronRpc, jobs: readonly TronJob[], options: SendOptions & TronSendOptions): Promise<void> {
  const groups = new Map<string, TronJob[]>()
  jobs.forEach((job) => {
    const list = groups.get(job.signer.address)
    if (list) list.push(job)
    else groups.set(job.signer.address, [job])
  })
  await mapPool([...groups.values()], options.concurrency ?? 8, (list) => sendTronGroup(rpc, list, options))
}

async function sendTronGroup(rpc: TronRpc, jobs: readonly TronJob[], options: SendOptions & TronSendOptions): Promise<void> {
  const { signal, dryRun = false, wait = true, timeout = 180_000, pollInterval = 3_000, retries = 2 } = options
  const inFlight: Array<{ sent: boolean; watch: () => Promise<void> }> = []
  const settle = async () => {
    for (let seen = -1; seen !== inFlight.length; ) {
      seen = inFlight.length
      await Promise.all(inFlight.map((f) => f.watch()))
    }
  }
  let stopped = false
  const update = (job: TronJob, patch: Partial<TxOutcome> & { status: TxOutcome['status'] }) => {
    try {
      job.onUpdate({ ...emptyOutcome(patch.status), ...patch })
    } catch {
      // 调用方的进度回调出错不能打断发送
    }
  }
  /** 这个钱包的余额和资源（第一次发送前读一次，之后按每笔的预估花费扣减） */
  let account: Promise<Resources> | null = null
  /**
   * 发送前检查 TRX 够不够：Tron 上能量不够的合约调用照样上链、执行失败（OUT_OF_ENERGY）并烧掉 TRX，
   * 不像 EVM 那样在广播时就被拒。按每笔的金额 + 能量（× 1.2）+ 带宽 + 激活费累计；不够时返回原因
   */
  const shortOf = async (job: TronJob, energy: number, feeLimit: bigint): Promise<string | null> => {
    const r = await (account ??= rpc.resources(job.signer.address))
    if (!r.exists) return 'account is not activated (it needs to receive TRX first)'
    const params = await rpc.params()
    const next = { ...r }
    const bytes = transactionBytes(job.contract, feeLimit)
    let spend: bigint
    if (job.contract.type === 'trigger') {
      spend = bandwidthBurn(next, bytes, params.bandwidthFee) + energyBurn(next, energy, params.energyFee) + job.contract.callValue
    } else {
      spend = transferBurn(next, bytes, params, !(await rpc.accountExists(job.contract.to))) + job.contract.amount
    }
    if (next.balance < spend) return `insufficient TRX: this transaction needs about ${spend} sun (amount + fees), the wallet has ${next.balance} left`
    Object.assign(r, next, { balance: next.balance - spend })
    return null
  }

  /** 发出一笔（attempt：过期后第几次重发） */
  const submit = async (job: TronJob, attempt: number): Promise<void> => {
    let energy = 0
    if (job.contract.type === 'trigger') {
      try {
        energy = await rpc.simulate(job.contract)
      } catch (err) {
        if (!(err instanceof TronTxError) || attempt > 0 || !inFlight.some((f) => f.sent)) throw err
        // 可能依赖前面还没确认的交易：等它们确认后重新模拟
        await settle()
        if (signal?.aborted) {
          update(job, { status: 'skipped', error: 'aborted' })
          return
        }
        energy = await rpc.simulate(job.contract)
      }
    }
    const feeLimit = job.contract.type === 'trigger' ? await feeLimitFor(rpc, job, energy) : 0n
    const gasLimit = job.contract.type === 'trigger' ? BigInt(energy) : null
    // 过期重发的这笔之前已经扣过预估花费（原交易没执行，不再重复扣）
    const short = attempt === 0 ? await shortOf(job, energy, feeLimit) : null
    if (short) throw new TronTxError(short)
    if (dryRun) {
      update(job, { status: 'simulated', gasLimit })
      return
    }
    const { txId, signed, expiration } = await buildSigned(rpc, job, feeLimit, attempt > 0)
    const sent = await rpc.broadcast(signed)
    update(job, { status: 'sent', hash: txId, gasLimit, error: sent === 'accepted' ? null : sent.uncertain })
    let watching: Promise<void> | null = null
    const flight = { sent: true, watch: () => (watching ??= follow()) }
    const follow = async (): Promise<void> => {
      const deadline = Date.now() + timeout
      let polls = 0
      let expiredChecks = 0
      while (!signal?.aborted) {
        await sleep(pollInterval, signal)
        if (signal?.aborted) break
        let info: TransactionInfo | null = null
        try {
          info = await rpc.request<TransactionInfo>('wallet/gettransactioninfobyid', { value: txId })
        } catch {
          // 节点暂时出错：下次再查
        }
        if (info?.id) {
          flight.sent = false
          const result = info.receipt?.result ?? 'SUCCESS'
          const ok = result === 'SUCCESS' && info.result !== 'FAILED'
          const output = info.contractResult?.[0]
          const reason = ok ? null : (output && decodeRevertReason(`0x${output}`)) || (info.resMessage ? decodeHex(info.resMessage) : result)
          update(job, {
            status: ok ? 'confirmed' : 'reverted',
            hash: txId,
            gasLimit,
            gasUsed: info.receipt?.energy_usage_total === undefined ? null : BigInt(info.receipt.energy_usage_total),
            fee: BigInt(info.fee ?? 0),
            blockNumber: info.blockNumber ?? null,
            error: reason === null ? null : `execution reverted: ${reason}`,
          })
          return
        }
        // 过期判断按固化数据（见 expiredForSure），连续两次确认才算：误判过期后重发会重复执行。本地时钟只用来决定什么时候开始查
        if (Date.now() > expiration && (await rpc.expiredForSure(txId, expiration))) {
          expiredChecks++
        } else {
          expiredChecks = 0
        }
        if (expiredChecks >= 2) {
          flight.sent = false
          if (attempt < retries) {
            await submit(job, attempt + 1).catch((err: unknown) => update(job, { status: 'failed', error: errorText(err) }))
          } else {
            update(job, { status: 'failed', error: 'transaction expired before it was confirmed' })
          }
          return
        }
        if (Date.now() >= deadline) {
          flight.sent = false
          update(job, { status: 'pending', hash: txId, gasLimit, error: `not confirmed within ${timeout}ms` })
          return
        }
        if (++polls % 3 === 0) {
          void rpc.broadcast(signed).catch(() => {})
        }
      }
      flight.sent = false
    }
    inFlight.push(flight)
    if (wait) void flight.watch()
  }

  for (const job of jobs) {
    if (stopped || signal?.aborted) {
      update(job, { status: 'skipped', error: signal?.aborted ? 'aborted' : 'skipped: a previous call from this wallet failed' })
      continue
    }
    try {
      await submit(job, 0)
    } catch (err) {
      update(job, { status: 'failed', error: errorText(err) })
      if (!job.continueOnError) stopped = true
    }
  }
  if (wait) await settle()
}
