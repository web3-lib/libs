/** Tron 的批量操作：批量调用、一对多转账、归集、手续费估算 */
import { hexlify } from 'ethers'

import { encodeCall } from '../../call.js'
import { NATIVE_TOKEN, erc20Interface, formatUnits, type TokenBalance } from '../../erc20.js'
import { errorText } from '../../fallback.js'
import type { Provider } from '../../provider.js'
import { toEvmAddress } from '../../tron.js'
import { mapPool } from '../../util.js'
import type { BatchCallOptions, WriteCall } from '../batch.js'
import type { BatchCollectOptions, CollectResult } from '../collect.js'
import { collectTokens, planCollect, planTransfers, type ChainRules, type CollectItem, type PlannedTransfer } from '../plan.js'
import { emptyOutcome, toWriteResult, type SendOptions, type TronSendOptions, type TxOutcome, type WriteResult } from '../send.js'
import type { SignerInput } from '../signer.js'
import type { BatchTransferOptions, TransferItem, TransferResult } from '../transfer.js'
import { canonical, isRecipientAddress, resolveTronSigner, type TronContract, type TronKey } from './codec.js'
import { TronRpc, bandwidthBurn, energyBurn, transactionBytes, transferBurn } from './rpc.js'
import { sendTronJobs, type TronJob } from './send.js'

// ---- 批量调用 / 转账 / 归集 ----

async function tronRpc(provider: Provider, options: SendOptions & TronSendOptions): Promise<TronRpc> {
  return new TronRpc(provider.rpc, options)
}

/**
 * Tron 的规划规则：地址统一成 T 地址（区分大小写），数量用 BigInt；
 * TRX 转账数量必须大于 0（java-tron 拒绝 0 数额的 TransferContract），代币允许 0
 */
const TRON_RULES: ChainRules = {
  tokenKey: (token) => canonical(token),
  token: (key) => key,
  address: (address) => canonical(address),
  walletKey: (address) => address,
  checkRecipient: (to, index) => {
    if (!isRecipientAddress(to)) {
      throw new Error(`recipients[${index}]: invalid address ${to}`)
    }
  },
  amount: (value) => BigInt(value),
  invalidAmount: (amount, native) => (amount < 0n || (native && amount === 0n) ? 'amount must be positive' : null),
}

/** 一笔交易的手续费估算（子路径 /fees 的 estimateCost 在 Tron 上用） */
export interface TronCostEstimate {
  /** 合约调用消耗的能量（模拟得到）；转 TRX 为 0 */
  energy: number
  /** 交易的字节数（带宽） */
  bandwidth: number
  /** 账户剩余的能量 / 带宽不够时要烧的 TRX（sun） */
  energyBurn: bigint
  bandwidthBurn: bigint
  /** 转 TRX 给没激活的地址：激活费（含创建账户的带宽），算在 bandwidthBurn 里 */
  activates: boolean
  /** 每单位能量、每字节带宽的价格（sun） */
  energyPrice: bigint
  bandwidthPrice: bigint
  /** 以下与 estimateCost 的返回对齐：type、合计（energyBurn + bandwidthBurn，sun）、按主币精度换算的值、symbol */
  type: 'tron'
  total: bigint
  totalFormatted: string
  symbol: 'TRX'
}

/**
 * 估算一笔交易要烧多少 TRX：合约调用模拟出能量，按发送者剩余的质押能量 / 免费和质押带宽抵扣，不够的部分按链参数的价格烧 TRX。
 * 能量按模拟值（不加余量），实际执行可能略有出入
 */
export async function tronEstimateCost(provider: Provider, call: { from: string; to: string; data?: string; value?: bigint }): Promise<TronCostEstimate> {
  const rpc = await tronRpc(provider, {})
  const from = canonical(call.from)
  const to = canonical(call.to)
  const value = call.value ?? 0n
  const data = call.data && call.data !== '0x' ? call.data : null
  const [params, resources, isContract] = await Promise.all([rpc.params(), rpc.resources(from), data ? Promise.resolve(true) : rpc.isContract(to)])
  const contract: TronContract = isContract ? { type: 'trigger', owner: from, contract: to, data: data ?? '0x', callValue: value } : { type: 'transfer', owner: from, to, amount: value }
  const energy = contract.type === 'trigger' ? await rpc.simulate(contract) : 0
  const feeLimit = contract.type === 'trigger' ? BigInt(Math.ceil(energy * 1.5)) * params.energyFee || 1_000_000n : 0n
  const bytes = transactionBytes(contract, feeLimit)
  const activates = contract.type === 'transfer' && !(await rpc.accountExists(to))
  const energyCost = BigInt(Math.max(0, energy - resources.energy)) * params.energyFee
  const bandwidthCost = contract.type === 'transfer' ? transferBurn(resources, bytes, params, activates) : bandwidthBurn(resources, bytes, params.bandwidthFee)
  const total = energyCost + bandwidthCost
  const { decimals } = await provider.nativeCurrency()
  return {
    energy,
    bandwidth: bytes,
    energyBurn: energyCost,
    bandwidthBurn: bandwidthCost,
    activates,
    energyPrice: params.energyFee,
    bandwidthPrice: params.bandwidthFee,
    type: 'tron',
    total,
    totalFormatted: formatUnits(total, decimals),
    symbol: 'TRX',
  }
}

