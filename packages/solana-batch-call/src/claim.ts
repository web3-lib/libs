/**
 * 批量领取（子路径 `@w3lib/solana-batch-call/claim`）：Orca Whirlpool、Raydium CLMM 仓位的未领取手续费和挖矿奖励（Orca 的奖励 slot、Raydium 的农场奖励）。
 * 先只读预览（每个仓位能领多少、美元价值），再把全部（或选中的）仓位的领取指令打包成交易，发送前用 /simulate 模拟。
 * 领取的指令就是 /liquidity 的 collectFees（手续费 + 全部奖励，SOL 自动解包、缺少的代币账户自动创建），这里只做批量和打包
 */
import type { RequestOptions, SolanaClient } from './client.js'
import { isAddress } from './address.js'
import { buildCollectFees } from './liquidity/index.js'
import type { SolanaLiquidityPlan } from './liquidity/types.js'
import { lpPositions, type SolanaLpClmmPosition, type SolanaLpProtocol, type SolanaLpToken } from './lp.js'
import { defillamaPrices, type SolanaPriceSource } from './price.js'
import { simulatePlan, sendCalls, type PlanSimulation, type PlanSimulationOptions, type PlannedCall } from './batchPlan.js'
import { formatUnits } from './layout.js'
import type { SimulatedBalanceChange } from './simulate.js'
import type { BatchCallOptions } from './write/batch.js'
import { mapPool, type WriteResult } from './write/send.js'
import type { SignerInput } from './write/signer.js'

export type ClaimProtocol = Extract<SolanaLpProtocol, 'orca-whirlpool' | 'raydium-clmm'>

/** 一项能领取的东西：手续费或挖矿奖励 */
export interface ClaimableAmount {
  mint: string
  symbol: string | null
  decimals: number | null
  /** 数量（最小单位）；读不到两端的 tick 数据时为 null */
  amount: string | null
  formatted: string | null
  /** 美元价值（查到价格时；没有价格为 null；数量为 0 时为 0） */
  usd: number | null
  /** 只在按代币汇总（`Claimable.tokens`）里：true 表示有仓位的数量读不到，`amount` 只是已读到部分的合计（偏低），`usd` 为 null */
  incomplete?: true
}

export interface ClaimablePosition {
  protocol: ClaimProtocol
  protocolName: string
  /** 仓位 NFT 的 mint 和仓位账户 */
  positionMint: string
  position: string
  pool: string
  token0: SolanaLpToken
  token1: SolanaLpToken
  liquidity: string
  inRange: boolean
  /** token0 / token1 的未领取手续费 */
  fees: [ClaimableAmount, ClaimableAmount]
  /** 池子里已初始化的挖矿奖励（Orca 的奖励 slot / Raydium 的 reward_infos），数量按程序的方式结算到当前时间 */
  rewards: Array<ClaimableAmount & { index: number }>
  feesUsd: number | null
  rewardsUsd: number | null
  /** 手续费 + 奖励的美元价值：有数量的项缺价格或读不到时为 null */
  totalUsd: number | null
}

export interface Claimable {
  owner: string
  /** 有手续费或奖励可领的仓位（没有流动性也没有可领的不在内），按美元价值从大到小 */
  positions: ClaimablePosition[]
  /** 按代币汇总：手续费 + 奖励，所有仓位合计 */
  tokens: ClaimableAmount[]
  /** true：有仓位的数量读不到（tick 数据读不到），`tokens` 的数量和各项合计都可能偏低 */
  incomplete: boolean
  feesUsd: number | null
  rewardsUsd: number | null
  totalUsd: number | null
  warnings: string[]
}

export interface ClaimQuery extends RequestOptions {
  /** 只看这些仓位 NFT 的 mint（读 ATA，免费公共节点也能用）；不传时列出全部代币账户（getTokenAccountsByOwner，需要支持它的节点） */
  mints?: readonly string[]
  /** 协议，默认两个都查 */
  protocols?: readonly ClaimProtocol[]
  /** 价格：true（默认）用 DefiLlama；false 不查；也可以传自己的价格源（如 combinePrices([defillamaPrices(), onchainPrices()])） */
  prices?: boolean | SolanaPriceSource
  /** 奖励结算到哪个时刻（unix 秒），默认当前时间 */
  now?: number
  fetch?: typeof fetch
}

const MAX_ERROR = 200

