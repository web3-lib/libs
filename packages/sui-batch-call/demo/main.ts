import { SUI_COIN_TYPE, SuiClient, formatUnits, type NftDetails } from '@w3lib/sui-batch-call'
import { SUI_LP_PROTOCOLS, lpPositions, type SuiLpProtocol } from '@w3lib/sui-batch-call/lp'

// ---- 示例数据 ----

/** 示例地址：持有多种代币的活跃地址（2026-10 时的真实地址） */
const SAMPLE_OWNER = '0xffd4f043057226453aeba59732d41c6093516f54823ebc3a16d17f8a77d2f0ad'

const SAMPLE_COINS = [
  SUI_COIN_TYPE,
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS',
  '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP',
  '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
]

const SAMPLE_OBJECTS = ['0x6', '0x5', '0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab']

/** LP 示例：各 DEX 有仓位的地址和其中一个仓位（2026-10 时的真实仓位，之后可能撤出） */
const SAMPLE_LP: Array<{ protocol: SuiLpProtocol; owner: string; position: string }> = [
  { protocol: 'cetus', owner: '0x4ae27fc3d16fd33bc017ceaed23d5b6242cfe95b9c073a3546b2242f6b354b50', position: '0xfffa73532099a5b655d5d0c3a7827780718c9df98625edc19d61ed4ef617c215' },
  { protocol: 'bluefin', owner: '0x95b9f5ad34c4c987d011e00472591b835906ff2c0381409ccf7038b7c54ebec7', position: '0x00071152cab50d0d2708765869273818e9aa1ec982fc88c93fc6331b1765f478' },
  { protocol: 'momentum', owner: '0xd296f7f43c8c48f1de676eb898398bd36401a16cec5000245c19626b2897c359', position: '0x00017c08b581aef1bb6e742cc072b1c2c17d9cec629fa5f9dbaad466f47c620e' },
  { protocol: 'turbos', owner: '0xa7b9ddd98dbcde45276dc204a1a20a1ff15c129da6a5ec997301cbc9ba179a24', position: '0xd4f9ddf81688146dd1843d00e9ff3f092ce6b55a7d01f4d337e2df05255e32b2' },
  { protocol: 'magma', owner: '0x9b42721c812a1eccf083038313b05833c0c7bd1be47d77382066e77623329b0f', position: '0xfe57d2b1cd66230b0b157b92b710183f8a333742c1bdec57a383b23b7a097ab7' },
  { protocol: 'flowx', owner: '0xc02b3a404ff72ffede0f6ebf0356f4f5c0ba5431c0e052fb1eb086ebf0713334', position: '0x09adb02c9a250c04360da87466bd15500d5b8b8fffcc42f79092f80e2a803d92' },
]

// ---- 设置（存在 localStorage，刷新后保留） ----

interface Settings {
  node: string
  owner: string
}

const SETTINGS_KEY = 'w3lib-demo:sui'

function loadSettings(): Settings {
  let stored: Partial<Settings> = {}
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') ?? {}
  } catch {
    // 存的不是 JSON：用默认的
  }
  return {
    node: typeof stored.node === 'string' ? stored.node : '',
    owner: typeof stored.owner === 'string' ? stored.owner : '',
  }
}

const settings = loadSettings()
const save = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const nodeInput = $<HTMLInputElement>('node')
const ownerInput = $<HTMLInputElement>('owner')

nodeInput.value = settings.node
ownerInput.value = settings.owner
$<HTMLTextAreaElement>('balanceCoins').value = SAMPLE_COINS.join('\n')
$<HTMLTextAreaElement>('coinTypes').value = SAMPLE_COINS.join('\n')
$<HTMLTextAreaElement>('objectIds').value = SAMPLE_OBJECTS.join('\n')

