/**
 * Jetton 风险检查连主网（链上 get_jetton_data + emulateTrace 模拟买卖，不发送），默认跳过：
 * `LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/risk-live.test.ts`（TONCENTER_API_KEY 可选）
 * 代币是 2026-10 时的状态
 */
import { describe, expect, it } from 'vitest'

import { TonClient } from '../src/index.js'
import { tokenRisks } from '../src/subpaths/risk.js'

const live = process.env.LIVE ? describe : describe.skip
const ton = new TonClient(undefined, process.env.TONCENTER_API_KEY ? { apiKey: process.env.TONCENTER_API_KEY } : { timeout: 30_000 })
const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const NOT = 'EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT'
/** admin 改成了零地址 */
const CATI = 'EQD-cvR0Nz6XAyRBvbhz-abTrRC6sI5tvHvvpeQraV9UAAD7'
/** 仿冒 USD₮ 的空投代币（名字 “Tether USD”，symbol “USD”）：有 admin，钱包代码不是常见的（索引器没有标记为诈骗） */
const FAKE_USDT = 'EQAACuEKC39UFxkfLhsrpYN8pxxLmRGfxZo-sENciH5Yf8V-'

live('Jetton 风险检查（主网）', { timeout: 600_000 }, () => {
  it('admin、mintable、钱包代码：USD₮ 带治理、NOT 和 CATI 已放弃 admin、仿冒的 USD₮ 钱包代码不认识', async () => {
    const [usdt, not, cati, fake] = await tokenRisks(ton, [USDT, NOT, CATI, FAKE_USDT])
    console.log(JSON.stringify([usdt, not, cati, fake], null, 1))
    expect(usdt).toMatchObject({ symbol: 'USD₮', mintable: true, isScam: false, walletCode: 'stablecoin', flags: ['mintable', 'admin', 'governed'] })
    expect(usdt?.admin).not.toBeNull()
    expect(not).toMatchObject({ symbol: 'NOT', admin: null, walletCode: 'notcoin', flags: [] })
    expect(cati).toMatchObject({ admin: null, walletCode: 'standard', flags: [] })
    expect(fake).toMatchObject({ symbol: 'USD', walletCode: null })
    expect(fake?.flags).toContain('unknown-wallet-code')
    expect(fake?.flags).toContain('admin')
  })

  it('模拟买入、卖出：NOT 买得到也卖得出，没有税；仿冒的 USD₮ 没有池子', async () => {
    const [not, fake] = await tokenRisks(ton, [NOT, FAKE_USDT], { simulate: true })
    console.log(JSON.stringify(not?.trade), JSON.stringify(fake?.trade), fake?.flags)
    expect(['no-pool', 'no-holder']).toContain(fake?.trade?.stage)
    expect(not?.trade).toMatchObject({ stage: 'ok', error: null })
    expect(not?.trade?.buyTax).toBeLessThan(0.005)
    expect(not?.trade?.sellTax).toBeLessThan(0.005)
    expect(BigInt(not?.trade?.bought ?? '0')).toBeGreaterThan(0n)
    expect(BigInt(not?.trade?.sold ?? '0')).toBeGreaterThan(0n)
    expect(not?.flags).toEqual([])
  })
})
