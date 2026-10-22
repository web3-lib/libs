/**
 * 交易模拟（子路径 `@w3lib/solana-batch-call/simulate`）：simulateTransaction（不验签名，换最新 blockhash）+ 钱包和交易里可写账户的前后状态，
 * 算出余额变化、授权变化（delegate / SetAuthority / 关闭账户）、指令说明、程序错误、手续费和警告。支持 legacy 和 v0（地址查找表）交易
 */
import { base64 } from '@scure/base'

import { encodeAddress, isAddress } from './address.js'
import type { RequestOptions, SolanaClient } from './client.js'
import { NATIVE_MINT, SOL_DECIMALS, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants.js'
import { decodeInstruction, type DecodedInstruction } from './decode.js'
import { classify, describe, type AssetDelta, type TxKind } from './describe.js'
import { formatUnits, parseMint, type AccountInfo } from './layout.js'
import { BPF_LOADER_UPGRADEABLE, COMPUTE_BUDGET, PROGRAMS, programErrorName } from './programs.js'
import type { SolanaPriceSource } from './price.js'
import {
  MAX_ACCOUNT_LOCKS,
  PACKET_DATA_SIZE,
  compileMessage,
  parseMessage,
  serializeTransaction,
  splitTransaction,
  transactionSize,
  normalizeInstruction,
  type InstructionInput,
} from './write/transaction.js'

export interface SimulatedBalanceChange extends AssetDelta {
  /** 谁的余额（钱包地址）；asset 原生 SOL 为 'native'（Wrapped SOL 账户的变化也并入这里），其他是 mint */
  address: string
  /** 美元价值（prices 选项开启时；没有价格为 null） */
  usd?: number | null
}

export type ApprovalChangeKind = 'delegate-set' | 'delegate-changed' | 'delegate-revoked' | 'authority-changed' | 'account-closed'

export interface ApprovalChange {
  kind: ApprovalChangeKind
  /** 代币账户（或 mint、钱包账户） */
  account: string
  mint?: string
  /** 代币账户的 owner */
  owner?: string
  /** delegate-*：新 / 旧的被授权方，和授权数量（最小单位；unlimited：接近 u64 上限） */
  delegate?: string | null
  previousDelegate?: string | null
  amount?: string
  unlimited?: boolean
  /** authority-changed：权限类型（AccountOwner、CloseAccount、MintTokens、FreezeAccount）和前后的地址 */
  authorityType?: string
  authority?: string | null
  previousAuthority?: string | null
  /** account-closed：关闭时账户里的数量，和租金退给谁（从指令里读） */
  balance?: string
  destination?: string
}

export type WarningSeverity = 'info' | 'warn' | 'danger'

export interface SimulationWarning {
  code: string
  severity: WarningSeverity
  message: string
  address?: string
}

export interface SimulationResult {
  success: boolean
  /** 失败时的原因：程序错误码解码后的名字 + 日志里的说明 */
  error?: string
  /** 消耗的计算单元（十进制字符串） */
  gasUsed: string
  /** 手续费（lamports）：每个签名 5000 + 计算单元上限 × 单价；不含新建账户的租金 */
  fee?: string
  balanceChanges: SimulatedBalanceChange[]
  approvalChanges: ApprovalChange[]
  decoded: {
    type: TxKind
    protocol?: string
    method?: string
    summary: string
    /** 没有认得的指令、按余额变化推断出来的类型 */
    inferred?: boolean
    instructions: DecodedInstruction[]
  }
  warnings: SimulationWarning[]
  logs: string[]
  /** 交易需要签名的地址和版本 */
  signers: string[]
  version: 'legacy' | 0
  /** risk: true 时：变化的代币的风险标记（mint → flags） */
  risks?: Record<string, string[]>
}

export interface SimulateOptions extends RequestOptions {
  /** 站在哪个钱包的角度算余额变化，默认交易的第一个签名者（手续费支付者）；构建好的计划 / 指令用它们自己的 owner */
  owner?: string
  /** 预期还会签名的地址（如新建仓位的 NFT mint）；交易需要别的签名者时给警告 */
  signers?: readonly string[]
  /** 额外要看余额变化的地址（如收款人） */
  watch?: readonly string[]
  /** 计划里有多步（setup + 主指令）放不进一笔交易时，只模拟这一步（下标） */
  step?: number
  /** 算 usd：true 用默认价格源，或传价格源；默认不查 */
  prices?: boolean | readonly SolanaPriceSource[]
  /** 变化的代币的风险检查（/risk），危险的标记加进 warnings；默认不查 */
  risk?: boolean
  fetch?: typeof fetch
}

/** 本库构建器的输出：兑换 / 流动性计划（steps）、指令列表、一组 ApprovalCall */
export type SimulateInput =
  | string
  | Uint8Array
  | { owner: string; steps: ReadonlyArray<{ instructions: readonly InstructionInput[] }>; signers?: ReadonlyArray<{ address: string }> }
  | { owner?: string; feePayer?: string; instructions: InstructionInput | readonly InstructionInput[] }
  | ReadonlyArray<{ owner: string; instructions: readonly InstructionInput[] }>

const U64_HALF = 1n << 63n
const HIGH_FEE_LAMPORTS = 10_000_000n
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

interface Built {
  bytes: Uint8Array
  owner: string | undefined
  expected: string[]
}

function build(input: SimulateInput, options: SimulateOptions): Built {
  if (typeof input === 'string') return { bytes: base64.decode(input), owner: options.owner, expected: [...(options.signers ?? [])] }
  if (input instanceof Uint8Array) return { bytes: input, owner: options.owner, expected: [...(options.signers ?? [])] }
  let payer: string | undefined
  let list: InstructionInput[]
  let expected = [...(options.signers ?? [])]
  if (Array.isArray(input)) {
    const calls = input as ReadonlyArray<{ owner: string; instructions: readonly InstructionInput[] }>
    payer = calls[0]?.owner
    list = calls.flatMap((c) => [...c.instructions])
    expected.push(...calls.map((c) => c.owner))
  } else if ('steps' in input) {
    payer = input.owner
    const steps = options.step === undefined ? input.steps : input.steps.filter((_, i) => i === options.step)
    list = steps.flatMap((s) => [...s.instructions])
    expected.push(...(input.signers ?? []).map((s) => s.address))
  } else {
    payer = (input as { feePayer?: string }).feePayer ?? (input as { owner?: string }).owner
    const ix = (input as { instructions: InstructionInput | readonly InstructionInput[] }).instructions
    list = Array.isArray(ix) ? [...ix] : [ix as InstructionInput]
  }
  payer = options.owner ?? payer
  if (!payer || !isAddress(payer)) throw new Error('Simulation needs a valid owner / feePayer address')
  const instructions = list.map(normalizeInstruction)
  const hasLimit = instructions.some((ix) => ix.programId === COMPUTE_BUDGET && ix.data[0] === 2)
  const withLimit = hasLimit ? instructions : [{ programId: COMPUTE_BUDGET, keys: [], data: new Uint8Array([2, 0xc0, 0x5c, 0x15, 0x00]) }, ...instructions]
  const message = compileMessage(payer, withLimit, SYSTEM_PROGRAM_ID)
  if (transactionSize(message) > PACKET_DATA_SIZE || message.accountKeys.length > MAX_ACCOUNT_LOCKS) {
    throw new Error('The instructions do not fit in one transaction; simulate the steps one by one with the `step` option')
  }
  return { bytes: serializeTransaction(message, message.signers.map(() => null)), owner: payer, expected: [payer, ...expected] }
}

interface Resolved {
  version: 'legacy' | 0
  signers: string[]
  keys: string[]
  writable: Set<string>
  instructions: Array<{ programId: string; accounts: string[]; data: Uint8Array }>
}

/** 解析交易：地址查找表里的账户读表补上（静态账户 + 表里可写的 + 表里只读的） */
async function resolveTransaction(client: SolanaClient, bytes: Uint8Array, signal: AbortSignal | undefined): Promise<Resolved> {
  if (((bytes[0] ?? 0) & 0x80) !== 0) throw new Error('Unsupported transaction format (v1): only legacy and v0 transactions can be simulated')
  const { message } = splitTransaction(bytes)
  const parsed = parseMessage(message)
  const loadedWritable: string[] = []
  const loadedReadonly: string[] = []
  if (parsed.lookups.length) {
    const tables = await client.accounts(parsed.lookups.map((l) => l.table), { signal })
    parsed.lookups.forEach((l, i) => {
      const data = tables[i]?.data
      if (!data) throw new Error(`Address lookup table not found: ${l.table}`)
      const at = (index: number) => {
        const start = 56 + 32 * index
        if (start + 32 > data.length) throw new Error(`Address lookup table ${l.table} has no entry ${index}`)
        return encodeAddress(data.slice(start, start + 32))
      }
      loadedWritable.push(...l.writable.map(at))
      loadedReadonly.push(...l.readonly.map(at))
    })
  }
  const keys = [...parsed.staticKeys, ...loadedWritable, ...loadedReadonly]
  const key = (i: number) => {
    const k = keys[i]
    if (k === undefined) throw new Error('Invalid transaction: bad account index')
    return k
  }
  return {
    version: parsed.version,
    signers: parsed.staticKeys.slice(0, parsed.signatures),
    keys,
    writable: new Set([...parsed.writable, ...loadedWritable]),
    instructions: parsed.instructions.map((ix) => ({ programId: ix.programId, accounts: ix.accounts.map(key), data: ix.data })),
  }
}

// ---- 账户状态 ----

interface Snap {
  lamports: bigint
  owner: string
  data: Uint8Array
}

interface TokenState {
  mint: string
  owner: string
  amount: bigint
  delegate: string | null
  delegatedAmount: bigint
  closeAuthority: string | null
}

function tokenState(snap: Snap | null): TokenState | null {
  const d = snap?.data
  if (!snap || !d || (snap.owner !== TOKEN_PROGRAM_ID && snap.owner !== TOKEN_2022_PROGRAM_ID)) return null
  if (d.length !== 165 && !(d.length > 165 && d[165] === 2)) return null
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength)
  const key = (o: number) => encodeAddress(d.slice(o, o + 32))
  if (d[108] === 0) return null
  return {
    mint: key(0),
    owner: key(32),
    amount: view.getBigUint64(64, true),
    delegate: view.getUint32(72, true) === 1 ? key(76) : null,
    delegatedAmount: view.getBigUint64(121, true),
    closeAuthority: view.getUint32(129, true) === 1 ? key(133) : null,
  }
}

