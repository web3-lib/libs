/**
 * 添加 / 移除流动性（子路径 `@w3lib/sui-batch-call/liquidity`）：Sui 上的集中流动性 DEX（与 /lp 相同的协议）。
 * 报价按集中流动性的公式在本地算；交易调用各 DEX 合约的函数，合约检查数量上限 / 下限，超出滑点时整笔失败
 */
import { SUI_COIN_TYPE, normalizeSuiAddress } from './address.js'
import { MAX_TICK, MIN_TICK, amountsForLiquidity, liquidityForAmount, sqrtPriceAtTick } from './clmmMath.js'
import type { SuiClient } from './client.js'
import { createEnv, resolvePackages } from './dex/env.js'
import { ADAPTERS, adapterForPool, adapterForPosition } from './dex/adapters.js'
import { inspect } from './dex/inspect.js'
import type { DexAdapter, DexPool, DexPosition, SuiLpProtocol } from './dex/types.js'
import { formatUnits, parseUnits } from './format.js'
import type { SuiLpPosition, SuiLpToken } from './lp.js'
import { getBalance } from './services.js'
import { pure, type Argument, type ProgrammableTransaction } from './write/bcs.js'
import { PtbBuilder } from './write/ptb.js'
import { buildContext, emptyOutcome, sendJobs, toWriteResult, type BuildContext, type SendOptions, type WriteResult } from './write/send.js'
import { resolveSigner, type ResolvedSigner, type SignerInput } from './write/signer.js'
import { gatherCoin } from './write/transfer.js'

/** 从 gas 币拆 SUI 时至少要多出这么多留给 gas（0.001 SUI，实际够不够由模拟决定） */
const GAS_MARGIN = 1_000_000n

export interface LiquidityOptions {
  /** 数量滑点，默认 0.005：添加时另一边的上限 = 按当前价格算出的数量 × (1 + s)，下限 = 数量 × (1 − s)；移除时下限 = 数量 × (1 − s) */
  slippage?: number
  signal?: AbortSignal
}

/** 新建仓位，或往已有仓位追加 */
export interface AddLiquidityParams extends LiquidityOptions {
  /** 新建：协议（不传时按池子的类型认出） */
  protocol?: SuiLpProtocol
  /** 新建：池子地址 */
  pool?: string
  /** 追加：已有仓位（lpPositions 的结果，或仓位对象 ID） */
  position?: SuiLpPosition | string
  /** 新建时的价格区间（token1 / token0，按精度换算）；或 tickLower / tickUpper；或 fullRange */
  priceLower?: number
  priceUpper?: number
  tickLower?: number
  tickUpper?: number
  fullRange?: boolean
  /** 数量（最小单位或按精度换算的字符串），给一边；两边都给时按能加的较少的一边算，另一边不超过给的数量 */
  amount0?: bigint | string | number
  amount1?: bigint | string | number
  amount0Formatted?: string
  amount1Formatted?: string
}

export interface RemoveLiquidityParams extends LiquidityOptions {
  position: SuiLpPosition | string
  /** 移除的比例（0~100），默认 100；或 liquidity 指定数量 */
  percent?: number
  liquidity?: bigint | string
  /** 全部移除并关闭仓位（同时领取手续费和奖励） */
  burn?: boolean
}

export interface CollectFeesParams extends LiquidityOptions {
  position: SuiLpPosition | string
}

export interface LiquidityPlanBase {
  type: 'clmm'
  protocol: SuiLpProtocol
  pool: string
  token0: SuiLpToken
  token1: SuiLpToken
  tickLower: number
  tickUpper: number
  /** 池子当前 tick 和价格（token1 / token0） */
  tick: number
  price: number | null
  /** 领取的挖矿奖励代币（池子的奖励顺序） */
  rewardCoins: string[]
  /** 交易内容（按发送者当前的 Coin 构建），可以自己签名发送；gasSpend 是从 gas 币里拆走的 SUI */
  kind: ProgrammableTransaction
  gasSpend: bigint
}

