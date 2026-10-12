import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWallet } from '../src/index.js'
import { friendlyAddress, ton } from '../src/ton/index.js'
import { tron } from '../src/tron/index.js'
import { flush, memoryStorage, stubWindow } from './fakes.js'
import { WalletError, isUserRejected, toWalletError } from '../src/index.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ---- TON：假的 @tonconnect/sdk ----

const RAW = '0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8'
const FRIENDLY = 'UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI'

function tonModule(options: { restored?: boolean; deviceAppName?: string; signData?: boolean; wallets?: Array<Record<string, unknown>> } = {}) {
  const instances: FakeTonConnect[] = []
  class FakeTonConnect {
    connected = false
    wallet: { account: { address: string; chain: string }; device: { appName: string } } | null = null
    listeners = new Set<{ ok: (w: unknown) => void; err?: (e: unknown) => void }>()
    connects: unknown[] = []
    signals: Array<AbortSignal | undefined> = []
    paused = 0
    disconnects = 0
    signData = options.signData === false ? undefined : async (data: { type: string; text: string }) => ({ signature: `b64(${data.text})` })
    constructor(readonly opts: Record<string, unknown>) {
      instances.push(this)
    }
    async getWallets() {
      if (options.wallets) return options.wallets
      return [
        { name: 'Tonkeeper', appName: 'tonkeeper', imageUrl: 'data:tk', aboutUrl: 'https://tonkeeper.com', jsBridgeKey: 'tonkeeper', injected: true, embedded: false, universalLink: 'https://app.tonkeeper.com/ton-connect', bridgeUrl: 'https://bridge.tonapi.io/bridge' },
        { name: 'MyTonWallet', appName: 'mytonwallet', imageUrl: 'data:mtw', aboutUrl: 'https://mytonwallet.io', injected: false, embedded: false, universalLink: 'https://connect.mytonwallet.org', bridgeUrl: 'https://tonconnectbridge.mytonwallet.org/bridge' },
      ]
    }
    onStatusChange(ok: (w: unknown) => void, err?: (e: unknown) => void) {
      const entry = { ok, err }
      this.listeners.add(entry)
      return () => this.listeners.delete(entry)
    }
    emitStatus(wallet: FakeTonConnect['wallet']) {
      this.wallet = wallet
      this.connected = Boolean(wallet)
      this.listeners.forEach((l) => l.ok(wallet))
    }
    emitError(err: unknown) {
      this.listeners.forEach((l) => l.err?.(err))
    }
    connect(source: { jsBridgeKey?: string; universalLink?: string }, opts?: { signal?: AbortSignal }) {
      // 与真实 SDK 一样：已连接时不能再连接
      if (this.connected) throw new Error('[TON_CONNECT_SDK_ERROR] WalletAlreadyConnectedError')
      this.connects.push(source)
      this.signals.push(opts?.signal)
      if (source.jsBridgeKey) {
        setTimeout(() => this.emitStatus({ account: { address: RAW, chain: '-239' }, device: { appName: 'tonkeeper' } }), 1)
        return
      }
      return `${source.universalLink}?v=2&id=abc`
    }
    async restoreConnection() {
      if (options.restored) this.emitStatus({ account: { address: RAW, chain: '-239' }, device: { appName: options.deviceAppName ?? 'tonkeeper' } })
    }
    async disconnect() {
      // 与真实 SDK 一样：没连接时抛 WalletNotConnectedError
      if (!this.connected) throw new Error('[TON_CONNECT_SDK_ERROR] WalletNotConnectedError')
      this.disconnects++
      this.emitStatus(null)
    }
    pauseConnection() {
      this.paused++
    }
    async sendTransaction() {
      return { boc: '' }
    }
  }
  return { module: { TonConnect: FakeTonConnect }, instances }
}

