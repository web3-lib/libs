import { afterEach, describe, expect, it, vi } from 'vitest'

import { WalletError, createWallet, isUserRejected, type WalletEvent } from '../src/index.js'
import { evm } from '../src/evm/index.js'
import { FakeEvmProvider, announce, fakeWalletConnect, flush, memoryStorage, stubWindow } from './fakes.js'

const BSC = { id: 56, name: 'BNB Smart Chain', rpcUrls: ['https://bsc.example'], nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 } }
const BASE = { id: 8453, name: 'Base', rpcUrls: ['https://base.example'], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }
const ADDRESS = '0xAbC0000000000000000000000000000000000001'

afterEach(() => vi.unstubAllGlobals())

function setup(options: { storage?: ReturnType<typeof memoryStorage>; autoConnect?: boolean; mode?: 'multi' | 'single' } = {}) {
  const win = stubWindow()
  const metamask = new FakeEvmProvider()
  announce(win, metamask, { rdns: 'io.metamask', name: 'MetaMask' })
  const storage = options.storage ?? memoryStorage()
  const wallet = createWallet({ connectors: [evm({ chains: [BSC, BASE] })], storage, autoConnect: options.autoConnect ?? false, mode: options.mode })
  const events: WalletEvent[] = []
  wallet.subscribe((_, event) => events.push(event))
  return { win, metamask, storage, wallet, events }
}

describe('钱包列表', () => {
  it('EIP-6963 发现的钱包排前面（按内置顺序），没安装的内置钱包排后面并带下载链接；WalletConnect 配置后出现', () => {
    const win = stubWindow()
    announce(win, new FakeEvmProvider(), { rdns: 'com.okex.wallet', name: 'OKX Wallet' })
    announce(win, new FakeEvmProvider(), { rdns: 'io.metamask', name: 'MetaMask' })
    announce(win, new FakeEvmProvider(), { rdns: 'xyz.unknown', name: 'Unknown Wallet' })
    const wallet = createWallet({ connectors: [evm({ walletConnect: { projectId: 'p', load: async () => ({}) } })], storage: null, autoConnect: false })
    const list = wallet.wallets('evm')
    expect(list.slice(0, 3).map((w) => [w.id, w.installed])).toEqual([
      ['io.metamask', true],
      ['com.okex.wallet', true],
      ['xyz.unknown', true],
    ])
    expect(list[3]).toMatchObject({ id: 'walletconnect', type: 'qrcode', installed: true })
    expect(list.find((w) => w.id === 'com.bitget.web3')).toMatchObject({ installed: false, downloadUrl: expect.stringContaining('bitget') })
    expect(list.filter((w) => w.name === 'MetaMask')).toHaveLength(1)
  })

  it('晚注入的钱包也能出现（walletsChanged 事件）', () => {
    const { win, wallet, events } = setup()
    expect(wallet.wallets('evm').find((w) => w.id === 'com.okex.wallet')?.installed).toBe(false)
    announce(win, new FakeEvmProvider(), { rdns: 'com.okex.wallet', name: 'OKX Wallet' })
    expect(events).toContainEqual({ type: 'walletsChanged', namespace: 'evm' })
    expect(wallet.wallets('evm').find((w) => w.id === 'com.okex.wallet')?.installed).toBe(true)
  })

  it('只注入 window.ethereum 的老钱包：按标识字段识别名字；同时用 EIP-6963 公告的不重复列', () => {
    const okx = new FakeEvmProvider({ flags: { isOkxWallet: true, isMetaMask: true } })
    const win = stubWindow({ ethereum: okx })
    const wallet = createWallet({ connectors: [evm({ known: [] })], storage: null, autoConnect: false })
    expect(wallet.wallets('evm')).toMatchObject([{ id: 'injected', namespace: 'evm', name: 'OKX Wallet', icon: null, type: 'injected', installed: true, downloadUrl: null }])
    announce(win, okx, { rdns: 'com.okex.wallet', name: 'OKX Wallet' })
    expect(wallet.wallets('evm').map((w) => w.id)).toEqual(['com.okex.wallet'])
  })
})

