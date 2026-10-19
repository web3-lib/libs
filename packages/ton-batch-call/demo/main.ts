import { NATIVE_TON, TonClient, formatUnits, sameTonAddress, type NftDetails } from '@w3lib/ton-batch-call'
import {
  addLiquidity,
  buildAddLiquidity,
  buildRemoveLiquidity,
  removeLiquidity,
  type AddLiquidityParams,
  type LiquidityPlan,
  type LiquidityResult,
  type RemoveLiquidityParams,
} from '@w3lib/ton-batch-call/liquidity'
import { TON_LP_PROTOCOLS, lpPositions, type TonLpPosition, type TonLpProtocol } from '@w3lib/ton-batch-call/lp'
import { createWallet } from '@w3lib/wallet'
import { ton } from '@w3lib/wallet/ton'
import { createWalletModal } from '@w3lib/wallet/ui'

// ---- 示例数据 ----

/** 示例地址：持有 USDT 和多种 Jetton 的 v4r2 钱包（2026-10 时的真实地址） */
const SAMPLE_OWNER = 'UQAj-peZGPH-cC25EAv4Q-h8cBXszTmkch6ba6wXC8BM40qt'

const SAMPLE_JETTONS = [
  'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', // USDT
  'EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT', // NOT
  'EQCvxJy4eG8hyHBFsZ7eePxrRsUQSFE_jpptRAYBmcG_DOGS', // DOGS
  'EQA2kCVNwVsil2EM2mB0SkXytxCqQjS4mttjDpnXmwG9T6bO', // STON
]

/** 多个地址示例：USDT 主合约（也是有 TON 余额的合约）和示例钱包 */
const SAMPLE_OWNERS = [SAMPLE_OWNER, 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs']

/** LP 示例：持有 DeDust TON/USD₮ 和 STON.fi v2 USD₮/TON LP 的地址（2026-10 时的真实仓位，之后可能撤出） */
const SAMPLE_LP_OWNER = '0:489595F65115A45C24A0DD0176309654FB00B95E40682F0C3E85D5A4D86DFB25'

// ---- 设置（存在 localStorage，刷新后保留） ----

interface Settings {
  url: string
  apiKey: string
  owner: string
}

const SETTINGS_KEY = 'w3lib-demo:ton'

function loadSettings(): Settings {
  let stored: Partial<Settings> = {}
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') ?? {}
  } catch {
    // 存的不是 JSON：用默认的
  }
  return {
    url: typeof stored.url === 'string' ? stored.url : '',
    apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : '',
    owner: typeof stored.owner === 'string' ? stored.owner : '',
  }
}

const settings = loadSettings()
const save = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const urlInput = $<HTMLInputElement>('url')
const apiKeyInput = $<HTMLInputElement>('apiKey')
const ownerInput = $<HTMLInputElement>('owner')

urlInput.value = settings.url
apiKeyInput.value = settings.apiKey
ownerInput.value = settings.owner
$<HTMLTextAreaElement>('balanceTokens').value = SAMPLE_JETTONS.join('\n')
$<HTMLTextAreaElement>('jettons').value = SAMPLE_JETTONS.join('\n')
$<HTMLTextAreaElement>('multiOwners').value = SAMPLE_OWNERS.join('\n')

urlInput.addEventListener('change', () => {
  settings.url = urlInput.value.trim()
  save()
})
apiKeyInput.addEventListener('change', () => {
  settings.apiKey = apiKeyInput.value.trim()
  save()
})
ownerInput.addEventListener('change', () => {
  settings.owner = ownerInput.value.trim()
  save()
})
$('sample').addEventListener('click', () => {
  ownerInput.value = SAMPLE_OWNER
  ownerInput.dispatchEvent(new Event('change'))
})
$('lpSample').addEventListener('click', () => {
  ownerInput.value = SAMPLE_LP_OWNER
  ownerInput.dispatchEvent(new Event('change'))
})

// ---- 客户端：记录每个请求（toncenter 的接口名、耗时、状态） ----

interface RequestEvent {
  path: string
  ms: number
  status: number | null
}

let listener: ((e: RequestEvent) => void) | null = null

