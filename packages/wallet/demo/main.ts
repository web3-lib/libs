import { createWallet, type Connector, type Namespace, type WalletEvent, type WalletGroup, type WalletManager, type WalletOption } from '@w3lib/wallet'
import { createNonce, parseSignInMessage, signIn, type SignInProof } from '@w3lib/wallet/auth'
import { arbitrum, base, bsc, ethereum, polygon } from '@w3lib/wallet/chains'
import { evm } from '@w3lib/wallet/evm'
import { solana } from '@w3lib/wallet/solana'
import { sui } from '@w3lib/wallet/sui'
import { ton } from '@w3lib/wallet/ton'
import { tron } from '@w3lib/wallet/tron'
import { createWalletModal, type WalletModal, type WalletModalFlow, type WalletModalTheme } from '@w3lib/wallet/ui'

// ---- 设置（存在 localStorage，刷新后保留） ----

interface Settings {
  theme: WalletModalTheme
  flow: WalletModalFlow
  mode: 'single' | 'multi'
  chains: Namespace[]
  projectId: string
  listKind: WalletModalFlow
}

const ALL: Namespace[] = ['evm', 'solana', 'sui', 'tron', 'ton']
const LABELS: Record<Namespace, string> = { evm: 'EVM', solana: 'Solana', sui: 'Sui', tron: 'Tron', ton: 'TON' }
const EVM_CHAINS = [bsc, ethereum, base, polygon, arbitrum]
const SETTINGS_KEY = 'w3lib-demo:settings'

const DEFAULTS: Settings = { theme: 'auto', flow: 'chain-first', mode: 'single', chains: [...ALL], projectId: '', listKind: 'chain-first' }

/** 读存的设置：损坏或不认识的值用默认的 */
function loadSettings(): Settings {
  let stored: Partial<Settings> = {}
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') ?? {}
  } catch {
    // 存的不是 JSON：用默认的
  }
  const pick = <T>(value: unknown, allowed: readonly T[], fallback: T) => (allowed.includes(value as T) ? (value as T) : fallback)
  return {
    theme: pick(stored.theme, ['light', 'dark', 'auto'] as const, DEFAULTS.theme),
    flow: pick(stored.flow, ['chain-first', 'wallet-first'] as const, DEFAULTS.flow),
    mode: pick(stored.mode, ['single', 'multi'] as const, DEFAULTS.mode),
    chains: Array.isArray(stored.chains) ? ALL.filter((n) => stored.chains?.includes(n)) : DEFAULTS.chains,
    projectId: typeof stored.projectId === 'string' ? stored.projectId : '',
    listKind: pick(stored.listKind, ['chain-first', 'wallet-first'] as const, DEFAULTS.listKind),
  }
}

const settings = loadSettings()
const save = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))

// WalletConnect 的 SDK 依赖很重，demo 只在填了 projectId 时从 esm.sh 加载（锁定版本）；
// 项目里装上它，写 () => import('@walletconnect/ethereum-provider')，和下面 TON 的写法一样
const WALLETCONNECT_CDN = 'https://esm.sh/@walletconnect/ethereum-provider@2.21.10'
// 放在模块顶层（同一个函数）：重建 wallet 时库会复用已经初始化的 WalletConnect，不重复初始化
const loadWalletConnect = () => import(/* @vite-ignore */ WALLETCONNECT_CDN)

/** 只打开 http(s) 的链接（TON 的下载地址来自远程的钱包列表） */
const openSafe = (url: string | null) => {
  if (url && /^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener')
}

// ---- DOM 小工具 ----

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string | ((event: Event) => void)> = {}, ...children: Array<Node | string | null>) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'function') el.addEventListener(key, value)
    else el.setAttribute(key, value)
  }
  for (const child of children) if (child !== null) el.append(child)
  return el
}
const short = (address: string) => (address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address)
const icon = (item: { name: string; icon: string | null }) => (item.icon ? h('img', { src: item.icon, alt: '' }) : h('span', { class: 'letter' }, item.name.slice(0, 1).toUpperCase()))

function segmented(id: string, value: string, onChange: (value: string) => void) {
  const root = $(id)
  const sync = (current: string) => root.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === current)))
  sync(value)
  root.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button')
    if (!button?.dataset.value) return
    sync(button.dataset.value)
    onChange(button.dataset.value)
  })
}

function output(text: string, error = false) {
  const el = $('output')
  el.hidden = false
  el.textContent = text
  el.classList.toggle('error', error)
}

function showError(err: unknown) {
  const e = err as { code?: string; message?: string }
  output(`${e.code ?? 'error'}: ${e.message ?? String(err)}`, true)
}

