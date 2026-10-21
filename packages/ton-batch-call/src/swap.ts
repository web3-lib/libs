/**
 * 兑换（子路径 `@w3lib/ton-batch-call/swap`）：在 STON.fi v2 / v1、DeDust（volatile）的池子里找路线（直接兑换，或经过 TON / USD₮ 的两跳），
 * 报价选输出最多的，按滑点算最少收到的数量，构建并发送兑换的消息。消息格式与 @ston-fi/sdk 2.7 / @dedust/sdk 0.8 相同；
 * 发送走 `/write` 的流程（先模拟整条交易链，再发送、等结果）
 */
import { slippagePpm, withSlippageDown } from './slippage.js'
import { isValidTonAddress, toFriendlyAddress, toRawAddress } from './address.js'
import type { TonClient } from './client.js'
import { NATIVE_TON, TON_DECIMALS } from './constants.js'
import { formatUnits, parseUnits } from './format.js'
import { runGetMethod } from './getters.js'
import { DEDUST_FACTORY, PTON_V1_MASTER, PTON_V2_MASTER, STONFI_V1_ROUTER, TON_LP_PROTOCOLS, dedustAsset, dedustAssetCell, type TonLpProtocol, type TonLpToken } from './lp.js'
import { INFINITE, cached, dedustPoolAddress, orNull, routerType, routerWallets, stonfiMaster, stonfiPoolAddress, stonfiRouters, type PoolEnv, type RouterWallet } from './pools.js'
import { TON_USDT } from './price.js'
import { Cell, beginCell } from './write/cell.js'
import { jettonTransferBody } from './write/message.js'
import type { SendMessage, SendOptions, Trace, WriteResult } from './write/send.js'
import type { TonSignerInput } from './write/signer.js'

const nano = (ton: string) => parseUnits(ton, TON_DECIMALS)

/** 各种兑换附带的 TON（多余的退回）；直接兑换与官方 SDK 的默认值相同，两跳每多一跳多带 hop */
export const SWAP_GAS = {
  /** STON.fi v2：Jetton 卖出的转账 / forward；TON 卖出的 forward 和 pTON 的手续费 */
  stonfiJetton: nano('0.3'),
  stonfiJettonForward: nano('0.24'),
  stonfiTonForward: nano('0.3'),
  stonfiPtonFee: nano('0.01'),
  /** STON.fi v1：Jetton → Jetton、Jetton → TON 的转账 / forward；TON 卖出的 forward */
  stonfiV1JettonToJetton: nano('0.22'),
  stonfiV1JettonToJettonForward: nano('0.175'),
  stonfiV1JettonToTon: nano('0.17'),
  stonfiV1JettonToTonForward: nano('0.125'),
  stonfiV1TonForward: nano('0.185'),
  /** DeDust：TON 卖出的 gas；Jetton 卖出的转账 / forward */
  dedustNative: nano('0.2'),
  dedustJetton: nano('0.3'),
  dedustJettonForward: nano('0.25'),
  /** 两跳时多带的（STON.fi 的 cross_swap、DeDust 的下一步） */
  hop: nano('0.1'),
} as const

const OP = {
  stonfiSwap: 0x6664de2a,
  stonfiCrossSwap: 0x69cf1a5b,
  stonfiV1Swap: 0x25938561,
  ptonTransfer: 0x01f3835d,
  dedustSwapNative: 0xea06185d,
  dedustSwapJetton: 0xe3a0d482,
  internalTransfer: 0x178d4519,
  transferNotification: 0x7362d09c,
  dedustPayoutFromPool: 0xad4eb6f5,
  dedustPayout: 0x474f86cf,
}

/** STON.fi v2 的手续费分母（lp_fee、protocol_fee 是万分之几） */
const FEE_DIVIDER = 10_000n

export interface SwapParams {
  /** 卖出 / 买入的代币：NATIVE_TON 或 Jetton 主合约地址（任意格式） */
  tokenIn: string
  tokenOut: string
  /** 卖出的数量：amountIn（最小单位）和 amountInFormatted（按精度换算，如 '1.5'）二选一 */
  amountIn?: bigint | string | number
  amountInFormatted?: string
}

export interface SwapOptions {
  /** 价格滑点（比例，0.005 = 0.5%），最少收到 = 报价 × (1 − slippage)，默认 0.005 */
  slippage?: number
  /** 兑换的有效期（秒，DEX 合约检查），默认 900（与 STON.fi SDK 相同） */
  deadline?: number
  /** 收到代币的地址，默认 owner */
  recipient?: string
  /** 只用这些协议，默认 ['stonfi-v2', 'stonfi-v1', 'dedust'] */
  protocols?: readonly TonLpProtocol[]
  /** 两跳的中间代币，默认 [NATIVE_TON, TON_USDT]；传 [] 只找直接兑换 */
  intermediates?: readonly string[]
  /** 额外认可的 STON.fi v2 router（与 lpPositions 的同名选项相同） */
  stonfiRouters?: readonly string[]
  /** 指定路线（如之前报价结果 routes 里的某一条）：只用这条路线报价和兑换，不选最好的 */
  route?: Pick<TonSwapRoute, 'protocol' | 'path' | 'pools'>
  signal?: AbortSignal
}

