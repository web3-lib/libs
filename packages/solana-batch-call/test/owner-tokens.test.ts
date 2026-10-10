import { beforeEach, describe, expect, it } from 'vitest'

import {
  METADATA_PROGRAM_ID,
  NATIVE_MINT,
  SYSTEM_PROGRAM_ID,
  SolanaClient,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getMetadataAddress,
  getOwnerTokens,
} from '../src/index.js'
import { resetTokenMetaCache } from '../src/client.js'
import { resetClientCache } from '../src/shortcuts.js'
import { createMockNode, metaplexData, mintData, tokenAccountData, type MockAccount } from './mock.js'

const OWNER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
const BARE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' // 没有元数据
const EMPTY = 'BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG' // 余额为 0 的代币
const NFT = '8Jornc27vtAYPkwDzsZVgLQchAYyC8nD7aCNPCDV8Qk2'
const EXTRA_USDC_ACCOUNT = '7KJjY7rArbydeLBF7gQ5LdqXRKRYyPArT99NEctsHsgU'

function world(): Record<string, MockAccount> {
  const ata = (mint: string, program = TOKEN_PROGRAM_ID) => getAssociatedTokenAddress(OWNER, mint, program)
  return {
    [OWNER]: { lamports: 1_500_000_000n, owner: SYSTEM_PROGRAM_ID },
    [USDC]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) },
    [getMetadataAddress(USDC)]: { owner: METADATA_PROGRAM_ID, data: metaplexData({ mint: USDC, name: 'USD Coin', symbol: 'USDC' }) },
    [ata(USDC)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(USDC, OWNER, 1_234_500_000n) },
    [EXTRA_USDC_ACCOUNT]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(USDC, OWNER, 500_000n) },
    [PYUSD]: { owner: TOKEN_2022_PROGRAM_ID, data: mintData({ decimals: 6, metadata: { name: 'PayPal USD', symbol: 'PYUSD', uri: '' } }) },
    [ata(PYUSD, TOKEN_2022_PROGRAM_ID)]: { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccountData(PYUSD, OWNER, 2_000_000n) },
    [BARE]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 2 }) },
    [ata(BARE)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(BARE, OWNER, 150n) },
    [EMPTY]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) },
    [ata(EMPTY)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(EMPTY, OWNER, 0n) },
    [NFT]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 0, supply: 1n }) },
    [ata(NFT)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(NFT, OWNER, 1n) },
  }
}

beforeEach(() => {
  resetTokenMetaCache()
  resetClientCache()
})

