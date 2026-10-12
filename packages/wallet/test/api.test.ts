import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWallet, type WalletOption } from '../src/index.js'
import { evm } from '../src/evm/index.js'
import { solana } from '../src/solana/index.js'
import { FakeEvmProvider, announce, fakeStandardWallet, fakeWalletConnect, memoryStorage, registerStandardWallet, stubWindow } from './fakes.js'

afterEach(() => vi.unstubAllGlobals())

const ADDRESS = '0xAbC0000000000000000000000000000000000001'
const SOL_ADDRESS = 'So1anaAddress1111111111111111111111111111111'

function setup() {
  const win = stubWindow()
  const metamask = new FakeEvmProvider()
  announce(win, metamask, { rdns: 'io.metamask', name: 'MetaMask' })
  const phantom = fakeStandardWallet({ name: 'Phantom', chain: 'solana:mainnet', address: SOL_ADDRESS, features: { 'solana:signTransaction': {} } })
  registerStandardWallet(win, phantom.wallet)
  const wallet = createWallet({ mode: 'multi', connectors: [evm({ known: [] }), solana({ known: [] })], storage: memoryStorage(), autoConnect: false })
  return { win, metamask, phantom, wallet }
}

describe('当前地址', () => {
  it('state.address / state.connection / wallet.address 跟着连接、切换账户、setActive、断开变化', async () => {
    const { wallet, metamask } = setup()
    expect([wallet.address, wallet.connection, wallet.getState().address]).toEqual([null, null, null])

    await wallet.connect('evm', 'io.metamask')
    expect(wallet.address).toBe(ADDRESS)
    expect(wallet.getState()).toMatchObject({ address: ADDRESS, connection: { walletId: 'io.metamask', chainId: 1 } })

    metamask.emit('accountsChanged', ['0x0000000000000000000000000000000000000002'])
    expect(wallet.address).toBe('0x0000000000000000000000000000000000000002')

    await wallet.connect('solana', 'Phantom')
    expect(wallet.address).toBe(SOL_ADDRESS)
    wallet.setActive('evm')
    expect(wallet.getState().address).toBe('0x0000000000000000000000000000000000000002')

    await wallet.disconnect('evm')
    // 当前钱包断开后换成另一条链的
    expect(wallet.address).toBe(SOL_ADDRESS)
    await wallet.disconnect()
    expect([wallet.address, wallet.connection]).toEqual([null, null])
  })

  it('getAddress 按链取地址，默认当前钱包', async () => {
    const { wallet } = setup()
    await wallet.connect('evm', 'io.metamask')
    await wallet.connect('solana', 'Phantom')
    expect(wallet.getAddress()).toBe(SOL_ADDRESS)
    expect(wallet.getAddress('evm')).toBe(ADDRESS)
    expect(wallet.getAddress('tron')).toBeNull()
  })
})

