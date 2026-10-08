import { errorText, GetLogsError } from './fallback.js'
import type { DiscoveredToken, TokenSource } from './owner.js'
import { isTronChain } from './source.js'

/** ERC20 / ERC721 的 Transfer(address,address,uint256) 事件 */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** 增量扫描的进度，按 chainId + 地址保存 */
export interface TransferScanState {
  /** 第一个扫描的区块（之前的历史不扫描） */
  startBlock: number
  /** 已扫描到的区块号（含）；第一次调用且 lookbackBlocks 为 0 时等于 startBlock - 1 */
  cursor: number
  /** 扫描中发现的代币合约地址（小写） */
  tokens: string[]
  /** 当前使用的单次查询区块范围：出错时缩小，连续成功后翻倍，直到 rangeLimit / blockRange 选项 */
  blockRange: number
  /** 节点的区块范围上限（报错里给出的，或减半试出来的），记录 1 天后失效，之后会重新试更大的范围 */
  rangeLimit?: number
  /** rangeLimit 的记录时间（毫秒时间戳） */
  rangeLimitAt?: number
  /** 节点不开放 getLogs 时，在这个时间之前不再尝试（毫秒时间戳） */
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
        return raw ? (JSON.parse(raw) as TransferScanState) : undefined // 格式在读取后校验
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
  /** 单次 getLogs 的最大区块范围，默认 1000；节点有上限时自动缩小 */
  blockRange?: number
  /** 每次调用最多发多少个 getLogs 请求，默认 20；落后很多时分多次追上 */
  maxRequests?: number
  /** 每次调用的扫描时间预算（毫秒），默认 5000：超过后不再发新请求，留到下次调用 */
  timeBudget?: number
  /** 只扫到最新区块往前这么多个区块，默认 5：避开链重组，也避免节点之间高度不一致时漏扫 */
  confirmations?: number
}

const defaultStorage = memoryScanStorage()

/** 节点不开放 getLogs 时，暂停多久再试 */
const PAUSE_ON_UNSUPPORTED = 10 * 60 * 1000
/** 记下的区块范围上限多久后失效（节点可能换了 / 调整了限制） */
const RANGE_LIMIT_TTL = 24 * 60 * 60 * 1000
/** 连续成功多少次后把范围翻倍 */
const GROW_AFTER = 2

type ErrorKind = 'transient' | 'range' | 'unsupported' | 'other'

/** 按节点返回的错误信息分类 */
function kindOf(text: string): ErrorKind {
  if (/too many|rate.?limit|429|temporarily|unavailable|busy|timed? ?out|timeout|network|ECONN|ENOTFOUND|socket|fetch failed|missing response|bad response|50[234]|quota|credits|compute units/i.test(text)) {
    return 'transient' // 限频 / 超时 / 连不上：换个时间重试即可
  }
  if (/range|too (?:large|wide|big)|exceed|query returned more than|more than \d+ (?:results|logs)|response size|block limit/i.test(text)) {
    return 'range'
  }
  if (/method not found|-32601|not supported|unsupported|not available|does not exist|not (?:allowed|enabled|whitelisted)|disabled/i.test(text)) {
    return 'unsupported'
  }
  return 'other'
}

