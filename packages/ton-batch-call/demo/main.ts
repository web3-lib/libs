import { mountShell } from '../../demo-shared/shell'
import { batchTransfer } from '@w3lib/ton-batch-call/write'
import { NATIVE_TON, TonClient, formatUnits, isValidTonAddress, parseUnits, sameTonAddress, type NftDetails } from '@w3lib/ton-batch-call'
import { estimateCost, type FeeCall, type TonCostEstimate } from '@w3lib/ton-batch-call/fees'
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
import { lookupAddresses, resolveNames } from '@w3lib/ton-batch-call/names'
import { defillamaPrices, portfolio, tokenPrices, type TonPriceSource } from '@w3lib/ton-batch-call/price'
import { history, type Activity } from '@w3lib/ton-batch-call/history'
import { tokenRisks, type TonTokenRisk } from '@w3lib/ton-batch-call/risk'
import { simulateTransaction, type SimulationResult } from '@w3lib/ton-batch-call/simulate'
import { buildSwap, swap, type SwapParams, type SwapResult, type TonSwapPlan, type TonSwapRoute } from '@w3lib/ton-batch-call/swap'
import { createWallet } from '@w3lib/wallet'
import { ton } from '@w3lib/wallet/ton'
import { createWalletModal } from '@w3lib/wallet/ui'

// 外壳：侧边分组导航 + 设置 / 连接面板（见 packages/demo-shared/shell.ts）
mountShell()

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

/** 域名示例：foundation.ton、Fragment 上的 stud.t.me，和一个没注册的名字（2026-10 主网） */
const SAMPLE_NAMES = ['foundation.ton', 'stud.t.me', 'nobody-here-12345.ton']
/** 反查示例：持有 tolya.ton 的地址 */
const SAMPLE_NAME_OWNERS = ['UQCdqXGvONLwOr3zCNX5FjapflorB6ZsOdcdfLrjsDLt3AF4']
/** 兑换示例的买入代币：USD₮ */
const SAMPLE_USDT = SAMPLE_JETTONS[0] as string

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
  // 没填地址时用已连接钱包的地址
  const value = ownerInput.value.trim() || connection()?.address || ''
  if (!value) throw new Error('请先在顶部“地址”里填写地址（或点“示例地址”，或连接钱包）')
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

