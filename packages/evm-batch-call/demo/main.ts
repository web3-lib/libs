import { NATIVE_TOKEN, TRON_CHAIN_ID, getBalances, getTokens, onRequest, type RequestEvent } from '@w3lib/evm-batch-call'
import { LP_PROTOCOLS, LP_QUOTE_TOKENS, getLpPositions, type LpPosition } from '@w3lib/evm-batch-call/lp'
import { getNftCollections, getNftOwners, getNftTokenUris } from '@w3lib/evm-batch-call/nft'
import { getOwnerTokens } from '@w3lib/evm-batch-call/owner'

// ---- 链和示例数据 ----

interface ChainInfo {
  id: number
  name: string
  /** 示例地址：链上找的、持有 V3 仓位的普通地址（2026-10 时；仓位之后可能被撤掉） */
  sample: string
}

const TRON = TRON_CHAIN_ID.mainnet

const CHAINS: ChainInfo[] = [
  {
    id: 56,
    name: 'BNB Chain',
    sample: '0xb2709AeE04A6aaA04613ADf0f5397e04Eb609f6F',
  },
  {
    id: 1,
    name: 'Ethereum',
    sample: '0xa9EC6b3707BdFE618Fffcbac4144BF9347764D32',
  },
  {
    id: 8453,
    name: 'Base',
    sample: '0x2dA91ffa7C2F8Fa9AC16E07294176D7Eb45C0E14',
  },
  {
    id: 42161,
    name: 'Arbitrum',
    sample: '0xAfa93A903Ce1FD5986db648912cb78004C93eEC9',
  },
  {
    id: 10,
    name: 'Optimism',
    sample: '0x4125Aa7bEB9cCd553D970C11eC732ccdF785dF6c',
  },
  {
    id: 137,
    name: 'Polygon',
    sample: '0x671dd7715BcF310c4867f1c8e4028fA3A4ACc9aa',
  },
  {
    id: 43114,
    name: 'Avalanche',
    sample: '0x9eE8f00C1FD6b5C4ba13315add2C7c99A99e451e',
  },
  { id: TRON, name: 'Tron', sample: 'TW7igRFaUUFWNuwsuVw1xiMQcDf4pf7SWe' },
]

/** NFT 示例：这条链上第一个 V3 仓位合约（仓位 NFT 也是 ERC721） */
const sampleNft = (chainId: number) => LP_PROTOCOLS.find((p) => p.chainId === chainId && p.version === 'v3')?.positionManager ?? ''

// ---- 设置（存在 localStorage，刷新后保留） ----

interface Settings {
  chain: number
  rpc: string
  /** 每条链各记一个地址 */
  owners: Record<string, string>
}

const SETTINGS_KEY = 'w3lib-demo:evm'

function loadSettings(): Settings {
  let stored: Partial<Settings> = {}
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') ?? {}
  } catch {
    // 存的不是 JSON：用默认的
  }
  return {
    chain: CHAINS.some((c) => c.id === stored.chain) ? (stored.chain as number) : 56,
    rpc: typeof stored.rpc === 'string' ? stored.rpc : '',
    owners: stored.owners && typeof stored.owners === 'object' ? stored.owners : {},
  }
}

const settings = loadSettings()
const save = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const chainSelect = $<HTMLSelectElement>('chain')
const rpcInput = $<HTMLInputElement>('rpc')
const ownerInput = $<HTMLInputElement>('owner')
const balanceTokens = $<HTMLTextAreaElement>('balanceTokens')
const tokenList = $<HTMLTextAreaElement>('tokenList')
const nftContract = $<HTMLInputElement>('nftContract')
const nftTokenIds = $<HTMLInputElement>('nftTokenIds')

for (const chain of CHAINS) {
  chainSelect.append(new Option(`${chain.name}（${chain.id}）`, String(chain.id)))
}

