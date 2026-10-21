import { sha256 } from '@noble/hashes/sha2.js'
import { base64 } from '@scure/base'

import { decodeAddress, encodeAddress, findProgramAddress, isAddress } from './address.js'
import type { RequestOptions, SolanaClient } from './client.js'
import { formatUnits, parseMint, parseTokenAccount, type AccountInfo } from './layout.js'
import { AllNodesFailedError, HttpError, RpcError } from './rpc.js'
import { getAmountsForLiquidity, getFeeGrowthInside, getFeesOwed, orcaSqrtPriceAtTick, raydiumSqrtPriceAtTick, sqrtPriceToPrice, tickToPrice, type TickFeeData } from './lpMath.js'
import { defillamaPrices, type SolanaPriceSource } from './price.js'

export const RAYDIUM_CLMM_PROGRAM_ID = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'
export const ORCA_WHIRLPOOL_PROGRAM_ID = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
export const RAYDIUM_AMM_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'
export const RAYDIUM_CPMM_PROGRAM_ID = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'
/** AMM v4 的 LP mint 权限（固定地址） */
export const RAYDIUM_AMM_AUTHORITY = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'
/** CPMM 的 LP mint 权限：PDA ["vault_and_lp_mint_auth_seed"] */
export const RAYDIUM_CPMM_AUTHORITY = 'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL'

export type SolanaLpProtocol = 'raydium-clmm' | 'orca-whirlpool' | 'raydium-amm' | 'raydium-cpmm'

export const SOLANA_LP_PROTOCOLS: Readonly<Record<SolanaLpProtocol, { name: string; type: 'clmm' | 'amm'; programId: string }>> = {
  'raydium-clmm': { name: 'Raydium CLMM', type: 'clmm', programId: RAYDIUM_CLMM_PROGRAM_ID },
  'orca-whirlpool': { name: 'Orca Whirlpool', type: 'clmm', programId: ORCA_WHIRLPOOL_PROGRAM_ID },
  'raydium-amm': { name: 'Raydium AMM v4', type: 'amm', programId: RAYDIUM_AMM_PROGRAM_ID },
  'raydium-cpmm': { name: 'Raydium CPMM', type: 'amm', programId: RAYDIUM_CPMM_PROGRAM_ID },
}

// 价格源在 price.ts（子路径 /price）；这里继续导出，旧的 import 不受影响
export { defillamaPrices, type SolanaPriceSource, type SolanaPriceSourceContext } from './price.js'

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

export interface SolanaLpToken {
  mint: string
  /** 读不到时为 null；Wrapped SOL 为 'SOL'（按客户端的 nativeMints 配置） */
  symbol: string | null
  /** 读不到时为 null（这时 formatted 字段也为 null） */
  decimals: number | null
}

interface SolanaLpPositionBase {
  protocol: SolanaLpProtocol
  protocolName: string
  /** 池子账户地址 */
  pool: string
  token0: SolanaLpToken
  token1: SolanaLpToken
  /** 撤出全部流动性能拿到的数量（最小单位，十进制字符串；不含未领取的手续费） */
  amount0: string
  amount1: string
  amount0Formatted: string | null
  amount1Formatted: string | null
  /** 开启 prices 时：两种代币的美元价值（数量不为 0 的代币没有价格时为 null）；没开启时不返回 */
  valueUsd?: number | null
}

/** Raydium AMM v4 / CPMM：持有的 LP 代币 */
export interface SolanaLpAmmPosition extends SolanaLpPositionBase {
  type: 'amm'
  lpMint: string
  /** 持有的 LP 数量（最小单位） */
  balance: string
  /** 池子记录的 LP 总量（程序按它计算撤出数量） */
  totalSupply: string
  /** 份额（0~1，浮点数） */
  share: number
}

/** Raydium CLMM / Orca Whirlpool：仓位 NFT */
export interface SolanaLpClmmPosition extends SolanaLpPositionBase {
  type: 'clmm'
  /** 仓位 NFT 的 mint */
  positionMint: string
  /** 仓位账户（PDA ["position", positionMint]） */
  position: string
  /** 手续费率，百万分之一（如 2500 = 0.25%）；读不到时为 null */
  fee: number | null
  tickSpacing: number
  tickLower: number
  tickUpper: number
  /** 池子当前 tick */
  tick: number
  /** 当前价格在区间内（tickLower ≤ tick < tickUpper，在区间内才赚手续费） */
  inRange: boolean
  liquidity: string
  /** 价格都是 token1 / token0（按精度换算，只用于展示）；读不到精度时为 null */
  price: number | null
  priceLower: number | null
  priceUpper: number | null
  /** 未领取的手续费（最小单位）；不含挖矿奖励。读不到两端的 tick 数据时（极少见，如数组刚好被关闭）为 null */
  fees0: string | null
  fees1: string | null
  fees0Formatted: string | null
  fees1Formatted: string | null
  /** 开启 prices 时：未领取手续费的美元价值（手续费为 null 或缺价格时为 null） */
  feesUsd?: number | null
}

