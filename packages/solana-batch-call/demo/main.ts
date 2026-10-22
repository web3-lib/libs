import { mountShell } from '../../demo-shared/shell'
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
  SolanaClient,
  formatUnits,
  onRequest,
  type NftDetails,
  type RequestEvent,
} from '@w3lib/solana-batch-call'
import {
  buildCloses,
  buildRevokes,
  closeTokenAccounts,
  getApprovals,
  revokeApprovals,
  type ApprovalCall,
  type TokenAccountApproval,
} from '@w3lib/solana-batch-call/approvals'
import { buildClaimAll, claimAll, getClaimable, simulateClaim, type Claimable } from '@w3lib/solana-batch-call/claim'
import { buildReclaim, getReclaimable, reclaim, simulateReclaim, type Reclaimable } from '@w3lib/solana-batch-call/reclaim'
import { getFeeEstimate, getCostEstimate } from '@w3lib/solana-batch-call/fees'
import {
  addLiquidity,
  buildAddLiquidity,
  buildCollectFees,
  buildRemoveLiquidity,
  collectFees,
  removeLiquidity,
  type SolanaAddLiquidityParams,
  type SolanaLiquidityOptions,
  type SolanaLiquidityPlan,
  type SolanaLiquidityResult,
  type SolanaLiquidityStepResult,
  type SolanaRemoveLiquidityParams,
} from '@w3lib/solana-batch-call/liquidity'
import { SOLANA_LP_PROTOCOLS, getLpPositions, type SolanaLpPosition, type SolanaLpProtocol } from '@w3lib/solana-batch-call/lp'
import { getAddressNames, getNameAddresses } from '@w3lib/solana-batch-call/names'
import { getPortfolio, getTokenPrices } from '@w3lib/solana-batch-call/price'
import { getTokenRisks, getTradeChecks, type SolanaTokenRisk } from '@w3lib/solana-batch-call/risk'
import { getHistory, type Activity } from '@w3lib/solana-batch-call/history'
import { getSimulation } from '@w3lib/solana-batch-call/simulate'
import { getSwapQuote, swap, type SolanaSwapParams, type SolanaSwapPlan, type SolanaSwapResult, type SolanaSwapStepResult } from '@w3lib/solana-batch-call/swap'
import { batchTransfer, systemTransfer } from '@w3lib/solana-batch-call/write'
import { createWallet } from '@w3lib/wallet'
import { solana } from '@w3lib/wallet/solana'
import { createWalletModal } from '@w3lib/wallet/ui'

// 外壳：侧边分组导航 + 设置 / 连接面板（见 packages/demo-shared/shell.ts）
mountShell()

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
  if (!settings.rpc) throw new Error('这个查询需要支持 getTokenAccountsByOwner 等索引方法的节点：请在右上角“节点设置”里填自己的 RPC URL（内置公共节点不支持）')
  return nodeOptions()
}

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