describe('钱包列表：选择和连接', () => {
  it('每项带 connected 和 connect()；也可以把列表项直接传给 connect()', async () => {
    const { wallet } = setup()
    const metamask = wallet.wallets('evm').find((w) => w.id === 'io.metamask')!
    expect(metamask).toMatchObject({ namespace: 'evm', name: 'MetaMask', installed: true, connected: false })
    expect((await metamask.connect()).address).toBe(ADDRESS)
    expect(wallet.wallets('evm').find((w) => w.id === 'io.metamask')?.connected).toBe(true)

    const phantom = wallet.wallets('solana')[0]!
    expect((await wallet.connect(phantom)).walletId).toBe('Phantom')
    expect(wallet.getState().active).toBe('solana')
  })

  it('按链过滤：一条链、几条链、不传为全部；没配置的链抛 unsupported', () => {
    const { wallet } = setup()
    expect(new Set(wallet.wallets().map((w) => w.namespace))).toEqual(new Set(['evm', 'solana']))
    expect(wallet.wallets('solana').map((w) => w.id)).toEqual(['Phantom'])
    expect(wallet.wallets(['solana', 'evm']).map((w) => w.namespace)).toEqual(['solana', 'evm'])
    expect(() => wallet.wallets('tron')).toThrow('No connector configured for tron')
  })

  it('watchWallets：立即调用一次；钱包晚注入、连接 / 断开时再调用；只关心过滤的链；取消后不再调用', async () => {
    const { win, wallet } = setup()
    const calls: WalletOption[][] = []
    const stop = wallet.watchWallets((list) => calls.push(list), 'evm')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.map((w) => w.id)).toEqual(['io.metamask'])

    announce(win, new FakeEvmProvider(), { rdns: 'io.rabby', name: 'Rabby Wallet' })
    expect(calls.at(-1)!.map((w) => w.id)).toEqual(['io.metamask', 'io.rabby'])

    await wallet.connect('evm', 'io.metamask')
    expect(calls.at(-1)!.find((w) => w.id === 'io.metamask')?.connected).toBe(true)

    // 别的链的变化不通知
    const before = calls.length
    await wallet.connect('solana', 'Phantom')
    expect(calls).toHaveLength(before)

    await wallet.disconnect('evm')
    expect(calls.at(-1)!.every((w) => !w.connected)).toBe(true)

    stop()
    announce(win, new FakeEvmProvider(), { rdns: 'com.okex.wallet', name: 'OKX Wallet' })
    expect(calls.at(-1)!.map((w) => w.id)).not.toContain('com.okex.wallet')
  })

  it('watchWallets 监听几条链 / 全部链', async () => {
    const { wallet } = setup()
    const both: string[][] = []
    wallet.watchWallets((list) => both.push(list.map((w) => `${w.namespace}:${w.id}:${w.connected}`)))
    await wallet.connect('solana', 'Phantom')
    expect(both.at(-1)).toEqual(['evm:io.metamask:false', 'solana:Phantom:true'])
  })
})

describe('默认 single 模式', () => {
  function single() {
    const win = stubWindow()
    announce(win, new FakeEvmProvider(), { rdns: 'io.metamask', name: 'MetaMask' })
    registerStandardWallet(win, fakeStandardWallet({ name: 'Phantom', chain: 'solana:mainnet', address: SOL_ADDRESS, features: { 'solana:signTransaction': {} } }).wallet)
    return { win, wallet: createWallet({ connectors: [evm({ known: [] }), solana({ known: [] })], storage: memoryStorage(), autoConnect: false }) }
  }

  it('换到另一条链的钱包：原来的断开；中间没有“没有连接”的状态（订阅者不会误以为退出了）', async () => {
    const { wallet } = single()
    await wallet.connect('evm', 'io.metamask')
    const seen: Array<[string, string | null]> = []
    wallet.subscribe((state, event) => seen.push([event.type, state.address]))
    await wallet.connect('solana', 'Phantom')
    // 旧钱包的 disconnect（replaced）在 connect 之前，但看到的已经是新钱包的状态
    expect(seen).toEqual([
      ['disconnect', SOL_ADDRESS],
      ['connect', SOL_ADDRESS],
      ['activeChanged', SOL_ADDRESS],
    ])
    expect(Object.keys(wallet.getState().connections)).toEqual(['solana'])
    expect(wallet.getAddress('evm')).toBeNull()
  })

  it('watchWallets 看全部链：一次换钱包后列表里只有新钱包是 connected', async () => {
    const { wallet } = single()
    await wallet.connect('evm', 'io.metamask')
    let last: WalletOption[] = []
    wallet.watchWallets((list) => (last = list))
    await wallet.connect('solana', 'Phantom')
    expect(last.filter((w) => w.connected).map((w) => w.id)).toEqual(['Phantom'])
  })
})

