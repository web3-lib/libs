import { isError, type TransactionRequest } from 'ethers'

import type { EthersLikeProvider } from './aggregate.js'
import { detectChainIdOf } from './detect.js'
import { isExecutionError } from './errors.js'
import { withTimeout } from './util.js'

export interface FallbackOptions {
  /** 单个节点单次请求超时（毫秒），超时视为该节点故障并换下一个。默认 10000；<= 0 表示不限制 */
  timeout?: number
  /** 节点出错后跳过它的时长（毫秒），期间优先用其他节点。默认 30000 */
  cooldown?: number
}

/**
 * 多节点故障切换：按顺序使用节点，出错或超时换下一个；出错的节点在 cooldown 内排到最后。
 *
 * 与 ethers FallbackProvider 相比：
 * - 没有首次请求前对所有节点的 getBlockNumber 同步，一个卡住的节点不会拖住第一次查询
 * - 合约 revert 等确定性结果直接返回，不会拿去别的节点重试
 */
export class FallbackRpc implements EthersLikeProvider {
  readonly #nodes: EthersLikeProvider[]
  readonly #timeout: number
  readonly #cooldown: number
  readonly #failedAt: number[]
  /** 上次 getLogs 成功的节点 */
  #logsNode = -1
  /** 上次成功的节点连续被限频的次数 */
  #logsThrottled = 0
  /** getLogs 超时 / 连不上的时间，只影响 getLogs 的节点顺序 */
  readonly #logsFailedAt: number[]

  constructor(nodes: EthersLikeProvider[], options: FallbackOptions = {}) {
    if (!nodes.length) {
      throw new Error('FallbackRpc requires at least one node')
    }
    this.#nodes = nodes
    this.#timeout = options.timeout ?? 10_000
    this.#cooldown = options.cooldown ?? 30_000
    this.#failedAt = nodes.map(() => 0)
    this.#logsFailedAt = nodes.map(() => 0)
  }

  get nodes(): readonly EthersLikeProvider[] {
    return this.#nodes
  }

  call(tx: TransactionRequest): Promise<string> {
    return this.#run((node) => node.call(tx))
  }

  getBalance(address: Parameters<EthersLikeProvider['getBalance']>[0], blockTag?: Parameters<EthersLikeProvider['getBalance']>[1]): Promise<bigint> {
    return this.#run((node) => node.getBalance(address, blockTag))
  }

  /** 按节点顺序探测 chainId（节点需实现 getChainId，见 detect.ts） */
  getChainId(): Promise<number> {
    return this.#run((node) => detectChainIdOf(node))
  }