export type SolanaLpPosition = SolanaLpAmmPosition | SolanaLpClmmPosition

export interface LpPositionsOptions extends RequestOptions {
  /** 只查这些协议，默认全部 */
  protocols?: readonly SolanaLpProtocol[]
  /**
   * 只看这些代币（仓位 NFT 的 mint、LP 代币的 mint），按关联代币账户（ATA）读余额，免费公共节点也能用。
   * 不传时扫描地址的全部代币账户（getTokenAccountsByOwner，需要支持它的节点）
   */
  mints?: readonly string[]
  /**
   * Raydium AMM v4 / CPMM 的池子地址：这些池子的 LP 代币直接按池子识别。
   * 不在这里的 LP 代币用 getProgramAccounts 按 LP mint 找池子（需要支持它的节点）
   */
  pools?: readonly string[]
  /** 返回已清空的仓位（流动性为 0、手续费也领完，NFT 还在）。默认 false */
  includeClosed?: boolean
  /** 查美元价值：true 用 DefiLlama，也可以传自己的 SolanaPriceSource（如 /price 的 combinePrices([defillamaPrices(), onchainPrices()])）。默认不查 */
  prices?: boolean | SolanaPriceSource
  /**
   * 价格源出错时调用（服务不可用、被拦截等）：这时照样返回仓位，只是 valueUsd / feesUsd 为 null，
   * 用它区分“价格服务出错”和“这个代币没有价格”。回调本身出错会被忽略
   */
  onPriceError?: (error: unknown) => void
  /** 查价格用的 fetch，默认全局 fetch */
  fetch?: typeof fetch
}

// ---------------------------------------------------------------------------
// 账户布局（各程序的 Anchor / 原生账户，偏移量含 8 字节判别符）
// ---------------------------------------------------------------------------

