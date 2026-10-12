import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWallet } from '../src/index.js'
import { evm } from '../src/evm/index.js'
import { solana } from '../src/solana/index.js'
import { sui } from '../src/sui/index.js'
import { FakeEvmProvider, announce, fakeStandardWallet, memoryStorage, registerStandardWallet, stubWindow } from './fakes.js'

const SOL_ADDRESS = 'So1anaAddress1111111111111111111111111111111'
const SUI_ADDRESS = '0x5ui0000000000000000000000000000000000000000000000000000000000001'

afterEach(() => vi.unstubAllGlobals())

function phantom(options: { authorized?: boolean } = {}) {
  return fakeStandardWallet({
    name: 'Phantom',
    chain: 'solana:mainnet',
    address: SOL_ADDRESS,
    authorized: options.authorized,
    features: {
      'solana:signTransaction': {},
      'solana:signMessage': { signMessage: async () => [{ signedMessage: new Uint8Array(), signature: new Uint8Array([0, 0, 1, 2, 3]) }] },
    },
  })
}

describe('Solana（Wallet Standard）', () => {
  it('列出这条链上能签交易的钱包；没检测到的内置钱包带下载链接；晚注册的钱包也能出现', () => {
    const win = stubWindow()
    const wallet = createWallet({ connectors: [solana()], storage: null, autoConnect: false })
    expect(wallet.wallets('solana').every((w) => !w.installed)).toBe(true)
    const events: string[] = []
    wallet.subscribe((_, e) => events.push(e.type))
    registerStandardWallet(win, phantom().wallet)
    // 只支持 Sui 的钱包、只能签消息的钱包都不列
    registerStandardWallet(win, fakeStandardWallet({ name: 'Slush', chain: 'sui:mainnet', address: SUI_ADDRESS, features: { 'sui:signTransaction': {} } }).wallet)
    registerStandardWallet(win, fakeStandardWallet({ name: 'NoTx', chain: 'solana:mainnet', address: SOL_ADDRESS }).wallet)
    expect(events).toContain('walletsChanged')
    const list = wallet.wallets('solana')
    expect(list[0]).toMatchObject({ id: 'Phantom', installed: true, icon: 'data:Phantom', downloadUrl: 'https://phantom.com/download' })
    expect(list.map((w) => w.name)).not.toContain('Slush')
    expect(list.map((w) => w.name)).not.toContain('NoTx')
    expect(list.filter((w) => w.name === 'Phantom')).toHaveLength(1)
  })

  it('钱包先于页面注册（注册在 app-ready 之前）也能发现', () => {
    const win = stubWindow()
    const fake = phantom()
    // 钱包先加载：监听 app-ready，收到后注册
    win.addEventListener('wallet-standard:app-ready', (event) => (event as CustomEvent).detail.register(fake.wallet))
    const wallet = createWallet({ connectors: [solana()], storage: null, autoConnect: false })
    expect(wallet.wallets('solana')[0]?.installed).toBe(true)
  })

  it('连接、签名（base58）、钱包里切换账户 / 断开；断开时通知钱包', async () => {
    const win = stubWindow()
    const fake = phantom()
    registerStandardWallet(win, fake.wallet)
    const wallet = createWallet({ connectors: [solana()], storage: null, autoConnect: false })
    const connection = await wallet.connect('solana', 'Phantom')
    expect(connection).toMatchObject({ namespace: 'solana', walletId: 'Phantom', address: SOL_ADDRESS, chainId: 'solana:mainnet', provider: fake.wallet })
    expect(await wallet.signMessage('hi')).toBe('11Ldp') // 前导 0 字节编码为 '1'
    fake.setAccount('Another111111111111111111111111111111111111')
    expect(wallet.getConnection()?.address).toBe('Another111111111111111111111111111111111111')
    fake.setAccount(null)
    expect(wallet.getState().connections).toEqual({})

    await wallet.connect('solana', 'Phantom')
    await wallet.disconnect()
    expect(fake.wallet.accounts).toEqual([])
  })

  it('恢复用 silent 连接（不弹窗）；钱包已不再授权时不恢复；钱包在超时内注册时等到', async () => {
    const saved = { 'w3lib:wallet': JSON.stringify({ v: 1, active: 'solana', connections: { solana: { walletId: 'Phantom', address: SOL_ADDRESS, chainId: 'solana:mainnet' } } }) }
    const win = stubWindow()
    const authorized = phantom({ authorized: true })
    registerStandardWallet(win, authorized.wallet)
    const w1 = createWallet({ connectors: [solana()], storage: memoryStorage(saved) })
    await w1.restore()
    expect(w1.getConnection()?.address).toBe(SOL_ADDRESS)
    expect(authorized.connectCalls).toEqual([{ silent: true }])

    const win2 = stubWindow()
    const revoked = phantom({ authorized: false })
    registerStandardWallet(win2, revoked.wallet)
    const revokedStorage = memoryStorage(saved)
    const w2 = createWallet({ connectors: [solana()], storage: revokedStorage })
    await w2.restore()
    expect(w2.getState().connections).toEqual({})
    expect(revokedStorage.data.size).toBe(0)

    const win3 = stubWindow()
    const w3 = createWallet({ connectors: [solana({ restoreTimeout: 500 })], storage: memoryStorage(saved) })
    setTimeout(() => registerStandardWallet(win3, phantom({ authorized: true }).wallet), 20)
    await w3.restore()
    expect(w3.getConnection()?.walletId).toBe('Phantom')
  })

  it('没装 / 不支持签消息', async () => {
    const win = stubWindow()
    registerStandardWallet(win, fakeStandardWallet({ name: 'Plain', chain: 'solana:mainnet', address: SOL_ADDRESS, features: { 'solana:signTransaction': {} } }).wallet)
    const wallet = createWallet({ connectors: [solana()], storage: null, autoConnect: false })
    expect((await wallet.connect('solana', 'Phantom').catch((e) => e)).code).toBe('not_installed')
    await wallet.connect('solana', 'Plain')
    expect((await wallet.signMessage('x').catch((e) => e)).code).toBe('unsupported')
  })
})

