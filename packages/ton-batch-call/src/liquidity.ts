/**
 * 添加 / 移除流动性（子路径 `@w3lib/ton-batch-call/liquidity`）：STON.fi v2（添加、移除）、STON.fi v1（移除）、DeDust（添加、移除）。
 * 消息格式与 @ston-fi/sdk 2.7 / @dedust/sdk 0.8 相同；发送走 `/write` 的流程（先模拟整条交易链，再发送、等结果）
 */
import { isValidTonAddress, toFriendlyAddress, toRawAddress } from './address.js'
import type { TonClient } from './client.js'
import { NATIVE_TON, TON_DECIMALS } from './constants.js'
import { formatUnits, parseUnits } from './format.js'
import { GetMethodError, runGetMethod } from './getters.js'
import { DEDUST_FACTORY, PTON_MASTERS, PTON_V2_MASTER, STONFI_V1_ROUTER, STONFI_V2_ROUTERS, hashKey, lpPositions, type TonLpPosition, type TonLpProtocol, type TonLpToken } from './lp.js'
import { beginCell, type Cell } from './write/cell.js'
import { jettonTransferBody } from './write/message.js'
import { emptyOutcome, resolveWallets, sendJobs, toWriteResult, type SendMessage, type SendOptions, type Trace, type WalletContext, type WriteResult } from './write/send.js'
import type { TonSignerInput } from './write/signer.js'

const TON = 1_000_000_000n
const nano = (ton: string) => parseUnits(ton, TON_DECIMALS)

/** 各操作附带的 TON（多余的退回）；与官方 SDK 的默认值相同 */
export const LIQUIDITY_GAS = {
  /** STON.fi v2：Jetton 一边的转账 / 转给 router 的 forward；TON 一边的 forward */
  stonfiJetton: nano('0.3'),
  stonfiJettonForward: nano('0.235'),
  stonfiTonForward: nano('0.3'),
  stonfiPtonFee: nano('0.01'),
  stonfiBurnV2: nano('0.8'),
  stonfiBurnV1: nano('0.5'),
  /** DeDust：TON 存入的 gas；Jetton 存入的转账 / forward；取出 */
  dedustNative: nano('0.3'),
  dedustJetton: nano('0.5'),
  dedustJettonForward: nano('0.4'),
  dedustBurn: nano('0.5'),
} as const

const OP = {
  stonfiProvideLp: 0x37c096df,
  ptonTransfer: 0x01f3835d,
  burn: 0x595f07bc,
  dedustDepositNative: 0xd55e4686,
  dedustDepositJetton: 0x40e108d6,
  internalTransfer: 0x178d4519,
}

export interface LiquidityOptions {
  /** 数量滑点，默认 0.005：添加时 LP 下限 = 预计 LP × (1 − s) */
  slippage?: number
  /** 额外认可的 STON.fi v2 router（与 lpPositions 的同名选项相同） */
  stonfiRouters?: readonly string[]
  signal?: AbortSignal
}

export interface AddLiquidityParams extends LiquidityOptions {
  /** 池子：lpPositions 的结果，或 { protocol, pool } */
  position?: TonLpPosition
  protocol?: TonLpProtocol
  pool?: string
  /** 给一边（另一边按储备比例算）或两边都给；数量是最小单位或按精度换算的字符串 */
  amount0?: bigint | string | number
  amount1?: bigint | string | number
  amount0Formatted?: string
  amount1Formatted?: string
  /** LP 数量下限（不按滑点算） */
  minLpOut?: bigint
}

export interface RemoveLiquidityParams extends LiquidityOptions {
  position?: TonLpPosition
  protocol?: TonLpProtocol
  pool?: string
  /** 移除的比例（0~100），默认 100；或 lpAmount 指定 LP 数量 */
  percent?: number
  lpAmount?: bigint | string
}

export interface LiquidityPlan {
  action: 'add' | 'remove'
  protocol: TonLpProtocol
  pool: string
  token0: TonLpToken
  token1: TonLpToken
  /** 添加：付出的数量；移除：按当前储备预计拿到的数量（合约不检查下限） */
  amount0: string
  amount1: string
  amount0Formatted: string
  amount1Formatted: string
  /** 添加：预计拿到的 LP（stableswap 等估不出时为 null）和下限；移除：烧掉的 LP */
  lpAmount: string | null
  minLpOut: string | null
  /** 钱包要发的消息（一笔交易里），可以交给 batchCall 或 TON Connect */
  messages: Array<{ to: string; value: string; body: string; bounce: boolean }>
  /** 附带的 TON 合计（含要存入的 TON 和 gas，多余的 gas 退回） */
  tonAttached: string
}

