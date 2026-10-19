import { decodeAddress, findProgramAddress, getAssociatedTokenAddress } from '../address.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../constants.js'
import type { AccountInfo } from '../layout.js'
import { RAYDIUM_CLMM_PROGRAM_ID, SOLANA_LP_PROTOCOLS, raydiumTickArray, utf8, type SolanaLpToken } from '../lp.js'
import { getAmountsForLiquidity, getMaxAmounts, getMinAmounts, getMintAmounts, sqrtPriceAtTick } from '../lpMath.js'
import type { Instruction } from '../write/transaction.js'
import { liquidityFor, priceInfo, queryPosition, resolveRange } from './clmm.js'
import {
  Bytes,
  DEFAULT_ADDRESS,
  MEMO_PROGRAM_ID,
  RENT_SYSVAR_ID,
  Writer,
  anchorIx,
  makePlan,
  mintMeta,
  mustAccounts,
  nativeSide,
  newMintKeypair,
  parseAmount,
  prepareTokenAccounts,
  r,
  refMint,
  removeAmount,
  tokenInfo,
  w,
  type Ctx,
  type MintMeta,
} from './common.js'
import type { SolanaIncreaseLiquidityParams, SolanaLiquidityPlan, SolanaNewPositionParams, SolanaRemoveLiquidityParams } from './types.js'

const PROGRAM = RAYDIUM_CLMM_PROGRAM_ID
const TICK_ARRAY_SIZE = 60
/** 池子账户里的 tick 数组位图覆盖的范围：± tickSpacing × 60 × 512，超出时要带上位图扩展账户 */
const BITMAP_SIZE = 512

interface RaydiumPool {
  address: string
  mint0: string
  mint1: string
  vault0: string
  vault1: string
  tickSpacing: number
  sqrtPrice: bigint
  tick: number
  /** 已初始化的奖励：mint 和池子的奖励金库 */
  rewards: Array<{ mint: string; vault: string }>
}

/** PoolState：mint 73 / 105、vault 137 / 169、tick_spacing 235、sqrt_price 253、tick 269、reward_infos 397（3 个，每个 169 字节：mint +57、vault +89） */
function parsePool(address: string, data: Uint8Array): RaydiumPool {
  if (data.length < 904) {
    throw new Error(`Not a Raydium CLMM pool: ${address}`)
  }
  const b = new Bytes(data)
  const rewards: RaydiumPool['rewards'] = []
  for (let i = 0; i < 3; i++) {
    const offset = 397 + i * 169
    const mint = b.key(offset + 57)
    // 与程序一致：奖励的 mint 不为默认地址就算已初始化
    if (mint !== DEFAULT_ADDRESS) {
      rewards.push({ mint, vault: b.key(offset + 89) })
    }
  }
  return { address, mint0: b.key(73), mint1: b.key(105), vault0: b.key(137), vault1: b.key(169), tickSpacing: b.u16(235), sqrtPrice: b.u128(253), tick: b.i32(269), rewards }
}

/** 读池子和两种代币的 mint；已知 mint 时（已有仓位，查询结果里有）与池子一次读完 */
async function readPool(ctx: Ctx, address: string, knownMints?: readonly [string, string], extra: readonly string[] = []): Promise<{ extra: AccountInfo[]; pool: RaydiumPool; mints: [MintMeta, MintMeta] }> {
  // 已知 mint 时与池子、额外的账户（如仓位 NFT 的 mint）一次读完
  const first = await mustAccounts(ctx, [address, ...(knownMints ?? []), ...extra], (i) => (i > (knownMints?.length ?? 0) ? 'Account' : i ? 'Token mint' : 'Raydium CLMM pool'))
  if (first[0]?.owner !== PROGRAM) {
    throw new Error(`Not a Raydium CLMM pool: ${address}`)
  }
  const pool = parsePool(address, (first[0] as AccountInfo).data)
  const [m0, m1] = knownMints && knownMints[0] === pool.mint0 && knownMints[1] === pool.mint1 ? first.slice(1, 3) : await mustAccounts(ctx, [pool.mint0, pool.mint1], () => 'Token mint')
  return { pool, mints: [mintMeta(pool.mint0, m0 as AccountInfo), mintMeta(pool.mint1, m1 as AccountInfo)], extra: first.slice(1 + (knownMints?.length ?? 0)) }
}

