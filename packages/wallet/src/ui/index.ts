import type { WalletManager } from '../core/manager.js'
import { isMobileBrowser, openInWalletUrl, type DeepLinkWallet } from '../core/mobile.js'
import type { WalletGroup } from '../core/groups.js'
import type { Connection, Namespace, WalletOption } from '../core/types.js'
import { qrSvg } from './qr.js'
import { STYLES } from './styles.js'

export type WalletModalTheme = 'light' | 'dark' | 'auto'

export interface WalletModalTexts {
  title: string
  /** “先选钱包”时，多链钱包的选链页标题 */
  chooseChain: string
  connected: string
  installed: string
  qrcode: string
  notInstalled: string
  empty: string
  confirm: (wallet: string) => string
  scan: string
  copy: string
  copied: string
  openInWallet: string
  retry: string
  back: string
  close: string
  disconnect: string
  rejected: string
  pending: string
  notFound: string
  failed: string
}

/**
 * - 'chain-first'：先选链，再选钱包（多条链时顶部是链的标签，下面是这条链的钱包）
 * - 'wallet-first'：先选钱包，再选链（同一个插件在各条链上合成一项；只有一条链能连时直接连，否则再选链）
 */
export type WalletModalFlow = 'chain-first' | 'wallet-first'

export interface WalletModalOptions {
  /** 显示哪些链，默认 createWallet 里配置了的全部 */
  chains?: readonly Namespace[]
  /** 选择方式：'chain-first' 先选链再选钱包（默认），'wallet-first' 先选钱包再选链 */
  flow?: WalletModalFlow
  /** 主题：'light' 浅色、'dark' 深色、'auto' 跟随系统（默认） */
  theme?: WalletModalTheme
  /** 语言，默认按浏览器语言（中文为 'zh'，其他为 'en'） */
  locale?: 'zh' | 'en'
  /** 覆盖部分文案 */
  texts?: Partial<WalletModalTexts>
  /** 链标签的显示名，默认 EVM、Solana、Tron、Sui、TON */
  chainLabels?: Partial<Record<Namespace, string>>
  /** 弹窗的 z-index，默认 2147483000 */
  zIndex?: number
  /** 挂在哪个元素下，默认 document.body */
  container?: HTMLElement
}

export interface WalletModal {
  /**
   * 打开弹窗。用户连接成功后 resolve 为连接，关闭弹窗时 resolve 为 null（不会 reject）。
   * 可以只显示某些链：open('evm')、open(['evm', 'solana'])；也可以这次换一种选择方式：open({ chains, flow: 'wallet-first' })
   */
  open(target?: Namespace | readonly Namespace[] | { chains?: readonly Namespace[]; flow?: WalletModalFlow }): Promise<Connection | null>
  close(): void
  readonly isOpen: boolean
  /** 切换主题 */
  setTheme(theme: WalletModalTheme): void
  /** 弹窗的宿主元素（样式在它的 Shadow DOM 里，不影响页面） */
  readonly element: HTMLElement | null
  /** 关闭并移除元素 */
  destroy(): void
}

const TEXTS: Record<'zh' | 'en', WalletModalTexts> = {
  zh: {
    title: '连接钱包',
    chooseChain: '选择网络',
    connected: '已连接',
    installed: '已安装',
    qrcode: '扫码',
    notInstalled: '未安装',
    empty: '没有可用的钱包',
    confirm: (wallet) => `请在 ${wallet} 中确认连接`,
    scan: '使用手机钱包扫码连接',
    copy: '复制链接',
    copied: '已复制',
    openInWallet: '在钱包中打开',
    retry: '重试',
    back: '返回',
    close: '关闭',
    disconnect: '断开',
    rejected: '已取消连接',
    pending: '钱包里有待处理的请求，请打开钱包查看',
    notFound: '没有检测到这个钱包',
    failed: '连接失败，请重试',
  },
  en: {
    title: 'Connect a wallet',
    chooseChain: 'Choose a network',
    connected: 'Connected',
    installed: 'Installed',
    qrcode: 'Scan',
    notInstalled: 'Not installed',
    empty: 'No wallets available',
    confirm: (wallet) => `Confirm the connection in ${wallet}`,
    scan: 'Scan with your mobile wallet',
    copy: 'Copy link',
    copied: 'Copied',
    openInWallet: 'Open in wallet',
    retry: 'Try again',
    back: 'Back',
    close: 'Close',
    disconnect: 'Disconnect',
    rejected: 'Connection cancelled',
    pending: 'A request is pending in your wallet, open it to continue',
    notFound: 'Wallet not detected',
    failed: 'Connection failed, please try again',
  },
}