/** 转 TRX：普通地址用 TransferContract；合约地址用合约调用（空 calldata 带 call_value，主网禁止 TransferContract 转给合约） */
async function trxContract(rpc: TronRpc, owner: string, to: string, amount: bigint): Promise<TronContract> {
  return (await rpc.isContract(to)) ? { type: 'trigger', owner, contract: to, data: '0x', callValue: amount } : { type: 'transfer', owner, to, amount }
}

export async function tronBatchCall(provider: Provider, calls: readonly WriteCall[], options: BatchCallOptions & TronSendOptions = {}): Promise<WriteResult[]> {
  if (options.mode === '7702') {
    throw new Error("mode '7702' is not supported on Tron")
  }
  const rpc = await tronRpc(provider, options)
  const cache = new Map()
  const prepared = await Promise.all(
    calls.map(async (item, i) => {
      const signer = await resolveTronSigner(item.from, cache)
      let to: string
      let data: string
      let value: bigint
      if (item.call) {
        const request = encodeCall(item.call, false)
        to = request.target
        data = request.callData
        value = BigInt(item.value ?? item.call.overrides?.value ?? 0n)
      } else {
        if (!item.to) throw new Error(`calls[${i}]: either to or call is required`)
        to = item.to
        data = item.data ? hexlify(item.data) : '0x'
        value = BigInt(item.value ?? 0n)
      }
      // 没有 calldata：转 TRX；否则调用合约
      const contract: TronContract =
        data === '0x' ? await trxContract(rpc, signer.address, canonical(to), value) : { type: 'trigger', owner: signer.address, contract: canonical(to), data, callValue: value }
      return { signer, to: canonical(to), contract }
    }),
  )
  const results = prepared.map((p, i) => toWriteResult(i, p.signer.address, p.to, emptyOutcome('skipped')))
  const jobs: TronJob[] = prepared.map((p, i) => ({
    signer: p.signer,
    contract: p.contract,
    continueOnError: options.continueOnError,
    onUpdate: (outcome) => {
      results[i] = toWriteResult(i, p.signer.address, p.to, outcome)
      options.onUpdate?.(results[i] as WriteResult)
    },
  }))
  await sendTronJobs(rpc, jobs, options)
  return results
}

type Planned = PlannedTransfer

function tokenTransfer(owner: string, token: string, to: string, amount: bigint): Extract<TronContract, { type: 'trigger' }> {
  return { type: 'trigger', owner, contract: token, data: erc20Interface.encodeFunctionData('transfer', [toEvmAddress(to), amount]), callValue: 0n }
}

/** Tron 一对多转账：每个收款人一笔交易（Tron 上没有通用的 Disperse 合约），结果的 via 为 'tx' */
export async function tronBatchTransfer(
  provider: Provider,
  from: SignerInput,
  recipients: readonly TransferItem[],
  options: BatchTransferOptions & TronSendOptions = {},
): Promise<TransferResult[]> {
  if (options.mode === '7702') {
    throw new Error("mode '7702' is not supported on Tron")
  }
  const rpc = await tronRpc(provider, options)
  const signer = await resolveTronSigner(from, new Map())
  const planned = await planTransfers(provider, signer.address, recipients, options, TRON_RULES)
  const toResult = (p: Planned, outcome: TxOutcome): TransferResult => ({
    ...toWriteResult(p.index, signer.address, p.to, outcome),
    token: p.token,
    native: p.native,
    amount: p.amount.toString(),
    formatted: p.decimals === null ? null : formatUnits(p.amount, p.decimals),
    via: 'tx',
    approvals: [],
  })
  const results = planned.map((p) => toResult(p, emptyOutcome('skipped')))
  const contracts = await Promise.all(planned.map((p) => (p.native ? trxContract(rpc, signer.address, p.to, p.amount) : tokenTransfer(signer.address, p.token, p.to, p.amount))))
  const jobs: TronJob[] = planned.map((p, k) => ({
    signer,
    contract: contracts[k] as TronContract,
    continueOnError: true,
    onUpdate: (outcome) => {
      results[p.index] = toResult(p, outcome)
      options.onUpdate?.(results[p.index] as TransferResult)
    },
  }))
  await sendTronJobs(rpc, jobs, options)
  return results
}

