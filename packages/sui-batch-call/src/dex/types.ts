/**
 * Sui 集中流动性 DEX 的适配层：每个 DEX 一个适配器（仓位 / 池子的解析、只读调用、交易命令），
 * 通用的部分（扫描仓位、批量只读调用、报价、发送）在 lp.ts / liquidity.ts
 */
import type { SuiClient } from '../client.js'
import type { SuiObject } from '../services.js'
import type { Argument, ObjectRef } from '../write/bcs.js'
import type { PtbBuilder } from '../write/ptb.js'

export type SuiLpProtocol = 'cetus' | 'bluefin' | 'momentum' | 'turbos' | 'flowx' | 'magma'

export interface SharedRef {
  objectId: string
  initialSharedVersion: bigint
}

export interface DexPool {
  protocol: SuiLpProtocol
  id: string
  /** Move 类型参数（Turbos 的第三个是手续费类型） */
  typeArgs: string[]
  coinA: string
  coinB: string
  /** Q64.64 */
  sqrtPrice: bigint
  tick: number
  /** 手续费率，百万分之一 */
  fee: number
  tickSpacing: number
  /** 挖矿奖励的代币（池子的奖励顺序） */
  rewardCoins: string[]
  /** 共享对象；FlowX 的池子在注册表里，为 null */
  shared: SharedRef | null
  paused: boolean
  /** Turbos：奖励金库（与 rewardCoins 对应），prepare 里补上共享版本 */
  rewardVaults?: Array<SharedRef | { objectId: string; initialSharedVersion: null }>
}

export interface DexPosition {
  protocol: SuiLpProtocol
  /** 用户拥有的对象：仓位，或 Turbos 的仓位 NFT */
  id: string
  ref: ObjectRef | null
  pool: string
  /** Turbos 的 NFT 里没有，由 loadState / 只读调用给出 */
  tickLower: number | null
  tickUpper: number | null
  liquidity: bigint | null
}

/** 构建交易 / 只读调用时的环境 */
export interface DexEnv {
  ptb: PtbBuilder
  /** 包的最新版本（storage id） */
  pkg(original: string): string
  owner: string
  clock(): Argument
  shared(ref: SharedRef, mutable: boolean): Argument
  /** 交易最后转给 owner 的对象（新仓位等） */
  keep(arg: Argument): void
  /** 交易最后转给 owner 的 Coin：同类的先合并成一个（不留下多个数量为 0 的币） */
  keepCoin(coin: Argument, coinType: string): void
  /** 只读调用里读 Coin / Balance 的数量：返回命令下标 */
  coinValue(coin: Argument, coinType: string): number
  balanceValue(balance: Argument, coinType: string): number
  /** 当前时间（毫秒），截止时间参数用 */
  now: number
}

/** 只读调用的结果：领取的手续费和奖励；Cetus 给出数量和受攻击标记，Turbos 给出 tick 和流动性 */
export interface ReadOut {
  amounts?: [bigint, bigint] | null
  fees: [bigint, bigint] | null
  rewards: bigint[] | null
  restricted?: boolean | null
  tickLower?: number
  tickUpper?: number
  liquidity?: bigint
}

export interface AddArgs {
  tickLower: number
  tickUpper: number
  coinA: Argument
  coinB: Argument
  /** 按当前价格添加的流动性和数量 */
  liquidity: bigint
  amount0: bigint
  amount1: bigint
  /** 固定的一边和数量上限 / 下限（各协议按自己的参数用） */
  fixA: boolean
  amount0Max: bigint
  amount1Max: bigint
  amount0Min: bigint
  amount1Min: bigint
}

export interface WithdrawArgs {
  liquidity: bigint
  amount0Min: bigint
  amount1Min: bigint
  /** 移除后关闭仓位（已经领取过手续费和奖励） */
  close: boolean
}

/** 读取部分（/lp 用） */
export interface DexReader {
  protocol: SuiLpProtocol
  name: string
  /** 原始包 id（类型名用它） */
  original: string
  /** 要解析最新版本的包（原始 id） */
  packages: readonly string[]
  /** 地址拥有的仓位对象的类型 */
  positionType: string
  isPool(type: string | null): boolean
  parsePosition(o: SuiObject): DexPosition | null
  parsePool(o: SuiObject): DexPool | null
  /** 补全池子需要的额外信息（如 Turbos 奖励金库的共享版本） */
  prepare?(client: SuiClient, pools: DexPool[], signal?: AbortSignal): Promise<void>
  /** 只读调用：对一个仓位领取手续费和奖励（数量从返回值读） */
  read(env: DexEnv, pos: DexPosition, pool: DexPool, position: () => Argument): (outputs: unknown[][]) => ReadOut
  /** 仓位对象里没有 tick / 流动性时（Turbos），用单独的只读调用读（不和领取放在一起，领取失败不影响它） */
  state?(env: DexEnv, pos: DexPosition): (outputs: unknown[][]) => { tickLower: number; tickUpper: number; liquidity: bigint } | null
}

/** 交易部分（/liquidity 用） */
export interface DexWriter {
  /** 交易里额外用到的包（原始 id） */
  packages: readonly string[]
  /** 新建仓位并添加流动性（仓位转给 owner） */
  open(env: DexEnv, pool: DexPool, args: AddArgs): void
  /** 往已有仓位追加 */
  add(env: DexEnv, pool: DexPool, position: Argument, args: AddArgs): void
  /** 领取手续费和奖励（claim：要领取的奖励下标，只含数量不为 0 的；有的 DEX 领取 0 会失败） */
  collect(env: DexEnv, pool: DexPool, position: Argument, claim: readonly number[]): void
  /** 移除流动性（代币给 owner），close 时再关闭仓位 */
  withdraw(env: DexEnv, pool: DexPool, position: Argument, args: WithdrawArgs): void
  /** 移除全部之前的检查（如 Cetus 受攻击影响的仓位不能全部移除） */
  checkWithdrawAll?(client: SuiClient, owner: string, pos: DexPosition, pool: DexPool, signal?: AbortSignal): Promise<void>
}

export type DexAdapter = DexReader & DexWriter