describe('连接', () => {
  it('连接后写入状态、设为当前钱包、持久化；签名用 personal_sign', async () => {
    const { wallet, storage, events } = setup()
    const connection = await wallet.connect('evm', 'io.metamask')
    expect(connection).toMatchObject({ namespace: 'evm', walletId: 'io.metamask', walletName: 'MetaMask', address: ADDRESS, chainId: 1 })
    expect(wallet.getState()).toMatchObject({ active: 'evm', connections: { evm: connection } })
    expect(events.map((e) => e.type)).toEqual(['connect', 'activeChanged'])
    expect(JSON.parse(storage.data.get('w3lib:wallet')!)).toEqual({ v: 1, active: 'evm', connections: { evm: { walletId: 'io.metamask', address: ADDRESS, chainId: 1 } } })
    // 'hi' 的 UTF-8 十六进制
    expect(await wallet.signMessage('hi')).toBe(`sig(0x6869,${ADDRESS})`)
  })

  it('用户拒绝 / 已有挂起的请求 / 没安装：统一成 WalletError', async () => {
    const { wallet, metamask } = setup()
    metamask.failNext = Object.assign(new Error('User rejected the request.'), { code: 4001 })
    const rejected = await wallet.connect('evm', 'io.metamask').catch((e) => e)
    expect(rejected).toBeInstanceOf(WalletError)
    expect(rejected.code).toBe('user_rejected')
    expect(isUserRejected(rejected)).toBe(true)
    metamask.failNext = { code: -32002, message: 'Already processing eth_requestAccounts' }
    expect((await wallet.connect('evm', 'io.metamask').catch((e) => e)).code).toBe('pending_request')
    expect((await wallet.connect('evm', 'com.bitget.web3').catch((e) => e)).code).toBe('not_installed')
    expect(wallet.getState().connections).toEqual({})
  })

  it('连接时传 chainId：连接后切链', async () => {
    const { wallet, metamask } = setup()
    const connection = await wallet.connect('evm', 'io.metamask', { chainId: 56 })
    expect(connection.chainId).toBe(56)
    expect(metamask.chainId).toBe(56)
  })

  it('连接时传 \'0x38\' 和当前链相同：不切链', async () => {
    const { wallet, metamask } = setup()
    metamask.chainId = 56
    expect((await wallet.connect('evm', 'io.metamask', { chainId: '0x38' })).chainId).toBe(56)
    expect(metamask.calls.map((c) => c.method)).not.toContain('wallet_switchEthereumChain')
    await wallet.switchChain('0x2105')
    expect(wallet.getConnection()?.chainId).toBe(8453)
    expect((await wallet.switchChain('abc').catch((e) => e)).code).toBe('unsupported_chain')
  })

  it('先后连接两个钱包：先完成的先生效，后完成的替换它（断开前一个）', async () => {
    const { win, wallet, metamask } = setup()
    announce(win, new FakeEvmProvider({ accounts: ['0x0000000000000000000000000000000000000002'] }), { rdns: 'com.okex.wallet', name: 'OKX Wallet' })
    const first = wallet.connect('evm', 'io.metamask')
    const second = wallet.connect('evm', 'com.okex.wallet')
    expect((await first).walletId).toBe('io.metamask')
    expect((await second).walletId).toBe('com.okex.wallet')
    expect(wallet.getConnection()?.walletId).toBe('com.okex.wallet')
    expect(metamask.calls.at(-1)?.method).toBe('wallet_revokePermissions')
  })

  it('后发起的连接先完成：先发起的作废（superseded），不断开钱包', async () => {
    const { win, wallet, metamask } = setup()
    announce(win, new FakeEvmProvider({ accounts: ['0x0000000000000000000000000000000000000002'] }), { rdns: 'com.okex.wallet', name: 'OKX Wallet' })
    let release!: () => void
    metamask.gate = new Promise<void>((r) => (release = r))
    const first = wallet.connect('evm', 'io.metamask')
    expect((await wallet.connect('evm', 'com.okex.wallet')).walletId).toBe('com.okex.wallet')
    release()
    expect((await first.catch((e) => e)).code).toBe('superseded')
    expect(wallet.getConnection()?.walletId).toBe('com.okex.wallet')
    expect(metamask.calls.map((c) => c.method)).not.toContain('wallet_revokePermissions')
  })

  it('同一个钱包连点两次：作废的那次不撤销授权，保持连接', async () => {
    const { wallet, metamask } = setup()
    let release!: () => void
    metamask.gate = new Promise<void>((r) => (release = r))
    const first = wallet.connect('evm', 'io.metamask')
    metamask.gate = null
    await wallet.connect('evm', 'io.metamask')
    release()
    expect((await first.catch((e) => e)).code).toBe('superseded')
    // 已连接时再连接同一个钱包：替换会话，也不撤销授权
    await wallet.connect('evm', 'io.metamask')
    expect(metamask.calls.map((c) => c.method)).not.toContain('wallet_revokePermissions')
    expect(metamask.authorized).toBe(true)
    expect(wallet.getConnection()?.walletId).toBe('io.metamask')
  })

  it('后发起的连接失败（-32002）：先发起的照常生效', async () => {
    const { win, wallet, metamask } = setup()
    const okx = new FakeEvmProvider()
    announce(win, okx, { rdns: 'com.okex.wallet', name: 'OKX Wallet' })
    let release!: () => void
    metamask.gate = new Promise<void>((r) => (release = r))
    const first = wallet.connect('evm', 'io.metamask')
    okx.failNext = { code: -32002, message: 'Already processing' }
    expect((await wallet.connect('evm', 'com.okex.wallet').catch((e) => e)).code).toBe('pending_request')
    release()
    expect((await first).walletId).toBe('io.metamask')
    expect(wallet.getConnection()?.walletId).toBe('io.metamask')
  })

  it("'injected' 但页面没有 window.ethereum：not_installed", async () => {
    stubWindow()
    const wallet = createWallet({ connectors: [evm()], storage: null, autoConnect: false })
    expect(wallet.wallets('evm').some((w) => w.id === 'injected')).toBe(false)
    expect((await wallet.connect('evm', 'injected').catch((e) => e)).code).toBe('not_installed')
  })

  it('destroy：移除 EIP-6963 监听，之后不能再连接', async () => {
    const { win, wallet, events } = setup()
    wallet.wallets('evm')
    wallet.destroy()
    announce(win, new FakeEvmProvider(), { rdns: 'io.rabby', name: 'Rabby' })
    expect(events.filter((e) => e.type === 'walletsChanged')).toEqual([])
    expect((await wallet.connect('evm', 'io.metamask').catch((e) => e)).message).toContain('destroyed')
  })
})

