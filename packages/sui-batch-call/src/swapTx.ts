/**
 * 兑换的交易命令（只在 /swap、/risk 里用到）：每个 DEX 一个函数，把传入的 Coin 全部卖出（exact input），返回买到的 Coin。
 * 集中流动性用各 DEX 的 swap / flash_swap（价格上限给到最大，不在这里限制数量），传统 AMM、Aftermath 用 public 的 swap 函数；
 * 最少收到多少由调用方在最后一跳之后检查（guardMin）。用剩的输入币要正好为 0（destroy_zero），没有卖完时整笔失败
 */
import { CETUS } from './cetus.js'
import { AFTERMATH, type AftermathPool } from './aftermath.js'
import { call as aftermathCall } from './aftermathTx.js'
import { PKG as DIPCOIN, GLOBAL as DIPCOIN_GLOBAL } from './amm/dipcoin.js'
import { PKG as FLOWX_V2, CONTAINER as FLOWX_V2_CONTAINER } from './amm/flowxV2.js'
import { PKG as KRIYA_AMM } from './amm/kriya.js'
import type { AmmPool } from './amm/types.js'
import { PKG as BLUEFIN, CONFIG as BLUEFIN_CONFIG } from './dex/bluefin.js'
import { CETUS_CONFIG, MAGMA_CONFIG } from './dex/cetus.js'
import { PKG as FLOWX, POOL_REGISTRY as FLOWX_REGISTRY, VERSIONED as FLOWX_VERSIONED } from './dex/flowx.js'
import { KRIYA_CLMM_CONFIG, MOMENTUM_CONFIG, type MomentumLike } from './dex/momentum.js'
import { PKG as TURBOS, VERSIONED as TURBOS_VERSIONED } from './dex/turbos.js'
import type { DexEnv, DexPool, SharedRef, SuiLpProtocol } from './dex/types.js'
import { CETUS_DLMM, type DlmmPool } from './dlmm.js'
import { pure, type Argument } from './write/bcs.js'

/** 集中流动性的 sqrt 价格范围（Q64.64，tick ±443636），兑换时价格上限给到边界内一点 */
export const MIN_SQRT_PRICE = 4295048016n
export const MAX_SQRT_PRICE = 79226673515401279992447579055n

/** 可以兑换的池子：两种币的池子按池子的币顺序（coins[0] 是 A / X），Aftermath 是池子里的全部币 */
export type SwapPoolData =
  | { kind: 'clmm'; pool: DexPool }
  | { kind: 'dlmm'; pool: DlmmPool }
  | { kind: 'amm'; pool: AmmPool }
  | { kind: 'multi'; pool: AftermathPool }

export interface SwapPool {
  protocol: SuiLpProtocol
  /** 池子对象 ID（FlowX V2 是 pairs 表里的字段对象，DAO 费池子是里面的 Pool） */
  id: string
  coins: string[]
  /** 手续费率，百万分之一 */
  fee: number | null
  data: SwapPoolData
}

/** 构建兑换命令要解析最新版本的包（原始 id） */
export const SWAP_PACKAGES: Readonly<Record<SuiLpProtocol, readonly string[]>> = {
  cetus: [CETUS_CONFIG.integrate],
  magma: [MAGMA_CONFIG.integrate],
  bluefin: [BLUEFIN],
  momentum: [MOMENTUM_CONFIG.pkg],
  'kriya-clmm': [KRIYA_CLMM_CONFIG.pkg],
  turbos: [TURBOS],
  flowx: [FLOWX],
  'cetus-dlmm': [CETUS_DLMM.pkg],
  dipcoin: [DIPCOIN],
  'flowx-v2': [FLOWX_V2],
  'kriya-amm': [KRIYA_AMM],
  aftermath: [AFTERMATH.amm, AFTERMATH.dao],
}

