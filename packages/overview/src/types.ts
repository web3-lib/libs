/**
 * 公开类型。不引用链包的类型（它们是可选依赖，没装也要能编译）：链包返回的数据在这里按结构声明、统一成同一种形状。
 */

export type ChainKind = 'evm' | 'tron' | 'solana' | 'sui' | 'ton'

/** 链包的模块加载器，如 `() => import('@w3lib/evm-batch-call/price')`；由应用传入，打包时只会带上应用用到的链包 */
export type ModuleLoader = () => Promise<any>

export interface OverviewLoaders {
  /** `@w3lib/evm-batch-call/price`（EVM 和 Tron 共用） */
  evm?: ModuleLoader
  /** `@w3lib/evm-batch-call/approvals`（开启 approvals 时） */
  evmApprovals?: ModuleLoader
  /** `@w3lib/evm-batch-call/owner`（EVM 的 `discover: true` 时） */
  evmOwner?: ModuleLoader
  /** `@w3lib/solana-batch-call/price` */
  solana?: ModuleLoader
  /** `@w3lib/solana-batch-call/approvals` */
  solanaApprovals?: ModuleLoader
  /** `@w3lib/sui-batch-call/price` */
  sui?: ModuleLoader
  /** `@w3lib/ton-batch-call/price` */
  ton?: ModuleLoader
  /** `@w3lib/ton-batch-call/write`（`/mnemonic` 推导 TON 钱包地址时） */
  tonWrite?: ModuleLoader
  /** `@w3lib/ton-batch-call`（`/mnemonic`：地址格式、判断 v4r2 / v5r1 哪个在用） */
  tonCore?: ModuleLoader
}

/** 每条链都有的配置 */
export interface ChainInputBase {
  /** 这条链上的地址 */
  address: string
  /** 传给链包各个函数的节点参数：provider、cluster / network、apiKey、fetch、timeout 等（EVM 的 chainId 自动带上） */
  node?: Record<string, unknown>
  /** 只传给链包 `getPortfolio` 的其他选项，如 `sources`（价格源）、`includeScam` */
  portfolio?: Record<string, unknown>
}

export interface EvmDiscoverContext {
  chainId: number
  address: string
  signal?: AbortSignal
}

/** 发现代币的钩子：返回要核对余额的代币地址（和内置列表、应用的列表合并） */
export type EvmDiscover = (ctx: EvmDiscoverContext) => Promise<readonly string[]> | readonly string[]

export interface EvmChainConfig extends Pick<ChainInputBase, 'node' | 'portfolio'> {
  chainId: number
  /** 应用提供的代币列表（和内置列表合并） */
  tokens?: readonly string[]
  /** 不用这条链的内置主要代币列表，默认 true */
  defaults?: boolean
  /** 发现代币：`true` 用 `@w3lib/evm-batch-call/owner` 的 `getOwnerTokens`（公开代币列表，尽力而为），或自己的钩子 */
  discover?: boolean | EvmDiscover
}

export interface EvmInput extends Pick<ChainInputBase, 'address'> {
  /** 要查的链：chainId，或带配置的对象 */
  chains: ReadonlyArray<number | EvmChainConfig>
  /** 按 chainId 给的应用代币列表（和 chains 里每条链自己的 tokens 合并） */
  tokens?: Readonly<Record<number, readonly string[]>>
  /** 所有链默认的发现方式（链自己的 discover 优先） */
  discover?: boolean | EvmDiscover
}

export interface TronInput extends ChainInputBase {
  tokens?: readonly string[]
  defaults?: boolean
  discover?: boolean | EvmDiscover
}

export interface SolanaInput extends ChainInputBase {
  /**
   * 不传：先列出全部持仓（需要支持 getTokenAccountsByOwner 的节点），不支持时退回内置的主要代币列表；
   * 数组：只查这些 mint（加上 SOL）；'default'：直接用内置列表（免费公共节点）
   */
  tokens?: readonly string[] | 'default'
}

export type SuiInput = ChainInputBase
export type TonInput = ChainInputBase

export interface OverviewInput {
  evm?: EvmInput
  tron?: TronInput
  solana?: SolanaInput
  sui?: SuiInput
  ton?: TonInput
}

export interface ApprovalsOptions {
  /** 每条链最多检查多少个持有的代币的授权（按价值从高到低），默认 30 */
  maxTokens?: number
  /** 传给链包 `getApprovals` 的其他选项（如 EVM 的 `spenders`、`pairs`、`nfts`） */
  options?: Record<string, unknown>
}

