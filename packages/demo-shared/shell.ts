/**
 * 各库 demo 共用的外壳：把 index.html 里带 data-group / data-title 的 <section> 做成
 * 左侧分组导航 + 只显示选中的功能（hash 路由：#/<key>），并把设置 / 连接面板固定在顶部栏。
 *
 * 页面上的约定（都在 <main> 的直接子元素上）：
 *   data-group   分组名（见 GROUPS，固定顺序；没有功能的分组不显示）
 *   data-title   导航里的名字 / 页面标题
 *   data-key     hash 里的 id（可选，默认由标题生成）
 *   data-desc    一句话说明
 *   data-mode    read（只读）| write（会发送交易）| mixed（查询只读，也能发送交易）| sign（只签名，不发交易）
 *   data-wallet  有这个属性：显示“需要钱包”
 *   data-needs-node="说明"  这个功能需要自己的节点：还在用内置公共节点时，区块里提示并给出“打开节点设置”按钮
 *   <script type="text/plain" data-usage>…</script>  区块里的调用示例：渲染成默认折叠的“调用方式”（带复制按钮）；
 *                用 script 是为了代码里的 < > & 不用转义
 *   data-role="settings"  设置：链、地址、钱包这几行常驻在顶部栏下方（每个功能页都看得到）；其余（节点等）放进“节点设置”弹出面板
 * 原来的 id 和 DOM 都不变（只是移动位置），main.ts 里的代码照常工作。
 */
import './shell.css'

/** 分组的固定顺序；未列出的分组排在最后 */
export const GROUPS = ['资产查询', '流动性', '交易', '安全', '领取与回收', '工具'] as const

interface Page {
  key: string
  group: string
  title: string
  mode: string
  el: HTMLElement
  link: HTMLAnchorElement
}


/** 节点按钮上显示的状态：main.ts 可以覆盖（如“钱包”：没填节点时用已连接钱包的节点） */
let nodeStatus: string | null = null
let refreshNode: () => void = () => {}
export function setNodeStatus(status: string | null): void {
  nodeStatus = status
  refreshNode()
}

/** hash 里的页面 id；格式不对（如 #/%E0）时当作没有，回到第一个功能 */
function hashKey(): string {
  const raw = location.hash.replace(/^#\/?/, '')
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-|-$/g, '') || 'page'
}

function badge(kind: 'read' | 'write' | 'sign' | 'wallet', text: string): HTMLElement {
  return el('span', `badge ${kind}`, text)
}

/** 给卡片型页面加标题行：标题 + 徽标 + 一句话说明 + 接口说明（原来 h2 里的 small） */
function decorate(page: HTMLElement, title: string, mode: string, desc: string | undefined, wallet: boolean): void {
  const head = page.querySelector<HTMLElement>(':scope > h2')
  const api = head?.querySelector('small')?.textContent?.trim()
  const h2 = head ?? el('h2')
  h2.textContent = title
  if (mode === 'read' || mode === 'mixed') h2.append(badge('read', mode === 'mixed' ? '查询只读' : '只读'))
  if (mode === 'write' || mode === 'mixed') h2.append(badge('write', '会发送交易'))
  if (mode === 'sign') h2.append(badge('read', '检测只读'), badge('sign', '需要签名（不发交易）'))
  if (wallet) h2.append(badge('wallet', '需要钱包'))
  const info = el('div', 'sec-head')
  if (desc) info.append(el('p', 'desc', desc))
  if (api) info.append(el('p', 'api', api))
  if (!head) page.prepend(h2)
  h2.after(info)
  if (!info.childElementCount) info.remove()
  const usage = usageBlock(page)
  if (usage) (info.isConnected ? info : h2).after(usage)
  const needs = page.dataset.needsNode
  if (needs !== undefined) {
    const note = el('div', 'needs-node')
    note.append(el('span', undefined, needs || '这个功能需要自己的节点（内置公共节点不支持）。'))
    const open = el('button', undefined, '打开节点设置')
    open.type = 'button'
    // 外壳里的节点设置弹窗监听这个事件（点击事件要先冒泡完，避免被“点到弹窗外面就关闭”立刻关掉）
    open.addEventListener('click', (e) => {
      e.stopPropagation()
      document.dispatchEvent(new CustomEvent('w3demo:open-settings'))
    })
    note.append(open)
    ;(usage ?? (info.isConnected ? info : h2)).after(note)
  }
  // 文档式排版：标题、说明、调用方式在上面；表单、按钮、结果收进“在线试用”面板（只是外面套一层，id 不变）
  const lead = new Set<Element>([h2, info, ...(usage ? [usage] : []), ...Array.from(page.querySelectorAll(':scope > .needs-node'))])
  const rest = Array.from(page.children).filter((c) => !lead.has(c))
  if (rest.length) {
    const playground = el('div', 'playground')
    const ph = el('div', 'playground-head')
    ph.append(el('span', 'playground-title', '在线试用'))
    if (mode === 'write' || mode === 'mixed') ph.append(el('span', 'playground-note', '橙色按钮会发送交易，需要在钱包里确认'))
    playground.append(ph, ...rest)
    page.append(playground)
  }
}

