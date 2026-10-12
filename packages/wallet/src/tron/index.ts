import { WalletError } from '../core/errors.js'
import { exportOf } from '../core/module.js'
import { isMobileBrowser } from '../core/mobile.js'
import type { ChainId, Connector, SavedConnection, Session, SessionHandlers, WalletInfo } from '../core/types.js'

/** 钱包注入的 tronWeb（只用到这些） */
export interface TronWeb {
  defaultAddress?: { base58?: string | false; hex?: string | false }
  fullNode?: { host?: string }
  trx: {
    sign(transaction: unknown): Promise<unknown>
    signMessageV2?(message: string): Promise<string>
    getBlockByNumber?(height: number): Promise<{ blockID?: string }>
  }
}

/** 钱包注入的 Tron provider：TIP-1193（window.tron、TIP-6963 公告的）或老的 window.tronLink 写法 */
interface TronProvider {
  ready?: boolean
  tronWeb?: TronWeb | false
  isTronLink?: boolean
  request(args: { method: string; params?: unknown }): Promise<unknown>
  on?(event: string, listener: (...args: any[]) => void): unknown
  removeListener?(event: string, listener: (...args: any[]) => void): unknown
}

/** @tronweb3/tronwallet-adapters 的 WalletConnectAdapter（只用到这些） */
export interface TronAdapter {
  name: string
  icon?: string
  address: string | null
  connect(options?: Record<string, unknown>): Promise<void>
  disconnect(): Promise<void>
  signMessage(message: string): Promise<string>
  signTransaction(transaction: unknown): Promise<unknown>
  network?(): Promise<{ networkType?: string; chainId?: string }>
  on(event: string, listener: (...args: any[]) => void): unknown
  off?(event: string, listener: (...args: any[]) => void): unknown
  removeListener?(event: string, listener: (...args: any[]) => void): unknown
}

/**
 * 注入的钱包：
 * - 'tip1193'：request({ method: 'eth_requestAccounts' }) 连接，provider.on('accountsChanged' / 'chainChanged')（新版 TronLink、TokenPocket）
 * - 'legacy'：request({ method: 'tron_requestAccounts' }) 返回 { code }，账户变化通过 window 的 message 事件通知（老版 TronLink、OKX、Bitget）
 * - 'inapp'：钱包 App 内置浏览器只注入了 tronWeb，打开页面时已经授权
 */
interface Found {
  protocol: 'tip1193' | 'legacy' | 'inapp'
  provider: TronProvider | null
  tronWeb(): TronWeb | null
}

interface TronWalletDef {
  id: string
  name: string
  downloadUrl: string
  find(win: Record<string, any>, announced: Map<string, Announced>): Found | null
}

interface Announced {
  info: { name: string; icon?: string; rdns?: string }
  provider: TronProvider
}

const webOf = (value: unknown): TronWeb | null => (value && typeof (value as TronWeb).trx?.sign === 'function' ? (value as TronWeb) : null)