/** 包一层 fetch：统计查询期间发出的 HTTP 请求（DefiLlama 查价也会经过它） */
const countingFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const path = url.host.endsWith('llama.fi') ? 'DefiLlama' : url.pathname.replace(/^\/api\/v3\//, '').replace(/^\/api\//, '')
  const start = performance.now()
  try {
    const res = await fetch(input, init)
    listener?.({ path, ms: performance.now() - start, status: res.status })
    return res
  } catch (err) {
    listener?.({ path, ms: performance.now() - start, status: null })
    throw err
  }
}

// 同一组设置复用一个客户端：没有 API Key 时 1 秒 1 次的限频队列在多次查询之间共享
let cached: { key: string; client: TonClient } | null = null
function client(): TonClient {
  const key = JSON.stringify([settings.url, settings.apiKey])
  if (cached?.key !== key) {
    cached = { key, client: new TonClient(settings.url || undefined, { apiKey: settings.apiKey || undefined, fetch: countingFetch }) }
  }
  return cached.client
}

const lines = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)

function owner(): string {
  const value = ownerInput.value.trim()
  if (!value) throw new Error('请先填写地址（或点“示例地址”）')
  return value
}

// ---- 结果展示 ----

type Cell = string | number | null | undefined | Node

/** 用 textContent 填表格：Jetton 名称、symbol 来自链上，不能当 HTML 插入 */
function table(headers: string[], rows: Cell[][], numeric: number[] = []): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'table-wrap'
  if (!rows.length) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = '没有结果'
    wrap.append(empty)
    return wrap
  }
  const t = document.createElement('table')
  const head = t.createTHead().insertRow()
  for (const h of headers) {
    const th = document.createElement('th')
    th.textContent = h
    head.append(th)
  }
  const body = t.createTBody()
  for (const row of rows) {
    const tr = body.insertRow()
    row.forEach((value, i) => {
      const td = tr.insertCell()
      if (numeric.includes(i)) td.className = 'num'
      if (value instanceof Node) td.append(value)
      else td.textContent = value === null || value === undefined ? '—' : String(value)
    })
  }
  wrap.append(t)
  return wrap
}

function addr(value: string | null | undefined): Node {
  const span = document.createElement('span')
  span.className = 'addr'
  span.title = value ?? ''
  span.textContent = !value ? '—' : value.length > 14 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value
  return span
}

function tag(text: string, kind: 'ok' | 'bad' | '' = ''): Node {
  const span = document.createElement('span')
  span.className = `tag ${kind}`
  span.textContent = text
  return span
}

/** 显示用：最多 6 位小数（完整数值在原始 JSON 里） */
function amount(formatted: string | null | undefined): string {
  if (formatted === null || formatted === undefined) return '—'
  const n = Number(formatted)
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 6 }) : formatted
}