/** LP 查询（“LP 仓位”页的按钮和“加载我的仓位”共用） */
async function queryLp() {
  const mints = lines($<HTMLTextAreaElement>('lpMints').value)
  const pools = lines($<HTMLTextAreaElement>('lpPools').value)
  // 不指定 mints 时要扫描全部代币账户：内置公共节点不支持
  const node = mints.length ? nodeOptions() : indexedNode()
  const prices = $<HTMLInputElement>('lpPrices').checked
  let priceError: unknown = null
  const from = owner()
  const list = await getLpPositions(from, {
    ...node,
    ...(mints.length ? { mints } : {}),
    ...(pools.length ? { pools } : {}),
    prices,
    onPriceError: (err) => {
      priceError = err
    },
  })
  setPositions(list, from)
  const usd = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`)
  return {
    data: list,
    view: withPriceWarning(
      table(
        ['协议', '交易对', '数量', '未领取手续费', '区间 / 份额', '价值', '仓位'],
        list.map((p) => {
          const pair = pairOf(p)
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
}
bind('runLp', 'lp', queryLp)

const pairOf = (p: SolanaLpPosition) => `${p.token0.symbol ?? '?'} / ${p.token1.symbol ?? '?'}`

/** 价格按有效数字显示（如 meme 币对 SOL 的价格很小）；只去掉小数部分末尾的 0（150000 不能变成 15） */
function price(v: number | null): string {
  if (v === null) return '—'
  const [mantissa = '', exponent] = v.toPrecision(6).split('e')
  const trimmed = mantissa.includes('.') ? mantissa.replace(/\.?0+$/, '') : mantissa
  return exponent === undefined ? trimmed : `${trimmed}e${exponent}`
}

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

/** 各协议的示例池子（SOL / USDC；CPMM 是 Raydium 上的一个活跃池子） */
const SAMPLE_POOLS: Record<SolanaLpProtocol, string> = {
  'raydium-clmm': '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv',
  'orca-whirlpool': 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
  'raydium-amm': '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
  'raydium-cpmm': '47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4',
}

const liq = {
  action: $<HTMLSelectElement>('liqAction'),
  protocol: $<HTMLSelectElement>('liqProtocol'),
  pool: $<HTMLInputElement>('liqPool'),
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

// 钱包：Solana 的 Wallet Standard 钱包（Phantom、Solflare、Backpack…），连接弹窗用 @w3lib/wallet/ui
const wallet = createWallet({ connectors: [solana()] })
const modal = createWalletModal(wallet)
const connection = () => wallet.getConnection('solana')

function renderWallet() {
  const c = connection()
  // 连上钱包、地址栏还空着：填上钱包地址（查询默认查自己的钱包）
  if (c && !ownerInput.value.trim()) {
    ownerInput.value = c.address
    ownerInput.dispatchEvent(new Event('change'))
  }
  $('walletInfo').textContent = c ? `${c.walletName} · ${c.address}` : '未连接（只读查询不需要钱包）'
  $('connectWallet').textContent = c ? '切换 / 断开' : '连接钱包'
}
wallet.subscribe(() => renderWallet())
void wallet.ready.then(renderWallet)
$('connectWallet').addEventListener('click', () => void modal.open('solana'))

// 同一个节点复用客户端（自动合并请求）
let liqClient: { rpc: string; client: SolanaClient } | null = null
function liquidityClient(): SolanaClient {
  if (liqClient?.rpc !== settings.rpc) liqClient = { rpc: settings.rpc, client: new SolanaClient(settings.rpc || undefined) }
  return liqClient.client
}

/** 上一次“查询 LP”的结果：追加、移除、领取从里面选仓位 */
let lastPositions: SolanaLpPosition[] = []
/** 仓位是哪个地址的（查询“LP 仓位”时的地址）：追加、移除、领取要用这个地址 */
let positionsOwner = ''

function setPositions(list: SolanaLpPosition[], of: string) {
  lastPositions = list
  positionsOwner = of
  const options = list.map((p, i) => new Option(`${p.protocolName} · ${pairOf(p)} · ${p.type === 'amm' ? `份额 ${(p.share * 100).toPrecision(3)}%` : `仓位 ${p.positionMint.slice(0, 4)}…${p.positionMint.slice(-4)}`}`, String(i)))
  liq.position.replaceChildren(...(options.length ? options : [new Option('没有仓位：点右边“加载我的仓位”，或在“LP 仓位”页查询', '')]))
}

for (const [id, info] of Object.entries(SOLANA_LP_PROTOCOLS)) liq.protocol.append(new Option(`${info.name}（${info.type === 'clmm' ? '集中流动性' : 'AMM'}）`, id))

function applyProtocol() {
  const id = liq.protocol.value as SolanaLpProtocol
  liq.pool.value = SAMPLE_POOLS[id] ?? ''
  const clmm = SOLANA_LP_PROTOCOLS[id]?.type === 'clmm'
  liq.priceLower.disabled = liq.priceUpper.disabled = !clmm
}

function applyAction() {
  const action = liq.action.value
  $('liqNew').hidden = action !== 'new'
  $('liqExisting').hidden = action === 'new'
  $('liqAddAmounts').hidden = action !== 'add'
  $('liqRemoveOptions').hidden = action !== 'remove'
}

liq.protocol.addEventListener('change', applyProtocol)
liq.action.addEventListener('change', applyAction)
liq.amountA.value = '0.01'
setPositions([], '')
applyProtocol()
applyAction()

const text = (input: HTMLInputElement) => input.value.trim() || undefined

/**
 * 构建 / 发送用的地址：连了钱包用钱包地址（追加、移除、领取时要和仓位的地址一致）；
 * 没连钱包时，追加、移除、领取用仓位的地址，新建用“地址”栏的
 */
function liquidityFrom(walletAddress?: string): string {
  if (liq.action.value === 'new') return walletAddress ?? owner()
  if (walletAddress && positionsOwner && walletAddress !== positionsOwner) {
    throw new Error(`仓位是 ${positionsOwner} 的，钱包是 ${walletAddress}：换成仓位的账户，或用钱包地址重新查询 LP 仓位`)
  }
  return walletAddress ?? positionsOwner
}

function selectedPosition(): SolanaLpPosition {
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

function liquidityOptions(): SolanaLiquidityOptions {
  const percent = numberOf(liq.slippage, '滑点')
  if (percent !== undefined && !(percent >= 0 && percent < 100)) throw new Error('滑点要在 0 ~ 100% 之间')
  return { ...(percent === undefined ? {} : { slippage: percent / 100 }), native: liq.native.checked }
}

function addParams(): SolanaAddLiquidityParams {
  if (liq.action.value === 'add') return { position: selectedPosition(), amount0Formatted: text(liq.amount0), amount1Formatted: text(liq.amount1) }
  const protocol = liq.protocol.value as SolanaLpProtocol
  const pool = text(liq.pool)
  if (!pool) throw new Error('请填写池子地址')
  const lower = text(liq.priceLower)
  const upper = text(liq.priceUpper)
  const clmm = SOLANA_LP_PROTOCOLS[protocol].type === 'clmm'
  return {
    protocol,
    pool,
    ...(clmm ? (lower || upper ? { priceLower: lower, priceUpper: upper } : { fullRange: true }) : {}),
    amount0Formatted: text(liq.amountA),
    amount1Formatted: text(liq.amountB),
  }
}

function removeParams(): SolanaRemoveLiquidityParams {
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

/** 原始结果里不显示新仓位 NFT 的临时私钥 */
const withoutSecrets = (plan: SolanaLiquidityPlan) => ({ ...plan, signers: plan.signers.map((s) => ({ address: s.address, secretKey: '（不显示）' })) })

/** 按最小单位的数量按精度换算（显示用） */
function units(value: string | null, decimals: number | null): string {
  if (value === null) return '—'
  return decimals === null ? value : amount(formatUnits(BigInt(value), decimals))
}

function link(signature: string): Node {
  const a = document.createElement('a')
  a.href = `https://solscan.io/tx/${signature}`
  a.target = '_blank'
  a.rel = 'noopener'
  a.textContent = `${signature.slice(0, 10)}…`
  return a
}

const STEP_NAMES: Record<string, string> = { setup: '准备（代币账户 / tick 数组）', add: '添加', remove: '移除', collect: '领取' }

function planView(plan: SolanaLiquidityPlan, results?: SolanaLiquidityStepResult[]): Node {
  const s0 = plan.token0.symbol ?? 'token0'
  const s1 = plan.token1.symbol ?? 'token1'
  const both = (a: string | null, b: string | null) => `${units(a, plan.token0.decimals)} ${s0} + ${units(b, plan.token1.decimals)} ${s1}`
  const collect = plan.action === 'collect'
  const rows: Array<[string, string | null]> = [
    ['协议', plan.protocolName],
    ['交易对', `${s0} / ${s1}${plan.native ? `（${plan.native === 'token0' ? s0 : s1} 自动包装 / 解包）` : ''}`],
    ['当前价格', plan.price === null ? null : `1 ${s0} = ${price(plan.price)} ${s1}`],
    ['区间', plan.priceLower === null ? (plan.type === 'amm' ? '全区间（AMM）' : null) : `${price(plan.priceLower)} ~ ${price(plan.priceUpper)}（tick ${plan.tickLower} ~ ${plan.tickUpper}）`],
    [plan.action === 'add' ? '预计存入' : '预计取回', collect ? null : both(plan.amount0, plan.amount1)],
    ['上限', plan.amount0Max === null ? null : both(plan.amount0Max, plan.amount1Max)],
    ['下限', plan.amount0Min === null || collect ? null : both(plan.amount0Min, plan.amount1Min)],
    [collect ? '领取的手续费' : '一并领取的手续费', plan.fees0 === '0' && plan.fees1 === '0' && !collect ? null : both(plan.fees0, plan.fees1)],
    ['挖矿奖励', plan.rewardMints.length ? `${plan.rewardMints.length} 种（数量要等交易执行后才知道）` : null],
    [plan.type === 'amm' ? 'LP 数量' : '流动性', collect ? null : plan.liquidity],
    ['新仓位 NFT', plan.action === 'add' && plan.signers.length ? plan.positionMint : null],
  ]
  const wrap = document.createElement('div')
  wrap.append(
    table(
      ['项目', '值'],
      rows.filter(([, v]) => v !== null),
    ),
    table(
      ['#', '步骤', '指令数', ...(results ? ['状态', '交易签名'] : [])],
      plan.steps.map((step, i) => {
        const r = results?.[i]
        return [
          i + 1,
          STEP_NAMES[step.kind] ?? step.kind,
          step.instructions.length,
          ...(results ? [r ? tag(r.status + (r.error ? `：${r.error}` : ''), r.status === 'confirmed' ? 'ok' : r.status === 'failed' || r.status === 'reverted' ? 'bad' : '') : '等待', r?.signature ? link(r.signature) : null] : []),
        ]
      }),
    ),
  )
  return wrap
}

