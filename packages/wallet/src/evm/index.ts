import { WalletError, abortable, isUserRejected } from '../core/errors.js'
import { exportOf } from '../core/module.js'
import { hex, utf8 } from '../core/encoding.js'
import type { ChainId, ConnectOptions, Connector, SavedConnection, Session, SessionHandlers, WalletInfo } from '../core/types.js'

/** 共用的 WalletConnect EthereumProvider：按 load 函数、初始化参数 */
const sharedWalletConnect = new WeakMap<() => Promise<unknown>, Map<string, Promise<WcProvider>>>()

/** EIP-1193 provider（注入的钱包、WalletConnect 的 EthereumProvider） */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>
  on?(event: string, listener: (...args: any[]) => void): unknown
  removeListener?(event: string, listener: (...args: any[]) => void): unknown
}

/** 链的信息：钱包没有这条链时用来请求添加（wallet_addEthereumChain），WalletConnect 用 rpcUrls */
export interface EvmChain {
  id: number
  name: string
  rpcUrls: readonly string[]
  nativeCurrency: { name: string; symbol: string; decimals: number }
  blockExplorerUrls?: readonly string[]
  iconUrls?: readonly string[]
}

/** 内置的钱包元数据：id 为 EIP-6963 的 rdns；flag 为老的 window.ethereum 上标识这个钱包的字段 */
export interface KnownEvmWallet {
  id: string
  name: string
  downloadUrl: string
  flag?: string
  icon?: string
}

export interface WalletConnectOptions {
  /** WalletConnect Cloud（Reown）的 projectId */
  projectId: string
  /**
   * 加载 @walletconnect/ethereum-provider（由应用安装，按需加载）：
   * `load: () => import('@walletconnect/ethereum-provider')`
   */
  load: () => Promise<unknown>
  /** dapp 信息（钱包里显示）：{ name, description, url, icons } */
  metadata?: { name: string; description: string; url: string; icons: readonly string[] }
  /** 拿到连接用的 URI 时回调：应用自己画二维码 / 在移动端跳转钱包 */
  onDisplayUri?: (uri: string) => void
  /**
   * 用 WalletConnect 自带的二维码弹窗（@walletconnect/ethereum-provider 2.21 起需要安装 @reown/appkit，
   * 没装时初始化失败，连恢复会话也会失败）。默认 false：用 onDisplayUri 自己画
   */
  showQrModal?: boolean
  qrModalOptions?: Record<string, unknown>
  /** 钱包列表里显示的名称和图标 */
  name?: string
  icon?: string
  /** 其他传给 EthereumProvider.init 的参数 */
  options?: Record<string, unknown>
}

export interface EvmConnectorOptions {
  /** 支持的链：切链时钱包没有这条链就用这里的信息添加；WalletConnect 用它们做 optionalChains 和 rpcMap */
  chains?: readonly EvmChain[]
  /** 没检测到时也列出来的钱包（引导下载），默认见 DEFAULT_EVM_WALLETS；传 [] 不列 */
  known?: readonly KnownEvmWallet[]
  walletConnect?: WalletConnectOptions
  /** 列出只注入 window.ethereum、不支持 EIP-6963 的钱包（如部分移动端钱包的内置浏览器）。默认 true */
  legacyInjected?: boolean
  /** 恢复上次连接时等插件响应 EIP-6963 的最长时间（毫秒），默认 1500 */
  restoreTimeout?: number
}

export const DEFAULT_EVM_WALLETS: readonly KnownEvmWallet[] = [
  { id: 'io.metamask', name: 'MetaMask', downloadUrl: 'https://metamask.io/download', flag: 'isMetaMask' },
  { id: 'com.okex.wallet', name: 'OKX Wallet', downloadUrl: 'https://web3.okx.com/download', flag: 'isOkxWallet' },
  { id: 'com.bitget.web3', name: 'Bitget Wallet', downloadUrl: 'https://web3.bitget.com/wallet-download', flag: 'isBitKeep' },
  { id: 'com.binance.wallet', name: 'Binance Wallet', downloadUrl: 'https://www.binance.com/web3wallet', flag: 'isBinance' },
  { id: 'com.trustwallet.app', name: 'Trust Wallet', downloadUrl: 'https://trustwallet.com/download', flag: 'isTrust' },
  { id: 'com.coinbase.wallet', name: 'Coinbase Wallet', downloadUrl: 'https://www.coinbase.com/wallet/downloads', flag: 'isCoinbaseWallet' },
  { id: 'io.rabby', name: 'Rabby Wallet', downloadUrl: 'https://rabby.io', flag: 'isRabby' },
  { id: 'pro.tokenpocket', name: 'TokenPocket', downloadUrl: 'https://www.tokenpocket.pro/en/download/app', flag: 'isTokenPocket' },
]

