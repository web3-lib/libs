import { type BigNumberish } from 'ethers'

import { aggregate, type AggregateContext, type BlockTag, type CallOverrides, type EthersLikeProvider } from './aggregate.js'
import { Batcher, type BatchOptions } from './batcher.js'
import { asStringOrBytes32, decodeCall, encodeCall, type BoundCall, type Call, type CallRequest, type FailableCall, type RawResult } from './call.js'
import { Contract, bindCall, type ContractAbi, type ContractRunner } from './contract.js'
import {
  DEFAULT_NATIVE_TOKENS,
  ERC20_ABI,
  formatAmount,
  getCachedTokenMeta,
  setCachedTokenMeta,
  type BalanceToken,
  type Erc20Contract,
  type TokenBalance,
  type TokenAllowance,
  MAX_UINT256,
  UNLIMITED_ALLOWANCE_THRESHOLD,
  DEFAULT_TOKEN_FIELDS,
  type DefaultTokenField,
  type TokenDetails,
  type TokenField,
} from './erc20.js'
import { CallFailedError, isExecutionError } from './errors.js'
import { MULTICALL3_ADDRESS, getMulticall3, type Multicall } from './multicall.js'
import { getNativeCurrency } from './chains.js'
import { ownerTokens, type OwnedToken, type OwnerTokensOptions } from './owner.js'
import {
  erc1155Balances,
  nftBalances,
  nftCollections,
  nftOwners,
  nftTokenUris,
  type DefaultNftCollectionField,
  type Erc1155Balance,
  type NftBalance,
  type NftCollection,
  type NftCollectionField,
  type NftCollectionsOptions,
  type NftItem,
  type NftOwner,
  type NftTokenUri,
  type NftTokenUriOptions,
} from './nft.js'
import { detectChainId } from './detect.js'
import { isTronChain, resolveSource, type ProviderSource, type SourceOptions } from './source.js'

export type { ProviderSource }

export interface StaticCallOverrides extends CallOverrides {
  value?: BigNumberish
  gasLimit?: BigNumberish
}

export interface StaticCallItem {
  call: Call
  overrides?: StaticCallOverrides
}

export type StaticCallResult<T> = { success: true; data: T } | { success: false; error: Error }

/** all / tryAll 的输入：Call 数组，或 { 名字: Call } 对象 */
export type CallInput = readonly Call[] | Readonly<Record<string, Call>>

type ResultOf<C> = C extends Call<infer R> ? R : any
/** 与输入同构的结果：数组 → 数组（元组保留各项类型），对象 → 同名字段 */
export type CallResults<C> = { -readonly [K in keyof C]: ResultOf<C[K]> }
export type TryCallResults<C> = { -readonly [K in keyof C]: ResultOf<C[K]> | null }

export interface ProviderConfig extends SourceOptions {
  /** 自定义 Multicall3 地址；不填则查内置地址表，表里没有就走 deployless */
  multicall?: Partial<Multicall>
  /** 强制走 deployless（不依赖链上 multicall 合约） */
  deployless?: boolean
  /** 单次 eth_call 最多打包的调用数，超出自动拆分并发请求。默认 500 */
  chunkSize?: number
  /** `provider.call()` 自动合并的参数 */
  batch?: BatchOptions
  /** `balances()` 里视为主币的地址，默认 0xeeee…eeee（NATIVE_TOKEN）和零地址 */
  nativeTokens?: readonly string[]
  /** 主币精度，默认按内置链信息表（NATIVE_CURRENCIES），表里没有时 EVM 18、Tron 6 */
  nativeDecimals?: number
  /** 主币 symbol（balances 的 symbol 选项、tokens 用），默认按内置链信息表，表里没有时为 null */
  nativeSymbol?: string
  /** 主币名称（tokens 用），默认按内置链信息表，表里没有时为 null */
  nativeName?: string
}

export interface TokensOptions<F extends TokenField = DefaultTokenField> extends CallOverrides {
  /** 要返回的字段，默认 ['name', 'symbol', 'decimals'] */
  fields?: readonly F[]
}

export interface BalancesOptions extends CallOverrides {
  /** 同时返回 symbol（代币查一次后缓存；主币取 nativeSymbol / 内置链信息表）。默认 false */
  symbol?: boolean
}