describe('事件', () => {
  it('切换账户、切换链、钱包里断开（账户为空）都同步到状态；只是大小写不同不算换账户', async () => {
    const { wallet, metamask, events, storage } = setup()
    await wallet.connect('evm', 'io.metamask')
    metamask.emit('accountsChanged', [ADDRESS.toLowerCase()])
    expect(wallet.getConnection()?.address).toBe(ADDRESS)
    metamask.emit('accountsChanged', ['0x0000000000000000000000000000000000000009'])
    expect(wallet.getConnection()?.address).toBe('0x0000000000000000000000000000000000000009')
    metamask.emit('chainChanged', '0x38')
    expect(wallet.getConnection()?.chainId).toBe(56)
    metamask.emit('accountsChanged', [])
    expect(wallet.getState()).toMatchObject({ connections: {}, active: null })
    expect(events.map((e) => e.type)).toEqual(['connect', 'activeChanged', 'accountChanged', 'chainChanged', 'disconnect', 'activeChanged'])
    expect(storage.data.has('w3lib:wallet')).toBe(false)
    expect(metamask.listenerCount('accountsChanged')).toBe(0) // 断开后取消订阅
  })

  it('订阅者抛错不影响其他订阅者', async () => {
    const { wallet } = setup()
    const seen: string[] = []
    wallet.subscribe(() => {
      throw new Error('ui bug')
    })
    wallet.subscribe((_, e) => seen.push(e.type))
    await wallet.connect('evm', 'io.metamask')
    expect(seen).toEqual(['connect', 'activeChanged'])
  })
})

