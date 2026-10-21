/**
 * 授权管理（子路径 `@w3lib/evm-batch-call/approvals`）：批量查一个地址给出的授权——ERC20 额度、Permit2 额度（含过期时间）、
 * NFT 的 setApprovalForAll；按 Approval 事件增量发现授权过的代币；批量撤销（approve 0、Permit2 lockdown、setApprovalForAll false）
 */
import { Interface } from 'ethers'

import { formatUnits } from './erc20.js'
import { LP_PROTOCOLS } from './lp.js'
import type { Provider } from './provider.js'
import { runLogScan, type LogScanProgress } from './scan.js'
import { isTronChain, toEvmAddress, toTronAddress } from './tron.js'
import type { BatchCallOptions } from './write/batch.js'
import type { WriteResult } from './write/send.js'
import type { SignerInput } from './write/signer.js'

/** Uniswap 的 Permit2（各 EVM 链上地址相同；Tron 上没有） */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

/** 已知的被授权方（显示名称用；也是 approvals 默认检查的范围） */
export interface KnownSpender {
  address: string
  name: string
  /** 'erc20'：代币授权的对象（Router、聚合器）；'nft'：NFT 市场的 operator */
  kind: 'erc20' | 'nft'
}

const erc20 = (address: string, name: string): KnownSpender => ({ address, name, kind: 'erc20' })
const nft = (address: string, name: string): KnownSpender => ({ address, name, kind: 'nft' })

/** 多条链上地址相同的合约（CREATE2 部署） */
const EVERYWHERE: readonly KnownSpender[] = [
  erc20(PERMIT2_ADDRESS, 'Uniswap Permit2'),
  erc20('0x111111125421cA6dc452d289314280a0f8842A65', '1inch Router v6'),
  erc20('0x1111111254EEB25477B68fb85Ed929f73A960582', '1inch Router v5'),
  erc20('0x6A000F20005980200259B80c5102003040001068', 'ParaSwap Augustus v6.2'),
  erc20('0x0000000000001fF3684f28c67538d4D072C22734', '0x AllowanceHolder'),
  nft('0x1E0049783F008A0085193E00003D00cd54003c71', 'OpenSea Seaport Conduit'),
]

/** 各链的 Router（不含 LP_PROTOCOLS 里已有的 V2 Router、仓位合约，它们自动加入）。2026-10 在链上核对过有合约 */
const BY_CHAIN: Readonly<Record<number, readonly KnownSpender[]>> = {
  1: [
    erc20('0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', 'Uniswap SwapRouter02'),
    erc20('0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af', 'Uniswap Universal Router'),
    erc20('0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', 'Uniswap Universal Router (old)'),
    erc20('0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', 'PancakeSwap Smart Router'),
    erc20('0xDef1C0ded9bec7F1a1670819833240f027b25EfF', '0x Exchange Proxy'),
    erc20('0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57', 'ParaSwap Augustus v5'),
    nft('0x00000000000111AbE46ff893f3B2fdF1F759a8A8', 'Blur Execution Delegate'),
  ],
  56: [
    erc20('0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2', 'Uniswap SwapRouter02'),
    erc20('0x1906c1d672b88cD1B9aC7593301cA990F94Eae07', 'Uniswap Universal Router'),
    erc20('0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', 'PancakeSwap Smart Router'),
    erc20('0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB', 'PancakeSwap Universal Router'),
    erc20('0xDef1C0ded9bec7F1a1670819833240f027b25EfF', '0x Exchange Proxy'),
    erc20('0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57', 'ParaSwap Augustus v5'),
  ],
  8453: [
    erc20('0x2626664c2603336E57B271c5C0b26F421741e481', 'Uniswap SwapRouter02'),
    erc20('0x6fF5693b99212Da76ad316178A184AB56D299b43', 'Uniswap Universal Router'),
    erc20('0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86', 'PancakeSwap Smart Router'),
  ],
  42161: [
    erc20('0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', 'Uniswap SwapRouter02'),
    erc20('0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3', 'Uniswap Universal Router'),
    erc20('0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57', 'ParaSwap Augustus v5'),
  ],
  10: [
    erc20('0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', 'Uniswap SwapRouter02'),
    erc20('0x851116D9223fabED8E56C0E6b8Ad0c31d98B3507', 'Uniswap Universal Router'),
    erc20('0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57', 'ParaSwap Augustus v5'),
  ],
  137: [
    erc20('0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', 'Uniswap SwapRouter02'),
    erc20('0x1095692A6237d83C6a72F3F5eFEdb9A670C49223', 'Uniswap Universal Router'),
    erc20('0xDef1C0ded9bec7F1a1670819833240f027b25EfF', '0x Exchange Proxy'),
    erc20('0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57', 'ParaSwap Augustus v5'),
  ],
  43114: [
    erc20('0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE', 'Uniswap SwapRouter02'),
    erc20('0x94b75331AE8d42C1b61065089B7d48FE14aA73b7', 'Uniswap Universal Router'),
    erc20('0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57', 'ParaSwap Augustus v5'),
  ],
}