export type LiquidityResult = WriteResult & { plan: LiquidityPlan }

interface PoolInfo {
  protocol: TonLpProtocol
  pool: string
  /** 代币：NATIVE_TON 或 Jetton 主合约（原始地址） */
  t0: string
  t1: string
  /** STON.fi：router 和它的两个代币钱包 */
  router: string | null
  routerWallet0: string | null
  routerWallet1: string | null
  reserve0: bigint
  reserve1: bigint
  totalSupply: bigint
  poolType: string | null
  /** DeDust：stable 池子（存入消息里的池子类型位） */
  stable: boolean
  /** STON.fi：pTON 那一边用的 pTON 主合约（没有 TON 时为 null） */
  pton: string | null
}

async function poolInfo(client: TonClient, protocol: TonLpProtocol, poolAddress: string, options: LiquidityOptions): Promise<PoolInfo> {
  const { signal } = options
  if (!isValidTonAddress(poolAddress)) throw new Error(`Invalid pool address: ${poolAddress}`)
  const pool = toRawAddress(poolAddress)
  const t = client.transport
  const opts = { signal }
  let pton: string | null = null
  const masterOfWallets = async (wallets: string[]) => {
    const res = await t.get<{ jetton_wallets?: Array<{ address: string; jetton: string }> }>('jetton/wallets', { address: wallets, limit: 10 }, opts)
    const map = new Map((res.jetton_wallets ?? []).map((w) => [toRawAddress(w.address), toRawAddress(w.jetton)]))
    return wallets.map((w) => {
      const m = map.get(w)
      if (!m) throw new Error(`Cannot find the jetton of the pool's token wallet ${w}`)
      if (PTON_MASTERS.has(m)) pton = m
      return PTON_MASTERS.has(m) ? NATIVE_TON : m
    })
  }
  const supply = async () => {
    const s = await runGetMethod(t, pool, 'get_jetton_data', [], opts)
    return s.num()
  }
  if (protocol === 'stonfi-v2') {
    const s = await runGetMethod(t, pool, 'get_pool_data', [], opts)
    s.num()
    const router = s.address() as string
    // router 必须是 STON.fi 的（池子自己报的 router 不可信：仿冒的池子可以配一个仿冒的 router）
    const routers = new Set([...STONFI_V2_ROUTERS, ...(options.stonfiRouters ?? []).map((r) => hashKey(toRawAddress(r)))])
    if (!routers.has(hashKey(router))) throw new Error('Not a STON.fi v2 pool (unknown router; pass stonfiRouters if STON.fi deployed a new one)')
    const totalSupply = s.num()
    const [reserve0, reserve1] = [s.num(), s.num()]
    const [w0, w1] = [s.address() as string, s.address() as string]
    const check = await runGetMethod(t, router, 'get_pool_address', [{ type: 'address', address: w0 }, { type: 'address', address: w1 }], opts)
    if (check.address() !== pool) throw new Error('Not a STON.fi v2 pool (the router does not recognize it)')
    const poolType = await runGetMethod(t, pool, 'get_pool_type', [], opts).then((x) => x.string()).catch(() => null)
    const [t0, t1] = await masterOfWallets([w0, w1])
    return { protocol, pool, t0: t0 as string, t1: t1 as string, router, routerWallet0: w0, routerWallet1: w1, reserve0, reserve1, totalSupply, poolType, stable: false, pton }
  }
  if (protocol === 'stonfi-v1') {
    const s = await runGetMethod(t, pool, 'get_pool_data', [], opts)
    const [reserve0, reserve1] = [s.num(), s.num()]
    const [w0, w1] = [s.address() as string, s.address() as string]
    const check = await runGetMethod(t, STONFI_V1_ROUTER, 'get_pool_address', [{ type: 'address', address: w0 }, { type: 'address', address: w1 }], opts)
    if (check.address() !== pool) throw new Error('Not a STON.fi v1 pool (the router does not recognize it)')
    const [t0, t1] = await masterOfWallets([w0, w1])
    return { protocol, pool, t0: t0 as string, t1: t1 as string, router: STONFI_V1_ROUTER, routerWallet0: w0, routerWallet1: w1, reserve0, reserve1, totalSupply: await supply(), poolType: 'constant_product', stable: false, pton }
  }
  const assets = await runGetMethod(t, pool, 'get_assets', [], opts)
  const [c0, c1] = [assets.cell(), assets.cell()]
  const stable = Number((await runGetMethod(t, pool, 'is_stable', [], opts)).num())
  const check = await runGetMethod(t, DEDUST_FACTORY, 'get_pool_address', [{ type: 'num', value: stable }, { type: 'slice', cell: c0 }, { type: 'slice', cell: c1 }], opts)
  if (check.address() !== pool) throw new Error('Not a DeDust pool (the factory does not recognize it)')
  const reserves = await runGetMethod(t, pool, 'get_reserves', [], opts)
  const [reserve0, reserve1] = [reserves.num(), reserves.num()]
  const asset = (c: Cell) => {
    const sl = c.beginParse()
    if (sl.loadUintNumber(4) === 0) return NATIVE_TON
    const wc = Number(sl.loadInt(8))
    return `${wc}:${[...sl.loadBytes(32)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
  }
  return { protocol, pool, t0: asset(c0), t1: asset(c1), router: null, routerWallet0: null, routerWallet1: null, reserve0, reserve1, totalSupply: await supply(), poolType: stable ? 'stable' : 'volatile', stable: stable === 1, pton: null }
}

function target(params: AddLiquidityParams | RemoveLiquidityParams): { protocol: TonLpProtocol; pool: string } {
  if (params.position) return { protocol: params.position.protocol, pool: params.position.pool }
  if (!params.protocol || !params.pool) throw new Error('Pass position (from lpPositions) or protocol + pool')
  return { protocol: params.protocol, pool: params.pool }
}

async function tokensOf(client: TonClient, info: PoolInfo, signal?: AbortSignal): Promise<[TonLpToken, TonLpToken]> {
  const jettons = [info.t0, info.t1].filter((t) => t !== NATIVE_TON)
  const details = jettons.length ? await client.jettons(jettons, { signal }) : []
  const meta = new Map(details.map((d) => [toRawAddress(d.address), d]))
  const token = (t: string): TonLpToken =>
    t === NATIVE_TON
      ? { address: NATIVE_TON, symbol: 'TON', decimals: TON_DECIMALS }
      : { address: toFriendlyAddress(t), symbol: meta.get(t)?.symbol ?? null, decimals: meta.get(t)?.decimals ?? TON_DECIMALS, ...(meta.get(t)?.decimalsUnknown ? { decimalsUnknown: true as const } : {}) }
  return [token(info.t0), token(info.t1)]
}

const slippageBps = (s: number | undefined) => {
  const v = s ?? 0.005
  if (!(v >= 0 && v < 1)) throw new Error(`Invalid slippage: ${v}`)
  return BigInt(Math.round(v * 1_000_000))
}

interface Built {
  plan: LiquidityPlan
  messages: SendMessage[]
  /** 交易链里要看到的结果（如 LP 发到了用户的 LP 钱包） */
  check: (trace: Trace) => string | null
}

const outMessages = (list: SendMessage[], testOnly: boolean) =>
  list.map((m) => ({ to: toFriendlyAddress(typeof m.message.to === 'string' ? m.message.to : toRawAddress(m.message.to), { bounceable: m.message.bounce, testOnly }), value: m.message.value.toString(), body: (m.message.body as Cell).toBase64(), bounce: m.message.bounce }))

/** 交易链里 account 上有成功执行的、收到 internal_transfer 的交易（Jetton 到账） */
function received(trace: Trace, account: string): boolean {
  const raw = toRawAddress(account)
  return Object.values(trace.transactions).some(
    (tx) => toRawAddress(tx.account) === raw && Number(tx.in_msg?.opcode ?? -1) === OP.internalTransfer && tx.description?.compute_ph?.success === true && !tx.description.aborted,
  )
}

async function buildAdd(client: TonClient, wallet: WalletContext, params: AddLiquidityParams): Promise<Built> {
  const { signal } = params
  const { protocol, pool } = target(params)
  if (protocol === 'stonfi-v1') throw new Error('Adding liquidity to STON.fi v1 is not supported (use STON.fi v2); removing is')
  const info = await poolInfo(client, protocol, pool, params)
  if (protocol === 'stonfi-v2' && info.poolType !== 'constant_product' && params.minLpOut === undefined) {
    throw new Error(`Cannot estimate the LP amount of a ${info.poolType} pool: pass minLpOut`)
  }
  if (protocol === 'dedust' && info.poolType !== 'volatile' && params.minLpOut === undefined) throw new Error('Cannot estimate the LP amount of a DeDust stable pool: pass minLpOut')
  if (info.totalSupply === 0n || info.reserve0 === 0n || info.reserve1 === 0n) throw new Error('The pool is empty: creating pools is not supported')
  const [token0, token1] = await tokensOf(client, info, signal)
  const amount = (v: bigint | string | number | undefined, f: string | undefined, t: TonLpToken, side: string) => {
    if (v !== undefined && f !== undefined) throw new Error(`Pass either ${side} or ${side}Formatted`)
    if (f !== undefined && t.decimalsUnknown) throw new Error(`The decimals of ${t.address} are not known yet (its metadata is off-chain and not indexed): pass ${side} instead of ${side}Formatted`)
    if (f !== undefined) return parseUnits(f, t.decimals)
    return v === undefined ? null : BigInt(v)
  }
  let a0 = amount(params.amount0, params.amount0Formatted, token0, 'amount0')
  let a1 = amount(params.amount1, params.amount1Formatted, token1, 'amount1')
  if (a0 === null && a1 === null) throw new Error('Pass amount0 or amount1')
  // 给一边时另一边按储备比例（向上取整，保证不少于比例）
  if (a0 !== null && a1 === null) a1 = (a0 * info.reserve1 + info.reserve0 - 1n) / info.reserve0
  if (a1 !== null && a0 === null) a0 = (a1 * info.reserve0 + info.reserve1 - 1n) / info.reserve1
  if (protocol === 'stonfi-v2' && info.pton !== null && info.pton !== PTON_V2_MASTER) throw new Error('The pool uses pTON v1: adding TON to it is not supported')
  const [x0, x1] = [a0 as bigint, a1 as bigint]
  if (x0 <= 0n || x1 <= 0n) throw new Error('Both amounts must be greater than 0')
  const lp0 = (x0 * info.totalSupply) / info.reserve0
  const lp1 = (x1 * info.totalSupply) / info.reserve1
  const expectedLp = lp0 < lp1 ? lp0 : lp1
  // 按恒定乘积估算；stableswap 等池子不准，计划里不给预计值
  const estimated = info.poolType === 'constant_product' || info.poolType === 'volatile'
  const minLpOut = params.minLpOut ?? (expectedLp * (1_000_000n - slippageBps(params.slippage))) / 1_000_000n

  // 用户的 Jetton 钱包和余额
  const jettons = [info.t0, info.t1].filter((t) => t !== NATIVE_TON)
  const held = jettons.length ? ((await client.multiBalances([{ owner: wallet.address, tokens: jettons }], { signal }))[0] ?? []) : []
  const userWallet = (t: string) => {
    const b = held[jettons.indexOf(t)]
    if (!b?.wallet) throw new Error(`${wallet.friendly} has no ${toFriendlyAddress(t)} jetton wallet`)
    return b.wallet
  }
  const lpWallet = (await runGetMethod(client.transport, info.pool, 'get_wallet_address', [{ type: 'address', address: wallet.address }], { signal })).address() as string
  const messages: SendMessage[] = []
  if (protocol === 'stonfi-v2') {
    const router = info.router as string
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 15 * 60)
    const provide = (otherRouterWallet: string) =>
      beginCell()
        .storeUint(OP.stonfiProvideLp, 32)
        .storeAddress(otherRouterWallet)
        .storeAddress(wallet.address)
        .storeAddress(wallet.address)
        .storeUint(deadline, 64)
        .storeRef(beginCell().storeCoins(minLpOut).storeAddress(wallet.address).storeUint(1, 1).storeCoins(0).storeMaybeRef(null))
        .endCell()
    const side = (t: string, amountIn: bigint, ownRouterWallet: string, otherRouterWallet: string): SendMessage => {
      if (t === NATIVE_TON) {
        // TON：发给 router 的 pTON 钱包（ton_transfer），forward 里带 provide_lp
        const body = beginCell().storeUint(OP.ptonTransfer, 32).storeUint(0, 64).storeCoins(amountIn).storeAddress(wallet.address).storeMaybeRef(provide(otherRouterWallet)).endCell()
        return { message: { to: ownRouterWallet, value: amountIn + LIQUIDITY_GAS.stonfiTonForward + LIQUIDITY_GAS.stonfiPtonFee, bounce: true, body } }
      }
      const body = jettonTransferBody({ amount: amountIn, destination: router, responseDestination: wallet.address, forwardTonAmount: LIQUIDITY_GAS.stonfiJettonForward, forwardPayload: provide(otherRouterWallet) })
      return { message: { to: userWallet(t), value: LIQUIDITY_GAS.stonfiJetton, bounce: true, body } }
    }
    messages.push(side(info.t0, x0, info.routerWallet0 as string, info.routerWallet1 as string), side(info.t1, x1, info.routerWallet1 as string, info.routerWallet0 as string))
  } else {
    const assetCell = (t: string) => (t === NATIVE_TON ? beginCell().storeUint(0, 4) : beginCell().storeUint(1, 4).storeInt(Number(t.split(':')[0]), 8).storeBytes(Uint8Array.from((t.split(':')[1] as string).match(/../g) as string[], (h) => parseInt(h, 16)))).endCell()
    const [asset0, asset1] = [assetCell(info.t0), assetCell(info.t1)]
    const vaultOf = async (asset: Cell) => (await runGetMethod(client.transport, DEDUST_FACTORY, 'get_vault_address', [{ type: 'slice', cell: asset }], { signal })).address() as string
    const side = async (t: string, amountIn: bigint): Promise<SendMessage> => {
      const vault = await vaultOf(assetCell(t))
      if (t === NATIVE_TON) {
        const body = beginCell()
          .storeUint(OP.dedustDepositNative, 32)
          .storeUint(0, 64)
          .storeCoins(amountIn)
          .storeUint(info.stable ? 1 : 0, 1) // 池子类型：volatile 0 / stable 1
          .storeSlice(asset0.beginParse())
          .storeSlice(asset1.beginParse())
          .storeRef(beginCell().storeCoins(minLpOut).storeCoins(x0).storeCoins(x1))
          .storeMaybeRef(null)
          .storeMaybeRef(null)
          .endCell()
        return { message: { to: vault, value: amountIn + LIQUIDITY_GAS.dedustNative, bounce: true, body } }
      }
      const payload = beginCell()
        .storeUint(OP.dedustDepositJetton, 32)
        .storeUint(info.stable ? 1 : 0, 1)
        .storeSlice(asset0.beginParse())
        .storeSlice(asset1.beginParse())
        .storeCoins(minLpOut)
        .storeCoins(x0)
        .storeCoins(x1)
        .storeMaybeRef(null)
        .storeMaybeRef(null)
        .endCell()
      const body = jettonTransferBody({ amount: amountIn, destination: vault, responseDestination: wallet.address, forwardTonAmount: LIQUIDITY_GAS.dedustJettonForward, forwardPayload: payload })
      return { message: { to: userWallet(t), value: LIQUIDITY_GAS.dedustJetton, bounce: true, body } }
    }
    messages.push(await side(info.t0, x0), await side(info.t1, x1))
  }
  const tonAttached = messages.reduce((s, m) => s + m.message.value, 0n)
  return {
    plan: {
      action: 'add',
      protocol,
      pool: toFriendlyAddress(info.pool),
      token0,
      token1,
      amount0: x0.toString(),
      amount1: x1.toString(),
      amount0Formatted: formatUnits(x0, token0.decimals),
      amount1Formatted: formatUnits(x1, token1.decimals),
      lpAmount: estimated ? expectedLp.toString() : null,
      minLpOut: minLpOut.toString(),
      messages: outMessages(messages, client.network === 'testnet'),
      tonAttached: tonAttached.toString(),
    },
    messages,
    check: (trace) => (received(trace, lpWallet) ? null : 'no LP tokens were minted (the deposit was refunded: price moved beyond minLpOut, or the amounts are unbalanced)'),
  }
}

async function buildRemove(client: TonClient, wallet: WalletContext, params: RemoveLiquidityParams): Promise<Built> {
  const { signal } = params
  const { protocol, pool } = target(params)
  const info = await poolInfo(client, protocol, pool, params)
  const [token0, token1] = await tokensOf(client, info, signal)
  const lpWallet = (await runGetMethod(client.transport, info.pool, 'get_wallet_address', [{ type: 'address', address: wallet.address }], { signal })).address() as string
  // 余额从要发 burn 的那个 LP 钱包上直接读（不用索引器的记录，地址和余额都确定一致）；没部署时为 0
  const balance = await runGetMethod(client.transport, lpWallet, 'get_wallet_data', [], { signal }).then(
    (s) => s.num(),
    (err: unknown) => {
      if (err instanceof GetMethodError) return 0n
      throw err
    },
  )
  let amount: bigint
  if (params.lpAmount !== undefined) amount = BigInt(params.lpAmount)
  else {
    const percent = params.percent ?? 100
    if (!(percent > 0 && percent <= 100)) throw new Error(`Invalid percent: ${percent}`)
    amount = (balance * BigInt(Math.round(percent * 1e6))) / 100_000_000n
  }
  if (amount <= 0n) throw new Error('Nothing to remove: no LP tokens')
  if (amount > balance) throw new Error(`Only ${balance} LP tokens are held`)
  const out0 = (amount * info.reserve0) / info.totalSupply
  const out1 = (amount * info.reserve1) / info.totalSupply
  // STON.fi v2 的 burn 不带 response 地址（池子直接发给持有者）；v1 和 DeDust 带
  const body = beginCell()
    .storeUint(OP.burn, 32)
    .storeUint(0, 64)
    .storeCoins(amount)
    .storeAddress(protocol === 'stonfi-v2' ? null : wallet.address)
    .storeMaybeRef(null)
    .endCell()
  const gas = protocol === 'stonfi-v2' ? LIQUIDITY_GAS.stonfiBurnV2 : protocol === 'stonfi-v1' ? LIQUIDITY_GAS.stonfiBurnV1 : LIQUIDITY_GAS.dedustBurn
  const messages: SendMessage[] = [{ message: { to: lpWallet, value: gas, bounce: true, body } }]
  // 取回的代币：Jetton 到账（用户的 Jetton 钱包收到 internal_transfer）；TON 那边直接收到 TON
  // 预计取回 0 的一边（很小的 LP、向下取整）不会收到：不检查
  const jettons = (
    [
      [info.t0, out0],
      [info.t1, out1],
    ] as const
  )
    .filter(([t, out]) => t !== NATIVE_TON && out > 0n)
    .map(([t]) => t)
  const held = jettons.length ? ((await client.multiBalances([{ owner: wallet.address, tokens: jettons }], { signal }))[0] ?? []) : []
  const userWallets = held.map((b) => b.wallet).filter((w): w is string => !!w)
  return {
    plan: {
      action: 'remove',
      protocol,
      pool: toFriendlyAddress(info.pool),
      token0,
      token1,
      amount0: out0.toString(),
      amount1: out1.toString(),
      amount0Formatted: formatUnits(out0, token0.decimals),
      amount1Formatted: formatUnits(out1, token1.decimals),
      lpAmount: amount.toString(),
      minLpOut: null,
      messages: outMessages(messages, client.network === 'testnet'),
      tonAttached: gas.toString(),
    },
    messages,
    // 用户已有的 Jetton 钱包要收到取回的代币（新钱包的地址事先不知道，只检查已有的）
    check: (trace) => (userWallets.every((w) => received(trace, w)) ? null : 'the withdrawn tokens did not arrive'),
  }
}

/** 报价并构建要发的消息（不签名）：结果里的 messages 可以交给 batchCall 或 TON Connect */
export async function buildAddLiquidity(client: TonClient, owner: TonSignerInput | string, params: AddLiquidityParams): Promise<LiquidityPlan> {
  const [wallet] = await resolveWallets(client, [ownerInput(owner)], params.signal)
  return (await buildAdd(client, wallet as WalletContext, params)).plan
}

export async function buildRemoveLiquidity(client: TonClient, owner: TonSignerInput | string, params: RemoveLiquidityParams): Promise<LiquidityPlan> {
  const [wallet] = await resolveWallets(client, [ownerInput(owner)], params.signal)
  return (await buildRemove(client, wallet as WalletContext, params)).plan
}

/** 只给地址时当作只读的 TON Connect 钱包（不签名，只用来算地址和读状态） */
function ownerInput(owner: TonSignerInput | string): TonSignerInput {
  if (typeof owner === 'string' && isValidTonAddress(owner)) {
    return { wallet: { account: { address: owner } }, sendTransaction: () => Promise.reject(new Error('read-only')) }
  }
  return owner
}

export interface LiquiditySendOptions extends SendOptions {
  /** 发送前检查余额（要存入的数量 + 附带的 TON），默认 true */
  checkBalance?: boolean
}

async function send(client: TonClient, from: TonSignerInput, params: LiquidityOptions, build: (w: WalletContext) => Promise<Built>, options: LiquiditySendOptions, need?: (b: Built) => Array<[string, bigint]>): Promise<LiquidityResult> {
  const [wallet] = await resolveWallets(client, [from], options.signal ?? params.signal)
  const w = wallet as WalletContext
  const built = await build(w)
  if ((options.checkBalance ?? true) && need) {
    const list = need(built)
    const tokens = list.map(([t]) => t)
    const [bal] = await client.multiBalances([{ owner: w.address, tokens }], { signal: options.signal ?? params.signal })
    list.forEach(([t, amount], i) => {
      const have = BigInt(bal?.[i]?.balance ?? '0')
      if (have < amount) throw new Error(`Insufficient balance of ${t === NATIVE_TON ? 'TON' : toFriendlyAddress(t)}: need ${amount}, have ${have}`)
    })
  }
  let result = toWriteResult(0, w.friendly, emptyOutcome('skipped'))
  await sendJobs(
    client,
    [
      {
        wallet: w,
        messages: built.messages,
        check: built.check,
        onUpdate: (outcome) => {
          result = toWriteResult(0, w.friendly, outcome)
          options.onUpdate?.(result)
        },
      },
    ],
    { ...options, signal: options.signal ?? params.signal },
  )
  return { ...result, plan: built.plan }
}

/**
 * 添加流动性：STON.fi v2、DeDust（volatile）。给一边时另一边按储备比例；两笔转账在同一笔钱包交易里。
 *
 * ```ts
 * const [position] = await lpPositions(ton, owner)
 * await addLiquidity(ton, mnemonic, { position, amount0Formatted: '10' })
 * await addLiquidity(ton, mnemonic, { protocol: 'dedust', pool, amount1Formatted: '5' })
 * ```
 */
export async function addLiquidity(client: TonClient, from: TonSignerInput, params: AddLiquidityParams, options: LiquiditySendOptions = {}): Promise<LiquidityResult> {
  return send(client, from, params, (w) => buildAdd(client, w, params), options, (b) => {
    const t0 = b.plan.token0.address === NATIVE_TON ? NATIVE_TON : toRawAddress(b.plan.token0.address)
    const t1 = b.plan.token1.address === NATIVE_TON ? NATIVE_TON : toRawAddress(b.plan.token1.address)
    const ton = BigInt(b.plan.tonAttached) + FEE_RESERVE
    return [[NATIVE_TON, ton], ...(t0 === NATIVE_TON ? [] : ([[t0, BigInt(b.plan.amount0)]] as Array<[string, bigint]>)), ...(t1 === NATIVE_TON ? [] : ([[t1, BigInt(b.plan.amount1)]] as Array<[string, bigint]>))]
  })
}

/** 移除流动性（烧掉 LP，按比例拿回两种代币）：STON.fi v1 / v2、DeDust */
export async function removeLiquidity(client: TonClient, from: TonSignerInput, params: RemoveLiquidityParams, options: LiquiditySendOptions = {}): Promise<LiquidityResult> {
  return send(client, from, params, (w) => buildRemove(client, w, params), options, (b) => [[NATIVE_TON, BigInt(b.plan.tonAttached) + FEE_RESERVE]])
}

/** 余额检查时预留的手续费 */
const FEE_RESERVE = TON / 50n

export { lpPositions }
