import {
  decodeBase58,
  encodeBase58,
  getBytes,
  hexlify,
  makeError,
  sha256,
  toBeHex,
  toUtf8String,
  type TransactionRequest,
} from 'ethers'

import type { EthersLikeProvider } from './aggregate.js'

/** Tron 链 ID（与 TronGrid /jsonrpc 的 eth_chainId 一致） */
export const TRON_CHAIN_ID = {
  mainnet: 728126428,
  shasta: 2494104990,
  nile: 3448148188,
} as const

const TRON_CHAIN_IDS = new Set<number>(Object.values(TRON_CHAIN_ID))

/** 是否是 Tron 链（主网 / 测试网）：只能查最新状态，地址区分大小写 */
export function isTronChain(chainId: number): boolean {
  return TRON_CHAIN_IDS.has(chainId)
}

const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

export function isTronAddress(value: unknown): boolean {
  return typeof value === 'string' && TRON_ADDRESS_RE.test(value)
}

/** T 开头的 base58 地址 → 0x 开头的 20 字节地址（ABI 编码用）；已经是 0x 地址则原样返回 */
export function toEvmAddress(address: string): string {
  if (!isTronAddress(address)) {
    if (/^41[0-9a-fA-F]{40}$/.test(address)) {
      return `0x${address.slice(2)}`
    }
    return address
  }
  const bytes = getBytes(toBeHex(decodeBase58(address), 25))
  const payload = bytes.slice(0, 21)
  const checksum = getBytes(sha256(sha256(payload))).slice(0, 4)
  if (bytes[0] !== 0x41 || hexlify(checksum) !== hexlify(bytes.slice(21))) {
    throw new Error(`Invalid Tron address: ${address}`)
  }
  return hexlify(payload.slice(1))
}

/** 0x 地址 / 41 开头的 hex 地址 → T 开头的 base58 地址 */
export function toTronAddress(address: string): string {
  if (isTronAddress(address)) {
    return address
  }
  const hex = address.replace(/^0x/i, '').replace(/^41(?=[0-9a-fA-F]{40}$)/, '')
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
    throw new Error(`Invalid address: ${address}`)
  }
  const payload = getBytes(`0x41${hex}`)
  const checksum = getBytes(sha256(sha256(payload))).slice(0, 4)
  return encodeBase58(new Uint8Array([...payload, ...checksum]))
}

function toTronHex(address: string): string {
  return `41${toEvmAddress(address).slice(2).toLowerCase()}`
}

/** 只用到 tronWeb 的这几个字段，兼容 tronweb v5/v6 及钱包注入的实例 */
export interface TronWebLike {
  /** host 是当前连接的全节点地址，TronLink 切换网络时会变，用于区分 chainId 缓存 */
  fullNode: { request: (url: string, payload: Record<string, unknown>, method: string) => Promise<any>; host?: string }
  defaultAddress?: { base58?: string | false }
}

export type TronRequest = (path: string, body: Record<string, unknown>) => Promise<any>