const value = (env: DexEnv, coin: Argument, type: string) => env.ptb.moveCall('0x2::coin::value', [type], [coin])
const destroyZero = (env: DexEnv, coin: Argument, type: string) => void env.ptb.moveCall('0x2::coin::destroy_zero', [type], [coin])
const destroyZeroBalance = (env: DexEnv, balance: Argument, type: string) => void env.ptb.moveCall('0x2::balance::destroy_zero', [type], [balance])
const intoBalance = (env: DexEnv, coin: Argument, type: string) => env.ptb.moveCall('0x2::coin::into_balance', [type], [coin])
const fromBalance = (env: DexEnv, balance: Argument, type: string) => env.ptb.moveCall('0x2::coin::from_balance', [type], [balance])
const zeroBalance = (env: DexEnv, type: string) => env.ptb.moveCall('0x2::balance::zero', [type], [])
/** 价格上限：A → B 价格往下走，B → A 往上走 */
const limit = (env: DexEnv, a2b: boolean) => env.ptb.pure(pure.u128(a2b ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n))
const deadline = (env: DexEnv) => env.ptb.pure(pure.u64(BigInt(env.now + 10 * 60_000)))

/** 从 coinIn 里拆出 amount 还给池子（flash swap 的欠款），coinIn 剩下的要是 0 */
function payDebt(env: DexEnv, coinIn: Argument, typeIn: string, amount: Argument): Argument {
  const pay = env.ptb.moveCall('0x2::coin::split', [typeIn], [coinIn, amount])
  destroyZero(env, coinIn, typeIn)
  return intoBalance(env, pay, typeIn)
}

function cetusLike(env: DexEnv, integrate: string, config: SharedRef, pool: DexPool, coinIn: Argument, a2b: boolean): Argument {
  const ptb = env.ptb
  const [typeIn, typeOut] = a2b ? [pool.coinA, pool.coinB] : [pool.coinB, pool.coinA]
  const amount = value(env, coinIn, typeIn)
  const zero = ptb.moveCall('0x2::coin::zero', [typeOut], [])
  const out = ptb.moveCall(`${env.pkg(integrate)}::router::swap`, pool.typeArgs, [
    env.shared(config, false),
    env.shared(pool.shared as SharedRef, true),
    a2b ? coinIn : zero,
    a2b ? zero : coinIn,
    ptb.pure(pure.bool(a2b)),
    ptb.pure(pure.bool(true)),
    amount,
    limit(env, a2b),
    ptb.pure(pure.bool(false)),
    env.clock(),
  ])
  destroyZero(env, ptb.nested(out, a2b ? 0 : 1), typeIn)
  return ptb.nested(out, a2b ? 1 : 0)
}

function bluefin(env: DexEnv, pool: DexPool, coinIn: Argument, a2b: boolean): Argument {
  const ptb = env.ptb
  const [typeIn, typeOut] = a2b ? [pool.coinA, pool.coinB] : [pool.coinB, pool.coinA]
  const amount = value(env, coinIn, typeIn)
  const balIn = intoBalance(env, coinIn, typeIn)
  const zero = zeroBalance(env, typeOut)
  const out = ptb.moveCall(`${env.pkg(BLUEFIN)}::pool::swap`, pool.typeArgs, [
    env.clock(),
    env.shared(BLUEFIN_CONFIG, false),
    env.shared(pool.shared as SharedRef, true),
    a2b ? balIn : zero,
    a2b ? zero : balIn,
    ptb.pure(pure.bool(a2b)),
    ptb.pure(pure.bool(true)),
    amount,
    ptb.pure(pure.u64(0n)),
    limit(env, a2b),
  ])
  destroyZeroBalance(env, ptb.nested(out, a2b ? 0 : 1), typeIn)
  return fromBalance(env, ptb.nested(out, a2b ? 1 : 0), typeOut)
}

