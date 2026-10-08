import { errorText, GetLogsError } from './fallback.js'
import type { DiscoveredToken, TokenSource } from './owner.js'
import { isTronChain } from './source.js'

/** ERC20 / ERC721 的 Transfer(address,address,uint256) 事件 */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** 增量扫描的进度，按 chainId + 地址保存 */
export interface TransferScanState {
  /** 第一次调用时的区块号（之前的历史不扫描） */
  startBlock: number
  /** 已扫描到的区块号（含） */
  cursor: number
  /** 扫描中发现的代币合约地址（小写） */
  tokens: string[]
  /** 当前使用的单次查询区块范围（节点有上限时会缩小） */
  blockRange: number
  /** 成功过的最大区块范围：之后遇到临时错误（限频等）不会缩到它以下 */
  verifiedRange?: number
  /** 连单个区块都查不了时，在这个时间之前不再尝试（毫秒时间戳） */
  pausedUntil?: number
}

/** 进度存储：默认存在内存里；传自定义存储可以跨页面刷新 / 重启接着扫（如 localStorage、数据库） */
export interface TransferScanStorage {
  get(key: string): TransferScanState | undefined | Promise<TransferScanState | undefined>
  set(key: string, state: TransferScanState): void | Promise<void>
}

/** 内存存储（默认）：最多保存 1000 个地址，超出时淘汰最早的 */
export function memoryScanStorage(limit = 1000): TransferScanStorage {
  const map = new Map<string, TransferScanState>()
  return {
    get: (key) => map.get(key),
    set: (key, state) => {
      map.delete(key)
      map.set(key, state)
      if (map.size > limit) {
        map.delete(map.keys().next().value as string)
      }
    },
  }
}

/**
 * 基于 getItem / setItem 的存储（如浏览器的 localStorage）：
 * `transferScan({ storage: keyValueScanStorage(localStorage) })`
 */
export function keyValueScanStorage(store: { getItem(key: string): string | null; setItem(key: string, value: string): void }, prefix = 'w3lib:transfer-scan:'): TransferScanStorage {
  return {
    get: (key) => {
      try {
        const raw = store.getItem(prefix + key)
        return raw ? (JSON.parse(raw) as TransferScanState) : undefined
      } catch {
        return undefined
      }
    },
    set: (key, state) => {
      try {
        store.setItem(prefix + key, JSON.stringify(state))
      } catch {
        // 存储满或不可用：只影响下次能否接着扫
      }
    },
  }
}

export interface TransferScanOptions {
  /** 进度存储，默认内存（进程 / 页面结束就丢失） */
  storage?: TransferScanStorage
  /** 第一次调用时往回扫多少个区块，默认 0（只从现在开始往后扫） */
  lookbackBlocks?: number
  /** 单次 getLogs 的区块范围，默认 1000；节点有上限时自动缩小并记住 */
  blockRange?: number
  /** 每次调用最多发多少个 getLogs 请求，默认 20；落后很多时分多次追上 */
  maxRequests?: number
}

const defaultStorage = memoryScanStorage()

/** 节点连 1 个区块都查不了时，暂停多久再试 */
const PAUSE_ON_UNSUPPORTED = 10 * 60 * 1000