export interface TronProviderOptions {
  /** 全节点地址，默认 https://api.trongrid.io */
  fullHost?: string
  /** TronGrid API Key（TRON-PRO-API-KEY） */
  apiKey?: string
  headers?: Record<string, string>
  /**
   * 自定义请求函数，可以接入已有的 tronWeb：
   * `request: (path, body) => tronWeb.fullNode.request(path, body, 'post')`
   */
  request?: TronRequest
  /** 同时在途的最大请求数，避免触发 TronGrid 限频。默认 4 */
  concurrency?: number
  /** 相邻两次请求发起的最小间隔（毫秒）。没有 API Key 时建议 200 左右。默认 0 */
  minInterval?: number
  /** 遇到 HTTP 429 时的重试次数（指数退避，从 1s 开始）。默认 3 */
  retries?: number
  /** 单次 HTTP 请求超时（毫秒，仅对内置 fetch 生效，自定义 request 自行处理）。默认 10000；<= 0 不限制 */
  timeout?: number
  /** 不传 from 时使用的调用者地址；传函数则每次调用时取值（钱包切换账号后自动跟随） */
  defaultFrom?: string | (() => string | null | undefined)
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

// T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb，Tron 的零地址
const ZERO_OWNER = '410000000000000000000000000000000000000000'

/**
 * 基于 Tron 全节点 HTTP API 的 Provider 适配器，实现 ethers Provider 的 `call` / `getBalance`，
 * 可以直接传给 `new Provider(TRON_CHAIN_ID.mainnet, tronProvider)`。
 *
 * 不用 TronGrid 的 /jsonrpc 是因为它不支持合约创建调用（deployless）、不带 revert 数据、不支持 value。
 * 注意：Tron HTTP API 只能查询最新状态，传历史 blockTag 会直接报错。
 */
export class TronProvider implements EthersLikeProvider {
  readonly #request: TronRequest
  readonly #concurrency: number
  readonly #minInterval: number
  readonly #retries: number
  readonly #defaultFrom: TronProviderOptions['defaultFrom']
  #active = 0
  #nextStart = 0
  readonly #waiting: Array<() => void> = []

