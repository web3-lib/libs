/**
 * 兑换连主网（报价 + emulateTrace 模拟，不发送），默认跳过：
 * `LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/swap-live.test.ts`（TONCENTER_API_KEY 可选，快很多；没有 Key 时约 5 分钟）
 * 钱包是 2026-10 时持有 TON、USD₮、NOT 的真实 v4r2 钱包（只读，不签名）
 */
import { describe, expect, it } from 'vitest'

import { NATIVE_TON, TonClient, isNodeFault } from '../src/index.js'
import { getSwapQuote, swap, type SwapResult } from '../src/subpaths/swap.js'
import type { TonConnectLike } from '../src/subpaths/write.js'
import type { TonLpProtocol } from '../src/lp.js'

const live = process.env.LIVE ? describe : describe.skip
const apiKey = process.env.TONCENTER_API_KEY
const ton = new TonClient(undefined, apiKey ? { apiKey } : {})
/** v4r2：约 27 TON、198 USD₮、11365 NOT */
const HOLDER = '0:C3AC62A4A83FCB5C4ED3F8FB6C70C260708F9C3D0883D11F080850E71197D480'
const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const NOT = 'EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT'

const watchOnly = (address: string): TonConnectLike => ({
  wallet: { account: { address }, device: { features: [{ name: 'SendTransaction', maxMessages: 4 }] } },
  sendTransaction: async () => Promise.reject(new Error('watch-only')),
})

/** 代理 / toncenter 偶尔断开：节点问题重试两次 */
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i >= 2 || !(isNodeFault(err) || /fetch failed|timed out/i.test(String(err)))) throw err
    }
  }
}

const label = (t: string) => (t === NATIVE_TON ? 'TON' : t === USDT ? 'USD₮' : 'NOT')

/** 每个协议三个方向：TON → Jetton、Jetton → TON、Jetton → Jetton（STON.fi v2 / DeDust 可能走 TON 两跳） */
const CASES: Array<[TonLpProtocol, string, string, string]> = [
  ['stonfi-v2', NATIVE_TON, USDT, '1'],
  ['stonfi-v2', USDT, NATIVE_TON, '2'],
  ['stonfi-v2', USDT, NOT, '2'],
  ['dedust', NATIVE_TON, USDT, '1'],
  ['dedust', USDT, NATIVE_TON, '2'],
  ['dedust', NOT, USDT, '1000'],
  ['stonfi-v1', NATIVE_TON, NOT, '1'],
  ['stonfi-v1', NOT, NATIVE_TON, '1000'],
  ['stonfi-v1', NOT, USDT, '1000'],
]

live('TON 兑换（主网模拟）', { timeout: 900_000 }, () => {
  it('每个协议三个方向：模拟成功，收到的数量 ≥ amountOutMin 且与报价相差不到 0.5%', async () => {
    for (const [protocol, tokenIn, tokenOut, amount] of CASES) {
      console.log(`${protocol} ${amount} ${label(tokenIn)} → ${label(tokenOut)} …`)
      // 状态（error、模拟结果）不是节点问题时 swap 不抛出：结果里 failed 且是 simulation unavailable 时也重试
      const r: SwapResult = await retry(async () => {
        const x = await swap(ton, watchOnly(HOLDER), { tokenIn, tokenOut, amountInFormatted: amount }, { protocols: [protocol], dryRun: true })
        if (x.error && /unavailable|fetch failed|timed out/.test(x.error)) throw new Error(`fetch failed: ${x.error}`)
        return x
      })
      const out = BigInt(r.plan.amountOut)
      const received = BigInt(r.amountReceived ?? '0')
      const diff = Number(received - out) / Number(out)
      console.log(
        `  ${protocol} ${amount} ${label(tokenIn)} → ${label(tokenOut)} via ${r.plan.route.path.map(label).join('/')}: quote ${r.plan.amountOut}, min ${r.plan.amountOutMin}, received ${r.amountReceived} (${(diff * 100).toFixed(4)}%), impact ${r.plan.priceImpact?.toFixed(5)}, attached ${r.plan.tonAttached}, fee ${r.fee}`,
      )
      expect([protocol, r.status, r.error]).toEqual([protocol, 'simulated', null])
      expect(r.plan.route.protocol).toBe(protocol)
      expect(received).toBeGreaterThanOrEqual(BigInt(r.plan.amountOutMin))
      expect(Math.abs(diff)).toBeLessThan(0.005)
    }
  })

  it('不限协议：所有路线报价，选输出最多的；余额不够时发送前报错', async () => {
    const plan = await retry(() => getSwapQuote(HOLDER, { tokenIn: NATIVE_TON, tokenOut: USDT, amountInFormatted: '1' }, { provider: ton.transport }))
    console.log(plan.routes.map((r) => `${r.protocol} ${r.path.map(label).join('/')} ${r.amountOut}`).join('\n'))
    expect(new Set(plan.routes.map((r) => r.protocol)).size).toBeGreaterThanOrEqual(2)
    expect(plan.route.amountOut).toBe(plan.routes[0]?.amountOut)
    expect(plan.routes.every((r, i, all) => i === 0 || BigInt(r.amountOut) <= BigInt(all[i - 1]?.amountOut ?? '0'))).toBe(true)
    // USD₮ 不够：发送前的余额检查报错
    await expect(retry(() => swap(ton, watchOnly(HOLDER), { tokenIn: USDT, tokenOut: NATIVE_TON, amountInFormatted: '1000000' }, { dryRun: true, protocols: ['stonfi-v2'] }))).rejects.toThrow(/Insufficient balance/)
  })
})
