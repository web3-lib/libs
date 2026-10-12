import { WalletError } from './errors.js'
import type { ConnectOptions, Connection, Namespace, WalletOption } from './types.js'

/**
 * 按钱包合并的列表项：同一个插件在不同链上的条目合成一项（如 OKX 在 evm、solana、tron、sui 下各有一项 → 一个 OKX），
 * 用于“先选钱包，再选链”的界面
 */
export interface WalletGroup {
  /** 钱包的 id（由钱包名归一化而来，如 'okx'、'metamask'、'phantom'） */
  id: string
  name: string
  icon: string | null
  /** 有一条链上是注入的就是 'injected'；全是扫码的为 'qrcode' */
  type: 'injected' | 'qrcode'
  /** 至少有一条链上能直接连接 */
  installed: boolean
  /** 至少有一条链上已连接 */
  connected: boolean
  downloadUrl: string | null
  /** 这个钱包出现在哪些链上（按 createWallet 里 connectors 的顺序） */
  chains: Namespace[]
  /** 能直接连接的链（installed 的） */
  installedChains: Namespace[]
  /** 每条链上的条目 */
  wallets: WalletOption[]
  /**
   * 连接这个钱包。传了 namespace 就连那条链；不传时：只有一条链能连就连它，否则连第一条能连的链。
   * 选链的界面应该先让用户在 installedChains 里选
   */
  connect(namespace?: Namespace, options?: ConnectOptions): Promise<Connection>
}

/** 名字不规则的钱包：归一化后的名字 → 钱包 id */
const ALIASES: Record<string, string> = {
  binanceweb3: 'binance',
  binancechain: 'binance',
  okxweb3: 'okx',
  bitkeep: 'bitget',
  tronlinkpro: 'tronlink',
}

/** 钱包名 → 钱包 id：小写、去掉空格和符号、去掉末尾的 wallet（'OKX Wallet' → 'okx'） */
export function walletKey(name: string): string {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  // 没有字母数字的名字（如中文名）：原样当 id
  if (!compact) return name
  const key = compact.endsWith('wallet') && compact.length > 6 ? compact.slice(0, -6) : compact
  return ALIASES[key] ?? key
}

/** 把按链的钱包列表合并成按钱包的列表：已连接的、已安装的在前，其余保持原来的顺序 */
export function groupWallets(list: readonly WalletOption[]): WalletGroup[] {
  const groups = new Map<string, WalletOption[]>()
  for (const item of list) {
    const key = walletKey(item.name)
    const members = groups.get(key)
    // 同一条链上同名的钱包（极少见）只取第一个
    if (members?.some((m) => m.namespace === item.namespace)) continue
    if (members) members.push(item)
    else groups.set(key, [item])
  }
  const result = [...groups].map(([id, members]): WalletGroup => {
    const installed = members.filter((m) => m.installed)
    const primary = installed[0] ?? members[0] as WalletOption
    return {
      id,
      name: primary.name,
      icon: primary.icon ?? members.find((m) => m.icon)?.icon ?? null,
      // 按能连的条目算（没装的插件不算“注入的”）
      type: (installed.length ? installed : members).some((m) => m.type === 'injected') ? 'injected' : 'qrcode',
      installed: installed.length > 0,
      connected: members.some((m) => m.connected),
      downloadUrl: members.find((m) => m.downloadUrl)?.downloadUrl ?? null,
      chains: members.map((m) => m.namespace),
      installedChains: installed.map((m) => m.namespace),
      wallets: members,
      connect(namespace, options) {
        const target = namespace ? members.find((m) => m.namespace === namespace) : primary
        if (!target) return Promise.reject(new WalletError('unsupported', `${primary.name} is not available on ${namespace}`))
        return target.connect(options)
      },
    }
  })
  const rank = (g: WalletGroup) => (g.connected ? 0 : g.installed ? 1 : 2)
  return result.map((g, i) => [g, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([g]) => g)
}
