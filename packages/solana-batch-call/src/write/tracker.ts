import { sleep } from '../util.js'
import type { Chain } from './chain.js'

interface SignatureStatus {
  slot: number
  err: unknown
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null
}

export type WatchResult = { kind: 'landed'; slot: number; err: unknown } | { kind: 'expired' } | { kind: 'timeout' } | { kind: 'aborted' }

interface Watched {
  signature: string
  raw: string
  /** blockhash 的有效期；Infinity 表示不知道（钱包换了 blockhash），这时不判断过期、不自动重发 */
  lastValidBlockHeight: number
  deadline: number
  polls: number
  resolve(result: WatchResult): void
}

/**
 * 统一轮询所有待确认的交易：一次 getSignatureStatuses 查全部（每 256 个一组），未确认的每两次轮询重发一次，blockhash 过期后再查一次历史确认没上链。
 * 区块高度（getEpochInfo）不是每轮都查：记下上次查到的（高度, slot），之后用状态查询返回的 context.slot 估计高度的上限
 * （高度每个 slot 最多加 1），估计值超过某笔交易的 lastValidBlockHeight 时才查，确认过期
 */
export class Tracker {
  readonly #watched = new Set<Watched>()
  #running = false
  /** 上次查到的区块高度和对应的 slot */
  #anchor: { height: number; slot: number } | null = null

  constructor(readonly chain: Chain) {}

  watch(signature: string, raw: string, lastValidBlockHeight: number): Promise<WatchResult> {
    const { timeout = 120_000 } = this.chain.options
    return new Promise((resolve) => {
      this.#watched.add({ signature, raw, lastValidBlockHeight, deadline: Date.now() + timeout, polls: 0, resolve })
      if (!this.#running) {
        this.#running = true
        void this.#loop()
      }
    })
  }

  /** 查交易状态；contextSlot 是各次响应里最小的 context.slot（节点的数据新到哪个 slot），响应没带时为 0 */
  async #statuses(signatures: string[], history: boolean): Promise<{ found: Map<string, SignatureStatus>; contextSlot: number }> {
    const found = new Map<string, SignatureStatus>()
    let contextSlot = Number.POSITIVE_INFINITY
    for (let i = 0; i < signatures.length; i += 256) {
      const chunk = signatures.slice(i, i + 256)
      const res = await this.chain.client.request<{ context?: { slot?: number }; value: Array<SignatureStatus | null> }>('getSignatureStatuses', [
        chunk,
        { searchTransactionHistory: history },
      ])
      contextSlot = Math.min(contextSlot, res.context?.slot ?? 0)
      res.value.forEach((s, k) => s && found.set(chunk[k] as string, s))
    }
    return { found, contextSlot }
  }

  #done(status: SignatureStatus): boolean {
    const level = status.confirmationStatus
    return this.chain.commitment === 'finalized' ? level === 'finalized' : level === 'confirmed' || level === 'finalized'
  }

  #settle(item: Watched, result: WatchResult): void {
    this.#watched.delete(item)
    item.resolve(result)
  }

  /** 是否可能有交易过期了（需要查区块高度确认）：不知道当前高度、或状态查询没带 slot 时总是查 */
  #mayHaveExpired(waiting: readonly Watched[], contextSlot: number): boolean {
    const known = waiting.filter((w) => Number.isFinite(w.lastValidBlockHeight))
    if (!known.length) {
      return false
    }
    if (!this.#anchor || !(contextSlot > 0) || !Number.isFinite(contextSlot)) {
      return true
    }
    const highest = this.#anchor.height + Math.max(0, contextSlot - this.#anchor.slot)
    return known.some((w) => highest > w.lastValidBlockHeight)
  }

  async #loop(): Promise<void> {
    const { pollInterval = 2_000, signal } = this.chain.options
    try {
      while (this.#watched.size) {
        await sleep(pollInterval, signal, false)
        if (signal?.aborted) {
          ;[...this.#watched].forEach((w) => this.#settle(w, { kind: 'aborted' }))
          return
        }
        const items = [...this.#watched]
        try {
          const { found: statuses, contextSlot } = await this.#statuses(
            items.map((w) => w.signature),
            false,
          )
          for (const item of items) {
            const status = statuses.get(item.signature)
            if (status && this.#done(status)) {
              this.#settle(item, { kind: 'landed', slot: status.slot, err: status.err })
            }
          }
          const waiting = items.filter((w) => this.#watched.has(w))
          if (waiting.length && this.#mayHaveExpired(waiting, contextSlot)) {
            // 区块高度和对应的 slot 一起取（同一个节点、同一个时刻）
            const epoch = await this.chain.client.request<{ blockHeight: number; absoluteSlot: number }>('getEpochInfo', [{ commitment: 'confirmed' }])
            this.#anchor = { height: epoch.blockHeight, slot: epoch.absoluteSlot }
            const expired = waiting.filter((w) => epoch.blockHeight > w.lastValidBlockHeight)
            if (expired.length) {
              // 过期了：再查一次历史确认确实没上链。请求可能落到另一个节点（多节点 / 负载均衡），
              // 它的数据必须不早于看到过期的那个 slot，否则可能只是它还没看到这笔交易，这一轮先不判断
              const history = await this.#statuses(
                expired.map((w) => w.signature),
                true,
              )
              const caughtUp = history.contextSlot >= epoch.absoluteSlot
              for (const item of expired) {
                const status = history.found.get(item.signature)
                if (!status) {
                  if (!caughtUp) continue
                  this.#settle(item, { kind: 'expired' })
                } else if (this.#done(status)) {
                  this.#settle(item, { kind: 'landed', slot: status.slot, err: status.err })
                }
              }
            }
          }
        } catch {
          // 节点暂时出错：下次再查
        }
        const now = Date.now()
        for (const item of [...this.#watched]) {
          if (now >= item.deadline) {
            this.#settle(item, { kind: 'timeout' })
          } else if (++item.polls % 2 === 0) {
            // 每两次轮询重发一次（每笔都重发会让待确认交易多时很快触发节点限频）
            void this.chain.broadcast(item.raw).catch(() => {})
          }
        }
      }
    } finally {
      this.#running = false
      if (this.#watched.size) {
        this.#running = true
        void this.#loop()
      }
    }
  }
}