/** 构造参数第一个是 chainId 还是节点：数字、数字字符串、0x 十六进制视为 chainId，其余（URL、对象、数组）视为节点 */
function isChainIdArg(value: unknown): value is number | bigint | string {
  return (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    (typeof value === 'string' && /^\s*(\d+|0x[0-9a-fA-F]+)\s*$/.test(value))
  )
}

const ETH_BALANCE_INPUTS = [{ name: 'addr', type: 'address' }] as const
const ETH_BALANCE_OUTPUTS = [{ name: 'balance', type: 'uint256' }] as const

/**
 * Multicall Provider，API 与 ethcall 的 Provider 保持一致：
 *
 * ```ts
 * const multi = new Provider(chainId, ethersProvider)
 * const [symbol, decimals] = await multi.all([erc20.symbol(), erc20.decimals()])
 * ```
 */
export class Provider implements ContractRunner {
  /** 不传 chainId 时在识别完成前为 null */
  #ctx: AggregateContext | null = null
  /** 识别中的 Promise；识别失败后置空，下次使用时重试 */
  #detecting: Promise<AggregateContext> | null = null
  readonly #source: ProviderSource | readonly ProviderSource[] | undefined
  readonly #batcher: Batcher
  readonly #nativeTokens: Set<string>
  readonly #config: ProviderConfig

  /**
   * 两种写法：
   *
   * ```ts
   * new Provider(window.ethereum)          // 只传节点：chainId 从节点识别
   * new Provider([url1, url2], config)
   * new Provider(56)                       // 只传 chainId：使用内置公共节点
   * new Provider(56, rpc, config)          // 都传（与 ethcall 相同），不需要识别
   * ```
   *
   * @param provider 节点：RPC URL、ethers Provider、钱包（window.ethereum / tronWeb）或它们的数组（主节点 + 备用节点）
   * @param config 可选配置
   */
  constructor(provider: ProviderSource | readonly ProviderSource[], config?: ProviderConfig)
  /**
   * @param chainId 链 ID（接受数字字符串）
   * @param provider 节点，不传则使用内置的公共节点表
   * @param config 可选配置
   */
  constructor(chainId: number | string, provider?: ProviderSource | readonly ProviderSource[], config?: ProviderConfig)
  constructor(
    first: number | string | ProviderSource | readonly ProviderSource[],
    second?: ProviderSource | readonly ProviderSource[] | ProviderConfig,
    third?: ProviderConfig,
  ) {
    const hasChainId = isChainIdArg(first)
    const source = (hasChainId ? second : first) as ProviderSource | readonly ProviderSource[] | undefined
    const config = ((hasChainId ? third : second) ?? {}) as ProviderConfig
    this.#config = config
    this.#batcher = new Batcher((requests, overrides) => this.#aggregate(requests, overrides), config.batch)
    this.#nativeTokens = new Set((config.nativeTokens ?? DEFAULT_NATIVE_TOKENS).map((t) => t.toLowerCase()))

    this.#source = source
    if (hasChainId) {
      this.#ctx = this.#createContext(Number(first), source)
    } else {
      if (source === undefined) {
        throw new Error('Provider requires a chainId or a provider')
      }
      // 提前开始识别；失败时由使用方的调用拿到错误（这里避免未处理的 rejection）
      this.#ensureReady().catch(() => {})
    }
  }

  /**
   * 只传节点时等 chainId 识别完成后再返回实例，之后 rpc / multicall 等同步属性可以直接用。
   *
   * ```ts
   * const multi = await Provider.create(window.ethereum)
   * multi.rpc // 已就绪
   * ```
   */
  static async create(
    provider: ProviderSource | readonly ProviderSource[],
    config?: ProviderConfig,
  ): Promise<Provider> {
    return new Provider(provider, config).ready()
  }