describe('TON', () => {
  it('地址转换：原始地址 → 非 bounceable 的 user-friendly 地址（与 TON 文档的示例一致）', () => {
    expect(friendlyAddress(RAW)).toBe(FRIENDLY)
    expect(friendlyAddress(FRIENDLY)).toBe(FRIENDLY)
    expect(friendlyAddress(RAW, true).startsWith('0Q')).toBe(true)
  })

  it('钱包列表远程加载后通知；注入的钱包直接连接；手机钱包回调链接给应用画二维码', async () => {
    stubWindow()
    const { module, instances } = tonModule()
    const uris: string[] = []
    const wallet = createWallet({
      connectors: [ton({ manifestUrl: 'https://dapp.example/tonconnect-manifest.json', load: async () => module, onDisplayUri: (uri) => uris.push(uri) })],
      storage: null,
      autoConnect: false,
    })
    expect(wallet.wallets('ton')).toEqual([])
    await flush()
    await flush()
    expect(wallet.wallets('ton').map((w) => [w.id, w.type, w.installed])).toEqual([
      ['tonkeeper', 'injected', true],
      ['mytonwallet', 'qrcode', true],
    ])
    expect(instances[0]?.opts).toMatchObject({ manifestUrl: 'https://dapp.example/tonconnect-manifest.json' })

    const injected = await wallet.connect('ton', 'tonkeeper')
    expect(injected).toMatchObject({ walletName: 'Tonkeeper', address: FRIENDLY, chainId: '-239' })
    expect(await wallet.signMessage('x')).toBe('b64(x)')
    // 钱包里换了账户
    const other = '0:' + 'ab'.repeat(32)
    instances[0]!.emitStatus({ account: { address: other, chain: '-239' }, device: { appName: 'tonkeeper' } })
    expect(wallet.getConnection()?.address).toBe(friendlyAddress(other))

    const remote = wallet.connect('ton', 'mytonwallet')
    await flush()
    await flush()
    expect(uris).toEqual(['https://connect.mytonwallet.org?v=2&id=abc'])
    instances[0]!.emitStatus({ account: { address: RAW, chain: '-239' }, device: { appName: 'mytonwallet' } })
    expect((await remote).walletId).toBe('mytonwallet')

    // 钱包那边断开
    instances[0]!.emitStatus(null)
    expect(wallet.getState().connections).toEqual({})
  })

  it('用户在钱包里拒绝 / 关闭二维码（取消）：user_rejected', async () => {
    stubWindow()
    const { module, instances } = tonModule()
    const wallet = createWallet({ connectors: [ton({ manifestUrl: 'm', load: async () => module, onDisplayUri: () => {} })], storage: null, autoConnect: false })
    const rejected = wallet.connect('ton', 'mytonwallet')
    await flush()
    await flush()
    // 真实 SDK 的错误：name 是 Error，类型写在消息里
    instances[0]!.emitError(new Error('[TON_CONNECT_SDK_ERROR] UserRejectsError\nUser rejects the action in the wallet.'))
    expect((await rejected.catch((e) => e)).code).toBe('user_rejected')

    const controller = new AbortController()
    const cancelled = wallet.connect('ton', 'mytonwallet', { signal: controller.signal })
    await flush()
    await flush()
    controller.abort()
    expect((await cancelled.catch((e) => e)).code).toBe('user_rejected')
    // signal 交给 SDK：由它结束这次连接请求
    expect(instances[0]!.signals.at(-1)).toBe(controller.signal)
    expect(instances[0]!.listeners.size).toBe(0)

    // 已经取消的 signal：不发起连接
    const before = instances[0]!.connects.length
    expect((await wallet.connect('ton', 'mytonwallet', { signal: AbortSignal.abort() }).catch((e) => e)).code).toBe('user_rejected')
    expect(instances[0]!.connects.length).toBe(before)
    expect(isUserRejected(new WalletError('user_rejected', 'x'))).toBe(true)
  })

  it('不支持 signData 的 SDK 版本：signMessage 抛 unsupported；手机钱包没有 onDisplayUri：unsupported；未知钱包：not_installed', async () => {
    stubWindow()
    const { module } = tonModule({ signData: false })
    const wallet = createWallet({ connectors: [ton({ manifestUrl: 'm', load: async () => module })], storage: null, autoConnect: false })
    await wallet.connect('ton', 'tonkeeper')
    expect((await wallet.signMessage('x').catch((e) => e)).code).toBe('unsupported')
    expect((await wallet.connect('ton', 'mytonwallet').catch((e) => e)).code).toBe('unsupported')
    expect((await wallet.connect('ton', 'nope').catch((e) => e)).code).toBe('not_installed')
    expect((await createWallet({ connectors: [ton({ manifestUrl: 'm', load: async () => ({}) })], storage: null, autoConnect: false }).connect('ton', 'tonkeeper').catch((e) => e)).message).toContain('@tonconnect/sdk')
  })

  it('连接还没完成时又连接另一个钱包：前一个作废（superseded），不会被新钱包的结果当成自己的', async () => {
    stubWindow()
    const { module, instances } = tonModule()
    const wallet = createWallet({ connectors: [ton({ manifestUrl: 'm', load: async () => module, onDisplayUri: () => {} })], storage: null, autoConnect: false })
    const first = wallet.connect('ton', 'mytonwallet').catch((e) => e)
    await flush()
    await flush()
    const second = await wallet.connect('ton', 'tonkeeper')
    expect((await first).code).toBe('superseded')
    expect(second.walletId).toBe('tonkeeper')
    expect(wallet.getConnection()?.walletId).toBe('tonkeeper')
    // 只剩已连接会话的订阅
    expect(instances[0]!.listeners.size).toBe(1)
  })

  it('连接新钱包时先断开原来的 TON 连接', async () => {
    stubWindow()
    const { module, instances } = tonModule()
    const wallet = createWallet({ connectors: [ton({ manifestUrl: 'm', load: async () => module, onDisplayUri: () => {} })], storage: null, autoConnect: false })
    const events: string[] = []
    wallet.subscribe((_, e) => e.type !== 'walletsChanged' && events.push(e.type))
    await wallet.connect('ton', 'tonkeeper')
    const remote = wallet.connect('ton', 'mytonwallet')
    await flush()
    await flush()
    instances[0]!.emitStatus({ account: { address: RAW, chain: '-239' }, device: { appName: 'mytonwallet' } })
    expect((await remote).walletId).toBe('mytonwallet')
    expect(events).toEqual(['connect', 'activeChanged', 'disconnect', 'activeChanged', 'connect', 'activeChanged'])
  })

  it('恢复：TON Connect 自己的会话还在时恢复', async () => {
    const saved = { 'w3lib:wallet': JSON.stringify({ v: 1, active: 'ton', connections: { ton: { walletId: 'tonkeeper', address: FRIENDLY, chainId: '-239' } } }) }
    stubWindow()
    const { module } = tonModule({ restored: true })
    const wallet = createWallet({ connectors: [ton({ manifestUrl: 'm', load: async () => module })], storage: memoryStorage(saved) })
    await wallet.restore()
    expect(wallet.getConnection()).toMatchObject({ walletId: 'tonkeeper', walletName: 'Tonkeeper', address: FRIENDLY })
  })

  it('恢复：钱包报告的 appName 和列表写法不同（大小写）时，仍用列表里的 id', async () => {
    const saved = { 'w3lib:wallet': JSON.stringify({ v: 1, active: 'ton', connections: { ton: { walletId: 'old-id', address: FRIENDLY, chainId: '-239' } } }) }
    stubWindow()
    const { module } = tonModule({ restored: true, deviceAppName: 'Tonkeeper' })
    const wallet = createWallet({ connectors: [ton({ manifestUrl: 'm', load: async () => module })], storage: memoryStorage(saved) })
    await wallet.restore()
    expect(wallet.getConnection()).toMatchObject({ walletId: 'tonkeeper', walletName: 'Tonkeeper' })

    // TON Connect 的会话已经没了：不恢复
    stubWindow()
    const gone = tonModule({ restored: false })
    const w2 = createWallet({ connectors: [ton({ manifestUrl: 'm', load: async () => gone.module })], storage: memoryStorage(saved) })
    await w2.restore()
    expect(w2.getState().connections).toEqual({})
  })
})

