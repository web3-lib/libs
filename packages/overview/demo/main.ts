import { mountShell } from '../../demo-shared/shell'
import { getOverview, type ChainOverview, type Overview, type OverviewInput } from '@w3lib/overview'
import { deriveAddresses, getDerivedOverview, type DerivedAddresses, type MnemonicChain } from '@w3lib/overview/mnemonic'
import { createWallet } from '@w3lib/wallet'
import { arbitrum, avalanche, base, bsc, ethereum, optimism, polygon } from '@w3lib/wallet/chains'
import { evm } from '@w3lib/wallet/evm'
import { solana } from '@w3lib/wallet/solana'
import { sui } from '@w3lib/wallet/sui'
import { ton } from '@w3lib/wallet/ton'
import { tron } from '@w3lib/wallet/tron'
import { createWalletModal } from '@w3lib/wallet/ui'

mountShell()

// 链包按需加载：打包时只会带上这里写了的
const loaders = {
  evm: () => import('@w3lib/evm-batch-call/price'),
  evmApprovals: () => import('@w3lib/evm-batch-call/approvals'),
  solana: () => import('@w3lib/solana-batch-call/price'),
  solanaApprovals: () => import('@w3lib/solana-batch-call/approvals'),
  sui: () => import('@w3lib/sui-batch-call/price'),
  ton: () => import('@w3lib/ton-batch-call/price'),
  // 助记词推导 TON 钱包地址（/mnemonic）
  tonWrite: () => import('@w3lib/ton-batch-call/write'),
  tonCore: () => import('@w3lib/ton-batch-call'),
}

