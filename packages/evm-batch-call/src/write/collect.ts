import { Interface, getAddress, getBigInt, type BigNumberish } from 'ethers'

import { ERC20_ABI, NATIVE_TOKEN, formatUnits, type TokenBalance } from '../erc20.js'
import type { Provider } from '../provider.js'
import { WriteRpc, failureText, l1Fee } from './rpc.js'
import { FeeSource, applyGasMultiplier, emptyOutcome, mapPool, sendJobs, toWriteResult, type SendOptions, type TronSendOptions, type TxFees, type TxJob, type TxOutcome, type WriteResult } from './send.js'
import { resolveSigner, type ResolvedSigner, type SignerInput } from './signer.js'
import { tronModule } from './batch.js'
import { batchTransfer, type TransferResult } from './transfer.js'

const erc20Interface = new Interface(ERC20_ABI as unknown as string[])

/** 预估代币转账 gas 失败（有的节点对没有主币的地址预估时报余额不足）时用的 gasLimit */
const FALLBACK_TOKEN_GAS = 120_000n

export interface BatchCollectOptions extends SendOptions, TronSendOptions {
  /**
   * 要归集的代币。包含主币（NATIVE_TOKEN）时，在代币归集确认后把剩余主币扣掉手续费全部转走
   * （OP Stack / Scroll 链上同时预留 L1 数据费；EIP-1559 链上按 maxFeePerGas 预留，实际手续费更低，会留下少量零头）
   */
  tokens: readonly string[]
  /**
   * 补 gas 的钱包：子钱包主币不够付归集手续费时，先从它转入刚好够用的主币（按 gasLimit × maxFeePerGas 计算，已含余量），确认后再归集。
   * 不传时，主币不够的子钱包对应的项 status 为 'failed'
   */
  gasWallet?: SignerInput
  /** 补 gas 的方式，见 batchTransfer 的 mode，默认 'disperse'（一笔交易给所有子钱包补） */
  gasMode?: 'disperse' | 'tx'
  /** 补 gas 数量的额外倍数，默认 1 */
  gasBuffer?: number
  /** 各代币的最小归集数量（最小单位），余额低于它的不归集：`{ [USDT]: 10n ** 6n }` */
  minAmount?: Readonly<Record<string, BigNumberish>>
}

/** 单个钱包单个代币的归集结果；from 是子钱包，to 是归集地址 */
export interface CollectItemResult extends WriteResult {
  token: string
  native: boolean
  /** 归集的数量（最小单位）；主币扫尾在发送前为 '0' */
  amount: string
  formatted: string | null
}

export interface CollectResult {
  /** 按 wallets × tokens 顺序（第 i 个钱包第 j 个代币在 i × tokens.length + j） */
  results: CollectItemResult[]
  /** 补 gas 的转账（没有需要补的钱包时为空） */
  topUps: TransferResult[]
}

interface Item {
  index: number
  signer: ResolvedSigner
  token: string
  native: boolean
  amount: bigint
  decimals: number | null
  gasLimit: bigint | null
  result: CollectItemResult
}

/**
 * 归集：多个钱包的代币 / 主币转到同一个地址。每个钱包内按代币顺序逐笔发送，钱包之间并发。
 *
 * ```ts
 * const { results, topUps } = await batchCollect(multi, [key1, key2, key3], hotWallet, {
 *   tokens: [USDT, NATIVE_TOKEN],   // 主币放在里面表示代币归集完后扫空剩余主币
 *   gasWallet: gasKey,              // 子钱包主币不够付手续费时先从这里补
 * })
 * ```
 *
 * 流程：一次 multicall 读出所有钱包的余额 → 预估每笔归集的手续费 → 给不够的钱包补 gas（等确认）
 * → 发代币归集 → （包含主币时）等代币归集确认、按最新余额扫空主币。
 * dryRun 时只做到预估，返回计划（补多少 gas、每笔 gasLimit），不发任何交易
 */
