/**
 * 授权管理（子路径 `@w3lib/solana-batch-call/approvals`）：Solana 上的“授权”是代币账户的 delegate（Approve 设置，可以转走 delegatedAmount 以内的代币）。
 * 批量查一个地址的代币账户给出的授权、可以关闭回收租金的空账户；批量撤销（Revoke）、关闭（CloseAccount，租金退回）
 */
import { base64 } from '@scure/base'

import { encodeAddress, getAssociatedTokenAddress, getMetadataAddress, isAddress } from './address.js'
import type { RequestOptions, SolanaClient } from './client.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants.js'
import { findExtension, formatUnits, parseMetaplexMetadata, parseMint, type AccountInfo } from './layout.js'
import { methodUnavailable } from './lp.js'
import { closeAccount, harvestWithheldTokensToMint, revoke } from './write/instructions.js'
import type { BatchCallOptions } from './write/batch.js'
import type { WriteResult } from './write/send.js'
import type { SignerInput } from './write/signer.js'
import type { Instruction } from './write/transaction.js'

export interface ApprovalsQuery extends RequestOptions {
  /**
   * 要检查的代币 mint：读这些代币的关联代币账户（ATA，SPL Token 和 Token-2022 都看），免费公共节点也能用；非 ATA 的代币账户查不到。
   * 不传时列出地址的全部代币账户（getTokenAccountsByOwner），需要支持它的节点
   */
  mints?: readonly string[]
  /** 返回全部代币账户（含没有授权、有余额的），默认 false：只返回有授权（delegate / 别人的关闭权限）的账户和余额为 0 的账户 */
  all?: boolean
}

/** 关不掉的原因：balance 有余额（Wrapped SOL 除外）；close-authority 关闭权限是别的地址；confidential-balance Token-2022 机密余额不为 0 */
export type CloseBlocker = 'balance' | 'close-authority' | 'confidential-balance'

/** 一个代币账户的授权状态，字段都是字符串 / 数字 / 布尔 / null，可以直接 JSON.stringify */
export interface TokenAccountApproval {
  /** 代币账户地址 */
  account: string
  mint: string
  owner: string
  tokenProgram: string
  /** 是 owner 的关联代币账户（ATA） */
  ata: boolean
  /** Wrapped SOL 账户：amount 是包装的 SOL，关闭时连同租金一起退回（相当于 unwrap） */
  native: boolean
  symbol: string | null
  /** 精度；mint 读不到时为 null（formatted 也为 null） */
  decimals: number | null
  amount: string
  formatted: string | null
  /** 被授权方（delegate）；没有授权时为 null */
  delegate: string | null
  /** 被授权方还能转走的数量（最小单位） */
  delegatedAmount: string
  delegatedFormatted: string | null
  /** 关闭权限：设置了且不是 owner 时，owner 自己关不掉，余额为 0 时它可以关闭账户并拿走租金（只有它自己能撤销） */
  closeAuthority: string | null
  /** mint 的永久授权（Token-2022 PermanentDelegate 扩展）：可以转走 / 销毁任何账户里的这种代币，撤销不了 */
  permanentDelegate: string | null
  /** 账户被冻结：不能 Revoke（关闭不受影响） */
  frozen: boolean
  /** 账户的 lamports：关闭时全部退回 destination（Wrapped SOL 含包装的 SOL） */
  lamports: string
  /** Token-2022 账户里暂存的转账手续费（不属于 owner）：不为 0 时要先收到 mint 上才能关闭，buildCloses 自动加上这一步 */
  withheldAmount: string
  /** 能撤销授权（有 delegate、没有冻结） */
  revocable: boolean
  /** 能关闭；不能时 closeBlocker 是原因 */
  closable: boolean
  closeBlocker: CloseBlocker | null
}

const ACCOUNT_SIZE = 165
const ACCOUNT_TYPE_ACCOUNT = 2
const EXT_TRANSFER_FEE_AMOUNT = 2
const EXT_CONFIDENTIAL_TRANSFER_ACCOUNT = 5
const EXT_PERMANENT_DELEGATE = 12
const EXT_CONFIDENTIAL_TRANSFER_FEE_AMOUNT = 17
const ZERO_PUBKEY = '11111111111111111111111111111111'

/** 代币账户的完整布局（SPL Token / Token-2022 前 165 字节相同）及关闭相关的 Token-2022 扩展 */
interface ParsedAccount {
  mint: string
  owner: string
  amount: bigint
  delegate: string | null
  frozen: boolean
  native: boolean
  delegatedAmount: bigint
  closeAuthority: string | null
  withheldAmount: bigint
  confidentialBalance: boolean
}