function log(text: string) {
  const time = new Date().toLocaleTimeString()
  $('log').prepend(h('li', {}, h('time', {}, time), text))
}

function describe(event: WalletEvent): string {
  switch (event.type) {
    case 'connect':
      return `connect  ${event.namespace}  ${event.connection.walletName}  ${short(event.connection.address)}  chain=${String(event.connection.chainId)}`
    case 'disconnect':
      return `disconnect  ${event.namespace}  ${event.walletId}${event.replaced ? '  (replaced)' : ''}`
    case 'accountChanged':
      return `accountChanged  ${event.namespace}  ${short(event.address)}`
    case 'chainChanged':
      return `chainChanged  ${event.namespace}  ${String(event.chainId)}`
    case 'activeChanged':
      return `activeChanged  ${String(event.active)}`
    case 'walletsChanged':
      return `walletsChanged  ${event.namespace}`
    default:
      return event.type
  }
}

// ---- wallet ----

let wallet: WalletManager
let modal: WalletModal
let stops: Array<() => void> = []

function connectors(): Connector[] {
  const list: Connector[] = []
  const on = (n: Namespace) => settings.chains.includes(n)
  if (on('evm')) {
    list.push(
      evm({
        chains: EVM_CHAINS,
        walletConnect: settings.projectId
          ? {
              projectId: settings.projectId,
              load: loadWalletConnect,
              metadata: { name: '@w3lib/wallet demo', description: 'Wallet connection demo', url: location.origin, icons: [] },
            }
          : undefined,
      }),
    )
  }
  if (on('solana')) list.push(solana())
  if (on('sui')) list.push(sui())
  if (on('tron')) list.push(tron())
  // TON Connect 的 SDK 按需加载：Vite 会把它拆成单独的文件，第一次用到 TON 时才下载
  if (on('ton')) list.push(ton({ manifestUrl: new URL('tonconnect-manifest.json', location.href).href, load: () => import('@tonconnect/sdk') }))
  return list
}

function build() {
  stops.forEach((stop) => stop())
  stops = []
  modal?.destroy()
  wallet?.destroy()

  wallet = createWallet({ connectors: connectors(), mode: settings.mode })
  modal = createWalletModal(wallet, { flow: settings.flow, theme: settings.theme })
  stops.push(
    wallet.subscribe((_, event) => {
      if (event.type !== 'walletsChanged') log(describe(event))
      renderState()
    }),
  )
  log(`createWallet  mode=${settings.mode}  chains=${wallet.namespaces.join(',') || '（无）'}`)
  renderState()
  renderList()
  void wallet.ready.then(() => log(`ready  ${wallet.connected ? short(wallet.address ?? '') : '未连接'}`))
}

// ---- 当前状态 ----

function renderState() {
  const state = wallet.getState()
  const rows: Array<[string, string]> = [
    ['status', state.status === 'restoring' ? 'restoring（恢复上次的连接中…）' : 'ready'],
    ['connected', String(wallet.connected)],
    ['address', state.address ?? '—'],
    ['chainId', wallet.chainId === null ? '—' : String(wallet.chainId)],
    ['wallet', state.connection ? `${state.connection.walletName}（${state.connection.namespace}）` : '—'],
  ]
  if (settings.mode === 'multi') {
    for (const namespace of wallet.namespaces) {
      const connection = state.connections[namespace]
      rows.push([`  ${LABELS[namespace]}`, connection ? `${connection.walletName}  ${short(connection.address)}${state.active === namespace ? '  ← 当前' : ''}` : '—'])
    }
  }
  $('state').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))
  const connected = wallet.connected
  for (const id of ['sign', 'disconnect', 'disconnectAll']) $<HTMLButtonElement>(id).disabled = !connected
  $<HTMLButtonElement>('switch').disabled = !wallet.getConnection('evm')
  renderAuth()
}

// ---- 登录签名（/auth 签名，/verify 验证） ----

// 模拟后端：发出去、还没用过的 nonce（真实后端存在数据库 / redis，验证通过后删除）
const issuedNonces = new Set<string>()
let lastProof: SignInProof | null = null

function authOutput(text: string, error = false) {
  const el = $('authOutput')
  el.hidden = false
  el.textContent = text
  el.classList.toggle('error', error)
}

