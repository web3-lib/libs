// 余额的三种查法（ATA、扫描全部代币账户、按 mint 查全部代币账户）、持仓列表和补读代币信息

import { base64 } from '@scure/base'

import { attachSlot, FAILED, queryContext, type AccountReader, type QueryContext } from './accountReader.js'
import { getAssociatedTokenAddress, getMetadataAddress, InvalidAddressError, isAddress } from './address.js'
import type { BalanceQuery, BalancesOptions, OwnerTokensOptions, RequestOptions, SolBalancesOptions } from './client.js'
import { NATIVE_MINT, SOL_DECIMALS, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants.js'
import { formatUnits, parseTokenAccount, type AccountInfo } from './layout.js'
import { RpcError } from './rpc.js'
import { nftsOf } from './tokenDetails.js'
import { getMeta, isSmallOwner, learnMeta, learnOwner, setMeta } from './tokenMeta.js'
import type { Commitment, FailureReason, NftDetails, OwnedToken, SolBalance, TokenBalance, TokenProgramOption } from './types.js'
import { SharedAbort } from './util.js'

/** 查询共用的上下文：账户读取、缓存范围（网络）、按原生 SOL 处理的 mint、commitment */
export interface ReadContext {
  reader: AccountReader
  scope: string
  nativeMints: ReadonlySet<string>
  commitment: Commitment
}

export const TOKEN_PROGRAMS: readonly string[] = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]

// 用 Map：普通对象会让 'constructor' 等原型上的名字通过校验
const PROGRAM_ALIASES = new Map<string, string>([
  ['spl', TOKEN_PROGRAM_ID],
  ['token-2022', TOKEN_2022_PROGRAM_ID],
  [TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID],
  [TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM_ID],
])

/**
 * 简写 / 程序地址转成程序地址（顺序固定为 Token、Token-2022）。
 * 不认识的值和空数组报错，避免拼错或漏选时悄悄过滤掉全部代币
 */
export function resolvePrograms(tokenPrograms: readonly TokenProgramOption[] | undefined): readonly string[] {
  if (tokenPrograms === undefined) {
    return TOKEN_PROGRAMS
  }
  if (tokenPrograms.length === 0) {
    throw new Error(`tokenPrograms is empty (expected 'spl' and / or 'token-2022'; omit it to include both)`)
  }
  const wanted = new Set(
    tokenPrograms.map((value) => {
      const program = PROGRAM_ALIASES.get(value)
      if (!program) {
        throw new Error(`Unknown token program: ${value} (expected 'spl', 'token-2022' or a token program id)`)
      }
      return program
    }),
  )
  return TOKEN_PROGRAMS.filter((program) => wanted.has(program))
}

/** 所属程序已知且不在允许范围内 */
export function isExcluded(tokenProgram: string | undefined, allowed: readonly string[]): boolean {
  return tokenProgram !== undefined && !allowed.includes(tokenProgram)
}

/** 按 mint 汇总后精度 0、数量 1 的持仓视为 NFT（ownerTokens 与 ownerNfts 共用） */
export function isNftHolding(holding: Holding): boolean {
  return holding.decimals === 0 && holding.amount === 1n
}

/** #loadMeta 没能补上 decimals 的原因；failed 为节点问题（tolerant 时） */
export type MetaFailure = 'failed' | 'not-found' | 'not-token'

/** 一个 mint 的读取结果：ok、确认不存在 / 不是代币，或节点问题（带错误，非 tolerant 的调用方抛出） */
export type MetaOutcome = 'ok' | 'not-found' | 'not-token' | { error: unknown }

/** 正在读取的代币信息（按 scope:mint）：同一 mint 正在查时共用同一个读取（在途去重） */
export interface MetaLoad {
  /** 这次读取包含元数据账户（能补上 name / symbol） */
  withSymbol: boolean
  /** 发起方的 minContextSlot：只有相同的查询才能加入（否则会继承对方的 slot 约束和因此产生的失败） */
  minContextSlot: number | undefined
  /** 所有调用方都取消后才中止；null 表示发起方没传 signal（不会中止） */
  abort: SharedAbort | null
  promise: Promise<MetaOutcome>
}

const metaLoads = new Map<string, MetaLoad>()

export interface Holding {
  amount: bigint
  decimals: number
  program: string
  /** 代币账户数量 */
  accounts: number
}

