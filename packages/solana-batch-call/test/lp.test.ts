import { readFileSync } from 'node:fs'

import { sha256 } from '@noble/hashes/sha2.js'
import { base64 } from '@scure/base'
import { beforeEach, describe, expect, it } from 'vitest'

import { SolanaClient, decodeAddress, findProgramAddress, type RpcTransport } from '../src/index.js'
import { resetTokenMetaCache } from '../src/client.js'
import { lpPositions, type SolanaLpClmmPosition, type SolanaLpPosition, type SolanaPriceSource } from '../src/lp.js'
import { MAX_TICK, MIN_TICK, getFeeGrowthInside, getFeesOwed, orcaSqrtPriceAtTick, raydiumSqrtPriceAtTick } from '../src/lpMath.js'
import { resetClientCache } from '../src/shortcuts.js'
import { getLpPositions } from '../src/subpaths/lp.js'
import { createMockNode, type MockAccount } from './mock.js'

/**
 * 主网账户快照（2026-10）：Raydium CLMM、Orca Whirlpool（SPL / Token-2022 两种仓位 NFT）、Raydium AMM v4、CPMM 各一个真实仓位，
 * expected 是官方 SDK（@orca-so/whirlpools-core、@raydium-io/raydium-sdk-v2）从同一份数据独立算出的结果。
 * 回放这些账户，验证账户布局的偏移量和计算与官方实现逐位一致
 */
interface Fixture {
  accounts: Record<string, { owner: string; data: string }>
  getProgramAccounts: { params: [string, { filters: [unknown, { memcmp: { bytes: string } }] }]; result: unknown[] }[]
  cases: { owner: string; mints: string[]; expected: Record<string, string> }[]
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/lp-mainnet.json', import.meta.url), 'utf8')) as Fixture

const [RAYDIUM, ORCA, ORCA_2022, AMM, CPMM] = fixture.cases as [Fixture['cases'][number], Fixture['cases'][number], Fixture['cases'][number], Fixture['cases'][number], Fixture['cases'][number]]
const AMM_POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'
const ORCA_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'

function accounts(edit?: (address: string, data: Uint8Array) => Uint8Array): Record<string, MockAccount> {
  return Object.fromEntries(
    Object.entries(fixture.accounts).map(([address, a]) => {
      const data = base64.decode(a.data)
      return [address, { owner: a.owner, lamports: 1_000_000n, data: edit ? edit(address, data) : data }]
    }),
  )
}

/** 快照回放：getProgramAccounts 按 memcmp 的 LP mint 返回录下来的结果，其余方法交给模拟节点 */
function replay(options: { edit?: (address: string, data: Uint8Array) => Uint8Array; gpaError?: boolean } = {}) {
  const node = createMockNode({ accounts: accounts(options.edit) })
  const calls: string[] = []
  const transport: RpcTransport = {
    async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      calls.push(method)
      if (method === 'getProgramAccounts') {
        if (options.gpaError) {
          const { RpcError } = await import('../src/rpc.js')
          throw new RpcError('Request blocked', -32602)
        }
        const bytes = (params[1] as { filters: [unknown, { memcmp: { bytes: string } }] }).filters[1].memcmp.bytes
        const hit = fixture.getProgramAccounts.find((g) => g.params[0] === params[0] && g.params[1].filters[1].memcmp.bytes === bytes)
        return (hit?.result ?? []) as T
      }
      return node.request<T>(method, params)
    },
  }
  return { client: new SolanaClient(transport, { cluster: 'mainnet' }), calls, transport }
}

function numbers(p: SolanaLpPosition) {
  return p.type === 'clmm' ? { amount0: p.amount0, amount1: p.amount1, fees0: p.fees0, fees1: p.fees1 } : { amount0: p.amount0, amount1: p.amount1, totalSupply: p.totalSupply }
}

beforeEach(() => {
  resetTokenMetaCache()
  resetClientCache()
})

