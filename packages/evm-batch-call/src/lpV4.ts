import { AbiCoder, keccak256 } from 'ethers'

import type { CallOverrides } from './aggregate.js'
import { getAmountsForLiquidity, getFeesEarned, getSqrtRatioAtTick } from './lpMath.js'
import type { Provider } from './provider.js'
import { runLogScan, type LogScanProgress } from './scan.js'

/** Uniswap V4 用到的 LP 协议字段（与 lp.ts 的 LpProtocol 一致，避免循环引用） */
interface V4Protocol {
  id: string
  name: string
  version: 'v2' | 'v3' | 'v4'
  chainId: number
  positionManager?: string
  stateView?: string
  deployBlock?: number
}

/** V4 扫描进度的存储：默认存在内存里；传自定义存储可以跨页面刷新 / 重启接着扫 */
export interface LpScanStorage {
  get(key: string): LogScanProgress | undefined | Promise<LogScanProgress | undefined>
  set(key: string, state: LogScanProgress): void | Promise<void>
}

/** 内存存储：最多保存 1000 组进度，超出淘汰最早的 */
export function memoryLpScanStorage(limit = 1000): LpScanStorage {
  const map = new Map<string, LogScanProgress>()
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

/** 基于 getItem / setItem 的存储（如 localStorage）：`v4: { scan: { storage: keyValueLpScanStorage(localStorage) } }` */
export function keyValueLpScanStorage(store: { getItem(key: string): string | null; setItem(key: string, value: string): void }, prefix = 'w3lib:lp-v4-scan:'): LpScanStorage {
  return {
    get: (key) => {
      try {
        const raw = store.getItem(prefix + key)
        return raw ? (JSON.parse(raw) as LogScanProgress) : undefined // 格式在读取后校验
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

export interface V4ScanOptions {
  /** 进度存储，默认内存（进程 / 页面结束就丢失） */
  storage?: LpScanStorage
  /**
   * 第一次扫描从哪个区块开始：数字；'deployment' 从仓位合约部署的区块开始（扫全部历史；
   * 自定义协议没有 deployBlock 时等同于 'latest'）；'latest' 从现在开始（只能发现之后的新仓位）。默认 'deployment'
   */
  fromBlock?: number | 'deployment' | 'latest'
  /** 单次 getLogs 的最大区块范围，默认 10000（只查仓位合约的事件，节点一般允许较大的范围）；节点有上限时自动缩小 */
  blockRange?: number
  /** 每次调用最多发多少个 getLogs，默认 20 */
  maxRequests?: number
  /** 每次调用的扫描时间预算（毫秒），默认 5000 */
  timeBudget?: number
  /** 只扫到最新区块往前这么多个区块，默认 5。不要设为 0：刚出的区块可能被重组，扫到的仓位核对时“不存在”会被从进度里去掉 */
  confirmations?: number
  /**
   * 每次扫描后的进度：cursor 是已扫到的区块，target 是这次的目标区块，done 表示已扫到最新。
   * 没扫完之前 V4 的结果不完整（从 fromBlock 往后扫，最近铸造的仓位最后才扫到），可以据此提示用户或继续调用
   */
  onProgress?(progress: V4ScanProgress): void
}

export interface V4ScanProgress {
  chainId: number
  positionManager: string
  startBlock: number
  cursor: number
  /**
   * 这次的目标区块；没扫（暂停中、拿不到最新区块）时为 null。
   * 触发暂停的那一次照常有 target，同时带 pausedUntil；第一次就拿不到最新区块时 startBlock / cursor 为 -1
   */
  target: number | null
  done: boolean
  /** 节点不开放 getLogs 时暂停到这个时间（毫秒时间戳），之前的调用不再扫描 */
  pausedUntil?: number
}

export interface LpV4Options {
  /** 已知的仓位 tokenId（如应用自己记下的）：直接查，不用扫描 */
  tokenIds?: ReadonlyArray<string | number | bigint>
  /**
   * 扫描仓位合约发给这个地址的 NFT（Transfer 事件）来发现仓位。V4 的仓位合约不能按地址列出 NFT，只能这样找。
   * 需要节点支持 eth_getLogs；扫全部历史在公共节点上很慢（每次调用推进一段，进度可以存起来），建议用自己的节点。默认不扫描
   */
  scan?: boolean | V4ScanOptions
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
/** PoolKey.fee 的最高位：动态手续费池子（实际手续费看 slot0 的 lpFee） */
const DYNAMIC_FEE_FLAG = 0x800000

const POSITION_MANAGER_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
]
const STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)',
  'function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
]

const defaultStorage = memoryLpScanStorage()

/** int24 的补码 → number */
function int24(value: bigint): number {
  const n = Number(value & 0xffffffn)
  return n >= 0x800000 ? n - 0x1000000 : n
}

/** PositionInfo（uint256）：| 200 位 poolId | 24 位 tickUpper | 24 位 tickLower | 8 位 hasSubscriber | */
export function decodePositionInfo(info: bigint): { tickLower: number; tickUpper: number } {
  return { tickLower: int24(info >> 8n), tickUpper: int24(info >> 32n) }
}

/** poolId = keccak256(abi.encode(PoolKey)) */
export function poolIdOf(key: { currency0: string; currency1: string; fee: number | bigint; tickSpacing: number | bigint; hooks: string }): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]),
  )
}

