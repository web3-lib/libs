import type { SolanaLpPosition, SolanaLpProtocol, SolanaLpToken } from '../lp.js'
import type { SendOptions, WriteResult, WriteStatus } from '../write/send.js'
import type { Instruction } from '../write/transaction.js'

type Amount = bigint | number | string

/**
 * 已有的仓位：直接传 getLpPositions 查到的 SolanaLpPosition，或者只传能定位仓位的字段：
 * - Raydium CLMM / Orca Whirlpool：positionMint（仓位 NFT 的 mint）
 * - Raydium AMM v4 / CPMM：pool（池子地址）
 */
export interface SolanaPositionRef {
  protocol: SolanaLpProtocol
  positionMint?: string
  pool?: string
}

/** 往已有仓位追加：两边数量给一边即可（另一边按当前价格算），也可以都给（按较少的一边） */
export interface SolanaIncreaseLiquidityParams {
  position: SolanaPositionRef | SolanaLpPosition
  /** token0 的数量：amount0（最小单位）和 amount0Formatted（按精度换算，如 '1.5'）二选一 */
  amount0?: Amount
  amount0Formatted?: string
  amount1?: Amount
  amount1Formatted?: string
}

/**
 * 新建仓位（Raydium CLMM / Orca：一个新的仓位 NFT；AMM v4 / CPMM：往池子里加流动性，拿到 LP 代币）。
 * 池子用地址指定（Solana 上同一对代币有很多池子，按地址最明确）；价格是“1 个 token0 值多少个 token1”（池子的方向）
 */
export interface SolanaNewPositionParams {
  protocol: SolanaLpProtocol
  pool: string
  /** 集中流动性：价格区间（token1 / token0，取最近的可用 tick）；或直接给 tick；或 fullRange */
  priceLower?: string | number
  priceUpper?: string | number
  tickLower?: number
  tickUpper?: number
  fullRange?: boolean
  amount0?: Amount
  amount0Formatted?: string
  amount1?: Amount
  amount1Formatted?: string
}

export type SolanaAddLiquidityParams = SolanaIncreaseLiquidityParams | SolanaNewPositionParams

export interface SolanaRemoveLiquidityParams {
  position: SolanaPositionRef | SolanaLpPosition
  /** 移除的比例（百分数，(0, 100]），默认 100 */
  percent?: number
  /** 或者直接给移除的数量：集中流动性是 L，AMM 是 LP 代币数量（最小单位） */
  liquidity?: Amount
  /** 集中流动性：全部移除后关闭仓位、销毁 NFT（退回租金），默认 false */
  burn?: boolean
}

export interface SolanaCollectFeesParams {
  /** 集中流动性的仓位（AMM 的手续费已经计入 LP 份额） */
  position: SolanaPositionRef | SolanaLpPosition
}

export interface SolanaLiquidityOptions {
  /** 价格滑点（比例，0.005 = 0.5%），默认 0.005 */
  slippage?: number
  /**
   * Wrapped SOL 那一边用 SOL 支付 / 收取（自动包装 / 解包），默认 true。
   * 用的是 wSOL 的关联代币账户：原来没有时创建、用完关闭（剩余的 wSOL 换回 SOL）；原来就有时只补差额、不关闭
   */
  native?: boolean
  /** 新建仓位的 NFT 归谁，默认 owner */
  recipient?: string
  /** 取消读取 */
  signal?: AbortSignal
}

/** 一步：要原子执行的一组指令 */
export interface SolanaLiquidityStep {
  /**
   * - setup：创建代币账户、初始化 tick 数组等准备工作（与主指令能放进同一笔交易时会合并）
   * - add / remove / collect：添加 / 移除流动性、领取手续费
   */
  kind: 'setup' | 'add' | 'remove' | 'collect'
  instructions: Instruction[]
}

/** 添加 / 移除流动性的计划：预计的数量 + 按顺序执行的指令。只读取、不签名，可以当作报价 */
export interface SolanaLiquidityPlan {
  action: 'add' | 'remove' | 'collect'
  protocol: SolanaLpProtocol
  protocolName: string
  type: 'clmm' | 'amm'
  pool: string
  owner: string
  token0: SolanaLpToken
  token1: SolanaLpToken
  /** 集中流动性：仓位 NFT 的 mint（新建时是新生成的，见 signers）和仓位账户 */
  positionMint: string | null
  position: string | null
  /** AMM：LP 代币的 mint */
  lpMint: string | null
  /** 集中流动性：区间、池子当前的 tick 和价格（token1 / token0，按精度换算，只用于展示） */
  tickLower: number | null
  tickUpper: number | null
  tick: number | null
  price: number | null
  priceLower: number | null
  priceUpper: number | null
  /** 添加 / 移除的流动性：集中流动性是 L；AMM 是 LP 代币数量 */
  liquidity: string
  /** 按当前价格预计存入 / 取出的数量（不含手续费） */
  amount0: string
  amount1: string
  amount0Formatted: string | null
  amount1Formatted: string | null
  /** 添加：最多会用掉的数量（按滑点）；移除：null */
  amount0Max: string | null
  amount1Max: string | null
  /** 移除：至少会拿到的数量；添加：null */
  amount0Min: string | null
  amount1Min: string | null
  /** 一并领取的未领取手续费（集中流动性移除 / 领取时）；AMM 为 '0' */
  fees0: string
  fees1: string
  fees0Formatted: string | null
  fees1Formatted: string | null
  /** 一并领取的挖矿奖励的代币（集中流动性移除 / 领取时；数量要等交易执行后才知道） */
  rewardMints: string[]
  /** 哪一边用 SOL 支付 / 收取（自动包装 / 解包 wSOL） */
  native: 'token0' | 'token1' | null
  /** 按顺序执行；setup 和主指令能放进同一笔交易时会合并 */
  steps: SolanaLiquidityStep[]
  /**
   * 除 owner 外还需要签名的临时密钥（新建集中流动性仓位时的 NFT mint，32 字节种子）。
   * 自己发送时用它签名主指令所在的交易（如 web3.js 的 Keypair.fromSeed(secretKey)）
   */
  signers: Array<{ address: string; secretKey: Uint8Array }>
}

export interface SolanaLiquiditySendOptions extends SolanaLiquidityOptions, Omit<SendOptions, 'onUpdate' | 'signal'> {
  /** 发送前检查余额够不够（添加时），默认 true */
  checkBalance?: boolean
  onUpdate?: (result: SolanaLiquidityStepResult) => void
}

export interface SolanaLiquidityStepResult extends WriteResult {
  kind: SolanaLiquidityStep['kind']
}

export interface SolanaLiquidityResult {
  plan: SolanaLiquidityPlan
  /** 与 plan.steps 一一对应 */
  results: SolanaLiquidityStepResult[]
  /** 主指令（最后一步）的状态和签名 */
  status: WriteStatus
  signature: string | null
}
