import { WalletError, abortable, toWalletError } from './errors.js'
import { groupWallets, type WalletGroup } from './groups.js'
import type { ChainId, ConnectOptions, Connection, Connector, Namespace, SavedConnection, Session, StorageLike, WalletEvent, WalletInfo, WalletOption, WalletState } from './types.js'

export interface WalletConfig {
  /** 各条链的连接器：evm()、solana()、sui()、tron()、ton() */
  connectors: readonly Connector[]
  /**
   * - 'single'（默认）：同一时间只连一个钱包，新钱包连接成功后断开其他链的
   * - 'multi'：每条链（命名空间）可以同时连一个钱包，比如 EVM 用 MetaMask、Solana 用 Phantom；active 指向当前钱包
   */
  mode?: 'single' | 'multi'
  /** 持久化存储，默认 localStorage（不可用时不持久化）；传 null 不持久化 */
  storage?: StorageLike | null
  /** 存储的 key，默认 'w3lib:wallet' */
  storageKey?: string
  /** 创建后自动静默恢复上次的连接（不弹窗）。默认 true（只在浏览器里） */
  autoConnect?: boolean
  /**
   * 每条链恢复连接最多等多久（毫秒），默认 8000。超时后 status 照常变成 'ready'（不被最慢的那条链拖住），
   * 这条链的记录保留；之后恢复成功的照样接上（connect 事件）
   */
  restoreTimeout?: number
}

export interface WalletManager {
  /** 当前钱包的地址，没有连接时为 null（等于 getState().address） */
  readonly address: string | null
  /** 当前钱包的连接（地址、链、钱包名、图标、provider），没有连接时为 null（等于 getState().connection） */
  readonly connection: Connection | null
  /** 有没有连接钱包 */
  readonly connected: boolean
  /** 配置了的链（connectors 的顺序） */
  readonly namespaces: readonly Namespace[]
  /** 当前钱包所在的链（connection.chainId），没有连接时为 null */
  readonly chainId: ChainId | null
  /**
   * 刷新后自动恢复完成时 resolve（不会 reject）；没有要恢复的（SSR、autoConnect: false）时已经是 resolve 的。
   *
   * ```ts
   * await wallet.ready
   * if (!wallet.connected) showConnectButton()
   * ```
   */
  readonly ready: Promise<void>
  /** 当前状态（每次变化都是新对象，方便框架做响应式） */
  getState(): WalletState
  /** 订阅状态变化，返回取消订阅 */
  subscribe(listener: (state: WalletState, event: WalletEvent) => void): () => void
  /**
   * 只订阅某一种事件，返回取消订阅。
   *
   * ```ts
   * wallet.on('accountChanged', (event) => reload(event.address))
   * wallet.on('disconnect', (event, state) => !state.connected && logout())   // 换钱包时旧钱包也会发 disconnect（replaced: true）
   * ```
   */
  on<T extends WalletEvent['type']>(type: T, handler: (event: Extract<WalletEvent, { type: T }>, state: WalletState) => void): () => void
  /**
   * 可连接的钱包，每项带 connected 和 connect()，直接用来渲染钱包列表。
   * 按链过滤：传一条链（'evm'）或几条链（['evm', 'solana']），不传为全部配置了的链。
   * Tron / TON 的钱包列表在第一次调用时开始加载 SDK，加载完通过 walletsChanged 事件 / watchWallets 更新
   */
  wallets(chains?: Namespace | readonly Namespace[]): WalletOption[]
  /**
   * 监听钱包列表：立即用当前列表调用一次，之后列表变化（插件晚注入、SDK 加载完）或连接状态变化时再调用。返回取消监听。
   * chains 和 wallets() 一样按链过滤
   *
   * ```ts
   * const stop = wallet.watchWallets((list) => (wallets.value = list), 'evm')
   * ```
   */
  watchWallets(listener: (wallets: WalletOption[]) => void, chains?: Namespace | readonly Namespace[]): () => void
  /**
   * 按钱包合并的列表（“先选钱包，再选链”）：同一个插件在不同链上的条目合成一项，带它支持的链和 connect(namespace?)。
   * chains 和 wallets() 一样按链过滤
   */
  walletGroups(chains?: Namespace | readonly Namespace[]): WalletGroup[]
  /** 监听按钱包合并的列表，用法同 watchWallets */
  watchWalletGroups(listener: (groups: WalletGroup[]) => void, chains?: Namespace | readonly Namespace[]): () => void
  /** 某条链（默认当前钱包）连接的地址，没有连接时为 null */
  getAddress(namespace?: Namespace): string | null
  /**
   * 连接钱包（会弹出钱包确认）。可以传 wallets() 里的一项，或者命名空间 + 钱包 id。
   * 连接成功后：'single' 模式下断开其他链的钱包；同一命名空间已连接的钱包被替换。
   * 传了 chainId（evm）时连接后切链：切链失败时连接仍然保留，抛出切链的错误
   */
  connect(wallet: WalletInfo, options?: ConnectOptions): Promise<Connection>
  connect(namespace: Namespace, walletId: string, options?: ConnectOptions): Promise<Connection>
  /** 断开一个命名空间的钱包，默认当前钱包 */
  disconnect(namespace?: Namespace): Promise<void>
  disconnectAll(): Promise<void>
  /** 切换当前钱包（该命名空间必须已连接） */
  setActive(namespace: Namespace): void
  /** 某个命名空间（默认当前）的连接，未连接时为 null */
  getConnection(namespace?: Namespace): Connection | null
  /** 切换链（只有 evm 支持，默认作用于 evm 的钱包）。钱包没有这条链时，按 evm({ chains }) 里的信息请求添加 */
  switchChain(chainId: ChainId, namespace?: Namespace): Promise<void>
  /** 用某个命名空间（默认当前）的钱包签名一段文本 */
  signMessage(message: string, namespace?: Namespace): Promise<string>
  /** 静默恢复上次的连接；autoConnect 时创建后自动调用。多次调用共用同一次恢复 */
  restore(): Promise<void>
  /** 取消所有订阅、移除全局监听（不断开钱包）；之后不能再使用 */
  destroy(): void
}