export interface AddLiquidityPlan extends LiquidityPlanBase {
  action: 'add'
  /** 追加时是已有仓位；新建时为 null（交易执行后才有仓位对象） */
  position: string | null
  /** 按当前价格添加的流动性和数量 */
  liquidity: string
  amount0: string
  amount1: string
  amount0Formatted: string | null
  amount1Formatted: string | null
  /** 固定的一边（数量不变），另一边按上限 */
  fixed: 'token0' | 'token1'
  amount0Max: string
  amount1Max: string
  amount0Min: string
  amount1Min: string
}

export interface RemoveLiquidityPlan extends LiquidityPlanBase {
  action: 'remove' | 'collect'
  position: string
  /** 移除的流动性（collect 为 0） */
  liquidity: string
  /** 按当前价格移除能拿到的数量（不含手续费） */
  amount0: string
  amount1: string
  amount0Formatted: string | null
  amount1Formatted: string | null
  amount0Min: string
  amount1Min: string
  /** 关闭仓位 */
  burn: boolean
}

export type LiquidityResult<P> = WriteResult & { plan: P }

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

interface Loaded {
  adapter: DexAdapter
  pool: DexPool
  /** 已有仓位（新建时为 null），tick 和流动性都已知 */
  pos: (DexPosition & { tickLower: number; tickUpper: number; liquidity: bigint }) | null
  packages: Map<string, string>
}

async function loadPool(client: SuiClient, adapter: DexAdapter | null, id: string, signal?: AbortSignal): Promise<{ adapter: DexAdapter; pool: DexPool }> {
  const [o] = await client.objects([id], { fields: ['type', 'owner', 'json'], signal })
  const a = adapter ?? adapterForPool(o?.type ?? null)
  const pool = o && a?.isPool(o.type) ? a.parsePool(o) : null
  if (!a || !pool) throw new Error(`Not a supported pool: ${id}`)
  if (pool.paused) throw new Error('The pool is paused')
  await a.prepare?.(client, [pool], signal)
  return { adapter: a, pool }
}

/** 读仓位和池子；仓位要直接属于 owner。Turbos 的 tick 和流动性在仓位管理器里，用只读调用读 */
async function load(client: SuiClient, owner: string, params: { position?: SuiLpPosition | string; pool?: string; protocol?: SuiLpProtocol; signal?: AbortSignal }): Promise<Loaded> {
  const { signal } = params
  if (params.position === undefined) {
    if (!params.pool) throw new Error('Pass pool (new position) or position (add to it)')
    const forced = params.protocol ? (ADAPTERS[params.protocol] ?? null) : null
    if (params.protocol && !forced) throw new Error(`Unsupported protocol: ${params.protocol}`)
    const { adapter, pool } = await loadPool(client, forced, normalizeSuiAddress(params.pool), signal)
    return { adapter, pool, pos: null, packages: await resolvePackages(client.transport, [adapter]) }
  }
  const id = normalizeSuiAddress(typeof params.position === 'string' ? params.position : params.position.position)
  const [o] = await client.objects([id], { fields: ['type', 'owner', 'json'], signal })
  const adapter = adapterForPosition(o?.type ?? null)
  const parsed = o && adapter ? adapter.parsePosition(o) : null
  if (!o || !adapter || !parsed) throw new Error(`Not a supported LP position: ${id}`)
  if (o.owner?.kind !== 'address' || normalizeSuiAddress(o.owner.address ?? '') !== owner) {
    throw new Error(`Position ${id} is not owned by ${owner} (staked in a farm / vault, or someone else's)`)
  }
  const { pool } = await loadPool(client, adapter, parsed.pool, signal)
  const packages = await resolvePackages(client.transport, [adapter])
  let pos = parsed
  if (pos.tickLower === null || pos.tickUpper === null || pos.liquidity === null) {
    if (!adapter.state) throw new Error('Cannot read the position range')
    const state = adapter.state
    const res = await inspect(client, owner, packages, (env) => state(env, parsed), signal)
    if (!res.value) throw new Error(`Cannot read the position: ${res.error ?? 'unknown error'}`)
    pos = { ...parsed, ...res.value }
  }
  return { adapter, pool, pos: pos as Loaded['pos'], packages }
}