const WALLETS: readonly TronWalletDef[] = [
  {
    id: 'tronlink',
    name: 'TronLink',
    downloadUrl: 'https://www.tronlink.org',
    find(w, announced) {
      // 与官方 adapter 一致：手机上（TronLink App 内置浏览器）只用 window.tronLink / window.tronWeb
      const mobile = isMobileBrowser()
      const tip6963 = mobile ? undefined : announced.get('TronLink')?.provider
      if (tip6963) return { protocol: 'tip1193', provider: tip6963, tronWeb: () => webOf(tip6963.tronWeb) }
      if (!mobile && w.tron?.isTronLink) return { protocol: 'tip1193', provider: w.tron, tronWeb: () => webOf(w.tron.tronWeb) }
      // Bitget、TokenPocket 也会注入 window.tronLink / window.tronWeb：那时不算 TronLink
      const other = w.isBitKeep || w.bitkeep || w.tokenpocket
      if (w.tronLink && !other) return { protocol: 'legacy', provider: w.tronLink, tronWeb: () => webOf(w.tronLink.tronWeb) ?? webOf(w.tronWeb) }
      if (mobile && webOf(w.tronWeb) && !other && !w.okxwallet) return { protocol: 'inapp', provider: null, tronWeb: () => webOf(w.tronWeb) }
      return null
    },
  },
  {
    id: 'okx',
    name: 'OKX Wallet',
    downloadUrl: 'https://web3.okx.com/download',
    find: (w) => (w.okxwallet?.tronLink ? { protocol: 'legacy', provider: w.okxwallet.tronLink, tronWeb: () => webOf(w.okxwallet.tronLink.tronWeb) ?? webOf(w.okxwallet.tronWeb) } : null),
  },
  {
    id: 'bitget',
    name: 'Bitget Wallet',
    downloadUrl: 'https://web3.bitget.com/wallet-download',
    find: (w) => {
      const tronLink = w.bitkeep?.tronLink
      if (!tronLink && !webOf(w.bitkeep?.tronWeb)) return null
      // 移动端 App 里打开时已经授权（不用请求），tronWeb 在 bitkeep.tronLink 上；电脑上在 bitkeep.tronWeb
      const mobile = isMobileBrowser()
      const tronWeb = () => (mobile ? (webOf(tronLink?.tronWeb) ?? webOf(w.bitkeep?.tronWeb)) : (webOf(w.bitkeep?.tronWeb) ?? webOf(tronLink?.tronWeb)))
      return { protocol: tronLink && !mobile ? 'legacy' : 'inapp', provider: tronLink ?? null, tronWeb }
    },
  },
  {
    id: 'tokenpocket',
    name: 'TokenPocket',
    downloadUrl: 'https://www.tokenpocket.pro/en/download/app',
    find(w, announced) {
      const provider = announced.get('TokenPocket')?.provider ?? w.tokenpocket?.tron
      // 手机上 tronWeb 在 window.tokenpocket.tronWeb（与官方 adapter 一致）
      if (provider) return { protocol: 'tip1193', provider, tronWeb: () => (isMobileBrowser() ? (webOf(w.tokenpocket?.tronWeb) ?? webOf(provider.tronWeb)) : (webOf(provider.tronWeb) ?? webOf(w.tokenpocket?.tronWeb))) }
      if (w.tokenpocket && webOf(w.tronWeb)) return { protocol: 'inapp', provider: null, tronWeb: () => webOf(w.tronWeb) }
      return null
    },
  },
]

/** 创世区块 id 的最后 8 位（TIP-1193 的 chainId）→ 网络 */
const NETWORKS: Record<string, string> = { '0x2b6653dc': 'mainnet', '0x94a9059e': 'shasta', '0xcd8690dc': 'nile' }

export interface TronConnectorOptions {
  /** 列出的钱包，默认 ['tronlink', 'okx', 'bitget', 'tokenpocket'] */
  wallets?: readonly string[]
  /** 钱包图标（TronLink、TokenPocket 通过 TIP-6963 自带图标；其他钱包没有内置图标，默认 null） */
  icons?: Readonly<Record<string, string>>
  /**
   * WalletConnect（扫码连手机钱包，用 adapter 自带的二维码弹窗）：传给 WalletConnectAdapter 的参数，如
   * { network: 'Mainnet', options: { projectId, metadata } }；需要同时传 load。
   * WalletConnectAdapter 不能静默恢复会话，刷新后需要重新扫码
   */
  walletConnect?: Record<string, unknown> & { name?: string; icon?: string }
  /**
   * 只在用 WalletConnect 时需要：加载 @tronweb3/tronwallet-adapters（由应用安装，按需加载）。
   * 插件钱包（TronLink、OKX、Bitget、TokenPocket）直接对接，不需要任何 SDK
   */
  load?: () => Promise<unknown>
  /** 刷新后恢复时，等插件注入 / 钱包就绪的最长时间（毫秒），默认 1500 */
  restoreTimeout?: number
}

const WALLETCONNECT = 'walletconnect'
const ANNOUNCE = 'TIP6963:announceProvider'
const REQUEST = 'TIP6963:requestProvider'

