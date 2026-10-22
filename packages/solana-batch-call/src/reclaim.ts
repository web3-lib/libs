/**
 * 账户回收（子路径 `@w3lib/solana-batch-call/reclaim`）：扫描钱包里关闭后能退回租金（SOL）的账户，给出每项和合计能拿回多少 lamports，批量关闭。
 *
 * - 空的代币账户（SPL Token / Token-2022，有暂存转账手续费的先收到 mint 上）；冻结的、关闭权限是别人的关不掉，单独列出
 * - 垃圾币：有余额但没有价格 / 价值很小 / 垃圾特征（可疑名字、不可转让等）的代币，先销毁再关闭账户（一个账户的指令原子执行）。
 *   默认只自动勾选有把握的（见 `selected`）：有价格且价值超过 `maxJunkUsd` 的、NFT、仓位 NFT 一律不当垃圾币
 * - Wrapped SOL 账户：关闭 = 解包，余额和租金一起退回
 * - 已清空的集中流动性仓位（Orca Whirlpool、Raydium CLMM：流动性、手续费、奖励都是 0）：关闭仓位账户并销毁 NFT。还有没领的手续费 / 奖励时列在 blocked，先用 /claim 领取
 */
import { decodeAddress, findProgramAddress, isAddress } from './address.js'
import type { RequestOptions, SolanaClient } from './client.js'
import { TOKEN_2022_PROGRAM_ID } from './constants.js'
import { approvals, parseTokenAccountState, type TokenAccountApproval } from './approvals.js'
import { ORCA_WHIRLPOOL_PROGRAM_ID, RAYDIUM_CLMM_PROGRAM_ID, parseClmmPosition, utf8 } from './lp.js'
import { orcaClosePosition } from './liquidity/orca.js'
import { raydiumClosePosition } from './liquidity/raydiumClmm.js'
import { defillamaPrices, type SolanaPriceSource } from './price.js'
import { tokenRisks, type SolanaTokenRisk } from './risk.js'
import { simulatePlan, sendCalls, type PlanSimulation, type PlanSimulationOptions, type PlannedCall } from './batchPlan.js'
import type { BatchCallOptions } from './write/batch.js'
import { burnChecked, closeAccount, harvestWithheldTokensToMint } from './write/instructions.js'
import type { SignerInput } from './write/signer.js'
import type { WriteResult } from './write/send.js'

export type ReclaimKind = 'empty-token' | 'junk-token' | 'wrapped-sol' | 'orca-position' | 'raydium-position'

/**
 * 关不掉的原因：frozen 账户被冻结；close-authority 关闭权限是别的地址；confidential-balance Token-2022 机密余额不为 0；
 * paused / permissioned-burn 代币暂停了 / 只有指定的地址能销毁（垃圾币销毁不了）；owed 仓位还有没领的手续费 / 奖励（先领取）
 */
export type ReclaimBlocker = 'frozen' | 'close-authority' | 'confidential-balance' | 'paused' | 'permissioned-burn' | 'owed'

/** 能回收租金的一项（字段都是字符串 / 数字 / 布尔 / null，可以直接 JSON.stringify） */
export interface ReclaimItem {
  kind: ReclaimKind
  /** 要关闭的代币账户（仓位是持有仓位 NFT 的代币账户） */
  account: string
  /** 账户的 owner（签名者） */
  owner: string
  /** 代币的 mint（仓位是 NFT 的 mint） */
  mint: string
  tokenProgram: string
  symbol: string | null
  decimals: number | null
  /** 账户里的余额（最小单位）：垃圾币会被销毁，Wrapped SOL 会解包成 SOL */
  amount: string
  formatted: string | null
  /** 余额的美元价值（查到价格时；没有价格为 null） */
  usd: number | null
  /** Token-2022 账户里暂存的转账手续费：不为 0 时关闭前先收到 mint 上（自动处理） */
  withheldAmount: string
  /** 预计退回的 lamports：账户里的全部（Wrapped SOL 含余额；仓位是仓位账户 + NFT 账户 + Token-2022 NFT 一并关闭的 mint），十进制字符串；以模拟的结果为准 */
  lamports: string
  /** 其中的租金（Wrapped SOL 不含包装的余额） */
  rentLamports: string
  /** 建议勾选：空账户、Wrapped SOL、空仓位总是 true；垃圾币只有“有把握”的才是 true（价格查询正常，且有价格但价值不超过 maxJunkUsd、/risk 有垃圾风险标记、或 isJunk 返回 true；光是名字可疑不够） */
  selected: boolean
  /** 判断依据：dust / no-price / spam-name / risk:<flag> / custom / empty-position / unwrap / … */
  reasons: string[]
  /** 仓位：协议、仓位账户和池子 */
  position?: { protocol: 'orca-whirlpool' | 'raydium-clmm'; positionMint: string; position: string; pool: string }
  /** 只在 blocked 里：关不掉的原因 */
  blocker?: ReclaimBlocker
}