describe('切链', () => {
  it('钱包没有这条链：按配置添加后切换；没有配置时报 unsupported_chain；用户拒绝时状态不变', async () => {
    const { wallet, metamask } = setup()
    await wallet.connect('evm', 'io.metamask')
    await wallet.switchChain(8453)
    expect(metamask.calls.map((c) => c.method)).toContain('wallet_addEthereumChain')
    expect(metamask.calls.find((c) => c.method === 'wallet_addEthereumChain')?.params).toEqual([
      { chainId: '0x2105', chainName: 'Base', rpcUrls: ['https://base.example'], nativeCurrency: BASE.nativeCurrency },
    ])
    expect(wallet.getConnection()?.chainId).toBe(8453)

    const unknown = await wallet.switchChain(999).catch((e) => e)
    expect(unknown.code).toBe('unsupported_chain')

    metamask.failNext = { code: 4001, message: 'User rejected' }
    expect((await wallet.switchChain(56).catch((e) => e)).code).toBe('user_rejected')
    expect(wallet.getConnection()?.chainId).toBe(8453)
  })

  it('MetaMask 移动端把 4902 包在 -32603 里：也能识别为没添加', async () => {
    const { wallet, metamask } = setup()
    await wallet.connect('evm', 'io.metamask')
    metamask.chains.delete(56)
    metamask.failNext = { code: -32603, message: 'Internal error', data: { originalError: { code: 4902 } } }
    await wallet.switchChain(56)
    expect(wallet.getConnection()?.chainId).toBe(56)
  })

  it('切链请求成功但钱包不发 chainChanged：以请求结果为准', async () => {
    const { wallet, metamask } = setup()
    await wallet.connect('evm', 'io.metamask')
    metamask.emit = () => {} // 不发事件
    await wallet.switchChain(56)
    expect(wallet.getConnection()?.chainId).toBe(56)
  })

  it('没有连接时切链 / 签名：not_connected', async () => {
    const { wallet } = setup()
    expect((await wallet.switchChain(56).catch((e) => e)).code).toBe('not_connected')
    expect((await wallet.signMessage('x').catch((e) => e)).code).toBe('not_connected')
  })
})

describe('断开与恢复', () => {
  it('断开：撤销授权（EIP-2255）、清空状态和存储', async () => {
    const { wallet, metamask, storage } = setup()
    await wallet.connect('evm', 'io.metamask')
    await wallet.disconnect()
    expect(metamask.calls.at(-1)?.method).toBe('wallet_revokePermissions')
    expect(wallet.getState().connections).toEqual({})
    expect(storage.data.size).toBe(0)
  })

  it('页面重新加载：用 eth_accounts 静默恢复，不弹窗、不切链', async () => {
    const storage = memoryStorage({ 'w3lib:wallet': JSON.stringify({ v: 1, active: 'evm', connections: { evm: { walletId: 'io.metamask', address: ADDRESS, chainId: 56 } } }) })
    const win = stubWindow()
    const metamask = new FakeEvmProvider({ authorized: true, chainId: 1 })
    announce(win, metamask, { rdns: 'io.metamask', name: 'MetaMask' })
    const wallet = createWallet({ connectors: [evm()], storage })
    expect(wallet.getState().status).toBe('restoring')
    await wallet.restore()
    expect(wallet.getState()).toMatchObject({ status: 'ready', active: 'evm', connections: { evm: { address: ADDRESS, chainId: 1 } } })
    expect(metamask.calls.map((c) => c.method)).toEqual(['eth_accounts', 'eth_chainId'])
  })

  it('钱包已不再授权：不恢复，清掉存储；插件晚注入时在超时内等到', async () => {
    const saved = { 'w3lib:wallet': JSON.stringify({ v: 1, active: 'evm', connections: { evm: { walletId: 'io.metamask', address: ADDRESS, chainId: 1 } } }) }
    const revoked = memoryStorage(saved)
    const win = stubWindow()
    announce(win, new FakeEvmProvider({ authorized: false }), { rdns: 'io.metamask', name: 'MetaMask' })
    const w1 = createWallet({ connectors: [evm()], storage: revoked })
    await w1.restore()
    expect(w1.getState().connections).toEqual({})
    expect(revoked.data.size).toBe(0)

    const late = memoryStorage(saved)
    const win2 = stubWindow()
    const w2 = createWallet({ connectors: [evm({ restoreTimeout: 500 })], storage: late })
    setTimeout(() => announce(win2, new FakeEvmProvider({ authorized: true }), { rdns: 'io.metamask', name: 'MetaMask' }), 20)
    await w2.restore()
    expect(w2.getConnection()?.walletId).toBe('io.metamask')
  })

  it('等不到插件注入（可能只是慢）：保留记录，下次再试', async () => {
    const storage = memoryStorage({ 'w3lib:wallet': JSON.stringify({ v: 1, active: 'evm', connections: { evm: { walletId: 'io.metamask', address: ADDRESS, chainId: 1 } } }) })
    stubWindow()
    const wallet = createWallet({ connectors: [evm({ restoreTimeout: 20 })], storage })
    await wallet.restore()
    expect(wallet.getState().connections).toEqual({})
    expect(storage.data.size).toBe(1)
  })

  it('存储内容损坏：忽略', async () => {
    stubWindow()
    const wallet = createWallet({ connectors: [evm()], storage: memoryStorage({ 'w3lib:wallet': '{oops' }) })
    await wallet.restore()
    expect(wallet.getState()).toMatchObject({ status: 'ready', connections: {} })
  })
})