const be32 = (n: number) => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setInt32(0, n, false)
  return b
}
const personalPositionAddress = (nftMint: string) => findProgramAddress([utf8('position'), decodeAddress(nftMint)], PROGRAM)
/**
 * ProtocolPositionState：程序的种子是 tick 的大端字节（to_be_bytes）。当前版本的程序已不再校验这个账户（官方 SDK 传的是小端推导出的地址，
 * 主网照样成功），按程序的种子推导，以后恢复校验也对
 */
const protocolPositionAddress = (pool: string, lower: number, upper: number) => findProgramAddress([utf8('position'), decodeAddress(pool), be32(lower), be32(upper)], PROGRAM)

/** 区间两端的 tick 数组；超出池子位图覆盖的范围时还要位图扩展账户 */
function tickAccounts(pool: RaydiumPool, tickLower: number, tickUpper: number) {
  const lower = raydiumTickArray(pool.address, tickLower, pool.tickSpacing)
  const upper = raydiumTickArray(pool.address, tickUpper, pool.tickSpacing)
  const [lowerStart, upperStart] = [lower.start, upper.start]
  const max = pool.tickSpacing * TICK_ARRAY_SIZE * BITMAP_SIZE
  const overflow = [lowerStart, upperStart].some((s) => s >= max || s < -max)
  return {
    lowerStart,
    upperStart,
    lower: lower.address,
    upper: upper.address,
    bitmap: overflow ? [w(findProgramAddress([utf8('pool_tick_array_bitmap_extension'), decodeAddress(pool.address)], PROGRAM))] : [],
  }
}

