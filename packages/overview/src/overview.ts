import { CHAIN_NAMES, DEFAULT_TOKENS, TRON_CHAIN_ID, knownAsset, normalizeToken } from './defaults.js'
import type {
  ApprovalItem,
  ApprovalSummary,
  ApprovalsOptions,
  AssetTotal,
  ChainKind,
  ChainOverview,
  EvmChainConfig,
  EvmDiscover,
  ModuleLoader,
  Overview,
  OverviewInput,
  OverviewLp,
  OverviewOptions,
  OverviewToken,
} from './types.js'

/** 各链包 `/price`、`/approvals`、`/owner` 子路径的包名：没传加载器时（Node、脚本）按它动态导入 */
const MODULES = {
  evm: '@w3lib/evm-batch-call/price',
  evmApprovals: '@w3lib/evm-batch-call/approvals',
  evmOwner: '@w3lib/evm-batch-call/owner',
  solana: '@w3lib/solana-batch-call/price',
  solanaApprovals: '@w3lib/solana-batch-call/approvals',
  sui: '@w3lib/sui-batch-call/price',
  ton: '@w3lib/ton-batch-call/price',
} as const

type ModuleKey = keyof typeof MODULES

/** EVM / Tron 的主币标识（与 @w3lib/evm-batch-call 的 NATIVE_TOKEN 相同，Tron 也用它；这里写死，避免为一个常量引入主入口） */
const EVM_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
/** evm-batch-call 默认也按主币处理的零地址：应用传了它时去掉，避免主币查两次 */
const EVM_ZERO = '0x0000000000000000000000000000000000000000'
const SOLANA_NATIVE = 'So11111111111111111111111111111111111111112'
const DEFAULT_MAX_APPROVAL_TOKENS = 30

/** 链包 getPortfolio 返回的数据（结构，不引用链包类型） */
interface RawPortfolio {
  totalUsd: number
  tokensUsd: number
  lpUsd: number
  tokens: Array<Record<string, any>>
  lp: Array<Record<string, any>>
  unpriced: number
}

interface ChainSpec {
  chain: string
  kind: ChainKind
  chainId?: number
  address: string
  node: Record<string, unknown>
  portfolio: Record<string, unknown>
  /** 查余额的代币（EVM / Tron / Solana）；undefined 表示链包自己列出全部持仓 */
  tokens?: string[]
  /** Solana：tokens 没传时先试列出全部，失败后退回的列表 */
  fallbackTokens?: string[]
  discover?: boolean | EvmDiscover
}

const dedupe = (list: readonly string[], kind: ChainKind): string[] => {
  const seen = new Set<string>()
  return list.filter((t) => {
    const k = normalizeToken(kind, t)
    return !seen.has(k) && !!seen.add(k)
  })
}

/** EVM / Tron：主币放在第一个，总是查（链包的 getPortfolio 只查传入的代币） */
const withNative = (list: readonly string[], kind: ChainKind): string[] =>
  dedupe([EVM_NATIVE, ...list.filter((t) => t.toLowerCase() !== EVM_NATIVE.toLowerCase() && t.toLowerCase() !== EVM_ZERO)], kind)

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function assertAddress(name: string, address: unknown): void {
  if (typeof address !== 'string' || !address.trim()) {
    throw new TypeError(`@w3lib/overview: ${name}.address must be a non-empty string`)
  }
}