/**
 * Tron 连接器：TronLink、OKX、Bitget、TokenPocket 直接对接钱包注入的对象（不需要 SDK），WalletConnect 可选（需要 @tronweb3/tronwallet-adapters）。
 * connection.provider 是钱包注入的 tronWeb（WalletConnect 时是 adapter），都可以直接传给 @w3lib/evm-batch-call 的 Tron 写操作；
 * signMessage 用 tronWeb.trx.signMessageV2，返回 0x 签名
 */
export function tron(options: TronConnectorOptions = {}): Connector {
  const defs = (options.wallets ?? WALLETS.map((w) => w.id)).map((id) => WALLETS.find((w) => w.id === id)).filter((w): w is TronWalletDef => Boolean(w))
  const listeners = new Set<() => void>()
  /** TIP-6963 公告的钱包，按名字 */
  const announced = new Map<string, Announced>()
  let listening = false
  let destroyed = false
  let wcAdapter: Promise<TronAdapter> | null = null

  const notify = () => listeners.forEach((l) => l())
  const win = () => (typeof window === 'undefined' ? null : (window as unknown as Record<string, any>))

  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<Announced>).detail
    if (!detail?.info?.name || !detail.provider) return
    const previous = announced.get(detail.info.name)
    announced.set(detail.info.name, detail)
    if (previous?.provider !== detail.provider) notify()
  }

  /** 开始监听 TIP-6963（之后一直监听，晚注入的钱包也能收到）并请求公告 */
  let requesting = false
  const discover = () => {
    if (!win() || destroyed) return
    if (!listening) {
      listening = true
      window.addEventListener(ANNOUNCE, onAnnounce)
    }
    // 钱包同步公告 → walletsChanged → 应用又列钱包 → 又 discover：防止重入
    if (requesting) return
    requesting = true
    try {
      window.dispatchEvent(new Event(REQUEST))
    } finally {
      requesting = false
    }
  }

  const find = (def: TronWalletDef): Found | null => {
    const w = win()
    return w ? def.find(w, announced) : null
  }

  const iconOf = (def: TronWalletDef) => options.icons?.[def.id] ?? announced.get(def.name)?.info.icon ?? null

  /** 读当前账户（tronWeb.defaultAddress）。老写法的钱包 ready 为 false 时还没授权（与官方 adapter 一致） */
  const addressOf = (found: Found) => {
    if (found.protocol !== 'tip1193' && found.provider?.ready === false) return null
    const address = found.tronWeb()?.defaultAddress?.base58
    return typeof address === 'string' && address ? address : null
  }

  /** 当前网络：按创世区块（与 TIP-1193 的 chainId 相同），读不到时按节点地址猜；最多 3 秒 */
  const networkOf = async (tronWeb: TronWeb | null): Promise<string | null> => {
    if (!tronWeb) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), 3000)))
      const block = await Promise.race([tronWeb.trx.getBlockByNumber?.(0), timeout])
      const network = block?.blockID ? NETWORKS[`0x${block.blockID.slice(-8)}`] : undefined
      if (network) return network
    } catch {
      // 节点请求失败：按节点地址猜
    } finally {
      clearTimeout(timer)
    }
    const host = tronWeb.fullNode?.host ?? ''
    return /nile/i.test(host) ? 'nile' : /shasta/i.test(host) ? 'shasta' : /trongrid|tronstack/i.test(host) ? 'mainnet' : null
  }

  // ---- 注入钱包的会话 ----

  const session = async (def: TronWalletDef, found: Found, address: string): Promise<Session> => {
    const tronWeb = found.tronWeb()
    if (!tronWeb) throw new WalletError('unknown', `${def.name} did not provide tronWeb`)
    return {
      walletId: def.id,
      walletName: def.name,
      icon: iconOf(def),
      address,
      chainId: await networkOf(tronWeb),
      provider: tronWeb,
      subscribe(handlers: SessionHandlers) {
        let current: string | null = address
        const update = (next: string | null) => {
          if (next === current) return
          current = next
          handlers.accounts(next ? [next] : [])
        }
        /** 重新读一次当前账户（消息、定时检查用） */
        const recheck = () => {
          const next = addressOf(found)
          if (next) update(next)
          return next
        }
        const onChain = () => void networkOf(found.tronWeb()).then(handlers.chain)
        const offs: Array<() => void> = []
        const provider = found.provider
        if (found.protocol === 'tip1193' && provider?.on) {
          // 钱包给了账户数组就以它为准（空数组是断开 / 锁定）；没给时读 tronWeb 的当前账户（TronLink 的做法）
          const onAccounts = (accounts: unknown) => update(Array.isArray(accounts) ? (typeof accounts[0] === 'string' && accounts[0]) || null : addressOf(found))
          const onChainChanged = (data: unknown) => {
            const network = NETWORKS[(data as { chainId?: string } | null)?.chainId ?? '']
            if (network) handlers.chain(network as ChainId)
            else onChain()
          }
          provider.on('accountsChanged', onAccounts)
          provider.on('chainChanged', onChainChanged)
          offs.push(() => {
            provider.removeListener?.('accountsChanged', onAccounts)
            provider.removeListener?.('chainChanged', onChainChanged)
          })
        } else if (win()) {
          // 老写法：钱包通过 window.postMessage 通知（TronLink 协议），只信本页面发的。
          // 同一页面上可能装了好几个 Tron 钱包，它们发的消息长得一样：消息只当作“重新读一次”的信号，以这个钱包自己的 tronWeb 为准
          let timer: ReturnType<typeof setTimeout> | undefined
          const onMessage = (event: MessageEvent) => {
            if (event.origin && event.origin !== location.origin) return
            const action = (event.data as { message?: { action?: string } } | null)?.message?.action
            if (action === 'setNode') onChain()
            if (action !== 'accountsChanged' && action !== 'setAccount' && action !== 'connect' && action !== 'disconnect' && action !== 'setNode') return
            // tronWeb 可能稍后才更新：现在读一次，过一会儿再读一次；读不到地址才算断开
            const settle = () => {
              if (!recheck() && current !== null) update(null)
            }
            recheck()
            clearTimeout(timer)
            timer = setTimeout(settle, 300)
          }
          offs.push(() => clearTimeout(timer))
          window.addEventListener('message', onMessage)
          offs.push(() => window.removeEventListener('message', onMessage))
        }
        // 兜底：有的钱包不发事件（App 内置浏览器、锁定钱包时），定时看一眼当前账户。
        // 读不到地址可能只是钱包在重新挂 tronWeb（换网络时）：连续两次读不到才算断开；TIP-1193 钱包断开以它的事件为准
        let empty = 0
        const poll = setInterval(() => {
          if (recheck()) {
            empty = 0
            return
          }
          if (found.protocol === 'tip1193' || ++empty < 2) return
          update(null)
        }, 1500)
        offs.push(() => clearInterval(poll))
        return () => offs.forEach((off) => off())
      },
      async signMessage(message) {
        const web = found.tronWeb()
        if (!web?.trx.signMessageV2) throw new WalletError('unsupported', `${def.name} does not support signing messages`)
        return web.trx.signMessageV2(message)
      },
      // 注入的 Tron 钱包没有“撤销授权”的接口：只在本地断开
      disconnect: async () => notReadyCounter(def.id).reset(),
    }
  }

  /** 请求授权，返回地址 */
  const requestAccounts = async (def: TronWalletDef, found: Found): Promise<string | null> => {
    const provider = found.provider
    if (found.protocol === 'inapp' || !provider) return addressOf(found)
    if (found.protocol === 'tip1193') {
      const accounts = await provider.request({ method: 'eth_requestAccounts' })
      const address = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : null
      // tronWeb 可能晚一点才挂上：最多等 2 秒
      if (address && !found.tronWeb()) await waitFor(() => found.tronWeb(), 2000)
      return address ?? addressOf(found)
    }
    const res = (await provider.request({ method: 'tron_requestAccounts' })) as { code?: number; message?: string } | boolean | null | undefined
    if (!res) throw new WalletError('unknown', `${def.name} is locked or has no account`)
    const code = typeof res === 'object' ? res.code : 200
    if (code === 4000) throw new WalletError('pending_request', `A connection request is already pending in ${def.name}`)
    // Bitget 的“用户取消”是 40001
    if (code === 4001 || code === 40001) throw new WalletError('user_rejected', 'The user rejected the connection')
    if (code !== undefined && code !== 200) throw new WalletError('unknown', (typeof res === 'object' && res.message) || `${def.name} connection failed (${code})`)
    return addressOf(found) ?? (await waitFor(() => addressOf(found), 2000))
  }

  // ---- WalletConnect（SDK） ----

  const walletConnect = () => {
    const wc = options.walletConnect
    if (!wc) return Promise.reject(new WalletError('unsupported', `Unknown Tron wallet ${WALLETCONNECT}`))
    const load = options.load
    if (!load) return Promise.reject(new WalletError('unsupported', 'Tron WalletConnect needs tron({ load: () => import("@tronweb3/tronwallet-adapters") })'))
    wcAdapter ??= load().then((mod) => {
      const Adapter = exportOf<new (params: Record<string, unknown>) => TronAdapter>(mod, 'WalletConnectAdapter')
      if (typeof Adapter !== 'function') throw new WalletError('unknown', 'tron({ load }) did not return @tronweb3/tronwallet-adapters')
      const { name: _name, icon: _icon, ...params } = wc
      return new Adapter(params)
    })
    wcAdapter.catch(() => (wcAdapter = null))
    return wcAdapter
  }

  /** 配置里的网络（'Mainnet' / 'Nile' / 链 id）→ 'mainnet' / 'nile' */
  const configuredNetwork = (): string | null => {
    const network = options.walletConnect?.network
    if (typeof network !== 'string') return null
    return NETWORKS[network.toLowerCase()] ?? (['mainnet', 'shasta', 'nile'].includes(network.toLowerCase()) ? network.toLowerCase() : null)
  }

  /** WalletConnect 时的网络：adapter 能报告就用它的（新版本才有 network()），否则用配置里连的网络 */
  const adapterNetwork = async (adapter: TronAdapter) => {
    if (!adapter.network) return configuredNetwork()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), 3000)))
      const type = (await Promise.race([adapter.network(), timeout]))?.networkType
      return type && type !== 'Unknown' ? type.toLowerCase() : configuredNetwork()
    } catch {
      return configuredNetwork()
    } finally {
      clearTimeout(timer)
    }
  }

  const adapterSession = async (adapter: TronAdapter): Promise<Session> => ({
    walletId: WALLETCONNECT,
    walletName: options.walletConnect?.name ?? 'WalletConnect',
    icon: options.walletConnect?.icon ?? adapter.icon ?? null,
    address: adapter.address as string,
    chainId: await adapterNetwork(adapter),
    provider: adapter,
    subscribe(handlers) {
      const onAccounts = (next: unknown) => handlers.accounts(typeof next === 'string' && next ? [next] : [])
      const onChain = () => void adapterNetwork(adapter).then(handlers.chain)
      const onDisconnect = () => handlers.disconnect()
      adapter.on('accountsChanged', onAccounts)
      adapter.on('chainChanged', onChain)
      adapter.on('disconnect', onDisconnect)
      const off = (event: string, fn: (...args: any[]) => void) => (adapter.off ?? adapter.removeListener)?.call(adapter, event, fn)
      return () => {
        off('accountsChanged', onAccounts)
        off('chainChanged', onChain)
        off('disconnect', onDisconnect)
      }
    },
    signMessage: (message) => adapter.signMessage(message),
    disconnect: () => adapter.disconnect(),
  })

  return {
    namespace: 'tron',

    wallets(): WalletInfo[] {
      discover()
      const list = defs.map((def): WalletInfo => ({ id: def.id, namespace: 'tron', name: def.name, icon: iconOf(def), type: 'injected', installed: find(def) !== null, downloadUrl: def.downloadUrl }))
      list.sort((a, b) => Number(b.installed) - Number(a.installed))
      if (options.walletConnect) {
        list.push({ id: WALLETCONNECT, namespace: 'tron', name: options.walletConnect.name ?? 'WalletConnect', icon: options.walletConnect.icon ?? null, type: 'qrcode', installed: true, downloadUrl: null, sdkModal: true })
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
      if (listening && win()) window.removeEventListener(ANNOUNCE, onAnnounce)
      listening = false
      listeners.clear()
    },

    async connect(walletId) {
      if (walletId === WALLETCONNECT) {
        const adapter = await walletConnect()
        await adapter.connect()
        if (!adapter.address) throw new WalletError('unknown', 'WalletConnect returned no account')
        return adapterSession(adapter)
      }
      const def = defs.find((d) => d.id === walletId)
      if (!def) throw new WalletError('unsupported', `Unknown Tron wallet ${walletId}`)
      discover()
      const found = find(def)
      if (!found) throw new WalletError('not_installed', `${def.name} is not installed`)
      const address = await requestAccounts(def, found)
      if (!address) throw new WalletError('unknown', `${def.name} returned no account`)
      // 用户明确连上了：之前恢复时“没就绪”的计数清零
      notReadyCounter(def.id).reset()
      return session(def, found, address)
    },

    async restore(saved: SavedConnection) {
      // WalletConnectAdapter 不能静默恢复（只有 connect 弹出扫码）
      if (saved.walletId === WALLETCONNECT) return null
      const def = defs.find((d) => d.id === saved.walletId)
      if (!def) return null
      const timeout = options.restoreTimeout ?? 1500
      discover()
      const found = find(def) ?? (await waitFor(() => find(def), timeout))
      // 等不到插件注入（可能只是慢）：抛错保留记录，下次再试
      if (!found) throw new WalletError('not_installed', `${def.name} was not detected`)
      // 仍授权时钱包注入后就有地址（可能稍晚）；没有就是没授权 / 已锁定：不恢复（不请求授权，避免弹窗）
      const address = addressOf(found) ?? (await waitFor(() => addressOf(found), timeout))
      const misses = notReadyCounter(def.id)
      if (address) {
        misses.reset()
        return session(def, found, address)
      }
      // 老写法的钱包还没就绪（ready 为 false）：可能只是插件启动慢，也可能是撤销了授权 / 锁着，分不出来。
      // 先保留记录下次再试；连续 3 次打开页面都没就绪就当作不再授权，删掉记录（不让每次打开页面都多等）
      if (found.protocol !== 'tip1193' && found.provider?.ready === false && misses.increment() < 3) throw new WalletError('unknown', `${def.name} is not ready`)
      misses.reset()
      return null
    },
  }
}