/** 切链：地址换成这条链记下的，代币和 NFT 换成这条链的示例 */
function applyChain() {
  const chainId = settings.chain
  chainSelect.value = String(chainId)
  ownerInput.value = settings.owners[chainId] ?? ''
  const tokens = LP_QUOTE_TOKENS[chainId] ?? []
  balanceTokens.value = tokens.join('\n')
  tokenList.value = tokens.join('\n')
  nftContract.value = sampleNft(chainId)
  // Tron 单次合约调用有 CPU 上限：SunSwap V3 的 tokenURI 在链上生成 SVG，几个放进同一次 multicall 就会超时
  nftTokenIds.value = chainId === TRON ? '1' : '1, 2, 3'
  for (const id of ['balancesResult', 'tokensResult', 'ownerResult', 'lpResult', 'nftResult']) $(id).replaceChildren()
  for (const id of ['balancesStats', 'tokensStats', 'ownerStats', 'lpStats', 'nftStats']) $(id).textContent = ''
}

rpcInput.value = settings.rpc
applyChain()

chainSelect.addEventListener('change', () => {
  settings.chain = Number(chainSelect.value)
  save()
  applyChain()
})
rpcInput.addEventListener('change', () => {
  settings.rpc = rpcInput.value.trim()
  save()
})
ownerInput.addEventListener('change', () => {
  settings.owners[settings.chain] = ownerInput.value.trim()
  save()
})
$('sample').addEventListener('click', () => {
  ownerInput.value = CHAINS.find((c) => c.id === settings.chain)?.sample ?? ''
  ownerInput.dispatchEvent(new Event('change'))
})

/** 各查询共用的节点参数：选的链 + 自己填的节点（不填用内置公共节点） */
const nodeOptions = () => ({
  chainId: settings.chain,
  provider: settings.rpc || undefined,
})

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
  span.textContent = !value ? '—' : value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
  return span
}

/** 元数据地址可能是很长的 data: URI（V3 仓位 NFT 在链上生成 SVG），表格里只显示开头 */
function shortUri(uri: string | null | undefined): Node | null {
  if (!uri) return null
  const span = document.createElement('span')
  span.title = uri.length > 300 ? `${uri.slice(0, 300)}…` : uri
  span.textContent = uri.length > 60 ? `${uri.slice(0, 60)}…` : uri
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

/** 美元：1 以上保留 2 位小数，小于 1 保留 4 位有效数字（小币的单价） */
function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return `$${value.toLocaleString('en-US', Math.abs(value) >= 1 || value === 0 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 4 })}`
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

/** 一次查询期间的节点请求统计（onRequest 是全局的；按钮在查询期间禁用，同一时间只有一个查询） */
function describeRequests(events: RequestEvent[], ms: number): string {
  const byMethod = new Map<string, number>()
  for (const e of events) byMethod.set(e.method, (byMethod.get(e.method) ?? 0) + 1)
  const methods = [...byMethod].map(([m, n]) => `${m} ×${n}`).join('、')
  const failed = events.filter((e) => !e.ok).length
  const nodes = [...new Set(events.filter((e) => e.ok).map((e) => e.node))].join('、')
  return [`${ms} ms`, `${events.length} 次节点请求${methods ? `（${methods}）` : ''}`, failed ? `${failed} 次失败后换节点` : '', nodes ? `节点 ${nodes}` : '']
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
  const tokens = [NATIVE_TOKEN, ...lines(balanceTokens.value)]
  const list = await getBalances(owner(), tokens, {
    ...nodeOptions(),
    symbol: true,
  })
  return {
    data: list,
    view: table(
      ['代币', '余额', '地址', '状态'],
      list.map((b) => [
        b.symbol ?? (b.native ? '主币' : null),
        amount(b.formatted),
        b.native ? '主币' : addr(b.token),
        b.success ? tag('ok', 'ok') : tag(b.error ?? 'failed', 'bad'),
      ]),
      [1],
    ),
  }
})

