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
import { createWallet } from '@w3lib/wallet'
import { solana } from '@w3lib/wallet/solana'
import { createWalletModal } from '@w3lib/wallet/ui'

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
})

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
  $('walletInfo').textContent = c ? `${c.walletName} · ${c.address}` : '未连接（只构建时用上面“地址”栏的地址）'
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
  liq.position.replaceChildren(...(options.length ? options : [new Option('先在上面“LP 仓位”里查询（用同一个地址）', '')]))
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