describe('WalletConnect', () => {
  it('连接：应用自己画二维码（onDisplayUri）；optionalChains / rpcMap 来自 chains；断开结束会话', async () => {
    stubWindow()
    const wc = fakeWalletConnect()
    const uris: string[] = []
    const wallet = createWallet({
      connectors: [evm({ chains: [BSC, BASE], walletConnect: { projectId: 'pid', load: wc.load, onDisplayUri: (uri) => uris.push(uri) } })],
      storage: null,
      autoConnect: false,
    })
    const connection = await wallet.connect('evm', 'walletconnect')
    expect(connection).toMatchObject({ walletId: 'walletconnect', walletName: 'WalletConnect', address: wc.provider.accounts[0] })
    expect(uris).toEqual(['wc:abc@2?relay-protocol=irn&symKey=1'])
    expect(wc.inits[0]).toMatchObject({ projectId: 'pid', optionalChains: [56, 8453], rpcMap: { 56: 'https://bsc.example', 8453: 'https://base.example' }, showQrModal: false })
    expect(wc.provider.listenerCount('display_uri')).toBe(0)
    await wallet.disconnect()
    expect(wc.provider.disconnected).toBe(true)
  })

  it('恢复：会话还在才恢复（不弹二维码）；钱包那边结束会话时断开', async () => {
    const storage = memoryStorage({ 'w3lib:wallet': JSON.stringify({ v: 1, active: 'evm', connections: { evm: { walletId: 'walletconnect', address: '0xwc', chainId: 1 } } }) })
    stubWindow()
    const wc = fakeWalletConnect({ session: true })
    const uris: string[] = []
    const wallet = createWallet({ connectors: [evm({ walletConnect: { projectId: 'pid', load: wc.load, onDisplayUri: (u) => uris.push(u) } })], storage })
    await wallet.restore()
    expect(wallet.getConnection()?.walletId).toBe('walletconnect')
    expect(uris).toEqual([])
    wc.provider.emit('disconnect')
    expect(wallet.getState().connections).toEqual({})
  })

  it('取消连接（关闭二维码弹窗）：user_rejected；没配置 WalletConnect：unsupported', async () => {
    stubWindow()
    const wc = fakeWalletConnect({ hang: true })
    const wallet = createWallet({ connectors: [evm({ walletConnect: { projectId: 'pid', load: wc.load, onDisplayUri: () => {} } })], storage: null, autoConnect: false })
    const controller = new AbortController()
    const pending = wallet.connect('evm', 'walletconnect', { signal: controller.signal })
    await flush()
    controller.abort()
    expect((await pending.catch((e) => e)).code).toBe('user_rejected')
    // 取消时中止配对：之后扫码同意也不会建立会话
    expect(wc.provider.signer.aborted).toBe(1)
    const plain = createWallet({ connectors: [evm()], storage: null, autoConnect: false })
    expect((await plain.connect('evm', 'walletconnect').catch((e) => e)).code).toBe('unsupported')
  })

  it('已经取消的 signal：直接 user_rejected', async () => {
    stubWindow()
    const wc = fakeWalletConnect({ hang: true })
    const wallet = createWallet({ connectors: [evm({ walletConnect: { projectId: 'pid', load: wc.load, onDisplayUri: () => {} } })], storage: null, autoConnect: false })
    const uris: string[] = []
    wc.provider.on('display_uri', (uri: string) => uris.push(uri))
    expect((await wallet.connect('evm', 'walletconnect', { signal: AbortSignal.abort() }).catch((e) => e)).code).toBe('user_rejected')
    // 不发起配对：不出二维码
    expect(uris).toEqual([])
  })

  it('关闭 WalletConnect 自带弹窗（Connection request reset）：user_rejected；既没有 onDisplayUri 也没开弹窗：unsupported', async () => {
    stubWindow()
    const wc = fakeWalletConnect({ rejectWith: new Error('Connection request reset. Please try again.') })
    const modal = createWallet({ connectors: [evm({ walletConnect: { projectId: 'pid', load: wc.load, showQrModal: true } })], storage: null, autoConnect: false })
    expect((await modal.connect('evm', 'walletconnect').catch((e) => e)).code).toBe('user_rejected')
    expect(wc.inits[0]).toMatchObject({ showQrModal: true })
    const blind = createWallet({ connectors: [evm({ walletConnect: { projectId: 'pid', load: wc.load } })], storage: null, autoConnect: false })
    expect((await blind.connect('evm', 'walletconnect').catch((e) => e)).code).toBe('unsupported')
  })
})

