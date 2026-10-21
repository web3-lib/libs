/**
 * Raydium CPMM 的兑换：swap_base_input。报价照搬程序（raydium-cp-swap curve/calculator.rs）：
 * 交易费（含创建者手续费，从输入或输出扣）向上取整，恒定乘积向下取整，储备 = 金库余额 − 协议 / 基金 / 创建者手续费；输入输出的 Token-2022 转账手续费都算
 */
import { parseTokenAccount, type AccountInfo } from '../layout.js'
import { RAYDIUM_CPMM_AUTHORITY, RAYDIUM_CPMM_PROGRAM_ID } from '../lp.js'
import { Writer, anchorIx, r, w } from '../liquidity/common.js'
import type { Instruction } from '../write/transaction.js'
import { Bytes, UnsupportedPool, mulDivCeil, mulDivFloor, need, swapMint, transferFee, type AccountGetter, type HopQuote, type SwapEnv, type SwapMint, type SwapPool } from './common.js'

const FEE_DENOMINATOR = 1_000_000n
const POOL_SIZE = 637

interface CpmmState {
  address: string
  config: string
  vault0: string
  vault1: string
  mint0: string
  mint1: string
  observation: string
  status: number
  openTime: bigint
  reserved0: bigint
  reserved1: bigint
  creatorFeeOn: number
  creatorFeeEnabled: boolean
}

/** PoolState：amm_config 8、vault 72 / 104、mint 168 / 200、observation 296、status 329、协议 / 基金手续费 341…、open_time 373、creator_fee_on 389、enable_creator_fee 390、创建者手续费 397 / 405 */
export function parseCpmmPool(account: AccountInfo): CpmmState | null {
  if (account.owner !== RAYDIUM_CPMM_PROGRAM_ID || account.data.length !== POOL_SIZE) return null
  const b = new Bytes(account.data)
  return {
    address: account.address,
    config: b.key(8),
    vault0: b.key(72),
    vault1: b.key(104),
    mint0: b.key(168),
    mint1: b.key(200),
    observation: b.key(296),
    status: b.u8(329),
    openTime: b.u64(373),
    reserved0: b.u64(341) + b.u64(357) + b.u64(397),
    reserved1: b.u64(349) + b.u64(365) + b.u64(405),
    creatorFeeOn: b.u8(389),
    creatorFeeEnabled: b.u8(390) !== 0,
  }
}

/** 恒定乘积的兑换（与程序 CurveCalculator::swap_base_input 一致），返回给用户的输出（未扣转账手续费） */
export function cpmmSwapBaseInput(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  tradeFeeRate: bigint,
  creatorFeeRate: bigint,
  creatorFeeOnInput: boolean,
): bigint {
  let afterFee: bigint
  if (creatorFeeOnInput) {
    afterFee = amountIn - mulDivCeil(amountIn, tradeFeeRate + creatorFeeRate, FEE_DENOMINATOR)
  } else {
    afterFee = amountIn - mulDivCeil(amountIn, tradeFeeRate, FEE_DENOMINATOR)
  }
  if (afterFee < 0n) return 0n
  const swapped = mulDivFloor(afterFee, reserveOut, reserveIn + afterFee)
  return creatorFeeOnInput ? swapped : swapped - mulDivCeil(swapped, creatorFeeRate, FEE_DENOMINATOR)
}

export function cpmmPool(state: CpmmState): SwapPool {
  const mints = (get: AccountGetter): [SwapMint, SwapMint] => [
    swapMint(state.mint0, need(get, state.mint0, 'Token mint')),
    swapMint(state.mint1, need(get, state.mint1, 'Token mint')),
  ]
  return {
    protocol: 'raydium-cpmm',
    address: state.address,
    mint0: state.mint0,
    mint1: state.mint1,
    mints,
    accounts: () => [state.config, state.vault0, state.vault1, state.mint0, state.mint1],
    quote(get, amountIn, zeroForOne, env: SwapEnv): HopQuote {
      // status 第 2 位（Swap）为 1 表示禁止兑换
      if (state.status & 4) throw new UnsupportedPool('Swap is disabled on this pool')
      if (env.timestamp < state.openTime) throw new UnsupportedPool('Pool is not open yet')
      const [m0, m1] = mints(get)
      const config = need(get, state.config, 'AMM config').data
      if (config.length < 124) throw new UnsupportedPool('Unexpected AMM config')
      const c = new Bytes(config)
      // AmmConfig：trade_fee_rate 12、creator_fee_rate 108
      const tradeFeeRate = c.u64(12)
      const creatorFeeRate = state.creatorFeeEnabled ? c.u64(108) : 0n
      const v0 = parseTokenAccount(need(get, state.vault0, 'Pool vault').data).amount
      const v1 = parseTokenAccount(need(get, state.vault1, 'Pool vault').data).amount
      if (v0 < state.reserved0 || v1 < state.reserved1) throw new UnsupportedPool('Pool vault is below the owed fees')
      const [reserveIn, reserveOut] = zeroForOne ? [v0 - state.reserved0, v1 - state.reserved1] : [v1 - state.reserved1, v0 - state.reserved0]
      const [mintIn, mintOut] = zeroForOne ? [m0, m1] : [m1, m0]
      // 创建者手续费：0 两边都从输入扣；1 只收 token0；2 只收 token1（收哪种代币，卖出它时从输入扣，买入它时从输出扣）
      const creatorOnInput = state.creatorFeeOn === 0 || (state.creatorFeeOn === 1 && zeroForOne) || (state.creatorFeeOn === 2 && !zeroForOne)
      const actualIn = amountIn - transferFee(mintIn, amountIn, env.epoch)
      if (actualIn <= 0n) return { amountIn, amountOut: 0n, accounts: [] }
      const out = cpmmSwapBaseInput(actualIn, reserveIn, reserveOut, tradeFeeRate, creatorFeeRate, creatorOnInput)
      const received = out - transferFee(mintOut, out, env.epoch)
      return { amountIn, amountOut: received > 0n ? received : 0n, accounts: [] }
    },
    instruction(get, owner, input, output, zeroForOne, quote, minOut): Instruction {
      const [m0, m1] = mints(get)
      const [mintIn, mintOut] = zeroForOne ? [m0, m1] : [m1, m0]
      const [vaultIn, vaultOut] = zeroForOne ? [state.vault0, state.vault1] : [state.vault1, state.vault0]
      return {
        programId: RAYDIUM_CPMM_PROGRAM_ID,
        keys: [
          r(owner, true),
          r(RAYDIUM_CPMM_AUTHORITY),
          r(state.config),
          w(state.address),
          w(input),
          w(output),
          w(vaultIn),
          w(vaultOut),
          r(mintIn.program),
          r(mintOut.program),
          r(mintIn.mint),
          r(mintOut.mint),
          w(state.observation),
        ],
        data: new Writer().bytes(anchorIx('swap_base_input')).u64(quote.amountIn).u64(minOut).build(),
      }
    },
  }
}
