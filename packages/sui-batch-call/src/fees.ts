/**
 * 手续费估算（子路径 `@w3lib/sui-batch-call/fees`）：当前 epoch 的参考 gas 价格；一笔交易的手续费（按 /write 的方式选 gas 币、模拟执行，
 * 给出计算费、存储费、存储返还、净花费和发送时会用的 gas 上限）。
 *
 * 没有慢 / 中 / 快三档：Sui 的参考 gas 价格由验证者每个 epoch（约 24 小时）定一次，epoch 内不变，没有随区块变化的 baseFee，
 * 按参考价格发送就会被正常处理。出价高于参考价格只在交易用到拥堵的共享对象时有用（这些交易按 gas 价格排队），这时用 /write 的 gasPrice
 */
import { base64 } from '@scure/base'

import { normalizeSuiAddress } from './address.js'
import type { SuiClient } from './client.js'
import { SUI_DECIMALS } from './constants.js'
import { formatUnits } from './format.js'
import { getEpoch } from './services.js'
import type { ProgrammableTransaction } from './write/bcs.js'
import { sendJobs, type SendOptions } from './write/send.js'
import type { ResolvedSigner } from './write/signer.js'

export interface FeeEstimate {
  /** 当前 epoch */
  epoch: string
  /** 当前 epoch 的参考 gas 价格（MIST / gas 单位），/write 默认按它发送 */
  referenceGasPrice: string
}

/**
 * 当前的 gas 价格（一次 GetEpoch）。
 *
 * ```ts
 * await estimateFees(sui)   // { epoch: '1285', referenceGasPrice: '100' }
 * ```
 */
export async function estimateFees(client: SuiClient, options: { signal?: AbortSignal } = {}): Promise<FeeEstimate> {
  const { epoch, referenceGasPrice } = await getEpoch(client.transport, { signal: options.signal })
  if (referenceGasPrice === 0n) throw new Error('The node did not report the reference gas price')
  return { epoch: epoch.toString(), referenceGasPrice: referenceGasPrice.toString() }
}

export interface CostCall {
  /** 发送者地址（只模拟，不需要私钥） */
  from: string
  /**
   * 交易内容（TransactionKind），同 batchCall：@mysten/sui 的 `tx.build({ client, onlyTransactionKind: true })` 的字节或其 base64，
   * 或本库的 ProgrammableTransaction（如 PtbBuilder 拼的）
   */
  kind: Uint8Array | string | ProgrammableTransaction
  /** 付 gas 的地址（赞助交易），默认发送者自己付 */
  sponsor?: string
}

export interface EstimateCostOptions extends Pick<SendOptions, 'gasPrice' | 'gasMultiplier' | 'signal'> {}

export interface CostEstimate {
  /** 模拟用的 gas 价格（MIST），默认参考价格 */
  gasPrice: string
  /** 计算费（MIST）：计算消耗 × gas 价格 */
  computationCost: string
  /** 存储费（MIST）：交易写入的对象占用的存储 */
  storageCost: string
  /** 存储返还（MIST）：交易删除 / 改写的对象原来付的存储费，已扣掉不返还的部分 */
  storageRebate: string
  /** 不返还的存储费（MIST，被改写对象的存储费的 1%，已从 storageRebate 里扣掉） */
  nonRefundableStorageFee: string
  /** 净花费：computationCost + storageCost − storageRebate（MIST），可能为负（返还多于花费，如合并很多 Coin） */
  total: string
  /** total 按 SUI 换算 */
  totalFormatted: string
  /**
   * /write 发送这笔交易时用的 gas 上限（MIST）：(computationCost + storageCost) × gasMultiplier，不低于 0.002 SUI，
   * 不超过付款地址可用的 SUI。执行前付款地址至少要有这么多 SUI（存储返还在执行后才到账）
   */
  gasBudget: string
  gasBudgetFormatted: string
  symbol: 'SUI'
}

/** 只用来模拟的签名器：不能签名 */
const watchOnly = (address: string): ResolvedSigner => ({
  address: normalizeSuiAddress(address),
  kind: 'local',
  sign: () => Promise.reject(new Error('estimateCost does not sign transactions')),
})

/**
 * 估算一笔交易的手续费：和 /write 发送时一样选付款地址的 gas 币（没有 Coin 时用地址余额），模拟执行一次。
 * 模拟失败（Move abort、付款地址没有 SUI 付 gas 等）时抛出
 *
 * ```ts
 * const ptb = new PtbBuilder()                                 // 转 0.001 SUI：从 gas 币拆出来再转走
 * const coin = ptb.command({ kind: 'splitCoins', coin: ptb.gas, amounts: [ptb.pure(pure.u64(1_000_000n))] })
 * ptb.command({ kind: 'transferObjects', objects: [ptb.nested(coin, 0)], address: ptb.pure(pure.address(to)) })
 * await estimateCost(sui, { from: owner, kind: ptb.build() })
 * // { gasPrice: '100', computationCost: '100000', storageCost: '1976000', storageRebate: '987901', total: '1088099', totalFormatted: '0.001088099', gasBudget: '2491200', … }
 * ```
 */
export async function estimateCost(client: SuiClient, call: CostCall, options: EstimateCostOptions = {}): Promise<CostEstimate> {
  const kind = typeof call.kind === 'string' ? base64.decode(call.kind) : call.kind
  const sender = watchOnly(call.from)
  const sponsor = call.sponsor === undefined ? undefined : watchOnly(call.sponsor)
  const [outcome] = await sendJobs(client, [{ sender, sponsor, build: async () => kind, onUpdate: () => {} }], {
    gasPrice: options.gasPrice,
    gasMultiplier: options.gasMultiplier,
    signal: options.signal,
    dryRun: true,
  })
  options.signal?.throwIfAborted()
  const sim = outcome?.status === 'simulated' ? outcome.simulation : undefined
  if (!sim?.gasUsed) throw new Error(outcome?.error ?? 'simulation failed')
  const { computationCost, storageCost, storageRebate, nonRefundableStorageFee } = sim.gasUsed
  const total = computationCost + storageCost - storageRebate
  return {
    gasPrice: sim.gasPrice.toString(),
    computationCost: computationCost.toString(),
    storageCost: storageCost.toString(),
    storageRebate: storageRebate.toString(),
    nonRefundableStorageFee: nonRefundableStorageFee.toString(),
    total: total.toString(),
    totalFormatted: formatUnits(total, SUI_DECIMALS),
    gasBudget: sim.gasBudget.toString(),
    gasBudgetFormatted: formatUnits(sim.gasBudget, SUI_DECIMALS),
    symbol: 'SUI',
  }
}
