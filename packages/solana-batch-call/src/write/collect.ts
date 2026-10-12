import { getAssociatedTokenAddress, isAddress } from '../address.js'
import type { SolanaClient } from '../client.js'
import { formatUnits } from '../layout.js'
import type { TokenBalance } from '../types.js'
import { closeAccount, createAssociatedTokenAccountIdempotent, systemTransfer } from './instructions.js'
import { emptyOutcome, priorityFeeFor, sendUnits, toWriteResult, transactionFee, type SendOptions, type TxOutcome, type Unit, type WriteResult } from './send.js'
import { resolveSigner, type ResolvedSigner, type SignerInput } from './signer.js'
import { transferInstructions } from './transfer.js'

/** 扫空 SOL 的交易（一条 System 转账 + 两条计算预算指令）用的计算单元上限 */
const SWEEP_COMPUTE_UNITS = 1_000

export interface BatchCollectOptions extends SendOptions {
  /**
   * 要归集的代币 mint。包含原生 SOL（NATIVE_MINT）时，在代币归集确认后把剩余 SOL 全部转走：
   * 传了 feePayer 时整个余额转走（手续费由 feePayer 付），否则扣掉这笔的手续费后转走，钱包余额归零
   */
  tokens: readonly string[]
  /**
   * 代币转完后关闭钱包的代币账户（ATA），租金（约 0.00204 SOL / 个）退回钱包本身；同时扫 SOL 时一并转走。默认 false。
   * Token-2022 账户里有未提取的转账手续费等情况关不掉，只影响 close 那一项
   */
  closeAccounts?: boolean
  /** 各代币的最小归集数量（最小单位），余额低于它的不归集：`{ [USDC]: 1_000_000n }`；对 SOL 同样有效 */
  minAmount?: Readonly<Record<string, bigint | number | string>>
  /** 每笔交易最多几个调用，默认不限（按交易大小） */
  batchSize?: number
}

/** 单个钱包单个代币的归集结果；from 是钱包，to 是归集地址 */
export interface CollectItemResult extends WriteResult {
  to: string
  token: string
  native: boolean
  /** 归集的数量（最小单位）；SOL 扫尾在发送前为 '0' */
  amount: string
  formatted: string | null
  /** closeAccounts 时关闭代币账户的结果；没有关闭（未开启、SOL、没有归集）时为 null */
  close: WriteResult | null
}

export interface CollectResult {
  /** 按 wallets × tokens 顺序（第 i 个钱包第 j 个代币在 i × tokens.length + j） */
  results: CollectItemResult[]
}

interface Item {
  index: number
  signer: ResolvedSigner
  token: string
  native: boolean
  amount: bigint
  decimals: number | null
  tokenProgram: string | null
  result: CollectItemResult
}

/**
 * 归集：多个钱包的代币 / SOL 转到同一个地址。
 *
 * ```ts
 * const { results } = await batchCollect(client, [key1, key2, key3], hotWallet, {
 *   tokens: [USDC, NATIVE_MINT],   // 包含 SOL 表示代币归集完后扫空 SOL
 *   feePayer: gasKey,              // 手续费都由 gasKey 付：子钱包不需要有 SOL，多个钱包的转账打包进同一笔交易
 * })
 * ```
 *
 * 流程：一次读出所有钱包的余额 → 归集地址没有该代币的 ATA 时随第一批转账创建 → 打包发送代币转账（可选关闭代币账户）
 * →（包含 SOL 时）等代币归集确认，按最新余额扫空 SOL。
 * 不传 feePayer 时每个钱包自己付手续费，没有 SOL 的钱包对应的项失败（Solana 上不需要先补 gas：传 feePayer 即可）
 */
