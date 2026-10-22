import { mountShell, setNodeStatus } from '../../demo-shared/shell'
import { DEFAULT_RPC_URLS, NATIVE_TOKEN, Provider, TRON_CHAIN_ID, getBalances, getTokens, onRequest, type ProviderSource, type RequestEvent } from '@w3lib/evm-batch-call'
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
import { buildRevokes, getApprovals, revokeApprovals, type Approval, type RevokeResult } from '@w3lib/evm-batch-call/approvals'
import { getCostEstimate, getFeeEstimate, type CostEstimate, type FeeLevel, type FeeLevelEstimate } from '@w3lib/evm-batch-call/fees'
import { LP_PROTOCOLS, LP_QUOTE_TOKENS, getLpPositions, keyValueLpScanStorage, type LpPosition } from '@w3lib/evm-batch-call/lp'
import { NAME_SERVICES, getAddressNames, getNameAddresses } from '@w3lib/evm-batch-call/names'
import { getPortfolio, getTokenPrices, type Portfolio } from '@w3lib/evm-batch-call/price'
import { getTokenRisks, type TokenRisk } from '@w3lib/evm-batch-call/risk'
import { BundlerClient, getSimpleAccount, getWalletCapabilities } from '@w3lib/evm-batch-call/smart-account'
import { claimDividends, getDividends, type DividendItem } from '@w3lib/evm-batch-call/dividends'
import { getHistory, type Activity } from '@w3lib/evm-batch-call/history'
import { buildClaimAll, claimAll, getClaimable, type ClaimItem, type ClaimPlan } from '@w3lib/evm-batch-call/rewards'
import { getBatchSimulation, getSimulation, type BatchSimulationResult, type SimulationResult } from '@w3lib/evm-batch-call/simulate'
import { batchTransfer } from '@w3lib/evm-batch-call/write'
import { detectPermit, buildPermit, signPermit, permitCalldata } from '@w3lib/evm-batch-call/permit'
import { getSwapQuote, swap, type SwapPlan, type SwapResult, type SwapTxResult } from '@w3lib/evm-batch-call/swap'
import { createWallet } from '@w3lib/wallet'
import { arbitrum, avalanche, base, bsc, ethereum, optimism, polygon } from '@w3lib/wallet/chains'
import { evm } from '@w3lib/wallet/evm'
import { tron } from '@w3lib/wallet/tron'
import { createWalletModal } from '@w3lib/wallet/ui'
import { BrowserProvider, formatUnits, parseUnits, type Eip1193Provider } from 'ethers'
import { getNftCollections, getNftOwners, getNftTokenUris } from '@w3lib/evm-batch-call/nft'
import { getOwnerTokens } from '@w3lib/evm-batch-call/owner'

// 外壳：侧边分组导航 + 设置 / 连接面板（见 packages/demo-shared/shell.ts）
mountShell()

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
  for (const id of ['balancesResult', 'tokensResult', 'ownerResult', 'lpResult', 'nftResult', 'liqResult', 'priceResult', 'apprResult', 'revokeResult', 'namesResult', 'feesResult', 'swapResult', 'smartResult', 'riskResult', 'simResult', 'histResult', 'claimResult', 'btResult', 'pmResult', 'divResult']) $(id).replaceChildren()
  for (const id of ['balancesStats', 'tokensStats', 'ownerStats', 'lpStats', 'nftStats', 'liqStats', 'priceStats', 'apprStats', 'revokeStats', 'namesStats', 'feesStats', 'swapStats', 'smartStats', 'riskStats', 'simStats', 'histStats', 'claimStats', 'btStats', 'pmStats', 'divStats', 'lpV4Progress', 'liqLoadStatus']) $(id).textContent = ''
  applyLiquidityChain()
  applyExtraChain()
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
/**
 * 查询用的节点：填了自己的节点就用它；没填时，已连接的 EVM 钱包正好在这条链上，就先走钱包的节点
 * （只读请求，不会弹窗），钱包出错时再退到内置公共节点；钱包在别的链上 / 没连接时只用内置公共节点
 */
function nodeSource(): ProviderSource | readonly ProviderSource[] | undefined {
  if (settings.rpc) return settings.rpc
  if (isTron()) return undefined
  const c = wallet.getConnection('evm')
  if (!c || Number(c.chainId) !== settings.chain) return undefined
  return [c.provider as Eip1193Provider, ...(DEFAULT_RPC_URLS[settings.chain] ?? [])]
}
/** 当前用的是哪类节点：自己的 / 钱包 / 内置公共（节点变了就重建 Provider） */
const nodeKey = () => (settings.rpc ? `rpc:${settings.rpc}` : Array.isArray(nodeSource()) ? `wallet:${wallet.getConnection('evm')?.address}` : 'public')

const nodeOptions = () => ({
  chainId: settings.chain,
  provider: nodeSource(),
})

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

/** V4 仓位：填了 tokenId 就直接查；否则可以扫描仓位合约发给这个地址的 Transfer 事件（进度存在 localStorage，每次推进一段） */
function v4Options(tokenIds: string[], scan: boolean, progressEl?: HTMLElement) {
  if (tokenIds.length) return { tokenIds }
  if (!scan) return undefined
  return {
    scan: {
      storage: keyValueLpScanStorage(localStorage),
      onProgress: (p: { cursor: number; target: number | null; done: boolean; startBlock: number; pausedUntil?: number; skipped?: true; held?: number }) => {
        if (!progressEl) return
        const held = p.held === undefined ? '' : `这个地址持有 ${p.held} 个 V4 仓位 NFT；`
        const left = p.target !== null && p.cursor >= 0 ? p.target - p.cursor : null
        const slow = left !== null && left > 1_000_000
        progressEl.textContent = p.skipped
          ? '这个地址没有 V4 仓位 NFT，不用扫描'
          : p.pausedUntil
            ? `${held}节点不开放 eth_getLogs，V4 扫描已暂停：在右上角“节点设置”里换自己的节点，或手填 V4 tokenId`
            : p.done
              ? `${held}V4 扫描完成（已扫到区块 ${p.cursor}）`
              : `${held}V4 扫描中：已扫到区块 ${p.cursor}${p.target ? ` / ${p.target}` : ''}` +
                (slow
                  ? `，还剩约 ${Math.round((left as number) / 1e6)} 百万个区块。公共节点每次只能查很小的区块范围，扫完要很久：建议在右上角“节点设置”里填自己的节点，或手填 V4 tokenId`
                  : '，结果还不完整，再点一次“查询”继续')
      },
    },
  }
}

