import { Interface, Transaction, isError, type Provider as EthersProvider, type TransactionReceipt, type TransactionRequest } from 'ethers'

import type { EthersLikeProvider } from '../aggregate.js'
import { decodeRevertReason, isExecutionError } from '../errors.js'
import { FallbackRpc, errorText } from '../fallback.js'
import type { Provider } from '../provider.js'
import { ChainCheckedProvider } from '../source.js'
import { TronProvider, isTronChain } from '../tron.js'

/** 写操作要用到的节点方法（ethers 的 JsonRpcProvider / BrowserProvider 都有） */
type WriteNode = Pick<EthersProvider, 'getTransactionCount' | 'estimateGas' | 'getFeeData' | 'broadcastTransaction' | 'getTransactionReceipt' | 'getCode' | 'getBalance' | 'call'>

export interface FeeData {
  gasPrice: bigint | null
  maxFeePerGas: bigint | null
  maxPriorityFeePerGas: bigint | null
}

/**
 * 广播结果：已进交易池（含节点说已经有这笔）；nonce 已被用掉（可能就是这笔已上链，也可能被别的交易占用）；
 * 或不确定（超时、连接失败，或前一个节点超时后另一个节点拒绝：前一个节点也许已经收下了），交易可能已经发出
 */
export type BroadcastOutcome = 'accepted' | 'nonce-used' | { uncertain: string }

/** 换节点也不会变的失败（余额不足、revert、gas 参数不合法等），不再请求其他节点 */
class Final {
  constructor(readonly error: unknown) {}
}

// 节点对“交易池里已经有这笔交易”的各种说法：同一笔签名交易发到多个节点 / 重发时会遇到，视为成功
const ALREADY_KNOWN_RE = /already known|known transaction|already imported|already exists|alreadyknown|already in (the )?(tx|transaction)?\s*pool/i
const NONCE_USED_RE = /nonce too low|nonce has already been used|nonce is too low|invalid nonce|old nonce/i
// 交易本身的问题：换节点结果一样
const TX_INVALID_RE =
  /insufficient funds|intrinsic gas too low|exceeds block gas limit|gas limit reached|max fee per gas less than block base fee|fee cap less than block base fee|underpriced|tip higher than|max priority fee per gas higher than|invalid sender|invalid chain id|only replay-protected|transaction type not supported|tx type not supported|oversized data/i

/** 广播被节点明确拒绝、换节点也一样（交易没进交易池） */
export function isFinalBroadcastError(err: unknown): boolean {
  return isError(err, 'INSUFFICIENT_FUNDS') || isError(err, 'REPLACEMENT_UNDERPRICED') || isError(err, 'INVALID_ARGUMENT') || TX_INVALID_RE.test(errorText(err))
}

/** 节点明确拒绝了这笔交易（给出了 JSON-RPC 错误，或限频）：交易肯定没进这个节点的交易池 */
function isRejection(err: unknown): boolean {
  const e = err as { error?: { message?: unknown }; info?: { error?: { message?: unknown } } } | null
  const message = e?.error?.message ?? e?.info?.error?.message
  if (isFinalBroadcastError(err) || /too many requests|rate.?limit|\b429\b/i.test(errorText(err))) return true
  return typeof message === 'string' && !/timeout|timed out|busy|unavailable|overload|try again/i.test(message)
}

function isFinalEstimateError(err: unknown): boolean {
  return isExecutionError(err) || isError(err, 'INSUFFICIENT_FUNDS') || isError(err, 'INVALID_ARGUMENT') || /insufficient funds|gas required exceeds allowance|transaction type not supported/i.test(errorText(err))
}

/** 预估 / 执行失败的可读原因：优先解析 revert 数据（Error(string) / Panic），否则取节点的原始信息 */
export function failureText(err: unknown): string {
  const data = (err as { data?: unknown } | null)?.data
  const reason = typeof data === 'string' ? decodeRevertReason(data) : null
  if (reason) {
    return `execution reverted: ${reason}`
  }
  return errorText(err)
}

/** 预估 gas 时 revert 带回的数据（解析 7702 批量执行里是第几个调用失败用） */
export function revertData(err: unknown): string | null {
  const data = (err as { data?: unknown } | null)?.data
  return typeof data === 'string' && data !== '0x' ? data : null
}

