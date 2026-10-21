/**
 * 兑换（子路径 `@w3lib/solana-batch-call/swap`）：在 Raydium CLMM、Orca Whirlpool、Raydium CPMM、Raydium AMM v4 的池子里找路线
 * （直接兑换，或经过 SOL / USDC / USDT 的两跳），按链上状态在本地报价（照搬各程序的计算），选输出最多的；
 * 按滑点算最少收到的数量，构建指令（SOL 自动包装 / 解包、缺少的代币账户自动创建），发送同 /write
 */
import { getAssociatedTokenAddress, isAddress } from '../address.js'
import type { SolanaClient } from '../client.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '../constants.js'
import { formatUnits, parseTokenAccount, type AccountInfo } from '../layout.js'
import { createCtx, minus, parseAmount, prepareTokenAccounts, tokenInfo, type Ctx, type MintMeta } from '../liquidity/common.js'
import { SOLANA_LP_PROTOCOLS, type SolanaLpToken } from '../lp.js'
import { poolAddresses, type PdaPoolProtocol } from '../pools.js'
import { batchCall } from '../write/batch.js'
import { MAX_COMPUTE_UNITS, setComputeUnitLimit, setComputeUnitPrice } from '../write/instructions.js'
import type { SendOptions, WriteResult, WriteStatus } from '../write/send.js'
import { resolveSigner, type SignerInput } from '../write/signer.js'
import { MAX_ACCOUNT_LOCKS, PACKET_DATA_SIZE, compileMessage, transactionSize, type Instruction } from '../write/transaction.js'
import { ammV4Pool, parseAmmV4Pool } from './amm.js'
import { CLOCK_SYSVAR_ID, NeedAccounts, parseClock, swapMint, type AccountGetter, type HopQuote, type SolanaSwapProtocol, type SwapEnv, type SwapPool } from './common.js'
import { cpmmPool, parseCpmmPool } from './cpmm.js'
import { parseWhirlpool, whirlpoolPool } from './orca.js'
import { parseRaydiumClmmPool, raydiumClmmPool } from './raydiumClmm.js'

export type { SolanaSwapProtocol } from './common.js'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
/** 两跳默认的中间代币：Wrapped SOL、USDC、USDT */
export const SWAP_INTERMEDIATES: readonly string[] = [NATIVE_MINT, USDC, USDT]
/** 默认的协议：能按两个 mint 推导池子地址的三个，加上 pools 里给出的 AMM v4 池子 */
export const SWAP_PROTOCOLS: readonly SolanaSwapProtocol[] = ['raydium-clmm', 'orca-whirlpool', 'raydium-cpmm', 'raydium-amm']

type Amount = bigint | number | string
/** 兑换走得比预读的 tick 数组远时，最多再读几轮 */
const MAX_LOAD_ROUNDS = 3

export interface SolanaSwapParams {
  /** 卖出 / 买入的代币 mint；原生 SOL 用 NATIVE_MINT（So111…112）或客户端的 nativeMints，池子里按 Wrapped SOL */
  tokenIn: string
  tokenOut: string
  /** 卖出的数量：amountIn（最小单位）和 amountInFormatted（按精度换算，如 '1.5'）二选一 */
  amountIn?: Amount
  amountInFormatted?: string
}

export interface SolanaSwapOptions {
  /** 价格滑点（比例，0.005 = 0.5%），最少收到 = 报价 × (1 − slippage)，默认 0.005 */
  slippage?: number
  /**
   * Wrapped SOL 用 SOL 支付 / 收取（自动包装 / 解包），默认 true。
   * 用的是 wSOL 的关联代币账户：原来没有时创建、用完关闭（换回 SOL）；原来就有时只补差额、不关闭（买入的 SOL 留在 wSOL 账户里）
   */
  native?: boolean
  /** 只用这些协议，默认 SWAP_PROTOCOLS（全部四个） */
  protocols?: readonly SolanaSwapProtocol[]
  /** 两跳的中间代币，默认 SWAP_INTERMEDIATES（Wrapped SOL、USDC、USDT）；传 [] 只找直接兑换 */
  intermediates?: readonly string[]
  /**
   * 额外的池子地址（四个协议都可以，按账户所属程序识别）。Raydium AMM v4 的池子地址不能从两个 mint 推导，要用的话在这里给出；
   * 用 seed_index 建的 Raydium CLMM 池子、非默认配置的 Orca 池子同样
   */
  pools?: readonly string[]
  /** 按两个 mint 推导池子地址（Raydium CLMM / CPMM 的每个 AmmConfig、Orca 的每个费率档位），默认 true；false 时只用 pools 里的 */
  discover?: boolean
  signal?: AbortSignal
}

