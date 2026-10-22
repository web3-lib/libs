import type { BatchCallOptions, NormalizedCall } from '../write/batch.js'
import { sendEach } from '../write/batch.js'
import { WriteRpc, failureText } from '../write/rpc.js'
import { quantity } from './userOp.js'
import { emptyOutcome, toWriteResult, type TxOutcome, type WriteResult } from '../write/send.js'

/**
 * 浏览器钱包的提供者，三种都可以：EIP-1193 provider（`window.ethereum`，有 request）、
 * ethers 的 BrowserProvider（有 send）、ethers 的 JsonRpcSigner（用它背后的 provider）
 */
export type Eip1193Like =
  | { request(args: { method: string; params?: unknown[] | object }): Promise<unknown> }
  | { send(method: string, params: unknown[]): Promise<unknown> }
  | { provider: { send(method: string, params: unknown[]): Promise<unknown> } | { request(args: { method: string; params?: unknown[] | object }): Promise<unknown> } }

export type RequestFn = (method: string, params: unknown[]) => Promise<unknown>

/** 统一成 (method, params) => Promise */
export function toRequest(p: Eip1193Like): RequestFn {
  const direct = p as { request?: unknown; send?: unknown; provider?: unknown }
  if (typeof direct.request === 'function') {
    return (method, params) => (p as { request(args: { method: string; params: unknown[] }): Promise<unknown> }).request({ method, params })
  }
  if (typeof direct.send === 'function') {
    return (method, params) => (p as { send(method: string, params: unknown[]): Promise<unknown> }).send(method, params)
  }
  if (direct.provider) {
    return toRequest(direct.provider as Eip1193Like)
  }
  throw new Error('Expected an EIP-1193 provider, an ethers BrowserProvider or a JsonRpcSigner')
}

/** 钱包对某条链的能力（wallet_getCapabilities） */
export interface WalletCapabilities {
  /** 'supported'：能原子批量；'ready'：钱包会在用户同意后升级账户；'unsupported'：不支持 */
  atomic: 'supported' | 'ready' | 'unsupported'
  /** 钱包是否支持 paymasterService（代付 gas）能力 */
  paymasterService: boolean
  /** 钱包返回的原始能力 */
  raw: Record<string, unknown>
}

const chainHex = (chainId: number) => quantity(chainId)

/** 查询钱包能力；钱包不支持 EIP-5792（报错）时返回 null */
export async function getWalletCapabilities(provider: Eip1193Like, address: string, chainId: number): Promise<WalletCapabilities | null> {
  let all: Record<string, Record<string, any>> | null
  try {
    all = (await toRequest(provider)('wallet_getCapabilities', [address, [chainHex(chainId)]])) as Record<string, Record<string, any>> | null
  } catch {
    return null
  }
  const raw = all?.[chainHex(chainId)] ?? all?.[String(chainId)] ?? Object.entries(all ?? {}).find(([k]) => k.toLowerCase() === chainHex(chainId).toLowerCase())?.[1] ?? {}
  const status = raw.atomic?.status ?? (raw.atomicBatch?.supported ? 'supported' : 'unsupported')
  return { atomic: status === 'supported' || status === 'ready' ? status : 'unsupported', paymasterService: Boolean(raw.paymasterService?.supported), raw }
}

export interface SendCallsRequest {
  from: string
  chainId: number
  calls: ReadonlyArray<{ to: string; value?: bigint; data?: string }>
  /** 必须原子执行（钱包不能原子就拒绝）。默认 true */
  atomicRequired?: boolean
  /** 钱包能力扩展（如 `{ paymasterService: { url } }` 让钱包找 paymaster 代付 gas） */
  capabilities?: Record<string, unknown>
}

/** wallet_sendCalls：返回调用批次的 id（用 getCallsStatus 查询） */
export async function sendCalls(provider: Eip1193Like, req: SendCallsRequest): Promise<string> {
  const result = (await toRequest(provider)('wallet_sendCalls', [
    {
      version: '2.0.0',
      from: req.from,
      chainId: chainHex(req.chainId),
      atomicRequired: req.atomicRequired ?? true,
      calls: req.calls.map((c) => ({ to: c.to, ...(c.value ? { value: quantity(c.value) } : {}), data: c.data ?? '0x' })),
      ...(req.capabilities ? { capabilities: req.capabilities } : {}),
    },
  ])) as string | { id: string }
  return typeof result === 'string' ? result : result.id
}

export interface CallsStatus {
  status: 'pending' | 'confirmed' | 'failed' | 'reverted' | 'partial'
  atomic: boolean
  receipts: Array<{ transactionHash: string; blockNumber: number | null; gasUsed: bigint | null; success: boolean }>
}

