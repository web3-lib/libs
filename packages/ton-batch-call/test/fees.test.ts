/** 手续费估算：假的 walletStates 和 emulateTrace（不连网络），按模拟出的交易链算费用 */
import { describe, expect, it } from 'vitest'

import { ApiError, TonClient, toFriendlyAddress, toRawAddress, type TonTransport } from '../src/index.js'
import { estimateCost, estimateCosts } from '../src/subpaths/fees.js'
import { Cell, bytesToBase64 } from '../src/write/cell.js'
import { commentCell, jettonTransferBody } from '../src/write/message.js'

const WALLET = `0:${'f1'.repeat(32)}`
const JETTON_WALLET = `0:${'0a'.repeat(32)}`
const RECIPIENT_JW = `0:${'0b'.repeat(32)}`
const OTHER = `0:${'0e'.repeat(32)}`

const transfer = jettonTransferBody({ amount: 1n, destination: OTHER, responseDestination: WALLET, forwardTonAmount: 1n })
const comment = commentCell('hi')
const hashOf = (c: Cell) => bytesToBase64(c.hash())

const msg = (hash: string, destination: string, value: string, fwd: string, body?: Cell) => ({ hash, destination, value, fwd_fee: fwd, bounce: true, bounced: false, message_content: { hash: hashOf(body ?? Cell.EMPTY) } })
const tx = (hash: string, account: string, lt: string, fees: string, inMsg: unknown, outs: unknown[], extra: Record<string, unknown> = {}) => ({
  hash,
  account,
  lt,
  total_fees: fees,
  description: { aborted: false, compute_ph: { success: true, exit_code: 0, gas_fees: '0' }, action: { success: true, result_code: 0, skipped_actions: 0 }, ...extra },
  in_msg: inMsg,
  out_msgs: outs,
})

/**
 * 与主网上模拟的一笔 USDT 转账 + 备注转账的数值相同：钱包交易（导入 213334、存储 4647534、计算 377068、动作 61243）发出两条消息，
 * Jetton 钱包 → 收款人的 Jetton 钱包 → 通知 + 多余的 TON 退回钱包
 */
function trace() {
  const root = tx('root', WALLET, '10', '5299179', { hash: 'ext', destination: WALLET, value: null }, [msg('m1', JETTON_WALLET, '50000000', '78046', transfer), msg('m2', OTHER, '1000', '44446', comment)], {
    storage_ph: { storage_fees_collected: '4647534' },
    compute_ph: { success: true, exit_code: 0, gas_fees: '377068' },
    action: { success: true, result_code: 0, skipped_actions: 0, total_fwd_fees: '183735', total_action_fees: '61243' },
  })
  const jw = tx('jw', JETTON_WALLET, '11', '2119675', msg('m1', JETTON_WALLET, '50000000', '78046', transfer), [msg('m3', RECIPIENT_JW, '49742264', '127380')])
  const rjw = tx('rjw', RECIPIENT_JW, '12', '121688', msg('m3', RECIPIENT_JW, '49742264', '127380'), [msg('m4', OTHER, '1', '65602'), msg('m5', WALLET, '48536094', '44446')])
  const excess = tx('excess', WALLET, '13', '51868', msg('m5', WALLET, '48536094', '44446'), [])
  const note = tx('note', OTHER, '13', '0', msg('m4', OTHER, '1', '65602'), [])
  const comm = tx('comm', OTHER, '11', '0', msg('m2', OTHER, '1000', '44446', comment), [])
  return {
    trace: { tx_hash: 'root', in_msg_hash: 'ext', children: [{ tx_hash: 'jw', in_msg_hash: 'm1', children: [{ tx_hash: 'rjw', in_msg_hash: 'm3', children: [{ tx_hash: 'note', in_msg_hash: 'm4' }, { tx_hash: 'excess', in_msg_hash: 'm5' }] }] }, { tx_hash: 'comm', in_msg_hash: 'm2' }] },
    transactions: Object.fromEntries([root, jw, rjw, excess, note, comm].map((t) => [t.hash, t])),
    is_incomplete: false,
  }
}

