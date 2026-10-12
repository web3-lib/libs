import { WalletError } from '../core/errors.js'
import { exportOf } from '../core/module.js'
import type { ConnectOptions, Connector, SavedConnection, Session, WalletInfo } from '../core/types.js'

/** @tonconnect/sdk 的钱包信息（只用到这些） */
interface TonWalletInfo {
  name: string
  appName: string
  imageUrl: string
  aboutUrl?: string
  jsBridgeKey?: string
  injected?: boolean
  embedded?: boolean
  universalLink?: string
  bridgeUrl?: string
}

interface TonAccount {
  address: string
  chain: string
  publicKey?: string
}

interface TonConnected {
  account: TonAccount
  device?: { appName?: string }
}

/** @tonconnect/sdk 的 TonConnect 实例（只用到这些） */
export interface TonConnectLike {
  connected: boolean
  wallet: TonConnected | null
  getWallets(): Promise<TonWalletInfo[]>
  connect(source: { jsBridgeKey: string } | { universalLink: string; bridgeUrl: string }, options?: { signal?: AbortSignal }): string | void
  restoreConnection(): Promise<void>
  disconnect(): Promise<void>
  onStatusChange(callback: (wallet: TonConnected | null) => void, onError?: (err: unknown) => void): () => void
  sendTransaction(transaction: unknown): Promise<{ boc: string }>
  /** @tonconnect/sdk 3.2 起；钱包不支持时抛错 */
  signData?(data: { type: 'text'; text: string }): Promise<{ signature: string; address: string; timestamp: number; domain: string }>
  pauseConnection?(): void
}

export interface TonConnectorOptions {
  /** tonconnect-manifest.json 的地址（dapp 的名称、图标，钱包里显示） */
  manifestUrl: string
  /**
   * 加载 @tonconnect/sdk（由应用安装，按需加载）：`load: () => import('@tonconnect/sdk')`
   */
  load: () => Promise<unknown>
  /**
   * 连接手机钱包时回调连接链接（universal link）：应用把它画成二维码，移动端直接跳转。
   * 也可以在 connect 时传（connect(..., { onDisplayUri })，优先）；两处都没有时连接手机钱包抛 unsupported
   */
  onDisplayUri?: (uri: string, wallet: WalletInfo) => void
  /** 其他传给 new TonConnect() 的参数（如 storage） */
  options?: Record<string, unknown> & { storage?: { getItem(key: string): Promise<string | null> | string | null } }
}

/**
 * TON 连接器：基于 @tonconnect/sdk（不带界面）。插件 / 内置浏览器注入的钱包直接连接；手机钱包通过 onDisplayUri 拿到链接扫码。
 * connection.address 是 user-friendly 的非 bounceable 地址（UQ… / 测试网 0Q…）；connection.provider 是 TonConnect 实例（sendTransaction）。
 * 注意 sendTransaction 的 validUntil 单位是秒。signMessage 用 TON Connect 的 signData（text，需要 SDK 3.2+），返回 base64 签名；钱包不支持时抛错。
 * 签名的内容还包括 address / timestamp / domain：后端要验签时，直接调用 connection.provider.signData() 拿到完整结果。
 * 一个 TonConnect 实例同时只能连一个钱包：连接新钱包时先断开原来的（即使之后新的连接被取消）
 */
