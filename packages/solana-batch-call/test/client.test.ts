import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest'

import {
  METADATA_PROGRAM_ID,
  NATIVE_MINT,
  SYSTEM_PROGRAM_ID,
  SolanaClient,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getBalances,
  getMetadataAddress,
  getNftOwners,
  getNfts,
  getOwnerNfts,
  getSolBalances,
  getTokens,
} from '../src/index.js'
import { resetTokenMetaCache } from '../src/client.js'
import { resetClientCache, resolveClientForTest } from '../src/shortcuts.js'
import { createMockNode, metaplexData, mintData, tokenAccountData, type MockAccount } from './mock.js'

// 地址都取真实格式的公钥（内容无关紧要）
const OWNER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // SPL Token，Metaplex 元数据
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' // Token-2022，TokenMetadata 扩展
const NFT = 'BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG'
const COLLECTION = '8Jornc27vtAYPkwDzsZVgLQchAYyC8nD7aCNPCDV8Qk2'
const MISSING = '3MU8CwCqv82fAvufNDY3vwvfCGqSUMbq7Qexr4hofXG1' // 不存在的账户
const EXTRA_USDC_ACCOUNT = '7KJjY7rArbydeLBF7gQ5LdqXRKRYyPArT99NEctsHsgU' // OWNER 的非 ATA USDC 账户

function world(): Record<string, MockAccount> {
  return {
    [OWNER]: { lamports: 1_500_000_000n, owner: SYSTEM_PROGRAM_ID },
    [USDC]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6, supply: 10_000_000n, mintAuthority: OTHER }) },
    [getMetadataAddress(USDC)]: { owner: METADATA_PROGRAM_ID, data: metaplexData({ mint: USDC, name: 'USD Coin', symbol: 'USDC', uri: 'https://usdc' }) },
    [PYUSD]: { owner: TOKEN_2022_PROGRAM_ID, data: mintData({ decimals: 6, supply: 5_000_000n, metadata: { name: 'PayPal USD', symbol: 'PYUSD', uri: 'https://pyusd' } }) },
    [getAssociatedTokenAddress(OWNER, USDC, TOKEN_PROGRAM_ID)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(USDC, OWNER, 1_234_500_000n) },
    [getAssociatedTokenAddress(OWNER, PYUSD, TOKEN_2022_PROGRAM_ID)]: { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccountData(PYUSD, OWNER, 2_000_000n) },
    [EXTRA_USDC_ACCOUNT]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(USDC, OWNER, 500_000n) },
    // NFT：数量 1、精度 0，持有人 OTHER
    [NFT]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 0, supply: 1n }) },
    [getMetadataAddress(NFT)]: {
      owner: METADATA_PROGRAM_ID,
      data: metaplexData({
        mint: NFT,
        name: 'Mad Lad #1',
        symbol: 'MAD',
        uri: 'https://meta/1.json',
        sellerFeeBasisPoints: 420,
        isMutable: true,
        tokenStandard: 4,
        collection: { address: COLLECTION, verified: true },
        creators: [{ address: OWNER, verified: true, share: 100 }],
      }),
    },
    [getAssociatedTokenAddress(OTHER, NFT, TOKEN_PROGRAM_ID)]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(NFT, OTHER, 1n) },
  }
}

function setup() {
  const node = createMockNode({ accounts: world() })
  return { node, sol: new SolanaClient(node, { cluster: 'mainnet' }) }
}

const multipleAccountsCalls = (node: ReturnType<typeof createMockNode>) => node.calls.filter((c) => c.method === 'getMultipleAccounts')
const addressesRequested = (node: ReturnType<typeof createMockNode>) =>
  multipleAccountsCalls(node).reduce((n, c) => n + (c.params[0] as string[]).length, 0)

beforeEach(() => {
  resetTokenMetaCache()
  resetClientCache()
})

