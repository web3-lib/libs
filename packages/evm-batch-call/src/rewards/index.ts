import type { CallOverrides } from '../aggregate.js'
import { MAX_UINT128, createCtx, evm, fmt, out, type Ctx } from '../liquidity/common.js'
import { npmInterface } from '../liquidity/v3.js'
import { Actions, Planner, pmInterface } from '../liquidity/v4.js'
import { LP_PROTOCOLS, lpPositions, type LpConcentratedPosition, type LpProtocol } from '../lp.js'
import { tokenPrices } from '../price.js'
import type { Provider } from '../provider.js'
import { withSignal } from '../util.js'
import { batchCall, tronModule } from '../write/batch.js'
import { resolveSigner } from '../write/signer.js'
import { mapPool } from '../write/send.js'
import { FARM_PROTOCOLS, gaugeInterface, masterChefInterface, readGauges, readMasterChef } from './farms.js'
import type {
  ClaimAllOptions,
  ClaimAllSendOptions,
  ClaimAmount,
  ClaimItem,
  ClaimPlan,
  ClaimResult,
  ClaimSkipped,
  ClaimTx,
  ClaimTxResult,
  Claimable,
  ClaimableOptions,
  FarmProtocol,
} from './types.js'
import type { SignerInput } from '../write/signer.js'

export { FARM_PROTOCOLS } from './farms.js'

const lower = (s: string) => s.toLowerCase()

/** 同一个代币的数量合并 */
function sumAmounts(items: readonly ClaimItem[]): ClaimAmount[] {
  const sum = new Map<string, { amount: ClaimAmount; raw: bigint; usd: number | null | undefined }>()
  for (const { amounts } of items) {
    for (const a of amounts) {
      const key = lower(a.token.address)
      const entry = sum.get(key) ?? { amount: a, raw: 0n, usd: undefined }
      entry.raw += BigInt(a.amount)
      if (a.usd !== undefined) {
        entry.usd = a.usd === null ? (entry.usd ?? null) : (entry.usd ?? 0) + a.usd
      }
      sum.set(key, entry)
    }
  }
  return [...sum.values()]
    .filter((e) => e.raw > 0n)
    .map(({ amount, raw, usd }): ClaimAmount => ({ token: amount.token, amount: raw.toString(), formatted: fmt(raw, amount.token), ...(usd === undefined ? {} : { usd }) }))
}

const usdOf = (amounts: readonly ClaimAmount[]): number | null | undefined => {
  if (amounts.every((a) => a.usd === undefined)) {
    return undefined
  }
  const known = amounts.filter((a) => a.usd != null && BigInt(a.amount) > 0n)
  return known.length ? known.reduce((s, a) => s + (a.usd as number), 0) : null
}

/** 给每一项的数量加美元价值（价格源出错时全部为 null） */
async function applyPrices(provider: Provider, items: ClaimItem[], options: ClaimableOptions): Promise<void> {
  const tokens = [...new Set(items.flatMap((i) => i.amounts).filter((a) => BigInt(a.amount) > 0n).map((a) => a.token.address))]
  if (!tokens.length) {
    return
  }
  let prices: Array<number | null> = tokens.map(() => null)
  try {
    const found = await tokenPrices(provider, tokens, {
      ...(options.prices === true ? {} : { sources: options.prices as never }),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })
    prices = found.map((p) => p.price)
  } catch (err) {
    try {
      options.onPriceError?.(err)
    } catch {
      // 回调出错不影响查询结果
    }
  }
  const priceOf = new Map(tokens.map((t, i) => [lower(t), prices[i] as number | null]))
  for (const item of items) {
    for (const a of item.amounts) {
      const price = priceOf.get(lower(a.token.address)) ?? null
      a.usd = a.formatted !== null && price !== null ? Number(a.formatted) * price : BigInt(a.amount) === 0n ? 0 : null
    }
    item.usd = usdOf(item.amounts) ?? null
  }
}

