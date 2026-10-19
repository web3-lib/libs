import type { BigNumberish } from 'ethers'

import type { LpPosition, LpProtocol, LpToken, LpVersion } from '../lp.js'
import type { SendOptions, TronSendOptions, WriteResult, WriteStatus } from '../write/send.js'

/**
 * 已有的仓位：直接传 getLpPositions 查到的 LpPosition，或者只传能定位仓位的字段。
 * - V2：pool（LP 代币地址）
 * - V3 / V4：tokenId，加上 positionManager 或 protocol（协议 id / LpProtocol）
 */
export interface PositionRef {
  pool?: string
  tokenId?: string | number | bigint
  positionManager?: string
  protocol?: string | LpProtocol
}

/** 往已有仓位追加流动性：两边数量给一边即可（另一边按当前价格算），也可以都给（按较少的一边） */
export interface IncreaseLiquidityParams {
  position: PositionRef | LpPosition
  /** token0 的数量：amount0（最小单位）和 amount0Formatted（按精度换算，如 '1.5'）二选一 */
  amount0?: BigNumberish
  amount0Formatted?: string
  amount1?: BigNumberish
  amount1Formatted?: string
}

/**
 * 新建仓位（V3 / V4：一个新的仓位 NFT；V2：往 tokenA / tokenB 的池子里加，池子不存在时创建）。
 * 两个代币不分顺序，价格都是“1 个 tokenA 值多少个 tokenB”
 */
export interface NewPositionParams {
  /** 协议 id（如 'uniswap-v3'）或自己的 LpProtocol */
  protocol: string | LpProtocol
  /** 代币地址；主币用 NATIVE_TOKEN 或零地址（V2 / V3 换成包装币、用主币支付；V4 是主币池子） */
  tokenA: string
  tokenB: string
  /** V3 / V4：手续费档位（百万分之一：500 = 0.05%） */
  fee?: number
  /** V4：tick 间距，默认按手续费档位（100 → 1、500 → 10、3000 → 60、10000 → 200） */
  tickSpacing?: number
  /** V4：池子的 hooks 合约，默认零地址 */
  hooks?: string
  /** V3 / V4：价格区间（tokenB / tokenA，取最近的可用 tick）；或直接给 tickLower / tickUpper；或 fullRange */
  priceLower?: string | number
  priceUpper?: string | number
  /** 池子里的 tick（token1 / token0 方向），必须是 tickSpacing 的整数倍 */
  tickLower?: number
  tickUpper?: number
  /** 全区间（最小到最大的可用 tick） */
  fullRange?: boolean
  /** tokenA / tokenB 的数量：amount（最小单位）和 formatted 二选一；两边给一边即可，V2 新池子两边都要给 */
  amountA?: BigNumberish
  amountAFormatted?: string
  amountB?: BigNumberish
  amountBFormatted?: string
  /** 池子不存在（或还没初始化）时用这个价格创建（tokenB / tokenA）。不传时池子不存在会报错 */
  initialPrice?: string | number
}

export type AddLiquidityParams = IncreaseLiquidityParams | NewPositionParams

export interface RemoveLiquidityParams {
  position: PositionRef | LpPosition
  /** 移除的比例（百分数，(0, 100]），默认 100 */
  percent?: number
  /** 或者直接给移除的流动性：V3 / V4 是 L，V2 是 LP 代币数量（最小单位） */
  liquidity?: BigNumberish
  /** V3 / V4：全部移除后销毁仓位 NFT，默认 false */
  burn?: boolean
}

export interface CollectFeesParams {
  /** V3 / V4 的仓位（V2 的手续费已经计入 LP 份额，没有单独领取） */
  position: PositionRef | LpPosition
}

export interface LiquidityOptions {
  /** 价格滑点（比例，0.005 = 0.5%），默认 0.005 */
  slippage?: number
  /** 交易的有效期（秒），默认 1200 */
  deadline?: number
  /** 收到 LP 代币 / 仓位 NFT / 移除的代币的地址，默认 owner */
  recipient?: string
  /**
   * V2 / V3：包装币（WETH / WBNB …）那一边用主币支付 / 收取。
   * 新建仓位时 tokenA / tokenB 传主币地址会自动开启；往已有仓位追加、移除、领取时默认 false（收到包装币）。V4 的主币池子不需要
   */
  native?: boolean
  /** 授权额度：'exact'（默认，本次需要的数量）或 'max'（无限额度，之后不用再授权） */
  approve?: 'exact' | 'max'
  /** 内置表里没有的协议（自己的 LpProtocol），定位仓位时也会用到 */
  protocols?: readonly LpProtocol[]
  /** V4：传给 hooks 的 hookData，默认 '0x' */
  hookData?: string
}