/** 老写法里识别钱包的字段（很多钱包同时设置 isMetaMask，所以 isMetaMask 放最后） */
const LEGACY_FLAGS: ReadonlyArray<[string, string]> = [
  ['isOkxWallet', 'OKX Wallet'],
  ['isBitKeep', 'Bitget Wallet'],
  ['isBinance', 'Binance Wallet'],
  ['isTokenPocket', 'TokenPocket'],
  ['isTrust', 'Trust Wallet'],
  ['isTrustWallet', 'Trust Wallet'],
  ['isCoinbaseWallet', 'Coinbase Wallet'],
  ['isRabby', 'Rabby Wallet'],
  ['isSafePal', 'SafePal'],
  ['isImToken', 'imToken'],
  ['isPhantom', 'Phantom'],
  ['isMetaMask', 'MetaMask'],
]

interface Announced {
  info: { uuid: string; name: string; icon: string; rdns: string }
  provider: Eip1193Provider
}

/** WalletConnect 的 EthereumProvider（只用到这些） */
interface WcProvider extends Eip1193Provider {
  session?: unknown
  accounts: string[]
  chainId: number
  enable(): Promise<string[]>
  disconnect(): Promise<void>
}

const WALLETCONNECT = 'walletconnect'
const INJECTED = 'injected'