/** 把输入展开成每条链一个 ChainSpec（配置错误直接抛出，不算链出错） */
function buildSpecs(input: OverviewInput): ChainSpec[] {
  const specs: ChainSpec[] = []
  const defaultsOf = (key: string) => DEFAULT_TOKENS[key]?.map(([a]) => a) ?? []
  const { evm, tron, solana, sui, ton } = input
  if (evm) {
    assertAddress('evm', evm.address)
    if (!Array.isArray(evm.chains) || !evm.chains.length) {
      throw new TypeError('@w3lib/overview: evm.chains must list at least one chain id')
    }
    const seen = new Set<number>()
    for (const item of evm.chains) {
      const cfg: EvmChainConfig = typeof item === 'number' ? { chainId: item } : item
      if (!Number.isSafeInteger(cfg.chainId) || cfg.chainId <= 0) {
        throw new TypeError(`@w3lib/overview: invalid EVM chain id ${String(cfg.chainId)}`)
      }
      if (seen.has(cfg.chainId)) continue
      seen.add(cfg.chainId)
      const chain = `evm:${cfg.chainId}`
      specs.push({
        chain,
        kind: 'evm',
        chainId: cfg.chainId,
        address: evm.address,
        node: cfg.node ?? {},
        portfolio: cfg.portfolio ?? {},
        tokens: withNative([...(cfg.defaults === false ? [] : defaultsOf(chain)), ...(evm.tokens?.[cfg.chainId] ?? []), ...(cfg.tokens ?? [])], 'evm'),
        discover: cfg.discover ?? evm.discover,
      })
    }
  }
  if (tron) {
    assertAddress('tron', tron.address)
    specs.push({
      chain: 'tron',
      kind: 'tron',
      chainId: TRON_CHAIN_ID,
      address: tron.address,
      node: tron.node ?? {},
      portfolio: tron.portfolio ?? {},
      tokens: withNative([...(tron.defaults === false ? [] : defaultsOf('tron')), ...(tron.tokens ?? [])], 'tron'),
      discover: tron.discover,
    })
  }
  if (solana) {
    assertAddress('solana', solana.address)
    const fallbackTokens = defaultsOf('solana')
    const base = { chain: 'solana', kind: 'solana' as const, address: solana.address, node: solana.node ?? {}, portfolio: solana.portfolio ?? {} }
    if (solana.tokens === undefined) specs.push({ ...base, fallbackTokens })
    else specs.push({ ...base, tokens: solana.tokens === 'default' ? fallbackTokens : dedupe([SOLANA_NATIVE, ...solana.tokens], 'solana') })
  }
  for (const [kind, cfg] of [['sui', sui], ['ton', ton]] as const) {
    if (!cfg) continue
    assertAddress(kind, cfg.address)
    specs.push({ chain: kind, kind, address: cfg.address, node: cfg.node ?? {}, portfolio: cfg.portfolio ?? {} })
  }
  if (!specs.length) {
    throw new TypeError('@w3lib/overview: pass at least one of evm / tron / solana / sui / ton')
  }
  return specs
}

// ---------------------------------------------------------------------------
// 加载链包
// ---------------------------------------------------------------------------

function moduleLoader(options: OverviewOptions) {
  const cache = new Map<ModuleKey, Promise<any>>()
  return (key: ModuleKey): Promise<any> => {
    let p = cache.get(key)
    if (!p) {
      const loader: ModuleLoader | undefined = options.loaders?.[key]
      p = (loader ? loader() : import(/* @vite-ignore */ /* webpackIgnore: true */ MODULES[key])).catch((err: unknown) => {
        cache.delete(key)
        throw new Error(
          `${MODULES[key]} could not be loaded (${messageOf(err)}). Install the package and pass loaders: { ${key}: () => import('${MODULES[key]}') }`,
          { cause: err },
        )
      })
      cache.set(key, p)
    }
    return p
  }
}

// ---------------------------------------------------------------------------
// 并发、取消
// ---------------------------------------------------------------------------

/** work 和 signal 的取消谁先到用谁；结束后移除挂在 signal 上的监听（调用方的 signal 可能被多次 getOverview 共用） */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener('abort', onAbort))
}

/** 最多 limit 个同时进行 */
async function pool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await run(items[next++] as T)
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
}

// ---------------------------------------------------------------------------
// 单条链
// ---------------------------------------------------------------------------

type Lp = boolean | Record<string, unknown>

/** 这条链实际的 LP 参数：链上的 `portfolio.lp` 优先（对象和全局的对象合并；true 时用全局的对象），没有时用全局的 `options.lp` */
function lpOf(spec: ChainSpec, global: Lp | undefined): Lp {
  const own = spec.portfolio.lp
  const globalObj = global && typeof global === 'object' ? global : undefined
  if (own === undefined) return global ?? false
  if (own && typeof own === 'object') return globalObj ? { ...globalObj, ...(own as Record<string, unknown>) } : (own as Record<string, unknown>)
  return own ? (globalObj ?? true) : false
}

