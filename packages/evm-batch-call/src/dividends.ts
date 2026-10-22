/**
 * Flap（flap.sh，BNB Chain 发币平台）的分红：持有带分红的 Flap 税收代币（FlapTaxToken）的地址按持仓比例分到税收，
 * 分红放在每个代币自己的 Dividend 合约里，持有人（或任何人替持有人）调用 withdrawDividendsFor 领取。
 *
 * 核实过的合约（BSC 主网，2026-10 在主网分叉上实测）：
 * - 代币：`dividendContract()` 返回它的 Dividend 合约（Tax Token V3 总是部署；V2 只在 dividendBps > 0 时部署）
 * - Dividend 合约（EIP-1167 克隆，实现 0xd67447C2…5905，Sourcify / BscScan 上未验证源码，函数靠官方文档 + 链上调用核对）：
 *   `dividendToken()`、`weth()`、`minimumShareBalance()`、`withdrawableDividends(address)`、`withdrawnDividends(address)`、
 *   `withdrawDividendsFor(address)`（任何人可调，款项直接到持有人）
 * - 官方 TaxTokenHelper（0x53841c73…8346）的 `getDividendInfo(token, user) → (claimed, pending)` 与上面两个函数结果一致（测试里交叉核对）
 *
 * 只有一种合约形态，所以只有一个适配器（flap）；识别不了的代币（没有 dividendContract() 或 Dividend 合约缺函数）放进 unsupported，
 * 不猜函数。
 */
import { Interface, getAddress } from 'ethers'

import { NATIVE_TOKEN, formatUnits } from './erc20.js'
import type { Provider } from './provider.js'
import { runLogScan, type LogScanProgress } from './scan.js'
import type { PriceSource } from './price.js'
import { isTronChain } from './tron.js'
import type { BatchCallOptions } from './write/batch.js'
import type { WriteResult } from './write/send.js'
import type { SignerInput } from './write/signer.js'

/** 支持的链：目前只有 BSC（Flap 在 Base、X Layer 等链上也有部署，但没有核实过，不开放） */
export const FLAP_DIVIDEND_CHAINS: Readonly<Record<number, { portal: string; taxTokenHelper: string; swapRegistry: string }>> = {
  56: {
    portal: '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0',
    taxTokenHelper: '0x53841c73217735F37BC1775538b03b23feFD8346',
    swapRegistry: '0x644A8f560138418bAD4EdEFC7c17878a3c2fBEB6',
  },
}

/** Flap 代币地址的靓号后缀（Portal 创建时用）：税收代币是 7777，普通代币是 8888（实测也有 8888 的代币带分红合约）；发现持仓时只收这类地址 */
export const FLAP_TOKEN_SUFFIXES: readonly string[] = ['7777', '8888']

const TOKEN_ABI = [
  'function dividendContract() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]
const DIVIDEND_ABI = [
  'function dividendToken() view returns (address)',
  'function weth() view returns (address)',
  'function minimumShareBalance() view returns (uint256)',
  'function withdrawableDividends(address) view returns (uint256)',
  'function withdrawnDividends(address) view returns (uint256)',
]
const ERC20_META_ABI = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)']
const claimInterface = new Interface(['function withdrawDividendsFor(address user)'])
const ZERO = '0x0000000000000000000000000000000000000000'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** 一次最多检查的代币数（防止传入或发现的列表无限大） */
const MAX_TOKENS = 200