/** 刷新后恢复时钱包连续几次没就绪（存在 localStorage，不可用时只在内存里） */
const memoryMisses = new Map<string, number>()
function notReadyCounter(walletId: string) {
  const key = `w3lib:wallet:tron-not-ready:${walletId}`
  const storage = (() => {
    try {
      const s = (globalThis as { localStorage?: Storage }).localStorage
      return s && typeof s.getItem === 'function' ? s : null
    } catch {
      return null
    }
  })()
  const read = () => Number((storage ? storage.getItem(key) : memoryMisses.get(key)) ?? 0) || 0
  const write = (value: number | null) => {
    try {
      if (storage) value === null ? storage.removeItem(key) : storage.setItem(key, String(value))
      else value === null ? memoryMisses.delete(key) : memoryMisses.set(key, value)
    } catch {
      // 存储满了 / 不可用：不影响恢复
    }
  }
  return {
    increment: () => {
      const next = read() + 1
      write(next)
      return next
    },
    reset: () => write(null),
  }
}

/** 等到 get() 有值（每 100 毫秒看一次），最多 timeout 毫秒 */
function waitFor<T>(get: () => T | null, timeout: number): Promise<T | null> {
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const value = get()
      if (value !== null || Date.now() - started >= timeout) {
        clearInterval(timer)
        resolve(value)
      }
    }, 100)
  })
}
