/**
 * 兑换（子路径 `@w3lib/sui-batch-call/swap`）：在支持的 DEX（与 /lp 相同）里找路线（直接兑换，或经过 SUI / USDC 的两跳），
 * 每条候选路线在只读调用里执行一遍兑换的交易、读出买到的数量（各 DEX 合约自己算，含手续费，与实际执行逐位一致），选输出最多的；
 * 按滑点算最少收到的数量，交易最后检查（不够时整笔失败）
 */
import { SUI_COIN_TYPE, normalizeStructTag, normalizeSuiAddress } from './address.js'
import type { SuiClient } from './client.js'
import { SUI_DECIMALS } from './constants.js'
import { createEnv, resolvePackages } from './dex/env.js'
import { guardMin, payCoin, sinkFor } from './dex/pay.js'
import type { SuiLpProtocol } from './dex/types.js'
import { formatUnits, parseUnits } from './format.js'
import { isNodeFault } from './grpc.js'
import type { SuiLpToken } from './lp.js'
import { POOL_LOOKUPS, findPools, type PoolLookupProtocol } from './pools.js'
import { getBalance, inspectTransaction } from './services.js'
import { loadSwapPools } from './swapPools.js'
import { slippageOf, withSlippageDown } from './slippage.js'
import { SWAP_PACKAGES, swapCommand, type SwapPool } from './swapTx.js'
import { encodeTransactionData, pure, type Argument, type ProgrammableTransaction } from './write/bcs.js'
import { PtbBuilder } from './write/ptb.js'
import { buildContext, emptyOutcome, sendJobs, toWriteResult, type BuildContext, type SendOptions, type WriteResult } from './write/send.js'
import { resolveSigner, type SignerInput } from './write/signer.js'

/** 原生 USDC（Circle） */
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
/** 两跳的默认中间币 */
export const SWAP_INTERMEDIATES: readonly string[] = [SUI_COIN_TYPE, USDC]

export interface SwapParams {
  /** 卖出 / 买入的代币类型（SUI 用 SUI_COIN_TYPE 或 '0x2::sui::SUI'） */
  tokenIn: string
  tokenOut: string
  /** 卖出的数量：amountIn（最小单位）和 amountInFormatted（按精度换算，如 '1.5'）二选一 */
  amountIn?: bigint | string | number
  amountInFormatted?: string
}

export interface SwapOptions {
  /** 价格滑点（比例，0.005 = 0.5%），最少收到 = 报价 × (1 − slippage)，默认 0.005 */
  slippage?: number
  /** 按币对自动找池子的 DEX，默认全部能找的：Cetus、Magma、Turbos、FlowX CLMM、DipCoin、FlowX V2；传 [] 只用 pools */
  protocols?: readonly PoolLookupProtocol[]
  /** 另外参与比较的池子 ID（任意支持的 DEX：Bluefin、Momentum、Kriya、Cetus DLMM、Aftermath 等只能这样给） */
  pools?: readonly string[]
  /** 两跳的中间币，默认 SWAP_INTERMEDIATES（SUI、USDC）；传 [] 只找直接兑换 */
  intermediates?: readonly string[]
  /** 同时执行几个报价的只读调用，默认 SuiClient 的 concurrency */
  concurrency?: number
  signal?: AbortSignal
}

export interface SwapHop {
  protocol: SuiLpProtocol
  pool: string
  tokenIn: string
  tokenOut: string
  /** 手续费率，百万分之一 */
  fee: number | null
}

export interface SwapRoute {
  /** 经过的代币 */
  path: string[]
  hops: SwapHop[]
  /** 这条路线的报价（最小单位） */
  amountOut: string
}

export interface SwapPlan {
  tokenIn: SuiLpToken
  tokenOut: SuiLpToken
  amountIn: string
  amountInFormatted: string | null
  /** 报价（最小单位）和最少收到的数量（按滑点） */
  amountOut: string
  amountOutFormatted: string | null
  amountOutMin: string
  amountOutMinFormatted: string | null
  /** 1 个 tokenIn 换多少 tokenOut（按这笔的数量） */
  price: number | null
  /** 价格影响（0~1）：这笔的价格比极小数量（1 / 10000）的价格差多少；算不出时为 null */
  priceImpact: number | null
  route: SwapRoute
  /** 报价成功的候选路线，从高到低（含选中的） */
  routes: SwapRoute[]
  /** 交易内容（按发送者当前的 Coin 构建），可以自己签名发送；gasSpend 是从 gas 币里拆走的 SUI */
  kind: ProgrammableTransaction
  gasSpend: bigint
}

