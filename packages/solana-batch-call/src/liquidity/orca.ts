import { decodeAddress, findProgramAddress, getAssociatedTokenAddress } from '../address.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../constants.js'
import type { AccountInfo } from '../layout.js'
import { ORCA_WHIRLPOOL_PROGRAM_ID, SOLANA_LP_PROTOCOLS, orcaTickArray, utf8, type SolanaLpToken } from '../lp.js'
import { getAmountsForLiquidity, getMaxAmounts, getMinAmounts, getMintAmounts, sqrtPriceAtTick } from '../lpMath.js'
import type { Instruction } from '../write/transaction.js'
import { liquidityFor, priceInfo, queryPosition, resolveRange } from './clmm.js'
import {
  Bytes,
  DEFAULT_ADDRESS,
  MEMO_PROGRAM_ID,
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

const PROGRAM = ORCA_WHIRLPOOL_PROGRAM_ID
/** 带 Token-2022 元数据扩展的仓位 NFT 的元数据更新权限（Orca 固定地址） */
const METADATA_UPDATE_AUTH = '3axbTs2z5GBy6usVbNVoqEgZMng3vZvMnAoX29BFfwhr'

interface Whirlpool {
  address: string
  tickSpacing: number
  sqrtPrice: bigint
  tick: number
  mint0: string
  vault0: string
  mint1: string
  vault1: string
  rewards: Array<{ index: number; mint: string; vault: string }>
}

/** Whirlpool：tick_spacing 41、sqrt_price 65、tick 81、mint_a 101、vault_a 133、mint_b 181、vault_b 213、reward_infos 269（3 个，每个 128 字节：mint +0、vault +32） */
function parsePool(address: string, data: Uint8Array): Whirlpool {
  if (data.length < 653) {
    throw new Error(`Not an Orca Whirlpool: ${address}`)
  }
  const b = new Bytes(data)
  const rewards: Whirlpool['rewards'] = []
  for (let i = 0; i < 3; i++) {
    const mint = b.key(269 + i * 128)
    if (mint !== DEFAULT_ADDRESS) {
      rewards.push({ index: i, mint, vault: b.key(269 + i * 128 + 32) })
    }
  }
  return { address, tickSpacing: b.u16(41), sqrtPrice: b.u128(65), tick: b.i32(81), mint0: b.key(101), vault0: b.key(133), mint1: b.key(181), vault1: b.key(213), rewards }
}

/** 读池子和两种代币的 mint；已知 mint 时（已有仓位，查询结果里有）与池子一次读完 */
async function readPool(ctx: Ctx, address: string, knownMints?: readonly [string, string], extra: readonly string[] = []): Promise<{ extra: AccountInfo[]; pool: Whirlpool; mints: [MintMeta, MintMeta] }> {
  // 已知 mint 时与池子、额外的账户（如仓位 NFT 的 mint）一次读完
  const first = await mustAccounts(ctx, [address, ...(knownMints ?? []), ...extra], (i) => (i > (knownMints?.length ?? 0) ? 'Account' : i ? 'Token mint' : 'Orca Whirlpool'))
  if (first[0]?.owner !== PROGRAM) {
    throw new Error(`Not an Orca Whirlpool: ${address}`)
  }
  const pool = parsePool(address, (first[0] as AccountInfo).data)
  const [m0, m1] = knownMints && knownMints[0] === pool.mint0 && knownMints[1] === pool.mint1 ? first.slice(1, 3) : await mustAccounts(ctx, [pool.mint0, pool.mint1], () => 'Token mint')
  return { pool, mints: [mintMeta(pool.mint0, m0 as AccountInfo), mintMeta(pool.mint1, m1 as AccountInfo)], extra: first.slice(1 + (knownMints?.length ?? 0)) }
}

const positionAddress = (mint: string) => findProgramAddress([utf8('position'), decodeAddress(mint)], PROGRAM)

function tickArrays(pool: Whirlpool, tickLower: number, tickUpper: number) {
  const lower = orcaTickArray(pool.address, tickLower, pool.tickSpacing)
  const upper = orcaTickArray(pool.address, tickUpper, pool.tickSpacing)
  return { lowerStart: lower.start, upperStart: upper.start, lower: lower.address, upper: upper.address }
}

/** increase_liquidity_v2 / decrease_liquidity_v2 共用的账户 */
function liquidityKeys(ctx: Ctx, pool: Whirlpool, mints: readonly MintMeta[], position: string, nftAccount: string, owner: readonly string[], lower: string, upper: string) {
  return [
    w(pool.address),
    r((mints[0] as MintMeta).program),
    r((mints[1] as MintMeta).program),
    r(MEMO_PROGRAM_ID),
    r(ctx.owner, true),
    w(position),
    r(nftAccount),
    r(pool.mint0),
    r(pool.mint1),
    w(owner[0] as string),
    w(owner[1] as string),
    w(pool.vault0),
    w(pool.vault1),
    w(lower),
    w(upper),
  ]
}

export async function orcaAdd(ctx: Ctx, params: SolanaIncreaseLiquidityParams | SolanaNewPositionParams): Promise<SolanaLiquidityPlan> {
  let pool: Whirlpool
  let mints: [MintMeta, MintMeta]
  let tickLower: number
  let tickUpper: number
  let existing: { mint: string; program: string } | null = null
  /** 已有仓位：代币信息用查询结果里的，不再读一次 */
  let known: [SolanaLpToken, SolanaLpToken] | null = null
  if ('position' in params) {
    const mint = refMint(params.position)
    const position = await queryPosition(ctx, 'orca-whirlpool', mint)
    known = [position.token0, position.token1]
    let nft: AccountInfo[]
    ;({ pool, mints, extra: nft } = await readPool(ctx, position.pool, [position.token0.mint, position.token1.mint], [mint]))
    ;[tickLower, tickUpper] = [position.tickLower, position.tickUpper]
    existing = { mint, program: (nft[0] as AccountInfo).owner }
  } else {
    if (ctx.recipient !== ctx.owner) {
      // 新建后要由仓位 NFT 的持有者签名才能加流动性：同一笔交易里只能是 owner 自己
      throw new Error('Orca Whirlpool: recipient must be the owner when opening a position (transfer the NFT afterwards)')
    }
    ;({ pool, mints } = await readPool(ctx, params.pool))
    tickLower = 0
    tickUpper = 0
  }
  const [token0, token1] = known ?? ((await tokenInfo(ctx, mints)) as [SolanaLpToken, SolanaLpToken])
  if (!existing) {
    ;[tickLower, tickUpper] = resolveRange('orca', params as SolanaNewPositionParams, token0, token1, pool.tickSpacing)
  }
  const amount0 = parseAmount(params.amount0, params.amount0Formatted, mints[0].decimals, 'amount0')
  const amount1 = parseAmount(params.amount1, params.amount1Formatted, mints[1].decimals, 'amount1')
  const liquidity = liquidityFor('orca', pool.tick, pool.sqrtPrice, tickLower, tickUpper, amount0, amount1, token0, token1)
  const [expected0, expected1] = getMintAmounts(pool.tick, pool.sqrtPrice, sqrtPriceAtTick('orca', tickLower), sqrtPriceAtTick('orca', tickUpper), liquidity, tickLower, tickUpper)
  const [max0, max1] = getMaxAmounts('orca', pool.sqrtPrice, tickLower, tickUpper, liquidity, ctx.slippage)

  const tokens = await prepareTokenAccounts(ctx, mints, [max0, max1])
  const ticks = tickArrays(pool, tickLower, tickUpper)
  const setup = [...tokens.setup]
  const main: Instruction[] = []
  const signers: SolanaLiquidityPlan['signers'] = []
  let positionMint: string
  let nftAccount: string
  if (existing) {
    positionMint = existing.mint
    nftAccount = getAssociatedTokenAddress(ctx.owner, existing.mint, existing.program)
  } else {
    // 区间两端的 tick 数组不存在时先初始化（idempotent：别人同时初始化了也不失败）
    const arrays = await ctx.client.accounts([ticks.lower, ticks.upper], { signal: ctx.signal })
    // 地址上可能只是别人转过 SOL 的系统账户：按是否归 Whirlpool 程序判断
    const starts = [...new Set([ticks.lowerStart, ticks.upperStart])]
    for (const start of starts) {
      const address = start === ticks.lowerStart ? ticks.lower : ticks.upper
      if (arrays[start === ticks.lowerStart ? 0 : 1]?.owner !== PROGRAM) {
        setup.push({
          programId: PROGRAM,
          keys: [r(pool.address), w(ctx.owner, true), w(address), r(SYSTEM_PROGRAM_ID)],
          data: new Writer().bytes(anchorIx('initialize_dynamic_tick_array')).i32(start).bool(true).build(),
        })
      }
    }
    const nft = await newMintKeypair()
    signers.push(nft)
    positionMint = nft.address
    nftAccount = getAssociatedTokenAddress(ctx.owner, nft.address, TOKEN_2022_PROGRAM_ID)
    main.push({
      programId: PROGRAM,
      keys: [
        w(ctx.owner, true),
        r(ctx.owner),
        w(positionAddress(nft.address)),
        w(nft.address, true),
        w(nftAccount),
        r(pool.address),
        r(TOKEN_2022_PROGRAM_ID),
        r(SYSTEM_PROGRAM_ID),
        r(ASSOCIATED_TOKEN_PROGRAM_ID),
        r(METADATA_UPDATE_AUTH),
      ],
      // 仓位 NFT 用 Token-2022 并带元数据扩展（钱包里能显示，与 Orca 网页一致）
      data: new Writer().bytes(anchorIx('open_position_with_token_extensions')).i32(tickLower).i32(tickUpper).bool(true).build(),
    })
  }
  main.push({
    programId: PROGRAM,
    keys: liquidityKeys(ctx, pool, mints, positionAddress(positionMint), nftAccount, tokens.accounts, ticks.lower, ticks.upper),
    // remaining_accounts_info: None
    data: new Writer().bytes(anchorIx('increase_liquidity_v2')).u128(liquidity).u64(max0).u64(max1).u8(0).build(),
  })
  return makePlan(ctx, {
    action: 'add',
    protocol: 'orca-whirlpool',
    protocolName: SOLANA_LP_PROTOCOLS['orca-whirlpool'].name,
    type: 'clmm',
    pool: pool.address,
    token0,
    token1,
    positionMint,
    position: positionAddress(positionMint),
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
    // 追加时 Orca 只更新手续费记账，不转出
    fees0: '0',
    fees1: '0',
    rewardMints: [],
    native: nativeSide(tokens.nativeIndex),
    steps: [
      { kind: 'setup', instructions: setup },
      { kind: 'add', instructions: [...tokens.wrap, ...main, ...tokens.cleanup] },
    ],
    signers,
  })
}

/**
 * 关闭已清空的仓位（流动性、手续费、奖励都为 0）：销毁仓位 NFT、关闭仓位账户和 NFT 的代币账户（nftAccount，默认 owner 的 ATA），租金退给 receiver。
 * NFT 是 Token-2022（带元数据扩展）时连 mint 一起关闭，否则（Metaplex 时代的 SPL Token NFT）mint 留着
 */
export function orcaClosePosition(owner: string, receiver: string, positionMint: string, nftProgram: string, nftAccount = getAssociatedTokenAddress(owner, positionMint, nftProgram)): Instruction {
  const position = positionAddress(positionMint)
  const token2022 = nftProgram === TOKEN_2022_PROGRAM_ID
  return {
    programId: PROGRAM,
    keys: [r(owner, true), w(receiver), w(position), w(positionMint), w(nftAccount), r(nftProgram)],
    data: anchorIx(token2022 ? 'close_position_with_token_extensions' : 'close_position'),
  }
}

/** 移除（decrease + 领取手续费和奖励）/ 只领取（collectOnly） */
export async function orcaRemove(ctx: Ctx, params: SolanaRemoveLiquidityParams, collectOnly = false): Promise<SolanaLiquidityPlan> {
  const mint = refMint(params.position)
  const position = await queryPosition(ctx, 'orca-whirlpool', mint)
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
  const [amount0, amount1] = getAmountsForLiquidity(pool.tick, pool.sqrtPrice, sqrtPriceAtTick('orca', tickLower), sqrtPriceAtTick('orca', tickUpper), liquidity, tickLower, tickUpper)
  const [min0, min1] = liquidity === 0n ? [0n, 0n] : getMinAmounts('orca', pool.sqrtPrice, tickLower, tickUpper, liquidity, ctx.slippage)

  const nftMintAccount = extra[0] as AccountInfo
  const rewardMintAccounts = pool.rewards.length ? await mustAccounts(ctx, pool.rewards.map((x) => x.mint), () => 'Reward mint') : []
  const nftProgram = (nftMintAccount as AccountInfo).owner
  const rewardMints = pool.rewards.map((x, i) => mintMeta(x.mint, rewardMintAccounts[i] as AccountInfo, false))
  // 两种代币和奖励的代币都收到 owner 的关联代币账户：没有时创建；wSOL（池子的一边或奖励）原来没有账户时用完关闭、换回 SOL
  const rewardOnly = rewardMints.filter((m) => !mints.some((x) => x.mint === m.mint))
  const tokens = await prepareTokenAccounts(ctx, [...mints, ...rewardOnly], [null, null, ...rewardOnly.map(() => null)])
  const ticks = tickArrays(pool, tickLower, tickUpper)
  const positionAccount = positionAddress(mint)
  const nftAccount = getAssociatedTokenAddress(ctx.owner, mint, nftProgram)
  const main: Instruction[] = []
  if (liquidity > 0n) {
    main.push({
      programId: PROGRAM,
      keys: liquidityKeys(ctx, pool, mints, positionAccount, nftAccount, tokens.accounts, ticks.lower, ticks.upper),
      data: new Writer().bytes(anchorIx('decrease_liquidity_v2')).u128(liquidity).u64(min0).u64(min1).u8(0).build(),
    })
  } else if (total > 0n) {
    // 只领取：先按最新的价格更新手续费和奖励的记账（流动性为 0 的仓位不需要）
    main.push({ programId: PROGRAM, keys: [w(pool.address), w(positionAccount), r(ticks.lower), r(ticks.upper)], data: anchorIx('update_fees_and_rewards') })
  }
  main.push({
    programId: PROGRAM,
    keys: [
      r(pool.address),
      r(ctx.owner, true),
      w(positionAccount),
      r(nftAccount),
      r(pool.mint0),
      r(pool.mint1),
      w(tokens.accounts[0] as string),
      w(pool.vault0),
      w(tokens.accounts[1] as string),
      w(pool.vault1),
      r((mints[0] as MintMeta).program),
      r((mints[1] as MintMeta).program),
      r(MEMO_PROGRAM_ID),
    ],
    data: new Writer().bytes(anchorIx('collect_fees_v2')).u8(0).build(),
  })
  pool.rewards.forEach((reward, i) => {
    const m = rewardMints[i] as MintMeta
    main.push({
      programId: PROGRAM,
      keys: [
        r(pool.address),
        r(ctx.owner, true),
        w(positionAccount),
        r(nftAccount),
        w(getAssociatedTokenAddress(ctx.owner, m.mint, m.program)),
        r(m.mint),
        w(reward.vault),
        r(m.program),
        r(MEMO_PROGRAM_ID),
      ],
      data: new Writer().bytes(anchorIx('collect_reward_v2')).u8(reward.index).u8(0).build(),
    })
  })
  if (burn) {
    main.push(orcaClosePosition(ctx.owner, ctx.owner, mint, nftProgram))
  }
  return makePlan(ctx, {
    action: collectOnly ? 'collect' : 'remove',
    protocol: 'orca-whirlpool',
    protocolName: SOLANA_LP_PROTOCOLS['orca-whirlpool'].name,
    type: 'clmm',
    pool: pool.address,
    token0,
    token1,
    positionMint: mint,
    position: positionAccount,
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