const isProgress = (raw: unknown): raw is LogScanProgress => {
  const s = raw as Partial<LogScanProgress> | null
  return (
    !!s &&
    typeof s === 'object' &&
    Number.isSafeInteger(s.startBlock) &&
    Number.isSafeInteger(s.cursor) &&
    Number.isSafeInteger(s.blockRange) &&
    (s.blockRange as number) >= 1 &&
    Array.isArray(s.items) &&
    s.items.every((t) => typeof t === 'string' && /^\d+$/.test(t))
  )
}

/** 扫描仓位合约发给 owner 的 NFT，返回扫描到的 tokenId（之后再核对是否仍归 owner） */
async function scanTokenIds(
  provider: Provider,
  chainId: number,
  protocol: V4Protocol,
  owner: string,
  options: V4ScanOptions,
  signal: AbortSignal | undefined,
): Promise<{ ids: string[]; cursor: number; prune(ids: readonly string[]): Promise<void> }> {
  const storage = options.storage ?? defaultStorage
  const key = `${chainId}:${(protocol.positionManager as string).toLowerCase()}:${owner.toLowerCase()}`
  let saved: LogScanProgress | undefined
  try {
    const raw = await storage.get(key)
    saved = isProgress(raw) ? raw : undefined // 格式不对（旧版本 / 被改坏）时丢弃，重新开始
  } catch {
    saved = undefined
  }
  const fromBlock = options.fromBlock ?? 'deployment'
  const ownerTopic = `0x${owner.slice(2).toLowerCase().padStart(64, '0')}`
  let reported = false
  const report = (state: LogScanProgress, target: number | null) => {
    reported = true
    try {
      options.onProgress?.({
        chainId,
        positionManager: protocol.positionManager as string,
        startBlock: state.startBlock,
        cursor: state.cursor,
        target,
        done: target !== null && state.cursor >= target,
        ...(state.pausedUntil ? { pausedUntil: state.pausedUntil } : {}),
      })
    } catch {
      // 回调出错不影响扫描和保存进度
    }
  }
  const progress = await runLogScan({
    provider,
    saved,
    initialCursor: (target) =>
      typeof fromBlock === 'number' ? fromBlock - 1 : fromBlock === 'deployment' && protocol.deployBlock !== undefined ? protocol.deployBlock - 1 : target,
    filter: { address: protocol.positionManager as string, topics: [TRANSFER_TOPIC, null, ownerTopic] },
    // ERC721 的 Transfer：第 4 个 topic 是 tokenId
    collect: (log) => (log.topics.length === 4 ? BigInt(log.topics[3] as string).toString() : null),
    maxRange: Math.max(1, Math.floor(options.blockRange ?? 10_000)),
    maxRequests: Math.max(1, options.maxRequests ?? 20),
    timeBudget: options.timeBudget ?? 5000,
    confirmations: Math.max(0, Math.floor(options.confirmations ?? 5)),
    signal,
    onDone: report,
  })
  if (!progress) {
    // 第一次扫描就拿不到最新区块：也告诉调用方（还没开始，没有进度）
    report({ startBlock: -1, cursor: -1, items: [], blockRange: 0 }, null)
    return { ids: [], cursor: -1, prune: async () => {} }
  }
  if (!reported) {
    report(progress, null) // 暂停中 / 拿不到最新区块：这次没扫，也告诉调用方
  }
  const save = async (state: LogScanProgress) => {
    try {
      await storage.set(key, state)
    } catch {
      // 存储不可用：只影响下次能否接着扫
    }
  }
  if (progress !== saved) {
    await save(progress)
  }
  return {
    ids: progress.items,
    cursor: progress.cursor,
    // 已经转给别人 / 销毁的 tokenId 从进度里去掉，之后不用每次再核对（转回来时会有新的 Transfer 事件，重新扫到）
    prune: async (ids) => {
      const drop = new Set(ids)
      if (progress.items.some((id) => drop.has(id))) {
        await save({ ...progress, items: progress.items.filter((id) => !drop.has(id)) })
      }
    },
  }
}

