import type { CallOverrides } from '../aggregate.js'
import type { LpProtocol, LpToken } from '../lp.js'
import type { LpV4Options } from '../lpV4.js'
import type { TokenPricesOptions } from '../price.js'
import type { SimulationResult } from '../simulate.js'
import type { BatchCallOptions } from '../write/batch.js'
import type { WriteResult, WriteStatus } from '../write/send.js'

/** 内置表之外的挖矿合约（自己的 FarmProtocol） */
export interface FarmProtocol {
  /** 协议 id：与 LP 协议同名时（如 'pancakeswap-v3'）选这个协议会同时查它的挖矿奖励 */
  id: string
  name: string
  /**
   * - masterchef-v3：PancakeSwap V3 的 MasterChefV3，仓位 NFT 存在合约里，按 `balanceOf` / `tokenOfOwnerByIndex` 列出用户质押的仓位，
   *   `pendingCake` 是待领取的 CAKE，质押中的仓位手续费也由它代为领取
   * - gauge：Aerodrome / Velodrome Slipstream 的 CLGauge（经 Voter 找到每个池子的 gauge），`stakedValues` / `earned` / `getReward`
   */
  kind: 'masterchef-v3' | 'gauge'
  chainId: number
  /** 仓位 NFT 合约（质押的仓位属于它） */
  positionManager: string
  /** masterchef-v3：MasterChefV3 合约 */
  masterChef?: string
  /** gauge：Voter 合约（pools / gauges） */
  voter?: string
}

/**
 * 领取的内容：
 * - fees：V3 / V4 仓位未领取的手续费（token0 / token1），质押在 MasterChef 里的仓位也有
 * - farm：MasterChef 的挖矿奖励（CAKE）
 * - gauge：Slipstream gauge 的奖励（AERO / VELO）
 */
export type ClaimKind = 'fees' | 'farm' | 'gauge'

export interface ClaimAmount {
  token: LpToken
  /** 最小单位 */
  amount: string
  /** 按精度换算；读不到精度时为 null */
  formatted: string | null
  /** 开启 prices 时：美元价值（没有价格或读不到精度时为 null） */
  usd?: number | null
}

/** 一项可领取的内容：一个仓位的手续费，或一个质押仓位的挖矿奖励 */
export interface ClaimItem {
  /** `<kind>:<协议 id>:<tokenId>`，在一次查询里唯一 */
  id: string
  kind: ClaimKind
  protocol: string
  protocolName: string
  /** fees：仓位的版本 */
  version?: 'v3' | 'v4'
  tokenId: string
  /** 池子地址（V4 为 poolId）；gauge 为 null */
  pool: string | null
  /** 仓位 NFT 质押在挖矿合约里 */
  staked: boolean
  /** 领取时调用的合约：仓位合约 / MasterChef / gauge */
  target: string
  /** fees 固定是 [token0, token1]（可能有一边为 0）；farm / gauge 是奖励代币 */
  amounts: ClaimAmount[]
  /** 开启 prices 时：这一项的美元价值（已知部分的合计；全部未知时为 null） */
  usd?: number | null
  /** 数量是估计值（MasterChef 的 harvest 预执行失败，退回 pendingCake，实际领到的可能更多） */
  approximate?: boolean
}

export interface Claimable {
  chainId: number
  owner: string
  /** 有东西可领的项，开启 prices 时按美元价值从大到小排 */
  items: ClaimItem[]
  /** 按代币汇总 */
  totals: ClaimAmount[]
  usd?: number | null
  /** 某个来源读取失败（节点出错等）时的说明，其他来源的结果照常返回 */
  errors: Array<{ source: string; error: string }>
}

