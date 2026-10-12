import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWallet, type WalletEvent } from '../src/index.js'
import { tron } from '../src/tron/index.js'
import { flush, memoryStorage, stubWindow } from './fakes.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const T_ADDRESS = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const T_OTHER = 'TNewAddress111111111111111111111111'
/** 主网创世区块 id（最后 8 位 2b6653dc） */
const MAINNET_GENESIS = '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc'

class Emitter {
  handlers = new Map<string, Set<(...args: any[]) => void>>()
  on(event: string, fn: (...args: any[]) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(fn)
  }
  removeListener(event: string, fn: (...args: any[]) => void) {
    this.handlers.get(event)?.delete(fn)
  }
  emit(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.forEach((fn) => fn(...args))
  }
}

/** 假的 tronWeb */
function tronWeb(options: { address?: string; host?: string; genesis?: string | null; sign?: boolean } = {}) {
  return {
    defaultAddress: { base58: (options.address ?? false) as string | false },
    fullNode: { host: options.host ?? 'https://api.trongrid.io' },
    trx: {
      sign: async (tx: unknown) => tx,
      ...(options.sign === false ? {} : { signMessageV2: async (message: string) => `0xsig(${message})` }),
      getBlockByNumber: async () => {
        if (options.genesis === null) throw new Error('node down')
        return { blockID: options.genesis ?? MAINNET_GENESIS }
      },
    },
  }
}

type FakeWeb = ReturnType<typeof tronWeb>

/** 老写法（TronLink 老版、OKX、Bitget）：request({ method: 'tron_requestAccounts' }) 返回 { code } */
function legacy(web: FakeWeb, respond?: () => unknown) {
  const calls: string[] = []
  return {
    calls,
    ready: Boolean(web.defaultAddress.base58),
    tronWeb: web,
    async request({ method }: { method: string }) {
      calls.push(method)
      if (respond) return respond()
      web.defaultAddress.base58 = T_ADDRESS
      // 与真实钱包一样：授权后 ready 变成 true
      this.ready = true
      return { code: 200, message: 'ok' }
    },
  }
}

/** TIP-1193（新版 TronLink、TokenPocket）：request({ method: 'eth_requestAccounts' }) 返回地址数组 */
class Tip1193 extends Emitter {
  isTronLink = true
  calls: string[] = []
  constructor(public tronWeb: FakeWeb | undefined) {
    super()
  }
  async request({ method }: { method: string }) {
    this.calls.push(method)
    if (this.tronWeb) this.tronWeb.defaultAddress.base58 = T_ADDRESS
    return [T_ADDRESS]
  }
}

function make(connectorOptions: Parameters<typeof tron>[0] = {}, storage = memoryStorage(), autoConnect = false) {
  const wallet = createWallet({ connectors: [tron(connectorOptions)], storage, autoConnect })
  const events: WalletEvent[] = []
  wallet.subscribe((_, event) => events.push(event))
  return { wallet, events, storage }
}