function fakeNode(emulation: () => unknown) {
  const posted: Array<{ boc: string; ignore_chksig: boolean }> = []
  const transport: TonTransport = {
    async get<T>(path: string, query: Record<string, unknown>) {
      expect(path).toBe('walletStates')
      const list = (query.address as string[]).map((a) => toRawAddress(a))
      return {
        wallets: list.flatMap((a) => (a === WALLET ? [{ address: a.toUpperCase().replace('0X', '0x'), is_wallet: true, wallet_type: 'wallet v5 r1', seqno: 7, wallet_id: 2147483409, balance: '4640687449', status: 'active' }] : [])),
      } as T
    },
    async post<T>(path: string, body: unknown) {
      expect(path).toBe('../emulate/v1/emulateTrace')
      posted.push(body as { boc: string; ignore_chksig: boolean })
      return emulation() as T
    },
  }
  return { ton: new TonClient(transport), posted }
}

const messages = [
  { to: JETTON_WALLET, value: 50_000_000n, body: transfer },
  { to: OTHER, value: 1000n, bounce: false, body: comment },
]

describe('estimateCosts', () => {
  it('只给地址（只读钱包）：空签名模拟，钱包的手续费明细、附带 / 退回的 TON、余额变化、整条链的手续费', async () => {
    const { ton, posted } = fakeNode(trace)
    const cost = await estimateCost(ton, { from: toFriendlyAddress(WALLET, { bounceable: false }), messages })
    expect(cost).toEqual({
      index: 0,
      from: toFriendlyAddress(WALLET, { bounceable: false }),
      error: null,
      simulated: true,
      incomplete: false,
      walletFees: { import: '213334', storage: '4647534', gas: '377068', action: '61243', forward: '122492' },
      // 钱包交易 5299179 + 转发 122492 + 收退款的交易 51868
      fee: '5473539',
      feeFormatted: '0.005473539',
      attached: '50001000',
      attachedFormatted: '0.050001',
      returned: '48536094',
      returnedFormatted: '0.048536094',
      balanceChange: '-6938445',
      balanceChangeFormatted: '-0.006938445',
      // 所有交易 7592410 + 所有消息的转发费 359920
      chainFee: '7952330',
      chainFeeFormatted: '0.00795233',
    })
    // 不签名：模拟时不检查签名；外部消息发给钱包，没有 StateInit（已部署）
    expect(posted[0]?.ignore_chksig).toBe(true)
    const ext = Cell.fromBase64(posted[0]?.boc as string).beginParse()
    expect(ext.loadUintNumber(2)).toBe(2)
    ext.loadAddress()
    expect(toRawAddress(ext.loadAddress() as never)).toBe(WALLET)
    ext.loadCoins()
    expect(ext.loadBit()).toBe(false)
  })

  it('后面的合约失败：error 是原因，费用照算；钱包拒绝外部消息、不是钱包的地址：没有数值', async () => {
    const bounced = trace()
    // Jetton 钱包执行失败（余额不够），收到的是可回弹的消息：退回
    const jw = bounced.transactions.jw as { description: Record<string, unknown>; in_msg: { bounce: boolean } }
    jw.description = { aborted: true, compute_ph: { success: false, exit_code: 47 } }
    expect(jw.in_msg.bounce).toBe(true)
    const { ton } = fakeNode(() => bounced)
    const [failed, notWallet] = await estimateCosts(ton, [
      { from: WALLET, messages },
      { from: OTHER, messages },
    ])
    expect(failed).toMatchObject({ simulated: true, fee: '5473539' })
    expect(failed?.error).toMatch(/exit code 47; it was bounced/)
    expect(notWallet).toMatchObject({ simulated: false, fee: null, walletFees: null })
    expect(notWallet?.error).toMatch(/unknown wallet version/)

    const rejecting = fakeNode(() => {
      throw new ApiError('toncenter: HTTP 500 cannot apply external message to current state', 500)
    })
    const rejected = await estimateCost(rejecting.ton, { from: WALLET, messages })
    expect(rejected).toMatchObject({ simulated: false, fee: null })
    expect(rejected.error).toMatch(/simulation failed/)
    const none = await estimateCost(rejecting.ton, { from: WALLET, messages: [] })
    expect(none.error).toBe('nothing to send')
  })
})