/** 解析代币账户；不是已初始化的代币账户时为 null */
export function parseTokenAccountState(data: Uint8Array): ParsedAccount | null {
  if (data.length !== ACCOUNT_SIZE && !(data.length > ACCOUNT_SIZE && data[ACCOUNT_SIZE] === ACCOUNT_TYPE_ACCOUNT)) {
    return null
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const pubkey = (offset: number) => encodeAddress(data.slice(offset, offset + 32))
  // COption：u32 标记（1 有、0 没有）+ 值
  const option = (offset: number) => view.getUint32(offset, true) === 1
  const state = data[108] as number
  if (state === 0) {
    return null // 未初始化
  }
  const withheld = findExtension(data, EXT_TRANSFER_FEE_AMOUNT)
  // 机密转账：待入账（lo / hi）和可用余额的密文全为 0 才能关闭；手续费扩展同理（Token-2022 的 closable 检查）
  const confidential = findExtension(data, EXT_CONFIDENTIAL_TRANSFER_ACCOUNT)
  const confidentialFee = findExtension(data, EXT_CONFIDENTIAL_TRANSFER_FEE_AMOUNT)
  const nonZero = (bytes: Uint8Array | null, from: number, to: number) => !!bytes && bytes.slice(from, to).some((b) => b !== 0)
  return {
    mint: pubkey(0),
    owner: pubkey(32),
    amount: view.getBigUint64(64, true),
    delegate: option(72) ? pubkey(76) : null,
    frozen: state === 2,
    native: option(109),
    delegatedAmount: view.getBigUint64(121, true),
    closeAuthority: option(129) ? pubkey(133) : null,
    withheldAmount: withheld && withheld.length >= 8 ? new DataView(withheld.buffer, withheld.byteOffset).getBigUint64(0, true) : 0n,
    confidentialBalance: nonZero(confidential, 33, 225) || nonZero(confidentialFee, 0, 64),
  }
}

interface RawTokenAccount {
  pubkey: string
  account: { data: [string, string]; owner: string; lamports: number | string }
}

interface Found {
  address: string
  program: string
  lamports: bigint
  parsed: ParsedAccount
}

/**
 * 查一个地址的代币账户给出的授权，和可以关闭回收租金的空账户（结果按账户，同一账户的授权和关闭状态在一起）。
 * 传 mints 时读这些代币的 ATA（一次 getMultipleAccounts，免费公共节点也能用）；不传时列出全部代币账户（需要支持 getTokenAccountsByOwner 的节点）
 *
 * ```ts
 * await approvals(client, owner, { mints: [USDC, BONK] })
 * // [{ account: '…', mint: USDC, delegate: 'JUP…', delegatedAmount: '1000000', revocable: true, closable: false, closeBlocker: 'balance', … }]
 * await approvals(new SolanaClient('https://my-rpc…'), owner)   // 全部代币账户
 * ```
 */
export async function approvals(client: SolanaClient, owner: string, query: ApprovalsQuery = {}): Promise<TokenAccountApproval[]> {
  if (!isAddress(owner)) {
    throw new Error(`Invalid owner address: ${owner}`)
  }
  const { signal } = query
  const found = query.mints ? await ataAccounts(client, owner, query.mints, signal) : await listAccounts(client, owner, signal)
  // 只看 owner 自己的账户（ATA 的 owner 可能被改过：SPL Token 的 ATA 能 SetAuthority 换 owner）
  const mine = found.filter((f) => f.parsed.owner === owner)
  const mints = [...new Set(mine.map((f) => f.parsed.mint))]
  const metaAddresses = mints.flatMap((m) => [m, getMetadataAddress(m)])
  const metaAccounts = metaAddresses.length ? await client.accounts(metaAddresses, { signal }) : []
  const meta = new Map(mints.map((mint, i) => [mint, mintMeta(metaAccounts[2 * i] ?? null, metaAccounts[2 * i + 1] ?? null)]))

  const list = mine.map((f): TokenAccountApproval => {
    const p = f.parsed
    const m = meta.get(p.mint) ?? { decimals: null, symbol: null, permanentDelegate: null }
    const format = (v: bigint) => (m.decimals === null ? null : formatUnits(v, m.decimals))
    const closeBlocker: CloseBlocker | null =
      p.closeAuthority !== null && p.closeAuthority !== owner ? 'close-authority' : !p.native && p.amount > 0n ? 'balance' : p.confidentialBalance ? 'confidential-balance' : null
    return {
      account: f.address,
      mint: p.mint,
      owner: p.owner,
      tokenProgram: f.program,
      ata: getAssociatedTokenAddress(owner, p.mint, f.program) === f.address,
      native: p.native,
      symbol: m.symbol,
      decimals: m.decimals,
      amount: p.amount.toString(),
      formatted: format(p.amount),
      delegate: p.delegate,
      delegatedAmount: p.delegatedAmount.toString(),
      delegatedFormatted: format(p.delegatedAmount),
      closeAuthority: p.closeAuthority,
      permanentDelegate: m.permanentDelegate,
      frozen: p.frozen,
      lamports: f.lamports.toString(),
      withheldAmount: p.withheldAmount.toString(),
      revocable: p.delegate !== null && !p.frozen,
      closable: closeBlocker === null,
      closeBlocker,
    }
  })
  return query.all ? list : list.filter((a) => a.delegate !== null || a.closeBlocker === 'close-authority' || BigInt(a.amount) === 0n)
}

/** 指定 mints：两个程序的 ATA 都读（mint 所属程序未知时只有一个存在） */
async function ataAccounts(client: SolanaClient, owner: string, mints: readonly string[], signal: AbortSignal | undefined): Promise<Found[]> {
  const targets = [...new Set(mints.filter((m) => isAddress(m)))].flatMap((mint) =>
    [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((program) => ({ program, address: getAssociatedTokenAddress(owner, mint, program) })),
  )
  const accounts = targets.length ? await client.accounts(targets.map((t) => t.address), { signal }) : []
  return targets.flatMap((t, i) => {
    const account = accounts[i]
    const parsed = account && account.owner === t.program ? parseTokenAccountState(account.data) : null
    return parsed && account ? [{ address: t.address, program: t.program, lamports: account.lamports, parsed }] : []
  })
}

/** 不传 mints：用 getTokenAccountsByOwner 列出两个程序的全部代币账户（base64，自己解析扩展） */
async function listAccounts(client: SolanaClient, owner: string, signal: AbortSignal | undefined): Promise<Found[]> {
  const lists = await Promise.all(
    [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
      client.request<{ value: RawTokenAccount[] }>('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'base64', commitment: client.commitment }], { signal }).then(
        (res) => ({ programId, value: res.value ?? [] }),
      ),
    ),
  ).catch((err: unknown) => {
    if (signal?.aborted || !methodUnavailable(err)) {
      throw err // 取消、限频、超时等原样抛出（保留错误类型）
    }
    throw new Error(
      `Listing the token accounts of ${owner} failed (${err instanceof Error ? err.message : String(err)}). ` +
        'Listing needs getTokenAccountsByOwner (most free public nodes do not support it): pass the mints in `mints`, or use a node that supports it',
      { cause: err },
    )
  })
  return lists.flatMap(({ programId, value }) =>
    value.flatMap((entry) => {
      const parsed = entry.account.owner === programId ? parseTokenAccountState(base64.decode(entry.account.data[0])) : null
      return parsed ? [{ address: entry.pubkey, program: programId, lamports: BigInt(entry.account.lamports), parsed }] : []
    }),
  )
}

/** mint 的精度、symbol（Token-2022 TokenMetadata 扩展或 Metaplex 元数据）、永久授权 */
function mintMeta(mint: AccountInfo | null, metadata: AccountInfo | null): { decimals: number | null; symbol: string | null; permanentDelegate: string | null } {
  if (!mint) {
    return { decimals: null, symbol: null, permanentDelegate: null }
  }
  let decimals: number | null = null
  let symbol: string | null = null
  try {
    const info = parseMint(mint.data)
    decimals = info.decimals
    symbol = info.metadata?.symbol || null
  } catch {
    // 不是 mint
  }
  if (!symbol && metadata) {
    try {
      symbol = parseMetaplexMetadata(metadata.data).symbol || null
    } catch {
      // 元数据格式不对
    }
  }
  const ext = findExtension(mint.data, EXT_PERMANENT_DELEGATE)
  const delegate = ext && ext.length >= 32 ? encodeAddress(ext.slice(0, 32)) : null
  return { decimals, symbol, permanentDelegate: delegate && delegate !== ZERO_PUBKEY ? delegate : null }
}

// ---------------------------------------------------------------------------
// 撤销、关闭
// ---------------------------------------------------------------------------

/** 一个账户要执行的指令（作为 batchCall 的一个调用，原子执行） */
export interface ApprovalCall {
  /** revoke：撤销 delegate；close：关闭账户（有暂存的转账手续费时先收到 mint 上） */
  kind: 'revoke' | 'close'
  account: string
  /** 要签名的地址（代币账户的 owner） */
  owner: string
  instructions: Instruction[]
  approval: TokenAccountApproval
}

/** 撤销授权的指令：每个有 delegate、没有冻结的账户一条 Revoke；其他的跳过 */
export function buildRevokes(list: readonly TokenAccountApproval[]): ApprovalCall[] {
  return list
    .filter((a) => a.revocable)
    .map((a) => ({ kind: 'revoke', account: a.account, owner: a.owner, instructions: [revoke(a.account, a.owner, a.tokenProgram)], approval: a }))
}

export interface BuildClosesOptions {
  /** 租金（和 Wrapped SOL 包装的 SOL）退给谁，默认账户的 owner */
  destination?: string
}

/**
 * 关闭账户的指令：每个 closable 的账户一条 CloseAccount（关闭同时去掉授权）；Token-2022 账户里有暂存的转账手续费时，
 * 先加一条 HarvestWithheldTokensToMint（不需要签名）。关不掉的跳过。
 * 注意 Wrapped SOL 账户有余额时也能关闭（余额作为 SOL 退回 destination）：只想回收空账户时先按 amount 过滤
 */
export function buildCloses(list: readonly TokenAccountApproval[], options: BuildClosesOptions = {}): ApprovalCall[] {
  if (options.destination !== undefined && !isAddress(options.destination)) {
    throw new Error(`Invalid destination: ${options.destination}`)
  }
  return list
    .filter((a) => a.closable)
    .map((a) => ({
      kind: 'close',
      account: a.account,
      owner: a.owner,
      instructions: [
        ...(a.tokenProgram === TOKEN_2022_PROGRAM_ID && BigInt(a.withheldAmount) > 0n ? [harvestWithheldTokensToMint(a.mint, [a.account])] : []),
        closeAccount(a.account, options.destination ?? a.owner, a.owner, a.tokenProgram),
      ],
      approval: a,
    }))
}

export interface ApprovalResult extends WriteResult {
  kind: ApprovalCall['kind']
  account: string
  approval: TokenAccountApproval
}

export interface CloseAccountsOptions extends BatchCallOptions, BuildClosesOptions {}

/**
 * 撤销授权：构建（同 buildRevokes）后用 owner 签名发送，钱包和选项同 batchCall（多个账户打包进同一笔交易，feePayer 可以替 owner 付手续费）。
 * 默认一个失败不影响后面的（continueOnError: true）；结果与构建出的调用一一对应
 *
 * ```ts
 * const list = await approvals(client, owner, { mints })
 * await revokeApprovals(client, key, list)
 * ```
 */
export function revokeApprovals(client: SolanaClient, from: SignerInput, list: readonly TokenAccountApproval[], options: BatchCallOptions = {}): Promise<ApprovalResult[]> {
  return send(client, from, buildRevokes(list), options)
}

/**
 * 关闭代币账户回收租金（同 buildCloses），发送同 revokeApprovals。
 *
 * ```ts
 * const empty = (await approvals(client, owner, { mints })).filter((a) => a.amount === '0')
 * await closeTokenAccounts(client, key, empty)   // 租金退回 owner
 * ```
 */
export function closeTokenAccounts(client: SolanaClient, from: SignerInput, list: readonly TokenAccountApproval[], options: CloseAccountsOptions = {}): Promise<ApprovalResult[]> {
  const { destination, ...rest } = options
  return send(client, from, buildCloses(list, { destination }), rest)
}

async function send(client: SolanaClient, from: SignerInput, calls: readonly ApprovalCall[], options: BatchCallOptions): Promise<ApprovalResult[]> {
  if (!calls.length) return []
  // 发送的代码按需加载：只查授权时打包不会带上
  const [{ batchCall }, { resolveSigner }] = await Promise.all([import('./write/batch.js'), import('./write/signer.js')])
  const { address } = await resolveSigner(from)
  const other = calls.find((c) => c.owner !== address)
  if (other) {
    throw new Error(`Token account ${other.account} belongs to ${other.owner}, not the signer ${address}`)
  }
  const results = await batchCall(
    client,
    calls.map((c) => ({ from, instructions: c.instructions })),
    { continueOnError: true, ...options },
  )
  return results.map((r, i) => {
    const call = calls[i] as ApprovalCall
    return { ...r, kind: call.kind, account: call.account, approval: call.approval }
  })
}