export interface SolanaSwapHop {
  protocol: SolanaSwapProtocol
  protocolName: string
  pool: string
  tokenIn: string
  tokenOut: string
  /** 这一跳卖出的数量和预计收到的数量（已扣转账手续费） */
  amountIn: string
  amountOut: string
  /** 这一跳的最少收到（按滑点），交易里的 other_amount_threshold */
  amountOutMin: string
}

export interface SolanaSwapRoute {
  /** 经过的代币（池子里的 mint，SOL 是 Wrapped SOL） */
  path: string[]
  hops: SolanaSwapHop[]
  /** 预计收到的数量（最小单位） */
  amountOut: string
  /**
   * 用于比较路线的数量：两跳时第二跳按第一跳的报价全部卖出能拿到的（实际第二跳只卖第一跳的最少收到，多出的中间代币留在账户里，见 leftover）；
   * 直接兑换等于 amountOut
   */
  value: string
}

export interface SolanaSwapStep {
  /** setup：创建代币账户（能和兑换放进同一笔交易时会合并）；swap：包装 SOL、兑换、解包 */
  kind: 'setup' | 'swap'
  instructions: Instruction[]
}

/** 兑换的计划：报价 + 按顺序执行的指令。只读取、不签名，可以当作报价 */
export interface SolanaSwapPlan {
  owner: string
  tokenIn: SolanaLpToken
  tokenOut: SolanaLpToken
  amountIn: string
  amountInFormatted: string | null
  /** 预计收到的数量（按当前链上状态本地计算，与程序的取整一致）和最少收到的数量（按滑点） */
  amountOut: string
  amountOutFormatted: string | null
  amountOutMin: string
  amountOutMinFormatted: string | null
  /** 1 个 tokenIn 换多少 tokenOut（按这笔的数量，路线的 value） */
  price: number | null
  /** 价格影响（0~1）：这笔的价格比极小数量（1 / 10000）的价格差多少；算不出时为 null */
  priceImpact: number | null
  route: SolanaSwapRoute
  /** 所有候选路线，按 value 从高到低（含选中的） */
  routes: SolanaSwapRoute[]
  /** 两跳时留在账户里的中间代币（第一跳报价 − 第一跳最少收到，按当前状态）；中间代币是 Wrapped SOL 且原来没有 wSOL 账户时随账户关闭换回 SOL */
  leftover: { mint: string; amount: string } | null
  /** 哪一边用 SOL（自动包装 / 解包） */
  native: 'tokenIn' | 'tokenOut' | null
  /** 没有用上的池子和原因（不支持的代币扩展、需要位图扩展、流动性不足等） */
  skipped: Array<{ protocol: SolanaSwapProtocol; pool: string; reason: string }>
  steps: SolanaSwapStep[]
}

interface Leg {
  pool: SwapPool
  zeroForOne: boolean
  tokenIn: string
  tokenOut: string
}

interface Candidate {
  legs: Array<{ leg: Leg; quote: HopQuote; min: bigint }>
  amountOut: bigint
  value: bigint
}

