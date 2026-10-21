/**
 * 兑换连主网（只读调用报价、模拟构建好的交易，不发送），默认跳过：
 * `LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/swap-live.test.ts`（DEX=bluefin 只跑一个 DEX 的单池子用例）
 * 核对：以真实持币地址的身份模拟最终的交易，按余额变化算出买到的数量 ≥ amountOutMin，池子状态没变时与报价相等。
 * 地址是 2026-10 时持币的真实地址，之后可能变化
 */
import { describe, expect, it } from 'vitest'

import { SUI_COIN_TYPE, SuiClient } from '../src/index.js'
import { getEpoch, simulateTransaction } from '../src/services.js'
import { buildSwap, swap, type SwapOptions, type SwapParams, type SwapPlan } from '../src/subpaths/swap.js'
import { encodeTransactionData, kindInputs } from '../src/write/bcs.js'
import { buildContext } from '../src/write/send.js'

const live = process.env.LIVE ? describe : describe.skip
/** 代理 / 公共节点偶尔连接失败：重试几次 */
const retryFetch: typeof fetch = async (input, init) => {
  for (let i = 0; ; i++) {
    try {
      return await fetch(input, init)
    } catch (err) {
      if (i >= 4 || init?.signal?.aborted) throw err
      await new Promise((r) => setTimeout(r, 300 * (i + 1)))
    }
  }
}
const sui = new SuiClient(process.env.SUI_GRPC, { fetch: retryFetch, concurrency: 6 })
/** 持有 SUI、USDC、Wormhole USDC、CETUS、DEEP、WAL */
const HOLDER = '0x9f63425709069336fec108bd4ba69a8f3d23e8ab237311f3ce58ae2bb0ed4d7f'
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
const WUSDC = '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN'
const CETUS = '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS'
const watchOnly = (address: string) => ({ address, signTransaction: async (): Promise<string> => Promise.reject(new Error('watch-only')) })

/** 以 owner 的身份模拟构建好的交易（真实的 gas 币，检查开启），按余额变化算出买到的 tokenOut */
async function simulateOut(plan: SwapPlan, owner: string): Promise<bigint> {
  const ctx = buildContext(sui, null, () => ({}))
  const used = new Set(kindInputs(plan.kind).owned)
  const gas = (await ctx.coins(owner, SUI_COIN_TYPE)).filter((c) => !used.has(c.objectId)).slice(0, 20)
  const { referenceGasPrice } = await getEpoch(sui.transport)
  const bytes = encodeTransactionData({
    kind: plan.kind,
    sender: owner,
    gas: { payment: gas.map(({ balance: _, ...ref }) => ref), owner, price: referenceGasPrice, budget: 100_000_000n },
    expiration: { kind: 'none' },
  })
  const sim = await simulateTransaction(sui.transport, bytes, {}, { balanceChanges: true })
  if (!sim.success) throw new Error(`simulation failed: ${sim.error}`)
  const tokenOut = plan.tokenOut.coinType
  const delta = (sim.balanceChanges ?? []).filter((b) => b.address === owner && b.coinType === tokenOut).reduce((s, b) => s + b.amount, 0n)
  // SUI 的变化里扣了 gas：加回来
  const fee = sim.gasUsed ? sim.gasUsed.computationCost + sim.gasUsed.storageCost - sim.gasUsed.storageRebate : 0n
  return tokenOut === SUI_COIN_TYPE ? delta + fee : delta
}

/**
 * 报价 → 构建 → 模拟：买到的 ≥ amountOutMin。节点不能把两次请求固定在同一个状态上，SUI / USDC 的池子几秒就有一笔交易，所以模拟的同时
 * 只用选中的池子再报一次价（几乎同一时刻的状态）：模拟的结果要等于原报价或这次报价；都不等时（这期间正好有成交）重来，最多 5 次
 */
async function check(params: SwapParams, options: SwapOptions = {}) {
  let last: { plan: SwapPlan; out: bigint; same: boolean } | null = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const plan = await buildSwap(sui, HOLDER, params, { concurrency: 6, ...options })
    const pinned = { protocols: [], pools: plan.route.hops.map((h) => h.pool), intermediates: plan.route.path.slice(1, -1), concurrency: 6 }
    const [out, again] = await Promise.all([simulateOut(plan, HOLDER), buildSwap(sui, HOLDER, params, pinned)])
    expect(out >= BigInt(plan.amountOutMin)).toBe(true)
    expect(again.route.hops.map((h) => h.pool)).toEqual(pinned.pools)
    last = { plan, out, same: out === BigInt(plan.amountOut) || out === BigInt(again.amountOut) }
    if (last.same) break
  }
  const { plan, out, same } = last as { plan: SwapPlan; out: bigint; same: boolean }
  console.log(
    `${plan.tokenIn.symbol} → ${plan.tokenOut.symbol}`,
    plan.amountInFormatted,
    '→',
    plan.amountOutFormatted,
    `(min ${plan.amountOutMinFormatted}, impact ${plan.priceImpact?.toFixed(5)})`,
    plan.route.hops.map((h) => `${h.protocol}:${h.pool.slice(0, 10)}`).join(' > '),
    `simulated ${out}`,
    `${plan.routes.length} routes`,
  )
  expect(same).toBe(true)
  return plan
}

