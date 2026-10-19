import { NATIVE_TOKEN, Provider, TRON_CHAIN_ID, getBalances, getTokens, onRequest, type RequestEvent } from '@w3lib/evm-batch-call'
import {
  addLiquidity,
  buildAddLiquidity,
  buildCollectFees,
  buildRemoveLiquidity,
  collectFees,
  removeLiquidity,
  type AddLiquidityParams,
  type LiquidityOptions,
  type LiquidityPlan,
  type LiquidityResult,
  type LiquidityTxResult,
  type RemoveLiquidityParams,
} from '@w3lib/evm-batch-call/liquidity'
import { LP_PROTOCOLS, LP_QUOTE_TOKENS, getLpPositions, type LpPosition } from '@w3lib/evm-batch-call/lp'
import { createWallet } from '@w3lib/wallet'
import { arbitrum, avalanche, base, bsc, ethereum, optimism, polygon } from '@w3lib/wallet/chains'
import { evm } from '@w3lib/wallet/evm'
import { tron } from '@w3lib/wallet/tron'
import { createWalletModal } from '@w3lib/wallet/ui'
import { BrowserProvider, formatUnits, type Eip1193Provider } from 'ethers'
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
  for (const id of ['balancesResult', 'tokensResult', 'ownerResult', 'lpResult', 'nftResult', 'liqResult']) $(id).replaceChildren()
  for (const id of ['balancesStats', 'tokensStats', 'ownerStats', 'lpStats', 'nftStats', 'liqStats']) $(id).textContent = ''
  applyLiquidityChain()
}

rpcInput.value = settings.rpc
// 先定义好“添加 / 移除流动性”里用到的元素，applyChain 会填这一部分的默认值
const liq = {
  action: $<HTMLSelectElement>('liqAction'),
  protocol: $<HTMLSelectElement>('liqProtocol'),
  tokenA: $<HTMLInputElement>('liqTokenA'),
  tokenB: $<HTMLInputElement>('liqTokenB'),
  fee: $<HTMLInputElement>('liqFee'),
  priceLower: $<HTMLInputElement>('liqPriceLower'),
  priceUpper: $<HTMLInputElement>('liqPriceUpper'),
  amountA: $<HTMLInputElement>('liqAmountA'),
  amountB: $<HTMLInputElement>('liqAmountB'),
  position: $<HTMLSelectElement>('liqPosition'),
  amount0: $<HTMLInputElement>('liqAmount0'),
  amount1: $<HTMLInputElement>('liqAmount1'),
  percent: $<HTMLInputElement>('liqPercent'),
  burn: $<HTMLInputElement>('liqBurn'),
  slippage: $<HTMLInputElement>('liqSlippage'),
  native: $<HTMLInputElement>('liqNative'),
}
/** 上一次“查询 LP”的结果：追加、移除、领取从里面选仓位 */
let lastPositions: LpPosition[] = []

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
  const from = owner()
  const list = await getLpPositions(from, {
    ...nodeOptions(),
    prices,
    onPriceError: (err) => {
      priceError = err
    },
    includeClosed: $<HTMLInputElement>('lpClosed').checked,
    v4: tokenIds.length ? { tokenIds } : undefined,
  })
  setPositions(list, from)
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

// ---- 添加 / 移除流动性（子路径 /liquidity） ----

// 钱包：EVM 的几条链和 Tron；连接弹窗用 @w3lib/wallet/ui
const EVM_CHAINS = new Map([ethereum, bsc, base, arbitrum, optimism, polygon, avalanche].map((c) => [c.id, c]))
const wallet = createWallet({ connectors: [evm({ chains: [...EVM_CHAINS.values()] }), tron()] })
const modal = createWalletModal(wallet)
const isTron = (chainId = settings.chain) => chainId === TRON
const walletNamespace = () => (isTron() ? 'tron' : 'evm')
const connection = () => wallet.getConnection(walletNamespace())

/** 交易浏览器和主币（EVM 链用钱包的链信息；Tron：tronscan、TRX 6 位小数） */
function chainMeta(chainId: number) {
  if (isTron(chainId)) return { explorer: 'https://tronscan.org/#/transaction/', symbol: 'TRX', decimals: 6 }
  const c = EVM_CHAINS.get(chainId)
  const explorer = c?.blockExplorerUrls?.[0]
  return { explorer: explorer ? `${explorer}/tx/` : null, symbol: c?.nativeCurrency.symbol ?? '主币', decimals: c?.nativeCurrency.decimals ?? 18 }
}