export interface Reclaimable {
  owner: string
  /** 能回收的 */
  items: ReclaimItem[]
  /** 暂时关不掉的（带 blocker）：冻结的、关闭权限是别人的、还有没领的手续费的仓位等 */
  blocked: ReclaimItem[]
  /** items 的 lamports 之和 */
  totalLamports: string
  /** items 里 selected 的 lamports 之和 */
  selectedLamports: string
  /** 每种的数量和 lamports（只含 items） */
  byKind: Partial<Record<ReclaimKind, { count: number; lamports: string }>>
  /** 提示（价格服务出错时垃圾币不自动勾选等） */
  warnings: string[]
}

/** isJunk 回调收到的信息 */
export interface JunkContext {
  account: TokenAccountApproval
  /** 美元价格；没有时为 null */
  price: number | null
  /** 余额的美元价值；没有价格时为 null */
  usd: number | null
  /** /risk 的检查结果（risk 选项关闭或读不到时为 null） */
  risk: SolanaTokenRisk | null
}

export interface ReclaimQuery extends RequestOptions {
  /** 只看这些 mint 的关联代币账户（免费公共节点也能用）；不传时列出全部代币账户（getTokenAccountsByOwner，需要支持它的节点） */
  mints?: readonly string[]
  /** 找垃圾币（有余额的代币），默认 true；false 只找空账户、Wrapped SOL 和空仓位 */
  junk?: boolean
  /** 找已清空的集中流动性仓位，默认 true */
  positions?: boolean
  /** 价格：true（默认）用 DefiLlama；false 不查（这时垃圾币都不自动勾选）；也可以传自己的价格源（如 combinePrices([defillamaPrices(), onchainPrices()])） */
  prices?: boolean | SolanaPriceSource
  /** 有价格且价值不超过它的代币算“尘埃”（美元，默认 0.01）；超过它的代币不会当垃圾币（isJunk 明确返回 true 的除外） */
  maxJunkUsd?: number
  /** 查垃圾特征用 /risk（不可转让、转账手续费很高、已暂停等），默认 true */
  risk?: boolean
  /**
   * 自己判断哪些是垃圾币：返回 true 一定算垃圾币并勾选（NFT 和仓位 NFT 除外），false 一定不算，undefined 用默认判断。
   * 例如白名单：`({ account }) => (mine.has(account.mint) ? false : undefined)`
   */
  isJunk?: (context: JunkContext) => boolean | undefined
  fetch?: typeof fetch
}

/** 垃圾特征里足以自动勾选的风险标记（只有这些：legit 的 RWA / 稳定币常有 permanent-delegate、transfer-hook，不能据此判断） */
const JUNK_RISK_FLAGS = ['non-transferable', 'high-transfer-fee', 'paused']
/** 垃圾币常见的名字：链接 / 域名、领奖广告。只作提示（reasons 里的 spam-name），不会让代币被自动勾选 */
const SPAM_SYMBOL = /https?:|www\.|\.(com|io|xyz|net|org|app|cc|vip|top|site|fun|live|me)\b|t\.me|claim|airdrop|visit|voucher|\$\d/i