function mintAuthorities(snap: Snap | null): { mintAuthority: string | null; freezeAuthority: string | null } | null {
  if (!snap || (snap.owner !== TOKEN_PROGRAM_ID && snap.owner !== TOKEN_2022_PROGRAM_ID)) return null
  try {
    const m = parseMint(snap.data)
    return { mintAuthority: m.mintAuthority, freezeAuthority: m.freezeAuthority }
  } catch {
    return null
  }
}

// ---- 错误 ----

const TX_ERRORS: Record<string, string> = {
  InsufficientFundsForFee: 'insufficient SOL for the transaction fee',
  AccountNotFound: 'fee payer account not found (it has no SOL)',
  BlockhashNotFound: 'blockhash not found',
  AccountInUse: 'account in use',
}

/** 失败原因：Anchor 日志的错误名 > 程序错误码（按失败的程序查表）> 日志里程序打印的说明 > 错误本身 */
export function failureText(err: unknown, logs: readonly string[], ixs: readonly DecodedInstruction[]): string {
  if (typeof err === 'string') return TX_ERRORS[err] ?? err
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError
  if (!ie) {
    if ((err as { InsufficientFundsForRent?: unknown } | null)?.InsufficientFundsForRent) return 'account would be left with less SOL than the rent-exempt minimum'
    return JSON.stringify(err)
  }
  const [index, reason] = ie
  const at = ixs[index]
  const where = at ? `instruction ${index} (${at.program ?? short(at.programId)}${at.method ? ` ${at.method}` : ''})` : `instruction ${index}`
  const reversed = [...logs].reverse()
  const anchor = reversed.find((l) => /AnchorError/.test(l))
  const anchorText = anchor && /Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.*?)\.?$/.exec(anchor)
  if (anchorText) return `${where} failed: ${anchorText[1]} (${anchorText[2]}): ${anchorText[3]}`
  const custom = (reason as { Custom?: number } | null)?.Custom
  if (custom !== undefined) {
    const failed = reversed.map((l) => /^Program (\w+) failed: custom program error/.exec(l)?.[1]).find(Boolean) ?? at?.programId
    const name = programErrorName(failed, custom)
    const detail = reversed.find((l) => /^Program log: (Error|error)/.test(l))?.replace(/^Program log: /, '')
    return `${where} failed: ${name ?? `custom program error 0x${custom.toString(16)}`}${name ? ` (0x${custom.toString(16)})` : ''}${detail ? ` - ${detail}` : ''}`
  }
  const plain = reversed.find((l) => !l.startsWith('Program ') || /^Program log: /.test(l))?.replace(/^Program log: /, '')
  return `${where} failed: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}${plain ? ` - ${plain}` : ''}`
}

