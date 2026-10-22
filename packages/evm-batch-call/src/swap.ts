/**
 * 兑换（子路径 `@w3lib/evm-batch-call/swap`）：在内置协议表的 V2 / V3 池子里找路线（直接兑换，或经过包装主币 / 稳定币的两跳），
 * 批量报价（V2 用 Router 的 getAmountsOut，V3 用 QuoterV2，按 gas 分成几次并发的 eth_call），选输出最多的；按滑点算最少收到的数量，
 * 构建授权 + 兑换的交易（V2 走 Router 的 swapExact…SupportingFeeOnTransferTokens，V3 走 SwapRouter02 / PancakeSwap SmartRouter 的 multicall）
 */
import { Interface, getAddress, type BigNumberish } from 'ethers'

import { approvals, createCtx, evm, fmt, isNative, minus, out, parseAmount, same, tokenInfo, type Ctx } from './liquidity/common.js'
import type { LiquidityTxResult } from './liquidity/types.js'
import { LP_PROTOCOLS, LP_QUOTE_TOKENS, type LpProtocol, type LpToken } from './lp.js'
import type { BlockTag } from './aggregate.js'
import type { Provider } from './provider.js'
import type { SignedPermit } from './permit.js'
import type { BatchCallOptions } from './write/batch.js'
import type { SignerInput } from './write/signer.js'