const usd = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`)

function rawJson(data: unknown): HTMLElement {
  const details = document.createElement('details')
  const summary = document.createElement('summary')
  summary.textContent = '原始结果（JSON）'
  const pre = document.createElement('pre')
  pre.className = 'output'
  pre.textContent = JSON.stringify(data, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)
  details.append(summary, pre)
  return details
}

function describeRequests(events: RequestEvent[], ms: number): string {
  const byPath = new Map<string, number>()
  for (const e of events) byPath.set(e.path, (byPath.get(e.path) ?? 0) + 1)
  const paths = [...byPath].map(([p, n]) => `${p} ×${n}`).join('、')
  const failed = events.filter((e) => e.status === null || e.status >= 400).length
  return [`${ms} ms`, `${events.length} 次请求${paths ? `（${paths}）` : ''}`, failed ? `${failed} 次失败（限频时自动重试）` : ''].filter(Boolean).join(' · ')
}

/** 按钮 → 查询 → 渲染；查询期间禁用所有查询按钮 */
function bind(buttonId: string, name: string, query: () => Promise<{ data: unknown; view: Node }>) {
  const button = $<HTMLButtonElement>(buttonId)
  const stats = $(`${name}Stats`)
  const result = $(`${name}Result`)
  button.addEventListener('click', async () => {
    const buttons = document.querySelectorAll<HTMLButtonElement>('button.primary')
    buttons.forEach((b) => (b.disabled = true))
    stats.textContent = '查询中…'
    result.replaceChildren()
    const events: RequestEvent[] = []
    listener = (e) => {
      events.push(e)
      // 发送时显示交易的进度（等待确认时还会轮询），不再覆盖
      if (stats.textContent?.startsWith('查询中')) stats.textContent = `查询中…已发出 ${events.length} 次请求`
    }
    const start = performance.now()
    try {
      const { data, view } = await query()
      stats.textContent = describeRequests(events, Math.round(performance.now() - start))
      result.replaceChildren(view, rawJson(data))
    } catch (err) {
      stats.textContent = describeRequests(events, Math.round(performance.now() - start))
      const pre = document.createElement('pre')
      pre.className = 'output error'
      pre.textContent = err instanceof Error ? err.message : String(err)
      result.replaceChildren(pre)
    } finally {
      listener = null
      buttons.forEach((b) => (b.disabled = false))
    }
  })
}

// ---- 各查询 ----

bind('runBalances', 'balances', async () => {
  const tokens = lines($<HTMLTextAreaElement>('balanceTokens').value)
  const list = await client().balances(owner(), tokens.length ? [NATIVE_TON, ...tokens] : undefined, { symbol: true })
  return {
    data: list,
    view: table(
      ['代币', '余额', 'Jetton 主合约', 'Jetton 钱包', '状态'],
      list.map((b) => [
        b.symbol ?? null,
        amount(b.formatted),
        b.native ? 'TON' : addr(b.token),
        addr(b.wallet),
        !b.success ? tag(b.error ?? 'failed', 'bad') : b.isScam ? tag('诈骗代币', 'bad') : tag('ok', 'ok'),
      ]),
      [1],
    ),
  }
})

bind('runMulti', 'multi', async () => {
  const owners = lines($<HTMLTextAreaElement>('multiOwners').value)
  if (!owners.length) throw new Error('请填写地址，每行一个')
  const ton = client()
  // 两个查询一起发出：余额（accountStates + jetton/wallets，每 100 个地址一个请求）和钱包状态
  const [balances, states] = await Promise.all([
    ton.multiBalances(owners.map((o) => ({ owner: o, tokens: [NATIVE_TON, SAMPLE_JETTONS[0] as string] }))),
    ton.walletStates(owners),
  ])
  return {
    data: { balances, states },
    view: table(
      ['地址', 'TON', 'USDT', '钱包类型', 'seqno', '状态'],
      owners.map((o, i) => {
        const [tonBalance, usdt] = balances[i] ?? []
        const state = states[i]
        return [
          addr(state?.address ?? o),
          amount(tonBalance?.formatted),
          amount(usdt?.formatted),
          state?.walletType ?? (state?.isWallet === false ? '不是钱包' : null),
          state?.seqno,
          state?.success ? tag(state.status, state.status === 'active' ? 'ok' : '') : tag(state?.error ?? 'failed', 'bad'),
        ]
      }),
      [1, 2, 4],
    ),
  }
})

bind('runJettons', 'jettons', async () => {
  const list = await client().jettons(lines($<HTMLTextAreaElement>('jettons').value))
  return {
    data: list,
    view: table(
      ['symbol', '名称', '精度', '总量', '可增发', '主合约', '状态'],
      list.map((j) => [
        j.symbol,
        j.name,
        j.decimals,
        j.totalSupply === null ? null : amount(formatUnits(BigInt(j.totalSupply), j.decimals)),
        j.mintable === null ? null : j.mintable ? '是' : '否',
        addr(j.address),
        !j.success ? tag(j.error ?? 'failed', 'bad') : j.isScam ? tag('诈骗代币', 'bad') : tag('ok', 'ok'),
      ]),
      [2, 3],
    ),
  }
})

bind('runLp', 'lp', async () => {
  const prices = $<HTMLInputElement>('lpPrices').checked
  let priceError: unknown = null
  const from = owner()
  const list = await lpPositions(client(), from, {
    prices,
    fetch: countingFetch,
    onPriceError: (err) => {
      priceError = err
    },
  })
  setPositions(list, from)
  return {
    data: list,
    view: withPriceWarning(
      table(
        ['协议', '交易对', '撤出可得', '份额', '手续费', '池子类型', '价值', '池子'],
        list.map((p) => [
          p.protocolName,
          pairOf(p),
          `${amount(p.amount0Formatted)} ${p.token0.symbol ?? ''} + ${amount(p.amount1Formatted)} ${p.token1.symbol ?? ''}`,
          `${(p.share * 100).toLocaleString('en-US', { maximumSignificantDigits: 3 })}%`,
          p.feeBps === null ? null : `${p.feeBps / 100}%`,
          p.poolType,
          prices ? usd(p.valueUsd) : null,
          addr(p.pool),
        ]),
      ),
      priceError,
    ),
  }
})

const pairOf = (p: TonLpPosition) => `${p.token0.symbol ?? '?'} / ${p.token1.symbol ?? '?'}`

/** 价格服务出错时在结果上方提示（这时价值列显示 —，但不是代币没有价格） */
function withPriceWarning(view: Node, error: unknown): Node {
  if (error === null) return view
  const wrap = document.createElement('div')
  const note = document.createElement('p')
  note.className = 'hint'
  note.textContent = `价格服务出错，这次没有美元价值：${error instanceof Error ? error.message : String(error)}`
  wrap.append(note, view)
  return wrap
}

function nftTable(list: NftDetails[]): HTMLElement {
  return table(
    ['名称', '集合', '编号', '出售中', '地址'],
    list.map((n) => [n.name, n.collectionName ?? (n.collection ? addr(n.collection) : null), n.index, n.onSale ? tag('出售中', 'ok') : '', addr(n.address)]),
  )
}

bind('runNft', 'nft', async () => {
  const collection = $<HTMLInputElement>('nftCollection').value.trim()
  const list = await client().nfts(owner(), { limit: 100, ...(collection ? { collection } : {}) })
  return { data: list, view: nftTable(list) }
})

// ---- 添加 / 移除流动性（子路径 /liquidity） ----

/** 各协议的示例池子（TON / USD₮；STON.fi v1 只能移除） */
const SAMPLE_POOLS: Partial<Record<TonLpProtocol, string>> = {
  'stonfi-v2': 'EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4',
  dedust: 'EQA-X_yo3fzzbDbJ_0bzFWKqtRuZFIRa1sJsveZJ1YpViO3r',
}

const liq = {
  action: $<HTMLSelectElement>('liqAction'),
  protocol: $<HTMLSelectElement>('liqProtocol'),
  pool: $<HTMLInputElement>('liqPool'),
  position: $<HTMLSelectElement>('liqPosition'),
  amount0: $<HTMLInputElement>('liqAmount0'),
  amount1: $<HTMLInputElement>('liqAmount1'),
  percent: $<HTMLInputElement>('liqPercent'),
  slippage: $<HTMLInputElement>('liqSlippage'),
}

// 钱包：TON Connect（@tonconnect/sdk 按需加载），连接弹窗用 @w3lib/wallet/ui
const wallet = createWallet({ connectors: [ton({ manifestUrl: new URL('tonconnect-manifest.json', location.href).href, load: () => import('@tonconnect/sdk') })] })
const modal = createWalletModal(wallet)
const connection = () => wallet.getConnection('ton')

/** 节点是测试网时钱包也要在测试网（TON Connect 的 chain：-239 主网，-3 测试网） */
const testnet = () => client().network === 'testnet'
const networkName = (chain: string | number | null) => (chain === '-239' ? '主网' : chain === '-3' ? '测试网' : `网络 ${chain ?? '未知'}`)

function renderWallet() {
  const c = connection()
  if (!c) {
    $('walletInfo').textContent = '未连接（只构建时用上面“地址”栏的地址）'
    $('connectWallet').textContent = '连接钱包'
    return
  }
  const expected = testnet() ? '-3' : '-239'
  $('walletInfo').textContent = `${c.walletName} · ${c.address}${c.chainId === expected ? '' : `（钱包在${networkName(c.chainId)}，节点是${networkName(expected)}）`}`
  $('connectWallet').textContent = '切换 / 断开'
}
wallet.subscribe(() => renderWallet())
void wallet.ready.then(renderWallet)
$('connectWallet').addEventListener('click', () => void modal.open('ton'))
// 换了节点（网络）：钱包网络重新比对，之前查到的仓位不再适用
urlInput.addEventListener('change', () => {
  renderWallet()
  setPositions([], '')
})

/** 上一次“查询 LP”的结果：追加、移除从里面选仓位 */
let lastPositions: TonLpPosition[] = []
/** 仓位是哪个地址的（查询“LP 仓位”时的地址）：追加、移除要用这个地址 */
let positionsOwner = ''

function setPositions(list: TonLpPosition[], of: string) {
  lastPositions = list
  positionsOwner = of
  const options = list.map((p, i) => new Option(`${p.protocolName} · ${pairOf(p)} · 份额 ${(p.share * 100).toPrecision(3)}%`, String(i)))
  liq.position.replaceChildren(...(options.length ? options : [new Option('先在上面“LP 仓位”里查询（用同一个地址）', '')]))
}

for (const id of Object.keys(SAMPLE_POOLS) as TonLpProtocol[]) liq.protocol.append(new Option(TON_LP_PROTOCOLS[id].name, id))

function applyProtocol() {
  liq.pool.value = SAMPLE_POOLS[liq.protocol.value as TonLpProtocol] ?? ''
}

function applyAction() {
  const action = liq.action.value
  $('liqNew').hidden = action !== 'new'
  $('liqExisting').hidden = action === 'new'
  $('liqAmounts').hidden = action === 'remove'
  $('liqRemoveOptions').hidden = action !== 'remove'
}

liq.protocol.addEventListener('change', applyProtocol)
liq.action.addEventListener('change', applyAction)
liq.amount1.value = '0.1'
setPositions([], '')
applyProtocol()
applyAction()

const text = (input: HTMLInputElement) => input.value.trim() || undefined

/**
 * 构建 / 发送用的地址：连了钱包用钱包地址（追加、移除时要和仓位的地址一致）；
 * 没连钱包时，追加、移除用仓位的地址，加入池子用“地址”栏的
 */
function liquidityFrom(walletAddress?: string): string {
  if (liq.action.value === 'new') return walletAddress ?? owner()
  if (walletAddress && positionsOwner && !sameTonAddress(walletAddress, positionsOwner)) {
    throw new Error(`仓位是 ${positionsOwner} 的，钱包是 ${walletAddress}：换成仓位的账户，或用钱包地址重新查询 LP 仓位`)
  }
  return walletAddress ?? positionsOwner
}

function selectedPosition(): TonLpPosition {
  const p = lastPositions[Number(liq.position.value)]
  if (!liq.position.value || !p) throw new Error('请先在“LP 仓位”里查询，再选一个仓位')
  return p
}

/** 选填的数字：不填时为 undefined（用库的默认值），填了不是数字时报错 */
function numberOf(input: HTMLInputElement, label: string): number | undefined {
  const value = text(input)
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`${label}不是数字：${value}`)
  return n
}

function slippageOf(): { slippage?: number } {
  const percent = numberOf(liq.slippage, '滑点')
  if (percent !== undefined && !(percent >= 0 && percent < 100)) throw new Error('滑点要在 0 ~ 100% 之间')
  return percent === undefined ? {} : { slippage: percent / 100 }
}

function addParams(): AddLiquidityParams {
  const amounts = { amount0Formatted: text(liq.amount0), amount1Formatted: text(liq.amount1) }
  if (!amounts.amount0Formatted && !amounts.amount1Formatted) throw new Error('请填写至少一边的数量')
  if (liq.action.value === 'add') return { position: selectedPosition(), ...amounts, ...slippageOf() }
  const pool = text(liq.pool)
  if (!pool) throw new Error('请填写池子地址')
  return { protocol: liq.protocol.value as TonLpProtocol, pool, ...amounts, ...slippageOf() }
}

function removeParams(): RemoveLiquidityParams {
  const percent = numberOf(liq.percent, '移除比例')
  if (percent !== undefined && !(percent > 0 && percent <= 100)) throw new Error('移除比例要在 0 ~ 100% 之间')
  return { position: selectedPosition(), ...(percent === undefined ? {} : { percent }) }
}

/** 表单 → 要调用的函数和参数（连接钱包之前先检查表单） */
function liquidityRequest() {
  return liq.action.value === 'remove' ? { action: 'remove' as const, params: removeParams() } : { action: 'add' as const, params: addParams() }
}

const tonAmount = (nano: string) => `${amount(formatUnits(BigInt(nano), 9))} TON`

/** 交易在浏览器里的链接（有钱包交易哈希时用它，否则用外部消息的哈希） */
function link(hash: string): Node {
  const a = document.createElement('a')
  a.href = `https://${testnet() ? 'testnet.' : ''}tonviewer.com/transaction/${hash}`
  a.target = '_blank'
  a.rel = 'noopener'
  a.textContent = `${hash.slice(0, 10)}…`
  return a
}

