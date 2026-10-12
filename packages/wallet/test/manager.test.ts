import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWallet, type Connector, type Namespace, type SavedConnection, type Session, type SessionHandlers, type WalletEvent } from '../src/index.js'
import { memoryStorage, stubWindow } from './fakes.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** 可控的会话：handlers 用来模拟钱包事件 */
function fakeSession(walletId: string, address: string, provider: unknown = {}) {
  const session: Session & { handlers: SessionHandlers | null; disconnected: number } = {
    walletId,
    walletName: walletId,
    icon: null,
    address,
    chainId: null,
    provider,
    handlers: null,
    disconnected: 0,
    subscribe(handlers) {
      session.handlers = handlers
      return () => (session.handlers = null)
    },
    signMessage: async (message) => `sig:${message}`,
    async disconnect() {
      session.disconnected++
    },
  }
  return session
}

/** 可控的连接器：restore / connect 的结果由测试决定 */
function fakeConnector(namespace: Namespace, handlers: { restore?: (saved: SavedConnection) => Promise<Session | null>; connect?: (walletId: string) => Promise<Session> } = {}) {
  const connector: Connector & { destroyed: number } = {
    namespace,
    destroyed: 0,
    wallets: () => [{ id: `${namespace}-wallet`, namespace, name: namespace, icon: null, type: 'injected', installed: true, downloadUrl: null }],
    watchWallets: () => () => {},
    connect: handlers.connect ?? (async (walletId) => fakeSession(walletId, `${namespace}-address`)),
    restore: handlers.restore ?? (async (saved) => fakeSession(saved.walletId, saved.address)),
    destroy() {
      connector.destroyed++
    },
  }
  return connector
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

function stored(active: Namespace | null, connections: Partial<Record<Namespace, SavedConnection>>) {
  return { 'w3lib:wallet': JSON.stringify({ v: 1, active, connections }) }
}

const savedOf = (storage: ReturnType<typeof memoryStorage>) => JSON.parse(storage.data.get('w3lib:wallet') ?? 'null')

const EVM = { walletId: 'evm-wallet', address: '0xabc', chainId: 1 }
const SOL = { walletId: 'sol-wallet', address: 'Sol111', chainId: 'solana:mainnet' }

describe('恢复', () => {
  it('恢复出错（节点 / 网络）：保留记录下次再试；钱包确实不再授权（null）：删掉记录', async () => {
    stubWindow()
    const storage = memoryStorage(stored('evm', { evm: EVM, solana: SOL }))
    const wallet = createWallet({
      connectors: [fakeConnector('evm', { restore: async () => Promise.reject(new Error('network down')) }), fakeConnector('solana', { restore: async () => null })],
      storage,
    })
    await wallet.restore()
    expect(wallet.getState()).toMatchObject({ status: 'ready', active: null, connections: {} })
    expect(savedOf(storage)).toEqual({ v: 1, active: 'evm', connections: { evm: EVM } })
  })

  it('一条链先恢复成功写存储：不会覆盖还在恢复 / 恢复出错的其他链的记录', async () => {
    stubWindow()
    const storage = memoryStorage(stored('solana', { evm: EVM, solana: SOL }))
    const solana = deferred<Session | null>()
    const wallet = createWallet({ mode: 'multi',
      connectors: [fakeConnector('evm'), fakeConnector('solana', { restore: () => solana.promise })],
      storage,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(wallet.getConnection('evm')).not.toBeNull()
    expect(Object.keys(savedOf(storage).connections).sort()).toEqual(['evm', 'solana'])
    solana.reject(new Error('rpc timeout'))
    await wallet.restore()
    // 上次的当前钱包没恢复：当前钱包先用已恢复的；solana 的记录保留，下次再试
    expect(wallet.getState().active).toBe('evm')
    expect(savedOf(storage)).toMatchObject({ active: 'evm', connections: { evm: { walletId: EVM.walletId }, solana: SOL } })
  })

  it('每条链单独超时：不被最慢的链拖住，超时后恢复成功的照样接上并设为当前钱包', async () => {
    vi.useFakeTimers()
    stubWindow()
    const storage = memoryStorage(stored('evm', { evm: EVM }))
    const slow = deferred<Session | null>()
    const wallet = createWallet({ connectors: [fakeConnector('evm', { restore: () => slow.promise })], storage, restoreTimeout: 100 })
    const events: WalletEvent[] = []
    wallet.subscribe((_, event) => events.push(event))
    const restoring = wallet.restore()
    await vi.advanceTimersByTimeAsync(100)
    await restoring
    expect(wallet.getState()).toMatchObject({ status: 'ready', active: null })
    expect(savedOf(storage).connections.evm).toEqual(EVM)
    slow.resolve(fakeSession(EVM.walletId, EVM.address))
    await vi.advanceTimersByTimeAsync(0)
    expect(wallet.getState().active).toBe('evm')
    expect(events.map((e) => e.type)).toEqual(['restored', 'connect', 'activeChanged'])
  })

  it('一条链很慢不拖住其他链：超时后 status 变成 ready，已恢复的照常可用', async () => {
    vi.useFakeTimers()
    stubWindow()
    const storage = memoryStorage(stored('solana', { evm: EVM, solana: SOL }))
    const wallet = createWallet({ mode: 'multi', connectors: [fakeConnector('evm'), fakeConnector('solana', { restore: () => new Promise(() => {}) })], storage, restoreTimeout: 100 })
    const restoring = wallet.restore()
    await vi.advanceTimersByTimeAsync(100)
    await restoring
    expect(wallet.getState()).toMatchObject({ status: 'ready', active: 'evm' })
    expect(Object.keys(wallet.getState().connections)).toEqual(['evm'])
  })

  it('超时后用户断开了这条链：晚到的恢复结果丢弃，不会把钱包连回来', async () => {
    vi.useFakeTimers()
    stubWindow()
    const storage = memoryStorage(stored('evm', { evm: EVM }))
    const slow = deferred<Session | null>()
    const wallet = createWallet({ connectors: [fakeConnector('evm', { restore: () => slow.promise })], storage, restoreTimeout: 100 })
    const restoring = wallet.restore()
    await vi.advanceTimersByTimeAsync(100)
    await restoring
    await wallet.disconnect('evm')
    expect(storage.data.size).toBe(0)
    slow.resolve(fakeSession(EVM.walletId, EVM.address))
    await vi.advanceTimersByTimeAsync(0)
    expect(wallet.getState()).toMatchObject({ connections: {}, active: null })
    expect(storage.data.size).toBe(0)
  })

  it('恢复期间用户自己连接了同一条链：以用户的为准，恢复的结果丢弃（不断开钱包）', async () => {
    stubWindow()
    const storage = memoryStorage(stored('evm', { evm: EVM }))
    const slow = deferred<Session | null>()
    const wallet = createWallet({ connectors: [fakeConnector('evm', { restore: () => slow.promise })], storage })
    await wallet.connect('evm', 'other-wallet')
    const restored = fakeSession(EVM.walletId, EVM.address)
    slow.resolve(restored)
    await wallet.restore()
    expect(wallet.getConnection('evm')?.walletId).toBe('other-wallet')
    expect(restored.disconnected).toBe(0)
    expect(savedOf(storage).connections).toEqual({ evm: { walletId: 'other-wallet', address: 'evm-address', chainId: null } })
  })

  it("'single'：恢复期间用户连了另一条链，恢复结果丢弃，不会同时连着两条链", async () => {
    stubWindow()
    const storage = memoryStorage(stored('evm', { evm: EVM }))
    const slow = deferred<Session | null>()
    const wallet = createWallet({ connectors: [fakeConnector('evm', { restore: () => slow.promise }), fakeConnector('solana')], storage, mode: 'single' })
    await wallet.connect('solana', 'sol-wallet')
    // 'single' 下连新钱包时，还没恢复完的其他链的记录也一起删掉
    expect(Object.keys(savedOf(storage).connections)).toEqual(['solana'])
    slow.resolve(fakeSession(EVM.walletId, EVM.address))
    await wallet.restore()
    expect(Object.keys(wallet.getState().connections)).toEqual(['solana'])
    expect(wallet.getState().active).toBe('solana')
    expect(Object.keys(savedOf(storage).connections)).toEqual(['solana'])
  })

  it('断开一条还没恢复完的链：删掉它的记录', async () => {
    stubWindow()
    const storage = memoryStorage(stored('evm', { evm: EVM, solana: SOL }))
    const slow = deferred<Session | null>()
    const wallet = createWallet({ mode: 'multi', connectors: [fakeConnector('evm', { restore: () => slow.promise }), fakeConnector('solana')], storage })
    await wallet.disconnect('evm')
    slow.resolve(null)
    await wallet.restore()
    expect(Object.keys(savedOf(storage).connections)).toEqual(['solana'])
  })

  it('没有配置这条链的连接器：忽略它的记录；多次调用 restore 共用一次', async () => {
    stubWindow()
    let calls = 0
    const wallet = createWallet({ mode: 'multi',
      connectors: [fakeConnector('evm', { restore: async (saved) => (calls++, fakeSession(saved.walletId, saved.address)) })],
      storage: memoryStorage(stored('ton', { evm: EVM, ton: { walletId: 'tonkeeper', address: 'UQ', chainId: '-239' } })),
    })
    expect(wallet.restore()).toBe(wallet.restore())
    await wallet.restore()
    expect(calls).toBe(1)
    expect(Object.keys(wallet.getState().connections)).toEqual(['evm'])
    expect(wallet.getState().active).toBe('evm')
  })
})

describe('并发连接', () => {
  it('替换旧钱包时先切换状态再等它断开：等待期间较新的连接照常替换，最终是最新的，没有空档', async () => {
    stubWindow()
    const slowDisconnect = deferred<void>()
    const a = fakeSession('a', 'addr-a', 'provider-a')
    a.disconnect = () => slowDisconnect.promise
    const c = deferred<Session>()
    const sessions: Record<string, () => Promise<Session>> = {
      a: async () => a,
      b: async () => fakeSession('b', 'addr-b', 'provider-b'),
      c: () => c.promise,
    }
    const wallet = createWallet({ connectors: [fakeConnector('evm', { connect: (id) => (sessions[id] as () => Promise<Session>)() })], storage: null, autoConnect: false })
    await wallet.connect('evm', 'a')
    const connectB = wallet.connect('evm', 'b')
    const connectC = wallet.connect('evm', 'c')
    await Promise.resolve()
    await Promise.resolve()
    // b 已生效（状态里已经是 b），正在等 a 断开
    expect(wallet.getConnection()?.walletId).toBe('b')
    const sessionC = fakeSession('c', 'addr-c', 'provider-c')
    c.resolve(sessionC)
    expect((await connectC).walletId).toBe('c')
    slowDisconnect.resolve()
    // b 生效过，调用方拿到的是它自己的连接
    expect((await connectB).walletId).toBe('b')
    expect(wallet.getConnection()?.walletId).toBe('c')
    expect(sessionC.handlers).not.toBeNull()
  })
})

describe('管理器', () => {
  it('默认存储用 localStorage；访问 localStorage 抛错（Safari 隐私模式）时不持久化', async () => {
    stubWindow()
    const local = memoryStorage()
    vi.stubGlobal('localStorage', local)
    const wallet = createWallet({ connectors: [fakeConnector('evm')], autoConnect: false })
    await wallet.connect('evm', 'evm-wallet')
    expect(local.data.has('w3lib:wallet')).toBe(true)

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      },
    })
    try {
      const noStorage = createWallet({ connectors: [fakeConnector('evm')], autoConnect: false })
      await noStorage.connect('evm', 'evm-wallet')
      expect(noStorage.getConnection()).not.toBeNull()
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage
    }
  })

  it('存储写入失败（满了）：不影响连接', async () => {
    stubWindow()
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {},
    }
    const wallet = createWallet({ connectors: [fakeConnector('evm')], storage, autoConnect: false })
    expect((await wallet.connect('evm', 'evm-wallet')).address).toBe('evm-address')
  })

  it('wallets() 不传命名空间时列出全部；disconnectAll 断开所有链', async () => {
    stubWindow()
    const storage = memoryStorage()
    const wallet = createWallet({ connectors: [fakeConnector('evm'), fakeConnector('solana')], storage, autoConnect: false })
    expect(wallet.wallets().map((w) => w.namespace)).toEqual(['evm', 'solana'])
    await wallet.connect('evm', 'a')
    await wallet.connect('solana', 'b')
    await wallet.disconnectAll()
    expect(wallet.getState()).toMatchObject({ connections: {}, active: null })
    expect(storage.data.size).toBe(0)
  })

  it('切链：不支持切链的链抛 unsupported；签名出错统一成 WalletError', async () => {
    stubWindow()
    const session = fakeSession('w', 'addr')
    session.signMessage = () => Promise.reject(Object.assign(new Error('User rejected'), { code: 4001 }))
    const wallet = createWallet({ connectors: [fakeConnector('solana', { connect: async () => session })], storage: null, autoConnect: false })
    await wallet.connect('solana', 'w')
    expect((await wallet.switchChain(1, 'solana').catch((e) => e)).code).toBe('unsupported')
    expect((await wallet.signMessage('x').catch((e) => e)).code).toBe('user_rejected')
    expect(() => wallet.setActive('evm')).toThrow('No evm wallet connected')
  })

  it('destroy：调用各连接器的 destroy，之后钱包事件不再更新状态；连接中途 destroy 时结果作废', async () => {
    stubWindow()
    const session = fakeSession('w', 'addr')
    const pending = deferred<Session>()
    const evm = fakeConnector('evm', { connect: async () => session })
    const sol = fakeConnector('solana', { connect: () => pending.promise })
    const storage = memoryStorage()
    const wallet = createWallet({ connectors: [evm, sol], storage, autoConnect: false })
    const events: WalletEvent[] = []
    wallet.subscribe((_, event) => events.push(event))
    await wallet.connect('evm', 'w')
    const connecting = wallet.connect('solana', 'x')
    wallet.destroy()
    expect([evm.destroyed, sol.destroyed]).toEqual([1, 1])
    expect(session.handlers).toBeNull()
    pending.resolve(fakeSession('x', 'sol'))
    expect((await connecting.catch((e) => e)).code).toBe('superseded')
    expect(events.map((e) => e.type)).toEqual(['connect', 'activeChanged'])
    expect(Object.keys(savedOf(storage).connections)).toEqual(['evm'])
    expect((await wallet.signMessage('x').catch((e) => e)).message).toContain('destroyed')
  })
})