describe('TON 的更多情况', () => {
  const saved = () => memoryStorage({ 'w3lib:wallet': JSON.stringify({ v: 1, active: 'ton', connections: { ton: { walletId: 'tonkeeper', address: FRIENDLY, chainId: '-239' } } }) })

  it('恢复：SDK 存的会话还在但 bridge 连不上：保留记录；会话不在了：删掉记录；options 传给 TonConnect', async () => {
    stubWindow()
    const sdkStorage = { getItem: async (key: string) => (key === 'ton-connect-storage_bridge-connection' ? '{"type":"http"}' : null) }
    const offline = tonModule({ restored: false })
    const storage = saved()
    const w1 = createWallet({ connectors: [ton({ manifestUrl: 'm', load: async () => offline.module, options: { storage: sdkStorage } })], storage })
    await w1.restore()
    expect(w1.getState().connections).toEqual({})
    expect(storage.data.size).toBe(1)
    expect(offline.instances[0]!.opts).toMatchObject({ manifestUrl: 'm', storage: sdkStorage })

    stubWindow()
    const gone = memoryStorage(Object.fromEntries(saved().data))
    const w2 = createWallet({ connectors: [ton({ manifestUrl: 'm', load: async () => tonModule().module, options: { storage: { getItem: async () => null } } })], storage: gone })
    await w2.restore()
    expect(gone.data.size).toBe(0)
  })

  it('主动断开：通知 TonConnect，清空状态；onDisplayUri 的第二个参数是钱包信息', async () => {
    stubWindow()
    const { module, instances } = tonModule()
    const seen: unknown[] = []
    const wallet = createWallet({ connectors: [ton({ manifestUrl: 'm', load: async () => module, onDisplayUri: (_, info) => seen.push(info) })], storage: null, autoConnect: false })
    const remote = wallet.connect('ton', 'mytonwallet')
    await flush()
    await flush()
    expect(seen).toEqual([{ id: 'mytonwallet', namespace: 'ton', name: 'MyTonWallet', icon: 'data:mtw', type: 'qrcode', installed: true, downloadUrl: 'https://mytonwallet.io' }])
    instances[0]!.emitStatus({ account: { address: RAW, chain: '-239' }, device: { appName: 'mytonwallet' } })
    await remote
    await wallet.disconnect('ton')
    expect(instances[0]!.disconnects).toBe(1)
    expect(wallet.getState().connections).toEqual({})
  })

  it('钱包既不能注入也没有扫码信息：not_installed；扫码钱包的链接可以在连接时传 onDisplayUri', async () => {
    stubWindow()
    const { module } = tonModule({ wallets: [{ name: 'Odd', appName: 'odd', imageUrl: 'data:odd' }, { name: 'Remote', appName: 'remote', imageUrl: 'data:r', universalLink: 'https://r.example', bridgeUrl: 'https://bridge.example' }] })
    const wallet = createWallet({ connectors: [ton({ manifestUrl: 'm', load: async () => module })], storage: null, autoConnect: false })
    // 列表还没加载时直接连接：先拉列表
    expect((await wallet.connect('ton', 'odd').catch((e) => e)).code).toBe('not_installed')
    expect(wallet.wallets('ton').map((w) => [w.id, w.installed, w.downloadUrl])).toEqual([
      ['odd', false, null],
      ['remote', true, null],
    ])
    // 配置和连接时都没有 onDisplayUri：unsupported
    expect((await wallet.connect('ton', 'remote').catch((e) => e)).code).toBe('unsupported')
    const uris: string[] = []
    void wallet.connect('ton', 'remote', { onDisplayUri: (uri) => uris.push(uri) }).catch(() => {})
    await flush()
    expect(uris).toEqual(['https://r.example?v=2&id=abc'])
  })

  it('destroy：停掉 bridge 连接（会话保留），结束进行中的连接', async () => {
    stubWindow()
    const { module, instances } = tonModule()
    const wallet = createWallet({ connectors: [ton({ manifestUrl: 'm', load: async () => module, onDisplayUri: () => {} })], storage: null, autoConnect: false })
    const pending = wallet.connect('ton', 'mytonwallet').catch((e) => e)
    await flush()
    await flush()
    wallet.destroy()
    expect((await pending).code).toBe('superseded')
    await flush()
    expect(instances[0]!.paused).toBe(1)
    expect(instances[0]!.listeners.size).toBe(0)
  })
})