live('兑换：自动找路线（Sui 主网）', { timeout: 300_000 }, () => {
  it('SUI → USDC、USDC → SUI', async () => {
    const a = await check({ tokenIn: SUI_COIN_TYPE, tokenOut: USDC, amountInFormatted: '10' })
    expect(a.route.path).toEqual([SUI_COIN_TYPE, USDC])
    expect(a.routes.length).toBeGreaterThan(3)
    await check({ tokenIn: USDC, tokenOut: '0x2::sui::SUI', amountInFormatted: '5' })
  })

  it('CETUS ↔ SUI（可能经过 USDC 两跳）', async () => {
    await check({ tokenIn: SUI_COIN_TYPE, tokenOut: CETUS, amountInFormatted: '20' })
    await check({ tokenIn: CETUS, tokenOut: SUI_COIN_TYPE, amountInFormatted: '500' })
  })

  it('intermediates 只给 USDC：候选里有 SUI → USDC → CETUS 两跳', async () => {
    const plan = await check({ tokenIn: SUI_COIN_TYPE, tokenOut: CETUS, amountInFormatted: '5' }, { intermediates: [USDC] })
    expect(plan.routes.some((r) => r.hops.length === 2)).toBe(true)
  })

  it('swap 的 dryRun：同样的路线，模拟通过', async () => {
    const r = await swap(sui, watchOnly(HOLDER), { tokenIn: USDC, tokenOut: SUI_COIN_TYPE, amountInFormatted: '2' }, { dryRun: true, concurrency: 6 })
    expect(r.status).toBe('simulated')
    expect(r.plan.kind.commands.length).toBeGreaterThan(0)
  })

  it('持币不够时报错（报价要从 owner 执行一遍）；没有路线时报错', async () => {
    await expect(buildSwap(sui, '0x0000000000000000000000000000000000000000000000000000000000000abc', { tokenIn: USDC, tokenOut: SUI_COIN_TYPE, amountInFormatted: '1' })).rejects.toThrow(/Insufficient balance/)
    await expect(buildSwap(sui, HOLDER, { tokenIn: SUI_COIN_TYPE, tokenOut: USDC, amountInFormatted: '1' }, { protocols: [], pools: [] })).rejects.toThrow(/No route found/)
  })
})

/** 每个 DEX 一个池子（只用这个池子），两个方向；coin 是另一种币（和 SUI 配对） */
const POOLS: Array<{ protocol: string; pool: string; coin: string; amount: string }> = [
  { protocol: 'cetus', pool: '0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab', coin: USDC, amount: '1' },
  { protocol: 'bluefin', pool: '0x3b585786b13af1d8ea067ab37101b6513a05d2f90cfe60e8b1d9e1b46a63c4fa', coin: USDC, amount: '1' },
  { protocol: 'momentum', pool: '0x455cf8d2ac91e7cb883f515874af750ed3cd18195c970b7a2d46235ac2b0c388', coin: USDC, amount: '1' },
  { protocol: 'turbos', pool: '0x0df4f02d0e210169cb6d5aabd03c3058328c06f2c4dbb0804faa041159c78443', coin: USDC, amount: '1' },
  { protocol: 'flowx', pool: '0x325239132e2b619147c00052986461cea02815172ea9d000c58e68484f514a90', coin: USDC, amount: '1' },
  { protocol: 'magma', pool: '0xff8c47de1f04e4889bd3dbe06e87ceb61d44c2380f43d2a4fb2bc582ff8e51dd', coin: USDC, amount: '1' },
  { protocol: 'cetus-dlmm', pool: '0x64e590b0e4d4f7dfc7ae9fae8e9983cd80ad83b658d8499bf550a9d4f6667076', coin: USDC, amount: '1' },
  { protocol: 'dipcoin', pool: '0x7fbd7f609fcecd84329359cb6ea4eadbcd84d02a28fec9ce4652712d06474b3e', coin: USDC, amount: '1' },
  { protocol: 'flowx-v2', pool: '0x8eba28d4fef9750f52baaaed896d096b0765973ca6c8f193870236b5451a413c', coin: USDC, amount: '1' },
  { protocol: 'kriya-amm', pool: '0x5af4976b871fa1813362f352fa4cada3883a96191bb7212db1bd5d13685ae305', coin: WUSDC, amount: '1' },
  { protocol: 'aftermath', pool: '0xb0cc4ce941a6c6ac0ca6d8e6875ae5d86edbec392c3333d008ca88f377e5e181', coin: USDC, amount: '1' },
]

live('兑换：每个 DEX 单独（Sui 主网）', { timeout: 300_000 }, () => {
  for (const c of POOLS.filter((x) => !process.env.DEX || x.protocol === process.env.DEX)) {
    it(`${c.protocol}：SUI → 币、币 → SUI`, async () => {
      const options = { protocols: [], pools: [c.pool], intermediates: [] }
      const buy = await check({ tokenIn: SUI_COIN_TYPE, tokenOut: c.coin, amountInFormatted: c.amount }, options)
      expect(buy.route.hops).toMatchObject([{ protocol: c.protocol }])
      const sell = await check({ tokenIn: c.coin, tokenOut: SUI_COIN_TYPE, amountInFormatted: c.amount }, options)
      expect(sell.route.hops).toMatchObject([{ protocol: c.protocol }])
    })
  }

  it('kriya-clmm：合约关闭了交易（2026-10 所有池子的 pool::assert_trading_enabled 都失败），没有路线', async () => {
    const options = { protocols: [], pools: ['0x779ec6b1b3a147a74d72bbc5fea67f3cf57b11af99e8811c2e5b3f57aacd490f'], intermediates: [] }
    await expect(buildSwap(sui, HOLDER, { tokenIn: SUI_COIN_TYPE, tokenOut: USDC, amountInFormatted: '0.2' }, options)).rejects.toThrow(/No route found/)
  })
})