function chainIdOf(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value) {
    const n = value.startsWith('0x') ? Number.parseInt(value, 16) : Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** 钱包没有这条链时的各种报错：标准的 4902；MetaMask 移动端等包在 -32603 里 */
function isUnknownChain(err: unknown): boolean {
  const e = err as { code?: unknown; data?: { originalError?: { code?: unknown } }; message?: unknown } | null
  return e?.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized chain|not been added|unknown chain|chain .*not (found|supported)|4902/i.test(String(e?.message ?? ''))
}

/**
 * EVM 连接器：EIP-6963 发现的插件钱包（持续监听，晚注入的也能出现）、只注入 window.ethereum 的老钱包，以及 WalletConnect。
 *
 * ```ts
 * evm({
 *   chains: [{ id: 56, name: 'BNB Smart Chain', rpcUrls: ['https://bsc-dataseed.bnbchain.org'], nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 } }],
 *   walletConnect: { projectId, load: () => import('@walletconnect/ethereum-provider'), onDisplayUri: (uri) => showQr(uri) },
 * })
 * ```
 */
export function evm(options: EvmConnectorOptions = {}): Connector {
  const known = options.known ?? DEFAULT_EVM_WALLETS
  const chains = options.chains ?? []
  const announced = new Map<string, Announced>()
  const listeners = new Set<() => void>()
  let listening = false
  let destroyed = false
  let requesting = false

  const notify = () => listeners.forEach((l) => l())

  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<Announced>).detail
    if (!detail?.info || !detail.provider) return
    const id = detail.info.rdns || detail.info.uuid
    const previous = announced.get(id)
    announced.set(id, detail)
    if (!previous || previous.provider !== detail.provider) notify()
  }

  /** 开始监听 EIP-6963（第一次用到时；之后一直监听，晚注入的钱包也能收到；destroy 时移除） */
  const discover = () => {
    if (typeof window === 'undefined' || destroyed) return
    if (!listening) {
      listening = true
      window.addEventListener('eip6963:announceProvider', onAnnounce)
    }
    // 钱包在 requestProvider 里同步公告 → walletsChanged → 应用（watchWallets）又调 wallets() → 又 discover：防止重入
    if (requesting) return
    requesting = true
    try {
      window.dispatchEvent(new Event('eip6963:requestProvider'))
    } finally {
      requesting = false
    }
  }

  const legacy = (): Eip1193Provider | null => {
    if (options.legacyInjected === false || typeof window === 'undefined') return null
    const injected = (window as unknown as { ethereum?: Eip1193Provider }).ethereum
    if (!injected || typeof injected.request !== 'function') return null
    // 已经通过 EIP-6963 列出来的就不再重复列
    for (const item of announced.values()) if (item.provider === injected) return null
    return injected
  }

  const legacyName = (provider: Eip1193Provider | null) => {
    const flags = (provider ?? {}) as Record<string, unknown>
    return LEGACY_FLAGS.find(([flag]) => flags[flag] === true)?.[1] ?? 'Browser Wallet'
  }

  const providerOf = (walletId: string): Eip1193Provider | null => {
    if (walletId === INJECTED) {
      if (typeof window === 'undefined') return null
      const injected = (window as unknown as { ethereum?: Eip1193Provider }).ethereum
      return injected && typeof injected.request === 'function' ? injected : null
    }
    return announced.get(walletId)?.provider ?? null
  }

  const walletName = (walletId: string) =>
    walletId === WALLETCONNECT
      ? (options.walletConnect?.name ?? 'WalletConnect')
      : (announced.get(walletId)?.info.name ?? (walletId === INJECTED ? legacyName(providerOf(INJECTED)) : (known.find((k) => k.id === walletId)?.name ?? walletId)))

  const walletIcon = (walletId: string) =>
    walletId === WALLETCONNECT ? (options.walletConnect?.icon ?? null) : (announced.get(walletId)?.info.icon ?? known.find((k) => k.id === walletId)?.icon ?? null)

  // ---- 会话 ----

  const switchChainOn = async (provider: Eip1193Provider, chainId: ChainId): Promise<number> => {
    const id = chainIdOf(chainId)
    if (id === null) throw new WalletError('unsupported_chain', `Invalid EVM chain id: ${String(chainId)}`)
    const hexId = `0x${id.toString(16)}`
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] })
      return id
    } catch (err) {
      if (isUserRejected(err) || !isUnknownChain(err)) throw err
      const chain = chains.find((c) => c.id === id)
      if (!chain) throw new WalletError('unsupported_chain', `The wallet has not added chain ${id}; pass its info in evm({ chains })`, { cause: err })
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: hexId,
            chainName: chain.name,
            rpcUrls: chain.rpcUrls,
            nativeCurrency: chain.nativeCurrency,
            ...(chain.blockExplorerUrls ? { blockExplorerUrls: chain.blockExplorerUrls } : {}),
            ...(chain.iconUrls ? { iconUrls: chain.iconUrls } : {}),
          },
        ],
      })
      // 有的钱包添加后不会自动切过去
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] })
      return id
    }
  }

  const session = (walletId: string, provider: Eip1193Provider, address: string, chainId: number | null, end?: () => Promise<void>): Session => {
    let current = address
    return {
      walletId,
      walletName: walletName(walletId),
      icon: walletIcon(walletId),
      address,
      chainId,
      provider,
      subscribe(handlers: SessionHandlers) {
        const onAccounts = (accounts: unknown) => {
          const list = Array.isArray(accounts) ? (accounts as string[]) : []
          // 只是大小写不同（如 WalletConnect 给小写）时保留原来的写法，不算账户变化
          const next = list.map((a) => (sameAddress(a, current) ? current : a))
          if (next[0]) current = next[0]
          handlers.accounts(next)
        }
        const onChain = (value: unknown) => handlers.chain(chainIdOf(value))
        // 注入钱包的 disconnect 表示和链的连接断了（EIP-1193），不是用户断开：只有 WalletConnect 的会话结束才算断开
        const onDisconnect = () => handlers.disconnect()
        provider.on?.('accountsChanged', onAccounts)
        provider.on?.('chainChanged', onChain)
        if (end) provider.on?.('disconnect', onDisconnect)
        return () => {
          provider.removeListener?.('accountsChanged', onAccounts)
          provider.removeListener?.('chainChanged', onChain)
          if (end) provider.removeListener?.('disconnect', onDisconnect)
        }
      },
      async signMessage(message) {
        return (await provider.request({ method: 'personal_sign', params: [hex(utf8(message)), current] })) as string
      },
      switchChain: (target) => switchChainOn(provider, target),
      normalizeChainId: (target) => chainIdOf(target) ?? target,
      async disconnect() {
        if (end) {
          await end()
          return
        }
        // 支持 EIP-2255 的钱包（如 MetaMask）撤销授权，下次连接重新确认；不支持的忽略
        await provider.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => {})
      },
    }
  }

  // ---- WalletConnect ----

  let wcProvider: Promise<WcProvider> | null = null
  const walletConnectProvider = (): Promise<WcProvider> => {
    const wc = options.walletConnect
    if (!wc) return Promise.reject(new WalletError('unsupported', 'WalletConnect is not configured; pass evm({ walletConnect })'))
    if (wcProvider) return wcProvider
    const ids = chains.length ? chains.map((c) => c.id) : [1]
    const initOptions = {
      projectId: wc.projectId,
      optionalChains: ids,
      rpcMap: Object.fromEntries(chains.filter((c) => c.rpcUrls[0]).map((c) => [c.id, c.rpcUrls[0]])),
      showQrModal: wc.showQrModal ?? false,
      ...(wc.qrModalOptions ? { qrModalOptions: wc.qrModalOptions } : {}),
      ...(wc.metadata ? { metadata: wc.metadata } : {}),
      ...wc.options,
    }
    // 同一个 load 函数、同样的配置共用一个 EthereumProvider：重新 createWallet（如 destroy 后重建）时不重复初始化
    // （WalletConnect 的 Core 只该初始化一次，重复初始化会多开连接并告警）
    let byOptions = sharedWalletConnect.get(wc.load)
    if (!byOptions) sharedWalletConnect.set(wc.load, (byOptions = new Map()))
    const key = JSON.stringify(initOptions)
    const cache = byOptions
    let shared = cache.get(key)
    if (!shared) {
      shared = (async () => {
        const mod = await wc.load()
        const EthereumProvider = exportOf<{ init?(opts: Record<string, unknown>): Promise<WcProvider> }>(mod, 'EthereumProvider', true)
        if (!EthereumProvider?.init) throw new WalletError('unknown', 'walletConnect.load() did not return @walletconnect/ethereum-provider')
        return EthereumProvider.init(initOptions)
      })()
      cache.set(key, shared)
      shared.catch(() => cache.delete(key))
    }
    wcProvider = shared
    shared.catch(() => {
      if (wcProvider === shared) wcProvider = null
    })
    return shared
  }

  /** 进行中的 WalletConnect 连接：新的连接开始时结束它（provider 会丢弃之前的配对，旧的那次永远等不到结果） */
  let cancelPendingWc: (() => void) | null = null

  const connectWalletConnect = async (connectOptions: ConnectOptions): Promise<Session> => {
    const wc = options.walletConnect
    const display = connectOptions.onDisplayUri ?? wc?.onDisplayUri
    if (wc && !display && !wc.showQrModal) {
      // 既不自己画二维码、也不用自带弹窗：用户看不到二维码，连接会一直等着
      throw new WalletError('unsupported', 'Pass onDisplayUri (in walletConnect options or connect options) to show the QR code, or showQrModal: true with @reown/appkit installed')
    }
    const provider = await walletConnectProvider()
    const onUri = (uri: string) => display?.(uri)
    provider.on?.('display_uri', onUri)
    try {
      if (connectOptions.signal?.aborted) throw new WalletError('user_rejected', 'Connection cancelled')
      const enabling = provider.enable()
      // 取消后 enable 还会被 WalletConnect 拒绝：吞掉，避免未处理的 rejection
      enabling.catch(() => {})
      // 取消后用户仍可能扫码同意：会话一建立就断开，否则下次连接时 enable() 会直接复用这个“已取消”的会话。
      // （abortPairingAttempt 在 2.21 起是空操作，只对老版本有用）
      const abort = () => {
        ;(provider as WcProvider & { signer?: { abortPairingAttempt?(): void } }).signer?.abortPairingAttempt?.()
        // 开了 showQrModal 时，WalletConnect 自己的扫码窗口也关掉
        ;(provider as WcProvider & { modal?: { close?(): void } }).modal?.close?.()
        enabling.then(() => provider.disconnect().catch(() => {}), () => {})
      }
      cancelPendingWc?.()
      let cancel!: () => void
      const superseded = new Promise<never>((_, reject) => (cancel = () => reject(new WalletError('superseded', 'Superseded by a newer WalletConnect connection'))))
      superseded.catch(() => {})
      cancelPendingWc = cancel
      let accounts: string[]
      try {
        accounts = await Promise.race([connectOptions.signal ? abortable(enabling, connectOptions.signal, abort) : enabling, superseded])
      } finally {
        if (cancelPendingWc === cancel) cancelPendingWc = null
      }
      const address = accounts[0]
      if (!address) throw new WalletError('unknown', 'WalletConnect returned no account')
      return session(WALLETCONNECT, provider, address, chainIdOf(provider.chainId), () => provider.disconnect())
    } finally {
      provider.removeListener?.('display_uri', onUri)
    }
  }

  // ---- 连接器 ----

  return {
    namespace: 'evm',

    wallets(): WalletInfo[] {
      discover()
      const knownIndex = (id: string) => {
        const i = known.findIndex((k) => k.id === id)
        return i < 0 ? known.length : i
      }
      const installed = [...announced.entries()]
        .map(([id, item]): WalletInfo => ({
          id,
          namespace: 'evm',
          name: item.info.name,
          icon: item.info.icon || null,
          type: 'injected',
          installed: true,
          downloadUrl: known.find((k) => k.id === id)?.downloadUrl ?? null,
        }))
        .sort((a, b) => knownIndex(a.id) - knownIndex(b.id))
      const list = [...installed]
      const injected = legacy()
      if (injected) {
        const name = legacyName(injected)
        // 老写法注入的钱包和某个 EIP-6963 钱包是同一个（如同时支持两种写法）时不重复列
        if (!installed.some((w) => w.name === name)) {
          list.push({ id: INJECTED, namespace: 'evm', name, icon: known.find((k) => k.name === name)?.icon ?? null, type: 'injected', installed: true, downloadUrl: null })
        }
      }
      if (options.walletConnect) {
        list.push({ id: WALLETCONNECT, namespace: 'evm', name: walletName(WALLETCONNECT), icon: walletIcon(WALLETCONNECT), type: 'qrcode', installed: true, downloadUrl: null, ...(options.walletConnect.showQrModal ? { sdkModal: true } : {}) })
      }
      const names = new Set(list.map((w) => w.name))
      for (const k of known) {
        if (!announced.has(k.id) && !names.has(k.name)) {
          list.push({ id: k.id, namespace: 'evm', name: k.name, icon: k.icon ?? null, type: 'injected', installed: false, downloadUrl: k.downloadUrl })
        }
      }
      return list
    },

    watchWallets(listener) {
      discover()
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    destroy() {
      destroyed = true
      if (listening && typeof window !== 'undefined') window.removeEventListener('eip6963:announceProvider', onAnnounce)
      listening = false
      listeners.clear()
    },

    async connect(walletId, connectOptions) {
      if (walletId === WALLETCONNECT) return connectWalletConnect(connectOptions)
      discover()
      const provider = providerOf(walletId)
      if (!provider) throw new WalletError('not_installed', `${walletName(walletId)} is not installed`)
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
      const address = accounts[0]
      if (!address) throw new WalletError('unknown', `${walletName(walletId)} returned no account`)
      const chainId = chainIdOf(await provider.request({ method: 'eth_chainId' }))
      return session(walletId, provider, address, chainId)
    },

    async restore(saved: SavedConnection) {
      if (saved.walletId === WALLETCONNECT) {
        if (!options.walletConnect) return null
        const provider = await walletConnectProvider()
        // 会话还在（WalletConnect 自己持久化）才恢复；不弹二维码
        if (!provider.session || !provider.accounts[0]) return null
        const address = provider.accounts.find((a) => sameAddress(a, saved.address)) ?? (provider.accounts[0] as string)
        return session(WALLETCONNECT, provider, address, chainIdOf(provider.chainId), () => provider.disconnect())
      }
      discover()
      const provider = providerOf(saved.walletId) ?? (await waitForProvider(() => providerOf(saved.walletId), listeners, discover, options.restoreTimeout ?? 1500))
      // 等不到插件（可能只是注入得慢，也可能卸载了）：抛错保留记录，下次再试；钱包明确说没授权才删记录
      if (!provider) throw new WalletError('not_installed', `${walletName(saved.walletId)} was not detected`)
      // eth_accounts 不弹窗：钱包仍授权时返回账户，否则为空
      const accounts = ((await provider.request({ method: 'eth_accounts' })) as string[] | null) ?? []
      if (!accounts.length) return null
      const address = accounts.find((a) => sameAddress(a, saved.address)) ?? (accounts[0] as string)
      const chainId = chainIdOf(await provider.request({ method: 'eth_chainId' }))
      return session(saved.walletId, provider, address, chainId)
    },
  }
}

function waitForProvider(get: () => Eip1193Provider | null, listeners: Set<() => void>, discover: () => void, timeout: number): Promise<Eip1193Provider | null> {
  return new Promise((resolve) => {
    const check = () => {
      const provider = get()
      if (provider) done(provider)
    }
    const timer = setTimeout(() => done(null), timeout)
    listeners.add(check)
    discover()
    function done(provider: Eip1193Provider | null) {
      clearTimeout(timer)
      listeners.delete(check)
      resolve(provider)
    }
  })
}

