/**
 * 兑换：按币对找池子的注册表条目、各 DEX 的兑换命令、选路线 / 最少收到 / 价格影响 / 交易内容（假节点，不连网络）
 */
import { describe, expect, it } from 'vitest'

import { GrpcError, SUI_COIN_TYPE, SuiClient, normalizeStructTag, normalizeSuiAddress } from '../src/index.js'
import { simulateTransaction } from '../src/services.js'
import { createEnv } from '../src/dex/env.js'
import { POOL_LOOKUPS, findPools } from '../src/pools.js'
import { typeNameOf } from '../src/dynamicField.js'
import { buildSwap, swap } from '../src/subpaths/swap.js'
import { SWAP_PACKAGES, swapCommand, type SwapPool } from '../src/swapTx.js'
import { PtbBuilder } from '../src/write/ptb.js'
import { FakeSui, hasId, hasU64 } from './swapFake.js'

const USDC = normalizeStructTag('0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC')
const OWNER = normalizeSuiAddress('0xa1')
const DIPCOIN = '0xdae28ab9ab072c647c4e8f2057a8f17dcc4847e42d6a8258df4b376ae183c872'
const KRIYA = '0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66'
const MAGMA = '0x4a35d3dfef55ed3631b7158544c6322a23bc434fe4fca1234cb680ce0505f82d'
const DIP_POOL = normalizeSuiAddress('0xd1')
const KRIYA_POOL = normalizeSuiAddress('0xd2')

const lohi = (a: string, b: string) => {
  const [x, y] = [typeNameOf(a), typeNameOf(b)]
  return x < y ? ([x, y] as const) : ([y, x] as const)
}

describe('按币对找池子', () => {
  it('注册表条目的对象 ID 本地算出（主网 Magma 的 SUI / USDC 60、DipCoin 的 LP-SUI-USDC，2026-10 核对过）', () => {
    const [lo, hi] = lohi(SUI_COIN_TYPE, USDC)
    expect(POOL_LOOKUPS.magma.entries(lo, hi, { cetus: [], magma: [60], turbos: null })).toEqual(['0x20fb50fe178543b81bc1a1f66548cd0240e40d54584f1b9b18b383d00d5cb951'])
    // 两种顺序都查（池子的币顺序未知）
    expect(POOL_LOOKUPS.dipcoin.entries(lo, hi, { cetus: [], magma: [], turbos: null })[0]).toBe('0x56446aacb1036777b6870e728330d6f126b4cec6736c255fdcba1e63f3edda29')
    expect(POOL_LOOKUPS['flowx-v2'].entries(lo, hi, { cetus: [], magma: [], turbos: null })).toHaveLength(2)
  })

  it('findPools：读配置（手续费档位）和条目，结果与币对一一对应；读不到的条目跳过', async () => {
    const node = new FakeSui()
    node.add(
      { id: '0x4c4e1402401f72c7d8533d0ed8d5f8949da363c7a3319ccef261ffe153d32f8a', type: `${MAGMA}::config::GlobalConfig`, owner: 'shared', json: { fee_tiers: { contents: [{ key: '60' }, { key: '200' }] } } },
      { id: '0x20fb50fe178543b81bc1a1f66548cd0240e40d54584f1b9b18b383d00d5cb951', type: 'entry', owner: 'shared', json: { value: { value: { pool_id: '0xff8c47de1f04e4889bd3dbe06e87ceb61d44c2380f43d2a4fb2bc582ff8e51dd' } } } },
      { id: '0x56446aacb1036777b6870e728330d6f126b4cec6736c255fdcba1e63f3edda29', type: 'entry', owner: 'shared', json: { value: '0x7fbd7f609fcecd84329359cb6ea4eadbcd84d02a28fec9ce4652712d06474b3e' } },
    )
    const found = await findPools(new SuiClient(node), [[USDC, '0x2::sui::SUI'], [USDC, '0x1::x::X']], ['magma', 'dipcoin'])
    expect(found).toEqual([
      [
        { protocol: 'magma', id: '0xff8c47de1f04e4889bd3dbe06e87ceb61d44c2380f43d2a4fb2bc582ff8e51dd' },
        { protocol: 'dipcoin', id: '0x7fbd7f609fcecd84329359cb6ea4eadbcd84d02a28fec9ce4652712d06474b3e' },
      ],
      [],
    ])
    expect(await findPools(new SuiClient(node), [[USDC, SUI_COIN_TYPE]], [])).toEqual([[]])
  })
})

