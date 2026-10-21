/**
 * 手续费估算（子路径 `@w3lib/evm-batch-call/fees`）：EIP-1559 的 baseFee 和三档优先费（按最近区块的 eth_feeHistory），
 * 一笔交易的手续费（含 OP Stack / Scroll 的 L1 数据费）；Tron 按能量 / 带宽和账户剩余的资源算要烧的 TRX
 */
import type { BigNumberish } from 'ethers'

import { getNativeCurrency } from './chains.js'
import { formatUnits } from './erc20.js'
import type { Provider } from './provider.js'
import { isTronChain } from './tron.js'

export type FeeLevel = 'slow' | 'normal' | 'fast'

/** 一档费用（wei 的十进制字符串）：EIP-1559 链是 maxFeePerGas / maxPriorityFeePerGas，legacy 链是 gasPrice */
export type FeeLevelEstimate = { maxFeePerGas: string; maxPriorityFeePerGas: string } | { gasPrice: string }

export interface FeeEstimate {
  type: 'eip1559' | 'legacy'
  /** 下一个区块的 baseFee（wei）；legacy 链为 null */
  baseFee: string | null
  slow: FeeLevelEstimate
  normal: FeeLevelEstimate
  fast: FeeLevelEstimate
}

export interface EstimateFeesOptions {
  /** 看最近多少个区块，默认 20 */
  blocks?: number
  /** 三档优先费取各区块交易优先费的百分位，默认 [10, 50, 90] */
  percentiles?: readonly [number, number, number]
  /** maxFeePerGas = baseFee × baseFeeMultiplier + 优先费，默认 2（baseFee 连涨几个区块也够） */
  baseFeeMultiplier?: number
}

interface FeeHistory {
  baseFeePerGas?: string[]
  reward?: string[][]
}

/** 节点的 JSON-RPC send（ethers 的 JsonRpcProvider / BrowserProvider） */
type Sender = { send(method: string, params: unknown[]): Promise<unknown> }

async function send<T>(provider: Provider, method: string, params: unknown[]): Promise<T> {
  const { runOnNodes } = await import('./write/rpc.js')
  return runOnNodes(provider.rpc, method, async (node) => {
    if (typeof (node as Partial<Sender>).send !== 'function') throw new Error(`${method} is not supported by this node; pass an RPC URL or an ethers Provider`)
    return (await (node as unknown as Sender).send(method, params)) as T
  })
}

const median = (values: bigint[]): bigint => {
  if (!values.length) return 0n
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sorted[Math.floor(sorted.length / 2)] as bigint
}

/**
 * 当前的手续费建议（EVM 链）：baseFee 取下一个区块的，三档优先费是最近区块里交易优先费的百分位的中位数；
 * 节点不支持 eth_feeHistory 或链上没有 baseFee 时按 eth_gasPrice（三档为 1、1、1.2 倍）。Tron 用 estimateCost
 *
 * ```ts
 * const fees = await estimateFees(provider)
 * // { type: 'eip1559', baseFee: '1200000000', slow: { maxFeePerGas, maxPriorityFeePerGas }, normal: {…}, fast: {…} }
 * ```
 */
export async function estimateFees(provider: Provider, options: EstimateFeesOptions = {}): Promise<FeeEstimate> {
  if (isTronChain(await provider.getChainId())) throw new Error('estimateFees is for EVM chains; use estimateCost on Tron')
  const blocks = Math.max(1, Math.min(1024, Math.floor(options.blocks ?? 20)))
  const percentiles = options.percentiles ?? [10, 50, 90]
  if (!percentiles.every((p, i) => p >= 0 && p <= 100 && (i === 0 || p >= (percentiles[i - 1] as number)))) throw new RangeError('percentiles must be ascending numbers in [0, 100]')
  const multiplier = options.baseFeeMultiplier ?? 2
  let history: FeeHistory | null = null
  try {
    history = await send<FeeHistory>(provider, 'eth_feeHistory', [`0x${blocks.toString(16)}`, 'latest', [...percentiles]])
  } catch (err) {
    // 只有节点 / 链不支持 feeHistory 时才按 gasPrice；网络等其他错误照常抛出（不要在 EIP-1559 链上悄悄退回 legacy）
    if (!/not (supported|available|found)|unsupported|does not exist|unknown method|-32601|method.*not/i.test(err instanceof Error ? err.message : String(err))) throw err
    history = null
  }
  const baseFees = history?.baseFeePerGas ?? []
  const next = baseFees.length ? BigInt(baseFees[baseFees.length - 1] as string) : 0n
  if (!history || !baseFees.length || next === 0n) {
    const gasPrice = BigInt(await send<string>(provider, 'eth_gasPrice', []))
    const level = (n: bigint, d: bigint) => ({ gasPrice: ((gasPrice * n) / d).toString() })
    return { type: 'legacy', baseFee: null, slow: level(1n, 1n), normal: level(1n, 1n), fast: level(6n, 5n) }
  }
  const rewards = history.reward ?? []
  // 每档：各区块这个百分位的优先费取中位数（空区块的 0 不算）
  const tip = (k: number) => median(rewards.map((r) => BigInt(r[k] ?? '0')).filter((v) => v > 0n))
  const base = (next * BigInt(Math.round(multiplier * 1000))) / 1000n
  const level = (priority: bigint) => ({ maxFeePerGas: (base + priority).toString(), maxPriorityFeePerGas: priority.toString() })
  const [slow, normal, fast] = [tip(0), tip(1), tip(2)]
  // 优先费不递减（区块很空时三档可能相同）
  return { type: 'eip1559', baseFee: next.toString(), slow: level(slow), normal: level(normal > slow ? normal : slow), fast: level(fast > normal ? fast : normal > slow ? normal : slow) }
}

