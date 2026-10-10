import { isError, type TransactionRequest } from 'ethers'

import type { EthersLikeProvider } from './aggregate.js'
import { detectChainIdOf } from './detect.js'
import { isExecutionError } from './errors.js'
import { emitRequest } from './events.js'
import { TimeoutError, withTimeout } from './util.js'

export interface FallbackOptions {
  /** 单个节点单次请求超时（毫秒），超时视为该节点故障并换下一个。默认 10000；<= 0 表示不限制 */
  timeout?: number
  /**
   * 节点迟迟不返回时，过多久（毫秒）同时请求下一个节点：原来的请求不取消，谁先成功用谁（与 ethers FallbackProvider 的 stallTimeout 相同）。
   * 适合正常但偶尔较慢的节点：不必把 timeout 设得很短（正常的慢请求会被判成超时）。
   * 默认 0（不提前请求，只在出错 / 超时后换节点）；只影响 call / getBalance，不影响 getLogs / getBlockNumber
   */
  stallTimeout?: number
  /** 节点出错后跳过它的时长（毫秒），期间优先用其他节点。默认 30000。超时不算出错，同一节点连续 3 次超时才冷却 */
  cooldown?: number
}

/** FallbackRpc 每个节点的标识（resolveSource 传入；直接 new FallbackRpc 时可省略） */
export interface FallbackNodeInfo {
  /** 用于错误信息和 onRequest 事件的节点标识 */
  label: string
  /** 健康状态的 key：URL 字符串或节点对象。相同 key 的节点在所有 FallbackRpc 之间共享冷却状态 */
  key: string | object
  /** 对象节点按链分开记健康状态（钱包可以切链） */
  chainId?: number
}

/** call 的结果校验：返回 false 时视为这个节点的结果不可用（如返回空数据），换下一个节点、不冷却 */
export interface CallValidation {
  accept?: (result: string) => boolean
  /**
   * 最多几个节点的结果没通过校验就不再换节点（默认 2：两个节点结果一致，足以确认是合约本身的问题，
   * 不必把所有节点挨个试一遍——链上确实没有合约时，每个节点都会这样）
   */
  maxInvalid?: number
  /**
   * 检查节点返回的错误：可以抛出别的错误替换它（如 deployless 结果过大时通过 revert 带回的结果，
   * 校验出节点落后时抛 NodeBehindError，这样也能换节点，而不是当成确定性的合约错误直接返回）
   */
  inspectError?: (err: unknown) => void
}

/** 节点的结果早于要求的区块（minBlock）：节点落后，换下一个节点，不冷却（节点是健康的，只是慢几个块） */
export class NodeBehindError extends Error {
  constructor(
    readonly minBlock: bigint,
    readonly block: bigint,
  ) {
    super(`Node is behind: block ${block} < minBlock ${minBlock}`)
    this.name = 'NodeBehindError'
  }
}

/** 节点返回的结果没通过校验（如 eth_call 返回 0x / 无法解码）：换节点，不冷却（可能是合约确实不存在，所有节点都会这样） */
export class InvalidResultError extends Error {
  constructor(readonly result: string) {
    super(`Unusable eth_call result: ${result.length > 66 ? `${result.slice(0, 66)}…` : result}`)
    this.name = 'InvalidResultError'
  }
}

/** 节点健康状态，按节点（URL / 对象）全局共享：Provider 重建后刚失败过的节点仍排在后面 */
interface Health {
  failedAt: number
  /** 连续超时次数 */
  timeouts: number
  /** 开了 stallTimeout 时，在并发竞争中输给后发节点的时间（慢但没出错）：冷却期内排在健康节点之后 */
  slowAt: number
  /** minBlock 校验发现节点落后的时间：短时间内（BEHIND_DEMOTE）排在健康节点之后——出块只要几秒，不必像故障那样冷却 30 秒 */
  behindAt: number
}

/** 落后的节点排到后面的时长：通常几秒内就会跟上，不长期影响其他查询的节点顺序 */
const BEHIND_DEMOTE = 5_000

/** 连续超时多少次后才冷却（偶尔慢不算坏节点） */
const TIMEOUTS_BEFORE_COOLDOWN = 3
const MAX_TRACKED_URLS = 1000
const healthByUrl = new Map<string, Health>()
/** 对象节点（钱包、ethers Provider）按链分开记：钱包在一条链上出错不影响它在其他链上的排序 */
const healthByObject = new WeakMap<object, Map<number | undefined, Health>>()