const CHAIN_LABELS: Record<Namespace, string> = { evm: 'EVM', solana: 'Solana', tron: 'Tron', sui: 'Sui', ton: 'TON' }

/** 没安装时在手机上可以“在钱包 App 里打开当前页面”的钱包 */
const DEEP_LINKS: Record<string, DeepLinkWallet> = {
  'evm:io.metamask': 'metamask',
  'evm:com.okex.wallet': 'okx',
  'evm:com.bitget.web3': 'bitget',
  'evm:com.trustwallet.app': 'trust',
  'evm:com.coinbase.wallet': 'coinbase',
  'evm:pro.tokenpocket': 'tokenpocket',
  'solana:Phantom': 'phantom',
  'solana:Solflare': 'solflare',
  'solana:OKX Wallet': 'okx',
  'solana:Bitget Wallet': 'bitget',
  'tron:tronlink': 'tronlink',
  'tron:okx': 'okx',
  'tron:bitget': 'bitget',
  'tron:tokenpocket': 'tokenpocket',
}

/** list：钱包列表（先选链时按链的标签，先选钱包时是合并后的钱包）；chains：多链钱包选链；connecting：连接中（from 是返回到哪） */
type View =
  | { kind: 'list' }
  | { kind: 'chains'; group: WalletGroup }
  | { kind: 'connecting'; item: WalletOption; uri: string | null; error: string | null; copied: boolean; from: View }

const CLOSE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
const BACK_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>'

/** Shadow DOM 里有焦点的元素（个别环境读 activeElement 会抛错：当作没有） */
function activeIn(root: ShadowRoot): HTMLElement | null {
  try {
    return root.activeElement as HTMLElement | null
  } catch {
    return null
  }
}

/** 打开着的弹窗（Esc 只关最上面的） */
const openModals: object[] = []
/** 页面滚动锁：多个弹窗共用，最后一个关闭时恢复 */
let scrollLocks = 0
let savedScroll: { overflow: string; paddingRight: string } | null = null

function lockScroll() {
  if (scrollLocks++ > 0) return
  const html = document.documentElement
  savedScroll = { overflow: html.style.overflow, paddingRight: html.style.paddingRight }
  // 滚动条消失时补上它的宽度，页面不左右跳（页面已经用 scrollbar-gutter: stable 预留了位置时不用补）
  const gap = (typeof innerWidth === 'number' ? innerWidth : 0) - html.clientWidth
  const computed = getComputedStyle(html)
  html.style.overflow = 'hidden'
  if (gap > 0 && !/stable/.test(computed.getPropertyValue('scrollbar-gutter'))) {
    html.style.paddingRight = `${(Number.parseFloat(computed.paddingRight) || 0) + gap}px`
  }
}

function unlockScroll() {
  if (--scrollLocks > 0 || !savedScroll) return
  const html = document.documentElement
  html.style.overflow = savedScroll.overflow
  html.style.paddingRight = savedScroll.paddingRight
  savedScroll = null
}

/**
 * 默认的连接钱包弹窗（可选，不引用就不会打包）。不依赖任何框架和第三方库，自带浅色 / 深色主题和二维码。
 *
 * ```ts
 * import { createWalletModal } from '@w3lib/wallet/ui'
 *
 * const modal = createWalletModal(wallet, { theme: 'dark' })
 * button.onclick = async () => {
 *   const connection = await modal.open()      // 连接成功返回连接，关闭返回 null
 * }
 * ```
 */