  /** 取初始化好的上下文；识别失败不会被永久记住，下次调用重新识别（如节点短暂限流） */
  #ensureReady(): Promise<AggregateContext> {
    if (this.#ctx) {
      return Promise.resolve(this.#ctx)
    }
    if (!this.#detecting) {
      const source = this.#source as ProviderSource | readonly ProviderSource[]
      const detecting = detectChainId(source, this.#config.fallback?.timeout).then((id) => {
        this.#ctx = this.#createContext(id, source)
        return this.#ctx
      })
      this.#detecting = detecting
      detecting.catch(() => {
        if (this.#detecting === detecting) {
          this.#detecting = null
        }
      })
    }
    return this.#detecting
  }

  #createContext(chainId: number, source: ProviderSource | readonly ProviderSource[] | undefined): AggregateContext {
    const config = this.#config
    return {
      provider: resolveSource(chainId, source, config),
      chainId,
      multicall: config.deployless ? null : resolveMulticall(chainId, config.multicall),
      chunkSize: config.chunkSize ?? 500,
    }
  }

  /** 链 ID（不传 chainId 构造时，会等待从节点识别完成） */
  async getChainId(): Promise<number> {
    return (await this.#ensureReady()).chainId
  }

  /** 等待初始化完成（只传节点时会先识别 chainId；识别失败在这里抛出） */
  async ready(): Promise<this> {
    await this.#ensureReady()
    return this
  }

  #nativeCurrency(chainId: number): { decimals: number; symbol: string | null; name: string | null } {
    const known = getNativeCurrency(chainId)
    return {
      decimals: this.#config.nativeDecimals ?? known?.decimals ?? (isTronChain(chainId) ? 6 : 18),
      symbol: this.#config.nativeSymbol ?? known?.symbol ?? null,
      name: this.#config.nativeName ?? known?.name ?? null,
    }
  }

  /**
   * 绑定到本 Provider 的合约：方法返回的 Call 可以直接 await（自动合并成 multicall），
   * 也可以传给 all / tryAll；`method.staticCall(...)` 预执行。
   *
   * ```ts
   * const pair = multi.contract(pairAddress, PAIR_ABI)
   * const [reserves, token0] = await Promise.all([pair.getReserves(), pair.token0()]) // 一次请求
   * ```
   */
  contract(address: string, abi: ContractAbi): Contract {
    return new Contract(address, abi, this)
  }

  /** 绑定的 ERC20 合约（内置 ABI，结果带类型） */
  erc20(address: string): Erc20Contract {
    return new Contract(address, ERC20_ABI as unknown as string[], this) as Erc20Contract
  }

  /**
   * 批量查余额（含按 decimals 换算后的数值），主币和代币混在一起、一次请求。
   *
   * ```ts
   * const list = await multi.balances(user, [NATIVE_TOKEN, USDT, { address: USDC, decimals: 6 }], { symbol: true })
   * list[1] // { token: USDT, native: false, balance: '1234500000000000000000', decimals: 18, formatted: '1234.5', symbol: 'USDT', success: true }
   * ```
   *
   * - 主币地址见 config.nativeTokens（默认 0xeeee…eeee 和零地址）；精度 / symbol 按内置链信息表，可用 nativeDecimals / nativeSymbol 覆盖
   * - decimals、symbol 查到一次后缓存，之后只查 balanceOf；也可以直接传 `{ address, decimals }`
   * - 单个代币失败（非合约地址、非法地址等）不影响其他代币，该项 success 为 false
   */
  async balances(owner: string, tokens: readonly BalanceToken[], options: BalancesOptions = {}): Promise<TokenBalance[]> {
    const { symbol: withSymbol = false, ...overrides } = options
    const { chainId } = await this.#ensureReady()
    const nativeCurrency = this.#nativeCurrency(chainId)
    const items = tokens.map((token) => {
      const resolved = this.#resolveToken(chainId, token, nativeCurrency.decimals)
      const symbol = resolved.native ? nativeCurrency.symbol : getCachedTokenMeta(chainId, resolved.address).symbol
      return { ...resolved, symbol }
    })

    const calls: Call[] = []
    const plan = items.map(({ address, native, decimals, symbol }) => {
      const balanceIndex = calls.push(native ? this.getEthBalance(owner) : this.erc20(address).balanceOf(owner)) - 1
      const decimalsIndex = decimals === undefined ? calls.push(this.erc20(address).decimals()) - 1 : -1
      const symbolIndex = withSymbol && !native && symbol === undefined ? calls.push(this.#symbolCall(address)) - 1 : -1
      return { balanceIndex, decimalsIndex, symbolIndex }
    })
    const results = await this.tryAll(calls, overrides)

    return items.map((item, i) => {
      const { balanceIndex, decimalsIndex, symbolIndex } = plan[i] as { balanceIndex: number; decimalsIndex: number; symbolIndex: number }
      const balance = results[balanceIndex] as bigint | null
      const fetchedDecimals = decimalsIndex === -1 ? null : (results[decimalsIndex] as bigint | null)
      const fetchedSymbol = symbolIndex === -1 ? null : (results[symbolIndex] as string | null)
      if (!item.native && (fetchedDecimals !== null || fetchedSymbol !== null)) {
        setCachedTokenMeta(chainId, item.address, {
          ...(fetchedDecimals !== null ? { decimals: Number(fetchedDecimals) } : {}),
          ...(fetchedSymbol !== null ? { symbol: fetchedSymbol } : {}),
        })
      }
      const decimals = item.decimals ?? (fetchedDecimals === null ? null : Number(fetchedDecimals))
      const extra = withSymbol ? { symbol: item.symbol ?? fetchedSymbol ?? null } : {}
      if (balance === null || decimals === null) {
        return { token: item.address, native: item.native, balance: '0', decimals: decimals ?? 0, formatted: '0', ...extra, success: false }
      }
      // 结果全是字符串 / 数字 / 布尔 / null，可以直接 JSON.stringify
      return {
        token: item.address,
        native: item.native,
        balance: balance.toString(),
        decimals,
        formatted: formatAmount(balance, decimals),
        ...extra,
        success: true,
      }
    })
  }

  /**
   * 批量查 ERC20 授权额度（发交易前判断是否需要 approve），一次请求。
   *
   * ```ts
   * const [usdt] = await multi.allowances(user, router, [USDT])
   * usdt // { token: USDT, spender: router, native: false, allowance: '…', decimals: 18, formatted: '100', unlimited: false, success: true }
   * ```
   *
   * - 主币不需要授权：native 为 true，额度视为 MaxUint256、unlimited 为 true，不发请求
   * - decimals 与 balances / tokens 共用缓存；也可以直接传 `{ address, decimals }`
   */
  async allowances(
    owner: string,
    spender: string,
    tokens: readonly BalanceToken[],
    overrides?: CallOverrides,
  ): Promise<TokenAllowance[]> {
    const { chainId } = await this.#ensureReady()
    const nativeDecimals = this.#nativeCurrency(chainId).decimals
    const calls: Call[] = []
    const plan = tokens.map((token) => {
      const { address, native, decimals } = this.#resolveToken(chainId, token, nativeDecimals)
      const allowanceIndex = native ? -1 : calls.push(this.erc20(address).allowance(owner, spender)) - 1
      const decimalsIndex = native || decimals !== undefined ? -1 : calls.push(this.erc20(address).decimals()) - 1
      return { address, native, decimals, allowanceIndex, decimalsIndex }
    })
    const results = calls.length ? await this.tryAll(calls, overrides) : []

    return plan.map(({ address, native, decimals: known, allowanceIndex, decimalsIndex }) => {
      const allowance = native ? MAX_UINT256 : ((results[allowanceIndex] as bigint | null) ?? null)
      const fetched = decimalsIndex === -1 ? null : ((results[decimalsIndex] as bigint | null) ?? null)
      if (fetched !== null) {
        setCachedTokenMeta(chainId, address, { decimals: Number(fetched) })
      }
      const decimals = known ?? (fetched === null ? null : Number(fetched))
      if (allowance === null || decimals === null) {
        return { token: address, spender, native, allowance: '0', decimals: decimals ?? 0, formatted: '0', unlimited: false, success: false }
      }
      return {
        token: address,
        spender,
        native,
        allowance: allowance.toString(),
        decimals,
        formatted: formatAmount(allowance, decimals),
        unlimited: allowance >= UNLIMITED_ALLOWANCE_THRESHOLD,
        success: true,
      }
    })
  }

  /**
   * 列出持有人拥有的代币（资产列表）：从代币来源拿候选代币，再用 multicall 在链上核对余额。
   * 默认来源是公开代币列表，**只能发现列表里的代币**，局限性见 README「资产列表」一节。
   */
  ownerTokens(owner: string, options?: OwnerTokensOptions): Promise<OwnedToken[]> {
    return ownerTokens(this, owner, options)
  }

  /** 批量查 NFT 集合信息（标准 / name / symbol / totalSupply），字段可选 */
  nftCollections<const F extends NftCollectionField = DefaultNftCollectionField>(
    collections: readonly string[],
    options?: NftCollectionsOptions<F>,
  ): Promise<NftCollection<F>[]> {
    return nftCollections<F>(this, collections, options)
  }

  /** 批量查 ERC721 持有数量（balanceOf） */
  nftBalances(owner: string, collections: readonly string[], overrides?: CallOverrides): Promise<NftBalance[]> {
    return nftBalances(this, owner, collections, overrides)
  }

  /** 批量查 ERC721 持有人（ownerOf），可混合多个集合 */
  nftOwners(items: readonly NftItem[], overrides?: CallOverrides): Promise<NftOwner[]> {
    return nftOwners(this, items, overrides)
  }

  /** 批量查 NFT 元数据地址：兼容 ERC721 tokenURI 与 ERC1155 uri（{id} 按规范替换），可转换 ipfs:// */
  nftTokenUris(items: readonly NftItem[], options?: NftTokenUriOptions): Promise<NftTokenUri[]> {
    return nftTokenUris(this, items, options)
  }

  /** 批量查 ERC1155 余额 */
  erc1155Balances(owner: string, items: readonly NftItem[], overrides?: CallOverrides): Promise<Erc1155Balance[]> {
    return erc1155Balances(this, owner, items, overrides)
  }

  /** symbol() 调用：string 解码失败时按 bytes32 解析（MKR 等老代币） */
  #symbolCall(address: string): Call<string> {
    return asStringOrBytes32(this.erc20(address).symbol())
  }

  /** 解析 balances / allowances 的代币参数：是否主币、已知的 decimals（传入的 > 主币配置 / 缓存） */
  #resolveToken(chainId: number, token: BalanceToken, nativeDecimals: number): { address: string; native: boolean; decimals: number | undefined } {
    const address = typeof token === 'string' ? token : token.address
    const native = this.#nativeTokens.has(address.toLowerCase())
    const passed = typeof token === 'string' ? undefined : token.decimals
    const decimals = passed ?? (native ? nativeDecimals : getCachedTokenMeta(chainId, address).decimals)
    return { address, native, decimals }
  }

  /**
   * 批量查 ERC20 代币详情，一次请求；可以选择返回哪些字段。
   *
   * ```ts
   * await multi.tokens([USDT, NATIVE_TOKEN])                                       // name / symbol / decimals
   * await multi.tokens([USDT], { fields: ['symbol', 'decimals', 'totalSupply'] })
   * // [{ address: USDT, native: false, symbol: 'USDT', decimals: 18, totalSupply: '…', totalSupplyFormatted: '…', success: true }]
   * ```
   *
   * - name / symbol / decimals 查到一次后缓存（与 balances 共用），totalSupply 每次都查
   * - 主币占位地址不发请求，信息取内置链信息表（可用 nativeName / nativeSymbol / nativeDecimals 覆盖），totalSupply 为 null
   * - symbol / name 兼容返回 bytes32 的老代币（MKR 等）
   * - 读取失败的字段为 null；请求的字段都读到时 success 为 true
   */
  async tokens<const F extends TokenField = DefaultTokenField>(
    tokens: readonly string[],
    options: TokensOptions<F> = {},
  ): Promise<TokenDetails<F>[]> {
    const { fields = DEFAULT_TOKEN_FIELDS as unknown as readonly F[], ...overrides } = options
    const wanted = new Set<TokenField>(fields)
    const needDecimals = wanted.has('decimals') || wanted.has('totalSupply')
    const { chainId } = await this.#ensureReady()
    const nativeCurrency = this.#nativeCurrency(chainId)

    const calls: Call[] = []
    const plan = tokens.map((address) => {
      const native = this.#nativeTokens.has(address.toLowerCase())
      const meta = native
        ? { name: nativeCurrency.name ?? undefined, symbol: nativeCurrency.symbol ?? undefined, decimals: nativeCurrency.decimals }
        : getCachedTokenMeta(chainId, address)
      const index: Partial<Record<TokenField, number>> = {}
      if (!native) {
        const erc20 = this.erc20(address)
        if (wanted.has('name') && meta.name === undefined) {
          index.name = calls.push(asStringOrBytes32(erc20.name())) - 1
        }
        if (wanted.has('symbol') && meta.symbol === undefined) {
          index.symbol = calls.push(this.#symbolCall(address)) - 1
        }
        if (needDecimals && meta.decimals === undefined) {
          index.decimals = calls.push(erc20.decimals()) - 1
        }
        if (wanted.has('totalSupply')) {
          index.totalSupply = calls.push(erc20.totalSupply()) - 1
        }
      }
      return { address, native, meta, index }
    })
    const results = calls.length ? await this.tryAll(calls, overrides) : []
    const read = <T>(i: number | undefined): T | null => (i === undefined ? null : ((results[i] as T | null) ?? null))

    return plan.map(({ address, native, meta, index }) => {
      const name = meta.name ?? read<string>(index.name)
      const symbol = meta.symbol ?? read<string>(index.symbol)
      const fetchedDecimals = read<bigint>(index.decimals)
      const decimals = meta.decimals ?? (fetchedDecimals === null ? null : Number(fetchedDecimals))
      const totalSupply = read<bigint>(index.totalSupply)
      if (!native) {
        setCachedTokenMeta(chainId, address, {
          ...(index.name !== undefined && name !== null ? { name } : {}),
          ...(index.symbol !== undefined && symbol !== null ? { symbol } : {}),
          ...(fetchedDecimals !== null ? { decimals: Number(fetchedDecimals) } : {}),
        })
      }

      const values: Record<TokenField, unknown> = {
        name,
        symbol,
        decimals,
        totalSupply: totalSupply === null ? null : totalSupply.toString(),
      }
      const out: Record<string, unknown> = { address, native }
      let success = true
      for (const field of fields) {
        out[field] = values[field]
        // 主币没有 totalSupply，不算失败
        if (values[field] === null && !(native && field === 'totalSupply')) {
          success = false
        }
      }
      if (wanted.has('totalSupply')) {
        out.totalSupplyFormatted = totalSupply === null || decimals === null ? null : formatAmount(totalSupply, decimals)
      }
      out.success = success
      return out as TokenDetails<F>
    })
  }

  /**
   * 主币余额查询，可以和合约调用放在同一批里（同一次 eth_call）：
   * 有 Multicall3 时调合约的 getEthBalance；deployless 时由 deployless 合约直接用 BALANCE 读取。
   */
  getEthBalance(address: string): BoundCall<bigint> {
    const call: Call<bigint> = {
      // 地址只用于展示：执行时合约模式会换成实际的 multicall 地址，deployless 时由合约内部处理
      contract: { address: this.#ctx?.multicall?.address ?? MULTICALL3_ADDRESS },
      name: 'getEthBalance',
      inputs: ETH_BALANCE_INPUTS,
      outputs: ETH_BALANCE_OUTPUTS,
      params: [address],
      kind: 'ethBalance',
    }
    return bindCall(call, this)
  }

  /**
   * 合并成一次调用，任意一条失败则整体抛错。
   * 可以传数组（结果顺序一致），也可以传 `{ 名字: Call }` 对象（结果是同名字段）。
   */
  all<const C extends CallInput>(calls: C, overrides?: CallOverrides): Promise<CallResults<C>>
  all<T = any>(calls: readonly Call[], overrides?: CallOverrides): Promise<T[]>
  async all(calls: CallInput, overrides?: CallOverrides): Promise<unknown> {
    const [list, pack] = unpack(calls)
    const results = await this.#aggregate(list.map((call) => encodeCall(call, false)), overrides)
    return pack(list.map((call, i) => decodeCall(call, (results[i] as RawResult).returnData)))
  }

  /**
   * 合并成一次调用，失败（revert、解码失败、参数编码失败如非法地址）的位置返回 null。
   * 与 all 一样支持数组或对象。
   */
  tryAll<const C extends CallInput>(calls: C, overrides?: CallOverrides): Promise<TryCallResults<C>>
  tryAll<T = any>(calls: readonly Call[], overrides?: CallOverrides): Promise<(T | null)[]>
  async tryAll(calls: CallInput, overrides?: CallOverrides): Promise<unknown> {
    const [list, pack] = unpack(calls)
    return pack(await this.tryEach(list, list.map(() => true), overrides))
  }

  /**
   * 逐条指定是否允许失败：允许失败的位置返回 null，不允许失败的一旦失败整体抛错。
   */
  async tryEach<T = any>(calls: readonly Call[], canFail: readonly boolean[], overrides?: CallOverrides): Promise<(T | null)[]> {
    // 允许失败的条目编码出错（如后端给的脏地址）只让该条为 null，不拖垮整批
    const requests: Array<CallRequest | null> = calls.map((call, i) => {
      const callCanFail = canFail[i]
      if (callCanFail === undefined) {
        throw new Error('Unable to access the canFail value')
      }
      try {
        return encodeCall(call, callCanFail)
      } catch (err) {
        if (callCanFail) {
          return null
        }
        throw err
      }
    })
    const valid = requests.filter((req): req is CallRequest => req !== null)
    const results = await this.#aggregate(valid, overrides)
    let j = 0
    const aligned = requests.map((req) => (req ? (results[j++] as RawResult) : { success: false, returnData: '0x' }))
    return decodeTry<T>(calls, aligned)
  }

  /**
   * 单条调用，自动与同一收集窗口内的其他 `call()` 合并为一次 multicall。
   * 失败时 reject CallFailedError。适合各组件各自查数据、又希望只发一个请求的场景。
   */
  call<T = any>(call: Call, overrides?: CallOverrides): Promise<T> {
    const own = call.overrides
    return this.#batcher.load<T>(call, merge({ blockTag: own?.blockTag, from: own?.from }, overrides))
  }

  /**
   * 预执行（模拟交易）：直接对目标合约发 eth_call，可带 from / value / gasLimit，
   * 用于 swap 报价、检查交易是否会 revert 等。失败时抛 CallFailedError（带解析后的 revert 原因）。
   *
   * 不走 multicall：multicall 里子调用的 msg.sender 是 multicall 合约本身、也无法按条带 value，
   * 与真实交易不一致。
   *
   * overrides 优先级：参数 overrides > Call 上的 overrides（`contract.swap(params, { value })`）。
   */
  async staticCall<T = any>(call: Call, overrides: StaticCallOverrides = {}): Promise<T> {
    const result = await this.#staticCall<T>(call, overrides)
    if (!result.success) {
      throw result.error
    }
    return result.data
  }

  /**
   * 批量预执行：每条都是独立的 eth_call，同时发出（JsonRpcProvider 会合进一个 JSON-RPC batch 请求；
   * TronProvider 按 concurrency 限流）。每条结果单独返回成功/失败，不会互相影响。
   *
   * @param items Call，或 `{ call, overrides }` 以便每条带不同的 value / from
   * @param overrides 所有条目共享的 overrides，优先级最低
   */
  async staticCallAll<T = any>(
    items: ReadonlyArray<Call | StaticCallItem>,
    overrides: StaticCallOverrides = {},
  ): Promise<StaticCallResult<T>[]> {
    return Promise.all(
      items.map((item) =>
        'call' in item && 'contract' in item.call
          ? this.#staticCall<T>(item.call, item.overrides, overrides)
          : this.#staticCall<T>(item as Call, undefined, overrides),
      ),
    )
  }

  /** 优先级：explicit > Call 自带的 overrides > shared；值为 undefined 的字段不覆盖 */
  async #staticCall<T>(
    call: Call,
    explicit?: StaticCallOverrides,
    shared?: StaticCallOverrides,
  ): Promise<StaticCallResult<T>> {
    const merged: StaticCallOverrides = merge(merge({ ...shared }, call.overrides), explicit)
    if (call.kind === 'ethBalance') {
      try {
        const { provider } = await this.#ensureReady()
        return { success: true, data: (await provider.getBalance(call.params[0], merged.blockTag)) as T }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err : new Error(String(err)) }
      }
    }
    let returnData: string
    try {
      const request = encodeCall(call, false)
      const { provider } = await this.#ensureReady()
      returnData = await provider.call({
        to: request.target,
        data: request.callData,
        from: merged.from,
        value: merged.value,
        gasLimit: merged.gasLimit,
        blockTag: merged.blockTag,
      })
    } catch (err) {
      // 只有执行层面的失败才是 CallFailedError；限流、超时等节点错误原样返回
      if (isExecutionError(err)) {
        return { success: false, error: new CallFailedError(call, (err as { data?: string | null }).data ?? '0x', err) }
      }
      return { success: false, error: err instanceof Error ? err : new Error(String(err)) }
    }
    try {
      return { success: true, data: decodeCall<T>(call, returnData) }
    } catch (err) {
      // 目标地址没有合约时返回 0x，解码失败
      return { success: false, error: new CallFailedError(call, returnData, err) }
    }
  }

  /** 当前区块号（底层节点需支持 getBlockNumber） */
  async getBlockNumber(): Promise<number> {
    const { provider } = await this.#ensureReady()
    if (!provider.getBlockNumber) {
      throw new Error('getBlockNumber is not supported by this provider')
    }
    return provider.getBlockNumber()
  }

  /** eth_getLogs（底层节点需支持 getLogs）。多节点时依次尝试，全部失败抛 GetLogsError */
  async getLogs(filter: Parameters<NonNullable<EthersLikeProvider['getLogs']>>[0]): Promise<Awaited<ReturnType<NonNullable<EthersLikeProvider['getLogs']>>>> {
    const { provider } = await this.#ensureReady()
    if (!provider.getLogs) {
      throw new Error('getLogs is not supported by this provider')
    }
    return provider.getLogs(filter)
  }

  /** 是否是按主币处理的地址（config.nativeTokens，默认 0xeeee…eeee 和零地址） */
  isNativeToken(address: string): boolean {
    return this.#nativeTokens.has(address.toLowerCase())
  }

  /** 按主币处理的地址（小写），顺序同 config.nativeTokens */
  get nativeTokens(): readonly string[] {
    return [...this.#nativeTokens]
  }

  /** 底层连接（多节点时是 FallbackRpc）。只传节点构造时，需在 ready() 之后读取 */
  get rpc(): EthersLikeProvider {
    if (!this.#ctx) {
      throw new Error('Provider is still detecting chainId; await provider.ready() first')
    }
    return this.#ctx.provider
  }

  /** 当前使用的 multicall 合约（null 表示 deployless；只传节点构造时在 ready() 之前也为 null） */
  get multicall(): Multicall | null {
    return this.#ctx?.multicall ?? null
  }

  async #aggregate(requests: CallRequest[], overrides?: CallOverrides): Promise<RawResult[]> {
    return aggregate(await this.#ensureReady(), requests, overrides)
  }
}

