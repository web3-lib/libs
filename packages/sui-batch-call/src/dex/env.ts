import { latestPackage } from '../cetus.js'
import type { GrpcTransport } from '../grpc.js'
import { pure, type Argument } from '../write/bcs.js'
import type { PtbBuilder } from '../write/ptb.js'
import type { DexEnv, SharedRef } from './types.js'

export const CLOCK: SharedRef = { objectId: '0x0000000000000000000000000000000000000000000000000000000000000006', initialSharedVersion: 1n }

/** 解析适配器用到的包的最新版本 */
export async function resolvePackages(t: GrpcTransport, adapters: ReadonlyArray<{ packages: readonly string[] }>): Promise<Map<string, string>> {
  const originals = [...new Set(adapters.flatMap((a) => a.packages))]
  const latest = await Promise.all(originals.map((o) => latestPackage(t, o)))
  return new Map(originals.map((o, i) => [o, latest[i] as string]))
}

/**
 * 交易 / 只读调用的环境；finish() 把要留给 owner 的对象转过去。
 * sink(coinType, coin)：留给 owner 的这类 Coin 合并进 owner 已有的这个 Coin（找零、领取常有数量为 0 的，不新建对象）；
 * 传函数时只在真的要合并时才把它加进交易（没有要留下的币时不碰这个 Coin）
 */
export function createEnv(ptb: PtbBuilder, owner: string, packages: Map<string, string>): DexEnv & { finish(): void; sink(coinType: string, coin: Argument | (() => Argument)): void } {
  const kept: Argument[] = []
  const coins = new Map<string, Argument[]>()
  const sinks = new Map<string, Argument | (() => Argument)>()
  return {
    ptb,
    owner,
    now: Date.now(),
    pkg(original) {
      const p = packages.get(original)
      if (!p) throw new Error(`Package ${original} is not resolved`)
      return p
    },
    clock: () => ptb.object({ kind: 'shared', ...CLOCK, mutable: false }),
    shared: (ref, mutable) => ptb.object({ kind: 'shared', ...ref, mutable }),
    keep: (arg) => void kept.push(arg),
    keepCoin(coin, coinType) {
      coins.set(coinType, [...(coins.get(coinType) ?? []), coin])
    },
    coinValue(coin, coinType) {
      const r = ptb.moveCall('0x2::coin::value', [coinType], [coin])
      return (r as { index: number }).index
    },
    balanceValue(balance, coinType) {
      const r = ptb.moveCall('0x2::balance::value', [coinType], [balance])
      return (r as { index: number }).index
    },
    sink(coinType, coin) {
      sinks.set(coinType, coin)
    },
    finish() {
      // 同类的 Coin 合并成一个再转（领取 / 找零里常有数量为 0 的，合并后不会留下空币）；有 sink 时合并进 owner 已有的 Coin
      for (const [coinType, list] of coins) {
        const sink = sinks.get(coinType)
        if (sink) {
          if (list.length) ptb.command({ kind: 'mergeCoins', destination: typeof sink === 'function' ? sink() : sink, sources: list })
          continue
        }
        const [first, ...rest] = list
        if (!first) continue
        if (rest.length) ptb.command({ kind: 'mergeCoins', destination: first, sources: rest })
        kept.push(first)
      }
      coins.clear()
      if (kept.length) ptb.command({ kind: 'transferObjects', objects: [...kept], address: ptb.pure(pure.address(owner)) })
      kept.length = 0
    },
  }
}

/** Balance → Coin，留给 owner */
export function keepBalance(env: DexEnv, balance: Argument, coinType: string): void {
  env.keepCoin(env.ptb.moveCall('0x2::coin::from_balance', [coinType], [balance]), coinType)
}

export const big = (v: unknown) => BigInt(String(v))
