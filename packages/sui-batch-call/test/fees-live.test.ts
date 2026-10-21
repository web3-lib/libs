/**
 * 手续费估算连主网（只模拟，不发送），默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/fees-live.test.ts`
 * 地址是 2026-10 时持有 SUI / USDC 的地址
 */
import { describe, expect, it } from 'vitest'

import { SuiClient } from '../src/index.js'
import { estimateCost, estimateFees } from '../src/subpaths/fees.js'
import { PtbBuilder, pure } from '../src/subpaths/write.js'

const live = process.env.LIVE ? describe : describe.skip
const sui = new SuiClient(process.env.SUI_GRPC)
const OWNER = '0xffd4f043057226453aeba59732d41c6093516f54823ebc3a16d17f8a77d2f0ad'
const TO = '0xc5fcbe33baba979d09123a2b81dc2ad78fd1b3c28e26c5acf9ccbf095e2fb4a3'
const USDC_HOLDER = '0x9f63425709069336fec108bd4ba69a8f3d23e8ab237311f3ce58ae2bb0ed4d7f'
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'

const check = (c: Awaited<ReturnType<typeof estimateCost>>, gasPrice: string) => {
  expect(c.gasPrice).toBe(gasPrice)
  expect(BigInt(c.total)).toBe(BigInt(c.computationCost) + BigInt(c.storageCost) - BigInt(c.storageRebate))
  const used = BigInt(c.computationCost) + BigInt(c.storageCost)
  expect(BigInt(c.gasBudget)).toBe((used * 1200n + 999n) / 1000n > 2_000_000n ? (used * 1200n + 999n) / 1000n : 2_000_000n)
}

live('手续费估算（主网）', { timeout: 60_000 }, () => {
  it('参考 gas 价格；SUI 转账（从 gas 币拆）的 gas 明细和 gas 上限', async () => {
    const fees = await estimateFees(sui)
    expect(BigInt(fees.referenceGasPrice)).toBeGreaterThan(0n)
    const ptb = new PtbBuilder()
    const split = ptb.command({ kind: 'splitCoins', coin: ptb.gas, amounts: [ptb.pure(pure.u64(1_000_000n))] })
    ptb.command({ kind: 'transferObjects', objects: [ptb.nested(split, 0)], address: ptb.pure(pure.address(TO)) })
    const cost = await estimateCost(sui, { from: OWNER, kind: ptb.build() })
    check(cost, fees.referenceGasPrice)
    // 新建一个 Coin：要付存储费，gas 币改写有返还
    expect(BigInt(cost.storageCost)).toBeGreaterThan(0n)
    expect(BigInt(cost.storageRebate)).toBeGreaterThan(0n)
    expect(BigInt(cost.total)).toBeGreaterThan(0n)
    // 出价翻倍：计算费跟着翻倍
    const double = await estimateCost(sui, { from: OWNER, kind: ptb.build() }, { gasPrice: BigInt(fees.referenceGasPrice) * 2n })
    expect(BigInt(double.computationCost)).toBe(BigInt(cost.computationCost) * 2n)
  })

  it('赞助交易：整个 USDC Coin 转走，gas 由另一个地址付；存储返还几乎抵掉存储费', async () => {
    const [coin] = await sui.ownedObjects(USDC_HOLDER, { type: `0x2::coin::Coin<${USDC}>`, limit: 1 })
    if (!coin?.version || !coin.digest) throw new Error('no USDC coin')
    const ptb = new PtbBuilder()
    ptb.command({ kind: 'transferObjects', objects: [ptb.owned({ objectId: coin.objectId, version: coin.version, digest: coin.digest })], address: ptb.pure(pure.address(TO)) })
    const cost = await estimateCost(sui, { from: USDC_HOLDER, sponsor: OWNER, kind: ptb.build() })
    check(cost, (await estimateFees(sui)).referenceGasPrice)
    expect(BigInt(cost.total)).toBeLessThan(BigInt(cost.computationCost) + BigInt(cost.storageCost) / 10n)
  })

  it('付款地址没有 SUI 时抛出', async () => {
    const empty = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`
    await expect(estimateCost(sui, { from: empty, kind: { inputs: [], commands: [] } })).rejects.toThrow(/does not have enough SUI/)
  })
})