export function ton(options: TonConnectorOptions): Connector {
  const listeners = new Set<() => void>()
  let connector: Promise<TonConnectLike> | null = null
  /** 进行中的连接：新的连接开始时结束它（SDK 同一时间只处理一个连接请求，否则两个都会收到新钱包的连接结果） */
  let cancelPending: (() => void) | null = null
  let list: TonWalletInfo[] = []

  const notify = () => listeners.forEach((l) => l())

  /** TON Connect SDK 存会话用的 key（@tonconnect/sdk 2.x / 3.x 相同） */
  const sdkSessionStored = async () => {
    try {
      const storage = options.options?.storage ?? (globalThis as { localStorage?: { getItem(key: string): string | null } }).localStorage
      return Boolean(await storage?.getItem('ton-connect-storage_bridge-connection'))
    } catch {
      return false
    }
  }

  const instance = () => {
    connector ??= options.load().then(async (mod) => {
      const TonConnect = exportOf<new (opts: Record<string, unknown>) => TonConnectLike>(mod, 'TonConnect', true)
      if (typeof TonConnect !== 'function') throw new WalletError('unknown', 'ton({ load }) did not return @tonconnect/sdk')
      const created = new TonConnect({ manifestUrl: options.manifestUrl, ...options.options })
      created
        .getWallets()
        .then((wallets) => {
          list = wallets
          notify()
        })
        .catch(() => {})
      return created
    })
    connector.catch(() => (connector = null))
    return connector
  }

  const info = (w: TonWalletInfo): WalletInfo => ({
    id: w.appName,
    namespace: 'ton',
    name: w.name,
    icon: w.imageUrl ?? null,
    type: w.injected || w.embedded ? 'injected' : 'qrcode',
    // 注入的钱包、能扫码的远程钱包都能直接连接
    installed: Boolean(w.injected || w.embedded || (w.universalLink && w.bridgeUrl)),
    downloadUrl: w.aboutUrl ?? null,
  })

  const session = (tc: TonConnectLike, connected: TonConnected, walletId: string): Session => {
    const meta = list.find((w) => w.appName === walletId)
    return {
      walletId,
      walletName: meta?.name ?? walletId,
      icon: meta?.imageUrl ?? null,
      address: friendlyAddress(connected.account.address, connected.account.chain === '-3'),
      chainId: connected.account.chain,
      provider: tc,
      subscribe(handlers) {
        return tc.onStatusChange((wallet) => {
          if (!wallet) handlers.disconnect()
          else handlers.accounts([friendlyAddress(wallet.account.address, wallet.account.chain === '-3')])
        })
      },
      signMessage: async (message) => {
        if (!tc.signData) throw new WalletError('unsupported', 'signData needs @tonconnect/sdk 3.2 or later')
        return (await tc.signData({ type: 'text', text: message })).signature
      },
      disconnect: () => tc.disconnect(),
    }
  }

  return {
    namespace: 'ton',

    wallets() {
      // 钱包列表由 TON Connect 远程下发：第一次调用时开始加载，加载完通知（walletsChanged）
      // SSR 时不加载（不在服务端创建 TonConnect）
      if (typeof window !== 'undefined') void instance().catch(() => {})
      return list.map(info)
    },

    watchWallets(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    destroy() {
      listeners.clear()
      cancelPending?.()
      // 停掉 bridge 的连接（SSE），会话本身保留
      void connector?.then((tc) => tc.pauseConnection?.()).catch(() => {})
    },

    async connect(walletId, connectOptions: ConnectOptions) {
      const tc = await instance()
      if (!list.length) list = await tc.getWallets()
      const wallet = list.find((w) => w.appName === walletId)
      if (!wallet) throw new WalletError('not_installed', `Unknown TON wallet ${walletId}`)
      // 先确认能连（注入的钱包，或扫码钱包且有地方显示二维码），再断开原来的连接：连不了时不把用户登出
      const injected = Boolean((wallet.injected || wallet.embedded) && wallet.jsBridgeKey)
      const remote = Boolean(wallet.universalLink && wallet.bridgeUrl)
      const display = connectOptions.onDisplayUri ?? (options.onDisplayUri && ((uri: string) => options.onDisplayUri?.(uri, info(wallet))))
      if (!injected && !remote) throw new WalletError('not_installed', `${wallet.name} is not available in this browser`)
      if (!injected && !display) throw new WalletError('unsupported', 'Pass onDisplayUri (in ton() options or connect options) to connect mobile wallets by QR code')
      if (tc.connected) await tc.disconnect().catch(() => {})
      return new Promise<Session>((resolve, reject) => {
        const finish = (fn: () => void) => {
          unsubscribe()
          connectOptions.signal?.removeEventListener('abort', onAbort)
          if (cancelPending === cancel) cancelPending = null
          fn()
        }
        const cancel = () => finish(() => reject(new WalletError('superseded', 'Superseded by a newer connect() call')))
        cancelPending?.()
        cancelPending = cancel
        const unsubscribe = tc.onStatusChange(
          (connected) => connected && finish(() => resolve(session(tc, connected, walletId))),
          (err) => finish(() => reject(err)),
        )
        // signal 也传给 SDK：取消时它会结束这次连接请求（之后钱包再同意也不会连上）
        const onAbort = () => finish(() => reject(new WalletError('user_rejected', 'Connection cancelled')))
        if (connectOptions.signal?.aborted) return onAbort()
        connectOptions.signal?.addEventListener('abort', onAbort, { once: true })
        const sdkOptions = connectOptions.signal ? { signal: connectOptions.signal } : undefined
        try {
          if (injected) {
            tc.connect({ jsBridgeKey: wallet.jsBridgeKey as string }, sdkOptions)
          } else {
            const link = tc.connect({ universalLink: wallet.universalLink as string, bridgeUrl: wallet.bridgeUrl as string }, sdkOptions)
            if (typeof link === 'string') display?.(link)
          }
        } catch (err) {
          finish(() => reject(err))
        }
      })
    },

    async restore(saved: SavedConnection) {
      const tc = await instance()
      await tc.restoreConnection()
      if (!tc.connected || !tc.wallet) {
        // SDK 自己存的会话还在（只是网络 / bridge 连不上，SDK 12 秒后放弃等待）：抛错保留记录，下次再试。
        // 会话不在了（没存过、钱包那边断开、注入的钱包没了）SDK 会删掉它：确实不再授权
        if (await sdkSessionStored()) throw new WalletError('unknown', 'Could not reach the TON Connect bridge to restore the session')
        return null
      }
      if (!list.length) list = await tc.getWallets().catch(() => [])
      // 优先用存储的 id（钱包列表里的 appName）；device.appName 的大小写 / 写法不一定和列表一致
      const appName = tc.wallet.device?.appName?.toLowerCase()
      const walletId = list.some((w) => w.appName === saved.walletId)
        ? saved.walletId
        : (list.find((w) => w.appName.toLowerCase() === appName || w.name.toLowerCase() === appName)?.appName ?? saved.walletId)
      return session(tc, tc.wallet, walletId)
    },
  }
}

/** 原始地址（'0:hex'）转 user-friendly 地址：非 bounceable（钱包地址的推荐写法），base64url */
export function friendlyAddress(raw: string, testnet = false): string {
  const match = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(raw)
  if (!match) return raw // 已经是 user-friendly 写法
  const bytes = new Uint8Array(36)
  bytes[0] = 0x51 | (testnet ? 0x80 : 0) // 非 bounceable；测试网加 0x80
  bytes[1] = Number(match[1]) & 0xff
  for (let i = 0; i < 32; i++) bytes[2 + i] = Number.parseInt((match[2] as string).slice(i * 2, i * 2 + 2), 16)
  const crc = crc16(bytes.subarray(0, 34))
  bytes[34] = crc >> 8
  bytes[35] = crc & 0xff
  let binary = ''
  bytes.forEach((b) => (binary += String.fromCharCode(b)))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_')
}

/** CRC16-CCITT（XMODEM），TON 地址校验和 */
function crc16(data: Uint8Array): number {
  let crc = 0
  for (const byte of data) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}
