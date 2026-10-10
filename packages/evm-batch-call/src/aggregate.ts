import { AbiCoder, Interface, concat, dataSlice, id, isError, type Provider as EthersProvider } from 'ethers'

import { encodeUint256, type CallRequest, type RawResult } from './call.js'
import { DEPLOYLESS_MULTICALL3_BYTECODE } from './deployless.js'
import { isExecutionError } from './errors.js'
import { AllNodesFailedError, FallbackRpc, InvalidResultError, NodeBehindError, isBehind } from './fallback.js'
import { MULTICALL3_ADDRESS, type Multicall } from './multicall.js'
import { isTronChain } from './tron.js'

/**
 * 只用到 ethers Provider 的这几个方法：必需 call / getBalance；getLogs / getBlockNumber 可选（只有增量扫描 Transfer 事件时用到）。
 * ethers 的 JsonRpcProvider / BrowserProvider 都满足
 */
export type EthersLikeProvider = Pick<EthersProvider, 'call' | 'getBalance'> & Partial<Pick<EthersProvider, 'getLogs' | 'getBlockNumber'>>

export type BlockTag = number | bigint | string

export interface CallOverrides {
  blockTag?: BlockTag
  from?: string
  /**
   * 最低区块：节点落后于这个区块时（如交易刚确认、公共节点还没跟上）不用它的结果——
   * 改为按这个区块重查（落后的节点会报错、自动换节点），所有节点都落后时稍等重试，最多约 10 秒。
   * 只对最新状态的查询生效（指定了 blockTag 时忽略）
   */
  minBlock?: number
  /** 取消查询：已取消时不发请求；执行中取消时立即 reject（合并在一起的底层请求继续完成，结果丢弃） */
  signal?: AbortSignal
}

/**
 * 主币余额的读取方式：
 * - 'contract'：和其他调用放在同一次 eth_call 里（Multicall3.getEthBalance / deployless 合约里的 BALANCE）
 * - 'rpc'：单独用 eth_getBalance（与 eth_call 同时发出）。用于合约里读主币余额不可靠的链（如 BALANCE 恒为 0）
 * - { erc20 }：主币其实是一个 ERC20 合约，改调它的 balanceOf
 */
export type NativeBalanceMode = 'contract' | 'rpc' | { erc20: string }

const balanceOfInterface = new Interface(['function balanceOf(address owner) view returns (uint256)'])

export const multicall3Interface = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
  'function getBlockNumber() view returns (uint256 blockNumber)',
])

/** 区块号查询（minBlock 检查用）：目标在执行时换成 multicall 地址 */
const BLOCK_NUMBER_REQUEST: CallRequest = {
  target: MULTICALL3_ADDRESS,
  allowFailure: true,
  callData: multicall3Interface.encodeFunctionData('getBlockNumber'),
  blockNumber: true,
}

/**
 * Arbitrum 系的链（Arbitrum One / Nova、Orbit 链如 Robinhood Chain）在合约里 block.number 是 L1 区块号，
 * L2 区块号要从 ArbSys 预编译合约（0x64）的 arbBlockNumber() 读。区块号查询时顺带读它：有返回值就用它，
 * 其他链上 0x64 没有代码、返回空数据，忽略
 */
const ARB_BLOCK_NUMBER_REQUEST: CallRequest = {
  target: '0x0000000000000000000000000000000000000064',
  allowFailure: true,
  callData: '0xa3b1b31d', // arbBlockNumber()
}

/** minBlock：所有节点都落后时的重试间隔和总时长 */
const MIN_BLOCK_RETRY_INTERVAL = 1000
const MIN_BLOCK_DEADLINE = 10_000

const CALL3_TUPLE = 'tuple(address target, bool allowFailure, bytes callData)[]'
const RESULT_TUPLE = 'tuple(bool success, bytes returnData)[]'
/** error Aggregate3Result((bool,bytes)[]) */
const AGGREGATE3_RESULT_SELECTOR = id('Aggregate3Result((bool,bytes)[])').slice(0, 10)

