/**
 * 手续费估算（子路径 `@w3lib/ton-batch-call/fees`）：用 toncenter 的 emulateTrace 模拟整条交易链（与 /write 发送前的模拟相同），
 * 算出钱包付的手续费（导入外部消息、存储、计算、转发）、附带的 TON、退回钱包的 TON、整条链的手续费。
 * TON 没有手续费市场（价格由链上配置决定，不随拥堵变化），所以没有快慢档
 */
import { isValidTonAddress, toRawAddress } from './address.js'
import type { TonClient } from './client.js'
import { TON_DECIMALS } from './constants.js'
import { formatUnits } from './format.js'
import { toSendMessage, type CallMessage } from './write/batch.js'
import { buildExternal, emulate, evaluateTrace, resolveWallets, type Trace, type TraceMessage, type TraceTx, type WalletContext } from './write/send.js'
import type { TonConnectLike, TonSignerInput } from './write/signer.js'

export interface FeeCall {
  /**
   * 发送的钱包：同 /write（助记词、私钥、签名器、TON Connect），或者直接传钱包地址（只读：要已部署的 v4r2 / v5r1 钱包）。
   * 估算不签名（空签名、模拟时不检查签名），私钥只用来算地址和公钥
   */
  from: TonSignerInput
  /** 与 batchCall 的 messages 相同 */
  messages: readonly CallMessage[]
}

export interface EstimateCostOptions {
  /** 外部消息的有效期（秒），默认 60（只影响模拟用的消息） */
  validFor?: number
  signal?: AbortSignal
}

/** 钱包交易的手续费明细（nanoTON 的十进制字符串） */
export interface TonFeeBreakdown {
  /** 导入外部消息（按消息大小；部署钱包时含 StateInit） */
  import: string
  /** 存储费：钱包上次交易以来欠的 */
  storage: string
  /** 计算（gas） */
  gas: string
  /** 动作：发出消息的转发费里发送时收的部分 */
  action: string
  /** 发出消息的转发费里其余的部分（到目标时收）。发送模式带 +1 时另从余额里扣，不带时从消息的金额里扣 */
  forward: string
}

export interface TonCostEstimate {
  index: number
  /** 发送的钱包（用户友好格式） */
  from: string
  /** null 为模拟通过；否则是失败原因（钱包拒绝、消息没发出、后面的合约失败退回、不能模拟等）。有模拟结果时数值是失败的这条链的 */
  error: string | null
  /** 有没有模拟结果：钱包拒绝外部消息（余额不够付手续费、seqno 等）、不知道钱包版本、模拟服务不可用时为 false，下面的数值都是 null */
  simulated: boolean
  /** 交易链太长、模拟结果被截断：returned、chainFee 只算了已有的部分 */
  incomplete: boolean
  /** 钱包交易（外部消息触发的那笔）的手续费明细 */
  walletFees: TonFeeBreakdown | null
  /** 钱包付的手续费（nanoTON）：钱包交易的手续费 + 发出消息的转发费 + 交易链里钱包之后的交易（如收到退回的 TON）的手续费 */
  fee: string | null
  /** fee 按 TON 换算 */
  feeFormatted: string | null
  /** 钱包发出的消息附带的 TON（实际金额：模式 64 / 128 带上的余额、模式不带 +1 时扣掉的转发费都按模拟结果） */
  attached: string | null
  attachedFormatted: string | null
  /** 交易链里回到钱包的 TON（Jetton 转账等多余的 gas、失败退回的消息） */
  returned: string | null
  returnedFormatted: string | null
  /** 钱包 TON 余额的净变化 = returned − attached − fee（负数是减少） */
  balanceChange: string | null
  balanceChangeFormatted: string | null
  /** 整条交易链的手续费：所有交易的手续费 + 所有消息的转发费（含其他合约付的：大多从附带的 TON 里出，也有合约用自己余额付的存储费） */
  chainFee: string | null
  chainFeeFormatted: string | null
}

const num = (v: string | null | undefined) => BigInt(v ?? '0')
const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n)
/** 内部消息（外部发出的日志消息没有目标） */
const internal = (tx: TraceTx) => (tx.out_msgs ?? []).filter((m): m is TraceMessage & { destination: string } => !!m.destination)

/** 交易链的费用：钱包的交易按 lt 排序，第一笔是外部消息触发的 */
export function traceCosts(trace: Trace, wallet: string) {
  const root = trace.transactions[trace.trace.tx_hash] as TraceTx
  const all = Object.values(trace.transactions)
  const own = all.filter((tx) => toRawAddress(tx.account) === toRawAddress(wallet))
  const later = own.filter((tx) => tx !== root)
  const d = root.description ?? {}
  const storage = num(d.storage_ph?.storage_fees_collected)
  const gas = num(d.compute_ph?.gas_fees)
  const action = num(d.action?.total_action_fees)
  const walletImport = num(root.total_fees) - storage - gas - action
  const forward = sum(internal(root).map((m) => num(m.fwd_fee)))
  const fee = sum(own.map((tx) => num(tx.total_fees) + sum(internal(tx).map((m) => num(m.fwd_fee)))))
  const attached = sum(own.flatMap((tx) => internal(tx).map((m) => num(m.value))))
  const returned = sum(later.map((tx) => num(tx.in_msg?.value)))
  const chainFee = sum(all.map((tx) => num(tx.total_fees) + sum(internal(tx).map((m) => num(m.fwd_fee)))))
  return {
    walletFees: { import: walletImport > 0n ? walletImport : 0n, storage, gas, action, forward },
    fee,
    attached,
    returned,
    balanceChange: returned - attached - fee,
    chainFee,
  }
}

