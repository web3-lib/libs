import { NATIVE_TON, TonClient, formatUnits, type NftDetails } from '@w3lib/ton-batch-call'
import { lpPositions } from '@w3lib/ton-batch-call/lp'

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
      stats.textContent = `查询中…已发出 ${events.length} 次请求`
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
  const list = await lpPositions(client(), owner(), {
    prices,
    fetch: countingFetch,
    onPriceError: (err) => {
      priceError = err
    },
  })
  return {
    data: list,
    view: withPriceWarning(
      table(
        ['协议', '交易对', '撤出可得', '份额', '手续费', '池子类型', '价值', '池子'],
        list.map((p) => [
          p.protocolName,
          `${p.token0.symbol ?? '?'} / ${p.token1.symbol ?? '?'}`,
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