/**
 * 判定为无效的 multicall 地址（无代码 / 不是 Multicall3），按 chainId+address 记在模块级，
 * 这样业务里每次 new Provider 也只会多试一次。
 */
const unusableMulticalls = new Map<string, number>()

/** 判定不可用后多久重新尝试合约（节点偶发返回空数据时不至于整个会话都不用 Multicall3） */
const UNUSABLE_TTL = 10 * 60 * 1000
/** 单节点时连续返回空数据 / 无法解码的次数（多节点时由多个节点一致的结果确认，见 aggregateRawChunk） */
const invalidStrikes = new Map<string, number>()

/**
 * eth_call 并解码 aggregate3 的结果：通过 FallbackRpc 时空数据 / 无法解码的结果换下一个节点（解码只做一次，结果复用）；
 * 其他 Provider 不支持校验参数，取到结果后自己校验
 */
async function callAggregate3(
  provider: EthersLikeProvider,
  tx: Parameters<EthersLikeProvider['call']>[0],
  requests: readonly CallRequest[],
  atLeast?: bigint,
): Promise<RawResult[]> {
  const decoded = new Map<string, RawResult[]>()
  // deployless 结果超过 24KB 时通过 revert Aggregate3Result 带回：同样校验区块号，落后时换成 NodeBehindError（FallbackRpc 换节点）
  const inspectError = (err: unknown) => {
    const results = atLeast === undefined ? null : revertedResults(err)
    if (results) {
      assertAtLeast(requests, results, atLeast as bigint)
    }
  }
  const accept = (data: string) => {
    const results = decodeAggregate3Data(data)
    if (!results) {
      return false
    }
    // minBlock：结果里的区块号早于要求时节点落后，抛 NodeBehindError 让 FallbackRpc 换下一个节点
    if (atLeast !== undefined) {
      assertAtLeast(requests, results, atLeast)
    }
    decoded.set(data, results)
    return true
  }
  let data: string
  if (provider instanceof FallbackRpc) {
    data = await provider.call(tx, { accept, inspectError })
  } else {
    // 其他 Provider 不支持校验参数：取到结果后自己校验（同样包括区块号）
    try {
      data = await provider.call(tx)
    } catch (err) {
      inspectError(err)
      throw err
    }
    if (!accept(data)) {
      throw new InvalidResultError(data)
    }
  }
  const results = decoded.get(data) ?? decodeAggregate3Data(data)
  if (!results) {
    throw new InvalidResultError(data)
  }
  return results
}

/** 已解析过的 revert 结果（同一个错误在 inspectError 和 callDeploylessChunk 里各用一次，只解析一次） */
const revertedCache = new WeakMap<object, RawResult[] | null>()

/** deployless 通过 revert Aggregate3Result(...) 带回的结果；不是这种 revert、或数据无法解码时为 null（保留原来的错误） */
function revertedResults(err: unknown): RawResult[] | null {
  const revertData = (err as { data?: string | null } | null)?.data
  if (!isError(err, 'CALL_EXCEPTION') || !revertData?.startsWith(AGGREGATE3_RESULT_SELECTOR)) {
    return null
  }
  const cached = revertedCache.get(err)
  if (cached !== undefined) {
    return cached
  }
  let results: RawResult[] | null
  try {
    results = decodeAggregate3(AbiCoder.defaultAbiCoder().decode([RESULT_TUPLE], dataSlice(revertData, 4))[0])
  } catch {
    results = null
  }
  revertedCache.set(err, results)
  return results
}

/** ArbSys.arbBlockNumber() 的结果（Arbitrum 系的 L2 区块号）；其他链上 0x64 没有代码、返回空数据，为 null */
function l2BlockOf(result: RawResult | undefined): bigint | null {
  return result?.success && result.returnData.length === 66 ? BigInt(result.returnData) : null
}

/**
 * minBlock 校验：这次 eth_call 里附带的区块号查询（BLOCK_NUMBER_REQUEST，Arbitrum 上用一起附带的 L2 区块号）早于要求时，
 * 抛 NodeBehindError（FallbackRpc 换下一个节点）。每次 eth_call 都附带了这两条（deployless 切片时每片各自附带）
 */
