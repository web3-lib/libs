/**
 * 连主网 toncenter v3 的测试，默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/live.test.ts`
 * 没有 TONCENTER_API_KEY 时每秒 1 次请求，整套约 15 秒。地址是 2026-10 时的真实地址，余额之后可能变化
 */
import { describe, expect, it } from 'vitest'

import { NATIVE_TON, TonClient, toRawAddress } from '../src/index.js'

const live = process.env.LIVE ? describe : describe.skip
const ton = new TonClient(process.env.TONCENTER_URL, { apiKey: process.env.TONCENTER_API_KEY })
const WALLET = 'UQAj-peZGPH-cC25EAv4Q-h8cBXszTmkch6ba6wXC8BM40qt'
const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'

live('TON 主网', { timeout: 120_000 }, () => {
  it('全部余额：TON + Jetton，USDT 精度 6', async () => {
    const list = await ton.balances(WALLET, undefined, { symbol: true })
    expect(list[0]).toMatchObject({ token: NATIVE_TON, native: true, decimals: 9, success: true })
    const usdt = list.find((b) => b.token === USDT)
    expect(usdt).toMatchObject({ decimals: 6, symbol: 'USD₮', isScam: false })
    expect(usdt?.wallet).toMatch(/^EQ/)
  })

  it('指定代币、多个地址；结果与输入一一对应', async () => {
    const [a, b] = await ton.multiBalances([{ owner: WALLET, tokens: [USDT, NATIVE_TON] }, { owner: USDT, tokens: [NATIVE_TON] }])
    expect(a?.map((x) => x.token)).toEqual([USDT, NATIVE_TON])
    expect(BigInt(b?.[0]?.balance ?? '0')).toBeGreaterThan(0n)
  })

  it('Jetton 信息、钱包状态、NFT', async () => {
    const [usdt] = await ton.jettons([USDT])
    expect(usdt).toMatchObject({ name: 'Tether USD', decimals: 6, success: true })
    const [state] = await ton.walletStates([WALLET])
    expect(state).toMatchObject({ isWallet: true, status: 'active' })
    expect(state?.walletType).toMatch(/wallet v4/)
    const nfts = await ton.nfts(WALLET, { limit: 5 })
    expect(nfts.every((n) => n.address.length === 48)).toBe(true)
    expect(toRawAddress(state?.address as string)).toBe(toRawAddress(WALLET))
  })
})