interface StoredState {
  v: 1
  active: Namespace | null
  connections: Partial<Record<Namespace, SavedConnection>>
}

interface Live {
  session: Session
  connection: Connection
  unsubscribe: () => void
}

function defaultStorage(): StorageLike | null {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage
    // Node 25 起有全局 localStorage，但没指定 --localstorage-file 时方法不可用
    return storage && typeof storage.getItem === 'function' ? storage : null
  } catch {
    // Safari 隐私模式等访问 localStorage 会抛错
    return null
  }
}

/**
 * 创建钱包管理器。
 *
 * ```ts
 * const wallet = createWallet({ connectors: [evm({ chains }), solana(), tron({ load })] })
 * wallet.subscribe((state) => render(state))
 * wallet.wallets('evm')                          // 渲染钱包列表
 * await wallet.connect('evm', 'io.metamask', { chainId: 56 })
 * await wallet.signMessage('hello')
 * ```
 */
export function createWallet(config: WalletConfig): WalletManager {
  const mode = config.mode ?? 'single'
  const storage = config.storage === undefined ? defaultStorage() : config.storage
  const storageKey = config.storageKey ?? 'w3lib:wallet'
  const connectors = new Map<Namespace, Connector>()
  for (const connector of config.connectors) {
    if (connectors.has(connector.namespace)) {
      throw new WalletError('unsupported', `Duplicate connector for namespace ${connector.namespace}`)
    }
    connectors.set(connector.namespace, connector)
  }

  const live = new Map<Namespace, Live>()
  const listeners = new Set<(state: WalletState, event: WalletEvent) => void>()
  /**
   * 发起过的 connect 编号，以及最近生效的编号：较新的连接生效后，较早的结果作废；较新的失败不影响较早的。
   * 'multi' 下每个命名空间各自编号；'single' 下所有链共用一个编号（同一时间只能有一个钱包）
   */
  const attempts = new Map<string, number>()
  const committed = new Map<string, number>()
  /**
   * 存储里有、但现在没连上的记录：恢复还没完成，或者这次恢复出错 / 超时（下次刷新再试）。写存储时一起写回，不会因为别的链恢复成功被覆盖掉
   */
  const retained = new Map<Namespace, SavedConnection>()
  let retainedActive: Namespace | null = null
  let state: WalletState = { connection: null, address: null, connections: {}, active: null, status: config.autoConnect === false || !hasWindow() ? 'ready' : 'restoring' }
  let restoring: Promise<void> | null = null
  let destroyed = false

  const emit = (event: WalletEvent) => {
    for (const listener of [...listeners]) {
      try {
        listener(state, event)
      } catch {
        // 订阅者出错不影响其他订阅者和钱包状态
      }
    }
  }

  const persist = () => {
    if (!storage || destroyed) return
    const stored: StoredState = { v: 1, active: state.active, connections: {} }
    // 'single' 模式下已经连上了一个，保留的其他记录就不要了
    if (mode === 'multi' || live.size === 0) {
      for (const [namespace, saved] of retained) if (!live.has(namespace)) stored.connections[namespace] = saved
      if (!stored.active && retainedActive && stored.connections[retainedActive]) stored.active = retainedActive
    }
    for (const [namespace, item] of live) {
      stored.connections[namespace] = { walletId: item.connection.walletId, address: item.connection.address, chainId: item.connection.chainId }
    }
    try {
      if (Object.keys(stored.connections).length) storage.setItem(storageKey, JSON.stringify(stored))
      else storage.removeItem(storageKey)
    } catch {
      // 存储满了 / 不可用：不影响连接
    }
  }

  const readStored = (): StoredState | null => {
    if (!storage) return null
    try {
      const raw = storage.getItem(storageKey)
      const parsed = raw ? (JSON.parse(raw) as StoredState) : null
      return parsed?.v === 1 && parsed.connections && typeof parsed.connections === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  /** 更新状态、写存储，然后发事件（可以一次发几个：它们看到的都是更新后的状态） */
  const commit = (next: Partial<WalletState>, event: WalletEvent | readonly WalletEvent[]) => {
    if (destroyed) return
    const connections: WalletState['connections'] = {}
    for (const [namespace, item] of live) connections[namespace] = item.connection
    const active = next.active === undefined ? state.active : next.active
    const connection = (active && connections[active]) || null
    state = { ...state, ...next, connections, connection, address: connection?.address ?? null }
    persist()
    for (const e of Array.isArray(event) ? event : [event as WalletEvent]) emit(e)
  }

  /** 移除一个命名空间的连接（钱包那边断开，或主动断开） */
  const drop = (namespace: Namespace) => {
    const item = live.get(namespace)
    if (!item) return null
    item.unsubscribe()
    live.delete(namespace)
    const previous = state.active
    const active = previous === namespace ? ((live.keys().next().value as Namespace | undefined) ?? null) : previous
    commit({ active }, { type: 'disconnect', namespace, walletId: item.connection.walletId })
    if (active !== previous) emit({ type: 'activeChanged', active })
    return item
  }

  const attach = (namespace: Namespace, session: Session): Connection => {
    const connection: Connection = {
      namespace,
      walletId: session.walletId,
      walletName: session.walletName,
      icon: session.icon,
      address: session.address,
      chainId: session.chainId,
      provider: session.provider,
    }
    const item: Live = { session, connection, unsubscribe: () => {} }
    item.unsubscribe = session.subscribe({
      accounts: (addresses) => {
        if (live.get(namespace) !== item) return
        const address = addresses[0]
        if (!address) {
          drop(namespace)
          return
        }
        if (address === item.connection.address) return
        item.connection = { ...item.connection, address }
        commit({}, { type: 'accountChanged', namespace, address })
      },
      chain: (chainId) => {
        if (live.get(namespace) !== item || chainId === item.connection.chainId) return
        item.connection = { ...item.connection, chainId }
        commit({}, { type: 'chainChanged', namespace, chainId })
      },
      disconnect: () => {
        if (live.get(namespace) === item) drop(namespace)
      },
    })
    retained.delete(namespace)
    live.get(namespace)?.unsubscribe()
    live.set(namespace, item)
    return connection
  }

  const connectorOf = (namespace: Namespace): Connector => {
    const connector = connectors.get(namespace)
    if (!connector) throw new WalletError('unsupported', `No connector configured for ${namespace}`)
    return connector
  }

  const liveOf = (namespace?: Namespace): Live => {
    const target = namespace ?? state.active
    const item = target ? live.get(target) : undefined
    if (!item) throw new WalletError('not_connected', target ? `No ${target} wallet connected` : 'No wallet connected')
    return item
  }

  /** 过滤条件 → 命名空间列表（不传为全部配置了的；传了没配置的链时抛 unsupported） */
  const namespacesOf = (chains?: Namespace | readonly Namespace[]): Namespace[] => {
    if (chains === undefined) return [...connectors.keys()]
    const list = typeof chains === 'string' ? [chains] : [...new Set(chains)]
    list.forEach(connectorOf)
    return list
  }

  const assertAlive = () => {
    if (destroyed) throw new WalletError('unsupported', 'The wallet manager has been destroyed')
  }

  const disconnectNamespace = async (namespace: Namespace) => {
    if (retained.delete(namespace) && !live.has(namespace)) persist()
    const item = drop(namespace)
    if (item) {
      // 先更新状态再通知钱包：钱包的 disconnect 事件回来时已经不是当前连接，不会重复处理
      await item.session.disconnect().catch(() => {})
    }
  }

  const unwatch = [...connectors.values()].map((connector) => connector.watchWallets(() => emit({ type: 'walletsChanged', namespace: connector.namespace })))

  const connectTo = async (namespace: Namespace, walletId: string, options: ConnectOptions = {}): Promise<Connection> => {
    assertAlive()
    const connector = connectorOf(namespace)
    const key = mode === 'single' ? '*' : namespace
    const attempt = (attempts.get(key) ?? 0) + 1
    attempts.set(key, attempt)
    let session: Session
    try {
      // 所有连接器都支持取消：取消后钱包里再同意，结果也不会生效
      const { signal } = options
      if (signal?.aborted) throw new WalletError('user_rejected', 'Connection cancelled')
      session = await (signal ? abortable(connector.connect(walletId, options), signal) : connector.connect(walletId, options))
    } catch (err) {
      throw toWalletError(err, 'Failed to connect the wallet')
    }
    // 之后发起的连接已经生效：这次的结果作废。只在本地丢弃，不通知钱包断开——
    // 很可能是同一个钱包（连点两次），断开会把生效的那个连接一起断掉
    if (destroyed || attempt < (committed.get(key) ?? 0)) throw new WalletError('superseded', 'Superseded by a newer connect() call')
    committed.set(key, attempt)

    // 先一次性切换状态，再等旧钱包断开：中间没有 await，不会出现“没有连接”的中间状态（订阅者不会误以为退出了），
    // 也不会有别的连接插进来
    const ending: Session[] = []
    const dropped: Connection[] = []
    if (mode === 'single') {
      for (const other of new Set([...live.keys(), ...retained.keys()])) {
        if (other === namespace) continue
        retained.delete(other)
        const item = live.get(other)
        if (!item) continue
        item.unsubscribe()
        live.delete(other)
        dropped.push(item.connection)
        ending.push(item.session)
      }
    }
    const previous = live.get(namespace)
    // 换成了另一个钱包：断开原来的；同一个钱包对象（重新连接）不断开，否则会把新会话一起断掉
    if (previous && previous.session.provider !== session.provider) ending.push(previous.session)
    if (previous && previous.connection.walletId !== session.walletId) dropped.push(previous.connection)
    const connection = attach(namespace, session)
    const wasActive = state.active
    // 被替换的钱包也发 disconnect（replaced: true，不管是不是同一条链），都在 connect 之前；它们看到的已经是新状态
    const replaced: WalletEvent[] = dropped.map((old) => ({ type: 'disconnect', namespace: old.namespace, walletId: old.walletId, replaced: true }))
    commit({ active: namespace }, [...replaced, { type: 'connect', namespace, connection }])
    if (wasActive !== namespace) emit({ type: 'activeChanged', active: namespace })
    // 旧会话已经取消订阅，它们断开时发的事件不会影响状态
    await Promise.all(ending.map((old) => old.disconnect().catch(() => {})))
    // chainId 只对能切链的会话（evm）有效，其他链忽略
    if (options.chainId !== undefined && session.switchChain) {
      // 等旧钱包断开期间又有更新的连接替换了这次的：不能再切链（会切到新钱包上），这次作废
      if (live.get(namespace)?.session !== session) throw new WalletError('superseded', 'Superseded by a newer connect() call')
      const target = session.normalizeChainId?.(options.chainId) ?? options.chainId
      if (session.chainId !== target) await manager.switchChain(target, namespace)
    }
    return live.get(namespace)?.session === session ? (live.get(namespace) as Live).connection : connection
  }

  const manager: WalletManager = {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    get address() {
      return state.address
    },

    get connection() {
      return state.connection
    },

    get connected() {
      return state.connection !== null
    },

    get namespaces() {
      return [...connectors.keys()]
    },

    get chainId() {
      return state.connection?.chainId ?? null
    },

    get ready() {
      return restoring ?? Promise.resolve()
    },

    on(type, handler) {
      return manager.subscribe((state, event) => {
        if (event.type === type) handler(event as Extract<WalletEvent, { type: typeof type }>, state)
      })
    },

    wallets(chains) {
      const infos = namespacesOf(chains).flatMap((namespace) => connectorOf(namespace).wallets())
      return infos.map(
        (info): WalletOption => ({
          ...info,
          connected: live.get(info.namespace)?.connection.walletId === info.id,
          connect: (options) => connectTo(info.namespace, info.id, options),
        }),
      )
    },

    watchWallets(listener, chains) {
      const watched = namespacesOf(chains)
      // 先调用一次再订阅：首次调用抛错时不会留下订阅
      listener(manager.wallets(watched))
      return manager.subscribe((_, event) => {
        // 列表本身变了，或者连接状态（connected）变了
        if (event.type !== 'walletsChanged' && event.type !== 'connect' && event.type !== 'disconnect') return
        // 被替换的钱包的 disconnect 后面紧跟着新钱包的 connect，那时再刷新（同一条链上替换时 connect 也在这条链）
        if (event.type === 'disconnect' && event.replaced && watched.length === connectors.size) return
        if (!watched.includes(event.namespace)) return
        listener(manager.wallets(watched))
      })
    },

    walletGroups(chains) {
      return groupWallets(manager.wallets(chains))
    },

    watchWalletGroups(listener, chains) {
      return manager.watchWallets((list) => listener(groupWallets(list)), chains)
    },

    getAddress(namespace) {
      return manager.getConnection(namespace)?.address ?? null
    },

    connect(target: Namespace | WalletInfo, walletIdOrOptions?: string | ConnectOptions, options?: ConnectOptions) {
      if (typeof target === 'object') return connectTo(target.namespace, target.id, walletIdOrOptions as ConnectOptions | undefined)
      return connectTo(target, walletIdOrOptions as string, options)
    },

    disconnect: async (namespace) => {
      const target = namespace ?? state.active
      if (target) await disconnectNamespace(target)
    },

    async disconnectAll() {
      await Promise.all([...new Set([...live.keys(), ...retained.keys()])].map(disconnectNamespace))
    },

    setActive(namespace) {
      liveOf(namespace)
      if (state.active === namespace) return
      commit({ active: namespace }, { type: 'activeChanged', active: namespace })
    },

    getConnection(namespace) {
      const target = namespace ?? state.active
      return (target && live.get(target)?.connection) || null
    },

    async switchChain(chainId, namespace = 'evm') {
      assertAlive()
      const item = liveOf(namespace)
      if (!item.session.switchChain) throw new WalletError('unsupported', `Switching chains is not supported for ${namespace}`)
      let switched: ChainId
      try {
        switched = await item.session.switchChain(chainId)
      } catch (err) {
        throw toWalletError(err, 'Failed to switch the chain')
      }
      // 有的钱包切链后不发 chainChanged 事件：以请求成功为准
      if (live.get(namespace) === item && item.connection.chainId !== switched) {
        item.connection = { ...item.connection, chainId: switched }
        commit({}, { type: 'chainChanged', namespace, chainId: switched })
      }
    },

    async signMessage(message, namespace) {
      assertAlive()
      const item = liveOf(namespace)
      try {
        return await item.session.signMessage(message)
      } catch (err) {
        throw toWalletError(err, 'Failed to sign the message')
      }
    },

    restore() {
      restoring ??= (async () => {
        let finished = false
        const stored = readStored()
        const saved = Object.entries(stored?.connections ?? {}) as Array<[Namespace, SavedConnection]>
        // 这个页面没配置连接器的链：记录原样保留（其他页面可能配置了）
        for (const [namespace, item] of saved) if (!connectors.has(namespace)) retained.set(namespace, item)
        // 'single' 模式只恢复上次的当前钱包
        const targets = (mode === 'single' ? saved.filter(([namespace]) => namespace === stored?.active).slice(0, 1) : saved).filter(([namespace]) => connectors.has(namespace) && !live.has(namespace))
        // 恢复完成前先保留这些记录（其他链先恢复成功时写存储不会把它们覆盖掉）
        for (const [namespace, item] of targets) retained.set(namespace, item)
        retainedActive = stored?.active ?? null
        // autoConnect: false 时手动调用：同样进入 'restoring'（'restoring' 事件），'restored' 时变回 'ready'。
        // 要在读出、保留了存储的记录之后再提交（提交会写存储）
        if (state.status !== 'restoring') commit({ status: 'restoring' }, { type: 'restoring' })

        const timeout = config.restoreTimeout ?? 8000
        await Promise.all(
          targets.map(([namespace, item]) => {
            // 第三方连接器的 restore 可能同步抛错：也当作出错处理（保留记录），不让恢复卡在 'restoring'
            const connector = connectors.get(namespace) as Connector
            const task = Promise.resolve().then(() => connector.restore(item)).then(
              (session) => {
                if (!session) {
                  // 钱包确实不再授权：删掉记录
                  if (retained.delete(namespace)) persist()
                  return
                }
                // 期间用户自己连接了（这条链，或 'single' 模式下的任意链），或者断开了这条链（记录已删）：
                // 以用户的为准，只在本地丢弃（不断开钱包，可能是同一个）
                if (destroyed || !retained.has(namespace) || live.has(namespace) || (mode === 'single' && live.size > 0)) {
                  retained.delete(namespace)
                  return
                }
                const connection = attach(namespace, session)
                // 恢复已经结束（超时后才恢复成功）且没有当前钱包：设为当前钱包
                const late = finished && !state.active
                commit(late ? { active: namespace } : {}, { type: 'connect', namespace, connection })
                if (late) emit({ type: 'activeChanged', active: namespace })
              },
              () => {
                // 出错 / 超时：保留记录，下次刷新再试
              },
            )
            // 不被最慢的链拖住：超时后照常结束恢复，之后恢复成功的照样接上
            let timer: ReturnType<typeof setTimeout> | undefined
            return Promise.race([task, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeout)))]).finally(() => clearTimeout(timer))
          }),
        )
        // 用户在恢复期间连接过时以用户的为准；否则用上次的当前钱包
        finished = true
        const previous = state.active
        const active = previous ?? (stored?.active && live.has(stored.active) ? stored.active : ((live.keys().next().value as Namespace | undefined) ?? null))
        commit({ active, status: 'ready' }, { type: 'restored' })
        if (active !== previous) emit({ type: 'activeChanged', active })
      })()
      return restoring
    },

    destroy() {
      destroyed = true
      unwatch.forEach((fn) => fn())
      for (const item of live.values()) item.unsubscribe()
      for (const connector of connectors.values()) connector.destroy?.()
      listeners.clear()
    },
  }

  if (config.autoConnect !== false && hasWindow()) {
    void manager.restore()
  }
  return manager
}

function hasWindow(): boolean {
  return typeof window !== 'undefined'
}
