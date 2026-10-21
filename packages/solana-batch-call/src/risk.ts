/**
 * 代币风险检查（子路径 `@w3lib/solana-batch-call/risk`）：mint 的权限（还能不能增发、能不能冻结持有人）和 Token-2022 扩展里
 * 影响持有人的设置（转账手续费、永久授权、转账 hook、不可转让、新账户默认冻结、可暂停、保密转账、mint 可关闭等），一次 getMultipleAccounts 读完。
 * 可选：持币集中度（getTokenLargestAccounts，免费公共节点大多不支持）；能不能买、能不能卖用 tradeChecks（在主网模拟“买入 → 卖出”）
 */
import { isAddress } from './address.js'
import type { RequestOptions, SolanaClient } from './client.js'
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants.js'
import { findExtension, parseMint, parseTransferFeeConfig, type AccountInfo } from './layout.js'
import { Bytes } from './lp.js'
import { CLOCK_SYSVAR_ID, parseClock } from './swap/common.js'

/** Token-2022 扩展的类型编号（spl-token-2022 ExtensionType） */
const EXT = {
  transferFeeConfig: 1,
  mintCloseAuthority: 3,
  confidentialTransferMint: 4,
  defaultAccountState: 6,
  nonTransferable: 9,
  interestBearingConfig: 10,
  permanentDelegate: 12,
  transferHook: 14,
  scaledUiAmount: 25,
  pausable: 26,
  permissionedBurn: 28,
} as const

const ZERO = '11111111111111111111111111111111'
const key = (b: Bytes, o: number) => {
  const k = b.key(o)
  return k === ZERO ? null : k
}

export interface SolanaTokenRisk {
  mint: string
  /** mint 账户存在且是 SPL Token / Token-2022 的 mint */
  exists: boolean
  program: 'spl-token' | 'token-2022' | null
  decimals: number | null
  /** 总量（最小单位） */
  supply: string | null
  /** 增发权限：不为 null 时还能继续增发 */
  mintAuthority: string | null
  /** 冻结权限：不为 null 时可以冻结任何持有人的代币账户 */
  freezeAuthority: string | null
  /** Token-2022 转账手续费（当前 epoch 生效的）；authority 不为 null 时费率还能改（新费率两个 epoch 后生效） */
  transferFee: { basisPoints: number; maximumFee: string; authority: string | null; next: { basisPoints: number; maximumFee: string; epoch: string } | null } | null
  /** 永久授权：这个地址可以转走 / 销毁任何持有人的代币 */
  permanentDelegate: string | null
  /** 转账 hook：每次转账都会调用这个程序（可以拒绝转账）；authority 不为 null 时程序还能换 */
  transferHook: { program: string | null; authority: string | null } | null
  /** 不可转让（灵魂绑定） */
  nonTransferable: boolean
  /** 新建的代币账户默认是冻结的（要冻结权限解冻后才能用） */
  defaultFrozen: boolean
  /** 可暂停：authority 可以暂停全部转账、增发、销毁；paused 为当前状态 */
  pausable: { paused: boolean; authority: string | null } | null
  /** 保密转账（余额和转账数量加密） */
  confidentialTransfer: { authority: string | null; autoApprove: boolean } | null
  /** mint 关闭权限（总量为 0 时可以关闭 mint） */
  mintCloseAuthority: string | null
  /** 显示数量会随时间 / 系数变化（InterestBearingConfig、ScaledUiAmount），authority 可以改利率 / 系数 */
  uiAmountAuthority: string | null
  /** 只有这个地址能批准销毁（PermissionedBurn） */
  burnAuthority: string | null
  /** 持币集中度（concentration: true 时）：最大的 20 个代币账户里前 10 个占总量的比例；节点不支持或总量为 0 时为 null */
  topHolders: { top10Share: number; accounts: Array<{ address: string; amount: string; share: number }> } | null
  /**
   * 汇总的风险标记：not-found、mintable、freezable、transfer-fee（> 0）、high-transfer-fee（> 10%）、fee-changeable、permanent-delegate、
   * transfer-hook、non-transferable、default-frozen、pausable、paused、confidential-transfer、closable、ui-amount-changes、permissioned-burn、
   * concentrated（前 10 个账户 > 50%，含池子金库、交易所地址）
   */
  flags: string[]
}