/** 选出要查的 LP 协议 / 挖矿合约 */
function selectProtocols(chainId: number, options: ClaimableOptions): { lp: Array<string | LpProtocol> | undefined; farms: FarmProtocol[]; lpAll: LpProtocol[] } {
  const farmTable = [...(options.farms ?? []), ...FARM_PROTOCOLS].filter((f) => f.chainId === chainId)
  const custom = (options.protocols ?? []).filter((p): p is LpProtocol => typeof p !== 'string' && p.chainId === chainId)
  const lpAll = [...custom, ...LP_PROTOCOLS.filter((p) => p.chainId === chainId)]
  if (!options.protocols) {
    return { lp: undefined, farms: farmTable, lpAll }
  }
  const lp: Array<string | LpProtocol> = []
  const farms: FarmProtocol[] = []
  for (const p of options.protocols) {
    if (typeof p !== 'string') {
      if (p.chainId === chainId && p.version !== 'v2') lp.push(p)
      continue
    }
    const inLp = lpAll.filter((x) => x.id === p)
    const inFarm = farmTable.filter((f) => f.id === p)
    if (!inLp.length && !inFarm.length) {
      throw new Error(`Unknown protocol ${p} on chain ${chainId}; pass an LpProtocol / FarmProtocol object for protocols that are not built in`)
    }
    // V2 的手续费计入 LP 份额，没有单独领取的
    if (inLp.some((x) => x.version !== 'v2')) lp.push(p)
    farms.push(...inFarm)
  }
  return { lp, farms, lpAll }
}

/**
 * 查一个地址能领取的全部内容（只读）：V3 / V4 仓位未领取的手续费、质押在 MasterChef / gauge 里的仓位的挖矿奖励，
 * 数量按精度换算，可选美元价值。每个来源单独读取，某个来源出错只记进 `errors`
 *
 * ```ts
 * const c = await claimable(multi, user, { prices: true })
 * c.items   // [{ kind: 'fees', protocol: 'uniswap-v3', tokenId: '123', amounts: [{ token: USDC, formatted: '12.3', usd: 12.3 }, …], usd: 20.1 }, { kind: 'farm', amounts: [CAKE …] }, …]
 * c.totals  // 按代币汇总
 * ```
 */
export function claimable(provider: Provider, owner: string, options: ClaimableOptions = {}): Promise<Claimable> {
  return withSignal(options.signal, () => queryClaimable(provider, owner, options))
}