describe('Tron：直接对接钱包注入的对象（不需要 SDK）', () => {
  it('检测：TronLink（window.tron）、OKX、Bitget、TokenPocket；Bitget 注入的 window.tronLink 不算 TronLink；可以配图标', () => {
    stubWindow({ tron: new Tip1193(tronWeb()), okxwallet: { tronLink: legacy(tronWeb()) } })
    const { wallet } = make({ icons: { okx: 'data:okx' } })
    expect(wallet.wallets('tron').map((w) => [w.id, w.installed, w.icon])).toEqual([
      ['tronlink', true, null],
      ['okx', true, 'data:okx'],
      ['bitget', false, null],
      ['tokenpocket', false, null],
    ])

    const bitget = legacy(tronWeb())
    stubWindow({ tronLink: bitget, bitkeep: { tronLink: bitget, tronWeb: bitget.tronWeb }, isBitKeep: true, tokenpocket: { tron: new Tip1193(tronWeb()) } })
    expect(Object.fromEntries(make().wallet.wallets('tron').map((w) => [w.id, w.installed]))).toEqual({ tronlink: false, okx: false, bitget: true, tokenpocket: true })
  })

  it('TIP-6963 公告的钱包（带图标）；晚公告时钱包列表更新', () => {
    const win = stubWindow()
    const { wallet, events } = make()
    expect(wallet.wallets('tron').find((w) => w.id === 'tronlink')?.installed).toBe(false)
    win.dispatchEvent(new CustomEvent('TIP6963:announceProvider', { detail: { info: { name: 'TronLink', icon: 'data:tl', rdns: 'org.tronlink.www' }, provider: new Tip1193(tronWeb()) } }))
    expect(events).toContainEqual({ type: 'walletsChanged', namespace: 'tron' })
    expect(wallet.wallets('tron')[0]).toMatchObject({ id: 'tronlink', installed: true, icon: 'data:tl' })
  })

  it('TIP-1193 连接：eth_requestAccounts；provider 是 tronWeb；网络按创世区块；签名用 signMessageV2；账户 / 网络变化', async () => {
    const web = tronWeb()
    const provider = new Tip1193(web)
    stubWindow({ tron: provider })
    const { wallet, events } = make()
    const connection = await wallet.connect('tron', 'tronlink')
    expect(connection).toMatchObject({ walletId: 'tronlink', walletName: 'TronLink', address: T_ADDRESS, chainId: 'mainnet' })
    expect(connection.provider).toBe(web)
    expect(provider.calls).toEqual(['eth_requestAccounts'])
    expect(await wallet.signMessage('hi')).toBe('0xsig(hi)')

    provider.emit('accountsChanged', [T_OTHER])
    expect(wallet.address).toBe(T_OTHER)
    provider.emit('chainChanged', { chainId: '0xcd8690dc' })
    expect(wallet.chainId).toBe('nile')
    // chainChanged 不带已知的 chainId：重新读网络
    web.trx.getBlockByNumber = async () => ({ blockID: '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc' })
    provider.emit('chainChanged', {})
    await flush()
    expect(wallet.chainId).toBe('nile')
    // 不带数组：读 tronWeb 的当前账户
    web.defaultAddress.base58 = T_ADDRESS
    provider.emit('accountsChanged')
    expect(wallet.address).toBe(T_ADDRESS)
    provider.emit('accountsChanged', [])
    expect(wallet.connected).toBe(false)
    expect(events.map((e) => e.type)).toContain('disconnect')
  })

  it('TIP-1193：tronWeb 晚于授权挂上时等一下', async () => {
    const provider = new Tip1193(undefined)
    stubWindow({ tron: provider })
    const { wallet } = make()
    setTimeout(() => (provider.tronWeb = tronWeb({ address: T_ADDRESS })), 150)
    const connection = await wallet.connect('tron', 'tronlink')
    expect(connection.provider).toBe(provider.tronWeb)
  })

  it('老写法连接（OKX）：tron_requestAccounts；账户 / 节点变化和断开通过 message 事件；别的来源的消息忽略', async () => {
    vi.stubGlobal('location', { origin: 'https://dapp.example' })
    const web = tronWeb()
    const okx = legacy(web)
    const win = stubWindow({ okxwallet: { tronLink: okx } })
    const { wallet } = make()
    const connection = await wallet.connect('tron', 'okx')
    expect(connection).toMatchObject({ walletId: 'okx', address: T_ADDRESS, chainId: 'mainnet' })
    expect(okx.calls).toEqual(['tron_requestAccounts'])

    const post = (message: unknown, origin = 'https://dapp.example') => win.dispatchEvent(new MessageEvent('message', { data: { message }, origin }))
    // 消息只是“重新读一次”的信号：以这个钱包自己的 tronWeb 为准（别的 Tron 钱包发的消息不影响）
    post({ action: 'setAccount', data: { address: T_OTHER } })
    expect(wallet.address).toBe(T_ADDRESS)
    web.defaultAddress.base58 = T_OTHER
    post({ action: 'accountsChanged', data: { address: T_OTHER } }, 'https://evil.example')
    expect(wallet.address).toBe(T_ADDRESS)
    post({ action: 'accountsChanged', data: { address: T_OTHER } })
    expect(wallet.address).toBe(T_OTHER)
    web.fullNode.host = 'https://nile.trongrid.io'
    web.trx.getBlockByNumber = async () => ({ blockID: '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc' })
    post({ action: 'setNode', data: {} })
    await flush()
    expect(wallet.chainId).toBe('nile')
    // connect 消息：读当前账户
    web.defaultAddress.base58 = T_ADDRESS
    post({ action: 'connect' })
    expect(wallet.address).toBe(T_ADDRESS)
    // 别的钱包发的 disconnect：这个钱包还有地址，不断开
    post({ action: 'disconnect' })
    await new Promise((r) => setTimeout(r, 350))
    expect(wallet.connected).toBe(true)
    web.defaultAddress.base58 = false
    post({ action: 'disconnect' })
    await new Promise((r) => setTimeout(r, 350))
    expect(wallet.connected).toBe(false)
  })

  it('老写法的返回码：4001 / Bitget 的 40001 是用户拒绝，4000 是已有请求，没返回是钱包锁着，其他码按失败', async () => {
    const respond = { value: null as unknown }
    stubWindow({ okxwallet: { tronLink: legacy(tronWeb(), () => respond.value) } })
    const { wallet } = make()
    const code = async (value: unknown) => {
      respond.value = value
      return (await wallet.connect('tron', 'okx').catch((e) => e)).code
    }
    expect(await code({ code: 4001 })).toBe('user_rejected')
    expect(await code({ code: 40001 })).toBe('user_rejected')
    expect(await code({ code: 4000 })).toBe('pending_request')
    expect(await code(null)).toBe('unknown')
    respond.value = { code: 500, message: 'node error' }
    expect((await wallet.connect('tron', 'okx').catch((e) => e)).message).toBe('node error')
  })

  it('钱包 App 内置浏览器：只有 tronWeb、已经授权，直接连接不请求（TronLink App、TokenPocket App）', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })
    stubWindow({ tronWeb: tronWeb({ address: T_ADDRESS }) })
    expect((await make().wallet.connect('tron', 'tronlink')).address).toBe(T_ADDRESS)

    stubWindow({ tronWeb: tronWeb({ address: T_ADDRESS }), tokenpocket: {} })
    const { wallet } = make()
    expect(wallet.wallets('tron').find((w) => w.id === 'tronlink')?.installed).toBe(false)
    expect((await wallet.connect('tron', 'tokenpocket')).walletName).toBe('TokenPocket')

    // Bitget App 里打开时已授权：不请求
    const bitget = legacy(tronWeb({ address: T_ADDRESS }))
    stubWindow({ bitkeep: { tronLink: bitget, tronWeb: bitget.tronWeb } })
    expect((await make().wallet.connect('tron', 'bitget')).address).toBe(T_ADDRESS)
    expect(bitget.calls).toEqual([])
  })

  it('钱包不发事件：定时检查当前账户（换账户、锁定）', async () => {
    vi.useFakeTimers()
    const web = tronWeb()
    stubWindow({ okxwallet: { tronLink: legacy(web) } })
    const { wallet } = make()
    await wallet.connect('tron', 'okx')
    web.defaultAddress.base58 = T_OTHER
    await vi.advanceTimersByTimeAsync(1500)
    expect(wallet.address).toBe(T_OTHER)
    // 读不到地址：连续两次才算断开（钱包换网络时会短暂没有地址）
    web.defaultAddress.base58 = false
    await vi.advanceTimersByTimeAsync(1500)
    expect(wallet.connected).toBe(true)
    await vi.advanceTimersByTimeAsync(1500)
    expect(wallet.connected).toBe(false)
  })

  it('网络：节点请求失败时按节点地址猜，猜不出为 null；钱包不支持 signMessageV2：unsupported', async () => {
    stubWindow({ okxwallet: { tronLink: legacy(tronWeb({ genesis: null, host: 'https://api.shasta.trongrid.io', sign: false })) } })
    const { wallet } = make()
    expect((await wallet.connect('tron', 'okx')).chainId).toBe('shasta')
    expect((await wallet.signMessage('x').catch((e) => e)).code).toBe('unsupported')

    stubWindow({ okxwallet: { tronLink: legacy(tronWeb({ genesis: null, host: 'https://my-node.example' })) } })
    expect((await make().wallet.connect('tron', 'okx')).chainId).toBeNull()
  })

  it('没装：not_installed；没配置的钱包：unsupported；wallets 只列指定的', async () => {
    stubWindow()
    const { wallet } = make({ wallets: ['okx', 'tronlink'] })
    expect(wallet.wallets('tron').map((w) => w.id)).toEqual(['okx', 'tronlink'])
    expect((await wallet.connect('tron', 'okx').catch((e) => e)).code).toBe('not_installed')
    expect((await wallet.connect('tron', 'bitget').catch((e) => e)).code).toBe('unsupported')
  })
})