describe('Sui（Wallet Standard）', () => {
  it('signPersonalMessage 返回 base64 签名；老钱包退回 sui:signMessage', async () => {
    const win = stubWindow()
    registerStandardWallet(
      win,
      fakeStandardWallet({
        name: 'Slush',
        chain: 'sui:mainnet',
        address: SUI_ADDRESS,
        features: { 'sui:signTransaction': {}, 'sui:signPersonalMessage': { signPersonalMessage: async () => ({ bytes: 'aGk=', signature: 'AAEC' }) } },
      }).wallet,
    )
    registerStandardWallet(
      win,
      fakeStandardWallet({
        name: 'Old',
        chain: 'sui:mainnet',
        address: SUI_ADDRESS,
        features: { 'sui:signTransactionBlock': {}, 'sui:signMessage': { signMessage: async () => ({ messageBytes: 'aGk=', signature: new Uint8Array([1, 2]) }) } },
      }).wallet,
    )
    const wallet = createWallet({ connectors: [sui()], storage: null, autoConnect: false })
    await wallet.connect('sui', 'Slush')
    expect(await wallet.signMessage('hi')).toBe('AAEC')
    await wallet.connect('sui', 'Old')
    expect(await wallet.signMessage('hi')).toBe('AQI=')
  })
})

