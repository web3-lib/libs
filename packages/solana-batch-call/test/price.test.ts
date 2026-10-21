/** 价格源的组合、tokenPrices / portfolio 的结果、链上价格的池子推导和选择（模拟节点，不连网络） */
import { beforeEach, describe, expect, it } from 'vitest'

import { NATIVE_MINT, SYSTEM_PROGRAM_ID, SolanaClient, TOKEN_PROGRAM_ID, decodeAddress, findProgramAddress, getAssociatedTokenAddress } from '../src/index.js'
import { resetTokenMetaCache } from '../src/client.js'
import { resetClientCache } from '../src/shortcuts.js'
import { combinePrices, defillamaPrices, getPortfolio, getTokenPrices, onchainPrices, portfolio, tokenPrices, type SolanaPriceSource } from '../src/subpaths/price.js'
import { keypair } from './fakeSolana.js'
import { createMockNode, mintData, tokenAccountData, type MockAccount } from './mock.js'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const X = keypair(11).address
const Y = keypair(12).address
const Z = keypair(13).address
const OWNER = keypair(14).address

const CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'
const CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'
const ORCA = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
const ORCA_CONFIG = '2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ'

beforeEach(() => {
  resetTokenMetaCache()
  resetClientCache()
})

const fixed = (name: string, prices: Record<string, number>, seen: string[][] = []): SolanaPriceSource => ({
  name,
  async prices(ctx) {
    seen.push([...ctx.mints])
    return new Map(Object.entries(prices).filter(([k]) => ctx.mints.includes(k)))
  },
})

describe('价格源', () => {
  it('前面的源没有的价格交给后面的源，记下来源；出错的源跳过；原生 SOL 按 So111…112 查', async () => {
    const seen: string[][] = []
    const broken: SolanaPriceSource = { name: 'broken', prices: async () => Promise.reject(new Error('down')) }
    const errors: string[] = []
    const client = new SolanaClient(createMockNode(), { cluster: 'mainnet' })
    const list = await tokenPrices(client, [NATIVE_MINT, USDC, X, SYSTEM_PROGRAM_ID, 'not-an-address'], {
      sources: [broken, fixed('a', { [USDC]: 1 }, seen), fixed('b', { [NATIVE_MINT]: 150, [X]: 2, [USDC]: 9 }, seen)],
      onError: (s) => errors.push(s.name),
    })
    expect(errors).toEqual(['broken'])
    expect(list.map((p) => [p.token, p.native, p.price, p.source])).toEqual([
      [NATIVE_MINT, true, 150, 'b'],
      [USDC, false, 1, 'a'],
      [X, false, 2, 'b'],
      [SYSTEM_PROGRAM_ID, true, 150, 'b'],
      ['not-an-address', false, null, null],
    ])
    // 原生 SOL 只查一次；第二个源只查第一个源没有的；非法地址不查
    expect(seen).toEqual([
      [NATIVE_MINT, USDC, X],
      [NATIVE_MINT, X],
    ])
  })

  it('combinePrices 组合成一个价格源；取消查询时不跳过出错的源', async () => {
    const source = combinePrices([fixed('a', { [USDC]: 1 }), fixed('b', { [X]: 3 })])
    expect(source.name).toBe('a+b')
    expect([...(await source.prices({ mints: [USDC, X, Y], fetch }))]).toEqual([
      [USDC, 1],
      [X, 3],
    ])
    const controller = new AbortController()
    controller.abort()
    const aborting: SolanaPriceSource = { name: 'abort', prices: async () => Promise.reject(new Error('aborted')) }
    await expect(combinePrices([aborting, fixed('b', { [X]: 3 })]).prices({ mints: [X], fetch, signal: controller.signal })).rejects.toThrow('aborted')
  })

  it('DefiLlama：当前和历史价格的地址、置信度', async () => {
    const urls: string[] = []
    const fakeFetch = (async (url: string) => {
      urls.push(url)
      const all: Record<string, { price: number; confidence: number }> = { [`solana:${NATIVE_MINT}`]: { price: 150, confidence: 0.99 }, [`solana:${X}`]: { price: 2, confidence: 0.5 } }
      const asked = (url.split('/').pop() ?? '').split(',')
      return new Response(JSON.stringify({ coins: Object.fromEntries(Object.entries(all).filter(([k]) => asked.includes(k))) }))
    }) as typeof fetch
    const now = await defillamaPrices().prices({ mints: [NATIVE_MINT, X], fetch: fakeFetch })
    expect([...now]).toEqual([[NATIVE_MINT, 150]]) // 置信度 0.5 的不要
    const at = defillamaPrices({ at: new Date('2026-01-01T00:00:00Z'), minConfidence: 0 })
    expect(at.name).toBe('defillama@1767225600')
    expect([...(await at.prices({ mints: [X], fetch: fakeFetch }))]).toEqual([[X, 2]])
    expect(defillamaPrices({ at: 1767225600.7 }).name).toBe('defillama@1767225600')
    expect(urls).toEqual([`https://coins.llama.fi/prices/current/solana:${NATIVE_MINT},solana:${X}`, `https://coins.llama.fi/prices/historical/1767225600/solana:${X}`])
  })
})