const NFT_DECIMALS = 0
const ownedBy = (a: TokenAccountApproval, owner: string) => a.owner === owner

/** 能关闭的限制：冻结、关闭权限是别人、机密余额。没有时返回 undefined */
function closeBlock(a: TokenAccountApproval): ReclaimBlocker | undefined {
  if (a.frozen) return 'frozen'
  if (a.closeBlocker === 'close-authority') return 'close-authority'
  if (a.closeBlocker === 'confidential-balance') return 'confidential-balance'
  return undefined
}

const positionPda = (program: string, mint: string) => findProgramAddress([utf8('position'), decodeAddress(mint)], program)

function tokenItem(a: TokenAccountApproval, kind: ReclaimKind, extra: { selected: boolean; reasons: string[]; usd: number | null; blocker?: ReclaimBlocker }): ReclaimItem {
  const lamports = BigInt(a.lamports)
  return {
    kind,
    account: a.account,
    owner: a.owner,
    mint: a.mint,
    tokenProgram: a.tokenProgram,
    symbol: a.symbol,
    decimals: a.decimals,
    amount: a.amount,
    formatted: a.formatted,
    usd: extra.usd,
    withheldAmount: a.withheldAmount,
    lamports: lamports.toString(),
    rentLamports: (a.native ? lamports - BigInt(a.amount) : lamports).toString(),
    selected: extra.selected,
    reasons: extra.reasons,
    ...(extra.blocker ? { blocker: extra.blocker } : {}),
  }
}

/**
 * 扫描钱包里能回收租金的账户（只读取）。需要列出全部代币账户（getTokenAccountsByOwner），免费公共节点不支持时传 `mints` 只看指定代币的 ATA。
 *
 * ```ts
 * const r = await reclaimable(client, owner)
 * r.totalLamports                                  // 全部能拿回的 lamports
 * r.items.filter((i) => i.selected)                // 建议勾选的
 * ```
 */
export async function reclaimable(client: SolanaClient, owner: string, query: ReclaimQuery = {}): Promise<Reclaimable> {
  if (!isAddress(owner)) {
    throw new Error(`Invalid owner address: ${owner}`)
  }
  const { signal } = query
  const maxJunkUsd = query.maxJunkUsd ?? 0.01
  if (!(maxJunkUsd >= 0)) {
    throw new RangeError(`maxJunkUsd must be >= 0: ${maxJunkUsd}`)
  }
  const accounts = (await approvals(client, owner, { mints: query.mints, all: true, signal })).filter((a) => ownedBy(a, owner))
  const items: ReclaimItem[] = []
  const blocked: ReclaimItem[] = []
  const warnings: string[] = []
  const push = (item: ReclaimItem, blocker?: ReclaimBlocker) => (blocker ? blocked.push({ ...item, blocker }) : items.push(item))

  const nft = (a: TokenAccountApproval) => a.decimals === NFT_DECIMALS && a.amount === '1' && !a.native
  const rest: TokenAccountApproval[] = []
  for (const a of accounts) {
    const blocker = closeBlock(a)
    if (a.native) {
      // Wrapped SOL：空的算空账户，有余额的关闭即解包
      const empty = BigInt(a.amount) === 0n
      push(tokenItem(a, empty ? 'empty-token' : 'wrapped-sol', { selected: true, reasons: [empty ? 'empty' : 'unwrap'], usd: null }), blocker)
    } else if (BigInt(a.amount) === 0n) {
      push(tokenItem(a, 'empty-token', { selected: true, reasons: ['empty'], usd: null }), blocker)
    } else if (!nft(a)) {
      rest.push(a)
    }
  }

  if (query.positions ?? true) {
    await scanPositions(client, accounts.filter(nft), push, signal)
  }
  if ((query.junk ?? true) && rest.length) {
    await scanJunk(client, rest, query, maxJunkUsd, push, warnings)
  }

  const byKind: Reclaimable['byKind'] = {}
  let total = 0n
  let selected = 0n
  for (const item of items) {
    const entry = byKind[item.kind] ?? { count: 0, lamports: '0' }
    byKind[item.kind] = { count: entry.count + 1, lamports: (BigInt(entry.lamports) + BigInt(item.lamports)).toString() }
    total += BigInt(item.lamports)
    if (item.selected) selected += BigInt(item.lamports)
  }
  return { owner, items, blocked, totalLamports: total.toString(), selectedLamports: selected.toString(), byKind, warnings }
}