/** 限频 / 暂时不可用这类临时错误：换个时间重试即可，不应缩小查询范围 */
function isTransient(err: unknown): boolean {
  const texts = err instanceof GetLogsError ? err.errors.map(errorText) : [errorText(err)]
  return texts.some((t) => /too many|rate.?limit|429|temporarily|unavailable|busy|timed? ?out|timeout/i.test(t))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 从错误信息里找区块范围上限，如 “log query range must not exceed 25 blocks”“maximum block range: 5000” */
function parseRangeLimit(err: unknown): number | null {
  const texts = err instanceof GetLogsError ? err.errors.map(errorText) : [errorText(err)]
  let best: number | null = null
  for (const text of texts) {
    const match =
      /(?:exceed|maximum|max|limit(?:ed)? (?:of|to)?|up to|range)[^\d]{0,40}?(\d{1,7})\s*blocks?/i.exec(text) ??
      /(\d{1,7})\s*blocks?[^.]{0,20}(?:range|limit|maximum)/i.exec(text) ??
      /block range[^\d]{0,20}(\d{1,7})/i.exec(text)
    const n = match ? Number(match[1]) : NaN
    if (Number.isInteger(n) && n > 0 && (best === null || n > best)) {
      best = n // 多个节点给了不同上限时取最大的（能用的节点里最宽松的那个）
    }
  }
  return best
}

/**
 * 增量扫描地址收到的 ERC20 代币（Transfer 事件，to = 该地址）：第一次调用记下当前区块，之后每次从上次的位置往后扫。
 * 用来补充代币列表发现不了的新代币。作为代币来源使用：`combine(defaultTokenSource(), transferScan())`，
 * 或在 getOwnerTokens 里用 `scanTransfers: true`。
 *
 * 局限：只能发现开始扫描之后收到的代币（除非设置 lookbackBlocks）；需要节点支持 eth_getLogs，免费公共节点限制较多
 *（BSC 上只有 blockrazor 可用且每次最多 25 个区块）；Tron 不支持。
 */
export function transferScan(options: TransferScanOptions = {}): TokenSource {
  const storage = options.storage ?? defaultStorage
  const lookback = Math.max(0, options.lookbackBlocks ?? 0)
  const initialRange = Math.max(1, options.blockRange ?? 1000)
  const maxRequests = Math.max(1, options.maxRequests ?? 20)
  return {
    name: 'transfers',
    async discover({ chainId, owner, provider }) {
      if (!provider || isTronChain(chainId) || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
        return null
      }
      const key = `${chainId}:${owner.toLowerCase()}`
      const saved = await storage.get(key)
      const toResult = (state: TransferScanState | undefined): DiscoveredToken[] => (state?.tokens ?? []).map((address) => ({ address }))
      if (saved?.pausedUntil && Date.now() < saved.pausedUntil) {
        return toResult(saved)
      }

      let latest: number
      try {
        latest = await provider.getBlockNumber()
      } catch {
        return saved ? toResult(saved) : null // 节点不支持 / 暂时不可用：返回已发现的代币
      }
      const state: TransferScanState = saved
        ? { ...saved, tokens: [...saved.tokens], pausedUntil: undefined }
        : { startBlock: Math.max(0, latest - lookback), cursor: Math.max(-1, latest - lookback), tokens: [], blockRange: initialRange }
      const tokens = new Set(state.tokens)
      const ownerTopic = `0x${owner.slice(2).toLowerCase().padStart(64, '0')}`
      let range = Math.min(state.blockRange || initialRange, initialRange)
      let consecutiveTransient = 0

      for (let requests = 0; requests < maxRequests && state.cursor < latest; requests++) {
        const fromBlock = state.cursor + 1
        const toBlock = Math.min(latest, fromBlock + range - 1)
        try {
          const logs = await provider.getLogs({ fromBlock, toBlock, topics: [TRANSFER_TOPIC, null, ownerTopic] })
          for (const log of logs) {
            // ERC20 的 Transfer 有 3 个 topic；ERC721 的 tokenId 也是 indexed，有 4 个，排除
            if (log.topics.length === 3) {
              tokens.add(log.address.toLowerCase())
            }
          }
          state.cursor = toBlock
          state.verifiedRange = Math.max(state.verifiedRange ?? 0, toBlock - fromBlock + 1)
          consecutiveTransient = 0
        } catch (err) {
          const limit = parseRangeLimit(err)
          if (limit !== null && limit < range) {
            range = limit // 节点明确给了范围上限
          } else if (isTransient(err) || (state.verifiedRange !== undefined && range <= state.verifiedRange)) {
            // 限频等临时错误（或在成功过的范围内出错）：不缩小范围，退避后重试；连续 3 次就留到下次调用
            if (++consecutiveTransient >= 3) {
              break
            }
            await sleep(500 * consecutiveTransient)
          } else if (range > 1) {
            range = Math.max(1, Math.floor(range / 2))
          } else {
            // 连 1 个区块都查不了：节点不开放 getLogs，暂停一段时间，避免每次调用都白发请求
            state.pausedUntil = Date.now() + PAUSE_ON_UNSUPPORTED
            break
          }
        }
      }
      state.blockRange = range
      state.tokens = [...tokens]
      await storage.set(key, state)
      return toResult(state)
    },
  }
}

/** 读取某地址的扫描进度（不存在时为 undefined） */
export async function getTransferScanState(chainId: number, owner: string, storage: TransferScanStorage = defaultStorage): Promise<TransferScanState | undefined> {
  return storage.get(`${chainId}:${owner.toLowerCase()}`)
}