function asWriteNode(node: EthersLikeProvider, method: keyof WriteNode): WriteNode {
  if (typeof (node as Partial<WriteNode>)[method] !== 'function') {
    throw new Error(`${method} is not supported by this node; pass an RPC URL or an ethers Provider`)
  }
  return node as unknown as WriteNode
}

/**
 * 在 Provider 的节点上执行请求：多节点时与 call / getBalance 相同的故障切换（ChainCheckedProvider 先校验链）；
 * isFinal 判定为确定性的错误（revert、余额不足等）直接抛出，不拿去别的节点重试
 */
export async function runOnNodes<T>(rpc: EthersLikeProvider, method: string, fn: (node: EthersLikeProvider) => Promise<T>, isFinal: (err: unknown) => boolean = () => false): Promise<T> {
  const guarded = (node: EthersLikeProvider): Promise<T | Final> => {
    if (node instanceof ChainCheckedProvider) {
      return node.request((inner) => guarded(inner))
    }
    return fn(node).catch((err: unknown) => {
      if (isFinal(err)) {
        return new Final(err)
      }
      throw err
    })
  }
  const result = rpc instanceof FallbackRpc ? await rpc.request(method, guarded) : await guarded(rpc)
  if (result instanceof Final) {
    throw result.error
  }
  return result
}

/**
 * 写操作的节点访问：nonce、fee、预估 gas、广播、查回执，都经过 Provider 的多节点故障切换。
 * 确定性错误（revert、余额不足等）直接抛出，不拿去别的节点重试
 */
export class WriteRpc {
  constructor(
    readonly rpc: EthersLikeProvider,
    readonly chainId: number,
  ) {}

  static async from(provider: Provider): Promise<WriteRpc> {
    const chainId = await provider.getChainId()
    if (isTronChain(chainId)) {
      throw new Error('This operation is not supported on Tron')
    }
    return new WriteRpc(provider.rpc, chainId)
  }

  #run<T>(method: keyof WriteNode, fn: (node: WriteNode) => Promise<T>, isFinal?: (err: unknown) => boolean): Promise<T> {
    return runOnNodes(
      this.rpc,
      method,
      (node) => {
        if (node instanceof TronProvider) {
          return Promise.reject(new Error('This operation is not supported on Tron'))
        }
        return fn(asWriteNode(node, method))
      },
      isFinal,
    )
  }

  /** 本次批量操作里各钱包已用到的 nonce + 1（同一个 WriteRpc 分几轮发送时接上） */
  readonly #nextNonce = new Map<string, number>()

  /**
   * 下一个可用的 nonce：节点的 pending 计数（含交易池里待确认的交易）与本次已用过的取大者。
   * 多节点时先返回的节点可能还没看到刚发出的交易，只信节点会拿到已用过的 nonce
   */
  async nonce(address: string): Promise<number> {
    const pending = await this.#run('getTransactionCount', (node) => node.getTransactionCount(address, 'pending'))
    return Math.max(pending, this.#nextNonce.get(address.toLowerCase()) ?? 0)
  }

  /** 已上链的交易数（latest nonce） */
  latestNonce(address: string): Promise<number> {
    return this.#run('getTransactionCount', (node) => node.getTransactionCount(address, 'latest'))
  }

  /** 记录 nonce 已被占用（交易已广播，或节点说已被用掉） */
  useNonce(address: string, nonce: number): void {
    const key = address.toLowerCase()
    this.#nextNonce.set(key, Math.max(this.#nextNonce.get(key) ?? 0, nonce + 1))
  }

  code(address: string): Promise<string> {
    return this.#run('getCode', (node) => node.getCode(address))
  }

  async feeData(): Promise<FeeData> {
    const fee = await this.#run('getFeeData', (node) => node.getFeeData())
    return { gasPrice: fee.gasPrice, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
  }

  /** 预估 gas；revert / 余额不足等直接抛出（error.data 是 revert 数据） */
  estimateGas(tx: TransactionRequest): Promise<bigint> {
    return this.#run('estimateGas', (node) => node.estimateGas(tx), isFinalEstimateError)
  }

  /** eth_call；revert 直接抛出 */
  call(tx: TransactionRequest): Promise<string> {
    return this.#run('call', (node) => node.call(tx), isExecutionError)
  }

  /**
   * 广播已签名的交易。同一笔签名交易重复广播是安全的：节点说已经有了视为成功；
   * nonce 已被用掉时返回 'nonce-used'（调用方查回执确认是不是这笔已上链）。其他交易本身的问题直接抛出
   */
  async broadcast(signed: string): Promise<BroadcastOutcome> {
    // 记录各节点的结果：只有所有尝试都是“明确拒绝”、并且没有还在进行中的尝试时，才能确定交易没发出去
    let attempts = 0
    let rejections = 0
    let pending = 0
    try {
      return await this.#run(
        'broadcastTransaction',
        async (node) => {
          attempts++
          pending++
          try {
            await node.broadcastTransaction(signed)
            return 'accepted' as const
          } catch (err) {
            const text = errorText(err)
            if (ALREADY_KNOWN_RE.test(text)) {
              return 'accepted' as const
            }
            if (isError(err, 'NONCE_EXPIRED') || NONCE_USED_RE.test(text)) {
              return 'nonce-used' as const
            }
            if (isRejection(err)) rejections++
            throw err
          } finally {
            pending--
          }
        },
        // 明确拒绝、而且之前没有不确定的尝试：不再问别的节点
        (err) => isFinalBroadcastError(err) && rejections === attempts && pending === 0,
      )
    } catch (err) {
      if (attempts === 0 || rejections === attempts) {
        throw err
      }
      return { uncertain: `broadcast not acknowledged: ${failureText(err)}` }
    }
  }

  receipt(hash: string): Promise<TransactionReceipt | null> {
    return this.#run('getTransactionReceipt', (node) => node.getTransactionReceipt(hash))
  }
}