async function tokens(client: SuiClient, pool: DexPool, signal?: AbortSignal): Promise<[SuiLpToken, SuiLpToken]> {
  const [a, b] = await client.coins([pool.coinA, pool.coinB], { signal })
  return [
    { coinType: pool.coinA, symbol: a?.symbol ?? null, decimals: a?.decimals ?? null },
    { coinType: pool.coinB, symbol: b?.symbol ?? null, decimals: b?.decimals ?? null },
  ]
}

const priceOf = (pool: DexPool, t0: SuiLpToken, t1: SuiLpToken) => {
  if (t0.decimals === null || t1.decimals === null) return null
  const s = Number(pool.sqrtPrice) / 2 ** 64
  return s * s * 10 ** (t0.decimals - t1.decimals)
}

/** 价格 → tick（向下 / 向上对齐到 tickSpacing） */
function tickOf(price: number, t0: SuiLpToken, t1: SuiLpToken, spacing: number, round: 'down' | 'up'): number {
  if (!(price > 0) || !Number.isFinite(price)) throw new Error(`Invalid price: ${price}`)
  if (t0.decimals === null || t1.decimals === null) throw new Error('Unknown token decimals: pass tickLower / tickUpper instead of prices')
  // 先舍到 1e-9：正好在 tick 上的价格（如把 priceLower 原样传回来）不会因为浮点误差差一格
  const raw = Math.round((Math.log(price / 10 ** (t0.decimals - t1.decimals)) / Math.log(1.0001)) * 1e9) / 1e9
  const aligned = round === 'down' ? Math.floor(raw / spacing) * spacing : Math.ceil(raw / spacing) * spacing
  return Math.min(Math.max(aligned, Math.ceil(MIN_TICK / spacing) * spacing), Math.floor(MAX_TICK / spacing) * spacing)
}

const SLIPPAGE_SCALE = 1_000_000n

/** 滑点（0~1）→ 百万分之一 */
function slippageOf(slippage: number): bigint {
  if (!(slippage >= 0 && slippage < 1)) throw new Error(`Invalid slippage: ${slippage}`)
  return BigInt(Math.round(slippage * 1e6))
}

/** 上限：向上取整 */
const withSlippageUp = (v: bigint, s: bigint) => (v * (SLIPPAGE_SCALE + s) + SLIPPAGE_SCALE - 1n) / SLIPPAGE_SCALE
const withSlippageDown = (v: bigint, s: bigint) => (v * (SLIPPAGE_SCALE - s)) / SLIPPAGE_SCALE

const amountOf = (value: bigint | string | number | undefined, formatted: string | undefined, token: SuiLpToken, side: string): bigint | null => {
  if (value !== undefined && formatted !== undefined) throw new Error(`Pass either ${side} or ${side}Formatted`)
  if (formatted !== undefined) {
    if (token.decimals === null) throw new Error(`Unknown decimals of ${token.coinType}: pass ${side} in base units`)
    return parseUnits(formatted, token.decimals)
  }
  if (value === undefined) return null
  const v = BigInt(value)
  if (v < 0n) throw new Error(`${side} must not be negative`)
  return v
}

// ---------------------------------------------------------------------------
// 报价
// ---------------------------------------------------------------------------

interface AddQuote extends Loaded {
  token0: SuiLpToken
  token1: SuiLpToken
  tickLower: number
  tickUpper: number
  liquidity: bigint
  amount0: bigint
  amount1: bigint
  fixA: boolean
  amount0Max: bigint
  amount1Max: bigint
  amount0Min: bigint
  amount1Min: bigint
}