interface Hop {
  pool: SwapPool
  tokenIn: string
  tokenOut: string
}

/** 最多同时运行 limit 个任务（直接兑换和各个中间币的报价共用） */
function limiter(limit: number): <R>(task: () => Promise<R>) => Promise<R> {
  let active = 0
  const queue: Array<() => void> = []
  return async (task) => {
    // 满了就排队：前面的任务结束时把名额直接交给排队的（active 不变），不会短暂超出 limit
    if (active >= limit) await new Promise<void>((r) => queue.push(r))
    else active++
    try {
      return await task()
    } finally {
      const next = queue.shift()
      if (next) next()
      else active--
    }
  }
}

/** Coin 列表按 (owner, 类型) 缓存：报价的多次只读调用共用 */
function cachedContext(ctx: BuildContext): BuildContext {
  const cache = new Map<string, Promise<unknown>>()
  // 失败的不缓存（节点偶尔出错时下一次重新读）
  const once = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    let p = cache.get(key) as Promise<T> | undefined
    if (!p) {
      const created = read()
      p = created
      cache.set(key, created)
      created.catch(() => {
        if (cache.get(key) === created) cache.delete(key)
      })
    }
    return p
  }
  return {
    coins: (owner, coinType) => once(`coins:${owner}:${coinType}`, () => ctx.coins(owner, coinType)),
    addressBalance: (owner, coinType) => once(`balance:${owner}:${coinType}`, () => ctx.addressBalance(owner, coinType)),
    readOptions: ctx.readOptions,
  }
}

/** 交易里的兑换命令：付 tokenIn，依次经过每一跳，返回买到的 Coin */
async function swapHops(ptb: PtbBuilder, env: ReturnType<typeof createEnv>, ctx: BuildContext, owner: string, hops: readonly Hop[], amountIn: bigint, fromGas: boolean, quote: boolean) {
  const tokenIn = (hops[0] as Hop).tokenIn
  let coin: Argument
  let gasSpend = 0n
  if (quote && tokenIn === SUI_COIN_TYPE) {
    // 报价（只读调用）：SUI 从模拟的 gas 币里拆（不需要真的持有）
    coin = ptb.nested(ptb.command({ kind: 'splitCoins', coin: ptb.gas, amounts: [ptb.pure(pure.u64(amountIn))] }), 0)
  } else {
    const pay = await payCoin(ptb, ctx, owner, tokenIn, amountIn, fromGas)
    coin = pay.coin
    gasSpend = pay.gasSpend
  }
  for (const h of hops) coin = swapCommand(env, h.pool, coin, h.tokenIn, h.tokenOut)
  return { coin, gasSpend }
}

/** 只读调用里执行一遍路线，返回买到的数量；失败时为 null */
async function quoteHops(client: SuiClient, owner: string, packages: Map<string, string>, ctx: BuildContext, hops: readonly Hop[], amountIn: bigint, signal?: AbortSignal): Promise<bigint | null> {
  const ptb = new PtbBuilder()
  const env = createEnv(ptb, owner, packages)
  const tokenOut = (hops[hops.length - 1] as Hop).tokenOut
  let index: number
  try {
    const { coin } = await swapHops(ptb, env, ctx, owner, hops, amountIn, true, true)
    index = env.coinValue(coin, tokenOut)
    env.keepCoin(coin, tokenOut)
    env.finish()
  } catch (err) {
    // 读 Coin / 地址余额时节点出错：抛出（不能当作没有路线）；其他（如币不够）当作这条路线不可用
    if (isNodeFault(err) || signal?.aborted) throw err
    return null
  }
  const bytes = encodeTransactionData({ kind: ptb.build(), sender: owner, gas: { payment: [], owner, price: 1000n, budget: 50_000_000_000n }, expiration: { kind: 'none' } })
  let res: Awaited<ReturnType<typeof inspectTransaction>>
  try {
    // 候选路线很多时偶尔有请求失败：节点的问题再试一次
    res = await inspectTransaction(client.transport, bytes, { signal }).catch(async (err: unknown) => {
      if (!isNodeFault(err) || signal?.aborted) throw err
      await new Promise((r) => setTimeout(r, 500))
      return inspectTransaction(client.transport, bytes, { signal })
    })
  } catch (err) {
    // 节点的问题抛出；交易本身不合法（类型对不上等）当作这条路线不可用
    if (isNodeFault(err) || signal?.aborted) throw err
    return null
  }
  const { result, outputs } = res
  if (!result.success) return null
  const v = outputs[index]?.[0]
  return v === undefined ? null : BigInt(String(v))
}