const pair = (p: LpPosition) => `${p.token0.symbol ?? '?'} / ${p.token1.symbol ?? '?'}`

/** LP 查询（“LP 仓位”页的按钮和“加载我的仓位”共用） */
async function queryLp() {
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
    v4: v4Options(tokenIds, $<HTMLInputElement>('lpV4Scan').checked, $('lpV4Progress')),
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
}
bind('runLp', 'lp', queryLp)

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
  // 没填节点、钱包又在这条链上：查询走钱包的节点（节点按钮上显示“钱包”）
  setNodeStatus(Array.isArray(nodeSource()) ? '钱包' : null)
  // 连上钱包、地址栏还空着：填上钱包地址（查询默认查自己的钱包）
  if (c && !ownerInput.value.trim()) {
    ownerInput.value = c.address
    ownerInput.dispatchEvent(new Event('change'))
  }
  const info = $('walletInfo')
  if (!c) {
    info.textContent = '未连接（只读查询不需要钱包）'
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
  const key = `${settings.chain}|${nodeKey()}`
  if (liqProvider?.key !== key) liqProvider = { key, provider: new Provider(settings.chain, nodeSource()) }
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
  liq.position.replaceChildren(...(options.length ? options : [new Option('没有仓位：点右边“加载我的仓位”，或在“LP 仓位”页查询', '')]))
}

liq.protocol.addEventListener('change', applyProtocol)
liq.action.addEventListener('change', applyAction)

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

// ---- 价格、授权、域名、手续费、兑换、风险（子路径 /price /approvals /names /fees /swap /risk） ----

const ex = {
  priceTokens: $<HTMLTextAreaElement>('priceTokens'),
  priceLp: $<HTMLInputElement>('priceLp'),
  priceMinUsd: $<HTMLInputElement>('priceMinUsd'),
  apprTokens: $<HTMLTextAreaElement>('apprTokens'),
  apprNfts: $<HTMLTextAreaElement>('apprNfts'),
  apprPermit2: $<HTMLInputElement>('apprPermit2'),
  apprZero: $<HTMLInputElement>('apprZero'),
  nameList: $<HTMLTextAreaElement>('nameList'),
  nameAddresses: $<HTMLTextAreaElement>('nameAddresses'),
  feeTo: $<HTMLInputElement>('feeTo'),
  feeData: $<HTMLInputElement>('feeData'),
  feeValue: $<HTMLInputElement>('feeValue'),
  feeLevel: $<HTMLSelectElement>('feeLevel'),
  swapTokenIn: $<HTMLInputElement>('swapTokenIn'),
  swapTokenOut: $<HTMLInputElement>('swapTokenOut'),
  swapAmount: $<HTMLInputElement>('swapAmount'),
  swapSlippage: $<HTMLInputElement>('swapSlippage'),
  swapTax: $<HTMLInputElement>('swapTax'),
  swapApproveMax: $<HTMLInputElement>('swapApproveMax'),
  swapApprove: $<HTMLSelectElement>('swapApprove'),
  swapMode: $<HTMLSelectElement>('swapMode'),
  riskTokens: $<HTMLTextAreaElement>('riskTokens'),
}

/** 域名示例（别的链没有内置的域名服务） */
const NAME_SAMPLES: Record<number, string> = { 1: 'vitalik.eth', 56: 'binance.bnb', 8453: 'jesse.base.eth' }

/** 上一次“查询授权”的结果和勾选框（和 lastApprovals 一一对应）、查询用的地址 */
let lastApprovals: Approval[] = []
let approvalChecks: HTMLInputElement[] = []
let approvalsOwner = ''

/** 切链时：各区块填这条链的默认值，Tron 没有 Permit2 */
function applyExtraChain() {
  const chainId = settings.chain
  const quote = LP_QUOTE_TOKENS[chainId] ?? []
  ex.priceTokens.value = ['native', ...quote].join('\n')
  ex.apprTokens.value = quote.join('\n')
  ex.apprNfts.value = ''
  ex.apprPermit2.checked = !isTron(chainId)
  ex.apprPermit2.disabled = isTron(chainId)
  lastApprovals = []
  approvalChecks = []
  approvalsOwner = ''
  ex.nameList.value = NAME_SAMPLES[chainId] ?? ''
  ex.nameAddresses.value = ''
  ex.feeTo.value = ex.feeData.value = ex.feeValue.value = ''
  ex.swapTokenIn.value = 'native'
  ex.swapTokenOut.value = quote[1] ?? ''
  ex.swapAmount.value = isTron(chainId) ? '10' : '0.001'
  ex.swapTax.value = ''
  // 第一个是包装主币：风险检查的是别的代币
  ex.riskTokens.value = quote.slice(1).join('\n')
}

/** 代币列表：native / 主币 换成 NATIVE_TOKEN */
const tokenLines = (value: string) => lines(value).map((t) => (/^(native|主币)$/i.test(t) ? NATIVE_TOKEN : t))

const percentText = (v: number | null) => (v === null ? null : `${(v * 100).toFixed(2)}%`)

/** 连接钱包（没连时弹出连接窗口）、切到这条链，返回签名者：EVM 是 ethers Signer，Tron 直接用钱包注入的 tronWeb */
async function walletSigner(chainId: number) {
  let c = connection()
  if (!c) c = await modal.open(walletNamespace())
  if (!c) throw new Error('没有连接钱包')
  if (isTron(chainId)) {
    if (c.chainId !== 'mainnet') throw new Error(`钱包在 ${c.chainId ?? '未知网络'}，请在钱包里切到 Tron 主网`)
  } else if (Number(c.chainId) !== chainId) {
    await wallet.switchChain(chainId, 'evm')
    c = connection()
    if (!c) throw new Error('钱包已断开')
    // 用户拒绝或钱包忽略切换时，连接还在原来的链上：不能把按 chainId 构建的交易发过去
    if (Number(c.chainId) !== chainId) throw new Error(`钱包还在链 ${c.chainId ?? '未知'}，请在钱包里切到链 ${chainId} 后重试`)
  }
  const signer = isTron(chainId) ? (c.provider as never) : await new BrowserProvider(c.provider as Eip1193Provider).getSigner()
  return { signer, address: c.address }
}