/** 按账户所属程序解析池子（包内使用，测试也用） */
export function parseSwapPool(account: AccountInfo): SwapPool | null {
  const cpmm = parseCpmmPool(account)
  if (cpmm) return cpmmPool(cpmm)
  const amm = parseAmmV4Pool(account)
  if (amm) return ammV4Pool(amm)
  const clmm = parseRaydiumClmmPool(account)
  if (clmm) return raydiumClmmPool(clmm)
  const orca = parseWhirlpool(account)
  return orca ? whirlpoolPool(orca) : null
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** 读到的账户：多轮读取合并 */
class Snapshot {
  readonly map = new Map<string, AccountInfo | null>()
  get: AccountGetter = (address) => this.map.get(address)
  async load(ctx: Ctx, addresses: readonly string[]): Promise<void> {
    const missing = [...new Set(addresses)].filter((a) => !this.map.has(a))
    if (!missing.length) return
    const accounts = await ctx.client.accounts(missing, { signal: ctx.signal })
    missing.forEach((a, i) => this.map.set(a, accounts[i] ?? null))
  }
}

/**
 * 报价并构建兑换的指令（不签名）：选输出最多的路线，最少收到 = 报价 × (1 − slippage)。
 *
 * ```ts
 * const plan = await buildSwap(client, owner, { tokenIn: NATIVE_MINT, tokenOut: USDC, amountInFormatted: '0.5' })
 * plan.amountOutFormatted   // '93.41'
 * plan.route.hops           // [{ protocol: 'raydium-clmm', pool: '3ucNos4N…', … }]
 * ```
 */
export async function buildSwap(client: SolanaClient, owner: string, params: SolanaSwapParams, options: SolanaSwapOptions = {}): Promise<SolanaSwapPlan> {
  const ctx = createCtx(client, owner, { slippage: options.slippage, native: options.native, signal: options.signal })
  const nativeIn = client.isNativeMint(params.tokenIn)
  const nativeOut = client.isNativeMint(params.tokenOut)
  const tokenIn = nativeIn ? NATIVE_MINT : params.tokenIn
  const tokenOut = nativeOut ? NATIVE_MINT : params.tokenOut
  for (const mint of [tokenIn, tokenOut]) {
    if (!isAddress(mint)) throw new Error(`Invalid mint address: ${mint}`)
  }
  if (tokenIn === tokenOut) throw new Error(nativeIn || nativeOut ? 'Wrapping / unwrapping SOL is not a swap' : 'tokenIn and tokenOut are the same')
  const protocols = new Set(options.protocols ?? SWAP_PROTOCOLS)
  for (const p of protocols) {
    if (!SWAP_PROTOCOLS.includes(p)) throw new Error(`Unknown swap protocol: ${String(p)}`)
  }
  const mids = [...new Set(options.intermediates ?? SWAP_INTERMEDIATES)].filter((m) => m !== tokenIn && m !== tokenOut)
  for (const m of mids) {
    if (!isAddress(m)) throw new Error(`Invalid intermediate mint: ${m}`)
  }
  for (const p of options.pools ?? []) {
    if (!isAddress(p)) throw new Error(`Invalid pool address: ${p}`)
  }

  // 1. 一次读：候选池子（PDA 推导 + 传入的）、Clock、各代币的 mint
  const pda = new Set([...protocols].filter((p): p is PdaPoolProtocol => p !== 'raydium-amm'))
  const pairs: Array<[string, string]> = [[tokenIn, tokenOut], ...mids.flatMap((m): Array<[string, string]> => [[tokenIn, m], [m, tokenOut]])]
  const derived = options.discover === false ? [] : pairs.flatMap(([a, b]) => poolAddresses(a, b, pda).map((p) => p.address))
  const snapshot = new Snapshot()
  await snapshot.load(ctx, [CLOCK_SYSVAR_ID, tokenIn, tokenOut, ...mids, ...derived, ...(options.pools ?? [])])
  const clock = snapshot.get(CLOCK_SYSVAR_ID)
  if (!clock) throw new Error('Cannot read the Clock sysvar')
  const env: SwapEnv = parseClock(clock.data)
  for (const mint of [tokenIn, tokenOut]) {
    if (!snapshot.get(mint)) throw new Error(`Token mint not found: ${mint}`)
  }
  const metaIn = swapMint(tokenIn, snapshot.get(tokenIn) as AccountInfo)
  const metaOut = swapMint(tokenOut, snapshot.get(tokenOut) as AccountInfo)
  const amountIn = parseAmount(params.amountIn, params.amountInFormatted, metaIn.decimals, 'amountIn')
  if (amountIn === undefined || amountIn <= 0n) throw new Error('amountIn must be greater than 0')
  if (amountIn > (1n << 64n) - 1n) throw new RangeError('amountIn exceeds u64')

  // 2. 解析池子，按代币对分组
  const tokens = new Set([tokenIn, tokenOut, ...mids])
  const legs: Leg[] = []
  const seen = new Set<string>()
  for (const address of [...derived, ...(options.pools ?? [])]) {
    const account = snapshot.get(address)
    if (!account || seen.has(address)) continue
    const pool = parseSwapPool(account)
    if (!pool || !protocols.has(pool.protocol) || !tokens.has(pool.mint0) || !tokens.has(pool.mint1)) continue
    seen.add(address)
    for (const [a, b] of pairs) {
      if ((pool.mint0 === a && pool.mint1 === b) || (pool.mint0 === b && pool.mint1 === a)) legs.push({ pool, zeroForOne: pool.mint0 === a, tokenIn: a, tokenOut: b })
    }
  }
  if (!legs.length) throw new Error('No pool found for this pair (directly or through the intermediate tokens) in the supported protocols')
  // 3. 一次读：报价要用的账户（配置、金库、tick 数组、Oracle 等）
  await snapshot.load(ctx, legs.flatMap((l) => l.pool.accounts(l.zeroForOne)))

  const skipped: SolanaSwapPlan['skipped'] = []
  const skip = (leg: Leg, err: unknown) => {
    if (!skipped.some((s) => s.pool === leg.pool.address)) skipped.push({ protocol: leg.pool.protocol, pool: leg.pool.address, reason: errorText(err) })
  }
  /** 报价还要读的账户（兑换走得比预读的 tick 数组远）：读完后重新报价 */
  const pending = new Set<string>()
  let lastRound = false
  const quoteLeg = (leg: Leg, amount: bigint): HopQuote | null => {
    if (amount <= 0n) return null
    try {
      const q = leg.pool.quote(snapshot.get, amount, leg.zeroForOne, env)
      return q.amountOut > 0n ? q : null
    } catch (err) {
      if (err instanceof NeedAccounts && !lastRound) {
        err.addresses.forEach((a) => pending.add(a))
      } else {
        skip(leg, err instanceof NeedAccounts ? new Error('The swap needs too many tick arrays (amount too large for this pool)') : err)
      }
      return null
    }
  }

  // 4. 报价：直接兑换的每个池子；两跳的每个第一跳池子配上最好的第二跳
  const collect = (): Candidate[] => {
    const list: Candidate[] = []
    for (const leg of legs.filter((l) => l.tokenIn === tokenIn && l.tokenOut === tokenOut)) {
      const q = quoteLeg(leg, amountIn)
      if (q) list.push({ legs: [{ leg, quote: q, min: minus(q.amountOut, ctx.slippage) }], amountOut: q.amountOut, value: q.amountOut })
    }
    for (const mid of mids) {
      const seconds = legs.filter((l) => l.tokenIn === mid && l.tokenOut === tokenOut)
      if (!seconds.length) continue
      for (const first of legs.filter((l) => l.tokenIn === tokenIn && l.tokenOut === mid)) {
        const q1 = quoteLeg(first, amountIn)
        if (!q1) continue
        const min1 = minus(q1.amountOut, ctx.slippage)
        let best: Candidate | null = null
        for (const second of seconds) {
          const q2 = quoteLeg(second, min1)
          if (!q2) continue
          const value = quoteLeg(second, q1.amountOut)?.amountOut ?? q2.amountOut
          if (!best || value > best.value) {
            best = {
              legs: [
                { leg: first, quote: q1, min: min1 },
                { leg: second, quote: q2, min: minus(q2.amountOut, ctx.slippage) },
              ],
              amountOut: q2.amountOut,
              value,
            }
          }
        }
        if (best) list.push(best)
      }
    }
    return list
  }
  let candidates: Candidate[] = []
  for (let round = 0; ; round++) {
    pending.clear()
    skipped.length = 0
    lastRound = round >= MAX_LOAD_ROUNDS
    candidates = collect()
    if (!pending.size) break
    await snapshot.load(ctx, [...pending])
  }
  candidates.sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0))
  if (!candidates.length) {
    const reasons = skipped.map((s) => `${s.protocol} ${s.pool}: ${s.reason}`).join('; ')
    throw new Error(`No route can be quoted for this amount${reasons ? ` (${reasons})` : ''}`)
  }

  // 5. 代币账户：卖出的、买入的、两跳的中间代币
  const metaOf = (mint: string): MintMeta => {
    const m = mint === tokenIn ? metaIn : mint === tokenOut ? metaOut : swapMint(mint, snapshot.get(mint) as AccountInfo)
    return { mint: m.mint, program: m.program, decimals: m.decimals }
  }
  const [infoIn, infoOut] = (await tokenInfo(ctx, [metaOf(tokenIn), metaOf(tokenOut)])) as [SolanaLpToken, SolanaLpToken]

  // 6. 按顺序取第一条能放进一笔交易的路线
  let chosen: { candidate: Candidate; steps: SolanaSwapStep[]; native: SolanaSwapPlan['native'] } | null = null
  for (const candidate of candidates) {
    const path = [tokenIn, ...candidate.legs.map((l) => l.leg.tokenOut)]
    const metas = path.map(metaOf)
    const accounts = await prepareTokenAccounts(ctx, metas, path.map((_, i) => (i === 0 ? amountIn : null)))
    const swaps = candidate.legs.map(({ leg, quote, min }, i) =>
      leg.pool.instruction(snapshot.get, owner, accounts.accounts[i] as string, accounts.accounts[i + 1] as string, leg.zeroForOne, quote, min),
    )
    const main = [...accounts.wrap, ...swaps, ...accounts.cleanup]
    const probe = compileMessage(owner, [setComputeUnitLimit(MAX_COMPUTE_UNITS), setComputeUnitPrice(1n), ...main], '11111111111111111111111111111111')
    if (transactionSize(probe) > PACKET_DATA_SIZE || probe.accountKeys.length > MAX_ACCOUNT_LOCKS) {
      skipped.push(...candidate.legs.filter((l) => !skipped.some((s) => s.pool === l.leg.pool.address)).map((l) => ({ protocol: l.leg.pool.protocol, pool: l.leg.pool.address, reason: 'The route does not fit in one transaction' })))
      continue
    }
    const nativeIndex = accounts.nativeIndex
    const native = nativeIndex === 0 ? 'tokenIn' : nativeIndex !== null && nativeIndex === path.length - 1 ? 'tokenOut' : null
    chosen = {
      candidate,
      native,
      steps: [
        { kind: 'setup' as const, instructions: accounts.setup },
        { kind: 'swap' as const, instructions: main },
      ].filter((s) => s.instructions.length > 0),
    }
    break
  }
  if (!chosen) throw new Error('No route fits in one transaction')
  const best = chosen.candidate

  // 7. 价格影响：同一路线卖出 1 / 10000 的数量
  let priceImpact: number | null = null
  const small = amountIn / 10_000n
  if (small > 0n) {
    let amount: bigint | null = small
    for (const { leg } of best.legs) amount = amount === null ? null : (quoteLeg(leg, amount)?.amountOut ?? null)
    if (amount) priceImpact = Math.max(0, 1 - Number(best.value) / Number(amountIn) / (Number(amount) / Number(small)))
  }

  const amountOutMin = minus(best.amountOut, ctx.slippage)
  const fmt = (v: bigint, t: SolanaLpToken) => (t.decimals === null ? null : formatUnits(v, t.decimals))
  const route = (c: Candidate): SolanaSwapRoute => ({
    path: [tokenIn, ...c.legs.map((l) => l.leg.tokenOut)],
    hops: c.legs.map(({ leg, quote, min }) => ({
      protocol: leg.pool.protocol,
      protocolName: SOLANA_LP_PROTOCOLS[leg.pool.protocol].name,
      pool: leg.pool.address,
      tokenIn: leg.tokenIn,
      tokenOut: leg.tokenOut,
      amountIn: quote.amountIn.toString(),
      amountOut: quote.amountOut.toString(),
      amountOutMin: min.toString(),
    })),
    amountOut: c.amountOut.toString(),
    value: c.value.toString(),
  })
  const first = best.legs[0] as Candidate['legs'][number]
  return {
    owner,
    tokenIn: infoIn,
    tokenOut: infoOut,
    amountIn: amountIn.toString(),
    amountInFormatted: fmt(amountIn, infoIn),
    amountOut: best.amountOut.toString(),
    amountOutFormatted: fmt(best.amountOut, infoOut),
    amountOutMin: amountOutMin.toString(),
    amountOutMinFormatted: fmt(amountOutMin, infoOut),
    price: infoIn.decimals === null || infoOut.decimals === null ? null : Number(best.value) / 10 ** infoOut.decimals / (Number(amountIn) / 10 ** infoIn.decimals),
    priceImpact,
    route: route(best),
    routes: candidates.map(route),
    leftover: best.legs.length > 1 ? { mint: first.leg.tokenOut, amount: (first.quote.amountOut - first.min).toString() } : null,
    native: chosen.native,
    skipped,
    steps: chosen.steps,
  }
}