interface Candidate {
  hops: Hop[]
  amountOut: bigint
}

/** 找候选池子并报价：直接兑换；每个中间币先选第一跳输出最多的 FIRST_HOP_CANDIDATES 个池子，再和第二跳的每个池子组成两跳路线。按输出从高到低 */
async function quoteRoutes(client: SuiClient, owner: string, tokenIn: string, tokenOut: string, amountIn: bigint, options: SwapOptions): Promise<{ routes: Candidate[]; tried: number; packages: Map<string, string>; ctx: BuildContext }> {
  const { signal } = options
  const mids = [...new Set((options.intermediates ?? SWAP_INTERMEDIATES).map((t) => normalizeStructTag(t)))].filter((m) => m !== tokenIn && m !== tokenOut)
  const pairs: Array<[string, string]> = [[tokenIn, tokenOut], ...mids.flatMap((m): Array<[string, string]> => [[tokenIn, m], [m, tokenOut]])]
  const protocols = options.protocols ?? (Object.keys(POOL_LOOKUPS) as PoolLookupProtocol[])
  const found = await findPools(client, pairs, protocols, signal)
  const ids = [...new Set([...found.flat().map((p) => p.id), ...(options.pools ?? []).map((id) => normalizeSuiAddress(id))])]
  const loaded = (await loadSwapPools(client, ids, signal)).filter((p): p is SwapPool => !!p)
  // 一个池子可以用在哪些币对（Aftermath 的多币池可能同时在两跳里）
  const poolsFor = (a: string, b: string) => loaded.filter((p) => p.coins.includes(a) && p.coins.includes(b))
  const packages = await resolvePackages(client.transport, [...new Set(loaded.map((p) => p.protocol))].map((p) => ({ packages: SWAP_PACKAGES[p] })))
  const ctx = cachedContext(buildContext(client, null, () => ({ signal })))
  const limit = limiter(Math.max(1, options.concurrency ?? client.concurrency))
  let tried = 0
  const run = (routes: Hop[][], amount: bigint) =>
    Promise.all(
      routes.map((hops) =>
        limit(async (): Promise<Candidate> => {
          tried++
          return { hops, amountOut: (await quoteHops(client, owner, packages, ctx, hops, amount, signal)) ?? 0n }
        }),
      ),
    )
  const hop = (pool: SwapPool, a: string, b: string): Hop => ({ pool, tokenIn: a, tokenOut: b })

  const direct = run(
    poolsFor(tokenIn, tokenOut).map((p) => [hop(p, tokenIn, tokenOut)]),
    amountIn,
  )
  const twoHop = mids.map(async (m) => {
    const second = poolsFor(m, tokenOut)
    if (!second.length) return []
    // 第一跳输出最多的几个池子都和第二跳的每个池子配对（只选第一名的话，第一跳略差但第二跳配合得更好的路线就漏了）
    const firsts = (
      await run(
        poolsFor(tokenIn, m).map((p) => [hop(p, tokenIn, m)]),
        amountIn,
      )
    )
      .filter((c) => c.amountOut > 0n)
      .sort(byOut)
      .slice(0, FIRST_HOP_CANDIDATES)
    return run(
      firsts.flatMap((first) => second.map((p) => [...first.hops, hop(p, m, tokenOut)])),
      amountIn,
    )
  })
  const all = [...(await direct), ...(await Promise.all(twoHop)).flat()]
  return { routes: all.filter((c) => c.amountOut > 0n).sort(byOut), tried, packages, ctx }
}