/** V3 协议的报价合约（QuoterV2）和兑换合约（SwapRouter02 接口），按 协议 id → chainId。2026-10 在链上核对过（Router 的 WETH9 / deployer，并用 eth_call 实际执行过兑换） */
export const V3_SWAP_CONTRACTS: Readonly<Record<string, Readonly<Record<number, { quoter: string; router: string }>>>> = {
  'uniswap-v3': {
    1: { quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' },
    10: { quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' },
    56: { quoter: '0x78D78E420Da98ad378D7799bE8f4AF69033EB077', router: '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2' },
    137: { quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' },
    8453: { quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', router: '0x2626664c2603336E57B271c5C0b26F421741e481' },
    42161: { quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' },
    43114: { quoter: '0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F', router: '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE' },
  },
  'pancakeswap-v3': {
    1: { quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', router: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4' },
    56: { quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', router: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4' },
    // Base 上的 SmartRouter 地址与 Ethereum / BSC 不同
    8453: { quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', router: '0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86' },
  },
}

const V3_FEES = [100, 500, 2500, 3000, 10000] as const
/** SwapRouter02 的特殊收款地址：留在 Router 里（之后 unwrapWETH9 换成主币） */
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002'

const v2RouterInterface = new Interface([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
])
const permitInterface = new Interface(['function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)'])
const v3FactoryInterface = new Interface(['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)'])
const v3PoolInterface = new Interface(['function liquidity() view returns (uint128)'])
/** QuoterV2 很费 gas（池子很薄时一次可达上千万）：每次 eth_call 只放几个报价，多个 eth_call 并发，避免超过节点的 gas 上限后被悄悄截掉 */
const QUOTES_PER_CALL = 3
/** 两跳时每一跳最多用几个手续费档位（按当前流动性取最大的） */
const TIERS_PER_LEG = 2
const quoterInterface = new Interface([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
])
const swapRouterInterface = new Interface([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function selfPermitIfNecessary(address token, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) payable',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
])

export interface SwapParams {
  /** 卖出 / 买入的代币；主币用 NATIVE_TOKEN 或零地址（池子里按包装主币，交易里自动包装 / 解包） */
  tokenIn: string
  tokenOut: string
  /** 卖出的数量：amountIn（最小单位）和 amountInFormatted（按精度换算，如 '1.5'）二选一 */
  amountIn?: BigNumberish
  amountInFormatted?: string
}

export interface SwapOptions {
  /** 价格滑点（比例，0.005 = 0.5%），最少收到 = 报价 × (1 − slippage)，默认 0.005 */
  slippage?: number
  /** 交易的有效期（秒），默认 1200 */
  deadline?: number
  /** 收到代币的地址，默认 owner */
  recipient?: string
  /**
   * 授权方式：
   * - 'exact'（默认）：授权本次卖出的数量；'max'：无限额度
   * - 'permit'：用 EIP-2612 签名代替授权交易（要代币支持，见 /permit 的 detectPermit）。V3 路线（SwapRouter02 / SmartRouter）把 selfPermit 放进同一笔 multicall，
   *   一次签名、一笔交易；V2 路线的 Router 没有 selfPermit，只有 `atomic` 批量（7702 / 4337 / 5792）发送时才用 permit，否则仍然是普通授权
   * - 'permit2'：内置的 V2 / V3 路由都不使用 Permit2（它们直接 transferFrom），所以会退回普通的 'exact' 授权；结果的 plan.approval 里有说明
   * - 'auto'：能用 permit 就用，否则普通授权
   * 退回普通授权时 plan.approval.method 为 'approve'，reason 写明原因
   */
  approve?: 'exact' | 'max' | 'permit' | 'permit2' | 'auto'
  /** 交易会在一笔原子批量里发送（`swap` 的 mode 为 7702 / 4337 / 5792 时自动为 true）：V2 路线才能把 permit 和兑换放进同一笔 */
  atomic?: boolean
  /** 已签名的 permit（`swap` 内部使用）：V3 路线嵌入 multicall 的 selfPermit，V2 路线放在兑换前；不再生成授权交易 */
  signedPermit?: SignedPermit
  /**
   * 代币的转账税（比例，0.05 = 5%），默认 0。V2 报价（getAmountsOut）不含转账税，带税的代币
   * 实际收到的比报价少，最少收到按 (1 − slippage) × (1 − tax) 算，否则会因 INSUFFICIENT_OUTPUT_AMOUNT 回滚。
   * 税率可用 /risk 的 getTokenRisks 查；只对 V2 路线生效（V3 不支持带税的代币）。plan.amountOut 仍是不含税的报价
   */
  tax?: number
  /** 只用这些协议（id，如 ['pancakeswap-v3']），默认这条链内置表里能兑换的 V2 / V3 协议 */
  protocols?: readonly string[]
  /** 两跳的中间代币，默认 LP_QUOTE_TOKENS 里这条链的（包装主币和稳定币）；传 [] 只找直接兑换 */
  intermediates?: readonly string[]
  /** 按这个区块的状态报价（默认最新）：同一个区块里报价可以复现 */
  blockTag?: BlockTag
  /** 指定路线（如之前报价结果 routes 里的某一条）：只用这条路线报价和兑换，不选最好的 */
  route?: Pick<SwapRoute, 'protocol' | 'path' | 'fees'>
}

export interface SwapRoute {
  protocol: string
  protocolName: string
  version: 'v2' | 'v3'
  /** 经过的代币（池子里的地址，主币是包装主币） */
  path: string[]
  /** V3：每一跳池子的手续费档位；V2 为空 */
  fees: number[]
  /** 这条路线的报价（最小单位） */
  amountOut: string
}

export interface SwapTx {
  /** approve：卖出的代币授权给 Router；permit：提交 EIP-2612 签名（V2 路线批量发送时）；swap：兑换 */
  kind: 'approve' | 'permit' | 'swap'
  to: string
  data: string
  /** 附带的主币（最小单位）：卖出主币时为卖出的数量 */
  value: string
  token?: string
  spender?: string
  amount?: string
}

export interface SwapPlan {
  tokenIn: LpToken
  tokenOut: LpToken
  amountIn: string
  amountInFormatted: string | null
  /** 报价（最小单位）和最少收到的数量（按滑点） */
  amountOut: string
  amountOutFormatted: string | null
  amountOutMin: string
  amountOutMinFormatted: string | null
  /** 1 个 tokenIn 换多少 tokenOut（按这笔的数量） */
  price: number | null
  /** 价格影响（0~1）：这笔的价格比极小数量的价格差多少；算不出时为 null */
  priceImpact: number | null
  route: SwapRoute
  /** 其他候选路线的报价，从高到低（含选中的） */
  routes: SwapRoute[]
  /** 按顺序发送的交易（授权在前） */
  transactions: SwapTx[]
  /** 请求了 permit / permit2 / auto 时：实际采用的授权方式和原因 */
  approval?: SwapApproval
}

export interface SwapApproval {
  requested: 'permit' | 'permit2' | 'auto'
  /** 'permit'：用签名；'approve'：退回普通授权交易（reason 说明）；'none'：不需要授权（卖出主币 / 额度已够） */
  method: 'permit' | 'approve' | 'none'
  /** permit 的提交方式：selfPermit（V3 的 multicall 内）/ batch（和兑换放在同一笔原子批量） */
  via?: 'selfPermit' | 'batch'
  reason?: string
  /** 要签的 permit（owner 授权 spender 精确的卖出数量，签名有效期与兑换的 deadline 相同） */
  permit?: { token: string; spender: string; value: string; deadline: number }
}

interface Candidate {
  protocol: LpProtocol
  version: 'v2' | 'v3'
  path: string[]
  fees: number[]
  /** V2：Router；V3：报价 / 兑换合约 */
  router: string
  quoter?: string
}

/** 这条链上能兑换的协议：V2 要有 Router，V3 要有报价和兑换合约（V3_SWAP_CONTRACTS） */
export function swapProtocols(chainId: number): LpProtocol[] {
  return LP_PROTOCOLS.filter((p) => p.chainId === chainId && ((p.version === 'v2' && !!p.router) || (p.version === 'v3' && !!V3_SWAP_CONTRACTS[p.id]?.[chainId])))
}

/** V3 的路径编码：token ‖ fee(uint24) ‖ token ‖ … */
function encodePath(path: readonly string[], fees: readonly number[]): string {
  let hex = path[0]?.slice(2).toLowerCase() ?? ''
  fees.forEach((fee, i) => {
    hex += fee.toString(16).padStart(6, '0') + (path[i + 1] as string).slice(2).toLowerCase()
  })
  return `0x${hex}`
}

/** 列出候选路线（V3 先查哪些池子存在）并一次 multicall 报价，按输出从高到低 */
async function quoteRoutes(ctx: Ctx, tokenIn: string, tokenOut: string, amountIn: bigint, options: SwapOptions): Promise<Array<Candidate & { amountOut: bigint }>> {
  const all = swapProtocols(ctx.chainId)
  const protocols = options.protocols ? all.filter((p) => options.protocols?.includes(p.id)) : all
  if (!protocols.length) throw new Error(`No swap protocol on chain ${ctx.chainId}${options.protocols ? ` among ${options.protocols.join(', ')}` : ''}`)
  const mids = (options.intermediates ?? LP_QUOTE_TOKENS[ctx.chainId] ?? []).map(evm).filter((m) => !same(m, tokenIn) && !same(m, tokenOut))

  // V3：先查池子是否存在（每一跳的每个手续费档位）
  const v3 = protocols.filter((p) => p.version === 'v3')
  const legs: Array<{ p: LpProtocol; a: string; b: string; fee: number }> = []
  for (const p of v3) {
    for (const fee of V3_FEES) {
      legs.push({ p, a: tokenIn, b: tokenOut, fee })
      for (const m of mids) legs.push({ p, a: tokenIn, b: m, fee }, { p, a: m, b: tokenOut, fee })
    }
  }
  const overrides = options.blockTag === undefined ? undefined : { blockTag: options.blockTag }
  const pools = legs.length ? await ctx.provider.tryAll<string>(legs.map((l) => ctx.provider.contract(l.p.factory as string, v3FactoryInterface).getPool(l.a, l.b, l.fee)), overrides) : []
  // 再读存在的池子的当前流动性：没有流动性的不报价；两跳的每一跳只留流动性最大的几个档位（同一对代币的流动性可以直接比）
  const found = legs.flatMap((l, i) => (pools[i] && BigInt(pools[i] as string) !== 0n ? [{ ...l, pool: pools[i] as string }] : []))
  const liquidity = found.length ? await ctx.provider.tryAll<bigint>(found.map((l) => ctx.provider.contract(l.pool, v3PoolInterface).liquidity()), overrides) : []
  const live = found.map((l, i) => ({ ...l, liquidity: liquidity[i] ?? 0n })).filter((l) => l.liquidity > 0n)
  const legKey = (l: { p: LpProtocol; a: string; b: string }) => `${l.p.id}:${l.a}:${l.b}`
  const byLeg = new Map<string, typeof live>()
  for (const l of live) byLeg.set(legKey(l), [...(byLeg.get(legKey(l)) ?? []), l])
  const exists = new Set<string>()
  for (const [key, list] of byLeg) {
    const direct = key.endsWith(`:${tokenIn}:${tokenOut}`)
    const kept = direct ? list : [...list].sort((x, y) => (x.liquidity < y.liquidity ? 1 : x.liquidity > y.liquidity ? -1 : 0)).slice(0, TIERS_PER_LEG)
    for (const l of kept) exists.add(`${l.p.id}:${l.a}:${l.b}:${l.fee}`)
  }
  const has = (p: LpProtocol, a: string, b: string, fee: number) => exists.has(`${p.id}:${a}:${b}:${fee}`)

  const candidates: Candidate[] = []
  for (const p of protocols) {
    if (p.version === 'v2') {
      const router = p.router as string
      candidates.push({ protocol: p, version: 'v2', path: [tokenIn, tokenOut], fees: [], router })
      for (const m of mids) candidates.push({ protocol: p, version: 'v2', path: [tokenIn, m, tokenOut], fees: [], router })
      continue
    }
    const c = V3_SWAP_CONTRACTS[p.id]?.[ctx.chainId] as { quoter: string; router: string }
    for (const fee of V3_FEES) {
      if (has(p, tokenIn, tokenOut, fee)) candidates.push({ protocol: p, version: 'v3', path: [tokenIn, tokenOut], fees: [fee], router: c.router, quoter: c.quoter })
    }
    for (const m of mids) {
      for (const f1 of V3_FEES) {
        if (!has(p, tokenIn, m, f1)) continue
        for (const f2 of V3_FEES) {
          if (has(p, m, tokenOut, f2)) candidates.push({ protocol: p, version: 'v3', path: [tokenIn, m, tokenOut], fees: [f1, f2], router: c.router, quoter: c.quoter })
        }
      }
    }
  }
  // V2 的 getAmountsOut 很便宜，一次报完；V3 每 QUOTES_PER_CALL 个一组并发
  const v2Index = candidates.flatMap((c, i) => (c.version === 'v2' ? [i] : []))
  const v3Index = candidates.flatMap((c, i) => (c.version === 'v3' ? [i] : []))
  const groups = [v2Index, ...Array.from({ length: Math.ceil(v3Index.length / QUOTES_PER_CALL) }, (_, k) => v3Index.slice(k * QUOTES_PER_CALL, (k + 1) * QUOTES_PER_CALL))].filter((g) => g.length)
  const quotes: unknown[] = new Array(candidates.length).fill(null)
  await Promise.all(
    groups.map(async (group) => {
      const results = await ctx.provider.tryAll(
        group.map((i) => quoteCall(ctx, candidates[i] as Candidate, amountIn)),
        overrides,
      )
      group.forEach((i, k) => (quotes[i] = results[k]))
    }),
  )
  return candidates
    .map((c, i) => ({ ...c, amountOut: amountOf(c, quotes[i]) }))
    .filter((c) => c.amountOut > 0n)
    .sort((a, b) => (a.amountOut < b.amountOut ? 1 : a.amountOut > b.amountOut ? -1 : 0))
}

function quoteCall(ctx: Ctx, c: Candidate, amountIn: bigint) {
  if (c.version === 'v2') return ctx.provider.contract(c.router, v2RouterInterface).getAmountsOut(amountIn, c.path)
  const quoter = ctx.provider.contract(c.quoter as string, quoterInterface)
  return c.path.length === 2
    ? quoter.quoteExactInputSingle({ tokenIn: c.path[0], tokenOut: c.path[1], amountIn, fee: c.fees[0], sqrtPriceLimitX96: 0n })
    : quoter.quoteExactInput(encodePath(c.path, c.fees), amountIn)
}

function amountOf(c: Candidate, result: unknown): bigint {
  if (result === null || result === undefined) return 0n
  if (c.version === 'v2') {
    const amounts = result as readonly bigint[]
    return amounts.length === c.path.length ? (amounts[amounts.length - 1] as bigint) : 0n
  }
  return (result as { 0: bigint })[0] ?? 0n
}

/**
 * 报价并构建兑换的交易（不签名）：选输出最多的路线，最少收到 = 报价 × (1 − slippage)；卖出代币时额度不够先授权给 Router。
 *
 * ```ts
 * const plan = await buildSwap(provider, user, { tokenIn: NATIVE_TOKEN, tokenOut: USDT, amountInFormatted: '0.1' })
 * plan.amountOutFormatted   // '61.2'
 * plan.route                // { protocol: 'pancakeswap-v3', path: [WBNB, USDT], fees: [100], … }
 * ```
 */
export async function buildSwap(provider: Provider, owner: string, params: SwapParams, options: SwapOptions = {}): Promise<SwapPlan> {
  const { slippage, deadline, recipient, approve } = options
  const ctx = await createCtx(provider, owner, { slippage, deadline, recipient, approve: approve === 'max' ? 'max' : 'exact' })
  const wrapped = LP_QUOTE_TOKENS[ctx.chainId]?.[0]
  const nativeIn = isNative(ctx, params.tokenIn)
  const nativeOut = isNative(ctx, params.tokenOut)
  if ((nativeIn || nativeOut) && !wrapped) throw new Error(`No wrapped native token known on chain ${ctx.chainId}`)
  const tokenIn = nativeIn ? evm(wrapped as string) : evm(params.tokenIn)
  const tokenOut = nativeOut ? evm(wrapped as string) : evm(params.tokenOut)
  if (same(tokenIn, tokenOut)) throw new Error(nativeIn || nativeOut ? 'Wrapping / unwrapping the native token is not a swap; use the wrapped token contract' : 'tokenIn and tokenOut are the same')
  const [infoIn, infoOut] = await tokenInfo(ctx, [nativeIn ? params.tokenIn : tokenIn, nativeOut ? params.tokenOut : tokenOut])
  const tIn = infoIn as LpToken
  const tOut = infoOut as LpToken
  const amountIn = parseAmount(params.amountIn, params.amountInFormatted, tIn, 'amountIn')
  if (amountIn === undefined || amountIn <= 0n) throw new Error('amountIn must be greater than 0')

  const all = await quoteRoutes(ctx, tokenIn, tokenOut, amountIn, options)
  const wanted = options.route
  const routes = wanted
    ? all.filter((c) => c.protocol.id === wanted.protocol && c.path.length === wanted.path.length && c.path.every((a, i) => same(a, wanted.path[i] as string)) && c.fees.join() === wanted.fees.join())
    : all
  const best = routes[0]
  if (!best) throw new Error(wanted ? 'The given route has no quote (pool missing or no liquidity)' : 'No route found: no pool for this pair (directly or through the intermediate tokens) in the built-in protocols')
  // 价格影响：同一路线卖出极小的数量（1 / 10000）的价格
  const small = amountIn / 10_000n
  const smallOut = small > 0n ? amountOf(best, await provider.tryAll([quoteCall(ctx, best, small)], options.blockTag === undefined ? undefined : { blockTag: options.blockTag }).then((r) => r[0])) : 0n
  // 参考交易的输出太小时取整误差太大（几个最小单位就差好几个百分点），算不准，返回 null
  const priceImpact = smallOut >= 10_000n ? Math.max(0, 1 - Number(best.amountOut) / Number(amountIn) / (Number(smallOut) / Number(small))) : null
  const tax = options.tax ?? 0
  if (!(tax >= 0 && tax < 1)) throw new RangeError(`tax must be in [0, 1): ${tax}`)
  const keep = best.version === 'v2' ? 1 - tax : 1
  const amountOutMin = minus((best.amountOut * BigInt(Math.round(keep * 1_000_000))) / 1_000_000n, ctx.slippage)

  // approvals 只会返回 kind 为 'approve' 的交易
  // Router 在 Tron 上是 T 地址：授权的 ABI 参数要用 0x 格式
  const transactions = (nativeIn ? [] : await approvals(ctx, [{ token: tokenIn, spender: evm(best.router), amount: amountIn }])) as SwapTx[]
  let approval: SwapApproval | undefined
  const requested = options.approve
  if (requested === 'permit' || requested === 'permit2' || requested === 'auto') {
    approval = await decideApproval(ctx, requested, best, tokenIn, amountIn, nativeIn, transactions.some((t) => t.kind === 'approve'), options)
  }
  let permitCall: string | undefined
  if (options.signedPermit && approval?.method === 'permit') {
    permitCall = applySignedPermit(options.signedPermit, approval, ctx, transactions)
  }
  transactions.push(swapTx(ctx, best, amountIn, amountOutMin, nativeIn, nativeOut, permitCall))

  const route = (c: Candidate & { amountOut: bigint }): SwapRoute => ({
    protocol: c.protocol.id,
    protocolName: c.protocol.name,
    version: c.version,
    path: c.path.map((a) => out(ctx, a)),
    fees: c.fees,
    amountOut: c.amountOut.toString(),
  })
  const decimals = (t: LpToken) => t.decimals ?? 0
  return {
    tokenIn: tIn,
    tokenOut: tOut,
    amountIn: amountIn.toString(),
    amountInFormatted: fmt(amountIn, tIn),
    amountOut: best.amountOut.toString(),
    amountOutFormatted: fmt(best.amountOut, tOut),
    amountOutMin: amountOutMin.toString(),
    amountOutMinFormatted: fmt(amountOutMin, tOut),
    price: tIn.decimals === null || tOut.decimals === null ? null : Number(best.amountOut) / 10 ** decimals(tOut) / (Number(amountIn) / 10 ** decimals(tIn)),
    priceImpact,
    route: route(best),
    routes: routes.map(route),
    transactions,
    ...(approval ? { approval } : {}),
  }
}

/** permit / permit2 / auto：判断这条路线和这个代币能不能用签名代替授权交易，不能的退回普通授权并写明原因 */
async function decideApproval(ctx: Ctx, requested: SwapApproval['requested'], best: Candidate, tokenIn: string, amountIn: bigint, nativeIn: boolean, needsApprove: boolean, options: SwapOptions): Promise<SwapApproval> {
  if (nativeIn || !needsApprove) return { requested, method: 'none' }
  const fallback = (reason: string): SwapApproval => ({ requested, method: 'approve', reason })
  if (requested === 'permit2') {
    return fallback('The built-in V2 / V3 routers pull tokens with transferFrom and do not consume Permit2 signatures; used a normal exact approve')
  }
  if (ctx.tron) return fallback('permit is not available on Tron; used a normal approve')
  const { detectPermit } = await import('./permit.js')
  const support = await detectPermit(ctx.provider, tokenIn)
  if (!support.kind) return fallback(`${support.reason}; used a normal approve`)
  if (support.kind === 'dai') return fallback('A DAI-style permit can only grant an unlimited allowance; used a normal exact approve')
  const via = best.version === 'v3' ? 'selfPermit' : 'batch'
  if (via === 'batch' && !options.atomic) {
    return fallback("V2 routers have no selfPermit, so a separate permit() transaction saves nothing; use mode '7702' / '4337' / '5792' to send the permit and the swap atomically. Used a normal approve")
  }
  return { requested, method: 'permit', via, permit: { token: tokenIn, spender: evm(best.router), value: amountIn.toString(), deadline: ctx.deadline } }
}

/** 已签名的 permit 放进交易：V3 返回 selfPermit 的 calldata（嵌进 multicall），V2 往 transactions 里加一笔 permit 交易 */
function applySignedPermit(signed: SignedPermit, approval: SwapApproval, ctx: Ctx, transactions: SwapTx[]): string | undefined {
  const want = approval.permit as NonNullable<SwapApproval['permit']>
  const p = signed.permit
  if (p.kind !== 'eip2612' || getAddress(p.tokens[0] as string) !== getAddress(want.token) || getAddress(p.spender) !== getAddress(want.spender) || p.owner !== ctx.owner || BigInt(p.amounts[0] as string) !== BigInt(want.value)) {
    throw new Error('The signed permit does not match the swap (token / spender / owner / amount)')
  }
  // 授权交易换成 permit
  const at = transactions.findIndex((t) => t.kind === 'approve')
  transactions.splice(at, transactions.length)
  if (approval.via === 'selfPermit') {
    return swapRouterInterface.encodeFunctionData('selfPermitIfNecessary', [want.token, want.value, p.deadline, signed.v, signed.r, signed.s])
  }
  const m = p.typedData.message
  const data = permitInterface.encodeFunctionData('permit', [m.owner, m.spender, m.value, m.deadline, signed.v, signed.r, signed.s])
  transactions.push({ kind: 'permit', to: out(ctx, want.token), data, value: '0', token: out(ctx, want.token), spender: out(ctx, want.spender), amount: want.value })
  return undefined
}

function swapTx(ctx: Ctx, c: Candidate, amountIn: bigint, amountOutMin: bigint, nativeIn: boolean, nativeOut: boolean, selfPermit?: string): SwapTx {
  const value = nativeIn ? amountIn.toString() : '0'
  if (c.version === 'v2') {
    const data = nativeIn
      ? v2RouterInterface.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens', [amountOutMin, c.path, ctx.recipient, ctx.deadline])
      : nativeOut
        ? v2RouterInterface.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens', [amountIn, amountOutMin, c.path, ctx.recipient, ctx.deadline])
        : v2RouterInterface.encodeFunctionData('swapExactTokensForTokensSupportingFeeOnTransferTokens', [amountIn, amountOutMin, c.path, ctx.recipient, ctx.deadline])
    return { kind: 'swap', to: out(ctx, c.router), data, value }
  }
  // V3：卖出主币时附带 value（Router 自动包装）；买入主币时先收到 Router，再 unwrapWETH9 给收款地址
  const recipient = nativeOut ? ADDRESS_THIS : ctx.recipient
  const swap =
    c.path.length === 2
      ? swapRouterInterface.encodeFunctionData('exactInputSingle', [
          { tokenIn: c.path[0], tokenOut: c.path[1], fee: c.fees[0], recipient, amountIn, amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0n },
        ])
      : swapRouterInterface.encodeFunctionData('exactInput', [{ path: encodePath(c.path, c.fees), recipient, amountIn, amountOutMinimum: amountOutMin }])
  const calls = [...(selfPermit ? [selfPermit] : []), swap, ...(nativeOut ? [swapRouterInterface.encodeFunctionData('unwrapWETH9', [amountOutMin, ctx.recipient])] : [])]
  return { kind: 'swap', to: out(ctx, c.router), data: swapRouterInterface.encodeFunctionData('multicall', [ctx.deadline, calls]), value }
}

export type SwapTxResult = Omit<LiquidityTxResult, 'kind'> & { kind: SwapTx['kind'] }

export interface SwapResult {
  plan: SwapPlan
  /** 每笔交易的结果（授权 / permit、兑换） */
  results: SwapTxResult[]
  /** 兑换那一笔的状态和哈希 */
  status: LiquidityTxResult['status']
  hash: string | null
  /** 请求 permit / permit2 / auto 时：实际采用的授权方式（同 plan.approval，退回普通授权时有原因） */
  approval?: SwapApproval
}

export interface SwapSendOptions extends SwapOptions, Omit<BatchCallOptions, 'mode' | 'continueOnError' | 'onUpdate'> {
  /**
   * 发送方式：'tx'（默认，授权和兑换分别发，授权确认后重新报价）；
   * '7702' / '4337' / '5792'：授权（或 permit）和兑换放进同一笔原子批量，见 BatchCallOptions.mode
   */
  mode?: 'tx' | '7702' | '4337' | '5792'
  onUpdate?: (result: SwapTxResult) => void
}

/**
 * 兑换：构建（同 buildSwap）后用 from 签名发送（钱包同 /write：私钥、ethers Signer、浏览器钱包、Tron 钱包）。
 * 授权失败时不发兑换的交易
 *
 * ```ts
 * const r = await swap(provider, key, { tokenIn: USDT, tokenOut: NATIVE_TOKEN, amountInFormatted: '100' }, { slippage: 0.01 })
 * r.status   // 'confirmed'
 *
 * // 用 EIP-2612 签名代替授权交易（V3 路线一笔交易完成；不支持时退回普通授权，r.approval.reason 说明原因）
 * await swap(provider, signer, params, { approve: 'auto' })
 * ```
 */
export async function swap(provider: Provider, from: SignerInput, params: SwapParams, options: SwapSendOptions = {}): Promise<SwapResult> {
  const [{ batchCall, tronModule }, { resolveSigner }, { emptyOutcome, toWriteResult }] = await Promise.all([import('./write/batch.js'), import('./write/signer.js'), import('./write/send.js')])
  const tron = await tronModule(provider)
  const resolved = tron ? null : await resolveSigner(from)
  const owner = tron ? await tron.tronSignerAddress(from) : (resolved as NonNullable<typeof resolved>).address
  const mode = options.mode ?? 'tx'
  const atomic = mode !== 'tx'
  // 4337 的 SimpleAccount：资产在账户地址里，兑换的 owner 是账户（合约账户不能签 EIP-2612，不用 permit）
  let holder = owner
  let smartHolder = false
  if (mode === '4337' && (options.smartAccount?.account ?? 'simple') === 'simple') {
    const [{ resolveSimpleAccount }, { WriteRpc }] = await Promise.all([import('./smartAccount/account.js'), import('./write/rpc.js')])
    const sa = options.smartAccount
    holder = (await resolveSimpleAccount(await WriteRpc.from(provider), owner, sa?.entryPoint ?? '0.7', sa?.salt, sa?.factory)).address
    smartHolder = true
  }
  const wantsPermit = options.approve === 'permit' || options.approve === 'permit2' || options.approve === 'auto'
  let plan = await buildSwap(provider, holder, params, { ...options, atomic, ...(smartHolder && wantsPermit ? { approve: 'exact' as const } : {}) })
  if (smartHolder && wantsPermit && plan.transactions.length > 1) {
    plan.approval = { requested: options.approve as 'permit', method: 'approve', reason: 'The 4337 smart account is a contract and cannot sign EIP-2612 permits; used a normal approve' }
  }
  if (plan.approval?.method === 'permit' && resolved) {
    // 签 permit：精确的卖出数量、有效期与兑换的 deadline 相同；用户拒绝签名就整体中止（不悄悄改成发授权交易）
    const { buildPermit, signPermit } = await import('./permit.js')
    const want = plan.approval.permit as NonNullable<SwapApproval['permit']>
    const permit = await buildPermit(provider, { token: want.token, owner: holder, spender: want.spender, value: want.value }, { deadlineAt: want.deadline })
    const signed = await signPermit(resolved.signer as Parameters<typeof signPermit>[0], permit, { chainId: await provider.getChainId() })
    try {
      plan = await buildSwap(provider, holder, params, { ...options, atomic, signedPermit: signed })
    } catch (err) {
      // 签名后重新报价，最优路线变了（路由 / 版本 / 数量不同），签名对不上：改用普通授权，不让已经签过的请求白白中止
      if (!/signed permit does not match/.test(err instanceof Error ? err.message : String(err))) throw err
      plan = await buildSwap(provider, holder, params, { ...options, atomic, approve: 'exact' })
      if (plan.approval) plan.approval = { ...plan.approval, requested: options.approve as 'permit', method: 'approve', reason: 'The best route changed after the permit was signed; used a normal approve' }
    }
  }
  const send = async (txs: SwapTx[], asMode: 'tx' | 'atomic' = 'tx'): Promise<SwapTxResult[]> =>
    (
      await batchCall(
        provider,
        txs.map((tx) => ({ from, to: tx.to, data: tx.data, value: BigInt(tx.value) })),
        {
          ...options,
          mode: asMode === 'atomic' ? mode : 'tx',
          continueOnError: false,
          onUpdate: options.onUpdate ? (r) => options.onUpdate?.({ ...r, kind: (txs[r.index] as SwapTx).kind }) : undefined,
        },
      )
    ).map((r, i) => ({ ...r, kind: (txs[i] as SwapTx).kind }))
  const txs = plan.transactions
  let results: SwapTxResult[]
  if (atomic) {
    // 授权 / permit 和兑换在同一笔原子批量里：要么都成功，要么都不生效
    results = await send(txs, 'atomic')
  } else if (txs.length === 1) {
    results = await send(txs)
  } else {
    // 有授权时先发授权：确认后重新报价再发兑换，deadline 和最少收到从发兑换那一刻算，
    // 不会因为授权等得久而过期或按旧价成交
    const approved = await send(txs.slice(0, -1))
    const last = txs[txs.length - 1] as SwapTx
    const approval = plan.approval
    if (approved.every((r) => r.status === 'confirmed')) {
      plan = await buildSwap(provider, holder, params, { ...options, approve: options.approve === 'max' ? 'max' : 'exact' })
      if (approval) plan.approval = approval // 重新报价时额度已够：保留最初的选择和原因
      const fresh = plan.transactions[plan.transactions.length - 1] as SwapTx
      results = [...approved, ...(await send([fresh])).map((r) => ({ ...r, index: txs.length - 1 }))]
    } else {
      results = [...approved, { ...toWriteResult(txs.length - 1, owner, last.to, emptyOutcome('skipped', 'skipped: the approval did not succeed')), kind: last.kind }]
    }
  }
  const main = results[results.length - 1] as SwapTxResult
  return { plan, results, status: main.status, hash: main.hash, ...(plan.approval ? { approval: plan.approval } : {}) }
}
