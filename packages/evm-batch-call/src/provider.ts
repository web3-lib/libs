import { type BigNumberish } from 'ethers'

import { aggregate, type AggregateContext, type BlockTag, type CallOverrides, type EthersLikeProvider } from './aggregate.js'
import { Batcher, type BatchOptions } from './batcher.js'
import { decodeCall, encodeCall, type BoundCall, type Call, type CallRequest, type FailableCall, type RawResult } from './call.js'
import { Contract, bindCall, type ContractAbi, type ContractRunner } from './contract.js'
import { DEFAULT_NATIVE_TOKENS, ERC20_ABI, type Erc20Contract, type TokenInfo } from './erc20.js'
import { CallFailedError, isExecutionError } from './errors.js'
import { MULTICALL3_ADDRESS, getMulticall3, type Multicall } from './multicall.js'
import { resolveSource, type ProviderSource, type SourceOptions } from './source.js'

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
  /** `balances()` 里视为主币的地址，默认 0xeeee…eeee 和零地址 */
  nativeTokens?: readonly string[]
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
  readonly #ctx: AggregateContext
  readonly #batcher: Batcher
  readonly #nativeTokens: Set<string>

  /**
   * @param chainId 链 ID（接受数字字符串）
   * @param provider 节点：RPC URL、ethers Provider、钱包（window.ethereum / tronWeb）或它们的数组（主节点 + 备用节点）。
   *   不传则使用内置的公共节点表
   * @param config 可选配置
   */
  constructor(chainId: number | string, provider?: ProviderSource | readonly ProviderSource[], config: ProviderConfig = {}) {
    const id = Number(chainId)
    this.#ctx = {
      provider: resolveSource(id, provider, config),
      chainId: id,
      multicall: config.deployless ? null : resolveMulticall(id, config.multicall),
      chunkSize: config.chunkSize ?? 500,
    }
    this.#batcher = new Batcher((requests, overrides) => this.#aggregate(requests, overrides), config.batch)
    this.#nativeTokens = new Set((config.nativeTokens ?? DEFAULT_NATIVE_TOKENS).map((t) => t.toLowerCase()))
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
   * 批量查余额，主币和代币混在一起、一次请求。主币地址见 config.nativeTokens。
   * 查询失败（非合约地址、非法地址等）的位置为 0n；需要区分失败请用 tryAll。
   */
  async balances(owner: string, tokens: readonly string[], overrides?: CallOverrides): Promise<bigint[]> {
    const calls = tokens.map((token) =>
      this.#nativeTokens.has(token.toLowerCase()) ? this.getEthBalance(owner) : this.erc20(token).balanceOf(owner),
    )
    const results = await this.tryAll<bigint>(calls, overrides)
    return results.map((balance) => balance ?? 0n)
  }

  /**
   * 批量查代币信息（symbol / name / decimals），一次请求。
   * decimals 读不到（非代币合约、主币占位地址等）的位置为 null。
   */
  async tokenInfo(tokens: readonly string[], overrides?: CallOverrides): Promise<(TokenInfo | null)[]> {
    // 主币占位地址不是合约，不发请求
    const targets = tokens.filter((token) => !this.#nativeTokens.has(token.toLowerCase()))
    const calls = targets.flatMap((token) => {
      const erc20 = this.erc20(token)
      return [erc20.symbol(), erc20.name(), erc20.decimals()]
    })
    const results = calls.length ? await this.tryAll(calls, overrides) : []
    const infoByToken = new Map<string, TokenInfo | null>()
    targets.forEach((address, i) => {
      const decimals = results[i * 3 + 2] as bigint | null
      infoByToken.set(
        address,
        decimals === null
          ? null
          : {
              address,
              symbol: (results[i * 3] as string | null) ?? null,
              name: (results[i * 3 + 1] as string | null) ?? null,
              decimals: Number(decimals),
            },
      )
    })
    return tokens.map((token) => infoByToken.get(token) ?? null)
  }

  /**
   * 主币余额查询，可以和合约调用放在同一批里（同一次 eth_call）：
   * 有 Multicall3 时调合约的 getEthBalance；deployless 时由 deployless 合约直接用 BALANCE 读取。
   */
  getEthBalance(address: string): BoundCall<bigint> {
    const call: Call<bigint> = {
      contract: { address: this.#ctx.multicall?.address ?? MULTICALL3_ADDRESS },
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
        return { success: true, data: (await this.#ctx.provider.getBalance(call.params[0], merged.blockTag)) as T }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err : new Error(String(err)) }
      }
    }
    let returnData: string
    try {
      const request = encodeCall(call, false)
      returnData = await this.#ctx.provider.call({
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

  /** 底层连接（多节点时是 FallbackRpc） */
  get rpc(): EthersLikeProvider {
    return this.#ctx.provider
  }

  /** 当前使用的 multicall 合约（null 表示 deployless） */
  get multicall(): Multicall | null {
    return this.#ctx.multicall
  }

  #aggregate(requests: CallRequest[], overrides?: CallOverrides): Promise<RawResult[]> {
    return aggregate(this.#ctx, requests, overrides)
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