/** 一条路线的结果：报价用的数据 → SwapRoute */
const routeOf = (tokenIn: string, c: Candidate): SwapRoute => ({
  path: [tokenIn, ...c.hops.map((h) => h.tokenOut)],
  hops: c.hops.map((h) => ({ protocol: h.pool.protocol, pool: h.pool.id, tokenIn: h.tokenIn, tokenOut: h.tokenOut, fee: h.pool.fee })),
  amountOut: c.amountOut.toString(),
})

export interface RoundTrip {
  /** ok：买得到也卖得出；no-pool：没有和 SUI（或经过中间币）的池子；buy-failed：有池子但买不进；sell-failed：买进后卖不出 */
  stage: 'ok' | 'no-pool' | 'buy-failed' | 'sell-failed'
  /** 买入的路线（卖出按原路返回） */
  route: SwapRoute | null
  /** 买到的代币、卖回的 SUI（最小单位） */
  bought: bigint | null
  back: bigint | null
  error: string | null
}

/**
 * /risk 用：用 amount 的 SUI（只读调用里模拟的 gas 币，sender 不需要持有）按最好的路线买入 token，再按原路全部卖回 SUI，
 * 在同一笔只读调用里执行
 */
export async function roundTrip(client: SuiClient, sender: string, token: string, amount: bigint, options: SwapOptions = {}): Promise<RoundTrip> {
  const { signal } = options
  const tokenOut = normalizeStructTag(token)
  const { routes, tried, packages, ctx } = await quoteRoutes(client, sender, SUI_COIN_TYPE, tokenOut, amount, options)
  const best = routes[0]
  if (!best) return { stage: tried ? 'buy-failed' : 'no-pool', route: null, bought: null, back: null, error: null }
  const ptb = new PtbBuilder()
  const env = createEnv(ptb, sender, packages)
  const { coin } = await swapHops(ptb, env, ctx, sender, best.hops, amount, true, true)
  const boughtIndex = env.coinValue(coin, tokenOut)
  const back = [...best.hops].reverse().reduce((c, h) => swapCommand(env, h.pool, c, h.tokenOut, h.tokenIn), coin)
  const backIndex = env.coinValue(back, SUI_COIN_TYPE)
  env.keepCoin(back, SUI_COIN_TYPE)
  env.finish()
  const bytes = encodeTransactionData({ kind: ptb.build(), sender, gas: { payment: [], owner: sender, price: 1000n, budget: 50_000_000_000n }, expiration: { kind: 'none' } })
  const route = routeOf(SUI_COIN_TYPE, best)
  let res: Awaited<ReturnType<typeof inspectTransaction>>
  try {
    res = await inspectTransaction(client.transport, bytes, { signal })
  } catch (err) {
    if (isNodeFault(err) || signal?.aborted) throw err
    return { stage: 'sell-failed', route, bought: best.amountOut, back: null, error: err instanceof Error ? err.message : String(err) }
  }
  if (!res.result.success) return { stage: 'sell-failed', route, bought: best.amountOut, back: null, error: res.result.error }
  const value = (k: number) => BigInt(String(res.outputs[k]?.[0] ?? '0'))
  return { stage: 'ok', route, bought: value(boughtIndex), back: value(backIndex), error: null }
}

/** 两跳路线里每个中间币保留几个第一跳的池子 */
const FIRST_HOP_CANDIDATES = 2
const byOut = (a: Candidate, b: Candidate) => (a.amountOut < b.amountOut ? 1 : a.amountOut > b.amountOut ? -1 : 0)

/** 构建兑换的交易：付 tokenIn、依次兑换、检查买到的不少于 amountOutMin，买到的合并进发送者已有的 Coin（SUI 合并进 gas 币） */
async function buildKind(ctx: BuildContext, owner: string, packages: Map<string, string>, hops: readonly Hop[], amountIn: bigint, amountOutMin: bigint, fromGas: boolean): Promise<{ kind: ProgrammableTransaction; gasSpend: bigint }> {
  const ptb = new PtbBuilder()
  const env = createEnv(ptb, owner, packages)
  const tokenOut = (hops[hops.length - 1] as Hop).tokenOut
  const sink = await sinkFor(ptb, ctx, owner, tokenOut, fromGas)
  if (sink) env.sink(tokenOut, sink)
  const { coin, gasSpend } = await swapHops(ptb, env, ctx, owner, hops, amountIn, fromGas, false)
  guardMin(ptb, coin, amountOutMin)
  env.keepCoin(coin, tokenOut)
  env.finish()
  return { kind: ptb.build(), gasSpend }
}