describe('连接模式', () => {
  function multiSetup(mode: 'multi' | 'single') {
    const win = stubWindow()
    announce(win, new FakeEvmProvider({ authorized: true }), { rdns: 'io.metamask', name: 'MetaMask' })
    const fake = phantom({ authorized: true })
    registerStandardWallet(win, fake.wallet)
    const storage = memoryStorage()
    const wallet = createWallet({ connectors: [evm(), solana()], storage, mode, autoConnect: false })
    return { wallet, storage, fake }
  }

  it("'multi'：EVM 和 Solana 同时连着，active 指向最近连接的；setActive 切换；恢复时两个都恢复", async () => {
    const { wallet, storage } = multiSetup('multi')
    await wallet.connect('evm', 'io.metamask')
    await wallet.connect('solana', 'Phantom')
    expect(Object.keys(wallet.getState().connections).sort()).toEqual(['evm', 'solana'])
    expect(wallet.getState().active).toBe('solana')
    wallet.setActive('evm')
    expect(wallet.getConnection()?.namespace).toBe('evm')
    expect(() => wallet.setActive('tron')).toThrow('No tron wallet connected')
    // 断开当前钱包：active 换成剩下的那个
    await wallet.disconnect()
    expect(wallet.getState().active).toBe('solana')

    await wallet.connect('evm', 'io.metamask')
    const reloaded = createWallet({ mode: 'multi', connectors: [evm(), solana()], storage })
    await reloaded.restore()
    expect(Object.keys(reloaded.getState().connections).sort()).toEqual(['evm', 'solana'])
    expect(reloaded.getState().active).toBe('evm')
  })

  it("'single'：连新钱包时断开其他链的；恢复时只恢复当前钱包", async () => {
    const { wallet, storage, fake } = multiSetup('single')
    await wallet.connect('evm', 'io.metamask')
    await wallet.connect('solana', 'Phantom')
    expect(Object.keys(wallet.getState().connections)).toEqual(['solana'])
    expect(JSON.parse(storage.data.get('w3lib:wallet')!).connections).toEqual({ solana: { walletId: 'Phantom', address: SOL_ADDRESS, chainId: 'solana:mainnet' } })

    // 存储里有两个（比如从 multi 切到 single）：只恢复当前的
    storage.setItem(
      'w3lib:wallet',
      JSON.stringify({
        v: 1,
        active: 'solana',
        connections: { evm: { walletId: 'io.metamask', address: '0xAbC0000000000000000000000000000000000001', chainId: 1 }, solana: { walletId: 'Phantom', address: SOL_ADDRESS, chainId: 'solana:mainnet' } },
      }),
    )
    fake.wallet.accounts = []
    const reloaded = createWallet({ connectors: [evm(), solana()], storage, mode: 'single' })
    await reloaded.restore()
    expect(Object.keys(reloaded.getState().connections)).toEqual(['solana'])
  })

  it('没配置的命名空间、重复的连接器', () => {
    stubWindow()
    const wallet = createWallet({ connectors: [evm()], storage: null, autoConnect: false })
    expect(() => wallet.wallets('solana')).toThrow('No connector configured for solana')
    expect(() => createWallet({ connectors: [evm(), evm()], storage: null })).toThrow('Duplicate connector')
  })
})

describe('Wallet Standard 注册表', () => {
  it('重复注册同一个钱包：后一次的注销不影响前一次的注册', async () => {
    stubWindow()
    const { standardWallets, watchStandardWallets } = await import('../src/standard/registry.js')
    const { wallet } = phantom()
    let api!: { register(...w: unknown[]): () => void }
    standardWallets()
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: (a: typeof api) => (api = a) }))
    let changes = 0
    const unwatch = watchStandardWallets(() => changes++)
    const first = api.register(wallet)
    const second = api.register(wallet)
    expect(changes).toBe(1)
    second()
    expect(standardWallets()).toEqual([wallet])
    first()
    expect(standardWallets()).toEqual([])
    expect(changes).toBe(2)
    unwatch()
  })

  it('老写法 navigator.wallets：先推进数组的、之后 push 的都能注册；注册回调出错不影响其他钱包', async () => {
    stubWindow()
    const { standardWallets } = await import('../src/standard/registry.js')
    const a = phantom().wallet
    const b = fakeStandardWallet({ name: 'Solflare', chain: 'solana:mainnet', address: SOL_ADDRESS }).wallet
    const nav = { wallets: [() => { throw new Error('boom') }, ({ register }: { register(w: unknown): void }) => register(a)] as unknown }
    vi.stubGlobal('navigator', nav)
    expect(standardWallets()).toEqual([a])
    ;(nav.wallets as { push(fn: unknown): void }).push(({ register }: { register(w: unknown): void }) => register(b))
    expect(standardWallets()).toEqual([a, b])
  })
})