/** 交易状态的标签（等待、成功、失败） */
function statusTag(status: string, error: string | null | undefined): Node {
  return tag(status + (error ? `：${error}` : ''), status === 'confirmed' ? 'ok' : status === 'failed' || status === 'reverted' ? 'bad' : '')
}

/** 项目 / 值 两列的表（值为 null 的行不显示） */
const keyValues = (rows: Array<[string, Cell]>) =>
  table(
    ['项目', '值'],
    rows.filter(([, v]) => v !== null),
  )

// ---- 价格 / 资产总值 ----

function priceTokensInput(): string[] {
  const tokens = tokenLines(ex.priceTokens.value)
  if (!tokens.length) throw new Error('请填写至少一个代币')
  return tokens
}

bind('runPrices', 'price', async () => {
  const tokens = priceTokensInput()
  let priceError: unknown = null
  const list = await getTokenPrices(tokens, {
    ...nodeOptions(),
    onError: (_source, err) => {
      priceError = err
    },
  })
  return {
    data: list,
    view: withPriceWarning(
      table(
        ['代币', '价格', '来源', '地址'],
        list.map((p) => [p.native ? '主币' : null, usd(p.price), p.source, p.native ? '主币' : addr(p.token)]),
        [1],
      ),
      priceError,
    ),
  }
})

function portfolioView(p: Portfolio): Node {
  const wrap = document.createElement('div')
  const summary = document.createElement('p')
  summary.textContent = `合计 ${usd(p.totalUsd)}（代币 ${usd(p.tokensUsd)}${p.lp.length || p.lpUsd ? ` + LP ${usd(p.lpUsd)}` : ''}）${p.unpriced ? ` · ${p.unpriced} 项没有价格，不计入合计` : ''}`
  wrap.append(
    summary,
    table(
      ['代币', '余额', '单价', '价值', '来源', '地址'],
      p.tokens.map((t) => [t.symbol, amount(t.formatted), usd(t.price), usd(t.value), t.priceSource, t.native ? '主币' : addr(t.token)]),
      [1, 2, 3],
    ),
  )
  if (p.lp.length) {
    wrap.append(
      table(
        ['LP 协议', '交易对', '价值', '仓位'],
        p.lp.map((l) => [l.protocolName, pair(l), usd(l.valueUsd), l.version === 'v2' ? `份额 ${(l.share * 100).toPrecision(3)}%` : `#${l.tokenId}`]),
        [2],
      ),
    )
  }
  return wrap
}

bind('runPortfolio', 'price', async () => {
  const tokens = priceTokensInput()
  const minUsd = numberOf(ex.priceMinUsd, '最小价值')
  if (minUsd !== undefined && minUsd < 0) throw new Error('最小价值不能小于 0')
  const from = owner()
  let priceError: unknown = null
  const p = await getPortfolio(from, {
    ...nodeOptions(),
    tokens,
    lp: ex.priceLp.checked,
    ...(minUsd === undefined ? {} : { minUsd }),
    onPriceError: (err) => {
      priceError = err
    },
  })
  return { data: p, view: withPriceWarning(portfolioView(p), priceError) }
})

// ---- 授权 ----

/** 这一项现在还有效、撤销有意义 */
function revocable(a: Approval): boolean {
  if (a.type === 'nft') return a.approved
  return BigInt(a.amount) > 0n && !(a.type === 'permit2' && a.expired)
}

function approvalsView(list: Approval[]): Node {
  approvalChecks = list.map((a) => {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.disabled = !revocable(a)
    // 默认只勾无限授权和 NFT 的全部授权
    box.checked = revocable(a) && (a.type === 'nft' || a.unlimited)
    return box
  })
  return table(
    ['撤销', '类型', '代币 / 合约', '被授权方', '额度', '备注'],
    list.map((a, i) => {
      const spender = document.createElement('span')
      spender.append(a.spenderName ? `${a.spenderName} ` : '', addr(a.spender))
      if (a.type === 'nft') return [approvalChecks[i], 'NFT 全部', addr(a.collection), spender, a.approved ? tag('已授权', 'bad') : '未授权', null]
      const limit = a.unlimited ? tag('无限', 'bad') : a.formatted !== null ? amount(a.formatted) : a.amount
      const note = a.type === 'permit2' ? (a.expired ? '已过期' : a.expiration === 0 ? null : `到 ${new Date(a.expiration * 1000).toLocaleString()}`) : null
      const token = document.createElement('span')
      token.append(a.symbol ? `${a.symbol} ` : '', addr(a.token))
      return [approvalChecks[i], a.type === 'permit2' ? 'Permit2' : 'ERC20', token, spender, limit, note]
    }),
  )
}

bind('runApprovals', 'appr', async () => {
  const from = owner()
  const tokens = lines(ex.apprTokens.value)
  const nfts = lines(ex.apprNfts.value)
  if (!tokens.length && !nfts.length) throw new Error('请填写要检查的代币或 NFT 合约')
  lastApprovals = []
  approvalChecks = []
  $('revokeResult').replaceChildren()
  $('revokeStats').textContent = ''
  const list = await getApprovals(from, {
    ...nodeOptions(),
    ...(tokens.length ? { tokens } : {}),
    ...(nfts.length ? { nfts } : {}),
    permit2: ex.apprPermit2.checked && !isTron(),
    includeZero: ex.apprZero.checked,
  })
  lastApprovals = list
  approvalsOwner = from
  return { data: list, view: approvalsView(list) }
})

/** 勾选的授权（没有查询过或一个都没勾时报错） */
function selectedApprovals(): Approval[] {
  if (!lastApprovals.length) throw new Error('请先查询授权（并且有可撤销的项）')
  const list = lastApprovals.filter((_, i) => approvalChecks[i]?.checked)
  if (!list.length) throw new Error('请勾选要撤销的授权')
  return list
}

const revokeLabel = (list: Approval[]) => list.map((a) => (a.type === 'nft' ? `NFT ${addr(a.collection).textContent}` : `${a.symbol ?? addr(a.token).textContent} → ${a.spenderName ?? addr(a.spender).textContent}`)).join('；')