function assertAtLeast(requests: readonly CallRequest[], results: readonly RawResult[], atLeast: bigint): void {
  const blockIndex = requests.lastIndexOf(BLOCK_NUMBER_REQUEST)
  if (blockIndex === -1) {
    return
  }
  const arbIndex = requests.lastIndexOf(ARB_BLOCK_NUMBER_REQUEST)
  assertBlock((arbIndex === -1 ? null : l2BlockOf(results[arbIndex])) ?? blockOf(results[blockIndex]), atLeast)
}

/** 区块号不早于 minBlock，否则节点落后（读不到区块号也按落后处理） */
function assertBlock(block: bigint | null, atLeast: bigint): void {
  if (block === null || block < atLeast) {
    throw new NodeBehindError(atLeast, block ?? -1n)
  }
}

/** aggregate3 返回数据的解码结果；空数据或无法解码时为 null */
function decodeAggregate3Data(data: string): RawResult[] | null {
  if (!data || data === '0x') {
    return null
  }
  try {
    return decodeAggregate3(multicall3Interface.decodeFunctionResult('aggregate3', data)[0])
  } catch {
    return null
  }
}

export interface AggregateContext {
  provider: EthersLikeProvider
  chainId: number
  /** null 表示直接走 deployless */
  multicall: Multicall | null
  chunkSize: number
  /** 主币余额的读取方式，默认 'contract' */
  nativeBalance?: NativeBalanceMode
}

/**
 * 执行一批请求，结果与 requests 一一对应。
 * 有 multicall 合约就调合约的 aggregate3，否则（或合约不可用时）走 deployless。
 * 超过 chunkSize 的请求会拆成多次 eth_call 并发执行（JsonRpcProvider 会把它们合到一个 HTTP batch 里）。
 */
export async function aggregate(
  ctx: AggregateContext,
  requests: CallRequest[],
  overrides: CallOverrides = {},
): Promise<RawResult[]> {
  if (requests.length === 0) {
    return []
  }
  const mode = ctx.nativeBalance ?? 'contract'
  if (mode !== 'contract' && requests.some((req) => req.ethBalanceOf !== undefined)) {
    return typeof mode === 'object' ? aggregate(ctx, requests.map((req) => toErc20Balance(req, mode.erc20)), overrides) : aggregateWithRpcBalances(ctx, requests, overrides)
  }
  const size = Math.max(1, ctx.chunkSize)
  const run = overrides.minBlock !== undefined && isLatest(overrides.blockTag) ? aggregateChunkAtLeast : aggregateChunk
  if (requests.length <= size) {
    return run(ctx, requests, overrides)
  }
  const chunks: CallRequest[][] = []
  for (let i = 0; i < requests.length; i += size) {
    chunks.push(requests.slice(i, i + size))
  }
  const results = await Promise.all(chunks.map((chunk) => run(ctx, chunk, overrides)))
  return results.flat()
}

/**
 * minBlock：先按最新状态查，同一次 eth_call 里顺带读区块号；节点落后时按 minBlock 指定区块重查——
 * 落后的节点对未来区块报 “header not found” 等错误，FallbackRpc 换节点（不冷却）；所有节点都落后时稍等重试。
 * 重查得到的是 minBlock 那个区块的状态（已包含刚确认的交易）。Tron 只能查最新状态，落后时等节点跟上再查。
 * overrides.signal 取消后不再重试
 */
