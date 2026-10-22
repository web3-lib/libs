import { fetchJson } from '../http.js'
import { DUMMY_SIGNATURE, hexToBigInt, userOpToRpc, type UserOperation } from './userOp.js'

export interface RpcClientOptions {
  /** 自定义 fetch（测试、代理） */
  fetch?: typeof fetch
  /** 附加请求头（Authorization 等） */
  headers?: Record<string, string>
}

/** 最小的 JSON-RPC 客户端：错误信息里只有域名，不带 URL（API Key 常在 URL 里） */
class JsonRpc {
  #id = 0
  constructor(
    readonly url: string,
    readonly options: RpcClientOptions = {},
  ) {}

  async request<T>(method: string, params: unknown[]): Promise<T> {
    const body = await fetchJson<{ result?: T; error?: { code?: number; message?: string; data?: unknown } }>(
      this.options.fetch ?? fetch,
      this.url,
      { method: 'POST', headers: { 'content-type': 'application/json', ...this.options.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#id, method, params }) },
      'secret',
    )
    if (body.error) {
      throw new Error(`${method}: ${body.error.message ?? 'RPC error'}${body.error.code === undefined ? '' : ` (${body.error.code})`}`)
    }
    return body.result as T
  }
}

/** bundler 返回的 UserOperation 回执 */
export interface UserOperationReceipt {
  userOpHash: string
  sender: string
  success: boolean
  /** 执行失败时的原因（revert 数据） */
  reason?: string
  actualGasCost: bigint
  actualGasUsed: bigint
  /** 打包它的那笔交易 */
  transactionHash: string
  blockNumber: number | null
}

export interface GasEstimate {
  callGasLimit: bigint
  verificationGasLimit: bigint
  preVerificationGas: bigint
  paymasterVerificationGasLimit?: bigint
  paymasterPostOpGasLimit?: bigint
}

/**
 * ERC-4337 bundler 客户端：eth_sendUserOperation / eth_estimateUserOperationGas / eth_getUserOperationReceipt / eth_supportedEntryPoints。
 *
 * ```ts
 * const bundler = new BundlerClient('https://public.pimlico.io/v2/8453/rpc')
 * await bundler.supportedEntryPoints()
 * ```
 */
export class BundlerClient {
  readonly #rpc: JsonRpc
  constructor(url: string, options: RpcClientOptions = {}) {
    this.#rpc = new JsonRpc(url, options)
  }

  supportedEntryPoints(): Promise<string[]> {
    return this.#rpc.request('eth_supportedEntryPoints', [])
  }

  chainId(): Promise<number> {
    return this.#rpc.request<string>('eth_chainId', []).then(Number)
  }

  /** 估算 gas：signature 为空时用占位签名 */
  async estimateUserOperationGas(op: UserOperation, entryPoint: string): Promise<GasEstimate> {
    const rpcOp = userOpToRpc({ ...op, signature: op.signature === '0x' ? DUMMY_SIGNATURE : op.signature })
    const r = await this.#rpc.request<Record<string, string>>('eth_estimateUserOperationGas', [rpcOp, entryPoint])
    return {
      callGasLimit: hexToBigInt(r.callGasLimit),
      verificationGasLimit: hexToBigInt(r.verificationGasLimit),
      preVerificationGas: hexToBigInt(r.preVerificationGas),
      ...(r.paymasterVerificationGasLimit === undefined ? {} : { paymasterVerificationGasLimit: hexToBigInt(r.paymasterVerificationGasLimit) }),
      ...(r.paymasterPostOpGasLimit === undefined ? {} : { paymasterPostOpGasLimit: hexToBigInt(r.paymasterPostOpGasLimit) }),
    }
  }

  /** 提交，返回 userOpHash */
  sendUserOperation(op: UserOperation, entryPoint: string): Promise<string> {
    return this.#rpc.request('eth_sendUserOperation', [userOpToRpc(op), entryPoint])
  }

  /** 回执；还没上链为 null */
  async getUserOperationReceipt(hash: string): Promise<UserOperationReceipt | null> {
    const r = await this.#rpc.request<{ userOpHash: string; sender: string; success: boolean; reason?: string; actualGasCost: string; actualGasUsed: string; receipt: { transactionHash: string; blockNumber?: string } } | null>(
      'eth_getUserOperationReceipt',
      [hash],
    )
    if (!r) {
      return null
    }
    return {
      userOpHash: r.userOpHash,
      sender: r.sender,
      success: r.success === true,
      ...(r.reason ? { reason: r.reason } : {}),
      actualGasCost: hexToBigInt(r.actualGasCost),
      actualGasUsed: hexToBigInt(r.actualGasUsed),
      transactionHash: r.receipt.transactionHash,
      blockNumber: r.receipt.blockNumber ? Number(r.receipt.blockNumber) : null,
    }
  }

  /** 轮询回执直到上链；超时返回 null（UserOperation 之后仍可能上链） */
  async waitForUserOperation(hash: string, options: { timeout?: number; pollInterval?: number; signal?: AbortSignal } = {}): Promise<UserOperationReceipt | null> {
    const { timeout = 120_000, pollInterval = 2_000, signal } = options
    const deadline = Date.now() + timeout
    while (!signal?.aborted) {
      try {
        const receipt = await this.getUserOperationReceipt(hash)
        if (receipt) {
          return receipt
        }
      } catch {
        // bundler 暂时出错：下次再查
      }
      if (Date.now() >= deadline) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollInterval, Math.max(0, deadline - Date.now()))))
    }
    return null
  }
}

