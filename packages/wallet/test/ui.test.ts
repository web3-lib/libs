// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WalletError, createWallet, type Connector, type ConnectOptions, type Namespace, type Session, type WalletInfo } from '../src/index.js'
import { createWalletModal as create, type WalletModal } from '../src/ui/index.js'

/** 记下创建的弹窗：每个测试结束后关掉（页面滚动锁是全局计数的） */
const created: WalletModal[] = []
const createWalletModal = (...args: Parameters<typeof create>) => {
  const modal = create(...args)
  created.push(modal)
  return modal
}

afterEach(() => {
  created.splice(0).forEach((modal) => modal.destroy())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

const flush = () => new Promise((r) => setTimeout(r, 0))

function session(walletId: string, address: string): Session {
  return { walletId, walletName: walletId, icon: null, address, chainId: 1, provider: {}, subscribe: () => () => {}, signMessage: async () => '', disconnect: async () => {} }
}

/** 可控的连接器：每个钱包的连接行为由 behave 决定 */
function connector(namespace: Namespace, wallets: Array<Partial<WalletInfo> & { id: string }>, behave: (id: string, options: ConnectOptions) => Promise<Session>) {
  const c: Connector = {
    namespace,
    wallets: () => wallets.map((w) => ({ namespace, name: w.id, icon: null, type: 'injected' as const, installed: true, downloadUrl: null, ...w })),
    watchWallets: () => () => {},
    connect: (id, options) => behave(id, options),
    restore: async () => null,
  }
  return c
}

function setup() {
  let rejectNext = false
  const scanned: Array<() => void> = []
  const evm = connector(
    'evm',
    [
      { id: 'mm', name: 'MetaMask', icon: 'data:image/png;base64,AA==' },
      { id: 'wc', name: 'WalletConnect', type: 'qrcode' },
      { id: 'missing', name: 'Missing', installed: false, downloadUrl: 'https://download.example' },
      { id: 'evil', name: '<img src=x onerror=alert(1)>' },
    ],
    (id, options) => {
      if (id === 'wc') {
        options.onDisplayUri?.('wc:abc@2?relay-protocol=irn&symKey=1')
        return new Promise((resolve) => scanned.push(() => resolve(session('wc', '0xwc0000000000000000000000000000000000000001'))))
      }
      if (rejectNext) {
        rejectNext = false
        return Promise.reject(Object.assign(new Error('User rejected the request.'), { code: 4001 }))
      }
      return Promise.resolve(session(id, '0xAbC0000000000000000000000000000000000001'))
    },
  )
  const sol = connector('solana', [{ id: 'Phantom' }], async (id) => session(id, 'So1ana'))
  const wallet = createWallet({ connectors: [evm, sol], storage: null, autoConnect: false })
  return { wallet, scanned, rejectNext: () => (rejectNext = true) }
}

const shadow = (modal: { element: HTMLElement | null }) => modal.element!.shadowRoot!
const click = (el: Element | null | undefined) => (el as HTMLElement).click()
const names = (root: ShadowRoot) => Array.from(root.querySelectorAll('.wallet .name')).map((el) => el.textContent)

describe('默认弹窗', () => {
  it('打开：Shadow DOM 里的钱包列表、链标签、徽标；钱包名按文本显示（不当 HTML）', () => {
    const { wallet } = setup()
    const modal = createWalletModal(wallet, { locale: 'zh' })
    void modal.open()
    expect(modal.isOpen).toBe(true)
    const root = shadow(modal)
    expect(root.querySelector('h2')?.textContent).toBe('连接钱包')
    expect(Array.from(root.querySelectorAll('.tab')).map((el) => el.textContent)).toEqual(['EVM', 'Solana'])
    expect(names(root)).toEqual(['MetaMask', 'WalletConnect', 'Missing', '<img src=x onerror=alert(1)>'])
    expect(Array.from(root.querySelectorAll('.badge')).map((el) => el.textContent)).toEqual(['已安装', '扫码', '未安装', '已安装'])
    expect(root.querySelector('.wallet img[src^="x"]')).toBeNull()
    // 样式隔离：页面里只多了一个宿主元素
    expect(document.body.children).toHaveLength(1)
    click(root.querySelectorAll('.tab')[1])
    expect(names(root)).toEqual(['Phantom'])
  })

  it('点击已安装的钱包：显示“请在钱包中确认”，连接成功后 resolve 连接并关闭', async () => {
    const { wallet } = setup()
    const modal = createWalletModal(wallet, { locale: 'zh' })
    const result = modal.open('evm')
    const root = shadow(modal)
    expect(root.querySelector('.tabs')).toBeNull()
    click(root.querySelector('[data-id="mm"]'))
    expect(root.querySelector('.status')?.textContent).toBe('请在 MetaMask 中确认连接')
    expect((await result)?.walletId).toBe('mm')
    expect(modal.isOpen).toBe(false)
    expect(document.body.children).toHaveLength(0)
    expect(wallet.address).toBe('0xAbC0000000000000000000000000000000000001')
  })

  it('扫码钱包：显示二维码和复制按钮；关闭弹窗时取消连接，resolve null', async () => {
    const { wallet, scanned } = setup()
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const modal = createWalletModal(wallet, { locale: 'zh' })
    const result = modal.open('evm')
    const root = shadow(modal)
    click(root.querySelector('[data-id="wc"]'))
    await flush()
    expect(root.querySelector('.qr svg')).not.toBeNull()
    expect(root.querySelector('.status')?.textContent).toBe('使用手机钱包扫码连接')
    click(root.querySelector('.actions .secondary'))
    await flush()
    expect(writeText).toHaveBeenCalledWith('wc:abc@2?relay-protocol=irn&symKey=1')
    expect(root.querySelector('.actions .secondary')?.textContent).toBe('已复制')
    click(root.querySelector('[aria-label="关闭"]'))
    expect(await result).toBeNull()
    // 用户之后扫码同意：连接已取消，不会生效
    scanned[0]?.()
    await flush()
    expect(wallet.connected).toBe(false)
  })

  it('用户拒绝：显示错误和重试；重试成功', async () => {
    const { wallet, rejectNext } = setup()
    const modal = createWalletModal(wallet, { locale: 'zh' })
    const result = modal.open('evm')
    const root = shadow(modal)
    rejectNext()
    click(root.querySelector('[data-id="mm"]'))
    await flush()
    expect(root.querySelector('.status.error')?.textContent).toBe('已取消连接')
    click(root.querySelector('.actions .primary'))
    expect((await result)?.walletId).toBe('mm')
  })

  it('返回按钮：取消正在进行的连接，回到列表', async () => {
    const { wallet } = setup()
    const modal = createWalletModal(wallet, { locale: 'zh' })
    void modal.open('evm')
    const root = shadow(modal)
    click(root.querySelector('[data-id="wc"]'))
    click(root.querySelector('[aria-label="返回"]'))
    expect(names(root)).toHaveLength(4)
    await flush()
    expect(root.querySelector('.status.error')).toBeNull()
  })

  it('没安装的钱包：打开下载页', () => {
    const { wallet } = setup()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const modal = createWalletModal(wallet)
    void modal.open('evm')
    click(shadow(modal).querySelector('[data-id="missing"]'))
    expect(open).toHaveBeenCalledWith('https://download.example', '_blank', 'noopener')
  })

  it('Esc、点遮罩关闭；再次打开是新的弹窗', async () => {
    const { wallet } = setup()
    const modal = createWalletModal(wallet)
    const first = modal.open()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(await first).toBeNull()
    const second = modal.open()
    const backdrop = shadow(modal).querySelector('.backdrop') as HTMLElement
    // 在面板里按下、拖到遮罩上松开：不关闭
    shadow(modal).querySelector('.panel')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(modal.isOpen).toBe(true)
    // 在遮罩上按下、在面板里松开：也不关闭
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    shadow(modal).querySelector('.panel')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(modal.isOpen).toBe(true)
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    backdrop.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(await second).toBeNull()
    expect(modal.isOpen).toBe(false)
  })

  it('主题：默认跟随系统；可以指定浅色 / 深色，也可以随时切换；英文文案；可以覆盖文案', () => {
    const { wallet } = setup()
    const auto = createWalletModal(wallet)
    void auto.open()
    expect(auto.element?.getAttribute('data-theme')).toBe('auto')
    auto.close()

    const modal = createWalletModal(wallet, { theme: 'dark', locale: 'en', texts: { title: 'Sign in' } })
    void modal.open()
    expect(modal.element?.getAttribute('data-theme')).toBe('dark')
    expect(shadow(modal).querySelector('h2')?.textContent).toBe('Sign in')
    expect(shadow(modal).querySelector('.badge')?.textContent).toBe('Installed')
    modal.setTheme('light')
    expect(modal.element?.getAttribute('data-theme')).toBe('light')
    // 两套主题的样式都在
    const css = shadow(modal).querySelector('style')?.textContent ?? ''
    expect(css).toContain(':host([data-theme=dark])')
    expect(css).toContain('prefers-color-scheme:dark')
    modal.destroy()
    expect(document.body.children).toHaveLength(0)
  })

  it('已连接：列表里标“已连接”，底部显示地址，可以断开', async () => {
    const { wallet } = setup()
    await wallet.connect('evm', 'mm')
    const modal = createWalletModal(wallet, { locale: 'zh' })
    void modal.open()
    const root = shadow(modal)
    expect(root.querySelector('[data-id="mm"] .badge')?.textContent).toBe('已连接')
    expect(root.querySelector('footer .address')?.textContent).toBe('0xAbC0…0001')
    click(root.querySelector('footer .link'))
    await flush()
    expect(wallet.connected).toBe(false)
    expect(root.querySelector('footer')).toBeNull()
  })

  it('服务端（没有 document）：open 直接 resolve null', async () => {
    const { wallet } = setup()
    const modal = createWalletModal(wallet)
    vi.stubGlobal('document', undefined)
    expect(await modal.open()).toBeNull()
  })

  it('没有错误码的失败：显示通用的失败文案', async () => {
    const evm = connector('evm', [{ id: 'x' }], () => Promise.reject(new WalletError('unknown', 'boom')))
    const wallet = createWallet({ connectors: [evm], storage: null, autoConnect: false })
    const modal = createWalletModal(wallet, { locale: 'en' })
    void modal.open()
    click(shadow(modal).querySelector('[data-id="x"]'))
    await flush()
    expect(shadow(modal).querySelector('.status.error')?.textContent).toBe('Connection failed, please try again')
  })

  it('各种错误的文案：钱包里已有请求、没检测到钱包；连点两个钱包时前一次的作废不显示错误', async () => {
    let next: () => Promise<Session> = () => Promise.reject(Object.assign(new Error('pending'), { code: -32002 }))
    const evm = connector('evm', [{ id: 'a' }, { id: 'b' }], () => next())
    const wallet = createWallet({ connectors: [evm], storage: null, autoConnect: false })
    const modal = createWalletModal(wallet, { locale: 'zh' })
    void modal.open()
    const root = shadow(modal)
    click(root.querySelector('[data-id="a"]'))
    await flush()
    expect(root.querySelector('.status.error')?.textContent).toBe('钱包里有待处理的请求，请打开钱包查看')

    next = () => Promise.reject(new WalletError('not_installed', 'x'))
    click(root.querySelector('.actions .primary'))
    await flush()
    expect(root.querySelector('.status.error')?.textContent).toBe('没有检测到这个钱包')

    next = () => Promise.reject(new WalletError('superseded', 'x'))
    click(root.querySelector('.actions .primary'))
    await flush()
    expect(root.querySelector('.status.error')).toBeNull()
  })

  it('手机上点没安装的钱包：跳到钱包 App 里打开当前页面；扫码时有“在钱包中打开”', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', language: 'zh-CN' })
    const loc = { href: 'https://dapp.example/', origin: 'https://dapp.example' }
    vi.stubGlobal('location', loc)
    const evm = connector('evm', [{ id: 'io.metamask', name: 'MetaMask', installed: false, downloadUrl: 'https://metamask.io/download' }, { id: 'wc', type: 'qrcode' }], (_, options) => {
      options.onDisplayUri?.('wc:xyz@2')
      return new Promise(() => {})
    })
    const wallet = createWallet({ connectors: [evm], storage: null, autoConnect: false })
    const modal = createWalletModal(wallet)
    void modal.open()
    const root = shadow(modal)
    expect(root.querySelector('h2')?.textContent).toBe('连接钱包')
    click(root.querySelector('[data-id="io.metamask"]'))
    expect(loc.href).toBe('https://link.metamask.io/dapp/dapp.example/')
    click(root.querySelector('[data-id="wc"]'))
    await flush()
    expect(root.querySelector('a.secondary')?.getAttribute('href')).toBe('wc:xyz@2')
  })

  it('只显示配置了的链：没配置的忽略，一条都没有时不打开', async () => {
    const { wallet } = setup()
    const modal = createWalletModal(wallet)
    expect(await modal.open('ton')).toBeNull()
    expect(modal.isOpen).toBe(false)
    expect(document.body.children).toHaveLength(0)
    void modal.open(['ton', 'solana'])
    expect(Array.from(shadow(modal).querySelectorAll('.tab'))).toHaveLength(0)
    expect(names(shadow(modal))).toEqual(['Phantom'])
  })

  it('应用在别处连接了钱包（弹窗这次作废）：不再转圈，弹窗以那个连接结束', async () => {
    let release!: (s: Session) => void
    const evm = connector('evm', [{ id: 'slow' }, { id: 'fast' }], (id) => (id === 'slow' ? new Promise((r) => (release = r)) : Promise.resolve(session('fast', '0xfast'))))
    const wallet = createWallet({ connectors: [evm], storage: null, autoConnect: false })
    const modal = createWalletModal(wallet)
    const result = modal.open()
    click(shadow(modal).querySelector('[data-id="slow"]'))
    await wallet.connect('evm', 'fast')
    release(session('slow', '0xslow'))
    expect((await result)?.walletId).toBe('fast')
  })

  it('键盘：重画后焦点还在同一个按钮上；Tab 在弹窗里循环；关闭后焦点还给打开它的按钮；Esc 不再传给页面', async () => {
    const { wallet } = setup()
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const pageEsc = vi.fn()
    document.addEventListener('keydown', pageEsc)
    const modal = createWalletModal(wallet)
    const result = modal.open('evm')
    const root = shadow(modal)
    ;(root.querySelector('[data-id="mm"]') as HTMLElement).focus()
    await wallet.connect('solana', 'Phantom') // 状态变化 → 重画
    expect((root.activeElement as HTMLElement).getAttribute('data-id')).toBe('mm')

    const buttons = Array.from(root.querySelectorAll<HTMLElement>('button'))
    buttons.at(-1)!.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    buttons.at(-1)!.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(root.activeElement).toBe(buttons[0])

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(await result).toBeNull()
    expect(pageEsc).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(opener)
    document.removeEventListener('keydown', pageEsc)
  })

  it('打开时页面不滚动，关闭后恢复；不安全的链接（javascript:）不打开；复制失败不报错', async () => {
    document.documentElement.style.overflow = 'auto'
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: () => Promise.reject(new Error('denied')) } })
    const evm = connector('evm', [{ id: 'bad', installed: false, downloadUrl: 'javascript:alert(1)' }, { id: 'wc', type: 'qrcode' }], (_, options) => {
      options.onDisplayUri?.('wc:abc@2')
      return new Promise(() => {})
    })
    const wallet = createWallet({ connectors: [evm], storage: null, autoConnect: false })
    const modal = createWalletModal(wallet)
    void modal.open()
    expect(document.documentElement.style.overflow).toBe('hidden')
    click(shadow(modal).querySelector('[data-id="bad"]'))
    expect(open).not.toHaveBeenCalled()
    click(shadow(modal).querySelector('[data-id="wc"]'))
    await flush()
    click(shadow(modal).querySelector('[data-focus="copy"]'))
    await flush()
    expect(shadow(modal).querySelector('[data-focus="copy"]')?.textContent).not.toBe('已复制')
    modal.close()
    expect(document.documentElement.style.overflow).toBe('auto')
  })

  describe('先选钱包，再选链（flow: wallet-first）', () => {
    function multi() {
      const evm = connector('evm', [{ id: 'com.okex.wallet', name: 'OKX Wallet' }, { id: 'io.metamask', name: 'MetaMask' }, { id: 'missing', name: 'Missing', installed: false, downloadUrl: 'https://download.example' }], async (id) => session(id, '0xevm'))
      const sol = connector('solana', [{ id: 'OKX Wallet', name: 'OKX Wallet' }], async (id) => session(id, 'So1'))
      const tronC = connector('tron', [{ id: 'okx', name: 'OKX Wallet', installed: false }], async (id) => session(id, 'T1'))
      return createWallet({ connectors: [evm, sol, tronC], storage: null, autoConnect: false })
    }

    it('列表是合并后的钱包（名字下面写能用的链），没有链的标签', () => {
      const modal = createWalletModal(multi(), { flow: 'wallet-first', locale: 'zh' })
      void modal.open()
      const root = shadow(modal)
      expect(root.querySelector('.tabs')).toBeNull()
      expect(names(root)).toEqual(['OKX Wallet', 'MetaMask', 'Missing'])
      expect(root.querySelector('[data-id="okx"] .chips')?.textContent).toBe('EVM · Solana · Tron')
    })

    it('多链钱包：先选链（没安装的链标“未安装”），再连接；从连接中返回回到选链', async () => {
      const wallet = multi()
      const modal = createWalletModal(wallet, { flow: 'wallet-first', locale: 'zh' })
      const result = modal.open()
      const root = shadow(modal)
      click(root.querySelector('[data-id="okx"]'))
      expect(root.querySelector('.choose .status')?.textContent).toBe('选择网络')
      expect(Array.from(root.querySelectorAll('[data-chain]')).map((el) => [el.getAttribute('data-chain'), el.querySelector('.badge')?.textContent])).toEqual([
        ['evm', '已安装'],
        ['solana', '已安装'],
        ['tron', '未安装'],
      ])
      click(root.querySelector('[data-chain="solana"]'))
      expect(root.querySelector('.status')?.textContent).toBe('请在 OKX Wallet 中确认连接')
      click(root.querySelector('[aria-label="返回"]'))
      expect(root.querySelector('.choose')).not.toBeNull()
      click(root.querySelector('[data-chain="solana"]'))
      expect(await result).toMatchObject({ namespace: 'solana', address: 'So1' })
    })

    it('只有一条链能连的钱包：直接连接；没安装的：打开下载页；选链页的返回回到列表', async () => {
      const wallet = multi()
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      const modal = createWalletModal(wallet, { flow: 'wallet-first' })
      const result = modal.open()
      const root = shadow(modal)
      click(root.querySelector('[data-id="missing"]'))
      expect(open).toHaveBeenCalledWith('https://download.example', '_blank', 'noopener')
      click(root.querySelector('[data-id="okx"]'))
      click(root.querySelector('[data-focus="back"]'))
      expect(names(root)).toHaveLength(3)
      click(root.querySelector('[data-id="metamask"]'))
      expect((await result)?.walletId).toBe('io.metamask')
    })

    it('open 时可以临时换选择方式；连接后再打开，已连接的钱包排在最前、标“已连接”', async () => {
      const wallet = multi()
      const modal = createWalletModal(wallet, { locale: 'zh' })
      void modal.open({ flow: 'wallet-first', chains: ['evm'] })
      expect(names(shadow(modal))).toEqual(['OKX Wallet', 'MetaMask', 'Missing'])
      modal.close()
      void modal.open()
      expect(shadow(modal).querySelector('.tabs')).not.toBeNull()
      modal.close()
      await wallet.connect('evm', 'io.metamask')
      void modal.open({ flow: 'wallet-first' })
      expect(names(shadow(modal))[0]).toBe('MetaMask')
      expect(shadow(modal).querySelector('[data-id="metamask"] .badge')?.textContent).toBe('已连接')
    })
  })

  it('两个弹窗：Esc 只关最上面的；都关掉后页面滚动才恢复', async () => {
    const { wallet } = setup()
    document.documentElement.style.overflow = 'auto'
    const a = createWalletModal(wallet)
    const b = createWalletModal(wallet)
    const first = a.open()
    void b.open()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect([a.isOpen, b.isOpen]).toEqual([true, false])
    expect(document.documentElement.style.overflow).toBe('hidden')
    a.close()
    expect(await first).toBeNull()
    expect(document.documentElement.style.overflow).toBe('auto')
  })

  it('SDK 自己弹扫码窗口的钱包（sdkModal）：连接时隐藏自带弹窗，不画二维码；失败时再显示出来', async () => {
    let reject!: (err: unknown) => void
    const seen: Array<ConnectOptions> = []
    const evm = connector('evm', [{ id: 'wc', type: 'qrcode', sdkModal: true }], (_, options) => {
      seen.push(options)
      return new Promise((_, r) => (reject = r))
    })
    const wallet = createWallet({ connectors: [evm], storage: null, autoConnect: false })
    const modal = createWalletModal(wallet, { locale: 'zh' })
    void modal.open()
    click(shadow(modal).querySelector('[data-id="wc"]'))
    expect(modal.element?.style.display).toBe('none')
    expect(seen[0]?.onDisplayUri).toBeUndefined()
    reject(Object.assign(new Error('User rejected'), { code: 4001 }))
    await flush()
    expect(modal.element?.style.display).toBe('')
    expect(shadow(modal).querySelector('.status.error')?.textContent).toBe('已取消连接')
  })

  it("'multi' 模式下底部显示当前标签那条链的连接，断开只断那条链", async () => {
    const evm = connector('evm', [{ id: 'mm' }], async (id) => session(id, '0xAbC0000000000000000000000000000000000001'))
    const sol = connector('solana', [{ id: 'ph' }], async (id) => session(id, 'So1anaAddress11111'))
    const wallet = createWallet({ connectors: [evm, sol], storage: null, autoConnect: false, mode: 'multi' })
    await wallet.connect('evm', 'mm')
    await wallet.connect('solana', 'ph')
    const modal = createWalletModal(wallet)
    void modal.open()
    const root = shadow(modal)
    expect(root.querySelector('footer .address')?.textContent).toBe('So1ana…1111')
    click(root.querySelector('[data-focus="tab:evm"]'))
    expect(root.querySelector('footer .address')?.textContent).toBe('0xAbC0…0001')
    click(root.querySelector('footer .link'))
    await flush()
    expect(Object.keys(wallet.getState().connections)).toEqual(['solana'])
  })

  it('SDK 自己的扫码窗口开着时（自带弹窗藏起来了），Esc 留给那个窗口', () => {
    const evm = connector('evm', [{ id: 'wc', type: 'qrcode', sdkModal: true }], () => new Promise(() => {}))
    const wallet = createWallet({ connectors: [evm], storage: null, autoConnect: false })
    const modal = createWalletModal(wallet)
    void modal.open()
    click(shadow(modal).querySelector('[data-id="wc"]'))
    const sdkEsc = vi.fn()
    window.addEventListener('keydown', sdkEsc)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(modal.isOpen).toBe(true)
    expect(sdkEsc).toHaveBeenCalled()
    window.removeEventListener('keydown', sdkEsc)
  })

  it('先选钱包：只有扫码能连、别的链插件没装时，先列出所有链让用户选', () => {
    const evm = connector('evm', [{ id: 'com.okex.wallet', name: 'OKX Wallet', installed: false, downloadUrl: 'https://okx.example' }], () => new Promise(() => {}))
    const tonC = connector('ton', [{ id: 'okxTon', name: 'OKX Wallet', type: 'qrcode' }], () => new Promise(() => {}))
    const wallet = createWallet({ connectors: [evm, tonC], storage: null, autoConnect: false })
    const modal = createWalletModal(wallet, { flow: 'wallet-first' })
    void modal.open()
    click(shadow(modal).querySelector('[data-id="okx"]'))
    expect(Array.from(shadow(modal).querySelectorAll('[data-chain]')).map((el) => el.getAttribute('data-chain'))).toEqual(['evm', 'ton'])
  })

  it('先选钱包：连接中别处连上了这个钱包的另一条链，返回选链页时状态是新的', async () => {
    const evm = connector('evm', [{ id: 'okx-evm', name: 'OKX Wallet' }], async (id) => session(id, '0xevm'))
    const sol = connector('solana', [{ id: 'okx-sol', name: 'OKX Wallet' }], () => new Promise(() => {}))
    const wallet = createWallet({ connectors: [evm, sol], storage: null, autoConnect: false, mode: 'multi' })
    const modal = createWalletModal(wallet, { flow: 'wallet-first', locale: 'zh' })
    void modal.open()
    const root = shadow(modal)
    click(root.querySelector('[data-id="okx"]'))
    click(root.querySelector('[data-chain="solana"]'))
    await wallet.connect('evm', 'okx-evm')
    click(root.querySelector('[data-focus="back"]'))
    expect(root.querySelector('[data-chain="evm"] .badge')?.textContent).toBe('已连接')
  })
})
