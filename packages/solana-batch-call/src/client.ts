import { AccountReader, queryContext } from './accountReader.js'
import { balancesFor, multiBalancesOf, ownerNftsOf, ownerTokensOf, solBalancesOf, type ReadContext } from './balances.js'
import { GENESIS_HASHES, NATIVE_MINT, SYSTEM_PROGRAM_ID, clusterOfGenesis, type Cluster } from './constants.js'
import type { AccountInfo } from './layout.js'
import type { RpcTransport } from './rpc.js'
import { clientSourceConfigs, resolveSource, type RpcSource, type SourceOptions } from './source.js'
import { nftOwnersOf, nftsOf, tokensOf } from './tokenDetails.js'
import type {
  Commitment,
  DefaultTokenField,
  NftDetails,
  NftOwner,
  OwnedToken,
  SolBalance,
  TokenBalance,
  TokenDetails,
  TokenField,
  TokenProgramOption,
} from './types.js'

// 代币信息缓存在 tokenMeta.ts；这里继续导出（公开 API 和测试的引用路径不变）
export { exportTokenMetaCache, importTokenMetaCache, persistTokenMetaCache, resetTokenMetaCache, type PersistTokenMetaOptions, type TokenMetaSnapshot } from './tokenMeta.js'

export interface ClientConfig extends SourceOptions {
  /** 网络。不传 provider 时用于选择内置节点（默认 mainnet）；传了 provider 时用于校验节点所在网络 */
  cluster?: Cluster
  /** 默认 'confirmed' */
  commitment?: Commitment
  /**
   * 视为原生 SOL 的 mint，默认 [So111…112（Wrapped SOL）, 11111…1（System Program）]。
   * 可以包含非 Solana 地址（如 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE），作为调用方自己的“主币”标识：
   * balances / tokens 遇到它时按 SOL 返回，token 原样带回（这是支持的用法，不会做地址校验）
   */
  nativeMints?: readonly string[]
}

/** 所有查询共用：取消 */
export interface RequestOptions {
  /**
   * 取消查询：已取消时直接 reject（不发请求）；中途取消时立即 reject（reason 为 signal.reason）。
   * signal 会传到底层传输：还在排队的请求不再发出，已经发出的 HTTP 请求在合并在一起的所有调用方都取消后中止，
   * 取消后也不再换节点重试（自定义传输可以处理 request 的第三个参数 `{ signal }`，不处理时请求照常完成、结果丢弃）
   */
  signal?: AbortSignal
}

/** 读余额类查询共用：指定最低 slot、返回读取时的 slot */
export interface SlotOptions {
  /**
   * 最低 slot：节点高度不到这个 slot 时（如刚成交、公共节点还落后一两个 slot）换下一个节点；
   * 所有节点都不够时每 500ms 重试，最多约 10 秒后抛错。传了它时结果项带 slot
   */
  minContextSlot?: number
  /** 结果项带 slot（读取时节点的 context.slot；一次查询发了多个请求时取最小的）。默认 false */
  withSlot?: boolean
}

export interface BalancesOptions extends RequestOptions, SlotOptions {
  /** 同时返回 symbol（代币查一次后缓存，主币为 SOL）。默认 false */
  symbol?: boolean
  /**
   * 用 getTokenAccountsByOwner 扫描持有人的全部代币账户（含非 ATA 账户、同一代币的多个账户合计）。
   * 不传 mints 时总是扫描。注意：免费公共节点大多不支持这个方法，需要自己的节点。
   */
  scan?: boolean
  /**
   * 指定 mints 时统计哪些代币账户（不传 mints 或 scan: true 时不起作用，总是统计全部账户）：
   * - 'ata'（默认）：只看关联代币账户（ATA），本地推导地址 + getMultipleAccounts，免费节点也能用
   * - 'all'：每个代币发一次按 mint 过滤的 getTokenAccountsByOwner（同一 tick 发出，合并成批量请求），统计该代币的全部账户并合计。
   *   只关心少数几个代币、又要算上非 ATA 账户时比 scan 轻得多；同样需要支持索引方法的节点
   */
  accounts?: 'ata' | 'all'
  /**
   * 只返回这些类型的代币：'spl'（SPL Token）、'token-2022'，也可以传程序地址。默认两种都返回。
   * 如传 ['spl']：结果里不含 Token-2022 代币（扫描时也不再请求 Token-2022 的代币账户）。主币 SOL 不受影响
   */
  tokenPrograms?: readonly TokenProgramOption[]
}

