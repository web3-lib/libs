import { SUI_COIN_TYPE, normalizeStructTag, normalizeSuiAddress } from '../address.js'
import type { SuiClient } from '../client.js'
import { getBalance } from '../services.js'
import { pure, type Argument } from './bcs.js'
import { PtbBuilder } from './ptb.js'
import { MAX_MERGE_COINS } from './transfer.js'
import { MAX_WITHDRAWALS, emptyOutcome, sendJobs, toWriteResult, type SendOptions, type TxJob, type WriteResult } from './send.js'
import { resolveSigner, type SignerInput } from './signer.js'

export interface BatchCollectOptions extends SendOptions {
  /**
   * 要归集的代币类型，默认只有 SUI。包含 SUI 时：有 sponsor 时转走全部 SUI；
   * 没有时把 gas 币整个转走（扣掉 gas 后剩下的全部，地址余额里的 SUI 不动）
   */
  tokens?: readonly string[]
  /** 付 gas 的钱包（赞助交易）：子钱包不需要 SUI，也不用先补 gas */
  sponsor?: SignerInput
}

export interface CollectResult extends WriteResult {
  /** 归集到的地址 */
  to: string
  /** 这个钱包归集了哪些代币（余额为 0 的不算） */
  tokens: string[]
}

/**
 * 多个钱包归集到一个地址：每个钱包一笔交易，把指定代币的全部 Coin 和地址余额转给 to。
 *
 * ```ts
 * await batchCollect(sui, [key1, key2], hotWallet, { tokens: [USDC, SUI_COIN_TYPE], sponsor: gasKey })
 * ```
 *
 * 有 sponsor 时 gas 由它付（Sui 原生的赞助交易），子钱包的 SUI 也能全部转走；
 * 没有时子钱包自己付 gas，没有 SUI 的钱包无法归集（结果为 failed）
 */
export async function batchCollect(client: SuiClient, wallets: readonly SignerInput[], to: string, options: BatchCollectOptions = {}): Promise<CollectResult[]> {
  const cache = new Map()
  const recipient = normalizeSuiAddress(to)
  const sponsor = options.sponsor === undefined ? undefined : await resolveSigner(options.sponsor, cache)
  const signers = await Promise.all(wallets.map((w) => resolveSigner(w, cache)))
  const tokens = [...new Set((options.tokens ?? [SUI_COIN_TYPE]).map(normalizeStructTag))]
  const results: CollectResult[] = signers.map((s, i) => ({ ...toWriteResult(i, s.address, emptyOutcome('skipped')), to: recipient, tokens: [] }))

  // 按输入顺序排（余额读取是并发的）
  const slots: Array<TxJob | null> = signers.map(() => null)
  const seen = new Set<string>()
  await Promise.all(
    signers.map(async (signer, i) => {
      // 同一个钱包传了多次：只归集一次
      if (seen.has(signer.address)) {
        results[i] = { ...(results[i] as CollectResult), error: 'skipped: duplicate wallet' }
        return
      }
      seen.add(signer.address)
      // 先看哪些代币有余额：都没有的钱包不发交易；读失败的钱包单独标记失败
      let balances: Awaited<ReturnType<typeof getBalance>>[]
      try {
        balances = await Promise.all(tokens.map((t) => getBalance(client.transport, signer.address, t, { signal: options.signal })))
      } catch (err) {
        results[i] = { ...toWriteResult(i, signer.address, emptyOutcome('failed', `could not read balances: ${err instanceof Error ? err.message : String(err)}`)), to: recipient, tokens: [] }
        return
      }
      const held = tokens.filter((t, k) => (balances[k]?.balance.balance ?? 0n) > 0n)
      const sponsored = !!sponsor && sponsor.address !== signer.address
      // 自己付 gas 时，只有 SUI 也要有 gas 币才能转
      const work = held.filter((t) => t !== SUI_COIN_TYPE || sponsored || (balances[tokens.indexOf(t)]?.balance.coinBalance ?? 0n) > 0n)
      if (!work.length) {
        results[i] = { ...results[i], ...toWriteResult(i, signer.address, emptyOutcome('skipped', 'nothing to collect')), to: recipient, tokens: [] }
        return
      }
      results[i] = { ...(results[i] as CollectResult), tokens: work }
      slots[i] = {
        sender: signer,
        sponsor,
        continueOnError: true,
        build: async (ctx) => {
          const ptb = new PtbBuilder()
          const sendAll: Argument[] = []
          let used = 0
          // 地址余额取款每笔最多 MAX_WITHDRAWALS 次，留一次给可能的地址余额付 gas；超出的代币只转 Coin，地址余额下次再归集
          let withdrawals = 0
          for (const token of work) {
            if (token === SUI_COIN_TYPE && !sponsored) {
              // gas 币：执行后剩下的全部转走
              sendAll.push(ptb.gas)
              continue
            }
            // 同类的 Coin 先合并成一个再转（一条命令最多 512 个参数）；Coin 特别多时每笔最多带 MAX_MERGE_COINS 个，剩下的再归集一次
            const coins = (await ctx.coins(signer.address, token)).slice(0, Math.max(0, MAX_MERGE_COINS - used))
            used += coins.length
            const parts = coins.map((c) => ptb.owned(c))
            const addressBalance = await ctx.addressBalance(signer.address, token)
            if (addressBalance > 0n && withdrawals < MAX_WITHDRAWALS - 1) {
              withdrawals++
              parts.push(ptb.moveCall('0x2::coin::redeem_funds', [token], [ptb.withdrawal(addressBalance, token)]))
            }
            const [primary, ...rest] = parts
            if (!primary) continue
            for (let k = 0; k < rest.length; k += 500) ptb.command({ kind: 'mergeCoins', destination: primary, sources: rest.slice(k, k + 500) })
            sendAll.push(primary)
          }
          if (!sendAll.length) throw new Error('nothing to collect')
          ptb.command({ kind: 'transferObjects', objects: sendAll, address: ptb.pure(pure.address(recipient)) })
          return ptb.build()
        },
        onUpdate: (outcome) => {
          results[i] = { ...toWriteResult(i, signer.address, outcome), to: recipient, tokens: work }
          options.onUpdate?.(results[i] as CollectResult)
        },
      }
    }),
  )
  await sendJobs(client, slots.filter((j): j is TxJob => j !== null), options)
  return results
}