async function quoteAdd(client: SuiClient, owner: string, params: AddLiquidityParams): Promise<AddQuote> {
  const { signal } = params
  const loaded = await load(client, owner, params)
  const { pool, pos } = loaded
  const [token0, token1] = await tokens(client, pool, signal)
  let tickLower: number
  let tickUpper: number
  if (pos) {
    ;[tickLower, tickUpper] = [pos.tickLower, pos.tickUpper]
  } else if (params.fullRange) {
    ;[tickLower, tickUpper] = [Math.ceil(MIN_TICK / pool.tickSpacing) * pool.tickSpacing, Math.floor(MAX_TICK / pool.tickSpacing) * pool.tickSpacing]
  } else if (params.tickLower !== undefined && params.tickUpper !== undefined) {
    ;[tickLower, tickUpper] = [params.tickLower, params.tickUpper]
    if (tickLower % pool.tickSpacing || tickUpper % pool.tickSpacing) throw new Error(`Ticks must be multiples of the tick spacing ${pool.tickSpacing}`)
  } else if (params.priceLower !== undefined && params.priceUpper !== undefined) {
    tickLower = tickOf(params.priceLower, token0, token1, pool.tickSpacing, 'down')
    tickUpper = tickOf(params.priceUpper, token0, token1, pool.tickSpacing, 'up')
  } else {
    throw new Error('Pass a price range (priceLower / priceUpper, tickLower / tickUpper or fullRange: true)')
  }
  if (tickLower >= tickUpper) throw new Error(`Invalid range: tickLower ${tickLower} >= tickUpper ${tickUpper}`)
  const a0 = amountOf(params.amount0, params.amount0Formatted, token0, 'amount0')
  const a1 = amountOf(params.amount1, params.amount1Formatted, token1, 'amount1')
  if ((a0 ?? 0n) === 0n && (a1 ?? 0n) === 0n) throw new Error('Pass amount0 or amount1')

  const slip = slippageOf(params.slippage ?? 0.005)
  // 区间在当前价格一侧时只需要一种代币：价格在区间上方只要 token1，下方只要 token0
  const above = pool.tick >= tickUpper
  const below = pool.tick < tickLower
  if (below && !a0) throw new Error('The price is below the range: only token0 is needed, pass amount0')
  if (above && !a1) throw new Error('The price is above the range: only token1 is needed, pass amount1')
  const [sa, sb] = [sqrtPriceAtTick(tickLower), sqrtPriceAtTick(tickUpper)]
  // 两边都给时：两种固定方式都算，用流动性较少的（另一边不超过给的数量）
  const options = [...(a0 && !above ? [{ fixA: true, amount: a0 }] : []), ...(a1 && !below ? [{ fixA: false, amount: a1 }] : [])].map((o) => ({
    ...o,
    liquidity: liquidityForAmount(pool.sqrtPrice, sa, sb, o.amount, o.fixA),
  }))
  const chosen = options.reduce((best, o) => (o.liquidity < best.liquidity ? o : best))
  if (chosen.liquidity === 0n) throw new Error('The amount is too small, or the price range needs only the other token')
  // 按这个流动性池子收取的数量（向上取整）；固定的一边就用给的数量
  const [m0, m1] = amountsForLiquidity(pool.sqrtPrice, sa, sb, chosen.liquidity, true)
  const amount0 = chosen.fixA ? chosen.amount : m0
  const amount1 = chosen.fixA ? m1 : chosen.amount
  // 另一边的上限 = 数量 × (1 + 滑点)，两边都给时不超过给的数量
  let amount0Max = chosen.fixA ? chosen.amount : withSlippageUp(m0, slip)
  let amount1Max = chosen.fixA ? withSlippageUp(m1, slip) : chosen.amount
  if (a0 && !chosen.fixA && amount0Max > a0) amount0Max = a0
  if (a1 && chosen.fixA && amount1Max > a1) amount1Max = a1
  return {
    ...loaded,
    token0,
    token1,
    tickLower,
    tickUpper,
    liquidity: chosen.liquidity,
    amount0,
    amount1,
    fixA: chosen.fixA,
    amount0Max,
    amount1Max,
    amount0Min: withSlippageDown(m0, slip),
    amount1Min: withSlippageDown(m1, slip),
  }
}

interface RemoveQuote extends Loaded {
  pos: NonNullable<Loaded['pos']>
  /** 要领取的奖励（下标） */
  claim: number[]
  token0: SuiLpToken
  token1: SuiLpToken
  liquidity: bigint
  amount0: bigint
  amount1: bigint
  amount0Min: bigint
  amount1Min: bigint
  burn: boolean
}

