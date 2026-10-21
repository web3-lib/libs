/**
 * 手续费估算连主网（emulateTrace 模拟，不发送），默认跳过：
 * `LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/fees-live.test.ts`（TONCENTER_API_KEY 可选）
 *
 * 钱包是 2026-10 时持有 USDT 和 TON 的真实地址（只读，不签名）
 */
import { describe, expect, it } from 'vitest'

import { TonClient, toFriendlyAddress } from '../src/index.js'
import { traceCosts } from '../src/fees.js'
import { estimateCosts } from '../src/subpaths/fees.js'
import { commentCell, jettonTransferBody, resolveWallets, signedBody } from '../src/subpaths/write.js'
import { buildExternal, emulate } from '../src/write/send.js'
import { toSendMessage } from '../src/write/batch.js'

const live = process.env.LIVE ? describe : describe.skip
const ton = new TonClient(process.env.TONCENTER_URL, process.env.TONCENTER_API_KEY ? { apiKey: process.env.TONCENTER_API_KEY } : {})
const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const V4 = 'UQAj-peZGPH-cC25EAv4Q-h8cBXszTmkch6ba6wXC8BM40qt'
const V5 = '0:F1BDB3304F76DA56E1242B295F2B8B5959071FD106F30C9F3041EEE44FEFF382'
/** 没部署的空钱包 */
const OTHER = toFriendlyAddress('0:6f7ca042ac14485464d036ad44aac5f751539784bc177322ea89e6eb113b2b35', { bounceable: false })

live('TON 主网手续费估算（模拟）', { timeout: 180_000 }, () => {
  it('USDT 转账 + 备注转账（v5r1）、TON 转账和转走全部余额（v4r2）、Jetton 不够被退回、空钱包和私钥', async () => {
    const [held] = await ton.multiBalances([{ owner: V5, tokens: [USDT] }])
    const jettonWallet = held?.[0]?.wallet as string
    const usdt = { to: jettonWallet, value: 50_000_000n, body: jettonTransferBody({ amount: 1n, destination: OTHER, responseDestination: V5, forwardTonAmount: 1n }) }
    const [jetton, tonTransfer, all, bounced, empty, key] = await estimateCosts(ton, [
      { from: V5, messages: [usdt, { to: OTHER, value: 1000n, bounce: false, body: commentCell('hi') }] },
      { from: V4, messages: [{ to: OTHER, value: 10_000_000n, bounce: false }] },
      { from: V4, messages: [{ to: OTHER, value: 0n, bounce: false, mode: 128 }] },
      { from: V5, messages: [{ ...usdt, body: jettonTransferBody({ amount: 10n ** 15n, destination: OTHER, responseDestination: V5, forwardTonAmount: 1n }) }] },
      { from: OTHER, messages: [{ to: V5, value: 1n }] },
      // 随机私钥：v5r1 地址没部署、没有余额，带 StateInit 也付不起手续费
      { from: crypto.getRandomValues(new Uint8Array(32)), messages: [{ to: V5, value: 1n }] },
    ])
    // Jetton 转账：多余的 gas 退回钱包，钱包实际花的远少于附带的 0.05 TON
    expect(jetton).toMatchObject({ error: null, simulated: true, incomplete: false, attached: '50001000' })
    expect(BigInt(jetton?.returned as string)).toBeGreaterThan(40_000_000n)
    expect(BigInt(jetton?.balanceChange as string)).toBe(BigInt(jetton?.returned as string) - 50_001_000n - BigInt(jetton?.fee as string))
    expect(BigInt(jetton?.chainFee as string)).toBeGreaterThan(BigInt(jetton?.fee as string))
    expect(BigInt(jetton?.fee as string)).toBeLessThan(20_000_000n)
    // TON 转账：没有后续的交易，整条链的手续费就是钱包付的
    expect(tonTransfer).toMatchObject({ error: null, attached: '10000000', returned: '0' })
    expect(tonTransfer?.chainFee).toBe(tonTransfer?.fee)
    // 模式 128：余额全部转走
    const [v4] = await resolveWallets(ton, [{ wallet: { account: { address: V4 } }, sendTransaction: async () => ({ boc: '' }) }])
    expect(all?.balanceChange).toBe((-(v4?.balance ?? 0n)).toString())
    expect(bounced?.error).toMatch(/bounced/)
    expect(BigInt(bounced?.returned as string)).toBeGreaterThan(45_000_000n)
    expect(empty).toMatchObject({ simulated: false, fee: null })
    expect(key).toMatchObject({ simulated: false, fee: null })
    expect(key?.error).toMatch(/simulation failed/)
  })

  it('与 toncenter 的 estimateFee（只算钱包交易）一致；余额变化与模拟结果里账户的前后余额一致', async () => {
    const [wallet] = await resolveWallets(ton, [{ wallet: { account: { address: V5 } }, sendTransaction: async () => ({ boc: '' }) }])
    if (!wallet) throw new Error('no wallet')
    const [held] = await ton.multiBalances([{ owner: V5, tokens: [USDT] }])
    // USDT 转账：钱包有两笔交易（发出、收到多余的 TON）
    const messages = [
      toSendMessage({ to: held?.[0]?.wallet as string, value: 50_000_000n, body: jettonTransferBody({ amount: 1n, destination: OTHER, responseDestination: V5, forwardTonAmount: 1n }) }),
      toSendMessage({ to: OTHER, value: 1000n, bounce: false, body: commentCell('fee check') }),
    ]
    const validUntil = Math.floor(Date.now() / 1000) + 60
    const body = await signedBody('v5r1', { walletId: wallet.walletId, seqno: wallet.seqno, validUntil, messages: messages.map((m) => ({ message: m.message, mode: 3 })) }, async () => new Uint8Array(64))
    const est = await ton.transport.post<{ source_fees: { in_fwd_fee: number; storage_fee: number; gas_fee: number; fwd_fee: number } }>('estimateFee', { address: wallet.address, body: body.toBase64(), ignore_chksig: true })
    const ext = await buildExternal(wallet, { seqno: wallet.seqno, deployed: true }, messages, validUntil, true)
    const { trace } = await emulate(ton, ext, true)
    if (!trace) throw new Error('no trace')
    const c = traceCosts(trace, wallet.address)
    expect(c.walletFees.import).toBe(BigInt(est.source_fees.in_fwd_fee))
    expect(c.walletFees.gas).toBe(BigInt(est.source_fees.gas_fee))
    expect(c.walletFees.action + c.walletFees.forward).toBe(BigInt(est.source_fees.fwd_fee))
    // 存储费按时间算，两次请求之间差几秒
    expect(Number(c.walletFees.storage - BigInt(est.source_fees.storage_fee))).toBeLessThan(1000)
    const own = Object.values(trace.transactions)
      .filter((t) => t.account.toLowerCase() === wallet.address)
      .sort((a, b) => (BigInt(a.lt ?? 0) < BigInt(b.lt ?? 0) ? -1 : 1))
    expect(own).toHaveLength(2)
    const before = BigInt(own[0]?.account_state_before?.balance as string)
    const after = BigInt(own.at(-1)?.account_state_after?.balance as string)
    expect(c.balanceChange).toBe(after - before)
  })
})