export interface ClaimableOptions extends CallOverrides {
  /**
   * 查哪些协议：LP 协议 id（'uniswap-v3'、'pancakeswap-v3'、'uniswap-v4' …）或自己的 LpProtocol、挖矿协议 id（'aerodrome-slipstream' …）。
   * 'pancakeswap-v3' 同时包含它的 MasterChef 挖矿。默认这条链上内置的全部
   */
  protocols?: ReadonlyArray<string | LpProtocol>
  /** 查手续费（V3 / V4 仓位，含质押在 MasterChef 里的），默认 true */
  fees?: boolean
  /** 查挖矿奖励（MasterChef / gauge），默认 true */
  rewards?: boolean
  /** V4：怎么找仓位（已知 tokenIds 或扫描 Transfer 事件，同 getLpPositions），两个都没有时不查 V4 */
  v4?: LpV4Options
  /** 内置表里没有的挖矿合约 */
  farms?: readonly FarmProtocol[]
  /** gauge：直接指定要查的 gauge 地址，不再通过 Voter 枚举全部池子（Aerodrome 有两千多个，枚举要几千次读取） */
  gauges?: readonly string[]
  /** 每个协议最多核对多少个仓位，默认 500 */
  maxPositions?: number
  /** 美元价值（可选）：true 用 DefiLlama + 链上池子，也可以传 tokenPrices 的 sources。默认不查 */
  prices?: boolean | TokenPricesOptions['sources']
  /** 价格源出错时调用：照样返回结果，usd 为 null */
  onPriceError?: (error: unknown) => void
  /** 自定义 fetch（价格用） */
  fetch?: typeof fetch
}

export interface ClaimAllOptions extends ClaimableOptions {
  /** 要领取的项（getClaimable 的结果里挑），默认领取查到的全部 */
  items?: readonly ClaimItem[]
  /** 领取的代币收到哪个地址，默认 owner。gauge 的奖励只能发给 owner，传了别的地址时这些项会被跳过 */
  recipient?: string
  /** V4：传给 hooks 的 hookData，默认 '0x' */
  hookData?: string
  /** 美元价值低于这个值的项跳过（不够付 gas 的零头）；价值未知的不跳过。需要 prices */
  minUsd?: number
  /** 一笔交易最多合并多少个仓位，默认 20 */
  batchSize?: number
  /**
   * 构建后先模拟（用 /simulate，按需加载）：某一笔失败时逐项再试，把会失败的项放进 skipped，其余照常领取。默认 true；
   * 设为 false 时不模拟（某一项失败会让它所在的那一笔整体失败）
   */
  simulate?: boolean
}

export interface ClaimTx {
  kind: ClaimKind
  to: string
  data: string
  value: '0'
  /** 这一笔里包含的项（ClaimItem.id） */
  itemIds: string[]
  /** 模拟的结果（simulate 不为 false 时）：资产变化就是实际会收到的数量 */
  simulation?: SimulationResult
}

export interface ClaimSkipped {
  item: ClaimItem
  reason: string
}

/** 领取计划：要按顺序发送的交易（每笔独立，互不依赖）。只读取、不签名 */
export interface ClaimPlan {
  chainId: number
  owner: string
  recipient: string
  /** 会领取的项 */
  items: ClaimItem[]
  /** 跳过的项和原因（没东西可领、低于 minUsd、模拟失败、地址不允许 …） */
  skipped: ClaimSkipped[]
  /** 按代币汇总的预计数量（用的是查询时的数量，挖矿奖励随时间还会增加一点） */
  totals: ClaimAmount[]
  usd?: number | null
  transactions: ClaimTx[]
}

export interface ClaimAllSendOptions extends ClaimAllOptions, Omit<BatchCallOptions, 'continueOnError'> {
  /** 某一笔发送前失败后，后面的是否继续，默认 true（每一笔都是独立的领取） */
  continueOnError?: boolean
}

export interface ClaimTxResult extends WriteResult {
  kind: ClaimKind
  itemIds: string[]
}

export interface ClaimResult {
  plan: ClaimPlan
  /** 与 plan.transactions 一一对应 */
  results: ClaimTxResult[]
  /** 全部确认为 'confirmed'；dryRun 全部预估通过为 'simulated'；没有东西可领为 'skipped'；否则是第一笔没成功的状态 */
  status: WriteStatus
  /** 已确认的交易里的项 / 其他交易里的项（dryRun 时 claimed 为空，failed 只含预估失败的项） */
  claimed: ClaimItem[]
  failed: ClaimItem[]
  /** dryRun：预估通过的项（没有真正发送） */
  simulated?: ClaimItem[]
}