/** 选链的下拉：只列启用的链，默认选当前的链；没连接的链能选，点按钮时会提示 */
function renderAuth() {
  const select = $<HTMLSelectElement>('authChain')
  const previous = select.value
  select.replaceChildren(
    ...wallet.namespaces.map((n) => h('option', { value: n }, `${LABELS[n]}${wallet.getConnection(n) ? '' : '（未连接）'}`)),
  )
  const active = wallet.getState().active
  select.value = wallet.namespaces.includes(previous as Namespace) ? previous : active && wallet.namespaces.includes(active) ? active : (wallet.namespaces[0] ?? '')
  const namespace = select.value as Namespace
  const connection = namespace ? wallet.getConnection(namespace) : null
  $('authHint').textContent = !namespace ? '没有启用任何链：先在设置里勾选链。' : connection ? '' : `${LABELS[namespace]} 还没连接钱包：先连接，再签名。`
  $<HTMLButtonElement>('authSign').disabled = !connection
  $<HTMLButtonElement>('authVerify').disabled = !lastProof
  $<HTMLButtonElement>('authTamper').disabled = !lastProof
}

/** 后端的验证：动态加载 /verify（它带密码学库，真实项目只在后端用） */
async function verifyProof(proof: SignInProof, label: string) {
  try {
    const { verifySignIn } = await import('@w3lib/wallet/verify')
    const connection = wallet.getConnection(proof.namespace)
    const result = await verifySignIn(proof, {
      domain: location.host,
      // 真实后端传自己要求的链；demo 取签名消息里写的链（不跟当前连接走：签名后切链、断开都不影响验证）
      chainId: proof.namespace === 'evm' ? Number(parseSignInMessage(proof.message).chainId) : parseSignInMessage(proof.message).chainId,
      // 传函数：签名验证通过后才调用，查到就删除，只能用一次
      nonce: (n) => issuedNonces.delete(n),
      // TON 的签名只能用公钥验证：真实后端读链上钱包合约的 get_public_key，demo 直接用 TON Connect 连接信息里的
      tonPublicKey: async () => {
        const key = (connection?.provider as { wallet?: { account?: { publicKey?: string } } } | undefined)?.wallet?.account?.publicKey
        if (!key) throw new Error('This TON wallet did not provide a public key')
        return key
      },
    })
    log(`${label}  ${proof.namespace}  ${result.ok ? 'ok' : result.error}`)
    authOutput(
      result.ok ? `${label}：验证通过\n账户（规范化地址）：${result.address}\nnonce 已作废，同一份签名再验一次会失败` : `${label}：验证失败\n${result.error}`,
      !result.ok,
    )
  } catch (err) {
    const e = err as { message?: string }
    authOutput(`${label}：${e.message ?? String(err)}`, true)
  }
}

$('authSign').addEventListener('click', async () => {
  const namespace = $<HTMLSelectElement>('authChain').value as Namespace
  const nonce = createNonce() // 真实场景由后端生成并记住
  issuedNonces.add(nonce)
  authOutput('请在钱包中确认登录签名…')
  try {
    const proof = await signIn(wallet, namespace, { domain: location.host, uri: location.origin, nonce, statement: $<HTMLInputElement>('authStatement').value.trim() || undefined })
    lastProof = proof
    renderAuth()
    authOutput(`登录消息：\n${proof.message}\n\n签名：\n${proof.signature}${proof.ton ? `\n\nTON signData：${JSON.stringify(proof.ton)}` : ''}\n\n（proof 原样发给后端，点“验证”看后端侧的结果）`)
  } catch (err) {
    issuedNonces.delete(nonce)
    showAuthError(err)
  }
})

$('authVerify').addEventListener('click', () => lastProof && void verifyProof(lastProof, '验证'))
$('authTamper').addEventListener('click', () => {
  if (!lastProof) return
  // 改动签名过的消息里 statement 的一个字：后端必须拒绝
  let message = lastProof.message.replace(/\n\n(.)/, (_, c: string) => `\n\n${c === 'X' ? 'Y' : 'X'}`)
  // 没有 statement 时正则不匹配、消息没变：在末尾加一个空格，保证确实被改动
  if (message === lastProof.message) message += ' '
  void verifyProof({ ...lastProof, message }, '篡改后验证')
})

function showAuthError(err: unknown) {
  const e = err as { code?: string; message?: string }
  authOutput(`${e.code ?? 'error'}: ${e.message ?? String(err)}`, true)
}

// ---- 自己画的钱包列表 ----

function walletButton(item: WalletOption, label = item.name, sub = '') {
  const tag = item.connected ? h('span', { class: 'tag ok' }, '已连接') : h('span', { class: 'tag' }, !item.installed ? '未安装' : item.type === 'qrcode' ? '扫码' : '已安装')
  return h('button', { click: () => void pick(item) }, icon(item), h('span', { class: 'meta' }, label, sub ? h('small', {}, sub) : null), tag)
}