const tonOf = (v: bigint) => formatUnits(v, TON_DECIMALS)

function emptyEstimate(index: number, from: string, error: string): TonCostEstimate {
  return {
    index,
    from,
    error,
    simulated: false,
    incomplete: false,
    walletFees: null,
    fee: null,
    feeFormatted: null,
    attached: null,
    attachedFormatted: null,
    returned: null,
    returnedFormatted: null,
    balanceChange: null,
    balanceChangeFormatted: null,
    chainFee: null,
    chainFeeFormatted: null,
  }
}

/** 只读的钱包（只给了地址）：当作 TON Connect 钱包，版本按链上的钱包类型判断 */
function watchOnly(address: string): TonConnectLike {
  return {
    wallet: { account: { address }, device: { features: [{ name: 'SendTransaction', maxMessages: 255 }] } },
    sendTransaction: async () => {
      throw new Error('watch-only wallet')
    },
  }
}

async function estimateOne(client: TonClient, index: number, wallet: WalletContext, call: FeeCall, options: EstimateCostOptions): Promise<TonCostEstimate> {
  const fail = (error: string) => emptyEstimate(index, wallet.friendly, error)
  if (!call.messages.length) return fail('nothing to send')
  if (wallet.status === 'frozen') return fail('The wallet is frozen')
  if (!wallet.version) return fail('Cannot simulate: unknown wallet version (the wallet is not deployed, or not a v4r2 / v5r1 wallet)')
  if (call.messages.length > wallet.maxMessages) return fail(`Too many messages for one transaction: ${call.messages.length} > ${wallet.maxMessages}`)
  const messages = call.messages.map(toSendMessage)
  let ext
  try {
    ext = await buildExternal(wallet, { seqno: wallet.seqno, deployed: wallet.status === 'active' }, messages, Math.floor(Date.now() / 1000) + (options.validFor ?? 60), true)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
  const emulated = await emulate(client, ext, true, options.signal)
  if (emulated.rejected) return fail(`simulation failed: ${emulated.rejected}`)
  if (!emulated.trace) return fail(`simulation unavailable: ${emulated.unavailable}`)
  const verdict = evaluateTrace(emulated.trace, wallet.address, messages)
  const c = traceCosts(emulated.trace, wallet.address)
  return {
    index,
    from: wallet.friendly,
    error: verdict.error,
    simulated: true,
    incomplete: !!emulated.trace.is_incomplete,
    walletFees: {
      import: c.walletFees.import.toString(),
      storage: c.walletFees.storage.toString(),
      gas: c.walletFees.gas.toString(),
      action: c.walletFees.action.toString(),
      forward: c.walletFees.forward.toString(),
    },
    fee: c.fee.toString(),
    feeFormatted: tonOf(c.fee),
    attached: c.attached.toString(),
    attachedFormatted: tonOf(c.attached),
    returned: c.returned.toString(),
    returnedFormatted: tonOf(c.returned),
    balanceChange: c.balanceChange.toString(),
    balanceChangeFormatted: tonOf(c.balanceChange),
    chainFee: c.chainFee.toString(),
    chainFeeFormatted: tonOf(c.chainFee),
  }
}

/**
 * 估算多笔交易的手续费：每个调用是一个钱包的一笔交易（与 batchCall 相同），按钱包当前的链上状态模拟整条交易链。
 * 同一钱包的多笔各自按当前状态模拟（模拟不出前一笔执行后的状态）。钱包状态一次请求读出，之后每笔一次 emulateTrace
 *
 * ```ts
 * const [cost] = await estimateCosts(ton, [{ from: owner, messages: [{ to: jettonWallet, value: 50_000_000n, body }] }])
 * // { fee: '5473539', feeFormatted: '0.005473539', attached: '50001000', returned: '48536094', balanceChange: '-6938445', … }
 * ```
 */
export async function estimateCosts(client: TonClient, calls: readonly FeeCall[], options: EstimateCostOptions = {}): Promise<TonCostEstimate[]> {
  // 同一个地址用同一个只读钱包对象（resolveWallets 按输入去重）
  const watched = new Map<string, TonConnectLike>()
  const inputs = calls.map((c) => {
    if (typeof c.from !== 'string' || !isValidTonAddress(c.from.trim())) return c.from
    const raw = toRawAddress(c.from.trim())
    let w = watched.get(raw)
    if (!w) watched.set(raw, (w = watchOnly(raw)))
    return w
  })
  const wallets = await resolveWallets(client, inputs, options.signal)
  return Promise.all(calls.map((call, i) => estimateOne(client, i, wallets[i] as WalletContext, call, options)))
}

/** 估算一笔交易的手续费（见 estimateCosts） */
export async function estimateCost(client: TonClient, call: FeeCall, options: EstimateCostOptions = {}): Promise<TonCostEstimate> {
  const [result] = await estimateCosts(client, [call], options)
  return result as TonCostEstimate
}