/** 每个节点的错误；GetLogsError 里没有错误表示没有节点支持 getLogs */
function errorTexts(err: unknown): string[] {
  if (err instanceof GetLogsError) {
    return err.errors.length ? err.errors.map(errorText) : ['getLogs is not supported']
  }
  return [errorText(err)]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 从错误信息里找区块范围上限，如 “log query range must not exceed 25 blocks”“maximum block range: 5000” */
function parseRangeLimit(texts: string[]): number | null {
  let best: number | null = null
  for (const raw of texts) {
    const text = raw.replace(/(\d),(?=\d{3}\b)/g, '$1') // 10,000 → 10000
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

const isInt = (value: unknown, min: number): value is number => Number.isSafeInteger(value) && (value as number) >= min
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** 校验存储里读出的进度：格式不对（旧版本 / 被改坏）时丢弃，重新开始 */
function parseState(raw: unknown): TransferScanState | undefined {
  const s = raw as Partial<Record<keyof TransferScanState, unknown>> | null
  if (!s || typeof s !== 'object' || !isInt(s.startBlock, 0) || !isInt(s.cursor, -1) || !isInt(s.blockRange, 1) || !Array.isArray(s.tokens)) {
    return undefined
  }
  if (!s.tokens.every((t) => typeof t === 'string' && /^0x[0-9a-fA-F]{40}$/.test(t))) {
    return undefined
  }
  return {
    startBlock: s.startBlock,
    cursor: s.cursor,
    tokens: (s.tokens as string[]).map((t) => t.toLowerCase()),
    blockRange: s.blockRange,
    ...(isInt(s.rangeLimit, 1) && isTime(s.rangeLimitAt) ? { rangeLimit: s.rangeLimit, rangeLimitAt: s.rangeLimitAt } : {}),
    ...(isTime(s.pausedUntil) ? { pausedUntil: s.pausedUntil } : {}),
  }
}

async function loadState(storage: TransferScanStorage, key: string): Promise<TransferScanState | undefined> {
  try {
    return parseState(await storage.get(key))
  } catch {
    return undefined
  }
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
  const lookback = Math.max(0, Math.floor(options.lookbackBlocks ?? 0))
  const maxRange = Math.max(1, Math.floor(options.blockRange ?? 1000))
  const maxRequests = Math.max(1, options.maxRequests ?? 20)
  const timeBudget = options.timeBudget ?? 5000
  const confirmations = Math.max(0, Math.floor(options.confirmations ?? 5))
  return {
    name: 'transfers',
    async discover({ chainId, owner, provider }) {
      if (!provider || isTronChain(chainId) || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
        return null
      }
      const key = `${chainId}:${owner.toLowerCase()}`
      const saved = await loadState(storage, key)
      const toResult = (state: TransferScanState | undefined): DiscoveredToken[] => (state?.tokens ?? []).map((address) => ({ address }))
      if (saved?.pausedUntil && Date.now() < saved.pausedUntil) {
        return toResult(saved)
      }

      const startedAt = Date.now()
      let target: number
      try {
        target = (await provider.getBlockNumber()) - confirmations
      } catch {
        return saved ? toResult(saved) : null // 节点不支持 / 暂时不可用：返回已发现的代币
      }
      const now = Date.now()
      let state: TransferScanState
      if (saved) {
        state = { ...saved, tokens: [...saved.tokens] }
        delete state.pausedUntil
        if (state.rangeLimitAt !== undefined && now - state.rangeLimitAt > RANGE_LIMIT_TTL) {
          delete state.rangeLimit
          delete state.rangeLimitAt
        }
      } else {
        const cursor = Math.max(-1, target - lookback)
        state = { startBlock: cursor + 1, cursor, tokens: [], blockRange: maxRange }
      }
      const tokens = new Set(state.tokens)
      const ownerTopic = `0x${owner.slice(2).toLowerCase().padStart(64, '0')}`
      const cap = () => Math.min(maxRange, state.rangeLimit ?? maxRange)
      const setLimit = (limit: number) => {
        state.rangeLimit = limit
        state.rangeLimitAt = Date.now()
      }
      let range = Math.min(state.blockRange, cap())
      let successes = 0
      let transient = 0

      for (let requests = 0; requests < maxRequests && state.cursor < target; requests++) {
        if (timeBudget > 0 && Date.now() - startedAt >= timeBudget) {
          break // 超出时间预算，留到下次调用
        }
        const fromBlock = state.cursor + 1
        const toBlock = Math.min(target, fromBlock + range - 1)
        try {
          const logs = await provider.getLogs({ fromBlock, toBlock, topics: [TRANSFER_TOPIC, null, ownerTopic] })
          for (const log of logs) {
            // ERC20 的 Transfer 有 3 个 topic；ERC721 的 tokenId 也是 indexed，有 4 个，排除
            if (log.topics.length === 3) {
              tokens.add(log.address.toLowerCase())
            }
          }
          state.cursor = toBlock
          transient = 0
          if (++successes >= GROW_AFTER && range < cap()) {
            range = Math.min(cap(), range * 2) // 之前缩小过（偶发错误 / 换了节点）：逐步放大回去
            successes = 0
          }
        } catch (err) {
          successes = 0
          const texts = errorTexts(err)
          const kinds = texts.map(kindOf)
          // 上次成功的节点这次的错误最能说明问题（其他节点可能一直就不能用，它们的报错不代表当前范围有问题）
          const preferred = err instanceof GetLogsError && err.preferred !== undefined ? kindOf(errorText(err.preferred)) : undefined
          const limit = parseRangeLimit(texts)
          if (limit !== null && limit < range) {
            range = limit // 节点明确给了范围上限
            setLimit(limit)
          } else if (kinds.every((k) => k === 'unsupported')) {
            // 所有节点都不开放 getLogs：暂停一段时间，避免每次调用都白发请求
            state.pausedUntil = Date.now() + PAUSE_ON_UNSUPPORTED
            break
          } else if (preferred === 'transient' || (preferred === undefined && kinds.every((k) => k === 'transient' || k === 'unsupported'))) {
            // 在用的节点只是限频 / 超时：不缩小范围，退避后重试；连续 3 次就留到下次调用
            const remaining = timeBudget > 0 ? timeBudget - (Date.now() - startedAt) : Infinity
            if (++transient >= 3 || remaining <= 0) {
              break
            }
            await sleep(Math.min(500 * transient, remaining))
          } else if (range > 1) {
            range = Math.max(1, Math.floor(range / 2)) // 范围超限但没说上限：减半再试
            setLimit(range)
          } else {
            state.pausedUntil = Date.now() + PAUSE_ON_UNSUPPORTED // 连 1 个区块都查不了
            break
          }
        }
      }
      state.blockRange = range
      state.tokens = [...tokens]
      try {
        await storage.set(key, state)
      } catch {
        // 存储不可用：只影响下次能否接着扫
      }
      return toResult(state)
    },
  }
}

/** 读取某地址的扫描进度（不存在时为 undefined） */
export async function getTransferScanState(chainId: number, owner: string, storage: TransferScanStorage = defaultStorage): Promise<TransferScanState | undefined> {
  return loadState(storage, `${chainId}:${owner.toLowerCase()}`)
}

