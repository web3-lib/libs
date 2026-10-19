/**
 * 写操作在 devnet 上真实执行，默认跳过：
 * `SUI_DEVNET_KEY=suiprivkey1… NODE_USE_ENV_PROXY=1 npx vitest run test/write-live.test.ts`
 * （SUI_DEVNET_KEY 要有几个 devnet SUI，faucet：POST https://faucet.devnet.sui.io/v2/gas）
 */
import { describe, expect, it } from 'vitest'

import { SUI_COIN_TYPE, SuiClient } from '../src/index.js'
import { PtbBuilder, batchCall, batchCollect, batchTransfer, pure, resolveSigner, type SuiWalletLike } from '../src/subpaths/write.js'

const KEY = process.env.SUI_DEVNET_KEY
const live = KEY ? describe : describe.skip
const sui = new SuiClient(undefined, { network: 'devnet' })
const MIST = 1_000_000_000n

const newKey = () => crypto.getRandomValues(new Uint8Array(32))
/** 读到 checkpoint 之后的余额（刚执行的交易已经生效） */
let seen = 0
const track = <T extends { checkpoint: number | null }>(results: T[]) => {
  for (const r of results) if (r.checkpoint !== null) seen = Math.max(seen, r.checkpoint)
  return results
}
const balanceOf = async (address: string) => {
  const [b] = await sui.balances(address, [SUI_COIN_TYPE], { minCheckpoint: seen })
  return BigInt(b?.balance ?? '0')
}

