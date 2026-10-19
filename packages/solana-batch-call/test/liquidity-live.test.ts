/**
 * 添加 / 移除流动性：在主网上模拟执行（simulateTransaction，不验签名、不上链），默认跳过：
 * `LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/liquidity-live.test.ts`
 *
 * 新建仓位用交易所热钱包（有 SOL 和 USDC）的身份模拟；移除 / 领取用 lp-live.test.ts 里真实仓位的持有人。
 * 模拟时取回执行后的账户（仓位、代币账户），核对流动性与计划逐位一致、收到 / 付出的数量在最小值 / 最大值以内
 */
import { base64 } from '@scure/base'
import { beforeEach, describe, expect, it } from 'vitest'

import { getAssociatedTokenAddress } from '../src/address.js'
import { HttpRpc, NATIVE_MINT, SolanaClient, TOKEN_PROGRAM_ID } from '../src/index.js'
import { Bytes } from '../src/liquidity/common.js'
import { parseTokenAccount } from '../src/layout.js'
import { buildAddLiquidity, buildCollectFees, buildRemoveLiquidity, type SolanaLiquidityPlan } from '../src/subpaths/liquidity.js'
import { setComputeUnitLimit } from '../src/write/instructions.js'
import { compileMessage, serializeTransaction, transactionSize } from '../src/write/transaction.js'

const live = process.env.LIVE ? describe : describe.skip
const client = new SolanaClient(new HttpRpc(process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com', { batch: false, retries: 5 }))

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
/** 有 SOL 和 USDC 的系统账户（Coinbase 热钱包） */
const WHALE = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
const RAYDIUM_OWNER = '7MNmCGMgdSzMzwNhQKCAs82pd5odi4xjg4VtUU7WiCNk'
const RAYDIUM_NFT = '6MZXirXpM1RcD6NT6LYr5QFs2XHkm6RtmYn6LAdexu7u'
const ORCA_OWNER = '3DpK18iFHS6tV91QdSg21okcEdVtUzQpahrs8B3ZFdht'
const ORCA_NFT = '5LXJvDUk542LZkPa8bYrgbRyNwkv4CbrcBBkBW4NaT9o'
const AMM_OWNER = 'D55dTJ6yaWtbCGbfmAEjbojiExz4GyeVfUryVCbKbiSK'
const AMM_POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'
const CPMM_POOL = '47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4'
/** CPMM 池子的 LP 持有人（2026-10，从池子最近的交易里找到） */
const CPMM_OWNER = '2CKkjAuNTXufc8bFJ5yRVGLQ2JYhqwvfNY732Jofhapn'

interface Simulated {
  err: unknown
  logs: string[]
  /** 执行后的账户（与 watch 一一对应，不存在时为 null） */
  after: Array<Uint8Array | null>
  size: number
}

/** 把计划的全部指令放进一笔交易模拟（以 owner 为手续费支付者） */
async function simulate(plan: SolanaLiquidityPlan, watch: readonly string[]): Promise<Simulated> {
  const instructions = [setComputeUnitLimit(1_400_000), ...plan.steps.flatMap((s) => s.instructions)]
  const message = compileMessage(plan.owner, instructions, '11111111111111111111111111111111')
  const tx = serializeTransaction(message, message.signers.map(() => null))
  const res = await client.request<{ value: { err: unknown; logs: string[] | null; accounts: Array<{ data: [string, string] } | null> | null } }>('simulateTransaction', [
    base64.encode(tx),
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watch } },
  ])
  return {
    err: res.value.err,
    logs: res.value.logs ?? [],
    after: (res.value.accounts ?? []).map((a) => (a ? base64.decode(a.data[0]) : null)),
    size: transactionSize(message),
  }
}

const tokenAmount = (data: Uint8Array | null | undefined) => (data ? parseTokenAccount(data).amount : 0n)
const ata = (owner: string, mint: string) => getAssociatedTokenAddress(owner, mint, TOKEN_PROGRAM_ID)

async function balancesOf(addresses: readonly string[]): Promise<bigint[]> {
  const accounts = await client.accounts(addresses)
  return accounts.map((a) => (a ? tokenAmount(a.data) : 0n))
}

function expectOk(sim: Simulated) {
  if (sim.err) {
    throw new Error(`simulation failed: ${JSON.stringify(sim.err)}\n${sim.logs.slice(-15).join('\n')}`)
  }
  expect(sim.size).toBeLessThanOrEqual(1232)
}

/** 模拟后账户已关闭：不存在，或数据被清空 */
const closed = (data: Uint8Array | null | undefined) => !data || data.length === 0

