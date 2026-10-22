import { mountShell } from '../../demo-shared/shell'
import { SUI_COIN_TYPE, SuiClient, formatUnits, normalizeSuiAddress, parseUnits, type NftDetails } from '@w3lib/sui-batch-call'
import { estimateCost, estimateFees } from '@w3lib/sui-batch-call/fees'
import { getHistoryOf, graphqlHistory, grpcHistory, type Activity } from '@w3lib/sui-batch-call/history'
import {
  addLiquidity,
  buildAddLiquidity,
  buildCollectFees,
  buildRemoveLiquidity,
  collectFees,
  removeLiquidity,
  type AddLiquidityParams,
  type AddLiquidityPlan,
  type LiquidityResult,
  type RemoveLiquidityParams,
  type RemoveLiquidityPlan,
} from '@w3lib/sui-batch-call/liquidity'
import { SUI_LP_PROTOCOLS, lpPositions, type SuiLpPosition, type SuiLpProtocol } from '@w3lib/sui-batch-call/lp'
import { lookupAddresses, resolveNames } from '@w3lib/sui-batch-call/names'
import { defillamaPrices, portfolio, tokenPrices } from '@w3lib/sui-batch-call/price'
import { coinRisks, type CapHolder } from '@w3lib/sui-batch-call/risk'
import { simulateTx } from '@w3lib/sui-batch-call/simulate'
import { buildSwap, swap, type SwapOptions, type SwapParams, type SwapPlan, type SwapResult } from '@w3lib/sui-batch-call/swap'
import { PtbBuilder, batchTransfer, pure } from '@w3lib/sui-batch-call/write'
import { createWallet } from '@w3lib/wallet'
import { sui } from '@w3lib/wallet/sui'
import { createWalletModal } from '@w3lib/wallet/ui'

// 外壳：侧边分组导航 + 设置 / 连接面板（见 packages/demo-shared/shell.ts）
mountShell()

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

/** SuiNS 示例名字（README 里的例子；之后可能过期 / 改指向） */
const SAMPLE_NAMES = ['example.sui', '@adeniyi', 'nobody-here-0000.sui']

const SAMPLE_OBJECTS = ['0x6', '0x5', '0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab']

/**
 * LP 示例：各 DEX 有仓位的地址和其中一个仓位（2026-10 时的真实仓位，之后可能撤出），
 * 以及添加流动性用的示例池子（多是 SUI / USDC）
 */