live('Sui devnet 写操作', { timeout: 180_000 }, () => {
  it('一对多转账（同一笔交易、同一收款人两笔）→ 赞助归集回来（子钱包清空）', async () => {
    const main = await resolveSigner(KEY as string)
    const [b, c] = [newKey(), newKey()]
    const [sb, sc] = await Promise.all([resolveSigner(b), resolveSigner(c)])
    const results = track(await batchTransfer(sui, KEY as string, [
      { to: sb.address, formatted: '0.05' },
      { to: sc.address, formatted: '0.03' },
      { to: sb.address, amount: 20_000_000n },
    ]))
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
    expect(new Set(results.map((r) => r.digest)).size).toBe(1)
    expect(await balanceOf(sb.address)).toBe(70_000_000n)
    expect(await balanceOf(sc.address)).toBe(30_000_000n)

    // 赞助交易归集：子钱包不付 gas，SUI 全部转走
    const collected = track(await batchCollect(sui, [b, c], main.address, { sponsor: KEY as string }))
    expect(collected.map((r) => [r.status, r.tokens])).toEqual([
      ['confirmed', [SUI_COIN_TYPE]],
      ['confirmed', [SUI_COIN_TYPE]],
    ])
    expect(await balanceOf(sb.address)).toBe(0n)
    expect(await balanceOf(sc.address)).toBe(0n)
  })

  it('地址余额：send_funds 存进去 → 用地址余额付 gas 转账 → 归集时取出', async () => {
    const main = await resolveSigner(KEY as string)
    const d = newKey()
    const sd = await resolveSigner(d)
    // main 用 coin::send_funds 把 0.1 SUI 存进 d 的地址余额（不是 Coin 对象）
    const ptb = new PtbBuilder()
    const split = ptb.command({ kind: 'splitCoins', coin: ptb.gas, amounts: [ptb.pure(pure.u64(100_000_000n))] })
    ptb.moveCall('0x2::coin::send_funds', [SUI_COIN_TYPE], [ptb.nested(split, 0), ptb.pure(pure.address(sd.address))])
    const [sent] = track(await batchCall(sui, [{ from: KEY as string, kind: ptb.build() }]))
        expect(sent?.status).toBe('confirmed')
    const [details] = await sui.balances(sd.address, [SUI_COIN_TYPE], { minCheckpoint: seen })
    expect(details?.balance).toBe('100000000')
    expect((await sui.ownedObjects(sd.address, { minCheckpoint: seen })).length).toBe(0) // 没有 Coin 对象

    // d 没有 Coin：gas 从地址余额付（payment 为空 + ValidDuring），转出的 SUI 也从地址余额取
    const [out] = track(await batchTransfer(sui, d, [{ to: main.address, amount: 10_000_000n }]))
        expect(out?.status).toBe('confirmed')
    const left = await balanceOf(sd.address)
    expect(left > 0n && left < 90_000_000n).toBe(true)

    // 赞助归集：地址余额里的 SUI 用 redeem_funds 取出转走
    const [collected] = track(await batchCollect(sui, [d], main.address, { sponsor: KEY as string }))
    expect(collected?.status).toBe('confirmed')
    expect(await balanceOf(sd.address)).toBe(0n)
  })

  it('几乎转出全部 SUI（gas 币只剩一点给 gas）', async () => {
    const main = await resolveSigner(KEY as string)
    const e = newKey()
    const se = await resolveSigner(e)
    track(await batchTransfer(sui, KEY as string, [{ to: se.address, formatted: '0.1' }]))
    const [out] = track(await batchTransfer(sui, e, [{ to: main.address, formatted: '0.097' }]))
    expect([out?.status, out?.error]).toEqual(['confirmed', null])
    expect(await balanceOf(se.address)).toBeLessThan(3_000_000n)
  })

  it('Wallet Standard 钱包签名；dryRun 只模拟', async () => {
    const local = await resolveSigner(KEY as string)
    let prompts = 0
    const wallet: SuiWalletLike = {
      accounts: [{ address: local.address, chains: ['sui:devnet'] }],
      features: {
        'sui:signTransaction': {
          signTransaction: async (input: { transaction: { toJSON(): Promise<string> }; chain: string }) => {
            prompts++
            expect(input.chain).toBe('sui:devnet')
            const bytes = await input.transaction.toJSON()
            return { bytes, signature: (await local.sign(Uint8Array.from(atob(bytes), (ch) => ch.charCodeAt(0)), 'devnet')).signature }
          },
        },
      },
    }
    const target = (await resolveSigner(newKey())).address
    const [dry] = track(await batchTransfer(sui, wallet, [{ to: target, amount: 1000n }], { dryRun: true }))
    expect(dry?.status).toBe('simulated')
    expect(prompts).toBe(0)
    const [r] = track(await batchTransfer(sui, wallet, [{ to: target, amount: 1000n }]))
    expect(r?.status).toBe('confirmed')
    expect(prompts).toBe(1)
    expect(await balanceOf(target)).toBe(1000n)
  })

  it('batchCall：@mysten/sui 构建的 TransactionKind', async () => {
    // tx.splitCoins(tx.gas, [0.01 SUI]) → tx.transferObjects([coin], '0x5')；tx.build({ onlyTransactionKind: true }) 的 base64
    const kind = 'AAIACICWmAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQICAAEBAAABAQMAAAAAAQEA'
    const before = await balanceOf('0x5')
    const [r] = track(await batchCall(sui, [{ from: KEY as string, kind }]))
    expect(r?.status).toBe('confirmed')
    expect(BigInt(r?.fee ?? '0')).toBeGreaterThan(0n)
    expect((await balanceOf('0x5')) - before).toBe(MIST / 100n)
  })

  it('执行失败（Move abort）为 failed（模拟就失败，不花 gas）', async () => {
    const ptb = new PtbBuilder()
    // 拆出比余额还多的 SUI
    ptb.command({ kind: 'splitCoins', coin: ptb.gas, amounts: [ptb.pure(pure.u64(10n ** 18n))] })
    const [r] = track(await batchCall(sui, [{ from: KEY as string, kind: ptb.build() }]))
    expect(r?.status).toBe('failed')
    expect(r?.error).toMatch(/simulation failed/)
  })
})