describe('管理器的其他约定', () => {
  it('连接时切链失败：连接保留（状态、存储、当前钱包），抛出切链的错误', async () => {
    stubWindow()
    const session = fakeSession('w', 'addr')
    session.chainId = 1
    session.normalizeChainId = (id) => Number(id)
    session.switchChain = () => Promise.reject(Object.assign(new Error('User rejected'), { code: 4001 }))
    const storage = memoryStorage()
    const wallet = createWallet({ connectors: [fakeConnector('evm', { connect: async () => session })], storage, autoConnect: false })
    expect((await wallet.connect('evm', 'w', { chainId: 56 }).catch((e) => e)).code).toBe('user_rejected')
    expect(wallet.getState()).toMatchObject({ active: 'evm', connections: { evm: { walletId: 'w', chainId: 1 } } })
    expect(savedOf(storage).connections.evm.walletId).toBe('w')
  })

  it('非 EVM 的会话传 chainId：没有 normalizeChainId 时原样比较，相同就不切链', async () => {
    stubWindow()
    const session = fakeSession('w', 'addr')
    session.chainId = 'solana:mainnet'
    const wallet = createWallet({ connectors: [fakeConnector('solana', { connect: async () => session })], storage: null, autoConnect: false })
    expect((await wallet.connect('solana', 'w', { chainId: 'solana:mainnet' })).chainId).toBe('solana:mainnet')
  })

  it("'single'：新钱包被用户拒绝时，原来的连接和存储保持不变", async () => {
    stubWindow()
    const storage = memoryStorage()
    const wallet = createWallet({
      connectors: [fakeConnector('evm'), fakeConnector('solana', { connect: () => Promise.reject(Object.assign(new Error('User rejected'), { code: 4001 })) })],
      storage,
      mode: 'single',
      autoConnect: false,
    })
    await wallet.connect('evm', 'w')
    const before = storage.data.get('w3lib:wallet')
    expect((await wallet.connect('solana', 'x').catch((e) => e)).code).toBe('user_rejected')
    expect(Object.keys(wallet.getState().connections)).toEqual(['evm'])
    expect(storage.data.get('w3lib:wallet')).toBe(before)
  })

  it("'single'：等其他链断开期间又连了一个：最终只剩最新的", async () => {
    stubWindow()
    const slow = deferred<void>()
    const evmSession = fakeSession('e', 'addr-e', 'p-e')
    evmSession.disconnect = () => slow.promise
    const wallet = createWallet({ connectors: [fakeConnector('evm', { connect: async () => evmSession }), fakeConnector('solana', { connect: async (id) => fakeSession(id, `addr-${id}`, `p-${id}`) })], storage: null, mode: 'single', autoConnect: false })
    await wallet.connect('evm', 'e')
    const first = wallet.connect('solana', 'a').catch((e) => e)
    await Promise.resolve()
    await Promise.resolve()
    const second = wallet.connect('solana', 'b')
    slow.resolve()
    expect((await second).walletId).toBe('b')
    expect((await first).walletId).toBe('a')
    expect(wallet.getState().connections).toEqual({ solana: expect.objectContaining({ walletId: 'b' }) })
  })

  it('setActive：发 activeChanged；已经是当前的不重复发；getConnection 没有当前钱包时为 null', async () => {
    stubWindow()
    const wallet = createWallet({ mode: 'multi', connectors: [fakeConnector('evm'), fakeConnector('solana')], storage: null, autoConnect: false })
    expect(wallet.getConnection()).toBeNull()
    await wallet.connect('evm', 'a')
    await wallet.connect('solana', 'b')
    const events: WalletEvent[] = []
    wallet.subscribe((_, e) => events.push(e))
    wallet.setActive('evm')
    wallet.setActive('evm')
    expect(events).toEqual([{ type: 'activeChanged', active: 'evm' }])
    expect(wallet.getConnection()?.namespace).toBe('evm')
  })

  it('storageKey：读写都用它；存储里版本不对的记录忽略', async () => {
    stubWindow()
    const storage = memoryStorage({ custom: JSON.stringify({ v: 1, active: 'evm', connections: { evm: EVM } }), 'w3lib:wallet': JSON.stringify({ v: 1, active: 'evm', connections: { evm: { ...EVM, walletId: 'wrong' } } }) })
    const wallet = createWallet({ connectors: [fakeConnector('evm')], storage, storageKey: 'custom' })
    await wallet.restore()
    expect(wallet.getConnection()?.walletId).toBe(EVM.walletId)

    const old = memoryStorage({ 'w3lib:wallet': JSON.stringify({ v: 0, active: 'evm', connections: { evm: EVM } }) })
    const w2 = createWallet({ connectors: [fakeConnector('evm')], storage: old })
    await w2.restore()
    expect(w2.getState().connections).toEqual({})
  })

  it('没有存储 / 存储为空：恢复直接结束（restored 事件）；SSR（没有 window）时不自动恢复，状态直接是 ready', async () => {
    stubWindow()
    const wallet = createWallet({ connectors: [fakeConnector('evm')], storage: null })
    const events: string[] = []
    wallet.subscribe((_, e) => events.push(e.type))
    await wallet.restore()
    expect(events).toEqual(['restored'])

    vi.unstubAllGlobals()
    vi.stubGlobal('window', undefined)
    let restores = 0
    const ssr = createWallet({ connectors: [fakeConnector('evm', { restore: async () => (restores++, null) })], storage: memoryStorage(stored('evm', { evm: EVM })) })
    expect(ssr.getState().status).toBe('ready')
    await Promise.resolve()
    expect(restores).toBe(0)
  })

  it('恢复途中 destroy：之后不再发事件、不写存储', async () => {
    stubWindow()
    const storage = memoryStorage(stored('evm', { evm: EVM }))
    const slow = deferred<Session | null>()
    const wallet = createWallet({ connectors: [fakeConnector('evm', { restore: () => slow.promise })], storage })
    const events: string[] = []
    wallet.subscribe((_, e) => events.push(e.type))
    wallet.destroy()
    slow.resolve(fakeSession(EVM.walletId, EVM.address))
    await wallet.restore()
    expect(events).toEqual([])
    expect(wallet.getState().connections).toEqual({})
    expect(savedOf(storage).connections.evm).toEqual(EVM)
  })
})