export interface OwnerTokensOptions extends RequestOptions, SlotOptions {
  /** 只返回这些类型的代币：'spl'、'token-2022' 或程序地址，默认两种都返回；主币 SOL 不受影响（用 includeNative 控制） */
  tokenPrograms?: readonly TokenProgramOption[]
  /** 返回 name / symbol（代币查一次后缓存）。默认 true */
  metadata?: boolean
  /** 第一项返回 SOL。默认 true */
  includeNative?: boolean
  /** 包含余额为 0 的代币账户（如已清空但未关闭的 ATA）。默认 false */
  includeZero?: boolean
  /** 包含 NFT（精度 0 且数量 1）。默认 false */
  includeNfts?: boolean
}

export interface TokensOptions<F extends TokenField = DefaultTokenField> extends RequestOptions {
  /** 要返回的字段，默认 ['name', 'symbol', 'decimals'] */
  fields?: readonly F[]
}

/** accounts() 的参数 */
export interface AccountsOptions extends RequestOptions {
  /** 最低 slot，见 SlotOptions.minContextSlot */
  minContextSlot?: number
}

/** solBalances() 的参数 */
export interface SolBalancesOptions extends RequestOptions, SlotOptions {}

/** balances(owner, options) 新写法的参数：mints 放进选项里（旧写法 balances(owner, mints, options) 照常可用） */
export interface BalancesQueryOptions extends BalancesOptions {
  /** 要查的代币；不传时扫描全部代币账户（同旧写法不传 mints） */
  mints?: readonly string[]
}

/** multiBalances() 的单项：一个钱包和要查的代币 */
export interface BalanceQuery {
  owner: string
  mints: readonly string[]
}