const fmt = (v: bigint, t: SuiLpToken) => (t.decimals === null ? null : formatUnits(v, t.decimals))

interface Prepared {
  plan: SwapPlan
  build(ctx: BuildContext, fromGas: boolean): Promise<{ kind: ProgrammableTransaction; gasSpend: bigint }>
}

async function prepare(client: SuiClient, owner: string, params: SwapParams, options: SwapOptions): Promise<Prepared> {
  const { signal } = options
  const tokenIn = normalizeStructTag(params.tokenIn)
  const tokenOut = normalizeStructTag(params.tokenOut)
  if (tokenIn === tokenOut) throw new Error('tokenIn and tokenOut are the same')
  const slippage = slippageOf(options.slippage ?? 0.005)
  const [infoIn, infoOut] = await client.coins([tokenIn, tokenOut], { signal })
  const token = (coinType: string, c: typeof infoIn): SuiLpToken => ({ coinType, symbol: coinType === SUI_COIN_TYPE ? 'SUI' : (c?.symbol ?? null), decimals: coinType === SUI_COIN_TYPE ? SUI_DECIMALS : (c?.decimals ?? null) })
  const tIn = token(tokenIn, infoIn)
  const tOut = token(tokenOut, infoOut)
  if ((params.amountIn === undefined) === (params.amountInFormatted === undefined)) throw new Error('Pass exactly one of amountIn / amountInFormatted')
  if (params.amountInFormatted !== undefined && tIn.decimals === null) throw new Error(`Unknown decimals of ${tokenIn}: pass amountIn in base units`)
  const amountIn = params.amountInFormatted !== undefined ? parseUnits(params.amountInFormatted, tIn.decimals as number) : BigInt(params.amountIn as bigint | string | number)
  if (amountIn <= 0n) throw new Error('amountIn must be greater than 0')
  if (tokenIn !== SUI_COIN_TYPE) {
    // 报价是从 owner 执行一遍兑换：要持有卖出的币（SUI 除外：只读调用里用模拟的 gas 币）
    const { balance } = await getBalance(client.transport, owner, tokenIn, { signal })
    if (balance.balance < amountIn) throw new Error(`Insufficient balance of ${tokenIn}: the quote simulates the swap from ${owner}, which holds ${balance.balance} (need ${amountIn})`)
  }

  const { routes, packages, ctx } = await quoteRoutes(client, owner, tokenIn, tokenOut, amountIn, options)
  const best = routes[0]
  if (!best) throw new Error('No route found: no pool for this pair (directly or through the intermediate coins) could quote this amount; pass pools for DEXes that cannot be looked up by coin pair')
  // 价格影响：同一路线卖出极小的数量（1 / 10000）的价格
  const small = amountIn / 10_000n
  const smallOut = small > 0n ? ((await quoteHops(client, owner, packages, ctx, best.hops, small, signal)) ?? 0n) : 0n
  // 参考交易的输出太小时取整误差太大（不到 100 个最小单位，误差超过 1%），算不准，返回 null
  const priceImpact = smallOut >= 100n ? Math.max(0, 1 - Number(best.amountOut) / Number(amountIn) / (Number(smallOut) / Number(small))) : null
  const amountOutMin = withSlippageDown(best.amountOut, slippage)
  const route = (c: Candidate) => routeOf(tokenIn, c)
  const plan: SwapPlan = {
    tokenIn: tIn,
    tokenOut: tOut,
    amountIn: amountIn.toString(),
    amountInFormatted: fmt(amountIn, tIn),
    amountOut: best.amountOut.toString(),
    amountOutFormatted: fmt(best.amountOut, tOut),
    amountOutMin: amountOutMin.toString(),
    amountOutMinFormatted: fmt(amountOutMin, tOut),
    price: tIn.decimals === null || tOut.decimals === null ? null : Number(best.amountOut) / 10 ** tOut.decimals / (Number(amountIn) / 10 ** tIn.decimals),
    priceImpact,
    route: route(best),
    routes: routes.map(route),
    kind: { inputs: [], commands: [] },
    gasSpend: 0n,
  }
  return { plan, build: (c, fromGas) => buildKind(c, owner, packages, best.hops, amountIn, amountOutMin, fromGas) }
}