describe('第三轮 review 的修复', () => {
  it('autoConnect: false 时手动 restore：同样进入 restoring，当前钱包用上次存的那条链', async () => {
    stubWindow()
    const storage = memoryStorage(stored('solana', { evm: EVM, solana: SOL }))
    const slowSolana = deferred<Session | null>()
    const wallet = createWallet({ connectors: [fakeConnector('evm'), fakeConnector('solana', { restore: () => slowSolana.promise })], storage, autoConnect: false })
    expect(wallet.getState().status).toBe('ready')
    const events: WalletEvent[] = []
    wallet.subscribe((_, e) => events.push(e))
    const restoring = wallet.restore()
    expect(wallet.getState().status).toBe('restoring')
    await Promise.resolve()
    await Promise.resolve()
    slowSolana.resolve(fakeSession(SOL.walletId, SOL.address))
    await restoring
    expect(wallet.getState()).toMatchObject({ status: 'ready', active: 'solana' })
    expect(events.filter((e) => e.type === 'activeChanged')).toEqual([{ type: 'activeChanged', active: 'solana' }])
  })

  it('这个页面没配置的链：存储里的记录原样保留', async () => {
    stubWindow()
    const ton = { walletId: 'tonkeeper', address: 'UQ', chainId: '-239' }
    const storage = memoryStorage(stored('evm', { evm: EVM, ton }))
    const wallet = createWallet({ mode: 'multi', connectors: [fakeConnector('evm')], storage })
    await wallet.restore()
    await wallet.connect('evm', 'other')
    expect(savedOf(storage).connections.ton).toEqual(ton)
    // 断开全部时一起清掉
    await wallet.disconnectAll()
    expect(storage.data.size).toBe(0)
  })

  it('全局 localStorage 存在但方法不可用（Node 25 没指定 --localstorage-file）：不持久化，不报错', async () => {
    stubWindow()
    vi.stubGlobal('localStorage', {})
    const wallet = createWallet({ connectors: [fakeConnector('evm')], autoConnect: false })
    expect((await wallet.connect('evm', 'w')).walletId).toBe('w')
  })

  it('所有连接器都支持取消：取消后连接器才返回，结果不生效', async () => {
    stubWindow()
    const pending = deferred<Session>()
    const wallet = createWallet({ connectors: [fakeConnector('solana', { connect: () => pending.promise })], storage: null, autoConnect: false })
    const controller = new AbortController()
    const connecting = wallet.connect('solana', 'w', { signal: controller.signal })
    controller.abort()
    expect((await connecting.catch((e) => e)).code).toBe('user_rejected')
    pending.resolve(fakeSession('w', 'addr'))
    await Promise.resolve()
    expect(wallet.getState().connections).toEqual({})
    let called = false
    const w2 = createWallet({ connectors: [fakeConnector('solana', { connect: async () => ((called = true), fakeSession('w', 'a')) })], storage: null, autoConnect: false })
    expect((await w2.connect('solana', 'w', { signal: AbortSignal.abort() }).catch((e) => e)).code).toBe('user_rejected')
    expect(called).toBe(false)
  })
})