type Item = CollectItem<TronKey>

/**
 * Tron 归集：与 EVM 相同的流程（补 gas → 归集代币 → 扫空 TRX）。手续费按 Tron 的资源模型算：
 * 合约调用烧能量（模拟的能量 × 能量单价，减去账户已有的能量，加 20% 余量），每笔交易烧带宽（免费 / 质押带宽不够时按字节计费）。
 * 没激活的子钱包由补 gas 的转账激活（激活费由 gasWallet 付）
 */
export async function tronBatchCollect(provider: Provider, wallets: readonly SignerInput[], to: string, options: BatchCollectOptions & TronSendOptions = {}): Promise<CollectResult> {
  const rpc = await tronRpc(provider, options)
  const target = canonical(to)
  const cache = new Map()
  const signers = await Promise.all(wallets.map((w) => resolveTronSigner(w, cache)))
  // 读余额、生成归集项和跳过原因（与 EVM 共用）
  const { items, results, balances, nativeAt, sweep, minAmount, report, active } = await planCollect(provider, signers, target, { ...options, tokens: collectTokens(options, provider) }, TRON_RULES)

  // 估算每个钱包的手续费：模拟能量 + 带宽
  const params = await rpc.params()
  const { energyFee, bandwidthFee } = params
  const byWallet = new Map<string, Item[]>()
  items.filter((i) => !i.native && active(i)).forEach((i) => byWallet.set(i.signer.address, [...(byWallet.get(i.signer.address) ?? []), i]))
  /** 每项的 fee_limit：按全部预估能量算（fee_limit 限制的是总能量，包括账户质押得到的能量），只是上限，实际按用量扣 */
  const feeLimits = new Map<Item, bigint>()
  const plans = await mapPool([...byWallet.entries()], options.concurrency ?? 8, async ([address, list]) => {
    const wallet = signers.findIndex((s) => s.address === address)
    const native = balances[wallet]?.[nativeAt] as TokenBalance
    if (!native.success) {
      // TRX 余额读不到：不知道要补多少，不补（多补的 TRX 也不会被扫回）
      list.forEach((item) => report(item, emptyOutcome('failed', `cannot read the TRX balance: ${native.error ?? 'unknown error'}`)))
      return { address, list, shortfall: 0n, exists: true }
    }
    const resources = await rpc.resources(address)
    let need = 0n
    for (const item of list) {
      const contract = tokenTransfer(address, item.token, target, item.amount)
      let energy: number
      try {
        energy = await rpc.simulate(contract)
      } catch (err) {
        report(item, emptyOutcome('failed', errorText(err)))
        continue
      }
      const feeLimit = options.feeLimit ?? (BigInt(Math.ceil(energy * 1.5)) * energyFee || 1_000_000n)
      feeLimits.set(item, feeLimit)
      // 没激活的账户 resources 里没有免费带宽：补 gas 的转账激活它之后才有，这里按要烧 TRX 算（多出来的扫 TRX 时会转走）
      need += bandwidthBurn(resources, transactionBytes(contract, feeLimit), bandwidthFee) + energyBurn(resources, energy, energyFee)
    }
    const nativeBalance = BigInt(native.balance)
    const buffered = (need * BigInt(Math.round((options.gasBuffer ?? 1) * 1000))) / 1000n
    return { address, list, shortfall: buffered > nativeBalance ? buffered - nativeBalance : 0n, exists: resources.exists }
  })

  // 补 gas（TRX）
  let topUps: TransferResult[] = []
  const short = plans.filter((p) => p.shortfall > 0n && p.list.some(active))
  if (short.length) {
    if (!options.gasWallet) {
      short.forEach((p) => p.list.filter(active).forEach((i) => report(i, emptyOutcome('failed', `insufficient TRX for fees: need ${p.shortfall} more sun (pass gasWallet to top up automatically)`))))
    } else {
      const { tokens: _t, gasWallet, gasMode: _m, gasBuffer: _b, minAmount: _min, onUpdate: _u, ...send } = options
      // 先确认 gasWallet 付得起全部补 gas（金额 + 激活没激活的钱包 + 带宽），不够时什么都不发
      const gas = await resolveTronSigner(gasWallet, cache)
      const gasAccount = await rpc.resources(gas.address)
      const total = short.reduce((sum, p) => {
        const bytes = transactionBytes({ type: 'transfer', owner: gas.address, to: p.address, amount: p.shortfall }, 0n)
        return sum + p.shortfall + transferBurn(gasAccount, bytes, params, !p.exists)
      }, 0n)
      if (gasAccount.balance < total) {
        throw new Error(`Insufficient TRX in gasWallet: the top-ups need about ${total} sun (including activation and bandwidth fees), it has ${gasAccount.balance}`)
      }
      topUps = await tronBatchTransfer(
        provider,
        gasWallet,
        short.map((p) => ({ to: p.address, amount: p.shortfall, token: NATIVE_TOKEN })),
        { ...send, mode: 'tx', wait: true },
      )
      topUps.forEach((t, k) => {
        if (!(t.status === 'confirmed' || (options.dryRun && t.status === 'simulated'))) {
          ;(short[k] as (typeof short)[number]).list.filter(active).forEach((i) => report(i, emptyOutcome('failed', `gas top-up ${t.status}: ${t.error ?? ''}`.trim())))
        }
      })
    }
  }

  const tokenItems = items.filter((i) => !i.native && active(i))
  if (options.dryRun) {
    tokenItems.forEach((i) => report(i, { ...emptyOutcome('simulated') }))
    if (sweep) items.filter((i) => i.native && active(i)).forEach((i) => report(i, emptyOutcome('simulated')))
    return { results, topUps }
  }
  const jobs: TronJob[] = tokenItems.map((item) => ({
    signer: item.signer,
    contract: tokenTransfer(item.signer.address, item.token, target, item.amount),
    feeLimit: feeLimits.get(item),
    continueOnError: true,
    onUpdate: (outcome) => report(item, outcome),
  }))
  await sendTronJobs(rpc, jobs, sweep ? { ...options, wait: true } : options)

  if (!sweep) return { results, topUps }
  // 代币没有全部归集成功的钱包不扫 TRX
  items
    .filter((i) => i.native && active(i))
    .forEach((native) => {
      const unfinished = items.find((i) => !i.native && i.signer.address === native.signer.address && i.result.status !== 'confirmed' && i.result.status !== 'skipped')
      if (unfinished) report(native, emptyOutcome('skipped', `skipped: collecting ${unfinished.token} did not succeed (${unfinished.result.status})`))
    })
  const sweepItems = items.filter((i) => i.native && active(i))
  if (!sweepItems.length || options.signal?.aborted) return { results, topUps }
  // 扫空 TRX：最新余额减去这笔的手续费（带宽够用时为 0；归集地址是合约时用合约调用，还要算能量）
  let targetIsContract: boolean
  try {
    targetIsContract = await rpc.isContract(target)
  } catch (err) {
    // 代币归集已经发出：不能整体抛错，扫 TRX 的项标记失败
    sweepItems.forEach((i) => report(i, emptyOutcome('failed', `cannot check the collect address: ${errorText(err)}`)))
    return { results, topUps }
  }
  const sweepJobs = await mapPool(sweepItems, options.concurrency ?? 8, async (item): Promise<TronJob | null> => {
    const owner = item.signer.address
    try {
      const resources = await rpc.resources(owner)
      const balance = resources.balance
      let energy = 0
      let feeLimit = 0n
      if (targetIsContract) {
        energy = await rpc.simulate({ type: 'trigger', owner, contract: target, data: '0x', callValue: 1n })
        feeLimit = options.feeLimit ?? (BigInt(Math.ceil(energy * 1.5)) * energyFee || 1_000_000n)
      }
      const probe: TronContract = targetIsContract ? { type: 'trigger', owner, contract: target, data: '0x', callValue: balance } : { type: 'transfer', owner, to: target, amount: balance }
      const fee = bandwidthBurn(resources, transactionBytes(probe, feeLimit), bandwidthFee) + (targetIsContract ? energyBurn(resources, energy, energyFee) : 0n)
      const amount = balance - fee
      const min = minAmount.get(item.token.toLowerCase()) ?? 0n
      if (amount <= 0n || amount < min) {
        report(item, emptyOutcome('skipped', amount <= 0n ? 'skipped: TRX balance does not cover the fee' : 'skipped: below minAmount'))
        return null
      }
      item.amount = amount
      const contract: TronContract = targetIsContract ? { type: 'trigger', owner, contract: target, data: '0x', callValue: amount } : { type: 'transfer', owner, to: target, amount }
      return { signer: item.signer, contract, feeLimit: targetIsContract ? feeLimit : undefined, continueOnError: true, onUpdate: (outcome) => report(item, outcome) }
    } catch (err) {
      report(item, emptyOutcome('failed', errorText(err)))
      return null
    }
  })
  await sendTronJobs(
    rpc,
    sweepJobs.filter((j): j is TronJob => j !== null),
    options,
  )
  return { results, topUps }
}
