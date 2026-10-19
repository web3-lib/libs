import { createProgramAddress, decodeAddress, getAssociatedTokenAddress } from '../address.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../constants.js'
import { parseTokenAccount, type AccountInfo } from '../layout.js'
import {
  RAYDIUM_AMM_AUTHORITY,
  RAYDIUM_AMM_PROGRAM_ID,
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_PROGRAM_ID,
  SOLANA_LP_PROTOCOLS,
  parseAmmPool,
  type AmmPoolState,
  type SolanaLpToken,
} from '../lp.js'
import { ceilDiv } from '../lpMath.js'
import type { Instruction } from '../write/transaction.js'
import {
  Bytes,
  MEMO_PROGRAM_ID,
  Writer,
  anchorIx,
  makePlan,
  minus,
  mintMeta,
  mustAccounts,
  nativeSide,
  parseAmount,
  plus,
  prepareTokenAccounts,
  r,
  refPool,
  removeAmount,
  tokenInfo,
  w,
  type Ctx,
  type MintMeta,
} from './common.js'
import type { SolanaIncreaseLiquidityParams, SolanaLiquidityPlan, SolanaNewPositionParams, SolanaRemoveLiquidityParams } from './types.js'

type AmmProtocol = 'raydium-amm' | 'raydium-cpmm'

interface Pool {
  state: AmmPoolState
  /** 池子账户的原始数据（AMM v4 还要读 OpenBook 相关字段） */
  data: Uint8Array
  mints: [MintMeta, MintMeta]
  /** 属于 LP 的储备：金库余额 − 不属于 LP 的部分（与程序计算撤出 / 存入数量时一致） */
  reserve0: bigint
  reserve1: bigint
}

async function readPool(ctx: Ctx, protocol: AmmProtocol, address: string): Promise<Pool> {
  const [account] = await mustAccounts(ctx, [address], () => 'Pool')
  const state = parseAmmPool(account as AccountInfo)
  if (!state || state.protocol !== protocol) {
    throw new Error(`Not a ${SOLANA_LP_PROTOCOLS[protocol].name} pool: ${address}`)
  }
  const [m0, m1, v0, v1] = await mustAccounts(ctx, [state.mint0, state.mint1, state.vault0, state.vault1], (i) => (i < 2 ? 'Token mint' : 'Pool vault'))
  const sub = (a: bigint, b: bigint) => (a > b ? a - b : 0n)
  return {
    state,
    data: (account as AccountInfo).data,
    mints: [mintMeta(state.mint0, m0 as AccountInfo), mintMeta(state.mint1, m1 as AccountInfo)],
    reserve0: sub(parseTokenAccount((v0 as AccountInfo).data).amount, state.reserved0),
    reserve1: sub(parseTokenAccount((v1 as AccountInfo).data).amount, state.reserved1),
  }
}

/** AMM v4 存入：按固定的一边（baseSide 0 = token0）收取，另一边 = 固定数量 × 储备比例（向上取整），LP = 固定数量 × 总量 / 储备 */
function ammDeposit(pool: Pool, given0: bigint | undefined, given1: bigint | undefined) {
  const { reserve0, reserve1 } = pool
  const supply = pool.state.lpSupply
  const by0 = (a0: bigint) => ({ side: 0, amount0: a0, amount1: ceilDiv(a0 * reserve1, reserve0), lp: (a0 * supply) / reserve0 })
  const by1 = (a1: bigint) => ({ side: 1, amount0: ceilDiv(a1 * reserve0, reserve1), amount1: a1, lp: (a1 * supply) / reserve1 })
  if (given0 !== undefined && given1 !== undefined) {
    const a = by0(given0)
    // 两边都给：按不超出另一边的那一边固定
    return a.amount1 <= given1 ? a : by1(given1)
  }
  return given0 !== undefined ? by0(given0) : by1(given1 as bigint)
}