// ---------------------------------------------------------------------------
// 链上价格：在 PDA 上放池子账户
// ---------------------------------------------------------------------------

const utf8 = (s: string) => new TextEncoder().encode(s)
const sorted = (a: string, b: string): [string, string] => {
  const x = decodeAddress(a)
  const y = decodeAddress(b)
  const i = x.findIndex((v, k) => v !== y[k])
  return (x[i] as number) < (y[i] as number) ? [a, b] : [b, a]
}
const ammConfig = (program: string, index: number) => findProgramAddress([utf8('amm_config'), new Uint8Array([index >> 8, index & 0xff])], program)

class Data {
  readonly bytes: Uint8Array
  readonly view: DataView
  constructor(size: number) {
    this.bytes = new Uint8Array(size)
    this.view = new DataView(this.bytes.buffer)
  }
  key(o: number, address: string) {
    this.bytes.set(decodeAddress(address), o)
    return this
  }
  u8(o: number, v: number) {
    this.bytes[o] = v
    return this
  }
  u64(o: number, v: bigint) {
    this.view.setBigUint64(o, v, true)
    return this
  }
  u128(o: number, v: bigint) {
    return this.u64(o, v & ((1n << 64n) - 1n)).u64(o + 8, v >> 64n)
  }
}

const DECIMALS: Record<string, number> = { [NATIVE_MINT]: 9, [USDC]: 6, [USDT]: 6, [X]: 6, [Y]: 9, [Z]: 6 }

/** price = mint1 / mint0（按精度换算）→ sqrt_price（Q64） */
function sqrtX64(mint0: string, mint1: string, price: number): bigint {
  const raw = price * 10 ** ((DECIMALS[mint1] as number) - (DECIMALS[mint0] as number))
  return BigInt(Math.round(Math.sqrt(raw) * 2 ** 64))
}

interface PoolSpec {
  /** 1 个 a 值多少个 b */
  price: number
  /** 两个金库的余额（最小单位） */
  balances: Record<string, bigint>
  liquidity?: bigint
}

function addVaults(accounts: Record<string, MockAccount>, pool: string, mints: [string, string], balances: Record<string, bigint>): [string, string] {
  return mints.map((m) => {
    const vault = findProgramAddress([utf8('vault'), decodeAddress(pool), decodeAddress(m)], CLMM)
    accounts[vault] = { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(m, pool, balances[m] ?? 0n) }
    return vault
  }) as [string, string]
}

function clmmPool(accounts: Record<string, MockAccount>, protocol: 'raydium' | 'orca', a: string, b: string, index: number, spec: PoolSpec) {
  const [m0, m1] = sorted(a, b)
  const address =
    protocol === 'raydium'
      ? findProgramAddress([utf8('pool'), decodeAddress(ammConfig(CLMM, index)), decodeAddress(m0), decodeAddress(m1)], CLMM)
      : findProgramAddress([utf8('whirlpool'), decodeAddress(ORCA_CONFIG), decodeAddress(m0), decodeAddress(m1), new Uint8Array([index & 0xff, index >> 8])], ORCA)
  const [v0, v1] = addVaults(accounts, address, [m0, m1], spec.balances)
  const sqrt = sqrtX64(m0, m1, m0 === a ? spec.price : 1 / spec.price)
  const liquidity = spec.liquidity ?? 1n << 100n
  const d =
    protocol === 'raydium'
      ? new Data(1544).key(73, m0).key(105, m1).key(137, v0).key(169, v1).u128(237, liquidity).u128(253, sqrt)
      : new Data(653).u128(49, liquidity).u128(65, sqrt).key(101, m0).key(133, v0).key(181, m1).key(213, v1)
  accounts[address] = { owner: protocol === 'raydium' ? CLMM : ORCA, data: d.bytes }
  return address
}

