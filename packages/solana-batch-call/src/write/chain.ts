import { sha256 } from '@noble/hashes/sha2.js'
import { base64 } from '@scure/base'

import type { SolanaClient } from '../client.js'
import { FallbackRpc, RpcError, isNodeFault, type RpcTransport } from '../rpc.js'
import { clientSourceConfigs } from '../clientConfig.js'
import { sleep } from '../util.js'
import { errorText } from './errors.js'
import type { SendOptions } from './send.js'
import { serializeTransaction, type CompiledMessage } from './transaction.js'

/**
 * 最近发出过的交易消息（sha256）：同样的消息签名也相同，再发一次只会被节点当成同一笔。
 * 在签名之前检查（钱包签名的交易也适用），重复时调整计算单元上限让消息不同
 */
const recentMessages = new Set<string>()

export function messageKey(message: Uint8Array): string {
  return base64.encode(sha256(message))
}

export function isRecentMessage(message: Uint8Array): boolean {
  return recentMessages.has(messageKey(message))
}

export function remember(message: Uint8Array): void {
  recentMessages.add(messageKey(message))
  if (recentMessages.size > 10_000) {
    recentMessages.delete(recentMessages.values().next().value as string)
  }
}

export interface Blockhash {
  blockhash: string
  lastValidBlockHeight: number
}

export interface SimulationValue {
  err: unknown
  logs?: string[] | null
  unitsConsumed?: number
  /** 请求了 accounts 时：模拟执行后这些账户的状态（已扣手续费）；账户不存在时为 null */
  accounts?: Array<{ lamports: number | string } | null> | null
}

/**
 * 'auto' 优先费用：最近费用里去掉 0 再取 75 分位。
 * 不活跃的账户大多数 slot 没有相关交易，返回 0（2026-10 主网实测 USDC mint 150 个 slot 里 135 个是 0），
 * 带上 0 取分位数几乎总是 0，等于不加优先费用
 */
export function autoPriorityFee(fees: readonly number[], cap: bigint): bigint {
  const paid = fees
    .filter((fee) => fee > 0)
    .map((fee) => BigInt(fee))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const p75 = paid.length ? (paid[Math.min(paid.length - 1, Math.floor(paid.length * 0.75))] as bigint) : 0n
  return p75 < cap ? p75 : cap
}