describe('Tron：刷新后恢复', () => {
  const saved = (walletId = 'tronlink') => memoryStorage({ 'w3lib:wallet': JSON.stringify({ v: 1, active: 'tron', connections: { tron: { walletId, address: T_ADDRESS, chainId: 'mainnet' } } }) })

  it('钱包仍授权（已有地址）：恢复，不请求授权（不弹窗）', async () => {
    const provider = new Tip1193(tronWeb({ address: T_ADDRESS }))
    stubWindow({ tron: provider })
    const { wallet } = make({}, saved(), true)
    await wallet.ready
    expect(wallet.address).toBe(T_ADDRESS)
    expect(provider.calls).toEqual([])
  })

  it('插件晚注入、地址晚到：在等待时间内都能恢复', async () => {
    const win = stubWindow()
    const web = tronWeb()
    const okx = legacy(web)
    setTimeout(() => Object.assign(win, { okxwallet: { tronLink: okx } }), 120)
    setTimeout(() => {
      web.defaultAddress.base58 = T_ADDRESS
      okx.ready = true
    }, 300)
    const { wallet } = make({ restoreTimeout: 1000 }, saved('okx'), true)
    await wallet.ready
    expect(wallet.address).toBe(T_ADDRESS)
  })

  it('钱包就绪但没有地址（没授权 / 锁着）：不恢复，删掉记录；没检测到钱包、钱包还没就绪：保留记录', async () => {
    const ready = legacy(tronWeb())
    ready.ready = true
    stubWindow({ okxwallet: { tronLink: ready } })
    const locked = saved('okx')
    const w1 = make({ restoreTimeout: 200 }, locked, true).wallet
    await w1.ready
    expect(w1.connected).toBe(false)
    expect(locked.data.size).toBe(0)

    stubWindow()
    const missing = saved('okx')
    const w2 = make({ restoreTimeout: 200 }, missing, true).wallet
    await w2.ready
    expect(missing.data.size).toBe(1)

    // ready 一直是 false（插件启动慢，或撤销了授权）：保留记录；连续 3 次打开页面都没就绪才删掉
    const slow = saved('okx')
    for (const expected of [1, 1, 0]) {
      stubWindow({ okxwallet: { tronLink: legacy(tronWeb()) } })
      const w = make({ restoreTimeout: 100 }, slow, true).wallet
      await w.ready
      expect(slow.data.size).toBe(expected)
    }
  })
})