/** 去掉每行共同的缩进和首尾空行（HTML 里的代码跟着标签缩进） */
function dedent(text: string): string {
  const lines = text.replace(/\t/g, '  ').split('\n')
  while (lines.length && !lines[0]?.trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop()
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length))
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n')
}

/** 区块里的调用示例 → 默认折叠的“调用方式” */
function usageBlock(page: HTMLElement): HTMLElement | null {
  const sources = Array.from(page.querySelectorAll<HTMLScriptElement>('script[type="text/plain"][data-usage]'))
  if (!sources.length) return null
  const details = el('details', 'usage')
  const summary = el('summary', undefined, '调用方式')
  details.append(summary)
  for (const source of sources) {
    const code = dedent(source.textContent ?? '')
    source.remove()
    const box = el('div', 'usage-code')
    if (source.dataset.usage) box.append(el('p', 'usage-title', source.dataset.usage))
    const pre = el('pre')
    pre.append(el('code', undefined, code))
    const copy = el('button', 'copy', '复制')
    copy.type = 'button'
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(code).then(
        () => {
          copy.textContent = '已复制'
          setTimeout(() => (copy.textContent = '复制'), 1500)
        },
        () => (copy.textContent = '复制失败'),
      )
    })
    box.append(pre, copy)
    details.append(box)
  }
  return details
}