describe('Wallet Standard 连接器的边界情况', () => {
  it('签名时原账户已不在钱包里：改用钱包当前的账户；连接没返回账户：unknown，静默恢复时为 null', async () => {
    const win = stubWindow()
    const signed: string[] = []
    const fake = fakeStandardWallet({
      name: 'Phantom',
      chain: 'solana:mainnet',
      address: SOL_ADDRESS,
      features: {
        'solana:signTransaction': {},
        'solana:signMessage': { signMessage: async ({ account }: { account: { address: string } }) => (signed.push(account.address), [{ signature: new Uint8Array([1]) }]) },
      },
    })
    registerStandardWallet(win, fake.wallet)
    const wallet = createWallet({ connectors: [solana()], storage: null, autoConnect: false })
    await wallet.connect('solana', 'Phantom')
    const other = 'Other1111111111111111111111111111111111111'
    fake.wallet.accounts = [{ address: other, chains: ['solana:mainnet'] }]
    await wallet.signMessage('x')
    expect(signed).toEqual([other])

    const empty = fakeStandardWallet({ name: 'Empty', chain: 'solana:mainnet', address: SOL_ADDRESS, features: { 'solana:signTransaction': {} } })
    ;(empty.wallet.features['standard:connect'] as { connect: unknown }).connect = async () => ({ accounts: [] })
    registerStandardWallet(win, empty.wallet)
    expect((await wallet.connect('solana', 'Empty').catch((e) => e)).code).toBe('unknown')
  })
})

describe('Wallet Standard 账户没标明链', () => {
  it('连接时用全部账户；钱包发 change 事件时同样处理，不会误判为断开', async () => {
    const win = stubWindow()
    const fake = fakeStandardWallet({ name: 'Phantom', chain: 'solana:mainnet', address: SOL_ADDRESS, features: { 'solana:signTransaction': {} } })
    ;(fake.wallet.features['standard:connect'] as { connect: unknown }).connect = async () => ({ accounts: [{ address: SOL_ADDRESS, chains: [] }] })
    registerStandardWallet(win, fake.wallet)
    const wallet = createWallet({ connectors: [solana()], storage: null, autoConnect: false })
    await wallet.connect('solana', 'Phantom')
    fake.events.emit('change', { accounts: [{ address: 'Next111111111111111111111111111111111111111', chains: [] }] })
    expect(wallet.getConnection()?.address).toBe('Next111111111111111111111111111111111111111')
  })
})