describe('EVM 的更多情况', () => {
  it('取消注入钱包的连接：立即 user_rejected，之后钱包里同意也不会连上', async () => {
    const { wallet, metamask } = setup()
    let approve!: () => void
    metamask.gate = new Promise<void>((r) => (approve = r))
    const controller = new AbortController()
    const pending = wallet.connect('evm', 'io.metamask', { signal: controller.signal })
    await flush()
    controller.abort()
    expect((await pending.catch((e) => e)).code).toBe('user_rejected')
    approve()
    await flush()
    expect(wallet.getState().connections).toEqual({})
  })

  it('WalletConnect 取消后用户仍扫码同意：会话一建立就断开，下次连接重新出二维码', async () => {
    stubWindow()
    let approve!: () => void
    const wc = fakeWalletConnect({ gate: new Promise<void>((r) => (approve = r)) })
    const uris: string[] = []
    const wallet = createWallet({ connectors: [evm({ walletConnect: { projectId: 'p', load: wc.load, onDisplayUri: (u) => uris.push(u) } })], storage: null, autoConnect: false })
    const controller = new AbortController()
    const pending = wallet.connect('evm', 'walletconnect', { signal: controller.signal })
    await flush()
    controller.abort()
    expect((await pending.catch((e) => e)).code).toBe('user_rejected')
    approve()
    await flush()
    expect(wc.provider.disconnected).toBe(true)
    expect(wc.provider.session).toBeUndefined()
    await wallet.connect('evm', 'walletconnect')
    expect(uris).toHaveLength(2)
  })

  it('WalletConnect 的配置透传：metadata、qrModalOptions、options、name、icon', async () => {
    stubWindow()
    const wc = fakeWalletConnect()
    const metadata = { name: 'Dapp', description: 'd', url: 'https://dapp.example', icons: ['https://dapp.example/i.png'] }
    const wallet = createWallet({
      connectors: [evm({ walletConnect: { projectId: 'p', load: wc.load, onDisplayUri: () => {}, metadata, qrModalOptions: { themeMode: 'dark' }, options: { disableProviderPing: true }, name: 'Mobile Wallet', icon: 'data:wc' } })],
      storage: null,
      autoConnect: false,
    })
    expect(wallet.wallets('evm').find((w) => w.id === 'walletconnect')).toMatchObject({ name: 'Mobile Wallet', icon: 'data:wc' })
    const connection = await wallet.connect('evm', 'walletconnect')
    expect(connection).toMatchObject({ walletName: 'Mobile Wallet', icon: 'data:wc' })
    // 没配置 chains 时 optionalChains 默认 [1]
    expect(wc.inits[0]).toMatchObject({ projectId: 'p', metadata, qrModalOptions: { themeMode: 'dark' }, disableProviderPing: true, optionalChains: [1], rpcMap: {} })
  })

  it('WalletConnect SDK：初始化失败后下次重试；load 返回不对时 unknown；兼容 default 导出', async () => {
    stubWindow()
    const wc = fakeWalletConnect({ failInit: 1 })
    const wallet = createWallet({ connectors: [evm({ walletConnect: { projectId: 'p', load: async () => ({ default: wc.module }), onDisplayUri: () => {} } })], storage: null, autoConnect: false })
    expect((await wallet.connect('evm', 'walletconnect').catch((e) => e)).message).toContain('relay unreachable')
    expect((await wallet.connect('evm', 'walletconnect')).walletId).toBe('walletconnect')
    expect(wc.inits).toHaveLength(2)

    const bad = createWallet({ connectors: [evm({ walletConnect: { projectId: 'p', load: async () => ({}), onDisplayUri: () => {} } })], storage: null, autoConnect: false })
    expect((await bad.connect('evm', 'walletconnect').catch((e) => e)).message).toContain('@walletconnect/ethereum-provider')
  })

  it('恢复 WalletConnect：会话已经结束 / 没配置 WalletConnect：不恢复，删掉记录', async () => {
    const saved = { 'w3lib:wallet': JSON.stringify({ v: 1, active: 'evm', connections: { evm: { walletId: 'walletconnect', address: '0xwc', chainId: 1 } } }) }
    stubWindow()
    const ended = memoryStorage(saved)
    const w1 = createWallet({ connectors: [evm({ walletConnect: { projectId: 'p', load: fakeWalletConnect().load, onDisplayUri: () => {} } })], storage: ended })
    await w1.restore()
    expect(w1.getState().connections).toEqual({})
    expect(ended.data.size).toBe(0)

    const unconfigured = memoryStorage(saved)
    const w2 = createWallet({ connectors: [evm()], storage: unconfigured })
    await w2.restore()
    expect(unconfigured.data.size).toBe(0)
  })

  it("恢复只注入 window.ethereum 的钱包（id 'injected'）；legacyInjected: false 时不列出", async () => {
    const storage = memoryStorage({ 'w3lib:wallet': JSON.stringify({ v: 1, active: 'evm', connections: { evm: { walletId: 'injected', address: ADDRESS, chainId: 1 } } }) })
    stubWindow({ ethereum: new FakeEvmProvider({ authorized: true, flags: { isTokenPocket: true } }) })
    const wallet = createWallet({ connectors: [evm({ known: [] })], storage })
    await wallet.restore()
    expect(wallet.getConnection()).toMatchObject({ walletId: 'injected', walletName: 'TokenPocket', address: ADDRESS })

    stubWindow({ ethereum: new FakeEvmProvider() })
    const hidden = createWallet({ connectors: [evm({ known: [], legacyInjected: false })], storage: null, autoConnect: false })
    expect(hidden.wallets('evm')).toEqual([])
  })

  it('恢复时上次的地址已不在授权列表里：用钱包当前的第一个账户，并更新存储', async () => {
    const storage = memoryStorage({ 'w3lib:wallet': JSON.stringify({ v: 1, active: 'evm', connections: { evm: { walletId: 'io.metamask', address: '0x0000000000000000000000000000000000000009', chainId: 1 } } }) })
    const win = stubWindow()
    announce(win, new FakeEvmProvider({ authorized: true }), { rdns: 'io.metamask', name: 'MetaMask' })
    const wallet = createWallet({ connectors: [evm()], storage })
    await wallet.restore()
    expect(wallet.getConnection()?.address).toBe(ADDRESS)
    expect(JSON.parse(storage.data.get('w3lib:wallet')!).connections.evm.address).toBe(ADDRESS)
  })

  it('钱包只在错误消息里说没有这条链（没有 4902）：也会添加；添加时带上浏览器、图标', async () => {
    const win = stubWindow()
    const provider = new FakeEvmProvider({ chains: [1] })
    announce(win, provider, { rdns: 'io.metamask', name: 'MetaMask' })
    const chain = { ...BASE, blockExplorerUrls: ['https://basescan.org'], iconUrls: ['https://base.example/icon.png'] }
    const wallet = createWallet({ connectors: [evm({ chains: [chain] })], storage: null, autoConnect: false })
    await wallet.connect('evm', 'io.metamask')
    provider.failNext = new Error('Unrecognized chain ID "0x2105". Try adding the chain using wallet_addEthereumChain first.')
    await wallet.switchChain(8453)
    const add = provider.calls.find((c) => c.method === 'wallet_addEthereumChain')
    expect((add?.params as unknown[])[0]).toEqual({
      chainId: '0x2105',
      chainName: 'Base',
      rpcUrls: ['https://base.example'],
      nativeCurrency: BASE.nativeCurrency,
      blockExplorerUrls: ['https://basescan.org'],
      iconUrls: ['https://base.example/icon.png'],
    })
    expect(wallet.getConnection()?.chainId).toBe(8453)
  })

  it('自定义 known：没检测到时用它的名字和图标；钱包发来的账户不是数组：当作断开', async () => {
    const win = stubWindow()
    const wallet = createWallet({ connectors: [evm({ known: [{ id: 'xyz.wallet', name: 'XYZ', icon: 'data:xyz', downloadUrl: 'https://xyz.example' }] })], storage: null, autoConnect: false })
    expect(wallet.wallets('evm')).toMatchObject([{ id: 'xyz.wallet', namespace: 'evm', name: 'XYZ', icon: 'data:xyz', type: 'injected', installed: false, downloadUrl: 'https://xyz.example' }])
    const provider = new FakeEvmProvider()
    announce(win, provider, { rdns: 'xyz.wallet', name: 'XYZ Wallet' })
    await wallet.connect('evm', 'xyz.wallet')
    provider.emit('accountsChanged', null)
    expect(wallet.getState().connections).toEqual({})
  })

  it('destroy 之后再列钱包：不会重新加上 EIP-6963 的监听', () => {
    const win = stubWindow()
    const wallet = createWallet({ connectors: [evm()], storage: null, autoConnect: false })
    wallet.wallets('evm')
    wallet.destroy()
    wallet.wallets('evm')
    announce(win, new FakeEvmProvider(), { rdns: 'io.rabby', name: 'Rabby' })
    expect(wallet.wallets('evm').find((w) => w.id === 'io.rabby')?.installed).toBe(false)
  })
})