/** V4 的原始仓位（与 lp.ts 的 RawConcentrated 结构一致） */
export interface RawV4Position {
  version: 'v4'
  protocol: V4Protocol
  pool: string
  tokenId: bigint
  token0: string
  token1: string
  fee: number
  tickLower: number
  tickUpper: number
  tick: number
  sqrtPriceX96: bigint
  liquidity: bigint
  amount0: bigint
  amount1: bigint
  fees0: bigint
  fees1: bigint
  hooks: string
}

/** 查 Uniswap V4 仓位：先找 tokenId（传入的 + 扫描到的），核对仍归 owner，再批量读池子和仓位状态 */
export async function v4Positions(
  provider: Provider,
  owner: string,
  protocols: readonly V4Protocol[],
  v4: LpV4Options,
  includeClosed: boolean,
  maxPositions: number,
  overrides: CallOverrides,
): Promise<RawV4Position[]> {
  const chainId = await provider.getChainId()
  const explicit = (v4.tokenIds ?? []).flatMap((id) => {
    try {
      return [BigInt(id).toString()]
    } catch {
      return [] // 非法 tokenId 忽略
    }
  })
  const scanOptions = v4.scan === true ? {} : v4.scan || null
  const limit = Math.floor(maxPositions)
  if (!(limit > 0)) {
    return []
  }

  // 每个协议的候选 tokenId：太多时只核对最大的 maxPositions 个（tokenId 递增，越大越新）
  const candidates = await Promise.all(
    protocols.map(async (protocol) => {
      const scan = scanOptions ? await scanTokenIds(provider, chainId, protocol, owner, scanOptions, overrides.signal) : null
      const ids = [...new Set([...explicit, ...(scan?.ids ?? [])])].map(BigInt).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      return { protocol, ids: ids.slice(0, limit), scan }
    }),
  )
  const items = candidates.flatMap(({ protocol, ids }) => ids.map((tokenId) => ({ protocol, tokenId })))
  if (!items.length) {
    return []
  }

  // 核对仍归 owner（扫描到的可能已经转走 / 销毁），同时读仓位信息。
  // 读最新状态时才清理扫描进度，并要求节点不落后于扫描进度（否则可能把刚转进来的仓位当成别人的，之后再也扫不到）
  const latest = overrides.blockTag === undefined || overrides.blockTag === 'latest'
  const scannedUpTo = Math.max(-1, ...candidates.map((c) => (c.scan ? c.scan.cursor : -1)))
  const calls = () =>
    items.flatMap(({ protocol, tokenId }) => {
      const pm = provider.contract(protocol.positionManager as string, POSITION_MANAGER_ABI)
      return [pm.ownerOf(tokenId), pm.getPoolAndPositionInfo(tokenId), pm.getPositionLiquidity(tokenId)]
    })
  let pruneSafe = latest && scannedUpTo >= 0
  let first: unknown[]
  if (pruneSafe) {
    try {
      first = await provider.tryAll(calls(), { ...overrides, minBlock: Math.max(overrides.minBlock ?? 0, scannedUpTo) })
    } catch (err) {
      if (overrides.signal?.aborted) {
        throw err
      }
      // 节点都落后于扫描进度（或其他错误）：照常查一次，这次不清理进度，查询本身不因此失败
      pruneSafe = false
      first = await provider.tryAll(calls(), overrides)
    }
  } else {
    first = await provider.tryAll(calls(), overrides)
  }
  type PoolKey = { currency0: string; currency1: string; fee: bigint; tickSpacing: bigint; hooks: string }
  const transferred = new Map<V4Protocol, string[]>(protocols.map((p) => [p, []]))
  const owned = items.flatMap((item, i) => {
    const holder = first[i * 3] as string | null
    const info = first[i * 3 + 1] as { 0: PoolKey; 1: bigint } | null
    // 转给了别人；或已销毁（ownerOf revert 且仓位信息为 0）
    if ((holder && holder.toLowerCase() !== owner.toLowerCase()) || (holder === null && info !== null && info[1] === 0n)) {
      transferred.get(item.protocol)?.push(item.tokenId.toString())
    }
    const liquidity = first[i * 3 + 2] as bigint | null
    if (!holder || holder.toLowerCase() !== owner.toLowerCase() || !info || liquidity === null) {
      return []
    }
    if (!includeClosed && liquidity === 0n) {
      return [] // V4 修改流动性时自动领取手续费：流动性为 0 就没有未领取的手续费
    }
    const key = info[0]
    const { tickLower, tickUpper } = decodePositionInfo(info[1])
    return [{ ...item, key, poolId: poolIdOf(key), tickLower, tickUpper, liquidity }]
  })
  if (pruneSafe) {
    await Promise.all(candidates.map(({ protocol, scan }) => scan?.prune(transferred.get(protocol) ?? [])))
  }
  if (!owned.length) {
    return []
  }

  // 池子状态（每个池子一次）+ 每个仓位的手续费增长
  const poolIds = [...new Set(owned.map((x) => `${(x.protocol.stateView as string).toLowerCase()}:${x.poolId}`))]
  const second = await provider.tryAll(
    [
      ...poolIds.map((k) => {
        const [stateView, poolId] = k.split(':') as [string, string]
        return provider.contract(stateView, STATE_VIEW_ABI).getSlot0(poolId)
      }),
      ...owned.flatMap((x) => {
        const sv = provider.contract(x.protocol.stateView as string, STATE_VIEW_ABI)
        const salt = `0x${x.tokenId.toString(16).padStart(64, '0')}`
        return [sv.getFeeGrowthInside(x.poolId, x.tickLower, x.tickUpper), sv.getPositionInfo(x.poolId, x.protocol.positionManager as string, x.tickLower, x.tickUpper, salt)]
      }),
    ],
    overrides,
  )
  const slot0 = new Map(poolIds.map((k, i) => [k, second[i] as { 0: bigint; 1: bigint; 3: bigint } | null]))

  return owned.flatMap((x, i): RawV4Position[] => {
    const s = slot0.get(`${(x.protocol.stateView as string).toLowerCase()}:${x.poolId}`)
    const inside = second[poolIds.length + i * 2] as { 0: bigint; 1: bigint } | null
    const last = second[poolIds.length + i * 2 + 1] as { 1: bigint; 2: bigint } | null
    if (!s || !inside || !last) {
      return []
    }
    const sqrtPriceX96 = s[0]
    const tick = Number(s[1])
    const [amount0, amount1] = getAmountsForLiquidity(sqrtPriceX96, getSqrtRatioAtTick(x.tickLower), getSqrtRatioAtTick(x.tickUpper), x.liquidity)
    const fee = Number(x.key.fee)
    return [
      {
        version: 'v4',
        protocol: x.protocol,
        pool: x.poolId,
        tokenId: x.tokenId,
        token0: x.key.currency0,
        token1: x.key.currency1,
        // 动态手续费池子：PoolKey 里只有标记，实际手续费是 slot0 的 lpFee
        fee: fee & DYNAMIC_FEE_FLAG ? Number(s[3]) : fee,
        tickLower: x.tickLower,
        tickUpper: x.tickUpper,
        tick,
        sqrtPriceX96,
        liquidity: x.liquidity,
        amount0,
        amount1,
        fees0: getFeesEarned(x.liquidity, inside[0], last[1]),
        fees1: getFeesEarned(x.liquidity, inside[1], last[2]),
        hooks: x.key.hooks,
      },
    ]
  })
}

export { ZERO_ADDRESS as V4_NATIVE_CURRENCY }