/** 每个协议的兑换命令（Move 调用的模块::函数） */
describe('兑换命令', () => {
  const clmm = (protocol: string, typeArgs = [SUI_COIN_TYPE, USDC]): SwapPool => ({
    protocol: protocol as SwapPool['protocol'],
    id: normalizeSuiAddress('0xe1'),
    coins: [SUI_COIN_TYPE, USDC],
    fee: 3000,
    data: {
      kind: 'clmm',
      pool: { protocol: protocol as never, id: normalizeSuiAddress('0xe1'), typeArgs, coinA: SUI_COIN_TYPE, coinB: USDC, sqrtPrice: 1n << 64n, tick: 0, fee: 3000, tickSpacing: 60, rewardCoins: [], shared: { objectId: normalizeSuiAddress('0xe1'), initialSharedVersion: 1n }, paused: false },
    },
  })
  const targets = (p: SwapPool, a2b: boolean) => {
    const ptb = new PtbBuilder()
    const packages = new Map(Object.values(SWAP_PACKAGES).flat().map((o) => [o, o]))
    const env = createEnv(ptb, OWNER, packages)
    const coin = ptb.moveCall('0x2::coin::zero', [a2b ? SUI_COIN_TYPE : USDC], [])
    swapCommand(env, p, coin, a2b ? SUI_COIN_TYPE : USDC, a2b ? USDC : SUI_COIN_TYPE)
    return ptb.build().commands.slice(1).flatMap((c) => (c.kind === 'moveCall' ? [`${c.module}::${c.function}`] : [c.kind]))
  }

  it('集中流动性：Cetus / Magma 的 router::swap，Bluefin 的 pool::swap，Momentum / Kriya 的 flash_swap + 还款，Turbos、FlowX 的 swap_router；剩下的输入币要正好为 0', () => {
    expect(targets(clmm('cetus'), true)).toEqual(['coin::value', 'coin::zero', 'router::swap', 'coin::destroy_zero'])
    expect(targets(clmm('magma'), false)).toEqual(['coin::value', 'coin::zero', 'router::swap', 'coin::destroy_zero'])
    expect(targets(clmm('bluefin'), true)).toEqual(['coin::value', 'coin::into_balance', 'balance::zero', 'pool::swap', 'balance::destroy_zero', 'coin::from_balance'])
    expect(targets(clmm('momentum'), true)).toEqual([
      'coin::value',
      'trade::flash_swap',
      'trade::swap_receipt_debts',
      'coin::split',
      'coin::destroy_zero',
      'coin::into_balance',
      'balance::destroy_zero',
      'balance::zero',
      'trade::repay_flash_swap',
      'coin::from_balance',
    ])
    expect(targets(clmm('turbos', [SUI_COIN_TYPE, USDC, '0x1::fee::FEE']), false)).toEqual(['coin::value', 'makeMoveVec', 'swap_router::swap_b_a_with_return_', 'coin::destroy_zero'])
    expect(targets(clmm('flowx'), true)).toEqual(['swap_router::swap_exact_input'])
  })

  it('价格上限：A → B 用最小价格 + 1，B → A 用最大价格 − 1；FlowX 的类型参数是 <卖出, 买入>', () => {
    const ptb = new PtbBuilder()
    const env = createEnv(ptb, OWNER, new Map(Object.values(SWAP_PACKAGES).flat().map((o) => [o, o])))
    const coin = ptb.moveCall('0x2::coin::zero', [USDC], [])
    swapCommand(env, clmm('flowx'), coin, USDC, SUI_COIN_TYPE)
    const call = ptb.build().commands[1] as { typeArguments: string[]; arguments: Array<{ index: number }> }
    expect(call.typeArguments).toEqual([USDC, SUI_COIN_TYPE])
    const limit = ptb.inputs[call.arguments[4]?.index as number] as { bytes: Uint8Array }
    expect(new DataView(limit.bytes.buffer).getBigUint64(0, true) + (new DataView(limit.bytes.buffer).getBigUint64(8, true) << 64n)).toBe(79226673515401279992447579055n - 1n)
  })

  it('传统 AMM 和 Aftermath', () => {
    const amm = (protocol: 'dipcoin' | 'flowx-v2' | 'kriya-amm'): SwapPool => ({
      protocol,
      id: DIP_POOL,
      coins: [SUI_COIN_TYPE, USDC],
      fee: 3000,
      data: { kind: 'amm', pool: { protocol, id: DIP_POOL, coinA: SUI_COIN_TYPE, coinB: USDC, reserveA: 1n, reserveB: 1n, lpSupply: 1n, lpCoinType: 'x', fee: 3000, stable: false, shared: { objectId: DIP_POOL, initialSharedVersion: 1n }, depositEnabled: true, withdrawEnabled: true, minLp: 0n } },
    })
    expect(targets(amm('dipcoin'), true)).toEqual(['router::swap_exact_x_to_y_with_return'])
    expect(targets(amm('flowx-v2'), false)).toEqual(['router::swap_exact_input_direct'])
    expect(targets(amm('kriya-amm'), false)).toEqual(['coin::value', 'spot_dex::swap_token_y'])
  })
})