describe('WalletConnect 连点两次', () => {
  it('前一次作废（superseded），不会一直挂着；后一次照常连接', async () => {
    stubWindow()
    let approve!: () => void
    const wc = fakeWalletConnect({ gate: new Promise<void>((r) => (approve = r)) })
    const wallet = createWallet({ connectors: [evm({ walletConnect: { projectId: 'p', load: wc.load, onDisplayUri: () => {} } })], storage: null, autoConnect: false })
    const first = wallet.connect('evm', 'walletconnect').catch((e) => e)
    await flush()
    const second = wallet.connect('evm', 'walletconnect')
    expect((await first).code).toBe('superseded')
    approve()
    expect((await second).walletId).toBe('walletconnect')
  })
})

describe('WalletConnect 实例复用', () => {
  it('同一个 load 函数、同样的配置：重建 wallet 时复用已经初始化的 EthereumProvider；配置不同时各自初始化', async () => {
    stubWindow()
    const wc = fakeWalletConnect()
    const make = (projectId: string) => createWallet({ connectors: [evm({ walletConnect: { projectId, load: wc.load, onDisplayUri: () => {} } })], storage: null, autoConnect: false })
    const first = make('p1')
    await first.connect('evm', 'walletconnect')
    first.destroy()
    const second = make('p1')
    await second.connect('evm', 'walletconnect')
    expect(wc.inits).toHaveLength(1)
    await make('p2').connect('evm', 'walletconnect')
    expect(wc.inits).toHaveLength(2)
  })

  it('初始化失败的不缓存：下次重新初始化', async () => {
    stubWindow()
    const wc = fakeWalletConnect({ failInit: 1 })
    const make = () => createWallet({ connectors: [evm({ walletConnect: { projectId: 'p', load: wc.load, onDisplayUri: () => {} } })], storage: null, autoConnect: false })
    expect((await make().connect('evm', 'walletconnect').catch((e) => e)).message).toContain('relay unreachable')
    expect((await make().connect('evm', 'walletconnect')).walletId).toBe('walletconnect')
    expect(wc.inits).toHaveLength(2)
  })
})