bind('runRevokeBuild', 'revoke', async () => {
  const txs = buildRevokes(selectedApprovals(), settings.chain)
  return {
    data: txs,
    view: table(
      ['#', '交易', '发给', '撤销的授权'],
      txs.map((tx, i) => [i + 1, tx.kind, addr(tx.to), revokeLabel(tx.approvals)]),
    ),
  }
})

bind('runRevokeSend', 'revoke', async () => {
  // 发送中不能切链（钱包网络按发送时的链）
  const chainId = settings.chain
  chainSelect.disabled = true
  try {
    const list = selectedApprovals()
    const { signer, address } = await walletSigner(chainId)
    if (approvalsOwner && !sameAddress(address, approvalsOwner)) {
      throw new Error(`授权是 ${approvalsOwner} 给出的，钱包是 ${address}：换成这个账户，或用钱包地址重新查询授权`)
    }
    const progress = $('revokeStats')
    const results: RevokeResult[] = await revokeApprovals(liquidityProvider(), signer, list, {
      onUpdate: (r) => (progress.textContent = `第 ${r.index + 1} 笔：${r.status}`),
    })
    const meta = chainMeta(chainId)
    const view = document.createElement('div')
    const note = document.createElement('p')
    note.className = 'hint'
    note.textContent = '撤销已发送，可以重新查询授权确认。'
    view.append(
      note,
      table(
        ['#', '交易', '撤销的授权', '状态', '交易哈希'],
        results.map((r, i) => [i + 1, r.kind, revokeLabel(r.approvals), statusTag(r.status, r.error), r.hash ? link(r.hash, meta.explorer) : null]),
      ),
    )
    return { data: results, view }
  } finally {
    chainSelect.disabled = false
  }
})

// ---- 域名 ----

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

function nameService() {
  const service = NAME_SERVICES.find((s) => s.chainId === settings.chain)
  if (!service) throw new Error(`这条链没有内置的域名服务（支持：${NAME_SERVICES.map((s) => `${s.name}（链 ${s.chainId}）`).join('、')}）`)
  return service
}

const serviceName = (id: string | null) => (id === null ? null : (NAME_SERVICES.find((s) => s.id === id)?.name ?? id))

bind('runNames', 'names', async () => {
  nameService()
  const names = lines(ex.nameList.value)
  if (!names.length) throw new Error('请填写要解析的域名')
  const list = await getNameAddresses(names, nodeOptions())
  return {
    data: list,
    view: table(
      ['名字', '规范化', '地址', '服务'],
      list.map((r) => [r.name, r.normalized ?? tag('名字不合法', 'bad'), r.address ? addr(r.address) : tag('未解析', 'bad'), serviceName(r.service) ?? tag('没有服务认这个后缀', 'bad')]),
    ),
  }
})

bind('runAddressNames', 'names', async () => {
  nameService()
  const input = lines(ex.nameAddresses.value)
  const addresses = input.length ? input : [owner()]
  const bad = addresses.find((a) => !ADDRESS.test(a))
  if (bad) throw new Error(`地址格式不对：${bad}`)
  const list = await getAddressNames(addresses, nodeOptions())
  return {
    data: list,
    view: table(
      ['地址', '名字', '服务'],
      list.map((r) => [addr(r.address), r.name ?? tag('没有主名字', 'bad'), serviceName(r.service)]),
    ),
  }
})

// ---- 手续费 ----

const gwei = (wei: string) => `${amount(formatUnits(wei, 'gwei'))} gwei`

function levelRow(level: string, e: FeeLevelEstimate): Cell[] {
  return 'gasPrice' in e ? [level, null, null, gwei(e.gasPrice)] : [level, gwei(e.maxFeePerGas), gwei(e.maxPriorityFeePerGas), null]
}

bind('runFees', 'fees', async () => {
  if (isTron()) throw new Error('Tron 没有 EIP-1559 费用建议：用“估算这笔交易”（按能量 / 带宽算要烧的 TRX）')
  const fees = await getFeeEstimate(nodeOptions())
  const wrap = document.createElement('div')
  const info = document.createElement('p')
  info.textContent = `${fees.type === 'eip1559' ? 'EIP-1559' : 'legacy（gasPrice）'}${fees.baseFee === null ? '' : ` · 下一个区块的 baseFee ${gwei(fees.baseFee)}`}`
  wrap.append(
    info,
    table(
      ['档位', 'maxFeePerGas', '优先费', 'gasPrice'],
      [levelRow('slow', fees.slow), levelRow('normal', fees.normal), levelRow('fast', fees.fast)],
      [1, 2, 3],
    ),
  )
  return { data: fees, view: wrap }
})

function costView(cost: CostEstimate): Node {
  if (cost.type === 'tron') {
    const trx = (sun: string) => `${amount(formatUnits(sun, 6))} TRX`
    return keyValues([
      ['能量', cost.energy],
      ['带宽', cost.bandwidth],
      ['要烧的能量', trx(cost.energyBurn)],
      ['要烧的带宽', trx(cost.bandwidthBurn)],
      ['激活接收地址', cost.activates ? '是（激活费算在带宽里）' : null],
      ['合计', `${amount(cost.totalFormatted)} TRX`],
    ])
  }
  const native = (wei: string) => `${amount(formatUnits(wei, 18))} ${cost.symbol ?? ''}`
  return keyValues([
    ['gasLimit', cost.gasLimit],
    ['每 gas 价格', gwei(cost.gasPrice)],
    ['手续费', native(cost.fee)],
    ['最多付', native(cost.maxFee)],
    ['L1 数据费', cost.l1Fee === '0' ? null : native(cost.l1Fee)],
    ['合计', `${amount(cost.totalFormatted)} ${cost.symbol ?? ''}`],
  ])
}

bind('runCost', 'fees', async () => {
  const from = owner()
  const to = text(ex.feeTo) ?? from
  const data = text(ex.feeData)
  if (data !== undefined && !/^0x([0-9a-fA-F]{2})*$/.test(data)) throw new Error('data 要是 0x 开头的十六进制')
  const valueText = text(ex.feeValue)
  let value: bigint | undefined
  if (valueText !== undefined) {
    try {
      value = parseUnits(valueText, chainMeta(settings.chain).decimals)
    } catch {
      throw new Error(`value 不是数字：${valueText}`)
    }
  }
  const cost = await getCostEstimate({ from, to, ...(data === undefined ? {} : { data }), ...(value === undefined ? {} : { value }) }, { ...nodeOptions(), level: ex.feeLevel.value as FeeLevel })
  return { data: cost, view: costView(cost) }
})