export interface TonSwapRoute {
  protocol: TonLpProtocol
  protocolName: string
  /** 经过的代币：'TON' 或 Jetton 主合约（用户友好格式） */
  path: string[]
  /** 每一跳的池子 */
  pools: string[]
  /** STON.fi：每一跳的 router（两跳可以在不同的 router 上）；DeDust 为空 */
  routers: string[]
  /** 这条路线的报价（最小单位） */
  amountOut: string
}

export interface TonSwapPlan {
  tokenIn: TonLpToken
  tokenOut: TonLpToken
  amountIn: string
  amountInFormatted: string
  /** 报价（最小单位）和最少收到的数量（按滑点，合约按它检查，不够时退款） */
  amountOut: string
  amountOutFormatted: string
  amountOutMin: string
  amountOutMinFormatted: string
  /** 1 个 tokenIn 换多少 tokenOut（按这笔的数量） */
  price: number | null
  /** 价格影响（0~1）：这笔的价格比极小数量的价格差多少；算不出时为 null */
  priceImpact: number | null
  route: TonSwapRoute
  /** 所有报到价的路线，从高到低（含选中的） */
  routes: TonSwapRoute[]
  /** 收到代币的地址（用户友好格式） */
  recipient: string
  /** 钱包要发的消息（一笔交易），可以交给 batchCall 或 TON Connect */
  messages: Array<{ to: string; value: string; body: string; bounce: boolean }>
  /** 附带的 TON 合计（含卖出的 TON 和 gas，多余的 gas 退回） */
  tonAttached: string
}

interface Env extends PoolEnv {
  protocols: ReadonlySet<TonLpProtocol>
}

/** 一条候选路线：path 是原始地址（TON 为 NATIVE_TON），pools[k] 是 path[k] → path[k + 1] 的池子 */
interface Candidate {
  protocol: TonLpProtocol
  path: string[]
  pools: string[]
  /** STON.fi：每一跳的 router 和它的 Jetton 钱包 [卖出的一侧, 买入的一侧]（TON 是 router 的 pTON 钱包）；DeDust 为空 */
  routers: string[]
  wallets: Array<[string, string]>
}

type Quoted = Candidate & { amountOut: bigint; quote: (amount: bigint) => Promise<bigint | null> }

interface StonfiHop {
  router: string
  pool: string
  wallets: [string, string]
}

/**
 * STON.fi 的候选路线。每一对代币：v1 有就用；v2 看排名之和（两个代币在这个 router 的 Jetton 钱包余额各排第几）最前的两个 router，
 * 加上两个代币各自余额最多的 router（同一对代币常在多个 router 上都有池子，有的是空的），只用 constant_product 的，最多 3 个。
 * 两跳只用 v2：经过 TON 时两跳可以在不同的 router 上，经过 Jetton 时要在同一个 router 上（每种组合都报价，选输出最多的）
 */