async function quoteRemove(client: SuiClient, owner: string, params: RemoveLiquidityParams | CollectFeesParams, collect: boolean): Promise<RemoveQuote> {
  const { signal } = params
  const loaded = await load(client, owner, { position: params.position, signal })
  const pos = loaded.pos as NonNullable<Loaded['pos']>
  const { pool, adapter } = loaded
  const [token0, token1] = await tokens(client, pool, signal)
  const p = params as RemoveLiquidityParams
  const burn0 = !collect && !!p.burn
  // 要领取的奖励：关闭仓位时全部领取（报价到执行之间奖励可能从 0 开始累积，仓位要清空才能关闭）；
  // 其他时候先只读调用一次，只领取有数量的（不留下数量为 0 的币）
  const all = pool.rewardCoins.map((_, k) => k)
  let claim = all
  if (!burn0) {
    // 节点问题直接抛出；只读调用执行失败时不领奖励
    const read = await inspect(client, owner, loaded.packages, (env) => adapter.read(env, pos, pool, () => env.ptb.owned(pos.ref as NonNullable<DexPosition['ref']>)), signal)
    claim = read.value?.rewards ? all.filter((k) => ((read.value?.rewards as bigint[])[k] ?? 0n) > 0n) : []
  }
  const burn = burn0
  let liquidity = 0n
  if (!collect) {
    if (burn || (p.liquidity === undefined && p.percent === undefined)) liquidity = pos.liquidity
    else if (p.liquidity !== undefined) {
      liquidity = BigInt(p.liquidity)
      if (liquidity < 0n) throw new Error('liquidity must not be negative')
    }
    else {
      const percent = p.percent as number
      if (!(percent > 0 && percent <= 100)) throw new Error(`Invalid percent: ${percent}`)
      liquidity = (pos.liquidity * BigInt(Math.round(percent * 1e6))) / 100_000_000n
    }
    if (liquidity > pos.liquidity) throw new Error(`The position has only ${pos.liquidity} liquidity`)
    if (liquidity === 0n && !burn) throw new Error('Nothing to remove: the position has no liquidity')
  }
  if (liquidity > 0n && liquidity === pos.liquidity) await adapter.checkWithdrawAll?.(client, owner, pos, pool, signal)
  const slip = slippageOf(params.slippage ?? 0.005)
  const [a, b] = amountsForLiquidity(pool.sqrtPrice, sqrtPriceAtTick(pos.tickLower), sqrtPriceAtTick(pos.tickUpper), liquidity)
  return { ...loaded, pos, claim, token0, token1, liquidity, amount0: a, amount1: b, amount0Min: withSlippageDown(a, slip), amount1Min: withSlippageDown(b, slip), burn }
}

// ---------------------------------------------------------------------------
// 交易
// ---------------------------------------------------------------------------

/**
 * 发送者付 amount 的 coinType：SUI 从 gas 币拆（自己付 gas 时），其他按 Coin + 地址余额凑。
 * source 是拆出它的、交易后还在发送者名下的 Coin（找零可以合并回去），没有时为 null
 */
async function payCoin(ptb: PtbBuilder, ctx: BuildContext, owner: string, coinType: string, amount: bigint, fromGas: boolean): Promise<{ coin: Argument; gasSpend: bigint; source: Argument | (() => Argument) | null }> {
  if (amount === 0n) return { coin: ptb.moveCall('0x2::coin::zero', [coinType], []), gasSpend: 0n, source: await sinkFor(ptb, ctx, owner, coinType, fromGas) }
  // SUI：自己付 gas、SUI Coin 足够（多出一点留给 gas）时从 gas 币拆，否则按 Coin + 地址余额凑
  if (fromGas && coinType === SUI_COIN_TYPE && (await ctx.coins(owner, SUI_COIN_TYPE, amount + GAS_MARGIN)).slice(0, 255).reduce((s, c) => s + c.balance, 0n) >= amount + GAS_MARGIN) {
    const split = ptb.command({ kind: 'splitCoins', coin: ptb.gas, amounts: [ptb.pure(pure.u64(amount))] })
    return { coin: ptb.nested(split, 0), gasSpend: amount, source: ptb.gas }
  }
  const source = await gatherCoin(ptb, ctx, owner, coinType, amount)
  // 全部来自地址余额时正好是 amount，整个传进去
  if (source.temporary) return { coin: source.coin, gasSpend: 0n, source: null }
  const split = ptb.command({ kind: 'splitCoins', coin: source.coin, amounts: [ptb.pure(pure.u64(amount))] })
  return { coin: ptb.nested(split, 0), gasSpend: 0n, source: source.coin }
}