function resolveMulticall(chainId: number, custom?: Partial<Multicall>): Multicall | null {
  if (custom?.address) {
    return { address: custom.address, block: custom.block ?? 0 }
  }
  return Number.isFinite(chainId) ? getMulticall3(chainId) : null
}

/** 浅合并，source 里值为 undefined 的字段不覆盖 target */
function merge<T extends object>(target: T, source?: object): T {
  const out = { ...target } as Record<string, unknown>
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value !== undefined) {
      out[key] = value
    }
  }
  return out as T
}

/** 把数组 / 对象输入展开成 Call 列表，并返回把结果还原成同样形状的函数 */
function unpack(calls: CallInput): [readonly Call[], (results: unknown[]) => unknown] {
  if (Array.isArray(calls)) {
    return [calls, (results) => results]
  }
  const keys = Object.keys(calls)
  const record = calls as Readonly<Record<string, Call>>
  return [keys.map((key) => record[key] as Call), (results) => Object.fromEntries(keys.map((key, i) => [key, results[i]]))]
}

function decodeTry<T>(calls: ReadonlyArray<Call | FailableCall>, results: RawResult[]): (T | null)[] {
  return calls.map((call, i) => {
    const result = results[i] as RawResult
    if (!result.success) {
      return null
    }
    try {
      return decodeCall<T>(call, result.returnData)
    } catch {
      // 解码失败：多半是目标地址没有合约
      return null
    }
  })
}

export default Provider

export type { BlockTag, CallOverrides }
