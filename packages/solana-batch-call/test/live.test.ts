/**
 * 连真实节点的测试，默认跳过：`pnpm test:live`
 * - SOLANA_RPC：支持 getTokenAccountsByOwner 的节点（扫描 / ownerNfts 用），默认官方节点（只能在服务端用）
 * - 需要代理时，Node 的 fetch 默认不读 HTTPS_PROXY，可以加 NODE_USE_ENV_PROXY=1（Node 24+）
 */
import { describe, expect, it } from 'vitest'

import { NATIVE_MINT, NetworkMismatchError, SolanaClient, TOKEN_2022_PROGRAM_ID, getBalances, getNftOwners, getNfts, getOwnerTokens, getTokens } from '../src/index.js'

const live = process.env.LIVE ? describe : describe.skip

const OWNER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
const NFT = '13GQVi3LMiG4yXn7VKEYDgo25TqHRUE2pb1t32ekizUm' // Derugging Ducks Pass #3835
const NFT_COLLECTION = '3Eyi78ptWg1k1nTaJTJHSLJhuLck7XAc3PCZ7BgL4WrN'
const INDEXED_RPC = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com'

live('内置公共节点（不需要索引方法）', () => {
  it('getBalances：SOL + SPL Token + Token-2022，带 symbol', async () => {
    const [sol, usdc, pyusd] = await getBalances(OWNER, [NATIVE_MINT, USDC, PYUSD], { symbol: true })
    expect(sol).toMatchObject({ native: true, decimals: 9, symbol: 'SOL', success: true })
    expect(usdc).toMatchObject({ decimals: 6, symbol: 'USDC', success: true })
    expect(pyusd).toMatchObject({ decimals: 6, symbol: 'PYUSD', tokenProgram: TOKEN_2022_PROGRAM_ID, success: true })
    expect(BigInt(usdc!.balance)).toBeGreaterThan(0n)
  })

  it('getTokens：Metaplex 与 Token-2022 元数据', async () => {
    const [usdc, pyusd] = await getTokens([USDC, PYUSD], { fields: ['name', 'symbol', 'decimals', 'supply'] })
    expect(usdc).toMatchObject({ name: 'USD Coin', symbol: 'USDC', decimals: 6, success: true })
    expect(pyusd).toMatchObject({ name: 'PayPal USD', symbol: 'PYUSD', decimals: 6, success: true })
    expect(Number(usdc!.supplyFormatted)).toBeGreaterThan(1e9)
  })

  it('getNfts：集合、标准', async () => {
    const [nft] = await getNfts([NFT])
    expect(nft).toMatchObject({ collection: { address: NFT_COLLECTION, verified: true }, tokenStandard: 'NonFungible', success: true })
    expect(nft?.name).toMatch(/Derugging Ducks/)
  })

  it('网络校验：devnet 节点按 mainnet 使用时报错', async () => {
    const client = new SolanaClient('https://api.devnet.solana.com', { cluster: 'mainnet' })
    await expect(client.solBalances([OWNER])).rejects.toThrow(NetworkMismatchError)
    expect(await new SolanaClient('https://api.devnet.solana.com').getCluster()).toBe('devnet')
  })
}, 60_000)

live('支持索引方法的节点', () => {
  it('scan：全部持仓（含同一代币的多个账户合计）', async () => {
    const list = await getBalances(OWNER, undefined, { provider: INDEXED_RPC })
    expect(list[0]).toMatchObject({ token: NATIVE_MINT, native: true })
    expect(list.length).toBeGreaterThan(10)
    const usdc = list.find((b) => b.token === USDC)
    const [ataOnly] = await getBalances(OWNER, [USDC], { provider: INDEXED_RPC })
    // 这个地址除了 ATA 还有很多非 ATA 的 USDC 账户
    expect(BigInt(usdc!.balance)).toBeGreaterThan(BigInt(ataOnly!.balance))
  })

  it('getOwnerTokens：全部持仓（不读元数据，大钱包也很快）', async () => {
    const list = await getOwnerTokens(OWNER, { provider: INDEXED_RPC, metadata: false })
    expect(list[0]).toMatchObject({ token: NATIVE_MINT, native: true })
    expect(list.length).toBeGreaterThan(100)
    const usdc = list.find((t) => t.token === USDC)
    expect(usdc?.accounts).toBeGreaterThan(1) // 多个代币账户合计
    expect(list.every((t) => !(t.decimals === 0 && t.balance === '1'))).toBe(true) // 默认不含 NFT
  })

  it('getNftOwners（官方节点对 getTokenLargestAccounts 限频很严，被限频时跳过）', async (ctx) => {
    const res = await getNftOwners([NFT], { provider: INDEXED_RPC }).catch((err: unknown) => {
      if (/too many|429/i.test(String(err))) ctx.skip('节点限频，换 SOLANA_RPC 为自己的节点再试')
      throw err
    })
    const [owner] = res
    expect(owner?.success).toBe(true)
    expect(owner?.owner).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  })
}, 120_000)