/** LP 查询（“LP 仓位”页的按钮和“加载我的仓位”共用） */
async function queryLp() {
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
}
bind('runLp', 'lp', queryLp)

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
  // 连上钱包、地址栏还空着：填上钱包地址（查询默认查自己的钱包）
  if (c && !ownerInput.value.trim()) {
    ownerInput.value = c.address
    ownerInput.dispatchEvent(new Event('change'))
  }
  if (!c) {
    $('walletInfo').textContent = '未连接（只读查询不需要钱包）'
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
  liq.position.replaceChildren(...(options.length ? options : [new Option('没有仓位：点右边“加载我的仓位”，或在“LP 仓位”页查询', '')]))
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

// ---- 价格（子路径 /price） ----

$<HTMLTextAreaElement>('priceTokens').value = SAMPLE_JETTONS.join('\n')

/** 价格源：默认 DefiLlama + 链上池子；勾选“只用 DefiLlama”时只用前者（链上价格每个代币要几次请求） */
function priceSources(): { sources?: readonly TonPriceSource[] } {
  return $<HTMLInputElement>('priceFast').checked ? { sources: [defillamaPrices()] } : {}
}

bind('runPrices', 'price', async () => {
  const tokens = lines($<HTMLTextAreaElement>('priceTokens').value)
  let priceError: unknown = null
  const list = await tokenPrices(client(), [NATIVE_TON, ...tokens], {
    ...priceSources(),
    fetch: countingFetch,
    onError: (_source, err) => {
      priceError = err
    },
  })
  return {
    data: list,
    view: withPriceWarning(
      table(
        ['代币', '美元价格', '来源'],
        list.map((p) => [p.native ? 'TON' : addr(p.token), p.price === null ? null : `$${p.price.toLocaleString('en-US', { maximumSignificantDigits: 6 })}`, p.source ?? tag('没有价格', 'bad')]),
        [1],
      ),
      priceError,
    ),
  }
})

bind('runPortfolio', 'price', async () => {
  let priceError: unknown = null
  const p = await portfolio(client(), owner(), {
    ...priceSources(),
    lp: $<HTMLInputElement>('priceLp').checked,
    fetch: countingFetch,
    onPriceError: (err) => {
      priceError = err
    },
  })
  const wrap = document.createElement('div')
  wrap.append(
    table(
      ['项目', '值'],
      [
        ['合计', usd(p.totalUsd)],
        ['代币', usd(p.tokensUsd)],
        ['LP 仓位', usd(p.lpUsd)],
        ['有余额但没有价值的代币', p.unpriced],
      ],
    ),
    table(
      ['代币', '余额', '价格', '价值', '来源'],
      p.tokens.map((t) => [
        t.symbol ?? (t.native ? 'TON' : addr(t.token)),
        amount(t.formatted),
        t.price === null ? null : `$${t.price.toLocaleString('en-US', { maximumSignificantDigits: 6 })}`,
        t.decimalsUnknown ? tag('精度未知', 'bad') : usd(t.value),
        t.priceSource,
      ]),
      [1, 2, 3],
    ),
  )
  if (p.lp.length) {
    wrap.append(
      table(
        ['协议', 'LP 交易对', '份额', '价值'],
        p.lp.map((l) => [l.protocolName, pairOf(l), `${(l.share * 100).toLocaleString('en-US', { maximumSignificantDigits: 3 })}%`, usd(l.valueUsd)]),
        [3],
      ),
    )
  }
  return { data: p, view: withPriceWarning(wrap, priceError) }
})

// ---- 域名解析（子路径 /names） ----

$<HTMLTextAreaElement>('nameList').value = SAMPLE_NAMES.join('\n')
$<HTMLTextAreaElement>('nameAddrs').value = SAMPLE_NAME_OWNERS.join('\n')

bind('runNames', 'names', async () => {
  const names = lines($<HTMLTextAreaElement>('nameList').value)
  if (!names.length) throw new Error('请填写名字，每行一个')
  const list = await resolveNames(client(), names)
  return {
    data: list,
    view: table(
      ['名字', '规范化', '地址', '服务'],
      list.map((r) => [r.name, r.normalized ?? tag('名字不合法', 'bad'), r.address ? addr(r.address) : r.normalized ? tag('没有钱包记录', '') : null, r.service ?? (r.normalized ? tag('没有服务认这个后缀', '') : null)]),
    ),
  }
})

bind('runAddrNames', 'names', async () => {
  const addresses = lines($<HTMLTextAreaElement>('nameAddrs').value)
  if (!addresses.length) throw new Error('请填写地址，每行一个')
  const list = await lookupAddresses(client(), addresses, { verify: $<HTMLInputElement>('nameVerify').checked })
  return {
    data: list,
    view: table(
      ['地址', '名字', '服务'],
      list.map((r) => [addr(r.address), r.name ?? tag('没有名字', ''), r.service]),
    ),
  }
})

// ---- 兑换（子路径 /swap；写在手续费估算之前：后者可以估算兑换的消息） ----

const sw = {
  tokenIn: $<HTMLInputElement>('swapIn'),
  tokenOut: $<HTMLInputElement>('swapOut'),
  amount: $<HTMLInputElement>('swapAmount'),
  protocol: $<HTMLSelectElement>('swapProtocol'),
  slippage: $<HTMLInputElement>('swapSlippage'),
  dry: $<HTMLInputElement>('swapDry'),
}
sw.tokenOut.value = SAMPLE_USDT

/** 上一次兑换报价：手续费估算可以估算它的消息（from 是报价的账户） */
let lastSwap: { plan: TonSwapPlan; from: string } | null = null

function renderSwapWallet() {
  const c = connection()
  if (!c) {
    $('swapWalletInfo').textContent = '未连接（报价时用顶部的地址）'
    $('swapConnect').textContent = '连接钱包'
    return
  }
  $('swapWalletInfo').textContent = `${c.walletName} · ${c.address}`
  $('swapConnect').textContent = '切换 / 断开'
}
wallet.subscribe(() => renderSwapWallet())
void wallet.ready.then(renderSwapWallet)
$('swapConnect').addEventListener('click', () => void modal.open('ton'))

/** TON 或 Jetton 主合约地址 */
function swapToken(input: HTMLInputElement, label: string): string {
  const value = input.value.trim()
  if (!value) throw new Error(`请填写${label}的代币（TON 或 Jetton 主合约地址）`)
  if (value.toUpperCase() === NATIVE_TON) return NATIVE_TON
  if (!isValidTonAddress(value)) throw new Error(`${label}的代币地址不合法：${value}`)
  return value
}

function swapRequest() {
  const tokenIn = swapToken(sw.tokenIn, '卖出')
  const tokenOut = swapToken(sw.tokenOut, '买入')
  if (tokenIn === tokenOut) throw new Error('卖出和买入是同一个代币')
  const amountInFormatted = text(sw.amount)
  if (!amountInFormatted || !/^\d*\.?\d+$/.test(amountInFormatted) || !(Number(amountInFormatted) > 0)) throw new Error(`卖出的数量要是大于 0 的数字：${amountInFormatted ?? '（空）'}`)
  const percent = numberOf(sw.slippage, '滑点')
  if (percent !== undefined && !(percent >= 0 && percent < 100)) throw new Error('滑点要在 0 ~ 100% 之间')
  const protocol = sw.protocol.value as TonLpProtocol | ''
  const params: SwapParams = { tokenIn, tokenOut, amountInFormatted }
  const options = { ...(percent === undefined ? {} : { slippage: percent / 100 }), ...(protocol ? { protocols: [protocol] } : {}) }
  return { params, options }
}

const shortAddr = (a: string) => (a === NATIVE_TON || a.length <= 14 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`)
function swapView(plan: TonSwapPlan, result?: SwapResult): Node {
  const sIn = plan.tokenIn.symbol ?? 'token'
  const sOut = plan.tokenOut.symbol ?? 'token'
  const rows: Array<[string, Cell]> = [
    ['协议', plan.route.protocolName],
    ['路线', plan.route.path.map(shortAddr).join(' → ')],
    ['卖出', `${amount(plan.amountInFormatted)} ${sIn}`],
    ['报价', `${amount(plan.amountOutFormatted)} ${sOut}`],
    ['最少收到（滑点保护）', `${amount(plan.amountOutMinFormatted)} ${sOut}`],
    ['价格', plan.price === null ? null : `1 ${sIn} = ${plan.price.toLocaleString('en-US', { maximumSignificantDigits: 6 })} ${sOut}`],
    ['价格影响', plan.priceImpact === null ? null : `${(plan.priceImpact * 100).toFixed(3)}%`],
    ['收款地址', addr(plan.recipient)],
    ['附带 TON（含 gas，多余的退回）', tonAmount(plan.tonAttached)],
  ]
  if (result) {
    const hash = result.txHash ?? result.hash
    rows.push(
      ['状态', tag(result.status + (result.error ? `：${result.error}` : ''), result.status === 'confirmed' || result.status === 'simulated' ? 'ok' : result.status === 'failed' || result.status === 'reverted' ? 'bad' : '')],
      [result.status === 'simulated' ? '模拟里收到' : '实际收到', result.amountReceived === null ? null : `${amount(formatUnits(BigInt(result.amountReceived), plan.tokenOut.decimals))} ${sOut}`],
      ['交易', hash && result.status !== 'simulated' ? link(hash) : null],
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
      ['路线（从高到低）', '报价'],
      plan.routes.map((r) => [`${r.protocolName} · ${r.path.map(shortAddr).join(' → ')}（${r.pools.length} 跳）`, `${amount(formatUnits(BigInt(r.amountOut), plan.tokenOut.decimals))} ${sOut}`]),
      [1],
    ),
    table(
      ['#', '发给', '附带 TON', 'bounce'],
      plan.messages.map((m, i) => [i + 1, addr(m.to), tonAmount(m.value), m.bounce ? '是' : '否']),
    ),
  )
  return wrap
}

bind('runSwapQuote', 'swap', async () => {
  const { params, options } = swapRequest()
  const from = connection()?.address ?? owner()
  const plan = await buildSwap(client(), from, params, options)
  lastSwap = { plan, from }
  return { data: plan, view: swapView(plan) }
})

bind('runSwapSend', 'swap', async () => {
  const { params, options } = swapRequest()
  if (testnet()) throw new Error('兑换只支持主网：请改“节点”')
  const c = connection() ?? (await modal.open('ton'))
  if (!c) throw new Error('没有连接钱包')
  if (c.chainId !== '-239') throw new Error(`钱包在${networkName(c.chainId)}，兑换要在主网：请在钱包里切换网络`)
  const dryRun = sw.dry.checked
  const progress = $('swapStats')
  // TON Connect 实例直接当签名器（钱包里确认）；dryRun 只模拟整条交易链，不发送
  const result = await swap(client(), c.provider as never, params, { ...options, dryRun, onUpdate: (r) => (progress.textContent = `交易：${r.status}`) })
  lastSwap = { plan: result.plan, from: c.address }
  const view = document.createElement('div')
  const note = document.createElement('p')
  note.className = 'hint'
  note.textContent = dryRun ? `只模拟了整条交易链（没有发送）：${result.status}` : `结果：${result.status}`
  view.append(note, swapView(result.plan, result))
  return { data: result, view }
})

// ---- 手续费估算（子路径 /fees） ----

const fee = { kind: $<HTMLSelectElement>('feeKind'), to: $<HTMLInputElement>('feeTo'), amount: $<HTMLInputElement>('feeAmount') }
fee.kind.addEventListener('change', () => {
  $('feeTransfer').hidden = fee.kind.value !== 'transfer'
})

function feeCall(): FeeCall {
  if (fee.kind.value === 'swap') {
    if (!lastSwap) throw new Error('请先在“兑换”里报价')
    // 兑换的消息按报价时的账户估算（消息里的收款地址、数量都是为它构建的）
    return { from: lastSwap.from, messages: lastSwap.plan.messages }
  }
  const to = text(fee.to)
  if (!to) throw new Error('请填写收款地址')
  if (!isValidTonAddress(to)) throw new Error(`收款地址不合法：${to}`)
  const value = parseUnits(text(fee.amount) ?? '', 9)
  if (value <= 0n) throw new Error('转账的数量要大于 0')
  return { from: connection()?.address ?? owner(), messages: [{ to, value, bounce: false }] }
}

function feeView(e: TonCostEstimate): Node {
  const ton = (nano: string | null, formatted: string | null) => (nano === null ? null : `${amount(formatted)} TON`)
  const rows: Array<[string, Cell]> = [
    ['发送的钱包', addr(e.from)],
    ['模拟', e.simulated ? (e.error ? tag(`失败：${e.error}`, 'bad') : tag('通过', 'ok')) : tag(`没有模拟结果${e.error ? `：${e.error}` : ''}`, 'bad')],
    ['钱包付的手续费', ton(e.fee, e.feeFormatted)],
    ['附带的 TON', ton(e.attached, e.attachedFormatted)],
    ['退回钱包的 TON', ton(e.returned, e.returnedFormatted)],
    ['钱包余额净变化', ton(e.balanceChange, e.balanceChangeFormatted)],
    ['整条链的手续费', ton(e.chainFee, e.chainFeeFormatted)],
    ['交易链被截断', e.incomplete ? tag('是：退回和整条链的数值只算了已有的部分', 'bad') : null],
  ]
  if (e.walletFees) {
    for (const [label, key] of [['导入外部消息', 'import'], ['存储费', 'storage'], ['计算（gas）', 'gas'], ['动作', 'action'], ['转发费其余部分', 'forward']] as const) {
      rows.push([`钱包交易：${label}`, `${amount(formatUnits(BigInt(e.walletFees[key]), 9))} TON`])
    }
  }
  return table(
    ['项目', '值'],
    rows.filter(([, v]) => v !== null),
  )
}

bind('runFees', 'fees', async () => {
  const estimate = await estimateCost(client(), feeCall())
  return { data: estimate, view: feeView(estimate) }
})

// ---- Jetton 风险检查（子路径 /risk） ----

$<HTMLTextAreaElement>('riskTokens').value = SAMPLE_JETTONS.join('\n')

const BAD_FLAGS = new Set(['scam', 'not-found', 'honeypot', 'cannot-buy', 'high-buy-tax', 'high-sell-tax', 'unknown-wallet-code'])

function riskFlags(r: TonTokenRisk): Node {
  const wrap = document.createElement('span')
  if (!r.flags.length) {
    wrap.append(tag('没有标记', 'ok'))
    return wrap
  }
  r.flags.forEach((f, i) => {
    if (i) wrap.append(' ')
    wrap.append(tag(f, BAD_FLAGS.has(f) ? 'bad' : ''))
  })
  return wrap
}

const percentOf = (v: number | null) => (v === null ? '—' : `${(v * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`)

function tradeCell(r: TonTokenRisk): Cell {
  const t = r.trade
  if (!t) return null
  const wrap = document.createElement('span')
  wrap.append(tag(t.stage, t.stage === 'ok' ? 'ok' : 'bad'))
  if (t.stage === 'ok' || t.buyTax !== null || t.sellTax !== null) wrap.append(` 买入税 ${percentOf(t.buyTax)} / 卖出税 ${percentOf(t.sellTax)}`)
  if (t.error) wrap.append(` ${t.error}`)
  return wrap
}

bind('runRisk', 'risk', async () => {
  const tokens = lines($<HTMLTextAreaElement>('riskTokens').value)
  if (!tokens.length) throw new Error('请填写 Jetton 主合约地址，每行一个')
  const simulate = $<HTMLInputElement>('riskSim').checked
  const buyAmount = parseUnits($<HTMLInputElement>('riskBuy').value.trim(), 9)
  if (buyAmount <= 0n) throw new Error('模拟买入的 TON 要大于 0')
  const list = await tokenRisks(client(), tokens, simulate ? { simulate, buyAmount } : {})
  return {
    data: list,
    view: table(
      ['symbol', '名称', 'admin', '可增发', '钱包代码', '风险标记', ...(simulate ? ['模拟买卖'] : []), '主合约'],
      list.map((r) => [
        r.symbol,
        r.name,
        r.error ? null : r.admin ? addr(r.admin) : tag('已放弃', 'ok'),
        r.mintable === null ? null : r.mintable ? '是' : '否',
        r.walletCode ?? (r.error ? null : tag('不认识', 'bad')),
        r.error ? tag(r.error, 'bad') : riskFlags(r),
        ...(simulate ? [tradeCell(r)] : []),
        addr(r.address ?? r.token),
      ]),
    ),
  }
})

// ---- 模拟（子路径 /simulate） ----

const sim = { kind: $<HTMLSelectElement>('simKind'), to: $<HTMLInputElement>('simTo'), amount: $<HTMLInputElement>('simAmount') }
sim.kind.addEventListener('change', () => {
  $('simTransfer').hidden = sim.kind.value !== 'transfer'
})

function simView(r: SimulationResult): Node {
  const wrap = document.createElement('div')
  const rows: Array<[string, Cell]> = [
    ['结果', !r.simulated ? tag(`没有模拟结果：${r.error}`, 'bad') : r.success ? tag('成功', 'ok') : tag(`失败：${r.error}`, 'bad')],
    ['说明', r.decoded.summary],
    ['类型', [r.decoded.type, r.decoded.protocol].filter(Boolean).join(' · ')],
    ['钱包付的手续费', r.fees ? `${amount(formatUnits(BigInt(r.fees.wallet), 9))} TON` : null],
    ['整条链的手续费', r.fees ? `${amount(formatUnits(BigInt(r.fees.total), 9))} TON（gas ${amount(formatUnits(BigInt(r.fees.gas), 9))}、转发 ${amount(formatUnits(BigInt(r.fees.forward), 9))}、存储 ${amount(formatUnits(BigInt(r.fees.storage), 9))}）` : null],
    ['警告', r.warnings.length ? r.warnings.map((w) => `${w.code}：${w.message}`).join('\n') : null],
  ]
  wrap.append(
    table(['项目', '值'], rows.filter(([, v]) => v !== null && v !== '')),
    table(
      ['地址', '资产', '变化'],
      r.balanceChanges.map((c) => [addr(c.address), c.symbol, `${c.formatted.startsWith('-') ? '' : '+'}${amount(c.formatted)}`]),
    ),
  )
  return wrap
}

bind('runSim', 'sim', async () => {
  let call: FeeCall
  if (sim.kind.value === 'swap') {
    if (!lastSwap) throw new Error('请先在“兑换”里报价')
    call = { from: lastSwap.from, messages: lastSwap.plan.messages }
  } else {
    const to = text(sim.to)
    if (!to) throw new Error('请填写收款地址')
    if (!isValidTonAddress(to)) throw new Error(`收款地址不合法：${to}`)
    const value = parseUnits(text(sim.amount) ?? '', 9)
    if (value <= 0n) throw new Error('转账的数量要大于 0')
    call = { from: connection()?.address ?? owner(), messages: [{ to, value, bounce: false }] }
  }
  const result = await simulateTransaction(client(), call)
  return { data: result, view: simView(result) }
})

// ---- 交易历史（子路径 /history） ----

let historyCursor: string | undefined
/** 游标属于哪次查询（地址、网络）：换了之后“下一页”不能接着用旧游标 */
let historyFor = ''
const historyKey = () => [owner(), client().network].join('|')
const moreHistory = $<HTMLButtonElement>('moreHistory')

function historyView(items: Activity[]): Node {
  return table(
    ['时间', '类型', '状态', '说明', '变化'],
    items.map((a) => [
      new Date(a.time * 1000).toLocaleString(),
      [a.type, a.direction].filter(Boolean).join(' · '),
      a.status === 'success' ? tag('成功', 'ok') : tag('失败', 'bad'),
      a.label,
      a.changes.map((c) => `${c.formatted.startsWith('-') ? '' : '+'}${amount(c.formatted)} ${c.symbol}`).join('\n'),
    ]),
  )
}

async function loadHistory(cursor: string | undefined) {
  // 发请求前记下这次查询的条件：等待期间改了表单，游标也只属于发出去的那次查询
  const key = historyKey()
  const page = await history(client(), owner(), { limit: 10, cursor })
  historyCursor = page.nextCursor
  historyFor = key
  moreHistory.disabled = !historyCursor
  return { data: page, view: historyView(page.items) }
}

bind('runHistory', 'history', () => loadHistory(undefined))
// “下一页”按钮的禁用状态会被 bind 在查询结束时恢复，不能只靠它：这里再检查一次
bind('moreHistory', 'history', () => {
  if (!historyCursor) throw new Error('没有下一页：请先点“查询”')
  if (historyFor !== historyKey()) throw new Error('地址或网络变了：请重新点“查询”')
  return loadHistory(historyCursor)
})

// ---- 批量转账（子路径 /write） ----

const bt = { recipients: $<HTMLTextAreaElement>('btRecipients'), token: $<HTMLInputElement>('btToken'), dry: $<HTMLInputElement>('btDry') }

bind('runBt', 'bt', async () => {
  const rows = bt.recipients.value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [to, formatted] = l.split(/[\s,]+/)
      if (!to || !formatted) throw new Error(`格式不对：${l}（每行“地址 数量”）`)
      return { to, formatted }
    })
  if (!rows.length) throw new Error('请填收款地址和数量')
  if (rows.length > 200) throw new Error('demo 一次最多 200 个收款人')
  const dryRun = bt.dry.checked
  const token = bt.token.value.trim()
  const c = connection() ?? (await modal.open('ton'))
  if (!c) throw new Error('没有连接钱包')
  const expected = testnet() ? '-3' : '-239'
  if (c.chainId !== expected) throw new Error(`钱包在${networkName(c.chainId)}，节点是${networkName(expected)}：请在钱包里切换网络，或改“节点”`)
  if (!dryRun && !confirm(`用 ${c.address} 向 ${rows.length} 个地址转${token ? `（${token}）` : ' TON'}，确认发送？`)) throw new Error('已取消')
  const progress = $('btStats')
  const results = await batchTransfer(client(), c.provider as never, rows, {
    ...(token ? { token } : {}),
    dryRun,
    onUpdate: (r) => (progress.textContent = `第 ${r.index + 1} 项：${r.status}`),
  })
  return {
    data: results,
    view: table(
      ['#', '收款', '数量', '状态', '交易'],
      results.map((r, i) => [i + 1, addr(r.to), r.formatted ?? r.amount, tag(r.status + (r.error ? `：${r.error}` : ''), r.status === 'confirmed' || r.status === 'simulated' ? 'ok' : r.status === 'failed' || r.status === 'reverted' ? 'bad' : ''), r.hash ? link(r.hash) : null]),
      [2],
    ),
  }
})

// 仓位下拉框的内容来自 LP 查询：这里直接调用同一个查询（同一个地址），不用切页
$('liqLoad').addEventListener('click', async () => {
  const status = $('liqLoadStatus')
  const button = $<HTMLButtonElement>('liqLoad')
  button.disabled = true
  status.textContent = '查询中…'
  try {
    await queryLp()
    const count = Array.from($<HTMLSelectElement>('liqPosition').options).filter((o) => o.value).length
    status.textContent = `找到 ${count} 个仓位`
  } catch (err) {
    status.textContent = `查询失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    button.disabled = false
  }
})