// ---- 兑换 ----

/** 表单 → 兑换参数和选项（连接钱包之前先检查表单） */
function swapRequest() {
  if (!ex.swapTokenIn.value.trim()) throw new Error('请填写要卖出的代币（主币填 native）')
  if (!ex.swapTokenOut.value.trim()) throw new Error('请填写要买入的代币')
  const tokenIn = tokenOf(ex.swapTokenIn)
  const tokenOut = tokenOf(ex.swapTokenOut)
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) throw new Error('卖出和买入不能是同一个代币')
  const amountIn = ex.swapAmount.value.trim()
  if (!/^\d+(\.\d+)?$/.test(amountIn) || !(Number(amountIn) > 0)) throw new Error('数量要填大于 0 的数字（如 0.01）')
  const slippage = numberOf(ex.swapSlippage, '滑点')
  if (slippage !== undefined && !(slippage >= 0 && slippage < 100)) throw new Error('滑点要在 0 ~ 100% 之间')
  const tax = numberOf(ex.swapTax, '转账税')
  // “无限额度”只对普通授权有效；permit 签的是精确数量，两者不能同时选
  if (ex.swapApproveMax.checked && ex.swapApprove.value) throw new Error('“授权无限额度”只适用于普通授权：和 permit 授权方式不能同时选')
  if (tax !== undefined && !(tax >= 0 && tax < 100)) throw new Error('转账税要在 0 ~ 100% 之间')
  return {
    params: { tokenIn, tokenOut, amountInFormatted: amountIn },
    options: {
      ...(slippage === undefined ? {} : { slippage: slippage / 100 }),
      ...(tax === undefined ? {} : { tax: tax / 100 }),
      ...(ex.swapApproveMax.checked ? { approve: 'max' as const } : {}),
      ...(ex.swapApprove.value ? { approve: ex.swapApprove.value as 'auto' | 'permit' | 'permit2' } : {}),
    },
    mode: ex.swapMode.value as 'tx' | '5792',
  }
}

function swapView(plan: SwapPlan, chainId: number, taxed: boolean, results?: SwapTxResult[]): Node {
  const meta = chainMeta(chainId)
  const nativeAmount = (value: string) => `${amount(formatUnits(value, meta.decimals))} ${meta.symbol}`
  const sIn = plan.tokenIn.symbol ?? 'tokenIn'
  const sOut = plan.tokenOut.symbol ?? 'tokenOut'
  const short = (a: string) => addr(a).textContent ?? a
  const taxNote = taxed ? '（不含转账税）' : ''
  const wrap = document.createElement('div')
  wrap.append(
    keyValues([
      ['卖出', `${amount(plan.amountInFormatted)} ${sIn}`],
      ['预计收到', `${amount(plan.amountOutFormatted)} ${sOut}${taxNote}`],
      ['最少收到', `${amount(plan.amountOutMinFormatted)} ${sOut}`],
      ['价格', plan.price === null ? null : `1 ${sIn} = ${price(plan.price)} ${sOut}`],
      ['价格影响', percentText(plan.priceImpact)],
      ['路线', `${plan.route.protocolName}（${plan.route.version.toUpperCase()}）· ${plan.route.path.map(short).join(' → ')}${plan.route.fees.length ? ` · 费率 ${plan.route.fees.join(' / ')}` : ''}`],
    ]),
    table(
      ['候选路线', '版本', '路径', '报价'],
      plan.routes.map((r) => [r.protocolName, r.version.toUpperCase(), r.path.map(short).join(' → '), `${units(r.amountOut, plan.tokenOut.decimals)} ${sOut}`]),
      [3],
    ),
    table(
      ['#', '交易', '发给', `附带 ${meta.symbol}`, '授权', ...(results ? ['状态', '交易哈希'] : [])],
      plan.transactions.map((tx, i) => {
        const r = results?.[i]
        return [
          i + 1,
          tx.kind,
          addr(tx.to),
          tx.value === '0' ? null : nativeAmount(tx.value),
          tx.token ? `${short(tx.token)} → ${short(tx.spender ?? '')}` : null,
          ...(results ? [r ? statusTag(r.status, r.error) : '等待', r?.hash ? link(r.hash, meta.explorer) : null] : []),
        ]
      }),
    ),
  )
  return wrap
}

bind('runSwapQuote', 'swap', async () => {
  const chainId = settings.chain
  const { params, options } = swapRequest()
  const from = connection()?.address ?? owner()
  const plan = await getSwapQuote(from, params, { ...nodeOptions(), ...options })
  return { data: plan, view: swapView(plan, chainId, options.tax !== undefined && options.tax > 0) }
})

bind('runSwapSend', 'swap', async () => {
  // 发送中不能切链（结果、钱包网络都按发送时的链）
  const chainId = settings.chain
  chainSelect.disabled = true
  try {
    const { params, options, mode } = swapRequest()
    const { signer } = await walletSigner(chainId)
    const progress = $('swapStats')
    const result: SwapResult = await swap(liquidityProvider(), signer, params, {
      ...options,
      mode,
      onUpdate: (r) => (progress.textContent = `第 ${r.index + 1} 笔（${r.kind}）：${r.status}`),
    })
    const view = document.createElement('div')
    const note = document.createElement('p')
    note.className = 'hint'
    note.textContent = `结果：${result.status}${result.approval ? `；授权方式：${result.approval.method}${result.approval.via ? `（${result.approval.via}）` : ''}${result.approval.reason ? `，${result.approval.reason}` : ''}` : ''}`
    view.append(note, swapView(result.plan, chainId, options.tax !== undefined && options.tax > 0, result.results))
    return { data: result, view }
  } finally {
    chainSelect.disabled = false
  }
})

// ---- 智能账户 / EIP-5792（只读） ----