function healthOf(key: string | object, scope?: number): Health {
  if (typeof key === 'string') {
    let health = healthByUrl.get(key)
    if (!health) {
      health = { failedAt: 0, timeouts: 0, slowAt: 0, behindAt: 0 }
      healthByUrl.set(key, health)
      if (healthByUrl.size > MAX_TRACKED_URLS) {
        healthByUrl.delete(healthByUrl.keys().next().value as string)
      }
    }
    return health
  }
  let byScope = healthByObject.get(key)
  if (!byScope) {
    byScope = new Map()
    healthByObject.set(key, byScope)
  }
  let health = byScope.get(scope)
  if (!health) {
    health = { failedAt: 0, timeouts: 0, slowAt: 0, behindAt: 0 }
    byScope.set(scope, health)
  }
  return health
}

/** 测试用：清空全局的节点健康状态 */
export function resetNodeHealth(): void {
  healthByUrl.clear()
}

/** 所有节点都失败（多节点时）：errors 是每个节点的标识和失败原因，按尝试顺序 */
export class AllNodesFailedError extends Error {
  constructor(readonly errors: ReadonlyArray<{ node: string; error: unknown }>) {
    super(`All RPC nodes failed: ${errors.map((e) => `${e.node}: ${errorText(e.error)}`).join(' | ')}`, { cause: errors[errors.length - 1]?.error })
    this.name = 'AllNodesFailedError'
  }
}

/**
 * 多节点故障切换：按顺序使用节点，出错或超时换下一个；出错的节点在 cooldown 内排到最后（超时只换节点，连续 3 次才冷却）。
 * 设置了 stallTimeout 时，节点迟迟不返回就同时请求下一个，谁先成功用谁。所有节点都失败时抛 AllNodesFailedError（单节点时抛原始错误）。
 * 冷却状态按节点全局共享，每次请求都会触发 onRequest 事件。
 *
 * 与 ethers FallbackProvider 相比：
 * - 没有首次请求前对所有节点的 getBlockNumber 同步，一个卡住的节点不会拖住第一次查询
 * - 合约 revert 等确定性结果直接返回，不会拿去别的节点重试
 */
export class FallbackRpc implements EthersLikeProvider {
  readonly #nodes: EthersLikeProvider[]
  readonly #timeout: number
  readonly #stallTimeout: number
  readonly #cooldown: number
  readonly #labels: string[]
  /** 健康状态的 key；每次用时再从全局表里取（表淘汰条目后，各实例仍取到同一个对象） */
  readonly #healthKeys: Array<string | object>
  readonly #healthScopes: Array<number | undefined>
  /** 上次 getLogs 成功的节点 */
  #logsNode = -1
  /** 上次成功的节点连续被限频的次数 */
  #logsThrottled = 0
  /** getLogs 超时 / 连不上的时间，只影响 getLogs 的节点顺序 */
  readonly #logsFailedAt: number[]

  constructor(nodes: EthersLikeProvider[], options: FallbackOptions = {}, info?: readonly FallbackNodeInfo[]) {
    if (!nodes.length) {
      throw new Error('FallbackRpc requires at least one node')
    }
    this.#nodes = nodes
    this.#timeout = options.timeout ?? 10_000
    this.#stallTimeout = options.stallTimeout ?? 0
    this.#cooldown = options.cooldown ?? 30_000
    this.#labels = nodes.map((_, i) => info?.[i]?.label ?? `node${i}`)
    this.#healthKeys = nodes.map((node, i) => info?.[i]?.key ?? node)
    this.#healthScopes = nodes.map((_, i) => info?.[i]?.chainId)
    this.#logsFailedAt = nodes.map(() => 0)
  }

  get nodes(): readonly EthersLikeProvider[] {
    return this.#nodes
  }