function renderWallet() {
  const c = connection()
  const info = $('walletInfo')
  if (!c) {
    info.textContent = '未连接（只构建时用上面“地址”栏的地址）'
    $('connectWallet').textContent = '连接钱包'
    return
  }
  const network = isTron()
    ? c.chainId === 'mainnet'
      ? ''
      : `（钱包在 ${c.chainId ?? '未知网络'}，请切到主网）`
    : c.chainId !== null && Number(c.chainId) !== settings.chain
      ? `（钱包在链 ${c.chainId}，发送时会请求切换）`
      : ''
  info.textContent = `${c.walletName} · ${c.address}${network}`
  $('connectWallet').textContent = '切换 / 断开'
}

wallet.subscribe(() => renderWallet())
void wallet.ready.then(renderWallet)
$('connectWallet').addEventListener('click', () => void modal.open(walletNamespace()))

// 同一条链、同一个节点复用 Provider（自动合并请求）
let liqProvider: { key: string; provider: Provider } | null = null
function liquidityProvider(): Provider {
  const key = `${settings.chain}|${settings.rpc}`
  if (liqProvider?.key !== key) liqProvider = { key, provider: new Provider(settings.chain, settings.rpc || undefined) }
  return liqProvider.provider
}

/** 切链时：协议换成这条链的，默认主币 / 稳定币、第一个 V3 协议 */
function applyLiquidityChain() {
  const chainId = settings.chain
  liq.protocol.replaceChildren(...LP_PROTOCOLS.filter((p) => p.chainId === chainId).map((p) => new Option(`${p.name}（${p.version.toUpperCase()}）`, p.id)))
  liq.protocol.value = LP_PROTOCOLS.find((p) => p.chainId === chainId && p.version === 'v3')?.id ?? liq.protocol.value
  liq.tokenA.value = 'native'
  liq.tokenB.value = LP_QUOTE_TOKENS[chainId]?.[1] ?? ''
  liq.fee.value = isTron(chainId) ? '3000' : '500'
  liq.priceLower.value = liq.priceUpper.value = liq.amountB.value = ''
  liq.amountA.value = isTron(chainId) ? '10' : '0.001'
  setPositions([], '')
  applyProtocol()
  renderWallet()
}

function applyProtocol() {
  const version = LP_PROTOCOLS.find((p) => p.id === liq.protocol.value)?.version
  liq.fee.disabled = version === 'v2'
  liq.priceLower.disabled = liq.priceUpper.disabled = version === 'v2'
}

function applyAction() {
  const action = liq.action.value
  $('liqNew').hidden = action !== 'new'
  $('liqExisting').hidden = action === 'new'
  $('liqAddAmounts').hidden = action !== 'add'
  $('liqRemoveOptions').hidden = action !== 'remove'
}

/** 仓位是哪个地址的（查询“LP 仓位”时的地址）：追加、移除、领取要用这个地址 */
let positionsOwner = ''

