import { isValidTonAddress, toFriendlyAddress, toRawAddress } from '../address.js'
import type { TonClient } from '../client.js'
import { NATIVE_TON } from '../constants.js'
import { jettonTransferBody } from './message.js'
import { emptyOutcome, messageOutcome, refreshWallets, resolveWallets, sendJobs, toWriteResult, type SendMessage, type SendOptions, type TxJob, type TxOutcome, type WalletContext, type WriteResult } from './send.js'
import type { TonSignerInput } from './signer.js'
import { DEFAULT_JETTON_GAS, FEE_RESERVE, MESSAGE_FEE_RESERVE } from './transfer.js'

export interface BatchCollectOptions extends SendOptions {
  /** 要归集的代币：NATIVE_TON 和 / 或 Jetton 主合约地址，默认只有 TON。包含 TON 时，最后一条消息把剩下的 TON 全部转走 */
  tokens?: readonly string[]
  /**
   * 给 TON 不够付 Jetton 转账 gas 的钱包先补 TON 的钱包（一笔交易补多个钱包），补完再归集。
   * 不传时这些钱包的归集会失败
   */
  gasFunder?: TonSignerInput
  /** 每笔 Jetton 转账附带的 TON，默认 0.05 TON；补 gas 时按它算 */
  jettonGas?: bigint
  /** Jetton 转账给收款地址的通知附带的 TON，默认 1 nanoTON */
  forwardAmount?: bigint
  /** TON 余额不到这么多的钱包不归集 TON（不够手续费），默认 0.01 TON */
  minTon?: bigint
}

export interface CollectResult extends WriteResult {
  to: string
  /** 这个钱包归集了哪些代币（余额为 0 的不算） */
  tokens: string[]
  /** 补 gas 的结果（补过时） */
  funding: WriteResult | null
}


/**
 * 多个钱包归集到一个地址：每个钱包一笔交易（Jetton 多时分几笔），转走全部 Jetton，包含 TON 时最后把剩下的 TON 全部转走。
 *
 * ```ts
 * await batchCollect(ton, [mnemonic1, mnemonic2], hotWallet, { tokens: [USDT, NATIVE_TON], gasFunder: gasMnemonic })
 * ```
 *
 * TON 上没有代付手续费：Jetton 转账要用钱包自己的 TON 付 gas。传 gasFunder 时，先给不够的钱包补上
 * （每个 Jetton jettonGas + 手续费），再归集；包含 TON 时补的 TON 剩下的部分也会一起归集回来。
 * 没部署的钱包（只收过款）在第一笔交易里自动部署
 */