/**
 * 依次尝试，失败了才降级：完整的（带 LP）→ 去掉 LP（判断失败是否由 LP 引起）→（Solana 没传 tokens 时）退回内置代币列表。
 * 不带 LP 的那次也失败时，原因不在 LP：直接报这一次的错误（不是 LP 那次的），只有 Solana 列出持仓失败时才再试内置列表
 */
async function fetchPortfolio(spec: ChainSpec, load: (k: ModuleKey) => Promise<any>, options: OverviewOptions, signal: AbortSignal, warnings: string[]): Promise<RawPortfolio> {
  const mod = await load(spec.kind === 'solana' || spec.kind === 'sui' || spec.kind === 'ton' ? spec.kind : 'evm')
  const sources = options.sources?.[spec.kind] ?? (spec.kind === 'tron' ? options.sources?.evm : undefined)
  const onPriceError = options.onPriceError ? (err: unknown) => options.onPriceError?.(spec.chain, err) : undefined
  const lp = lpOf(spec, options.lp)
  // minUsd 不交给链包：授权检查要用过滤前的全部持仓，显示时再过滤（runChain）
  const { lp: _ownLp, minUsd: _ownMinUsd, ...portfolio } = spec.portfolio
  const attempt = (tokens: string[] | undefined, withLp: Lp): Promise<RawPortfolio> =>
    mod.getPortfolio(spec.address, {
      ...spec.node,
      ...(spec.chainId !== undefined ? { chainId: spec.chainId } : {}),
      ...(tokens ? { tokens } : {}),
      ...(sources ? { sources } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(onPriceError ? { onPriceError } : {}),
      signal,
      ...portfolio,
      ...(withLp ? { lp: withLp } : {}),
    })
  let lpError: unknown
  if (lp) {
    try {
      return await attempt(spec.tokens, lp)
    } catch (err) {
      if (signal.aborted) throw err
      lpError = err
    }
  }
  let basicError: unknown
  try {
    const result = await attempt(spec.tokens, false)
    if (lp) warnings.push(`LP positions skipped: ${messageOf(lpError)}`)
    return result
  } catch (err) {
    if (signal.aborted || !spec.fallbackTokens) throw err
    basicError = err
  }
  try {
    const result = await attempt(spec.fallbackTokens, false)
    warnings.push(`holdings listing failed, using the built-in token list: ${messageOf(basicError)}`)
    if (lp) warnings.push(messageOf(lpError) === messageOf(basicError) ? 'LP positions skipped (holdings listing failed)' : `LP positions skipped: ${messageOf(lpError)}`)
    return result
  } catch (err) {
    if (signal.aborted) throw err
    const basic = messageOf(basicError)
    const last = messageOf(err)
    throw last === basic ? basicError : new Error(`${basic}; built-in token list also failed: ${last}`, { cause: basicError })
  }
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

function assetOf(chain: string, t: Record<string, any>, mergeBySymbol: boolean): { asset: string; known: boolean } {
  const symbol = typeof t.symbol === 'string' && t.symbol ? t.symbol : null
  // 主币按 symbol 合并（各 L2 的 ETH 是一项）；symbol 未知（不在链信息表里的链）时按链区分，不和别的链的主币混在一起
  if (t.native) return symbol ? { asset: symbol.toUpperCase(), known: true } : { asset: `${chain}:native`, known: false }
  const known = knownAsset(chain, String(t.token))
  if (known) return { asset: known, known: true }
  return { asset: mergeBySymbol && symbol ? symbol.toUpperCase() : `${chain}:${String(t.token)}`, known: false }
}

function normalizeTokens(spec: ChainSpec, raw: RawPortfolio, mergeBySymbol: boolean): OverviewToken[] {
  return raw.tokens.map((t) => ({
    chain: spec.chain,
    token: String(t.token),
    native: !!t.native,
    symbol: typeof t.symbol === 'string' ? t.symbol : null,
    asset: assetOf(spec.chain, t, mergeBySymbol).asset,
    balance: String(t.balance),
    decimals: typeof t.decimals === 'number' ? t.decimals : null,
    formatted: typeof t.formatted === 'string' ? t.formatted : null,
    price: typeof t.price === 'number' ? t.price : null,
    value: typeof t.value === 'number' ? t.value : null,
    priceSource: typeof t.priceSource === 'string' ? t.priceSource : null,
  }))
}

/** 内置表里不认识的代币单个价值超过上限时，价格多半是薄池子算出来的假数：按“没有价格”处理，不计入合计 */
function capOutliers(spec: ChainSpec, tokens: OverviewToken[], cap: number, warnings: string[]): { removedUsd: number; count: number } {
  let removedUsd = 0
  let count = 0
  for (const t of tokens) {
    if (t.native || t.value === null || t.value <= cap || knownAsset(spec.chain, t.token)) continue
    warnings.push(`price of ${t.symbol ?? t.token} ignored: ${Math.round(t.value)} USD exceeds maxUnknownTokenUsd (probably a thin pool)`)
    removedUsd += t.value
    count++
    t.price = null
    t.value = null
    t.priceSource = null
  }
  return { removedUsd, count }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function normalizeLp(chain: string, p: Record<string, any>): OverviewLp {
  const side = (t: any, amount: unknown) => ({ token: String(t?.address ?? t?.mint ?? t?.coinType ?? ''), symbol: typeof t?.symbol === 'string' ? t.symbol : null, amountFormatted: typeof amount === 'string' ? amount : null })
  const tokens = Array.isArray(p.coins)
    ? p.coins.map((c: any) => side(c, c.amountFormatted))
    : [side(p.token0, p.amount0Formatted), side(p.token1, p.amount1Formatted)]
  return {
    chain,
    protocol: String(p.protocol ?? ''),
    protocolName: String(p.protocolName ?? p.protocol ?? ''),
    kind: String(p.version ?? p.type ?? ''),
    pool: String(p.pool ?? ''),
    tokens,
    valueUsd: num(p.valueUsd),
    feesUsd: num(p.feesUsd),
    inRange: typeof p.inRange === 'boolean' ? p.inRange : null,
    raw: p,
  }
}

function summarize(items: ApprovalItem[]): ApprovalSummary {
  return { total: items.length, unlimited: items.filter((i) => i.unlimited).length, unknownSpender: items.filter((i) => i.unknownSpender).length, items }
}

/** 授权风险：只统计有效的授权（额度为 0 / 已过期 / 未授权的不算） */
async function fetchApprovals(spec: ChainSpec, tokens: OverviewToken[], load: (k: ModuleKey) => Promise<any>, opts: ApprovalsOptions): Promise<ApprovalSummary | undefined> {
  const held = tokens
    .filter((t) => !t.native && BigInt(t.balance || '0') > 0n)
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
    .slice(0, Math.max(0, opts.maxTokens ?? DEFAULT_MAX_APPROVAL_TOKENS))
    .map((t) => t.token)
  if (!held.length) return summarize([])
  const items: ApprovalItem[] = []
  if (spec.kind === 'solana') {
    const mod = await load('solanaApprovals')
    const list = (await mod.getApprovals(spec.address, { ...spec.node, mints: held, ...opts.options })) as Array<Record<string, any>>
    for (const a of list) {
      if (!a.delegate || BigInt(a.delegatedAmount ?? '0') === 0n) continue
      items.push({ chain: spec.chain, type: 'delegate', asset: String(a.mint), symbol: a.symbol ?? null, spender: String(a.delegate), spenderName: null, unlimited: BigInt(a.delegatedAmount) >= 2n ** 63n, unknownSpender: true })
    }
  } else {
    const mod = await load('evmApprovals')
    const list = (await mod.getApprovals(spec.address, { ...spec.node, chainId: spec.chainId, tokens: held, ...opts.options })) as Array<Record<string, any>>
    for (const a of list) {
      if (a.type === 'nft' ? !a.approved : a.type === 'permit2' && a.expired) continue
      items.push({
        chain: spec.chain,
        type: a.type,
        asset: String(a.token ?? a.collection),
        symbol: a.symbol ?? null,
        spender: String(a.spender),
        spenderName: a.spenderName ?? null,
        // setApprovalForAll 授权的是整个合集
        unlimited: a.type === 'nft' ? true : !!a.unlimited,
        unknownSpender: !a.spenderName,
      })
    }
  }
  return summarize(items)
}

// ---------------------------------------------------------------------------
// 一条链
// ---------------------------------------------------------------------------

async function discoverTokens(spec: ChainSpec, load: (k: ModuleKey) => Promise<any>, options: OverviewOptions, signal: AbortSignal): Promise<string[]> {
  if (typeof spec.discover === 'function') {
    return [...(await spec.discover({ chainId: spec.chainId as number, address: spec.address, signal }))]
  }
  const mod = await load('evmOwner')
  const owned = (await mod.getOwnerTokens(spec.address, { ...spec.node, chainId: spec.chainId, includeNative: false, ...(options.fetch ? { fetch: options.fetch } : {}), signal })) as Array<Record<string, any>>
  return owned.filter((t) => !t.native).map((t) => String(t.token))
}

async function runChain(spec: ChainSpec, load: (k: ModuleKey) => Promise<any>, options: OverviewOptions): Promise<ChainOverview> {
  const t0 = Date.now()
  const warnings: string[] = []
  const ctl = new AbortController()
  const parent = options.signal
  const onAbort = () => ctl.abort(parent?.reason)
  parent?.addEventListener('abort', onAbort, { once: true })
  const timeoutMs = options.chainTimeoutMs ?? 60_000
  const timer = setTimeout(() => ctl.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
  const head = { chain: spec.chain, kind: spec.kind, ...(spec.chainId !== undefined ? { chainId: spec.chainId } : {}), name: CHAIN_NAMES[spec.chain] ?? spec.chain, address: spec.address }
  try {
    const work = async (): Promise<ChainOverview> => {
      if (spec.discover && spec.tokens) {
        try {
          spec = { ...spec, tokens: dedupe([...spec.tokens, ...(await discoverTokens(spec, load, options, ctl.signal))], spec.kind) }
        } catch (err) {
          if (ctl.signal.aborted) throw err
          warnings.push(`token discovery failed: ${messageOf(err)}`)
        }
      }
      const raw = await fetchPortfolio(spec, load, options, ctl.signal, warnings)
      const all = normalizeTokens(spec, raw, !!options.mergeBySymbol)
      const outliers = capOutliers(spec, all, options.maxUnknownTokenUsd ?? 1_000_000, warnings)
      let approvals: ApprovalSummary | undefined
      if (options.approvals && spec.kind !== 'sui' && spec.kind !== 'ton') {
        try {
          // 用 minUsd 过滤前的全部持仓：零头、没有价格的代币上的授权一样危险
          approvals = await fetchApprovals(spec, all, load, options.approvals === true ? {} : options.approvals)
        } catch (err) {
          if (ctl.signal.aborted) throw err
          warnings.push(`approvals check failed: ${messageOf(err)}`)
        }
      }
      // minUsd 只影响列出哪些代币（同链包：大于 0 时没有价格的也不列出），不影响合计
      const minUsd = num(spec.portfolio.minUsd) ?? options.minUsd ?? 0
      const tokens = minUsd > 0 ? all.filter((t) => t.value !== null && t.value >= minUsd) : all
      return {
        ...head,
        status: warnings.length ? 'partial' : 'ok',
        warnings,
        totalUsd: Math.max(0, (num(raw.totalUsd) ?? 0) - outliers.removedUsd),
        tokensUsd: Math.max(0, (num(raw.tokensUsd) ?? 0) - outliers.removedUsd),
        lpUsd: num(raw.lpUsd) ?? 0,
        tokens,
        lp: raw.lp.map((p) => normalizeLp(spec.chain, p)),
        unpriced: (raw.unpriced ?? 0) + outliers.count,
        ...(approvals ? { approvals } : {}),
        ms: Date.now() - t0,
      }
    }
    return await raceAbort(work(), ctl.signal)
  } catch (err) {
    return { ...head, status: 'error', error: messageOf(err), warnings, totalUsd: 0, tokensUsd: 0, lpUsd: 0, tokens: [], lp: [], unpriced: 0, ms: Date.now() - t0 }
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', onAbort)
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

function aggregateTokens(chains: readonly ChainOverview[]): AssetTotal[] {
  const map = new Map<string, AssetTotal & { pricedAmount: number }>()
  for (const c of chains) {
    for (const t of c.tokens) {
      const known = t.native ? t.asset !== `${c.chain}:native` : knownAsset(c.chain, t.token) !== undefined
      let a = map.get(t.asset)
      if (!a) {
        a = { key: t.asset, symbol: known ? t.asset : t.symbol, known, amount: 0, usd: 0, price: null, unpriced: false, chains: [], pricedAmount: 0 }
        map.set(t.asset, a)
      }
      const amount = t.formatted === null ? 0 : Number(t.formatted)
      a.amount += amount
      if (t.value === null) a.unpriced = true
      else {
        a.usd += t.value
        a.pricedAmount += amount
      }
      a.chains.push({ chain: c.chain, token: t.token, formatted: t.formatted, value: t.value })
    }
  }
  return [...map.values()]
    .map(({ pricedAmount, ...a }) => ({ ...a, price: pricedAmount > 0 ? a.usd / pricedAmount : null }))
    .sort((x, y) => y.usd - x.usd)
}

/**
 * 多链资产总览：每条链调用对应链包的 getPortfolio（代币余额 × 价格，可选 LP、授权风险），并发有限，
 * 某条链失败不影响其他链（该链 status 为 'error'，其余照常返回）。
 *
 * ```ts
 * const overview = await getOverview(
 *   { evm: { address: '0x…', chains: [1, 56, 8453] }, solana: { address: '…' }, ton: { address: 'UQ…' } },
 *   { loaders: { evm: () => import('@w3lib/evm-batch-call/price'), solana: () => import('@w3lib/solana-batch-call/price'), ton: () => import('@w3lib/ton-batch-call/price') } },
 * )
 * overview.totalUsd   // 合计
 * overview.tokens     // 跨链合并的资产（USDC 在各链上合成一项）
 * overview.errors     // 失败的链
 * ```
 */
export async function getOverview(input: OverviewInput, options: OverviewOptions = {}): Promise<Overview> {
  const specs = buildSpecs(input)
  const started = Date.now()
  const { signal } = options
  signal?.throwIfAborted()
  const load = moduleLoader(options)
  const done = new Map<string, ChainOverview>()
  const run = pool(specs, options.concurrency ?? 4, async (spec) => {
    if (signal?.aborted) return
    const result = await runChain(spec, load, options)
    done.set(spec.chain, result)
    try {
      options.onChain?.(result)
    } catch {
      // 界面回调出错不影响结果
    }
  })
  await (signal ? raceAbort(run, signal) : run)
  return combineChains(
    specs.map((s) => done.get(s.chain) as ChainOverview),
    Date.now() - started,
    !!options.approvals,
  )
}

/**
 * 把若干条链的结果汇总成 Overview（getOverview 和 /mnemonic 的多账户合计共用；同一条链可以出现多次，如多个账户的 evm:1）。
 * `accountOf` 给出每条结果属于哪个账户（写进 errors）；同一条链出现多次时 timings.chains 的键是 `链@地址`
 */
export function combineChains(chains: readonly ChainOverview[], totalMs: number, approvals: boolean, accountOf?: (c: ChainOverview) => number | undefined): Overview {
  const byChain = [...chains].sort((a, b) => b.totalUsd - a.totalUsd)
  const sum = (f: (c: ChainOverview) => number) => byChain.reduce((s, c) => s + f(c), 0)
  const approvalItems = byChain.flatMap((c) => c.approvals?.items ?? [])
  const seen = new Map<string, number>()
  for (const c of byChain) seen.set(c.chain, (seen.get(c.chain) ?? 0) + 1)
  const timingKey = (c: ChainOverview) => ((seen.get(c.chain) ?? 0) > 1 ? `${c.chain}@${c.address}` : c.chain)
  return {
    totalUsd: sum((c) => c.totalUsd),
    tokensUsd: sum((c) => c.tokensUsd),
    lpUsd: sum((c) => c.lpUsd),
    byChain,
    tokens: aggregateTokens(byChain),
    lp: byChain.flatMap((c) => c.lp).sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1)),
    ...(approvals ? { approvals: summarize(approvalItems) } : {}),
    unpriced: sum((c) => c.unpriced),
    errors: byChain
      .filter((c) => c.status === 'error')
      .map((c) => {
        const account = accountOf?.(c)
        return { chain: c.chain, address: c.address, ...(account !== undefined ? { account } : {}), message: c.error as string }
      }),
    timings: { totalMs, chains: Object.fromEntries(byChain.map((c) => [timingKey(c), c.ms])) },
  }
}