async function stonfiCandidates(env: Env, paths: readonly string[][]): Promise<Candidate[]> {
  const v1 = env.protocols.has('stonfi-v1')
  const v2 = env.protocols.has('stonfi-v2')
  if (!v1 && !v2) return []
  const tokens = [...new Set(paths.flat())]
  const masters = [...new Set(tokens.flatMap((t) => (t === NATIVE_TON ? [...(v1 ? [PTON_V1_MASTER] : []), ...(v2 ? [PTON_V2_MASTER] : [])] : [t])))]
  const lists: RouterWallet[][] = []
  for (const m of masters) lists.push(await routerWallets(env, m))
  const byMaster = new Map(masters.map((m, i) => [m, lists[i] as RouterWallet[]]))
  const walletOn = (t: string, router: string) => {
    const list = byMaster.get(stonfiMaster(t, router)) ?? []
    const rank = list.findIndex((w) => w.router === router && w.balance > 0n)
    return rank < 0 ? null : { wallet: (list[rank] as RouterWallet).wallet, rank }
  }
  const routers = [...new Set(lists.flat().map((w) => w.router))]
  const hopCache = new Map<string, Promise<StonfiHop[]>>()
  const hops = (x: string, y: string): Promise<StonfiHop[]> => {
    const key = `${x}>${y}`
    let hit = hopCache.get(key)
    if (!hit) {
      hit = (async () => {
        const ranked = routers
          .filter((r) => (r === STONFI_V1_ROUTER ? v1 : v2) && walletOn(x, r) && walletOn(y, r))
          .map((r) => ({ r, score: (walletOn(x, r)?.rank ?? 0) + (walletOn(y, r)?.rank ?? 0) }))
          .sort((p, q) => p.score - q.score)
        const picks = ranked.filter((z) => z.r === STONFI_V1_ROUTER).map((z) => z.r)
        const v2Routers = ranked.filter((z) => z.r !== STONFI_V1_ROUTER).map((z) => z.r)
        const deepest = [x, y].map((t) => [...v2Routers].sort((p, q) => (walletOn(t, p)?.rank ?? 0) - (walletOn(t, q)?.rank ?? 0))[0])
        let count = 0
        for (const r of new Set([...v2Routers.slice(0, 2), ...deepest].filter((r): r is string => !!r))) {
          if (count >= 3) break
          if ((await routerType(env, r)) === 'constant_product') {
            picks.push(r)
            count++
          }
        }
        const out: StonfiHop[] = []
        for (const router of picks) {
          const wallets: [string, string] = [(walletOn(x, router) as { wallet: string }).wallet, (walletOn(y, router) as { wallet: string }).wallet]
          const pool = await stonfiPoolAddress(env, router, wallets[0], wallets[1])
          if (pool) out.push({ router, pool, wallets })
        }
        return out
      })()
      hopCache.set(key, hit)
    }
    return hit
  }
  const out: Candidate[] = []
  for (const path of paths) {
    if (path.length === 2) {
      for (const h of await hops(path[0] as string, path[1] as string)) out.push({ protocol: h.router === STONFI_V1_ROUTER ? 'stonfi-v1' : 'stonfi-v2', path, pools: [h.pool], routers: [h.router], wallets: [h.wallets] })
      continue
    }
    const first = (await hops(path[0] as string, path[1] as string)).filter((h) => h.router !== STONFI_V1_ROUTER)
    const second = first.length ? (await hops(path[1] as string, path[2] as string)).filter((h) => h.router !== STONFI_V1_ROUTER) : []
    // 不同的 router 之间只经过 TON 转（第一跳的输出由 pTON 钱包 ton_transfer 给第二个 router 的 pTON 钱包，已在主网模拟核对）；
    // 经过 Jetton 时只用同一个 router 的 cross_swap
    for (const h1 of first) {
      for (const h2 of second) {
        if (h1.router !== h2.router && path[1] !== NATIVE_TON) continue
        out.push({ protocol: 'stonfi-v2', path, pools: [h1.pool, h2.pool], routers: [h1.router, h2.router], wallets: [h1.wallets, h2.wallets] })
      }
    }
  }
  return out
}

async function dedustCandidates(env: Env, paths: readonly string[][]): Promise<Candidate[]> {
  if (!env.protocols.has('dedust')) return []
  const out: Candidate[] = []
  for (const path of paths) {
    const pools: string[] = []
    for (let k = 0; k + 1 < path.length; k++) {
      const pool = await dedustPoolAddress(env, path[k] as string, path[k + 1] as string)
      if (!pool) break
      pools.push(pool)
    }
    if (pools.length === path.length - 1) out.push({ protocol: 'dedust', path, pools, routers: [], wallets: [] })
  }
  return out
}

interface V2Pool {
  locked: boolean
  router: string | null
  totalSupply: bigint
  reserve0: bigint
  reserve1: bigint
  wallet0: string | null
  wallet1: string | null
  lpFee: bigint
  protocolFee: bigint
}

/** STON.fi v2 constant_product 池子的输出（与合约的 get_swap_out 相同，没有推荐人时不收推荐费） */
export function stonfiV2SwapOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, lpFee: bigint, protocolFee: bigint): bigint {
  const withFee = amountIn * (FEE_DIVIDER - lpFee)
  const base = (withFee * reserveOut) / (reserveIn * FEE_DIVIDER + withFee)
  const protocolOut = protocolFee > 0n ? (base * protocolFee + FEE_DIVIDER - 1n) / FEE_DIVIDER : 0n
  return base - protocolOut
}

/**
 * 每一跳的报价函数：STON.fi v2 读一次 get_pool_data 后按合约公式本地算（池子没有报价的 get 方法）；
 * STON.fi v1 用池子的 get_expected_outputs，DeDust 用池子的 estimate_swap_out（每次报价一次 get 方法）
 */