describe('Tron：WalletConnect（需要 SDK）', () => {
  function wcModule() {
    const created: Array<Emitter & { params: unknown; address: string | null; disconnected: boolean }> = []
    class WalletConnectAdapter extends Emitter {
      name = 'WalletConnect'
      icon = 'data:wc'
      address: string | null = null
      disconnected = false
      constructor(public params: unknown) {
        super()
        created.push(this)
      }
      async connect() {
        this.address = T_ADDRESS
      }
      async disconnect() {
        this.disconnected = true
        this.emit('disconnect')
      }
      async signMessage(message: string) {
        return `0xwc(${message})`
      }
      async signTransaction(tx: unknown) {
        return tx
      }
      // 与真实的 WalletConnectAdapter 一样：没有 network() 方法
    }
    return { created, module: { WalletConnectAdapter } }
  }

  it('配置 walletConnect 后列出扫码入口；连接用 adapter（参数去掉 name / icon）；签名、断开、钱包断开', async () => {
    stubWindow()
    const { created, module } = wcModule()
    const { wallet } = make({ load: async () => module, walletConnect: { network: 'Nile', name: 'Mobile', icon: 'data:m' } })
    expect(wallet.wallets('tron').at(-1)).toMatchObject({ id: 'walletconnect', name: 'Mobile', icon: 'data:m', type: 'qrcode' })
    const connection = await wallet.connect('tron', 'walletconnect')
    // adapter 没有 network()：网络用配置里连的（network: 'Nile'）
    expect(connection).toMatchObject({ walletName: 'Mobile', address: T_ADDRESS, chainId: 'nile' })
    expect(created[0]?.params).toEqual({ network: 'Nile' })
    expect(await wallet.signMessage('x')).toBe('0xwc(x)')
    created[0]!.emit('accountsChanged', T_OTHER)
    expect(wallet.address).toBe(T_OTHER)
    created[0]!.emit('disconnect')
    expect(wallet.connected).toBe(false)
  })

  it('CommonJS 互操作时导出在 default 上：也能找到 WalletConnectAdapter', async () => {
    stubWindow()
    const { module } = wcModule()
    const { wallet } = make({ load: async () => ({ default: module }), walletConnect: {} })
    expect((await wallet.connect('tron', 'walletconnect')).address).toBe(T_ADDRESS)
  })

  it('没传 load：unsupported；load 返回的不对：unknown；刷新后不能恢复，删掉记录', async () => {
    stubWindow()
    expect((await make({ walletConnect: {} }).wallet.connect('tron', 'walletconnect').catch((e) => e)).code).toBe('unsupported')
    expect((await make({ walletConnect: {}, load: async () => ({}) }).wallet.connect('tron', 'walletconnect').catch((e) => e)).message).toContain('@tronweb3/tronwallet-adapters')
    expect((await make().wallet.connect('tron', 'walletconnect').catch((e) => e)).code).toBe('unsupported')

    const storage = memoryStorage({ 'w3lib:wallet': JSON.stringify({ v: 1, active: 'tron', connections: { tron: { walletId: 'walletconnect', address: T_ADDRESS, chainId: 'mainnet' } } }) })
    const { wallet } = make({ load: async () => wcModule().module, walletConnect: {} }, storage, true)
    await wallet.ready
    expect(storage.data.size).toBe(0)
  })
})

