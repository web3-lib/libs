/** 链的命名空间：每个命名空间（在 'multi' 模式下）可以同时连一个钱包 */
export type Namespace = 'evm' | 'solana' | 'tron' | 'sui' | 'ton'

/**
 * 可连接的钱包（用于渲染钱包列表）。
 * id 在同一个命名空间内唯一且稳定（EVM 用 EIP-6963 的 rdns，如 'io.metamask'；Wallet Standard 用钱包名；WalletConnect 为 'walletconnect'），
 * 同一个钱包在不同链上是不同的条目（如 OKX 在 evm 和 solana 下各有一个）
 */
export interface WalletInfo {
  id: string
  namespace: Namespace
  name: string
  /** 图标（data URI 或 URL）；没检测到、又没有内置元数据时为 null */
  icon: string | null
  /** 'injected'：浏览器插件 / 钱包内置浏览器注入的；'qrcode'：扫码连接（WalletConnect、TonConnect 的远程钱包） */
  type: 'injected' | 'qrcode'
  /** 当前浏览器里能直接连接（插件已安装，或扫码类总是 true） */
  installed: boolean
  /** 没安装时的下载页 */
  downloadUrl: string | null
  /**
   * 连接时由钱包的 SDK 自己弹出扫码窗口（Tron 的 WalletConnect、EVM 开了 showQrModal 的 WalletConnect），拿不到连接链接：
   * 自己画的弹窗应该先让开（自带弹窗会自动隐藏）
   */
  sdkModal?: boolean
}

/**
 * 链标识：
 * - evm：chainId 数字（如 56）
 * - solana / sui：Wallet Standard 的链标识（'solana:mainnet'、'sui:mainnet' 等）
 * - tron：'mainnet' / 'shasta' / 'nile'（钱包报告不了时为 null）
 * - ton：'-239'（主网）/ '-3'（测试网）
 */
export type ChainId = number | string

/** 一个已连接的钱包 */
export interface Connection {
  namespace: Namespace
  walletId: string
  walletName: string
  icon: string | null
  address: string
  chainId: ChainId | null
  /**
   * 钱包对象，用来签名、发交易：
   * - evm：EIP-1193 provider（`new BrowserProvider(provider)` 后 getSigner()，或直接 request）
   * - solana / sui：Wallet Standard 钱包（可以直接传给 @w3lib/solana-batch-call 的写操作）
   * - tron：钱包注入的 tronWeb（WalletConnect 时是 @tronweb3/tronwallet-adapters 的 adapter），都可以直接传给 @w3lib/evm-batch-call 的 Tron 写操作
   * - ton：@tonconnect/sdk 的 TonConnect 实例（sendTransaction）
   */
  provider: unknown
}

/**
 * wallet.wallets() 返回的钱包：在 WalletInfo 上加了连接状态和连接方法，直接用来渲染钱包列表、响应点击
 *
 * ```ts
 * for (const item of wallet.wallets('evm')) {
 *   button(item.name, item.icon, item.connected ? '已连接' : item.installed ? '' : '未安装', () => item.connect())
 * }
 * ```
 */
export interface WalletOption extends WalletInfo {
  /** 当前已连接（它所在的链连的就是这个钱包） */
  connected: boolean
  /** 连接这个钱包，等同于 wallet.connect(namespace, id, options) */
  connect(options?: ConnectOptions): Promise<Connection>
}

export interface WalletState {
  /** 当前钱包（active 那条链的连接），没有时为 null */
  connection: Connection | null
  /** 当前钱包的地址（connection.address），没有连接时为 null */
  address: string | null
  /** 每个命名空间当前连接的钱包（'single' 模式下最多一个） */
  connections: Partial<Record<Namespace, Connection>>
  /** 当前钱包所在的命名空间（最近一次连接 / setActive 的） */
  active: Namespace | null
  /** 'restoring'：正在恢复上次的连接（autoConnect）；之后为 'ready' */
  status: 'restoring' | 'ready'
}

/** 状态变化的原因 */
export type WalletEvent =
  | { type: 'connect'; namespace: Namespace; connection: Connection }
  /** replaced：被新连接的钱包替换掉了（这时 state 里已经是新钱包，用户并没有退出） */
  | { type: 'disconnect'; namespace: Namespace; walletId: string; replaced?: boolean }
  | { type: 'accountChanged'; namespace: Namespace; address: string }
  | { type: 'chainChanged'; namespace: Namespace; chainId: ChainId | null }
  | { type: 'activeChanged'; active: Namespace | null }
  | { type: 'restoring' }
  | { type: 'restored' }
  | { type: 'walletsChanged'; namespace: Namespace }

export interface ConnectOptions {
  /** 连接后切到这条链（只对 evm 有效，其他链忽略） */
  chainId?: ChainId
  /** 取消（不再等待钱包，如关闭扫码弹窗时）：以 user_rejected 结束，之后钱包里再同意也不会生效 */
  signal?: AbortSignal
  /**
   * 扫码连接（WalletConnect、TON 的手机钱包）时拿到连接链接：画成二维码，或在手机上直接跳转。
   * 优先于连接器配置里的 onDisplayUri；两个都没有时扫码类钱包连接会抛 unsupported
   */
  onDisplayUri?: (uri: string) => void
}

/** 连接器建立的会话：已连接钱包的操作 */
export interface Session {
  walletId: string
  walletName: string
  icon: string | null
  address: string
  chainId: ChainId | null
  provider: unknown
  /** 订阅钱包事件，返回取消订阅 */
  subscribe(handlers: SessionHandlers): () => void
  /** 签名一段文本（UTF-8），返回各链惯用的编码：evm / tron 为 0x 十六进制，solana 为 base58，sui 为 base64 */
  signMessage(message: string): Promise<string>
  /** 切换链（只有 evm 支持），返回规范化后的链标识 */
  switchChain?(chainId: ChainId): Promise<ChainId>
  /** 把调用方传入的链标识规范化（如 evm 的 '0x38' → 56），用于比较和存储 */
  normalizeChainId?(chainId: ChainId): ChainId
  /** 断开（钱包支持时通知钱包；扫码类会结束会话） */
  disconnect(): Promise<void>
}

export interface SessionHandlers {
  /** 账户变了（空数组表示钱包那边断开 / 锁定） */
  accounts(addresses: string[]): void
  chain(chainId: ChainId | null): void
  disconnect(): void
}

/** 持久化的连接（用于下次打开页面时恢复） */
export interface SavedConnection {
  walletId: string
  address: string
  chainId: ChainId | null
}

/** 一个链的连接器（由各子路径的工厂函数创建，如 evm()、solana()） */
export interface Connector {
  namespace: Namespace
  /** 当前可连接的钱包 */
  wallets(): WalletInfo[]
  /** 钱包列表变化时通知（如插件晚于页面注入、Wallet Standard 新注册），返回取消订阅 */
  watchWallets(listener: () => void): () => void
  /** 连接（会弹出钱包确认） */
  connect(walletId: string, options: ConnectOptions): Promise<Session>
  /**
   * 静默恢复上次的连接（不弹窗）。钱包确实不再授权 / 已卸载时返回 null（管理器会删掉存储的记录）；
   * 出错（节点、网络、超时）时抛出（保留记录，下次再试）
   */
  restore(saved: SavedConnection): Promise<Session | null>
  /** 管理器 destroy() 时调用：移除全局事件监听等 */
  destroy?(): void
}

/** 与 localStorage 兼容的存储（SSR 或不需要持久化时传 null） */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