function momentumLike(env: DexEnv, c: MomentumLike, pool: DexPool, coinIn: Argument, a2b: boolean): Argument {
  const ptb = env.ptb
  const pkg = env.pkg(c.pkg)
  const [typeIn, typeOut] = a2b ? [pool.coinA, pool.coinB] : [pool.coinB, pool.coinA]
  const poolArg = env.shared(pool.shared as SharedRef, true)
  const flash = ptb.moveCall(`${pkg}::trade::flash_swap`, pool.typeArgs, [
    poolArg,
    ptb.pure(pure.bool(a2b)),
    ptb.pure(pure.bool(true)),
    value(env, coinIn, typeIn),
    limit(env, a2b),
    env.clock(),
    env.shared(c.version, false),
  ])
  const receipt = ptb.nested(flash, 2)
  const debts = ptb.moveCall(`${pkg}::trade::swap_receipt_debts`, [], [receipt])
  const pay = payDebt(env, coinIn, typeIn, ptb.nested(debts, a2b ? 0 : 1))
  destroyZeroBalance(env, ptb.nested(flash, a2b ? 0 : 1), typeIn)
  const zero = zeroBalance(env, typeOut)
  ptb.moveCall(`${pkg}::trade::repay_flash_swap`, pool.typeArgs, [poolArg, receipt, a2b ? pay : zero, a2b ? zero : pay, env.shared(c.version, false)])
  return fromBalance(env, ptb.nested(flash, a2b ? 1 : 0), typeOut)
}

function turbos(env: DexEnv, pool: DexPool, coinIn: Argument, a2b: boolean): Argument {
  const ptb = env.ptb
  const typeIn = a2b ? pool.coinA : pool.coinB
  const amount = value(env, coinIn, typeIn)
  const out = ptb.moveCall(`${env.pkg(TURBOS)}::swap_router::${a2b ? 'swap_a_b_with_return_' : 'swap_b_a_with_return_'}`, pool.typeArgs, [
    env.shared(pool.shared as SharedRef, true),
    ptb.command({ kind: 'makeMoveVec', type: `0x2::coin::Coin<${typeIn}>`, elements: [coinIn] }),
    amount,
    ptb.pure(pure.u64(0n)),
    limit(env, a2b),
    ptb.pure(pure.bool(true)),
    ptb.pure(pure.address(env.owner)),
    deadline(env),
    env.clock(),
    env.shared(TURBOS_VERSIONED, false),
  ])
  destroyZero(env, ptb.nested(out, 1), typeIn)
  return ptb.nested(out, 0)
}

function flowx(env: DexEnv, pool: DexPool, coinIn: Argument, a2b: boolean): Argument {
  const ptb = env.ptb
  const [typeIn, typeOut] = a2b ? [pool.coinA, pool.coinB] : [pool.coinB, pool.coinA]
  // 类型参数是 <卖出, 买入>，注册表按手续费档位找池子
  return ptb.moveCall(`${env.pkg(FLOWX)}::swap_router::swap_exact_input`, [typeIn, typeOut], [
    env.shared(FLOWX_REGISTRY, true),
    ptb.pure(pure.u64(BigInt(pool.fee))),
    coinIn,
    ptb.pure(pure.u64(0n)),
    limit(env, a2b),
    deadline(env),
    env.shared(FLOWX_VERSIONED, false),
    env.clock(),
  ])
}

function dlmm(env: DexEnv, pool: DlmmPool, coinIn: Argument, a2b: boolean): Argument {
  const ptb = env.ptb
  const pkg = env.pkg(CETUS_DLMM.pkg)
  const [typeIn, typeOut] = a2b ? [pool.coinA, pool.coinB] : [pool.coinB, pool.coinA]
  const args = [pool.coinA, pool.coinB]
  const poolArg = env.shared(pool.shared, true)
  const flash = ptb.moveCall(`${pkg}::pool::flash_swap`, args, [
    poolArg,
    ptb.pure(pure.bool(a2b)),
    ptb.pure(pure.bool(true)),
    value(env, coinIn, typeIn),
    env.shared(CETUS_DLMM.config, false),
    env.shared(CETUS_DLMM.versioned, false),
    env.clock(),
  ])
  const receipt = ptb.nested(flash, 2)
  const pay = payDebt(env, coinIn, typeIn, ptb.moveCall(`${pkg}::pool::pay_amount`, args, [receipt]))
  destroyZeroBalance(env, ptb.nested(flash, a2b ? 0 : 1), typeIn)
  const zero = zeroBalance(env, typeOut)
  ptb.moveCall(`${pkg}::pool::repay_flash_swap`, args, [poolArg, a2b ? pay : zero, a2b ? zero : pay, receipt, env.shared(CETUS_DLMM.versioned, false)])
  return fromBalance(env, ptb.nested(flash, a2b ? 1 : 0), typeOut)
}