export async function batchCollect(provider: Provider, wallets: readonly SignerInput[], to: string, options: BatchCollectOptions): Promise<CollectResult> {
  const tron = await tronModule(provider)
  if (tron) {
    return tron.tronBatchCollect(provider, wallets, to, options)
  }
  const rpc = await WriteRpc.from(provider)
  const target = getAddress(to)
  const cache = new Map()
  const signers = await Promise.all(wallets.map((w) => resolveSigner(w, cache)))
  const tokens = options.tokens
  const nativeIndex = tokens.findIndex((t) => provider.isNativeToken(t))
  const sweep = nativeIndex >= 0
  const multiplier = options.gasMultiplier

  // 一次 multicall 读出所有钱包的代币余额 + 主币余额（算手续费要用）
  const queryTokens = sweep ? [...tokens] : [...tokens, NATIVE_TOKEN]
  const nativeAt = sweep ? nativeIndex : tokens.length
  const balances = await provider.multiBalances(signers.map((s) => ({ owner: s.address, tokens: queryTokens })))
  const minAmount = new Map(Object.entries(options.minAmount ?? {}).map(([k, v]) => [k.toLowerCase(), getBigInt(v)]))

  const items: Item[] = []
  const seen = new Set<string>()
  signers.forEach((signer, w) => {
    const duplicate = seen.has(signer.address.toLowerCase())
    seen.add(signer.address.toLowerCase())
    tokens.forEach((token, t) => {
      const balance = balances[w]?.[t] as TokenBalance
      const native = t === nativeIndex
      const decimals = balance.success ? balance.decimals : null
      const item: Item = {
        index: w * tokens.length + t,
        signer,
        token: native ? token : getAddress(token),
        native,
        amount: native ? 0n : balance.success ? BigInt(balance.balance) : 0n,
        decimals,
        gasLimit: null,
        result: null as unknown as CollectItemResult,
      }
      const skip = !balance.success
        ? `cannot read balance: ${balance.error ?? 'unknown error'}`
        : signer.address === target
          ? 'skipped: wallet is the collect address'
          : duplicate
            ? 'skipped: duplicate wallet'
            : !native && item.amount === 0n
              ? 'skipped: zero balance'
              : !native && item.amount < (minAmount.get(token.toLowerCase()) ?? 0n)
                ? 'skipped: below minAmount'
                : null
      item.result = toCollectResult(item, target, emptyOutcome(skip ? (balance.success ? 'skipped' : 'failed') : 'skipped', skip))
      items.push(item)
    })
  })
  const results = items.map((i) => i.result)
  const report = (item: Item, outcome: TxOutcome) => {
    item.result = toCollectResult(item, target, outcome)
    results[item.index] = item.result
    options.onUpdate?.(item.result)
  }
  const active = (item: Item) => item.result.error === null

  // 预估每个钱包的代币归集 gas，算出需要补多少主币。
  // 手续费价格只取这一次，代币归集也按它发：补 gas 等确认期间节点报价上涨，也不会超出补的数量、因余额不足被拒
  const fee = await new FeeSource(rpc, options).get()
  const fees = FeeSource.fixed(rpc, fee)
  const byWallet = new Map<string, Item[]>()
  items.forEach((item) => {
    if (active(item)) {
      byWallet.set(item.signer.address, [...(byWallet.get(item.signer.address) ?? []), item])
    }
  })
  const plans = await mapPool([...byWallet.entries()], options.concurrency ?? 8, async ([address, list]) => {
    const native = balances[signers.findIndex((s) => s.address === address)]?.[nativeAt] as TokenBalance
    if (!native.success) {
      // 主币余额读不到：不知道要补多少，不补（按 0 算会多补，而这个钱包也不会扫主币，多补的收不回来）
      list.filter((i) => !i.native).forEach((i) => report(i, emptyOutcome('failed', `cannot read the native balance: ${native.error ?? 'unknown error'}`)))
      return { address, list, shortfall: 0n }
    }
    let need = 0n
    for (const item of list) {
      if (item.native) {
        continue
      }
      const tx = { from: address, to: item.token, data: erc20Interface.encodeFunctionData('transfer', [target, item.amount]) }
      try {
        item.gasLimit = applyGasMultiplier(await rpc.estimateGas(tx), multiplier)
      } catch (err) {
        if (!/insufficient funds/i.test(failureText(err))) {
          report(item, { ...emptyOutcome('failed', failureText(err)) })
          continue
        }
        item.gasLimit = FALLBACK_TOKEN_GAS
      }
      need += item.gasLimit * fee.perGas + (await l1Fee(rpc, { ...tx, from: undefined, gasLimit: item.gasLimit, ...feeFields(fee) }))
    }
    const wallet = signers.findIndex((s) => s.address === address)
    const nativeBalance = BigInt((balances[wallet]?.[nativeAt] as TokenBalance).balance)
    const buffered = (need * BigInt(Math.round((options.gasBuffer ?? 1) * 1000))) / 1000n
    return { address, list, shortfall: buffered > nativeBalance ? buffered - nativeBalance : 0n }
  })

  // 补 gas
  let topUps: TransferResult[] = []
  const short = plans.filter((p) => p.shortfall > 0n && p.list.some((i) => !i.native && active(i)))
  if (short.length) {
    if (!options.gasWallet) {
      short.forEach((p) => p.list.filter((i) => !i.native && active(i)).forEach((i) => report(i, emptyOutcome('failed', `insufficient native balance for gas: need ${p.shortfall} more wei (pass gasWallet to top up automatically)`))))
    } else {
      topUps = await batchTransfer(
        provider,
        options.gasWallet,
        short.map((p) => ({ to: p.address, amount: p.shortfall, token: NATIVE_TOKEN })),
        { ...sendOptions(options), mode: options.gasMode ?? 'disperse', wait: true },
      )
      topUps.forEach((t, k) => {
        const ok = t.status === 'confirmed' || (options.dryRun && t.status === 'simulated')
        if (!ok) {
          ;(short[k] as (typeof short)[number]).list.filter((i) => !i.native && active(i)).forEach((i) => report(i, emptyOutcome('failed', `gas top-up ${t.status}: ${t.error ?? ''}`.trim())))
        }
      })
    }
  }

  // 代币归集
  const tokenItems = items.filter((i) => !i.native && active(i))
  if (options.dryRun) {
    tokenItems.forEach((i) => report(i, { ...emptyOutcome('simulated'), gasLimit: i.gasLimit }))
    if (sweep) {
      items.filter((i) => i.native && active(i)).forEach((i) => report(i, { ...emptyOutcome('simulated'), gasLimit: 21_000n }))
    }
    return { results, topUps }
  }
  const minBlock = new Map<string, number>()
  topUps.forEach((t) => t.blockNumber !== null && minBlock.set(getAddress(t.to), t.blockNumber))
  const track = (item: Item, outcome: TxOutcome) => {
    if (outcome.blockNumber !== null) {
      minBlock.set(item.signer.address, Math.max(minBlock.get(item.signer.address) ?? 0, outcome.blockNumber))
    }
    report(item, outcome)
  }
  // 发送前重新预估（不用补 gas 前的 gasLimit）：预估时余额不足、用了兜底值的项按实际需要发；余额变了的项预估失败，不会上链 revert 白付手续费
  const jobs: TxJob[] = tokenItems.map((item) => ({
    signer: item.signer,
    continueOnError: true,
    build: async () => ({ to: item.token, data: erc20Interface.encodeFunctionData('transfer', [target, item.amount]), value: 0n }),
    onUpdate: (outcome) => track(item, outcome),
  }))
  // 要扫主币时必须等代币归集确认（扫的是扣完手续费后的余额）
  await sendJobs(rpc, jobs, sweep ? { ...options, wait: true } : options, fees)

  // 代币没有全部归集成功的钱包不扫主币：留着付之后重新归集的手续费；还没确认的交易也要用这部分主币付手续费
  items
    .filter((i) => i.native && active(i))
    .forEach((native) => {
      const unfinished = items.find((i) => !i.native && i.signer.address === native.signer.address && i.result.status !== 'confirmed' && i.result.status !== 'skipped')
      if (unfinished) {
        report(native, emptyOutcome('skipped', `skipped: collecting ${unfinished.token} did not succeed (${unfinished.result.status})`))
      }
    })

  // 扫空主币：按最新余额（不早于该钱包最后一笔确认交易的区块）减去这笔的手续费
  const sweepItems = items.filter((i) => i.native && active(i))
  if (sweep && sweepItems.length && !options.signal?.aborted) {
    const sweepFee = await new FeeSource(rpc, options).get()
    let gasLimit = 21_000n
    try {
      gasLimit = applyGasMultiplier(await rpc.estimateGas({ from: (sweepItems[0] as Item).signer.address, to: target, value: 1n }), multiplier)
    } catch {
      // 预估失败时按普通转账
    }
    const sweepJobs = await mapPool(sweepItems, options.concurrency ?? 8, async (item): Promise<TxJob | null> => {
      const block = minBlock.get(item.signer.address)
      const [balance] = await provider.balances(item.signer.address, [NATIVE_TOKEN], block === undefined ? {} : { minBlock: block })
      if (!balance?.success) {
        report(item, emptyOutcome('failed', `cannot read balance: ${balance?.error ?? 'unknown error'}`))
        return null
      }
      const reserve = gasLimit * sweepFee.perGas + (await l1Fee(rpc, { to: target, value: BigInt(balance.balance), gasLimit, ...feeFields(sweepFee) }))
      const amount = BigInt(balance.balance) - reserve
      if (amount <= 0n) {
        report(item, emptyOutcome('skipped', 'skipped: native balance does not cover the gas fee'))
        return null
      }
      item.amount = amount
      return {
        signer: item.signer,
        gasLimit,
        continueOnError: true,
        build: async () => ({ to: target, data: '0x', value: amount }),
        onUpdate: (outcome) => report(item, outcome),
      }
    })
    await sendJobs(rpc, sweepJobs.filter((j): j is TxJob => j !== null), options, FeeSource.fixed(rpc, sweepFee))
  }
  return { results, topUps }
}

/** 只保留发送参数（补 gas 时不带 tokens / onUpdate 等归集参数） */
function sendOptions(options: BatchCollectOptions): SendOptions {
  const { tokens: _tokens, gasWallet: _gasWallet, gasMode: _gasMode, gasBuffer: _gasBuffer, minAmount: _minAmount, onUpdate: _onUpdate, ...rest } = options
  return rest
}

function feeFields(fee: TxFees) {
  return fee.type === 2 ? { type: 2, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas } : { type: 0, gasPrice: fee.gasPrice }
}

function toCollectResult(item: Item, to: string, outcome: TxOutcome): CollectItemResult {
  return {
    ...toWriteResult(item.index, item.signer.address, to, outcome),
    token: item.token,
    native: item.native,
    amount: item.amount.toString(),
    formatted: item.decimals === null ? null : formatUnits(item.amount, item.decimals),
  }
}
