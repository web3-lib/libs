/**
 * EVM 与 Tron 共用的批量转账 / 归集规划：解析数量、汇总检查余额、生成归集项和跳过原因、结果格式。
 * 链的差异（地址规范化、收款地址校验、数量解析与零值规则）通过 ChainRules 注入
 */
import { getAddress, getBigInt, parseUnits, type BigNumberish } from 'ethers'

import { NATIVE_TOKEN, formatUnits, type TokenBalance } from '../erc20.js'
import type { Provider } from '../provider.js'
import type { CollectItemResult } from './collect.js'
import { emptyOutcome, toWriteResult, type TxOutcome } from './send.js'
import type { BatchTransferOptions, TransferItem } from './transfer.js'

export interface ChainRules {
  /** 代币在余额表、汇总、minAmount 里的 key（主币一律小写） */
  tokenKey(token: string): string
  /** 代币地址的规范形式（结果里的 token；入参是 tokenKey 的结果） */
  token(key: string): string
  /** 地址的规范形式（收款地址、归集地址）；非法时抛错 */
  address(address: string): string
  /** 钱包地址的去重 key（EVM 不区分大小写；Tron 的 T 地址区分） */
  walletKey(address: string): string
  /** 转账规划时先校验收款地址（Tron 先报地址错误再校验数量；EVM 在最后规范化时由 getAddress 报错） */
  checkRecipient?(to: string, index: number): void
  /** 解析最小单位的数量（EVM 用 getBigInt；Tron 用 BigInt） */
  amount(value: BigNumberish): bigint
  /** 数量不合法时的错误信息，合法时为 null（Tron 的 TRX 转账数量必须大于 0，EVM 允许 0） */
  invalidAmount(amount: bigint, native: boolean): string | null
}

/** EVM：地址统一成 checksum，代币 key 小写；数量用 getBigInt，允许 0（包括主币） */
export const EVM_RULES: ChainRules = {
  tokenKey: (token) => token.toLowerCase(),
  token: (key) => getAddress(key),
  address: (address) => getAddress(address),
  walletKey: (address) => address.toLowerCase(),
  amount: (value) => getBigInt(value),
  invalidAmount: (amount) => (amount < 0n ? 'amount must not be negative' : null),
}

/** 解析后的收款项 */
export interface PlannedTransfer {
  index: number
  to: string
  token: string
  native: boolean
  amount: bigint
  decimals: number | null
}

/** 解析数量（formatted 按精度换算）并按代币汇总检查余额（checkBalance，默认开） */
export async function planTransfers(
  provider: Provider,
  owner: string,
  recipients: readonly TransferItem[],
  options: Pick<BatchTransferOptions, 'token' | 'checkBalance'>,
  rules: ChainRules,
): Promise<PlannedTransfer[]> {
  const defaultToken = options.token ?? NATIVE_TOKEN
  const keyOf = (token: string) => (provider.isNativeToken(token) ? token.toLowerCase() : rules.tokenKey(token))
  const tokens = [...new Set(recipients.map((r) => keyOf(r.token ?? defaultToken)))]
  const balances = tokens.length ? await provider.balances(owner, tokens) : []
  const info = new Map(balances.map((b, i) => [tokens[i] as string, b]))
  const planned = recipients.map((item, index): PlannedTransfer => {
    const key = keyOf(item.token ?? defaultToken)
    const balance = info.get(key)
    const native = provider.isNativeToken(key)
    const decimals = balance?.success ? balance.decimals : null
    rules.checkRecipient?.(item.to, index)
    if ((item.amount === undefined) === (item.formatted === undefined)) {
      throw new Error(`recipients[${index}]: pass exactly one of amount / formatted`)
    }
    let amount: bigint
    if (item.formatted !== undefined) {
      if (decimals === null) {
        throw new Error(`recipients[${index}]: cannot read decimals of ${item.token ?? defaultToken}, pass amount instead of formatted`)
      }
      amount = parseUnits(item.formatted, decimals)
    } else {
      amount = rules.amount(item.amount as BigNumberish)
    }
    const invalid = rules.invalidAmount(amount, native)
    if (invalid) {
      throw new Error(`recipients[${index}]: ${invalid}`)
    }
    return { index, to: rules.address(item.to), token: native ? (item.token ?? defaultToken) : rules.token(key), native, amount, decimals }
  })
  if (options.checkBalance ?? true) {
    const totals = new Map<string, bigint>()
    planned.forEach((p) => totals.set(keyOf(p.token), (totals.get(keyOf(p.token)) ?? 0n) + p.amount))
    for (const [token, total] of totals) {
      const balance = info.get(token)
      if (!balance?.success) {
        throw new Error(`Cannot read the balance of ${token} (${balance?.error ?? 'unknown error'}); pass checkBalance: false to skip the check`)
      }
      if (BigInt(balance.balance) < total) {
        throw new Error(`Insufficient balance of ${token}: need ${total}, have ${balance.balance}`)
      }
    }
  }
  return planned
}