async function aggregateChunkAtLeast(ctx: AggregateContext, requests: CallRequest[], overrides: CallOverrides): Promise<RawResult[]> {
  const minBlock = overrides.minBlock as number
  // Tron 节点只能查最新状态（不支持按区块号查询）
  const canPinBlock = !isTronChain(ctx.chainId)
  const atLeast = BigInt(minBlock)
  let pinned = false
  return retryUntilCaughtUp(overrides, async () => {
    // 区块号校验在 FallbackRpc 里做：落后的节点（结果的区块号早于 minBlock）当场换下一个节点，跟上的节点直接给出最新状态
    try {
      return withoutBlock(await aggregateChunk(ctx, [...requests, BLOCK_NUMBER_REQUEST], overrides, atLeast))
    } catch (err) {
      // 有节点落后（其余节点可能因限频、超时等失败）时，按区块号重查一次；之后只等最新状态跟上，避免每秒把所有节点问两遍
      if (!canPinBlock || pinned || !isBehindFailure(err)) {
        throw err
      }
    }
    // 按区块号重查：落后的节点对未来区块报错或返回较旧区块，同样校验区块号、换节点；仍然都落后时由 retryUntilCaughtUp 稍等重试。
    // 确认节点都落后后不再重查（只等最新状态跟上）；因限频、超时等失败时下次照常重查
    try {
      return withoutBlock(await aggregateChunk(ctx, [...requests, BLOCK_NUMBER_REQUEST], { ...overrides, blockTag: minBlock }, atLeast))
    } catch (err) {
      // 所有节点都落后才不再重查；有节点只是限频、超时等失败时下次照常重查
      if (isAllBehind(err)) {
        pinned = true
      }
      throw err
    }
  })
}

/** 去掉附带的区块号查询（区块号已在每次 eth_call 时由 assertAtLeast 校验过） */
function withoutBlock(results: RawResult[]): RawResult[] {
  return results.slice(0, -1)
}

/**
 * 是否有节点落后：结果早于 minBlock（NodeBehindError），或对按区块号的查询报“区块不存在”（header not found 等）；
 * 多节点时其中有节点是这样（其余可能是限频、超时等）
 */
function isBehindFailure(err: unknown): boolean {
  return isBehindError(err) || (err instanceof AllNodesFailedError && err.errors.some((e) => isBehindError(e.error)))
}

/** 所有节点都落后（单节点时就是它落后） */
function isAllBehind(err: unknown): boolean {
  return isBehindError(err) || (err instanceof AllNodesFailedError && err.errors.every((e) => isBehindError(e.error)))
}

function isBehindError(err: unknown): boolean {
  return err instanceof NodeBehindError || isBehind(err)
}