/** 一笔要发送的交易 */
export interface LiquidityTx {
  /**
   * - approve：代币授权给 Router / 仓位合约 / Permit2
   * - permit2：Permit2 授权给 V4 的仓位合约
   * - add / remove / collect：添加 / 移除流动性、领取手续费
   */
  kind: 'approve' | 'permit2' | 'add' | 'remove' | 'collect'
  to: string
  data: string
  /** 附带的主币（最小单位） */
  value: string
  /** approve / permit2：授权的代币、被授权方、额度 */
  token?: string
  spender?: string
  amount?: string
}

/**
 * 添加 / 移除流动性的计划：预计的数量 + 要按顺序发送的交易（授权在前）。
 * 只做读取、不签名，可以当作报价用（输入一边数量，看另一边要多少）
 */
export interface LiquidityPlan {
  action: 'add' | 'remove' | 'collect'
  chainId: number
  version: LpVersion
  /** 协议 id / 显示名 */
  protocol: string
  protocolName: string
  /** 池子地址（V4 为 poolId）；V2 / V3 的池子还不存在时为 null */
  pool: string | null
  /** 这次会创建（初始化）池子 */
  createPool: boolean
  owner: string
  recipient: string
  token0: LpToken
  token1: LpToken
  /** 已有仓位的 tokenId；新建 V3 / V4 仓位、V2 为 null */
  tokenId: string | null
  /** V3 / V4：仓位的 tick 区间、池子当前的 tick 和价格（token1 / token0，按精度换算，只用于展示） */
  tickLower: number | null
  tickUpper: number | null
  tick: number | null
  price: number | null
  priceLower: number | null
  priceUpper: number | null
  /** 添加 / 移除的流动性：V3 / V4 是 L；V2 是 LP 代币数量（添加时为预计） */
  liquidity: string
  /** 按当前价格预计存入 / 取出的数量（不含手续费） */
  amount0: string
  amount1: string
  amount0Formatted: string | null
  amount1Formatted: string | null
  /** 添加：最多会用掉的数量（V4 按滑点上浮；V2 / V3 即传给合约的数量）；移除：为 null */
  amount0Max: string | null
  amount1Max: string | null
  /** 移除：至少会拿到的数量（价格在滑点范围外时交易失败）；添加：为 null */
  amount0Min: string | null
  amount1Min: string | null
  /**
   * 一并领取的未领取手续费（V3 移除 / 领取；V4 修改流动性时自动领取）。V2 没有单独的手续费，为 '0'
   */
  fees0: string
  fees1: string
  fees0Formatted: string | null
  fees1Formatted: string | null
  /** 哪一边用主币支付 / 收取（V2 / V3 的包装币那一边开启 native 时；V4 主币池子的 token0）；都不是时为 null */
  native: 'token0' | 'token1' | null
  /** 主交易附带的主币 */
  value: string
  /** 交易的截止时间（秒级时间戳） */
  deadline: number
  /** 按顺序发送；不需要授权时只有一笔 */
  transactions: LiquidityTx[]
}

export interface LiquiditySendOptions extends LiquidityOptions, Omit<SendOptions, 'onUpdate'>, TronSendOptions {
  /** 发送前检查余额够不够（添加时），默认 true */
  checkBalance?: boolean
  /** 每笔交易状态变化时回调（index 是在 plan.transactions 里的下标） */
  onUpdate?: (result: LiquidityTxResult) => void
}

export interface LiquidityTxResult extends WriteResult {
  kind: LiquidityTx['kind']
}

export interface LiquidityResult {
  plan: LiquidityPlan
  /** 与 plan.transactions 一一对应 */
  results: LiquidityTxResult[]
  /** 主交易（最后一笔）的状态和哈希 */
  status: WriteStatus
  hash: string | null
  /** 新建的 V3 / V4 仓位的 tokenId（EVM 上主交易 confirmed 后从回执里读；其他情况为 null） */
  tokenId: string | null
}