/**
 * 预览能领取的手续费和挖矿奖励（只读取，不构建交易）：每个仓位的两种手续费、每个奖励的数量和美元价值，以及按代币汇总。
 * 奖励照搬程序的结算：池子的奖励增长按时间摊给当前流动性，再按仓位区间内的增长计算
 *
 * ```ts
 * const c = await claimable(client, owner)
 * c.totalUsd                          // 全部能领的美元价值
 * c.positions[0].rewards              // [{ index: 0, symbol: 'RAY', formatted: '0.042698', usd: 0.083 }]
 * ```
 */
export async function claimable(client: SolanaClient, owner: string, query: ClaimQuery = {}): Promise<Claimable> {
  if (!isAddress(owner)) {
    throw new Error(`Invalid owner address: ${owner}`)
  }
  const { signal } = query
  const protocols: ClaimProtocol[] = query.protocols ? [...query.protocols] : ['orca-whirlpool', 'raydium-clmm']
  const list = (
    await lpPositions(client, owner, { protocols, mints: query.mints, rewards: true, now: query.now, signal })
  ).filter((p): p is SolanaLpClmmPosition => p.type === 'clmm')

  const warnings: string[] = []
  const mints = [...new Set(list.flatMap((p) => [p.token0.mint, p.token1.mint, ...(p.rewards ?? []).map((r) => r.mint)]))]
  const source = query.prices === false ? null : query.prices && query.prices !== true ? query.prices : defillamaPrices()
  let priceMap = new Map<string, number>()
  if (source && mints.length) {
    try {
      priceMap = await source.prices({ mints, fetch: query.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args)), signal, client })
    } catch (err) {
      if (signal?.aborted) throw err
      warnings.push(`Price lookup failed (${(err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR)}): usd values are null`)
    }
  }
  const amountOf = (token: { mint: string; symbol: string | null; decimals: number | null }, amount: bigint | null): ClaimableAmount => {
    const formatted = amount === null || token.decimals === null ? null : formatUnits(amount, token.decimals)
    const price = priceMap.get(token.mint)
    // 数量为 0 的不需要价格
    const usd = amount === 0n ? 0 : formatted === null || price === undefined || !source ? null : Number(formatted) * price
    return { mint: token.mint, symbol: token.symbol, decimals: token.decimals, amount: amount === null ? null : amount.toString(), formatted, usd }
  }
  const sum = (items: readonly ClaimableAmount[]) => (items.some((i) => i.usd === null) ? null : items.reduce((acc, i) => acc + (i.usd as number), 0))

  const positions: ClaimablePosition[] = []
  for (const p of list) {
    const fees: [ClaimableAmount, ClaimableAmount] = [amountOf(p.token0, p.fees0 === null ? null : BigInt(p.fees0)), amountOf(p.token1, p.fees1 === null ? null : BigInt(p.fees1))]
    const rewards = (p.rewards ?? []).map((r) => ({ ...amountOf(r, r.amount === null ? null : BigInt(r.amount)), index: r.index }))
    const unknown = [...fees, ...rewards].some((x) => x.amount === null)
    if (!unknown && [...fees, ...rewards].every((x) => x.amount === '0')) continue
    positions.push({
      protocol: p.protocol as ClaimProtocol,
      protocolName: p.protocolName,
      positionMint: p.positionMint,
      position: p.position,
      pool: p.pool,
      token0: p.token0,
      token1: p.token1,
      liquidity: p.liquidity,
      inRange: p.inRange,
      fees,
      rewards,
      feesUsd: sum(fees),
      rewardsUsd: sum(rewards),
      totalUsd: sum([...fees, ...rewards]),
    })
  }
  positions.sort((a, b) => (b.totalUsd ?? -1) - (a.totalUsd ?? -1))
  if (positions.some((p) => [...p.fees, ...p.rewards].some((x) => x.amount === null))) {
    warnings.push("Some positions' tick arrays could not be read: their amounts are null (they are still included)")
  }

  // 按代币汇总
  const byMint = new Map<string, { token: { mint: string; symbol: string | null; decimals: number | null }; amount: bigint; unknown: boolean }>()
  for (const item of positions.flatMap((p) => [...p.fees, ...p.rewards])) {
    const entry = byMint.get(item.mint) ?? { token: item, amount: 0n, unknown: false }
    entry.amount += BigInt(item.amount ?? 0)
    entry.unknown ||= item.amount === null
    byMint.set(item.mint, entry)
  }
  // 有读不到的数量时保留该代币（即使已读到的部分为 0），标记 incomplete，美元价值为 null
  const tokens = [...byMint.values()]
    .filter((e) => e.unknown || e.amount !== 0n)
    .map((e): ClaimableAmount => (e.unknown ? { ...amountOf(e.token, e.amount), usd: null, incomplete: true } : amountOf(e.token, e.amount)))
  const sumKnown = (items: ReadonlyArray<number | null>) => (items.some((x) => x === null) ? null : items.reduce<number>((acc, x) => acc + (x as number), 0))
  return {
    owner,
    positions,
    tokens,
    incomplete: tokens.some((t) => t.incomplete),
    feesUsd: sumKnown(positions.map((p) => p.feesUsd)),
    rewardsUsd: sumKnown(positions.map((p) => p.rewardsUsd)),
    totalUsd: sumKnown(positions.map((p) => p.totalUsd)),
    warnings,
  }
}

