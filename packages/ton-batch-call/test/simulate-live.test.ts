/**
 * 模拟连主网（emulateTrace，不发送、不检查签名），默认跳过：
 * `LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/simulate-live.test.ts`（TONCENTER_API_KEY 可选）
 * 用的是别人的钱包（只读地址），状态是 2026-10 时的：持有约 1700 USD₮、1.09 TON 的 v5r1 钱包
 */
import { describe, expect, it } from 'vitest'

import { NATIVE_TON, TonClient, sameTonAddress } from '../src/index.js'
import { resolveCallWallets } from '../src/fees.js'
import { jettonTransferBody } from '../src/write/message.js'
import { buildSwap } from '../src/swap.js'
import { buildExternal } from '../src/write/send.js'
import { toSendMessage } from '../src/write/batch.js'
import { simulateTransaction } from '../src/simulate.js'

const live = process.env.LIVE ? describe : describe.skip
const ton = new TonClient(undefined, process.env.TONCENTER_API_KEY ? { apiKey: process.env.TONCENTER_API_KEY } : { timeout: 30_000 })
const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const OWNER = 'UQCHY3ke1FpJ6rpDOqrxrIuooJ1pE5XFUz0P-rAXgmBqWBEW'
const OTHER = '0:5c4ae92412a0ae183c2b327476d94dc4104222592cf0a33b21392361e4a28aac'

live('模拟（主网）', { timeout: 600_000 }, () => {
  it('兑换：USD₮ → TON，余额变化、手续费、解码', async () => {
    const plan = await buildSwap(ton, OWNER, { tokenIn: USDT, tokenOut: NATIVE_TON, amountInFormatted: '1' })
    const sim = await simulateTransaction(ton, { from: OWNER, messages: plan.messages })
    console.log(JSON.stringify({ ...sim, messages: undefined }, null, 1))
    expect(sim).toMatchObject({ simulated: true, success: true, decoded: { type: 'swap' } })
    const usdt = sim.balanceChanges.find((c) => c.asset === USDT)
    expect(usdt).toMatchObject({ delta: '-1000000', symbol: 'USD₮' })
    expect(sim.balanceChanges.find((c) => c.asset === 'native')).toBeTruthy()
    // 路由器、池子的变化不列出
    expect(sim.balanceChanges.every((c) => c.address.startsWith('UQ'))).toBe(true)
    expect(sim.fees && BigInt(sim.fees.total)).toBeGreaterThan(BigInt(sim.fees?.wallet ?? 0))
    expect(BigInt(sim.fees?.total ?? 0)).toBe(BigInt(sim.fees?.gas ?? 0) + BigInt(sim.fees?.storage ?? 0) + BigInt(sim.fees?.forward ?? 0) + BigInt(sim.fees?.other ?? 0))
  })

  it('Jetton 转账 + TON 转账：解码、余额变化；转给 Jetton 主合约时警告', async () => {
    const [bal] = await ton.multiBalances([{ owner: OWNER, tokens: [USDT] }])
    const jw = bal?.[0]?.wallet as string
    const body = jettonTransferBody({ amount: 1_000_000n, destination: OTHER, responseDestination: OWNER, forwardTonAmount: 1n })
    const sim = await simulateTransaction(ton, {
      from: OWNER,
      messages: [
        { to: jw, value: 50_000_000n, body },
        { to: OTHER, value: 10_000_000n, bounce: false },
      ],
    })
    console.log(sim.decoded.summary, sim.balanceChanges.map((c) => `${c.address.slice(0, 6)} ${c.symbol} ${c.formatted}`))
    expect(sim.error).toBeUndefined()
    expect(sim.success).toBe(true)
    expect(sim.decoded.type).toBe('transfer')
    expect(sim.messages.map((m) => m.decoded.name)).toEqual(['jetton_transfer', 'empty'])
    expect(sim.balanceChanges.find((c) => sameTonAddress(c.address, OTHER) && c.asset === USDT)?.delta).toBe('1000000')
    const got = BigInt(sim.balanceChanges.find((c) => sameTonAddress(c.address, OTHER) && c.asset === 'native')?.delta ?? '0')
    expect(got).toBeGreaterThan(9_000_000n)
    expect(got).toBeLessThanOrEqual(10_000_000n)
    // 新部署的 Jetton 钱包不当作收款地址列出
    expect(sim.balanceChanges.filter((c) => c.asset === 'native')).toHaveLength(2)
    expect(sim.balanceChanges.find((c) => sameTonAddress(c.address, OWNER) && c.asset === USDT)?.delta).toBe('-1000000')

    const toMaster = await simulateTransaction(ton, { from: OWNER, messages: [{ to: jw, value: 50_000_000n, body: jettonTransferBody({ amount: 1_000_000n, destination: USDT, responseDestination: OWNER }) }] })
    console.log(toMaster.warnings, toMaster.error)
    expect(toMaster.warnings.map((w) => w.code)).toContain('jetton-to-contract')
  })

  it('失败：TON 不够付兑换的附带 TON；seqno 不对的外部消息；Jetton 不够', async () => {
    const plan = await buildSwap(ton, OWNER, { tokenIn: NATIVE_TON, tokenOut: USDT, amountInFormatted: '1' })
    const short = await simulateTransaction(ton, { from: OWNER, messages: plan.messages })
    console.log(short.error, short.failures)
    expect(short.success).toBe(false)
    expect(short.error).toMatch(/not (sent|enough)|skipped/i)

    const [w] = await resolveCallWallets(ton, [OWNER])
    const wallet = w as NonNullable<typeof w>
    const msgs = [{ to: OTHER, value: 1_000_000n, bounce: false }].map(toSendMessage)
    const stale = await buildExternal(wallet, { seqno: wallet.seqno + 5, deployed: true }, msgs, Math.floor(Date.now() / 1000) + 60, true)
    const bad = await simulateTransaction(ton, { boc: stale.toBase64() })
    console.log(bad.error, bad.external?.seqno)
    expect(bad.success).toBe(false)
    expect(bad.error).toMatch(/133.*wrong seqno/)
    expect(bad.external).toMatchObject({ version: 'v5r1', seqno: wallet.seqno + 5 })
    expect(bad.external?.messages[0]?.decoded.name).toBe('empty')

    const [bal] = await ton.multiBalances([{ owner: OWNER, tokens: [USDT] }])
    const huge = await simulateTransaction(ton, { from: OWNER, messages: [{ to: bal?.[0]?.wallet as string, value: 50_000_000n, body: jettonTransferBody({ amount: 10n ** 15n, destination: OTHER, responseDestination: OWNER }) }] })
    console.log(huge.error)
    expect(huge.success).toBe(false)
    expect(huge.error).toMatch(/exit code 47.*not enough jettons/)
  })
})
