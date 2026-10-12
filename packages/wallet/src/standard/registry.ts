/**
 * Wallet Standard 的应用端注册协议（与 @wallet-standard/app 的 getWallets() 相同，不依赖它）：
 * 应用派发 'wallet-standard:app-ready'（detail 为 { register }），钱包派发 'wallet-standard:register-wallet'（detail 为回调）；
 * 两边谁先加载都能对上。也兼容老的 navigator.wallets 数组写法
 */

/** 只用到 Wallet Standard 钱包的这些字段 */
export interface StandardWallet {
  readonly name: string
  readonly icon: string
  readonly chains: readonly string[]
  readonly accounts: readonly StandardAccount[]
  readonly features: Readonly<Record<string, unknown>>
}

export interface StandardAccount {
  readonly address: string
  readonly publicKey?: Uint8Array
  readonly chains: readonly string[]
  readonly features?: readonly string[]
}

interface RegisterApi {
  register(...wallets: StandardWallet[]): () => void
}

interface Registry {
  wallets: Set<StandardWallet>
  listeners: Set<() => void>
}

const REGISTRY_KEY = Symbol.for('w3lib.walletStandardRegistry')

function registry(): Registry | null {
  if (typeof window === 'undefined') return null
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>
  let existing = holder[REGISTRY_KEY]
  if (existing) return existing
  const created: Registry = { wallets: new Set(), listeners: new Set() }
  holder[REGISTRY_KEY] = created
  existing = created

  const notify = () => created.listeners.forEach((listener) => listener())
  const api: RegisterApi = Object.freeze({
    register(...wallets: StandardWallet[]) {
      const added = wallets.filter((w) => !created.wallets.has(w))
      added.forEach((w) => created.wallets.add(w))
      if (added.length) notify()
      // 只注销这次新加的：已经注册过的（重复注册）不受这次注销影响
      return () => {
        let removed = false
        for (const w of added) removed = created.wallets.delete(w) || removed
        if (removed) notify()
      }
    },
  })

  const callback = (fn: unknown) => {
    try {
      if (typeof fn === 'function') fn(api)
    } catch {
      // 某个钱包的注册回调出错不影响其他钱包
    }
  }
  window.addEventListener('wallet-standard:register-wallet', (event) => callback((event as CustomEvent).detail))
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }))
  } catch {
    // 没有 CustomEvent（极老环境）：只能靠 navigator.wallets
  }
  // 老写法：钱包先把回调推进 navigator.wallets；之后的 push 直接回调
  const nav = (globalThis as { navigator?: { wallets?: unknown } }).navigator
  if (nav) {
    const queued = Array.isArray(nav.wallets) ? (nav.wallets as unknown[]) : []
    try {
      Object.defineProperty(nav, 'wallets', { value: Object.freeze({ push: (...fns: unknown[]) => fns.forEach(callback) }), configurable: true })
    } catch {
      // navigator.wallets 不可改：忽略
    }
    queued.forEach(callback)
  }
  return created
}

/** 当前注册的所有 Wallet Standard 钱包 */
export function standardWallets(): StandardWallet[] {
  return [...(registry()?.wallets ?? [])]
}

/** 钱包注册 / 注销时通知，返回取消订阅 */
export function watchStandardWallets(listener: () => void): () => void {
  const reg = registry()
  if (!reg) return () => {}
  reg.listeners.add(listener)
  return () => reg.listeners.delete(listener)
}

/** 测试用：清空注册表（下次调用时重新派发 app-ready） */
export function resetStandardRegistry(): void {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>
  delete holder[REGISTRY_KEY]
}