bind('runLiqBuild', 'liq', async () => {
  const { action, params, options } = liquidityRequest()
  const from = liquidityFrom(connection()?.address)
  const client = liquidityClient()
  const plan =
    action === 'add'
      ? await buildAddLiquidity(client, from, params, options)
      : action === 'remove'
        ? await buildRemoveLiquidity(client, from, params, options)
        : await buildCollectFees(client, from, params, options)
  return { data: withoutSecrets(plan), view: planView(plan) }
})

bind('runLiqSend', 'liq', async () => {
  const { action, params, options } = liquidityRequest()
  const c = connection() ?? (await modal.open('solana'))
  if (!c) throw new Error('没有连接钱包')
  liquidityFrom(c.address)
  // Wallet Standard 钱包直接当签名器，指定连接的账户（新仓位 NFT 的临时密钥由库一起签）
  const signer = { wallet: c.provider, account: c.address } as never
  const progress = $('liqStats')
  const sendOptions = { ...options, onUpdate: (r: SolanaLiquidityStepResult) => (progress.textContent = `第 ${r.index + 1} 步（${STEP_NAMES[r.kind] ?? r.kind}）：${r.status}`) }
  const client = liquidityClient()
  const result: SolanaLiquidityResult =
    action === 'add'
      ? await addLiquidity(client, signer, params, sendOptions)
      : action === 'remove'
        ? await removeLiquidity(client, signer, params, sendOptions)
        : await collectFees(client, signer, params, sendOptions)
  const view = document.createElement('div')
  const note = document.createElement('p')
  note.className = 'hint'
  note.textContent = `结果：${result.status}（可以在“LP 仓位”里重新查询）`
  view.append(note, planView(result.plan, result.results))
  return { data: { ...result, plan: withoutSecrets(result.plan) }, view }
})

// ---- 以下几个区块各自用子路径导入（/price /approvals /names /fees /swap /risk）；写操作和上面一样用浏览器钱包 ----

$<HTMLTextAreaElement>('priceMints').value = SAMPLE_MINTS.join('\n')
$<HTMLTextAreaElement>('apprMints').value = SAMPLE_MINTS.join('\n')
$<HTMLTextAreaElement>('nameList').value = ['bonfida.sns', 'toly.sns', 'bonfida.sol'].join('\n')
$<HTMLTextAreaElement>('feeAccounts').value = SAMPLE_POOLS['raydium-clmm']
$<HTMLTextAreaElement>('swapPools').value = SAMPLE_POOLS['raydium-amm']
$<HTMLTextAreaElement>('riskMints').value = SAMPLE_MINTS.join('\n')

/** 查询 / 报价 / 模拟用的地址：连了钱包用钱包地址，否则用“地址”栏的 */
const actingAddress = () => connection()?.address ?? owner()

/** 连接钱包（没连接时弹出连接窗口）；写操作用 */
async function walletForSend() {
  const c = connection() ?? (await modal.open('solana'))
  if (!c) throw new Error('没有连接钱包')
  // 钱包的网络要和所选节点的网络一致（Wallet Standard 的链标识，如 solana:mainnet）
  const cluster = /devnet/i.test(settings.rpc) ? 'devnet' : /testnet/i.test(settings.rpc) ? 'testnet' : 'mainnet'
  if (typeof c.chainId === 'string' && c.chainId !== `solana:${cluster}`) {
    throw new Error(`钱包在 ${c.chainId}，而所选节点是 ${cluster}：请在钱包里切到 ${cluster}，或换节点`)
  }
  return c
}

/** Wallet Standard 钱包直接当签名器，指定连接的账户 */
const walletSigner = (c: { provider: unknown; address: string }) => ({ wallet: c.provider, account: c.address }) as never