async function pick(item: WalletOption) {
  if (!item.installed) {
    openSafe(item.downloadUrl)
    return
  }
  output(item.type === 'qrcode' ? '等待扫码…' : `请在 ${item.name} 中确认…`)
  try {
    const connection = await item.connect({ onDisplayUri: (uri) => output(`扫码链接（自己画二维码时用它）：\n${uri}`) })
    output(`已连接 ${connection.walletName}：${connection.address}`)
  } catch (err) {
    showError(err)
  }
}

function renderList() {
  const container = $('customList')
  if (settings.listKind === 'chain-first') {
    // 按链：watchWallets 拿全部链的钱包，按链分组显示
    stops.push(
      wallet.watchWallets((list) => {
        container.replaceChildren(
          ...wallet.namespaces.flatMap((namespace) => {
            const items = list.filter((w) => w.namespace === namespace)
            return [h('p', { class: 'group-title' }, LABELS[namespace]), items.length ? h('ul', { class: 'wallet-list' }, ...items.map((item) => h('li', {}, walletButton(item)))) : h('p', { class: 'empty' }, '没有钱包')]
          }),
        )
      }),
    )
    return
  }
  // 按钱包：watchWalletGroups，同一个插件在各条链上合成一项；每条能连的链一个按钮
  stops.push(
    wallet.watchWalletGroups((groups: WalletGroup[]) => {
      if (!groups.length) return container.replaceChildren(h('p', { class: 'empty' }, '没有钱包'))
      container.replaceChildren(
        h(
          'ul',
          { class: 'wallet-list' },
          ...groups.flatMap((group) => {
            const chains = group.chains.map((n) => LABELS[n]).join(' · ')
            if (group.wallets.length === 1) return [h('li', {}, walletButton(group.wallets[0] as WalletOption, group.name, chains))]
            return group.wallets.map((item) => h('li', {}, walletButton(item, `${group.name} → ${LABELS[item.namespace]}`, chains)))
          }),
        ),
      )
    }),
  )
}

// ---- 设置和按钮 ----

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme
  modal?.setTheme(settings.theme)
}

segmented('theme', settings.theme, (value) => {
  settings.theme = value as WalletModalTheme
  save()
  applyTheme()
})
segmented('flow', settings.flow, (value) => {
  settings.flow = value as WalletModalFlow
  save()
  build()
})
segmented('mode', settings.mode, (value) => {
  settings.mode = value as Settings['mode']
  save()
  build()
})
segmented('listKind', settings.listKind, (value) => {
  settings.listKind = value as WalletModalFlow
  save()
  build()
})

$('chains').replaceChildren(
  ...ALL.map((namespace) => {
    const input = h('input', { type: 'checkbox' }) as HTMLInputElement
    input.checked = settings.chains.includes(namespace)
    input.addEventListener('change', () => {
      settings.chains = ALL.filter((n) => (n === namespace ? input.checked : settings.chains.includes(n)))
      save()
      build()
    })
    return h('label', {}, input, LABELS[namespace])
  }),
)

const projectId = $<HTMLInputElement>('projectId')
projectId.value = settings.projectId
projectId.addEventListener('change', () => {
  settings.projectId = projectId.value.trim()
  save()
  build()
})

$<HTMLSelectElement>('switchTo').replaceChildren(...EVM_CHAINS.map((chain) => h('option', { value: String(chain.id) }, `${chain.name}（${chain.id}）`)))

$('open').addEventListener('click', async () => {
  const connection = await modal.open()
  $('result').textContent = connection ? `已连接 ${connection.walletName}（${connection.namespace}）` : '关闭了弹窗'
})

$('sign').addEventListener('click', async () => {
  try {
    const message = `Sign in to @w3lib/wallet demo\n${new Date().toISOString()}`
    output(`签名结果：\n${await wallet.signMessage(message)}`)
  } catch (err) {
    showError(err)
  }
})

$('switch').addEventListener('click', async () => {
  try {
    await wallet.switchChain(Number($<HTMLSelectElement>('switchTo').value))
    output(`已切到 ${String(wallet.getConnection('evm')?.chainId)}`)
  } catch (err) {
    showError(err)
  }
})

$('disconnect').addEventListener('click', () => wallet.disconnect().catch(showError))
$('disconnectAll').addEventListener('click', () => wallet.disconnectAll().catch(showError))
$('clearLog').addEventListener('click', () => $('log').replaceChildren())

applyTheme()
build()