function planView(plan: LiquidityPlan, result?: LiquidityResult): Node {
  const s0 = plan.token0.symbol ?? 'token0'
  const s1 = plan.token1.symbol ?? 'token1'
  const add = plan.action === 'add'
  // LP Jetton 都是 9 位精度
  const lp = (v: string | null) => (v === null ? null : amount(formatUnits(BigInt(v), 9)))
  const rows: Array<[string, Cell]> = [
    ['协议', TON_LP_PROTOCOLS[plan.protocol].name],
    ['池子', addr(plan.pool)],
    ['交易对', `${s0} / ${s1}`],
    [add ? '存入' : '预计取回（不检查下限）', `${amount(plan.amount0Formatted)} ${s0} + ${amount(plan.amount1Formatted)} ${s1}`],
    [add ? '预计得到的 LP' : '烧掉的 LP', lp(plan.lpAmount)],
    ['LP 下限', add ? lp(plan.minLpOut) : null],
    ['附带 TON（含 gas，多余的退回）', tonAmount(plan.tonAttached)],
  ]
  if (result) {
    const hash = result.txHash ?? result.hash
    rows.push(
      ['状态', tag(result.status + (result.error ? `：${result.error}` : ''), result.status === 'confirmed' ? 'ok' : result.status === 'failed' || result.status === 'reverted' ? 'bad' : '')],
      ['交易', hash ? link(hash) : null],
      ['手续费', result.fee === null ? null : tonAmount(result.fee)],
    )
  }
  const wrap = document.createElement('div')
  wrap.append(
    table(
      ['项目', '值'],
      rows.filter(([, v]) => v !== null),
    ),
    table(
      ['#', '发给', '附带 TON', 'bounce'],
      plan.messages.map((m, i) => [i + 1, addr(m.to), tonAmount(m.value), m.bounce ? '是' : '否']),
    ),
  )
  return wrap
}