function setPositions(list: LpPosition[], of: string) {
  lastPositions = list
  positionsOwner = of
  const options = list.map((p, i) => new Option(`${p.protocolName} · ${pair(p)} · ${p.version === 'v2' ? `份额 ${(p.share * 100).toPrecision(3)}%` : `#${p.tokenId}`}`, String(i)))
  liq.position.replaceChildren(...(options.length ? options : [new Option('先在上面“LP 仓位”里查询（用同一个地址）', '')]))
}

liq.protocol.addEventListener('change', applyProtocol)
liq.action.addEventListener('change', applyAction)
// 初始化放在最后：applyChain 会用到上面定义的钱包和表单
applyChain()
applyAction()

const text = (input: HTMLInputElement) => input.value.trim() || undefined
const tokenOf = (input: HTMLInputElement) => (/^(native|主币)?$/i.test(input.value.trim()) ? NATIVE_TOKEN : input.value.trim())
const sameAddress = (a: string, b: string) => (isTron() ? a === b : a.toLowerCase() === b.toLowerCase())

/**
 * 构建 / 发送用的地址：连了钱包用钱包地址（追加、移除、领取时要和仓位的地址一致）；
 * 没连钱包时，追加、移除、领取用仓位的地址，新建用“地址”栏的
 */
function liquidityFrom(walletAddress?: string): string {
  if (liq.action.value === 'new') return walletAddress ?? owner()
  if (walletAddress && positionsOwner && !sameAddress(walletAddress, positionsOwner)) {
    throw new Error(`仓位是 ${positionsOwner} 的，钱包是 ${walletAddress}：换成仓位的账户，或用钱包地址重新查询 LP 仓位`)
  }
  return walletAddress ?? positionsOwner
}

function selectedPosition(): LpPosition {
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

function liquidityOptions(): LiquidityOptions {
  const percent = numberOf(liq.slippage, '滑点')
  if (percent !== undefined && !(percent >= 0 && percent < 100)) throw new Error('滑点要在 0 ~ 100% 之间')
  return { ...(percent === undefined ? {} : { slippage: percent / 100 }), ...(liq.native.checked ? { native: true } : {}) }
}

function addParams(): AddLiquidityParams {
  if (liq.action.value === 'add') return { position: selectedPosition(), amount0Formatted: text(liq.amount0), amount1Formatted: text(liq.amount1) }
  const version = LP_PROTOCOLS.find((p) => p.id === liq.protocol.value)?.version
  const fee = version === 'v2' ? undefined : numberOf(liq.fee, '手续费档位')
  if (fee !== undefined && !(Number.isInteger(fee) && fee > 0)) throw new Error('手续费档位要填正整数（百万分之一，如 500 = 0.05%）')
  const lower = text(liq.priceLower)
  const upper = text(liq.priceUpper)
  return {
    protocol: liq.protocol.value,
    tokenA: tokenOf(liq.tokenA),
    tokenB: tokenOf(liq.tokenB),
    ...(fee === undefined ? {} : { fee }),
    ...(version === 'v2' ? {} : lower || upper ? { priceLower: lower, priceUpper: upper } : { fullRange: true }),
    amountAFormatted: text(liq.amountA),
    amountBFormatted: text(liq.amountB),
  }
}

function removeParams(): RemoveLiquidityParams {
  const percent = numberOf(liq.percent, '移除比例')
  if (percent !== undefined && !(percent > 0 && percent <= 100)) throw new Error('移除比例要在 0 ~ 100% 之间')
  return { position: selectedPosition(), ...(percent === undefined ? {} : { percent }), burn: liq.burn.checked }
}

/** 表单 → 要调用的函数和参数（连接钱包之前先检查表单） */
function liquidityRequest() {
  const action = liq.action.value
  const options = liquidityOptions()
  if (action === 'new' || action === 'add') return { action: 'add' as const, params: addParams(), options }
  if (action === 'remove') return { action: 'remove' as const, params: removeParams(), options }
  return { action: 'collect' as const, params: { position: selectedPosition() }, options }
}

/** 按最小单位的数量按精度换算（显示用） */
function units(value: string | null, decimals: number | null): string {
  if (value === null) return '—'
  return decimals === null ? value : amount(formatUnits(value, decimals))
}

/** chainId：构建 / 发送时的链（发送中切了链也不影响结果的显示） */
function planView(plan: LiquidityPlan, chainId: number, results?: LiquidityTxResult[]): Node {
  const meta = chainMeta(chainId)
  const nativeAmount = (value: string) => `${amount(formatUnits(value, meta.decimals))} ${meta.symbol}`
  const s0 = plan.token0.symbol ?? 'token0'
  const s1 = plan.token1.symbol ?? 'token1'
  const both = (a: string | null, b: string | null) => `${units(a, plan.token0.decimals)} ${s0} + ${units(b, plan.token1.decimals)} ${s1}`
  const collect = plan.action === 'collect'
  const rows: Array<[string, string | null]> = [
    ['协议', `${plan.protocolName}（${plan.version.toUpperCase()}）${plan.createPool ? ' · 会创建池子' : ''}`],
    ['交易对', `${s0} / ${s1}${plan.native ? `（${plan.native === 'token0' ? s0 : s1} 用 ${meta.symbol}）` : ''}`],
    ['当前价格', plan.price === null ? null : `1 ${s0} = ${price(plan.price)} ${s1}`],
    ['区间', plan.priceLower === null ? (plan.version === 'v2' ? '全区间（V2）' : null) : `${price(plan.priceLower)} ~ ${price(plan.priceUpper)}（tick ${plan.tickLower} ~ ${plan.tickUpper}）`],
    [plan.action === 'add' ? '预计存入' : '预计取回', collect ? null : both(plan.amount0, plan.amount1)],
    ['上限', plan.amount0Max === null ? null : both(plan.amount0Max, plan.amount1Max)],
    ['下限', plan.amount0Min === null || collect ? null : both(plan.amount0Min, plan.amount1Min)],
    [collect ? '领取的手续费' : '一并领取的手续费', plan.fees0 === '0' && plan.fees1 === '0' && !collect ? null : both(plan.fees0, plan.fees1)],
    [`附带 ${meta.symbol}`, plan.value === '0' ? null : nativeAmount(plan.value)],
    [plan.version === 'v2' ? 'LP 数量' : '流动性', collect ? null : plan.liquidity],
  ]
  const wrap = document.createElement('div')
  wrap.append(
    table(
      ['项目', '值'],
      rows.filter(([, v]) => v !== null),
    ),
    table(
      ['#', '交易', '发给', `附带 ${meta.symbol}`, '授权', ...(results ? ['状态', '交易哈希'] : [])],
      plan.transactions.map((tx, i) => {
        const r = results?.[i]
        const hash = r?.hash ? link(r.hash, meta.explorer) : null
        return [
          i + 1,
          tx.kind,
          addr(tx.to),
          tx.value === '0' ? null : nativeAmount(tx.value),
          tx.token ? `${addr(tx.token).textContent} → ${addr(tx.spender).textContent}` : null,
          ...(results ? [r ? tag(r.status + (r.error ? `：${r.error}` : ''), r.status === 'confirmed' ? 'ok' : r.status === 'failed' || r.status === 'reverted' ? 'bad' : '') : '等待', hash] : []),
        ]
      }),
    ),
  )
  return wrap
}

/** 价格按有效数字显示（小币对主币的价格很小） */
function price(v: number | null): string {
  if (v === null) return '—'
  const [mantissa = '', exponent] = v.toPrecision(6).split('e')
  const trimmed = mantissa.includes('.') ? mantissa.replace(/\.?0+$/, '') : mantissa
  return exponent === undefined ? trimmed : `${trimmed}e${exponent}`
}

function link(hash: string, explorer: string | null): Node {
  const text = `${hash.slice(0, 10)}…`
  if (!explorer) return document.createTextNode(text)
  const a = document.createElement('a')
  a.href = `${explorer}${hash}`
  a.target = '_blank'
  a.rel = 'noopener'
  a.textContent = text
  return a
}

bind('runLiqBuild', 'liq', async () => {
  const chainId = settings.chain
  const { action, params, options } = liquidityRequest()
  const from = liquidityFrom(connection()?.address)
  const provider = liquidityProvider()
  const plan =
    action === 'add'
      ? await buildAddLiquidity(provider, from, params, options)
      : action === 'remove'
        ? await buildRemoveLiquidity(provider, from, params, options)
        : await buildCollectFees(provider, from, params, options)
  return { data: plan, view: planView(plan, chainId) }
})

bind('runLiqSend', 'liq', async () => {
  // 发送中不能切链（结果、钱包网络都按发送时的链）
  const chainId = settings.chain
  chainSelect.disabled = true
  try {
    const { action, params, options } = liquidityRequest()
    let c = connection()
    if (!c) c = await modal.open(walletNamespace())
    if (!c) throw new Error('没有连接钱包')
    if (isTron(chainId)) {
      if (c.chainId !== 'mainnet') throw new Error(`钱包在 ${c.chainId ?? '未知网络'}，请在钱包里切到 Tron 主网`)
    } else if (Number(c.chainId) !== chainId) {
      await wallet.switchChain(chainId, 'evm')
      c = connection()
      if (!c) throw new Error('钱包已断开')
    }
    liquidityFrom(c.address)
    // EVM：EIP-1193 provider → ethers Signer（由钱包签名并发送）；Tron：直接用钱包注入的 tronWeb
    const signer = isTron(chainId) ? (c.provider as never) : await new BrowserProvider(c.provider as Eip1193Provider).getSigner()
    const progress = $('liqStats')
    const sendOptions = { ...options, onUpdate: (r: LiquidityTxResult) => (progress.textContent = `第 ${r.index + 1} 笔（${r.kind}）：${r.status}`) }
    const provider = liquidityProvider()
    const result: LiquidityResult =
      action === 'add'
        ? await addLiquidity(provider, signer, params, sendOptions)
        : action === 'remove'
          ? await removeLiquidity(provider, signer, params, sendOptions)
          : await collectFees(provider, signer, params, sendOptions)
    const view = document.createElement('div')
    const note = document.createElement('p')
    note.className = 'hint'
    note.textContent = `结果：${result.status}${result.tokenId ? ` · 新仓位 #${result.tokenId}` : ''}（可以在“LP 仓位”里重新查询）`
    view.append(note, planView(result.plan, chainId, result.results))
    return { data: result, view }
  } finally {
    chainSelect.disabled = false
  }
})