/** fees：不属于储备的协议手续费（最小单位） */
function cpmmPool(accounts: Record<string, MockAccount>, a: string, b: string, index: number, balances: Record<string, bigint>, fees: Record<string, bigint> = {}) {
  const [m0, m1] = sorted(a, b)
  const address = findProgramAddress([utf8('pool'), decodeAddress(ammConfig(CPMM, index)), decodeAddress(m0), decodeAddress(m1)], CPMM)
  const [v0, v1] = addVaults(accounts, address, [m0, m1], balances)
  // PoolState：vault 72 / 104、lp_mint 136、mint 168 / 200、decimals 331 / 332、lp_supply 333、protocol_fees_token_0 / 1 341 / 349
  const d = new Data(637)
    .key(72, v0)
    .key(104, v1)
    .key(136, keypair(99).address)
    .key(168, m0)
    .key(200, m1)
    .u8(331, DECIMALS[m0] as number)
    .u8(332, DECIMALS[m1] as number)
    .u64(333, 1000n)
    .u64(341, fees[m0] ?? 0n)
    .u64(349, fees[m1] ?? 0n)
  accounts[address] = { owner: CPMM, data: d.bytes }
  return address
}

function market() {
  const accounts: Record<string, MockAccount> = {}
  for (const [mint, decimals] of Object.entries(DECIMALS)) accounts[mint] = { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals }) }
  // SOL / USDC：Raydium CLMM 150（深）；Orca 100 但活跃流动性为 0（金库再深也不用）；USDT 池子 149 但比 USDC 的浅
  clmmPool(accounts, 'raydium', NATIVE_MINT, USDC, 4, { price: 150, balances: { [USDC]: 1_000_000_000_000n, [NATIVE_MINT]: 1_000n * 10n ** 9n } })
  clmmPool(accounts, 'orca', NATIVE_MINT, USDC, 64, { price: 100, balances: { [USDC]: 50_000_000_000_000n }, liquidity: 0n })
  clmmPool(accounts, 'orca', NATIVE_MINT, USDT, 4, { price: 149, balances: { [USDT]: 20_000_000_000n } })
  // X：Orca 对 SOL 0.01 SOL（= 1.5 美元，深 1000 SOL）；Raydium 对 USDC 2 美元，但只有 5000 美元（低于 10000，不用）
  clmmPool(accounts, 'orca', X, NATIVE_MINT, 1025, { price: 0.01, balances: { [NATIVE_MINT]: 1_000n * 10n ** 9n } })
  clmmPool(accounts, 'raydium', X, USDC, 0, { price: 2, balances: { [USDC]: 5_000_000_000n } })
  // Y：CPMM 对 USDC，金库 1,000,000 Y、50,000 USDC（Y 一侧有 1000 Y 的协议手续费不算储备）
  cpmmPool(accounts, Y, USDC, 0, { [Y]: 1_001_000n * 10n ** 9n, [USDC]: 50_000_000_000n }, { [Y]: 1_000n * 10n ** 9n })
  return accounts
}

describe('onchainPrices', () => {
  it('按 PDA 找池子，用计价币一侧最深的池子；SOL 先对稳定币定价；不用 getProgramAccounts', async () => {
    const node = createMockNode({ accounts: market() })
    const client = new SolanaClient(node, { cluster: 'mainnet' })
    const result = await onchainPrices().prices({ mints: [NATIVE_MINT, USDC, X, Y, Z], client, fetch })
    expect(result.get(NATIVE_MINT)).toBeCloseTo(150, 6)
    expect(result.get(USDC)).toBe(1)
    expect(result.get(X)).toBeCloseTo(1.5, 6)
    expect(result.get(Y)).toBeCloseTo(0.05, 9)
    expect(result.has(Z)).toBe(false)
    // 两轮读取：候选池子 128 + 3 × 192 个和 6 个 mint，按 100 个一组 8 次；金库 1 次
    expect(node.calls.filter((c) => c.method !== 'getGenesisHash').map((c) => c.method)).toEqual(Array(9).fill('getMultipleAccounts'))
  })

  it('流动性下限、只用部分协议、稳定币', async () => {
    const client = new SolanaClient(createMockNode({ accounts: market() }), { cluster: 'mainnet' })
    // 下限提高到 20 万美元：X 的 SOL 池子（15 万美元）也不够
    const strict = await onchainPrices({ minLiquidityUsd: 200_000 }).prices({ mints: [X], client, fetch })
    expect(strict.has(X)).toBe(false)
    // 只用 Raydium CLMM：X 只剩 5000 美元的池子；下限 1000 时用它
    const ray = await onchainPrices({ protocols: ['raydium-clmm'], minLiquidityUsd: 1000 }).prices({ mints: [X, Y], client, fetch })
    expect(ray.get(X)).toBeCloseTo(2, 6)
    expect(ray.has(Y)).toBe(false)
    // 只认 USDT：SOL 用 USDT 池子
    const usdt = await onchainPrices({ stablecoins: [USDT] }).prices({ mints: [NATIVE_MINT, USDT], client, fetch })
    expect(usdt.get(NATIVE_MINT)).toBeCloseTo(149, 6)
    expect(usdt.get(USDT)).toBe(1)
    await expect(onchainPrices().prices({ mints: [X], fetch })).rejects.toThrow('needs a SolanaClient')
  })

  it('tokenPrices 默认 DefiLlama 没有的再从链上算；getTokenPrices 节点参数同其他快捷函数', async () => {
    const node = createMockNode({ accounts: market() })
    const llama = (async () => new Response(JSON.stringify({ coins: { [`solana:${NATIVE_MINT}`]: { price: 151, confidence: 0.99 } } }))) as typeof fetch
    const list = await getTokenPrices([NATIVE_MINT, X, Z], { provider: node, cluster: 'mainnet', fetch: llama })
    expect(list.map((p) => [p.price === null ? null : Number(p.price.toFixed(6)), p.source])).toEqual([
      [151, 'defillama'],
      [1.5, 'onchain'],
      [null, null],
    ])
  })
})

