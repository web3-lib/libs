/**
 * LP 仓位连真实节点的测试，默认跳过：`LIVE=1 pnpm vitest run test/lp-live.test.ts`
 * - SOLANA_RPC：支持 getTokenAccountsByOwner / getProgramAccounts 的节点（扫描、按 LP mint 找池子），默认官方节点（只能在服务端用、限频严）
 * - 需要代理时加 NODE_USE_ENV_PROXY=1（Node 24+）
 * 仓位是 2026-10 时的真实仓位，持有人之后可能撤出；与官方 SDK 逐位核对见 lp.test.ts（主网快照回放）
 */
import { describe, expect, it } from 'vitest'

import { HttpRpc } from '../src/index.js'
import { getLpPositions, type SolanaLpClmmPosition } from '../src/subpaths/lp.js'

const live = process.env.LIVE ? describe : describe.skip
// 官方节点按方法限频：同一批里有两个 getTokenAccountsByOwner（SPL Token + Token-2022）就会 429，这里不合并请求
const INDEXED_RPC = new HttpRpc(process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com', { batch: false })

const RAYDIUM_OWNER = '7MNmCGMgdSzMzwNhQKCAs82pd5odi4xjg4VtUU7WiCNk'
const RAYDIUM_NFT = '6MZXirXpM1RcD6NT6LYr5QFs2XHkm6RtmYn6LAdexu7u'
const ORCA_OWNER = '3DpK18iFHS6tV91QdSg21okcEdVtUzQpahrs8B3ZFdht'
const ORCA_NFT = '5LXJvDUk542LZkPa8bYrgbRyNwkv4CbrcBBkBW4NaT9o'
const AMM_OWNER = 'D55dTJ6yaWtbCGbfmAEjbojiExz4GyeVfUryVCbKbiSK'
const AMM_LP = '8HoQnePLqPj4M7PUDzfw8e3Ymdwgc7NLGnaTUapubyvu' // SOL-USDC AMM v4
const AMM_POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'

live('LP 仓位：内置公共节点（指定 mints / pools）', { timeout: 30_000 }, () => {
  it('Raydium CLMM、Orca Whirlpool 仓位 NFT', async () => {
    const [ray] = (await getLpPositions(RAYDIUM_OWNER, { mints: [RAYDIUM_NFT] })) as [SolanaLpClmmPosition]
    expect(ray).toMatchObject({ protocol: 'raydium-clmm', positionMint: RAYDIUM_NFT, token0: { symbol: 'SOL' }, token1: { symbol: 'USDC' } })
    expect(BigInt(ray.liquidity)).toBeGreaterThan(0n)
    const [orca] = (await getLpPositions(ORCA_OWNER, { mints: [ORCA_NFT] })) as [SolanaLpClmmPosition]
    expect(orca).toMatchObject({ protocol: 'orca-whirlpool', positionMint: ORCA_NFT, fee: 400 })
    expect(BigInt(orca.amount0) + BigInt(orca.amount1)).toBeGreaterThan(0n)
  })

  it('Raydium AMM v4 LP 代币（传 pools，不需要 getProgramAccounts）', async () => {
    const [p] = await getLpPositions(AMM_OWNER, { mints: [AMM_LP], pools: [AMM_POOL] })
    expect(p).toMatchObject({ type: 'amm', protocol: 'raydium-amm', pool: AMM_POOL, lpMint: AMM_LP })
    expect(BigInt(p!.amount0)).toBeGreaterThan(0n)
  })

  it('prices：DefiLlama 美元价值', async () => {
    const [p] = await getLpPositions(RAYDIUM_OWNER, { mints: [RAYDIUM_NFT], prices: true })
    expect(p?.valueUsd).toBeGreaterThan(0)
  })
})

live('LP 仓位：支持索引方法的节点', { timeout: 30_000 }, () => {
  it('扫描全部代币账户；按 LP mint 用 getProgramAccounts 找池子', async (ctx) => {
    const skipOnLimit = (err: unknown) => {
      if (/too many|429/i.test(String(err))) ctx.skip('节点限频，换 SOLANA_RPC 为自己的节点再试')
      throw err
    }
    const scanned = await getLpPositions(ORCA_OWNER, { provider: INDEXED_RPC }).catch(skipOnLimit)
    expect(scanned.some((p) => p.type === 'clmm' && p.positionMint === ORCA_NFT)).toBe(true)
    const [amm] = await getLpPositions(AMM_OWNER, { provider: INDEXED_RPC, mints: [AMM_LP] }).catch(skipOnLimit)
    expect(amm).toMatchObject({ protocol: 'raydium-amm', pool: AMM_POOL })
  })
})