describe('第四轮 review 的修复', () => {
  it("'single'：等旧钱包断开期间另一条链连上了：最后只剩一个钱包", async () => {
    stubWindow()
    const slow = deferred<void>()
    const tonSession = fakeSession('tk', 'UQ', 'p-ton')
    tonSession.disconnect = () => slow.promise
    const wallet = createWallet({
      connectors: [fakeConnector('ton', { connect: async () => tonSession }), fakeConnector('evm', { connect: async (id) => fakeSession(id, 'e', 'p-evm') }), fakeConnector('solana', { connect: async (id) => fakeSession(id, 's', 'p-sol') })],
      storage: null,
      mode: 'single',
      autoConnect: false,
    })
    await wallet.connect('ton', 'tk')
    const evm = wallet.connect('evm', 'mm')
    await Promise.resolve()
    await Promise.resolve()
    const sol = await wallet.connect('solana', 'ph')
    slow.resolve()
    await evm
    expect(sol.walletId).toBe('ph')
    expect(Object.keys(wallet.getState().connections)).toEqual(['solana'])
    expect(wallet.getState().active).toBe('solana')
  })

  it("'single'：先发起的另一条链连接晚于后发起的完成：作废，不会把后连上的断开", async () => {
    stubWindow()
    const slowEvm = deferred<Session>()
    const wallet = createWallet({ connectors: [fakeConnector('evm', { connect: () => slowEvm.promise }), fakeConnector('solana')], storage: null, mode: 'single', autoConnect: false })
    const evm = wallet.connect('evm', 'mm').catch((e) => e)
    await wallet.connect('solana', 'ph')
    slowEvm.resolve(fakeSession('mm', 'e'))
    expect((await evm).code).toBe('superseded')
    expect(Object.keys(wallet.getState().connections)).toEqual(['solana'])
  })

  it('非 EVM 的链传 chainId：忽略，不切链也不报错', async () => {
    stubWindow()
    const session = fakeSession('tl', 'T')
    session.chainId = 'nile'
    const wallet = createWallet({ connectors: [fakeConnector('tron', { connect: async () => session })], storage: null, autoConnect: false })
    expect((await wallet.connect('tron', 'tl', { chainId: 'mainnet' })).chainId).toBe('nile')
  })

  it('第三方连接器的 restore 同步抛错：当作出错，恢复照常结束并保留记录', async () => {
    stubWindow()
    const storage = memoryStorage(stored('evm', { evm: EVM }))
    const connector = fakeConnector('evm')
    connector.restore = () => {
      throw new Error('sync boom')
    }
    const wallet = createWallet({ connectors: [connector], storage })
    await wallet.restore()
    expect(wallet.getState().status).toBe('ready')
    expect(savedOf(storage).connections.evm).toEqual(EVM)
  })
})