/** 节点落后时的重试：确定性错误（合约执行结果）直接抛；其余错误每秒重试，最多约 10 秒；signal 取消后停止 */
async function retryUntilCaughtUp<T>(overrides: CallOverrides, run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + MIN_BLOCK_DEADLINE
  for (;;) {
    overrides.signal?.throwIfAborted()
    try {
      return await run()
    } catch (err) {
      if (isExecutionError(err) || Date.now() + MIN_BLOCK_RETRY_INTERVAL > deadline) {
        throw err
      }
    }
    await sleep(MIN_BLOCK_RETRY_INTERVAL, overrides.signal)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 区块号查询的结果；失败时为 null */
function blockOf(result: RawResult | undefined): bigint | null {
  return result?.success && result.returnData !== '0x' ? BigInt(result.returnData) : null
}

/** 主币余额请求改成主币 ERC20 合约的 balanceOf（返回值同样是 uint256，解码方式不变） */
function toErc20Balance(req: CallRequest, erc20: string): CallRequest {
  if (req.ethBalanceOf === undefined) {
    return req
  }
  return { target: erc20, allowFailure: req.allowFailure, callData: balanceOfInterface.encodeFunctionData('balanceOf', [req.ethBalanceOf]) }
}

/**
 * 主币余额单独走 eth_getBalance，结果按原顺序合并；节点错误照常抛出。
 * 需要区块号（withBlock / minBlock）时，先执行其余请求并读出实际区块号，再在这个区块上读主币余额——
 * 主币和代币余额、blockNumber 一致，minBlock 的等待 / 换节点也由其余请求负责；否则两者同时发出
 */
async function aggregateWithRpcBalances(ctx: AggregateContext, requests: CallRequest[], overrides: CallOverrides): Promise<RawResult[]> {
  const others = requests.filter((req) => req.ethBalanceOf === undefined)
  const owners = requests.filter((req) => req.ethBalanceOf !== undefined).map((req) => req.ethBalanceOf as string)
  const contractCtx: AggregateContext = { ...ctx, nativeBalance: 'contract' }
  let otherResults: RawResult[]
  let balances: bigint[]
  // Tron 节点只能查最新状态，不能按区块号读余额
  if (isLatest(overrides.blockTag) && !isTronChain(ctx.chainId) && (overrides.minBlock !== undefined || others.some((req) => req.blockNumber))) {
    const results = await aggregate(contractCtx, [...others, BLOCK_NUMBER_REQUEST], overrides)
    const block = blockOf(results.pop())
    otherResults = results
    const blockTag = block === null ? overrides.blockTag : Number(block)
    // 已知限制：eth_getBalance 不返回区块号，没法校验。读余额的节点如果忽略区块参数、又比给出 blockTag 的节点落后，
    // 主币余额可能比代币余额早几个块（仍不早于 minBlock 的节点才会给出 blockTag 之后的区块）
    const read = () => Promise.all(owners.map((owner) => ctx.provider.getBalance(owner, blockTag)))
    // 只有 minBlock 才等待重试（读的区块可能来自比当前节点更新的节点）；只要 withBlock 时出错照常抛出
    balances = await (overrides.minBlock !== undefined ? retryUntilCaughtUp(overrides, read) : read())
  } else {
    ;[otherResults, balances] = await Promise.all([
      aggregate(contractCtx, others, overrides),
      Promise.all(owners.map((owner) => ctx.provider.getBalance(owner, overrides.blockTag))),
    ])
  }
  let i = 0
  let j = 0
  return requests.map((req) =>
    req.ethBalanceOf === undefined ? (otherResults[i++] as RawResult) : { success: true, returnData: encodeUint256(balances[j++] as bigint) },
  )
}

/** 执行一批请求；其中有区块号查询时顺带读 Arbitrum 的 L2 区块号，并用它替换（见 ARB_BLOCK_NUMBER_REQUEST） */
async function aggregateChunk(ctx: AggregateContext, requests: CallRequest[], overrides: CallOverrides, atLeast?: bigint): Promise<RawResult[]> {
  if (!requests.some((req) => req.blockNumber)) {
    return aggregateRawChunk(ctx, requests, overrides, atLeast)
  }
  const results = await aggregateRawChunk(ctx, [...requests, ARB_BLOCK_NUMBER_REQUEST], overrides, atLeast)
  const arb = results.pop() as RawResult
  if (l2BlockOf(arb) !== null) {
    requests.forEach((req, i) => {
      if (req.blockNumber) {
        results[i] = arb
      }
    })
  }
  return results
}

async function aggregateRawChunk(
  ctx: AggregateContext,
  requests: CallRequest[],
  overrides: CallOverrides,
  atLeast?: bigint,
): Promise<RawResult[]> {
  const multicall = ctx.multicall
  if (multicall && isUsable(ctx.chainId, multicall, overrides.blockTag)) {
    const key = cacheKey(ctx.chainId, multicall.address)
    const results = await callContract(ctx, multicall, requests, overrides, atLeast)
    if (Array.isArray(results)) {
      invalidStrikes.delete(key)
      return results
    }
    // 只有“最新状态下地址上没有可用合约”才记缓存（10 分钟后重新尝试）：
    // - 'invalid'（返回空数据 / 无法解码）要确认过才记：多个节点结果一致，或单节点连续 2 次——节点偶发返回一次 0x 不算
    // - revert 无数据（'reverted'）有歧义：可能是 out of gas / 节点 gas 上限、子调用失败而钱包丢了 revert 数据，
    //   这些情况地址本身是好的，只对这一次退回 deployless，不记缓存
    // - 历史区块查到无代码可能只是那时还没部署，不能推及 latest
    if (results !== 'reverted' && isLatest(overrides.blockTag)) {
      const strikes = (invalidStrikes.get(key) ?? 0) + 1
      if (results === 'invalid-confirmed' || strikes >= 2) {
        unusableMulticalls.set(key, Date.now() + UNUSABLE_TTL)
        invalidStrikes.delete(key)
      } else {
        invalidStrikes.set(key, strikes)
      }
    }
  }
  return callDeployless(ctx, requests, overrides, atLeast)
}

/**
 * 'invalid'：返回空数据（地址上没有代码）或无法解码——经 FallbackRpc 时会先换节点重试；
 * 所有节点（2 个以上）都这样时为 'invalid-confirmed'。'reverted'：执行 revert 且没有 revert 数据。
 * 这几种情况都退回 deployless。
 */
async function callContract(
  ctx: AggregateContext,
  multicall: Multicall,
  requests: CallRequest[],
  overrides: CallOverrides,
  atLeast?: bigint,
): Promise<RawResult[] | 'invalid' | 'invalid-confirmed' | 'reverted'> {
  const calls = requests.map((req) => ({
    target: req.ethBalanceOf || req.blockNumber ? multicall.address : req.target,
    allowFailure: req.allowFailure,
    callData: req.callData,
  }))
  try {
    // 地址上没有代码时 eth_call 返回 0x；空数据 / 无法解码的结果换下一个节点（节点偶发出错时别的节点能给出正确结果）
    return await callAggregate3(
      ctx.provider,
      { to: multicall.address, data: multicall3Interface.encodeFunctionData('aggregate3', [calls]), blockTag: overrides.blockTag, from: overrides.from },
      requests,
      atLeast,
    )
  } catch (err) {
    if (err instanceof InvalidResultError) {
      return 'invalid'
    }
    // 有节点只是落后（minBlock）：不能据此判断合约不存在，按落后处理（由 minBlock 的等待重试负责），不记次数
    // （只看 minBlock 校验得出的 NodeBehindError；“区块不存在”的报错和空数据混在一起时照常退回 deployless）
    if (atLeast !== undefined && (err instanceof NodeBehindError || (err instanceof AllNodesFailedError && err.errors.some((e) => e.error instanceof NodeBehindError)))) {
      throw err
    }
    // 有节点返回空数据、其余节点出错（超时、限频等）：合约可能不存在，退回 deployless；
    // 只有 2 个以上节点都返回空数据才算确认，记缓存
    if (err instanceof AllNodesFailedError && err.errors.some((e) => e.error instanceof InvalidResultError)) {
      const invalid = err.errors.filter((e) => e.error instanceof InvalidResultError).length
      return invalid >= 2 && invalid === err.errors.length ? 'invalid-confirmed' : 'invalid'
    }
    // aggregate3 自己的失败（allowFailure=false 的子调用失败）会带 "Multicall3: call failed" 的 revert 数据；
    // 执行层面 revert 且没有数据，基本就是这个地址上不是 Multicall3。
    // 限流、节点缺状态等错误 ethers 也会包装成 CALL_EXCEPTION，那些要原样抛出，不能把地址判成无效
    if (isExecutionError(err) && !hasRevertData(err)) {
      return 'reverted'
    }
    throw err
  }
}

/**
 * deployless：字节码 + 构造参数作为合约创建 eth_call 发出。
 * 主币余额（ethBalanceOf）也在合约里用 BALANCE 读取，和其他调用在同一次请求里。
 *
 * 合约创建受 EIP-3860 限制，initcode（字节码 + 参数）不能超过 48KB，这里按编码后的大小切片；
 * 返回超过 24KB 的情况由合约改用 revert 带回，见 contracts/DeploylessMulticall3.sol。
 */
async function callDeployless(
  ctx: AggregateContext,
  requests: CallRequest[],
  overrides: CallOverrides,
  atLeast?: bigint,
): Promise<RawResult[]> {
  const chunks = splitByInitcodeSize(requests)
  const results = await Promise.all(chunks.map((chunk) => callDeploylessChunk(ctx, chunk, overrides, atLeast)))
  return results.flat()
}

async function callDeploylessChunk(
  ctx: AggregateContext,
  requests: CallRequest[],
  overrides: CallOverrides,
  atLeast?: bigint,
): Promise<RawResult[]> {
  // minBlock：每片都附带区块号查询并各自校验——只校验带区块号的那一片的话，其他片可能来自落后节点、混进旧数据
  const sent =
    atLeast === undefined
      ? requests
      : [
          ...requests,
          ...(requests.includes(BLOCK_NUMBER_REQUEST) ? [] : [BLOCK_NUMBER_REQUEST]),
          ...(requests.includes(ARB_BLOCK_NUMBER_REQUEST) ? [] : [ARB_BLOCK_NUMBER_REQUEST]),
        ]
  const args = AbiCoder.defaultAbiCoder().encode(
    [CALL3_TUPLE],
    [
      sent.map(({ target, allowFailure, callData, ethBalanceOf, blockNumber }) => ({
        target: ethBalanceOf || blockNumber ? MULTICALL3_ADDRESS : target,
        allowFailure,
        callData,
      })),
    ],
  )
  try {
    // 返回空数据 / 无法解码（节点不支持合约创建式 eth_call，或偶发出错）时换下一个节点
    const results = await callAggregate3(ctx.provider, { data: concat([DEPLOYLESS_MULTICALL3_BYTECODE, args]), blockTag: overrides.blockTag, from: overrides.from }, sent, atLeast)
    return results.slice(0, requests.length)
  } catch (err) {
    // 结果超过 24KB，合约通过 revert Aggregate3Result(...) 带回（区块号已在 callAggregate3 里校验）
    const reverted = revertedResults(err)
    if (reverted) {
      return reverted.slice(0, requests.length)
    }
    // 有的钱包 / 中间层会丢掉 revert 数据，大结果拿不回来：对半拆开重试，小批量能正常 return
    if (requests.length > 1 && isExecutionError(err) && !hasRevertData(err)) {
      const mid = Math.ceil(requests.length / 2)
      const [a, b] = await Promise.all([
        callDeploylessChunk(ctx, requests.slice(0, mid), overrides, atLeast),
        callDeploylessChunk(ctx, requests.slice(mid), overrides, atLeast),
      ])
      return [...a, ...b]
    }
    throw err
  }
}

/** EIP-3860 initcode 上限 49152 字节，留出余量 */
const MAX_INITCODE_SIZE = 48_000
const BYTECODE_SIZE = (DEPLOYLESS_MULTICALL3_BYTECODE.length - 2) / 2

function splitByInitcodeSize(requests: CallRequest[]): CallRequest[][] {
  // 动态数组头 64 字节；每条 = 数组内偏移 32 + (target, allowFailure, bytes 偏移) 96 + bytes 长度 32 + 补齐后的数据
  const budget = MAX_INITCODE_SIZE - BYTECODE_SIZE - 64
  const chunks: CallRequest[][] = []
  let current: CallRequest[] = []
  let size = 0
  for (const req of requests) {
    const dataLength = (req.callData.length - 2) / 2
    const itemSize = 160 + Math.ceil(dataLength / 32) * 32
    if (current.length && size + itemSize > budget) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(req)
    size += itemSize
  }
  if (current.length) {
    chunks.push(current)
  }
  return chunks
}

function hasRevertData(err: unknown): boolean {
  const data = (err as { data?: string | null }).data
  return Boolean(data && data !== '0x')
}

function decodeAggregate3(raw: ReadonlyArray<readonly [boolean, string]>): RawResult[] {
  return raw.map(([success, returnData]) => ({ success, returnData }))
}

function isUsable(chainId: number, multicall: Multicall, blockTag?: BlockTag): boolean {
  const key = cacheKey(chainId, multicall.address)
  const until = unusableMulticalls.get(key)
  if (until !== undefined) {
    if (Date.now() < until) {
      return false
    }
    unusableMulticalls.delete(key)
  }
  if (blockTag === 'earliest') {
    return false
  }
  if (typeof blockTag === 'number' || typeof blockTag === 'bigint') {
    return BigInt(multicall.block) < BigInt(blockTag)
  }
  if (typeof blockTag === 'string' && /^0x[0-9a-f]+$/i.test(blockTag)) {
    return BigInt(multicall.block) < BigInt(blockTag)
  }
  return true
}

function isLatest(blockTag?: BlockTag): boolean {
  return blockTag === undefined || blockTag === null || blockTag === 'latest' || blockTag === 'pending'
}

function cacheKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`
}

/** 测试用：清掉“地址不可用”的缓存 */
export function resetMulticallCache(): void {
  unusableMulticalls.clear()
  invalidStrikes.clear()
}