// ---------------------------------------------------------------------------
// 构建、模拟、发送
// ---------------------------------------------------------------------------

/** 要领取的仓位：claimable 的结果，或只给协议 + 仓位 NFT 的 mint（getLpPositions 的结果也可以） */
export type ClaimTarget = Pick<ClaimablePosition, 'protocol' | 'positionMint'> & { pool?: string }

export interface BuildClaimOptions extends RequestOptions {
  /** wSOL（池子的一边或奖励）原来没有账户时用完关闭、换回 SOL，默认 true（同 /liquidity） */
  native?: boolean
  /** 同时构建几个仓位（每个要读几次账户），默认 4 */
  concurrency?: number
}

export interface ClaimCall extends PlannedCall {
  protocol: ClaimProtocol
  positionMint: string
  /** /liquidity 的领取计划（预计的手续费、奖励的代币、步骤） */
  plan: SolanaLiquidityPlan
}

export interface ClaimPlan {
  owner: string
  /** 每个仓位一个调用（创建缺少的代币账户 + 领取手续费 + 领取每个奖励，原子执行） */
  calls: ClaimCall[]
  /** 构建失败的仓位：仓位不在 owner 名下、不支持的代币（带转账手续费的 Token-2022 池子）等 */
  failed: Array<{ position: ClaimTarget; error: string }>
}

/**
 * 构建批量领取（只读取、不签名）：每个仓位一个调用，指令来自 /liquidity 的 buildCollectFees，构建时重新读取仓位。
 * 打包成交易由 simulateClaim / claimAll（batchCall）完成
 *
 * ```ts
 * const c = await claimable(client, owner)
 * const plan = await buildClaimAll(client, owner, c.positions)
 * ```
 */
export async function buildClaimAll(client: SolanaClient, owner: string, positions: readonly ClaimTarget[], options: BuildClaimOptions = {}): Promise<ClaimPlan> {
  if (!isAddress(owner)) {
    throw new Error(`Invalid owner address: ${owner}`)
  }
  const unique = [...new Map(positions.map((p) => [p.positionMint, p])).values()]
  const calls: ClaimCall[] = []
  const failed: ClaimPlan['failed'] = []
  const built = await mapPool(unique, options.concurrency ?? 4, async (position) => {
    try {
      const plan = await buildCollectFees(client, owner, { position: { protocol: position.protocol, positionMint: position.positionMint, pool: position.pool } }, { native: options.native, signal: options.signal })
      return { position, plan, error: null }
    } catch (err) {
      if (options.signal?.aborted) throw err
      return { position, plan: null, error: (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR) }
    }
  })
  for (const item of built) {
    if (item.plan === null) {
      failed.push({ position: item.position, error: item.error })
    } else {
      calls.push({ owner, protocol: item.position.protocol as ClaimProtocol, positionMint: item.position.positionMint, plan: item.plan, instructions: item.plan.steps.flatMap((s) => s.instructions) })
    }
  }
  return { owner, calls, failed }
}

export interface ClaimSimulation extends PlanSimulation {
  /** 模拟里收到的代币合计（手续费支付者 / owner 的余额变化，按资产汇总；SOL 为 'native'） */
  received: Array<{ asset: string; symbol: string; decimals: number; delta: string; formatted: string; usd?: number | null }>
}