export function createWalletModal(wallet: WalletManager, options: WalletModalOptions = {}): WalletModal {
  const locale = options.locale ?? (typeof navigator !== 'undefined' && /^zh/i.test(navigator.language) ? 'zh' : 'en')
  const t: WalletModalTexts = { ...TEXTS[locale], ...options.texts }
  const labels = { ...CHAIN_LABELS, ...options.chainLabels }
  let theme: WalletModalTheme = options.theme ?? 'auto'

  let host: HTMLElement | null = null
  let root: ShadowRoot | null = null
  let panel: HTMLElement | null = null
  let opened = false
  let chains: Namespace[] = []
  let tab: Namespace | null = null
  let view: View = { kind: 'list' }
  let list: WalletOption[] = []
  let groups: WalletGroup[] = []
  let flow: WalletModalFlow = options.flow ?? 'chain-first'
  let pending: AbortController | null = null
  let settle: ((connection: Connection | null) => void) | null = null
  let cleanup: Array<() => void> = []
  let unwatchList: (() => void) | null = null
  /** 打开前有焦点的元素：关闭时还给它 */
  let opener: Element | null = null

  // ---- DOM 小工具（文本一律用 textContent：钱包名来自插件，不能当 HTML） ----
  const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string | boolean | ((event: Event) => void)> = {}, ...children: Array<Node | string | null>): HTMLElementTagNameMap[K] => {
    const el = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === 'function') el.addEventListener(key, value)
      else if (value === true) el.setAttribute(key, '')
      else if (value !== false) el.setAttribute(key, value)
    }
    for (const child of children) if (child !== null) el.append(child)
    return el
  }
  const svg = (markup: string) => {
    const span = h('span', { class: 'svg', 'aria-hidden': 'true' })
    span.innerHTML = markup // 只用于自己生成的 SVG
    return span
  }
  const avatar = (item: { name: string; icon: string | null }, large = false) => {
    if (item.icon) return h('img', { class: large ? 'icon large' : 'icon', src: item.icon, alt: '' })
    return h('span', { class: large ? 'icon large letter' : 'icon letter', 'aria-hidden': 'true' }, item.name.slice(0, 1).toUpperCase())
  }

  /** 只放行 http(s) 的链接（下载地址来自远程的钱包列表），扫码链接再允许钱包自己的协议，挡掉 javascript: / data: */
  const safeUrl = (url: string | null, web = true) => {
    if (!url) return null
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
    if (!scheme) return null
    if (web) return scheme === 'https' || scheme === 'http' ? url : null
    return scheme === 'javascript' || scheme === 'data' || scheme === 'vbscript' ? null : url
  }

  // ---- 状态 ----

  const watchTab = () => {
    unwatchList?.()
    if (flow === 'wallet-first') {
      unwatchList = wallet.watchWalletGroups((next) => {
        groups = next
        // 选链页里的钱包也换成最新的（连接状态、安装状态可能变了）
        const refresh = (v: View): View => {
          if (v.kind !== 'chains') return v
          const fresh = next.find((g) => g.id === v.group.id)
          return fresh ? { kind: 'chains', group: fresh } : { kind: 'list' }
        }
        // 连接中时也更新“返回”要回到的选链页
        view = view.kind === 'connecting' ? { ...view, from: refresh(view.from) } : refresh(view)
        if (view.kind !== 'connecting') render()
      }, chains)
      return
    }
    unwatchList = tab ? wallet.watchWallets((next) => {
      list = next
      if (view.kind === 'list') render()
    }, tab) : null
  }

  const errorText = (err: unknown): string | null => {
    switch ((err as { code?: string } | null)?.code) {
      case 'superseded':
        return null
      case 'user_rejected':
        return t.rejected
      case 'pending_request':
        return t.pending
      case 'not_installed':
        return t.notFound
      default:
        return t.failed
    }
  }

  const connect = async (item: WalletOption, from: View = view.kind === 'connecting' ? view.from : view) => {
    pending?.abort()
    const controller = new AbortController()
    pending = controller
    view = { kind: 'connecting', item, uri: null, error: null, copied: false, from }
    render()
    // SDK 自己弹扫码窗口的钱包：先把这个弹窗藏起来，不挡住它（连接失败时再显示出来）
    if (item.sdkModal && host) host.style.display = 'none'
    try {
      const connection = await item.connect({
        signal: controller.signal,
        ...(item.sdkModal
          ? {}
          : {
              onDisplayUri: (uri: string) => {
                if (pending !== controller || view.kind !== 'connecting') return
                view = { ...view, uri, copied: false }
                render()
              },
            }),
      })
      if (pending !== controller) return
      pending = null
      finish(connection)
    } catch (err) {
      if (pending !== controller || view.kind !== 'connecting') return
      pending = null
      if (host) host.style.display = ''
      const message = errorText(err)
      if (message === null) {
        // 应用在别处连接了钱包（这次作废）：已经有连接就当作完成，否则回到列表
        if (wallet.connection) finish(wallet.connection)
        else back()
        return
      }
      view = { ...view, error: message }
      render()
    }
  }

  const select = (item: WalletOption) => {
    if (item.installed) {
      void connect(item)
      return
    }
    const deepLink = DEEP_LINKS[`${item.namespace}:${item.id}`]
    if (deepLink && isMobileBrowser()) {
      location.href = openInWalletUrl(deepLink)
      return
    }
    const url = safeUrl(item.downloadUrl)
    if (url) window.open(url, '_blank', 'noopener')
  }

  /** 先选钱包：没安装 → 下载 / 跳 App；只有一条链能连 → 直接连；否则去选链 */
  const selectGroup = (group: WalletGroup) => {
    const usable = group.wallets.filter((w) => w.installed)
    if (!usable.length) return select(group.wallets[0] as WalletOption)
    // 只有一条链能连就直接连；但如果那是扫码、而别的链上插件没装，让用户看到全部的链再选（可能想装插件）
    const only = usable[0] as WalletOption
    if (usable.length === 1 && !(only.type === 'qrcode' && group.wallets.length > 1)) return void connect(only, { kind: 'list' })
    view = { kind: 'chains', group }
    render()
  }

  const back = () => {
    pending?.abort()
    pending = null
    view = view.kind === 'connecting' ? view.from : { kind: 'list' }
    render()
  }

  const finish = (connection: Connection | null) => {
    const done = settle
    settle = null
    close()
    done?.(connection)
  }

  // ---- 渲染 ----

  const header = () => {
    const left = view.kind !== 'list' ? h('button', { class: 'icon-button', type: 'button', 'aria-label': t.back, 'data-focus': 'back', click: back }, svg(BACK_ICON)) : h('span', { class: 'spacer' })
    return h('header', {}, left, h('h2', { id: 'w3w-title' }, t.title), h('button', { class: 'icon-button', type: 'button', 'aria-label': t.close, 'data-focus': 'close', click: () => finish(null) }, svg(CLOSE_ICON)))
  }

  const tabs = () => {
    if (flow !== 'chain-first' || chains.length < 2 || view.kind !== 'list') return null
    return h(
      'nav',
      { class: 'tabs', role: 'tablist' },
      ...chains.map((namespace) =>
        h('button', {
          type: 'button',
          role: 'tab',
          class: namespace === tab ? 'tab active' : 'tab',
          'aria-selected': String(namespace === tab),
          'data-focus': `tab:${namespace}`,
          click: () => {
            tab = namespace
            watchTab()
            render()
          },
        }, labels[namespace]),
      ),
    )
  }

  const badgeOf = (item: { connected: boolean; installed: boolean; type: 'injected' | 'qrcode' }) =>
    item.connected ? h('span', { class: 'badge connected' }, t.connected) : !item.installed ? h('span', { class: 'badge muted' }, t.notInstalled) : item.type === 'qrcode' ? h('span', { class: 'badge muted' }, t.qrcode) : h('span', { class: 'badge' }, t.installed)

  /** 先选钱包：合并后的钱包，名字下面写它能用的链 */
  const groupsView = () => {
    if (!groups.length) return h('p', { class: 'empty' }, t.empty)
    return h(
      'ul',
      { class: 'wallets' },
      ...groups.map((group) => {
        // 写出这个钱包支持的所有链（哪些能直接连，在选链页里标出来）
        const meta = h('span', { class: 'meta' }, h('span', { class: 'name' }, group.name), h('span', { class: 'chips' }, group.chains.map((n) => labels[n]).join(' · ')))
        return h('li', {}, h('button', { type: 'button', class: 'wallet', 'data-id': group.id, 'data-focus': `group:${group.id}`, click: () => selectGroup(group) }, avatar(group), meta, badgeOf(group)))
      }),
    )
  }

  /** 先选钱包：多链钱包选链 */
  const chainsView = (group: WalletGroup) =>
    h(
      'section',
      { class: 'choose' },
      h('div', { class: 'choose-head' }, avatar(group, true), h('p', { class: 'wallet-name' }, group.name), h('p', { class: 'status' }, t.chooseChain)),
      h(
        'ul',
        { class: 'wallets' },
        ...group.wallets.map((item) =>
          h('li', {}, h('button', { type: 'button', class: 'wallet', 'data-chain': item.namespace, 'data-focus': `chain:${item.namespace}`, click: () => (item.installed ? void connect(item, view) : select(item)) }, h('span', { class: 'name' }, labels[item.namespace]), badgeOf(item))),
        ),
      ),
    )

  const listView = () => {
    if (!list.length) return h('p', { class: 'empty' }, t.empty)
    return h(
      'ul',
      { class: 'wallets' },
      ...list.map((item) => {
        const badge = item.connected ? h('span', { class: 'badge connected' }, t.connected) : !item.installed ? h('span', { class: 'badge muted' }, t.notInstalled) : item.type === 'qrcode' ? h('span', { class: 'badge muted' }, t.qrcode) : h('span', { class: 'badge' }, t.installed)
        return h('li', {}, h('button', { type: 'button', class: 'wallet', 'data-id': item.id, 'data-focus': `wallet:${item.id}`, click: () => select(item) }, avatar(item), h('span', { class: 'name' }, item.name), badge))
      }),
    )
  }

  const connectingView = (state: Extract<View, { kind: 'connecting' }>) => {
    const { item, uri, error } = state
    const children: Array<Node | null> = []
    if (uri && !error) {
      children.push(h('div', { class: 'qr', role: 'img', 'aria-label': t.scan }, svg(qrSvg(uri))))
      children.push(h('p', { class: 'status' }, t.scan))
      const actions = h(
        'div',
        { class: 'actions' },
        h('button', {
          type: 'button',
          class: 'secondary',
          'data-focus': 'copy',
          click: () => {
            navigator.clipboard
              ?.writeText(uri)
              .then(() => {
                if (view.kind === 'connecting' && view.uri === uri) {
                  view = { ...view, copied: true }
                  render()
                }
              })
              .catch(() => {}) // 没有剪贴板权限 / 非安全上下文：不处理
          },
        }, state.copied ? t.copied : t.copy),
        isMobileBrowser() && safeUrl(uri, false) ? h('a', { class: 'secondary', href: uri, 'data-focus': 'open' }, t.openInWallet) : null,
      )
      children.push(actions)
    } else {
      children.push(h('div', { class: 'pending-icon' }, avatar(item, true), error ? null : h('span', { class: 'spinner', 'aria-hidden': 'true' })))
      children.push(h('p', { class: 'wallet-name' }, item.name))
      children.push(error ? h('p', { class: 'status error', role: 'alert' }, error) : h('p', { class: 'status' }, item.type === 'qrcode' ? t.scan : t.confirm(item.name)))
      if (error) children.push(h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', 'data-focus': 'retry', click: () => void connect(item) }, t.retry)))
    }
    return h('section', { class: 'connecting' }, ...children)
  }

  const footer = () => {
    // 先选链时显示当前标签那条链的连接（'multi' 模式下各条链可能连着不同的钱包）
    const namespace = flow === 'chain-first' && tab && wallet.getConnection(tab) ? tab : wallet.getState().active
    const connection = namespace ? wallet.getConnection(namespace) : null
    if (!connection || !namespace || view.kind !== 'list') return null
    const short = connection.address.length > 14 ? `${connection.address.slice(0, 6)}…${connection.address.slice(-4)}` : connection.address
    return h(
      'footer',
      {},
      avatar({ name: connection.walletName, icon: connection.icon }),
      h('span', { class: 'address', title: connection.address }, short),
      h('button', { type: 'button', class: 'link', 'data-focus': 'disconnect', click: () => void wallet.disconnect(namespace) }, t.disconnect),
    )
  }

  const render = () => {
    if (!panel || !root) return
    // 整个面板重画：记下有焦点的按钮，画完把焦点放回同一个（键盘用户不会丢焦点）
    const focused = activeIn(root)?.getAttribute('data-focus')
    const body = view.kind === 'connecting' ? connectingView(view) : view.kind === 'chains' ? chainsView(view.group) : flow === 'wallet-first' ? groupsView() : listView()
    const parts = [header(), tabs(), h('div', { class: 'body' }, body), footer()]
    panel.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null))
    if (focused) {
      const target = Array.from(panel.querySelectorAll<HTMLElement>('[data-focus]')).find((el) => el.getAttribute('data-focus') === focused)
      ;(target ?? panel).focus()
    }
  }

  /** Tab 键只在弹窗里循环 */
  const trapFocus = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || !panel || !root) return
    const items = Array.from(panel.querySelectorAll<HTMLElement>('button, a[href]'))
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    const active = activeIn(root)
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const mount = () => {
    if (host) return
    host = document.createElement('div')
    host.setAttribute('data-w3lib-wallet-modal', '')
    host.setAttribute('data-theme', theme)
    root = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = STYLES
    // 只有在遮罩上按下、又在遮罩上松开才关闭（在面板里拖选文字拖到外面、或反过来，都不算）
    let pressed = false
    let released = false
    const backdrop: HTMLDivElement = h('div', {
      class: 'backdrop',
      style: `z-index:${options.zIndex ?? 2147483000}`,
      mousedown: (event) => (pressed = event.target === backdrop),
      mouseup: (event) => (released = event.target === backdrop),
      click: (event) => {
        if (event.target === backdrop && pressed && released) finish(null)
        pressed = released = false
      },
    })
    panel = h('div', { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'w3w-title', tabindex: '-1', keydown: (event) => trapFocus(event as KeyboardEvent) })
    backdrop.append(panel)
    root.append(style, backdrop)
    ;(options.container ?? document.body).append(host)
  }

  const close = () => {
    if (!opened) return
    opened = false
    pending?.abort()
    pending = null
    unwatchList?.()
    unwatchList = null
    cleanup.forEach((fn) => fn())
    cleanup = []
    host?.remove()
    host = root = panel = null
    // 焦点还给打开弹窗的元素
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    opener = null
    const done = settle
    settle = null
    done?.(null)
  }

  return {
    open(target) {
      // 服务端没有 document：直接结束
      if (typeof document === 'undefined') return Promise.resolve(null)
      if (opened) close()
      const settings = target && typeof target === 'object' && !Array.isArray(target) ? (target as { chains?: readonly Namespace[]; flow?: WalletModalFlow }) : { chains: target === undefined ? undefined : typeof target === 'string' ? [target as Namespace] : (target as readonly Namespace[]) }
      flow = settings.flow ?? options.flow ?? 'chain-first'
      // 只显示配置了的链（传了没配置的链时忽略它）；一条都没有时不打开
      const requested = settings.chains ?? options.chains ?? wallet.namespaces
      chains = [...new Set(requested)].filter((namespace) => wallet.namespaces.includes(namespace))
      if (!chains.length) return Promise.resolve(null)
      const active = wallet.getState().active
      tab = (active && chains.includes(active) ? active : chains[0]) ?? null
      view = { kind: 'list' }
      opener = document.activeElement
      opened = true
      mount()
      watchTab()
      cleanup.push(wallet.subscribe(() => view.kind !== 'connecting' && render()))
      // 捕获阶段处理 Esc，只关最上面的弹窗，并阻止它再传给页面（和下面的弹窗）
      const token = {}
      openModals.push(token)
      cleanup.push(() => openModals.splice(openModals.indexOf(token), 1))
      const onKey = (event: KeyboardEvent) => {
        // 弹窗藏起来时（钱包 SDK 自己的扫码窗口开着）Esc 留给那个窗口
        if (event.key !== 'Escape' || event.defaultPrevented || openModals[openModals.length - 1] !== token || host?.style.display === 'none') return
        event.stopImmediatePropagation()
        finish(null)
      }
      document.addEventListener('keydown', onKey, true)
      cleanup.push(() => document.removeEventListener('keydown', onKey, true))
      // 弹窗打开时页面不滚动
      lockScroll()
      cleanup.push(unlockScroll)
      render()
      panel?.focus()
      return new Promise((resolve) => (settle = resolve))
    },

    close,

    get isOpen() {
      return opened
    },

    setTheme(next) {
      theme = next
      host?.setAttribute('data-theme', next)
    },

    get element() {
      return host
    },

    destroy() {
      close()
    },
  }
}
