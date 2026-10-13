import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getBalances,
  getNftOwners,
  getNfts,
  getOwnerNfts,
  getOwnerTokens,
  getTokens,
  onRequest,
  type NftDetails,
  type RequestEvent,
} from '@w3lib/solana-batch-call'
import { getLpPositions } from '@w3lib/solana-batch-call/lp'

// ---- 示例数据 ----

/** 示例地址：Solana 联合创始人 toly 的公开钱包，持有多种代币和 NFT */
const SAMPLE_OWNER = '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY'

const SAMPLE_MINTS = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD（Token-2022）
]

const SAMPLE_NFTS = [
  '7ueb3syffyNdjYHcvZ3YHFvqRbn3kvtNGefBpf6Ledya', // Mad Lads #954（pNFT）
  '8XeLiTx4iRRyFccvtU25LhpHd3Cy3W3ob7iLRPiYmKd8', // Okay Bears
]

/** LP 示例：持有 Raydium CLMM SOL-USDC 仓位的地址和仓位 NFT（2026-10 时的真实仓位，之后可能撤出） */
const SAMPLE_LP_OWNER = '7MNmCGMgdSzMzwNhQKCAs82pd5odi4xjg4VtUU7WiCNk'
const SAMPLE_LP_MINTS = ['6MZXirXpM1RcD6NT6LYr5QFs2XHkm6RtmYn6LAdexu7u']

// ---- 设置（存在 localStorage，刷新后保留） ----

interface Settings {
  rpc: string
  owner: string
}

const SETTINGS_KEY = 'w3lib-demo:solana'

function loadSettings(): Settings {
  let stored: Partial<Settings> = {}
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') ?? {}
  } catch {
    // 存的不是 JSON：用默认的
  }
  return {
    rpc: typeof stored.rpc === 'string' ? stored.rpc : '',
    owner: typeof stored.owner === 'string' ? stored.owner : '',
  }
}

const settings = loadSettings()
const save = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const rpcInput = $<HTMLInputElement>('rpc')
const ownerInput = $<HTMLInputElement>('owner')

rpcInput.value = settings.rpc
ownerInput.value = settings.owner
$<HTMLTextAreaElement>('balanceMints').value = SAMPLE_MINTS.join('\n')
$<HTMLTextAreaElement>('tokenMints').value = SAMPLE_MINTS.join('\n')
$<HTMLTextAreaElement>('nftMints').value = SAMPLE_NFTS.join('\n')

rpcInput.addEventListener('change', () => {
  settings.rpc = rpcInput.value.trim()
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
  $<HTMLTextAreaElement>('lpMints').value = SAMPLE_LP_MINTS.join('\n')
  $<HTMLTextAreaElement>('lpPools').value = ''
})

/** 节点：自己填的优先，不填用内置公共节点 */
const nodeOptions = () => ({ provider: settings.rpc || undefined })

const lines = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)

/** 需要索引方法（getTokenAccountsByOwner 等）的查询：内置公共节点都不支持，没填节点时直接提示，不发请求 */
function indexedNode() {
  if (!settings.rpc) throw new Error('这个查询需要支持 getTokenAccountsByOwner 等索引方法的节点：请在“设置”里填自己的 RPC URL（内置公共节点不支持）')
  return nodeOptions()
}

function owner(): string {
  const value = ownerInput.value.trim()
  if (!value) throw new Error('请先填写地址（或点“示例地址”）')
  return value
}

// ---- 结果展示 ----

type Cell = string | number | null | undefined | Node

/** 用 textContent 填表格：代币名称、symbol 来自链上，不能当 HTML 插入 */
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

function programName(program: string | null | undefined): string {
  return program === TOKEN_PROGRAM_ID ? 'SPL Token' : program === TOKEN_2022_PROGRAM_ID ? 'Token-2022' : program ? program : '—'
}

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

/** 一次查询期间的 JSON-RPC 调用统计（onRequest 是全局的；按钮在查询期间禁用，同一时间只有一个查询） */
function describeRequests(events: RequestEvent[], ms: number): string {
  const byMethod = new Map<string, number>()
  for (const e of events) byMethod.set(e.method, (byMethod.get(e.method) ?? 0) + 1)
  const methods = [...byMethod].map(([m, n]) => `${m} ×${n}`).join('、')
  const failed = events.filter((e) => !e.ok).length
  const nodes = [...new Set(events.filter((e) => e.ok).map((e) => e.node))].join('、')
  return [`${ms} ms`, `${events.length} 次 RPC 调用${methods ? `（${methods}）` : ''}`, failed ? `${failed} 次失败后换节点` : '', nodes ? `节点 ${nodes}` : '']
    .filter(Boolean)
    .join(' · ')
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
    const off = onRequest((e) => events.push(e))
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
      off()
      buttons.forEach((b) => (b.disabled = false))
    }
  })
}

// ---- 各查询 ----

bind('runBalances', 'balances', async () => {
  const list = await getBalances(owner(), [NATIVE_MINT, ...lines($<HTMLTextAreaElement>('balanceMints').value)], { ...nodeOptions(), symbol: true })
  return {
    data: list,
    view: table(
      ['代币', '余额', '程序', 'mint', '状态'],
      list.map((b) => [
        b.symbol,
        amount(b.formatted),
        b.native ? '主币' : programName(b.tokenProgram),
        b.native ? 'SOL' : addr(b.token),
        b.success ? tag('ok', 'ok') : tag(b.error ?? 'failed', 'bad'),
      ]),
      [1],
    ),
  }
})

