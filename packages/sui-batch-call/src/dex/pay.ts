/** 交易里付款的币：从 gas 币或发送者的 Coin（+ 地址余额）拆出；找零 / 领取的币合并回发送者已有的 Coin */
import { SUI_COIN_TYPE } from '../address.js'
import { pure, type Argument } from '../write/bcs.js'
import type { PtbBuilder } from '../write/ptb.js'
import type { BuildContext } from '../write/send.js'
import { MAX_MERGE_COINS, gatherCoin } from '../write/transfer.js'

/** 从 gas 币拆 SUI 时至少要多出这么多留给 gas（0.001 SUI，实际够不够由模拟决定） */
const GAS_MARGIN = 1_000_000n

/**
 * 发送者付 amount 的 coinType：SUI 从 gas 币拆（自己付 gas 时），其他按 Coin + 地址余额凑。
 * source 是拆出它的、交易后还在发送者名下的 Coin（找零可以合并回去），没有时为 null。
 * clean：交给入口函数（entry）用的币，不能来自 Move 调用（地址余额取出、coin::zero），只用 Coin 对象
 */
export async function payCoin(
  ptb: PtbBuilder,
  ctx: BuildContext,
  owner: string,
  coinType: string,
  amount: bigint,
  fromGas: boolean,
  clean = false,
): Promise<{ coin: Argument; gasSpend: bigint; source: Argument | (() => Argument) | null }> {
  if (amount === 0n) {
    if (clean) throw new Error(`The amount of ${coinType} must be greater than 0`)
    return { coin: ptb.moveCall('0x2::coin::zero', [coinType], []), gasSpend: 0n, source: await sinkFor(ptb, ctx, owner, coinType, fromGas) }
  }
  // SUI：自己付 gas、SUI Coin 足够（多出一点留给 gas）时从 gas 币拆，否则按 Coin + 地址余额凑。
  // 入口函数（clean）也从 gas 币拆：只能用 Coin 对象，把它们当输入就没有 gas 币了（够不够由模拟决定）
  if (
    fromGas &&
    coinType === SUI_COIN_TYPE &&
    (clean || (await ctx.coins(owner, SUI_COIN_TYPE, amount + GAS_MARGIN)).slice(0, 255).reduce((s, c) => s + c.balance, 0n) >= amount + GAS_MARGIN)
  ) {
    const split = ptb.command({ kind: 'splitCoins', coin: ptb.gas, amounts: [ptb.pure(pure.u64(amount))] })
    return { coin: ptb.nested(split, 0), gasSpend: amount, source: ptb.gas }
  }
  if (clean) {
    // 入口函数（entry）不接受 Move 调用产生的币（地址余额取出的、coin::zero）：只用 Coin 对象
    const coins = await ctx.coins(owner, coinType, amount)
    let sum = 0n
    const picked = []
    for (const c of coins) {
      if (sum >= amount || picked.length >= MAX_MERGE_COINS) break
      picked.push(c)
      sum += c.balance
    }
    if (sum < amount) throw new Error(`Not enough ${coinType} in coin objects: need ${amount}, the ${picked.length} largest coins hold ${sum} (this DEX does not take funds from the address balance)`)
    const [primary, ...rest] = picked.map((c) => ptb.owned(c))
    for (let i = 0; i < rest.length; i += 500) ptb.command({ kind: 'mergeCoins', destination: primary as Argument, sources: rest.slice(i, i + 500) })
    const split = ptb.command({ kind: 'splitCoins', coin: primary as Argument, amounts: [ptb.pure(pure.u64(amount))] })
    return { coin: ptb.nested(split, 0), gasSpend: 0n, source: primary as Argument }
  }
  const source = await gatherCoin(ptb, ctx, owner, coinType, amount)
  // 全部来自地址余额时正好是 amount，整个传进去
  if (source.temporary) return { coin: source.coin, gasSpend: 0n, source: null }
  const split = ptb.command({ kind: 'splitCoins', coin: source.coin, amounts: [ptb.pure(pure.u64(amount))] })
  return { coin: ptb.nested(split, 0), gasSpend: 0n, source: source.coin }
}

/**
 * 发送者已有的一个 coinType 的 Coin（交易里还没用到的）：找零和领取的币合并进去，不新建对象。
 * SUI 在发送者自己付 gas 时用 gas 币；没有时为 null（照常转给发送者）
 */
export async function sinkFor(ptb: PtbBuilder, ctx: BuildContext, owner: string, coinType: string, fromGas: boolean): Promise<Argument | (() => Argument) | null> {
  if (coinType === SUI_COIN_TYPE) return fromGas ? ptb.gas : null
  const [coin] = await ctx.coins(owner, coinType, 1n)
  return coin ? () => ptb.owned(coin) : null
}

/**
 * 链上的数量下限：从 coin 里拆出 min 再合并回去，不够时 SplitCoins 失败、整笔交易失败。
 * 合约本身不检查下限时用（Kriya AMM 移除、Aftermath 按比例存取、Cetus DLMM 移除）
 */
export function guardMin(ptb: PtbBuilder, coin: Argument, min: bigint): void {
  if (min <= 0n) return
  const split = ptb.command({ kind: 'splitCoins', coin, amounts: [ptb.pure(pure.u64(min))] })
  ptb.command({ kind: 'mergeCoins', destination: coin, sources: [ptb.nested(split, 0)] })
}