export interface ParsedTokenAccount {
  pubkey: string
  account: {
    owner: string
    // 节点解析不了的账户（如 Token-2022 的新扩展）会退回 base64：["…", "base64"]
    data: { parsed?: { info?: { mint?: string; owner?: string; tokenAmount?: { amount?: string; decimals?: number } } } } | [string, string] | string
  }
}

/** jsonParsed 结果里的一个代币账户：节点解析好的直接取；退回 base64 的自己解析（这时没有 decimals，要从 mint 账户补） */
export function readTokenEntry(entry: ParsedTokenAccount): { mint: string; amount: bigint; decimals: number | undefined } | null {
  const data = entry.account?.data
  if (data && !Array.isArray(data) && typeof data === 'object') {
    const info = data.parsed?.info
    if (info?.mint && info.tokenAmount?.decimals !== undefined) {
      return { mint: info.mint, amount: BigInt(info.tokenAmount.amount ?? '0'), decimals: info.tokenAmount.decimals }
    }
  }
  const encoded = Array.isArray(data) ? (data[1] === 'base64' ? data[0] : undefined) : typeof data === 'string' ? data : undefined
  if (encoded === undefined) {
    return null
  }
  try {
    const parsed = parseTokenAccount(base64.decode(encoded))
    return { mint: parsed.mint, amount: parsed.amount, decimals: undefined }
  } catch {
    return null
  }
}

/** ATA 模式下单个代币的查询计划（multiBalances 时多个钱包共用一次 getMultipleAccounts） */
type AtaItem =
  /** owner：钱包地址（主币余额按地址从两组结果里取） */
  | { kind: 'native'; mint: string; owner: string }
  | { kind: 'invalid'; mint: string }
  | { kind: 'excluded'; mint: string }
  | { kind: 'token'; mint: string; mintIndex: number; metadataIndex: number; atas: Array<{ program: string; index: number }> }

export function balancesOf(rc: ReadContext, ctx: QueryContext, owner: string, mints: readonly string[] | undefined, options: BalancesOptions, programs: readonly string[]): Promise<TokenBalance[]> {
  const withSymbol = options.symbol ?? false
  if (mints === undefined || options.scan) {
    return scanBalances(rc, ctx, owner, mints, withSymbol, programs)
  }
  if (options.accounts === 'all') {
    return mintAccountBalances(rc, ctx, owner, mints, withSymbol, programs)
  }
  return ataBalances(rc, ctx, [{ owner, mints }], withSymbol, programs).then((lists) => lists[0] as TokenBalance[])
}

/** ATA 模式：所有钱包的 主币账户 / mint / 元数据 / ATA 一起读，结果按钱包分组 */
export async function ataBalances(rc: ReadContext, ctx: QueryContext, queries: readonly BalanceQuery[], withSymbol: boolean, allowed: readonly string[]): Promise<TokenBalance[][]> {
  const scope = rc.scope
  // 要数据的账户（mint、元数据、ATA）一组；钱包账户只要 lamports：已知是普通钱包（系统账户 / 不存在，数据为空）的
  // 放进同一组（一个请求、同一个快照），其余（可能是数据很大的程序账户）单独一组带 dataSlice——同时发出，合并在同一个 JSON-RPC 批量请求里
  const addresses: string[] = []
  const owners: string[] = []
  const plans = queries.map(({ owner, mints }) => mints.map((mint) => ataPlan(rc, owner, mint, withSymbol, allowed, addresses, owners)))
  const [dataMap, ownerMap] = await rc.reader.fetchGroups(
    [
      { addresses, lamportsOnly: false },
      { addresses: owners, lamportsOnly: true },
    ],
    false,
    ctx,
  )
  // 记下钱包账户是否数据为空：单独读的按结果学习；已放进代币那组的，读到不再是系统账户（如被分配给程序）时移除，下次单独读
  for (const owner of new Set(queries.map((q) => q.owner))) {
    // null（账户不存在）也是结果，不能用 ?? 落到另一组
    const account = ownerMap?.has(owner) ? ownerMap.get(owner) : dataMap?.get(owner)
    if (account !== undefined && account !== FAILED) {
      learnOwner(scope, owner, account)
    }
  }
  const accounts = addresses.map((address) => (dataMap?.get(address) as AccountInfo | null | undefined) ?? null)
  const lamportsOf = (owner: string) => ((ownerMap?.has(owner) ? ownerMap.get(owner) : dataMap?.get(owner)) as AccountInfo | null | undefined)?.lamports ?? 0n
  return plans.map((plan) => plan.flatMap((item) => ataResult(rc, item, accounts, lamportsOf, withSymbol, allowed)))
}