const SAMPLE = {
  evm: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  tron: 'TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G',
  solana: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
  sui: '0x9f63425709069336fec108bd4ba69a8f3d23e8ab237311f3ce58ae2bb0ed4d7f',
  ton: 'UQAj-peZGPH-cC25EAv4Q-h8cBXszTmkch6ba6wXC8BM40qt',
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const short = (s: string) => (s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s)
const STORE = 'w3lib-overview-demo'

for (const [id, value] of Object.entries(JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, string>)) {
  const el = document.getElementById(id) as HTMLInputElement | null
  if (el && typeof value === 'string') el.value = value
}

let controller: AbortController | null = null

function renderChain(c: ChainOverview): string {
  const status = c.status === 'ok' ? '<span class="tag ok">ok</span>' : c.status === 'partial' ? '<span class="tag">partial</span>' : '<span class="tag bad">error</span>'
  const rows = c.tokens.slice(0, 15).map((t) => `<tr><td>${esc(t.symbol ?? short(t.token))}</td><td class="num">${esc(t.formatted ?? '?')}</td><td class="num">${t.value === null ? '无价格' : usd(t.value)}</td></tr>`).join('')
  const detail = c.status === 'error' ? `<div class="output error">${esc(c.error ?? '')}</div>` : `<div class="table-wrap"><table><tbody>${rows}</tbody></table></div>`
  const warn = c.warnings.map((w) => `<div class="hint">${esc(w)}</div>`).join('')
  const lp = c.lp.length ? `<div class="hint">LP 仓位 ${c.lp.length} 个，${usd(c.lpUsd)}：${c.lp.map((p) => esc(`${p.protocolName} ${p.tokens.map((t) => t.symbol).join('/')}`)).join('、')}</div>` : ''
  return `<details open><summary>${esc(c.name)} ${status} <b>${usd(c.totalUsd)}</b> <span class="muted">${c.tokens.length} 个代币，${c.ms}ms${c.unpriced ? `，${c.unpriced} 个没有价格` : ''}</span></summary>${detail}${lp}${warn}</details>`
}

function renderAll(o: Overview): void {
  $('summary').innerHTML = `<b>${usd(o.totalUsd)}</b> <span class="muted">代币 ${usd(o.tokensUsd)} + LP ${usd(o.lpUsd)}，${o.unpriced} 个没有价格，${o.errors.length} 条链出错，共 ${o.timings.totalMs}ms</span>`
  $('chainsResult').innerHTML = o.byChain.map(renderChain).join('')
  $('assets').innerHTML = `<div class="table-wrap"><table><tbody>${o.tokens
    .slice(0, 30)
    .map((t) => `<tr><td>${esc(t.symbol ?? short(t.key))}${t.known ? '' : ' <span class="muted">未收录</span>'}</td><td class="num">${t.amount.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td><td class="num">${usd(t.usd)}</td><td>${t.chains.map((c) => esc(c.chain)).join(' ')}</td></tr>`)
    .join('')}</tbody></table></div>`
  $('approvalsResult').innerHTML = o.approvals
    ? `共 ${o.approvals.total} 项，无限授权 ${o.approvals.unlimited}，未知被授权方 ${o.approvals.unknownSpender}` +
      `<div class="table-wrap"><table><tbody>${o.approvals.items.map((a) => `<tr><td>${esc(a.chain)}</td><td>${esc(a.type)}</td><td>${esc(a.symbol ?? short(a.asset))}</td><td>${esc(a.spenderName ?? short(a.spender))}</td><td>${a.unlimited ? '<span class="tag bad">无限</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '<span class="muted">没有开启</span>'
}

$('sample').addEventListener('click', () => {
  for (const [id, value] of Object.entries(SAMPLE)) ($(id) as HTMLInputElement).value = value
})
$('cancel').addEventListener('click', () => controller?.abort(new Error('cancelled')))

$('run').addEventListener('click', async () => {
  const value = (id: string) => ($(id) as HTMLInputElement).value.trim()
  localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(Object.keys(SAMPLE).map((id) => [id, value(id)]))))
  const chains = Array.from(document.querySelectorAll<HTMLInputElement>('#chains input:checked')).map((i) => Number(i.value))
  const input: OverviewInput = {
    ...(value('evm') && chains.length ? { evm: { address: value('evm'), chains } } : {}),
    ...(value('tron') ? { tron: { address: value('tron') } } : {}),
    ...(value('solana') ? { solana: { address: value('solana') } } : {}),
    ...(value('sui') ? { sui: { address: value('sui') } } : {}),
    ...(value('ton') ? { ton: { address: value('ton') } } : {}),
  }
  controller = new AbortController()
  ;($('run') as HTMLButtonElement).disabled = true
  ;($('cancel') as HTMLButtonElement).disabled = false
  $('stats').textContent = '查询中…'
  $('chainsResult').innerHTML = ''
  const done: ChainOverview[] = []
  try {
    const o = await getOverview(input, {
      loaders,
      lp: ($('lp') as HTMLInputElement).checked,
      approvals: ($('approvals') as HTMLInputElement).checked,
      mergeBySymbol: ($('mergeBySymbol') as HTMLInputElement).checked,
      minUsd: 0.5,
      signal: controller.signal,
      // 每条链完成就显示
      onChain: (c) => {
        done.push(c)
        $('chainsResult').innerHTML = done.map(renderChain).join('')
        $('stats').textContent = `已完成 ${done.length} 条链…`
      },
    })
    renderAll(o)
    $('stats').textContent = `完成，${o.timings.totalMs}ms`
  } catch (err) {
    $('stats').textContent = err instanceof Error ? err.message : String(err)
  } finally {
    ;($('run') as HTMLButtonElement).disabled = false
    ;($('cancel') as HTMLButtonElement).disabled = true
  }
})

// ---------------------------------------------------------------------------
// 钱包：mode 'multi' 每条链各连一个钱包，连上的地址填进对应的栏；断开时只清空钱包填的栏
// ---------------------------------------------------------------------------

const NAMESPACES = ['evm', 'tron', 'solana', 'sui', 'ton'] as const
type Field = (typeof NAMESPACES)[number]
const NS_NAMES: Record<Field, string> = { evm: 'EVM', tron: 'Tron', solana: 'Solana', sui: 'Sui', ton: 'TON' }

const wallet = createWallet({
  mode: 'multi',
  connectors: [
    evm({ chains: [ethereum, bsc, base, arbitrum, optimism, polygon, avalanche] }),
    tron(),
    solana(),
    sui(),
    // TON Connect（@tonconnect/sdk 按需加载）；manifest 由 vite 插件生成
    ton({ manifestUrl: new URL('tonconnect-manifest.json', location.href).href, load: () => import('@tonconnect/sdk') }),
  ],
})
const modal = createWalletModal(wallet)
/** 钱包填进栏里的地址：栏里还是这个值时才跟着钱包更新 / 清空，自己填的不动 */
const filled = new Map<Field, string>()

function syncWallet(): void {
  const { connections } = wallet.getState()
  const lines: string[] = []
  for (const ns of NAMESPACES) {
    const c = connections[ns]
    const input = $(ns) as HTMLInputElement
    const current = input.value.trim()
    const prev = filled.get(ns)
    if (c) {
      if (!current || current === prev || current === c.address) {
        input.value = c.address
        filled.set(ns, c.address)
        lines.push(`${NS_NAMES[ns]} ← ${c.walletName}`)
      } else {
        lines.push(`${NS_NAMES[ns]}：${c.walletName}（栏里是自己填的地址，没有覆盖）`)
      }
    } else if (prev !== undefined) {
      if (current === prev) input.value = ''
      filled.delete(ns)
    }
  }
  $('walletInfo').textContent = lines.length ? lines.join(' · ') : '未连接（也可以直接填地址）'
  $('connectWallet').textContent = lines.length ? '连接其他链' : '连接钱包'
  ;($('disconnectWallet') as HTMLButtonElement).hidden = !lines.length
}
wallet.subscribe(() => syncWallet())
void wallet.ready.then(syncWallet)
$('connectWallet').addEventListener('click', () => void modal.open())
$('disconnectWallet').addEventListener('click', () => void wallet.disconnectAll())

// ---------------------------------------------------------------------------
// 助记词：本地推导地址 → 总览。助记词只在输入框和函数的局部变量里，不写进 URL / localStorage / console
// ---------------------------------------------------------------------------

/** 公开的测试助记词（BIP-39 的测试向量，谁都知道，不要往里转资产） */
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const mnemonicBox = $('mnemonic') as HTMLTextAreaElement
const passphraseBox = $('mnPassphrase') as HTMLInputElement
/** 推导出的地址（只有地址和路径）：输入框清空后“查询总览”用它 */
let derived: DerivedAddresses | null = null
/** 上次推导用的账户数和链（不含助记词、密码），用来判断设置是否改过 */
let derivedSettings = ''
let mnController: AbortController | null = null

// 遮住助记词：支持 -webkit-text-security 的浏览器显示圆点，其余用模糊
const nativeMask = CSS.supports('-webkit-text-security', 'disc')
function applyMask(): void {
  const masked = !($('mnShow') as HTMLInputElement).checked
  mnemonicBox.classList.toggle('masked', masked)
  mnemonicBox.style.color = masked && !nativeMask ? 'transparent' : ''
  mnemonicBox.style.textShadow = masked && !nativeMask ? '0 0 8px var(--fg)' : ''
}
applyMask()
$('mnShow').addEventListener('change', applyMask)
$('mnSample').addEventListener('click', () => {
  mnemonicBox.value = TEST_MNEMONIC
})

const checkedValues = (id: string) => Array.from(document.querySelectorAll<HTMLInputElement>(`#${id} input:checked`)).map((i) => i.value)

/**
 * 从输入框推导（推导后按选项清空输入框和密码）。输入框是空的时用上次推导的结果（reused: true）；
 * 但账户数、链或密码改过时上次的结果已经不对，要求重新填助记词
 */
async function deriveFromBox(): Promise<{ addresses: DerivedAddresses; reused: boolean }> {
  const mnemonic = mnemonicBox.value
  const accounts = Number(($('mnAccounts') as HTMLInputElement).value)
  const chains = checkedValues('mnKinds') as MnemonicChain[]
  const settings = `${accounts}|${chains.join(',')}`
  if (!mnemonic.trim()) {
    if (!derived) throw new Error('先填助记词')
    // 密码只和助记词一起用：框里有密码说明要换密码
    if (settings !== derivedSettings || passphraseBox.value) throw new Error('账户数、链或密码改过了，请重新填助记词再推导（输入框已在推导后清空）')
    return { addresses: derived, reused: true }
  }
  const result = await deriveAddresses(mnemonic, { accounts, passphrase: passphraseBox.value, chains, loaders })
  if (($('mnClear') as HTMLInputElement).checked) {
    mnemonicBox.value = ''
    passphraseBox.value = ''
  }
  derived = result
  derivedSettings = settings
  renderAddresses(result)
  return { addresses: result, reused: false }
}

function renderAddresses(a: DerivedAddresses): void {
  const row = (chain: string, index: number, address: string, path: string) =>
    `<tr><td>${esc(chain)}</td><td class="num">${index}</td><td class="addr">${esc(address)}</td><td class="addr">${esc(path)}</td></tr>`
  const rows = [
    ...(['evm', 'tron', 'solana', 'sui'] as const).flatMap((k) => a[k].map((address, i) => row(NS_NAMES[k], i, address, a.paths[k][i] ?? ''))),
    ...a.ton.flatMap((t) => {
      const path = t.scheme === 'ton' ? 'TON 格式助记词' : t.path
      return [row('TON v4r2', t.index, t.v4r2, path), row('TON v5r1', t.index, t.v5r1, path)]
    }),
  ]
  const kind = [a.kind.bip39 ? 'BIP-39' : '', a.kind.ton ? 'TON 格式' : ''].filter(Boolean).join(' + ')
  $('mnAddresses').innerHTML =
    `<div class="hint">助记词类型：${esc(kind)}</div>` +
    a.warnings.map((w) => `<div class="hint">${esc(w)}</div>`).join('') +
    `<div class="table-wrap"><table><thead><tr><th>链</th><th>账户</th><th>地址</th><th>派生路径</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
}

$('mnDerive').addEventListener('click', async () => {
  $('mnStats').textContent = '推导中…'
  try {
    const { addresses: a, reused } = await deriveFromBox()
    const n = Math.max(a.evm.length, a.tron.length, a.solana.length, a.sui.length, a.ton.length)
    $('mnStats').textContent = reused ? `输入框是空的，沿用上次推导的 ${n} 个账户` : `推导了 ${n} 个账户`
  } catch (err) {
    $('mnStats').textContent = err instanceof Error ? err.message : String(err)
  }
})
$('mnCancel').addEventListener('click', () => mnController?.abort(new Error('cancelled')))

$('mnRun').addEventListener('click', async () => {
  mnController = new AbortController()
  ;($('mnRun') as HTMLButtonElement).disabled = true
  ;($('mnCancel') as HTMLButtonElement).disabled = false
  $('mnSummary').innerHTML = ''
  $('mnAccountsResult').innerHTML = ''
  const html: string[] = []
  try {
    $('mnStats').textContent = '推导中…'
    const { addresses: a, reused } = await deriveFromBox()
    const prefix = reused ? '沿用上次推导的地址，' : ''
    $('mnStats').textContent = `${prefix}查询中…`
    // 一条 EVM 链都没勾时传空数组：库不查 EVM，并在 warnings 里说明
    const r = await getDerivedOverview(a, {
      evm: { chains: checkedValues('mnChains').map(Number) },
      loaders,
      minUsd: 0.5,
      signal: mnController.signal,
      // 每个账户查完就显示
      onAccount: (acc) => {
        const ton = acc.ton.map((t) => `TON ${t.version}${t.scheme === 'ton' ? '（TON 格式助记词）' : ''}（${t.status ?? '状态未知'}）`).join('、')
        html.push(`<details open><summary>账户 ${acc.index} <b>${usd(acc.overview.totalUsd)}</b> <span class="muted">${esc(ton)}</span></summary>${acc.overview.byChain.map(renderChain).join('')}</details>`)
        $('mnAccountsResult').innerHTML = html.join('')
        $('mnStats').textContent = `${prefix}已完成 ${html.length} 个账户…`
      },
    })
    $('mnSummary').innerHTML =
      `<b>${usd(r.total.totalUsd)}</b> <span class="muted">${r.accounts.length} 个账户，代币 ${usd(r.total.tokensUsd)} + LP ${usd(r.total.lpUsd)}，${r.total.errors.length} 条链出错</span>` +
      r.warnings.map((w) => `<div class="hint">${esc(w)}</div>`).join('') +
      `<div class="table-wrap"><table><tbody>${r.total.tokens
        .slice(0, 20)
        .map((t) => `<tr><td>${esc(t.symbol ?? short(t.key))}</td><td class="num">${t.amount.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td><td class="num">${usd(t.usd)}</td></tr>`)
        .join('')}</tbody></table></div>`
    $('mnStats').textContent = `${prefix}完成，${r.total.timings.totalMs}ms`
  } catch (err) {
    $('mnStats').textContent = err instanceof Error ? err.message : String(err)
  } finally {
    ;($('mnRun') as HTMLButtonElement).disabled = false
    ;($('mnCancel') as HTMLButtonElement).disabled = true
  }
})