/**
 * 这条链上已知的被授权方：内置协议表的 V2 Router、V3 / V4 仓位合约，各链的 Router / 聚合器，NFT 市场。
 * Tron 上只有协议表里的 SunSwap 合约（没有 Permit2）
 */
export function knownSpenders(chainId: number): KnownSpender[] {
  const tron = isTronChain(chainId)
  const fromLp = LP_PROTOCOLS.filter((p) => p.chainId === chainId).flatMap((p) => [
    ...(p.router ? [erc20(p.router, `${p.name} Router`)] : []),
    // V3 / V4 仓位合约：代币授权（添加流动性）
    ...(p.positionManager ? [erc20(p.positionManager, `${p.name} Positions`)] : []),
  ])
  const list = [...fromLp, ...(tron ? [] : EVERYWHERE), ...(BY_CHAIN[chainId] ?? [])]
  const seen = new Set<string>()
  return list.filter((s) => {
    const k = `${s.kind}:${keyOf(chainId, s.address)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** 地址的比较键：EVM 小写 0x；Tron 是 T 开头的 base58 */
const keyOf = (chainId: number, address: string) => (isTronChain(chainId) ? toTronAddress(address) : address.toLowerCase())

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export interface ApprovalsQuery {
  /** 要检查的 ERC20 代币（如持有的代币，或 scanApprovals 发现的） */
  tokens?: readonly string[]
  /** 被授权方：地址或 KnownSpender，默认 knownSpenders(chainId) 里 kind 为 erc20 的 */
  spenders?: ReadonlyArray<string | KnownSpender>
  /** 直接给出要检查的 代币 × 被授权方（和 tokens × spenders 合并） */
  pairs?: ReadonlyArray<{ token: string; spender: string }>
  /** 也检查 Permit2 的额度（代币 × 被授权方，Tron 上没有），默认 true */
  permit2?: boolean
  /** 要检查 setApprovalForAll 的 NFT 合约（ERC721 / ERC1155） */
  nfts?: readonly string[]
  /** NFT 的 operator，默认 knownSpenders 里 kind 为 nft 的 */
  operators?: ReadonlyArray<string | KnownSpender>
  /** 直接给出要检查的 NFT 合约 × operator */
  nftPairs?: ReadonlyArray<{ collection: string; operator: string }>
  /** 也返回额度为 0 / 已过期 / 未授权的项，默认 false（只返回有效的授权） */
  includeZero?: boolean
}

interface ApprovalBase {
  /** 被授权方（spender / operator）和它的名称（不在已知列表里时为 null） */
  spender: string
  spenderName: string | null
}

export interface Erc20Approval extends ApprovalBase {
  type: 'erc20'
  token: string
  symbol: string | null
  decimals: number | null
  /** 额度（最小单位） */
  amount: string
  /** 按精度换算的额度；精度读不到时为 null */
  formatted: string | null
  /** 额度 ≥ 2^96（无限授权，包括 MaxUint256 和截断为 uint96 的代币） */
  unlimited: boolean
}

export interface Permit2Approval extends ApprovalBase {
  type: 'permit2'
  token: string
  symbol: string | null
  decimals: number | null
  amount: string
  formatted: string | null
  unlimited: boolean
  /** 过期时间（unix 秒）；过期后额度不能再用 */
  expiration: number
  expired: boolean
  nonce: number
}

export interface NftApproval extends ApprovalBase {
  type: 'nft'
  collection: string
  /** setApprovalForAll 的状态（includeZero 时也返回 false 的项） */
  approved: boolean
}

export type Approval = Erc20Approval | Permit2Approval | NftApproval

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]
const PERMIT2_ABI = ['function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)']
const NFT_ABI = ['function isApprovedForAll(address owner, address operator) view returns (bool)']
const UNLIMITED = 2n ** 96n

/**
 * 查一个地址给出的授权（全部读取合成一次 multicall）。默认检查已知的 Router / 聚合器 / NFT 市场，
 * 代币要自己给（如持有的代币，或用 scanApprovals 按事件发现）。
 *
 * ```ts
 * await approvals(provider, user, { tokens: [USDT, USDC] })                         // 对已知的被授权方
 * await approvals(provider, user, { pairs: [{ token: USDT, spender: someContract }] })
 * await approvals(provider, user, { nfts: [BAYC] })                                 // NFT 市场的 setApprovalForAll
 * ```
 */
export async function approvals(provider: Provider, owner: string, query: ApprovalsQuery): Promise<Approval[]> {
  const chainId = await provider.getChainId()
  const tron = isTronChain(chainId)
  const key = (a: string) => keyOf(chainId, a)
  const known = knownSpenders(chainId)
  const names = new Map(known.map((s) => [key(s.address), s.name]))
  const addressOf = (s: string | KnownSpender) => {
    if (typeof s !== 'string') names.set(key(s.address), s.name)
    return typeof s === 'string' ? s : s.address
  }
  const spenders = (query.spenders ?? known.filter((s) => s.kind === 'erc20')).map(addressOf)
  const operators = (query.operators ?? known.filter((s) => s.kind === 'nft')).map(addressOf)

  const pairs = dedupe([...(query.tokens ?? []).flatMap((token) => spenders.map((spender) => ({ token, spender }))), ...(query.pairs ?? [])], (p) => `${key(p.token)}:${key(p.spender)}`)
  const nftPairs = dedupe(
    [...(query.nfts ?? []).flatMap((collection) => operators.map((operator) => ({ collection, operator }))), ...(query.nftPairs ?? [])],
    (p) => `${key(p.collection)}:${key(p.operator)}`,
  )
  // Permit2 的额度：被授权方是 Permit2 自己的没有意义（ERC20 授权给 Permit2 才有意义），不查
  const permitPairs = (query.permit2 ?? true) && !tron ? pairs.filter((p) => key(p.spender) !== key(PERMIT2_ADDRESS)) : []
  const tokens = dedupe(
    pairs.map((p) => p.token),
    key,
  )

  const calls = [
    ...pairs.map((p) => provider.contract(p.token, ERC20_ABI).allowance(owner, p.spender)),
    ...permitPairs.map((p) => provider.contract(PERMIT2_ADDRESS, PERMIT2_ABI).allowance(owner, p.token, p.spender)),
    ...tokens.flatMap((t) => [provider.contract(t, ERC20_ABI).decimals(), provider.contract(t, ERC20_ABI).symbol()]),
    ...nftPairs.map((p) => provider.contract(p.collection, NFT_ABI).isApprovedForAll(owner, p.operator)),
  ]
  const results = calls.length ? await provider.tryAll(calls) : []
  let i = 0
  const allowances = results.slice(i, (i += pairs.length)) as Array<bigint | null>
  const permits = new Map(permitPairs.map((p, j) => [p, results[i + j] as { 0: bigint; 1: bigint; 2: bigint } | null]))
  i += permitPairs.length
  const meta = new Map<string, { decimals: number | null; symbol: string | null }>()
  for (const t of tokens) {
    const [decimals, symbol] = results.slice(i, (i += 2)) as [bigint | null, string | null]
    meta.set(key(t), { decimals: decimals === null ? null : Number(decimals), symbol: typeof symbol === 'string' ? symbol : null })
  }
  const nftStates = results.slice(i) as Array<boolean | null>

  const now = Math.floor(Date.now() / 1000)
  const out: Approval[] = []
  pairs.forEach((p, j) => {
    const m = meta.get(key(p.token)) ?? { decimals: null, symbol: null }
    const base = { spender: p.spender, spenderName: names.get(key(p.spender)) ?? null, token: p.token, symbol: m.symbol, decimals: m.decimals }
    const amount = allowances[j]
    if (amount !== null && amount !== undefined && (amount > 0n || query.includeZero)) {
      out.push({ type: 'erc20', ...base, amount: amount.toString(), formatted: m.decimals === null ? null : formatUnits(amount, m.decimals), unlimited: amount >= UNLIMITED })
    }
    const permit = permits.get(p)
    if (permit) {
      const [value, expiration, nonce] = [permit[0], Number(permit[1]), Number(permit[2])]
      // Permit2 在 block.timestamp > expiration 时才拒绝
      const expired = expiration < now
      if ((value > 0n && !expired) || query.includeZero) {
        out.push({
          type: 'permit2',
          ...base,
          amount: value.toString(),
          formatted: m.decimals === null ? null : formatUnits(value, m.decimals),
          unlimited: value >= UNLIMITED,
          expiration,
          expired,
          nonce,
        })
      }
    }
  })
  nftPairs.forEach((p, j) => {
    const approved = nftStates[j]
    if (approved === true || (approved === false && query.includeZero)) {
      out.push({ type: 'nft', collection: p.collection, spender: p.operator, spenderName: names.get(key(p.operator)) ?? null, approved })
    }
  })
  return out
}

function dedupe<T>(list: readonly T[], keyFn: (x: T) => string): T[] {
  const seen = new Map<string, T>()
  for (const x of list) if (!seen.has(keyFn(x))) seen.set(keyFn(x), x)
  return [...seen.values()]
}

// ---------------------------------------------------------------------------
// 按事件发现
// ---------------------------------------------------------------------------

/** Approval(address indexed owner, address indexed spender, uint256)：ERC20（3 个 topic）和 ERC721 单个 NFT（4 个 topic）相同 */
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'
/** ApprovalForAll(address indexed owner, address indexed operator, bool) */
const APPROVAL_FOR_ALL_TOPIC = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31'
/** Permit2 的 Approval(address indexed owner, address indexed token, address indexed spender, uint160, uint48)：直接调用 approve */
const PERMIT2_APPROVAL_TOPIC = '0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b'
/** Permit2 的 Permit(address indexed owner, address indexed token, address indexed spender, uint160, uint48, uint48)：签名授权（Universal Router 等大多用它） */
const PERMIT2_PERMIT_TOPIC = '0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec'

export interface ApprovalScanOptions {
  /** 从哪个区块开始扫（不传时从 当前区块 − lookbackBlocks 开始）；有保存的进度时从进度继续 */
  fromBlock?: number
  /** 不传 fromBlock 时往回扫多少个区块，默认 0（只发现开始扫描之后的授权） */
  lookbackBlocks?: number
  /** 上次的进度（scanApprovals 返回的 progress），传了就接着扫 */
  progress?: ApprovalScanProgress
  /** 单次 getLogs 的最大区块范围，默认 1000；节点有上限时自动缩小 */
  blockRange?: number
  /** 这次最多发多少个 getLogs（三种事件合计），默认 30 */
  maxRequests?: number
  /** 这次最多花多少毫秒，默认 10000 */
  timeBudget?: number
  signal?: AbortSignal
}

/** 扫描进度：可以 JSON 序列化后保存，下次传回 progress 接着扫 */
export interface ApprovalScanProgress {
  erc20: LogScanProgress | null
  nft: LogScanProgress | null
  permit2: LogScanProgress | null
}

export interface ApprovalScanResult {
  /** 发现的 代币 × 被授权方（ERC20 的 Approval 事件和 Permit2 的 Approval 事件） */
  pairs: Array<{ token: string; spender: string }>
  /** 发现的 NFT 合约 × operator（ApprovalForAll 事件） */
  nftPairs: Array<{ collection: string; operator: string }>
  /** 已扫到的区块（三种事件里最慢的那个） */
  cursor: number
  progress: ApprovalScanProgress
}

/**
 * 按事件发现地址授权过的代币和 NFT 合约（只发现，不判断是否还有效：把结果的 pairs / nftPairs 交给 approvals 查当前状态）。
 * 需要节点支持 eth_getLogs；免费公共节点的范围限制很严（如 BSC 每次 25 个区块），从很早的区块扫全部历史不现实，
 * 适合从某个时间点开始增量扫描（保存 progress，下次接着扫）。Tron 不支持
 *
 * ```ts
 * let { pairs, nftPairs, progress } = await scanApprovals(provider, user, { lookbackBlocks: 50_000 })
 * const list = await approvals(provider, user, { pairs, nftPairs, spenders: [] })
 * // 之后：await scanApprovals(provider, user, { progress })
 * ```
 */
export async function scanApprovals(provider: Provider, owner: string, options: ApprovalScanOptions = {}): Promise<ApprovalScanResult> {
  const chainId = await provider.getChainId()
  if (isTronChain(chainId)) throw new Error('scanApprovals is not supported on Tron (no eth_getLogs)')
  const ownerTopic = `0x${toEvmAddress(owner).slice(2).toLowerCase().padStart(64, '0')}`
  const addr = (topic: string | undefined) => (topic ? `0x${topic.slice(26)}` : null)
  const lookback = Math.max(0, Math.floor(options.lookbackBlocks ?? 0))
  const maxRequests = Math.max(3, Math.floor(options.maxRequests ?? 30))
  const timeBudget = options.timeBudget ?? 10_000
  const base = {
    provider,
    initialCursor: (target: number) => (options.fromBlock !== undefined ? options.fromBlock - 1 : target - lookback),
    maxRange: Math.max(1, Math.floor(options.blockRange ?? 1000)),
    maxRequests: Math.ceil(maxRequests / 3),
    timeBudget,
    confirmations: 0,
    ...(options.signal ? { signal: options.signal } : {}),
  }
  const [erc20Progress, nftProgress, permit2Progress] = await Promise.all([
    runLogScan({
      ...base,
      saved: options.progress?.erc20 ?? undefined,
      filter: { topics: [APPROVAL_TOPIC, ownerTopic] },
      // ERC721 的单个 NFT 授权也是这个事件（4 个 topic），不是代币额度，跳过
      collect: (log) => (log.topics.length === 3 ? `${log.address.toLowerCase()}:${addr(log.topics[2])}` : null),
    }),
    runLogScan({
      ...base,
      saved: options.progress?.nft ?? undefined,
      filter: { topics: [APPROVAL_FOR_ALL_TOPIC, ownerTopic] },
      collect: (log) => `${log.address.toLowerCase()}:${addr(log.topics[2])}`,
    }),
    runLogScan({
      ...base,
      saved: options.progress?.permit2 ?? undefined,
      // 两种事件的 topic0 不同：按 owner 过滤 Permit2 的全部事件，只收这两种（Lockdown 等其他事件的 owner 也在 topic1）
      filter: { address: PERMIT2_ADDRESS, topics: [null, ownerTopic] },
      collect: (log) => (log.topics[0] === PERMIT2_APPROVAL_TOPIC || log.topics[0] === PERMIT2_PERMIT_TOPIC ? `${addr(log.topics[2])}:${addr(log.topics[3])}` : null),
    }),
  ])
  const split = (item: string) => item.split(':') as [string, string]
  const pairs = dedupe(
    [...(erc20Progress?.items ?? []), ...(permit2Progress?.items ?? [])].map((item) => {
      const [token, spender] = split(item)
      return { token, spender }
    }),
    (p) => `${p.token}:${p.spender}`,
  )
  const nftPairs = (nftProgress?.items ?? []).map((item) => {
    const [collection, operator] = split(item)
    return { collection, operator }
  })
  const cursors = [erc20Progress, nftProgress, permit2Progress].map((p) => p?.cursor ?? -1)
  return { pairs, nftPairs, cursor: Math.min(...cursors), progress: { erc20: erc20Progress, nft: nftProgress, permit2: permit2Progress } }
}

// ---------------------------------------------------------------------------
// 撤销
// ---------------------------------------------------------------------------

export interface RevokeTx {
  /** approve：ERC20 额度改为 0；lockdown：Permit2 的额度一次清零（一笔交易包含多个）；setApprovalForAll：NFT 取消授权 */
  kind: 'approve' | 'lockdown' | 'setApprovalForAll'
  to: string
  data: string
  value: '0'
  /** 这笔交易撤销的授权 */
  approvals: Approval[]
}

const erc20Interface = new Interface(['function approve(address spender, uint256 amount) returns (bool)'])
const permit2Interface = new Interface(['function lockdown((address token, address spender)[] approvals)'])
const nftInterface = new Interface(['function setApprovalForAll(address operator, bool approved)'])

/**
 * 撤销授权要发的交易（不签名）：ERC20 每个一笔 approve(spender, 0)；Permit2 的全部合成一笔 lockdown；NFT 每个一笔 setApprovalForAll(false)。
 * Tron 上 to 是 T 地址
 */
export function buildRevokes(list: readonly Approval[], chainId?: number): RevokeTx[] {
  const tron = chainId !== undefined && isTronChain(chainId)
  const to = (a: string) => (tron ? toTronAddress(a) : a)
  const hex = (a: string) => toEvmAddress(a)
  const txs: RevokeTx[] = []
  const permits = list.filter((a): a is Permit2Approval => a.type === 'permit2')
  for (const a of list) {
    if (a.type === 'erc20') txs.push({ kind: 'approve', to: to(a.token), data: erc20Interface.encodeFunctionData('approve', [hex(a.spender), 0n]), value: '0', approvals: [a] })
    if (a.type === 'nft') txs.push({ kind: 'setApprovalForAll', to: to(a.collection), data: nftInterface.encodeFunctionData('setApprovalForAll', [hex(a.spender), false]), value: '0', approvals: [a] })
  }
  if (permits.length) {
    txs.push({
      kind: 'lockdown',
      to: PERMIT2_ADDRESS,
      data: permit2Interface.encodeFunctionData('lockdown', [permits.map((p) => ({ token: hex(p.token), spender: hex(p.spender) }))]),
      value: '0',
      approvals: permits,
    })
  }
  return txs
}

export interface RevokeResult extends WriteResult {
  kind: RevokeTx['kind']
  approvals: Approval[]
}

/**
 * 撤销授权：构建（同 buildRevokes）后用 from 签名发送，钱包和选项同 batchCall（mode: '7702' 时同一钱包的撤销合成一笔交易）。
 * 默认一笔失败不影响后面的（continueOnError: true）
 *
 * ```ts
 * const list = await approvals(provider, user, { tokens })
 * await revokeApprovals(provider, key, list.filter((a) => a.unlimited))
 * ```
 */
export async function revokeApprovals(provider: Provider, from: SignerInput, list: readonly Approval[], options: BatchCallOptions = {}): Promise<RevokeResult[]> {
  const txs = buildRevokes(list, await provider.getChainId())
  if (!txs.length) return []
  // 发送的代码按需加载：只查授权时打包不会带上
  const { batchCall } = await import('./write/batch.js')
  const results = await batchCall(
    provider,
    txs.map((tx) => ({ from, to: tx.to, data: tx.data })),
    { continueOnError: true, ...options },
  )
  return results.map((r, i) => ({ ...r, kind: (txs[i] as RevokeTx).kind, approvals: (txs[i] as RevokeTx).approvals }))
}