async function queryClaimable(provider: Provider, owner: string, options: ClaimableOptions): Promise<Claimable> {
  const ctx = await createCtx(provider, owner, {})
  const { chainId } = ctx
  const wantFees = options.fees ?? true
  const wantRewards = options.rewards ?? true
  const maxPositions = Math.max(1, Math.floor(options.maxPositions ?? 500))
  const overrides: CallOverrides = {
    ...(options.blockTag !== undefined ? { blockTag: options.blockTag } : {}),
    ...(options.minBlock !== undefined ? { minBlock: options.minBlock } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  }
  const { lp, farms, lpAll } = selectProtocols(chainId, options)
  const errors: Claimable['errors'] = []
  const items: ClaimItem[] = []
  const task = async (source: string, run: () => Promise<ClaimItem[]>) => {
    try {
      items.push(...(await run()))
    } catch (err) {
      errors.push({ source, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const source = { ctx, owner: ctx.owner, overrides, maxPositions, lpProtocols: lpAll }
  await Promise.all([
    wantFees && (lp === undefined || lp.length)
      ? task('positions', async () => {
          const positions = await lpPositions(provider, owner, { ...overrides, ...(lp ? { protocols: lp } : {}), versions: ['v3', 'v4'], v4: options.v4, maxPositions })
          return (positions as LpConcentratedPosition[])
            .filter((p) => BigInt(p.fees0) + BigInt(p.fees1) > 0n)
            .map(
              (p): ClaimItem => ({
                id: `fees:${p.protocol}:${p.tokenId}`,
                kind: 'fees',
                protocol: p.protocol,
                protocolName: p.protocolName,
                version: p.version,
                tokenId: p.tokenId,
                pool: p.pool,
                staked: false,
                target: p.positionManager,
                amounts: [
                  { token: p.token0, amount: p.fees0, formatted: p.fees0Formatted },
                  { token: p.token1, amount: p.fees1, formatted: p.fees1Formatted },
                ],
              }),
            )
        })
      : null,
    ...farms.map((farm) =>
      farm.kind === 'masterchef-v3'
        ? wantFees || wantRewards
          ? task(farm.id, () => readMasterChef(source, farm, wantFees, wantRewards))
          : null
        : wantRewards
          ? task(farm.id, () => readGauges(source, farm, options.gauges))
          : null,
    ),
  ])
  if (options.prices) {
    await applyPrices(provider, items, options)
  }
  if (options.prices) {
    items.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1))
  }
  const totals = sumAmounts(items)
  const usd = usdOf(totals)
  return { chainId, owner: out(ctx, ctx.owner), items, totals, ...(usd === undefined ? {} : { usd }), errors }
}

// ---------------------------------------------------------------------------
// 构建交易
// ---------------------------------------------------------------------------

interface Group {
  kind: ClaimTx['kind']
  type: 'v3' | 'v4' | 'masterchef' | 'gauge'
  target: string
  items: ClaimItem[]
}

function groupOf(items: readonly ClaimItem[]): Group[] {
  const groups = new Map<string, Group>()
  for (const item of items) {
    const [type, kind, key]: [Group['type'], Group['kind'], string] =
      item.kind === 'gauge'
        ? ['gauge', 'gauge', item.id]
        : item.staked
          ? ['masterchef', 'farm', item.target]
          : item.version === 'v4'
            ? ['v4', 'fees', item.target]
            : ['v3', 'fees', item.target]
    const k = `${type}:${key}`
    const group = groups.get(k) ?? { kind, type, target: item.target, items: [] }
    group.items.push(item)
    groups.set(k, group)
  }
  return [...groups.values()]
}

const wrap = (iface: typeof npmInterface, calls: string[]) => (calls.length === 1 ? (calls[0] as string) : iface.encodeFunctionData('multicall', [calls]))

/** 一组（同一个合约）里的若干项 → 一笔交易的 calldata */
function encodeGroup(ctx: Ctx, type: Group['type'], items: readonly ClaimItem[]): string {
  const recipient = ctx.recipient
  if (type === 'v3') {
    return wrap(
      npmInterface,
      items.map((i) => npmInterface.encodeFunctionData('collect', [{ tokenId: i.tokenId, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }])),
    )
  }
  if (type === 'masterchef') {
    return wrap(
      masterChefInterface,
      items.map((i) =>
        i.kind === 'farm'
          ? masterChefInterface.encodeFunctionData('harvest', [i.tokenId, recipient])
          : masterChefInterface.encodeFunctionData('collectTo', [{ tokenId: i.tokenId, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }, recipient]),
      ),
    )
  }
  if (type === 'gauge') {
    return gaugeInterface.encodeFunctionData('getReward', [(items[0] as ClaimItem).tokenId])
  }
  // V4：每个仓位 DECREASE_LIQUIDITY(0) 结算手续费，再把涉及的每个币整个取出（TAKE 的数量 0 = 全部）
  const planner = new Planner()
  const hookData = ctx.options.hookData ?? '0x'
  for (const i of items) {
    planner.add(Actions.DECREASE_LIQUIDITY, ['uint256', 'uint256', 'uint128', 'uint128', 'bytes'], [i.tokenId, 0n, 0n, 0n, hookData])
  }
  const currencies = new Set(items.flatMap((i) => i.amounts.map((a) => evm(a.token.address))))
  for (const currency of currencies) {
    planner.add(Actions.TAKE, ['address', 'address', 'uint256'], [currency, recipient, 0n])
  }
  return pmInterface.encodeFunctionData('modifyLiquidities', [planner.encode(), ctx.deadline])
}

function buildTxs(ctx: Ctx, items: readonly ClaimItem[], batchSize: number): ClaimTx[] {
  return groupOf(items).flatMap((group) => {
    // gauge 的 getReward 一次只能领一个仓位
    const size = group.type === 'gauge' ? 1 : batchSize
    const txs: ClaimTx[] = []
    for (let i = 0; i < group.items.length; i += size) {
      const part = group.items.slice(i, i + size)
      txs.push({ kind: group.kind, to: out(ctx, group.target), data: encodeGroup(ctx, group.type, part), value: '0', itemIds: part.map((x) => x.id) })
    }
    return txs
  })
}

/**
 * 领取计划（不签名、不发送）：把要领取的项合并成尽量少的交易——同一个仓位合约的 V3 仓位用它的 `multicall`、
 * V4 仓位合并成一次 `modifyLiquidities`、MasterChef 的挖矿奖励和质押仓位手续费用它的 `multicall`、每个 gauge 的仓位各一笔。
 * 交易之间互不依赖，可以交给 `batchCall` 的 '7702' / '4337' / '5792' 模式合成一笔原子交易，或者逐笔发送。
 *
 * 默认先模拟（/simulate）：某一笔失败时逐项再试，会失败的项放进 `skipped`，不拖累其他仓位。
 *
 * ```ts
 * const plan = await buildClaimAll(multi, user, { prices: true, minUsd: 1 })
 * plan.transactions   // [{ kind: 'fees', to: npm, data, itemIds: [...] }, { kind: 'farm', … }]
 * plan.skipped        // [{ item, reason: 'below minUsd' }]
 * ```
 */
export async function buildClaimAll(provider: Provider, owner: string, options: ClaimAllOptions = {}): Promise<ClaimPlan> {
  const ctx = await createCtx(provider, owner, { recipient: options.recipient, hookData: options.hookData })
  const batchSize = Math.floor(options.batchSize ?? 20)
  if (!(batchSize >= 1)) {
    throw new RangeError(`batchSize must be at least 1: ${options.batchSize}`)
  }
  if (options.minUsd !== undefined && !(options.minUsd >= 0)) {
    throw new RangeError(`minUsd must not be negative: ${options.minUsd}`)
  }
  const found = options.items ? undefined : await claimable(provider, owner, options)
  const candidates = options.items ? [...options.items] : (found as Claimable).items
  const skipped: ClaimSkipped[] = []
  const seen = new Set<string>()
  let included = candidates.filter((item) => {
    const skip = (reason: string) => {
      skipped.push({ item, reason })
      return false
    }
    if (seen.has(item.id)) return false
    seen.add(item.id)
    if (item.amounts.every((a) => BigInt(a.amount) === 0n)) return skip('nothing to claim')
    // 有一个要领的币没有价格就当价值未知（usd 只是已知部分的合计），不跳过
    const unknownValue = item.amounts.some((a) => BigInt(a.amount) > 0n && a.usd === null)
    if (options.minUsd !== undefined && item.usd != null && !unknownValue && item.usd < options.minUsd) return skip(`below minUsd (${item.usd})`)
    if (item.kind === 'gauge' && ctx.recipient !== ctx.owner) return skip('gauge rewards are always paid to the owner, recipient is not supported')
    return true
  })
  let transactions = buildTxs(ctx, included, batchSize)
  if (options.simulate !== false && transactions.length) {
    const checked = await preflight(provider, ctx, included, transactions, skipped, options.signal)
    included = checked.items
    transactions = checked.transactions
  }
  const totals = sumAmounts(included)
  const usd = usdOf(totals)
  return { chainId: ctx.chainId, owner: out(ctx, ctx.owner), recipient: out(ctx, ctx.recipient), items: included, skipped, totals, ...(usd === undefined ? {} : { usd }), transactions }
}

/**
 * 模拟每一笔；失败的逐项再试，去掉会失败的项后重新构建。逐项都通过、只有合并后的那一笔失败时（gas / multicall 的相互影响）
 * 对半拆开再模拟，直到通过或拆成单项。返回的交易模拟都没有失败；模拟本身出错（节点不支持等）时不拦，照常发送；取消（signal）时抛出
 */
async function preflight(provider: Provider, ctx: Ctx, items: ClaimItem[], transactions: ClaimTx[], skipped: ClaimSkipped[], signal?: AbortSignal): Promise<{ items: ClaimItem[]; transactions: ClaimTx[] }> {
  const { simulate } = await import('../simulate.js')
  const run = async (tx: ClaimTx) => {
    signal?.throwIfAborted()
    try {
      tx.simulation = await simulate(provider, { from: ctx.owner, to: tx.to, data: tx.data, value: 0n }, { from: ctx.owner, fee: false })
      return tx.simulation.success ? null : (tx.simulation.error ?? 'execution reverted')
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err
      return null
    }
  }
  const byId = new Map(items.map((i) => [i.id, i]))
  const failed = new Map<string, string>()
  const settle = async (tx: ClaimTx): Promise<ClaimTx[]> => {
    const error = await run(tx)
    if (error === null) return [tx]
    const list = tx.itemIds.map((id) => byId.get(id) as ClaimItem)
    if (list.length === 1) {
      failed.set(tx.itemIds[0] as string, error)
      return []
    }
    // 逐项再试，找出是哪几个仓位失败
    const singles = await mapPool(list, 4, async (item) => {
      const single = buildTxs(ctx, [item], 1)[0] as ClaimTx
      return { item, single, error: await run(single) }
    })
    const good = singles.filter((s) => s.error === null)
    for (const s of singles) {
      if (s.error !== null) failed.set(s.item.id, s.error)
    }
    if (good.length === singles.length) {
      // 单项都能过、合并的失败：对半拆开
      const half = Math.ceil(list.length / 2)
      const parts = [list.slice(0, half), list.slice(half)].flatMap((part) => buildTxs(ctx, part, part.length))
      return (await Promise.all(parts.map(settle))).flat()
    }
    if (good.length === 1) return [(good[0] as (typeof good)[number]).single]
    return (await Promise.all(buildTxs(ctx, good.map((s) => s.item), list.length).map(settle))).flat()
  }
  const settled: ClaimTx[][] = []
  await mapPool(transactions, 4, async (tx, i) => {
    settled[i] = await settle(tx)
  })
  if (!failed.size) {
    return { items, transactions: settled.flat() }
  }
  for (const item of items) {
    if (failed.has(item.id)) skipped.push({ item, reason: `simulation failed: ${failed.get(item.id)}` })
  }
  return { items: items.filter((i) => !failed.has(i.id)), transactions: settled.flat() }
}

/**
 * 领取全部手续费和挖矿奖励：构建计划（同 buildClaimAll）后用 from 签名发送，每笔独立，某一笔失败不影响后面的。
 * from 与 /write 的 batchCall 相同；`mode: '7702' | '4337' | '5792'` 时合成一笔原子交易（一个仓位失败整笔回滚，所以先模拟、剔除会失败的项）。
 *
 * ```ts
 * const { status, plan, claimed } = await claimAll(multi, privateKey, { minUsd: 1 })
 * await claimAll(multi, privateKey, { mode: '7702' })            // 一笔交易领完
 * await claimAll(multi, privateKey, { items: picked })           // 只领 getClaimable / claimable 结果里挑出来的
 * ```
 */
export async function claimAll(provider: Provider, from: SignerInput, options: ClaimAllSendOptions = {}): Promise<ClaimResult> {
  const tron = await tronModule(provider)
  const owner = tron ? await tron.tronSignerAddress(from) : (await resolveSigner(from)).address
  const plan = await buildClaimAll(provider, owner, options)
  if (!plan.transactions.length) {
    return { plan, results: [], status: 'skipped', claimed: [], failed: [] }
  }
  const {
    items: _items, protocols: _protocols, fees: _fees, rewards: _rewards, v4: _v4, farms: _farms, gauges: _gauges, maxPositions: _max, prices: _prices, onPriceError: _onPriceError,
    fetch: _fetch, recipient: _recipient, hookData: _hookData, minUsd: _minUsd, batchSize: _batchSize, simulate: _simulate, blockTag: _blockTag, from: _from, minBlock: _minBlock, ...send
  } = options
  const written = await batchCall(
    provider,
    plan.transactions.map((tx) => ({ from, to: tx.to, data: tx.data, value: 0n })),
    { ...send, continueOnError: options.continueOnError ?? true },
  )
  const results = written.map((r, i): ClaimTxResult => ({ ...r, kind: (plan.transactions[i] as ClaimTx).kind, itemIds: (plan.transactions[i] as ClaimTx).itemIds }))
  if (options.dryRun) {
    // 只预估：没有领取任何东西。预估通过的项放进 simulated，预估失败的才算 failed
    const ok = new Set(results.filter((r) => r.status === 'simulated').flatMap((r) => r.itemIds))
    const badRun = results.find((r) => r.status !== 'simulated')
    return { plan, results, status: badRun ? badRun.status : 'simulated', claimed: [], failed: plan.items.filter((i) => !ok.has(i.id)), simulated: plan.items.filter((i) => ok.has(i.id)) }
  }
  const confirmed = new Set(results.filter((r) => r.status === 'confirmed').flatMap((r) => r.itemIds))
  const bad = results.find((r) => r.status !== 'confirmed')
  return {
    plan,
    results,
    status: bad ? bad.status : 'confirmed',
    claimed: plan.items.filter((i) => confirmed.has(i.id)),
    failed: plan.items.filter((i) => !confirmed.has(i.id)),
  }
}

export type { ClaimAllOptions, ClaimAllSendOptions, ClaimAmount, ClaimItem, ClaimKind, ClaimPlan, ClaimResult, ClaimSkipped, ClaimTx, ClaimTxResult, Claimable, ClaimableOptions, FarmProtocol } from './types.js'