describe('第七轮 review 的修复', () => {
  it('同一条链上换钱包也发旧钱包的 disconnect（replaced: true），在 connect 之前；同一个钱包重新连接不发', async () => {
    stubWindow()
    const wallet = createWallet({ connectors: [fakeConnector('evm', { connect: async (id) => fakeSession(id, `addr-${id}`, `p-${id}`) })], storage: null, autoConnect: false })
    await wallet.connect('evm', 'a')
    const events: WalletEvent[] = []
    wallet.subscribe((state, e) => events.push(e))
    await wallet.connect('evm', 'b')
    expect(events.slice(0, 2)).toEqual([
      { type: 'disconnect', namespace: 'evm', walletId: 'a', replaced: true },
      expect.objectContaining({ type: 'connect', namespace: 'evm' }),
    ])
    events.length = 0
    await wallet.connect('evm', 'b')
    expect(events.map((e) => e.type)).toEqual(['connect'])
  })

  it('连接时要切链，但等旧钱包断开期间被更新的连接替换了：作废，不给新钱包切链', async () => {
    stubWindow()
    const slow = deferred<void>()
    const a = fakeSession('a', 'addr-a', 'p-a')
    a.disconnect = () => slow.promise
    const switched: string[] = []
    const make = (id: string) => {
      const s = fakeSession(id, `addr-${id}`, `p-${id}`)
      s.chainId = 1
      s.switchChain = async (target) => (switched.push(`${id}:${String(target)}`), target)
      return s
    }
    const sessions: Record<string, () => Promise<Session>> = { a: async () => a, b: async () => make('b'), c: async () => make('c') }
    const wallet = createWallet({ connectors: [fakeConnector('evm', { connect: (id) => (sessions[id] as () => Promise<Session>)() })], storage: null, autoConnect: false })
    await wallet.connect('evm', 'a')
    const b = wallet.connect('evm', 'b', { chainId: 56 }).catch((e) => e)
    await Promise.resolve()
    await Promise.resolve()
    await wallet.connect('evm', 'c')
    slow.resolve()
    expect((await b).code).toBe('superseded')
    expect(switched).toEqual([])
    expect(wallet.getConnection()?.walletId).toBe('c')
  })
})
