import { vi } from 'vitest'

import { resetStandardRegistry, type StandardAccount } from '../src/standard/registry.js'
import type { StorageLike } from '../src/core/types.js'

/** 用 EventTarget 模拟浏览器的 window（Node 自带 EventTarget / CustomEvent） */
export function stubWindow(extra: Record<string, unknown> = {}) {
  const win = Object.assign(new EventTarget(), extra)
  vi.stubGlobal('window', win)
  resetStandardRegistry()
  return win as EventTarget & Record<string, unknown>
}

export function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  }
}

class Emitter {
  readonly handlers = new Map<string, Set<(...args: any[]) => void>>()
  on(event: string, fn: (...args: any[]) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(fn)
    return this
  }
  removeListener(event: string, fn: (...args: any[]) => void) {
    this.handlers.get(event)?.delete(fn)
    return this
  }
  emit(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.forEach((fn) => fn(...args))
  }
  listenerCount(event: string) {
    return this.handlers.get(event)?.size ?? 0
  }
}

export interface FakeEvmOptions {
  accounts?: string[]
  chainId?: number
  /** 钱包里已添加的链 */
  chains?: number[]
  /** 已授权（eth_accounts 返回账户） */
  authorized?: boolean
  flags?: Record<string, boolean>
}

/** 假的 EIP-1193 钱包 */
export class FakeEvmProvider extends Emitter {
  accounts: string[]
  chainId: number
  chains: Set<number>
  authorized: boolean
  calls: Array<{ method: string; params?: unknown }> = []
  /** 下一次请求抛这个错误 */
  failNext: unknown = null
  /** eth_requestAccounts 等它完成后才返回（模拟用户还没在钱包里确认） */
  gate: Promise<unknown> | null = null

  constructor(options: FakeEvmOptions = {}) {
    super()
    this.accounts = options.accounts ?? ['0xAbC0000000000000000000000000000000000001']
    this.chainId = options.chainId ?? 1
    this.chains = new Set(options.chains ?? [1, 56])
    this.authorized = options.authorized ?? false
    Object.assign(this, options.flags ?? {})
  }

  async request({ method, params }: { method: string; params?: any }): Promise<unknown> {
    this.calls.push({ method, params })
    if (this.failNext) {
      const err = this.failNext
      this.failNext = null
      throw err
    }
    switch (method) {
      case 'eth_requestAccounts':
        if (this.gate) await this.gate
        this.authorized = true
        return this.accounts
      case 'eth_accounts':
        return this.authorized ? this.accounts : []
      case 'eth_chainId':
        return `0x${this.chainId.toString(16)}`
      case 'personal_sign':
        return `sig(${params[0]},${params[1]})`
      case 'wallet_switchEthereumChain': {
        const id = Number.parseInt(params[0].chainId, 16)
        if (!this.chains.has(id)) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 })
        this.chainId = id
        this.emit('chainChanged', params[0].chainId)
        return null
      }
      case 'wallet_addEthereumChain':
        this.chains.add(Number.parseInt(params[0].chainId, 16))
        return null
      case 'wallet_revokePermissions':
        this.authorized = false
        return null
      default:
        throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 })
    }
  }
}

/** 让钱包通过 EIP-6963 公告自己（响应 requestProvider，并立即公告一次） */
export function announce(win: EventTarget, provider: FakeEvmProvider, info: { rdns: string; name: string; icon?: string; uuid?: string }) {
  const detail = { info: { uuid: info.uuid ?? info.rdns, name: info.name, icon: info.icon ?? `data:${info.name}`, rdns: info.rdns }, provider }
  const send = () => win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))
  win.addEventListener('eip6963:requestProvider', send)
  send()
}