const usdText = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`)
/** 单价按有效数字显示（价格很小的代币） */
const usdPrice = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `$${price(v)}`)
const shorten = (v: string) => (v === NATIVE_MINT ? 'SOL' : v.length > 14 ? `${v.slice(0, 4)}…${v.slice(-4)}` : v)

/** 状态标签：confirmed 绿，failed / reverted 红，其他灰 */
const statusTag = (status: string, error?: string | null) => tag(status + (error ? `：${error}` : ''), status === 'confirmed' ? 'ok' : status === 'failed' || status === 'reverted' ? 'bad' : '')

function note(text: string, view: Node): Node {
  const wrap = document.createElement('div')
  const p = document.createElement('p')
  p.className = 'hint'
  p.textContent = text
  wrap.append(p, view)
  return wrap
}

// ---- 价格（子路径 /price） ----

bind('runPrices', 'prices', async () => {
  const mints = [...new Set([NATIVE_MINT, ...lines($<HTMLTextAreaElement>('priceMints').value)])]
  const list = await getTokenPrices(mints, nodeOptions())
  return {
    data: list,
    view: table(
      ['代币', '价格', '价格源', 'mint'],
      list.map((p) => [p.native ? 'SOL' : null, usdPrice(p.price), p.source ? tag(p.source, 'ok') : tag('没有价格', 'bad'), p.native ? 'SOL' : addr(p.token)]),
      [1],
    ),
  }
})

bind('runPortfolio', 'portfolio', async () => {
  const from = owner()
  const listed = $<HTMLInputElement>('portfolioListed').checked
  const withLp = $<HTMLInputElement>('portfolioLp').checked
  const lpMints = lines($<HTMLTextAreaElement>('lpMints').value)
  const lpPools = lines($<HTMLTextAreaElement>('lpPools').value)
  // 列全部持仓、扫描 LP 代币账户都要索引方法
  const node = !listed || (withLp && !lpMints.length) ? indexedNode() : nodeOptions()
  let priceError: unknown = null
  const p = await getPortfolio(from, {
    ...node,
    ...(listed ? { tokens: [...new Set([NATIVE_MINT, ...lines($<HTMLTextAreaElement>('priceMints').value)])] } : {}),
    ...(withLp ? { lp: lpMints.length ? { mints: lpMints, ...(lpPools.length ? { pools: lpPools } : {}) } : true } : {}),
    onPriceError: (err) => {
      priceError = err
    },
  })
  const wrap = document.createElement('div')
  wrap.append(
    table(
      ['合计', '代币', 'LP 仓位', '没有价格的'],
      [[usdText(p.totalUsd), usdText(p.tokensUsd), usdText(p.lpUsd), p.unpriced]],
      [0, 1, 2, 3],
    ),
    table(
      ['代币', '余额', '价格', '价值', '价格源', 'mint'],
      p.tokens.map((t) => [t.symbol, amount(t.formatted), usdPrice(t.price), usdText(t.value), t.priceSource, t.native ? 'SOL' : addr(t.token)]),
      [1, 2, 3],
    ),
  )
  if (p.lp.length) wrap.append(table(['LP 仓位', '价值'], p.lp.map((l) => [`${l.protocolName} · ${pairOf(l)}`, usdText(l.valueUsd)]), [1]))
  return { data: p, view: withPriceWarning(wrap, priceError) }
})

// ---- 授权管理（子路径 /approvals） ----

const appr = { action: $<HTMLSelectElement>('apprAction'), destination: $<HTMLInputElement>('apprDestination') }
appr.action.addEventListener('change', () => {
  $('apprDestinationRow').hidden = appr.action.value !== 'close'
})

/** 上一次“查询授权”的结果：撤销 / 关闭只处理这里面的账户 */
let lastApprovals: TokenAccountApproval[] = []

const CLOSE_BLOCKERS: Record<string, string> = { balance: '有余额', 'close-authority': '关闭权限是别人', 'confidential-balance': '机密余额不为 0' }

bind('runApprovals', 'appr', async () => {
  const mints = lines($<HTMLTextAreaElement>('apprMints').value)
  // 不指定 mints 时列出全部代币账户：内置公共节点不支持
  const node = mints.length ? nodeOptions() : indexedNode()
  lastApprovals = []
  const list = await getApprovals(owner(), { ...node, ...(mints.length ? { mints } : {}), all: $<HTMLInputElement>('apprAll').checked })
  lastApprovals = list
  return {
    data: list,
    view: table(
      ['代币', '账户', '余额', '授权给', '还能转走', '状态', '撤销', '关闭'],
      list.map((a) => {
        const flags = document.createElement('span')
        if (a.native) flags.append(tag('wSOL'))
        if (a.frozen) flags.append(tag('已冻结', 'bad'))
        if (a.permanentDelegate) flags.append(tag('永久授权（撤销不了）', 'bad'))
        if (a.closeAuthority && a.closeAuthority !== a.owner) flags.append(tag('关闭权限是别人', 'bad'))
        return [
          a.symbol ?? addr(a.mint),
          addr(a.account),
          amount(a.formatted),
          a.delegate ? addr(a.delegate) : null,
          a.delegate ? amount(a.delegatedFormatted) : null,
          flags,
          a.revocable ? tag('可撤销', 'ok') : '—',
          a.closable ? tag(a.amount === '0' ? '空账户，可关闭' : '可关闭', 'ok') : a.closeBlocker ? CLOSE_BLOCKERS[a.closeBlocker] ?? a.closeBlocker : '—',
        ]
      }),
      [2, 4],
    ),
  }
})

/** 这次要处理的账户：撤销 = 有 delegate 且没有冻结的；关闭 = 余额为 0 且能关闭的（有余额的 wSOL 也能关，但这里不动） */
function approvalTargets() {
  if (!lastApprovals.length) throw new Error('请先“查询授权”，撤销 / 关闭只处理最近一次查到的账户')
  const action = appr.action.value === 'close' ? ('close' as const) : ('revoke' as const)
  const list = action === 'revoke' ? lastApprovals.filter((a) => a.revocable) : lastApprovals.filter((a) => a.closable && a.amount === '0')
  if (!list.length) throw new Error(action === 'revoke' ? '查到的账户里没有可以撤销的授权' : '查到的账户里没有可以关闭的空账户')
  const destination = text(appr.destination)
  return { action, list, destination: action === 'close' ? destination : undefined }
}

const callsView = (calls: ApprovalCall[]) =>
  table(
    ['#', '操作', '账户', '代币', '指令数', '被授权方 / 租金退给'],
    calls.map((c, i) => [i + 1, c.kind === 'revoke' ? '撤销授权' : '关闭账户', addr(c.account), c.approval.symbol ?? addr(c.approval.mint), c.instructions.length, c.kind === 'revoke' ? addr(c.approval.delegate) : addr(text(appr.destination) ?? c.owner)]),
  )

bind('runApprBuild', 'appr', async () => {
  const { action, list, destination } = approvalTargets()
  const calls = action === 'revoke' ? buildRevokes(list) : buildCloses(list, { destination })
  // 原始结果里只放每条指令的程序和账户数，不放指令数据
  const data = calls.map(({ instructions, ...c }) => ({ ...c, instructions: instructions.map((ix) => ({ programId: ix.programId, accounts: ix.keys.length })) }))
  return { data, view: note('只构建、没有发送：下面是会发送的操作（每个账户一个调用，打包进同一笔交易）。', callsView(calls)) }
})

bind('runApprSend', 'appr', async () => {
  const { action, list, destination } = approvalTargets()
  if (destination !== undefined) buildCloses(list, { destination }) // 发送前先检查退租金的地址
  const c = await walletForSend()
  const wrong = list.find((a) => a.owner !== c.address)
  if (wrong) throw new Error(`账户 ${wrong.account} 是 ${wrong.owner} 的，钱包是 ${c.address}：换成这个账户，或用钱包地址重新查询授权`)
  const progress = $('apprStats')
  const options = { onUpdate: (r: { index: number; status: string }) => (progress.textContent = `第 ${r.index + 1} / ${list.length} 个：${r.status}`) }
  const client = liquidityClient()
  const results = action === 'revoke' ? await revokeApprovals(client, walletSigner(c), list, options) : await closeTokenAccounts(client, walletSigner(c), list, { ...options, destination })
  return {
    data: results,
    view: note(
      '已发送（可以重新“查询授权”确认）。',
      table(
        ['#', '操作', '账户', '状态', '交易签名'],
        results.map((r, i) => [i + 1, r.kind === 'revoke' ? '撤销授权' : '关闭账户', addr(r.account), statusTag(r.status, r.error), r.signature ? link(r.signature) : null]),
      ),
    ),
  }
})

// ---- 账户回收（子路径 /reclaim） ----

const solText = (lamports: string | bigint) => `${formatUnits(BigInt(lamports), 9)} SOL`
const RECLAIM_KINDS: Record<string, string> = {
  'empty-token': '空代币账户',
  'junk-token': '垃圾币（销毁后关闭）',
  'wrapped-sol': 'Wrapped SOL（解包）',
  'orca-position': 'Orca 空仓位',
  'raydium-position': 'Raydium 空仓位',
}
const BLOCKERS: Record<string, string> = { frozen: '已冻结', 'close-authority': '关闭权限是别人', 'confidential-balance': '机密余额不为 0', paused: '代币已暂停', 'permissioned-burn': '只有指定地址能销毁', owed: '还有没领的手续费 / 奖励（先领取）' }

/** 上一次扫描的结果：模拟 / 回收只处理其中建议勾选的项 */
let lastReclaim: Reclaimable | null = null

bind('runReclaim', 'reclaim', async () => {
  const mints = lines($<HTMLTextAreaElement>('reclaimMints').value)
  lastReclaim = null
  // 预览查“地址”栏（空着时用已连接钱包的地址）；回收时库会核对账户确实属于发送的钱包
  const r = await getReclaimable(owner(), { ...(mints.length ? { ...nodeOptions(), mints } : indexedNode()) })
  lastReclaim = r
  const rows = (list: Reclaimable['items'], blocked: boolean) =>
    list.map((i) => [
      RECLAIM_KINDS[i.kind] ?? i.kind,
      i.position ? addr(i.position.positionMint) : (i.symbol ?? addr(i.mint)),
      i.kind === 'empty-token' || i.position ? '—' : amount(i.formatted),
      solText(i.lamports),
      blocked ? tag(BLOCKERS[i.blocker ?? ''] ?? i.blocker ?? '', 'bad') : i.selected ? tag('建议回收', 'ok') : tag('仅列出'),
      i.reasons.join(', '),
    ])
  const head = ['类型', '账户 / 代币', '余额', '退回', '状态', '依据']
  const view = document.createElement('div')
  view.append(
    note(`能回收 ${solText(r.totalLamports)}（建议勾选的 ${solText(r.selectedLamports)}）${r.warnings.length ? `；${r.warnings.join('；')}` : ''}`, table(head, rows(r.items, false), [2, 3])),
  )
  if (r.blocked.length) view.append(note('暂时关不掉的', table(head, rows(r.blocked, true), [2, 3])))
  return { data: r, view }
})

/** 构建并模拟建议勾选的项；destination 用钱包地址（没连接时用“地址”栏） */
async function reclaimPlan() {
  if (!lastReclaim) throw new Error('请先“扫描”，模拟 / 回收只处理最近一次扫描里建议勾选的项')
  const items = lastReclaim.items.filter((i) => i.selected)
  if (!items.length) throw new Error('没有建议回收的项')
  return { items, plan: await buildReclaim(liquidityClient(), lastReclaim.owner, items) }
}

bind('runReclaimSim', 'reclaim', async () => {
  const { plan } = await reclaimPlan()
  const sim = await simulateReclaim(liquidityClient(), plan)
  const data = { lamports: sim.lamports, source: sim.lamportsSource, fee: sim.fee, transactions: sim.transactions.length, failed: sim.failed, skipped: plan.skipped.map((s) => ({ account: s.item.account, reason: s.reason })), warnings: plan.warnings }
  return { data, view: note(`${sim.success ? '模拟通过' : `有 ${sim.failed.length} 个账户会失败`}：预计退回 ${solText(sim.lamports)}（${sim.lamportsSource === 'simulation' ? '模拟的结果' : '按账户余额估算'}），${plan.calls.length} 个账户打包成 ${sim.transactions.length} 笔交易，手续费 ${solText(sim.fee)}`, table(['#', '账户', '原因'], sim.failed.map((f) => [f.index + 1, addr(plan.calls[f.index]?.account), f.error]))) }
})

bind('runReclaimSend', 'reclaim', async () => {
  const { items } = await reclaimPlan()
  const c = await walletForSend()
  if (c.address !== lastReclaim?.owner) throw new Error(`钱包是 ${c.address}，扫描的是 ${lastReclaim?.owner}：请用钱包地址重新扫描`)
  const done = await reclaim(liquidityClient(), walletSigner(c), items)
  return {
    data: done,
    view: note(
      `已发送：预计退回 ${solText(done.simulation?.lamports ?? done.plan.lamports)}`,
      table(['#', '类型', '账户', '状态', '交易签名'], done.results.map((r, i) => [i + 1, RECLAIM_KINDS[r.kind] ?? r.kind, addr(r.account), statusTag(r.status, r.error), r.signature ? link(r.signature) : null])),
    ),
  }
})

// ---- 批量领取（子路径 /claim） ----

let lastClaim: Claimable | null = null

bind('runClaim', 'claim', async () => {
  const mints = lines($<HTMLTextAreaElement>('lpMints').value)
  lastClaim = null
  const c = await getClaimable(owner(), { ...(mints.length ? { ...nodeOptions(), mints } : indexedNode()) })
  lastClaim = c
  const view = document.createElement('div')
  view.append(
    note(
      `共 ${c.positions.length} 个仓位有可领的，合计 ${usdText(c.totalUsd)}（手续费 ${usdText(c.feesUsd)}、奖励 ${usdText(c.rewardsUsd)}）${c.warnings.length ? `；${c.warnings.join('；')}` : ''}`,
      table(
        ['协议', '仓位', '手续费', '奖励', '价值'],
        c.positions.map((p) => [
          p.protocolName,
          addr(p.positionMint),
          p.fees.map((f) => `${amount(f.formatted)} ${f.symbol ?? ''}`).join(' + '),
          p.rewards.length ? p.rewards.map((r) => `${amount(r.formatted)} ${r.symbol ?? addr(r.mint)}`).join(' + ') : '—',
          usdText(p.totalUsd),
        ]),
        [4],
      ),
    ),
    note('按代币汇总', table(['代币', '数量', '价值'], c.tokens.map((t) => [t.symbol ?? addr(t.mint), amount(t.formatted), usdText(t.usd)]), [1, 2])),
  )
  return { data: c, view }
})

bind('runClaimSim', 'claim', async () => {
  if (!lastClaim?.positions.length) throw new Error('请先“预览”，模拟 / 领取处理最近一次预览出的全部仓位')
  const plan = await buildClaimAll(liquidityClient(), lastClaim.owner, lastClaim.positions)
  const sim = await simulateClaim(liquidityClient(), plan)
  return {
    data: { success: sim.success, fee: sim.fee, transactions: sim.transactions.length, failed: sim.failed, built: plan.failed, received: sim.received },
    view: note(
      `${sim.success ? '模拟通过' : `有 ${sim.failed.length + plan.failed.length} 个仓位会失败`}：${plan.calls.length} 个仓位打包成 ${sim.transactions.length} 笔交易，手续费 ${solText(sim.fee)}`,
      table(['代币', '收到'], sim.received.map((r) => [r.symbol, amount(r.formatted)]), [1]),
    ),
  }
})

bind('runClaimSend', 'claim', async () => {
  if (!lastClaim?.positions.length) throw new Error('请先“预览”，模拟 / 领取处理最近一次预览出的全部仓位')
  const c = await walletForSend()
  if (c.address !== lastClaim.owner) throw new Error(`钱包是 ${c.address}，预览的是 ${lastClaim.owner}：请用钱包地址重新预览`)
  const done = await claimAll(liquidityClient(), walletSigner(c), lastClaim.positions)
  return {
    data: done,
    view: note('已发送', table(['#', '协议', '仓位', '状态', '交易签名'], done.results.map((r, i) => [i + 1, r.protocol, addr(r.positionMint), statusTag(r.status, r.error), r.signature ? link(r.signature) : null]))),
  }
})

// ---- 域名解析（子路径 /names） ----

bind('runNames', 'names', async () => {
  const names = lines($<HTMLTextAreaElement>('nameList').value)
  if (!names.length) throw new Error('请填写要解析的名字')
  const legacySol = $<HTMLInputElement>('nameLegacySol').checked
  const list = await getNameAddresses(names, { ...nodeOptions(), legacySol, allowPda: $<HTMLInputElement>('nameAllowPda').checked })
  const view = table(
    ['名字', '规范化', '地址', 'owner', '来源', '服务'],
    list.map((n) => [n.name, n.normalized, n.address ? addr(n.address) : tag('没有地址', 'bad'), addr(n.owner), n.source, n.service ?? tag('不归 SNS 解析', 'bad')]),
  )
  const skippedSol = !legacySol && list.some((n) => n.name.toLowerCase().endsWith('.sol') && n.service === null)
  return { data: list, view: skippedSol ? note('.sol 默认不解析（正在迁到另一个注册服务）：勾选“也解析 .sol”才会当作同名的 .sns 解析。', view) : view }
})

bind('runAddressNames', 'names', async () => {
  const list = await getAddressNames([owner()], nodeOptions())
  return {
    data: list,
    view: table(
      ['地址', '主域名', '服务'],
      list.map((n) => [addr(n.address), n.name ?? tag('没有设置主域名', 'bad'), n.service]),
    ),
  }
})

// ---- 手续费（子路径 /fees） ----

bind('runFees', 'fees', async () => {
  const accounts = lines($<HTMLTextAreaElement>('feeAccounts').value)
  const fees = await getFeeEstimate({ ...nodeOptions(), ...(accounts.length ? { accounts } : {}) })
  return {
    data: fees,
    view: note(
      `统计了最近 ${fees.slots} 个 slot 里${accounts.length ? '会写这些账户' : '全网'}的落块交易的最低单价，三档取第 50 / 75 / 90 百分位。`,
      table(
        ['档位', '单价（micro-lamports / 计算单元）'],
        [
          ['slow', fees.slow],
          ['normal', fees.normal],
          ['fast', fees.fast],
        ],
        [1],
      ),
    ),
  }
})

bind('runCost', 'fees', async () => {
  const from = owner()
  // 转给自己：只用来演示 getCostEstimate，模拟一次、不发送
  const cost = await getCostEstimate({ feePayer: from, instructions: [systemTransfer(from, from, 1000n)] }, nodeOptions())
  const rows: Array<[string, string]> = [
    ['计算单元（模拟消耗 / 上限）', `${cost.computeUnits} / ${cost.computeUnitLimit}`],
    ['优先费单价', `${cost.priorityFee} micro-lamports / 计算单元`],
    ['基础费（签名数）', `${cost.baseFee} lamports（${cost.signatures}）`],
    ['优先费', `${cost.priorityFeeLamports} lamports`],
    ['手续费', `${cost.fee} lamports`],
    ['新建账户的押金', `${cost.rent} lamports（${cost.createdAccounts.length} 个账户，关闭时退回）`],
    ['合计', `${cost.totalFormatted} ${cost.symbol}`],
  ]
  return { data: cost, view: table(['项目', '值'], rows) }
})

// ---- 兑换（子路径 /swap） ----

const sw = {
  tokenIn: $<HTMLInputElement>('swapIn'),
  tokenOut: $<HTMLInputElement>('swapOut'),
  amount: $<HTMLInputElement>('swapAmount'),
  pools: $<HTMLTextAreaElement>('swapPools'),
  slippage: $<HTMLInputElement>('swapSlippage'),
  native: $<HTMLInputElement>('swapNative'),
}
sw.tokenIn.value = NATIVE_MINT
sw.tokenOut.value = SAMPLE_MINTS[0] as string
sw.amount.value = '0.01'

/** 表单 → 参数和选项（连接钱包之前先检查表单） */
function swapRequest() {
  const tokenIn = text(sw.tokenIn)
  const tokenOut = text(sw.tokenOut)
  const amountIn = text(sw.amount)
  if (!tokenIn || !tokenOut) throw new Error('请填写卖出和买入的代币 mint（SOL 用 So11111111111111111111111111111111111111112）')
  if (tokenIn === tokenOut) throw new Error('卖出和买入不能是同一个代币')
  if (!amountIn || !/^\d+(\.\d+)?$/.test(amountIn) || !(Number(amountIn) > 0)) throw new Error(`数量要是大于 0 的数字：${amountIn ?? '（空）'}`)
  const percent = numberOf(sw.slippage, '滑点')
  if (percent !== undefined && !(percent >= 0 && percent < 100)) throw new Error('滑点要在 0 ~ 100% 之间')
  const pools = lines(sw.pools.value)
  const params: SolanaSwapParams = { tokenIn, tokenOut, amountInFormatted: amountIn }
  const options = { ...(percent === undefined ? {} : { slippage: percent / 100 }), native: sw.native.checked, ...(pools.length ? { pools } : {}) }
  return { params, options }
}

const SWAP_STEP_NAMES: Record<string, string> = { setup: '准备（创建代币账户）', swap: '兑换（包装 SOL / 兑换 / 解包）' }

/** 原始结果里只放每一步的指令数，不放指令数据 */
const plainSwapPlan = (plan: SolanaSwapPlan) => ({ ...plan, steps: plan.steps.map((s) => ({ kind: s.kind, instructions: s.instructions.length })) })

const routeKey = (r: SolanaSwapPlan['route']) => r.hops.map((h) => h.pool).join()

function swapView(plan: SolanaSwapPlan, results?: SolanaSwapStepResult[]): Node {
  const { tokenIn, tokenOut } = plan
  const sIn = tokenIn.symbol ?? 'tokenIn'
  const sOut = tokenOut.symbol ?? 'tokenOut'
  const out = (v: string | null) => (v === null ? '—' : `${units(v, tokenOut.decimals)} ${sOut}`)
  const rows: Array<[string, string | null]> = [
    ['卖出', `${amount(plan.amountInFormatted)} ${sIn}`],
    ['预计收到', out(plan.amountOut)],
    ['最少收到（按滑点）', out(plan.amountOutMin)],
    ['价格', plan.price === null ? null : `1 ${sIn} = ${price(plan.price)} ${sOut}`],
    ['价格影响', plan.priceImpact === null ? null : `${(plan.priceImpact * 100).toFixed(4)}%`],
    ['路线', plan.route.hops.map((h) => `${shorten(h.tokenIn)} → ${shorten(h.tokenOut)}（${h.protocolName} ${shorten(h.pool)}）`).join('，然后 ')],
    ['SOL 自动包装 / 解包', plan.native ? (plan.native === 'tokenIn' ? `卖出的 ${sIn}` : `买入的 ${sOut}`) : null],
    ['留在账户里的中间代币', plan.leftover ? `${plan.leftover.amount}（最小单位）${shorten(plan.leftover.mint)}` : null],
  ]
  const wrap = document.createElement('div')
  wrap.append(
    table(
      ['项目', '值'],
      rows.filter(([, v]) => v !== null),
    ),
    table(
      ['候选路线', '预计收到', '选中'],
      plan.routes.map((r) => [r.hops.map((h) => `${h.protocolName} ${shorten(h.pool)}`).join(' → '), out(r.amountOut), routeKey(r) === routeKey(plan.route) ? tag('选中', 'ok') : null]),
      [1],
    ),
  )
  if (plan.skipped.length) wrap.append(table(['没用上的池子', '协议', '原因'], plan.skipped.map((s) => [addr(s.pool), s.protocol, s.reason])))
  wrap.append(
    table(
      ['#', '步骤', '指令数', ...(results ? ['状态', '交易签名'] : [])],
      plan.steps.map((step, i) => {
        const r = results?.[i]
        return [i + 1, SWAP_STEP_NAMES[step.kind] ?? step.kind, step.instructions.length, ...(results ? [r ? statusTag(r.status, r.error) : '等待', r?.signature ? link(r.signature) : null] : [])]
      }),
    ),
  )
  return wrap
}

bind('runSwapQuote', 'swap', async () => {
  const { params, options } = swapRequest()
  const plan = await getSwapQuote(actingAddress(), params, { ...nodeOptions(), ...options })
  return { data: plainSwapPlan(plan), view: swapView(plan) }
})

bind('runSwapSend', 'swap', async () => {
  const { params, options } = swapRequest()
  const c = await walletForSend()
  const progress = $('swapStats')
  const result: SolanaSwapResult = await swap(liquidityClient(), walletSigner(c), params, {
    ...options,
    onUpdate: (r) => (progress.textContent = `第 ${r.index + 1} 步（${SWAP_STEP_NAMES[r.kind] ?? r.kind}）：${r.status}`),
  })
  return { data: { ...result, plan: plainSwapPlan(result.plan) }, view: note(`结果：${result.status}`, swapView(result.plan, result.results)) }
})

// ---- 代币风险（子路径 /risk） ----

function riskDetails(r: SolanaTokenRisk): string {
  const parts: string[] = []
  if (r.transferFee) parts.push(`转账手续费 ${r.transferFee.basisPoints / 100}%${r.transferFee.authority ? '（可改）' : ''}`)
  if (r.permanentDelegate) parts.push(`永久授权 ${shorten(r.permanentDelegate)}`)
  if (r.transferHook) parts.push(`转账 hook ${r.transferHook.program ? shorten(r.transferHook.program) : '（已取消）'}`)
  if (r.nonTransferable) parts.push('不可转让')
  if (r.defaultFrozen) parts.push('账户默认冻结')
  if (r.pausable) parts.push(r.pausable.paused ? '可暂停（已暂停）' : '可暂停')
  if (r.confidentialTransfer) parts.push('保密转账')
  if (r.mintCloseAuthority) parts.push(`mint 可关闭 ${shorten(r.mintCloseAuthority)}`)
  if (r.uiAmountAuthority) parts.push('显示数量会变化')
  if (r.burnAuthority) parts.push('只有指定地址能销毁')
  if (r.topHolders) parts.push(`前 10 个账户占 ${(r.topHolders.top10Share * 100).toFixed(1)}%`)
  return parts.join('；')
}

const authority = (value: string | null): Node => (value ? tag(shorten(value), 'bad') : tag('已放弃', 'ok'))

function flagTags(flags: string[]): Node {
  const span = document.createElement('span')
  if (!flags.length) span.append(tag('无标记', 'ok'))
  for (const f of flags) span.append(tag(f, 'bad'))
  return span
}

bind('runRisk', 'risk', async () => {
  const mints = lines($<HTMLTextAreaElement>('riskMints').value)
  if (!mints.length) throw new Error('请填写要检查的代币 mint')
  const list = await getTokenRisks(mints, { ...nodeOptions(), concentration: $<HTMLInputElement>('riskConcentration').checked })
  return {
    data: list,
    view: table(
      ['mint', '程序', '增发权限', '冻结权限', '风险标记', '详情'],
      list.map((r) => [addr(r.mint), r.exists ? r.program : tag('找不到 mint', 'bad'), r.exists ? authority(r.mintAuthority) : null, r.exists ? authority(r.freezeAuthority) : null, flagTags(r.flags), riskDetails(r)]),
    ),
  }
})

bind('runTrade', 'trade', async () => {
  const mints = lines($<HTMLTextAreaElement>('riskMints').value)
  if (!mints.length) throw new Error('请填写要检查的代币 mint')
  const amountFormatted = text($<HTMLInputElement>('tradeAmount'))
  if (!amountFormatted || !/^\d+(\.\d+)?$/.test(amountFormatted) || !(Number(amountFormatted) > 0)) throw new Error(`买入的 SOL 数量要是大于 0 的数字：${amountFormatted ?? '（空）'}`)
  const list = await getTradeChecks(mints, { ...nodeOptions(), owner: actingAddress(), amountFormatted })
  return {
    data: list,
    view: table(
      ['mint', '结果', '来回损失', '买入路线', '标记', '错误'],
      list.map((t) => [
        addr(t.mint),
        t.stage === null ? tag('没做成', 'bad') : tag(t.stage === 'ok' ? '能买能卖' : t.stage === 'sell-failed' ? '卖不出（貔貅）' : t.stage, t.stage === 'ok' ? 'ok' : 'bad'),
        t.roundTripLoss === null ? null : `${(t.roundTripLoss * 100).toFixed(2)}%`,
        t.buyRoute ? t.buyRoute.map((h) => `${h.protocol} ${shorten(h.pool)}`).join(' → ') : null,
        flagTags(t.flags),
        t.error,
      ]),
      [2],
    ),
  }
})

// ---- 交易模拟（子路径 /simulate） ----

bind('runSim', 'sim', async () => {
  const owner = actingAddress()
  const raw = $<HTMLTextAreaElement>('simTx').value.trim() || undefined
  const input = raw ?? (await getSwapQuote(owner, { tokenIn: NATIVE_MINT, tokenOut: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amountInFormatted: '0.1' }, nodeOptions()))
  const sim = await getSimulation(input, { ...nodeOptions(), owner, prices: true })
  return {
    data: { ...sim, logs: undefined },
    view: note(
      `${sim.success ? '成功' : `失败：${sim.error}`} · ${sim.decoded.summary} · 计算单元 ${sim.gasUsed} · 手续费 ${sim.fee} lamports`,
      table(
        ['类型', '资产', '变化', '美元'],
        [
          ...sim.balanceChanges.map((c) => ['余额', c.symbol, c.formatted, c.usd == null ? null : c.usd.toFixed(2)]),
          ...sim.approvalChanges.map((c) => [tag(c.kind, 'bad'), shorten(c.account), c.delegate ? shorten(c.delegate) : (c.authorityType ?? ''), null]),
          ...sim.warnings.map((w) => [tag(w.severity, w.severity === 'info' ? '' : 'bad'), w.code, w.message, null]),
        ],
        [2, 3],
      ),
    ),
  }
})

// ---- 交易历史（子路径 /history） ----

let historyCursor: string | undefined
/** 游标属于哪次查询（地址、类型、条数）：换了之后“下一页”不能接着用旧游标 */
let historyFor = ''
const historyKey = () => [owner(), $<HTMLSelectElement>('histType').value, $<HTMLInputElement>('histLimit').value].join('|')

function historyView(items: Activity[]): Node {
  return table(
    ['时间', '类型', '说明', '变化', '状态'],
    items.map((a) => [
      new Date(a.time * 1000).toLocaleString(),
      a.type,
      a.label ?? '',
      a.changes.map((c) => `${c.formatted} ${c.symbol}`).join(' / '),
      a.status === 'failed' ? tag('失败', 'bad') : tag('成功', 'ok'),
    ]),
  )
}

async function runHistory(cursor: string | undefined) {
  // 发请求前记下这次查询的条件：等待期间改了表单，游标也只属于发出去的那次查询
  const key = historyKey()
  const limit = Number(text($<HTMLInputElement>('histLimit')) ?? '10')
  const type = $<HTMLSelectElement>('histType').value as Activity['type'] | ''
  const page = await getHistory(owner(), { ...nodeOptions(), limit, cursor, types: type ? [type] : undefined })
  historyCursor = page.nextCursor
  historyFor = key
  return { data: page, view: note(page.nextCursor ? `还有更多，点“下一页”（游标 ${shorten(page.nextCursor)}）` : '没有更多了', historyView(page.items)) }
}

bind('runHist', 'hist', () => runHistory(undefined))
bind('runHistMore', 'hist', () => {
  if (!historyCursor) throw new Error('没有下一页')
  if (historyFor !== historyKey()) throw new Error('地址或筛选条件变了：请重新点“查询”')
  return runHistory(historyCursor)
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
  const c = await walletForSend()
  if (!dryRun && !confirm(`用 ${c.address} 向 ${rows.length} 个地址转${token ? `（${token}）` : ' SOL'}，确认发送？`)) throw new Error('已取消')
  const progress = $('btStats')
  const results = await batchTransfer(liquidityClient(), walletSigner(c), rows, {
    ...(token ? { token } : {}),
    dryRun,
    onUpdate: (r) => (progress.textContent = `第 ${r.index + 1} 项：${r.status}`),
  })
  return {
    data: results,
    view: table(
      ['#', '收款', '数量', '状态', '交易'],
      results.map((r, i) => [i + 1, addr(r.to), r.formatted ?? r.amount, tag(r.status + (r.error ? `：${r.error}` : ''), r.status === 'confirmed' || r.status === 'simulated' ? 'ok' : r.status === 'failed' || r.status === 'reverted' ? 'bad' : ''), r.signature ? link(r.signature) : null]),
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