export interface SolanaSwapSendOptions extends SolanaSwapOptions, Omit<SendOptions, 'onUpdate' | 'signal'> {
  /** 发送前检查卖出的余额够不够，默认 true */
  checkBalance?: boolean
  onUpdate?: (result: SolanaSwapStepResult) => void
}

export interface SolanaSwapStepResult extends WriteResult {
  kind: SolanaSwapStep['kind']
}

export interface SolanaSwapResult {
  plan: SolanaSwapPlan
  /** 与 plan.steps 一一对应 */
  results: SolanaSwapStepResult[]
  /** 兑换那一步的状态和签名 */
  status: WriteStatus
  signature: string | null
}

/**
 * 兑换：构建（同 buildSwap）后用 from 签名发送（钱包同 /write 的 batchCall）。创建代币账户和兑换能放进同一笔交易时合并成一笔
 *
 * ```ts
 * const r = await swap(client, secretKey, { tokenIn: USDC, tokenOut: NATIVE_MINT, amountInFormatted: '100' }, { slippage: 0.01 })
 * r.status   // 'confirmed'
 * ```
 */
export async function swap(client: SolanaClient, from: SignerInput, params: SolanaSwapParams, options: SolanaSwapSendOptions = {}): Promise<SolanaSwapResult> {
  const plan = await buildSwap(client, (await resolveSigner(from)).address, params, options)
  if (options.checkBalance ?? true) {
    await checkBalance(client, plan, options.native ?? true, options.signal)
  }
  const { steps } = plan
  const payer = (await resolveSigner(options.feePayer ?? from)).address
  const probe = compileMessage(payer, [setComputeUnitLimit(MAX_COMPUTE_UNITS), setComputeUnitPrice(1n), ...steps.flatMap((s) => s.instructions)], '11111111111111111111111111111111')
  const merged = steps.length > 1 && transactionSize(probe) <= PACKET_DATA_SIZE && probe.accountKeys.length <= MAX_ACCOUNT_LOCKS
  const groups: number[][] = merged ? [steps.map((_, i) => i)] : steps.map((_, i) => [i])
  const kindOf = (i: number) => (steps[i] as SolanaSwapStep).kind
  const raw = await batchCall(
    client,
    groups.map((group) => ({ from, instructions: group.flatMap((i) => (steps[i] as SolanaSwapStep).instructions) })),
    {
      ...options,
      mode: 'pack',
      continueOnError: false,
      onUpdate: options.onUpdate ? (r) => (groups[r.index] as number[]).forEach((i) => options.onUpdate?.({ ...r, index: i, kind: kindOf(i) })) : undefined,
    },
  )
  const results = groups.flatMap((group, g) => group.map((i): SolanaSwapStepResult => ({ ...(raw[g] as WriteResult), index: i, kind: kindOf(i) })))
  const last = results[results.length - 1] as SolanaSwapStepResult
  return { plan, results, status: last.status, signature: last.signature }
}