nodeInput.addEventListener('change', () => {
  settings.node = nodeInput.value.trim()
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

const lpSample = $<HTMLSelectElement>('lpSample')
for (const [i, s] of SAMPLE_LP.entries()) lpSample.add(new Option(SUI_LP_PROTOCOLS[s.protocol].name, String(i)))
lpSample.addEventListener('change', () => {
  const sample = SAMPLE_LP[Number(lpSample.value)]
  lpSample.value = ''
  if (!sample) return
  ownerInput.value = sample.owner
  ownerInput.dispatchEvent(new Event('change'))
  // 只填地址：扫描地址拥有的全部仓位（也可以在上面填仓位 ID 只查某几个）
  $<HTMLTextAreaElement>('lpPositions').value = ''
})

// ---- 客户端：记录每个 gRPC 调用（方法名、耗时、状态） ----

interface RequestEvent {
  method: string
  ms: number
  ok: boolean
}

let listener: ((e: RequestEvent) => void) | null = null

/** 包一层 fetch：统计查询期间的 gRPC-web 调用（URL 的最后一段是方法名；DefiLlama 查价也会经过它） */
const countingFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const method = url.host.endsWith('llama.fi') ? 'DefiLlama' : (url.pathname.split('/').pop() ?? url.pathname)
  const start = performance.now()
  try {
    const res = await fetch(input, init)
    // gRPC 的错误在响应头或 trailer 里（HTTP 状态是 200）：这里只按 HTTP 状态统计
    listener?.({ method, ms: performance.now() - start, ok: res.ok })
    return res
  } catch (err) {
    listener?.({ method, ms: performance.now() - start, ok: false })
    throw err
  }
}

let cached: { node: string; client: SuiClient } | null = null
function client(): SuiClient {
  if (cached?.node !== settings.node) cached = { node: settings.node, client: new SuiClient(settings.node || undefined, { fetch: countingFetch }) }
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

/** 用 textContent 填表格：代币名称、symbol、Display 来自链上，不能当 HTML 插入 */
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

/** 地址、对象 ID 缩写；代币类型只缩写开头的包地址（0x2::sui::SUI 这样的短类型原样显示） */
function addr(value: string | null | undefined): Node {
  const span = document.createElement('span')
  span.className = 'addr'
  span.title = value ?? ''
  if (!value) span.textContent = '—'
  else {
    const [pkg = '', ...rest] = value.split('::')
    const short = pkg.length > 14 ? `${pkg.slice(0, 6)}…${pkg.slice(-4)}` : pkg
    span.textContent = [short, ...rest].join('::')
  }
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

/** 价格可能很小（如 meme 币对 SUI），按有效数字显示 */
function price(v: number | null): string {
  if (v === null) return '—'
  // 只去掉小数部分末尾的 0（150000 不能变成 15）
  const [mantissa = '', exponent] = v.toPrecision(6).split('e')
  const trimmed = mantissa.includes('.') ? mantissa.replace(/\.?0+$/, '') : mantissa
  return exponent === undefined ? trimmed : `${trimmed}e${exponent}`
}

function rawJson(data: unknown): HTMLElement {
  const details = document.createElement('details')
  const summary = document.createElement('summary')
  summary.textContent = '原始结果（JSON）'
  const pre = document.createElement('pre')
  pre.className = 'output'
  pre.textContent = JSON.stringify(data, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? `<${v.length} bytes>` : v), 2)
  details.append(summary, pre)
  return details
}

function describeRequests(events: RequestEvent[], ms: number): string {
  const byMethod = new Map<string, number>()
  for (const e of events) byMethod.set(e.method, (byMethod.get(e.method) ?? 0) + 1)
  const methods = [...byMethod].map(([m, n]) => `${m} ×${n}`).join('、')
  const failed = events.filter((e) => !e.ok).length
  return [`${ms} ms`, `${events.length} 次调用${methods ? `（${methods}）` : ''}`, failed ? `${failed} 次失败后重试 / 换节点` : ''].filter(Boolean).join(' · ')
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
    listener = (e) => events.push(e)
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
  const coinTypes = lines($<HTMLTextAreaElement>('balanceCoins').value)
  const list = await client().balances(owner(), coinTypes.length ? coinTypes : undefined, { symbol: true })
  return {
    data: list,
    view: table(
      ['代币', '余额', '类型', '状态'],
      list.map((b) => [b.symbol ?? null, amount(b.formatted), addr(b.token), b.success ? tag('ok', 'ok') : tag(b.error ?? 'failed', 'bad')]),
      [1],
    ),
  }
})

bind('runCoins', 'coins', async () => {
  const list = await client().coins(lines($<HTMLTextAreaElement>('coinTypes').value))
  return {
    data: list,
    view: table(
      ['symbol', '名称', '精度', '总供应量', '类型', '状态'],
      list.map((c) => [
        c.symbol,
        c.name,
        c.decimals,
        c.totalSupply === null || c.decimals === null ? null : amount(formatUnits(BigInt(c.totalSupply), c.decimals)),
        addr(c.token),
        c.success ? tag('ok', 'ok') : tag(c.error ?? 'failed', 'bad'),
      ]),
      [2, 3],
    ),
  }
})

bind('runLp', 'lp', async () => {
  const positions = lines($<HTMLTextAreaElement>('lpPositions').value)
  const prices = $<HTMLInputElement>('lpPrices').checked
  let priceError: unknown = null
  const protocolErrors: string[] = []
  const list = await lpPositions(client(), owner(), {
    ...(positions.length ? { positions } : {}),
    prices,
    fetch: countingFetch,
    onPriceError: (err) => {
      priceError = err
    },
    onError: (protocol, err) => protocolErrors.push(`${SUI_LP_PROTOCOLS[protocol].name}：${err instanceof Error ? err.message : String(err)}`),
  })
  const sym = (t: { symbol: string | null }) => t.symbol ?? '?'
  const view = table(
    ['协议', '交易对', '数量', '未领取手续费', '奖励', '区间', '价值', '仓位'],
    list.map((p) => {
      const amounts = p.amount0Formatted === null ? null : `${amount(p.amount0Formatted)} ${sym(p.token0)} + ${amount(p.amount1Formatted)} ${sym(p.token1)}`
      const fees = p.fees0Formatted === null ? null : `${amount(p.fees0Formatted)} + ${amount(p.fees1Formatted)}${prices ? `（${usd(p.feesUsd)}）` : ''}`
      // 池子的奖励代币可能有好几个，只显示有未领取数量的（完整列表在原始 JSON 里）
      const pending = p.rewards?.filter((r) => r.amount !== '0') ?? null
      const rewards = pending === null ? null : pending.length ? pending.map((r) => `${amount(r.formatted)} ${r.symbol ?? '?'}`).join('、') : '—'
      const range = p.priceLower === null ? '—' : `${price(p.priceLower)} ~ ${price(p.priceUpper)}`
      return [
        p.restricted ? wrapWith(p.protocolName, tag('受限', 'bad')) : p.protocolName,
        `${sym(p.token0)} / ${sym(p.token1)} · ${p.fee / 10_000}%`,
        amounts,
        fees,
        rewards,
        p.inRange === null ? range : tag(range, p.inRange ? 'ok' : 'bad'),
        prices ? usd(p.valueUsd) : null,
        addr(p.position),
      ]
    }),
  )
  return { data: list, view: withWarnings(view, [...(priceError === null ? [] : [`价格服务出错，这次没有美元价值：${errorText(priceError)}`]), ...protocolErrors.map((e) => `读取出错，跳过了这个协议的仓位：${e}`)]) }
})

function wrapWith(text: string, node: Node): Node {
  const span = document.createElement('span')
  span.append(`${text} `, node)
  return span
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** 价格服务或某个协议出错时在结果上方提示（这时价值列显示 —，但不是代币没有价格） */
function withWarnings(view: Node, warnings: string[]): Node {
  if (!warnings.length) return view
  const wrap = document.createElement('div')
  for (const w of warnings) {
    const note = document.createElement('p')
    note.className = 'hint'
    note.textContent = w
    wrap.append(note)
  }
  wrap.append(view)
  return wrap
}

function nftTable(list: NftDetails[]): HTMLElement {
  return table(
    ['名称', '项目', '类型', 'Display', '对象'],
    list.map((n) => [n.name, n.projectUrl, addr(n.type), n.display ? tag('有', 'ok') : '内容字段', addr(n.objectId)]),
  )
}

bind('runNft', 'nft', async () => {
  const type = $<HTMLInputElement>('nftType').value.trim()
  const list = await client().nfts(owner(), { limit: 100, ...(type ? { type } : {}) })
  return { data: list, view: nftTable(list) }
})

bind('runObjects', 'objects', async () => {
  const ids = lines($<HTMLTextAreaElement>('objectIds').value)
  const list = await client().objects(ids, { fields: ['type', 'owner', 'json'] })
  return {
    data: list,
    view: table(
      ['对象', '类型', '所有者', '版本', '状态'],
      list.map((o, i) => [
        addr(o?.objectId ?? ids[i]),
        addr(o?.type),
        !o?.owner ? null : o.owner.address ? wrapWith(o.owner.kind, addr(o.owner.address)) : o.owner.kind,
        o?.version === null || o?.version === undefined ? null : o.version.toString(),
        o ? tag('ok', 'ok') : tag('不存在', 'bad'),
      ]),
      [3],
    ),
  }
})