/** CPMM 存入：按要拿到的 LP 收取两边（向上取整）；给一边时 LP = 数量 × 总量 / 储备（向下取整，用掉的不超过给的） */
function cpmmDeposit(pool: Pool, given0: bigint | undefined, given1: bigint | undefined) {
  const { reserve0, reserve1 } = pool
  const supply = pool.state.lpSupply
  const lp0 = given0 === undefined ? null : (given0 * supply) / reserve0
  const lp1 = given1 === undefined ? null : (given1 * supply) / reserve1
  // side：决定 LP 数量的那一边（两边都给时是较少的一边）
  const side = lp0 === null ? 1 : lp1 === null ? 0 : lp0 <= lp1 ? 0 : 1
  const lp = side === 0 ? (lp0 as bigint) : (lp1 as bigint)
  return { side, lp, amount0: ceilDiv(lp * reserve0, supply), amount1: ceilDiv(lp * reserve1, supply) }
}

function info(pool: Pool, token0: SolanaLpToken, token1: SolanaLpToken, protocol: AmmProtocol) {
  return {
    protocol,
    protocolName: SOLANA_LP_PROTOCOLS[protocol].name,
    type: 'amm' as const,
    pool: pool.state.address,
    token0,
    token1,
    positionMint: null,
    position: null,
    lpMint: pool.state.lpMint,
    tickLower: null,
    tickUpper: null,
    tick: null,
    price: null,
    priceLower: null,
    priceUpper: null,
  }
}

/** AMM v4 池子里 OpenBook 相关的账户：open_orders 496、market 528、market_program 560、target_orders 592 */
function ammKeys(pool: Pool) {
  const b = new Bytes(pool.data)
  return { openOrders: b.key(496), market: b.key(528), marketProgram: b.key(560), targetOrders: b.key(592) }
}

/** OpenBook 市场账户（MarketStateV3，含 5 字节前缀）：vault_signer_nonce 45、base_vault 117、quote_vault 165、event_queue 253、bids 285、asks 317 */
async function readMarket(ctx: Ctx, market: string, program: string) {
  const [account] = await mustAccounts(ctx, [market], () => 'OpenBook market of the AMM v4 pool')
  const data = (account as AccountInfo).data
  if (data.length < 388) {
    throw new Error(`Unexpected OpenBook market account: ${market}`)
  }
  const b = new Bytes(data)
  const nonce = new Uint8Array(8)
  new DataView(nonce.buffer).setBigUint64(0, b.u64(45), true)
  return {
    baseVault: b.key(117),
    quoteVault: b.key(165),
    eventQueue: b.key(253),
    bids: b.key(285),
    asks: b.key(317),
    authority: createProgramAddress([decodeAddress(market), nonce], program),
  }
}