function hopQuoter(env: Env, c: Candidate, k: number, v2Data: Map<string, Promise<V2Pool | null>>): (amount: bigint) => Promise<bigint | null> {
  const t = env.client.transport
  const opts = { signal: env.signal }
  const pool = c.pools[k] as string
  if (c.protocol === 'stonfi-v2') {
    let data = v2Data.get(pool)
    if (!data) {
      data = orNull(
        env,
        runGetMethod(t, pool, 'get_pool_data', [], opts).then((s): V2Pool => ({ locked: s.num() !== 0n, router: s.address(), totalSupply: s.num(), reserve0: s.num(), reserve1: s.num(), wallet0: s.address(), wallet1: s.address(), lpFee: s.num(), protocolFee: s.num() })),
      )
      v2Data.set(pool, data)
    }
    const [walletIn] = c.wallets[k] as [string, string]
    const router = c.routers[k]
    return async (amount) => {
      const p = await data
      if (!p || p.locked || p.router !== router || p.totalSupply <= 0n) return null
      const [rIn, rOut] = p.wallet0 === walletIn ? [p.reserve0, p.reserve1] : p.wallet1 === walletIn ? [p.reserve1, p.reserve0] : [0n, 0n]
      if (rIn <= 0n || rOut <= 0n) return null
      const out = stonfiV2SwapOut(amount, rIn, rOut, p.lpFee, p.protocolFee)
      return out >= 1n && out < rOut ? out : null
    }
  }
  if (c.protocol === 'stonfi-v1') {
    return (amount) => orNull(env, runGetMethod(t, pool, 'get_expected_outputs', [{ type: 'num', value: amount }, { type: 'address', address: (c.wallets[k] as [string, string])[0] }], opts).then((s) => s.num())).then((out) => (out !== null && out > 0n ? out : null))
  }
  const assetIn = dedustAssetCell(c.path[k] as string)
  const next = c.path[k + 1] as string
  return (amount) =>
    orNull(
      env,
      runGetMethod(t, pool, 'estimate_swap_out', [{ type: 'slice', cell: assetIn }, { type: 'num', value: amount }], opts).then((s) => (dedustAsset(s.cell()) === next ? s.num() : null)),
    ).then((out) => (out !== null && out > 0n ? out : null))
}

/** 列出候选路线，没部署的池子不报价（一次 accountStates），按输出从高到低 */
async function quoteRoutes(env: Env, tokenIn: string, tokenOut: string, amountIn: bigint, mids: readonly string[]): Promise<Quoted[]> {
  const paths = [[tokenIn, tokenOut], ...mids.map((m) => [tokenIn, m, tokenOut])]
  const candidates = [...(await stonfiCandidates(env, paths)), ...(await dedustCandidates(env, paths))]
  if (!candidates.length) return []
  const pools = [...new Set(candidates.flatMap((c) => c.pools))]
  const states = await env.client.tonBalances(pools, { signal: env.signal })
  const active = new Set(pools.filter((_, i) => states[i]?.status === 'active'))
  const v2Data = new Map<string, Promise<V2Pool | null>>()
  const live = candidates.filter((c) => c.pools.every((p) => active.has(p)))
  const quoted = await Promise.all(
    live.map(async (c): Promise<Quoted | null> => {
      const hops = c.pools.map((_, k) => hopQuoter(env, c, k, v2Data))
      const quote = async (amount: bigint) => {
        let x: bigint | null = amount
        for (const hop of hops) {
          if (x === null) return null
          x = await hop(x)
        }
        return x
      }
      const amountOut = await quote(amountIn)
      return amountOut === null ? null : { ...c, amountOut, quote }
    }),
  )
  return quoted.filter((q): q is Quoted => q !== null).sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0))
}