export interface TokenRisksOptions extends RequestOptions {
  /** 查持币集中度（getTokenLargestAccounts，每个 mint 一次请求；免费公共节点大多不支持，不支持时 topHolders 为 null），默认 false */
  concentration?: boolean
}

/**
 * 检查代币的风险（mint 和 Clock 一次 getMultipleAccounts 读完）。原生 SOL（客户端的 nativeMints）按 Wrapped SOL 的 mint 查。
 *
 * ```ts
 * const [risk] = await tokenRisks(client, [PYUSD])
 * // { program: 'token-2022', mintAuthority: '22mK…', freezeAuthority: '2apB…', permanentDelegate: '2apB…', flags: ['mintable', 'freezable', 'permanent-delegate', …] }
 * ```
 */
export async function tokenRisks(client: SolanaClient, mints: readonly string[], options: TokenRisksOptions = {}): Promise<SolanaTokenRisk[]> {
  const keys = mints.map((m) => (client.isNativeMint(m) ? NATIVE_MINT : m))
  for (const m of keys) {
    if (!isAddress(m)) throw new Error(`Invalid mint address: ${m}`)
  }
  const unique = [...new Set(keys)]
  const accounts = await client.accounts([CLOCK_SYSVAR_ID, ...unique], { signal: options.signal })
  const clock = accounts[0]
  const epoch = clock ? parseClock(clock.data).epoch : null
  const byMint = new Map(unique.map((m, i) => [m, accounts[i + 1] ?? null]))
  const holders = options.concentration ? await largestAccounts(client, unique, options.signal) : new Map<string, Array<{ address: string; amount: bigint }> | null>()
  return mints.map((mint, i) => {
    const k = keys[i] as string
    const risk = parseRisk(mint, byMint.get(k) ?? null, epoch)
    const list = holders.get(k)
    if (list && risk.supply && BigInt(risk.supply) > 0n) {
      const supply = BigInt(risk.supply)
      const share = (a: bigint) => Number((a * 1_000_000n) / supply) / 1_000_000
      const sorted = [...list].sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0))
      risk.topHolders = {
        top10Share: share(sorted.slice(0, 10).reduce((s, a) => s + a.amount, 0n)),
        accounts: sorted.map((a) => ({ address: a.address, amount: a.amount.toString(), share: share(a.amount) })),
      }
      if (risk.topHolders.top10Share > 0.5) risk.flags.push('concentrated')
    }
    return risk
  })
}

async function largestAccounts(client: SolanaClient, mints: readonly string[], signal: AbortSignal | undefined) {
  const out = new Map<string, Array<{ address: string; amount: bigint }> | null>()
  await Promise.all(
    mints.map(async (mint) => {
      try {
        const res = await client.request<{ value: Array<{ address: string; amount: string }> }>('getTokenLargestAccounts', [mint, { commitment: client.commitment }], { signal })
        out.set(
          mint,
          res.value.map((a) => ({ address: a.address, amount: BigInt(a.amount) })),
        )
      } catch (err) {
        if (signal?.aborted) throw err
        out.set(mint, null) // 节点不支持
      }
    }),
  )
  return out
}

function empty(mint: string): SolanaTokenRisk {
  return {
    mint,
    exists: false,
    program: null,
    decimals: null,
    supply: null,
    mintAuthority: null,
    freezeAuthority: null,
    transferFee: null,
    permanentDelegate: null,
    transferHook: null,
    nonTransferable: false,
    defaultFrozen: false,
    pausable: null,
    confidentialTransfer: null,
    mintCloseAuthority: null,
    uiAmountAuthority: null,
    burnAuthority: null,
    topHolders: null,
    flags: ['not-found'],
  }
}