/** 仓位 NFT（精度 0、余额 1）：Orca / Raydium CLMM 的仓位账户一次读出，清空了的列出来 */
async function scanPositions(client: SolanaClient, nfts: readonly TokenAccountApproval[], push: (item: ReclaimItem, blocker?: ReclaimBlocker) => void, signal: AbortSignal | undefined): Promise<void> {
  if (!nfts.length) return
  const protocols = [
    { protocol: 'orca-whirlpool' as const, program: ORCA_WHIRLPOOL_PROGRAM_ID, kind: 'orca-position' as const },
    { protocol: 'raydium-clmm' as const, program: RAYDIUM_CLMM_PROGRAM_ID, kind: 'raydium-position' as const },
  ]
  const addresses = nfts.flatMap((a) => [...protocols.map((p) => positionPda(p.program, a.mint)), a.mint])
  const read = await client.accounts(addresses, { signal })
  nfts.forEach((a, i) => {
    const base = i * (protocols.length + 1)
    const mintAccount = read[base + protocols.length]
    protocols.forEach((p, j) => {
      const address = addresses[base + j] as string
      const account = read[base + j]
      const state = account ? parseClmmPosition(p.protocol, address, account) : null
      if (!state || !account || state.mint !== a.mint || state.liquidity > 0n) return
      // 仓位 NFT 是 Token-2022（带元数据扩展）时两个程序都连 mint 一起关闭；SPL Token 的 NFT mint 留着（主网模拟核对过）
      const closesMint = a.tokenProgram === TOKEN_2022_PROGRAM_ID
      const rent = account.lamports + BigInt(a.lamports) + (closesMint && mintAccount ? mintAccount.lamports : 0n)
      const owed = state.owed0 > 0n || state.owed1 > 0n || state.rewards.some((r) => r.owed > 0n)
      const item: ReclaimItem = {
        ...tokenItem(a, p.kind, { selected: true, reasons: [owed ? 'owed' : 'empty-position'], usd: null }),
        lamports: rent.toString(),
        rentLamports: rent.toString(),
        position: { protocol: p.protocol, positionMint: a.mint, position: address, pool: state.pool },
      }
      push(item, closeBlock(a) ?? (owed ? 'owed' : undefined))
    })
  })
}