/** 单个钱包单个代币的归集项 */
export interface CollectItem<S extends { address: string }> {
  index: number
  /** 第几个钱包（balances 的行号） */
  wallet: number
  signer: S
  token: string
  native: boolean
  amount: bigint
  decimals: number | null
  /** EVM：预估的 gasLimit（Tron 不用） */
  gasLimit: bigint | null
  result: CollectItemResult
}

export interface CollectPlan<S extends { address: string }> {
  /** 实际归集的代币（options.tokens，或默认的主币） */
  tokens: readonly string[]
  items: CollectItem<S>[]
  /** 与 items 同序的结果数组（report 会原地更新） */
  results: CollectItemResult[]
  /** 余额表：balances[钱包][代币]，最后一列（或主币所在列）是主币余额 */
  balances: TokenBalance[][]
  /** 主币余额在每行的第几列 */
  nativeAt: number
  /** tokens 里包含主币：代币归集完后扫空主币 */
  sweep: boolean
  /** minAmount 按 tokenKey */
  minAmount: Map<string, bigint>
  /** 更新一项的结果并回调 onUpdate */
  report(item: CollectItem<S>, outcome: TxOutcome): void
  /** 还没有失败 / 跳过原因的项 */
  active(item: CollectItem<S>): boolean
}

/**
 * 归集的公共前半段：一次 multicall 读出所有钱包的代币 + 主币余额，生成 wallets × tokens 的归集项，
 * 标出读不到余额、钱包就是归集地址、重复钱包、零余额、低于 minAmount 的项
 */
export async function planCollect<S extends { address: string }>(
  provider: Provider,
  signers: readonly S[],
  target: string,
  options: { tokens: readonly string[]; minAmount?: Readonly<Record<string, BigNumberish>>; onUpdate?: (result: CollectItemResult) => void },
  rules: ChainRules,
): Promise<CollectPlan<S>> {
  const tokens = options.tokens
  const nativeIndex = tokens.findIndex((t) => provider.isNativeToken(t))
  const sweep = nativeIndex >= 0
  const keyOf = (token: string) => (provider.isNativeToken(token) ? token.toLowerCase() : rules.tokenKey(token))
  // 不归集主币时也多查一列主币余额（算手续费要用）
  const queryTokens = sweep ? [...tokens] : [...tokens, NATIVE_TOKEN]
  const nativeAt = sweep ? nativeIndex : tokens.length
  const balances = (await provider.multiBalances(signers.map((s) => ({ owner: s.address, tokens: queryTokens })))) as TokenBalance[][]
  const minAmount = new Map(Object.entries(options.minAmount ?? {}).map(([k, v]) => [keyOf(k), rules.amount(v)]))

  const items: CollectItem<S>[] = []
  const seen = new Set<string>()
  signers.forEach((signer, w) => {
    const duplicate = seen.has(rules.walletKey(signer.address))
    seen.add(rules.walletKey(signer.address))
    tokens.forEach((token, t) => {
      const balance = balances[w]?.[t] as TokenBalance
      const native = t === nativeIndex
      const item: CollectItem<S> = {
        index: w * tokens.length + t,
        wallet: w,
        signer,
        token: native ? token : rules.token(rules.tokenKey(token)),
        native,
        amount: native || !balance.success ? 0n : BigInt(balance.balance),
        decimals: balance.success ? balance.decimals : null,
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
              : !native && item.amount < (minAmount.get(keyOf(token)) ?? 0n)
                ? 'skipped: below minAmount'
                : null
      item.result = toCollectResult(item, target, emptyOutcome(skip && !balance.success ? 'failed' : 'skipped', skip))
      items.push(item)
    })
  })
  const results = items.map((i) => i.result)
  return {
    tokens,
    items,
    results,
    balances,
    nativeAt,
    sweep,
    minAmount,
    report: (item, outcome) => {
      item.result = toCollectResult(item, target, outcome)
      results[item.index] = item.result
      options.onUpdate?.(item.result)
    },
    active: (item) => item.result.error === null,
  }
}

/** 要归集的代币：不传时只扫空主币（Provider 配置的第一个主币地址） */
export function collectTokens(options: { tokens?: readonly string[] }, provider?: Pick<Provider, 'nativeTokens' | 'isNativeToken'>): readonly string[] {
  if (options.tokens) {
    return options.tokens
  }
  // 默认 NATIVE_TOKEN；Provider 的 nativeTokens 不含它时用配置的第一个
  return [!provider || provider.isNativeToken(NATIVE_TOKEN) ? NATIVE_TOKEN : (provider.nativeTokens[0] ?? NATIVE_TOKEN)]
}

/** 归集项的结果（EVM / Tron 共用） */
export function toCollectResult(item: Pick<CollectItem<{ address: string }>, 'index' | 'signer' | 'token' | 'native' | 'amount' | 'decimals'>, to: string, outcome: TxOutcome): CollectItemResult {
  return {
    ...toWriteResult(item.index, item.signer.address, to, outcome),
    token: item.token,
    native: item.native,
    amount: item.amount.toString(),
    formatted: item.decimals === null ? null : formatUnits(item.amount, item.decimals),
  }
}