/** 一批发送共用的节点访问：blockhash（缓存 10 秒）、优先费用（按账户缓存 10 秒）、模拟、广播 */
export class Chain {
  #blockhash: { at: number; value: Promise<Blockhash> } | null = null
  readonly #fees = new Map<string, { at: number; value: Promise<bigint> }>()
  #broadcastTargets: Promise<RpcTransport[]> | null = null

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
        .then((list) => autoPriorityFee(list.map((f) => f.prioritizationFee), cap))
        .catch(() => 0n) // 节点不支持时不加优先费用
      cached = { at: Date.now(), value }
      this.#fees.set(key, cached)
    }
    return cached.value
  }

  /** 模拟；watch 是要返回模拟后状态的账户（如手续费支付者，用来判断付不付得起优先费用） */
  async simulate(message: CompiledMessage, minContextSlot: number | undefined, watch?: readonly string[]): Promise<SimulationValue> {
    const raw = base64.encode(serializeTransaction(message, message.signers.map(() => null)))
    const config: Record<string, unknown> = { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }
    if (minContextSlot !== undefined) {
      config.minContextSlot = minContextSlot
    }
    if (watch?.length) {
      config.accounts = { encoding: 'base64', addresses: watch }
    }
    // 节点暂时的问题（限频、高度还没到 minContextSlot 等）重试几次，不当成调用失败
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.client.request<{ value: SimulationValue }>('simulateTransaction', [raw, config])
        return res.value
      } catch (err) {
        if (attempt >= 3 || (err instanceof RpcError && !isNodeFault(err))) throw err
        await sleep(500 * (attempt + 1), this.options.signal, false)
      }
    }
  }

  /** 账户当前的 lamports；读不到时为 null（调用方按“不知道”处理） */
  async balance(address: string, minContextSlot: number | undefined): Promise<bigint | null> {
    try {
      const config: Record<string, unknown> = { commitment: 'confirmed' }
      if (minContextSlot !== undefined) config.minContextSlot = minContextSlot
      const res = await this.client.request<{ value: number | string }>('getBalance', [address, config])
      return BigInt(res.value)
    } catch {
      return null
    }
  }

  /**
   * 广播目标：sendRpc（不传时用 client 的节点）。sendRpc 按 client 的网络和节点选项（headers / fetch / timeout 等）解析，
   * 并校验和 client 在同一个网络（不一致时报 NetworkMismatchError）。
   * broadcast 为 'all' 时拆成各个节点（每个单独包一层 FallbackRpc，照常触发 onRequest、记录健康状态），否则整体按故障切换顺序只发给第一个可用的节点。
   * 解析出错时抛出、不缓存（下次重试）。source.ts 只在传了 sendRpc 时按需加载（/write 的入口本身不静态依赖它）
   */
  #targets(): Promise<RpcTransport[]> {
    this.#broadcastTargets ??= this.#resolveTargets().catch((err: unknown) => {
      this.#broadcastTargets = null
      throw err
    })
    return this.#broadcastTargets
  }

  async #resolveTargets(): Promise<RpcTransport[]> {
    let sender = this.client.transport
    if (this.options.sendRpc !== undefined) {
      const { resolveSource } = await import('../source.js')
      const config = clientSourceConfigs.get(this.client)
      sender = resolveSource(this.options.sendRpc, config?.cluster, config?.options, config?.genesis).transport
    }
    const nodes = sender instanceof FallbackRpc ? sender.nodes : [sender]
    return this.options.broadcast === 'all' && nodes.length > 1 ? nodes.map((node) => new FallbackRpc([node])) : [sender]
  }

  /**
   * 广播：'accepted'（第一个接受的节点返回就结束，其余节点在后台继续）；没有节点接受时，有节点明确拒绝（或节点不在同一个网络）则抛出，
   * 否则返回错误说明（节点都连不上，交易可能已经发出）
   */
  async broadcast(raw: string): Promise<'accepted' | { uncertain: string }> {
    const params = [raw, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]
    const attempts = (await this.#targets()).map((target) =>
      target.request('sendTransaction', params).then(
        () => 'accepted' as const,
        (err: unknown) => {
          if (/already (been )?processed/i.test(errorText(err))) {
            return 'accepted' as const
          }
          throw err
        },
      ),
    )
    // 返回后还没结束的节点照常在后台完成：吞掉它们的拒绝，避免未处理的 rejection
    attempts.forEach((attempt) => attempt.catch(() => {}))
    try {
      return await Promise.any(attempts)
    } catch (err) {
      const errors: unknown[] = err instanceof AggregateError ? err.errors : [err]
      const rejected = errors.find((e) => (e instanceof RpcError && !isNodeFault(e)) || isNetworkMismatch(e))
      if (rejected) {
        throw rejected
      }
      return { uncertain: `broadcast not acknowledged: ${errors.map(errorText).join(' | ')}` }
    }
  }
}

/** 按 SendOptions 取优先费用单价（micro-lamports / 计算单元）；writable 是交易里的可写账户 */
export function priorityFeeFor(client: SolanaClient, options: SendOptions, writable: readonly string[]): Promise<bigint> {
  return new Chain(client, options).priorityFee(writable)
}

/** 节点不在同一个网络（source.ts 的 NetworkMismatchError）：按 name 判断，免得为 instanceof 静态带上 source.ts */
function isNetworkMismatch(err: unknown): boolean {
  return err instanceof Error && err.name === 'NetworkMismatchError'
}