describe('ownerTokens / getOwnerTokens', () => {
  it('默认：SOL 在第一位，带 name / symbol；不含 NFT 和余额为 0 的代币；多个账户合计', async () => {
    const sol = new SolanaClient(createMockNode({ accounts: world() }))
    const list = await sol.ownerTokens(OWNER)
    expect(list.map((t) => [t.symbol, t.name, t.formatted, t.accounts])).toEqual([
      ['SOL', 'Solana', '1.5', 1],
      ['USDC', 'USD Coin', '1235', 2], // ATA 1234.5 + 非 ATA 账户 0.5
      [null, null, '1.5', 1], // 没有元数据
      ['PYUSD', 'PayPal USD', '2', 1], // Token-2022 排在 SPL Token 之后；元数据来自扩展
    ])
    expect(list[0]).toMatchObject({ token: NATIVE_MINT, native: true, tokenProgram: null })
    expect(list[3]?.tokenProgram).toBe(TOKEN_2022_PROGRAM_ID)
    expect(JSON.parse(JSON.stringify(list))).toEqual(list)
  })

  it('includeNfts / includeZero / includeNative', async () => {
    const sol = new SolanaClient(createMockNode({ accounts: world() }))
    const all = await sol.ownerTokens(OWNER, { includeNfts: true, includeZero: true, includeNative: false })
    expect(all.map((t) => t.token).sort()).toEqual([USDC, PYUSD, BARE, EMPTY, NFT].sort())
    expect(all.find((t) => t.token === EMPTY)?.balance).toBe('0')
  })

  it('metadata: false 时不读元数据，也不返回 name / symbol 字段', async () => {
    const node = createMockNode({ accounts: world() })
    const list = await new SolanaClient(node).ownerTokens(OWNER, { metadata: false })
    expect(list.every((t) => !('name' in t) && !('symbol' in t))).toBe(true)
    expect(node.calls.some((c) => c.method === 'getMultipleAccounts')).toBe(false)
  })

  it('元数据缓存：第二次只扫描持仓，不再读元数据', async () => {
    const node = createMockNode({ accounts: world() })
    const sol = new SolanaClient(node, { cluster: 'mainnet' })
    await sol.ownerTokens(OWNER)
    const before = node.calls.filter((c) => c.method === 'getMultipleAccounts').length
    await sol.ownerTokens(OWNER)
    expect(node.calls.filter((c) => c.method === 'getMultipleAccounts').length).toBe(before)
  })

  it('Wrapped SOL 单独列出（native: false），不会并进 SOL 也不会丢失', async () => {
    const accounts = world()
    accounts[NATIVE_MINT] = { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 9 }) }
    accounts[getAssociatedTokenAddress(OWNER, NATIVE_MINT, TOKEN_PROGRAM_ID)] = { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(NATIVE_MINT, OWNER, 10_000_000_000n) }
    const list = await new SolanaClient(createMockNode({ accounts })).ownerTokens(OWNER)
    const entries = list.filter((t) => t.token === NATIVE_MINT)
    expect(entries.map((t) => [t.native, t.formatted])).toEqual([
      [true, '1.5'],
      [false, '10'],
    ])
    // balances 扫描时仍只有一项 SOL
    const balances = await new SolanaClient(createMockNode({ accounts })).balances(OWNER)
    expect(balances.filter((t) => t.token === NATIVE_MINT)).toHaveLength(1)
  })

  it('getOwnerTokens 透传选项；节点不支持索引方法时报错；owner 非法时报错', async () => {
    const node = createMockNode({ accounts: world() })
    const list = await getOwnerTokens(OWNER, { provider: node, includeNative: false, metadata: false })
    expect(list[0]?.token).not.toBe(NATIVE_MINT)
    const limited = createMockNode({ accounts: world(), errors: { getTokenAccountsByOwner: { code: -32602, message: 'Indexed requests require a personal token' } } })
    await expect(getOwnerTokens(OWNER, { provider: limited })).rejects.toThrow(/personal token/)
    await expect(getOwnerTokens('bad', { provider: node })).rejects.toThrow(/Invalid owner/)
  })

  it("tokenPrograms：只传 'spl' 时不含 Token-2022 代币", async () => {
    const node = createMockNode({ accounts: world() })
    const list = await getOwnerTokens(OWNER, { provider: node, tokenPrograms: ['spl'] })
    expect(list.map((t) => t.symbol)).toEqual(['SOL', 'USDC', null])
    expect(list.every((t) => t.tokenProgram !== TOKEN_2022_PROGRAM_ID)).toBe(true)
    expect(node.calls.filter((c) => c.method === 'getTokenAccountsByOwner')).toHaveLength(1)
  })

  it('元数据读取被限频时余额列表照常返回（name / symbol 为 null，且不缓存）', async () => {
    const node = createMockNode({ accounts: world(), errors: { getMultipleAccounts: { code: 429, message: 'Too many requests' } } })
    const sol = new SolanaClient(node, { cluster: 'mainnet' })
    const list = await sol.ownerTokens(OWNER)
    expect(list.map((t) => t.formatted)).toEqual(['1.5', '1235', '1.5', '2'])
    expect(list.slice(1).every((t) => t.symbol === null)).toBe(true)
    // 恢复后重新读取（失败的结果没有被当成“没有元数据”缓存）
    const healthy = createMockNode({ accounts: world() })
    const again = await new SolanaClient(healthy, { cluster: 'mainnet' }).ownerTokens(OWNER)
    expect(again[1]?.symbol).toBe('USDC')
  })

  it('元数据状态：ok / missing（确认没有）/ failed（节点问题）', async () => {
    const ok = await new SolanaClient(createMockNode({ accounts: world() })).ownerTokens(OWNER)
    expect(ok.map((t) => t.metadataStatus)).toEqual(['ok', 'ok', 'missing', 'ok'])
    const limited = createMockNode({ accounts: world(), errors: { getMultipleAccounts: { code: 429, message: 'Too many requests' } } })
    const degraded = await new SolanaClient(limited).ownerTokens(OWNER)
    expect(degraded.map((t) => t.metadataStatus)).toEqual(['ok', 'failed', 'failed', 'failed'])
  })
})