/** 两个池子：DipCoin 1 SUI → 3.2 USDC，Kriya 1 SUI → 3.1 USDC（小数量时都按 3.3） */
function fakeNode() {
  const node = new FakeSui()
  node.coins.set(USDC, { decimals: 6, symbol: 'USDC' })
  node.add(
    { id: DIP_POOL, type: `${DIPCOIN}::manage::Pool<${SUI_COIN_TYPE}, ${USDC}>`, owner: 'shared', json: { bal_x: '1000000000000', bal_y: '3000000000', lp_supply: { value: '1000' }, fee_rate: '30' } },
    { id: KRIYA_POOL, type: `${KRIYA}::spot_dex::Pool<${SUI_COIN_TYPE}, ${USDC}>`, owner: 'shared', json: { token_x: '1000000000000', token_y: '3000000000', lsp_supply: { value: '1000' }, lp_fee_percent: '2000', protocol_fee_percent: '1000', is_stable: false } },
  )
  node.hold(OWNER, SUI_COIN_TYPE, 50n * 10n ** 9n)
  node.hold(OWNER, USDC, 7_000_000n)
  const rate = (tx: Uint8Array) => (hasId(tx, DIP_POOL) ? 3_200_000n : hasId(tx, KRIYA_POOL) ? 3_100_000n : 0n)
  node.inspect = (tx) => {
    const r = rate(tx)
    if (!r) return null
    // 1 SUI（10^9）按池子的价格；10^5 MIST 按 3.3 USDC / SUI（价格影响）
    const out = hasU64(tx, 10n ** 9n) ? r : hasU64(tx, 10n ** 5n) ? 330n : null
    return out === null ? null : Array.from({ length: 30 }, () => out.toString())
  }
  return node
}