describe('lpMath', () => {
  it('tick → sqrt 价格：边界值与两个程序的常量一致', () => {
    expect(raydiumSqrtPriceAtTick(0)).toBe(1n << 64n)
    expect(orcaSqrtPriceAtTick(0)).toBe(1n << 64n)
    // raydium-clmm MIN_SQRT_PRICE_X64 / MAX_SQRT_PRICE_X64
    expect(raydiumSqrtPriceAtTick(MIN_TICK)).toBe(4295048016n)
    expect(raydiumSqrtPriceAtTick(MAX_TICK)).toBe(79226673521066979257578248091n)
    // orca whirlpool MIN_SQRT_PRICE_X64 / MAX_SQRT_PRICE_X64
    expect(orcaSqrtPriceAtTick(MIN_TICK)).toBe(4295048016n)
    expect(orcaSqrtPriceAtTick(MAX_TICK)).toBe(79226673515401279992447579055n)
    expect(() => raydiumSqrtPriceAtTick(MAX_TICK + 1)).toThrow(RangeError)
    expect(() => orcaSqrtPriceAtTick(1.5)).toThrow(RangeError)
  })

  it('手续费增长按 u128 回绕；Orca 未初始化的 tick', () => {
    const U128 = 1n << 128n
    const tick = { initialized: true, feeGrowthOutside0: 0n, feeGrowthOutside1: 0n }
    // 全局增长回绕后小于记录值，区间内增长也按回绕计算
    const [inside0] = getFeeGrowthInside(0, -10, tick, 10, tick, 5n, 0n)
    expect(inside0).toBe(5n)
    expect(getFeesOwed(7n, 1n << 64n, 5n, U128 - 3n)).toBe(7n + 8n)
    // 未初始化的下限：下方增长 = 全局，区间内为 0
    expect(getFeeGrowthInside(0, -10, { ...tick, initialized: false }, 10, tick, 100n, 100n)).toEqual([0n, 0n])
    // 新增部分超过 u64：与 Orca 程序一致记为 0
    expect(getFeesOwed(1n, U128 - 1n, U128 - 1n, 0n)).toBe(1n)
  })
})