/**
 * 发送者已有的一个 coinType 的 Coin（交易里还没用到的）：找零和领取的币合并进去，不新建对象。
 * SUI 在发送者自己付 gas 时用 gas 币；没有时为 null（照常转给发送者）
 */
async function sinkFor(ptb: PtbBuilder, ctx: BuildContext, owner: string, coinType: string, fromGas: boolean): Promise<Argument | (() => Argument) | null> {
  if (coinType === SUI_COIN_TYPE) return fromGas ? ptb.gas : null
  const [coin] = await ctx.coins(owner, coinType, 1n)
  return coin ? () => ptb.owned(coin) : null
}

async function positionRef(client: SuiClient, id: string, read: () => { signal?: AbortSignal; minCheckpoint?: number }) {
  const [o] = await client.objects([id], { fields: ['owner'], ...read() })
  if (!o || o.version === null || !o.digest) throw new Error(`Position ${id} not found`)
  return { objectId: o.objectId, version: o.version, digest: o.digest }
}

async function addKind(client: SuiClient, ctx: BuildContext, owner: string, q: AddQuote, fromGas: boolean): Promise<{ kind: ProgrammableTransaction; gasSpend: bigint }> {
  const ptb = new PtbBuilder()
  const env = createEnv(ptb, owner, q.packages)
  const a = await payCoin(ptb, ctx, owner, q.pool.coinA, q.amount0Max, fromGas)
  const b = await payCoin(ptb, ctx, owner, q.pool.coinB, q.amount1Max, fromGas)
  if (a.source) env.sink(q.pool.coinA, a.source)
  if (b.source && q.pool.coinB !== q.pool.coinA) env.sink(q.pool.coinB, b.source)
  const args = {
    tickLower: q.tickLower,
    tickUpper: q.tickUpper,
    coinA: a.coin,
    coinB: b.coin,
    liquidity: q.liquidity,
    amount0: q.amount0,
    amount1: q.amount1,
    fixA: q.fixA,
    amount0Max: q.amount0Max,
    amount1Max: q.amount1Max,
    amount0Min: q.amount0Min,
    amount1Min: q.amount1Min,
  }
  if (q.pos) q.adapter.add(env, q.pool, ptb.owned(await positionRef(client, q.pos.id, ctx.readOptions)), args)
  else q.adapter.open(env, q.pool, args)
  env.finish()
  return { kind: ptb.build(), gasSpend: a.gasSpend + b.gasSpend }
}

async function removeKind(client: SuiClient, ctx: BuildContext, owner: string, q: RemoveQuote, collect: boolean, fromGas: boolean): Promise<{ kind: ProgrammableTransaction; gasSpend: bigint }> {
  const ptb = new PtbBuilder()
  const env = createEnv(ptb, owner, q.packages)
  const position = ptb.owned(await positionRef(client, q.pos.id, ctx.readOptions))
  // 取回 / 领取的币合并进发送者已有的同类 Coin
  for (const coinType of new Set([q.pool.coinA, q.pool.coinB, ...q.claim.map((k) => q.pool.rewardCoins[k] as string)])) {
    const sink = await sinkFor(ptb, ctx, owner, coinType, fromGas)
    if (sink) env.sink(coinType, sink)
  }
  // 先领取手续费和奖励（收到发送者名下），再移除 / 关闭
  q.adapter.collect(env, q.pool, position, q.claim)
  if (!collect && (q.liquidity > 0n || q.burn)) {
    q.adapter.withdraw(env, q.pool, position, { liquidity: q.liquidity, amount0Min: q.amount0Min, amount1Min: q.amount1Min, close: q.burn })
  }
  env.finish()
  return { kind: ptb.build(), gasSpend: 0n }
}

const fmt = (v: bigint, t: SuiLpToken) => (t.decimals === null ? null : formatUnits(v, t.decimals))