bind('runSmart', 'smart', async () => {
  const chainId = settings.chain
  if (isTron(chainId)) throw new Error('Tron 不支持智能账户')
  const address = owner()
  const provider = liquidityProvider()
  const url = $<HTMLInputElement>('smartBundler').value.trim()
  const c = connection()
  // 几个查询互不依赖：并发发出
  const [v07, v08, entryPoints, capabilities] = await Promise.all([
    getSimpleAccount(provider, address, { entryPoint: '0.7' }),
    getSimpleAccount(provider, address, { entryPoint: '0.8' }),
    url ? new BundlerClient(url).supportedEntryPoints() : undefined,
    c ? getWalletCapabilities(c.provider as never, c.address, chainId) : undefined,
  ])
  const out: Record<string, unknown> = { owner: address, simpleAccountV07: v07, simpleAccountV08: v08 }
  if (url) out.bundlerEntryPoints = entryPoints
  if (c) out.walletCapabilities = capabilities ?? '钱包不支持 EIP-5792（wallet_getCapabilities）'
  const note = document.createElement('p')
  note.className = 'hint'
  note.textContent = '4337 的 SimpleAccount 地址（部署前即可算出）；bundler 支持的 EntryPoint；已连接钱包的 EIP-5792 能力。'
  return { data: out, view: note }
})

// ---- 代币风险 ----

const ZERO_OWNER = /^0x0+$/

function riskFlags(flags: string[]): Node {
  const span = document.createElement('span')
  if (!flags.length) return tag('无', 'ok')
  for (const f of flags) {
    span.append(tag(f, /^(honeypot|cannot-buy|high-)/.test(f) ? 'bad' : ''), ' ')
  }
  return span
}

function riskRow(r: TokenRisk): Cell[] {
  return [
    addr(r.token),
    r.stage === null ? tag('没有池子', 'bad') : tag(r.stage, r.stage === 'ok' ? 'ok' : 'bad'),
    r.honeypot === null ? null : r.honeypot ? tag('是', 'bad') : tag('否', 'ok'),
    percentText(r.buyTax),
    percentText(r.sellTax),
    percentText(r.transferTax),
    r.buyGas === null && r.sellGas === null ? null : `${r.buyGas ?? '—'} / ${r.sellGas ?? '—'}`,
    r.implementation ? addr(r.implementation) : '否',
    r.owner === null ? null : ZERO_OWNER.test(r.owner) ? tag('已放弃', 'ok') : addr(r.owner),
    riskFlags(r.flags),
  ]
}

bind('runRisk', 'risk', async () => {
  const tokens = tokenLines(ex.riskTokens.value)
  if (!tokens.length) throw new Error('请填写至少一个代币')
  if (tokens.includes(NATIVE_TOKEN)) throw new Error('主币不需要检查，请填代币合约地址')
  const list = await getTokenRisks(tokens, nodeOptions())
  return {
    data: list,
    view: table(['代币', '模拟到', '貔貅', '买入税', '卖出税', '转账税', 'gas 买 / 卖', '可升级代理', 'owner', '标记'], list.map(riskRow), [3, 4, 5]),
  }
})

// ---- 交易模拟（子路径 /simulate） ----

const WARN_KIND = { info: '', warn: '', danger: 'bad' } as const

function simView(sim: SimulationResult | BatchSimulationResult): Node {
  const wrap = document.createElement('div')
  const head = document.createElement('p')
  head.className = 'hint'
  const single = 'decoded' in sim ? sim : null
  head.append(tag(sim.success ? '成功' : '会失败', sim.success ? 'ok' : 'bad'), ` ${single ? single.decoded.summary : `${'results' in sim ? sim.results.length : 1} 笔交易`} · gas ${sim.gasUsed}${sim.fee ? ` · 手续费约 ${formatUnits(sim.fee, nativeInfo().decimals)} ${nativeInfo().symbol}` : ''} · ${sim.mode}`)
  if (single?.error) head.append(` · 原因：${single.error}`)
  if ('failedIndex' in sim && sim.failedIndex !== undefined) head.append(` · 第 ${sim.failedIndex + 1} 笔失败：${sim.results[sim.failedIndex]?.error ?? ''}`)
  wrap.append(head)
  wrap.append(
    table(
      ['地址', '资产', '变化', '美元'],
      sim.balanceChanges.map((c) => [addr(c.address), c.symbol ?? c.asset, c.formatted + (c.tokenId === undefined ? '' : ` #${c.tokenId}`), c.usd == null ? null : c.usd.toFixed(2)]),
      [2, 3],
    ),
  )
  if (sim.approvalChanges.length) {
    wrap.append(
      table(
        ['授权', '代币', '被授权方', '额度'],
        sim.approvalChanges.map((a) => [a.type, a.symbol ?? addr(a.token), a.spenderName ?? addr(a.spender), a.revoked ? tag('撤销', 'ok') : a.unlimited ? tag('无限', 'bad') : a.amount]),
      ),
    )
  }
  for (const w of sim.warnings) {
    const p = document.createElement('p')
    p.className = 'hint'
    p.append(tag(w.code, WARN_KIND[w.severity]), ` ${w.message}`)
    wrap.append(p)
  }
  return wrap
}

function nativeInfo(): { symbol: string; decimals: number } {
  const { symbol, decimals } = chainMeta(settings.chain)
  return { symbol, decimals }
}

const sim = {
  to: $<HTMLInputElement>('simTo'),
  data: $<HTMLInputElement>('simData'),
  value: $<HTMLInputElement>('simValue'),
  usd: $<HTMLInputElement>('simUsd'),
  risk: $<HTMLInputElement>('simRisk'),
}

bind('runSim', 'sim', async () => {
  const to = sim.to.value.trim()
  if (!to) throw new Error('请填写 to')
  const value = sim.value.value.trim()
  const result = await getSimulation(
    { to, ...(sim.data.value.trim() ? { data: sim.data.value.trim() } : {}), ...(value ? { value: BigInt(value) } : {}) },
    { ...nodeOptions(), from: connection()?.address ?? owner(), usd: sim.usd.checked, risk: sim.risk.checked },
  )
  return { data: result, view: simView(result) }
})

bind('runSimSwap', 'sim', async () => {
  const { params, options } = swapRequest()
  const from = connection()?.address ?? owner()
  const plan = await getSwapQuote(from, params, { ...nodeOptions(), ...options })
  const result = await getBatchSimulation(plan, { ...nodeOptions(), from, usd: sim.usd.checked, risk: sim.risk.checked })
  return { data: result, view: simView(result) }
})

// ---- 历史记录（子路径 /history） ----