describe('buildSwap', () => {
  it('每条候选路线一次只读调用，选输出最多的；最少收到按滑点；价格影响按极小数量的价格；交易最后检查数量', async () => {
    const node = fakeNode()
    const plan = await buildSwap(new SuiClient(node), OWNER, { tokenIn: '0x2::sui::SUI', tokenOut: USDC, amountInFormatted: '1' }, { protocols: [], pools: [KRIYA_POOL, DIP_POOL], slippage: 0.01 })
    expect(plan).toMatchObject({
      tokenIn: { coinType: SUI_COIN_TYPE, symbol: 'SUI', decimals: 9 },
      tokenOut: { coinType: USDC, symbol: 'USDC', decimals: 6 },
      amountIn: '1000000000',
      amountOut: '3200000',
      amountOutFormatted: '3.2',
      amountOutMin: '3168000',
      route: { path: [SUI_COIN_TYPE, USDC], hops: [{ protocol: 'dipcoin', pool: DIP_POOL, tokenIn: SUI_COIN_TYPE, tokenOut: USDC, fee: 3000 }], amountOut: '3200000' },
    })
    expect(plan.price).toBeCloseTo(3.2)
    expect(plan.priceImpact).toBeCloseTo(1 - 3.2 / 3.3, 6)
    expect(plan.routes.map((r) => [r.hops[0]?.protocol, r.amountOut])).toEqual([
      ['dipcoin', '3200000'],
      ['kriya-amm', '3100000'],
    ])
    // 两条路线 + 价格影响一次
    expect(node.count('SimulateTransaction')).toBe(3)
    // SUI 从 gas 币拆；买到的 USDC 检查不少于下限后合并进发送者已有的 USDC Coin
    const kinds = plan.kind.commands.map((c) => (c.kind === 'moveCall' ? `${c.module}::${c.function}` : c.kind))
    expect(kinds).toEqual(['splitCoins', 'router::swap_exact_x_to_y_with_return', 'splitCoins', 'mergeCoins', 'mergeCoins'])
    expect(plan.kind.commands[0]).toMatchObject({ coin: { kind: 'gas' } })
    expect(plan.gasSpend).toBe(10n ** 9n)
    const guard = plan.kind.commands[2] as { amounts: Array<{ index: number }> }
    expect(new DataView((plan.kind.inputs[guard.amounts[0]?.index as number] as { bytes: Uint8Array }).bytes.buffer).getBigUint64(0, true)).toBe(3_168_000n)
  })

  it('卖出的不是 SUI 时要持有足够的币；没有能报价的路线时报错；参数检查', async () => {
    const node = fakeNode()
    const client = new SuiClient(node)
    await expect(buildSwap(client, OWNER, { tokenIn: USDC, tokenOut: SUI_COIN_TYPE, amountInFormatted: '8' }, { protocols: [], pools: [DIP_POOL] })).rejects.toThrow(/Insufficient balance of .*holds 7000000/)
    await expect(buildSwap(client, OWNER, { tokenIn: SUI_COIN_TYPE, tokenOut: USDC, amountInFormatted: '2' }, { protocols: [], pools: [DIP_POOL] })).rejects.toThrow(/No route found/)
    await expect(buildSwap(client, OWNER, { tokenIn: USDC, tokenOut: USDC, amountIn: 1n })).rejects.toThrow(/same/)
    await expect(buildSwap(client, OWNER, { tokenIn: SUI_COIN_TYPE, tokenOut: USDC })).rejects.toThrow(/exactly one/)
    await expect(buildSwap(client, OWNER, { tokenIn: SUI_COIN_TYPE, tokenOut: USDC, amountIn: 0n })).rejects.toThrow(/greater than 0/)
    await expect(buildSwap(client, OWNER, { tokenIn: SUI_COIN_TYPE, tokenOut: USDC, amountIn: 1n }, { slippage: 1 })).rejects.toThrow(/slippage/)
  })

  it('读 Coin 时节点出错：抛出节点的错误（不是“没有路线”）；失败的读取不缓存', async () => {
    const node = fakeNode()
    const unary = node.unary.bind(node)
    let failures = 1
    node.unary = async (method, request) => {
      if (method.endsWith('ListOwnedObjects') && failures-- > 0) throw new GrpcError(14, 'unavailable')
      return unary(method, request)
    }
    await expect(buildSwap(new SuiClient(node), OWNER, { tokenIn: USDC, tokenOut: SUI_COIN_TYPE, amountIn: 1_000_000n }, { protocols: [], pools: [DIP_POOL] })).rejects.toThrow(/unavailable/)
  })

  it('并发上限：同时进行的只读调用不超过 concurrency', async () => {
    const node = fakeNode()
    const unary = node.unary.bind(node)
    let active = 0
    let peak = 0
    node.unary = async (method, request) => {
      if (!method.endsWith('SimulateTransaction')) return unary(method, request)
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return unary(method, request)
    }
    const extra = Array.from({ length: 6 }, (_, i) => normalizeSuiAddress(`0xd${i + 3}`))
    for (const id of extra) node.add({ id, type: `${DIPCOIN}::manage::Pool<${SUI_COIN_TYPE}, ${USDC}>`, owner: 'shared', json: { bal_x: '1', bal_y: '1', lp_supply: { value: '1' }, fee_rate: '30' } })
    await buildSwap(new SuiClient(node), OWNER, { tokenIn: SUI_COIN_TYPE, tokenOut: USDC, amountInFormatted: '1' }, { protocols: [], pools: [DIP_POOL, KRIYA_POOL, ...extra], concurrency: 2 })
    expect(peak).toBe(2)
  })

  it('发送者没有 SUI Coin 对象（只有地址余额）时，买到的 SUI 不合并进 gas 币，照常转给发送者', async () => {
    const node = fakeNode()
    node.hold(OWNER, SUI_COIN_TYPE)
    node.inspect = (tx) => (hasId(tx, DIP_POOL) ? Array.from({ length: 30 }, () => '300000000') : null)
    const plan = await buildSwap(new SuiClient(node), OWNER, { tokenIn: USDC, tokenOut: SUI_COIN_TYPE, amountIn: 1_000_000n }, { protocols: [], pools: [DIP_POOL] })
    expect(JSON.stringify(plan.kind.commands)).not.toContain('"gas"')
    expect(plan.kind.commands.at(-1)).toMatchObject({ kind: 'transferObjects' })
  })

  it('swap：dryRun 时按发送者最新的 Coin 构建并模拟；发送前检查余额（SUI 另留 gas）', async () => {
    const node = fakeNode()
    const watchOnly = { address: OWNER, signTransaction: async (): Promise<string> => Promise.reject(new Error('watch-only')) }
    const r = await swap(new SuiClient(node), watchOnly, { tokenIn: SUI_COIN_TYPE, tokenOut: USDC, amountInFormatted: '1' }, { protocols: [], pools: [DIP_POOL], dryRun: true })
    expect(r).toMatchObject({ status: 'simulated', from: OWNER, plan: { amountOut: '3200000', gasSpend: 10n ** 9n } })
    expect(r.plan.kind.commands.length).toBe(5)
    node.hold(OWNER, SUI_COIN_TYPE, 1_020_000_000n)
    await expect(swap(new SuiClient(node), watchOnly, { tokenIn: SUI_COIN_TYPE, tokenOut: USDC, amountInFormatted: '1' }, { protocols: [], pools: [DIP_POOL] })).rejects.toThrow(/including about 0.05 SUI for gas/)
  })
})

describe('simulateTransaction', () => {
  it('请求了余额变化、但响应里没有时为 []', async () => {
    const node = fakeNode()
    node.inspect = () => []
    const r = await simulateTransaction(node, new Uint8Array([0]), {}, { balanceChanges: true })
    expect(r.balanceChanges).toEqual([])
    expect((await simulateTransaction(node, new Uint8Array([0]))).balanceChanges).toBeUndefined()
  })
})