  /** eth_call；validation.accept 返回 false 的结果视为这个节点不可用，换下一个节点（不冷却） */
  call(tx: TransactionRequest, validation?: CallValidation): Promise<string> {
    const accept = validation?.accept
    return this.#run(
      'call',
      (node) =>
        node.call(tx).then(
          (result) => {
            if (accept && !accept(result)) {
              throw new InvalidResultError(result)
            }
            return result
          },
          (err: unknown) => {
            validation?.inspectError?.(err)
            throw err
          },
        ),
      accept ? (validation?.maxInvalid ?? 2) : Number.POSITIVE_INFINITY,
    )
  }

  #health(index: number): Health {
    return healthOf(this.#healthKeys[index] as string | object, this.#healthScopes[index])
  }

  getBalance(address: Parameters<EthersLikeProvider['getBalance']>[0], blockTag?: Parameters<EthersLikeProvider['getBalance']>[1]): Promise<bigint> {
    return this.#run('getBalance', (node) => node.getBalance(address, blockTag))
  }

  /** 按节点顺序探测 chainId（节点需实现 getChainId，见 detect.ts） */
  getChainId(): Promise<number> {
    return this.#run('getChainId', (node) => detectChainIdOf(node))
  }

  /** 对第 index 个节点发一次请求（带超时），并触发 onRequest 事件 */
  async #attempt<T>(method: string, index: number, attempt: number, fn: (node: EthersLikeProvider) => Promise<T>, timeout = this.#timeout): Promise<T> {
    const started = Date.now()
    try {
      const result = await withTimeout(Promise.resolve().then(() => fn(this.#nodes[index] as EthersLikeProvider)), timeout)
      emitRequest({ node: this.#labels[index] as string, method, ms: Date.now() - started, ok: true, attempt })
      return result
    } catch (err) {
      emitRequest({ node: this.#labels[index] as string, method, ms: Date.now() - started, ok: false, error: err, attempt })
      throw err
    }
  }

  /** 单节点：直接请求（getLogs / getBlockNumber 不走多节点的特殊逻辑），抛原始错误 */
  #single<T>(method: string, fn: (node: EthersLikeProvider) => Promise<T>): Promise<T> {
    return this.#attempt(method, 0, 0, fn)
  }

  /**
   * 当前区块号。优先问上次 getLogs 成功的节点（增量扫描时区块号和日志来自同一个节点，不会因节点间的高度差漏扫）；
   * 不支持 getBlockNumber 的节点跳过，失败也不让节点进入冷却（不影响 call / getBalance）
   */
  async getBlockNumber(): Promise<number> {
    if (this.#nodes.length === 1) {
      const node = this.#nodes[0] as EthersLikeProvider
      if (!node.getBlockNumber) {
        throw new Error('getBlockNumber is not supported by this provider')
      }
      return this.#single('getBlockNumber', (n) => (n.getBlockNumber as () => Promise<number>)())
    }
    let lastError: unknown = new Error('No node supports getBlockNumber')
    let attempt = 0
    for (const index of this.#preferLogsNode(this.#order())) {
      const node = this.#nodes[index] as EthersLikeProvider
      if (!node.getBlockNumber) {
        continue
      }
      try {
        return await this.#attempt('getBlockNumber', index, attempt++, (n) => (n.getBlockNumber as () => Promise<number>)())
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
    type GetLogs = NonNullable<EthersLikeProvider['getLogs']>
    if (this.#nodes.length === 1) {
      // 单节点：原样请求、抛原始错误（与不经过 FallbackRpc 时一致）
      if (!this.#nodes[0]?.getLogs) {
        throw new Error('getLogs is not supported by this provider')
      }
      return this.#single('getLogs', (n) => (n.getLogs as GetLogs)(filter))
    }
    const errors: unknown[] = []
    let preferred: unknown
    const sticky = this.#logsNode
    let attempt = 0
    for (const index of this.#preferLogsNode(this.#order(this.#logsFailedAt))) {
      const node = this.#nodes[index] as EthersLikeProvider
      if (!node.getLogs) {
        continue
      }
      try {
        const logs = await this.#attempt('getLogs', index, attempt++, (n) => (n.getLogs as GetLogs)(filter))
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

  /**
   * 按顺序请求节点：出错（非确定性错误）或超时立即换下一个；设置了 stallTimeout 时，
   * 当前节点超过 stallTimeout 还没返回也会同时请求下一个（已发出的请求不取消），第一个成功的结果胜出。
   * 出错的节点进入冷却；超时只换节点，同一节点连续 3 次超时才冷却（冷启动的大批量查询偶尔慢，不应把健康的节点踢到后面）；
   * 节点还没有请求的区块（minBlock 重查时落后的节点）也只换节点、不冷却。
   * 确定性错误（revert、参数错误等）直接抛出；所有节点都失败时抛 AllNodesFailedError（单节点时抛原始错误）。
   */
  #run<T>(method: string, fn: (node: EthersLikeProvider) => Promise<T>, maxInvalid = Number.POSITIVE_INFINITY): Promise<T> {
    const order = this.#order()
    let invalid = 0
    return new Promise<T>((resolve, reject) => {
      let next = 0
      let running = 0
      let settled = false
      /** 正在进行的请求（按发出顺序）：有节点胜出时，比它先发出、还没返回的节点记一次“慢” */
      const inFlight: Array<{ index: number; attempt: number }> = []
      const done = (index: number) => inFlight.splice(inFlight.findIndex((f) => f.index === index), 1)
      const errors: Array<{ node: string; error: unknown }> = []
      let stallTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (done: () => void) => {
        settled = true
        clearTimeout(stallTimer)
        done()
      }
      const fail = () => {
        const only = errors.length === 1 && this.#nodes.length === 1
        finish(() => reject(only ? errors[0]?.error : new AllNodesFailedError(errors)))
      }
      const launch = (): boolean => {
        if (settled || next >= order.length) {
          return false
        }
        const attempt = next++
        const index = order[attempt] as number
        const health = this.#health(index)
        running++
        inFlight.push({ index, attempt })
        clearTimeout(stallTimer)
        if (this.#stallTimeout > 0 && next < order.length) {
          stallTimer = setTimeout(launch, this.#stallTimeout)
        }
        this.#attempt(method, index, attempt, fn).then(
          (result) => {
            running--
            done(index)
            health.failedAt = 0
            health.timeouts = 0
            health.behindAt = 0 // 已经能给出结果：不再因为之前落后而排到后面
            if (!settled) {
              health.slowAt = 0
              // 先发出却还没返回的节点输掉了竞争：记一次慢，冷却期内排在健康节点之后（之后返回成功也不清除）
              inFlight.filter((f) => f.attempt < attempt).forEach((f) => (this.#health(f.index).slowAt = Date.now()))
              finish(() => resolve(result))
            }
          },
          (err: unknown) => {
            running--
            done(index)
            const deterministic = isDeterministic(err)
            if (err instanceof TimeoutError) {
              if (++health.timeouts >= TIMEOUTS_BEFORE_COOLDOWN) {
                health.failedAt = Date.now()
                health.timeouts = 0
              }
            } else if (err instanceof NodeBehindError || isBehind(err)) {
              // 落后（结果早于 minBlock，或对按区块号的查询报“区块不存在”）不算故障、不冷却，
              // 只在几秒内排到健康节点之后：紧接着的查询先问别的节点
              health.behindAt = Date.now()
            } else if (!deterministic && !(err instanceof InvalidResultError) && !isNullResult(err)) {
              health.failedAt = Date.now()
            }
            if (settled) {
              return
            }
            if (deterministic) {
              finish(() => reject(err))
              return
            }
            errors.push({ node: this.#labels[index] as string, error: err })
            // 结果没通过校验的节点够数了（已能确认是合约本身的问题）：不再换节点，等进行中的请求结束
            const enough = err instanceof InvalidResultError && ++invalid >= maxInvalid
            if ((enough || !launch()) && running === 0) {
              fail()
            }
          },
        )
        return true
      }
      launch()
    })
  }

  /**
   * 健康的节点按原顺序在前；最近在竞争中输过的慢节点其次；冷却中的按出错时间先后排在最后（全挂时也都会再试一次）。
   * 传入 failedAt 时（getLogs 自己的冷却表）不考虑慢节点
   */
  #order(failedAt?: readonly number[]): number[] {
    const now = Date.now()
    const health = this.#nodes.map((_, i) => this.#health(i))
    const failed = failedAt ?? health.map((h) => h.failedAt)
    const healthy: number[] = []
    const slow: number[] = []
    const cooling: number[] = []
    failed.forEach((at, i) => {
      if (at && now - at < this.#cooldown) {
        cooling.push(i)
      } else if (
        !failedAt &&
        (((health[i] as Health).slowAt && now - (health[i] as Health).slowAt < this.#cooldown) ||
          ((health[i] as Health).behindAt && now - (health[i] as Health).behindAt < BEHIND_DEMOTE))
      ) {
        slow.push(i)
      } else {
        healthy.push(i)
      }
    })
    cooling.sort((a, b) => (failed[a] as number) - (failed[b] as number))
    return [...healthy, ...slow, ...cooling]
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

/**
 * 节点还没有请求的区块（minBlock 按指定区块重查时，落后的节点会这样报错）：只换节点、不冷却——节点本身是健康的，只是慢一两个块
 */
export function isBehind(err: unknown): boolean {
  return BEHIND_RE.test(errorText(err))
}

// 各节点对“还没有这个区块”的报错（2026-10 对内置节点实测）：geth / erigon、Arbitrum 系、X Layer、Mantle、zkSync、Winchain 等
const BEHIND_RE =
  /header not found|unknown block|block not found|block .*not (yet )?(available|found)|requested block .*(ahead|future|above)|after last accepted block|unsupported block number|block is out of range|above the latest|height must be less than or equal to the head|doesn't exist yet|block number .*(exceeds|greater than|higher than)|future block/i

/**
 * 节点返回 result: null（ethers 解析响应时报 INVALID_ARGUMENT，值为 null）：换节点、不冷却。
 * 只认 null——调用方传入 undefined 等非法参数时值是 undefined，仍是确定性错误，不能拿去每个节点重试
 */
function isNullResult(err: unknown): boolean {
  return isError(err, 'INVALID_ARGUMENT') && (err as { value?: unknown }).value === null
}

/** 换节点也不会变的错误：合约执行结果、参数错误、用户拒绝等（节点返回 null 除外，见 isNullResult） */
function isDeterministic(err: unknown): boolean {
  if (isError(err, 'INVALID_ARGUMENT')) {
    return !isNullResult(err)
  }
  return isExecutionError(err) || isError(err, 'ACTION_REJECTED') || isError(err, 'NUMERIC_FAULT')
}