export async function ammAdd(ctx: Ctx, protocol: AmmProtocol, params: SolanaIncreaseLiquidityParams | SolanaNewPositionParams): Promise<SolanaLiquidityPlan> {
  const address = 'position' in params ? refPool(params.position) : params.pool
  if (!('position' in params) && (params.fullRange || params.priceLower !== undefined || params.priceUpper !== undefined || params.tickLower !== undefined || params.tickUpper !== undefined)) {
    throw new Error(`${SOLANA_LP_PROTOCOLS[protocol].name} has no price range: pass only the amounts`)
  }
  const pool = await readPool(ctx, protocol, address)
  const { state, mints } = pool
  if (state.lpSupply === 0n || pool.reserve0 === 0n || pool.reserve1 === 0n) {
    throw new Error(`Pool ${address} is empty`)
  }
  const [token0, token1] = (await tokenInfo(ctx, mints)) as [SolanaLpToken, SolanaLpToken]
  const given0 = parseAmount(params.amount0, params.amount0Formatted, mints[0].decimals, 'amount0')
  const given1 = parseAmount(params.amount1, params.amount1Formatted, mints[1].decimals, 'amount1')
  if (given0 === undefined && given1 === undefined) {
    throw new Error('Pass the amount of at least one token')
  }
  const lpMeta = { mint: state.lpMint, program: TOKEN_PROGRAM_ID, decimals: 0 }
  let lp: bigint
  let amount0: bigint
  let amount1: bigint
  let max0: bigint
  let max1: bigint
  /** 决定数量的那一边（AMM v4 是固定收取的一边） */
  let side = 0
  let ix: Instruction
  if (protocol === 'raydium-cpmm') {
    ;({ lp, amount0, amount1, side } = cpmmDeposit(pool, given0, given1))
    // 价格（储备比例）变动时每份 LP 对应的数量会变：两边都按滑点给出上限
    ;[max0, max1] = [plus(amount0, ctx.slippage), plus(amount1, ctx.slippage)]
  } else {
    const d = ammDeposit(pool, given0, given1)
    ;({ lp, amount0, amount1, side } = d)
    // 固定的一边按给的数量收取；另一边按滑点给出上限
    ;[max0, max1] = side === 0 ? [amount0, plus(amount1, ctx.slippage)] : [plus(amount0, ctx.slippage), amount1]
  }
  // 两边都给时，另一边的上限不超过给的数量（决定数量的那一边保留滑点余量，否则价格稍有不利就失败）
  if (side === 0 && given1 !== undefined && max1 > given1) max1 = given1
  if (side === 1 && given0 !== undefined && max0 > given0) max0 = given0
  if (lp === 0n || amount0 === 0n || amount1 === 0n) {
    throw new Error('Amount too small: no LP tokens would be minted')
  }
  const tokens = await prepareTokenAccounts(ctx, [...mints, lpMeta], [max0, max1, null])
  const [user0, user1, userLp] = tokens.accounts as [string, string, string]
  if (protocol === 'raydium-cpmm') {
    ix = {
      programId: RAYDIUM_CPMM_PROGRAM_ID,
      keys: [
        r(ctx.owner, true),
        r(RAYDIUM_CPMM_AUTHORITY),
        w(state.address),
        w(userLp),
        w(user0),
        w(user1),
        w(state.vault0),
        w(state.vault1),
        r(TOKEN_PROGRAM_ID),
        r(TOKEN_2022_PROGRAM_ID),
        r(state.mint0),
        r(state.mint1),
        w(state.lpMint),
      ],
      data: new Writer().bytes(anchorIx('deposit')).u64(lp).u64(max0).u64(max1).build(),
    }
  } else {
    const keys = ammKeys(pool)
    const market = await readMarket(ctx, keys.market, keys.marketProgram)
    ix = {
      programId: RAYDIUM_AMM_PROGRAM_ID,
      keys: [
        r(TOKEN_PROGRAM_ID),
        w(state.address),
        r(RAYDIUM_AMM_AUTHORITY),
        r(keys.openOrders),
        w(keys.targetOrders),
        w(state.lpMint),
        w(state.vault0),
        w(state.vault1),
        r(keys.market),
        w(user0),
        w(user1),
        w(userLp),
        r(ctx.owner, true),
        r(market.eventQueue),
      ],
      // deposit：max_coin、max_pc、base_side（0 = 固定 coin）、other_amount_min（另一边至少收取多少）
      data: new Writer()
        .u8(3)
        .u64(max0)
        .u64(max1)
        .u64(BigInt(side))
        .u64(side === 0 ? minus(amount1, ctx.slippage) : minus(amount0, ctx.slippage))
        .build(),
    }
  }
  return makePlan(ctx, {
    action: 'add',
    ...info(pool, token0, token1, protocol),
    liquidity: lp.toString(),
    amount0: amount0.toString(),
    amount1: amount1.toString(),
    amount0Max: max0.toString(),
    amount1Max: max1.toString(),
    amount0Min: null,
    amount1Min: null,
    fees0: '0',
    fees1: '0',
    rewardMints: [],
    native: nativeSide(tokens.nativeIndex),
    steps: [
      { kind: 'setup', instructions: tokens.setup },
      { kind: 'add', instructions: [...tokens.wrap, ix, ...tokens.cleanup] },
    ],
    signers: [],
  })
}