export function ataPlan(rc: ReadContext, owner: string, mint: string, withSymbol: boolean, allowed: readonly string[], addresses: string[], owners: string[]): AtaItem {
  const scope = rc.scope
  if (rc.nativeMints.has(mint)) {
    ;(isSmallOwner(scope, owner) ? addresses : owners).push(owner)
    return { kind: 'native', mint, owner }
  }
  if (!isAddress(mint)) {
    return { kind: 'invalid', mint }
  }
  const meta = getMeta(scope, mint)
  // 导入的缓存里的所属程序没确认过：按未知处理（记错时不会让余额恒为 0）
  const program = meta.programUnverified ? undefined : meta.tokenProgram
  if (isExcluded(program, allowed)) {
    return { kind: 'excluded', mint }
  }
  const needMint = meta.decimals === undefined || program === undefined || (withSymbol && meta.symbol === undefined)
  // 所属程序未知时只推导允许的程序的 ATA，读到 mint 账户后再确认
  const programs = program ? [program] : allowed
  return {
    kind: 'token',
    mint,
    mintIndex: needMint ? addresses.push(mint) - 1 : -1,
    metadataIndex: withSymbol && meta.symbol === undefined ? addresses.push(getMetadataAddress(mint)) - 1 : -1,
    atas: programs.map((program) => ({ program, index: addresses.push(getAssociatedTokenAddress(owner, mint, program)) - 1 })),
  }
}

export function ataResult(
  rc: ReadContext,
  item: AtaItem,
  accounts: readonly (AccountInfo | null)[],
  lamportsOf: (owner: string) => bigint,
  withSymbol: boolean,
  allowed: readonly string[],
): TokenBalance[] {
  const scope = rc.scope
  if (item.kind === 'native') {
    const lamports = lamportsOf(item.owner)
    return [
      withSymbolField(
        { token: item.mint, native: true, balance: lamports.toString(), decimals: SOL_DECIMALS, formatted: formatUnits(lamports, SOL_DECIMALS), tokenProgram: null, success: true },
        withSymbol,
        'SOL',
      ),
    ]
  }
  if (item.kind === 'excluded') {
    return []
  }
  if (item.kind === 'invalid') {
    return [failedBalance(item.mint, 'invalid-address', null, withSymbol, null)]
  }
  const mintAccount = item.mintIndex === -1 ? null : (accounts[item.mintIndex] ?? null)
  const meta = learnMeta(
    scope,
    item.mint,
    mintAccount,
    item.metadataIndex === -1 ? null : (accounts[item.metadataIndex] ?? null),
    item.metadataIndex !== -1 && item.mintIndex !== -1,
  )
  // 代币账户由哪个程序持有就是哪个；mint 账户的 owner 也能确定程序。
  // 所属程序未知时推导了两个程序的 ATA，但一个 mint 只属于一个程序，另一个程序下不可能有这个 mint 的代币账户：找到就结束
  let amount = 0n
  for (const ata of item.atas) {
    const account = accounts[ata.index]
    if (!account || account.owner !== ata.program) {
      continue
    }
    try {
      amount = parseTokenAccount(account.data).amount
    } catch {
      continue // 不是代币账户
    }
    if (meta.tokenProgram === undefined) {
      setMeta(scope, item.mint, { tokenProgram: ata.program })
      meta.tokenProgram = ata.program
    }
    break
  }
  // 读到 mint 账户后才知道是不允许的程序
  if (isExcluded(meta.tokenProgram, allowed)) {
    return []
  }
  if (meta.decimals === undefined) {
    // decimals 未知时一定读了 mint 账户：不存在 / 存在但不是 mint
    return [failedBalance(item.mint, mintAccount ? 'not-token' : 'not-found', meta.tokenProgram ?? null, withSymbol, meta.symbol ?? null)]
  }
  return [
    withSymbolField(
      {
        token: item.mint,
        native: false,
        balance: amount.toString(),
        decimals: meta.decimals,
        formatted: formatUnits(amount, meta.decimals),
        tokenProgram: meta.tokenProgram ?? null,
        success: true,
      },
      withSymbol,
      meta.symbol ?? null,
    ),
  ]
}