export interface CostCall {
  /** 发送者（预估 gas、Tron 上按它剩余的资源算） */
  from: string
  to: string
  data?: string
  value?: BigNumberish
}

export interface EvmCostEstimate {
  type: 'evm'
  gasLimit: string
  /** 这一档的每 gas 价格：EIP-1559 是 baseFee + 优先费（预计实际付的），legacy 是 gasPrice */
  gasPrice: string
  /** gasLimit × gasPrice（wei） */
  fee: string
  /** 最多付多少：gasLimit × maxFeePerGas（legacy 同 fee） */
  maxFee: string
  /** OP Stack / Scroll 的 L1 数据费（wei，含 25% 余量），其他链为 0 */
  l1Fee: string
  /** fee + l1Fee（wei）和按主币精度换算的值 */
  total: string
  totalFormatted: string
  symbol: string | null
}

export interface TronCost {
  type: 'tron'
  energy: number
  bandwidth: number
  /** 剩余能量 / 带宽不够时要烧的 TRX（sun） */
  energyBurn: string
  bandwidthBurn: string
  /** 转 TRX 给没激活的地址（激活费算在 bandwidthBurn 里） */
  activates: boolean
  energyPrice: string
  bandwidthPrice: string
  /** energyBurn + bandwidthBurn（sun）和按 TRX 换算的值 */
  total: string
  totalFormatted: string
  symbol: 'TRX'
}

export type CostEstimate = EvmCostEstimate | TronCost

export interface EstimateCostOptions extends EstimateFeesOptions {
  /** 用哪一档，默认 'normal' */
  level?: FeeLevel
  /** 已经查好的费用建议（多笔交易共用，不再查一次） */
  fees?: FeeEstimate
}

/**
 * 估算一笔交易的手续费：EVM 预估 gas × 这一档的价格（+ L1 数据费）；Tron 模拟能量，按发送者剩余的资源算要烧的 TRX。
 * 预估 gas 会执行一遍交易，revert 时抛出
 *
 * ```ts
 * await estimateCost(provider, { from: user, to: USDT, data })   // { type: 'evm', gasLimit, fee, total, totalFormatted: '0.00042', symbol: 'BNB', … }
 * await estimateCost(tronProvider, { from, to: USDT, data })     // { type: 'tron', energy: 64285, energyBurn: '6750000', totalFormatted: '7.0', … }
 * ```
 */
export async function estimateCost(provider: Provider, call: CostCall, options: EstimateCostOptions = {}): Promise<CostEstimate> {
  const chainId = await provider.getChainId()
  const value = BigInt(call.value ?? 0)
  if (isTronChain(chainId)) {
    const { tronEstimateCost } = await import('./write/tron.js')
    const c = await tronEstimateCost(provider, { from: call.from, to: call.to, ...(call.data ? { data: call.data } : {}), value })
    const total = c.energyBurn + c.bandwidthBurn
    return {
      type: 'tron',
      energy: c.energy,
      bandwidth: c.bandwidth,
      energyBurn: c.energyBurn.toString(),
      bandwidthBurn: c.bandwidthBurn.toString(),
      activates: c.activates,
      energyPrice: c.energyPrice.toString(),
      bandwidthPrice: c.bandwidthPrice.toString(),
      total: total.toString(),
      totalFormatted: formatUnits(total, 6),
      symbol: 'TRX',
    }
  }
  const { WriteRpc, l1Fee } = await import('./write/rpc.js')
  const rpc = await WriteRpc.from(provider)
  const tx = { from: call.from, to: call.to, data: call.data ?? '0x', value }
  const [gasLimit, fees] = await Promise.all([rpc.estimateGas(tx), options.fees ? Promise.resolve(options.fees) : estimateFees(provider, options)])
  const level = fees[options.level ?? 'normal']
  const perGas = 'gasPrice' in level ? BigInt(level.gasPrice) : BigInt(fees.baseFee ?? '0') + BigInt(level.maxPriorityFeePerGas)
  const maxPerGas = 'gasPrice' in level ? perGas : BigInt(level.maxFeePerGas)
  const feeFields = 'gasPrice' in level ? { type: 0, gasPrice: perGas } : { type: 2, maxFeePerGas: maxPerGas, maxPriorityFeePerGas: BigInt(level.maxPriorityFeePerGas) }
  const l1 = await l1Fee(rpc, { ...tx, from: undefined, gasLimit, ...feeFields })
  const fee = gasLimit * perGas
  const total = fee + l1
  const native = getNativeCurrency(chainId)
  return {
    type: 'evm',
    gasLimit: gasLimit.toString(),
    gasPrice: perGas.toString(),
    fee: fee.toString(),
    maxFee: (gasLimit * maxPerGas).toString(),
    l1Fee: l1.toString(),
    total: total.toString(),
    totalFormatted: formatUnits(total, native?.decimals ?? 18),
    symbol: native?.symbol ?? null,
  }
}