export interface DividendItem {
  /** 持有人 */
  owner: string
  /** 带分红的 Flap 代币 */
  token: string
  symbol: string | null
  decimals: number
  /** 持有人当前的代币余额（可以是 0：卖掉后之前累计的分红仍可领取） */
  balance: string
  /** 这个代币的 Dividend 合约（领取的目标） */
  dividendContract: string
  /** Dividend 合约里配置的分红代币地址（WBNB 也是这个地址） */
  dividendToken: string
  /** 实际收到的资产：'native'（分红代币是 WBNB 时领取会解包成 BNB）或分红代币地址 */
  asset: 'native' | string
  assetSymbol: string | null
  assetDecimals: number
  /** 分红资产的 decimals 读不到（节点出错等）：assetDecimals 按 18 估，claimableFormatted 可能不准，usd 固定为 null */
  decimalsUnknown?: boolean
  /** 当前可领取的数量（asset 的最小单位），领取时就是收到的数量 */
  claimable: string
  claimableFormatted: string
  /** 已经领取过的累计数量 */
  claimed: string
  claimedFormatted: string
  /** 可领取部分的美元价值；没开价格或没有价格时为 null */
  usd: number | null
  /** 持有人要持有至少这么多代币才会继续累计新的分红（已累计的不受影响） */
  minimumShareBalance: string
  /** 当前余额是否达到 minimumShareBalance（false 时新的分红不再累计，但 claimable 仍可领取） */
  accruing: boolean
  /** 适配器名称 */
  adapter: 'flap'
}

export interface DividendUnsupported {
  token: string
  reason: string
}

export interface DividendScanOptions {
  /** 收哪些后缀的代币地址，默认 FLAP_TOKEN_SUFFIXES */
  suffixes?: readonly string[]
  /** 起点区块（含）；不传时往回扫 lookbackBlocks 个区块 */
  fromBlock?: number
  /** 不传 fromBlock 时往回扫多少个区块，默认 5000 */
  lookbackBlocks?: number
  /** 上次的进度（结果的 scan.progress），传了就接着扫 */
  progress?: LogScanProgress
  /** 单次 getLogs 的最大区块范围，默认 1000；节点有上限时自动缩小 */
  blockRange?: number
  /** 这次最多发多少个 getLogs，默认 10 */
  maxRequests?: number
  /** 这次最多花多少毫秒，默认 10000 */
  timeBudget?: number
  signal?: AbortSignal
}

export interface DividendsOptions {
  /** 要检查的代币（Flap 代币地址）。可以和 discover 一起用 */
  tokens?: readonly string[]
  /** 从持有人收到过的 Transfer 事件里发现 Flap 代币（只收靓号后缀 7777 / 8888 的地址，再逐个核对；发现的代币里没有分红合约的不报告），true 用默认值 */
  discover?: boolean | DividendScanOptions
  /** 查分红资产的美元价格：true（默认）用 DefiLlama + 链上池子，也可以传自己的 PriceSource，false 不查 */
  prices?: boolean | PriceSource
  fetch?: typeof fetch
  /** 包含没有可领取分红的代币（默认 false，只返回 claimable > 0 的） */
  includeZero?: boolean
}

export interface DividendsResult {
  items: DividendItem[]
  /** 检查过但识别不了的代币（不是税收代币、没有分红合约、合约函数不符） */
  unsupported: DividendUnsupported[]
  /** discover 的扫描状态：cursor 是已扫到的区块，progress 可以存下来下次接着扫 */
  scan?: { cursor: number; progress: LogScanProgress | null; tokens: string[] }
  /** 查价格出错时的信息（这时 usd 都是 null） */
  priceError?: string
}

function assertChain(chainId: number): void {
  if (isTronChain(chainId) || !FLAP_DIVIDEND_CHAINS[chainId]) {
    throw new Error(`Flap dividends are only supported on BNB Chain (56), got chain ${chainId}`)
  }
}