  constructor(options: TronProviderOptions = {}) {
    this.#concurrency = Math.max(1, options.concurrency ?? 4)
    this.#minInterval = Math.max(0, options.minInterval ?? 0)
    this.#retries = Math.max(0, options.retries ?? 3)
    this.#defaultFrom = options.defaultFrom
    if (options.request) {
      this.#request = options.request
    } else {
      const host = (options.fullHost ?? 'https://api.trongrid.io').replace(/\/+$/, '')
      const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers }
      if (options.apiKey) {
        headers['TRON-PRO-API-KEY'] = options.apiKey
      }
      const timeout = options.timeout ?? 10_000
      this.#request = async (path, body) => {
        const res = await fetch(`${host}/${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: timeout > 0 && Number.isFinite(timeout) ? AbortSignal.timeout(timeout) : undefined,
        })
        if (!res.ok) {
          throw new HttpError(`Tron request ${path} failed: HTTP ${res.status}`, res.status)
        }
        return res.json()
      }
    }
  }

  /**
   * 复用浏览器钱包（TronLink / OKX 等）注入的 tronWeb：请求走钱包配置的节点，
   * 默认以当前连接的钱包地址作为调用者（预执行时 msg.sender 即用户）。
   */
  static fromTronWeb(tronWeb: TronWebLike, options: Omit<TronProviderOptions, 'request' | 'fullHost'> = {}): TronProvider {
    return new TronProvider({
      ...options,
      defaultFrom: options.defaultFrom ?? (() => tronWeb.defaultAddress?.base58 || undefined),
      request: (path, body) => tronWeb.fullNode.request(path, body, 'post'),
    })
  }

  async call(tx: TransactionRequest): Promise<string> {
    assertLatest(tx.blockTag)
    const body: Record<string, unknown> = {
      owner_address: tx.from ? toTronHex(String(tx.from)) : this.#getDefaultFrom(),
      data: String(tx.data ?? '0x').replace(/^0x/, ''),
    }
    if (tx.to) {
      body.contract_address = toTronHex(String(tx.to))
    }
    if (tx.value) {
      body.call_value = Number(BigInt(tx.value))
    }

    const res = await this.#limit(() => this.#request('wallet/triggerconstantcontract', body))
    const result = res?.result ?? {}
    const message = typeof result.message === 'string' ? decodeMessage(result.message) : ''

    if (result.code) {
      // 地址上没有合约：与 EVM 节点一致返回 0x（multicall 地址无效时会据此退回 deployless）
      if (result.code === 'CONTRACT_VALIDATE_ERROR' && /not exist/i.test(message)) {
        return '0x'
      }
      // 其余 code（如 call_value 超过余额）是交易本身校验不通过，换节点也一样：
      // 按执行错误抛出（isExecutionError 能识别），不触发 FallbackRpc 换节点，staticCall 得到 CallFailedError
      throw makeError(`Tron call failed: ${result.code}${message ? ` ${message}` : ''}`, 'CALL_EXCEPTION', {
        action: 'call',
        data: null,
        reason: message || null,
        transaction: { to: tx.to ? String(tx.to) : null, from: tx.from ? String(tx.from) : undefined, data: String(tx.data ?? '0x') },
        invocation: null,
        revert: null,
        info: { error: { code: result.code, message: `${result.code}: ${message}` } },
      })
    }

    const output = `0x${res?.constant_result?.[0] ?? ''}`
    if (res?.transaction?.ret?.[0]?.ret === 'FAILED') {
      throw makeError(message || 'execution reverted', 'CALL_EXCEPTION', {
        action: 'call',
        data: output,
        reason: null,
        transaction: { to: tx.to ? String(tx.to) : null, from: tx.from ? String(tx.from) : undefined, data: String(tx.data ?? '0x') },
        invocation: null,
        revert: null,
      })
    }
    return output
  }

  /** chainId = 创世区块哈希的最后 4 字节（与 TronGrid /jsonrpc 的 eth_chainId 一致，主网 728126428） */
  async getChainId(): Promise<number> {
    const res = await this.#limit(() => this.#request('wallet/getblockbynum', { num: 0 }))
    const blockId = String(res?.blockID ?? '')
    if (!/^[0-9a-f]{64}$/i.test(blockId)) {
      throw new Error('Unable to detect Tron chainId: unexpected genesis block response')
    }
    return Number.parseInt(blockId.slice(-8), 16)
  }

  async getBalance(address: unknown, blockTag?: unknown): Promise<bigint> {
    assertLatest(blockTag)
    const res = await this.#limit(() => this.#request('wallet/getaccount', { address: toTronHex(String(address)) }))
    return BigInt(res?.balance ?? 0)
  }

  #getDefaultFrom(): string {
    const from = typeof this.#defaultFrom === 'function' ? this.#defaultFrom() : this.#defaultFrom
    return from ? toTronHex(from) : ZERO_OWNER
  }

  async #limit<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#concurrency) {
      // 名额由释放方直接转交（#active 不变），避免被唤醒前被新来的请求抢走而超出并发上限
      await new Promise<void>((resolve) => this.#waiting.push(resolve))
    } else {
      this.#active++
    }
    try {
      for (let attempt = 0; ; attempt++) {
        await this.#throttle()
        try {
          return await task()
        } catch (err) {
          if (attempt >= this.#retries || !isRateLimited(err)) {
            throw err
          }
          await sleep(1000 * 2 ** attempt)
        }
      }
    } finally {
      const next = this.#waiting.shift()
      if (next) {
        next()
      } else {
        this.#active--
      }
    }
  }

  async #throttle(): Promise<void> {
    if (!this.#minInterval) {
      return
    }
    const now = Date.now()
    const start = Math.max(now, this.#nextStart)
    this.#nextStart = start + this.#minInterval
    if (start > now) {
      await sleep(start - now)
    }
  }
}

function assertLatest(blockTag: unknown): void {
  if (blockTag === undefined || blockTag === null || blockTag === 'latest' || blockTag === 'pending') {
    return
  }
  throw new Error(`Tron does not support calls at block ${String(blockTag)}`)
}

function isRateLimited(err: unknown): boolean {
  // fetch 实现抛 HttpError；tronWeb（axios）的错误带 response.status
  const e = err as { status?: number; response?: { status?: number } } | null
  return e?.status === 429 || e?.response?.status === 429
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function decodeMessage(hex: string): string {
  try {
    return toUtf8String(`0x${hex}`)
  } catch {
    return hex
  }
}
