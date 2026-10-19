/**
 * 传统 AMM（x·y = k，LP 是一种代币）的适配层：每个 DEX 一个适配器（找池子、解析池子、加减流动性的命令），
 * 通用的部分（找持有的 LP、按份额算数量、报价、发送）在 lp.ts / liquidity.ts
 */
import type { SuiClient } from '../client.js'
import type { DexEnv, SharedRef } from '../dex/types.js'
import type { SuiObject } from '../services.js'
import type { Argument, ObjectRef } from '../write/bcs.js'

export type SuiAmmProtocol = 'dipcoin' | 'flowx-v2' | 'kriya-amm'

export interface AmmPool {
  protocol: SuiAmmProtocol
  /** 池子对象 ID（FlowX V2 的池子是 Container 里的动态字段，这里是字段对象的 ID） */
  id: string
  /** 池子的两种代币（Move 类型参数的顺序，即 token0 / token1） */
  coinA: string
  coinB: string
  /** LP 能按份额取回的储备（不含协议手续费） */
  reserveA: bigint
  reserveB: bigint
  /** LP 总量（含锁定的最小流动性） */
  lpSupply: bigint
  /** LP 代币的类型 */
  lpCoinType: string
  /** 交易手续费率，百万分之一 */
  fee: number
  /** 稳定币曲线（Kriya 的 stable 池子） */
  stable: boolean
  /** 共享的池子对象；FlowX V2 为 null（交易时传 Container） */
  shared: SharedRef | null
  depositEnabled: boolean
  withdrawEnabled: boolean
  /** 添加时 LP 少于这个数合约会拒绝（DipCoin） */
  minLp: bigint
}

/** 地址持有的一份 LP */
export interface AmmHolding {
  protocol: SuiAmmProtocol
  lpCoinType: string
  coinA: string
  coinB: string
  balance: bigint
  /** LP 放在单独对象里的（Kriya 的 KriyaLPToken）：对象 ID、引用、所属池子；LP 是普通 Coin 时为 null */
  position: string | null
  ref: ObjectRef | null
  pool: string | null
}

export interface AmmAddArgs {
  coinA: Argument
  coinB: Argument
  amountA: bigint
  amountB: bigint
  minA: bigint
  minB: bigint
}

export interface AmmRemoveArgs {
  /** Coin<LP>（正好是 lpAmount），或 Kriya 的 KriyaLPToken（按 lpAmount 取，剩下的由合约退回） */
  lp: Argument
  lpAmount: bigint
  minA: bigint
  minB: bigint
}

/** 读取部分（/lp 用） */
export interface AmmReader {
  protocol: SuiAmmProtocol
  name: string
  /** 要解析最新版本的包（原始 id） */
  packages: readonly string[]
  /** LP 是普通 Coin 时：LP 代币类型的前缀（如 `0x…::manage::LP<`），从地址的余额里认出来 */
  lpCoinPrefix?: string
  /** LP 放在对象里时：对象类型的前缀（地址拥有的对象里扫描） */
  positionPrefix?: string
  parseHolding?(o: SuiObject): AmmHolding | null
  /** 是不是这个 DEX 的池子对象（按池子 ID 加减流动性时用） */
  isPool(type: string | null): boolean
  parsePool(o: SuiObject): AmmPool | null
  /** 找池子：每份 LP 一个结果（找不到为 null）；LP 是 Coin 时按两种代币找，Kriya 按 pool */
  loadPools(client: SuiClient, holdings: readonly AmmHolding[], signal?: AbortSignal): Promise<Array<AmmPool | null>>
}

/** 交易部分（/liquidity 用） */
export interface AmmWriter {
  /** 交易里额外用到的包（原始 id） */
  packages: readonly string[]
  /** 用的是入口函数（entry）：参数里的币不能来自 Move 调用（如地址余额取出的、coin::zero） */
  entry: boolean
  add(env: DexEnv, pool: AmmPool, args: AmmAddArgs): void
  remove(env: DexEnv, pool: AmmPool, args: AmmRemoveArgs): void
}

export type AmmAdapter = AmmReader & AmmWriter
