// 账户读取管线（getMultipleAccounts 分组 / 并发 / 重试）和查询上下文

import { base64 } from '@scure/base'

import { isAddress } from './address.js'
import type { RequestOptions, SlotOptions } from './client.js'
import type { AccountInfo } from './layout.js'
import { AllNodesFailedError, HttpError, RpcError, isBehind, type RpcTransport } from './rpc.js'
import { NetworkMismatchError } from './source.js'
import type { Commitment } from './types.js'
import { mapPool, sleep } from './util.js'

/** 一次查询的上下文：取消、最低 slot，以及读到的 slot（各请求 context.slot 的最小值） */
export interface QueryContext {
  signal?: AbortSignal
  minContextSlot?: number
  slot?: number
}

/** 节点高度不够时的重试间隔与总时长 */
const BEHIND_RETRY_INTERVAL = 500
const BEHIND_RETRY_TIMEOUT = 10_000

export const MAX_ACCOUNTS_PER_REQUEST = 100
/** 同时进行的 getMultipleAccounts 请求数上限 */
const MAX_PARALLEL_ACCOUNT_REQUESTS = 3
/** fetchAccounts 里没能读到（节点问题）的账户 */
export const FAILED = Symbol('failed')

/** 可以降级处理的错误：网络 / HTTP 错误、节点限制（限频、需要 Key 等）、节点不在期望的网络上、所有节点都失败；其他（参数错误、程序 bug）照常抛出 */
export function isRecoverable(err: unknown): boolean {
  return err instanceof HttpError || (err instanceof RpcError && err.nodeFault) || err instanceof NetworkMismatchError || err instanceof AllNodesFailedError
}

interface RawAccount {
  lamports: number | string
  owner: string
  data: [string, string] | string
  executable: boolean
}

function toAccountInfo(address: string, raw: RawAccount | null): AccountInfo | null {
  if (!raw) {
    return null
  }
  const encoded = Array.isArray(raw.data) ? raw.data[0] : raw.data
  return {
    address,
    lamports: BigInt(raw.lamports),
    owner: raw.owner,
    data: base64.decode(encoded),
    executable: raw.executable,
  }
}

/**
 * 账户读取管线：getMultipleAccounts 按 100 个一组、去重、并发池（最多同时 3 个），节点高度不够时等待重试，
 * 记录读到的 slot；tolerant 时节点问题只标记失败。SolanaClient 和余额 / 代币详情模块共用
 */
export class AccountReader {
  constructor(
    readonly transport: RpcTransport,
    readonly commitment: Commitment,
  ) {}

  /** 发给传输层：有 signal 时作为第三个参数传下去（没有时只传两个参数，自定义传输不受影响） */
  send<T>(method: string, params: readonly unknown[] | undefined, signal: AbortSignal | undefined): Promise<T> {
    return signal ? this.transport.request<T>(method, params, { signal }) : this.transport.request<T>(method, params)
  }

  /**
   * 发一个读账户类的请求：params 最后一项是配置对象，传了 minContextSlot 时带上；
   * 节点高度不够（所有节点都落后）时每 500ms 重试，最多约 10 秒；记录返回的 context.slot（取最小值）
   */
  async call<T>(ctx: QueryContext, method: string, params: unknown[]): Promise<T> {
    const last = params[params.length - 1]
    const sent =
      ctx.minContextSlot === undefined ? params : [...params.slice(0, -1), { ...(last as object), minContextSlot: ctx.minContextSlot }]
    const started = Date.now()
    for (;;) {
      try {
        const res = await this.send<T>(method, sent, ctx.signal)
        const slot = (res as { context?: { slot?: unknown } } | null)?.context?.slot
        if (typeof slot === 'number') {
          ctx.slot = ctx.slot === undefined ? slot : Math.min(ctx.slot, slot)
        }
        return res
      } catch (err) {
        if (ctx.minContextSlot === undefined || !isBehind(err) || Date.now() - started + BEHIND_RETRY_INTERVAL > BEHIND_RETRY_TIMEOUT) {
          throw err
        }
        await sleep(BEHIND_RETRY_INTERVAL, ctx.signal)
      }
    }
  }

  async accounts(addresses: readonly string[], ctx: QueryContext): Promise<(AccountInfo | null)[]> {
    const fetched = await this.fetchAccounts(addresses, false, ctx)
    return addresses.map((address) => (fetched.get(address) as AccountInfo | null | undefined) ?? null)
  }