/** 有余额的代币：查价格和风险，按保守的规则判断哪些是垃圾币 */
async function scanJunk(
  client: SolanaClient,
  list: readonly TokenAccountApproval[],
  query: ReclaimQuery,
  maxJunkUsd: number,
  push: (item: ReclaimItem, blocker?: ReclaimBlocker) => void,
  warnings: string[],
): Promise<void> {
  const { signal } = query
  const mints = [...new Set(list.map((a) => a.mint))]
  const source = query.prices === false ? null : query.prices && query.prices !== true ? query.prices : defillamaPrices()
  // 价格没查到（关闭 / 服务出错）时不知道哪些值钱：不自动勾选任何垃圾币
  let pricesOk = source !== null
  let priceMap = new Map<string, number>()
  if (source) {
    try {
      const fetchFn = query.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
      priceMap = await source.prices({ mints, fetch: fetchFn, signal, client })
    } catch (err) {
      if (signal?.aborted) throw err
      pricesOk = false
      warnings.push(`Price lookup failed (${err instanceof Error ? err.message : String(err)}): junk tokens are not auto-selected`)
    }
  } else {
    warnings.push('Prices are off: junk tokens are not auto-selected')
  }
  const risks = new Map<string, SolanaTokenRisk>()
  if (query.risk ?? true) {
    try {
      const found = await tokenRisks(client, mints, { signal })
      found.forEach((r, i) => risks.set(mints[i] as string, r))
    } catch (err) {
      if (signal?.aborted) throw err
      warnings.push(`Risk check failed (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  for (const a of list) {
    const price = priceMap.get(a.mint) ?? null
    const usd = price !== null && a.formatted !== null ? Number(a.formatted) * price : null
    const risk = risks.get(a.mint) ?? null
    const custom = query.isJunk?.({ account: a, price, usd, risk })
    const valuable = usd !== null && usd > maxJunkUsd
    if (custom === false || (valuable && custom !== true)) continue
    const reasons: string[] = []
    let sure = false
    if (custom === true) {
      reasons.push('custom')
      sure = true
    } else {
      if (usd !== null) {
        reasons.push('dust')
        sure = true
      } else {
        reasons.push('no-price')
      }
      if (a.symbol && (SPAM_SYMBOL.test(a.symbol) || a.symbol.length > 24)) {
        reasons.push('spam-name') // 只是提示：名字不能单独作为销毁的依据
      }
      for (const flag of risk?.flags ?? []) {
        if (JUNK_RISK_FLAGS.includes(flag)) {
          reasons.push(`risk:${flag}`)
          sure = true
        }
      }
      sure &&= pricesOk
    }
    // 销毁不了的：暂停了、只有指定地址能销毁
    const blocker = closeBlock(a) ?? (risk?.pausable?.paused ? 'paused' : risk?.burnAuthority ? 'permissioned-burn' : undefined)
    if (blocker && !sure) continue // 不确定是垃圾币又关不掉的不列
    push(tokenItem(a, 'junk-token', { selected: sure, reasons, usd }), blocker)
  }
}

// ---------------------------------------------------------------------------
// 构建、模拟、发送
// ---------------------------------------------------------------------------

/** 一个账户要执行的指令（作为一个调用，原子执行） */
export interface ReclaimCall extends PlannedCall {
  kind: ReclaimKind
  account: string
  item: ReclaimItem
}

export interface BuildReclaimOptions extends RequestOptions {
  /** 退回的 SOL 给谁，默认 owner。Raydium CLMM 的仓位账户租金程序固定退给 owner（不能指定），这时 destination 对它们无效并给出警告 */
  destination?: string
}

export interface ReclaimPlan {
  owner: string
  destination: string
  calls: ReclaimCall[]
  /** 重新读取后发现状态变了、没有构建的（余额变了、有人转入了代币、仓位有新的手续费等）：每项给出原因 */
  skipped: Array<{ item: ReclaimItem; reason: string }>
  /** 预计退回的 lamports 之和（按重新读到的账户），十进制字符串 */
  lamports: string
  warnings: string[]
}

/**
 * 构建回收的指令（只读取、不签名）：发送前重新读取每个账户的当前状态再核对（owner、mint、余额、冻结、关闭权限、仓位是否清空），
 * 状态变了的不构建、列在 skipped。每个账户一个调用（垃圾币：销毁 → 收暂存手续费 → 关闭，原子执行）。
 * 绝不关闭有余额的账户：空账户余额不为 0 时跳过；垃圾币只销毁和列表里一致的余额（有人又转入了就跳过）；只有 Wrapped SOL 带余额关闭（解包）
 *
 * ```ts
 * const r = await reclaimable(client, owner)
 * const plan = await buildReclaim(client, owner, r.items.filter((i) => i.selected))
 * ```
 */
export async function buildReclaim(client: SolanaClient, owner: string, items: readonly ReclaimItem[], options: BuildReclaimOptions = {}): Promise<ReclaimPlan> {
  if (!isAddress(owner)) {
    throw new Error(`Invalid owner address: ${owner}`)
  }
  const destination = options.destination ?? owner
  if (!isAddress(destination)) {
    throw new Error(`Invalid destination: ${destination}`)
  }
  const seen = new Set<string>()
  const list: ReclaimItem[] = []
  for (const item of items) {
    if (item.owner !== owner) {
      throw new Error(`Account ${item.account} belongs to ${item.owner}, not ${owner}`)
    }
    if (item.blocker) {
      throw new Error(`Account ${item.account} cannot be reclaimed yet (${item.blocker})`)
    }
    if (!seen.has(item.account)) {
      seen.add(item.account)
      list.push(item)
    }
  }
  const addresses = list.flatMap((i) => (i.position ? [i.account, i.position.position] : [i.account]))
  const read = addresses.length ? await client.accounts(addresses, { signal: options.signal }) : []
  const at = new Map(addresses.map((a, i) => [a, read[i] ?? null]))

  const calls: ReclaimCall[] = []
  const skipped: ReclaimPlan['skipped'] = []
  const warnings: string[] = []
  let lamports = 0n
  for (const item of list) {
    const skip = (reason: string) => skipped.push({ item, reason })
    const account = at.get(item.account)
    const state = account && account.owner === item.tokenProgram ? parseTokenAccountState(account.data) : null
    if (!account || !state) {
      skip('account not found (already closed?)')
      continue
    }
    if (state.owner !== owner || state.mint !== item.mint) {
      skip('account owner or mint changed')
      continue
    }
    if (state.frozen) {
      skip('account is frozen')
      continue
    }
    if (state.closeAuthority !== null && state.closeAuthority !== owner) {
      skip('another address holds the close authority')
      continue
    }
    if (state.confidentialBalance) {
      skip('confidential balance is not zero')
      continue
    }
    const instructions = []
    let expected = account.lamports
    if (item.kind === 'orca-position' || item.kind === 'raydium-position') {
      const position = item.position
      const raw = position ? at.get(position.position) : null
      const parsed = position && raw ? parseClmmPosition(position.protocol, position.position, raw) : null
      if (!position || !parsed || parsed.mint !== item.mint) {
        skip('position account not found')
        continue
      }
      if (state.amount !== 1n) {
        skip('the position NFT is not in this account')
        continue
      }
      if (parsed.liquidity > 0n || parsed.owed0 > 0n || parsed.owed1 > 0n || parsed.rewards.some((r) => r.owed > 0n)) {
        skip('position is not empty (has liquidity or unclaimed fees / rewards)')
        continue
      }
      if (item.kind === 'orca-position') {
        instructions.push(orcaClosePosition(owner, destination, item.mint, item.tokenProgram, item.account))
      } else {
        instructions.push(raydiumClosePosition(owner, item.mint, item.tokenProgram, position.pool, item.account))
        if (destination !== owner && !warnings.some((w) => w.startsWith('Raydium CLMM'))) {
          warnings.push('Raydium CLMM position rent is always returned to the owner, not to the destination')
        }
      }
      expected = BigInt(item.lamports)
    } else {
      if (item.kind === 'junk-token') {
        if (state.native || state.amount === 0n || state.amount.toString() !== item.amount) {
          skip('balance changed since the scan')
          continue
        }
        if (item.decimals === null || (item.decimals === NFT_DECIMALS && state.amount === 1n)) {
          skip('NFTs and tokens with unknown decimals are never burned')
          continue
        }
        instructions.push(burnChecked(item.account, item.mint, owner, state.amount, item.decimals, item.tokenProgram))
      } else if (item.kind === 'empty-token') {
        if (state.amount !== 0n) {
          skip('account is not empty anymore')
          continue
        }
      } else if (item.kind === 'wrapped-sol') {
        if (!state.native) {
          skip('not a Wrapped SOL account anymore')
          continue
        }
      }
      if (item.tokenProgram === TOKEN_2022_PROGRAM_ID && state.withheldAmount > 0n) {
        instructions.push(harvestWithheldTokensToMint(item.mint, [item.account]))
      }
      instructions.push(closeAccount(item.account, destination, owner, item.tokenProgram))
    }
    lamports += expected
    calls.push({ kind: item.kind, account: item.account, owner, instructions, item })
  }
  return { owner, destination, calls, skipped, lamports: lamports.toString(), warnings }
}

export interface ReclaimSimulationOptions extends Omit<PlanSimulationOptions, 'watch'> {}

export interface ReclaimSimulation extends PlanSimulation {
  /**
   * 预计退回 destination 的 lamports（不含手续费）。destination 就是手续费支付者时取模拟里它的 SOL 变化（lamportsSource 为 'simulation'，最准）；
   * 否则 /simulate 看不到收款地址的 SOL，按构建时读到的账户余额估算（'estimate'）
   */
  lamports: string
  lamportsSource: 'simulation' | 'estimate'
}

/**
 * 用 /simulate 模拟构建好的回收（不签名、不发送）：逐笔交易的结果、哪些调用会失败、手续费、预计退回的 SOL
 *
 * ```ts
 * const sim = await simulateReclaim(client, plan)
 * if (!sim.success) console.log(sim.failed)          // [{ index, error }]
 * sim.lamports                                       // 预计拿回的 lamports
 * ```
 */
export async function simulateReclaim(client: SolanaClient, plan: ReclaimPlan, options: ReclaimSimulationOptions = {}): Promise<ReclaimSimulation> {
  const sim = await simulatePlan(client, plan.calls, { ...options, watch: [plan.destination] })
  const payer = options.feePayer ?? plan.owner
  const exact = payer === plan.destination && sim.success
  return { ...sim, lamports: exact ? sim.payerNativeDelta : plan.lamports, lamportsSource: exact ? 'simulation' : 'estimate' }
}

export interface ReclaimOptions extends BatchCallOptions, BuildReclaimOptions {
  /** 发送前先用 /simulate 模拟，模拟失败的调用不发送，默认 true */
  simulate?: boolean
}

export interface ReclaimCallResult extends WriteResult {
  kind: ReclaimKind
  account: string
  item: ReclaimItem
}

export interface ReclaimResult {
  plan: ReclaimPlan
  /** 发送前的模拟（simulate: false 时为 null） */
  simulation: ReclaimSimulation | null
  /** 与 plan.calls 一一对应；dryRun 时 status 为 'simulated' / 'failed'，没有签名 */
  results: ReclaimCallResult[]
}

/**
 * 回收：构建（重新读取账户并核对）→ 模拟 → 用 from 签名发送（钱包同 /write 的 batchCall，多个账户打包进同一笔交易，feePayer 可以替 owner 付手续费）。
 * 一个账户失败不影响其他的。dryRun: true 只构建和模拟（不签名，from 只用来取地址）
 *
 * ```ts
 * const r = await reclaimable(client, owner)
 * const { simulation, results } = await reclaim(client, key, r.items.filter((i) => i.selected), { destination: cold })
 * ```
 */
export async function reclaim(client: SolanaClient, from: SignerInput, items: readonly ReclaimItem[], options: ReclaimOptions = {}): Promise<ReclaimResult> {
  const { resolveSigner } = await import('./write/signer.js')
  const owner = (await resolveSigner(from)).address
  const plan = await buildReclaim(client, owner, items, options)
  const feePayer = options.feePayer === undefined ? undefined : (await resolveSigner(options.feePayer)).address
  const simulation = options.simulate === false && !options.dryRun ? null : await simulateReclaim(client, plan, { feePayer, signal: options.signal, batchSize: (options.mode ?? 'pack') === 'tx' ? 1 : options.batchSize })
  const failed = new Map(simulation?.failed.map((f) => [f.index, f.error]))
  const results: ReclaimCallResult[] = []
  const toSend = plan.calls.filter((_, i) => !failed.has(i))
  const sent = options.dryRun ? [] : await sendCalls(client, from, toSend, options)
  let next = 0
  plan.calls.forEach((call, index) => {
    const base = { kind: call.kind, account: call.account, item: call.item }
    const error = failed.get(index)
    if (error !== undefined) {
      results.push({ index, from: owner, status: 'failed', signature: null, slot: null, fee: null, computeUnits: null, error, ...base })
    } else if (options.dryRun) {
      results.push({ index, from: owner, status: 'simulated', signature: null, slot: null, fee: null, computeUnits: null, error: null, ...base })
    } else {
      results.push({ ...(sent[next++] as WriteResult), index, ...base })
    }
  })
  return { plan, simulation, results }
}