export async function batchCollect(client: SolanaClient, wallets: readonly SignerInput[], to: string, options: BatchCollectOptions): Promise<CollectResult> {
  if (!isAddress(to)) {
    throw new Error(`Invalid collect address: ${to}`)
  }
  const cache = new Map()
  const signers = await Promise.all(wallets.map((w) => resolveSigner(w, cache)))
  const feePayer = options.feePayer === undefined ? null : await resolveSigner(options.feePayer, cache)
  const tokens = options.tokens
  const sweep = tokens.some((t) => client.isNativeMint(t))
  const minAmount = new Map(Object.entries(options.minAmount ?? {}).map(([k, v]) => [k, BigInt(v)]))
  const balances = await client.multiBalances(
    signers.map((s) => ({ owner: s.address, mints: tokens })),
    { signal: options.signal },
  )

  const items: Item[] = []
  const seen = new Set<string>()
  signers.forEach((signer, w) => {
    const duplicate = seen.has(signer.address)
    seen.add(signer.address)
    tokens.forEach((token, t) => {
      const balance = balances[w]?.[t] as TokenBalance
      const native = client.isNativeMint(token)
      const item: Item = {
        index: w * tokens.length + t,
        signer,
        token,
        native,
        amount: native || !balance.success ? 0n : BigInt(balance.balance),
        decimals: balance.success ? balance.decimals : null,
        tokenProgram: balance.tokenProgram,
        result: null as unknown as CollectItemResult,
      }
      const skip = !balance.success
        ? `cannot read balance: ${balance.error ?? 'unknown error'}`
        : signer.address === to
          ? 'skipped: wallet is the collect address'
          : duplicate
            ? 'skipped: duplicate wallet'
            : native && feePayer?.address === signer.address
              ? 'skipped: wallet is the fee payer'
              : !native && item.amount === 0n
                ? 'skipped: zero balance'
                : !native && item.amount < (minAmount.get(token) ?? 0n)
                  ? 'skipped: below minAmount'
                  : null
      item.result = toCollectResult(item, to, emptyOutcome(skip ? (balance.success ? 'skipped' : 'failed') : 'skipped', skip), null)
      items.push(item)
    })
  })
  const results = items.map((i) => i.result)
  const report = (item: Item, outcome: TxOutcome, close: WriteResult | null = item.result.close) => {
    const hint =
      !feePayer && outcome.status === 'failed' && /transaction fee|fee payer/.test(outcome.error ?? '') && !outcome.error?.includes('feePayer')
        ? ' (pass feePayer to pay fees from another wallet)'
        : ''
    item.result = toCollectResult(item, to, { ...outcome, error: outcome.error && outcome.error + hint }, close)
    results[item.index] = item.result
    options.onUpdate?.(item.result)
  }
  const active = (item: Item) => item.result.error === null

  // 归集地址的 ATA：没有的话随转账创建（创建指令是幂等的，同一代币的多笔转账都带上，只有第一笔真正创建）
  const tokenItems = items.filter((i) => !i.native && active(i))
  const targetAtas = new Map(tokenItems.map((i) => [i.token, getAssociatedTokenAddress(to, i.token, i.tokenProgram as string)]))
  const missing = new Set<string>()
  if (targetAtas.size) {
    const keys = [...targetAtas.values()]
    const accounts = await client.accounts(keys, { signal: options.signal })
    keys.forEach((k, i) => !accounts[i] && missing.add(k))
  }

  // 不传 feePayer 时每个钱包自己付费：如果每笔转账都带创建指令，模拟时每个钱包都要付得起租金（实际只创建一次）。
  // 先由第一个有这种代币的钱包单独创建，确认后再归集；创建失败时退回到每笔都带创建指令
  if (!feePayer && missing.size && !options.dryRun) {
    const setup: Unit[] = []
    for (const [mint, ata] of targetAtas) {
      if (!missing.has(ata)) continue
      const first = tokenItems.find((i) => i.token === mint) as Item
      setup.push({
        instructions: [createAssociatedTokenAccountIdempotent(first.signer.address, ata, to, mint, first.tokenProgram as string)],
        payer: first.signer,
        signers: [],
        continueOnError: true,
        onUpdate: (outcome) => outcome.status === 'confirmed' && missing.delete(ata),
      })
    }
    await sendUnits(client, setup, { ...options, wait: true }, { batchSize: 1 })
  }

  const units: Unit[] = []
  /** 每个钱包最后一笔上链交易的 slot（扫 SOL 时按不早于它的状态读余额） */
  let minSlot: number | undefined
  const track = (outcome: TxOutcome) => {
    if (outcome.slot !== null) minSlot = Math.max(minSlot ?? 0, outcome.slot)
  }
  for (const item of tokenItems) {
    const payer = feePayer ?? item.signer
    const signerList = payer.address === item.signer.address ? [] : [item.signer]
    const target = targetAtas.get(item.token) as string
    units.push({
      instructions: transferInstructions(item.signer, payer, { ...item, to }, target, missing.has(target)),
      payer,
      signers: signerList,
      continueOnError: true,
      onUpdate: (outcome) => {
        track(outcome)
        report(item, outcome)
      },
    })
    if (options.closeAccounts) {
      const program = item.tokenProgram as string
      const account = getAssociatedTokenAddress(item.signer.address, item.token, program)
      units.push({
        instructions: [closeAccount(account, item.signer.address, item.signer.address, program)],
        payer,
        signers: signerList,
        continueOnError: true,
        onUpdate: (outcome) => {
          track(outcome)
          report(item, outcomeOf(item.result), toWriteResult(item.index, item.signer.address, outcome))
        },
      })
    }
  }
  // 要扫 SOL 时必须等代币归集确认（扫的是最新余额，关闭账户退回的租金也要算进去）
  await sendUnits(client, units, sweep ? { ...options, wait: true } : options, { batchSize: options.batchSize })

  if (!sweep) {
    return { results }
  }
  // 代币没有全部归集成功的钱包不扫 SOL：留着付之后重新归集的手续费
  items
    .filter((i) => i.native && active(i))
    .forEach((native) => {
      const unfinished = items.find((i) => !i.native && i.signer.address === native.signer.address && i.result.status !== 'confirmed' && i.result.status !== 'skipped')
      if (unfinished) {
        report(native, emptyOutcome('skipped', `skipped: collecting ${unfinished.token} did not succeed (${unfinished.result.status})`))
      }
    })
  const sweepItems = items.filter((i) => i.native && active(i))
  if (!sweepItems.length || options.signal?.aborted) {
    return { results }
  }
  if (options.dryRun) {
    // 代币归集没有真的执行，扫 SOL 的金额要等归集之后才知道：只标记 simulated，不做模拟
    sweepItems.forEach((i) => report(i, emptyOutcome('simulated')))
    return { results }
  }
  let lamports: Awaited<ReturnType<SolanaClient['solBalances']>>
  try {
    lamports = await client.solBalances(
      sweepItems.map((i) => i.signer.address),
      { minContextSlot: minSlot, signal: options.signal },
    )
  } catch (err) {
    // 代币归集已经发出：不能整体抛错（调用方会拿不到这些结果），扫 SOL 的项标记失败
    sweepItems.forEach((i) => report(i, emptyOutcome('failed', `cannot read SOL balance: ${err instanceof Error ? err.message : String(err)}`)))
    return { results }
  }
  const prepared = await Promise.all(
    sweepItems.map(async (item, k): Promise<Unit | null> => {
      const balance = BigInt(lamports[k]?.balance ?? '0')
      let amount = balance
      let fixed: Unit['fixed']
      if (!feePayer) {
        // 自己付手续费：单独一笔、手续费事先算好，转走剩下的全部（余额归零，不受租金下限限制）
        const price = await priorityFeeFor(client, options, [item.signer.address, to])
        fixed = { computeUnits: SWEEP_COMPUTE_UNITS, price }
        amount = balance - transactionFee(1, SWEEP_COMPUTE_UNITS, price)
      }
      const min = minAmount.get(item.token) ?? 0n
      if (amount <= 0n || amount < min) {
        report(item, emptyOutcome('skipped', amount <= 0n ? 'skipped: SOL balance does not cover the fee' : 'skipped: below minAmount'))
        return null
      }
      item.amount = amount
      const payer = feePayer ?? item.signer
      return {
        instructions: [systemTransfer(item.signer.address, to, amount)],
        payer,
        signers: payer.address === item.signer.address ? [] : [item.signer],
        fixed,
        continueOnError: true,
        onUpdate: (outcome) => report(item, outcome),
      }
    }),
  )
  await sendUnits(
    client,
    prepared.filter((u): u is Unit => u !== null),
    options,
    { batchSize: options.batchSize },
  )
  return { results }
}

/** 结果转回交易结果（更新 close 字段时保留转账本身的状态） */
function outcomeOf(r: WriteResult): TxOutcome {
  return { status: r.status, signature: r.signature, slot: r.slot, fee: r.fee === null ? null : BigInt(r.fee), computeUnits: r.computeUnits, error: r.error }
}

function toCollectResult(item: Item, to: string, outcome: TxOutcome, close: WriteResult | null): CollectItemResult {
  return {
    ...toWriteResult(item.index, item.signer.address, outcome),
    to,
    token: item.token,
    native: item.native,
    amount: item.amount.toString(),
    formatted: item.decimals === null ? null : formatUnits(item.amount, item.decimals),
    close,
  }
}