/** 假的 Wallet Standard 钱包 */
export function fakeStandardWallet(options: { name: string; chain: string; address: string; features?: Record<string, unknown>; authorized?: boolean }) {
  const events = new Emitter()
  let authorized = options.authorized ?? false
  const account: StandardAccount = { address: options.address, chains: [options.chain], publicKey: new Uint8Array(32) }
  const connectCalls: Array<{ silent?: boolean } | undefined> = []
  const wallet = {
    version: '1.0.0',
    name: options.name,
    icon: `data:${options.name}`,
    chains: [options.chain],
    accounts: [] as StandardAccount[],
    features: {
      'standard:connect': {
        connect: async (input?: { silent?: boolean }) => {
          connectCalls.push(input)
          if (input?.silent && !authorized) return { accounts: [] }
          authorized = true
          wallet.accounts = [account]
          return { accounts: [account] }
        },
      },
      'standard:disconnect': {
        disconnect: async () => {
          authorized = false
          wallet.accounts = []
        },
      },
      'standard:events': {
        on: (event: string, fn: (props: unknown) => void) => {
          events.on(event, fn)
          return () => events.removeListener(event, fn)
        },
      },
      ...options.features,
    } as Record<string, unknown>,
  }
  return {
    wallet,
    events,
    connectCalls,
    setAccount(address: string | null) {
      wallet.accounts = address ? [{ ...account, address }] : []
      events.emit('change', { accounts: wallet.accounts })
    },
  }
}

/**
 * 钱包注册（钱包那一侧，与 @wallet-standard/wallet 的 registerWallet 相同）：派发 register-wallet 事件，
 * 同时监听 app-ready（应用晚于钱包加载时，由应用派发后再注册）
 */
export function registerStandardWallet(win: EventTarget, wallet: unknown) {
  const callback = (api: { register(w: unknown): void }) => api.register(wallet)
  win.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: callback }))
  win.addEventListener('wallet-standard:app-ready', (event) => callback((event as CustomEvent).detail))
}

/** 假的 WalletConnect EthereumProvider 模块 */
export function fakeWalletConnect(options: { session?: boolean; accounts?: string[]; chainId?: number; uri?: string; hang?: boolean; rejectWith?: unknown; gate?: Promise<unknown>; failInit?: number } = {}) {
  let failInit = options.failInit ?? 0
  const inits: Array<Record<string, unknown>> = []
  const provider = Object.assign(new Emitter(), {
    signer: {
      aborted: 0,
      abortPairingAttempt() {
        provider.signer.aborted++
      },
    },
    session: options.session ? {} : undefined,
    accounts: options.session ? (options.accounts ?? ['0xwc00000000000000000000000000000000000001']) : ([] as string[]),
    chainId: options.chainId ?? 1,
    disconnected: false,
    async enable() {
      // 与真实 provider 一样：已有会话时直接复用，不出二维码
      if (provider.session) return provider.accounts
      provider.emit('display_uri', options.uri ?? 'wc:abc@2?relay-protocol=irn&symKey=1')
      if (options.gate) await options.gate
      if (options.hang) return new Promise<string[]>(() => {})
      if (options.rejectWith) throw options.rejectWith
      provider.session = {}
      provider.accounts = options.accounts ?? ['0xwc00000000000000000000000000000000000001']
      return provider.accounts
    },
    async disconnect() {
      provider.disconnected = true
      provider.session = undefined
    },
    async request({ method, params }: { method: string; params?: any }) {
      if (method === 'personal_sign') return `wcsig(${params[0]})`
      if (method === 'wallet_switchEthereumChain') {
        provider.chainId = Number.parseInt(params[0].chainId, 16)
        return null
      }
      throw Object.assign(new Error('unsupported'), { code: 4200 })
    },
  })
  const module = {
    EthereumProvider: {
      init: async (opts: Record<string, unknown>) => {
        inits.push(opts)
        if (failInit > 0) {
          failInit--
          throw new Error('relay unreachable')
        }
        return provider
      },
    },
  }
  return { module, provider, inits, load: async () => module }
}

export const flush = () => new Promise((r) => setTimeout(r, 0))