/** 小端读取账户数据（添加 / 移除流动性也用） */
export class Bytes {
  readonly #view: DataView
  constructor(readonly data: Uint8Array) {
    this.#view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }
  u8(o: number): number {
    return this.#view.getUint8(o)
  }
  u16(o: number): number {
    return this.#view.getUint16(o, true)
  }
  u32(o: number): number {
    return this.#view.getUint32(o, true)
  }
  i32(o: number): number {
    return this.#view.getInt32(o, true)
  }
  u64(o: number): bigint {
    return this.#view.getBigUint64(o, true)
  }
  u128(o: number): bigint {
    return (this.#view.getBigUint64(o + 8, true) << 64n) | this.#view.getBigUint64(o, true)
  }
  key(o: number): string {
    return encodeAddress(this.data.subarray(o, o + 32))
  }
}

const RAYDIUM_POSITION_SIZE = 281
const ORCA_POSITION_SIZE = 216
/** 池子账户至少要读到的长度（Raydium PoolState 实际 1544 字节，Orca Whirlpool 653 字节） */
const RAYDIUM_POOL_MIN_SIZE = 309
const ORCA_POOL_MIN_SIZE = 261
const AMM_POOL_SIZE = 752
const CPMM_POOL_SIZE = 637
const RAYDIUM_TICK_ARRAY_SIZE = 60
const RAYDIUM_TICK_SIZE = 168
const ORCA_TICK_ARRAY_SIZE = 88
const ORCA_TICK_SIZE = 113

interface ClmmPositionState {
  protocol: 'raydium-clmm' | 'orca-whirlpool'
  address: string
  mint: string
  pool: string
  tickLower: number
  tickUpper: number
  liquidity: bigint
  growthLast0: bigint
  growthLast1: bigint
  owed0: bigint
  owed1: bigint
}

function raydiumPosition(address: string, b: Bytes): ClmmPositionState {
  return {
    protocol: 'raydium-clmm',
    address,
    mint: b.key(9),
    pool: b.key(41),
    tickLower: b.i32(73),
    tickUpper: b.i32(77),
    liquidity: b.u128(81),
    growthLast0: b.u128(97),
    growthLast1: b.u128(113),
    owed0: b.u64(129),
    owed1: b.u64(137),
  }
}

function orcaPosition(address: string, b: Bytes): ClmmPositionState {
  return {
    protocol: 'orca-whirlpool',
    address,
    pool: b.key(8),
    mint: b.key(40),
    liquidity: b.u128(72),
    tickLower: b.i32(88),
    tickUpper: b.i32(92),
    growthLast0: b.u128(96),
    owed0: b.u64(112),
    growthLast1: b.u128(120),
    owed1: b.u64(136),
  }
}

interface ClmmPoolState {
  mint0: string
  mint1: string
  decimals0: number | null
  decimals1: number | null
  tickSpacing: number
  sqrtPrice: bigint
  tick: number
  global0: bigint
  global1: bigint
  /** Orca：池子里的费率；Raydium：在 AmmConfig 里，ammConfig 为它的地址 */
  fee: number | null
  ammConfig: string | null
}

function raydiumPool(b: Bytes): ClmmPoolState {
  return {
    ammConfig: b.key(9),
    mint0: b.key(73),
    mint1: b.key(105),
    decimals0: b.u8(233),
    decimals1: b.u8(234),
    tickSpacing: b.u16(235),
    sqrtPrice: b.u128(253),
    tick: b.i32(269),
    global0: b.u128(277),
    global1: b.u128(293),
    fee: null,
  }
}

function orcaPool(b: Bytes): ClmmPoolState {
  return {
    ammConfig: null,
    tickSpacing: b.u16(41),
    fee: b.u16(45),
    sqrtPrice: b.u128(65),
    tick: b.i32(81),
    mint0: b.key(101),
    global0: b.u128(165),
    mint1: b.key(181),
    global1: b.u128(245),
    decimals0: null,
    decimals1: null,
  }
}

export interface AmmPoolState {
  protocol: 'raydium-amm' | 'raydium-cpmm'
  address: string
  lpMint: string
  mint0: string
  mint1: string
  vault0: string
  vault1: string
  decimals0: number
  decimals1: number
  /** 从金库余额里扣掉的、不属于 LP 的部分（AMM v4 待提取的收益；CPMM 协议 / 基金 / 创建者手续费） */
  reserved0: bigint
  reserved1: bigint
  lpSupply: bigint
}

function ammPool(address: string, b: Bytes): AmmPoolState {
  return {
    protocol: 'raydium-amm',
    address,
    decimals0: Number(b.u64(32)),
    decimals1: Number(b.u64(40)),
    reserved0: b.u64(192),
    reserved1: b.u64(200),
    vault0: b.key(336),
    vault1: b.key(368),
    mint0: b.key(400),
    mint1: b.key(432),
    lpMint: b.key(464),
    lpSupply: b.u64(720),
  }
}

function cpmmPool(address: string, b: Bytes): AmmPoolState {
  return {
    protocol: 'raydium-cpmm',
    address,
    vault0: b.key(72),
    vault1: b.key(104),
    lpMint: b.key(136),
    mint0: b.key(168),
    mint1: b.key(200),
    decimals0: b.u8(331),
    decimals1: b.u8(332),
    lpSupply: b.u64(333),
    reserved0: b.u64(341) + b.u64(357) + b.u64(397),
    reserved1: b.u64(349) + b.u64(365) + b.u64(405),
  }
}

export function parseAmmPool(account: AccountInfo): AmmPoolState | null {
  const b = new Bytes(account.data)
  if (account.owner === RAYDIUM_AMM_PROGRAM_ID && account.data.length === AMM_POOL_SIZE) {
    return ammPool(account.address, b)
  }
  if (account.owner === RAYDIUM_CPMM_PROGRAM_ID && account.data.length === CPMM_POOL_SIZE) {
    return cpmmPool(account.address, b)
  }
  return null
}

export const utf8 = (s: string) => new TextEncoder().encode(s)

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b) * b
}

/** Raydium tick 数组：PDA ["tick_array", pool, start（i32 大端）]，每个数组 60 个 tick */
export function raydiumTickArray(pool: string, tick: number, spacing: number): { address: string; start: number } {
  const start = floorDiv(tick, spacing * RAYDIUM_TICK_ARRAY_SIZE)
  const be = new Uint8Array(4)
  new DataView(be.buffer).setInt32(0, start, false)
  return { address: findProgramAddress([utf8('tick_array'), decodeAddress(pool), be], RAYDIUM_CLMM_PROGRAM_ID), start }
}

/** Orca tick 数组：PDA ["tick_array", whirlpool, start（十进制字符串）]，每个数组 88 个 tick */
export function orcaTickArray(pool: string, tick: number, spacing: number): { address: string; start: number } {
  const start = floorDiv(tick, spacing * ORCA_TICK_ARRAY_SIZE)
  return { address: findProgramAddress([utf8('tick_array'), decodeAddress(pool), utf8(String(start))], ORCA_WHIRLPOOL_PROGRAM_ID), start }
}

function raydiumTick(account: AccountInfo, start: number, tick: number, spacing: number): TickFeeData | null {
  raydiumDiscriminator ??= discriminator('TickArrayState')
  const offset = 44 + ((tick - start) / spacing) * RAYDIUM_TICK_SIZE
  // 先认判别符、查长度再读字段（PDA 上可能是别的账户，如被转过 SOL 的系统账户）
  if (!startsWith(account.data, raydiumDiscriminator) || offset + RAYDIUM_TICK_SIZE > account.data.length) {
    return null
  }
  const b = new Bytes(account.data)
  if (b.i32(40) !== start) {
    return null
  }
  // Raydium 不区分是否初始化：没用过的 tick 各项都是 0，按程序的公式算出来就是对的
  return { initialized: true, feeGrowthOutside0: b.u128(offset + 36), feeGrowthOutside1: b.u128(offset + 52) }
}