/** 两跳的多个 router 组合只留输出最多的那个（routes 已按输出排好） */
function dedupe(routes: readonly Quoted[]): Quoted[] {
  const seen = new Set<string>()
  return routes.filter((q) => {
    if (q.path.length === 2) return true
    const key = `${q.protocol}:${q.path.join('>')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** DeDust 的 vault（factory 的 get_vault_address） */
function dedustVault(env: Pick<PoolEnv, 'client' | 'signal'>, token: string): Promise<string> {
  return cached(`vault:${token}`, INFINITE, async () => (await runGetMethod(env.client.transport, DEDUST_FACTORY, 'get_vault_address', [{ type: 'slice', cell: dedustAssetCell(token) }], { signal: env.signal })).address() as string)
}

/** Jetton 主合约算出 owner 的 Jetton 钱包（get_wallet_address，钱包没部署也能算） */
function jettonWalletOf(env: Pick<PoolEnv, 'client' | 'signal'>, master: string, owner: string): Promise<string> {
  return runGetMethod(env.client.transport, master, 'get_wallet_address', [{ type: 'address', address: owner }], { signal: env.signal }).then((s) => {
    const w = s.address()
    if (!w) throw new Error(`Cannot get the jetton wallet of ${toFriendlyAddress(owner)} for ${toFriendlyAddress(master)}`)
    return w
  })
}

interface BuildCtx {
  owner: string
  recipient: string
  deadline: bigint
  amountIn: bigint
  amountOutMin: bigint
  /** 卖出 Jetton 时 owner 的 Jetton 钱包 */
  ownerWallet: string | null
}

/** 构建兑换的那条消息（一笔交易里只有一条） */
async function swapMessage(env: Env, c: Quoted, ctx: BuildCtx): Promise<SendMessage> {
  const { owner, recipient, deadline, amountIn, amountOutMin } = ctx
  const tonIn = c.path[0] === NATIVE_TON
  const tonOut = c.path.at(-1) === NATIVE_TON
  const jettonIn = (to: string, value: bigint, forward: bigint, payload: Cell): SendMessage => ({
    message: { to: ctx.ownerWallet as string, value, bounce: true, body: jettonTransferBody({ amount: amountIn, destination: to, responseDestination: owner, forwardTonAmount: forward, forwardPayload: payload }) },
  })
  if (c.protocol === 'stonfi-v2') {
    const router = c.routers[0] as string
    const w0 = c.wallets[0] as [string, string]
    const w1 = c.wallets[1]
    // swap / cross_swap：ask 一侧的 router 钱包、退款和多余 TON 给 owner；min_out、收款人等放在引用里（推荐费 10 与 SDK 相同，没有推荐人时不收）
    const body = (op: number, askWallet: string, minOut: bigint, receiver: string, fwdGas: bigint, next: Cell | null) =>
      beginCell()
        .storeUint(op, 32)
        .storeAddress(askWallet)
        .storeAddress(owner)
        .storeAddress(owner)
        .storeUint(deadline, 64)
        .storeRef(beginCell().storeCoins(minOut).storeAddress(receiver).storeCoins(fwdGas).storeMaybeRef(next).storeCoins(0).storeMaybeRef(null).storeUint(10, 16).storeAddress(null))
        .endCell()
    let payload: Cell
    let forwardExtra = 0n
    if (!w1) payload = body(OP.stonfiSwap, w0[1], amountOutMin, recipient, 0n, null)
    else if (c.routers[1] === router) {
      // 同一个 router：第一跳的 custom_payload 是 cross_swap，router 收到第一跳的输出后接着换（第一跳不限最少数量，最后一跳按 amountOutMin）
      payload = body(OP.stonfiSwap, w0[1], 1n, recipient, 0n, body(OP.stonfiCrossSwap, w1[1], amountOutMin, recipient, 0n, null))
      forwardExtra = SWAP_GAS.hop
    } else {
      // 不同的 router（只经过 TON）：第一跳的输出 TON 由 pTON 钱包转给第二个 router 的 pTON 钱包，custom_payload 是第二跳的 swap，fwd_gas 付第二跳
      const fwd = SWAP_GAS.stonfiTonForward
      const second = body(OP.stonfiSwap, w1[1], amountOutMin, recipient, 0n, null)
      payload = body(OP.stonfiSwap, w0[1], 1n, w1[0], fwd, second)
      forwardExtra = SWAP_GAS.hop + fwd
    }
    if (tonIn) {
      const forward = SWAP_GAS.stonfiTonForward + forwardExtra
      const ptonBody = beginCell().storeUint(OP.ptonTransfer, 32).storeUint(0, 64).storeCoins(amountIn).storeAddress(owner).storeMaybeRef(payload).endCell()
      return { message: { to: w0[0], value: amountIn + forward + SWAP_GAS.stonfiPtonFee, bounce: true, body: ptonBody } }
    }
    return jettonIn(router, SWAP_GAS.stonfiJetton + forwardExtra, SWAP_GAS.stonfiJettonForward + forwardExtra, payload)
  }
  if (c.protocol === 'stonfi-v1') {
    const router = c.routers[0] as string
    const w0 = c.wallets[0] as [string, string]
    const payload = beginCell().storeUint(OP.stonfiV1Swap, 32).storeAddress(w0[1]).storeCoins(amountOutMin).storeAddress(recipient).storeUint(0, 1).endCell()
    if (tonIn) {
      // pTON v1：Jetton 转账的格式发给 router 的 pTON 钱包，数量就是卖出的 TON
      const forward = SWAP_GAS.stonfiV1TonForward
      return { message: { to: w0[0], value: amountIn + forward, bounce: true, body: jettonTransferBody({ amount: amountIn, destination: router, responseDestination: null, forwardTonAmount: forward, forwardPayload: payload }) } }
    }
    return tonOut ? jettonIn(router, SWAP_GAS.stonfiV1JettonToTon, SWAP_GAS.stonfiV1JettonToTonForward, payload) : jettonIn(router, SWAP_GAS.stonfiV1JettonToJetton, SWAP_GAS.stonfiV1JettonToJettonForward, payload)
  }
  // DeDust：第一步（池子、limit）在消息里，后面的步骤是 next 链；limit 是这一步输出的下限，两跳时只限最后一步
  const params = beginCell().storeUint(deadline, 32).storeAddress(recipient).storeAddress(null).storeMaybeRef(null).storeMaybeRef(null).endCell()
  const next = c.pools.length > 1 ? beginCell().storeAddress(c.pools[1] as string).storeUint(0, 1).storeCoins(amountOutMin).storeMaybeRef(null).endCell() : null
  const firstLimit = c.pools.length > 1 ? 0n : amountOutMin
  if (tonIn) {
    const body = beginCell()
      .storeUint(OP.dedustSwapNative, 32)
      .storeUint(0, 64)
      .storeCoins(amountIn)
      .storeAddress(c.pools[0] as string)
      .storeUint(0, 1)
      .storeCoins(firstLimit)
      .storeMaybeRef(next)
      .storeRef(params)
      .endCell()
    return { message: { to: await dedustVault(env, NATIVE_TON), value: amountIn + SWAP_GAS.dedustNative + SWAP_GAS.hop * BigInt(c.pools.length - 1), bounce: true, body } }
  }
  const payload = beginCell().storeUint(OP.dedustSwapJetton, 32).storeAddress(c.pools[0] as string).storeUint(0, 1).storeCoins(firstLimit).storeMaybeRef(next).storeRef(params).endCell()
  return jettonIn(await dedustVault(env, c.path[0] as string), SWAP_GAS.dedustJetton + SWAP_GAS.hop * BigInt(c.pools.length - 1), SWAP_GAS.dedustJettonForward + SWAP_GAS.hop * BigInt(c.pools.length - 1), payload)
}

/** 交易链里怎么找收到的代币 */
export type SwapReceipt =
  /** Jetton：收款地址的 Jetton 钱包收到的 internal_transfer */
  | { kind: 'jetton'; wallet: string }
  /** STON.fi 收到 TON：router 的 pTON 钱包发给收款地址的 ton_transfer（v2）/ transfer_notification（v1） */
  | { kind: 'pton'; recipient: string; payer: string }
  /** DeDust 收到 TON：池子发给 TON vault 的 payout_from_pool（vault 再发给收款地址） */
  | { kind: 'dedust'; recipient: string; vault: string; pool: string }

/** 消息体开头的 op、query_id 之后的第一个 Coins */
function amountInBody(body: string | null | undefined): bigint | null {
  if (!body) return null
  try {
    const s = Cell.fromBase64(body).beginParse()
    s.loadUint(32)
    s.loadUint(64)
    return s.loadCoins()
  } catch {
    return null
  }
}

/**
 * 交易链里收款地址收到的数量（多余的 gas 不算）；没收到为 null。Jetton 按 internal_transfer 的数量；
 * TON 按付款方的消息体里的数量（这些消息附带的 TON 还含多余的 gas）
 */
export function receivedInTrace(trace: Trace, receipt: SwapReceipt): bigint | null {
  const ok = (tx: Trace['transactions'][string]) => !!tx.in_msg && !tx.in_msg.bounced && !tx.description?.aborted && tx.description?.compute_ph?.success === true
  const from = (tx: Trace['transactions'][string], source: string) => !!tx.in_msg?.source && toRawAddress(tx.in_msg.source) === toRawAddress(source)
  const on = (tx: Trace['transactions'][string], account: string) => toRawAddress(tx.account) === toRawAddress(account)
  const op = (tx: Trace['transactions'][string]) => Number(tx.in_msg?.opcode ?? -1)
  const txs = Object.values(trace.transactions).filter(ok)
  let total: bigint | null = null
  const add = (x: bigint | null) => {
    if (x !== null) total = (total ?? 0n) + x
  }
  if (receipt.kind === 'jetton') {
    for (const tx of txs) if (on(tx, receipt.wallet) && op(tx) === OP.internalTransfer) add(amountInBody(tx.in_msg?.message_content?.body))
  } else if (receipt.kind === 'pton') {
    for (const tx of txs) if (on(tx, receipt.recipient) && from(tx, receipt.payer) && (op(tx) === OP.ptonTransfer || op(tx) === OP.transferNotification)) add(amountInBody(tx.in_msg?.message_content?.body))
  } else {
    // vault 要真的把 TON 发给了收款地址
    if (!txs.some((tx) => on(tx, receipt.recipient) && from(tx, receipt.vault) && op(tx) === OP.dedustPayout)) return null
    for (const tx of txs) if (on(tx, receipt.vault) && from(tx, receipt.pool) && op(tx) === OP.dedustPayoutFromPool) add(amountInBody(tx.in_msg?.message_content?.body))
  }
  return total
}

interface Built {
  plan: TonSwapPlan
  messages: SendMessage[]
  /** 交易链里收到的数量（没收到为 null） */
  received: (trace: Trace) => bigint | null
}

const keyOf = (token: string) => {
  if (token === NATIVE_TON) return NATIVE_TON
  if (!isValidTonAddress(token)) throw new Error(`Invalid token: ${token}`)
  return toRawAddress(token)
}

async function build(client: TonClient, owner: string, params: SwapParams, options: SwapOptions): Promise<Built> {
  const { signal } = options
  if (client.network !== 'mainnet') throw new Error('Swaps are only supported on mainnet (the built-in routers and factory are mainnet contracts)')
  if (!isValidTonAddress(owner)) throw new Error(`Invalid owner address: ${owner}`)
  const recipientInput = options.recipient ?? owner
  if (!isValidTonAddress(recipientInput)) throw new Error(`Invalid recipient address: ${recipientInput}`)
  const tokenIn = keyOf(params.tokenIn)
  const tokenOut = keyOf(params.tokenOut)
  if (tokenIn === tokenOut) throw new Error('tokenIn and tokenOut are the same')
  const ppm = slippagePpm(options.slippage)
  const ownerRaw = toRawAddress(owner)
  const recipient = toRawAddress(recipientInput)

  // 代币信息（精度、symbol）
  const jettons = [tokenIn, tokenOut].filter((t) => t !== NATIVE_TON)
  const details = jettons.length ? await client.jettons(jettons, { signal }) : []
  const meta = new Map(details.map((d) => [toRawAddress(d.address), d]))
  const token = (t: string): TonLpToken => {
    if (t === NATIVE_TON) return { address: NATIVE_TON, symbol: 'TON', decimals: TON_DECIMALS }
    const d = meta.get(t)
    if (!d?.success) throw new Error(`Not a jetton: ${toFriendlyAddress(t)}`)
    return { address: toFriendlyAddress(t), symbol: d.symbol, decimals: d.decimals, ...(d.decimalsUnknown ? { decimalsUnknown: true as const } : {}) }
  }
  const tIn = token(tokenIn)
  const tOut = token(tokenOut)
  if (params.amountIn !== undefined && params.amountInFormatted !== undefined) throw new Error('Pass either amountIn or amountInFormatted')
  if (params.amountInFormatted !== undefined && tIn.decimalsUnknown) throw new Error(`The decimals of ${tIn.address} are not known yet (its metadata is off-chain and not indexed): pass amountIn instead of amountInFormatted`)
  const amountIn = params.amountInFormatted !== undefined ? parseUnits(params.amountInFormatted, tIn.decimals) : params.amountIn === undefined ? 0n : BigInt(params.amountIn)
  if (amountIn <= 0n) throw new Error('amountIn must be greater than 0')

  const env: Env = { client, signal, protocols: new Set(options.protocols ?? (['stonfi-v2', 'stonfi-v1', 'dedust'] as const)), ...stonfiRouters(options.stonfiRouters) }
  const mids = [...new Set((options.intermediates ?? [NATIVE_TON, TON_USDT]).map(keyOf))].filter((m) => m !== tokenIn && m !== tokenOut)
  const all = await quoteRoutes(env, tokenIn, tokenOut, amountIn, mids)
  const wanted = options.route
  const same = (a: string, b: string) => keyOf(a) === keyOf(b)
  const routes = wanted
    ? all.filter((c) => c.protocol === wanted.protocol && c.path.length === wanted.path.length && c.path.every((t, i) => same(t, wanted.path[i] as string)) && c.pools.every((p, i) => same(p, wanted.pools[i] as string)))
    : dedupe(all)
  const best = routes[0]
  if (!best) throw new Error(wanted ? 'The given route has no quote (pool missing or no liquidity, or its intermediate token is not in intermediates)' : 'No route found: no pool for this pair (directly or through the intermediate tokens) on STON.fi / DeDust')
  // 价格影响：同一路线卖出极小的数量（1 / 10000）的价格
  const small = amountIn / 10_000n
  const smallOut = small > 0n ? await best.quote(small) : null
  const priceImpact = smallOut && smallOut > 0n ? Math.max(0, 1 - Number(best.amountOut) / Number(amountIn) / (Number(smallOut) / Number(small))) : null
  const amountOutMin = withSlippageDown(best.amountOut, ppm)

  const [ownerWallet, recipientWallet] = await Promise.all([
    tokenIn === NATIVE_TON ? Promise.resolve(null) : jettonWalletOf(env, tokenIn, ownerRaw),
    tokenOut === NATIVE_TON ? Promise.resolve(null) : jettonWalletOf(env, tokenOut, recipient),
  ])
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (options.deadline ?? 900))
  const message = await swapMessage(env, best, { owner: ownerRaw, recipient, deadline, amountIn, amountOutMin, ownerWallet })
  const receipt: SwapReceipt = recipientWallet
    ? { kind: 'jetton', wallet: recipientWallet }
    : best.protocol === 'dedust'
      ? { kind: 'dedust', recipient, vault: await dedustVault(env, NATIVE_TON), pool: best.pools.at(-1) as string }
      : { kind: 'pton', recipient, payer: (best.wallets.at(-1) as [string, string])[1] }
  // 只支持主网：地址都是主网格式
  const friendly = (t: string) => (t === NATIVE_TON ? NATIVE_TON : toFriendlyAddress(t))
  const route = (c: Quoted): TonSwapRoute => ({
    protocol: c.protocol,
    protocolName: TON_LP_PROTOCOLS[c.protocol].name,
    path: c.path.map(friendly),
    pools: c.pools.map((p) => toFriendlyAddress(p)),
    routers: c.routers.map((r) => toFriendlyAddress(r)),
    amountOut: c.amountOut.toString(),
  })
  const m = message.message
  const to = typeof m.to === 'string' ? m.to : toRawAddress(m.to)
  const unknown = tIn.decimalsUnknown || tOut.decimalsUnknown
  return {
    plan: {
      tokenIn: tIn,
      tokenOut: tOut,
      amountIn: amountIn.toString(),
      amountInFormatted: formatUnits(amountIn, tIn.decimals),
      amountOut: best.amountOut.toString(),
      amountOutFormatted: formatUnits(best.amountOut, tOut.decimals),
      amountOutMin: amountOutMin.toString(),
      amountOutMinFormatted: formatUnits(amountOutMin, tOut.decimals),
      price: unknown ? null : Number(formatUnits(best.amountOut, tOut.decimals)) / Number(formatUnits(amountIn, tIn.decimals)),
      priceImpact,
      route: route(best),
      routes: routes.map(route),
      recipient: toFriendlyAddress(recipient, { bounceable: false }),
      messages: [{ to: toFriendlyAddress(to, { bounceable: m.bounce }), value: m.value.toString(), body: (m.body as Cell).toBase64(), bounce: m.bounce }],
      tonAttached: m.value.toString(),
    },
    messages: [message],
    received: (trace) => receivedInTrace(trace, receipt),
  }
}

/**
 * 报价并构建兑换的消息（不签名）：选输出最多的路线，最少收到 = 报价 × (1 − slippage)。owner 是发送的钱包地址。
 *
 * ```ts
 * const plan = await buildSwap(ton, owner, { tokenIn: NATIVE_TON, tokenOut: USDT, amountInFormatted: '1' })
 * plan.amountOutFormatted   // '1.357'
 * plan.route                // { protocol: 'stonfi-v2', path: ['TON', 'EQCxE6…'], pools: […], … }
 * plan.messages             // 交给 batchCall 或 TON Connect
 * ```
 */
export async function buildSwap(client: TonClient, owner: string, params: SwapParams, options: SwapOptions = {}): Promise<TonSwapPlan> {
  return (await build(client, owner, params, options)).plan
}

export interface SwapSendOptions extends SwapOptions, Omit<SendOptions, 'signal'> {
  /** 发送前检查余额（卖出的数量 + 附带的 TON + 0.02 TON 手续费），默认 true */
  checkBalance?: boolean
}

export type SwapResult = WriteResult & {
  plan: TonSwapPlan
  /** 交易链里收款地址实际收到的数量（最小单位；dryRun 时为模拟的结果）；没有结果时为 null。收到 TON 时不含一起退回的多余 gas */
  amountReceived: string | null
}

/** 余额检查时预留的手续费 */
const FEE_RESERVE = 20_000_000n

/**
 * 兑换：构建（同 buildSwap）后用 from 签名发送（钱包同 /write：助记词、私钥、TON Connect）。
 * 除了没有失败退回，还要求交易链里收款地址收到了不少于 amountOutMin 的代币（DEX 失败时是退款，不是退回）
 *
 * ```ts
 * const r = await swap(ton, mnemonic, { tokenIn: USDT, tokenOut: NATIVE_TON, amountInFormatted: '10' }, { slippage: 0.01 })
 * r.status          // 'confirmed'
 * r.amountReceived  // 实际收到的 nanoTON
 * ```
 */
export async function swap(client: TonClient, from: TonSignerInput, params: SwapParams, options: SwapSendOptions = {}): Promise<SwapResult> {
  const { emptyOutcome, resolveWallets, sendJobs, toWriteResult } = await import('./write/send.js')
  const [wallet] = await resolveWallets(client, [from], options.signal)
  if (!wallet) throw new Error('No wallet')
  const built = await build(client, wallet.address, params, options)
  const { plan } = built
  if (options.checkBalance ?? true) {
    const tokenIn = keyOf(params.tokenIn)
    const tokens = tokenIn === NATIVE_TON ? [NATIVE_TON] : [NATIVE_TON, tokenIn]
    const [bal] = await client.multiBalances([{ owner: wallet.address, tokens }], { signal: options.signal })
    const need = [BigInt(plan.tonAttached) + FEE_RESERVE, ...(tokenIn === NATIVE_TON ? [] : [BigInt(plan.amountIn)])]
    tokens.forEach((t, i) => {
      const have = BigInt(bal?.[i]?.balance ?? '0')
      if (have < (need[i] as bigint)) throw new Error(`Insufficient balance of ${t === NATIVE_TON ? 'TON' : toFriendlyAddress(t)}: need ${need[i]}, have ${have}`)
    })
  }
  const min = BigInt(plan.amountOutMin)
  let received: bigint | null = null
  let result = toWriteResult(0, wallet.friendly, emptyOutcome('skipped'))
  await sendJobs(
    client,
    [
      {
        wallet,
        messages: built.messages,
        check: (trace) => {
          received = built.received(trace)
          if (received === null) return 'the swapped tokens did not arrive (the swap was refunded: price moved beyond amountOutMin, the deadline passed, or the pool rejected it)'
          return received < min ? `received ${received}, less than amountOutMin ${min}` : null
        },
        onUpdate: (outcome) => {
          result = toWriteResult(0, wallet.friendly, outcome)
          options.onUpdate?.(result)
        },
      },
    ],
    options,
  )
  return { ...result, plan, amountReceived: received === null ? null : (received as bigint).toString() }
}