/** 查询带上取消：已取消时不执行；中途取消时立即 reject，查询本身继续（结果丢弃） */
function abortable<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  if (!signal) {
    return run()
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    run()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

let clientIds = 0

/**
 * Solana 批量读取客户端。
 *
 * ```ts
 * const sol = new SolanaClient()                                  // 内置公共节点（mainnet）
 * const sol = new SolanaClient('https://my-rpc.example')          // 自己的节点
 * const sol = new SolanaClient([connection, 'https://backup…'])   // web3.js Connection + 备用节点
 *
 * await sol.balances(owner, [NATIVE_MINT, USDC])
 * await sol.tokens([USDC, PYUSD], { fields: ['name', 'symbol', 'decimals', 'supply'] })
 * ```
 *
 * 同一 tick 内发起的 RPC 调用会合并成一个 JSON-RPC 批量请求；账户读取按 100 个一组用 getMultipleAccounts。
 * 这里只有薄的公开方法：账户读取管线在 accountReader.ts，余额在 balances.ts，代币详情 / NFT 在 tokenDetails.ts，代币信息缓存在 tokenMeta.ts
 */
export class SolanaClient {
  readonly transport: RpcTransport
  readonly #genesis: () => Promise<string>
  readonly #cluster: Cluster | undefined
  readonly #commitment: Commitment
  readonly #nativeMints: Set<string>
  readonly #reader: AccountReader
  readonly #rc: ReadContext

  constructor(provider?: RpcSource | readonly RpcSource[], config: ClientConfig = {}) {
    const resolved = resolveSource(provider, config.cluster ?? (provider === undefined ? 'mainnet' : undefined), config)
    this.transport = resolved.transport
    this.#genesis = resolved.genesis
    this.#cluster = config.cluster ?? (provider === undefined ? 'mainnet' : undefined)
    this.#commitment = config.commitment ?? 'confirmed'
    this.#nativeMints = new Set(config.nativeMints ?? [NATIVE_MINT, SYSTEM_PROGRAM_ID])
    this.#reader = new AccountReader(this.transport, this.#commitment)
    // 登记节点配置：写操作的 sendRpc 按同样的网络和节点选项解析
    clientSourceConfigs.set(this, { cluster: this.#cluster, options: config, genesis: () => this.#cluster ? Promise.resolve(GENESIS_HASHES[this.#cluster]) : this.#genesis() })
    // 网络已知时按网络共享缓存；未知（自定义节点且没指定 cluster）时缓存只在本客户端内使用，避免不同网络串数据
    const scope = this.#cluster ?? `client-${++clientIds}`
    this.#rc = { reader: this.#reader, scope, nativeMints: this.#nativeMints, commitment: this.#commitment }
  }

  /** 节点所在网络（按创世区块哈希识别）；不是 mainnet / devnet / testnet 时为 null */
  async getCluster(): Promise<Cluster | null> {
    return this.#cluster ?? clusterOfGenesis(await this.#genesis())
  }

  /** 默认的 commitment（ClientConfig.commitment，默认 'confirmed'） */
  get commitment(): Commitment {
    return this.#commitment
  }

  /** 是否按原生 SOL 处理这个 mint（ClientConfig.nativeMints） */
  isNativeMint(mint: string): boolean {
    return this.#nativeMints.has(mint)
  }

  /** 直接发 JSON-RPC 调用（同样参与自动合并与故障切换） */
  request<T = unknown>(method: string, params?: readonly unknown[], options: RequestOptions = {}): Promise<T> {
    const { signal } = options
    return abortable(signal, () => this.#reader.send<T>(method, params, signal))
  }

  /**
   * 批量读取账户（getMultipleAccounts，按 100 个一组，去重），结果与 addresses 一一对应。
   * 账户不存在或地址非法时为 null。
   */
  accounts(addresses: readonly string[], options: AccountsOptions = {}): Promise<(AccountInfo | null)[]> {
    return abortable(options.signal, () => this.#reader.accounts(addresses, queryContext(options)))
  }

  /** 批量查多个地址的 SOL 余额（getMultipleAccounts 只读 lamports、不读回账户数据；账户不存在视为 0） */
  solBalances(addresses: readonly string[], options: SolBalancesOptions = {}): Promise<SolBalance[]> {
    return abortable(options.signal, () => solBalancesOf(this.#rc, addresses, options))
  }

  /**
   * 批量查余额（主币 SOL + SPL Token + Token-2022），返回原始余额、decimals 和换算后的数值。两种写法：
   * `balances(owner, mints?, options?)`，或 `balances(owner, { mints, ...options })`。
   *
   * - 传 mints：本地推导 ATA，与 mint 账户一起用 getMultipleAccounts 读完，免费节点也能用；主币只读 lamports（dataSlice），另成一组同时发出
   * - 传 mints 且 accounts: 'all'：每个代币按 mint 过滤查 getTokenAccountsByOwner，统计全部代币账户（含非 ATA）
   * - 不传 mints（或 scan: true）：用 getTokenAccountsByOwner 扫描全部代币账户，返回所有余额大于 0 的代币
   * - 失败项（success: false）带 error：invalid-address（mint 地址非法）/ not-found（mint 不存在）/ not-token（不是代币 mint）
   * - tokenPrograms：只返回这些类型的代币，如 ['spl'] 不含 Token-2022（传了 mints 时，结果里去掉不符合的代币）
   * - minContextSlot / withSlot：要求节点高度、返回读取时的 slot，见 SlotOptions
   * - owner 非法时抛 InvalidAddressError
   */
  balances(owner: string, mints?: readonly string[], options?: BalancesOptions): Promise<TokenBalance[]>
  balances(owner: string, options: BalancesQueryOptions): Promise<TokenBalance[]>
  balances(owner: string, mintsOrOptions?: readonly string[] | BalancesQueryOptions, maybeOptions: BalancesOptions = {}): Promise<TokenBalance[]> {
    // null / undefined 按旧写法的“不传 mints”（扫描模式）处理
    const objectForm = mintsOrOptions != null && !Array.isArray(mintsOrOptions)
    const options: BalancesOptions = objectForm ? (mintsOrOptions as BalancesQueryOptions) : (maybeOptions ?? {})
    const mints = objectForm ? (mintsOrOptions as BalancesQueryOptions).mints : ((mintsOrOptions ?? undefined) as readonly string[] | undefined)
    return abortable(options.signal, () => balancesFor(this.#rc, owner, mints, options))
  }

  /**
   * 多个钱包一次查（如多钱包的持仓列表），结果与 queries 一一对应。
   * ATA 模式（默认）下所有钱包的账户合并成一次（按 100 个一组的）getMultipleAccounts；
   * scan / accounts: 'all' 时每个钱包各自查询（同一 tick 发出，合并成批量请求）。其他选项与 balances() 相同；
   * withSlot 时所有钱包的结果带同一个 slot（整次查询的最小值）。任一 owner 非法时抛 InvalidAddressError
   *
   * ```ts
   * await sol.multiBalances([{ owner: a, mints: [NATIVE_MINT, USDC] }, { owner: b, mints: [USDC] }])
   * ```
   */
  multiBalances(queries: readonly BalanceQuery[], options: BalancesOptions = {}): Promise<TokenBalance[][]> {
    return abortable(options.signal, () => multiBalancesOf(this.#rc, queries, options))
  }

  /**
   * 列出持有人拥有的全部代币（SOL 在第一位），带 name / symbol，适合做资产列表。
   * 需要支持 getTokenAccountsByOwner 的节点（免费公共节点大多不支持）。
   *
   * - 默认不含 NFT（精度 0 且数量 1）和余额为 0 的代币账户（如已清空的 ATA），可用 includeNfts / includeZero 打开
   * - accounts 是该代币的代币账户数量；大于 1 时余额为所有账户的合计
   * - 顺序：SOL，然后 SPL Token 的代币，再然后 Token-2022 的代币（各自按节点返回的顺序；没有价格信息，不按价值排序）
   * - tokenPrograms: ['spl'] 时不含 Token-2022 代币
   * - withSlot 的 slot 只算余额扫描（元数据读取不计入）
   */
  ownerTokens(owner: string, options: OwnerTokensOptions = {}): Promise<OwnedToken[]> {
    return abortable(options.signal, () => ownerTokensOf(this.#rc, owner, options))
  }

  /**
   * 批量查代币详情（一次 getMultipleAccounts），可以选择返回哪些字段。
   * name / symbol / uri 优先取 Token-2022 TokenMetadata 扩展，其次 Metaplex 元数据。
   * transferFee：Token-2022 转账手续费，请求时会顺带发一次 getEpochInfo（同一个批量请求里）选出当前生效的配置
   */
  tokens<const F extends TokenField = DefaultTokenField>(mints: readonly string[], options: TokensOptions<F> = {}): Promise<TokenDetails<F>[]> {
    return abortable(options.signal, () => tokensOf<F>(this.#rc, mints, options))
  }

  /** 批量查 NFT 元数据（Metaplex；Token-2022 NFT 取 TokenMetadata 扩展），一次 getMultipleAccounts */
  nfts(mints: readonly string[], options: RequestOptions = {}): Promise<NftDetails[]> {
    return abortable(options.signal, () => nftsOf(this.#rc, mints, options))
  }

  /**
   * 批量查 NFT 持有人：getTokenLargestAccounts（合并成一个批量请求）+ 一次 getMultipleAccounts。
   * 节点拒绝的 mint（不存在 / 不是代币）在同一次 getMultipleAccounts 里读 mint 账户区分原因
   */
  nftOwners(mints: readonly string[], options: RequestOptions = {}): Promise<NftOwner[]> {
    return abortable(options.signal, () => nftOwnersOf(this.#rc, mints, options))
  }

  /** 查某地址持有的全部 NFT（扫描代币账户：数量 1、精度 0），再批量读元数据。需要支持 getTokenAccountsByOwner 的节点 */
  ownerNfts(owner: string, options: RequestOptions = {}): Promise<NftDetails[]> {
    return abortable(options.signal, () => ownerNftsOf(this.#rc, owner, options))
  }
}