/** 卖出 SOL 时给手续费、wSOL 和收到代币的 ATA 租金留的 lamports（约 0.01 SOL） */
export const SWAP_SOL_RESERVE = 10_000_000n

/** 卖出的余额：代币读关联代币账户；SOL 读原生余额（扣掉 SWAP_SOL_RESERVE）+ 已有的 wSOL（只包装差额） */
async function checkBalance(client: SolanaClient, plan: SolanaSwapPlan, native: boolean, signal: AbortSignal | undefined): Promise<void> {
  const mint = plan.tokenIn.mint
  const need = BigInt(plan.amountIn)
  const program = (await client.accounts([mint], { signal }))[0]?.owner ?? TOKEN_PROGRAM_ID
  const ata = getAssociatedTokenAddress(plan.owner, mint, program)
  const [[account], sol] = await Promise.all([client.accounts([ata], { signal }), mint === NATIVE_MINT && native ? client.solBalances([plan.owner], { signal }) : Promise.resolve(null)])
  let have = 0n
  try {
    if (account) have = parseTokenAccount(account.data).amount
  } catch {
    // 不是代币账户
  }
  if (sol?.[0]?.balance) {
    const lamports = BigInt(sol[0].balance)
    have += lamports > SWAP_SOL_RESERVE ? lamports - SWAP_SOL_RESERVE : 0n
  }
  if (have < need) {
    throw new Error(`Insufficient balance of ${mint === NATIVE_MINT && native ? `SOL (keeping ${SWAP_SOL_RESERVE} lamports for fees and rent)` : mint}: need ${need}, have ${have}`)
  }
}
