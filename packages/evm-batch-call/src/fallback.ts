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

  constructor(nodes: EthersLikeProvider[], options: FallbackOptions = {}) {
    if (!nodes.length) {
      throw new Error('FallbackRpc requires at least one node')
    }
    this.#nodes = nodes
    this.#timeout = options.timeout ?? 10_000
    this.#cooldown = options.cooldown ?? 30_000
    this.#failedAt = nodes.map(() => 0)
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

  getBlockNumber(): Promise<number> {
    return this.#run((node) => {
      if (!node.getBlockNumber) throw new Error('getBlockNumber is not supported by this node')
      return node.getBlockNumber()
    })
  }

  /**
   * 依次尝试支持 getLogs 的节点。与其他请求不同：
   * - getLogs 失败多半是“区块范围超限 / 节点不开放这个方法”，不代表节点故障，所以不让节点进入冷却
   * - 全部失败时抛出 GetLogsError，带上每个节点的错误（如只有某个节点的报错里写了范围上限）
   */
  async getLogs(filter: Parameters<NonNullable<EthersLikeProvider['getLogs']>>[0]): Promise<Awaited<ReturnType<NonNullable<EthersLikeProvider['getLogs']>>>> {
    const errors: unknown[] = []
    // 上次成功的节点排在最前（大多数公共节点不开放 getLogs，没必要每次从头试）
    const order = this.#nodes.map((_, i) => i).sort((a, b) => (a === this.#logsNode ? -1 : b === this.#logsNode ? 1 : a - b))
    for (const index of order) {
      const node = this.#nodes[index] as EthersLikeProvider
      if (!node.getLogs) {
        continue
      }
      try {
        const logs = await withTimeout(node.getLogs(filter), this.#timeout)
        this.#logsNode = index
        return logs
      } catch (err) {
        if (isError(err, 'INVALID_ARGUMENT')) {
          throw err
        }
        errors.push(err)
      }
    }
    throw new GetLogsError(errors)
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
  #order(): number[] {
    const now = Date.now()
    const healthy: number[] = []
    const cooling: number[] = []
    this.#failedAt.forEach((at, i) => (at && now - at < this.#cooldown ? cooling : healthy).push(i))
    cooling.sort((a, b) => (this.#failedAt[a] as number) - (this.#failedAt[b] as number))
    return [...healthy, ...cooling]
  }
}

/** 换节点也不会变的错误：合约执行结果、参数错误、用户拒绝等 */
/** 所有节点的 getLogs 都失败时抛出，errors 是各节点的错误 */
export class GetLogsError extends Error {
  constructor(readonly errors: readonly unknown[]) {
    super(errors.length ? `getLogs failed on all nodes: ${errors.map(errorText).join(' | ')}` : 'No node supports getLogs')
    this.name = 'GetLogsError'
  }
}

/** 取出错误里节点返回的原始信息（ethers 会把它放在 error.message 里，外层是 “could not coalesce error”） */
export function errorText(err: unknown): string {
  const e = err as { error?: { message?: unknown }; info?: { error?: { message?: unknown } }; shortMessage?: unknown; message?: unknown } | null
  const parts = [e?.error?.message, e?.info?.error?.message, e?.shortMessage ?? e?.message].filter((p) => typeof p === 'string')
  return parts.length ? parts.join('; ') : String(err)
}

function isDeterministic(err: unknown): boolean {
  return (
    isExecutionError(err) ||
    isError(err, 'INVALID_ARGUMENT') ||
    isError(err, 'ACTION_REJECTED') ||
    isError(err, 'NUMERIC_FAULT')
  )
}