let histCursor: string | undefined
/** 游标属于哪次查询（链、地址、来源、类型）：换了之后“下一页”不能接着用旧游标 */
let histFor = ''
const histKey = () => [settings.chain, owner(), hist.source.value, hist.type.value, hist.limit.value].join('|')
const hist = {
  source: $<HTMLSelectElement>('histSource'),
  type: $<HTMLSelectElement>('histType'),
  limit: $<HTMLInputElement>('histLimit'),
  key: $<HTMLInputElement>('histKey'),
}

function activityRow(a: Activity): Cell[] {
  const changes = document.createElement('span')
  for (const c of a.changes) {
    changes.append(tag(`${c.formatted} ${c.symbol ?? ''}${c.tokenId === undefined ? '' : ` #${c.tokenId}`}`, c.delta.startsWith('-') ? 'bad' : 'ok'), ' ')
  }
  return [new Date(a.time * 1000).toLocaleString(), a.status === 'failed' ? tag(`${a.type}（失败）`, 'bad') : a.type, a.label, changes, a.counterparty ? addr(a.counterparty) : null, a.fee ?? null]
}

async function runHistory(cursor?: string) {
  // 发请求前记下这次查询的条件：等待期间改了表单，游标也只属于发出去的那次查询
  const key = histKey()
  const types = hist.type.value ? [hist.type.value as Activity['type']] : undefined
  const page = await getHistory(owner(), {
    ...nodeOptions(),
    limit: Number(hist.limit.value) || 20,
    ...(hist.source.value ? { source: hist.source.value as 'blockscout' | 'etherscan' | 'rpc' } : {}),
    ...(hist.key.value.trim() ? { apiKey: hist.key.value.trim() } : {}),
    ...(types ? { types } : {}),
    ...(cursor ? { cursor } : {}),
  })
  histCursor = page.nextCursor
  histFor = key
  const view = document.createElement('div')
  const note = document.createElement('p')
  note.className = 'hint'
  note.textContent = `来源：${page.source}；${page.nextCursor ? '还有更早的记录，点“下一页”' : '没有更早的记录了'}`
  view.append(note, table(['时间', '类型', '描述', '资产变化', '对方', '手续费（最小单位）'], page.items.map(activityRow)))
  return { data: page, view }
}

bind('runHist', 'hist', () => runHistory())
bind('runHistMore', 'hist', () => {
  if (!histCursor) throw new Error('没有更多记录了：请先点“查询”')
  if (histFor !== histKey()) throw new Error('链、地址或筛选条件变了：请重新点“查询”')
  return runHistory(histCursor)
})

// ---- 领取奖励（子路径 /rewards） ----

const claim = {
  usd: $<HTMLInputElement>('claimUsd'),
  v4: $<HTMLInputElement>('claimV4'),
  v4Scan: $<HTMLInputElement>('claimV4Scan'),
  minUsd: $<HTMLInputElement>('claimMinUsd'),
  mode: $<HTMLSelectElement>('claimMode'),
}

/** 查询和构建共用的选项（节点另外传） */
function claimQuery() {
  const v4Ids = lines(claim.v4.value)
  const v4 = v4Options(v4Ids, claim.v4Scan.checked)
  return { prices: claim.usd.checked, ...(v4 ? { v4 } : {}) }
}
function claimOptions() {
  const minUsd = claim.minUsd.value.trim()
  return { ...claimQuery(), ...(minUsd ? { minUsd: Number(minUsd) } : {}) }
}

function claimRow(i: ClaimItem): Cell[] {
  const amounts = document.createElement('span')
  for (const a of i.amounts) if (a.amount !== '0') amounts.append(tag(`${a.formatted ?? a.amount} ${a.token.symbol ?? ''}`, ''), ' ')
  return [i.protocolName, i.kind === 'fees' ? '手续费' : i.kind === 'farm' ? '农场奖励' : 'gauge 奖励', `#${i.tokenId}${i.staked ? '（已质押）' : ''}`, amounts, i.usd == null ? null : i.usd.toFixed(2)]
}

function claimView(items: ClaimItem[], usd: number | null | undefined, plan?: ClaimPlan): HTMLElement {
  const view = document.createElement('div')
  const note = document.createElement('p')
  note.className = 'hint'
  note.textContent = `${items.length} 项${usd == null ? '' : `，合计约 $${usd.toFixed(2)}`}${plan ? ` · ${plan.transactions.length} 笔交易${plan.skipped.length ? ` · 跳过 ${plan.skipped.length} 项` : ''}` : ''}`
  view.append(note, table(['协议', '类型', '仓位', '数量', '美元'], items.map(claimRow), [4]))
  if (plan?.skipped.length) view.append(table(['跳过的仓位', '原因'], plan.skipped.map((s) => [`${s.item.protocolName} #${s.item.tokenId}`, s.reason])))
  return view
}

bind('runClaim', 'claim', async () => {
  const c = await getClaimable(owner(), { ...nodeOptions(), ...claimQuery() })
  const view = claimView(c.items, c.usd)
  for (const e of c.errors) {
    const p = document.createElement('p')
    p.className = 'hint'
    p.append(tag(e.source, 'bad'), ` ${e.error}`)
    view.append(p)
  }
  return { data: c, view }
})

bind('runClaimPlan', 'claim', async () => {
  const plan = await buildClaimAll(liquidityProvider(), connection()?.address ?? owner(), claimOptions())
  return { data: plan, view: claimView(plan.items, plan.usd, plan) }
})

bind('runClaimSend', 'claim', async () => {
  if (isTron(settings.chain)) throw new Error('领取全部暂只支持 EVM 链')
  // 连接 / 切链 / 核对钱包确实切过去了，同其他发送
  const { signer } = await walletSigner(settings.chain)
  const mode = claim.mode.value as 'tx' | '7702' | '5792'
  const result = await claimAll(liquidityProvider(), signer, { ...claimOptions(), ...(mode === 'tx' ? {} : { mode }) })
  const view = claimView(result.plan.items, result.plan.usd, result.plan)
  const note = document.createElement('p')
  note.className = 'hint'
  note.textContent = `结果：${result.status} · 已领取 ${result.claimed.length} 项，未成功 ${result.failed.length} 项`
  view.prepend(note)
  return { data: result, view }
})

// ---- Flap 分红（子路径 /dividends） ----

const div = { tokens: $<HTMLInputElement>('divTokens'), discover: $<HTMLInputElement>('divDiscover'), mode: $<HTMLSelectElement>('divMode') }
let divItems: DividendItem[] = []

async function runDividends() {
  if (settings.chain !== 56) throw new Error('Flap 分红只支持 BSC：请先把链切到 BSC')
  const tokens = lines(div.tokens.value)
  const result = await getDividends(owner(), { ...nodeOptions(), chainId: 56, tokens, ...(div.discover.checked ? { discover: true } : {}) })
  divItems = result.items
  const view = document.createElement('div')
  const note = document.createElement('p')
  note.className = 'hint'
  note.textContent = `${result.items.length} 个代币有可领取的分红${result.unsupported.length ? `；${result.unsupported.length} 个识别不了（${result.unsupported[0]?.reason}）` : ''}${result.priceError ? `；价格服务出错：${result.priceError}` : ''}`
  view.append(
    note,
    table(
      ['代币', '余额', '可领取', '已领取', '价值', '继续累计'],
      result.items.map((i) => [addr(i.token), `${formatUnits(i.balance, i.decimals)} ${i.symbol ?? ''}`, `${i.claimableFormatted} ${i.assetSymbol ?? ''}`, `${i.claimedFormatted} ${i.assetSymbol ?? ''}`, i.usd === null ? '—' : `$${i.usd.toFixed(4)}`, i.accruing ? '是' : '否']),
    ),
  )
  return { data: result, view }
}
bind('runDiv', 'div', runDividends)
bind('runDivClaim', 'div', async () => {
  // 构建和模拟走 liquidityProvider()（跟随页面的链）：链不是 BSC 时之前查到的分红也不再适用
  if (settings.chain !== 56) throw new Error('Flap 分红只支持 BSC：请先把链切到 BSC，再重新查询')
  if (!divItems.length) throw new Error('没有可领取的分红：请先点“查询”')
  const { signer } = await walletSigner(56)
  const mode = div.mode.value as 'tx' | '7702' | '5792'
  const results = await claimDividends(liquidityProvider(), signer, divItems, { simulate: true, ...(mode === 'tx' ? {} : { mode }) })
  const view = table(
    ['代币', '状态', '交易', '错误'],
    results.map((r) => [addr(r.item.token), statusTag(r.status, r.error), r.hash ? link(r.hash, null) : null, r.error ?? null]),
  )
  return { data: results, view }
})

// ---- 批量转账（子路径 /write） ----

const bt = { recipients: $<HTMLTextAreaElement>('btRecipients'), token: $<HTMLInputElement>('btToken'), mode: $<HTMLSelectElement>('btMode'), dry: $<HTMLInputElement>('btDry') }

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
  if (rows.length > 500) throw new Error('demo 一次最多 500 个收款人')
  const chainId = settings.chain
  const dryRun = bt.dry.checked
  const token = bt.token.value.trim()
  // 发送中不能切链（钱包网络按发送时的链）
  chainSelect.disabled = true
  try {
    const { signer, address } = await walletSigner(chainId)
    if (!dryRun && !confirm(`用 ${address} 向 ${rows.length} 个地址转${token ? `代币 ${token}` : '主币'}，确认发送？`)) throw new Error('已取消')
    const progress = $('btStats')
    const results = await batchTransfer(liquidityProvider(), signer, rows, {
      ...(token ? { token } : {}),
      mode: isTron(chainId) ? 'tx' : (bt.mode.value as 'disperse' | 'tx' | '5792'),
      dryRun,
      onUpdate: (r) => (progress.textContent = `第 ${r.index + 1} 项：${r.status}`),
    })
    const meta = chainMeta(chainId)
    return {
      data: results,
      view: table(
        ['#', '收款', '数量', '方式', '状态', '交易哈希'],
        results.map((r, i) => [i + 1, addr(r.to), r.formatted ?? r.amount, r.via, statusTag(r.status, r.error), r.hash ? link(r.hash, meta.explorer) : null]),
        [2],
      ),
    }
  } finally {
    chainSelect.disabled = false
  }
})