describe('边界情况', () => {
  it('watchWallets 首次调用就抛错：抛给调用方，不留下订阅', () => {
    const { win, wallet } = setup()
    let calls = 0
    expect(() =>
      wallet.watchWallets(() => {
        calls++
        throw new Error('render failed')
      }),
    ).toThrow('render failed')
    announce(win, new FakeEvmProvider(), { rdns: 'io.rabby', name: 'Rabby Wallet' })
    expect(calls).toBe(1)
  })

  it('autoConnect: false 时手动 restore：发 restoring 事件，状态先变成 restoring', async () => {
    stubWindow()
    const wallet = createWallet({ connectors: [evm()], storage: memoryStorage(), autoConnect: false })
    const seen: string[] = []
    wallet.subscribe((state, event) => seen.push(`${event.type}:${state.status}`))
    await wallet.restore()
    expect(seen).toEqual(['restoring:restoring', 'restored:ready'])
  })

  it('重复的连接器：抛 WalletError', () => {
    stubWindow()
    expect(() => createWallet({ connectors: [evm(), evm()], storage: null })).toThrow(expect.objectContaining({ code: 'unsupported' }))
  })

  it('钱包每次被请求都公告一个新 provider：watchWallets 里列钱包不会无限递归', () => {
    const win = stubWindow()
    win.addEventListener('eip6963:requestProvider', () => {
      win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'x', name: 'Noisy', icon: '', rdns: 'xyz.noisy' }, provider: new FakeEvmProvider() } }))
    })
    const wallet = createWallet({ connectors: [evm({ known: [] })], storage: null, autoConnect: false })
    let calls = 0
    wallet.watchWallets(() => calls++)
    // 订阅之后再列一次：钱包公告 → walletsChanged → 监听里又列钱包 → 又请求…
    wallet.wallets('evm')
    expect(calls).toBeLessThan(5)
    expect(wallet.wallets('evm').map((w) => w.id)).toEqual(['xyz.noisy'])
  })
})

describe('ready / connected / chainId / on', () => {
  it('await ready 等恢复完成；没有要恢复的时已经完成', async () => {
    const win = stubWindow()
    announce(win, new FakeEvmProvider({ authorized: true }), { rdns: 'io.metamask', name: 'MetaMask' })
    const storage = memoryStorage({ 'w3lib:wallet': JSON.stringify({ v: 1, active: 'evm', connections: { evm: { walletId: 'io.metamask', address: ADDRESS, chainId: 1 } } }) })
    const wallet = createWallet({ connectors: [evm()], storage })
    expect(wallet.connected).toBe(false)
    await wallet.ready
    expect([wallet.connected, wallet.address, wallet.chainId]).toEqual([true, ADDRESS, 1])

    const manual = createWallet({ connectors: [evm()], storage: null, autoConnect: false })
    let resolved = false
    void manual.ready.then(() => (resolved = true))
    await Promise.resolve()
    expect(resolved).toBe(true)
  })

  it('on 只收到指定类型的事件，参数是对应的事件和状态；返回取消函数', async () => {
    const { wallet, metamask } = setup()
    const accounts: string[] = []
    const chains: unknown[] = []
    const off = wallet.on('accountChanged', (event, state) => accounts.push(`${event.address}|${state.address}`))
    wallet.on('chainChanged', (event) => chains.push(event.chainId))
    await wallet.connect('evm', 'io.metamask')
    metamask.emit('accountsChanged', ['0x0000000000000000000000000000000000000002'])
    metamask.emit('chainChanged', '0x38')
    off()
    metamask.emit('accountsChanged', ['0x0000000000000000000000000000000000000003'])
    expect(accounts).toEqual(['0x0000000000000000000000000000000000000002|0x0000000000000000000000000000000000000002'])
    expect(chains).toEqual([56])
    expect(wallet.chainId).toBe(56)
  })

  it('连接时传 onDisplayUri：WalletConnect 不用在配置里写', async () => {
    stubWindow()
    const wc = fakeWalletConnect()
    const wallet = createWallet({ connectors: [evm({ walletConnect: { projectId: 'p', load: wc.load } })], storage: null, autoConnect: false })
    const uris: string[] = []
    const item = wallet.wallets('evm').find((w) => w.id === 'walletconnect')!
    await item.connect({ onDisplayUri: (uri) => uris.push(uri) })
    expect(uris).toEqual(['wc:abc@2?relay-protocol=irn&symKey=1'])
  })
})