describe('大批量读取', () => {
  function manyTokens(count: number) {
    const accounts = world()
    let next = USDC
    for (let i = 0; i < count; i++) {
      next = getMetadataAddress(next) // 链式推导出不同的地址当作 mint
      accounts[next] = { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 1 }) }
      accounts[getAssociatedTokenAddress(OWNER, next, TOKEN_PROGRAM_ID)] = { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(next, OWNER, 10n) }
    }
    return accounts
  }

  /** 给 getMultipleAccounts 加延迟并统计同时进行中的请求数 */
  function instrumented(node: ReturnType<typeof createMockNode>) {
    const stats = { active: 0, peak: 0, calls: 0 }
    return {
      stats,
      async request<T>(method: string, params?: readonly unknown[]): Promise<T> {
        if (method !== 'getMultipleAccounts') return node.request<T>(method, params)
        stats.calls++
        stats.active++
        stats.peak = Math.max(stats.peak, stats.active)
        try {
          await new Promise((r) => setTimeout(r, 5))
          return await node.request<T>(method, params)
        } finally {
          stats.active--
        }
      },
    }
  }

  it('getMultipleAccounts 最多同时 3 个请求，每个最多 100 个地址', async () => {
    const node = createMockNode({ accounts: manyTokens(400) })
    const transport = instrumented(node)
    const list = await new SolanaClient(transport).ownerTokens(OWNER)
    expect(list.length).toBe(4 + 400) // 原有的 SOL + 3 个代币，加 400 个
    expect(transport.stats.peak).toBeLessThanOrEqual(3)
    const sizes = node.calls.filter((c) => c.method === 'getMultipleAccounts').map((c) => (c.params[0] as string[]).length)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100)
  })

  it('tokens / nfts 等其他批量读取同样限制并发', async () => {
    const accounts = manyTokens(400)
    const mints = Object.keys(accounts).filter((a) => accounts[a]?.data?.length === 82)
    const transport = instrumented(createMockNode({ accounts }))
    await new SolanaClient(transport).tokens(mints)
    expect(transport.stats.peak).toBeLessThanOrEqual(3)
  })

  it('遇到限频后不再发后面的请求', async () => {
    const node = createMockNode({ accounts: manyTokens(400), errors: { getMultipleAccounts: { code: 429, message: 'Too many requests' } } })
    await new SolanaClient(node).ownerTokens(OWNER)
    // 第一轮 3 个请求全部失败后就停止（不会把 8 个请求都发完）
    expect(node.calls.filter((c) => c.method === 'getMultipleAccounts').length).toBeLessThanOrEqual(3)
  })
})

describe('容错的边界', () => {
  it('balances(scan) 补 decimals 时遇到节点问题照常报错，不会把代币报成 mint 不存在', async () => {
    const node = createMockNode({ accounts: world(), errors: { getMultipleAccounts: { code: 429, message: 'Too many requests' } } })
    const UNHELD = '3MU8CwCqv82fAvufNDY3vwvfCGqSUMbq7Qexr4hofXG1'
    await expect(new SolanaClient(node).balances(OWNER, [USDC, UNHELD], { scan: true })).rejects.toThrow(/Too many/)
  })

  it('程序错误（如节点返回无法解码的账户数据）不会被当成节点问题吞掉', async () => {
    const node = createMockNode({ accounts: world() })
    const broken = {
      async request<T>(method: string, params?: readonly unknown[]): Promise<T> {
        if (method === 'getMultipleAccounts') {
          return { value: (params![0] as string[]).map(() => ({ lamports: 1, owner: TOKEN_PROGRAM_ID, data: ['%%not-base64%%', 'base64'], executable: false })) } as T
        }
        return node.request<T>(method, params)
      },
    }
    await expect(new SolanaClient(broken).ownerTokens(OWNER)).rejects.toThrow()
  })

  it('NFT 判断：按 mint 汇总后精度 0、数量 1；ownerTokens 与 ownerNfts 一致', async () => {
    const accounts = world()
    const EDITION = '3MU8CwCqv82fAvufNDY3vwvfCGqSUMbq7Qexr4hofXG1'
    accounts[EDITION] = { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 0, supply: 10n }) }
    accounts[getAssociatedTokenAddress(OWNER, EDITION, TOKEN_PROGRAM_ID)] = { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(EDITION, OWNER, 1n) }
    accounts['FzbcyEZ9m8xjtergWgWDq7mfPoHEbboBF791B6cTpzbq'] = { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(EDITION, OWNER, 1n) } // 第二个账户
    // 两个都有 Metaplex 元数据，否则 ownerNfts 会因为读不到元数据把它们过滤掉，测不出判断规则
    accounts[getMetadataAddress(EDITION)] = { owner: METADATA_PROGRAM_ID, data: metaplexData({ mint: EDITION, name: 'Edition', symbol: 'ED' }) }
    accounts[getMetadataAddress(NFT)] = { owner: METADATA_PROGRAM_ID, data: metaplexData({ mint: NFT, name: 'NFT #1', symbol: 'NFT' }) }
    const sol = new SolanaClient(createMockNode({ accounts }))
    const tokens = await sol.ownerTokens(OWNER, { metadata: false })
    expect(tokens.find((t) => t.token === EDITION)?.balance).toBe('2') // 合计 2，不是 NFT
    expect(tokens.some((t) => t.token === NFT)).toBe(false) // 合计 1，是 NFT
    const nfts = await sol.ownerNfts(OWNER)
    expect(nfts.map((n) => n.mint)).toEqual([NFT])
  })
})