  /**
   * 只读 lamports（主币余额）：getMultipleAccounts 带 dataSlice { offset: 0, length: 0 }，不读回账户数据——
   * 钱包可能是数据很大的程序账户（上百 KB），整份读回会拖慢甚至超时。结果与 addresses 一一对应，账户不存在或地址非法时为 null
   */
  async lamports(addresses: readonly string[], ctx: QueryContext): Promise<(bigint | null)[]> {
    const [fetched] = await this.fetchGroups([{ addresses, lamportsOnly: true }], false, ctx)
    return addresses.map((address) => (fetched?.get(address) as AccountInfo | null | undefined)?.lamports ?? null)
  }

  /** getMultipleAccounts（读账户数据）：见 fetchGroups */
  async fetchAccounts(
    addresses: readonly string[],
    tolerant: boolean,
    ctx: QueryContext,
    failure?: { error?: unknown },
  ): Promise<Map<string, AccountInfo | null | typeof FAILED>> {
    const [fetched] = await this.fetchGroups([{ addresses, lamportsOnly: false }], tolerant, ctx, failure)
    return fetched as Map<string, AccountInfo | null | typeof FAILED>
  }

  /**
   * getMultipleAccounts：每组去重、按 100 个一组拆分，所有组的请求放进并发池，最多同时 3 个（一个结束就发下一个，不必等同一波里最慢的）。
   * lamportsOnly 的组带 dataSlice（长度 0，对同一请求里的所有账户生效，所以只要 lamports 的账户要单独成组）。
   * tolerant 为 true 时，某个请求因节点问题（网络、限频等）失败不抛错：该请求的账户标记为 FAILED，并且不再发后面的请求（节点已经在限频了），
   * 第一个这样的错误记在 failure.error；否则第一个错误抛出，后面的请求也不再发。结果按组返回
   */
  async fetchGroups(
    groups: ReadonlyArray<{ addresses: readonly string[]; lamportsOnly: boolean }>,
    tolerant: boolean,
    ctx: QueryContext,
    failure?: { error?: unknown },
  ): Promise<Array<Map<string, AccountInfo | null | typeof FAILED>>> {
    const chunks: Array<{ group: number; addresses: string[]; lamportsOnly: boolean }> = []
    groups.forEach(({ addresses, lamportsOnly }, group) => {
      const unique = [...new Set(addresses.filter((a) => isAddress(a)))]
      for (let i = 0; i < unique.length; i += MAX_ACCOUNTS_PER_REQUEST) {
        chunks.push({ group, addresses: unique.slice(i, i + MAX_ACCOUNTS_PER_REQUEST), lamportsOnly })
      }
    })
    const results = groups.map(() => new Map<string, AccountInfo | null | typeof FAILED>())
    // 出错后不再发后面的请求
    let stopped = false
    // 并发池最先发出的几个请求在同一 tick（合并成一个 JSON-RPC 批量请求）
    await mapPool(chunks, MAX_PARALLEL_ACCOUNT_REQUESTS, async (chunk) => {
      const result = results[chunk.group] as Map<string, AccountInfo | null | typeof FAILED>
      if (stopped) {
        chunk.addresses.forEach((address) => result.set(address, FAILED))
        return
      }
      // 已取消的查询不再发后面的请求
      if (ctx.signal?.aborted) {
        throw ctx.signal.reason
      }
      try {
        const res = await this.call<{ value: Array<RawAccount | null> }>(ctx, 'getMultipleAccounts', [
          chunk.addresses,
          { encoding: 'base64', commitment: this.commitment, ...(chunk.lamportsOnly ? { dataSlice: { offset: 0, length: 0 } } : {}) },
        ])
        chunk.addresses.forEach((address, j) => result.set(address, toAccountInfo(address, res?.value?.[j] ?? null)))
      } catch (err) {
        stopped = true
        if (!tolerant || !isRecoverable(err)) {
          throw err
        }
        if (failure && !('error' in failure)) {
          failure.error = err
        }
        chunk.addresses.forEach((address) => result.set(address, FAILED))
      }
    })
    return results
  }
}

/** 结果项带上 slot（传了 withSlot / minContextSlot，且这次查询发了请求时） */
export function attachSlot<T extends object>(items: T[], ctx: QueryContext, options: SlotOptions): T[] {
  if ((!options.withSlot && options.minContextSlot === undefined) || ctx.slot === undefined) {
    return items
  }
  const slot = ctx.slot
  return items.map((item) => ({ ...item, slot }))
}

export function queryContext(options: RequestOptions & SlotOptions): QueryContext {
  return { signal: options.signal, minContextSlot: options.minContextSlot }
}