export async function ammRemove(ctx: Ctx, protocol: AmmProtocol, params: SolanaRemoveLiquidityParams): Promise<SolanaLiquidityPlan> {
  const address = refPool(params.position)
  const pool = await readPool(ctx, protocol, address)
  const { state, mints } = pool
  const lpAccount = getAssociatedTokenAddress(ctx.owner, state.lpMint, TOKEN_PROGRAM_ID)
  const [held] = await ctx.client.accounts([lpAccount], { signal: ctx.signal })
  const balance = held ? parseTokenAccount(held.data).amount : 0n
  if (balance === 0n) {
    throw new Error(`${ctx.owner} holds no LP tokens of ${address} (in its associated token account)`)
  }
  const lp = removeAmount(balance, params.percent, params.liquidity)
  const [token0, token1] = (await tokenInfo(ctx, mints)) as [SolanaLpToken, SolanaLpToken]
  // 与程序一致：份额 × 储备，向下取整
  const amount0 = (lp * pool.reserve0) / state.lpSupply
  const amount1 = (lp * pool.reserve1) / state.lpSupply
  if (amount0 === 0n && amount1 === 0n) {
    throw new Error('Amount too small: nothing would be withdrawn')
  }
  const min0 = minus(amount0, ctx.slippage)
  const min1 = minus(amount1, ctx.slippage)
  const tokens = await prepareTokenAccounts(ctx, mints, [null, null])
  const [user0, user1] = tokens.accounts as [string, string]
  let ix: Instruction
  if (protocol === 'raydium-cpmm') {
    ix = {
      programId: RAYDIUM_CPMM_PROGRAM_ID,
      keys: [
        r(ctx.owner, true),
        r(RAYDIUM_CPMM_AUTHORITY),
        w(state.address),
        w(lpAccount),
        w(user0),
        w(user1),
        w(state.vault0),
        w(state.vault1),
        r(TOKEN_PROGRAM_ID),
        r(TOKEN_2022_PROGRAM_ID),
        r(state.mint0),
        r(state.mint1),
        w(state.lpMint),
        r(MEMO_PROGRAM_ID),
      ],
      data: new Writer().bytes(anchorIx('withdraw')).u64(lp).u64(min0).u64(min1).build(),
    }
  } else {
    const keys = ammKeys(pool)
    const market = await readMarket(ctx, keys.market, keys.marketProgram)
    ix = {
      programId: RAYDIUM_AMM_PROGRAM_ID,
      keys: [
        r(TOKEN_PROGRAM_ID),
        w(state.address),
        r(RAYDIUM_AMM_AUTHORITY),
        w(keys.openOrders),
        w(keys.targetOrders),
        w(state.lpMint),
        w(state.vault0),
        w(state.vault1),
        // 原来的 withdraw_queue / temp_lp 账户，程序已不再使用，按官方 SDK 传池子地址占位
        w(state.address),
        w(state.address),
        r(keys.marketProgram),
        w(keys.market),
        w(market.baseVault),
        w(market.quoteVault),
        r(market.authority),
        w(lpAccount),
        w(user0),
        w(user1),
        r(ctx.owner, true),
        w(market.eventQueue),
        w(market.bids),
        w(market.asks),
      ],
      data: new Writer().u8(4).u64(lp).u64(min0).u64(min1).build(),
    }
  }
  return makePlan(ctx, {
    action: 'remove',
    ...info(pool, token0, token1, protocol),
    liquidity: lp.toString(),
    amount0: amount0.toString(),
    amount1: amount1.toString(),
    amount0Max: null,
    amount1Max: null,
    amount0Min: min0.toString(),
    amount1Min: min1.toString(),
    fees0: '0',
    fees1: '0',
    rewardMints: [],
    native: nativeSide(tokens.nativeIndex),
    steps: [
      { kind: 'setup', instructions: tokens.setup },
      { kind: 'remove', instructions: [...tokens.wrap, ix, ...tokens.cleanup] },
    ],
    signers: [],
  })
}