describe('Wallet Standard 的更多情况', () => {
  const sign = (output: unknown) => ({ 'solana:signTransaction': {}, 'solana:signMessage': { signMessage: async () => output } })

  it('cluster：只列这条链的钱包，chainId 为对应的链；exclude 隐藏；多个已安装的按 known 顺序排', async () => {
    const win = stubWindow()
    registerStandardWallet(win, fakeStandardWallet({ name: 'Solflare', chain: 'solana:devnet', address: SOL_ADDRESS, features: { 'solana:signTransaction': {} } }).wallet)
    registerStandardWallet(win, fakeStandardWallet({ name: 'Phantom', chain: 'solana:devnet', address: SOL_ADDRESS, features: { 'solana:signTransaction': {} } }).wallet)
    registerStandardWallet(win, fakeStandardWallet({ name: 'Mainnet Only', chain: 'solana:mainnet', address: SOL_ADDRESS, features: { 'solana:signTransaction': {} } }).wallet)
    registerStandardWallet(win, fakeStandardWallet({ name: 'Spam', chain: 'solana:devnet', address: SOL_ADDRESS, features: { 'solana:signTransaction': {} } }).wallet)
    const wallet = createWallet({ connectors: [solana({ cluster: 'devnet', exclude: ['Spam'] })], storage: null, autoConnect: false })
    expect(wallet.wallets('solana').filter((w) => w.installed).map((w) => w.id)).toEqual(['Phantom', 'Solflare'])
    expect((await wallet.connect('solana', 'Solflare')).chainId).toBe('solana:devnet')
  })

  it('Solana 签名：钱包返回对象（不是数组）、number[] 的签名都能编码；没有签名：unknown；不支持签消息：unsupported', async () => {
    const win = stubWindow()
    registerStandardWallet(win, fakeStandardWallet({ name: 'A', chain: 'solana:mainnet', address: SOL_ADDRESS, features: sign({ signature: [1, 2, 3] }) }).wallet)
    registerStandardWallet(win, fakeStandardWallet({ name: 'B', chain: 'solana:mainnet', address: SOL_ADDRESS, features: sign([{}]) }).wallet)
    registerStandardWallet(win, fakeStandardWallet({ name: 'C', chain: 'solana:mainnet', address: SOL_ADDRESS, features: { 'solana:signTransaction': {} } }).wallet)
    const wallet = createWallet({ connectors: [solana()], storage: null, autoConnect: false })
    await wallet.connect('solana', 'A')
    expect(await wallet.signMessage('x')).toBe('Ldp')
    await wallet.connect('solana', 'B')
    expect((await wallet.signMessage('x').catch((e) => e)).code).toBe('unknown')
    await wallet.connect('solana', 'C')
    expect((await wallet.signMessage('x').catch((e) => e)).code).toBe('unsupported')
  })

  it('Sui：network 选链；钱包不支持签消息：unsupported；没有签名：unknown', async () => {
    const win = stubWindow()
    const features = { 'sui:signTransaction': {} }
    registerStandardWallet(win, fakeStandardWallet({ name: 'Plain', chain: 'sui:testnet', address: SUI_ADDRESS, features }).wallet)
    registerStandardWallet(win, fakeStandardWallet({ name: 'Empty', chain: 'sui:testnet', address: SUI_ADDRESS, features: { ...features, 'sui:signPersonalMessage': { signPersonalMessage: async () => ({}) } } }).wallet)
    const wallet = createWallet({ connectors: [sui({ network: 'testnet' })], storage: null, autoConnect: false })
    expect((await wallet.connect('sui', 'Plain')).chainId).toBe('sui:testnet')
    expect((await wallet.signMessage('x').catch((e) => e)).code).toBe('unsupported')
    await wallet.connect('sui', 'Empty')
    expect((await wallet.signMessage('x').catch((e) => e)).code).toBe('unknown')
  })

  it('恢复：钱包一直没注册：保留记录；silent 连接抛“用户拒绝”（如 Phantom onlyIfTrusted）：删掉记录', async () => {
    const saved = () => memoryStorage({ 'w3lib:wallet': JSON.stringify({ v: 1, active: 'solana', connections: { solana: { walletId: 'Phantom', address: SOL_ADDRESS, chainId: 'solana:mainnet' } } }) })
    stubWindow()
    const kept = saved()
    const w1 = createWallet({ connectors: [solana({ restoreTimeout: 20 })], storage: kept })
    await w1.restore()
    expect(kept.data.size).toBe(1)

    const win = stubWindow()
    const fake = phantom()
    ;(fake.wallet.features['standard:connect'] as { connect: unknown }).connect = async () => Promise.reject(Object.assign(new Error('User rejected the request.'), { code: 4001 }))
    registerStandardWallet(win, fake.wallet)
    const forgotten = saved()
    const w2 = createWallet({ connectors: [solana()], storage: forgotten })
    await w2.restore()
    expect(forgotten.data.size).toBe(0)
  })

  it('钱包没有 standard:events：照常连接；change 事件只改了链 / 功能（没有 accounts）：不影响连接', async () => {
    const win = stubWindow()
    const quiet = fakeStandardWallet({ name: 'Quiet', chain: 'solana:mainnet', address: SOL_ADDRESS, features: { 'solana:signTransaction': {} } })
    delete quiet.wallet.features['standard:events']
    registerStandardWallet(win, quiet.wallet)
    const fake = phantom()
    registerStandardWallet(win, fake.wallet)
    const wallet = createWallet({ connectors: [solana()], storage: null, autoConnect: false })
    await wallet.connect('solana', 'Quiet')
    await wallet.connect('solana', 'Phantom')
    fake.events.emit('change', { chains: ['solana:mainnet'] })
    expect(wallet.getConnection()?.walletId).toBe('Phantom')
  })
})