  /**
   * 当前区块号。优先问上次 getLogs 成功的节点（增量扫描时区块号和日志来自同一个节点，不会因节点间的高度差漏扫）；
   * 不支持 getBlockNumber 的节点跳过，失败也不让节点进入冷却（不影响 call / getBalance）
   */
  async getBlockNumber(): Promise<number> {
    let lastError: unknown = new Error('No node supports getBlockNumber')
    for (const index of this.#preferLogsNode(this.#order())) {
      const node = this.#nodes[index] as EthersLikeProvider
      if (!node.getBlockNumber) {
        continue
      }
      try {
        return await withTimeout(node.getBlockNumber(), this.#timeout)
      } catch (err) {
        lastError = err
      }
    }
    throw lastError
  }

  /**
   * 依次尝试支持 getLogs 的节点。与其他请求不同：
   * - getLogs 失败多半是“区块范围超限 / 节点不开放这个方法”，不代表节点故障，所以不影响 call / getBalance 的节点顺序；
   *   超时 / 连不上的节点只在 getLogs 里排到后面（冷却期内），上次成功的节点排在最前
   * - 在用的节点被限频时直接抛出（连续 3 次后才换节点），其他情况全部失败时抛出；GetLogsError 带上每个节点的错误
   */
  async getLogs(filter: Parameters<NonNullable<EthersLikeProvider['getLogs']>>[0]): Promise<Awaited<ReturnType<NonNullable<EthersLikeProvider['getLogs']>>>> {
    const errors: unknown[] = []
    let preferred: unknown
    const sticky = this.#logsNode
    for (const index of this.#preferLogsNode(this.#order(this.#logsFailedAt))) {
      const node = this.#nodes[index] as EthersLikeProvider
      if (!node.getLogs) {
        continue
      }
      try {
        const logs = await withTimeout(node.getLogs(filter), this.#timeout)
        this.#logsNode = index
        this.#logsFailedAt[index] = 0
        this.#logsThrottled = 0
        return logs
      } catch (err) {
        if (isError(err, 'INVALID_ARGUMENT')) {
          throw err
        }
        if (!isAlive(err)) {
          // 超时 / 连不上：排到后面；如果是上次成功的节点，不再优先用它
          this.#logsFailedAt[index] = Date.now()
          if (index === this.#logsNode) {
            this.#logsNode = -1
          }
        } else if (index === sticky) {
          preferred = err
          if (isRateLimited(err)) {
            // 在用的节点只是限频：直接抛出让调用方退避重试（其他节点多半本来就不能用，逐个试只会更慢）；
            // 连续 3 次就不再优先用它，试其他节点
            if (++this.#logsThrottled < 3) {
              throw new GetLogsError([err], err)
            }
            this.#logsThrottled = 0
            this.#logsNode = -1
          }
        }
        errors.push(err)
      }
    }
    throw new GetLogsError(errors, preferred)
  }

  async #run<T>(fn: (node: EthersLikeProvider) => Promise<T>): Promise<T> {
    let lastError: unknown
    for (const index of this.#order()) {
      try {
        const result = await withTimeout(fn(this.#nodes[index] as EthersLikeProvider), this.#timeout)
        this.#failedAt[index] = 0
        return result
      } catch (err) {
        if (isDeterministic(err)) {
          throw err
        }
        this.#failedAt[index] = Date.now()
        lastError = err
      }
    }
    throw lastError
  }

  /** 健康的节点按原顺序在前，冷却中的按出错时间先后排在后面（全挂时也都会再试一次） */
  #order(failedAt: readonly number[] = this.#failedAt): number[] {
    const now = Date.now()
    const healthy: number[] = []
    const cooling: number[] = []
    failedAt.forEach((at, i) => (at && now - at < this.#cooldown ? cooling : healthy).push(i))
    cooling.sort((a, b) => (failedAt[a] as number) - (failedAt[b] as number))
    return [...healthy, ...cooling]
  }

  /** 上次 getLogs 成功的节点（不在 getLogs 冷却中时）排到最前 */
  #preferLogsNode(order: number[]): number[] {
    const index = this.#logsNode
    const at = this.#logsFailedAt[index]
    if (index < 0 || (at && Date.now() - at < this.#cooldown)) {
      return order
    }
    return [index, ...order.filter((i) => i !== index)]
  }
}

/**
 * getLogs 失败时抛出（所有节点都失败，或在用的节点被限频），errors 是各节点的错误；
 * preferred 是上次成功的节点这次返回的错误（它最能说明问题：其他节点可能一直就不能用）
 */
export class GetLogsError extends Error {
  constructor(
    readonly errors: readonly unknown[],
    readonly preferred?: unknown,
  ) {
    super(errors.length ? `getLogs failed: ${errors.map(errorText).join(' | ')}` : 'No node supports getLogs')
    this.name = 'GetLogsError'
  }
}

/** 取出错误里节点返回的原始信息（ethers 会把它放在 error.message 里，外层是 “could not coalesce error”） */
export function errorText(err: unknown): string {
  const e = err as { error?: { message?: unknown }; info?: { error?: { message?: unknown } }; shortMessage?: unknown; message?: unknown } | null
  const parts = [e?.error?.message, e?.info?.error?.message, e?.shortMessage ?? e?.message].filter((p) => typeof p === 'string')
  return parts.length ? parts.join('; ') : String(err)
}

/** 节点正常返回了 JSON-RPC 错误（ethers 把它放在 error / info.error 里）或只是限频，说明节点本身可用 */
function isAlive(err: unknown): boolean {
  const e = err as { error?: { message?: unknown }; info?: { error?: { message?: unknown } } } | null
  return typeof (e?.error?.message ?? e?.info?.error?.message) === 'string' || isRateLimited(err)
}

function isRateLimited(err: unknown): boolean {
  return /too many requests|rate.?limit|\b429\b/i.test(errorText(err))
}

/** 换节点也不会变的错误：合约执行结果、参数错误、用户拒绝等 */
function isDeterministic(err: unknown): boolean {
  return (
    isExecutionError(err) ||
    isError(err, 'INVALID_ARGUMENT') ||
    isError(err, 'ACTION_REJECTED') ||
    isError(err, 'NUMERIC_FAULT')
  )
}