describe('lpPositions（主网快照回放）', () => {
  it.each([
    ['Raydium CLMM', RAYDIUM],
    ['Orca Whirlpool', ORCA],
    ['Orca Whirlpool（Token-2022 仓位 NFT）', ORCA_2022],
    ['Raydium AMM v4', AMM],
    ['Raydium CPMM', CPMM],
  ])('%s：数量和手续费与官方 SDK 一致', async (_name, c) => {
    const { client } = replay()
    const list = await lpPositions(client, c.owner, { mints: c.mints })
    expect(list).toHaveLength(1)
    expect(numbers(list[0] as SolanaLpPosition)).toEqual(c.expected)
  })

  it('返回的字段：协议、代币、区间、价格', async () => {
    const { client } = replay()
    const [p] = (await lpPositions(client, RAYDIUM.owner, { mints: RAYDIUM.mints })) as [SolanaLpClmmPosition]
    expect(p).toMatchObject({
      type: 'clmm',
      protocol: 'raydium-clmm',
      protocolName: 'Raydium CLMM',
      pool: '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv',
      positionMint: RAYDIUM.mints[0],
      token0: { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9 },
      token1: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
      fee: 400,
      tickSpacing: 1,
      inRange: true,
    })
    expect(p.amount0Formatted).toBe((Number(p.amount0) / 1e9).toString())
    expect(p.price).toBeGreaterThan(p.priceLower as number)
    expect(p.price).toBeLessThan(p.priceUpper as number)
    expect('valueUsd' in p).toBe(false)

    const [amm] = await lpPositions(client, AMM.owner, { mints: AMM.mints })
    expect(amm).toMatchObject({ type: 'amm', protocol: 'raydium-amm', pool: AMM_POOL, lpMint: AMM.mints[0] })
    expect((amm as { share: number }).share).toBeCloseTo(Number((amm as { balance: string }).balance) / Number(AMM.expected.totalSupply), 12)
  })

  it('Orca 可变大小的 tick 数组（DynamicTickArray）与固定大小的结果相同', async () => {
    const discriminator = (name: string) => sha256(new TextEncoder().encode(`account:${name}`)).subarray(0, 8)
    const fixed = discriminator('TickArray')
    // 把快照里固定大小的 tick 数组改写成可变大小的格式
    const toDynamic = (address: string, data: Uint8Array) => {
      if (fixture.accounts[address]?.owner !== ORCA_PROGRAM || !fixed.every((b, i) => data[i] === b)) {
        return data
      }
      const out: number[] = [...discriminator('DynamicTickArray'), ...data.subarray(8, 12), ...data.subarray(9956, 9988), ...new Uint8Array(16)]
      for (let i = 0; i < 88; i++) {
        const tick = data.subarray(12 + i * 113, 12 + (i + 1) * 113)
        if (tick[0] === 1) out.push(1, ...tick.subarray(1))
        else out.push(0)
      }
      return new Uint8Array(out)
    }
    const { client } = replay({ edit: toDynamic })
    for (const c of [ORCA, ORCA_2022]) {
      const [p] = await lpPositions(client, c.owner, { mints: c.mints })
      expect(numbers(p as SolanaLpPosition)).toEqual(c.expected)
    }
  })

  it('不传 mints：扫描全部代币账户找仓位 NFT 和 LP 代币', async () => {
    const { client, calls } = replay()
    const list = await lpPositions(client, ORCA.owner)
    expect(calls).toContain('getTokenAccountsByOwner')
    expect(list.map(numbers)).toEqual([ORCA.expected])
  })

  it('pools：直接按池子识别 LP 代币，不用 getProgramAccounts', async () => {
    const { client, calls } = replay()
    const list = await lpPositions(client, AMM.owner, { mints: AMM.mints, pools: [AMM_POOL] })
    expect(list.map(numbers)).toEqual([AMM.expected])
    expect(calls).not.toContain('getProgramAccounts')
  })

  it('节点不支持 getProgramAccounts：报错里说明怎么绕过', async () => {
    const { client } = replay({ gpaError: true })
    await expect(lpPositions(client, AMM.owner, { mints: AMM.mints })).rejects.toThrow(/getProgramAccounts.*Request blocked.*`pools`/)
    // 不持有 Raydium 的 LP 代币时不会用到它
    expect(await lpPositions(client, ORCA.owner, { mints: ORCA.mints })).toHaveLength(1)
  })

  it('protocols 只查某些协议', async () => {
    const { client, calls } = replay()
    expect(await lpPositions(client, ORCA.owner, { mints: ORCA.mints, protocols: ['raydium-clmm'] })).toEqual([])
    expect(await lpPositions(client, AMM.owner, { mints: AMM.mints, protocols: ['raydium-cpmm'] })).toEqual([])
    expect(calls).not.toContain('getProgramAccounts')
    await expect(lpPositions(client, ORCA.owner, { protocols: ['uniswap' as never] })).rejects.toThrow(/Unknown LP protocol/)
  })

  it('已清空的仓位（流动性和手续费都为 0）默认不返回，includeClosed 时返回', async () => {
    // 把 Orca 仓位账户（PDA ["position", mint]）的流动性和已记账的手续费清零
    const position = findProgramAddress([new TextEncoder().encode('position'), decodeAddress(ORCA.mints[0] as string)], ORCA_PROGRAM)
    const { client } = replay({
      edit: (address, data) => {
        if (address !== position) return data
        const copy = data.slice()
        copy.fill(0, 72, 88)
        copy.fill(0, 112, 120)
        copy.fill(0, 136, 144)
        return copy
      },
    })
    expect(fixture.accounts[position]).toBeDefined()
    expect(await lpPositions(client, ORCA.owner, { mints: ORCA.mints })).toEqual([])
    const [p] = (await lpPositions(client, ORCA.owner, { mints: ORCA.mints, includeClosed: true })) as [SolanaLpClmmPosition]
    expect(p).toMatchObject({ liquidity: '0', amount0: '0', amount1: '0', fees0: '0', fees1: '0' })
  })

  it('prices：美元价值和手续费价值，按价值排序', async () => {
    const { client } = replay()
    const prices: SolanaPriceSource = {
      name: 'test',
      async prices({ mints, client: ctxClient }) {
        expect([...mints].sort()).toEqual(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'So11111111111111111111111111111111111111112'])
        expect(ctxClient).toBe(client) // 链上价格源用它读池子
        return new Map([
          ['So11111111111111111111111111111111111111112', 100],
          ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 1],
        ])
      },
    }
    const [p] = (await lpPositions(client, RAYDIUM.owner, { mints: RAYDIUM.mints, prices })) as [SolanaLpClmmPosition]
    expect(p.valueUsd).toBeCloseTo((Number(p.amount0) / 1e9) * 100 + Number(p.amount1) / 1e6, 6)
    expect(p.feesUsd).toBeCloseTo((Number(p.fees0) / 1e9) * 100 + Number(p.fees1) / 1e6, 6)

    // 价格源出错：照样返回仓位，只是不带价格
    const down: SolanaPriceSource = { name: 'down', prices: async () => Promise.reject(new Error('HTTP 503')) }
    const errors: unknown[] = []
    const [d] = (await lpPositions(client, RAYDIUM.owner, { mints: RAYDIUM.mints, prices: down, onPriceError: (err) => errors.push(err) })) as [SolanaLpClmmPosition]
    expect(d).toMatchObject({ amount0: RAYDIUM.expected.amount0, valueUsd: null, feesUsd: null })
    expect(String(errors[0])).toContain('HTTP 503')
    // 价格源同步抛错也接住
    const sync: SolanaPriceSource = {
      name: 'sync',
      prices: () => {
        throw new Error('sync fail')
      },
    }
    const syncErrors: unknown[] = []
    expect(await lpPositions(client, RAYDIUM.owner, { mints: RAYDIUM.mints, prices: sync, onPriceError: (e) => syncErrors.push(e) })).toHaveLength(1)
    expect(String(syncErrors[0])).toContain('sync fail')
    // 回调本身出错不影响结果
    const throwing = await lpPositions(client, RAYDIUM.owner, {
      mints: RAYDIUM.mints,
      prices: down,
      onPriceError: () => {
        throw new Error('boom')
      },
    })
    expect(throwing).toHaveLength(1)
    // 价格源正常时不调用
    const calls: unknown[] = []
    await lpPositions(client, RAYDIUM.owner, { mints: RAYDIUM.mints, prices, onPriceError: (err) => calls.push(err) })
    expect(calls).toEqual([])

    // 没有价格的代币数量不为 0 时 valueUsd 为 null
    const partial: SolanaPriceSource = { name: 'partial', prices: async () => new Map([['So11111111111111111111111111111111111111112', 100]]) }
    const [q] = await lpPositions(client, RAYDIUM.owner, { mints: RAYDIUM.mints, prices: partial })
    expect(q?.valueUsd).toBeNull()
  })

  it('getLpPositions：节点参数与其他快捷函数相同', async () => {
    const { transport } = replay()
    const list = await getLpPositions(CPMM.owner, { provider: transport, cluster: 'mainnet', mints: CPMM.mints })
    expect(list.map(numbers)).toEqual([CPMM.expected])
  })

  it('有流动性但读不到 tick 数组：手续费为 null（不只报已记账的部分）', async () => {
    const tickArrays = new Set(Object.keys(fixture.accounts).filter((a) => fixture.accounts[a]?.owner === ORCA_PROGRAM && base64.decode(fixture.accounts[a]?.data ?? '').length > 1000))
    const { client } = replay({ edit: (address, data) => (tickArrays.has(address) ? new Uint8Array(0) : data) })
    const [p] = (await lpPositions(client, ORCA.owner, { mints: ORCA.mints, prices: { name: 'p', prices: async () => new Map([['So11111111111111111111111111111111111111112', 100]]) } })) as [SolanaLpClmmPosition]
    expect(p).toMatchObject({ amount0: ORCA.expected.amount0, fees0: null, fees1: null, fees0Formatted: null, feesUsd: null })
  })

  it('pools 里不是 AMM v4 / CPMM 池子时报错；protocols 为空时不发请求', async () => {
    const { client, calls } = replay()
    await expect(lpPositions(client, AMM.owner, { mints: AMM.mints, pools: [ORCA.mints[0] as string] })).rejects.toThrow(/Not a Raydium AMM v4 \/ CPMM pool/)
    calls.length = 0
    expect(await lpPositions(client, AMM.owner, { protocols: [] })).toEqual([])
    expect(calls).toEqual([])
    await expect(lpPositions(client, AMM.owner, { protocols: ['toString' as never] })).rejects.toThrow(/Unknown LP protocol/)
  })

  it('tick 数组 PDA 上是别的账户 / 数据被截断：手续费为 null，不抛错', async () => {
    const RAYDIUM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'
    // tick 数组：Raydium 10240 字节，Orca 固定大小 9988 字节（池子账户都更小）
    const big = (owner: string) => new Set(Object.keys(fixture.accounts).filter((a) => fixture.accounts[a]?.owner === owner && base64.decode(fixture.accounts[a]?.data ?? '').length > 5000))
    const raydiumArrays = big(RAYDIUM_PROGRAM)
    // Raydium：只剩 10 字节（如被转过 SOL 的系统账户）
    const short = replay({ edit: (address, data) => (raydiumArrays.has(address) ? data.slice(0, 10) : data) })
    const [r] = (await lpPositions(short.client, RAYDIUM.owner, { mints: RAYDIUM.mints })) as [SolanaLpClmmPosition]
    expect(r).toMatchObject({ amount0: RAYDIUM.expected.amount0, fees0: null, fees1: null })
    // Raydium：长度够，但不是 TickArrayState（判别符不对）
    const foreign = replay({
      edit: (address, data) => {
        if (!raydiumArrays.has(address)) return data
        const copy = data.slice()
        copy.fill(0, 0, 8)
        return copy
      },
    })
    const [f] = (await lpPositions(foreign.client, RAYDIUM.owner, { mints: RAYDIUM.mints })) as [SolanaLpClmmPosition]
    expect(f).toMatchObject({ amount0: RAYDIUM.expected.amount0, fees0: null, fees1: null })

    // Orca 可变大小的数组在中间被截断
    const orcaArrays = big(ORCA_PROGRAM)
    const discriminator = (name: string) => sha256(new TextEncoder().encode(`account:${name}`)).subarray(0, 8)
    const truncated = replay({
      edit: (address, data) => (orcaArrays.has(address) ? new Uint8Array([...discriminator('DynamicTickArray'), ...data.subarray(8, 12), ...data.subarray(9956, 9988), ...new Uint8Array(16), 1, 0]) : data),
    })
    const [o] = (await lpPositions(truncated.client, ORCA.owner, { mints: ORCA.mints })) as [SolanaLpClmmPosition]
    expect(o).toMatchObject({ amount0: ORCA.expected.amount0, fees0: null, fees1: null })
  })

  it('限频、超时等节点故障原样抛出（不误报成“节点不支持”）', async () => {
    const { RpcError } = await import('../src/rpc.js')
    const node = createMockNode({ accounts: accounts(), errors: { getTokenAccountsByOwner: { code: 429, message: 'Too many requests for a specific RPC call' } } })
    const client = new SolanaClient(node, { cluster: 'mainnet' })
    const err = await lpPositions(client, ORCA.owner).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RpcError)
    expect((err as Error).message).not.toMatch(/`mints`/)
    // QuickNode 的限频报错带 “upgrade”，也不能当成“不支持”
    const quicknode = createMockNode({
      accounts: accounts(),
      errors: { getTokenAccountsByOwner: { code: -32007, message: '15/second request limit reached - reduce calls per second or upgrade your account at quicknode.com' } },
    })
    const qErr = await lpPositions(new SolanaClient(quicknode, { cluster: 'mainnet' }), ORCA.owner).catch((e: unknown) => e)
    expect(qErr).toBeInstanceOf(RpcError)
  })

  it('getLpPositions 的 fetch 同时用于节点请求和查价', async () => {
    const { transport } = replay()
    const urls: string[] = []
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      urls.push(url)
      if (url.startsWith('https://coins.llama.fi/')) {
        return new Response(JSON.stringify({ coins: { 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { price: 1 }, 'solana:So11111111111111111111111111111111111111112': { price: 100 } } }))
      }
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[]
      const one = async (r: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: '2.0', id: r.id, result: await transport.request(r.method, r.params) })
      const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body)
      return new Response(JSON.stringify(out, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)))
    }) as typeof fetch
    const [p] = await getLpPositions(CPMM.owner, { provider: 'https://rpc.example', cluster: 'mainnet', fetch: fetchFn, mints: CPMM.mints, prices: true })
    expect(numbers(p as SolanaLpPosition)).toEqual(CPMM.expected)
    expect(p?.valueUsd).toBeGreaterThan(0)
    expect(urls.some((u) => u.startsWith('https://rpc.example'))).toBe(true)
    expect(urls.some((u) => u.startsWith('https://coins.llama.fi/'))).toBe(true)
  })

  it('扫描失败时提示改用 mints', async () => {
    const node = createMockNode({ accounts: accounts(), errors: { getTokenAccountsByOwner: { code: -32602, message: 'Request blocked' } } })
    const client = new SolanaClient(node, { cluster: 'mainnet' })
    await expect(lpPositions(client, ORCA.owner)).rejects.toThrow(/getTokenAccountsByOwner.*`mints`/)
  })

  it('参数校验', async () => {
    const { client } = replay()
    await expect(lpPositions(client, 'not-an-address')).rejects.toThrow(/Invalid owner/)
    await expect(lpPositions(client, ORCA.owner, { mints: ['bad'] })).rejects.toThrow(/Invalid address/)
  })
})