function base(q: { adapter: DexAdapter; pool: DexPool; token0: SuiLpToken; token1: SuiLpToken }, ticks: [number, number], built: { kind: ProgrammableTransaction; gasSpend: bigint }) {
  return {
    type: 'clmm' as const,
    protocol: q.adapter.protocol,
    pool: q.pool.id,
    token0: q.token0,
    token1: q.token1,
    tickLower: ticks[0],
    tickUpper: ticks[1],
    tick: q.pool.tick,
    price: priceOf(q.pool, q.token0, q.token1),
    rewardCoins: q.pool.rewardCoins,
    kind: built.kind,
    gasSpend: built.gasSpend,
  }
}

function addPlan(q: AddQuote, built: { kind: ProgrammableTransaction; gasSpend: bigint }): AddLiquidityPlan {
  return {
    ...base(q, [q.tickLower, q.tickUpper], built),
    action: 'add',
    position: q.pos?.id ?? null,
    liquidity: q.liquidity.toString(),
    amount0: q.amount0.toString(),
    amount1: q.amount1.toString(),
    amount0Formatted: fmt(q.amount0, q.token0),
    amount1Formatted: fmt(q.amount1, q.token1),
    fixed: q.fixA ? 'token0' : 'token1',
    amount0Max: q.amount0Max.toString(),
    amount1Max: q.amount1Max.toString(),
    amount0Min: q.amount0Min.toString(),
    amount1Min: q.amount1Min.toString(),
  }
}

function removePlan(q: RemoveQuote, collect: boolean, built: { kind: ProgrammableTransaction; gasSpend: bigint }): RemoveLiquidityPlan {
  return {
    ...base(q, [q.pos.tickLower, q.pos.tickUpper], built),
    action: collect ? 'collect' : 'remove',
    position: q.pos.id,
    liquidity: q.liquidity.toString(),
    amount0: q.amount0.toString(),
    amount1: q.amount1.toString(),
    amount0Formatted: fmt(q.amount0, q.token0),
    amount1Formatted: fmt(q.amount1, q.token1),
    amount0Min: q.amount0Min.toString(),
    amount1Min: q.amount1Min.toString(),
    burn: q.burn,
  }
}

/** 报价并构建交易（不签名）：发送者自己付 gas；kind 可以交给 batchCall 或自己签名 */
export async function buildAddLiquidity(client: SuiClient, owner: string, params: AddLiquidityParams): Promise<AddLiquidityPlan> {
  const sender = normalizeSuiAddress(owner)
  const q = await quoteAdd(client, sender, params)
  return addPlan(q, await addKind(client, buildContext(client, null, () => ({ signal: params.signal })), sender, q, true))
}

export async function buildRemoveLiquidity(client: SuiClient, owner: string, params: RemoveLiquidityParams): Promise<RemoveLiquidityPlan> {
  const q = await quoteRemove(client, normalizeSuiAddress(owner), params, false)
  return removePlan(q, false, await removeKind(client, buildContext(client, null, () => ({ signal: params.signal })), normalizeSuiAddress(owner), q, false, true))
}

export async function buildCollectFees(client: SuiClient, owner: string, params: CollectFeesParams): Promise<RemoveLiquidityPlan> {
  const q = await quoteRemove(client, normalizeSuiAddress(owner), params, true)
  return removePlan(q, true, await removeKind(client, buildContext(client, null, () => ({ signal: params.signal })), normalizeSuiAddress(owner), q, true, true))
}

export interface LiquiditySendOptions extends SendOptions {
  /** 付 gas 的钱包（赞助交易） */
  sponsor?: SignerInput
  /** 发送前检查余额（按上限），默认 true */
  checkBalance?: boolean
}