/**
 * 报价并构建兑换的交易（不签名）：选输出最多的路线，最少收到 = 报价 × (1 − slippage)；发送者自己付 gas。
 * 报价从 owner 执行一遍兑换（只读调用，不需要签名），owner 要持有卖出的币（SUI 除外）
 *
 * ```ts
 * const plan = await buildSwap(sui, owner, { tokenIn: SUI_COIN_TYPE, tokenOut: USDC, amountInFormatted: '10' })
 * plan.amountOutFormatted   // '34.12'
 * plan.route                // { path: [SUI, USDC], hops: [{ protocol: 'cetus', pool: '0x…', … }], … }
 * ```
 */
export async function buildSwap(client: SuiClient, owner: string, params: SwapParams, options: SwapOptions = {}): Promise<SwapPlan> {
  const sender = normalizeSuiAddress(owner)
  const p = await prepare(client, sender, params, options)
  return { ...p.plan, ...(await p.build(buildContext(client, null, () => ({ signal: options.signal })), true)) }
}

export interface SwapSendOptions extends SwapOptions, Omit<SendOptions, 'signal'> {
  /** 付 gas 的钱包（赞助交易） */
  sponsor?: SignerInput
  /** 发送前检查卖出的币的余额（SUI 另外留 0.05 SUI 的 gas），默认 true */
  checkBalance?: boolean
}

export type SwapResult = WriteResult & { plan: SwapPlan }

/**
 * 兑换：报价（同 buildSwap）后签名发送（钱包同 /write：私钥、Keypair、浏览器钱包…）。发送时按最新的 Coin 重新构建交易，
 * 路线和最少收到的数量不变；超出滑点时交易失败（模拟时就会失败，不花 gas）
 *
 * ```ts
 * const r = await swap(sui, key, { tokenIn: USDC, tokenOut: SUI_COIN_TYPE, amountInFormatted: '100' }, { slippage: 0.01 })
 * r.status   // 'confirmed'
 * ```
 */
export async function swap(client: SuiClient, from: SignerInput, params: SwapParams, options: SwapSendOptions = {}): Promise<SwapResult> {
  const sender = await resolveSigner(from)
  const sponsor = options.sponsor === undefined ? undefined : await resolveSigner(options.sponsor)
  const sponsored = !!sponsor && sponsor.address !== sender.address
  const p = await prepare(client, sender.address, params, options)
  if (options.checkBalance ?? true) {
    const coinType = p.plan.tokenIn.coinType
    const need = BigInt(p.plan.amountIn) + (coinType === SUI_COIN_TYPE && !sponsored ? 50_000_000n : 0n)
    const { balance } = await getBalance(client.transport, sender.address, coinType, { signal: options.signal })
    if (balance.balance < need) throw new Error(`Insufficient balance of ${coinType}: need ${need}${coinType === SUI_COIN_TYPE && !sponsored ? ' (including about 0.05 SUI for gas)' : ''}, have ${balance.balance}`)
  }
  let result = toWriteResult(0, sender.address, emptyOutcome('skipped'))
  let built: { kind: ProgrammableTransaction; gasSpend: bigint } | null = null
  await sendJobs(
    client,
    [
      {
        sender,
        sponsor,
        build: async (ctx) => (built = await p.build(ctx, !sponsored)),
        onUpdate: (outcome) => {
          result = toWriteResult(0, sender.address, outcome)
          options.onUpdate?.(result)
        },
      },
    ],
    options,
  )
  const last = built as { kind: ProgrammableTransaction; gasSpend: bigint } | null
  return { ...result, plan: last ? { ...p.plan, ...last } : p.plan }
}
