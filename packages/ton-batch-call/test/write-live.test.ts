/**
 * 写操作连主网模拟（toncenter 的 emulateTrace，不发送），默认跳过：
 * `LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/write-live.test.ts`（TONCENTER_API_KEY 可以带 API Key，快很多）
 *
 * 用真实钱包的地址模拟（TON Connect 形状的对象：模拟时不检查签名），钱包是 2026-10 时持有 USDT 和 TON 的地址
 */
import { describe, expect, it } from 'vitest'

import { NATIVE_TON, TonClient, toFriendlyAddress } from '../src/index.js'
import { bytesToHex, Cell } from '../src/write/cell.js'
import { batchCall, batchCollect, batchTransfer, commentCell, externalMessageCell, jettonTransferBody, normalizedMessageHash, resolveWallets, signedBody, type TonConnectLike } from '../src/subpaths/write.js'

const live = process.env.LIVE ? describe : describe.skip
const ton = new TonClient(undefined, process.env.TONCENTER_API_KEY ? { apiKey: process.env.TONCENTER_API_KEY } : {})
const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const V4 = 'UQAj-peZGPH-cC25EAv4Q-h8cBXszTmkch6ba6wXC8BM40qt'
const V5 = '0:F1BDB3304F76DA56E1242B295F2B8B5959071FD106F30C9F3041EEE44FEFF382'
/** 测试用的空钱包（没部署） */
const OTHER = toFriendlyAddress('0:6f7ca042ac14485464d036ad44aac5f751539784bc177322ea89e6eb113b2b35', { bounceable: false })

/** 只能模拟的 TON Connect 钱包 */
const watchOnly = (address: string, maxMessages = 255): TonConnectLike => ({
  wallet: { account: { address }, device: { features: [{ name: 'SendTransaction', maxMessages }] } },
  sendTransaction: async () => {
    throw new Error('watch-only')
  },
})

live('TON 主网写操作（模拟）', { timeout: 120_000 }, () => {
  it('v4r2：TON + USDT 混合一对多（带备注），同一笔交易', async () => {
    const results = await batchTransfer(
      ton,
      watchOnly(V4, 4),
      [
        { to: OTHER, formatted: '0.01', comment: 'hello' },
        { to: OTHER, token: USDT, formatted: '0.01', comment: 'order 42' },
        { to: V5, token: USDT, amount: 1n },
      ],
      { dryRun: true },
    )
    expect(results.map((r) => [r.status, r.error])).toEqual([
      ['simulated', null],
      ['simulated', null],
      ['simulated', null],
    ])
    expect(results[1]?.formatted).toBe('0.01')
    expect(BigInt(results[0]?.fee ?? '0')).toBeGreaterThan(0n)
  })

  it('v5r1：6 条消息放进一笔交易', async () => {
    const recipients = Array.from({ length: 6 }, (_, i) => (i % 2 ? { to: OTHER, token: USDT, amount: BigInt(i + 1) } : { to: OTHER, amount: BigInt(1000 + i) }))
    const results = await batchTransfer(ton, watchOnly(V5), recipients, { dryRun: true })
    expect(results.every((r) => r.status === 'simulated' && r.error === null)).toBe(true)
    const [w] = await resolveWallets(ton, [watchOnly(V5)])
    expect(w?.version).toBe('v5r1')
  })

  it('归集 USDT + TON（两个版本的钱包）', async () => {
    const results = await batchCollect(ton, [watchOnly(V4, 4), watchOnly(V5)], OTHER, { tokens: [USDT, NATIVE_TON], dryRun: true })
    // TON Connect 钱包不能用模式 128 转走全部余额
    expect(results.map((r) => r.status)).toEqual(['failed', 'failed'])
    expect(results[0]?.error).toMatch(/send mode/)
    const jettonsOnly = await batchCollect(ton, [watchOnly(V4, 4), watchOnly(V5)], OTHER, { tokens: [USDT], dryRun: true })
    expect(jettonsOnly.map((r) => [r.status, r.error, r.tokens])).toEqual([
      ['simulated', null, [USDT]],
      ['simulated', null, [USDT]],
    ])
  })

  it('失败的模拟：Jetton 余额不够（退回）、TON 不够（消息被跳过）', async () => {
    const [w] = await resolveWallets(ton, [watchOnly(V5)])
    const [held] = await ton.multiBalances([{ owner: V5, tokens: [USDT] }])
    const jettonWallet = held?.[0]?.wallet as string
    const tooMuch = jettonTransferBody({ amount: 10n ** 15n, destination: OTHER, responseDestination: V5, forwardTonAmount: 1n })
    const [bounced] = await batchCall(ton, [{ from: watchOnly(V5), messages: [{ to: jettonWallet, value: 50_000_000n, body: tooMuch }] }], { dryRun: true })
    expect(bounced?.status).toBe('failed')
    expect(bounced?.error).toMatch(/bounced/)
    const [poor] = await batchCall(ton, [{ from: watchOnly(V5), messages: [{ to: OTHER, value: (w?.balance ?? 0n) + 10n ** 9n, bounce: false }] }], { dryRun: true })
    expect(poor?.status).toBe('failed')
    expect(poor?.error).toMatch(/not sent|action/)
    await expect(batchTransfer(ton, watchOnly(V5), [{ to: OTHER, formatted: '1000000' }], { dryRun: true })).rejects.toThrow(/Insufficient balance/)
  })

  it('私钥钱包：没部署、没余额的新钱包模拟失败（不抛错）', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const [r] = await batchTransfer(ton, key, [{ to: OTHER, amount: 1000n }], { dryRun: true, checkBalance: false })
    expect(r?.status).toBe('failed')
    expect(r?.error).toMatch(/simulation/)
  })

  it('规范化哈希与 toncenter 计算的一致', async () => {
    const [w] = await resolveWallets(ton, [watchOnly(V4, 4)])
    const body = await signedBody('v4r2', { walletId: 698983191, seqno: w?.seqno ?? 0, validUntil: Math.floor(Date.now() / 1000) + 60, messages: [{ message: { to: OTHER, value: 1000n, bounce: false, body: commentCell('x') }, mode: 3 }] }, async () => new Uint8Array(64))
    const ext = externalMessageCell(V4, body)
    const res = await ton.transport.post<{ transactions: Record<string, { in_msg?: { hash_norm?: string; message_content?: { body?: string } } }> }>('../emulate/v1/emulateTrace', { boc: ext.toBase64(), ignore_chksig: true })
    const norms = Object.values(res.transactions).map((t) => t.in_msg?.hash_norm).filter(Boolean)
    const ours = Buffer.from(bytesToHex(normalizedMessageHash(ext)), 'hex').toString('base64')
    expect(norms).toContain(ours)
    expect(Cell.fromBase64(ext.toBase64()).equals(ext)).toBe(true)
  })
})