/** 发送；结果里的 plan.kind / gasSpend 是实际发出（或最后一次构建）的交易 */
async function send<P extends { kind: ProgrammableTransaction; gasSpend: bigint }>(
  client: SuiClient,
  sender: ResolvedSigner,
  plan: P,
  build: (ctx: BuildContext, sponsored: boolean) => Promise<{ kind: ProgrammableTransaction; gasSpend: bigint }>,
  options: LiquiditySendOptions,
): Promise<LiquidityResult<P>> {
  const sponsor = options.sponsor === undefined ? undefined : await resolveSigner(options.sponsor)
  const sponsored = !!sponsor && sponsor.address !== sender.address
  let result = toWriteResult(0, sender.address, emptyOutcome('skipped'))
  let built: { kind: ProgrammableTransaction; gasSpend: bigint } | null = null
  await sendJobs(
    client,
    [
      {
        sender,
        sponsor,
        build: async (ctx) => (built = await build(ctx, sponsored)),
        onUpdate: (outcome) => {
          result = toWriteResult(0, sender.address, outcome)
          options.onUpdate?.(result)
        },
      },
    ],
    options,
  )
  const last = built as { kind: ProgrammableTransaction; gasSpend: bigint } | null
  return { ...result, plan: last ? { ...plan, kind: last.kind, gasSpend: last.gasSpend } : plan }
}

/**
 * 添加流动性：新建仓位（pool + 价格区间）或往已有仓位追加（position），给一边的数量。
 *
 * ```ts
 * await addLiquidity(sui, key, { pool, priceLower: 0.9, priceUpper: 1.1, amount0Formatted: '100' })
 * const [position] = await lpPositions(sui, owner)
 * await addLiquidity(sui, key, { position, amount1Formatted: '5' })
 * ```
 */
export async function addLiquidity(client: SuiClient, from: SignerInput, params: AddLiquidityParams, options: LiquiditySendOptions = {}): Promise<LiquidityResult<AddLiquidityPlan>> {
  const sender = await resolveSigner(from)
  const q = await quoteAdd(client, sender.address, params)
  if (options.checkBalance ?? true) {
    const signal = options.signal ?? params.signal
    const sponsored = options.sponsor !== undefined && (await resolveSigner(options.sponsor)).address !== sender.address
    await Promise.all(
      ([[q.pool.coinA, q.amount0Max], [q.pool.coinB, q.amount1Max]] as const).map(async ([coinType, amount]) => {
        // 自己付 gas 时 SUI 还要留出 gas（按 0.05 SUI 估）
        const need = amount + (coinType === SUI_COIN_TYPE && !sponsored ? 50_000_000n : 0n)
        if (amount === 0n) return
        const { balance } = await getBalance(client.transport, sender.address, coinType, { signal })
        if (balance.balance < need) throw new Error(`Insufficient balance of ${coinType}: need ${need}${coinType === SUI_COIN_TYPE && !sponsored ? ' (including about 0.05 SUI for gas)' : ''}, have ${balance.balance}`)
      }),
    )
  }
  const plan = addPlan(q, { kind: { inputs: [], commands: [] }, gasSpend: 0n })
  return send(client, sender, plan, (ctx, sponsored) => addKind(client, ctx, sender.address, q, !sponsored), { ...options, signal: options.signal ?? params.signal })
}

/** 移除流动性（按比例或数量，同时领取手续费和奖励）；burn: true 全部移除并关闭仓位 */
export async function removeLiquidity(client: SuiClient, from: SignerInput, params: RemoveLiquidityParams, options: LiquiditySendOptions = {}): Promise<LiquidityResult<RemoveLiquidityPlan>> {
  const sender = await resolveSigner(from)
  const q = await quoteRemove(client, sender.address, params, false)
  const plan = removePlan(q, false, { kind: { inputs: [], commands: [] }, gasSpend: 0n })
  return send(client, sender, plan, (ctx, sponsored) => removeKind(client, ctx, sender.address, q, false, !sponsored), { ...options, signal: options.signal ?? params.signal })
}

/** 只领取手续费和挖矿奖励 */
export async function collectFees(client: SuiClient, from: SignerInput, params: CollectFeesParams, options: LiquiditySendOptions = {}): Promise<LiquidityResult<RemoveLiquidityPlan>> {
  const sender = await resolveSigner(from)
  const q = await quoteRemove(client, sender.address, params, true)
  const plan = removePlan(q, true, { kind: { inputs: [], commands: [] }, gasSpend: 0n })
  return send(client, sender, plan, (ctx, sponsored) => removeKind(client, ctx, sender.address, q, true, !sponsored), { ...options, signal: options.signal ?? params.signal })
}
