/**
 * Raydium AMM v4 的兑换：swap_base_in_v2（指令 16，不需要 OpenBook 账户）。报价照搬程序（raydium-amm processor.rs）：
 * 手续费 = ceil(输入 × swap_fee_numerator / swap_fee_denominator)，储备 = 金库余额 − need_take_pnl，恒定乘积向下取整。只支持 SPL Token
 */
import { TOKEN_PROGRAM_ID } from '../constants.js'
import { parseTokenAccount, type AccountInfo } from '../layout.js'
import { RAYDIUM_AMM_AUTHORITY, RAYDIUM_AMM_PROGRAM_ID } from '../lp.js'
import { Writer, r, w } from '../liquidity/common.js'
import type { Instruction } from '../write/transaction.js'
import { Bytes, UnsupportedPool, mulDivCeil, mulDivFloor, need, swapMint, type AccountGetter, type HopQuote, type SwapMint, type SwapPool } from './common.js'

const POOL_SIZE = 752
/**
 * 只支持 SwapOnly（6，不再用 OpenBook 挂单，现在的池子基本都是）：swap_base_in_v2 不带 OpenBook 账户，
 * 还连着 OpenBook 的池子（Initialized 1、WaitingTrade 7）没有对照程序源码验证过能不能用，不报价，免得排第一后在链上失败
 */
const SWAP_STATUSES = new Set([6n])

interface AmmState {
  address: string
  status: bigint
  swapFeeNumerator: bigint
  swapFeeDenominator: bigint
  needTakePnl0: bigint
  needTakePnl1: bigint
  openTime: bigint
  vault0: string
  vault1: string
  mint0: string
  mint1: string
}

/** AmmInfo（无判别符）：status 0、fees.swap_fee 176 / 184、need_take_pnl_coin 192、need_take_pnl_pc 200、pool_open_time 224、vault 336 / 368、mint 400 / 432 */
export function parseAmmV4Pool(account: AccountInfo): AmmState | null {
  if (account.owner !== RAYDIUM_AMM_PROGRAM_ID || account.data.length !== POOL_SIZE) return null
  const b = new Bytes(account.data)
  return {
    address: account.address,
    status: b.u64(0),
    swapFeeNumerator: b.u64(176),
    swapFeeDenominator: b.u64(184),
    needTakePnl0: b.u64(192),
    needTakePnl1: b.u64(200),
    openTime: b.u64(224),
    vault0: b.key(336),
    vault1: b.key(368),
    mint0: b.key(400),
    mint1: b.key(432),
  }
}

export function ammV4Pool(state: AmmState): SwapPool {
  const mints = (get: AccountGetter): [SwapMint, SwapMint] => [
    swapMint(state.mint0, need(get, state.mint0, 'Token mint')),
    swapMint(state.mint1, need(get, state.mint1, 'Token mint')),
  ]
  return {
    protocol: 'raydium-amm',
    address: state.address,
    mint0: state.mint0,
    mint1: state.mint1,
    mints,
    accounts: () => [state.vault0, state.vault1, state.mint0, state.mint1],
    quote(get, amountIn, zeroForOne, env): HopQuote {
      if (!SWAP_STATUSES.has(state.status)) throw new UnsupportedPool(`Swap is not allowed in pool status ${state.status}`)
      if (env.timestamp < state.openTime) throw new UnsupportedPool('Pool is not open yet')
      if (state.swapFeeDenominator === 0n) throw new UnsupportedPool('Invalid pool fees')
      const [m0, m1] = mints(get)
      if (m0.program !== TOKEN_PROGRAM_ID || m1.program !== TOKEN_PROGRAM_ID) throw new UnsupportedPool('AMM v4 supports only SPL Token mints')
      const v0 = parseTokenAccount(need(get, state.vault0, 'Pool vault').data).amount
      const v1 = parseTokenAccount(need(get, state.vault1, 'Pool vault').data).amount
      if (v0 < state.needTakePnl0 || v1 < state.needTakePnl1) throw new UnsupportedPool('Pool vault is below the pending PnL')
      const [reserveIn, reserveOut] = zeroForOne ? [v0 - state.needTakePnl0, v1 - state.needTakePnl1] : [v1 - state.needTakePnl1, v0 - state.needTakePnl0]
      const fee = mulDivCeil(amountIn, state.swapFeeNumerator, state.swapFeeDenominator)
      const afterFee = amountIn - fee
      const out = afterFee > 0n ? mulDivFloor(reserveOut, afterFee, reserveIn + afterFee) : 0n
      // 程序要求输出小于储备
      return { amountIn, amountOut: out < reserveOut ? out : 0n, accounts: [] }
    },
    instruction(_get, owner, input, output, _zeroForOne, quote, minOut): Instruction {
      return {
        programId: RAYDIUM_AMM_PROGRAM_ID,
        keys: [r(TOKEN_PROGRAM_ID), w(state.address), r(RAYDIUM_AMM_AUTHORITY), w(state.vault0), w(state.vault1), w(input), w(output), r(owner, true)],
        data: new Writer().u8(16).u64(quote.amountIn).u64(minOut).build(),
      }
    },
  }
}