// ---- 免 gas 授权（子路径 /permit） ----

const pm = { token: $<HTMLInputElement>('pmToken'), spender: $<HTMLInputElement>('pmSpender'), amount: $<HTMLInputElement>('pmAmount') }

bind('runPmDetect', 'pm', async () => {
  if (isTron(settings.chain)) throw new Error('permit 只支持 EVM 链')
  const token = pm.token.value.trim()
  if (!ADDRESS.test(token)) throw new Error('请填代币地址（0x…）')
  const support = await detectPermit(liquidityProvider(), token)
  return {
    data: support,
    view: keyValues([
      ['支持', tag(support.kind ? support.kind : '不支持', support.kind ? 'ok' : 'bad')],
      ['原因', support.reason ?? null],
      ['domain', support.domain ? `${support.domain.name ?? ''} v${support.domain.version ?? ''}` : null],
    ]),
  }
})

bind('runPmSign', 'pm', async () => {
  if (isTron(settings.chain)) throw new Error('permit 只支持 EVM 链')
  const token = pm.token.value.trim()
  const spender = pm.spender.value.trim()
  if (!ADDRESS.test(token) || !ADDRESS.test(spender)) throw new Error('请填代币和 spender 地址（0x…）')
  if (!pm.amount.value.trim()) throw new Error('请填授权数量')
  const chainId = settings.chain
  const [info] = await getTokens([token], { ...nodeOptions(), fields: ['symbol', 'decimals'] })
  if (!info?.success || info.decimals === null || info.decimals === undefined) throw new Error('读不到代币精度，检查代币地址和链')
  const { signer, address } = await walletSigner(chainId)
  const permit = await buildPermit(liquidityProvider(), { token, owner: address, spender, value: parseUnits(pm.amount.value.trim(), info.decimals) })
  const signed = await signPermit(signer as Parameters<typeof signPermit>[0], permit, { chainId })
  const calldata = permitCalldata(signed)
  return {
    data: { permit, signature: signed.signature, calldata },
    view: keyValues([
      ['授权', `${address} → ${spender}`],
      ['额度', `${pm.amount.value.trim()} ${info.symbol ?? ''}`],
      ['有效期至', new Date(permit.deadline * 1000).toLocaleString()],
      ['签名', signed.signature],
      ['calldata', `${calldata.slice(0, 66)}…（${(calldata.length - 2) / 2} 字节）`],
    ]),
  }
})

// 初始化放在最后：applyChain 会用到上面定义的钱包和各区块的表单
applyChain()
applyAction()

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