/** 发现持有人收到过的 Flap 税收代币（只发现，不核对有没有分红：把 tokens 交给 dividends） */
export async function scanDividendTokens(provider: Provider, owner: string, options: DividendScanOptions = {}): Promise<{ tokens: string[]; cursor: number; progress: LogScanProgress | null }> {
  assertChain(await provider.getChainId())
  const ownerTopic = `0x${getAddress(owner).slice(2).toLowerCase().padStart(64, '0')}`
  const lookback = Math.max(0, Math.floor(options.lookbackBlocks ?? 5000))
  const suffixes = (options.suffixes ?? FLAP_TOKEN_SUFFIXES).map((x) => x.toLowerCase())
  const progress = await runLogScan({
    provider,
    saved: options.progress,
    initialCursor: (target) => (options.fromBlock !== undefined ? options.fromBlock - 1 : target - lookback),
    filter: { topics: [TRANSFER_TOPIC, null, ownerTopic] },
    // 只收 ERC20 的 Transfer（3 个 topic）里靓号后缀的合约
    collect: (log) => (log.topics.length === 3 && suffixes.some((s) => log.address.toLowerCase().endsWith(s)) ? log.address.toLowerCase() : null),
    maxRange: Math.max(1, Math.floor(options.blockRange ?? 1000)),
    maxRequests: Math.max(1, Math.floor(options.maxRequests ?? 10)),
    timeBudget: options.timeBudget ?? 10_000,
    confirmations: 0,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return { tokens: (progress?.items ?? []).map((a) => getAddress(a)), cursor: progress?.cursor ?? -1, progress }
}

/**
 * 查持有人在 Flap 代币上的分红：余额、可领取数量、已领取数量、分红资产和美元价值。
 * 代币来自 tokens 和 discover（扫描收到过的 Transfer），每个代币都在链上核对（dividendContract() + Dividend 合约的函数），
 * 核对不过的放进 unsupported。不发送交易
 */
export async function dividends(provider: Provider, owner: string, options: DividendsOptions = {}): Promise<DividendsResult> {
  const chainId = await provider.getChainId()
  assertChain(chainId)
  const holder = getAddress(owner)

  let scan: DividendsResult['scan']
  const found = new Map<string, string>()
  const explicit = new Set<string>()
  for (const t of options.tokens ?? []) {
    found.set(getAddress(t).toLowerCase(), getAddress(t))
    explicit.add(getAddress(t).toLowerCase())
  }
  if (options.discover) {
    const r = await scanDividendTokens(provider, holder, options.discover === true ? {} : options.discover)
    scan = { cursor: r.cursor, progress: r.progress, tokens: r.tokens }
    for (const t of r.tokens) found.set(t.toLowerCase(), t)
  }
  const tokens = [...found.values()]
  if (tokens.length > MAX_TOKENS) throw new Error(`Too many tokens (${tokens.length}), at most ${MAX_TOKENS} per call`)
  const result: DividendsResult = { items: [], unsupported: [], ...(scan ? { scan } : {}) }
  if (!tokens.length) return result

  // 第一步：代币本身（余额、精度、Dividend 合约地址）
  const stage1 = await provider.tryAll(tokens.flatMap((t) => [provider.contract(t, TOKEN_ABI).dividendContract(), provider.contract(t, TOKEN_ABI).balanceOf(holder), provider.contract(t, TOKEN_ABI).symbol(), provider.contract(t, TOKEN_ABI).decimals()]))
  const valid: Array<{ token: string; dividend: string; balance: bigint; symbol: string | null; decimals: number }> = []
  tokens.forEach((token, i) => {
    const [dividend, balance, symbol, decimals] = stage1.slice(i * 4, i * 4 + 4) as [string | null, bigint | null, string | null, bigint | null]
    if (dividend === null || dividend === ZERO) {
      // 发现来的代币大多不是分红代币（普通 8888 代币等），只报告用户明确传入的
      if (explicit.has(token.toLowerCase())) result.unsupported.push({ token, reason: dividend === null ? 'no dividendContract() (not a Flap tax token V2/V3)' : 'token has no dividend contract' })
    } else if (balance === null || decimals === null) {
      result.unsupported.push({ token, reason: 'not an ERC20 token' })
    } else {
      valid.push({ token, dividend, balance, symbol: typeof symbol === 'string' ? symbol : null, decimals: Number(decimals) })
    }
  })

  // 第二步：Dividend 合约（分红代币、可领取、已领取、最低持仓）
  const stage2 = valid.length
    ? await provider.tryAll(valid.flatMap((v) => {
        const d = provider.contract(v.dividend, DIVIDEND_ABI)
        return [d.dividendToken(), d.weth(), d.withdrawableDividends(holder), d.withdrawnDividends(holder), d.minimumShareBalance()]
      }))
    : []
  const rows: Array<{ v: (typeof valid)[number]; dividendToken: string; weth: string | null; claimable: bigint; claimed: bigint; min: bigint }> = []
  valid.forEach((v, i) => {
    const [dividendToken, weth, claimable, claimed, min] = stage2.slice(i * 5, i * 5 + 5) as [string | null, string | null, bigint | null, bigint | null, bigint | null]
    if (dividendToken === null || claimable === null || claimed === null || min === null) {
      result.unsupported.push({ token: v.token, reason: 'dividend contract does not expose the expected functions (unknown generation)' })
    } else {
      rows.push({ v, dividendToken, weth, claimable, claimed, min })
    }
  })

  // 第三步：分红资产的 symbol / decimals（WBNB 作为 BNB 领取：按主币处理）
  const isNative = (r: (typeof rows)[number]) => r.dividendToken === ZERO || (r.weth !== null && r.dividendToken.toLowerCase() === r.weth.toLowerCase())
  const assetTokens = [...new Set(rows.filter((r) => !isNative(r)).map((r) => r.dividendToken))]
  const meta = new Map<string, { symbol: string | null; decimals: number; known: boolean }>()
  if (assetTokens.length) {
    const res = await provider.tryAll(assetTokens.flatMap((a) => [provider.contract(a, ERC20_META_ABI).symbol(), provider.contract(a, ERC20_META_ABI).decimals()]))
    assetTokens.forEach((a, i) => meta.set(a, { symbol: typeof res[i * 2] === 'string' ? (res[i * 2] as string) : null, decimals: res[i * 2 + 1] === null ? 18 : Number(res[i * 2 + 1]), known: res[i * 2 + 1] !== null }))
  }
  const nativeMeta = { symbol: 'BNB', decimals: 18, known: true }

  const items: DividendItem[] = rows.map((r) => {
    const native = isNative(r)
    const m = native ? nativeMeta : (meta.get(r.dividendToken) ?? { symbol: null, decimals: 18, known: false })
    return {
      owner: holder,
      token: r.v.token,
      symbol: r.v.symbol,
      decimals: r.v.decimals,
      balance: r.v.balance.toString(),
      dividendContract: getAddress(r.v.dividend),
      dividendToken: getAddress(r.dividendToken),
      asset: native ? 'native' : getAddress(r.dividendToken),
      assetSymbol: m.symbol,
      assetDecimals: m.decimals,
      ...(m.known ? {} : { decimalsUnknown: true }),
      claimable: r.claimable.toString(),
      claimableFormatted: formatUnits(r.claimable, m.decimals),
      claimed: r.claimed.toString(),
      claimedFormatted: formatUnits(r.claimed, m.decimals),
      usd: null,
      minimumShareBalance: r.min.toString(),
      accruing: r.v.balance >= r.min && r.v.balance > 0n,
      adapter: 'flap',
    }
  })
  const shown = options.includeZero ? items : items.filter((i) => BigInt(i.claimable) > 0n)

  if (options.prices !== false && shown.length) {
    try {
      const { tokenPrices } = await import('./price.js')
      const assets = [...new Set(shown.map((i) => (i.asset === 'native' ? NATIVE_TOKEN : i.asset)))]
      const prices = await tokenPrices(provider, assets, { ...(typeof options.prices === 'object' ? { sources: [options.prices] } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) })
      const byAsset = new Map(prices.map((p) => [p.token.toLowerCase(), p.price]))
      for (const i of shown) {
        if (i.decimalsUnknown) continue // 精度未知，换算不出可信的美元价值
        const price = byAsset.get((i.asset === 'native' ? NATIVE_TOKEN : i.asset).toLowerCase())
        i.usd = price === null || price === undefined ? null : Number(i.claimableFormatted) * price
      }
    } catch (err) {
      result.priceError = err instanceof Error ? err.message : String(err)
    }
  }
  result.items = shown
  return result
}

// ---------------------------------------------------------------------------
// 领取
// ---------------------------------------------------------------------------

export interface ClaimDividendTx {
  to: string
  data: string
  value: '0'
  item: DividendItem
}

/**
 * 领取分红要发的交易（不签名）：每个代币一笔 `withdrawDividendsFor(owner)`，发给它的 Dividend 合约，款项直接到 owner。
 * 只包含 claimable > 0 的项。只校验 owner / dividendContract 是合法地址，不连链：items 来自调用方，
 * 要确认 dividendContract 确实是代币自己的 Dividend 合约，用 claimDividends（发送前会在链上核对）
 */
export function buildClaimDividends(items: readonly DividendItem[]): ClaimDividendTx[] {
  return items
    .filter((item) => BigInt(item.claimable) > 0n)
    .map((item) => {
      if (item.adapter !== 'flap') throw new Error(`Unsupported dividend adapter for ${item.token}`)
      let to: string
      let owner: string
      try {
        to = getAddress(item.dividendContract)
        owner = getAddress(item.owner)
      } catch {
        throw new Error(`Invalid dividendContract / owner address for ${item.token}`)
      }
      return { to, data: claimInterface.encodeFunctionData('withdrawDividendsFor', [owner]), value: '0' as const, item }
    })
}

export interface ClaimDividendsOptions extends BatchCallOptions {
  /** 发送前先用 /simulate 模拟每一笔（claimable 只是查询时的快照，可能已经变了），会 revert 的不发（结果 status 为 'skipped'，error 是原因）。默认 true，false 不模拟；dryRun 只预估 gas */
  simulate?: boolean
}

export interface ClaimDividendResult extends WriteResult {
  item: DividendItem
}

/**
 * 领取分红：构建（同 buildClaimDividends）后用 from 签名发送，钱包和选项同 batchCall
 * （mode: '7702' / '4337' / '5792' 时合成一笔原子交易）。任何人都可以替持有人领取，款项直接到 item.owner，所以 from 不必是持有人（如代付 gas）。
 *
 * ```ts
 * const { items } = await getDividends(user, { chainId: 56, discover: true })
 * await claimDividends(provider, key, items, { mode: '7702' })
 * ```
 */
export async function claimDividends(provider: Provider, from: SignerInput, items: readonly DividendItem[], options: ClaimDividendsOptions = {}): Promise<ClaimDividendResult[]> {
  assertChain(await provider.getChainId())
  const { simulate: preCheck = true, ...sendOptions } = options
  const txs = buildClaimDividends(items)
  if (!txs.length) return []
  const skipped = new Map<number, string>()
  // 核对 items 里的 dividendContract 确实是代币自己的 Dividend 合约（items 来自调用方，不能直接信）
  const onChain = await provider.tryAll<string>(txs.map((tx) => provider.contract(tx.item.token, TOKEN_ABI).dividendContract()))
  onChain.forEach((d, i) => {
    if (d === null || (txs[i] as ClaimDividendTx).to.toLowerCase() !== d.toLowerCase()) {
      skipped.set(i, `dividendContract mismatch: ${(txs[i] as ClaimDividendTx).to} is not the dividend contract of ${(txs[i] as ClaimDividendTx).item.token}`)
    }
  })
  if (preCheck) {
    const { simulate } = await import('./simulate.js')
    const sims = await Promise.all(txs.map((tx, i): Promise<{ success: boolean; error?: string }> => skipped.has(i) ? Promise.resolve({ success: true }) : simulate(provider, { to: tx.to, data: tx.data, from: tx.item.owner }, { usd: false, risk: false }).catch((err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) }))))
    sims.forEach((s, i) => !s.success && skipped.set(i, s.error ?? 'simulation failed'))
  }
  const send = txs.map((tx, i) => ({ tx, i })).filter(({ i }) => !skipped.has(i))
  const { batchCall } = await import('./write/batch.js')
  const sent = send.length ? await batchCall(provider, send.map(({ tx }) => ({ from, to: tx.to, data: tx.data })), { continueOnError: true, ...sendOptions }) : []
  const sentBy = new Map(send.map(({ i }, k) => [i, sent[k] as WriteResult]))
  return txs.map((tx, i) => {
    const r = sentBy.get(i)
    if (r) return { ...r, index: i, item: tx.item }
    return { index: i, from: tx.item.owner, to: tx.to, status: 'skipped', hash: null, nonce: null, gasLimit: null, gasUsed: null, fee: null, blockNumber: null, error: skipped.get(i) ?? null, item: tx.item }
  })
}
