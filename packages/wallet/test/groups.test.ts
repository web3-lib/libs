import { describe, expect, it } from 'vitest'

import { createWallet, groupWallets, walletKey, type Connector, type Namespace, type Session, type WalletInfo } from '../src/index.js'
import { stubWindow } from './fakes.js'

function connector(namespace: Namespace, wallets: Array<Partial<WalletInfo> & { id: string; name: string }>) {
  const c: Connector = {
    namespace,
    wallets: () => wallets.map((w) => ({ namespace, icon: null, type: 'injected' as const, installed: true, downloadUrl: null, ...w })),
    watchWallets: () => () => {},
    connect: async (walletId): Promise<Session> => ({ walletId, walletName: walletId, icon: null, address: `${namespace}:${walletId}`, chainId: null, provider: {}, subscribe: () => () => {}, signMessage: async () => '', disconnect: async () => {} }),
    restore: async () => null,
  }
  return c
}

function setup() {
  stubWindow()
  return createWallet({
    connectors: [
      connector('evm', [
        { id: 'io.metamask', name: 'MetaMask', icon: 'data:mm' },
        { id: 'com.okex.wallet', name: 'OKX Wallet', icon: 'data:okx' },
        { id: 'com.bitget.web3', name: 'Bitget Wallet', installed: false, downloadUrl: 'https://bitget.example' },
        { id: 'walletconnect', name: 'WalletConnect', type: 'qrcode' },
      ]),
      connector('solana', [
        { id: 'Phantom', name: 'Phantom', icon: 'data:ph' },
        { id: 'OKX Wallet', name: 'OKX Wallet' },
        { id: 'Bitget Wallet', name: 'Bitget Wallet', installed: false },
      ]),
      connector('tron', [
        { id: 'okx', name: 'OKX Wallet', installed: false },
        { id: 'tronlink', name: 'TronLink' },
      ]),
    ],
    storage: null,
    autoConnect: false,
    mode: 'multi',
  })
}

describe('按钱包合并（先选钱包，再选链）', () => {
  it('钱包名归一化：大小写、空格、末尾的 Wallet、少数别名', () => {
    expect(['OKX Wallet', 'okx', 'OKX'].map(walletKey)).toEqual(['okx', 'okx', 'okx'])
    expect(['Bitget Wallet', 'BitKeep'].map(walletKey)).toEqual(['bitget', 'bitget'])
    expect(walletKey('Trust Wallet')).toBe('trust')
    expect(walletKey('WalletConnect')).toBe('walletconnect')
    expect(walletKey('Wallet')).toBe('wallet')
    expect(walletKey('某钱包')).toBe('某钱包')
  })

  it('同一个插件在各条链上合成一项：带它出现的链、能连的链；已安装的在前', () => {
    const groups = setup().walletGroups()
    expect(groups.map((g) => [g.id, g.chains, g.installedChains, g.installed])).toEqual([
      ['metamask', ['evm'], ['evm'], true],
      ['okx', ['evm', 'solana', 'tron'], ['evm', 'solana'], true],
      ['walletconnect', ['evm'], ['evm'], true],
      ['phantom', ['solana'], ['solana'], true],
      ['tronlink', ['tron'], ['tron'], true],
      ['bitget', ['evm', 'solana'], [], false],
    ])
    const okx = groups.find((g) => g.id === 'okx')!
    expect(okx).toMatchObject({ name: 'OKX Wallet', icon: 'data:okx', type: 'injected', connected: false })
    expect(okx.wallets.map((w) => w.id)).toEqual(['com.okex.wallet', 'OKX Wallet', 'okx'])
    expect(groups.find((g) => g.id === 'bitget')?.downloadUrl).toBe('https://bitget.example')
  })

  it('connect(namespace) 连指定的链；不传时连第一条能连的链；不支持的链 unsupported；连接后 connected 排在最前', async () => {
    const wallet = setup()
    const okx = () => wallet.walletGroups().find((g) => g.id === 'okx')!
    expect((await okx().connect('solana')).address).toBe('solana:OKX Wallet')
    expect((await okx().connect()).namespace).toBe('evm')
    expect((await okx().connect('sui').catch((e) => e)).code).toBe('unsupported')
    expect(wallet.walletGroups()[0]).toMatchObject({ id: 'okx', connected: true })
  })

  it('按链过滤；watchWalletGroups 连接后更新', async () => {
    const wallet = setup()
    expect(wallet.walletGroups('solana').map((g) => g.id)).toEqual(['phantom', 'okx', 'bitget'])
    let latest = wallet.walletGroups()
    const stop = wallet.watchWalletGroups((next) => (latest = next), ['evm', 'tron'])
    expect(latest.map((g) => g.id)).toEqual(['metamask', 'okx', 'walletconnect', 'tronlink', 'bitget'])
    await wallet.connect('tron', 'tronlink')
    expect(latest[0]).toMatchObject({ id: 'tronlink', connected: true })
    stop()
  })

  it('groupWallets 可以单独用：同一条链上同名的只取第一个', () => {
    const wallet = setup()
    const list = wallet.wallets('evm')
    expect(groupWallets([...list, { ...list[0]!, id: 'dup' }]).find((g) => g.id === 'metamask')?.wallets.map((w) => w.id)).toEqual(['io.metamask'])
  })
})

describe('合并的细节', () => {
  it('没装插件、只有扫码能连时：type 是 qrcode（不显示成“已安装”的插件）', () => {
    stubWindow()
    const wallet = createWallet({
      connectors: [connector('evm', [{ id: 'com.okex.wallet', name: 'OKX Wallet', installed: false }]), connector('ton', [{ id: 'okxTonWallet', name: 'OKX Wallet', type: 'qrcode' }])],
      storage: null,
      autoConnect: false,
    })
    expect(wallet.walletGroups()[0]).toMatchObject({ id: 'okx', installed: true, type: 'qrcode', installedChains: ['ton'] })
  })

  it('换钱包时按钱包合并的列表只更新一次', async () => {
    const wallet = setup()
    await wallet.connect('evm', 'io.metamask')
    let calls = 0
    wallet.watchWalletGroups(() => calls++)
    calls = 0
    await wallet.connect('evm', 'com.okex.wallet')
    expect(calls).toBe(1)
  })
})