/** 用 /simulate 模拟构建好的批量领取（不签名、不发送）：逐笔交易的结果、哪些仓位会失败、收到的代币合计 */
export async function simulateClaim(client: SolanaClient, plan: ClaimPlan, options: Omit<PlanSimulationOptions, 'watch'> = {}): Promise<ClaimSimulation> {
  const sim = await simulatePlan(client, plan.calls, options)
  const totals = new Map<string, { change: SimulatedBalanceChange; delta: bigint; usd: number | null | undefined }>()
  const payer = options.feePayer ?? plan.owner
  for (const { simulation } of sim.transactions) {
    for (const change of simulation.balanceChanges) {
      if (change.address !== payer && change.address !== plan.owner) continue
      const entry = totals.get(change.asset) ?? { change, delta: 0n, usd: undefined }
      entry.delta += BigInt(change.delta)
      // 美元价值是所有变化的合计（任何一笔没有价格就是 null）；都没有 usd 字段时不给
      if (change.usd !== undefined) entry.usd = entry.usd === null || change.usd === null ? null : (entry.usd ?? 0) + change.usd
      totals.set(change.asset, entry)
    }
  }
  const received = [...totals.values()]
    .filter((e) => e.delta !== 0n)
    .map((e) => ({
      asset: e.change.asset,
      symbol: e.change.symbol,
      decimals: e.change.decimals,
      delta: e.delta.toString(),
      formatted: `${e.delta < 0n ? '-' : ''}${formatUnits(e.delta < 0n ? -e.delta : e.delta, e.change.decimals)}`,
      ...(e.usd !== undefined ? { usd: e.usd } : {}),
    }))
  return { ...sim, received }
}

export interface ClaimOptions extends BatchCallOptions, BuildClaimOptions {
  /** 发送前先用 /simulate 模拟，模拟失败的仓位不发送，默认 true */
  simulate?: boolean
  /** 只领取预计价值不低于它的仓位（美元）；没有价格的仓位照常领取。默认 0 */
  minUsd?: number
}

export interface ClaimCallResult extends WriteResult {
  protocol: ClaimProtocol
  positionMint: string
}

export interface ClaimResult {
  plan: ClaimPlan
  /** 发送前的模拟（simulate: false 时为 null） */
  simulation: ClaimSimulation | null
  /** 与 plan.calls 一一对应；dryRun 时 status 为 'simulated' / 'failed'，没有签名 */
  results: ClaimCallResult[]
}

/**
 * 批量领取：构建 → 模拟 → 用 from 签名发送（钱包同 /write 的 batchCall，多个仓位打包进同一笔交易，feePayer 可以替 owner 付手续费）。
 * positions 不传时先预览、领取全部有东西可领的仓位；一个仓位失败不影响其他的。dryRun: true 只构建和模拟（不签名，from 只用来取地址）
 *
 * ```ts
 * await claimAll(client, key)                                          // 全部
 * await claimAll(client, key, c.positions.slice(0, 5), { dryRun: true })
 * ```
 */
export async function claimAll(client: SolanaClient, from: SignerInput, positions?: readonly (ClaimTarget & Partial<Pick<ClaimablePosition, 'totalUsd'>>)[], options: ClaimOptions = {}): Promise<ClaimResult> {
  const { resolveSigner } = await import('./write/signer.js')
  const owner = (await resolveSigner(from)).address
  const minUsd = options.minUsd ?? 0
  const targets = (positions ?? (await claimable(client, owner, { signal: options.signal })).positions).filter((p) => p.totalUsd === undefined || p.totalUsd === null || p.totalUsd >= minUsd)
  const plan = await buildClaimAll(client, owner, targets, options)
  const feePayer = options.feePayer === undefined ? undefined : (await resolveSigner(options.feePayer)).address
  const simulation = options.simulate === false && !options.dryRun ? null : await simulateClaim(client, plan, { feePayer, signal: options.signal, batchSize: (options.mode ?? 'pack') === 'tx' ? 1 : options.batchSize })
  const failed = new Map(simulation?.failed.map((f) => [f.index, f.error]))
  const sent = options.dryRun ? [] : await sendCalls(client, from, plan.calls.filter((_, i) => !failed.has(i)), options)
  let next = 0
  const results = plan.calls.map((call, index): ClaimCallResult => {
    const base = { protocol: call.protocol, positionMint: call.positionMint }
    const error = failed.get(index)
    if (error !== undefined) return { index, from: owner, status: 'failed', signature: null, slot: null, fee: null, computeUnits: null, error, ...base }
    if (options.dryRun) return { index, from: owner, status: 'simulated', signature: null, slot: null, fee: null, computeUnits: null, error: null, ...base }
    return { ...(sent[next++] as WriteResult), index, ...base }
  })
  return { plan, simulation, results }
}