/** wallet_getCallsStatus（兼容 v1 的字符串状态和 v2 的 100 / 200 / 400 / 500 / 600 状态码） */
export async function getCallsStatus(provider: Eip1193Like, id: string): Promise<CallsStatus> {
  const r = (await toRequest(provider)('wallet_getCallsStatus', [id])) as { status: number | string; atomic?: boolean; receipts?: Array<{ transactionHash: string; blockNumber?: string; gasUsed?: string; status?: string }> }
  const code = typeof r.status === 'number' ? r.status : r.status === 'CONFIRMED' ? 200 : r.status === 'PENDING' ? 100 : 400
  const status = code < 200 ? 'pending' : code < 300 ? 'confirmed' : code < 500 ? 'failed' : code === 500 ? 'reverted' : 'partial'
  const receipts = (r.receipts ?? []).map((x) => ({
    transactionHash: x.transactionHash,
    blockNumber: x.blockNumber ? Number(x.blockNumber) : null,
    gasUsed: x.gasUsed ? BigInt(x.gasUsed) : null,
    success: x.status === undefined || Number(x.status) === 1,
  }))
  return { status, atomic: r.atomic ?? true, receipts }
}

/** 轮询到有结果；超时返回最后一次的 pending */
export async function waitForCalls(provider: Eip1193Like, id: string, options: { timeout?: number; pollInterval?: number; signal?: AbortSignal } = {}): Promise<CallsStatus> {
  const { timeout = 180_000, pollInterval = 2_000, signal } = options
  const deadline = Date.now() + timeout
  let last: CallsStatus = { status: 'pending', atomic: true, receipts: [] }
  while (!signal?.aborted) {
    try {
      last = await getCallsStatus(provider, id)
      if (last.status !== 'pending') return last
    } catch {
      // 钱包暂时没有这个 id 的状态：下次再查
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollInterval, Math.max(0, deadline - Date.now()))))
  }
  return last
}

/**
 * '5792' 模式：钱包支持原子批量就用 wallet_sendCalls（一次确认、一笔交易原子执行）；
 * 不支持（钱包不实现 EIP-5792，或链上账户不能原子批量）时退回逐笔发送（每笔一次确认），除非 atomicRequired
 */
export async function send5792(rpc: WriteRpc, calls: readonly NormalizedCall[], options: BatchCallOptions): Promise<WriteResult[]> {
  const first = calls[0]
  if (!first) return []
  if (calls.some((c) => c.signer.address !== first.signer.address)) {
    throw new Error("mode '5792' sends from one browser wallet; split calls per wallet")
  }
  const provider = options.eip1193 ?? (first.signer.signer as { provider?: Eip1193Like }).provider
  if (!provider) {
    throw new Error("mode '5792' requires a browser wallet signer (ethers JsonRpcSigner) or the eip1193 option")
  }
  const caps = await getWalletCapabilities(provider, first.signer.address, rpc.chainId)
  const atomic = caps !== null && caps.atomic !== 'unsupported'
  if (!atomic) {
    if (options.atomicRequired) {
      return calls.map((c, i) => toWriteResult(i, c.signer.address, c.to, emptyOutcome('failed', caps ? 'the wallet cannot execute batches atomically on this chain' : 'the wallet does not support EIP-5792 (wallet_getCapabilities)')))
    }
    // 退回逐笔发送：钱包要能直接发送交易
    const results = await sendEach(rpc, calls, options)
    return results.map((r) => ({ ...r, atomic: false }))
  }
  const results = calls.map((c, i) => toWriteResult(i, c.signer.address, c.to, emptyOutcome('skipped')))
  const report = (outcome: TxOutcome, perCall?: (i: number) => Partial<TxOutcome>) => {
    calls.forEach((c, i) => {
      results[i] = { ...toWriteResult(i, c.signer.address, c.to, { ...outcome, ...perCall?.(i) }), atomic: true }
      options.onUpdate?.(results[i] as WriteResult)
    })
  }
  if (options.dryRun) {
    report(emptyOutcome('simulated'))
    return results
  }
  try {
    const id = await sendCalls(provider, {
      from: first.signer.address,
      chainId: rpc.chainId,
      calls: calls.map((c) => ({ to: c.to, value: c.value, data: c.data })),
      atomicRequired: true,
      capabilities: options.capabilities,
    })
    report({ ...emptyOutcome('sent'), hash: null })
    if (options.wait === false) return results
    const status = await waitForCalls(provider, id, options)
    const receipt = status.receipts[0]
    const base: TxOutcome = { ...emptyOutcome('pending', 'not confirmed in time; query wallet_getCallsStatus with the id later'), hash: receipt?.transactionHash ?? null }
    if (status.status === 'confirmed' || status.status === 'reverted' || status.status === 'partial') {
      report({
        ...base,
        status: status.status === 'confirmed' && receipt?.success !== false ? 'confirmed' : 'reverted',
        error: status.status === 'confirmed' ? null : 'execution reverted',
        blockNumber: receipt?.blockNumber ?? null,
        gasUsed: receipt?.gasUsed ?? null,
      })
    } else if (status.status === 'failed') {
      report({ ...base, status: 'failed', error: 'the wallet reported that the batch failed' })
    } else {
      report(base)
    }
  } catch (err) {
    const rejected = (err as { code?: number } | null)?.code === 4001 || (err as { code?: string } | null)?.code === 'ACTION_REJECTED'
    report(emptyOutcome('failed', rejected ? 'rejected by user' : failureText(err)))
  }
  return results
}
