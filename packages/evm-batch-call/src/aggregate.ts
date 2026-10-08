import { AbiCoder, Interface, concat, dataSlice, id, isError, type Provider as EthersProvider } from 'ethers'

import type { CallRequest, RawResult } from './call.js'
import { DEPLOYLESS_MULTICALL3_BYTECODE } from './deployless.js'
import { isExecutionError } from './errors.js'
import { MULTICALL3_ADDRESS, type Multicall } from './multicall.js'

/**
 * 只用到 ethers Provider 的这几个方法：必需 call / getBalance；getLogs / getBlockNumber 可选（只有增量扫描 Transfer 事件时用到）。
 * ethers 的 JsonRpcProvider / BrowserProvider 都满足
 */
export type EthersLikeProvider = Pick<EthersProvider, 'call' | 'getBalance'> & Partial<Pick<EthersProvider, 'getLogs' | 'getBlockNumber'>>

export type BlockTag = number | bigint | string

export interface CallOverrides {
  blockTag?: BlockTag
  from?: string
}

export const multicall3Interface = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
])

const CALL3_TUPLE = 'tuple(address target, bool allowFailure, bytes callData)[]'
const RESULT_TUPLE = 'tuple(bool success, bytes returnData)[]'
/** error Aggregate3Result((bool,bytes)[]) */
const AGGREGATE3_RESULT_SELECTOR = id('Aggregate3Result((bool,bytes)[])').slice(0, 10)

/**
 * 判定为无效的 multicall 地址（无代码 / 不是 Multicall3），按 chainId+address 记在模块级，
 * 这样业务里每次 new Provider 也只会多试一次。
 */
const unusableMulticalls = new Set<string>()

export interface AggregateContext {
  provider: EthersLikeProvider
  chainId: number
  /** null 表示直接走 deployless */
  multicall: Multicall | null
  chunkSize: number
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
  const size = Math.max(1, ctx.chunkSize)
  if (requests.length <= size) {
    return aggregateChunk(ctx, requests, overrides)
  }
  const chunks: CallRequest[][] = []
  for (let i = 0; i < requests.length; i += size) {
    chunks.push(requests.slice(i, i + size))
  }
  const results = await Promise.all(chunks.map((chunk) => aggregateChunk(ctx, chunk, overrides)))
  return results.flat()
}

async function aggregateChunk(
  ctx: AggregateContext,
  requests: CallRequest[],
  overrides: CallOverrides,
): Promise<RawResult[]> {
  const multicall = ctx.multicall
  if (multicall && isUsable(ctx.chainId, multicall, overrides.blockTag)) {
    const results = await callContract(ctx, multicall, requests, overrides)
    if (Array.isArray(results)) {
      return results
    }
    // 只有“最新状态下地址上没有可用合约”才记缓存。
    // - revert 无数据（'reverted'）有歧义：可能是 out of gas / 节点 gas 上限、子调用失败而钱包丢了 revert 数据，
    //   这些情况地址本身是好的，只对这一次退回 deployless，不记缓存
    // - 历史区块查到无代码可能只是那时还没部署，不能推及 latest
    if (results === 'invalid' && isLatest(overrides.blockTag)) {
      unusableMulticalls.add(cacheKey(ctx.chainId, multicall.address))
    }
  }
  return callDeployless(ctx, requests, overrides)
}

/**
 * 'invalid'：地址上没有代码或返回无法解码；'reverted'：执行 revert 且没有 revert 数据。
 * 两种情况都退回 deployless。
 */
async function callContract(
  ctx: AggregateContext,
  multicall: Multicall,
  requests: CallRequest[],
  overrides: CallOverrides,
): Promise<RawResult[] | 'invalid' | 'reverted'> {
  const calls = requests.map((req) => ({
    target: req.ethBalanceOf ? multicall.address : req.target,
    allowFailure: req.allowFailure,
    callData: req.callData,
  }))
  let data: string
  try {
    data = await ctx.provider.call({
      to: multicall.address,
      data: multicall3Interface.encodeFunctionData('aggregate3', [calls]),
      blockTag: overrides.blockTag,
      from: overrides.from,
    })
  } catch (err) {
    // aggregate3 自己的失败（allowFailure=false 的子调用失败）会带 "Multicall3: call failed" 的 revert 数据；
    // 执行层面 revert 且没有数据，基本就是这个地址上不是 Multicall3。
    // 限流、节点缺状态等错误 ethers 也会包装成 CALL_EXCEPTION，那些要原样抛出，不能把地址判成无效
    if (isExecutionError(err) && !hasRevertData(err)) {
      return 'reverted'
    }
    throw err
  }
  // 地址上没有代码时 eth_call 返回 0x
  if (!data || data === '0x') {
    return 'invalid'
  }
  try {
    return decodeAggregate3(multicall3Interface.decodeFunctionResult('aggregate3', data)[0])
  } catch {
    return 'invalid'
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
): Promise<RawResult[]> {
  const chunks = splitByInitcodeSize(requests)
  const results = await Promise.all(chunks.map((chunk) => callDeploylessChunk(ctx, chunk, overrides)))
  return results.flat()
}

async function callDeploylessChunk(
  ctx: AggregateContext,
  requests: CallRequest[],
  overrides: CallOverrides,
): Promise<RawResult[]> {
  const args = AbiCoder.defaultAbiCoder().encode(
    [CALL3_TUPLE],
    [
      requests.map(({ target, allowFailure, callData, ethBalanceOf }) => ({
        target: ethBalanceOf ? MULTICALL3_ADDRESS : target,
        allowFailure,
        callData,
      })),
    ],
  )
  let data: string
  try {
    data = await ctx.provider.call({
      data: concat([DEPLOYLESS_MULTICALL3_BYTECODE, args]),
      blockTag: overrides.blockTag,
      from: overrides.from,
    })
  } catch (err) {
    const revertData = (err as { data?: string | null }).data
    if (isError(err, 'CALL_EXCEPTION') && revertData?.startsWith(AGGREGATE3_RESULT_SELECTOR)) {
      // 结果超过 24KB，合约通过 revert Aggregate3Result(...) 带回
      return decodeAggregate3(AbiCoder.defaultAbiCoder().decode([RESULT_TUPLE], dataSlice(revertData, 4))[0])
    }
    // 有的钱包 / 中间层会丢掉 revert 数据，大结果拿不回来：对半拆开重试，小批量能正常 return
    if (requests.length > 1 && isExecutionError(err) && !hasRevertData(err)) {
      const mid = Math.ceil(requests.length / 2)
      const [a, b] = await Promise.all([
        callDeploylessChunk(ctx, requests.slice(0, mid), overrides),
        callDeploylessChunk(ctx, requests.slice(mid), overrides),
      ])
      return [...a, ...b]
    }
    throw err
  }
  return decodeAggregate3(multicall3Interface.decodeFunctionResult('aggregate3', data)[0])
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
  if (unusableMulticalls.has(cacheKey(chainId, multicall.address))) {
    return false
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
}