interface RawSimulation {
  err: unknown
  logs: string[] | null
  unitsConsumed?: number
  accounts: Array<{ lamports: number | string; owner: string; data: [string, string] } | null> | null
}

/**
 * 模拟一笔交易，不需要签名、不会发送。输入：base64 / 字节的交易，或本库构建器的输出
 * （buildSwap / buildAddLiquidity… 的计划、`{ owner, instructions }`、buildRevokes / buildCloses 的结果）
 */
export async function simulate(client: SolanaClient, input: SimulateInput, options: SimulateOptions = {}): Promise<SimulationResult> {
  const { signal } = options
  const built = build(input, options)
  const tx = await resolveTransaction(client, built.bytes, signal)
  const wallet = built.owner ?? tx.signers[0]
  if (!wallet) throw new Error('Transaction has no signer')
  const decodedIxs = tx.instructions.map((ix, i) => decodeInstruction(i, ix.programId, ix.accounts, ix.data))

  // 要看前后状态的账户：钱包、额外要看的、交易里可写的里和钱包有关的（新建的账户、钱包的代币账户、mint）；
  // 公共节点的 simulateTransaction 一次最多返回 10 个账户（publicnode），所以先读前状态筛一遍，不够再分批模拟
  const candidates = [...new Set([wallet, ...(options.watch ?? []).filter(isAddress), ...tx.keys.filter((k) => tx.writable.has(k))])]
  const preAll = await client.accounts(candidates, { signal })
  const keep = (address: string, i: number) => {
    const before = preAll[i]
    if (address === wallet || options.watch?.includes(address) || !before) return true
    return tokenState(before)?.owner === wallet || mintAuthorities(before) !== null
  }
  const watch = candidates.filter(keep)
  const pre = watch.map((a) => preAll[candidates.indexOf(a)] ?? null)
  const raw = base64.encode(built.bytes)
  const run = (addresses: string[]) =>
    client.request<{ value: RawSimulation }>(
      'simulateTransaction',
      [raw, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses } }],
      { signal },
    )
  let sim: { value: RawSimulation }
  try {
    sim = await run(watch)
  } catch (err) {
    const max = Number(/maximum of (\d+) accounts/i.exec(err instanceof Error ? err.message : '')?.[1])
    if (!(max >= 1)) throw err
    const chunks = Array.from({ length: Math.ceil(watch.length / max) }, (_, i) => watch.slice(i * max, (i + 1) * max))
    const parts = await Promise.all(chunks.map(run))
    sim = { value: { ...(parts[0] as { value: RawSimulation }).value, accounts: parts.every((x) => x.value.accounts) ? parts.flatMap((x) => x.value.accounts ?? []) : null } }
  }
  const value = sim.value
  const logs = value.logs ?? []
  const success = !value.err
  const post: Array<Snap | null> | null = success && value.accounts ? value.accounts.map((a) => (a ? { lamports: BigInt(a.lamports), owner: a.owner, data: base64.decode(a.data[0]) } : null)) : null
  const preAt = (i: number): Snap | null => {
    const a: AccountInfo | null | undefined = pre[i]
    return a ? { lamports: a.lamports, owner: a.owner, data: a.data } : null
  }

  // 手续费：签名费 + 计算单元上限 × 单价
  let limit: bigint | null = null
  let price = 0n
  for (const ix of tx.instructions) {
    if (ix.programId !== COMPUTE_BUDGET) continue
    const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength)
    if (ix.data[0] === 2 && ix.data.length >= 5) limit = BigInt(view.getUint32(1, true))
    if (ix.data[0] === 3 && ix.data.length >= 9) price = view.getBigUint64(1, true)
  }
  const nonBudget = tx.instructions.filter((ix) => ix.programId !== COMPUTE_BUDGET).length
  const units = BigInt(Math.min(1_400_000, limit !== null ? Number(limit) : 200_000 * nonBudget))
  const fee = 5000n * BigInt(tx.signers.length) + (price * units + 999_999n) / 1_000_000n
  const feePayer = tx.signers[0]

  const warnings: SimulationWarning[] = []
  const warn = (code: string, severity: WarningSeverity, message: string, address?: string) => warnings.push({ code, severity, message, address })

  const approvalChanges: ApprovalChange[] = []
  const tokenDeltas = new Map<string, bigint>()
  let nativeDelta = 0n
  const mints = new Set<string>()

  if (post) {
    watch.forEach((address, i) => {
      const before = preAt(i)
      const after = post[i] ?? null
      if (address === wallet) {
        nativeDelta = (after?.lamports ?? 0n) - (before?.lamports ?? 0n)
        if (before && after && before.owner === SYSTEM_PROGRAM_ID && after.owner !== SYSTEM_PROGRAM_ID) {
          approvalChanges.push({ kind: 'authority-changed', account: address, authorityType: 'AccountOwner', authority: after.owner, previousAuthority: before.owner })
        }
      }
      const a = tokenState(before)
      const b = tokenState(after)
      const mine = (t: TokenState | null) => t?.owner === wallet
      const mint = (a ?? b)?.mint
      if (mint && (mine(a) || mine(b))) {
        mints.add(mint)
        tokenDeltas.set(mint, (tokenDeltas.get(mint) ?? 0n) + (mine(b) ? (b as TokenState).amount : 0n) - (mine(a) ? (a as TokenState).amount : 0n))
        const common = { account: address, mint, owner: wallet }
        if (a && !b) {
          approvalChanges.push({ ...common, kind: 'account-closed', balance: a.amount.toString() })
        } else if (b) {
          const unlimited = b.delegatedAmount >= U64_HALF
          if (b.delegate && !a?.delegate) approvalChanges.push({ ...common, kind: 'delegate-set', delegate: b.delegate, previousDelegate: null, amount: b.delegatedAmount.toString(), unlimited })
          else if (b.delegate && a?.delegate && (a.delegate !== b.delegate || b.delegatedAmount > a.delegatedAmount)) {
            approvalChanges.push({ ...common, kind: 'delegate-changed', delegate: b.delegate, previousDelegate: a.delegate, amount: b.delegatedAmount.toString(), unlimited })
          } else if (!b.delegate && a?.delegate) approvalChanges.push({ ...common, kind: 'delegate-revoked', delegate: null, previousDelegate: a.delegate, amount: '0' })
          if (a && a.owner !== b.owner) approvalChanges.push({ ...common, kind: 'authority-changed', authorityType: 'AccountOwner', authority: b.owner, previousAuthority: a.owner })
          if (a && a.closeAuthority !== b.closeAuthority) {
            approvalChanges.push({ ...common, kind: 'authority-changed', authorityType: 'CloseAccount', authority: b.closeAuthority, previousAuthority: a.closeAuthority })
          }
        }
      }
      const ma = mintAuthorities(before)
      const mb = mintAuthorities(after)
      if (ma && mb) {
        for (const [type, field] of [['MintTokens', 'mintAuthority'], ['FreezeAccount', 'freezeAuthority']] as const) {
          if (ma[field] !== mb[field]) approvalChanges.push({ kind: 'authority-changed', account: address, mint: address, authorityType: type, authority: mb[field], previousAuthority: ma[field] })
        }
      }
    })
  } else {
    // 没有模拟后的状态（模拟失败）：只能按指令判断授权
    for (const ix of decodedIxs) {
      const args = ix.args as Record<string, string | null> | undefined
      if (ix.method === 'approve' || ix.method === 'approveChecked') {
        approvalChanges.push({ kind: 'delegate-set', account: args?.account as string, mint: args?.mint ?? undefined, owner: args?.owner as string, delegate: args?.delegate, amount: args?.amount as string, unlimited: BigInt(args?.amount ?? 0) >= U64_HALF })
      } else if (ix.method === 'setAuthority') {
        approvalChanges.push({ kind: 'authority-changed', account: args?.account as string, authorityType: args?.authorityType as string, authority: args?.newAuthority })
      }
    }
  }
  for (const ix of decodedIxs) {
    const args = ix.args as Record<string, string> | undefined
    if (ix.method === 'closeAccount') {
      const closed = approvalChanges.find((c) => c.kind === 'account-closed' && c.account === args?.account)
      if (closed) closed.destination = args?.destination
    }
  }

  // 余额变化：钱包的 SOL（不含手续费）和代币，Wrapped SOL 并入 SOL
  const balanceChanges: SimulatedBalanceChange[] = []
  if (post) {
    const wsol = tokenDeltas.get(NATIVE_MINT) ?? 0n
    tokenDeltas.delete(NATIVE_MINT)
    mints.delete(NATIVE_MINT)
    const sol = nativeDelta + (feePayer === wallet ? fee : 0n) + wsol
    if (sol !== 0n) balanceChanges.push({ address: wallet, asset: 'native', symbol: 'SOL', decimals: SOL_DECIMALS, delta: sol.toString(), formatted: formatUnits(sol, SOL_DECIMALS) })
    const ids = [...tokenDeltas.entries()].filter(([, v]) => v !== 0n)
    const details = ids.length
      ? await client.tokens(ids.map(([m]) => m), { fields: ['symbol', 'decimals'], signal }).catch(() => null)
      : []
    if (!details) warn('metadata-unavailable', 'info', 'Token symbols / decimals could not be read')
    ids.forEach(([mint, delta], i) => {
      const detail = details?.[i]
      const decimals = detail?.decimals ?? 0
      balanceChanges.push({ address: wallet, asset: mint, symbol: detail?.symbol ?? short(mint), decimals, delta: delta.toString(), formatted: formatUnits(delta, decimals) })
    })
  }

  const kind = classify(decodedIxs, balanceChanges)
  const recipient = decodedIxs.find((ix) => ix.type === 'transfer')?.args as Record<string, string> | undefined
  const decoded: SimulationResult['decoded'] = {
    type: kind?.type ?? 'unknown',
    protocol: kind?.protocol,
    method: kind?.method,
    summary: describe(kind, decodedIxs, balanceChanges, recipient?.to ?? recipient?.destination),
    inferred: kind?.inferred,
    instructions: decodedIxs,
  }

  // ---- 警告 ----
  if (!success) warn('simulation-failed', 'warn', 'The transaction fails in simulation')
  for (const c of approvalChanges) {
    if (c.kind === 'delegate-set' || c.kind === 'delegate-changed') {
      warn(c.unlimited ? 'unlimited-delegate' : 'delegate-approved', c.unlimited ? 'danger' : 'warn', `${short(c.delegate as string)} can spend ${c.unlimited ? 'an unlimited amount of' : c.amount} of the tokens in ${short(c.account)}`, c.delegate as string)
    } else if (c.kind === 'authority-changed') {
      const sev = c.authorityType === 'AccountOwner' || c.authorityType === 'CloseAccount' ? 'danger' : 'warn'
      warn('authority-changed', sev, `${c.authorityType} authority of ${short(c.account)} changes to ${c.authority ? short(c.authority) : 'none'}`, c.authority ?? undefined)
    } else if (c.kind === 'account-closed' && c.destination && c.destination !== wallet) {
      warn('close-to-other', 'warn', `Closing ${short(c.account)}${c.balance && c.balance !== '0' ? ` (balance ${c.balance})` : ''} sends its lamports to ${short(c.destination)}`, c.destination)
    }
  }
  for (const ix of decodedIxs) {
    if (ix.method === 'assign' || ix.method === 'assignWithSeed') warn('assign-owner', 'danger', `Assigns ${short(String(ix.args?.account))} to another program`, String(ix.args?.account))
    if (ix.programId === BPF_LOADER_UPGRADEABLE && (ix.method === 'upgrade' || ix.method === 'setAuthority')) warn('program-upgrade', 'danger', `Program loader instruction: ${ix.method}`)
  }
  const unknown = new Set(decodedIxs.filter((ix) => !PROGRAMS[ix.programId]).map((ix) => ix.programId))
  for (const program of unknown) warn('unknown-program', 'warn', `Calls an unrecognized program ${short(program)}`, program)
  const expected = new Set(built.expected.length ? built.expected : [wallet])
  expected.add(wallet)
  for (const s of tx.signers) {
    if (!expected.has(s)) warn('unexpected-signer', 'warn', `The transaction also needs a signature from ${short(s)}`, s)
  }
  if (!tx.signers.includes(wallet)) warn('wallet-not-signer', 'info', `${short(wallet)} does not sign this transaction`, wallet)
  if (fee > HIGH_FEE_LAMPORTS) warn('high-fee', 'warn', `Network fee is ${formatUnits(fee, SOL_DECIMALS)} SOL`)
  if (post) {
    const walletPre = preAt(watch.indexOf(wallet))?.lamports ?? 0n
    const spent = -(nativeDelta + (feePayer === wallet ? fee : 0n))
    if (walletPre > 0n && spent > 0n && spent * 10n >= walletPre * 9n) warn('drains-balance', 'warn', 'Spends 90% or more of the wallet SOL balance', wallet)
    watch.forEach((address, i) => {
      if (address === wallet) return
      const before = preAt(i)
      const after = post[i] ?? null
      const isDestination = decodedIxs.some((ix) => (ix.method === 'transfer' || ix.method === 'transferWithSeed') && ix.programId === SYSTEM_PROGRAM_ID && ix.args?.to === address)
      if (isDestination && (!before || before.lamports === 0n)) warn('new-recipient', 'warn', `${short(address)} has never held SOL (new account)`, address)
      const t = tokenState(after)
      if (!before && t && t.owner !== wallet && decodedIxs.some((ix) => ix.type === 'transfer' && ix.args?.destination === address)) {
        warn('new-recipient', 'warn', `${short(t.owner)} did not have a token account for this mint yet`, t.owner)
      }
    })
  }

  const result: SimulationResult = {
    success,
    ...(success ? {} : { error: failureText(value.err, logs, decodedIxs) }),
    gasUsed: String(value.unitsConsumed ?? 0),
    fee: fee.toString(),
    balanceChanges,
    approvalChanges,
    decoded,
    warnings,
    logs,
    signers: tx.signers,
    version: tx.version,
  }

  // ---- 可选：价格、风险（按需加载） ----
  const assets = balanceChanges.map((c) => (c.asset === 'native' ? NATIVE_MINT : c.asset))
  if (options.prices && balanceChanges.length) {
    const { tokenPrices } = await import('./price.js')
    const sources = Array.isArray(options.prices) ? { sources: options.prices as readonly SolanaPriceSource[] } : {}
    const prices = await tokenPrices(client, assets, { ...sources, signal, fetch: options.fetch }).catch(() => null)
    balanceChanges.forEach((c, i) => {
      const p = prices?.[i]?.price
      c.usd = p == null ? null : Number(c.formatted) * p
    })
  }
  if (options.risk) {
    const tokens = [...mints].filter((m) => balanceChanges.some((c) => c.asset === m))
    if (tokens.length) {
      const { tokenRisks } = await import('./risk.js')
      const risks = await tokenRisks(client, tokens, { signal }).catch(() => null)
      if (risks) {
        result.risks = Object.fromEntries(risks.map((r) => [r.mint, r.flags]))
        const severe = ['permanent-delegate', 'transfer-hook', 'high-transfer-fee', 'non-transferable', 'default-frozen', 'paused', 'not-found']
        for (const r of risks) {
          const hit = r.flags.filter((f) => severe.includes(f))
          if (hit.length) warn('token-risk', 'warn', `${short(r.mint)}: ${hit.join(', ')}`, r.mint)
        }
      }
    }
  }
  return result
}