describe('Tron：destroy', () => {
  it('移除 TIP-6963 的监听', () => {
    const win = stubWindow()
    const { wallet, events } = make()
    wallet.wallets('tron')
    wallet.destroy()
    win.dispatchEvent(new CustomEvent('TIP6963:announceProvider', { detail: { info: { name: 'TronLink' }, provider: new Tip1193(tronWeb()) } }))
    expect(events).toEqual([])
  })
})

describe('Tron：和官方 adapter 对齐的细节', () => {
  it('老写法的钱包 ready 为 false（没授权）时，即使有 defaultAddress 也不恢复', async () => {
    const web = tronWeb({ address: T_ADDRESS })
    const bitget = legacy(web)
    bitget.ready = false
    stubWindow({ bitkeep: { tronLink: bitget, tronWeb: web } })
    const storage = memoryStorage({ 'w3lib:wallet': JSON.stringify({ v: 1, active: 'tron', connections: { tron: { walletId: 'bitget', address: T_ADDRESS, chainId: 'mainnet' } } }) })
    const { wallet } = make({ restoreTimeout: 200 }, storage, true)
    await wallet.ready
    expect(wallet.connected).toBe(false)
  })

  it('TIP-1193：定时检查读不到地址时不断开（以钱包的事件为准）', async () => {
    vi.useFakeTimers()
    const web = tronWeb()
    const provider = new Tip1193(web)
    stubWindow({ tron: provider })
    const { wallet } = make()
    await wallet.connect('tron', 'tronlink')
    web.defaultAddress.base58 = false
    await vi.advanceTimersByTimeAsync(6000)
    expect(wallet.connected).toBe(true)
  })

  it('手机上：TronLink 用 window.tronLink（不用 window.tron）；Bitget 用 bitkeep.tronLink.tronWeb；TokenPocket 用 tokenpocket.tronWeb', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' })
    const tip = new Tip1193(tronWeb())
    const tronLink = legacy(tronWeb())
    stubWindow({ tron: tip, tronLink })
    await make().wallet.connect('tron', 'tronlink')
    expect(tip.calls).toEqual([])
    expect(tronLink.calls).toEqual(['tron_requestAccounts'])

    const inner = tronWeb({ address: T_ADDRESS })
    stubWindow({ bitkeep: { tronLink: { ...legacy(inner), ready: true }, tronWeb: tronWeb({ address: T_OTHER }) } })
    expect((await make().wallet.connect('tron', 'bitget')).provider).toBe(inner)

    const tpWeb = tronWeb({ address: T_ADDRESS })
    stubWindow({ tokenpocket: { tron: new Tip1193(tronWeb()), tronWeb: tpWeb } })
    expect((await make().wallet.connect('tron', 'tokenpocket')).provider).toBe(tpWeb)
  })

  it('连接后钱包给不出 tronWeb：报错，不建一个没有 provider 的连接', async () => {
    const provider = new Tip1193(undefined)
    stubWindow({ tron: provider })
    expect((await make().wallet.connect('tron', 'tronlink').catch((e) => e)).message).toContain('tronWeb')
  })
})

describe('Tron WalletConnect 的细节', () => {
  it('关掉 adapter 的扫码窗口（WalletWindowClosedError）：user_rejected；network 写链 id 也能识别', async () => {
    stubWindow()
    class WalletConnectAdapter extends Emitter {
      name = 'WalletConnect'
      address: string | null = null
      constructor(public params: unknown) {
        super()
      }
      async connect() {
        throw Object.assign(new Error('The QR window is closed.'), { name: 'WalletWindowClosedError' })
      }
      async disconnect() {}
      async signMessage() {
        return ''
      }
      async signTransaction(tx: unknown) {
        return tx
      }
    }
    const { wallet } = make({ load: async () => ({ WalletConnectAdapter }), walletConnect: { network: '0xcd8690dc' } })
    expect((await wallet.connect('tron', 'walletconnect').catch((e) => e)).code).toBe('user_rejected')
  })
})