/** 扫描持有人的 SOL 余额和全部代币账户（默认 Token + Token-2022，只请求 programs 里的程序），同一代币的多个账户合计 */
export async function scanHoldings(
  rc: ReadContext,
  ctx: QueryContext,
  owner: string,
  programs: readonly string[] = TOKEN_PROGRAMS,
  withSymbol = false,
): Promise<{ sol: bigint; held: Map<string, Holding> }> {
  const [lamports, ...results] = await Promise.all([
    rc.reader.call<{ value: number | string }>(ctx, 'getBalance', [owner, { commitment: rc.commitment }]),
    ...programs.map((programId) =>
      rc.reader.call<{ value: ParsedTokenAccount[] }>(ctx, 'getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: rc.commitment }]),
    ),
  ])
  const entries = programs.flatMap((program, i) => (results[i]?.value ?? []).map((entry) => ({ program, entry })))
  const held = await collectHoldings(rc, ctx, entries, withSymbol)
  return { sol: BigInt(lamports.value), held }
}

/**
 * 把 getTokenAccountsByOwner（jsonParsed）的结果按 mint 汇总。节点解析不了、退回 base64 的账户自己解析，
 * decimals 读 mint 账户补上（不丢弃，也不会把余额算成 0）；mint 读不到 decimals 时才跳过
 */
export async function collectHoldings(
  rc: ReadContext,
  ctx: QueryContext,
  entries: ReadonlyArray<{ program: string | undefined; entry: ParsedTokenAccount }>,
  withSymbol = false,
): Promise<Map<string, Holding>> {
  const scope = rc.scope
  const read = entries.flatMap(({ program, entry }) => {
    const token = readTokenEntry(entry)
    return token ? [{ ...token, program: entry.account?.owner || program }] : []
  })
  read.forEach(({ mint, decimals, program }) => decimals !== undefined && program !== undefined && setMeta(scope, mint, { decimals, tokenProgram: program }))
  // 缺 decimals 或所属程序（节点没给账户 owner）的读 mint 账户补上；需要 symbol 时一起读，后面不必再读一遍
  const unknown = [
    ...new Set(read.filter((t) => getMeta(scope, t.mint).decimals === undefined || (t.program === undefined && getMeta(scope, t.mint).tokenProgram === undefined)).map((t) => t.mint)),
  ]
  if (unknown.length) {
    // 补读 mint 不受 minContextSlot 约束、不计入扫描的 slot（decimals / 所属程序不会因为刚成交而变化）；
    // 节点问题时不让整次扫描失败，读不到的代币跳过
    await loadMeta(rc, { signal: ctx.signal }, unknown, withSymbol, true)
  }
  const held = new Map<string, Holding>()
  for (const { mint, amount, program: entryProgram } of read) {
    const meta = getMeta(scope, mint)
    const decimals = meta.decimals
    const program = entryProgram ?? (meta.programUnverified ? undefined : meta.tokenProgram)
    if (decimals === undefined || program === undefined) {
      continue
    }
    const prev = held.get(mint)
    held.set(mint, { amount: (prev?.amount ?? 0n) + amount, decimals, program, accounts: (prev?.accounts ?? 0) + 1 })
  }
  return held
}

export async function scanBalances(rc: ReadContext, ctx: QueryContext, owner: string, mints: readonly string[] | undefined, withSymbol: boolean, allowed: readonly string[]): Promise<TokenBalance[]> {
  // held 里只有允许的程序的代币
  const { sol, held } = await scanHoldings(rc, ctx, owner, allowed, withSymbol)

  // Wrapped SOL（So111…112）默认按原生 SOL 处理：余额列表里只有一项 SOL，不再列出 wSOL 代币账户
  // 第一项是主币：用 nativeMints 里的地址（nativeMints 不含 So111…112 时 wSOL 作为普通代币列出，不能再拿它当 SOL）
  const nativeLead = rc.nativeMints.has(NATIVE_MINT) ? NATIVE_MINT : rc.nativeMints.values().next().value
  const targets = mints ?? [
    ...(nativeLead === undefined ? [] : [nativeLead]),
    ...[...held].filter(([mint, h]) => h.amount > 0n && !rc.nativeMints.has(mint)).map(([mint]) => mint),
  ]
  // 没持有的代币（拿不到 decimals）和缺 symbol 的代币：只读 mint / 元数据账户补上，不需要 ATA
  const failures = await loadMeta(
    rc,
    ctx,
    targets.filter((mint) => !rc.nativeMints.has(mint) && isAddress(mint)),
    withSymbol,
  )

  return targets.flatMap((mint): TokenBalance[] => {
    if (rc.nativeMints.has(mint)) {
      return [
        withSymbolField(
          { token: mint, native: true, balance: sol.toString(), decimals: SOL_DECIMALS, formatted: formatUnits(sol, SOL_DECIMALS), tokenProgram: null, success: true },
          withSymbol,
          'SOL',
        ),
      ]
    }
    return heldBalance(rc, mint, held.get(mint), failures, withSymbol, allowed)
  })
}

/**
 * 指定 mints、统计全部代币账户：每个代币一次按 mint 过滤的 getTokenAccountsByOwner（同一 tick 发出，自动合并）。
 * mint 不存在 / 不是代币时节点返回参数错误，按“没持有”处理，再由 #loadMeta 确认原因
 */
export async function mintAccountBalances(rc: ReadContext, ctx: QueryContext, owner: string, mints: readonly string[], withSymbol: boolean, allowed: readonly string[]): Promise<TokenBalance[]> {
  const scope = rc.scope
  // 导入的、未经链上确认的所属程序不用来排除代币（可能记错）：照常查询，从链上学到后再按程序过滤
  const queried = [
    ...new Set(
      mints.filter((mint) => {
        const meta = getMeta(scope, mint)
        return !rc.nativeMints.has(mint) && isAddress(mint) && (meta.programUnverified || !isExcluded(meta.tokenProgram, allowed))
      }),
    ),
  ]
  const [lamports, ...results] = await Promise.all([
    mints.some((mint) => rc.nativeMints.has(mint))
      ? rc.reader.call<{ value: number | string }>(ctx, 'getBalance', [owner, { commitment: rc.commitment }])
      : Promise.resolve(null),
    ...queried.map((mint) =>
      rc.reader.call<{ value: ParsedTokenAccount[] }>(ctx, 'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: rc.commitment }]).catch(
        (err: unknown) => {
          // "Invalid param: could not find mint" 等参数错误：mint 不存在或不是代币；节点问题照常抛出
          if (err instanceof RpcError && !err.nodeFault && err.code === -32602) return null
          throw err
        },
      ),
    ),
  ])
  const held = await collectHoldings(
    rc,
    ctx,
    queried.flatMap((_, i) => (results[i]?.value ?? []).map((entry) => ({ program: entry.account?.owner, entry }))),
    withSymbol,
  )
  // 没持有的代币补 decimals（同时确认 mint 是否存在），需要时补 symbol
  const failures = await loadMeta(rc, ctx, queried, withSymbol)
  const sol = BigInt(lamports?.value ?? 0)

  return mints.flatMap((mint): TokenBalance[] => {
    if (rc.nativeMints.has(mint)) {
      return [
        withSymbolField(
          { token: mint, native: true, balance: sol.toString(), decimals: SOL_DECIMALS, formatted: formatUnits(sol, SOL_DECIMALS), tokenProgram: null, success: true },
          withSymbol,
          'SOL',
        ),
      ]
    }
    return heldBalance(rc, mint, held.get(mint), failures, withSymbol, allowed)
  })
}

/** 扫描类查询（scan / accounts: 'all'）里单个代币的结果；不允许的程序返回空数组 */
export function heldBalance(rc: ReadContext, mint: string, h: Holding | undefined, failures: Map<string, MetaFailure>, withSymbol: boolean, allowed: readonly string[]): TokenBalance[] {
  const scope = rc.scope
  if (!isAddress(mint)) {
    return [failedBalance(mint, 'invalid-address', null, withSymbol, null)]
  }
  const meta = getMeta(scope, mint)
  if (!h) {
    // 没持有（或属于不允许的程序）：余额为 0；decimals 来自 mint 账户
    if (isExcluded(meta.tokenProgram, allowed)) {
      return []
    }
    if (meta.decimals === undefined) {
      const failure = failures.get(mint)
      return [failedBalance(mint, failure === 'not-token' ? 'not-token' : 'not-found', meta.tokenProgram ?? null, withSymbol, meta.symbol ?? null)]
    }
    return [withSymbolField({ token: mint, native: false, balance: '0', decimals: meta.decimals, formatted: '0', tokenProgram: meta.tokenProgram ?? null, success: true }, withSymbol, meta.symbol ?? null)]
  }
  if (isExcluded(h.program, allowed)) {
    return []
  }
  return [
    withSymbolField(
      { token: mint, native: false, balance: h.amount.toString(), decimals: h.decimals, formatted: formatUnits(h.amount, h.decimals), tokenProgram: h.program, success: true },
      withSymbol,
      meta.symbol ?? null,
    ),
  ]
}

/**
 * 补齐 decimals / 所属程序（以及需要时的 symbol / name）：只读缺的 mint 账户和元数据账户。
 * 同一 mint 正在被别的查询读取时共用那次读取（不重复发请求）。
 * 返回没能补上 decimals 的 mint 及原因：failed（tolerant 为 true 时的节点问题，信息保持未知、不写缓存）、not-found、not-token；
 * tolerant 为 false 时节点问题直接抛出
 */
export async function loadMeta(rc: ReadContext, ctx: QueryContext, mints: readonly string[], withSymbol: boolean, tolerant = false): Promise<Map<string, MetaFailure>> {
  const scope = rc.scope
  // 查询已取消（外层已经 reject）：不再发起或加入读取
  if (ctx.signal?.aborted) {
    throw ctx.signal.reason
  }
  const waits: Array<{ mint: string; promise: Promise<MetaOutcome> }> = []
  const plan: Array<{ mint: string; metadata: string | null }> = []
  for (const mint of new Set(mints)) {
    const meta = getMeta(scope, mint)
    const needSymbol = withSymbol && meta.symbol === undefined
    if (meta.decimals !== undefined && meta.tokenProgram !== undefined && !needSymbol) {
      continue
    }
    // 正在读、slot 约束相同、且这次读取能补上需要的信息（要 symbol 时得包含元数据账户）：加入它
    const running = metaLoads.get(`${scope}:${mint}`)
    if (running && running.minContextSlot === ctx.minContextSlot && (running.withSymbol || !needSymbol) && (!running.abort || running.abort.join(ctx.signal))) {
      waits.push({ mint, promise: running.promise })
    } else {
      plan.push({ mint, metadata: needSymbol ? getMetadataAddress(mint) : null })
    }
  }
  if (plan.length) {
    waits.push(...startMetaLoad(rc, ctx, plan))
  }
  const failures = new Map<string, MetaFailure>()
  const outcomes = await Promise.all(waits.map((w) => w.promise))
  outcomes.forEach((outcome, i) => {
    const mint = (waits[i] as { mint: string }).mint
    if (outcome === 'ok') {
      return
    }
    if (typeof outcome === 'object') {
      if (!tolerant) {
        throw outcome.error
      }
      failures.set(mint, 'failed')
      return
    }
    failures.set(mint, outcome)
  })
  return failures
}

/**
 * 发起一次代币信息读取并登记为在途（结束后移除）。总是按 tolerant 读：节点问题时把错误带在结果里，
 * 由各调用方按自己的 tolerant 决定抛出还是标记 failed。所有加入的调用方都取消后才中止
 */
export function startMetaLoad(rc: ReadContext, ctx: QueryContext, plan: ReadonlyArray<{ mint: string; metadata: string | null }>): Array<{ mint: string; promise: Promise<MetaOutcome> }> {
  const scope = rc.scope
  const shared = ctx.signal ? new SharedAbort() : null
  shared?.join(ctx.signal)
  const loadCtx: QueryContext = { ...ctx, signal: shared?.signal }
  const failure: { error?: unknown } = {}
  const loaded = rc.reader.fetchAccounts(
    plan.flatMap(({ mint, metadata }) => (metadata ? [mint, metadata] : [mint])),
    true,
    loadCtx,
    failure,
  ).then((fetched) => {
    // 读到的 slot 记回发起方的查询
    if (loadCtx.slot !== undefined) {
      ctx.slot = ctx.slot === undefined ? loadCtx.slot : Math.min(ctx.slot, loadCtx.slot)
    }
    const outcomes = new Map<string, MetaOutcome>()
    for (const { mint, metadata } of plan) {
      const mintAccount = fetched.get(mint)
      const metadataAccount = metadata ? fetched.get(metadata) : null
      // mint 和元数据账户可能落在不同的请求里：任一个没读到都算失败，不能当成“没有元数据”缓存
      if (mintAccount === FAILED || metadataAccount === FAILED) {
        outcomes.set(mint, { error: failure.error })
        continue
      }
      const learned = learnMeta(scope, mint, mintAccount ?? null, metadataAccount ?? null, metadata !== null)
      outcomes.set(mint, learned.decimals === undefined ? (mintAccount ? 'not-token' : 'not-found') : 'ok')
    }
    return outcomes
  })
  const entries = plan.map(({ mint, metadata }) => {
    const key = `${scope}:${mint}`
    const promise = loaded.then((outcomes) => outcomes.get(mint) as MetaOutcome)
    const load: MetaLoad = { withSymbol: metadata !== null, minContextSlot: ctx.minContextSlot, abort: shared, promise }
    metaLoads.set(key, load)
    const remove = () => {
      if (metaLoads.get(key) === load) {
        metaLoads.delete(key)
      }
    }
    promise.then(remove, remove)
    return { mint, promise }
  })
  loaded.then(
    () => shared?.done(),
    () => shared?.done(),
  )
  return entries
}

export function withSymbolField(balance: TokenBalance, withSymbol: boolean, symbol: string | null): TokenBalance {
  return withSymbol ? { ...balance, symbol } : balance
}

/** 失败项：余额为 0，带原因 */
export function failedBalance(token: string, error: FailureReason, tokenProgram: string | null, withSymbol: boolean, symbol: string | null): TokenBalance {
  return { ...withSymbolField({ token, native: false, balance: '0', decimals: 0, formatted: '0', tokenProgram, success: false }, withSymbol, symbol), error }
}

/** 批量查多个地址的 SOL 余额（getMultipleAccounts 只读 lamports、不读回账户数据；账户不存在视为 0） */
export async function solBalancesOf(rc: ReadContext, addresses: readonly string[], options: SolBalancesOptions): Promise<SolBalance[]> {
  const ctx = queryContext(options)
  const balances = await rc.reader.lamports(addresses, ctx)
  const list = addresses.map((address, i): SolBalance => {
    if (!isAddress(address)) {
      return { address, balance: '0', formatted: '0', success: false, error: 'invalid-address' }
    }
    const lamports = balances[i] ?? 0n
    return { address, balance: lamports.toString(), formatted: formatUnits(lamports, SOL_DECIMALS), success: true }
  })
  return attachSlot(list, ctx, options)
}

/**
 * 批量查余额（主币 SOL + SPL Token + Token-2022），返回原始余额、decimals 和换算后的数值。
 *
 * - 传 mints：本地推导 ATA，与 mint 账户一起用 getMultipleAccounts 读完，免费节点也能用；主币只读 lamports（dataSlice），另成一组同时发出
 * - 传 mints 且 accounts: 'all'：每个代币按 mint 过滤查 getTokenAccountsByOwner，统计全部代币账户（含非 ATA）
 * - 不传 mints（或 scan: true）：用 getTokenAccountsByOwner 扫描全部代币账户，返回所有余额大于 0 的代币
 * - 失败项（success: false）带 error：invalid-address（mint 地址非法）/ not-found（mint 不存在）/ not-token（不是代币 mint）
 * - tokenPrograms：只返回这些类型的代币，如 ['spl'] 不含 Token-2022（传了 mints 时，结果里去掉不符合的代币）
 * - minContextSlot / withSlot：要求节点高度、返回读取时的 slot，见 SlotOptions
 */
export async function balancesFor(rc: ReadContext, owner: string, mints: readonly string[] | undefined, options: BalancesOptions): Promise<TokenBalance[]> {
  if (!isAddress(owner)) {
    throw new InvalidAddressError(`Invalid owner address: ${owner}`, owner)
  }
  const ctx = queryContext(options)
  const list = await balancesOf(rc, ctx, owner, mints, options, resolvePrograms(options.tokenPrograms))
  return attachSlot(list, ctx, options)
}

/**
 * 多个钱包一次查（如多钱包的持仓列表），结果与 queries 一一对应。
 * ATA 模式（默认）下所有钱包的账户合并成一次（按 100 个一组的）getMultipleAccounts；
 * scan / accounts: 'all' 时每个钱包各自查询（同一 tick 发出，合并成批量请求）。其他选项与 balances() 相同；
 * withSlot 时所有钱包的结果带同一个 slot（整次查询的最小值）。任一 owner 非法时报错
 *
 * ```ts
 * await sol.multiBalances([{ owner: a, mints: [NATIVE_MINT, USDC] }, { owner: b, mints: [USDC] }])
 * ```
 */
export async function multiBalancesOf(rc: ReadContext, queries: readonly BalanceQuery[], options: BalancesOptions): Promise<TokenBalance[][]> {
  for (const { owner } of queries) {
    if (!isAddress(owner)) {
      throw new InvalidAddressError(`Invalid owner address: ${owner}`, owner)
    }
  }
  const programs = resolvePrograms(options.tokenPrograms)
  const ctx = queryContext(options)
  const lists =
    options.scan || options.accounts === 'all'
      ? await Promise.all(queries.map(({ owner, mints }) => balancesOf(rc, ctx, owner, mints, options, programs)))
      : await ataBalances(rc, ctx, queries, options.symbol ?? false, programs)
  return lists.map((list) => attachSlot(list, ctx, options))
}

/**
 * 列出持有人拥有的全部代币（SOL 在第一位），带 name / symbol，适合做资产列表。
 * 需要支持 getTokenAccountsByOwner 的节点（免费公共节点大多不支持）。
 *
 * - 默认不含 NFT（精度 0 且数量 1）和余额为 0 的代币账户（如已清空的 ATA），可用 includeNfts / includeZero 打开
 * - accounts 是该代币的代币账户数量；大于 1 时余额为所有账户的合计
 * - 顺序：SOL，然后 SPL Token 的代币，再然后 Token-2022 的代币（各自按节点返回的顺序；没有价格信息，不按价值排序）
 * - tokenPrograms: ['spl'] 时不含 Token-2022 代币
 * - withSlot 的 slot 只算余额扫描（元数据读取不计入）
 */
export async function ownerTokensOf(rc: ReadContext, owner: string, options: OwnerTokensOptions): Promise<OwnedToken[]> {
  if (!isAddress(owner)) {
    throw new InvalidAddressError(`Invalid owner address: ${owner}`, owner)
  }
  const { metadata = true, includeNative = true, includeZero = false, includeNfts = false } = options
  const scope = rc.scope
  const ctx = queryContext(options)
  const { sol, held } = await scanHoldings(rc, ctx, owner, resolvePrograms(options.tokenPrograms), metadata)
  const scanSlot = ctx.slot
  // Wrapped SOL 是独立的代币账户（需要 unwrap 才是 SOL），资产列表里单独列出（native: false）
  const tokens = [...held].filter(([, h]) => (includeZero || h.amount > 0n) && (includeNfts || !isNftHolding(h)))
  // 元数据不受 minContextSlot 约束（不会因为刚成交而变化）
  const failures = metadata ? await loadMeta(rc, { signal: options.signal }, tokens.map(([mint]) => mint), true, true) : new Map<string, MetaFailure>()

  const list: OwnedToken[] = tokens.map(([mint, h]) => {
    const item: OwnedToken = {
      token: mint,
      native: false,
      balance: h.amount.toString(),
      decimals: h.decimals,
      formatted: formatUnits(h.amount, h.decimals),
      tokenProgram: h.program,
      accounts: h.accounts,
      success: true,
    }
    if (!metadata) {
      return item
    }
    const meta = getMeta(scope, mint)
    const status = failures.get(mint) === 'failed' ? 'failed' : meta.name == null && meta.symbol == null ? 'missing' : 'ok'
    return { ...item, name: meta.name ?? null, symbol: meta.symbol ?? null, metadataStatus: status }
  })
  if (includeNative) {
    const sol_: OwnedToken = { token: NATIVE_MINT, native: true, balance: sol.toString(), decimals: SOL_DECIMALS, formatted: formatUnits(sol, SOL_DECIMALS), tokenProgram: null, accounts: 1, success: true }
    list.unshift(metadata ? { ...sol_, name: 'Solana', symbol: 'SOL', metadataStatus: 'ok' } : sol_)
  }
  return attachSlot(list, { slot: scanSlot }, options)
}

/** 查某地址持有的全部 NFT（扫描代币账户：数量 1、精度 0），再批量读元数据。需要支持 getTokenAccountsByOwner 的节点 */
export async function ownerNftsOf(rc: ReadContext, owner: string, options: RequestOptions): Promise<NftDetails[]> {
  if (!isAddress(owner)) {
    throw new InvalidAddressError(`Invalid owner address: ${owner}`, owner)
  }
  const { held } = await scanHoldings(rc, { signal: options.signal }, owner)
  const mints = [...held].filter(([, h]) => isNftHolding(h)).map(([mint]) => mint)
  return mints.length ? (await nftsOf(rc, mints, options)).filter((nft) => nft.success) : []
}