/** Anchor 账户判别符：sha256("account:<名称>") 的前 8 字节 */
const discriminator = (name: string) => sha256(utf8(`account:${name}`)).subarray(0, 8)
let orcaDiscriminators: { fixed: Uint8Array; dynamic: Uint8Array } | undefined
let raydiumDiscriminator: Uint8Array | undefined
const startsWith = (data: Uint8Array, prefix: Uint8Array) => data.length >= prefix.length && prefix.every((byte, i) => data[i] === byte)

function orcaTick(account: AccountInfo, start: number, tick: number, spacing: number): TickFeeData | null {
  orcaDiscriminators ??= { fixed: discriminator('TickArray'), dynamic: discriminator('DynamicTickArray') }
  if (account.data.length < 60) {
    return null // 两种格式的头部（判别符 + start + …）都放不下
  }
  const b = new Bytes(account.data)
  const index = (tick - start) / spacing
  if (startsWith(account.data, orcaDiscriminators.fixed)) {
    // 固定大小：start i32 | ticks [Tick; 88]（每个 113 字节：initialized u8、liquidity_net、liquidity_gross、两个手续费增长…）| whirlpool
    const offset = 12 + index * ORCA_TICK_SIZE
    if (b.i32(8) !== start || offset + ORCA_TICK_SIZE > account.data.length) {
      return null
    }
    return { initialized: b.u8(offset) === 1, feeGrowthOutside0: b.u128(offset + 33), feeGrowthOutside1: b.u128(offset + 49) }
  }
  if (startsWith(account.data, orcaDiscriminators.dynamic)) {
    // 可变大小：start i32 | whirlpool | tick_bitmap u128 | ticks（未初始化 1 字节 0；初始化 1 字节 1 + 112 字节数据）
    if (b.i32(8) !== start) {
      return null
    }
    let offset = 60
    for (let i = 0; i < index; i++) {
      if (offset >= account.data.length) {
        return null // 数据被截断
      }
      offset += b.u8(offset) === 1 ? 113 : 1
    }
    if (offset >= account.data.length) {
      return null
    }
    if (b.u8(offset) !== 1) {
      return { initialized: false, feeGrowthOutside0: 0n, feeGrowthOutside1: 0n }
    }
    if (offset + 113 > account.data.length) {
      return null
    }
    return { initialized: true, feeGrowthOutside0: b.u128(offset + 33), feeGrowthOutside1: b.u128(offset + 49) }
  }
  return null
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

interface Holding {
  mint: string
  amount: bigint
  decimals: number
}

interface RawClmm {
  type: 'clmm'
  position: ClmmPositionState
  pool: ClmmPoolState
  amount0: bigint
  amount1: bigint
  fees0: bigint | null
  fees1: bigint | null
}

interface RawAmm {
  type: 'amm'
  pool: AmmPoolState
  balance: bigint
  amount0: bigint
  amount1: bigint
}

/**
 * 查一个地址的 LP 仓位：Raydium CLMM / Orca Whirlpool 的仓位 NFT，Raydium AMM v4 / CPMM 的 LP 代币。
 * 返回两种代币的数量、未领取的手续费（集中流动性），可选美元价值。
 *
 * - 默认扫描地址的全部代币账户找仓位 NFT 和 LP 代币（需要支持 getTokenAccountsByOwner 的节点）；传 mints 时只看这些代币（ATA，免费节点也能用）
 * - Raydium AMM v4 / CPMM 的 LP 代币按 LP mint 用 getProgramAccounts 找池子（需要支持它的节点），传 pools 时这些池子不用找
 * - 质押在农场里的 LP、Orca 的仓位组合（Position Bundle）、锁仓的 Raydium 仓位不在用户名下，查不到
 */
export async function lpPositions(client: SolanaClient, owner: string, options: LpPositionsOptions = {}): Promise<SolanaLpPosition[]> {
  if (!isAddress(owner)) {
    throw new Error(`Invalid owner address: ${owner}`)
  }
  const protocols = new Set<SolanaLpProtocol>(options.protocols ?? (Object.keys(SOLANA_LP_PROTOCOLS) as SolanaLpProtocol[]))
  for (const p of protocols) {
    if (!Object.hasOwn(SOLANA_LP_PROTOCOLS, p)) {
      throw new Error(`Unknown LP protocol: ${p}`)
    }
  }
  for (const address of [...(options.mints ?? []), ...(options.pools ?? [])]) {
    if (!isAddress(address)) {
      throw new Error(`Invalid address: ${address}`)
    }
  }
  const { signal } = options
  const wantClmm = protocols.has('raydium-clmm') || protocols.has('orca-whirlpool')
  const wantAmm = protocols.has('raydium-amm') || protocols.has('raydium-cpmm')
  if (!wantClmm && !wantAmm) {
    return []
  }

  // 1. 传入的池子（AMM v4 / CPMM），以及持有的代币
  const knownPools: AmmPoolState[] = []
  if (wantAmm && options.pools?.length) {
    const accounts = await client.accounts(options.pools, { signal })
    accounts.forEach((account, i) => {
      const pool = account ? parseAmmPool(account) : null
      if (!pool) {
        throw new Error(`Not a Raydium AMM v4 / CPMM pool: ${options.pools?.[i]}`)
      }
      if (protocols.has(pool.protocol)) {
        knownPools.push(pool)
      }
    })
  }
  const holdings = await listHoldings(client, owner, options.mints, knownPools.map((p) => p.lpMint), signal)

  // 2. 一次读：可能是仓位 NFT 的代币（精度 0、数量 1）推导出的仓位账户，其余代币的 mint（看是不是 Raydium 的 LP）
  const nfts = wantClmm ? holdings.filter((h) => h.decimals === 0 && h.amount === 1n) : []
  const candidates = nfts.flatMap((h) => [
    ...(protocols.has('raydium-clmm') ? [{ protocol: 'raydium-clmm' as const, address: findProgramAddress([utf8('position'), decodeAddress(h.mint)], RAYDIUM_CLMM_PROGRAM_ID) }] : []),
    ...(protocols.has('orca-whirlpool') ? [{ protocol: 'orca-whirlpool' as const, address: findProgramAddress([utf8('position'), decodeAddress(h.mint)], ORCA_WHIRLPOOL_PROGRAM_ID) }] : []),
  ])
  const poolByLp = new Map(knownPools.map((p) => [p.lpMint, p]))
  const fungible = wantAmm ? holdings.filter((h) => !(h.decimals === 0 && h.amount === 1n) && !poolByLp.has(h.mint)) : []
  const first = await client.accounts([...candidates.map((c) => c.address), ...fungible.map((h) => h.mint)], { signal })

  const positions: ClmmPositionState[] = []
  candidates.forEach((c, i) => {
    const account = first[i]
    if (!account) {
      return
    }
    const program = SOLANA_LP_PROTOCOLS[c.protocol].programId
    if (c.protocol === 'raydium-clmm' && account.owner === program && account.data.length === RAYDIUM_POSITION_SIZE) {
      positions.push(raydiumPosition(c.address, new Bytes(account.data)))
    } else if (c.protocol === 'orca-whirlpool' && account.owner === program && account.data.length === ORCA_POSITION_SIZE) {
      positions.push(orcaPosition(c.address, new Bytes(account.data)))
    }
  })
  // LP mint 的权限是 AMM v4 / CPMM 的固定权限地址时才去找池子
  const lookups: { protocol: 'raydium-amm' | 'raydium-cpmm'; lpMint: string }[] = []
  fungible.forEach((h, i) => {
    const account = first[candidates.length + i]
    if (!account) {
      return
    }
    let authority: string | null
    try {
      authority = parseMint(account.data).mintAuthority
    } catch {
      return
    }
    if (authority === RAYDIUM_AMM_AUTHORITY && protocols.has('raydium-amm')) {
      lookups.push({ protocol: 'raydium-amm', lpMint: h.mint })
    } else if (authority === RAYDIUM_CPMM_AUTHORITY && protocols.has('raydium-cpmm')) {
      lookups.push({ protocol: 'raydium-cpmm', lpMint: h.mint })
    }
  })

  // 3. 池子：集中流动性的池子账户；LP 代币按 LP mint 找池子
  const poolAddresses = [...new Set(positions.map((p) => p.pool))]
  const [poolAccounts, found] = await Promise.all([
    client.accounts(poolAddresses, { signal }),
    Promise.all(lookups.map((l) => findAmmPool(client, l.protocol, l.lpMint, signal))),
  ])
  for (const pool of found) {
    if (pool) {
      poolByLp.set(pool.lpMint, pool)
    }
  }
  const pools = new Map<string, ClmmPoolState>()
  poolAddresses.forEach((address, i) => {
    const account = poolAccounts[i]
    if (account?.owner === RAYDIUM_CLMM_PROGRAM_ID && account.data.length >= RAYDIUM_POOL_MIN_SIZE) {
      pools.set(address, raydiumPool(new Bytes(account.data)))
    } else if (account?.owner === ORCA_WHIRLPOOL_PROGRAM_ID && account.data.length >= ORCA_POOL_MIN_SIZE) {
      pools.set(address, orcaPool(new Bytes(account.data)))
    }
  })
  const held = new Map(holdings.map((h) => [h.mint, h]))
  const ammHeld = [...poolByLp.values()].filter((p) => (held.get(p.lpMint)?.amount ?? 0n) > 0n)

  // 4. 一次读：有流动性的仓位两端的 tick 数组、Raydium 的费率配置、AMM 池子的金库
  const tickArrays = positions.flatMap((p) => {
    const pool = pools.get(p.pool)
    if (!pool || p.liquidity === 0n) {
      return []
    }
    const derive = p.protocol === 'raydium-clmm' ? raydiumTickArray : orcaTickArray
    return [{ position: p, lower: derive(p.pool, p.tickLower, pool.tickSpacing), upper: derive(p.pool, p.tickUpper, pool.tickSpacing) }]
  })
  const configs = [...new Set([...pools.values()].flatMap((p) => (p.ammConfig ? [p.ammConfig] : [])))]
  const vaults = ammHeld.flatMap((p) => [p.vault0, p.vault1])
  const tickAddresses = [...new Set(tickArrays.flatMap((t) => [t.lower.address, t.upper.address]))]
  const second = await client.accounts([...tickAddresses, ...configs, ...vaults], { signal })
  const byAddress = new Map<string, AccountInfo>()
  ;[...tickAddresses, ...configs, ...vaults].forEach((address, i) => {
    const account = second[i]
    if (account) {
      byAddress.set(address, account)
    }
  })
  const feeRates = new Map<string, number>()
  for (const config of configs) {
    const account = byAddress.get(config)
    // AmmConfig：bump u8 | index u16 | owner | protocol_fee_rate u32 | trade_fee_rate u32
    if (account?.owner === RAYDIUM_CLMM_PROGRAM_ID && account.data.length >= 51) {
      feeRates.set(config, new Bytes(account.data).u32(47))
    }
  }

  const raw: (RawClmm | RawAmm)[] = []
  for (const position of positions) {
    const pool = pools.get(position.pool)
    if (!pool) {
      continue
    }
    const sqrtAt = position.protocol === 'raydium-clmm' ? raydiumSqrtPriceAtTick : orcaSqrtPriceAtTick
    const [amount0, amount1] = getAmountsForLiquidity(pool.tick, pool.sqrtPrice, sqrtAt(position.tickLower), sqrtAt(position.tickUpper), position.liquidity, position.tickLower, position.tickUpper)
    // 没有流动性时只有已记账的部分
    let fees0: bigint | null = position.owed0
    let fees1: bigint | null = position.owed1
    const arrays = tickArrays.find((t) => t.position === position)
    if (arrays) {
      const read = position.protocol === 'raydium-clmm' ? raydiumTick : orcaTick
      const lowerAccount = byAddress.get(arrays.lower.address)
      const upperAccount = byAddress.get(arrays.upper.address)
      const lower = lowerAccount ? read(lowerAccount, arrays.lower.start, position.tickLower, pool.tickSpacing) : null
      const upper = upperAccount ? read(upperAccount, arrays.upper.start, position.tickUpper, pool.tickSpacing) : null
      // 有流动性时两端的 tick 数组一定存在；读不到 / 解析不了时不猜，手续费为 null
      if (lower && upper) {
        const [inside0, inside1] = getFeeGrowthInside(pool.tick, position.tickLower, lower, position.tickUpper, upper, pool.global0, pool.global1)
        fees0 = getFeesOwed(position.owed0, position.liquidity, inside0, position.growthLast0)
        fees1 = getFeesOwed(position.owed1, position.liquidity, inside1, position.growthLast1)
      } else {
        fees0 = null
        fees1 = null
      }
    }
    if (!options.includeClosed && position.liquidity === 0n && fees0 === 0n && fees1 === 0n) {
      continue
    }
    raw.push({ type: 'clmm', position, pool: { ...pool, fee: pool.fee ?? (pool.ammConfig ? (feeRates.get(pool.ammConfig) ?? null) : null) }, amount0, amount1, fees0, fees1 })
  }
  for (const pool of ammHeld) {
    const balance = held.get(pool.lpMint)?.amount ?? 0n
    const vault = (address: string) => {
      const account = byAddress.get(address)
      try {
        return account ? parseTokenAccount(account.data).amount : null
      } catch {
        return null
      }
    }
    const v0 = vault(pool.vault0)
    const v1 = vault(pool.vault1)
    if (v0 === null || v1 === null || pool.lpSupply === 0n) {
      continue
    }
    const sub = (a: bigint, b: bigint) => (a > b ? a - b : 0n)
    // 与程序撤出流动性的计算相同：份额 × （金库余额 − 不属于 LP 的部分），向下取整。
    // AMM v4 的池子还能用 OpenBook 挂单时（status 不是 6 SwapOnly），挂单里的资金没算进来，数量会略少
    raw.push({ type: 'amm', pool, balance, amount0: (balance * sub(v0, pool.reserved0)) / pool.lpSupply, amount1: (balance * sub(v1, pool.reserved1)) / pool.lpSupply })
  }
  return finalize(client, raw, options)
}

/**
 * 节点不提供这个方法（方法不存在、被拦截、需要付费 / Token、403 等）：这时报错里说明怎么绕过。
 * 多节点时所有节点都是这个原因才算；限频、超时、网络不对等原样抛出（资产总值 portfolio 也用）
 */
export function methodUnavailable(err: unknown): boolean {
  if (err instanceof AllNodesFailedError) {
    return err.errors.length > 0 && err.errors.every((e) => methodUnavailable(e.error))
  }
  if (err instanceof HttpError) {
    return err.status === 401 || err.status === 403 || err.status === 405
  }
  if (err instanceof RpcError) {
    // 限频不算“不支持”（如 QuickNode：“… request limit reached - … upgrade your account”）
    if (err.code === 429 || err.code === -32007 || /rate.?limit|too many requests|limit reached/i.test(err.message)) {
      return false
    }
    return err.code === -32601 || err.code === 403 || /blocked|not (supported|available|allowed|enabled)|method not found|disabled|excluded|personal token|api key|upgrade|paid plan/i.test(err.message)
  }
  return false
}

/** 按 mint 列出持有的代币：传 mints 时读这些代币的 ATA，否则扫描全部代币账户 */
async function listHoldings(client: SolanaClient, owner: string, mints: readonly string[] | undefined, extra: readonly string[], signal: AbortSignal | undefined): Promise<Holding[]> {
  if (mints) {
    const list = [...new Set([...mints, ...extra])]
    const balances = list.length ? await client.balances(owner, list, { signal }) : []
    return balances.filter((b) => b.success && !b.native && b.balance !== '0').map((b) => ({ mint: b.token, amount: BigInt(b.balance), decimals: b.decimals }))
  }
  const tokens = await client.ownerTokens(owner, { signal, metadata: false, includeNative: false, includeNfts: true }).catch((err: unknown) => {
    if (signal?.aborted || !methodUnavailable(err)) {
      throw err // 取消、限频、超时等原样抛出（保留错误类型）
    }
    throw new Error(
      `Scanning the token accounts of ${owner} failed (${err instanceof Error ? err.message : String(err)}). ` +
        'Scanning needs getTokenAccountsByOwner (most free public nodes do not support it): pass the position NFT / LP mints in `mints`, or use a node that supports it',
      { cause: err },
    )
  })
  return tokens.map((t) => ({ mint: t.token, amount: BigInt(t.balance), decimals: t.decimals }))
}

/** 按 LP mint 找 AMM v4 / CPMM 的池子（getProgramAccounts + memcmp），找不到时为 null */
async function findAmmPool(client: SolanaClient, protocol: 'raydium-amm' | 'raydium-cpmm', lpMint: string, signal: AbortSignal | undefined): Promise<AmmPoolState | null> {
  const [programId, size, offset] = protocol === 'raydium-amm' ? [RAYDIUM_AMM_PROGRAM_ID, AMM_POOL_SIZE, 464] : [RAYDIUM_CPMM_PROGRAM_ID, CPMM_POOL_SIZE, 136]
  const res = await client
    .request<{ pubkey: string; account: { data: [string, string]; owner: string } }[]>(
      'getProgramAccounts',
      [programId, { encoding: 'base64', commitment: client.commitment, filters: [{ dataSize: size }, { memcmp: { offset, bytes: lpMint } }] }],
      { signal },
    )
    .catch((err: unknown) => {
      if (signal?.aborted || !methodUnavailable(err)) {
        throw err
      }
      // 免费公共节点大多不支持 getProgramAccounts：说明怎么绕过
      throw new Error(
        `Finding the ${SOLANA_LP_PROTOCOLS[protocol].name} pool of LP token ${lpMint} uses getProgramAccounts, which failed (${err instanceof Error ? err.message : String(err)}; most free public nodes do not support it). ` +
          "Pass the pool address in `pools`, use a node that supports getProgramAccounts, or skip LP tokens with `protocols: ['raydium-clmm', 'orca-whirlpool']`",
        { cause: err },
      )
    })
  for (const item of res ?? []) {
    const data = base64.decode(item.account.data[0])
    const pool = parseAmmPool({ address: item.pubkey, owner: item.account.owner, data, lamports: 0n, executable: false })
    if (pool?.lpMint === lpMint) {
      return pool
    }
  }
  return null
}

async function finalize(client: SolanaClient, raw: readonly (RawClmm | RawAmm)[], options: LpPositionsOptions): Promise<SolanaLpPosition[]> {
  const { signal } = options
  const mints = [...new Set(raw.flatMap((r) => [r.pool.mint0, r.pool.mint1]))]
  const priceSource = options.prices === true ? defillamaPrices() : options.prices || null
  const fetchFn = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  // 价格源出错（服务不可用、被拦截、同步抛错等）时照样返回仓位，只是不带价格；取消查询时照常 reject
  const loadPrices = async (): Promise<Map<string, number>> => {
    if (!priceSource || !mints.length) {
      return new Map()
    }
    try {
      // wSOL 的价格就是 SOL 的价格，DefiLlama 用 So111…112 查得到；client 给链上价格源读池子
      return await priceSource.prices({ mints, fetch: fetchFn, signal, client })
    } catch (err) {
      if (signal?.aborted) {
        throw err
      }
      try {
        options.onPriceError?.(err)
      } catch {
        // 回调出错不影响查询结果
      }
      return new Map()
    }
  }
  const [details, priceMap] = await Promise.all([
    mints.length ? client.tokens(mints, { fields: ['symbol', 'decimals'], signal }) : Promise.resolve([]),
    loadPrices(),
  ])
  const meta = new Map(details.map((d) => [d.address, d]))
  const token = (mint: string, poolDecimals: number | null): SolanaLpToken => {
    const d = meta.get(mint)
    return { mint, symbol: d?.symbol ?? null, decimals: d?.decimals ?? poolDecimals }
  }
  const fmt = (value: bigint, t: SolanaLpToken) => (t.decimals === null ? null : formatUnits(value, t.decimals))
  const usd = (t: SolanaLpToken, formatted: string | null) => {
    const price = priceMap.get(t.mint)
    return formatted === null || price === undefined ? null : Number(formatted) * price
  }
  const sum = (a: number | null, b: number | null, amountA: bigint, amountB: bigint) => {
    // 数量为 0 的一边没有价格也不影响
    if ((a === null && amountA > 0n) || (b === null && amountB > 0n)) {
      return null
    }
    return (a ?? 0) + (b ?? 0)
  }

  const list = raw.map((r): SolanaLpPosition => {
    const protocol = r.type === 'clmm' ? r.position.protocol : r.pool.protocol
    const token0 = token(r.pool.mint0, r.pool.decimals0)
    const token1 = token(r.pool.mint1, r.pool.decimals1)
    const amount0Formatted = fmt(r.amount0, token0)
    const amount1Formatted = fmt(r.amount1, token1)
    const base = {
      protocol,
      protocolName: SOLANA_LP_PROTOCOLS[protocol].name,
      pool: r.type === 'clmm' ? r.position.pool : r.pool.address,
      token0,
      token1,
      amount0: r.amount0.toString(),
      amount1: r.amount1.toString(),
      amount0Formatted,
      amount1Formatted,
      ...(priceSource ? { valueUsd: sum(usd(token0, amount0Formatted), usd(token1, amount1Formatted), r.amount0, r.amount1) } : {}),
    }
    if (r.type === 'amm') {
      return {
        ...base,
        type: 'amm',
        lpMint: r.pool.lpMint,
        balance: r.balance.toString(),
        totalSupply: r.pool.lpSupply.toString(),
        share: Number(r.balance) / Number(r.pool.lpSupply),
      }
    }
    const { position: p, pool } = r
    const d0 = token0.decimals
    const d1 = token1.decimals
    const fees0Formatted = r.fees0 === null ? null : fmt(r.fees0, token0)
    const fees1Formatted = r.fees1 === null ? null : fmt(r.fees1, token1)
    return {
      ...base,
      type: 'clmm',
      positionMint: p.mint,
      position: p.address,
      fee: pool.fee,
      tickSpacing: pool.tickSpacing,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      tick: pool.tick,
      inRange: pool.tick >= p.tickLower && pool.tick < p.tickUpper,
      liquidity: p.liquidity.toString(),
      price: d0 === null || d1 === null ? null : sqrtPriceToPrice(pool.sqrtPrice, d0, d1),
      priceLower: d0 === null || d1 === null ? null : tickToPrice(p.tickLower, d0, d1),
      priceUpper: d0 === null || d1 === null ? null : tickToPrice(p.tickUpper, d0, d1),
      fees0: r.fees0 === null ? null : r.fees0.toString(),
      fees1: r.fees1 === null ? null : r.fees1.toString(),
      fees0Formatted,
      fees1Formatted,
      ...(priceSource ? { feesUsd: r.fees0 === null || r.fees1 === null ? null : sum(usd(token0, fees0Formatted), usd(token1, fees1Formatted), r.fees0, r.fees1) } : {}),
    }
  })
  if (priceSource) {
    const total = (p: SolanaLpPosition) => (p.valueUsd === null || p.valueUsd === undefined ? -1 : p.valueUsd + (p.type === 'clmm' ? (p.feesUsd ?? 0) : 0))
    list.sort((a, b) => total(b) - total(a))
  }
  return list
}