describe('SSR', () => {
  it('没有 window 时列钱包不加载 TON 的 SDK，Tron 没有钱包', () => {
    vi.stubGlobal('window', undefined)
    let loads = 0
    const load = async () => (loads++, {})
    const wallet = createWallet({ connectors: [tron({ load }), ton({ manifestUrl: 'm', load })], storage: null })
    expect(wallet.wallets('tron').every((w) => !w.installed)).toBe(true)
    expect(wallet.wallets('ton')).toEqual([])
    expect(loads).toBe(0)
  })
})

describe('TON：连不了时不断开原来的连接', () => {
  it('已连着注入钱包，选了扫码钱包但没有 onDisplayUri：报 unsupported，原来的连接还在', async () => {
    stubWindow()
    const { module, instances } = tonModule()
    const wallet = createWallet({ connectors: [ton({ manifestUrl: 'm', load: async () => module })], storage: null, autoConnect: false })
    await wallet.connect('ton', 'tonkeeper')
    expect((await wallet.connect('ton', 'mytonwallet').catch((e) => e)).code).toBe('unsupported')
    expect(instances[0]!.disconnects).toBe(0)
    expect(wallet.getConnection('ton')?.walletId).toBe('tonkeeper')
  })
})

describe('TON：真实 SDK 的模块形状', () => {
  it('@tonconnect/sdk 的 default 就是 TonConnect 类（ESM）；CommonJS 互操作时导出在 default 上；只有 default 也行', async () => {
    for (const shape of ['esm', 'cjs', 'defaultOnly', 'class'] as const) {
      stubWindow()
      const { module, instances } = tonModule()
      // class：应用直接返回类本身（load: async () => (await import('@tonconnect/sdk')).default）
      const mod = shape === 'esm' ? { ...module, default: module.TonConnect } : shape === 'cjs' ? { default: module } : shape === 'defaultOnly' ? { default: module.TonConnect } : module.TonConnect
      const wallet = createWallet({ connectors: [ton({ manifestUrl: 'm', load: async () => mod })], storage: null, autoConnect: false })
      wallet.wallets('ton')
      await flush()
      await flush()
      expect(instances).toHaveLength(1)
      expect(wallet.wallets('ton').map((w) => w.id)).toEqual(['tonkeeper', 'mytonwallet'])
    }
  })
})