describe('accounts / solBalances', () => {
  it('按 100 个一组，去重，非法地址为 null 且不发请求', async () => {
    const { node, sol } = setup()
    const many = Array.from({ length: 150 }, () => OWNER)
    const res = await sol.accounts([...many, 'bad', MISSING])
    expect(res).toHaveLength(152)
    expect(res[0]?.lamports).toBe(1_500_000_000n)
    expect(res[150]).toBeNull()
    expect(res[151]).toBeNull()
    expect(addressesRequested(node)).toBe(2) // OWNER + MISSING
  })

  it('超过 100 个地址拆成多次 getMultipleAccounts', async () => {
    const { node, sol } = setup()
    // 链式推导 150 个不同的地址（每个都是上一个的 Metaplex 元数据 PDA）
    const distinct: string[] = [USDC]
    while (distinct.length < 150) distinct.push(getMetadataAddress(distinct[distinct.length - 1] as string))
    expect(new Set(distinct).size).toBe(150)
    const res = await sol.accounts(distinct)
    expect(res).toHaveLength(150)
    expect(multipleAccountsCalls(node).map((c) => (c.params[0] as string[]).length)).toEqual([100, 50])
  })

  it('getSolBalances：一次请求查多个地址，账户不存在为 0', async () => {
    const node = createMockNode({ accounts: world() })
    const res = await getSolBalances([OWNER, MISSING, 'bad'], { provider: node })
    expect(res).toEqual([
      { address: OWNER, balance: '1500000000', formatted: '1.5', success: true },
      { address: MISSING, balance: '0', formatted: '0', success: true },
      { address: 'bad', balance: '0', formatted: '0', success: false },
    ])
  })
})

describe('balances（指定 mint：ATA 模式）', () => {
  it('SOL + SPL Token + Token-2022 一次 getMultipleAccounts', async () => {
    const { node, sol } = setup()
    const res = await sol.balances(OWNER, [NATIVE_MINT, USDC, PYUSD])
    expect(res).toEqual([
      { token: NATIVE_MINT, native: true, balance: '1500000000', decimals: 9, formatted: '1.5', tokenProgram: null, success: true },
      { token: USDC, native: false, balance: '1234500000', decimals: 6, formatted: '1234.5', tokenProgram: TOKEN_PROGRAM_ID, success: true },
      { token: PYUSD, native: false, balance: '2000000', decimals: 6, formatted: '2', tokenProgram: TOKEN_2022_PROGRAM_ID, success: true },
    ])
    expect(multipleAccountsCalls(node)).toHaveLength(1)
    expect(node.calls.some((c) => c.method === 'getTokenAccountsByOwner')).toBe(false) // 免费节点也能用
  })

  it('decimals / 所属程序缓存后只查 1 个 ATA', async () => {
    const { node, sol } = setup()
    await sol.balances(OWNER, [USDC])
    const first = addressesRequested(node) // mint + 2 个 ATA
    await sol.balances(OWNER, [USDC])
    expect(first).toBe(3)
    expect(addressesRequested(node) - first).toBe(1)
  })

  it('symbol：SPL Token 取 Metaplex，Token-2022 取扩展，SOL 固定', async () => {
    const { sol } = setup()
    const res = await sol.balances(OWNER, [NATIVE_MINT, USDC, PYUSD], { symbol: true })
    expect(res.map((r) => r.symbol)).toEqual(['SOL', 'USDC', 'PYUSD'])
  })

  it('没有 ATA 的代币余额为 0；mint 不存在 / 地址非法 success 为 false', async () => {
    const { sol } = setup()
    const res = await sol.balances(OTHER, [USDC, MISSING, 'bad'])
    expect(res[0]).toMatchObject({ balance: '0', decimals: 6, success: true })
    expect(res[1]).toMatchObject({ success: false })
    expect(res[2]).toMatchObject({ success: false })
  })

  it('System Program 地址（11111…1）也按 SOL 处理；nativeMints 可配置', async () => {
    const { node } = setup()
    expect((await new SolanaClient(node).balances(OWNER, [SYSTEM_PROGRAM_ID]))[0]).toMatchObject({ native: true, formatted: '1.5' })
    const custom = new SolanaClient(node, { nativeMints: [] })
    expect((await custom.balances(OWNER, [NATIVE_MINT]))[0]?.native).toBe(false)
  })

  it('owner 非法时报错', async () => {
    const { sol } = setup()
    await expect(sol.balances('bad', [USDC])).rejects.toThrow(/Invalid owner/)
  })

  it('ATA 模式只统计 ATA，scan 模式统计全部代币账户', async () => {
    const { sol } = setup()
    expect((await sol.balances(OWNER, [USDC]))[0]?.balance).toBe('1234500000')
    expect((await sol.balances(OWNER, [USDC], { scan: true }))[0]?.balance).toBe('1235000000') // + 非 ATA 账户里的 0.5
  })
})