bind('runTokens', 'tokens', async () => {
  const list = await getTokens(lines($<HTMLTextAreaElement>('tokenMints').value), {
    ...nodeOptions(),
    fields: ['name', 'symbol', 'decimals', 'supply', 'tokenProgram', 'transferFee'],
  })
  return {
    data: list,
    view: table(
      ['symbol', 'name', 'decimals', '总量', '程序', '转账手续费', 'mint', '状态'],
      list.map((t) => [
        t.symbol,
        t.name,
        t.decimals,
        amount(t.supplyFormatted),
        programName(t.tokenProgram),
        t.transferFee ? `${t.transferFee.basisPoints / 100}%` : '—',
        addr(t.address),
        t.success ? tag('ok', 'ok') : tag(t.error ?? 'failed', 'bad'),
      ]),
      [2, 3],
    ),
  }
})

bind('runOwner', 'owner', async () => {
  const list = await getOwnerTokens(owner(), {
    ...indexedNode(),
    includeNfts: $<HTMLInputElement>('includeNfts').checked,
    includeZero: $<HTMLInputElement>('includeZero').checked,
  })
  return {
    data: list,
    view: table(
      ['代币', '名称', '余额', '账户数', '程序', 'mint'],
      list.map((t) => [t.symbol, t.name, amount(t.formatted), t.accounts, t.native ? '主币' : programName(t.tokenProgram), t.native ? 'SOL' : addr(t.token)]),
      [2, 3],
    ),
  }
})

function nftTable(list: NftDetails[], owners?: Map<string, string | null>): HTMLElement {
  const headers = ['名称', '集合', '标准', '版税', 'mint', ...(owners ? ['持有人'] : []), '状态']
  return table(
    headers,
    list.map((n) => [
      n.name,
      n.collection ? addr(n.collection.address) : null,
      n.tokenStandard,
      n.sellerFeeBasisPoints === null ? null : `${n.sellerFeeBasisPoints / 100}%`,
      addr(n.mint),
      ...(owners ? [addr(owners.get(n.mint))] : []),
      n.success ? tag(n.collection?.verified ? '集合已认证' : 'ok', 'ok') : tag(n.error ?? 'failed', 'bad'),
    ]),
  )
}

bind('runNft', 'nft', async () => {
  const mints = lines($<HTMLTextAreaElement>('nftMints').value)
  const withOwners = $<HTMLInputElement>('nftOwners').checked
  // 两个查询同时发出：同一个客户端会把它们合并成一个 JSON-RPC 批量请求
  const [nfts, owners] = await Promise.all([getNfts(mints, nodeOptions()), withOwners ? getNftOwners(mints, indexedNode()) : null])
  return {
    data: owners ? { nfts, owners } : nfts,
    view: nftTable(nfts, owners ? new Map(owners.map((o) => [o.mint, o.owner])) : undefined),
  }
})

bind('runOwnerNfts', 'ownerNfts', async () => {
  const list = await getOwnerNfts(owner(), indexedNode())
  return { data: list, view: nftTable(list) }
})

bind('runLp', 'lp', async () => {
  const mints = lines($<HTMLTextAreaElement>('lpMints').value)
  const pools = lines($<HTMLTextAreaElement>('lpPools').value)
  // 不指定 mints 时要扫描全部代币账户：内置公共节点不支持
  const node = mints.length ? nodeOptions() : indexedNode()
  const prices = $<HTMLInputElement>('lpPrices').checked
  let priceError: unknown = null
  const list = await getLpPositions(owner(), {
    ...node,
    ...(mints.length ? { mints } : {}),
    ...(pools.length ? { pools } : {}),
    prices,
    onPriceError: (err) => {
      priceError = err
    },
  })
  const usd = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`)
  // 价格可能很小（如 meme 币对 SOL），按有效数字显示
  const price = (v: number | null) => {
    if (v === null) return '—'
    // 只去掉小数部分末尾的 0（150000 不能变成 15）
    const [mantissa = '', exponent] = v.toPrecision(6).split('e')
    const trimmed = mantissa.includes('.') ? mantissa.replace(/\.?0+$/, '') : mantissa
    return exponent === undefined ? trimmed : `${trimmed}e${exponent}`
  }
  return {
    data: list,
    view: withPriceWarning(
      table(
        ['协议', '交易对', '数量', '未领取手续费', '区间 / 份额', '价值', '仓位'],
        list.map((p) => {
          const pair = `${p.token0.symbol ?? '?'} / ${p.token1.symbol ?? '?'}`
          const amounts = `${amount(p.amount0Formatted)} ${p.token0.symbol ?? ''} + ${amount(p.amount1Formatted)} ${p.token1.symbol ?? ''}`
          if (p.type === 'amm') {
            return [
              p.protocolName,
              pair,
              amounts,
              '计入份额',
              `${(p.share * 100).toLocaleString('en-US', { maximumSignificantDigits: 3 })}%`,
              prices ? usd(p.valueUsd) : null,
              addr(p.lpMint),
            ]
          }
          const fees = `${amount(p.fees0Formatted)} + ${amount(p.fees1Formatted)}${prices ? `（${usd(p.feesUsd)}）` : ''}`
          const range = `${price(p.priceLower)} ~ ${price(p.priceUpper)}`
          return [p.protocolName, pair, amounts, fees, tag(range, p.inRange ? 'ok' : 'bad'), prices ? usd(p.valueUsd) : null, addr(p.positionMint)]
        }),
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