live('添加 / 移除流动性（主网模拟）', { timeout: 120_000 }, () => {
  // 官方节点按连接限频：用例之间歇一下
  beforeEach(() => new Promise((resolve) => setTimeout(resolve, process.env.SOLANA_RPC ? 0 : 8000)))

  it('Raydium CLMM：新建仓位（SOL 自动包装）→ 流动性与计划一致', async () => {
    const [current] = (await (await import('../src/subpaths/lp.js')).getLpPositions(RAYDIUM_OWNER, { mints: [RAYDIUM_NFT] })) as Array<{ pool: string; price: number }>
    const pool = current?.pool as string
    const plan = await buildAddLiquidity(client, WHALE, { protocol: 'raydium-clmm', pool, priceLower: (current?.price as number) * 0.9, priceUpper: (current?.price as number) * 1.1, amount0Formatted: '1' })
    expect(plan.native).toBe('token0')
    expect(plan.signers).toHaveLength(1)
    const before = await balancesOf([ata(WHALE, USDC)])
    const sim = await simulate(plan, [plan.position as string, ata(WHALE, USDC)])
    expectOk(sim)
    // PersonalPositionState：liquidity 在 81
    expect(new Bytes(sim.after[0] as Uint8Array).u128(81).toString()).toBe(plan.liquidity)
    const spent = (before[0] as bigint) - tokenAmount(sim.after[1])
    expect(spent > 0n && spent <= BigInt(plan.amount1Max as string)).toBe(true)
  })

  it('Raydium CLMM：持有人移除一半（收到 wSOL / USDC 不少于最小值），领取手续费', async () => {
    const plan = await buildRemoveLiquidity(client, RAYDIUM_OWNER, { position: { protocol: 'raydium-clmm', positionMint: RAYDIUM_NFT }, percent: 50 }, { native: false })
    const watch = [ata(RAYDIUM_OWNER, NATIVE_MINT), ata(RAYDIUM_OWNER, USDC), plan.position as string]
    const before = await balancesOf(watch.slice(0, 2))
    const sim = await simulate(plan, watch)
    expectOk(sim)
    const got0 = tokenAmount(sim.after[0]) - (before[0] as bigint)
    const got1 = tokenAmount(sim.after[1]) - (before[1] as bigint)
    expect(got0 >= BigInt(plan.amount0Min as string) && got1 >= BigInt(plan.amount1Min as string)).toBe(true)
    const left = new Bytes(sim.after[2] as Uint8Array).u128(81)
    const collect = await buildCollectFees(client, RAYDIUM_OWNER, { position: { protocol: 'raydium-clmm', positionMint: RAYDIUM_NFT } })
    expectOk(await simulate(collect, []))
    expect(left > 0n).toBe(true)
  })

  it('Raydium CLMM：全部移除并关闭仓位（SOL 解包）', async () => {
    const plan = await buildRemoveLiquidity(client, RAYDIUM_OWNER, { position: { protocol: 'raydium-clmm', positionMint: RAYDIUM_NFT }, burn: true })
    const sim = await simulate(plan, [plan.position as string, RAYDIUM_NFT])
    expectOk(sim)
    expect(closed(sim.after[0])).toBe(true) // 仓位账户关闭
  })

  it('Orca：新建仓位（初始化 tick 数组、开仓、加流动性）→ 流动性与计划一致', async () => {
    const [current] = (await (await import('../src/subpaths/lp.js')).getLpPositions(ORCA_OWNER, { mints: [ORCA_NFT] })) as Array<{ pool: string; price: number }>
    const plan = await buildAddLiquidity(client, WHALE, {
      protocol: 'orca-whirlpool',
      pool: current?.pool as string,
      priceLower: (current?.price as number) * 0.95,
      priceUpper: (current?.price as number) * 1.05,
      amount1Formatted: '100',
    })
    const sim = await simulate(plan, [plan.position as string])
    expectOk(sim)
    // Position：liquidity 在 72
    expect(new Bytes(sim.after[0] as Uint8Array).u128(72).toString()).toBe(plan.liquidity)
  })

  it('Orca：持有人移除一半；全部移除并关闭', async () => {
    const half = await buildRemoveLiquidity(client, ORCA_OWNER, { position: { protocol: 'orca-whirlpool', positionMint: ORCA_NFT }, percent: 50 }, { native: false })
    const watch = [ata(ORCA_OWNER, half.token0.mint), ata(ORCA_OWNER, half.token1.mint)]
    const before = await balancesOf(watch)
    const sim = await simulate(half, watch)
    expectOk(sim)
    expect(tokenAmount(sim.after[0]) - (before[0] as bigint) >= BigInt(half.amount0Min as string)).toBe(true)
    expect(tokenAmount(sim.after[1]) - (before[1] as bigint) >= BigInt(half.amount1Min as string)).toBe(true)
    const all = await buildRemoveLiquidity(client, ORCA_OWNER, { position: { protocol: 'orca-whirlpool', positionMint: ORCA_NFT }, burn: true })
    const end = await simulate(all, [all.position as string])
    expectOk(end)
    expect(closed(end.after[0])).toBe(true)
  })

  it('Raydium AMM v4：存入 USDC（另一边 SOL）→ 拿到的 LP 与计划一致；持有人移除 10%', async () => {
    const plan = await buildAddLiquidity(client, WHALE, { protocol: 'raydium-amm', pool: AMM_POOL, amount1Formatted: '50' })
    const lpAccount = ata(WHALE, plan.lpMint as string)
    const [lpBefore] = await balancesOf([lpAccount])
    const sim = await simulate(plan, [lpAccount])
    expectOk(sim)
    const minted = tokenAmount(sim.after[0]) - (lpBefore as bigint)
    // 储备随交易变化：与计划相差在滑点以内
    expect(minted > 0n && minted * 1000n >= BigInt(plan.liquidity) * 995n).toBe(true)

    const remove = await buildRemoveLiquidity(client, AMM_OWNER, { position: { protocol: 'raydium-amm', pool: AMM_POOL }, percent: 10 }, { native: false })
    const watch = [ata(AMM_OWNER, NATIVE_MINT), ata(AMM_OWNER, USDC)]
    const before = await balancesOf(watch)
    const out = await simulate(remove, watch)
    expectOk(out)
    expect(tokenAmount(out.after[0]) - (before[0] as bigint) >= BigInt(remove.amount0Min as string)).toBe(true)
    expect(tokenAmount(out.after[1]) - (before[1] as bigint) >= BigInt(remove.amount1Min as string)).toBe(true)
  })

  it('Raydium CPMM：存入 SOL → 拿到的 LP 与计划一致；持有人移除一半', async () => {
    const plan = await buildAddLiquidity(client, WHALE, { protocol: 'raydium-cpmm', pool: CPMM_POOL, amount0Formatted: '0.01' })
    const lpAccount = ata(WHALE, plan.lpMint as string)
    const [lpBefore] = await balancesOf([lpAccount])
    const sim = await simulate(plan, [lpAccount])
    expectOk(sim)
    expect((tokenAmount(sim.after[0]) - (lpBefore as bigint)).toString()).toBe(plan.liquidity)

    const remove = await buildRemoveLiquidity(client, CPMM_OWNER, { position: { protocol: 'raydium-cpmm', pool: CPMM_POOL }, percent: 50 }, { native: false })
    const watch = [ata(CPMM_OWNER, remove.token0.mint), ata(CPMM_OWNER, remove.token1.mint)]
    const before = await balancesOf(watch)
    const out = await simulate(remove, watch)
    expectOk(out)
    // 储备没变时与计划逐位一致（池子不活跃）；至少不少于最小值
    const got0 = tokenAmount(out.after[0]) - (before[0] as bigint)
    const got1 = tokenAmount(out.after[1]) - (before[1] as bigint)
    expect(got0 >= BigInt(remove.amount0Min as string) && got1 >= BigInt(remove.amount1Min as string)).toBe(true)
  })

  it('往已有仓位追加（Raydium CLMM / Orca）：流动性增加量与计划一致（持有人余额不够时跳过）', async (ctx) => {
    let checked = 0
    for (const [protocol, owner, nft, offset] of [
      ['raydium-clmm', RAYDIUM_OWNER, RAYDIUM_NFT, 81],
      ['orca-whirlpool', ORCA_OWNER, ORCA_NFT, 72],
    ] as const) {
      // 两边都给：价格在区间外时只用需要的那一边
      const plan = await buildAddLiquidity(client, owner, { position: { protocol, positionMint: nft }, amount0Formatted: '0.01', amount1Formatted: '1' })
      const [b0, b1] = await client.balances(owner, [plan.token0.mint, plan.token1.mint])
      if (BigInt(b0?.balance ?? 0) < BigInt(plan.amount0Max as string) || BigInt(b1?.balance ?? 0) < BigInt(plan.amount1Max as string)) {
        continue
      }
      const [positionBefore] = await client.accounts([plan.position as string])
      const sim = await simulate(plan, [plan.position as string])
      expectOk(sim)
      const added = new Bytes(sim.after[0] as Uint8Array).u128(offset) - new Bytes((positionBefore as { data: Uint8Array }).data).u128(offset)
      expect(added.toString()).toBe(plan.liquidity)
      checked++
    }
    if (!checked) ctx.skip()
  })
})