bind('runLiqBuild', 'liq', async () => {
  const { action, params } = liquidityRequest()
  const from = liquidityFrom(connection()?.address)
  const plan = action === 'add' ? await buildAddLiquidity(client(), from, params) : await buildRemoveLiquidity(client(), from, params)
  return { data: plan, view: planView(plan) }
})

bind('runLiqSend', 'liq', async () => {
  const { action, params } = liquidityRequest()
  const c = connection() ?? (await modal.open('ton'))
  if (!c) throw new Error('没有连接钱包')
  const expected = testnet() ? '-3' : '-239'
  if (c.chainId !== expected) throw new Error(`钱包在${networkName(c.chainId)}，节点是${networkName(expected)}：请在钱包里切换网络，或改“节点”`)
  liquidityFrom(c.address)
  // TON Connect 实例直接当签名器（钱包里确认）
  const signer = c.provider as never
  const progress = $('liqStats')
  const options = { onUpdate: (r: { status: string }) => (progress.textContent = `交易：${r.status}`) }
  const result = action === 'add' ? await addLiquidity(client(), signer, params, options) : await removeLiquidity(client(), signer, params, options)
  const view = document.createElement('div')
  const note = document.createElement('p')
  note.className = 'hint'
  note.textContent = `结果：${result.status}（可以在“LP 仓位”里重新查询）`
  view.append(note, planView(result.plan, result))
  return { data: result, view }
})