export async function batchCollect(client: TonClient, wallets: readonly TonSignerInput[], to: string, options: BatchCollectOptions = {}): Promise<CollectResult[]> {
  if (!isValidTonAddress(to)) throw new Error(`Invalid TON address: ${to}`)
  const recipient = toRawAddress(to)
  const tokens = [...new Set((options.tokens ?? [NATIVE_TON]).map((t) => (t === NATIVE_TON ? NATIVE_TON : toRawAddress(t))))]
  const jettons = tokens.filter((t) => t !== NATIVE_TON)
  const withTon = tokens.includes(NATIVE_TON)
  const jettonGas = options.jettonGas ?? DEFAULT_JETTON_GAS
  const forwardAmount = options.forwardAmount ?? 1n
  const minTon = options.minTon ?? FEE_RESERVE

  // 没指定版本的私钥钱包：持有要归集的 Jetton 的那个地址优先（只收过 Jetton、没部署的旧版本钱包也能找到）
  const holders = async (addresses: readonly string[]) => {
    if (!jettons.length) return new Set<string>()
    const rows = await client.multiBalances(addresses.map((owner) => ({ owner, tokens: jettons })), { signal: options.signal })
    return new Set(addresses.filter((_, k) => (rows[k] ?? []).some((b) => b.success && BigInt(b.balance) > 0n)))
  }
  const contexts = await resolveWallets(client, wallets, { signal: options.signal, holders })
  const balances = await client.multiBalances(
    contexts.map((c) => ({ owner: c.address, tokens: [NATIVE_TON, ...jettons] })),
    { signal: options.signal },
  )
  const results: CollectResult[] = contexts.map((c, i) => ({ ...toWriteResult(i, c.friendly, emptyOutcome('skipped')), to, tokens: [], funding: null }))
  const tokenLabel = (t: string) => (t === NATIVE_TON ? NATIVE_TON : toFriendlyAddress(t))

  interface Plan {
    index: number
    wallet: WalletContext
    jettons: Array<{ token: string; wallet: string; amount: bigint }>
    ton: bigint
    /** 付 Jetton gas 和手续费还差多少 TON */
    shortfall: bigint
  }
  const plans: Plan[] = []
  const seen = new Set<string>()
  contexts.forEach((wallet, i) => {
    const list = balances[i] ?? []
    if (wallet.address === recipient) {
      results[i] = { ...(results[i] as CollectResult), error: 'skipped: the wallet is the recipient' }
      return
    }
    if (seen.has(wallet.address)) {
      results[i] = { ...(results[i] as CollectResult), error: 'skipped: duplicate wallet' }
      return
    }
    seen.add(wallet.address)
    const held = jettons.flatMap((token, k) => {
      const b = list[k + 1]
      const amount = BigInt(b?.balance ?? '0')
      return b?.success && b.wallet && amount > 0n ? [{ token, wallet: b.wallet, amount }] : []
    })
    const ton = BigInt(list[0]?.balance ?? '0')
    const txs = Math.max(1, Math.ceil((held.length + (withTon ? 1 : 0)) / wallet.maxMessages))
    const need = BigInt(held.length) * (jettonGas + forwardAmount + MESSAGE_FEE_RESERVE) + FEE_RESERVE * BigInt(txs)
    const sweepTon = withTon && (held.length > 0 || ton >= minTon)
    if (!held.length && !sweepTon) {
      results[i] = { ...(results[i] as CollectResult), error: 'skipped: nothing to collect' }
      return
    }
    plans.push({ index: i, wallet, jettons: held, ton, shortfall: held.length && ton < need ? need - ton : 0n })
  })

  // 先补 gas：一笔交易补多个钱包，确认后再归集
  const funded = new Set<number>()
  const needy = plans.filter((p) => p.shortfall > 0n)
  if (needy.length && options.gasFunder !== undefined) {
    const [funder] = await resolveWallets(client, [options.gasFunder], options.signal)
    const f = funder as WalletContext
    const jobs: TxJob[] = []
    for (let k = 0; k < needy.length; k += f.maxMessages) {
      const chunk = needy.slice(k, k + f.maxMessages)
      jobs.push({
        wallet: f,
        // 补的 TON 发给可能没部署的钱包：不可回弹
        messages: chunk.map((p): SendMessage => ({ message: { to: p.wallet.address, value: p.shortfall, bounce: false } })),
        // 每个钱包看自己那条消息（钱包会跳过发不出的消息，同一笔里可能有的补上了、有的没有）
        onUpdate: (outcome) =>
          chunk.forEach((p, k) => {
            const own = messageOutcome(outcome, k)
            const funding = toWriteResult(p.index, f.friendly, own)
            results[p.index] = { ...(results[p.index] as CollectResult), funding }
            if (own.status === 'confirmed' || own.status === 'simulated') funded.add(p.index)
          }),
      })
    }
    await sendJobs(client, jobs, { ...options, onUpdate: undefined })
    if (!options.dryRun) {
      // 再读一次状态：补到 TON 的钱包（部署状态、余额），以及付款钱包本身也要归集时（seqno 变了）
      // 地址、版本不变，只更新状态
      const stale = plans.filter((p) => funded.has(p.index) || p.wallet.address === f.address)
      const fresh = await refreshWallets(client, stale.map((p) => p.wallet), options.signal)
      stale.forEach((p, k) => (p.wallet = fresh[k] as WalletContext))
    }
  }

  const jobs: TxJob[] = []
  for (const p of plans) {
    if (p.shortfall > 0n && !funded.has(p.index)) {
      const reason = options.gasFunder === undefined ? 'not enough TON to pay the jetton transfer gas (pass gasFunder to top it up)' : 'topping up gas failed'
      results[p.index] = { ...(results[p.index] as CollectResult), ...toWriteResult(p.index, p.wallet.friendly, emptyOutcome('failed', reason)), funding: results[p.index]?.funding ?? null }
      continue
    }
    const messages: SendMessage[] = p.jettons.map((j) => ({
      message: {
        to: j.wallet,
        value: jettonGas + forwardAmount,
        bounce: true,
        body: jettonTransferBody({ amount: j.amount, destination: recipient, responseDestination: withTon ? recipient : p.wallet.address, forwardTonAmount: forwardAmount }),
      },
    }))
    // 剩下的 TON 全部转走（模式 128，必须是最后一条）
    if (withTon) messages.push({ message: { to: recipient, value: 0n, bounce: false }, mode: 128 })
    const work = [...p.jettons.map((j) => tokenLabel(j.token)), ...(withTon ? [NATIVE_TON] : [])]
    results[p.index] = { ...(results[p.index] as CollectResult), tokens: work }
    if (options.dryRun && p.shortfall > 0n) {
      // 模拟不出补 gas 之后的状态
      results[p.index] = { ...(results[p.index] as CollectResult), ...toWriteResult(p.index, p.wallet.friendly, emptyOutcome('simulated', 'not simulated: depends on the gas top-up')) }
      continue
    }
    // Jetton 多时分几笔：结果取第一笔没成功的，都成功时取最后一笔
    const outcomes: TxOutcome[] = []
    for (let k = 0; k < messages.length; k += p.wallet.maxMessages) {
      const slot = outcomes.length
      outcomes.push(emptyOutcome('skipped'))
      jobs.push({
        wallet: p.wallet,
        messages: messages.slice(k, k + p.wallet.maxMessages),
        onUpdate: (outcome) => {
          outcomes[slot] = outcome
          const shown = outcomes.find((o, n) => n <= slot && o.status !== 'confirmed' && o.status !== 'simulated') ?? outcome
          results[p.index] = { ...(results[p.index] as CollectResult), ...toWriteResult(p.index, p.wallet.friendly, shown) }
          options.onUpdate?.(results[p.index] as CollectResult)
        },
      })
    }
  }
  await sendJobs(client, jobs, options)
  return results
}