const SAMPLE_LP: Array<{ protocol: SuiLpProtocol; owner: string; position: string | null; pool: string }> = [
  { protocol: 'cetus', owner: '0x4ae27fc3d16fd33bc017ceaed23d5b6242cfe95b9c073a3546b2242f6b354b50', position: '0xfffa73532099a5b655d5d0c3a7827780718c9df98625edc19d61ed4ef617c215', pool: '0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab' },
  { protocol: 'bluefin', owner: '0x95b9f5ad34c4c987d011e00472591b835906ff2c0381409ccf7038b7c54ebec7', position: '0x00071152cab50d0d2708765869273818e9aa1ec982fc88c93fc6331b1765f478', pool: '0x3b585786b13af1d8ea067ab37101b6513a05d2f90cfe60e8b1d9e1b46a63c4fa' },
  { protocol: 'momentum', owner: '0xd296f7f43c8c48f1de676eb898398bd36401a16cec5000245c19626b2897c359', position: '0x00017c08b581aef1bb6e742cc072b1c2c17d9cec629fa5f9dbaad466f47c620e', pool: '0x455cf8d2ac91e7cb883f515874af750ed3cd18195c970b7a2d46235ac2b0c388' },
  { protocol: 'turbos', owner: '0xa7b9ddd98dbcde45276dc204a1a20a1ff15c129da6a5ec997301cbc9ba179a24', position: '0xd4f9ddf81688146dd1843d00e9ff3f092ce6b55a7d01f4d337e2df05255e32b2', pool: '0x0df4f02d0e210169cb6d5aabd03c3058328c06f2c4dbb0804faa041159c78443' },
  { protocol: 'magma', owner: '0x9b42721c812a1eccf083038313b05833c0c7bd1be47d77382066e77623329b0f', position: '0xfe57d2b1cd66230b0b157b92b710183f8a333742c1bdec57a383b23b7a097ab7', pool: '0xff8c47de1f04e4889bd3dbe06e87ceb61d44c2380f43d2a4fb2bc582ff8e51dd' },
  { protocol: 'flowx', owner: '0xc02b3a404ff72ffede0f6ebf0356f4f5c0ba5431c0e052fb1eb086ebf0713334', position: '0x09adb02c9a250c04360da87466bd15500d5b8b8fffcc42f79092f80e2a803d92', pool: '0x325239132e2b619147c00052986461cea02815172ea9d000c58e68484f514a90' },
  { protocol: 'kriya-clmm', owner: '0x0f2671a9f2aa80018889ade3e6d5a2222cb015c5e45d7ecd8dd4f2209137b6d9', position: '0xffcf4aaed73c787c271d6d980cb4af01e520d732867ec492cc05c056870a9866', pool: '0x367e02acb99632e18db69c3e93d89d21eb721e1d1fcebc0f6853667337450acc' },
  { protocol: 'cetus-dlmm', owner: '0x68e3d704f4ca71a3188a5b1a4e4899e6e59d3ceff0e1cb6e23121f2fe88012b4', position: '0xff7e679577e2541720a2c23b95f574e35e898da5ac7f0b9871d15c8d74e6fa80', pool: '0x64e590b0e4d4f7dfc7ae9fae8e9983cd80ad83b658d8499bf550a9d4f6667076' },
  // 传统 AMM：LP 是代币（DipCoin、FlowX V2）或 KriyaLPToken 对象
  { protocol: 'dipcoin', owner: '0x3283b58910842620120028e8f0300781dac502be1d5350f95b75c38c044472eb', position: null, pool: '0x7fbd7f609fcecd84329359cb6ea4eadbcd84d02a28fec9ce4652712d06474b3e' },
  { protocol: 'flowx-v2', owner: '0x2568ff0ef7709f5a7ca5fea3ae5766cfe64e1fe94ca48552395744dba1c5e30a', position: null, pool: '0x8eba28d4fef9750f52baaaed896d096b0765973ca6c8f193870236b5451a413c' },
  { protocol: 'kriya-amm', owner: '0x8eaa6a3d4fa4a5a41e6f78c1c4ce7e887ac3f980ca558a6df053bf1d78907783', position: null, pool: '0x5af4976b871fa1813362f352fa4cada3883a96191bb7212db1bd5d13685ae305' },
  // 多币池：仓位在 5 种稳定币的池子；添加用 SUI / USDC（20 / 80 的加权池）
  { protocol: 'aftermath', owner: '0x8c90d1c14730cc251d15e7d228bf2f34266cbbc2ee4b1518fd34b1cd96acb238', position: null, pool: '0xb0cc4ce941a6c6ac0ca6d8e6875ae5d86edbec392c3333d008ca88f377e5e181' },
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
$<HTMLTextAreaElement>('priceCoins').value = SAMPLE_COINS.join('\n')
$<HTMLTextAreaElement>('riskCoins').value = SAMPLE_COINS.join('\n')
$<HTMLTextAreaElement>('nameList').value = SAMPLE_NAMES.join('\n')
$<HTMLInputElement>('swapIn').value = SUI_COIN_TYPE
$<HTMLInputElement>('swapOut').value = SAMPLE_COINS[1] ?? ''

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

/** 节点的网络：按节点地址认出测试网 / 开发网（钱包签名、浏览器链接用） */
/** 连接钱包（没连接时弹出连接窗口）；钱包的网络要和所选节点的网络一致（链标识如 sui:mainnet）。写操作用 */
async function walletForSend() {
  const c = connection() ?? (await modal.open('sui'))
  if (!c) throw new Error('没有连接钱包')
  if (typeof c.chainId === 'string' && c.chainId !== `sui:${network()}`) {
    throw new Error(`钱包在 ${c.chainId}，而所选节点是 ${network()}：请在钱包里切到 ${network()}，或换节点`)
  }
  return c
}

const network = () => (/testnet/i.test(settings.node) ? 'testnet' : /devnet/i.test(settings.node) ? 'devnet' : 'mainnet')

let cached: { node: string; client: SuiClient } | null = null
function client(): SuiClient {
  if (cached?.node !== settings.node) cached = { node: settings.node, client: new SuiClient(settings.node || undefined, { network: network(), fetch: countingFetch }) }
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

/** LP 查询（“LP 仓位”页的按钮和“加载我的仓位”共用） */
async function queryLp() {
  const positions = lines($<HTMLTextAreaElement>('lpPositions').value)
  const prices = $<HTMLInputElement>('lpPrices').checked
  let priceError: unknown = null
  const protocolErrors: string[] = []
  const from = owner()
  const list = await lpPositions(client(), from, {
    ...(positions.length ? { positions } : {}),
    prices,
    fetch: countingFetch,
    onPriceError: (err) => {
      priceError = err
    },
    onError: (protocol, err) => protocolErrors.push(`${SUI_LP_PROTOCOLS[protocol].name}：${err instanceof Error ? err.message : String(err)}`),
  })
  setPositions(list, from)
  const sym = (t: { symbol: string | null }) => t.symbol ?? '?'
  const view = table(
    ['协议', '交易对', '数量', '未领取手续费', '奖励', '区间 / 份额', '价值', '仓位'],
    list.map((p) => {
      if (p.type === 'multi') {
        // 多币池：每种币一项；手续费已经计入 LP 份额
        return [
          p.protocolName,
          `${p.coins.map(sym).join(' / ')} · ${p.fee / 10_000}%${p.stable ? ' · stable' : ''}${p.daoFee ? ` · DAO ${p.daoFee / 10_000}%` : ''}`,
          p.coins.map((c) => `${amount(c.amountFormatted)} ${sym(c)}`).join(' + '),
          '计入份额',
          '—',
          `${(p.share * 100).toLocaleString('en-US', { maximumSignificantDigits: 3 })}%`,
          prices ? usd(p.valueUsd) : null,
          addr(p.pool),
        ]
      }
      const amounts = p.amount0Formatted === null ? null : `${amount(p.amount0Formatted)} ${sym(p.token0)} + ${amount(p.amount1Formatted)} ${sym(p.token1)}`
      if (p.type === 'amm') {
        // 传统 AMM：手续费已经计入 LP 份额
        return [
          p.protocolName,
          `${sym(p.token0)} / ${sym(p.token1)} · ${p.fee / 10_000}%${p.stable ? ' · stable' : ''}`,
          amounts,
          '计入份额',
          '—',
          `${(p.share * 100).toLocaleString('en-US', { maximumSignificantDigits: 3 })}%`,
          prices ? usd(p.valueUsd) : null,
          // LP 是普通代币时没有仓位对象：显示池子
          addr(p.position ?? p.pool),
        ]
      }
      const fees = p.fees0Formatted === null ? null : `${amount(p.fees0Formatted)} + ${amount(p.fees1Formatted)}${prices ? `（${usd(p.feesUsd)}）` : ''}`
      // 池子的奖励代币可能有好几个，只显示有未领取数量的（完整列表在原始 JSON 里）
      const pending = p.rewards?.filter((r) => r.amount !== '0') ?? null
      const rewards = pending === null ? null : pending.length ? pending.map((r) => `${amount(r.formatted)} ${r.symbol ?? '?'}`).join('、') : '—'
      const range = p.priceLower === null ? '—' : `${price(p.priceLower)} ~ ${price(p.priceUpper)}`
      return [
        p.type === 'clmm' && p.restricted ? wrapWith(p.protocolName, tag('受限', 'bad')) : p.protocolName,
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
}
bind('runLp', 'lp', queryLp)

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

// ---- 添加 / 移除流动性（子路径 /liquidity） ----

const liq = {
  action: $<HTMLSelectElement>('liqAction'),
  protocol: $<HTMLSelectElement>('liqProtocol'),
  pool: $<HTMLInputElement>('liqPool'),
  priceLower: $<HTMLInputElement>('liqPriceLower'),
  priceUpper: $<HTMLInputElement>('liqPriceUpper'),
  position: $<HTMLSelectElement>('liqPosition'),
  amount0: $<HTMLInputElement>('liqAmount0'),
  amount1: $<HTMLInputElement>('liqAmount1'),
  coin: $<HTMLInputElement>('liqCoin'),
  outCoin: $<HTMLInputElement>('liqOutCoin'),
  coinAmount: $<HTMLInputElement>('liqCoinAmount'),
  single: $<HTMLInputElement>('liqSingle'),
  percent: $<HTMLInputElement>('liqPercent'),
  burn: $<HTMLInputElement>('liqBurn'),
  slippage: $<HTMLInputElement>('liqSlippage'),
}

// 钱包：Sui 的 Wallet Standard 钱包（Slush、Suiet、OKX…），连接弹窗用 @w3lib/wallet/ui。签名时的网络按“节点”（见 client）
const wallet = createWallet({ connectors: [sui()] })
const modal = createWalletModal(wallet)
const connection = () => wallet.getConnection('sui')

function renderWallet() {
  const c = connection()
  // 连上钱包、地址栏还空着：填上钱包地址（查询默认查自己的钱包）
  if (c && !ownerInput.value.trim()) {
    ownerInput.value = c.address
    ownerInput.dispatchEvent(new Event('change'))
  }
  $('walletInfo').textContent = c ? `${c.walletName} · ${c.address}` : '未连接（只读查询不需要钱包）'
  $('connectWallet').textContent = c ? '切换 / 断开' : '连接钱包'
  // 兑换区块里的钱包行
  $('swapWalletInfo').textContent = c ? `${c.walletName} · ${c.address}` : '未连接（只报价时用顶部的地址）'
  $('swapConnect').textContent = c ? '切换 / 断开' : '连接钱包'
}
wallet.subscribe(() => renderWallet())
void wallet.ready.then(renderWallet)
$('connectWallet').addEventListener('click', () => void modal.open('sui'))
$('swapConnect').addEventListener('click', () => void modal.open('sui'))

/** 上一次“查询 LP”的结果：追加、移除、领取从里面选仓位 */
let lastPositions: SuiLpPosition[] = []
/** 仓位是哪个地址的（查询“LP 仓位”时的地址）：追加、移除、领取要用这个地址 */
let positionsOwner = ''

const shareText = (share: number) => `份额 ${(share * 100).toPrecision(3)}%`

function setPositions(list: SuiLpPosition[], of: string) {
  lastPositions = list
  positionsOwner = of
  const options = list.map((p, i) => {
    const pair = p.type === 'multi' ? p.coins.map((c) => c.symbol ?? '?').join(' / ') : `${p.token0.symbol ?? '?'} / ${p.token1.symbol ?? '?'}`
    const id = p.type === 'clmm' || p.type === 'dlmm' ? `仓位 ${p.position.slice(0, 6)}…${p.position.slice(-4)}` : shareText(p.share)
    return new Option(`${p.protocolName} · ${pair} · ${id}`, String(i))
  })
  liq.position.replaceChildren(...(options.length ? options : [new Option('没有仓位：点右边“加载我的仓位”，或在“LP 仓位”页查询', '')]))
  applyAction()
}

for (const s of SAMPLE_LP) liq.protocol.append(new Option(`${SUI_LP_PROTOCOLS[s.protocol].name}（${SUI_LP_PROTOCOLS[s.protocol].type.toUpperCase()}）`, s.protocol))

const selected = (): SuiLpPosition | undefined => (liq.position.value ? lastPositions[Number(liq.position.value)] : undefined)
/** 当前操作的池子类型：新建按选的协议，其他按选的仓位 */
const poolType = () => (liq.action.value === 'new' ? SUI_LP_PROTOCOLS[liq.protocol.value as SuiLpProtocol]?.type : selected()?.type)

function applyProtocol() {
  liq.pool.value = SAMPLE_LP.find((s) => s.protocol === liq.protocol.value)?.pool ?? ''
  applyAction()
}

function applyAction() {
  const action = liq.action.value
  const type = poolType()
  const adding = action === 'new' || action === 'add'
  $('liqNew').hidden = action !== 'new'
  $('liqExisting').hidden = action === 'new'
  $('liqRange').hidden = !(type === 'clmm' || type === 'dlmm')
  $('liqRemoveOptions').hidden = action !== 'remove'
  liq.burn.disabled = !(type === 'clmm' || type === 'dlmm')
  $('liqAmounts').hidden = !adding || type === 'multi'
  $('liqMulti').hidden = type !== 'multi' || !adding
  $('liqOutCoinRow').hidden = type !== 'multi' || action !== 'remove'
}

liq.protocol.addEventListener('change', applyProtocol)
liq.action.addEventListener('change', applyAction)
liq.position.addEventListener('change', applyAction)
// 换了节点（网络）：之前查到的仓位不再适用
nodeInput.addEventListener('change', () => setPositions([], ''))
liq.amount1.value = '0.1'
liq.coin.value = SUI_COIN_TYPE
liq.coinAmount.value = '0.1'
setPositions([], '')
applyProtocol()

const text = (input: HTMLInputElement) => input.value.trim() || undefined

/**
 * 构建 / 发送用的地址：连了钱包用钱包地址（追加、移除、领取时要和仓位的地址一致）；
 * 没连钱包时，追加、移除、领取用仓位的地址，新建用“地址”栏的
 */
function liquidityFrom(walletAddress?: string): string {
  if (liq.action.value === 'new') return walletAddress ?? owner()
  if (walletAddress && positionsOwner && normalizeSuiAddress(walletAddress) !== normalizeSuiAddress(positionsOwner)) {
    throw new Error(`仓位是 ${positionsOwner} 的，钱包是 ${walletAddress}：换成仓位的账户，或用钱包地址重新查询 LP 仓位`)
  }
  return walletAddress ?? positionsOwner
}

function selectedPosition(): SuiLpPosition {
  const p = selected()
  if (!p) throw new Error('请先在“LP 仓位”里查询，再选一个仓位')
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

/** 数量：多币池给一种币的数量，其他给 token0 / token1 的一边 */
function amountsOf(multi: boolean): Partial<AddLiquidityParams> {
  if (multi) {
    const coin = text(liq.coin)
    const amountFormatted = text(liq.coinAmount)
    if (!coin || !amountFormatted) throw new Error('多币池：请填写币的类型和数量')
    return { coin, amountFormatted, ...(liq.single.checked ? { single: true } : {}) }
  }
  const amounts = { amount0Formatted: text(liq.amount0), amount1Formatted: text(liq.amount1) }
  if (!amounts.amount0Formatted && !amounts.amount1Formatted) throw new Error('请填写至少一边的数量')
  return amounts
}

function addParams(): AddLiquidityParams {
  const multi = poolType() === 'multi'
  if (liq.action.value === 'add') return { position: selectedPosition(), ...amountsOf(multi), ...slippageOf() }
  const protocol = liq.protocol.value as SuiLpProtocol
  const pool = text(liq.pool)
  if (!pool) throw new Error('请填写池子地址')
  const type = SUI_LP_PROTOCOLS[protocol].type
  const lower = numberOf(liq.priceLower, '价格下限')
  const upper = numberOf(liq.priceUpper, '价格上限')
  if ((lower === undefined) !== (upper === undefined)) throw new Error('价格区间要上下限都填，或都不填')
  const range = type === 'clmm' || type === 'dlmm' ? (lower !== undefined ? { priceLower: lower, priceUpper: upper } : type === 'clmm' ? { fullRange: true } : {}) : {}
  return { protocol, pool, ...range, ...amountsOf(multi), ...slippageOf() }
}

function removeParams(): RemoveLiquidityParams {
  const position = selectedPosition()
  const percent = numberOf(liq.percent, '移除比例')
  if (percent !== undefined && !(percent > 0 && percent <= 100)) throw new Error('移除比例要在 0 ~ 100% 之间')
  const outCoin = position.type === 'multi' ? text(liq.outCoin) : undefined
  return {
    position,
    ...(percent === undefined ? {} : { percent }),
    ...(liq.burn.checked && !liq.burn.disabled ? { burn: true } : {}),
    ...(outCoin ? { outCoin } : {}),
    ...slippageOf(),
  }
}

/** 表单 → 要调用的函数和参数（连接钱包之前先检查表单） */
function liquidityRequest() {
  const action = liq.action.value
  if (action === 'new' || action === 'add') return { action: 'add' as const, params: addParams() }
  if (action === 'remove') return { action: 'remove' as const, params: removeParams() }
  return { action: 'collect' as const, params: { position: selectedPosition(), ...slippageOf() } }
}

function link(digest: string, net: string): Node {
  const a = document.createElement('a')
  a.href = `https://suiscan.xyz/${net}/tx/${digest}`
  a.target = '_blank'
  a.rel = 'noopener'
  a.textContent = `${digest.slice(0, 10)}…`
  return a
}

/** 按最小单位的数量按精度换算（显示用；精度未知时显示最小单位） */
const units = (value: string, t: { symbol: string | null; decimals: number | null }) => `${t.decimals === null ? value : amount(formatUnits(BigInt(value), t.decimals))} ${t.symbol ?? '?'}`

function planView(plan: AddLiquidityPlan | RemoveLiquidityPlan, result?: LiquidityResult<unknown> & { network: string }): Node {
  const t0 = plan.token0
  const t1 = plan.token1
  const both = (a: string, b: string) => `${units(a, t0)} + ${units(b, t1)}`
  const add = plan.action === 'add'
  const collect = plan.action === 'collect'
  const multi = plan.coins
  const rows: Array<[string, Cell]> = [
    ['协议', `${SUI_LP_PROTOCOLS[plan.protocol].name}（${plan.type.toUpperCase()}）`],
    ['池子', addr(plan.pool)],
    ['仓位', plan.position ? addr(plan.position) : add && (plan.type === 'clmm' || plan.type === 'dlmm') ? '新建（交易执行后才有仓位对象）' : null],
    ['交易对', multi ? multi.map((c) => c.symbol ?? '?').join(' / ') : `${t0.symbol ?? '?'} / ${t1.symbol ?? '?'}`],
    ['当前价格', plan.price === null || multi ? null : `1 ${t0.symbol ?? '?'} = ${price(plan.price)} ${t1.symbol ?? '?'}`],
    ['区间', plan.tickLower === null ? null : `${plan.type === 'dlmm' ? 'bin' : 'tick'} ${plan.tickLower} ~ ${plan.tickUpper}（当前 ${plan.tick}）`],
  ]
  if (multi) {
    rows.push([add ? '存入（上限）' : '预计取回（下限）', multi.map((c) => `${units(c.amount, c)}（${units(add ? c.amountMax : c.amountMin, c)}）`).join(' + ')])
  } else if (plan.action === 'add') {
    rows.push(['预计存入', both(plan.amount0, plan.amount1)], ['上限', both(plan.amount0Max, plan.amount1Max)], ['下限', both(plan.amount0Min, plan.amount1Min)])
  } else if (!collect) {
    rows.push(['预计取回（不含手续费）', both(plan.amount0, plan.amount1)], ['下限', both(plan.amount0Min, plan.amount1Min)])
  } else {
    // 交易内容里没有领取的数量：用查询 LP 时读到的未领取手续费和奖励
    const p = lastPositions.find((x) => (x.type === 'clmm' || x.type === 'dlmm') && x.position === plan.position)
    if (p && (p.type === 'clmm' || p.type === 'dlmm')) {
      const rewards = p.rewards?.filter((r) => r.amount !== '0') ?? []
      rows.push(
        ['未领取的手续费（查询 LP 时）', p.fees0Formatted === null ? null : `${amount(p.fees0Formatted)} ${t0.symbol ?? '?'} + ${amount(p.fees1Formatted)} ${t1.symbol ?? '?'}`],
        ['未领取的奖励（查询 LP 时）', rewards.length ? rewards.map((r) => `${amount(r.formatted)} ${r.symbol ?? '?'}`).join('、') : null],
      )
    }
  }
  rows.push(
    [plan.type === 'amm' || plan.type === 'multi' ? 'LP 数量' : '流动性', collect ? null : plan.liquidity],
    ['关闭仓位', plan.action !== 'add' && plan.burn ? '是' : null],
    ['领取的奖励代币', plan.rewardCoins.length ? `${plan.rewardCoins.length} 种（数量要等交易执行后才知道）` : null],
    ['从 gas 币拆出的 SUI', plan.gasSpend ? `${amount(formatUnits(plan.gasSpend, 9))} SUI` : null],
  )
  if (result) {
    rows.push(
      ['状态', tag(result.status + (result.error ? `：${result.error}` : ''), result.status === 'confirmed' ? 'ok' : result.status === 'failed' || result.status === 'reverted' ? 'bad' : '')],
      ['交易', result.digest ? link(result.digest, result.network) : null],
      ['gas', result.fee === null ? null : `${amount(formatUnits(BigInt(result.fee), 9))} SUI`],
    )
  }
  return table(
    ['项目', '值'],
    rows.filter(([, v]) => v !== null),
  )
}

/** 原始结果不显示交易内容（PTB 很长；自己签名发送时用 build* 返回的 kind） */
const withoutKind = <P extends { kind: unknown }>(plan: P) => ({ ...plan, kind: '（PTB，太长不显示）' })

bind('runLiqBuild', 'liq', async () => {
  const { action, params } = liquidityRequest()
  const from = liquidityFrom(connection()?.address)
  const plan =
    action === 'add'
      ? await buildAddLiquidity(client(), from, params)
      : action === 'remove'
        ? await buildRemoveLiquidity(client(), from, params)
        : await buildCollectFees(client(), from, params)
  return { data: withoutKind(plan), view: planView(plan) }
})

bind('runLiqSend', 'liq', async () => {
  const { action, params } = liquidityRequest()
  // 发送时的客户端（网络）：结果的链接按它，发送中改了节点也不影响
  const sui = client()
  const c = await walletForSend()
  liquidityFrom(c.address)
  // Wallet Standard 钱包直接当签名器，指定连接的账户
  const signer = { wallet: c.provider, account: c.address } as never
  const progress = $('liqStats')
  const options = { onUpdate: (r: { status: string }) => (progress.textContent = `交易：${r.status}`) }
  const result =
    action === 'add'
      ? await addLiquidity(sui, signer, params, options)
      : action === 'remove'
        ? await removeLiquidity(sui, signer, params, options)
        : await collectFees(sui, signer, params, options)
  const view = document.createElement('div')
  const note = document.createElement('p')
  note.className = 'hint'
  note.textContent = `结果：${result.status}（可以在“LP 仓位”里重新查询）`
  view.append(note, planView(result.plan, { ...result, network: sui.network }))
  return { data: { ...result, plan: withoutKind(result.plan) }, view }
})

// ---- 价格 / 资产总值（子路径 /price） ----

/** 填了日期用 DefiLlama 的历史价格（链上价格源只给当前价格）；没填用默认的价格源 */
function priceSources() {
  const date = $<HTMLInputElement>('priceAt').value
  if (!date) return {}
  const at = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(at.getTime())) throw new Error(`历史价格的日期不对：${date}`)
  if (at.getTime() > Date.now()) throw new Error('历史价格的日期不能是未来')
  return { sources: [defillamaPrices({ at })] }
}

bind('runPrices', 'price', async () => {
  const coinTypes = lines($<HTMLTextAreaElement>('priceCoins').value)
  if (!coinTypes.length) throw new Error('请填写至少一个代币类型')
  const errors: string[] = []
  const list = await tokenPrices(client(), coinTypes, {
    ...priceSources(),
    fetch: countingFetch,
    onError: (source, err) => errors.push(`${source.name}：${errorText(err)}`),
  })
  return {
    data: list,
    view: withWarnings(
      table(
        ['代币', '价格', '来源', '状态'],
        list.map((p) => [addr(p.token), p.price === null ? null : `$${price(p.price)}`, p.source, p.price === null ? tag('没有价格', 'bad') : tag('ok', 'ok')]),
        [1],
      ),
      errors.map((e) => `价格源出错，继续用下一个源：${e}`),
    ),
  }
})

bind('runPortfolio', 'price', async () => {
  const from = owner()
  const coinTypes = lines($<HTMLTextAreaElement>('priceCoins').value)
  const minUsd = numberOf($<HTMLInputElement>('priceMinUsd'), '最小价值') ?? 0
  if (minUsd < 0) throw new Error('最小价值不能为负')
  const errors: string[] = []
  const p = await portfolio(client(), from, {
    ...priceSources(),
    ...(coinTypes.length ? { coinTypes } : {}),
    lp: $<HTMLInputElement>('priceLp').checked ? { onError: (protocol, err) => errors.push(`读取出错，跳过了 ${SUI_LP_PROTOCOLS[protocol].name} 的仓位：${errorText(err)}`) } : false,
    minUsd,
    fetch: countingFetch,
    onPriceError: (err) => errors.push(`价格服务出错：${errorText(err)}`),
  })
  const summary = table(
    ['合计', '代币', 'LP 仓位', '算不出价值'],
    [[usd(p.totalUsd), usd(p.tokensUsd), $<HTMLInputElement>('priceLp').checked ? `${usd(p.lpUsd)}（${p.lp.length} 个）` : '未计入', `${p.unpriced} 个`]],
    [0, 1, 2, 3],
  )
  const tokens = table(
    ['代币', '余额', '价格', '价值', '来源', '类型'],
    p.tokens.map((t) => [t.symbol, amount(t.formatted), t.price === null ? null : `$${price(t.price)}`, usd(t.value), t.priceSource, addr(t.token)]),
    [1, 2, 3],
  )
  const view = document.createElement('div')
  view.append(summary, tokens)
  return { data: p, view: withWarnings(view, errors) }
})

// ---- 域名（子路径 /names） ----

bind('runNames', 'names', async () => {
  const names = lines($<HTMLTextAreaElement>('nameList').value)
  if (!names.length) throw new Error('请填写至少一个名字')
  const list = await resolveNames(client(), names)
  return {
    data: list,
    view: table(
      ['名字', '规范化', '地址', '到期时间', '状态'],
      list.map((r) => [
        r.name,
        r.normalized,
        addr(r.address),
        r.expiresAt === null ? null : new Date(r.expiresAt).toLocaleString(),
        r.normalized === null ? tag('名字不合法', 'bad') : r.address !== null ? tag('ok', 'ok') : r.expiresAt !== null && r.expiresAt < Date.now() ? tag('已过期', 'bad') : tag('没有注册或没有设置地址', 'bad'),
      ]),
    ),
  }
})

bind('runAddressNames', 'addressNames', async () => {
  const typed = lines($<HTMLTextAreaElement>('nameAddresses').value)
  // 地址不合法时库返回 null（和没有名字分不开）：先检查
  const addresses = (typed.length ? typed : [owner()]).map((a) => {
    try {
      return normalizeSuiAddress(a)
    } catch {
      throw new Error(`地址不合法：${a}`)
    }
  })
  const list = await lookupAddresses(client(), addresses)
  return { data: list, view: table(['地址', '默认名字'], list.map((r) => [addr(r.address), r.name ?? tag('没有默认名字', '')])) }
})

// ---- 手续费（子路径 /fees） ----

bind('runGasPrice', 'gasPrice', async () => {
  const fee = await estimateFees(client())
  return { data: fee, view: table(['项目', '值'], [['epoch', fee.epoch], ['参考 gas 价格', `${fee.referenceGasPrice} MIST / gas 单位`]]) }
})

bind('runCost', 'cost', async () => {
  const from = normalizeSuiAddress(owner())
  const toText = $<HTMLInputElement>('feeTo').value.trim()
  const to = toText ? normalizeSuiAddress(toText) : from
  const value = parseUnits($<HTMLInputElement>('feeAmount').value, 9)
  if (value <= 0n) throw new Error('转账数量要大于 0')
  // 从 gas 币拆出 value 再转给 to（同 README 的例子）
  const ptb = new PtbBuilder()
  const coin = ptb.command({ kind: 'splitCoins', coin: ptb.gas, amounts: [ptb.pure(pure.u64(value))] })
  ptb.command({ kind: 'transferObjects', objects: [ptb.nested(coin, 0)], address: ptb.pure(pure.address(to)) })
  const cost = await estimateCost(client(), { from, kind: ptb.build() })
  const mist = (v: string) => `${v} MIST`
  return {
    data: cost,
    view: table(
      ['项目', '值'],
      [
        ['gas 价格', mist(cost.gasPrice)],
        ['计算费', mist(cost.computationCost)],
        ['存储费', mist(cost.storageCost)],
        ['存储返还', mist(cost.storageRebate)],
        ['净花费', `${cost.totalFormatted} ${cost.symbol}（${mist(cost.total)}）`],
        ['gas 上限（发送时用）', `${cost.gasBudgetFormatted} ${cost.symbol}（${mist(cost.gasBudget)}）`],
      ],
    ),
  }
})

// ---- 兑换（子路径 /swap） ----

const swapSlippage = $<HTMLInputElement>('swapSlippage')

function swapRequest(): { params: SwapParams; options: SwapOptions } {
  const tokenIn = text($<HTMLInputElement>('swapIn'))
  const tokenOut = text($<HTMLInputElement>('swapOut'))
  if (!tokenIn || !tokenOut) throw new Error('请填写卖出和买入的代币类型')
  if (tokenIn === tokenOut) throw new Error('卖出和买入不能是同一种代币')
  const amountInFormatted = text($<HTMLInputElement>('swapAmount'))
  if (!amountInFormatted || !/^(\d+\.?\d*|\.\d+)$/.test(amountInFormatted) || !(Number(amountInFormatted) > 0)) throw new Error('卖出的数量要是大于 0 的数字')
  const percent = numberOf(swapSlippage, '滑点')
  if (percent !== undefined && !(percent >= 0 && percent < 100)) throw new Error('滑点要在 0 ~ 100% 之间')
  const pools = lines($<HTMLTextAreaElement>('swapPools').value).map((p) => {
    try {
      return normalizeSuiAddress(p)
    } catch {
      throw new Error(`池子 ID 不合法：${p}`)
    }
  })
  return {
    params: { tokenIn, tokenOut, amountInFormatted },
    options: { ...(percent === undefined ? {} : { slippage: percent / 100 }), ...(pools.length ? { pools } : {}) },
  }
}

const coinName = (type: string) => type.split('::').pop() ?? type

function swapView(plan: SwapPlan, result?: SwapResult & { network: string }): Node {
  const inSym = plan.tokenIn.symbol ?? '?'
  const outSym = plan.tokenOut.symbol ?? '?'
  const rows: Array<[string, Cell]> = [
    ['卖出', units(plan.amountIn, plan.tokenIn)],
    ['报价', units(plan.amountOut, plan.tokenOut)],
    ['最少收到', units(plan.amountOutMin, plan.tokenOut)],
    ['价格', plan.price === null ? null : `1 ${inSym} = ${price(plan.price)} ${outSym}`],
    ['价格影响', plan.priceImpact === null ? null : `${(plan.priceImpact * 100).toFixed(3)}%`],
    ['从 gas 币拆出的 SUI', plan.gasSpend ? `${amount(formatUnits(plan.gasSpend, 9))} SUI` : null],
  ]
  if (result) {
    rows.push(
      ['状态', tag(result.status + (result.error ? `：${result.error}` : ''), result.status === 'confirmed' ? 'ok' : result.status === 'failed' || result.status === 'reverted' ? 'bad' : '')],
      ['交易', result.digest ? link(result.digest, result.network) : null],
      ['gas', result.fee === null ? null : `${amount(formatUnits(BigInt(result.fee), 9))} SUI`],
    )
  }
  const hops = (r: SwapPlan['route']) => r.hops.map((h) => `${SUI_LP_PROTOCOLS[h.protocol].name}${h.fee === null ? '' : `（${h.fee / 10_000}%）`}`).join(' → ')
  const view = document.createElement('div')
  view.append(
    table(['项目', '值'], rows.filter(([, v]) => v !== null)),
    table(
      ['候选路线（从高到低）', '经过', '报价', '选中'],
      plan.routes.map((r) => [hops(r), r.path.map(coinName).join(' → '), units(r.amountOut, plan.tokenOut), r.amountOut === plan.route.amountOut && hops(r) === hops(plan.route) ? tag('选中', 'ok') : '']),
      [2],
    ),
    // 选中路线每一跳的池子
    table(
      ['跳', '协议', '池子', '卖出 → 买入'],
      plan.route.hops.map((h, i) => [i + 1, SUI_LP_PROTOCOLS[h.protocol].name, addr(h.pool), `${coinName(h.tokenIn)} → ${coinName(h.tokenOut)}`]),
    ),
  )
  return view
}

bind('runSwapQuote', 'swap', async () => {
  const { params, options } = swapRequest()
  const plan = await buildSwap(client(), connection()?.address ?? owner(), params, options)
  return { data: withoutKind(plan), view: swapView(plan) }
})

bind('runSwapSend', 'swap', async () => {
  const { params, options } = swapRequest()
  // 发送时的客户端（网络）：结果的链接按它，发送中改了节点也不影响
  const sui = client()
  const c = await walletForSend()
  const signer = { wallet: c.provider, account: c.address } as never
  const progress = $('swapStats')
  const result = await swap(sui, signer, params, { ...options, onUpdate: (r) => (progress.textContent = `交易：${r.status}`) })
  const view = document.createElement('div')
  const note = document.createElement('p')
  note.className = 'hint'
  note.textContent = `结果：${result.status}（余额变化可以在“余额”里重新查询）`
  view.append(note, swapView(result.plan, { ...result, network: sui.network }))
  return { data: { ...result, plan: withoutKind(result.plan) }, view }
})

// ---- 代币风险（子路径 /risk） ----

/** 权限对象（TreasuryCap、DenyCap、MetadataCap）在谁手里 */
function holder(h: CapHolder | null): Cell {
  if (!h) return null
  switch (h.owner) {
    case 'address':
      return wrapWith('地址', addr(h.address))
    case 'object':
      return h.root ? wrapWith(`在对象里（${h.root.owner}）`, addr(h.root.type ?? h.root.id)) : '在别的对象里'
    case 'shared':
      return '共享对象'
    case 'consensus-address':
      return '共识地址'
    case 'immutable':
      return '已冻结'
    case 'burned':
      return '已转给 0x0'
    case 'not-found':
      return '节点读不到'
    default:
      return '未知'
  }
}

bind('runRisk', 'risk', async () => {
  const coinTypes = lines($<HTMLTextAreaElement>('riskCoins').value)
  if (!coinTypes.length) throw new Error('请填写至少一个代币类型')
  const sell = $<HTMLInputElement>('riskSell').checked
  const buyAmount = parseUnits($<HTMLInputElement>('riskAmount').value, 9)
  if (sell && buyAmount <= 0n) throw new Error('买入的 SUI 数量要大于 0')
  const address = $<HTMLInputElement>('riskDenied').checked ? normalizeSuiAddress(owner()) : undefined
  const list = await coinRisks(client(), coinTypes, { sell, ...(sell ? { amount: buyAmount } : {}), ...(address ? { address } : {}) })
  return {
    data: list,
    view: table(
      ['代币', '监管币', '增发', 'TreasuryCap', '元数据', '能不能卖', '风险标记'],
      list.map((r) => {
        if (!r.exists) return [wrapWith(r.symbol ?? '?', addr(r.token)), null, null, null, null, null, r.flags.join('、')]
        const regulated = r.flags.includes('regulated')
          ? tag(`监管币${r.flags.includes('global-pause') ? ' · 可全局暂停' : ''}${r.paused ? ' · 暂停中' : ''}${r.denied ? ' · 该地址被冻结' : ''}`, 'bad')
          : r.regulated
            ? tag('监管币，冻结权限已废弃', 'ok')
            : r.regulated === false
              ? tag('否', 'ok')
              : null
        const supply = r.supply === 'mintable' ? tag('可增发', 'bad') : r.supply === 'unknown' ? tag('不知道', 'bad') : tag(r.supply === 'fixed' ? '固定供应' : '只能销毁', 'ok')
        const metadata = r.metadataMutable === null ? null : r.metadataMutable ? tag('可修改', 'bad') : tag('不可改', 'ok')
        const canSell =
          r.sell === null
            ? null
            : r.sell.stage === 'ok'
              ? tag(`ok · 来回损失 ${r.sell.roundTripLoss === null ? '?' : `${(r.sell.roundTripLoss * 100).toFixed(2)}%`}`, r.honeypot ? 'bad' : 'ok')
              : tag(`${r.sell.stage}${r.sell.error ? `：${r.sell.error}` : ''}`, 'bad')
        return [wrapWith(r.symbol ?? '?', addr(r.token)), regulated, supply, holder(r.treasuryCap), metadata, canSell, r.flags.join('、') || '无']
      }),
    ),
  }
})

// ---- 模拟交易（子路径 /simulate） ----

bind('runSim', 'sim', async () => {
  const to = normalizeSuiAddress($<HTMLInputElement>('simTo').value.trim())
  const amount = parseUnits($<HTMLInputElement>('simAmount').value, 9)
  const from = normalizeSuiAddress(owner())
  const ptb = new PtbBuilder()
  const coin = ptb.command({ kind: 'splitCoins', coin: { kind: 'gas' }, amounts: [ptb.pure(pure.u64(amount))] })
  ptb.command({ kind: 'transferObjects', objects: [ptb.nested(coin, 0)], address: ptb.pure(pure.address(to)) })
  const sim = await simulateTx(client(), { kind: ptb.build() }, { sender: from })
  const view = document.createElement('div')
  const note = document.createElement('p')
  note.textContent = `${sim.success ? '会成功' : '会失败'}：${sim.decoded.summary}${sim.error ? `（${sim.error}）` : ''} · gas 用量 ${formatUnits(BigInt(sim.gasUsed), 9)} SUI`
  view.append(
    note,
    table(
      ['地址', '代币', '变化', '美元'],
      sim.balanceChanges.map((c) => [addr(c.address), c.symbol ?? c.asset, c.formatted, c.usd == null ? null : c.usd.toFixed(4)]),
      [2, 3],
    ),
    table(['提醒', '说明'], sim.warnings.map((w) => [tag(w.code, w.severity === 'info' ? '' : 'bad'), w.message])),
  )
  return { data: sim, view }
})

// ---- 交易历史（子路径 /history） ----

let historyCursor: string | undefined
/** 游标属于哪次查询（地址、网络）：换了之后“下一页”不能接着用旧游标 */
let historyFor = ''
const historyKey = () => [owner(), network()].join('|')
function historyRows(items: Activity[]): Cell[][] {
  return items.map((a) => [
    new Date(a.time * 1000).toLocaleString(),
    tag(a.status === 'failed' ? `${a.type} · 失败` : a.type, a.status === 'failed' ? 'bad' : ''),
    a.label,
    a.changes.map((c) => `${c.formatted} ${c.symbol ?? ''}`).join('、'),
    a.counterparty ? addr(a.counterparty) : null,
    wrapWith(a.hash.slice(0, 10) + '…', addr(a.hash)),
  ])
}
async function runHistory(more: boolean) {
  // “下一页”按钮的禁用状态会被 bind 在查询结束时恢复，不能只靠它：这里再检查一次
  if (more && !historyCursor) throw new Error('没有下一页：请先点“查询”')
  if (more && historyFor !== historyKey()) throw new Error('地址或网络变了：请重新点“查询”')
  // 发请求前记下这次查询的条件：等待期间改了表单，游标也只属于发出去的那次查询
  const key = historyKey()
  const limit = Math.max(1, Math.min(50, Number($<HTMLInputElement>('histLimit').value) || 20))
  const page = await getHistoryOf(client(), normalizeSuiAddress(owner()), {
    limit,
    ...(more && historyCursor ? { cursor: historyCursor } : {}),
    adapters: [graphqlHistory({ network: network(), fetch: countingFetch }), grpcHistory(client().transport)],
  })
  historyCursor = page.nextCursor
  historyFor = key
  $<HTMLButtonElement>('runHistoryMore').disabled = !historyCursor
  return { data: page, view: table(['时间', '类型', '说明', '币变化', '对方', '交易'], historyRows(page.items)) }
}
bind('runHistory', 'hist', () => runHistory(false))
bind('runHistoryMore', 'hist', () => runHistory(true))

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
  const c = await walletForSend()
  if (!dryRun && !confirm(`用 ${c.address} 向 ${rows.length} 个地址转${token ? `（${token}）` : ' SUI'}，确认发送？`)) throw new Error('已取消')
  const progress = $('btStats')
  const results = await batchTransfer(client(), { wallet: c.provider, account: c.address } as never, rows, {
    ...(token ? { token } : {}),
    dryRun,
    onUpdate: (r) => (progress.textContent = `第 ${r.index + 1} 项：${r.status}`),
  })
  return {
    data: results,
    view: table(
      ['#', '收款', '数量', '状态', '交易'],
      results.map((r, i) => [i + 1, addr(r.to), r.formatted ?? r.amount, tag(r.status + (r.error ? `：${r.error}` : ''), r.status === 'confirmed' || r.status === 'simulated' ? 'ok' : r.status === 'failed' || r.status === 'reverted' ? 'bad' : ''), r.digest ? link(r.digest, network()) : null]),
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