/** 解析一个 mint 账户的风险项（包内使用，测试也用）；epoch 用来选转账手续费的新旧配置（null 时按新配置） */
export function parseRisk(mint: string, account: AccountInfo | null, epoch: bigint | null): SolanaTokenRisk {
  if (!account || (account.owner !== TOKEN_PROGRAM_ID && account.owner !== TOKEN_2022_PROGRAM_ID)) return empty(mint)
  let info: ReturnType<typeof parseMint>
  try {
    info = parseMint(account.data)
  } catch {
    return empty(mint)
  }
  const risk: SolanaTokenRisk = {
    ...empty(mint),
    exists: true,
    program: account.owner === TOKEN_PROGRAM_ID ? 'spl-token' : 'token-2022',
    decimals: info.decimals,
    supply: info.supply.toString(),
    mintAuthority: info.mintAuthority,
    freezeAuthority: info.freezeAuthority,
    flags: [],
  }
  if (account.owner === TOKEN_2022_PROGRAM_ID) {
    const data = account.data
    const ext = (type: number) => findExtension(data, type)
    const fee = parseTransferFeeConfig(data)
    if (fee) {
      const current = epoch === null || epoch >= fee.newer.epoch ? fee.newer : fee.older
      const pending = epoch !== null && epoch < fee.newer.epoch ? fee.newer : null
      risk.transferFee = {
        basisPoints: current.basisPoints,
        maximumFee: current.maximumFee.toString(),
        authority: fee.transferFeeConfigAuthority,
        next: pending ? { basisPoints: pending.basisPoints, maximumFee: pending.maximumFee.toString(), epoch: pending.epoch.toString() } : null,
      }
    }
    const close = ext(EXT.mintCloseAuthority)
    if (close && close.length >= 32) risk.mintCloseAuthority = key(new Bytes(close), 0)
    const confidential = ext(EXT.confidentialTransferMint)
    if (confidential && confidential.length >= 33) risk.confidentialTransfer = { authority: key(new Bytes(confidential), 0), autoApprove: confidential[32] === 1 }
    const state = ext(EXT.defaultAccountState)
    // AccountState：0 未初始化、1 正常、2 冻结
    risk.defaultFrozen = !!state && state[0] === 2
    risk.nonTransferable = ext(EXT.nonTransferable) !== null
    const delegate = ext(EXT.permanentDelegate)
    if (delegate && delegate.length >= 32) risk.permanentDelegate = key(new Bytes(delegate), 0)
    const hook = ext(EXT.transferHook)
    if (hook && hook.length >= 64) {
      const b = new Bytes(hook)
      risk.transferHook = { authority: key(b, 0), program: key(b, 32) }
    }
    const pausable = ext(EXT.pausable)
    if (pausable && pausable.length >= 33) risk.pausable = { authority: key(new Bytes(pausable), 0), paused: pausable[32] === 1 }
    for (const type of [EXT.interestBearingConfig, EXT.scaledUiAmount]) {
      const e = ext(type)
      if (e && e.length >= 32) risk.uiAmountAuthority ??= key(new Bytes(e), 0) ?? null
    }
    const burn = ext(EXT.permissionedBurn)
    if (burn && burn.length >= 32) risk.burnAuthority = key(new Bytes(burn), 0)
  }
  risk.flags = flagsOf(risk)
  return risk
}

function flagsOf(r: SolanaTokenRisk): string[] {
  const flags: string[] = []
  if (r.mintAuthority) flags.push('mintable')
  if (r.freezeAuthority) flags.push('freezable')
  if (r.transferFee) {
    const bps = Math.max(r.transferFee.basisPoints, r.transferFee.next?.basisPoints ?? 0)
    if (bps > 0) flags.push('transfer-fee')
    if (bps > 1000) flags.push('high-transfer-fee')
    if (r.transferFee.authority) flags.push('fee-changeable')
  }
  if (r.permanentDelegate) flags.push('permanent-delegate')
  if (r.transferHook?.program || r.transferHook?.authority) flags.push('transfer-hook')
  if (r.nonTransferable) flags.push('non-transferable')
  if (r.defaultFrozen) flags.push('default-frozen')
  if (r.pausable) flags.push('pausable')
  if (r.pausable?.paused) flags.push('paused')
  if (r.confidentialTransfer) flags.push('confidential-transfer')
  if (r.mintCloseAuthority) flags.push('closable')
  if (r.uiAmountAuthority) flags.push('ui-amount-changes')
  if (r.burnAuthority) flags.push('permissioned-burn')
  return flags
}
