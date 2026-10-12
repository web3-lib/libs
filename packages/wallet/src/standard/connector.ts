import { WalletError, isUserRejected } from '../core/errors.js'
import type { Connector, Session, WalletInfo } from '../core/types.js'
import { standardWallets, watchStandardWallets, type StandardAccount, type StandardWallet } from './registry.js'

/** 内置的钱包元数据：没检测到时也列出来，引导下载 */
export interface KnownWallet {
  name: string
  downloadUrl: string
  icon?: string
}

export interface StandardConnectorConfig {
  namespace: 'solana' | 'sui'
  /** Wallet Standard 链标识，如 'solana:mainnet' */
  chain: string
  /** 钱包必须支持其中之一（能签交易） */
  transactionFeatures: readonly string[]
  known: readonly KnownWallet[]
  /** 列表里不显示的钱包名 */
  exclude?: readonly string[]
  /** 恢复连接时等钱包注册的最长时间（毫秒） */
  restoreTimeout: number
  signMessage(wallet: StandardWallet, account: StandardAccount, message: Uint8Array, chain: string): Promise<string>
}

interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StandardAccount[] }>
}
interface EventsFeature {
  on(event: 'change', listener: (properties: { accounts?: readonly StandardAccount[]; chains?: readonly string[] }) => void): () => void
}
interface DisconnectFeature {
  disconnect(): Promise<void>
}

/** Solana / Sui 共用的 Wallet Standard 连接器 */
export function standardConnector(config: StandardConnectorConfig): Connector {
  const { namespace, chain } = config

  const supported = (w: StandardWallet) =>
    w.chains.includes(chain) && 'standard:connect' in w.features && config.transactionFeatures.some((f) => f in w.features) && !config.exclude?.includes(w.name)

  const detected = () => standardWallets().filter(supported)
  const find = (walletId: string) => detected().find((w) => w.name === walletId)

  /** 这条链上的账户（钱包可能同时给出多条链的账户） */
  const accountOf = (accounts: readonly StandardAccount[]) => accounts.find((a) => a.chains.includes(chain)) ?? accounts[0]

  const session = (wallet: StandardWallet, account: StandardAccount): Session => {
    let current = account
    return {
      walletId: wallet.name,
      walletName: wallet.name,
      icon: wallet.icon,
      address: account.address,
      chainId: chain,
      provider: wallet,
      subscribe(handlers) {
        const events = wallet.features['standard:events'] as EventsFeature | undefined
        if (!events) return () => {}
        return events.on('change', (properties) => {
          if (!properties.accounts) return
          // 与 accountOf 一致：没有账户标明这条链时用钱包给的全部账户
          const matching = properties.accounts.filter((a) => a.chains.includes(chain))
          const next = matching.length ? matching : properties.accounts
          if (next[0]) current = next[0]
          handlers.accounts(next.map((a) => a.address))
        })
      },
      async signMessage(message) {
        if (!wallet.accounts.some((a) => a.address === current.address)) {
          current = accountOf(wallet.accounts) ?? current
        }
        return config.signMessage(wallet, current, new TextEncoder().encode(message), chain)
      },
      async disconnect() {
        await (wallet.features['standard:disconnect'] as DisconnectFeature | undefined)?.disconnect()
      },
    }
  }

  const connectWallet = async (wallet: StandardWallet, silent: boolean): Promise<Session | null> => {
    const { accounts } = await (wallet.features['standard:connect'] as ConnectFeature).connect(silent ? { silent: true } : undefined)
    const account = accountOf(accounts.length ? accounts : wallet.accounts)
    if (!account) {
      if (silent) return null
      throw new WalletError('unknown', `${wallet.name} did not return an account`)
    }
    return session(wallet, account)
  }

  return {
    namespace,

    wallets(): WalletInfo[] {
      const found = detected()
      const names = new Set(found.map((w) => w.name))
      const knownIndex = (name: string) => {
        const i = config.known.findIndex((k) => k.name === name)
        return i < 0 ? config.known.length : i
      }
      const installed = found
        .map((w): WalletInfo => ({
          id: w.name,
          namespace,
          name: w.name,
          icon: w.icon,
          type: 'injected',
          installed: true,
          downloadUrl: config.known.find((k) => k.name === w.name)?.downloadUrl ?? null,
        }))
        .sort((a, b) => knownIndex(a.name) - knownIndex(b.name))
      const missing = config.known
        .filter((k) => !names.has(k.name))
        .map((k): WalletInfo => ({ id: k.name, namespace, name: k.name, icon: k.icon ?? null, type: 'injected', installed: false, downloadUrl: k.downloadUrl }))
      return [...installed, ...missing]
    },

    watchWallets: watchStandardWallets,

    async connect(walletId) {
      const wallet = find(walletId)
      if (!wallet) throw new WalletError('not_installed', `${walletId} is not installed`)
      return (await connectWallet(wallet, false)) as Session
    },

    async restore(saved) {
      // 插件可能晚于页面初始化才注册：等一会儿
      const wallet = find(saved.walletId) ?? (await waitFor(() => find(saved.walletId), config.restoreTimeout))
      // 等不到钱包注册（可能只是加载得慢）：抛错保留记录，下次再试；silent 连接没有账户（不再授权）才删记录
      if (!wallet) throw new WalletError('not_installed', `${saved.walletId} was not detected`)
      try {
        return await connectWallet(wallet, true)
      } catch (err) {
        // 有的钱包（如 Phantom 的 onlyIfTrusted）在没授权时 silent 连接抛“用户拒绝”而不是返回空账户：同样是不再授权
        if (isUserRejected(err)) return null
        throw err
      }
    },
  }
}

/** 等到 get() 有结果（钱包注册时检查），最多 timeout 毫秒 */
function waitFor<T>(get: () => T | undefined, timeout: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeout)
    const unwatch = watchStandardWallets(() => {
      const value = get()
      if (value !== undefined) done(value)
    })
    function done(value?: T) {
      clearTimeout(timer)
      unwatch()
      resolve(value)
    }
  })
}
