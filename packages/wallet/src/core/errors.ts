/**
 * 错误类型：
 * - user_rejected：用户在钱包里拒绝 / 关闭了请求
 * - pending_request：钱包里已经有一个同类请求在等用户处理（如 MetaMask 的 -32002），请用户打开钱包处理
 * - not_installed：钱包没安装（或这个浏览器里检测不到）
 * - not_connected：这个命名空间没有连接钱包
 * - unsupported_chain：钱包不支持 / 没有添加这条链，且没有提供链的信息让钱包添加
 * - unsupported：钱包或这条链不支持这个操作（如钱包不支持签名消息）
 * - superseded：同一条链上之后又发起了新的连接，并且已经生效，这次的结果作废（不用提示用户）
 * - unknown：其他错误（cause 是原始错误）
 */
export type WalletErrorCode = 'user_rejected' | 'pending_request' | 'not_installed' | 'not_connected' | 'unsupported_chain' | 'unsupported' | 'superseded' | 'unknown'

export class WalletError extends Error {
  readonly code: WalletErrorCode

  constructor(code: WalletErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WalletError'
    this.code = code
  }
}

// 4001：EIP-1193；5000：WalletConnect 的 USER_REJECTED；5002：部分钱包
const REJECTED_CODES = new Set<unknown>([4001, '4001', 'ACTION_REJECTED', 5000, '5000', 5002, '5002'])
// 不匹配单独的 cancelled / canceled：ethers 的 TRANSACTION_REPLACED（reason: 'cancelled'）等不是用户拒绝
const REJECTED_TEXT =
  /user rejected|user denied|user reject|userrejects|user cancel|confirmation declined|connection request reset|denied message signature|denied transaction signature|rejected the request|request rejected|transaction was rejected|签名被拒绝|用户拒绝|用户取消/i

/** 错误对象里可能出现错误码的位置（钱包、ethers、各种包装库各不相同） */
function codesOf(err: unknown): unknown[] {
  const e = err as { code?: unknown; error?: { code?: unknown }; info?: { error?: { code?: unknown } }; cause?: { code?: unknown } } | null
  return [e?.code, e?.error?.code, e?.info?.error?.code, e?.cause?.code]
}

function textOf(err: unknown): string {
  if (typeof err === 'string') return err
  const e = err as { name?: unknown; message?: unknown; reason?: unknown } | null
  return `${String(e?.name ?? '')} ${String(e?.message ?? '')} ${String(e?.reason ?? '')}`
}

/** 是否是用户拒绝（各钱包、各链的写法：4001、ACTION_REJECTED、“User rejected”、“Confirmation declined by user” 等） */
export function isUserRejected(err: unknown): boolean {
  if (err instanceof WalletError) return err.code === 'user_rejected'
  if (codesOf(err).some((code) => REJECTED_CODES.has(code))) return true
  // WalletWindowClosedError：tronwallet-adapter 的扫码窗口被用户关掉
  const name = (err as { name?: unknown } | null)?.name
  return name === 'UserRejectedRequestError' || name === 'WalletWindowClosedError' || REJECTED_TEXT.test(textOf(err))
}

/** 把钱包抛出的各种错误统一成 WalletError（已经是的原样返回） */
export function toWalletError(err: unknown, fallback = 'Wallet request failed'): WalletError {
  if (err instanceof WalletError) return err
  // 很多钱包抛的是普通对象（{ code, message }），不是 Error：也取它的 message
  const raw = typeof err === 'string' ? err : (err as { message?: unknown } | null)?.message
  const message = typeof raw === 'string' ? raw : ''
  if (isUserRejected(err)) return new WalletError('user_rejected', message || 'User rejected the request', { cause: err })
  // 各钱包库的“没找到钱包”（如 tronwallet-adapter 的 WalletNotFoundError）
  if (/NotFound/.test(String((err as { name?: unknown } | null)?.name ?? ''))) return new WalletError('not_installed', message || 'Wallet not found', { cause: err })
  const codes = codesOf(err)
  if (codes.includes(-32002)) return new WalletError('pending_request', 'A request is already pending in the wallet; open the wallet to continue', { cause: err })
  if (codes.includes(4200)) return new WalletError('unsupported', message || 'The wallet does not support this method', { cause: err })
  if (codes.includes(4902) || codes.includes(4901)) return new WalletError('unsupported_chain', message || 'The wallet does not support this chain', { cause: err })
  return new WalletError('unknown', message || fallback, { cause: err })
}

/** 等 promise，signal 取消时提前以 user_rejected 结束（onAbort 用来做清理，如中止配对） */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal, onAbort?: () => void): Promise<T> {
  if (signal.aborted) {
    onAbort?.()
    return Promise.reject(new WalletError('user_rejected', 'Connection cancelled'))
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      onAbort?.()
      reject(new WalletError('user_rejected', 'Connection cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