export async function raydiumAdd(ctx: Ctx, params: SolanaIncreaseLiquidityParams | SolanaNewPositionParams): Promise<SolanaLiquidityPlan> {
  let pool: RaydiumPool
  let mints: [MintMeta, MintMeta]
  let tickLower: number
  let tickUpper: number
  /** 已有仓位：NFT mint 和它的代币程序 */
  let existing: { mint: string; program: string } | null = null
  /** 已有仓位：代币信息用查询结果里的，不再读一次 */
  let known: [SolanaLpToken, SolanaLpToken] | null = null
  if ('position' in params) {
    const mint = refMint(params.position)
    const position = await queryPosition(ctx, 'raydium-clmm', mint)
    known = [position.token0, position.token1]
    let nft: AccountInfo[]
    ;({ pool, mints, extra: nft } = await readPool(ctx, position.pool, [position.token0.mint, position.token1.mint], [mint]))
    ;[tickLower, tickUpper] = [position.tickLower, position.tickUpper]
    existing = { mint, program: (nft[0] as AccountInfo).owner }
  } else {
    ;({ pool, mints } = await readPool(ctx, params.pool))
    tickLower = 0
    tickUpper = 0
  }
  const [token0, token1] = known ?? ((await tokenInfo(ctx, mints)) as [SolanaLpToken, SolanaLpToken])
  if (!existing) {
    ;[tickLower, tickUpper] = resolveRange('raydium', params as SolanaNewPositionParams, token0, token1, pool.tickSpacing)
  }
  const amount0 = parseAmount(params.amount0, params.amount0Formatted, mints[0].decimals, 'amount0')
  const amount1 = parseAmount(params.amount1, params.amount1Formatted, mints[1].decimals, 'amount1')
  const liquidity = liquidityFor('raydium', pool.tick, pool.sqrtPrice, tickLower, tickUpper, amount0, amount1, token0, token1)
  const sqrtA = sqrtPriceAtTick('raydium', tickLower)
  const sqrtB = sqrtPriceAtTick('raydium', tickUpper)
  const [expected0, expected1] = getMintAmounts(pool.tick, pool.sqrtPrice, sqrtA, sqrtB, liquidity, tickLower, tickUpper)
  const [max0, max1] = getMaxAmounts('raydium', pool.sqrtPrice, tickLower, tickUpper, liquidity, ctx.slippage)

  const tokens = await prepareTokenAccounts(ctx, mints, [max0, max1])
  const ticks = tickAccounts(pool, tickLower, tickUpper)
  const protocolPosition = protocolPositionAddress(pool.address, tickLower, tickUpper)
  const signers: SolanaLiquidityPlan['signers'] = []
  let positionMint: string
  let ix: Instruction
  if (existing) {
    positionMint = existing.mint
    ix = {
      programId: PROGRAM,
      keys: [
        r(ctx.owner, true),
        r(getAssociatedTokenAddress(ctx.owner, existing.mint, existing.program)),
        w(pool.address),
        r(protocolPosition),
        w(personalPositionAddress(existing.mint)),
        w(ticks.lower),
        w(ticks.upper),
        w(tokens.accounts[0] as string),
        w(tokens.accounts[1] as string),
        w(pool.vault0),
        w(pool.vault1),
        r(TOKEN_PROGRAM_ID),
        r(TOKEN_2022_PROGRAM_ID),
        r(pool.mint0),
        r(pool.mint1),
        ...ticks.bitmap,
      ],
      // base_flag: None（按给定的流动性）
      data: new Writer().bytes(anchorIx('increase_liquidity_v2')).u128(liquidity).u64(max0).u64(max1).u8(0).bool(false).build(),
    }
  } else {
    const nft = await newMintKeypair()
    signers.push(nft)
    positionMint = nft.address
    ix = {
      programId: PROGRAM,
      keys: [
        w(ctx.owner, true),
        r(ctx.recipient),
        w(nft.address, true),
        w(getAssociatedTokenAddress(ctx.recipient, nft.address, TOKEN_2022_PROGRAM_ID)),
        w(pool.address),
        r(protocolPosition),
        w(ticks.lower),
        w(ticks.upper),
        w(personalPositionAddress(nft.address)),
        w(tokens.accounts[0] as string),
        w(tokens.accounts[1] as string),
        w(pool.vault0),
        w(pool.vault1),
        r(RENT_SYSVAR_ID),
        r(SYSTEM_PROGRAM_ID),
        r(TOKEN_PROGRAM_ID),
        r(ASSOCIATED_TOKEN_PROGRAM_ID),
        r(TOKEN_2022_PROGRAM_ID),
        r(pool.mint0),
        r(pool.mint1),
        ...ticks.bitmap,
      ],
      // 仓位 NFT 用 Token-2022（不建 Metaplex 元数据，租金更少）；tick 数组不存在时程序自动创建
      data: new Writer()
        .bytes(anchorIx('open_position_with_token22_nft'))
        .i32(tickLower)
        .i32(tickUpper)
        .i32(ticks.lowerStart)
        .i32(ticks.upperStart)
        .u128(liquidity)
        .u64(max0)
        .u64(max1)
        .bool(false)
        .u8(0)
        .bool(false)
        .build(),
    }
  }
  return makePlan(ctx, {
    action: 'add',
    protocol: 'raydium-clmm',
    protocolName: SOLANA_LP_PROTOCOLS['raydium-clmm'].name,
    type: 'clmm',
    pool: pool.address,
    token0,
    token1,
    positionMint,
    position: personalPositionAddress(positionMint),
    lpMint: null,
    tickLower,
    tickUpper,
    ...priceInfo(pool.tick, pool.sqrtPrice, token0, token1, tickLower, tickUpper),
    liquidity: liquidity.toString(),
    amount0: expected0.toString(),
    amount1: expected1.toString(),
    amount0Max: max0.toString(),
    amount1Max: max1.toString(),
    amount0Min: null,
    amount1Min: null,
    // 追加流动性时 Raydium 不领取手续费（留在仓位里）
    fees0: '0',
    fees1: '0',
    rewardMints: [],
    native: nativeSide(tokens.nativeIndex),
    steps: [
      { kind: 'setup', instructions: tokens.setup },
      { kind: 'add', instructions: [...tokens.wrap, ix, ...tokens.cleanup] },
    ],
    signers,
  })
}