export interface OverviewOptions {
  loaders?: OverviewLoaders
  /** 同时计入 LP 仓位，默认 false（要多读很多合约；Solana 免费公共节点上需要自己的节点或 `portfolio.lp` 传 mints / pools）；对象为链包 `getPortfolio` 的 lp 参数。某条链的 `portfolio.lp` 优先：对象与这里的对象合并、`false` 关掉这条链的 LP、设了就算这条链开了 LP（读取失败同样降级为 partial） */
  lp?: boolean | Record<string, unknown>
  /** 检查授权风险（EVM / Tron 的 ERC20、Permit2、NFT，Solana 的 delegate），默认不检查。检查持有的代币 × 已知的 Router / 聚合器 / 市场 */
  approvals?: boolean | ApprovalsOptions
  /** 价值低于它的代币不列出（不影响合计） */
  minUsd?: number
  /** 内置表里不认识的代币，单个价值超过它就当价格不可信（薄池子算出的假价格）：不计入合计、算作没有价格，链的 warnings 里有说明。默认 1000000，传 Infinity 关闭。LP 仓位不受影响 */
  maxUnknownTokenUsd?: number
  /** 各条链的价格源（链包 `/price` 的 PriceSource，每种链的类型不同）；Tron 用 `tron`，没有时用 `evm` 的 */
  sources?: Partial<Record<ChainKind, readonly unknown[]>>
  fetch?: typeof fetch
  /** 取消：getOverview 抛出 signal.reason；已经完成的链通过 onChain 收到过 */
  signal?: AbortSignal
  /** 同时查多少条链，默认 4 */
  concurrency?: number
  /** 单条链的超时（毫秒），超时的链按出错处理，默认 60000 */
  chainTimeoutMs?: number
  /** 同符号的代币也合并（默认只合并内置表里认识的资产：稳定币、主币、WETH 等，防止同名假币混进去） */
  mergeBySymbol?: boolean
  /** 一条链有结果（成功或失败）时调用，界面可以逐条渲染；回调里抛错会被忽略 */
  onChain?: (result: ChainOverview) => void
  /** 价格源出错时调用 */
  onPriceError?: (chain: string, error: unknown) => void
}

export interface OverviewToken {
  chain: string
  /** 代币地址 / mint / coinType / Jetton 主合约；主币为各链包约定的标识 */
  token: string
  native: boolean
  symbol: string | null
  /** 跨链合并用的资产键，见 AssetTotal.key */
  asset: string
  balance: string
  decimals: number | null
  formatted: string | null
  price: number | null
  value: number | null
  priceSource: string | null
}

export interface OverviewLp {
  chain: string
  protocol: string
  protocolName: string
  /** v2 / v3 / v4（EVM）；amm / clmm / dlmm / multi（Solana、Sui、TON） */
  kind: string
  pool: string
  tokens: Array<{ token: string; symbol: string | null; amountFormatted: string | null }>
  valueUsd: number | null
  feesUsd: number | null
  inRange: boolean | null
  /** 链包返回的原始仓位 */
  raw: unknown
}

export interface ApprovalItem {
  chain: string
  type: 'erc20' | 'permit2' | 'nft' | 'delegate'
  /** 代币 / NFT 合集 / Solana 的 mint */
  asset: string
  symbol: string | null
  spender: string
  /** 已知的被授权方名称；不认识时为 null */
  spenderName: string | null
  unlimited: boolean
  unknownSpender: boolean
}

export interface ApprovalSummary {
  total: number
  /** 无限授权（ERC20 / Permit2 额度 ≥ 2^96，Solana delegate 额度 ≥ 2^63） */
  unlimited: number
  /** 被授权方不在已知列表里（Solana 没有已知列表，delegate 都算） */
  unknownSpender: number
  items: ApprovalItem[]
}

export interface ChainOverview {
  /** 'evm:1' / 'evm:56' / 'tron' / 'solana' / 'sui' / 'ton' */
  chain: string
  kind: ChainKind
  chainId?: number
  name: string
  address: string
  /** ok 全部成功；partial 拿到了结果但有降级（如 LP 读不了），原因在 warnings；error 这条链没有结果 */
  status: 'ok' | 'partial' | 'error'
  error?: string
  warnings: string[]
  totalUsd: number
  tokensUsd: number
  lpUsd: number
  tokens: OverviewToken[]
  lp: OverviewLp[]
  /** 有余额但算不出价值的代币数（含 LP 仓位） */
  unpriced: number
  approvals?: ApprovalSummary
  /** 这条链用了多久（毫秒） */
  ms: number
}

/** 跨链合并后的一种资产 */
export interface AssetTotal {
  /** 内置表里认识的资产是资产 id（'USDC'、'ETH'、'WETH'…）；主币是主币 symbol；其他是 `<链>:<地址>`（mergeBySymbol 时是大写 symbol） */
  key: string
  symbol: string | null
  /** 在内置表里（或是主币） */
  known: boolean
  /** 数量之和（按精度换算后的浮点数，只用于展示） */
  amount: number
  /** 有价格的部分的美元价值之和 */
  usd: number
  /** 加权平均价格：usd / 有价格部分的数量；全都没价格时为 null */
  price: number | null
  /** 其中有没有价格的部分 */
  unpriced: boolean
  chains: Array<{ chain: string; token: string; formatted: string | null; value: number | null }>
}

export interface ChainError {
  chain: string
  /** 这条链查询的地址 */
  address: string
  /** /mnemonic 多账户合计时：账户索引 */
  account?: number
  message: string
}

export interface Overview {
  totalUsd: number
  tokensUsd: number
  lpUsd: number
  /** 按 totalUsd 从高到低 */
  byChain: ChainOverview[]
  /** 跨链合并的资产，按 usd 从高到低 */
  tokens: AssetTotal[]
  lp: OverviewLp[]
  /** 开启 approvals 时：所有链的合计 */
  approvals?: ApprovalSummary
  unpriced: number
  /** 失败的链（其余链的结果照常返回，合计只含成功的链） */
  errors: ChainError[]
  /** 每条链的耗时，键是链键；同一条链出现多次（多个账户 / 钱包）时是 `链键@地址` */
  timings: { totalMs: number; chains: Record<string, number> }
}