/** paymaster 返回的字段，合并进 UserOperation */
export type PaymasterFields = Pick<UserOperation, 'paymaster' | 'paymasterData' | 'paymasterVerificationGasLimit' | 'paymasterPostOpGasLimit'>

export interface PaymasterContext {
  entryPoint: string
  chainId: number
  /** 'stub'：估算 gas 前，要占位数据；'final'：gas 已定，要真正的签名数据 */
  stage: 'stub' | 'final'
}

/** 自定义 paymaster：拿到 UserOperation 返回 paymaster 字段（verifying paymaster 自己签名、自家后端等） */
export type PaymasterHook = (op: UserOperation, context: PaymasterContext) => Promise<PaymasterFields> | PaymasterFields

/**
 * ERC-7677 paymaster 服务客户端：pm_getPaymasterStubData（估算 gas 用的占位数据）/ pm_getPaymasterData（最终数据）。
 * URL / Key 由应用提供。`client.hook` 可直接作为 `paymaster` 选项
 */
export class PaymasterClient {
  readonly #rpc: JsonRpc
  constructor(
    url: string,
    /** 服务商要求的 context（如 Pimlico 的 `{ sponsorshipPolicyId }`） */
    readonly context: Record<string, unknown> = {},
    options: RpcClientOptions = {},
  ) {
    this.#rpc = new JsonRpc(url, options)
  }

  readonly hook: PaymasterHook = async (op, { entryPoint, chainId, stage }) => {
    const method = stage === 'stub' ? 'pm_getPaymasterStubData' : 'pm_getPaymasterData'
    const r = await this.#rpc.request<Record<string, string>>(method, [userOpToRpc(op), entryPoint, `0x${chainId.toString(16)}`, this.context])
    // v0.6 的 paymasterAndData 格式不支持：只处理拆开的 v0.7 / v0.8 字段
    if (!r.paymaster) {
      throw new Error(`${method}: the response has no paymaster field (EntryPoint v0.7 / v0.8 format expected)`)
    }
    return {
      paymaster: r.paymaster,
      paymasterData: r.paymasterData ?? '0x',
      paymasterVerificationGasLimit: hexToBigInt(r.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: hexToBigInt(r.paymasterPostOpGasLimit),
    }
  }
}