export function mountShell(): void {
  const body = document.body
  const header = body.querySelector<HTMLElement>(':scope > header.top')
  const main = body.querySelector<HTMLElement>(':scope > main')
  const footer = body.querySelector<HTMLElement>(':scope > .foot')
  if (!main) return
  const brandTitle = header?.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() ?? document.title
  const intro = header?.querySelector('p')?.textContent?.trim()

  // ── 页面 ──
  const settings = main.querySelector<HTMLElement>(':scope > [data-role="settings"]')
  const found = Array.from(main.querySelectorAll<HTMLElement>(':scope > [data-group]'))
  const groupNames = [...GROUPS.filter((g) => found.some((p) => p.dataset.group === g)), ...new Set(found.map((p) => p.dataset.group ?? '其他').filter((g) => !(GROUPS as readonly string[]).includes(g)))]

  // ── 外壳 DOM ──
  const shell = el('div', 'shell')
  const side = el('aside', 'side')
  const brand = el('div', 'brand')
  brand.append(el('h1', undefined, brandTitle))
  if (intro) brand.append(el('p', undefined, intro))
  const nav = el('nav', 'nav')
  nav.setAttribute('aria-label', '功能')
  const content = el('div', 'content')
  const bar = el('div', 'bar')
  const menuBtn = el('button', 'menu-btn', '☰ 功能')
  const barTitle = el('span', 'bar-title')
  const chips = el('div', 'chips')
  const settingsBtn = el('button', undefined, '节点设置 ▾')
  const ctx = el('div', 'ctx')
  const pop = el('div', 'pop')
  pop.hidden = true
  const backdrop = el('div', 'backdrop')
  menuBtn.type = settingsBtn.type = 'button'
  menuBtn.setAttribute('aria-label', '打开功能导航')
  settingsBtn.setAttribute('aria-expanded', 'false')
  bar.append(menuBtn, barTitle, chips)
  if (settings) {
    // 链 / 地址 / 钱包：几乎每个功能都要用，常驻在顶部栏下方；其余设置（节点、API Key、说明）留在弹出面板
    for (const row of Array.from(settings.querySelectorAll<HTMLElement>(':scope > .row'))) {
      if (!row.querySelector('#chain, #owner, #walletInfo')) continue
      if (row.querySelector('#owner')) row.classList.add('grow')
      ctx.append(row)
    }
    const h2 = settings.querySelector(':scope > h2')
    if (h2) h2.textContent = '节点设置'
    settings.removeAttribute('data-role')
    if (settings.querySelector('.row, input, select')) bar.append(settingsBtn, pop)
    pop.append(settings)
    if (ctx.childElementCount) bar.append(ctx)
  }

  const pages: Page[] = []
  const taken = new Set<string>()
  for (const name of groupNames) {
    const group = el('div', 'nav-group')
    group.append(el('h3', undefined, name))
    for (const p of found.filter((f) => (f.dataset.group ?? '其他') === name)) {
      const title = p.dataset.title ?? p.querySelector('h2')?.textContent?.trim() ?? '未命名'
      let key = p.dataset.key ?? slug(title)
      while (taken.has(key)) key += '-2'
      taken.add(key)
      const mode = p.dataset.mode ?? ''
      const link = el('a')
      link.href = `#/${key}`
      link.append(el('span', 'grow', title))
      if (mode === 'write' || mode === 'mixed') {
        const dot = el('span', 'dot')
        dot.title = '会发送交易'
        link.append(dot)
      }
      group.append(link)
      if (p.classList.contains('card')) decorate(p, title, mode, p.dataset.desc, p.hasAttribute('data-wallet'))
      p.hidden = true
      pages.push({ key, group: name, title, mode, el: p, link })
    }
    nav.append(group)
  }
  side.append(brand, nav)
  if (pages.some((p) => p.mode === 'write' || p.mode === 'mixed')) {
    const legend = el('div', 'legend')
    legend.append(el('span', 'dot'), document.createTextNode('会发送交易的功能（其余只读）'))
    side.append(legend)
  }
  // 页脚链接：多功能页放进侧边栏；只有一个功能页（侧边栏不显示）时留在页面底部
  const single = pages.length <= 1
  if (footer && !single) {
    const foot = el('div', 'side-foot')
    foot.append(...Array.from(footer.querySelectorAll('a')))
    side.append(foot)
    footer.remove()
  }
  header?.remove()

  content.append(bar, main)
  if (footer && single) content.append(footer)
  shell.append(side, content, backdrop)
  body.prepend(shell)
  if (single) {
    shell.classList.add('single')
    if (intro) {
      const p = el('p', 'muted', intro)
      p.style.margin = '0'
      main.prepend(p)
    }
  }

  // 其余还没渲染的调用示例（不是卡片型功能页的区块，如总览页）：在所在的区块里、标题后面渲染
  const rest = new Set(
    Array.from(main.querySelectorAll<HTMLElement>('script[type="text/plain"][data-usage]')).map((s) => s.closest<HTMLElement>('section') ?? (s.parentElement as HTMLElement)),
  )
  for (const sec of rest) {
    const usage = usageBlock(sec)
    if (usage) (sec.querySelector(':scope > h2') ?? sec.firstElementChild)?.after(usage)
  }

  // ── 导航 / hash 路由 ──
  const setNav = (open: boolean) => shell.classList.toggle('nav-open', open)
  menuBtn.addEventListener('click', () => setNav(!shell.classList.contains('nav-open')))
  backdrop.addEventListener('click', () => setNav(false))
  nav.addEventListener('click', (e) => {
    if ((e.target as Element).closest('a')) setNav(false)
  })

  let current: Page | undefined
  const activate = (page: Page, scroll: boolean) => {
    if (current === page) return
    current = page
    for (const p of pages) {
      p.el.hidden = p !== page
      if (p === page) p.link.setAttribute('aria-current', 'page')
      else p.link.removeAttribute('aria-current')
    }
    barTitle.replaceChildren(page.group ? `${page.group} · ${page.title}` : page.title)
    if (shell.classList.contains('single')) barTitle.textContent = brandTitle
    document.title = `${page.title} · ${brandTitle}`
    setNav(false)
    if (scroll) window.scrollTo(0, 0)
  }
  const route = (scroll: boolean) => {
    const key = hashKey()
    const page = pages.find((p) => p.key === key) ?? pages[0]
    if (!page) return
    activate(page, scroll)
    if (key !== page.key) history.replaceState(null, '', `#/${page.key}`)
  }
  window.addEventListener('hashchange', () => route(true))
  route(false)

  // ── 节点设置：顶部栏按钮下方的弹出面板 ──
  // 按钮上显示当前用的是内置公共节点还是自己填的（节点 URL、API Key 等任一项填了就算自定义）
  const custom = () => !!settings && Array.from(settings.querySelectorAll<HTMLInputElement>('input')).some((i) => (i.type === 'text' || i.type === '') && i.value.trim() !== '')
  const label = () => `节点：${custom() ? '自定义' : (nodeStatus ?? '公共')} ${pop.hidden ? '▾' : '▴'}`
  const setPop = (open: boolean) => {
    pop.hidden = !open
    settingsBtn.setAttribute('aria-expanded', String(open))
    settingsBtn.textContent = label()
    settingsBtn.classList.toggle('custom', custom())
    // 需要自己节点的功能：填了自定义节点后不再提示
    for (const n of Array.from(document.querySelectorAll<HTMLElement>('.needs-node'))) n.hidden = custom()
  }
  if (settings) {
    const close = el('button', 'pop-close', '×')
    close.type = 'button'
    close.setAttribute('aria-label', '关闭节点设置')
    close.addEventListener('click', () => setPop(false))
    pop.prepend(close)
    settingsBtn.addEventListener('click', () => setPop(pop.hidden))
    document.addEventListener('w3demo:open-settings', () => {
      setPop(true)
      pop.querySelector<HTMLInputElement>('input')?.focus()
    })
    document.addEventListener('click', (e) => {
      const t = e.target as Node
      if (!pop.hidden && !pop.contains(t) && !settingsBtn.contains(t)) setPop(false)
    })
    // 输入框的值由 main.ts 从本地存储恢复（在外壳之后）：稍后再刷新一次按钮文字
    settings.addEventListener('input', () => setPop(!pop.hidden))
    settings.addEventListener('change', () => setPop(!pop.hidden))
    setTimeout(() => setPop(false), 0)
    refreshNode = () => setPop(!pop.hidden)
    // 默认收起：链 / 地址 / 钱包已经常驻在顶部栏，弹窗不该一打开页面就盖住内容
    setPop(false)
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    setNav(false)
    if (settings && !pop.hidden) setPop(false)
  })
}
