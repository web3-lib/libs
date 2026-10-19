/**
 * 添加 / 移除流动性（子路径 `@w3lib/sui-batch-call/liquidity`）：与 /lp 相同的协议。
 * 集中流动性：报价按集中流动性的公式在本地算；交易调用各 DEX 合约的函数，合约检查数量上限 / 下限，超出滑点时整笔失败。
 * 传统 AMM：给一边时另一边按储备比例，LP = min(数量 / 储备 × 总量)；移除按 LP 份额
 */
import { SUI_COIN_TYPE, normalizeStructTag, normalizeSuiAddress } from './address.js'
import { MAX_TICK, MIN_TICK, amountsForLiquidity, liquidityForAmount, sqrtPriceAtTick } from './clmmMath.js'
import type { SuiClient } from './client.js'
import { createEnv, resolvePackages } from './dex/env.js'
import { AMM_ADAPTERS, ammAdapterForHolding, ammAdapterForPool } from './amm/adapters.js'
import type { AmmAdapter, AmmHolding, AmmPool, SuiAmmProtocol } from './amm/types.js'
import { CETUS_DLMM, CETUS_DLMM_POSITION_TYPE, MAX_BIN_WIDTH, binPrice, parseDlmmPool, parseDlmmPosition, readDlmm, type DlmmPool, type DlmmPosition } from './dlmm.js'
import { addDlmm, closeDlmm, collectDlmm, guardDlmm, openDlmm, removeDlmm } from './dlmmTx.js'
import { AFTERMATH, MAX_POOL_COINS, isAftermathObject, loadAftermathPool, parseAftermathFees, protocolFeeOf, withdrawAllAmounts, type AftermathFees, type AftermathPool } from './aftermath.js'
import { depositAll, depositOne, withdrawAll, withdrawOne } from './aftermathTx.js'
import { ADAPTERS, adapterForPool, adapterForPosition } from './dex/adapters.js'
import { inspect } from './dex/inspect.js'
import { guardMin, payCoin, sinkFor } from './dex/pay.js'
import type { DexAdapter, DexPool, DexPosition, SuiClmmProtocol, SuiLpProtocol } from './dex/types.js'
import { formatUnits, parseUnits } from './format.js'
import type { SuiLpPosition, SuiLpToken } from './lp.js'
import { getBalance, inspectTransaction, type SuiObject } from './services.js'
import { encodeTransactionData, type Argument, type ProgrammableTransaction } from './write/bcs.js'
import { PtbBuilder } from './write/ptb.js'
import { buildContext, emptyOutcome, sendJobs, toWriteResult, type BuildContext, type SendOptions, type WriteResult } from './write/send.js'
import { resolveSigner, type ResolvedSigner, type SignerInput } from './write/signer.js'

export interface LiquidityOptions {
  /** 数量滑点，默认 0.005：添加时另一边的上限 = 按当前价格算出的数量 × (1 + s)，下限 = 数量 × (1 − s)；移除时下限 = 数量 × (1 − s) */
  slippage?: number
  signal?: AbortSignal
}

/** 新建仓位，或往已有仓位追加（传统 AMM：往池子里加，拿到 LP） */
export interface AddLiquidityParams extends LiquidityOptions {
  /** 新建：协议（不传时按池子的类型认出） */
  protocol?: SuiLpProtocol
  /** 新建：池子地址（FlowX V2 是 lpPositions 结果里的 pool） */
  pool?: string
  /** 追加：已有仓位（lpPositions 的结果，或仓位对象 ID）；传统 AMM 的仓位表示往它的池子里加 */
  position?: SuiLpPosition | string
  /** 集中流动性新建时的价格区间（token1 / token0，按精度换算）；或 tickLower / tickUpper（DLMM 是 bin id）；或 fullRange（DLMM 不支持） */
  priceLower?: number
  priceUpper?: number
  tickLower?: number
  tickUpper?: number
  fullRange?: boolean
  /**
   * 数量（最小单位或按精度换算的字符串），给一边；两边都给时按能加的较少的一边算，另一边不超过给的数量。
   * DLMM：两边各自给（当前 bin 以上的 bin 放 token0，以下的放 token1），区间在当前价格一侧时只给那一种
   */
  amount0?: bigint | string | number
  amount1?: bigint | string | number
  amount0Formatted?: string
  amount1Formatted?: string
  /** 多币池（Aftermath）：给其中一种币（代币类型）的数量；其余的币按池子的比例，single: true 时只存这一种 */
  coin?: string
  amount?: bigint | string | number
  amountFormatted?: string
  single?: boolean
}

export interface RemoveLiquidityParams extends LiquidityOptions {
  /** 仓位：lpPositions 的结果，或仓位对象 ID（Kriya 是 KriyaLPToken 的 ID） */
  position?: SuiLpPosition | string
  /** LP 是普通代币时（DipCoin、FlowX V2、Aftermath）也可以只给池子：移除发送者持有的这个池子的 LP */
  pool?: string
  /** 和 pool 一起用：指定协议（不传时按池子的类型认出） */
  protocol?: SuiLpProtocol
  /** 移除的比例（0~100），默认 100；或 liquidity 指定数量（集中流动性是 L，传统 AMM 是 LP 数量） */
  percent?: number
  liquidity?: bigint | string
  /** 集中流动性：全部移除并关闭仓位（同时领取手续费和奖励） */
  burn?: boolean
  /** 多币池（Aftermath）：只取回这一种币（代币类型）；不传时按比例取回全部币 */
  outCoin?: string
}

/** 集中流动性的仓位（传统 AMM 的手续费已经计入 LP 份额，没有单独领取） */
export interface CollectFeesParams extends LiquidityOptions {
  position: SuiLpPosition | string
}

/** 多币池的计划里每种币：数量（预计存入 / 取回）、上限、下限 */
export interface LiquidityPlanCoin extends SuiLpToken {
  amount: string
  amountFormatted: string | null
  amountMax: string
  amountMin: string
}

export interface LiquidityPlanBase {
  type: 'clmm' | 'dlmm' | 'amm' | 'multi'
  protocol: SuiLpProtocol
  pool: string
  token0: SuiLpToken
  token1: SuiLpToken
  /** 集中流动性的区间和池子当前 tick（DLMM 是 bin）；传统 AMM 为 null */
  tickLower: number | null
  tickUpper: number | null
  tick: number | null
  /** DLMM：相邻 bin 的价格差（万分之一），和按滑点允许当前 bin 偏离报价时多少个 bin（超出时交易失败）；其他为 null */
  binStep: number | null
  binShift: number | null
  /** 池子当前价格（token1 / token0，按精度换算；传统 AMM 按储备的比例） */
  price: number | null
  /** 传统 AMM：LP 代币的类型；集中流动性为 null */
  lpCoinType: string | null
  /** 多币池：每种币（池子的顺序；token0 / token1 是前两种）；其他为 null */
  coins: LiquidityPlanCoin[] | null
  /** 领取的挖矿奖励代币（池子的奖励顺序；传统 AMM 为空） */
  rewardCoins: string[]
  /** 交易内容（按发送者当前的 Coin 构建），可以自己签名发送；gasSpend 是从 gas 币里拆走的 SUI */
  kind: ProgrammableTransaction
  gasSpend: bigint
}