bind('runTokens', 'tokens', async () => {
  const list = await getTokens(lines(tokenList.value), {
    ...nodeOptions(),
    fields: ['name', 'symbol', 'decimals', 'totalSupply'],
  })
  return {
    data: list,
    view: table(
      ['symbol', 'name', 'decimals', '总量', '地址', '状态'],
      list.map((t) => [t.symbol, t.name, t.decimals, amount(t.totalSupplyFormatted), addr(t.address), t.success ? tag('ok', 'ok') : tag(t.error ?? 'failed', 'bad')]),
      [2, 3],
    ),
  }
})

bind('runOwner', 'owner', async () => {
  const prices = $<HTMLInputElement>('ownerPrices').checked
  const list = await getOwnerTokens(owner(), { ...nodeOptions(), prices })
  return {
    data: list,
    view: table(
      ['代币', '名称', '余额', '单价', '价值', '来源', '地址'],
      list.map((t) => [t.symbol, t.name, amount(t.formatted), prices ? usd(t.price) : null, prices ? usd(t.value) : null, t.source, t.native ? '主币' : addr(t.token)]),
      [2, 3, 4],
    ),
  }
})

const pair = (p: LpPosition) => `${p.token0.symbol ?? '?'} / ${p.token1.symbol ?? '?'}`

bind('runLp', 'lp', async () => {
  const prices = $<HTMLInputElement>('lpPrices').checked
  const tokenIds = lines($<HTMLInputElement>('v4TokenIds').value)
  let priceError: unknown = null
  const list = await getLpPositions(owner(), {
    ...nodeOptions(),
    prices,
    onPriceError: (err) => {
      priceError = err
    },
    includeClosed: $<HTMLInputElement>('lpClosed').checked,
    v4: tokenIds.length ? { tokenIds } : undefined,
  })
  return {
    data: list,
    view: withPriceWarning(
      table(
        ['协议', '交易对', '价值', '数量', '未领手续费', '区间', '仓位'],
        list.map((p) => [
          p.protocolName,
          pair(p),
          prices ? usd(p.valueUsd) : null,
          `${amount(p.amount0Formatted)} ${p.token0.symbol ?? ''} + ${amount(p.amount1Formatted)} ${p.token1.symbol ?? ''}`,
          p.version === 'v2' ? '计入份额' : `${amount(p.fees0Formatted)} + ${amount(p.fees1Formatted)}${prices ? `（${usd(p.feesUsd)}）` : ''}`,
          p.version === 'v2' ? null : p.inRange ? tag('区间内', 'ok') : tag('区间外', 'bad'),
          p.version === 'v2' ? `份额 ${(p.share * 100).toPrecision(3)}%` : `#${p.tokenId}`,
        ]),
        [2],
      ),
      priceError,
    ),
  }
})

bind('runNft', 'nft', async () => {
  const contract = nftContract.value.trim()
  if (!contract) throw new Error('请填写 NFT 合约地址')
  const items = lines(nftTokenIds.value).map((tokenId) => ({
    contract,
    tokenId,
  }))
  const options = nodeOptions()
  // 集合信息和持有人同时发出（同一个 Provider 自动合并成一次 multicall）；
  // 元数据地址单独查：V3 仓位 NFT 的 tokenURI 在链上生成 SVG，很重，在 Tron 上和别的调用合在一次里会超出 CPU 上限
  const [collections, owners] = await Promise.all([
    getNftCollections([contract], {
      ...options,
      fields: ['standard', 'name', 'symbol', 'totalSupply'],
    }),
    getNftOwners(items, options),
  ])
  const uris = await getNftTokenUris(items, {
    ...options,
    ipfsGateway: 'https://ipfs.io/ipfs/',
  })
  const collection = collections[0]
  const info = document.createElement('p')
  info.textContent = collection ? `${collection.name ?? '?'}（${collection.symbol ?? '?'}）· ${collection.standard ?? '未识别的标准'} · 总量 ${collection.totalSupply ?? '—'}` : ''
  const view = document.createElement('div')
  view.append(
    info,
    table(
      ['tokenId', '持有人', '元数据地址'],
      owners.map((o, i) => [o.tokenId, addr(o.owner), shortUri(uris[i]?.uri)]),
    ),
  )
  return { data: { collections, owners, uris }, view }
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