describe('balances（scan：全部持仓）', () => {
  it('不传 mints：返回 SOL + 所有余额大于 0 的代币（含 Token-2022）', async () => {
    const { sol } = setup()
    const res = await sol.balances(OWNER, undefined, { symbol: true })
    expect(res.map((r) => [r.token, r.formatted, r.symbol])).toEqual([
      [NATIVE_MINT, '1.5', 'SOL'],
      [USDC, '1235', 'USDC'],
      [PYUSD, '2', 'PYUSD'],
    ])
  })

  it('节点不支持 getTokenAccountsByOwner 时报错（免费公共节点）', async () => {
    const node = createMockNode({ accounts: world(), errors: { getTokenAccountsByOwner: { code: -32602, message: 'Indexed requests require a personal token' } } })
    await expect(new SolanaClient(node).balances(OWNER)).rejects.toThrow(/personal token/)
  })

  it('scan + 指定 mints：没持有的代币余额为 0，decimals 照常返回', async () => {
    const { sol } = setup()
    const res = await sol.balances(OTHER, [USDC], { scan: true })
    expect(res[0]).toMatchObject({ token: USDC, balance: '0', decimals: 6, success: true })
  })
})

describe('tokens', () => {
  it('默认 name / symbol / decimals', async () => {
    const { sol } = setup()
    const [usdc, pyusd, native] = await sol.tokens([USDC, PYUSD, NATIVE_MINT])
    expect(usdc).toEqual({ address: USDC, native: false, name: 'USD Coin', symbol: 'USDC', decimals: 6, success: true })
    expect(pyusd).toMatchObject({ name: 'PayPal USD', symbol: 'PYUSD', decimals: 6, success: true })
    expect(native).toEqual({ address: NATIVE_MINT, native: true, name: 'Solana', symbol: 'SOL', decimals: 9, success: true })
    expectTypeOf(usdc!.symbol).toEqualTypeOf<string | null>()
  })

  it('字段可选，supply 带换算值，权限为 null 是有效值', async () => {
    const { sol } = setup()
    const [usdc, pyusd] = await sol.tokens([USDC, PYUSD], { fields: ['supply', 'tokenProgram', 'mintAuthority', 'uri'] })
    expect(usdc).toEqual({
      address: USDC,
      native: false,
      supply: '10000000',
      supplyFormatted: '10',
      tokenProgram: TOKEN_PROGRAM_ID,
      mintAuthority: OTHER,
      uri: 'https://usdc',
      success: true,
    })
    expect(pyusd).toMatchObject({ mintAuthority: null, uri: 'https://pyusd', tokenProgram: TOKEN_2022_PROGRAM_ID, success: true })
    // @ts-expect-error 没请求 name
    void usdc!.name
  })

  it('name / symbol / decimals 命中缓存时不发请求；与 balances 共用缓存', async () => {
    const { node, sol } = setup()
    await sol.balances(OWNER, [USDC], { symbol: true })
    const before = node.calls.length
    const [usdc] = await sol.tokens([USDC], { fields: ['symbol', 'decimals'] })
    expect(usdc).toMatchObject({ symbol: 'USDC', decimals: 6 })
    expect(node.calls.length).toBe(before)
  })

  it('mint 不存在：字段为 null，success 为 false', async () => {
    const { sol } = setup()
    const [missing] = await sol.tokens([MISSING], { fields: ['decimals', 'mintAuthority'] })
    expect(missing).toEqual({ address: MISSING, native: false, decimals: null, mintAuthority: null, success: false })
  })

  it('getTokens 透传 fields', async () => {
    const node = createMockNode({ accounts: world() })
    const res = await getTokens([PYUSD], { provider: node, fields: ['symbol'] })
    expect(res).toEqual([{ address: PYUSD, native: false, symbol: 'PYUSD', success: true }])
  })
})