function amm(env: DexEnv, pool: AmmPool, coinIn: Argument, a2b: boolean): Argument {
  const ptb = env.ptb
  const args = [pool.coinA, pool.coinB]
  const zero = ptb.pure(pure.u64(0n))
  switch (pool.protocol) {
    case 'dipcoin':
      return ptb.moveCall(`${env.pkg(DIPCOIN)}::router::${a2b ? 'swap_exact_x_to_y_with_return' : 'swap_exact_y_to_x_with_return'}`, args, [
        env.shared(DIPCOIN_GLOBAL, false),
        env.shared(pool.shared as SharedRef, true),
        coinIn,
        zero,
      ])
    case 'flowx-v2':
      // Container 里按两种币找池子；类型参数是 <卖出, 买入>
      return ptb.moveCall(`${env.pkg(FLOWX_V2)}::router::swap_exact_input_direct`, a2b ? args : [pool.coinB, pool.coinA], [env.shared(FLOWX_V2_CONTAINER, true), coinIn])
    case 'kriya-amm':
      return ptb.moveCall(`${env.pkg(KRIYA_AMM)}::spot_dex::${a2b ? 'swap_token_x' : 'swap_token_y'}`, args, [
        env.shared(pool.shared as SharedRef, true),
        coinIn,
        value(env, coinIn, a2b ? pool.coinA : pool.coinB),
        zero,
      ])
  }
}

function aftermath(env: DexEnv, pool: AftermathPool, coinIn: Argument, typeIn: string, typeOut: string): Argument {
  const { pkg, head } = aftermathCall(env, pool)
  return env.ptb.moveCall(`${pkg}::swap::swap_exact_in_direct`, [pool.lpCoinType, typeIn, typeOut], [...head, coinIn, env.ptb.pure(pure.u64(0n))])
}

/** 把 coinIn（typeIn）全部卖成 typeOut，返回买到的 Coin */
export function swapCommand(env: DexEnv, p: SwapPool, coinIn: Argument, typeIn: string, typeOut: string): Argument {
  const d = p.data
  if (d.kind === 'multi') return aftermath(env, d.pool, coinIn, typeIn, typeOut)
  const a2b = typeIn === p.coins[0]
  if (d.kind === 'dlmm') return dlmm(env, d.pool, coinIn, a2b)
  if (d.kind === 'amm') return amm(env, d.pool, coinIn, a2b)
  const pool = d.pool
  switch (pool.protocol) {
    case 'cetus':
      return cetusLike(env, CETUS.integrate, CETUS.globalConfig, pool, coinIn, a2b)
    case 'magma':
      return cetusLike(env, MAGMA_CONFIG.integrate, MAGMA_CONFIG.config, pool, coinIn, a2b)
    case 'bluefin':
      return bluefin(env, pool, coinIn, a2b)
    case 'momentum':
      return momentumLike(env, MOMENTUM_CONFIG, pool, coinIn, a2b)
    case 'kriya-clmm':
      return momentumLike(env, KRIYA_CLMM_CONFIG, pool, coinIn, a2b)
    case 'turbos':
      return turbos(env, pool, coinIn, a2b)
    case 'flowx':
      return flowx(env, pool, coinIn, a2b)
  }
}