export interface AddLiquidityPlan extends LiquidityPlanBase {
  action: 'add'
  /** 追加时是已有仓位；新建时为 null（交易执行后才有仓位对象） */
  position: string | null
  /** 按当前价格添加的流动性（传统 AMM 是预计得到的 LP 数量）和数量 */
  liquidity: string
  amount0: string
  amount1: string
  amount0Formatted: string | null
  amount1Formatted: string | null
  /** 集中流动性：固定的一边（数量不变），另一边按上限；传统 AMM 为 null（两边都按给的数量放进去，多余的由合约退回） */
  fixed: 'token0' | 'token1' | null
  amount0Max: string
  amount1Max: string
  amount0Min: string
  amount1Min: string
}

export interface RemoveLiquidityPlan extends LiquidityPlanBase {
  action: 'remove' | 'collect'
  /** 仓位对象（传统 AMM 的 LP 是普通 Coin 时为 null） */
  position: string | null
  /** 移除的流动性（collect 为 0；传统 AMM 是 LP 数量） */
  liquidity: string
  /** 按当前价格移除能拿到的数量（不含手续费） */
  amount0: string
  amount1: string
  amount0Formatted: string | null
  amount1Formatted: string | null
  amount0Min: string
  amount1Min: string
  /** 关闭仓位（传统 AMM 为 false） */
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

async function loadPool(client: SuiClient, adapter: DexAdapter | null, id: string, peek: Peek, signal?: AbortSignal): Promise<{ adapter: DexAdapter; pool: DexPool }> {
  const o = await peek(id)
  const a = adapter ?? adapterForPool(o?.type ?? null)
  const pool = o && a?.isPool(o.type) ? a.parsePool(o) : null
  if (!a || !pool) throw new Error(`Not a supported pool: ${id}`)
  if (pool.paused) throw new Error('The pool is paused')
  await a.prepare?.(client, [pool], signal)
  return { adapter: a, pool }
}

/** 读仓位和池子；仓位要直接属于 owner。Turbos 的 tick 和流动性在仓位管理器里，用只读调用读 */
async function load(
  client: SuiClient,
  owner: string,
  params: { position?: SuiLpPosition | string; pool?: string; protocol?: SuiLpProtocol; signal?: AbortSignal },
  peek: Peek = peeker(client, params.signal),
): Promise<Loaded> {
  const { signal } = params
  if (params.position === undefined) {
    if (!params.pool) throw new Error('Pass pool (new position) or position (add to it)')
    const forced = params.protocol ? (ADAPTERS[params.protocol as SuiClmmProtocol] ?? null) : null
    if (params.protocol && !forced) throw new Error(`Unsupported protocol: ${params.protocol}`)
    const { adapter, pool } = await loadPool(client, forced, normalizeSuiAddress(params.pool), peek, signal)
    return { adapter, pool, pos: null, packages: await resolvePackages(client.transport, [adapter]) }
  }
  const id = normalizeSuiAddress(typeof params.position === 'string' ? params.position : (params.position.position ?? ''))
  const o = await peek(id)
  const adapter = adapterForPosition(o?.type ?? null)
  const parsed = o && adapter ? adapter.parsePosition(o) : null
  if (!o || !adapter || !parsed) throw new Error(`Not a supported LP position: ${id}`)
  if (o.owner?.kind !== 'address' || normalizeSuiAddress(o.owner.address ?? '') !== owner) {
    throw new Error(`Position ${id} is not owned by ${owner} (staked in a farm / vault, or someone else's)`)
  }
  const { pool } = await loadPool(client, adapter, parsed.pool, peek, signal)
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

async function tokens(client: SuiClient, pool: { coinA: string; coinB: string }, signal?: AbortSignal): Promise<[SuiLpToken, SuiLpToken]> {
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

/** total 的 percent%（0~100，默认 100，精确到百万分之一） */
function portion(total: bigint, percent = 100): bigint {
  if (!(percent > 0 && percent <= 100)) throw new Error(`Invalid percent: ${percent}`)
  return (total * BigInt(Math.round(percent * 1e6))) / 100_000_000n
}

/** 要移除的 LP 数量：liquidity 给定，或持有的 percent% */
function lpToRemove(held: bigint, params: { liquidity?: bigint | string; percent?: number }): bigint {
  const amount = params.liquidity !== undefined ? BigInt(params.liquidity) : portion(held, params.percent)
  if (amount <= 0n) throw new Error('Nothing to remove: no LP tokens')
  if (amount > held) throw new Error(`Only ${held} LP tokens are held`)
  return amount
}

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

async function quoteAdd(client: SuiClient, owner: string, params: AddLiquidityParams, peek?: Peek): Promise<AddQuote> {
  const { signal } = params
  const loaded = await load(client, owner, params, peek)
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

async function quoteRemove(client: SuiClient, owner: string, params: RemoveLiquidityParams | CollectFeesParams, collect: boolean, peek?: Peek): Promise<RemoveQuote> {
  const { signal } = params
  const loaded = await load(client, owner, { position: params.position, signal }, peek)
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
    else liquidity = portion(pos.liquidity, p.percent)
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
    lpCoinType: null,
    binStep: null,
    binShift: null,
    coins: null,
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

// ---------------------------------------------------------------------------
// 传统 AMM（DipCoin、FlowX V2、Kriya）
// ---------------------------------------------------------------------------

interface AmmTarget {
  adapter: AmmAdapter
  pool: AmmPool
  /** Kriya：要移除的 KriyaLPToken；LP 是普通 Coin 时为 null */
  holding: AmmHolding | null
  packages: Map<string, string>
}

const isAmmProtocol = (p: SuiLpProtocol | undefined): p is SuiAmmProtocol => p !== undefined && p in AMM_ADAPTERS

/** 参数指向传统 AMM 的池子 / LP 时读出池子；集中流动性返回 null */
/** 按 ID 读对象（同一次添加 / 移除里各协议的判断共用，不重复读） */
type Peek = (id: string) => Promise<SuiObject | null>

function peeker(client: SuiClient, signal?: AbortSignal): Peek {
  const cache = new Map<string, Promise<SuiObject | null>>()
  return (id) => {
    const key = normalizeSuiAddress(id)
    let p = cache.get(key)
    if (!p) {
      p = client.objects([key], { fields: ['type', 'owner', 'json'], signal }).then(([o]) => o ?? null)
      cache.set(key, p)
    }
    return p
  }
}

async function loadAmm(client: SuiClient, owner: string, params: { position?: SuiLpPosition | string; pool?: string; protocol?: SuiLpProtocol; signal?: AbortSignal }, peek: Peek): Promise<AmmTarget | null> {
  const position = params.position
  if (position !== undefined && typeof position !== 'string' && position.type !== 'amm') return null
  if (position === undefined && params.protocol !== undefined && !isAmmProtocol(params.protocol)) return null
  const id = typeof position === 'string' ? position : position ? position.position ?? position.pool : params.pool
  if (!id) return null
  const o = await peek(id)
  let holding: AmmHolding | null = null
  let adapter = ammAdapterForHolding(o?.type ?? null)
  let poolId: string
  if (o && adapter) {
    holding = adapter.parseHolding?.(o) ?? null
    if (!holding?.pool) throw new Error(`Not a supported LP object: ${id}`)
    if (o.owner?.kind !== 'address' || normalizeSuiAddress(o.owner.address ?? '') !== owner) throw new Error(`LP object ${id} is not owned by ${owner}`)
    poolId = holding.pool
  } else {
    adapter = ammAdapterForPool(o?.type ?? null)
    if (!o || !adapter) {
      if (position && typeof position !== 'string') throw new Error(`Cannot read the pool of the position: ${id}`)
      if (isAmmProtocol(params.protocol)) throw new Error(`Not a ${AMM_ADAPTERS[params.protocol].name} pool or LP object: ${id}`)
      return null
    }
    poolId = o.objectId
  }
  if (params.protocol !== undefined && params.protocol !== adapter.protocol) throw new Error(`The pool belongs to ${adapter.protocol}, not ${params.protocol}`)
  const p = poolId === o.objectId ? o : await peek(poolId)
  const pool = p ? adapter.parsePool(p) : null
  if (!pool) throw new Error(`Cannot read the pool ${poolId}`)
  return { adapter, pool, holding, packages: await resolvePackages(client.transport, [adapter]) }
}

const ammPrice = (pool: AmmPool, t0: SuiLpToken, t1: SuiLpToken) =>
  t0.decimals === null || t1.decimals === null || pool.reserveA === 0n ? null : (Number(pool.reserveB) / Number(pool.reserveA)) * 10 ** (t0.decimals - t1.decimals)

function ammBase(t: AmmTarget, token0: SuiLpToken, token1: SuiLpToken) {
  return {
    type: 'amm' as const,
    protocol: t.adapter.protocol,
    pool: t.pool.id,
    token0,
    token1,
    tickLower: null,
    tickUpper: null,
    tick: null,
    price: ammPrice(t.pool, token0, token1),
    lpCoinType: t.pool.lpCoinType,
    binStep: null,
    binShift: null,
    coins: null,
    rewardCoins: [],
    kind: EMPTY_KIND,
    gasSpend: 0n,
  }
}

async function prepareAmmAdd(client: SuiClient, owner: string, t: AmmTarget, params: AddLiquidityParams): Promise<Prepared<AddLiquidityPlan>> {
  const { pool, adapter } = t
  if (!pool.depositEnabled) throw new Error('Deposits are disabled in this pool')
  if (pool.reserveA === 0n || pool.reserveB === 0n || pool.lpSupply === 0n) throw new Error('The pool is empty: creating pools is not supported')
  if (params.priceLower !== undefined || params.priceUpper !== undefined || params.tickLower !== undefined || params.tickUpper !== undefined) {
    throw new Error(`${adapter.name} is a constant-product AMM: there is no price range`)
  }
  const [token0, token1] = await tokens(client, pool, params.signal)
  let a = amountOf(params.amount0, params.amount0Formatted, token0, 'amount0')
  let b = amountOf(params.amount1, params.amount1Formatted, token1, 'amount1')
  if (a === null && b === null) throw new Error('Pass amount0 or amount1')
  // 给一边时另一边按储备比例（向上取整，保证不少于比例）；两边都给时合约按比例取，多余的退回
  if (b === null) b = ((a as bigint) * pool.reserveB + pool.reserveA - 1n) / pool.reserveA
  if (a === null) a = (b * pool.reserveA + pool.reserveB - 1n) / pool.reserveB
  const lpA = (a * pool.lpSupply) / pool.reserveA
  const lpB = (b * pool.lpSupply) / pool.reserveB
  const lp = lpA < lpB ? lpA : lpB
  if (lp === 0n) throw new Error('The amount is too small: it would mint no LP tokens')
  if (lp < pool.minLp) throw new Error(`${adapter.name} requires at least ${pool.minLp} LP tokens per deposit; this would mint about ${lp}`)
  const slip = slippageOf(params.slippage ?? 0.005)
  // 按比例实际会用掉的数量（另一边多给的退回），下限按它算
  const usedA = lpA < lpB ? a : (lp * pool.reserveA) / pool.lpSupply
  const usedB = lpA < lpB ? (lp * pool.reserveB) / pool.lpSupply : b
  const minA = withSlippageDown(usedA, slip)
  const minB = withSlippageDown(usedB, slip)
  const amountA = a
  const amountB = b
  const plan: AddLiquidityPlan = {
    ...ammBase(t, token0, token1),
    action: 'add',
    position: null,
    liquidity: lp.toString(),
    amount0: usedA.toString(),
    amount1: usedB.toString(),
    amount0Formatted: fmt(usedA, token0),
    amount1Formatted: fmt(usedB, token1),
    fixed: null,
    amount0Max: amountA.toString(),
    amount1Max: amountB.toString(),
    amount0Min: minA.toString(),
    amount1Min: minB.toString(),
  }
  return {
    plan,
    // 入口函数只能用 Coin 对象付款：余额按 Coin 对象里的算
    spend: [
      [pool.coinA, amountA, adapter.entry],
      [pool.coinB, amountB, adapter.entry],
    ],
    async build(ctx, fromGas) {
      const ptb = new PtbBuilder()
      const env = createEnv(ptb, owner, t.packages)
      const pa = await payCoin(ptb, ctx, owner, pool.coinA, amountA, fromGas, adapter.entry)
      const pb = await payCoin(ptb, ctx, owner, pool.coinB, amountB, fromGas, adapter.entry)
      adapter.add(env, pool, { coinA: pa.coin, coinB: pb.coin, amountA, amountB, minA, minB })
      env.finish()
      return { kind: ptb.build(), gasSpend: pa.gasSpend + pb.gasSpend }
    },
  }
}

async function prepareAmmRemove(client: SuiClient, owner: string, t: AmmTarget, params: RemoveLiquidityParams): Promise<Prepared<RemoveLiquidityPlan>> {
  const { pool, adapter, holding } = t
  const { signal } = params
  if (!pool.withdrawEnabled) throw new Error('Withdrawals are disabled in this pool')
  if (params.burn) throw new Error(`${adapter.name} positions are LP tokens: remove them (percent: 100) instead of burn`)
  if (adapter.positionPrefix && !holding) throw new Error(`Pass the ${adapter.name} LP object (position) to remove`)
  // 持有的 LP：Kriya 是这个对象里的；LP 是普通 Coin 时是发送者的 Coin（入口函数只能用 Coin 对象，不含地址余额）
  const held = holding ? holding.balance : (await getBalance(client.transport, owner, pool.lpCoinType, { signal })).balance.coinBalance
  const amount = lpToRemove(held, params)
  const [token0, token1] = await tokens(client, pool, signal)
  const outA = (amount * pool.reserveA) / pool.lpSupply
  const outB = (amount * pool.reserveB) / pool.lpSupply
  // 合约不接受取回 0（数量太少时向下取整成 0）
  if (outA === 0n || outB === 0n) throw new Error(`The amount is too small: removing ${amount} LP tokens would return 0 of one token`)
  const slip = slippageOf(params.slippage ?? 0.005)
  const minA = withSlippageDown(outA, slip)
  const minB = withSlippageDown(outB, slip)
  const plan: RemoveLiquidityPlan = {
    ...ammBase(t, token0, token1),
    action: 'remove',
    position: holding?.position ?? null,
    liquidity: amount.toString(),
    amount0: outA.toString(),
    amount1: outB.toString(),
    amount0Formatted: fmt(outA, token0),
    amount1Formatted: fmt(outB, token1),
    amount0Min: minA.toString(),
    amount1Min: minB.toString(),
    burn: false,
  }
  return {
    plan,
    spend: [],
    async build(ctx, fromGas) {
      const ptb = new PtbBuilder()
      const env = createEnv(ptb, owner, t.packages)
      let lp: Argument
      if (holding?.position) lp = ptb.owned(await positionRef(client, holding.position, ctx.readOptions))
      else lp = (await payCoin(ptb, ctx, owner, pool.lpCoinType, amount, false, adapter.entry)).coin
      // 取回的币合并进发送者已有的同类 Coin（合约自己转给发送者的不经过这里）
      for (const coinType of [pool.coinA, pool.coinB]) {
        const sink = await sinkFor(ptb, ctx, owner, coinType, fromGas)
        if (sink) env.sink(coinType, sink)
      }
      adapter.remove(env, pool, { lp, lpAmount: amount, minA, minB })
      env.finish()
      return { kind: ptb.build(), gasSpend: 0n }
    },
  }
}

// ---------------------------------------------------------------------------
// Cetus DLMM
// ---------------------------------------------------------------------------

interface DlmmTarget {
  pool: DlmmPool
  /** 已有仓位（新建时为 null） */
  pos: DlmmPosition | null
  packages: Map<string, string>
}

/** 参数指向 Cetus DLMM 的池子 / 仓位时读出来；其他协议返回 null */
async function loadDlmmTarget(client: SuiClient, owner: string, params: { position?: SuiLpPosition | string; pool?: string; protocol?: SuiLpProtocol; signal?: AbortSignal }, peek: Peek): Promise<DlmmTarget | null> {
  const { position } = params
  if (position !== undefined && typeof position !== 'string' && position.type !== 'dlmm') return null
  if (params.protocol !== undefined && params.protocol !== 'cetus-dlmm') return null
  const id = typeof position === 'string' ? position : position ? position.position : params.pool
  if (!id) return null
  const o = await peek(id)
  let pos: DlmmPosition | null = null
  let poolObject = o
  if (o?.type === CETUS_DLMM_POSITION_TYPE) {
    pos = parseDlmmPosition(o)
    if (!pos) throw new Error(`Not a supported LP position: ${id}`)
    if (o.owner?.kind !== 'address' || normalizeSuiAddress(o.owner.address ?? '') !== owner) throw new Error(`Position ${id} is not owned by ${owner} (staked in a farm / vault, or someone else's)`)
    poolObject = await peek(pos.pool)
  } else if (!o?.type?.startsWith(`${CETUS_DLMM.pkg}::pool::Pool<`)) {
    if (params.protocol === 'cetus-dlmm' || (position && typeof position !== 'string')) throw new Error(`Not a Cetus DLMM pool or position: ${id}`)
    return null
  }
  const pool = poolObject ? parseDlmmPool(poolObject) : null
  if (!pool) throw new Error(`Cannot read the pool of ${id}`)
  return { pool, pos, packages: await resolvePackages(client.transport, [{ packages: [CETUS_DLMM.pkg, CETUS_DLMM.router] }]) }
}

/** 价格 → bin（价格所在的 bin，向下取整） */
function binOf(price: number, t0: SuiLpToken, t1: SuiLpToken, binStep: number): number {
  if (!(price > 0) || !Number.isFinite(price)) throw new Error(`Invalid price: ${price}`)
  if (t0.decimals === null || t1.decimals === null) throw new Error('Unknown token decimals: pass tickLower / tickUpper (bin ids) instead of prices')
  // 先舍到 1e-9：正好在 bin 上的价格（如把 priceLower 原样传回来）不会因为浮点误差差一格
  return Math.floor(Math.round((Math.log(price / 10 ** (t0.decimals - t1.decimals)) / Math.log(1 + binStep / 10_000)) * 1e9) / 1e9)
}

/**
 * 滑点 → 允许当前 bin 偏离多少个 bin（价格变化不超过 slippage）；至少 1 个：bin step 比滑点大时（如 1% 的 bin、0.5% 的滑点）
 * 不允许偏离任何一个 bin 的话，价格一动交易就失败
 */
const binShiftOf = (slippage: number, binStep: number) => {
  slippageOf(slippage)
  return Math.max(1, Math.floor(Math.log(1 + slippage) / Math.log(1 + binStep / 10_000) + 1e-9))
}

function dlmmBase(t: DlmmTarget, token0: SuiLpToken, token1: SuiLpToken, bins: [number, number], binShift: number) {
  const { pool } = t
  return {
    type: 'dlmm' as const,
    protocol: 'cetus-dlmm' as const,
    pool: pool.id,
    token0,
    token1,
    tickLower: bins[0],
    tickUpper: bins[1],
    tick: pool.activeBin,
    price: token0.decimals === null || token1.decimals === null ? null : binPrice(pool.activeBin, pool.binStep) * 10 ** (token0.decimals - token1.decimals),
    lpCoinType: null,
    binStep: pool.binStep,
    binShift,
    coins: null,
    rewardCoins: pool.rewardCoins,
    kind: EMPTY_KIND,
    gasSpend: 0n,
  }
}

async function prepareDlmmAdd(client: SuiClient, owner: string, t: DlmmTarget, params: AddLiquidityParams): Promise<Prepared<AddLiquidityPlan>> {
  const { pool, pos } = t
  if (!pool.canAdd) throw new Error('Adding liquidity is disabled in this pool')
  const [token0, token1] = await tokens(client, pool, params.signal)
  let bins: [number, number]
  if (pos) bins = [pos.binLower, pos.binUpper]
  else if (params.fullRange) throw new Error(`Cetus DLMM positions span at most ${MAX_BIN_WIDTH} bins: pass a price range`)
  else if (params.tickLower !== undefined && params.tickUpper !== undefined) bins = [params.tickLower, params.tickUpper]
  else if (params.priceLower !== undefined && params.priceUpper !== undefined) bins = [binOf(params.priceLower, token0, token1, pool.binStep), binOf(params.priceUpper, token0, token1, pool.binStep)]
  else throw new Error('Pass a price range (priceLower / priceUpper) or bins (tickLower / tickUpper)')
  const [lower, upper] = bins
  if (!Number.isInteger(lower) || !Number.isInteger(upper) || lower > upper) throw new Error(`Invalid bin range: ${lower} ~ ${upper}`)
  if (upper - lower + 1 > MAX_BIN_WIDTH) throw new Error(`The range spans ${upper - lower + 1} bins; Cetus DLMM allows at most ${MAX_BIN_WIDTH}`)
  let a = amountOf(params.amount0, params.amount0Formatted, token0, 'amount0') ?? 0n
  let b = amountOf(params.amount1, params.amount1Formatted, token1, 'amount1') ?? 0n
  // 当前 bin 以上的只放 token0、以下的只放 token1
  if (lower > pool.activeBin) {
    if (b > 0n && a === 0n) throw new Error('The range is above the current price: only token0 can be added')
    b = 0n
  }
  if (upper < pool.activeBin) {
    if (a > 0n && b === 0n) throw new Error('The range is below the current price: only token1 can be added')
    a = 0n
  }
  if (a === 0n && b === 0n) throw new Error('Pass amount0 and / or amount1')
  const binShift = binShiftOf(params.slippage ?? 0.005, pool.binStep)
  const plan: AddLiquidityPlan = {
    ...dlmmBase(t, token0, token1, bins, binShift),
    action: 'add',
    position: pos?.id ?? null,
    // DLMM 每个 bin 各有份额，没有单一的流动性数值
    liquidity: '0',
    amount0: a.toString(),
    amount1: b.toString(),
    amount0Formatted: fmt(a, token0),
    amount1Formatted: fmt(b, token1),
    fixed: null,
    amount0Max: a.toString(),
    amount1Max: b.toString(),
    // 合约没有数量下限：价格保护是 binShift
    amount0Min: '0',
    amount1Min: '0',
  }
  const activeBin = pool.activeBin
  return {
    plan,
    spend: [
      [pool.coinA, a],
      [pool.coinB, b],
    ],
    async build(ctx, fromGas) {
      const ptb = new PtbBuilder()
      const env = createEnv(ptb, owner, t.packages)
      const pa = await payCoin(ptb, ctx, owner, pool.coinA, a, fromGas)
      const pb = await payCoin(ptb, ctx, owner, pool.coinB, b, fromGas)
      if (pa.source) env.sink(pool.coinA, pa.source)
      if (pb.source) env.sink(pool.coinB, pb.source)
      const args = { coinA: pa.coin, coinB: pb.coin, amountA: a, amountB: b, binLower: lower, binUpper: upper, activeBin, binShift }
      if (pos) addDlmm(env, pool, ptb.owned(await positionRef(client, pos.id, ctx.readOptions)), args)
      else openDlmm(env, pool, args)
      // 币是 &mut 传进去的：用剩的合并回去
      env.keepCoin(pa.coin, pool.coinA)
      env.keepCoin(pb.coin, pool.coinB)
      env.finish()
      return { kind: ptb.build(), gasSpend: pa.gasSpend + pb.gasSpend }
    },
  }
}

async function prepareDlmmRemove(client: SuiClient, owner: string, t: DlmmTarget, params: RemoveLiquidityParams | CollectFeesParams, collect: boolean): Promise<Prepared<RemoveLiquidityPlan>> {
  const { pool } = t
  const pos = t.pos
  if (!pos) throw new Error('Pass the Cetus DLMM position')
  const p = params as RemoveLiquidityParams
  const burn = !collect && !!p.burn
  if (!collect && !pool.canRemove) throw new Error('Removing liquidity is disabled in this pool')
  if (!collect && p.liquidity !== undefined) throw new Error('Cetus DLMM positions are removed by percent (or burn), not by liquidity')
  let bps = 0
  if (!collect && !burn) {
    const percent = p.percent ?? 100
    if (!(percent > 0 && percent <= 100)) throw new Error(`Invalid percent: ${percent}`)
    bps = Math.max(1, Math.round(percent * 100))
  }
  const [token0, token1] = await tokens(client, pool, params.signal)
  // 只读调用读出现在的数量和奖励：部分移除 / 领取只领取有数量的奖励，关闭时全部领取
  const read = await inspect(client, owner, t.packages, (env) => readDlmm(env, pos, pool), params.signal)
  if (!read.value) throw new Error(`Cannot read the position: ${read.error ?? 'unknown error'}`)
  const now = read.value
  if (!collect && !burn && now.amounts[0] === 0n && now.amounts[1] === 0n) throw new Error('Nothing to remove: the position has no liquidity')
  // 池子关闭了领取时：部分移除不领取；关闭仓位要先领完，不行
  if (burn && (!pool.canCollectFee || !pool.canCollectReward)) throw new Error('Collecting fees / rewards is disabled in this pool: the position cannot be closed now (remove by percent instead)')
  if (collect && !pool.canCollectFee && !pool.canCollectReward) throw new Error('Collecting fees and rewards is disabled in this pool')
  const all = pool.rewardCoins.map((_, k) => k)
  const claim = !pool.canCollectReward ? [] : burn ? all : all.filter((k) => (now.rewards[k] ?? 0n) > 0n)
  const collectFee = pool.canCollectFee
  const share = burn ? 10_000n : BigInt(bps)
  const outA = collect ? 0n : (now.amounts[0] * share) / 10_000n
  const outB = collect ? 0n : (now.amounts[1] * share) / 10_000n
  // 合约的移除没有数量下限：取回后在交易里检查（另有 binShift 防价格变动）
  const slip = slippageOf(params.slippage ?? 0.005)
  const minA = withSlippageDown(outA, slip)
  const minB = withSlippageDown(outB, slip)
  const binShift = binShiftOf(params.slippage ?? 0.005, pool.binStep)
  const plan: RemoveLiquidityPlan = {
    ...dlmmBase(t, token0, token1, [pos.binLower, pos.binUpper], binShift),
    action: collect ? 'collect' : 'remove',
    position: pos.id,
    // DLMM：移除的比例（万分之一）
    liquidity: collect ? '0' : share.toString(),
    amount0: outA.toString(),
    amount1: outB.toString(),
    amount0Formatted: fmt(outA, token0),
    amount1Formatted: fmt(outB, token1),
    amount0Min: minA.toString(),
    amount1Min: minB.toString(),
    burn,
  }
  const activeBin = pool.activeBin
  return {
    plan,
    spend: [],
    async build(ctx, fromGas) {
      const ptb = new PtbBuilder()
      const env = createEnv(ptb, owner, t.packages)
      const position = ptb.owned(await positionRef(client, pos.id, ctx.readOptions))
      for (const coinType of new Set([pool.coinA, pool.coinB, ...claim.map((k) => pool.rewardCoins[k] as string)])) {
        const sink = await sinkFor(ptb, ctx, owner, coinType, fromGas)
        if (sink) env.sink(coinType, sink)
      }
      // 先领取手续费和奖励，再移除 / 关闭；移除时检查价格没有偏离太多
      collectDlmm(env, pool, position, pos.id, collectFee, claim)
      if (!collect) {
        guardDlmm(env, pool, activeBin, binShift)
        if (burn) closeDlmm(env, pool, position, minA, minB)
        else removeDlmm(env, pool, position, pos.binLower, pos.binUpper, bps, minA, minB)
      }
      env.finish()
      return { kind: ptb.build(), gasSpend: 0n }
    },
  }
}

// ---------------------------------------------------------------------------
// 多币池（Aftermath）
// ---------------------------------------------------------------------------

interface MultiTarget {
  pool: AftermathPool
  fees: AftermathFees
  packages: Map<string, string>
}

/** 参数指向 Aftermath 的池子（Pool 或 DaoFeePool 的 ID）/ 仓位时读出来；其他协议返回 null */
async function loadMultiTarget(client: SuiClient, params: { position?: SuiLpPosition | string; pool?: string; protocol?: SuiLpProtocol; signal?: AbortSignal }, peek: Peek): Promise<MultiTarget | null> {
  const { signal, position } = params
  if (position !== undefined && typeof position !== 'string' && position.type !== 'multi') return null
  if (params.protocol !== undefined && params.protocol !== 'aftermath') return null
  const id = typeof position === 'string' ? position : position ? position.pool : params.pool
  if (!id) return null
  const o = await peek(id)
  if (!isAftermathObject(o?.type ?? null)) {
    if (params.protocol === 'aftermath' || (position && typeof position !== 'string')) throw new Error(`Not an Aftermath pool: ${id}`)
    return null
  }
  const [pool, [vault], packages] = await Promise.all([
    loadAftermathPool(client, id, signal, o),
    client.objects([AFTERMATH.feeVault.objectId], { fields: ['json'], signal }),
    resolvePackages(client.transport, [{ packages: [AFTERMATH.amm, AFTERMATH.dao] }]),
  ])
  if (!pool) throw new Error(`Cannot read the Aftermath pool ${id}`)
  if (pool.coins.length > MAX_POOL_COINS) throw new Error(`Pools with more than ${MAX_POOL_COINS} coins are not supported`)
  return { pool, fees: parseAftermathFees(vault ?? null), packages }
}

/**
 * 在只读调用里执行一遍交易，读出几个 Coin 的数量（报价用：合约算出的数量，含手续费、推荐人优惠）。
 * 用发送者现在的 Coin，所以发送者要有这些币
 */
async function simulateCoins(
  client: SuiClient,
  owner: string,
  packages: Map<string, string>,
  signal: AbortSignal | undefined,
  build: (ptb: PtbBuilder, env: ReturnType<typeof createEnv>, ctx: BuildContext) => Promise<Array<{ coin: Argument; coinType: string }>>,
): Promise<bigint[]> {
  const ptb = new PtbBuilder()
  const env = createEnv(ptb, owner, packages)
  const coins = await build(ptb, env, buildContext(client, null, () => ({ signal })))
  const indexes = coins.map((c) => (ptb.moveCall('0x2::coin::value', [c.coinType], [c.coin]) as { index: number }).index)
  for (const c of coins) env.keepCoin(c.coin, c.coinType)
  env.finish()
  const bytes = encodeTransactionData({ kind: ptb.build(), sender: owner, gas: { payment: [], owner, price: 1000n, budget: 50_000_000_000n }, expiration: { kind: 'none' } })
  const { result, outputs } = await inspectTransaction(client.transport, bytes, { signal })
  if (!result.success) throw new Error(`Cannot quote (simulation failed): ${result.error}`)
  return indexes.map((k) => BigInt(String(outputs[k]?.[0] ?? '0')))
}

function multiBase(t: MultiTarget, tokens: SuiLpToken[], coins: LiquidityPlanCoin[]) {
  return {
    type: 'multi' as const,
    protocol: 'aftermath' as const,
    pool: t.pool.id,
    token0: tokens[0] as SuiLpToken,
    token1: tokens[1] as SuiLpToken,
    tickLower: null,
    tickUpper: null,
    tick: null,
    price: null,
    lpCoinType: t.pool.lpCoinType,
    binStep: null,
    binShift: null,
    coins,
    rewardCoins: [],
    kind: EMPTY_KIND,
    gasSpend: 0n,
  }
}

const planCoin = (t: SuiLpToken, amount: bigint, max: bigint, min: bigint): LiquidityPlanCoin => ({
  ...t,
  amount: amount.toString(),
  amountFormatted: fmt(amount, t),
  amountMax: max.toString(),
  amountMin: min.toString(),
})

async function multiTokens(client: SuiClient, pool: AftermathPool, signal?: AbortSignal): Promise<SuiLpToken[]> {
  const details = await client.coins(pool.coins, { signal })
  return pool.coins.map((coinType, i) => ({ coinType, symbol: details[i]?.symbol ?? null, decimals: details[i]?.decimals ?? null }))
}

/** 哪种币（池子里的下标） */
function coinIndex(pool: AftermathPool, coinType: string, what: string): number {
  const k = pool.coins.indexOf(normalizeStructTag(coinType))
  if (k < 0) throw new Error(`${what} ${coinType} is not in the pool (${pool.coins.join(', ')})`)
  return k
}

async function prepareMultiAdd(client: SuiClient, owner: string, t: MultiTarget, params: AddLiquidityParams): Promise<Prepared<AddLiquidityPlan>> {
  const { pool, fees } = t
  const { signal } = params
  if (pool.lpSupply === 0n || pool.reserves.some((r) => r === 0n)) throw new Error('The pool is empty: creating pools is not supported')
  if (params.priceLower !== undefined || params.priceUpper !== undefined || params.tickLower !== undefined || params.tickUpper !== undefined) {
    throw new Error('Aftermath pools have no price range')
  }
  const tokens = await multiTokens(client, pool, signal)
  // 给的那种币：coin + amount；两种币的池子也可以用 amount0 / amount1
  let k: number
  let given: bigint | null
  if (params.coin !== undefined) {
    k = coinIndex(pool, params.coin, 'coin')
    given = amountOf(params.amount, params.amountFormatted, tokens[k] as SuiLpToken, 'amount')
  } else if (params.amount0 !== undefined || params.amount0Formatted !== undefined) {
    k = 0
    given = amountOf(params.amount0, params.amount0Formatted, tokens[0] as SuiLpToken, 'amount0')
  } else if (params.amount1 !== undefined || params.amount1Formatted !== undefined) {
    k = 1
    given = amountOf(params.amount1, params.amount1Formatted, tokens[1] as SuiLpToken, 'amount1')
  } else throw new Error('Pass coin and amount (or amountFormatted)')
  if (!given) throw new Error('The amount must be greater than 0')
  const amount = given
  const slip = slippageOf(params.slippage ?? 0.005)

  if (params.single) {
    // 只存一种币：LP 由合约的牛顿迭代算出，按模拟的结果报价，下限按滑点
    const deposit = (env: ReturnType<typeof createEnv>, coin: Argument, minLp: bigint) => depositOne(env, pool, k, coin, minLp)
    const [lp = 0n] = await simulateCoins(client, owner, t.packages, signal, async (ptb, env, ctx) => {
      const pay = await payCoin(ptb, ctx, owner, pool.coins[k] as string, amount, true)
      return [{ coin: deposit(env, pay.coin, 0n), coinType: pool.lpCoinType }]
    })
    if (lp === 0n) throw new Error('The amount is too small: it would mint no LP tokens')
    const minLp = withSlippageDown(lp, slip)
    const coins = tokens.map((tk, i) => (i === k ? planCoin(tk, amount, amount, amount) : planCoin(tk, 0n, 0n, 0n)))
    return {
      plan: multiAddPlan(t, tokens, coins, lp),
      spend: [[pool.coins[k] as string, amount]],
      async build(ctx, fromGas) {
        const ptb = new PtbBuilder()
        const env = createEnv(ptb, owner, t.packages)
        const pay = await payCoin(ptb, ctx, owner, pool.coins[k] as string, amount, fromGas)
        const sink = await sinkFor(ptb, ctx, owner, pool.lpCoinType, fromGas)
        if (sink) env.sink(pool.lpCoinType, sink)
        env.keepCoin(deposit(env, pay.coin, minLp), pool.lpCoinType)
        env.finish()
        return { kind: ptb.build(), gasSpend: pay.gasSpend }
      },
    }
  }

  // 按比例存入全部币：其他币 = 给的数量 × 储备比例（向上取整）；合约按最少的比例取，多余的留在币里退回
  const ref = pool.reserves[k] as bigint
  const amounts = pool.reserves.map((r, i) => (i === k ? amount : (amount * r + ref - 1n) / ref))
  if (amounts.some((a) => a === 0n)) throw new Error('The amount is too small: another coin would be 0')
  // 预计的 LP：扣掉协议手续费（和 DAO 费）后按比例（有推荐人时略多）
  const afterFees = amounts.map((a) => {
    const net = a - (pool.dao ? (a * BigInt(pool.dao.feeBps)) / 10_000n : 0n)
    return net - protocolFeeOf(net, fees)
  })
  const ratio = afterFees.reduce((m, a, i) => {
    const r = (a * (pool.scalars[i] as bigint) * 10n ** 18n) / (pool.normalized[i] as bigint)
    return m === null || r < m ? r : m
  }, null as bigint | null) as bigint
  const lp = (pool.lpSupply * ratio) / 10n ** 18n
  if (lp === 0n) throw new Error('The amount is too small: it would mint no LP tokens')
  // 合约没有 LP 下限：在交易里检查拿到的 LP 不少于预计 × (1 − slippage)
  const minLp = withSlippageDown(lp, slip)
  const coins = tokens.map((tk, i) => planCoin(tk, amounts[i] as bigint, amounts[i] as bigint, 0n))
  return {
    plan: multiAddPlan(t, tokens, coins, lp),
    spend: pool.coins.map((c, i) => [c, amounts[i] as bigint]),
    async build(ctx, fromGas) {
      const ptb = new PtbBuilder()
      const env = createEnv(ptb, owner, t.packages)
      const pays: Array<Awaited<ReturnType<typeof payCoin>>> = []
      for (let i = 0; i < pool.coins.length; i++) pays.push(await payCoin(ptb, ctx, owner, pool.coins[i] as string, amounts[i] as bigint, fromGas))
      pool.coins.forEach((c, i) => {
        const source = pays[i]?.source
        if (source) env.sink(c, source)
      })
      const sink = await sinkFor(ptb, ctx, owner, pool.lpCoinType, fromGas)
      if (sink) env.sink(pool.lpCoinType, sink)
      const lpCoin = depositAll(
        env,
        pool,
        pays.map((p) => p.coin),
      )
      guardMin(ptb, lpCoin, minLp)
      env.keepCoin(lpCoin, pool.lpCoinType)
      // 币是 &mut 传进去的：用剩的合并回去
      pays.forEach((p, i) => env.keepCoin(p.coin, pool.coins[i] as string))
      env.finish()
      return { kind: ptb.build(), gasSpend: pays.reduce((s, p) => s + p.gasSpend, 0n) }
    },
  }
}

function multiAddPlan(t: MultiTarget, tokens: SuiLpToken[], coins: LiquidityPlanCoin[], lp: bigint): AddLiquidityPlan {
  return {
    ...multiBase(t, tokens, coins),
    action: 'add',
    position: null,
    liquidity: lp.toString(),
    amount0: coins[0]?.amount ?? '0',
    amount1: coins[1]?.amount ?? '0',
    amount0Formatted: coins[0]?.amountFormatted ?? null,
    amount1Formatted: coins[1]?.amountFormatted ?? null,
    fixed: null,
    amount0Max: coins[0]?.amountMax ?? '0',
    amount1Max: coins[1]?.amountMax ?? '0',
    amount0Min: coins[0]?.amountMin ?? '0',
    amount1Min: coins[1]?.amountMin ?? '0',
  }
}

async function prepareMultiRemove(client: SuiClient, owner: string, t: MultiTarget, params: RemoveLiquidityParams): Promise<Prepared<RemoveLiquidityPlan>> {
  const { pool, fees } = t
  const { signal } = params
  if (params.burn) throw new Error('Aftermath positions are LP tokens: remove them (percent: 100) instead of burn')
  const held = (await getBalance(client.transport, owner, pool.lpCoinType, { signal })).balance.balance
  const lpAmount = lpToRemove(held, params)
  const tokens = await multiTokens(client, pool, signal)
  const slip = slippageOf(params.slippage ?? 0.005)
  let coins: LiquidityPlanCoin[]
  let build: Prepared<RemoveLiquidityPlan>['build']
  const sinks = async (ptb: PtbBuilder, env: ReturnType<typeof createEnv>, ctx: BuildContext, fromGas: boolean) => {
    for (const c of pool.coins) {
      const sink = await sinkFor(ptb, ctx, owner, c, fromGas)
      if (sink) env.sink(c, sink)
    }
  }
  if (params.outCoin !== undefined) {
    // 只取一种币：按模拟的结果报价，下限按滑点
    const k = coinIndex(pool, params.outCoin, 'outCoin')
    const [out = 0n] = await simulateCoins(client, owner, t.packages, signal, async (ptb, env, ctx) => {
      const lp = await payCoin(ptb, ctx, owner, pool.lpCoinType, lpAmount, false)
      return [{ coin: withdrawOne(env, pool, k, lp.coin, 0n), coinType: pool.coins[k] as string }]
    })
    if (out === 0n) throw new Error('The amount is too small: it would return nothing')
    const minOut = withSlippageDown(out, slip)
    coins = tokens.map((tk, i) => (i === k ? planCoin(tk, out, out, minOut) : planCoin(tk, 0n, 0n, 0n)))
    build = async (ctx, fromGas) => {
      const ptb = new PtbBuilder()
      const env = createEnv(ptb, owner, t.packages)
      await sinks(ptb, env, ctx, fromGas)
      const lp = await payCoin(ptb, ctx, owner, pool.lpCoinType, lpAmount, false)
      env.keepCoin(withdrawOne(env, pool, k, lp.coin, minOut), pool.coins[k] as string)
      env.finish()
      return { kind: ptb.build(), gasSpend: 0n }
    }
  } else {
    // 按比例取回全部币：预计数量按合约的算法（扣协议手续费和 DAO 费）；合约没有数量下限，在交易里检查
    const outs = withdrawAllAmounts(pool, lpAmount, fees)
    if (outs.every((o) => o === 0n)) throw new Error('The amount is too small: it would return nothing')
    const mins = outs.map((o) => withSlippageDown(o, slip))
    coins = tokens.map((tk, i) => planCoin(tk, outs[i] ?? 0n, outs[i] ?? 0n, mins[i] ?? 0n))
    build = async (ctx, fromGas) => {
      const ptb = new PtbBuilder()
      const env = createEnv(ptb, owner, t.packages)
      await sinks(ptb, env, ctx, fromGas)
      const lp = await payCoin(ptb, ctx, owner, pool.lpCoinType, lpAmount, false)
      withdrawAll(env, pool, lp.coin).forEach((c, i) => {
        guardMin(ptb, c, mins[i] ?? 0n)
        env.keepCoin(c, pool.coins[i] as string)
      })
      env.finish()
      return { kind: ptb.build(), gasSpend: 0n }
    }
  }
  const plan: RemoveLiquidityPlan = {
    ...multiBase(t, tokens, coins),
    action: 'remove',
    position: null,
    liquidity: lpAmount.toString(),
    amount0: coins[0]?.amount ?? '0',
    amount1: coins[1]?.amount ?? '0',
    amount0Formatted: coins[0]?.amountFormatted ?? null,
    amount1Formatted: coins[1]?.amountFormatted ?? null,
    amount0Min: coins[0]?.amountMin ?? '0',
    amount1Min: coins[1]?.amountMin ?? '0',
    burn: false,
  }
  return { plan, spend: [], build }
}

// ---------------------------------------------------------------------------
// 对外的函数
// ---------------------------------------------------------------------------

type Built = { kind: ProgrammableTransaction; gasSpend: bigint }

const EMPTY_KIND: ProgrammableTransaction = { inputs: [], commands: [] }

/**
 * 报价和构建方法：plan 里的 kind 还是空的，build(ctx, fromGas) 按发送者当前的 Coin 构建；
 * spend 是要付的代币（检查余额用；第三项为 true 时只能用 Coin 对象，不算地址余额）
 */
interface Prepared<P> {
  plan: P
  build(ctx: BuildContext, fromGas: boolean): Promise<Built>
  spend: Array<[string, bigint, boolean?]>
}

async function prepareAdd(client: SuiClient, owner: string, params: AddLiquidityParams): Promise<Prepared<AddLiquidityPlan>> {
  const peek = peeker(client, params.signal)
  const amm = await loadAmm(client, owner, params, peek)
  if (amm) return prepareAmmAdd(client, owner, amm, params)
  const dlmm = await loadDlmmTarget(client, owner, params, peek)
  if (dlmm) return prepareDlmmAdd(client, owner, dlmm, params)
  const multi = await loadMultiTarget(client, params, peek)
  if (multi) return prepareMultiAdd(client, owner, multi, params)
  const q = await quoteAdd(client, owner, params, peek)
  return {
    plan: addPlan(q, { kind: EMPTY_KIND, gasSpend: 0n }),
    build: (ctx, fromGas) => addKind(client, ctx, owner, q, fromGas),
    spend: [
      [q.pool.coinA, q.amount0Max],
      [q.pool.coinB, q.amount1Max],
    ],
  }
}

async function prepareRemove(client: SuiClient, owner: string, params: RemoveLiquidityParams | CollectFeesParams, collect: boolean): Promise<Prepared<RemoveLiquidityPlan>> {
  const peek = peeker(client, params.signal)
  const amm = await loadAmm(client, owner, params, peek)
  if (amm) {
    if (collect) throw new Error(`${amm.adapter.name} fees are part of the LP share: there is nothing to collect separately`)
    return prepareAmmRemove(client, owner, amm, params)
  }
  const dlmm = await loadDlmmTarget(client, owner, params, peek)
  if (dlmm) return prepareDlmmRemove(client, owner, dlmm, params, collect)
  const multi = await loadMultiTarget(client, params, peek)
  if (multi) {
    if (collect) throw new Error('Aftermath fees are part of the LP share: there is nothing to collect separately')
    return prepareMultiRemove(client, owner, multi, params)
  }
  if (params.position === undefined) throw new Error('Pass position')
  const q = await quoteRemove(client, owner, { ...params, position: params.position }, collect, peek)
  return {
    plan: removePlan(q, collect, { kind: EMPTY_KIND, gasSpend: 0n }),
    build: (ctx, fromGas) => removeKind(client, ctx, owner, q, collect, fromGas),
    spend: [],
  }
}

/** 报价并构建交易（不签名）：发送者自己付 gas；kind 可以交给 batchCall 或自己签名 */
export async function buildAddLiquidity(client: SuiClient, owner: string, params: AddLiquidityParams): Promise<AddLiquidityPlan> {
  const sender = normalizeSuiAddress(owner)
  const p = await prepareAdd(client, sender, params)
  return { ...p.plan, ...(await p.build(buildContext(client, null, () => ({ signal: params.signal })), true)) }
}

export async function buildRemoveLiquidity(client: SuiClient, owner: string, params: RemoveLiquidityParams): Promise<RemoveLiquidityPlan> {
  const sender = normalizeSuiAddress(owner)
  const p = await prepareRemove(client, sender, params, false)
  return { ...p.plan, ...(await p.build(buildContext(client, null, () => ({ signal: params.signal })), true)) }
}

export async function buildCollectFees(client: SuiClient, owner: string, params: CollectFeesParams): Promise<RemoveLiquidityPlan> {
  const sender = normalizeSuiAddress(owner)
  const p = await prepareRemove(client, sender, params, true)
  return { ...p.plan, ...(await p.build(buildContext(client, null, () => ({ signal: params.signal })), true)) }
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
 * 添加流动性：新建仓位（pool + 价格区间）或往已有仓位追加（position），给一边的数量；传统 AMM 给池子（或它的仓位）和一边的数量。
 *
 * ```ts
 * await addLiquidity(sui, key, { pool, priceLower: 0.9, priceUpper: 1.1, amount0Formatted: '100' })
 * const [position] = await lpPositions(sui, owner)
 * await addLiquidity(sui, key, { position, amount1Formatted: '5' })
 * ```
 */
export async function addLiquidity(client: SuiClient, from: SignerInput, params: AddLiquidityParams, options: LiquiditySendOptions = {}): Promise<LiquidityResult<AddLiquidityPlan>> {
  const sender = await resolveSigner(from)
  const p = await prepareAdd(client, sender.address, params)
  if (options.checkBalance ?? true) {
    const signal = options.signal ?? params.signal
    const sponsored = options.sponsor !== undefined && (await resolveSigner(options.sponsor)).address !== sender.address
    await Promise.all(
      p.spend.map(async ([coinType, amount, coinsOnly]) => {
        // 自己付 gas 时 SUI 还要留出 gas（按 0.05 SUI 估）
        const need = amount + (coinType === SUI_COIN_TYPE && !sponsored ? 50_000_000n : 0n)
        if (amount === 0n) return
        const { balance } = await getBalance(client.transport, sender.address, coinType, { signal })
        const have = coinsOnly ? balance.coinBalance : balance.balance
        if (have < need) {
          throw new Error(`Insufficient balance of ${coinType}${coinsOnly ? ' in coin objects (the address balance cannot be used here)' : ''}: need ${need}${coinType === SUI_COIN_TYPE && !sponsored ? ' (including about 0.05 SUI for gas)' : ''}, have ${have}`)
        }
      }),
    )
  }
  return send(client, sender, p.plan, (ctx, sponsored) => p.build(ctx, !sponsored), { ...options, signal: options.signal ?? params.signal })
}

/** 移除流动性（集中流动性按比例或数量，同时领取手续费和奖励；burn: true 全部移除并关闭仓位）；传统 AMM 按比例或 LP 数量 */
export async function removeLiquidity(client: SuiClient, from: SignerInput, params: RemoveLiquidityParams, options: LiquiditySendOptions = {}): Promise<LiquidityResult<RemoveLiquidityPlan>> {
  const sender = await resolveSigner(from)
  const p = await prepareRemove(client, sender.address, params, false)
  return send(client, sender, p.plan, (ctx, sponsored) => p.build(ctx, !sponsored), { ...options, signal: options.signal ?? params.signal })
}

/** 只领取手续费和挖矿奖励（集中流动性） */
export async function collectFees(client: SuiClient, from: SignerInput, params: CollectFeesParams, options: LiquiditySendOptions = {}): Promise<LiquidityResult<RemoveLiquidityPlan>> {
  const sender = await resolveSigner(from)
  const p = await prepareRemove(client, sender.address, params, true)
  return send(client, sender, p.plan, (ctx, sponsored) => p.build(ctx, !sponsored), { ...options, signal: options.signal ?? params.signal })
}