// ---------------------------------------------------------------------------
// portfolio
// ---------------------------------------------------------------------------

function wallet() {
  const accounts = market()
  accounts[OWNER] = { owner: SYSTEM_PROGRAM_ID, lamports: 2n * 10n ** 9n }
  accounts[getAssociatedTokenAddress(OWNER, USDC, TOKEN_PROGRAM_ID)] = { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(USDC, OWNER, 10_000_000n) }
  accounts[getAssociatedTokenAddress(OWNER, X, TOKEN_PROGRAM_ID)] = { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(X, OWNER, 100_000_000n) }
  accounts[getAssociatedTokenAddress(OWNER, Z, TOKEN_PROGRAM_ID)] = { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(Z, OWNER, 5_000_000n) }
  return accounts
}

describe('portfolio', () => {
  const sources = [fixed('test', { [NATIVE_MINT]: 100, [USDC]: 1, [X]: 0.5 })]

  it('指定代币：余额 × 价格，按价值排序；余额为 0 的不列出', async () => {
    const client = new SolanaClient(createMockNode({ accounts: wallet() }), { cluster: 'mainnet' })
    const p = await portfolio(client, OWNER, { tokens: [NATIVE_MINT, USDC, X, Y, Z], sources })
    expect(p.tokens.map((t) => [t.token, t.native, t.formatted, t.value, t.priceSource])).toEqual([
      [NATIVE_MINT, true, '2', 200, 'test'],
      [X, false, '100', 50, 'test'],
      [USDC, false, '10', 10, 'test'],
      [Z, false, '5', null, null],
    ])
    expect(p).toMatchObject({ totalUsd: 260, tokensUsd: 260, lpUsd: 0, lp: [], unpriced: 1 })
    const filtered = await portfolio(client, OWNER, { tokens: [NATIVE_MINT, USDC, X, Z], sources, minUsd: 20 })
    expect(filtered.tokens.map((t) => t.token)).toEqual([NATIVE_MINT, X])
    expect(filtered.totalUsd).toBe(260) // 不影响合计
  })

  it('不传 tokens：列出全部持仓（需要 getTokenAccountsByOwner），节点不支持时提示传 tokens', async () => {
    const p = await getPortfolio(OWNER, { provider: createMockNode({ accounts: wallet() }), cluster: 'mainnet', sources })
    expect(p.tokens.map((t) => t.token).sort()).toEqual([NATIVE_MINT, USDC, X, Z].sort())
    expect(p.totalUsd).toBe(260)
    const unsupported = createMockNode({ accounts: wallet(), errors: { getTokenAccountsByOwner: { code: -32601, message: 'Method not found' } } })
    await expect(getPortfolio(OWNER, { provider: unsupported, cluster: 'mainnet', sources })).rejects.toThrow('pass the mints in `tokens`')
  })

  it('价格源出错：照样返回余额，onPriceError 收到错误', async () => {
    const client = new SolanaClient(createMockNode({ accounts: wallet() }), { cluster: 'mainnet' })
    const errors: unknown[] = []
    const p = await portfolio(client, OWNER, { tokens: [USDC], sources: [{ name: 'down', prices: async () => Promise.reject(new Error('HTTP 503')) }], onPriceError: (e) => errors.push(e) })
    expect(p.tokens).toMatchObject([{ token: USDC, value: null }])
    expect(String(errors[0])).toContain('HTTP 503')
  })
})