/** 已签名交易的哈希 */
export function signedHash(signed: string): string {
  return Transaction.from(signed).hash as string
}

// OP Stack（GasPriceOracle）与 Scroll（L1GasPriceOracle）的 L1 数据费：不包含在 gasLimit × gasPrice 里，单独从余额里扣。
// 扫空主币余额时要预留，否则交易因余额不足失败
const L1_ORACLES = ['0x420000000000000000000000000000000000000F', '0x5300000000000000000000000000000000000002'] as const
const l1OracleInterface = new Interface(['function getL1Fee(bytes data) view returns (uint256)'])
/** chainId → 这条链的 L1 费用预言机地址（null 表示不是这类链） */
const l1OracleByChain = new Map<number, string | null>()

/** 测试用 */
export function resetL1OracleCache(): void {
  l1OracleByChain.clear()
}

async function l1Oracle(rpc: WriteRpc): Promise<string | null> {
  const cached = l1OracleByChain.get(rpc.chainId)
  if (cached !== undefined) {
    return cached
  }
  let found: string | null = null
  for (const address of L1_ORACLES) {
    try {
      const code = await rpc.code(address)
      if (code && code !== '0x') {
        found = address
        break
      }
    } catch {
      return null // 节点出错：这次按没有处理，下次再查
    }
  }
  l1OracleByChain.set(rpc.chainId, found)
  return found
}

/**
 * 交易的 L1 数据费（OP Stack / Scroll），其他链为 0。结果加 25% 余量（L1 gas 价格在交易上链前可能上涨）。
 * 查询失败时返回 0（不阻塞发送，只影响扫空主币时的预留）
 */
export async function l1Fee(rpc: WriteRpc, tx: TransactionRequest): Promise<bigint> {
  const oracle = await l1Oracle(rpc)
  if (!oracle) {
    return 0n
  }
  try {
    const unsigned = Transaction.from({ ...tx, from: undefined, chainId: rpc.chainId } as Parameters<typeof Transaction.from>[0]).unsignedSerialized
    const data = await rpc.call({ to: oracle, data: l1OracleInterface.encodeFunctionData('getL1Fee', [unsigned]) })
    const [fee] = l1OracleInterface.decodeFunctionResult('getL1Fee', data)
    return ((fee as bigint) * 125n) / 100n
  } catch {
    return 0n
  }
}
