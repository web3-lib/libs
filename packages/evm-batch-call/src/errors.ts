import { Interface, isError } from 'ethers'

import type { Call } from './call.js'

const errorInterface = new Interface(['error Error(string)', 'error Panic(uint256)'])

/** 自动合并模式下，单条调用失败时 reject 的错误 */
export class CallFailedError extends Error {
  readonly call: Call
  /** revert 原始数据 */
  readonly returnData: string
  /** 能解析出来的 revert 原因（Error(string) / Panic(uint256)） */
  readonly reason: string | null

  constructor(call: Call, returnData: string, cause?: unknown) {
    const reason = decodeRevertReason(returnData)
    super(
      `${call.name} call to ${call.contract.address} failed${reason ? `: ${reason}` : ''}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'CallFailedError'
    this.call = call
    this.returnData = returnData
    this.reason = reason
  }
}

// 最后一项是 TronProvider 对交易校验失败（CONTRACT_VALIDATE_ERROR 等）抛出的错误
const EXECUTION_ERROR_RE =
  /revert|max (init)?code size|out of gas|invalid opcode|stack (underflow|overflow)|invalid jump|^CONTRACT_[A-Z_]+_ERROR:/i

/**
 * eth_call 的失败是否是 EVM 执行层面的确定性结果（revert、代码大小超限等），而不是节点/网络问题。
 *
 * ethers 会把 eth_call 返回的**任何** JSON-RPC 错误都包装成 CALL_EXCEPTION（"missing revert data"），
 * 包括限流（-32005）、header not found、非归档节点缺状态等，所以不能只看错误码：
 * 有 revert 数据，或节点原始错误信息是执行错误，才算确定性失败；其余换节点重试可能会成功。
 */
export function isExecutionError(err: unknown): boolean {
  if (!isError(err, 'CALL_EXCEPTION')) {
    return false
  }
  if (err.data && err.data !== '0x') {
    return true
  }
  const info = err.info as { error?: { message?: unknown } } | undefined
  const raw = info?.error?.message
  // 没有节点原始信息时（如 TronProvider 自己抛的）看 shortMessage；ethers 的 "missing revert data" 不算
  const message = typeof raw === 'string' ? raw : err.shortMessage === 'missing revert data' ? '' : err.shortMessage
  return EXECUTION_ERROR_RE.test(message ?? '')
}

export function decodeRevertReason(data: string): string | null {
  if (!data || data === '0x') {
    return null
  }
  try {
    const parsed = errorInterface.parseError(data)
    if (!parsed) {
      return null
    }
    return parsed.name === 'Panic' ? `Panic(${parsed.args[0]})` : String(parsed.args[0])
  } catch {
    return null
  }
}