describe('NFT', () => {
  it('nfts：Metaplex 元数据（集合、版税、标准、创作者）', async () => {
    const { sol } = setup()
    const [nft, missing] = await sol.nfts([NFT, MISSING])
    expect(nft).toEqual({
      mint: NFT,
      name: 'Mad Lad #1',
      symbol: 'MAD',
      uri: 'https://meta/1.json',
      collection: { address: COLLECTION, verified: true },
      creators: [{ address: OWNER, verified: true, share: 100 }],
      sellerFeeBasisPoints: 420,
      tokenStandard: 'ProgrammableNonFungible',
      isMutable: true,
      updateAuthority: '11111111111111111111111111111111',
      success: true,
    })
    expect(missing?.success).toBe(false)
  })

  it('nfts：Token-2022 代币取 TokenMetadata 扩展', async () => {
    const { sol } = setup()
    expect((await sol.nfts([PYUSD]))[0]).toMatchObject({ name: 'PayPal USD', symbol: 'PYUSD', collection: null, success: true })
  })

  it('nftOwners：getTokenLargestAccounts 合并发送 + 一次 getMultipleAccounts', async () => {
    const node = createMockNode({ accounts: world() })
    const res = await getNftOwners([NFT, MISSING, 'bad'], { provider: node })
    expect(res).toEqual([
      { mint: NFT, owner: OTHER, tokenAccount: getAssociatedTokenAddress(OTHER, NFT, TOKEN_PROGRAM_ID), success: true },
      { mint: MISSING, owner: null, tokenAccount: null, success: false },
      { mint: 'bad', owner: null, tokenAccount: null, success: false },
    ])
  })

  it('ownerNfts：扫描数量 1、精度 0 的代币账户', async () => {
    const node = createMockNode({ accounts: world() })
    const res = await getOwnerNfts(OTHER, { provider: node })
    expect(res.map((n) => n.name)).toEqual(['Mad Lad #1'])
    expect(await getOwnerNfts(OWNER, { provider: node })).toEqual([])
  })

  it('getNfts', async () => {
    const node = createMockNode({ accounts: world() })
    expect((await getNfts([NFT], { provider: node }))[0]?.collection?.address).toBe(COLLECTION)
  })
})

describe('独立函数', () => {
  it('getBalances：不传 provider 时用内置节点（mainnet）', () => {
    const client = resolveClientForTest({})
    expect(client).toBeInstanceOf(SolanaClient)
  })

  it('getBalances 透传 symbol / scan', async () => {
    const node = createMockNode({ accounts: world() })
    const res = await getBalances(OWNER, [USDC], { provider: node, symbol: true, scan: true })
    expect(res[0]).toMatchObject({ balance: '1235000000', symbol: 'USDC' })
  })

  it('客户端缓存：相同参数复用；undefined 配置项不影响；含函数的配置不复用', () => {
    const node = createMockNode()
    const a = resolveClientForTest({ provider: node })
    expect(resolveClientForTest({ provider: node, commitment: undefined })).toBe(a)
    expect(resolveClientForTest({ provider: node, commitment: 'finalized' })).not.toBe(a)
    const fetchFn = fetch
    expect(resolveClientForTest({ provider: 'https://a.example', fetch: fetchFn })).not.toBe(resolveClientForTest({ provider: 'https://a.example', fetch: fetchFn }))
  })
})