/** 移除（liquidity > 0）/ 只领取手续费和奖励（collectOnly：流动性为 0 的 decrease） */
export async function raydiumRemove(ctx: Ctx, params: SolanaRemoveLiquidityParams, collectOnly = false): Promise<SolanaLiquidityPlan> {
  const mint = refMint(params.position)
  const position = await queryPosition(ctx, 'raydium-clmm', mint)
  const { pool, mints, extra } = await readPool(ctx, position.pool, [position.token0.mint, position.token1.mint], [mint])
  const total = BigInt(position.liquidity)
  let liquidity = 0n
  if (!collectOnly) {
    if (total === 0n) {
      throw new Error(`Position ${mint} has no liquidity; use collectFees to collect what is owed`)
    }
    liquidity = removeAmount(total, params.percent, params.liquidity)
  }
  const burn = !collectOnly && !!params.burn
  if (burn && liquidity !== total) {
    throw new Error('burn: true needs the whole position to be removed')
  }
  const [token0, token1] = [position.token0, position.token1]
  const { tickLower, tickUpper } = position
  const [amount0, amount1] = getAmountsForLiquidity(pool.tick, pool.sqrtPrice, sqrtPriceAtTick('raydium', tickLower), sqrtPriceAtTick('raydium', tickUpper), liquidity, tickLower, tickUpper)
  const [min0, min1] = liquidity === 0n ? [0n, 0n] : getMinAmounts('raydium', pool.sqrtPrice, tickLower, tickUpper, liquidity, ctx.slippage)

  const nftAccount = extra[0] as AccountInfo
  const rewardMintAccounts = pool.rewards.length ? await mustAccounts(ctx, pool.rewards.map((x) => x.mint), () => 'Reward mint') : []
  const nftProgram = (nftAccount as AccountInfo).owner
  const rewardMints = pool.rewards.map((x, i) => mintMeta(x.mint, rewardMintAccounts[i] as AccountInfo, false))
  // 两种代币和奖励的代币都收到 owner 的关联代币账户：没有时创建；wSOL（池子的一边或奖励）原来没有账户时用完关闭、换回 SOL
  const rewardOnly = rewardMints.filter((m) => !mints.some((x) => x.mint === m.mint))
  const tokens = await prepareTokenAccounts(ctx, [...mints, ...rewardOnly], [null, null, ...rewardOnly.map(() => null)])
  const rewardAccounts = rewardMints.map((m) => getAssociatedTokenAddress(ctx.owner, m.mint, m.program))
  const ticks = tickAccounts(pool, tickLower, tickUpper)
  const personal = personalPositionAddress(mint)
  const nftAta = getAssociatedTokenAddress(ctx.owner, mint, nftProgram)
  const decrease: Instruction = {
    programId: PROGRAM,
    keys: [
      r(ctx.owner, true),
      r(nftAta),
      w(personal),
      w(pool.address),
      r(protocolPositionAddress(pool.address, tickLower, tickUpper)),
      w(pool.vault0),
      w(pool.vault1),
      w(ticks.lower),
      w(ticks.upper),
      w(tokens.accounts[0] as string),
      w(tokens.accounts[1] as string),
      r(TOKEN_PROGRAM_ID),
      r(TOKEN_2022_PROGRAM_ID),
      r(MEMO_PROGRAM_ID),
      r(pool.mint0),
      r(pool.mint1),
      ...ticks.bitmap,
      ...pool.rewards.flatMap((x, i) => [w(x.vault), w(rewardAccounts[i] as string), r(x.mint)]),
    ],
    data: new Writer().bytes(anchorIx('decrease_liquidity_v2')).u128(liquidity).u64(min0).u64(min1).build(),
  }
  const main: Instruction[] = [decrease]
  if (burn) {
    main.push({
      programId: PROGRAM,
      keys: [w(ctx.owner, true), w(mint), w(nftAta), w(personal), r(SYSTEM_PROGRAM_ID), r(nftProgram), w(pool.address)],
      data: anchorIx('close_position'),
    })
  }
  return makePlan(ctx, {
    action: collectOnly ? 'collect' : 'remove',
    protocol: 'raydium-clmm',
    protocolName: SOLANA_LP_PROTOCOLS['raydium-clmm'].name,
    type: 'clmm',
    pool: pool.address,
    token0,
    token1,
    positionMint: mint,
    position: personal,
    lpMint: null,
    tickLower,
    tickUpper,
    ...priceInfo(pool.tick, pool.sqrtPrice, token0, token1, tickLower, tickUpper),
    liquidity: liquidity.toString(),
    amount0: amount0.toString(),
    amount1: amount1.toString(),
    amount0Max: null,
    amount1Max: null,
    amount0Min: min0.toString(),
    amount1Min: min1.toString(),
    fees0: position.fees0 ?? '0',
    fees1: position.fees1 ?? '0',
    rewardMints: rewardMints.map((m) => m.mint),
    native: nativeSide(tokens.nativeIndex),
    steps: [
      { kind: 'setup', instructions: tokens.setup },
      { kind: collectOnly ? 'collect' : 'remove', instructions: [...tokens.wrap, ...main, ...tokens.cleanup] },
    ],
    signers: [],
  })
}
