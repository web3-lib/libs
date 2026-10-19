import { beforeEach, describe, expect, it } from 'vitest'

import { decodeAddress, findProgramAddress } from '../src/address.js'
import { NATIVE_MINT, SolanaClient, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '../src/index.js'
import { Bytes, anchorIx } from '../src/liquidity/common.js'
import { RAYDIUM_CLMM_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID } from '../src/lp.js'
import {
  MAX_TICK,
  MIN_TICK,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getMaxAmounts,
  getMinAmounts,
  getMintAmounts,
  orcaSqrtPriceAtTick,
  raydiumSqrtPriceAtTick,
  ratioToSqrtPrice,
  sqrtPriceAtTick,
  tickAtSqrtPrice,
} from '../src/lpMath.js'
import { resetNodeHealth } from '../src/rpc.js'
import { addLiquidity, buildAddLiquidity, buildCollectFees, buildRemoveLiquidity, removeLiquidity } from '../src/subpaths/liquidity.js'
import { createFakeSolana, keypair } from './fakeSolana.js'
import { mintData, tokenAccountData, type MockAccount } from './mock.js'

describe('lpMath：添加 / 移除用到的计算', () => {
  it('tickAtSqrtPrice 与两个程序的 sqrtPriceAtTick 互逆', () => {
    for (const program of ['raydium', 'orca'] as const) {
      for (const tick of [MIN_TICK, -300000, -1, 0, 1, 64, 123457, MAX_TICK - 1]) {
        const sqrt = sqrtPriceAtTick(program, tick)
        expect(tickAtSqrtPrice(program, sqrt)).toBe(tick)
        expect(tickAtSqrtPrice(program, sqrt + 1n)).toBe(tick)
        if (tick > MIN_TICK) expect(tickAtSqrtPrice(program, sqrt - 1n)).toBe(tick - 1)
      }
    }
    expect(raydiumSqrtPriceAtTick(0)).toBe(orcaSqrtPriceAtTick(0))
  })

  it('价格 → sqrt 价格：1 → 2^64，按精度换算', () => {
    expect(ratioToSqrtPrice(1n, 1n, 6, 6)).toBe(1n << 64n)
    // SOL（9 位）/ USDC（6 位）价格 150：raw = 150 × 10^-3
    const sqrt = ratioToSqrtPrice(150n, 1n, 9, 6)
    expect(Math.abs((Number(sqrt) / 2 ** 64) ** 2 / 0.15 - 1)).toBeLessThan(1e-12)
    expect(() => ratioToSqrtPrice(0n, 1n, 9, 6)).toThrow(RangeError)
  })

  it('按数量算的流动性：需要的数量不超过给的；最小值 <= 预计 <= 最大值', () => {
    const [tl, tu, tick] = [-640, 960, 100]
    const a = raydiumSqrtPriceAtTick(tl)
    const b = raydiumSqrtPriceAtTick(tu)
    const p = raydiumSqrtPriceAtTick(tick) + 12345n
    const L = getLiquidityForAmounts(tick, p, a, b, 10n ** 9n, 5n * 10n ** 9n, tl, tu)
    const [m0, m1] = getMintAmounts(tick, p, a, b, L, tl, tu)
    expect(m0 <= 10n ** 9n && m1 <= 5n * 10n ** 9n).toBe(true)
    expect(10n ** 9n - m0 <= 1n || 5n * 10n ** 9n - m1 <= 1n).toBe(true)
    const [e0, e1] = getAmountsForLiquidity(tick, p, a, b, L, tl, tu)
    const [min0, min1] = getMinAmounts('raydium', p, tl, tu, L, 0.01)
    const [max0, max1] = getMaxAmounts('raydium', p, tl, tu, L, 0.01)
    expect(min0 < e0 && e0 <= m0 && m0 < max0).toBe(true)
    expect(min1 < e1 && e1 <= m1 && m1 < max1).toBe(true)
    // 区间在当前价格下方 / 上方：只给需要的那一边
    expect(getLiquidityForAmounts(tl - 100, a - 1000n, a, b, undefined, 10n ** 9n, tl, tu)).toBe(0n)
    expect(getLiquidityForAmounts(tl - 100, a - 1000n, a, b, 10n ** 9n, undefined, tl, tu)).toBeGreaterThan(0n)
    // 价格正好在上限（向下穿过后 tick = tickUpper − 1、sqrtPrice = 上限）：只需要 token1，不能除以 0
    expect(getLiquidityForAmounts(tu - 1, b, a, b, 10n ** 9n, 10n ** 9n, tl, tu)).toBe(getLiquidityForAmounts(tu, b, a, b, undefined, 10n ** 9n, tl, tu))
    // 价格正好在下限（tick == tickLower）：只需要 token0，不能除以 0
    expect(getLiquidityForAmounts(tl, a, a, b, 10n ** 9n, 10n ** 9n, tl, tu)).toBe(getLiquidityForAmounts(tl - 1, a - 1n, a, b, 10n ** 9n, undefined, tl, tu))
  })
})

// ---------------------------------------------------------------------------
// 假的链：CPMM 池子 + 假的 CPMM 程序（存入 / 取出按程序的取整规则）
// ---------------------------------------------------------------------------

const USER = keypair(1)
const OTHER = keypair(2)
const USDC = keypair(40).address
const POOL = keypair(50).address
const LP_MINT = keypair(51).address
const VAULT0 = keypair(52).address
const VAULT1 = keypair(53).address
const SOL = 1_000_000_000n
const fast = { pollInterval: 1, timeout: 5_000, priorityFee: 0 }

const u64 = (data: Uint8Array, o: number) => new DataView(data.buffer, data.byteOffset).getBigUint64(o, true)
const setU64 = (data: Uint8Array, o: number, v: bigint) => new DataView(data.buffer, data.byteOffset).setBigUint64(o, v, true)

function cpmmPoolData(supply: bigint): Uint8Array {
  const data = new Uint8Array(637)
  data.set(decodeAddress(VAULT0), 72)
  data.set(decodeAddress(VAULT1), 104)
  data.set(decodeAddress(LP_MINT), 136)
  data.set(decodeAddress(NATIVE_MINT), 168)
  data.set(decodeAddress(USDC), 200)
  data[331] = 9
  data[332] = 6
  setU64(data, 333, supply)
  return data
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

/** 假的 CPMM：deposit / withdraw 与程序相同的取整（存入向上、取出向下） */
function fakeCpmm(ix: { keys: string[]; data: Uint8Array }, state: Record<string, MockAccount>) {
  const [, , pool, userLp, user0, user1, vault0, vault1] = ix.keys as string[]
  const disc = ix.data.slice(0, 8)
  const lp = u64(ix.data, 8)
  const poolData = state[pool as string]?.data as Uint8Array
  const supply = u64(poolData, 333)
  const balance = (a: string) => u64(state[a]?.data as Uint8Array, 64)
  const add = (a: string, d: bigint) => {
    const account = state[a] as MockAccount
    const next = balance(a) + d
    if (next < 0n) throw new Error(`insufficient funds in ${a}`)
    setU64(account.data as Uint8Array, 64, next)
    // wSOL：代币余额就是账户里的 lamports（与 Token 程序转 wSOL 一致）
    if (new Bytes(account.data as Uint8Array).key(0) === NATIVE_MINT) {
      account.lamports = (account.lamports ?? 0n) + d
    }
  }
  const [r0, r1] = [balance(vault0 as string), balance(vault1 as string)]
  if (disc.every((b, i) => b === anchorIx('deposit')[i])) {
    const [a0, a1] = [ceilDiv(lp * r0, supply), ceilDiv(lp * r1, supply)]
    if (a0 > u64(ix.data, 16) || a1 > u64(ix.data, 24)) throw new Error('ExceededSlippage')
    add(user0 as string, -a0)
    add(user1 as string, -a1)
    add(vault0 as string, a0)
    add(vault1 as string, a1)
    add(userLp as string, lp)
    setU64(poolData, 333, supply + lp)
  } else if (disc.every((b, i) => b === anchorIx('withdraw')[i])) {
    const [a0, a1] = [(lp * r0) / supply, (lp * r1) / supply]
    if (a0 < u64(ix.data, 16) || a1 < u64(ix.data, 24)) throw new Error('ExceededSlippage')
    add(userLp as string, -lp)
    add(vault0 as string, -a0)
    add(vault1 as string, -a1)
    add(user0 as string, a0)
    add(user1 as string, a1)
    setU64(poolData, 333, supply - lp)
  } else {
    throw new Error('unknown instruction')
  }
}

function setup() {
  const chain = createFakeSolana({ programs: { [RAYDIUM_CPMM_PROGRAM_ID]: fakeCpmm } })
  chain.addMint(NATIVE_MINT, 9)
  chain.addMint(USDC, 6)
  chain.addMint(LP_MINT, 9)
  chain.setSol(USER.address, 10n * SOL)
  chain.setToken(USER.address, USDC, 1000n * 10n ** 6n)
  // 储备 100 SOL / 15000 USDC，LP 总量 1e9
  chain.accounts[POOL] = { lamports: 10n ** 7n, owner: RAYDIUM_CPMM_PROGRAM_ID, data: cpmmPoolData(10n ** 9n) }
  chain.accounts[VAULT0] = { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ID, data: tokenAccountData(NATIVE_MINT, POOL, 100n * SOL) }
  chain.accounts[VAULT1] = { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ID, data: tokenAccountData(USDC, POOL, 15000n * 10n ** 6n) }
  return { chain, client: new SolanaClient(chain.transport) }
}

beforeEach(() => {
  resetNodeHealth()
})

describe('Raydium CPMM（假的链）', () => {
  it('计划：给 USDC，按储备比例算 LP 和 SOL；SOL 自动包装', async () => {
    const { client } = setup()
    const plan = await buildAddLiquidity(client, USER.address, { protocol: 'raydium-cpmm', pool: POOL, amount1Formatted: '150' })
    // LP = 150 × 1e9 / 15000 = 1e7；SOL = ceil(1e7 × 100 SOL / 1e9) = 1 SOL
    expect(plan).toMatchObject({ type: 'amm', lpMint: LP_MINT, liquidity: '10000000', amount0: String(SOL), amount1: '150000000', native: 'token0' })
    expect(plan.amount0Max).toBe(String((SOL * 1005n) / 1000n))
    const [setupStep, main] = plan.steps
    expect(setupStep?.kind).toBe('setup')
    // 准备：创建 wSOL 账户、LP 账户；主指令那一步：转 SOL、SyncNative、存入、关闭 wSOL（原来没有）
    expect(setupStep?.instructions.map((ix) => `${ix.programId.slice(0, 6)}:${ix.data[0]}`)).toEqual(['AToken:1', 'AToken:1'])
    expect(main?.instructions.map((ix) => `${ix.programId.slice(0, 6)}:${ix.data[0]}`)).toEqual(['111111:2', 'Tokenk:17', `${RAYDIUM_CPMM_PROGRAM_ID.slice(0, 6)}:${anchorIx('deposit')[0]}`, 'Tokenk:9'])
    const deposit = main?.instructions[2]
    expect(deposit?.programId).toBe(RAYDIUM_CPMM_PROGRAM_ID)
    expect([...(deposit?.data.slice(0, 8) ?? [])]).toEqual([...anchorIx('deposit')])
    expect(u64(deposit?.data as Uint8Array, 8)).toBe(10_000_000n)
  })

  it('发送：包装 SOL → 存入 → 关闭 wSOL；再移除一半拿回 SOL 和 USDC', async () => {
    const { chain, client } = setup()
    const added = await addLiquidity(client, USER.secretKey, { protocol: 'raydium-cpmm', pool: POOL, amount1Formatted: '150' }, fast)
    expect(added.status).toBe('confirmed')
    expect(added.results.every((r) => r.status === 'confirmed')).toBe(true)
    expect(chain.token(USER.address, LP_MINT)).toBe(10_000_000n)
    expect(chain.token(USER.address, USDC)).toBe(850n * 10n ** 6n)
    // wSOL 账户已关闭，多包装的 0.005 SOL 和租金退回
    expect(chain.token(USER.address, NATIVE_MINT)).toBe(null)
    const spent = 10n * SOL - chain.sol(USER.address)
    expect(spent).toBe(SOL + 2_039_280n + 5000n) // 1 SOL + LP 账户租金 + 手续费（准备和存入合成了一笔交易）
    expect(added.results.map((r) => r.signature).every((sig) => sig === added.signature)).toBe(true)

    const solBefore = chain.sol(USER.address)
    const removed = await removeLiquidity(client, USER.secretKey, { position: { protocol: 'raydium-cpmm', pool: POOL }, percent: 50 }, fast)
    expect(removed.status).toBe('confirmed')
    expect(removed.plan).toMatchObject({ liquidity: '5000000', amount1: '75000000', native: 'token0' })
    expect(chain.token(USER.address, LP_MINT)).toBe(5_000_000n)
    expect(chain.token(USER.address, USDC)).toBe(925n * 10n ** 6n)
    expect(chain.sol(USER.address) - solBefore).toBeGreaterThan(SOL / 2n - 100_000n)

    // 已经有 wSOL 账户时：收到的留在里面（不关闭），计划不标成收到 SOL
    chain.setToken(USER.address, NATIVE_MINT, 0n)
    const keep = await buildRemoveLiquidity(client, USER.address, { position: { protocol: 'raydium-cpmm', pool: POOL }, percent: 50 })
    expect(keep.native).toBe(null)
    expect(keep.steps.flatMap((step) => step.instructions).some((ix) => ix.programId === TOKEN_PROGRAM_ID && ix.data[0] === 9)).toBe(false)
  })

  it('两边都给：按较少的一边算 LP，另一边的上限不超过给的数量', async () => {
    const { client } = setup()
    // 1 SOL 对应 150 USDC：给 1 SOL + 200 USDC，SOL 决定数量，USDC 上限是 150 × 1.005，不超过 200
    const plan = await buildAddLiquidity(client, USER.address, { protocol: 'raydium-cpmm', pool: POOL, amount0Formatted: '1', amount1Formatted: '200' })
    expect([plan.amount0, plan.amount1, plan.amount1Max]).toEqual([String(SOL), '150000000', '150750000'])
    // 给 1 SOL + 150.1 USDC：USDC 上限压到 150.1
    const tight = await buildAddLiquidity(client, USER.address, { protocol: 'raydium-cpmm', pool: POOL, amount0Formatted: '1', amount1Formatted: '150.1' })
    expect(tight.amount1Max).toBe('150100000')
    expect(BigInt(tight.amount0Max as string)).toBeGreaterThan(SOL)
  })

  it('主指令模拟失败：准备工作（创建账户、包装 SOL）也不发送', async () => {
    const chain = createFakeSolana({
      programs: {
        [RAYDIUM_CPMM_PROGRAM_ID]: () => {
          throw new Error('pool is paused')
        },
      },
    })
    const { chain: base } = setup()
    Object.assign(chain.accounts, base.accounts)
    const client = new SolanaClient(chain.transport)
    const result = await addLiquidity(client, USER.secretKey, { protocol: 'raydium-cpmm', pool: POOL, amount1Formatted: '150' }, fast)
    expect(result.status).toBe('failed')
    expect(result.results.map((r) => r.status)).toEqual(['failed', 'failed'])
    expect(chain.sent).toHaveLength(0)
    expect(chain.token(USER.address, NATIVE_MINT)).toBe(null)
    expect(chain.sol(USER.address)).toBe(10n * SOL)
  })

  it('带转账手续费的 Token-2022 代币：构建时报错', async () => {
    const { chain, client } = setup()
    chain.accounts[USDC] = {
      lamports: 1_461_600n,
      owner: TOKEN_2022_PROGRAM_ID,
      data: mintData({ decimals: 6, transferFee: { older: { epoch: 0n, maximumFee: 10n ** 9n, basisPoints: 100 }, newer: { epoch: 0n, maximumFee: 10n ** 9n, basisPoints: 100 } } }),
    }
    await expect(buildAddLiquidity(client, USER.address, { protocol: 'raydium-cpmm', pool: POOL, amount1Formatted: '1' })).rejects.toThrow(/transfer fee/)
  })

  it('余额不够时不发送；不持有 LP 时移除报错；CPMM 没有单独领取手续费', async () => {
    const { client } = setup()
    await expect(addLiquidity(client, USER.secretKey, { protocol: 'raydium-cpmm', pool: POOL, amount1Formatted: '5000' }, fast)).rejects.toThrow(/Insufficient balance/)
    await expect(buildRemoveLiquidity(client, OTHER.address, { position: { protocol: 'raydium-cpmm', pool: POOL } })).rejects.toThrow(/holds no LP/)
    await expect(buildCollectFees(client, USER.address, { position: { protocol: 'raydium-cpmm', pool: POOL } })).rejects.toThrow(/no separate fees/)
    await expect(buildAddLiquidity(client, USER.address, { protocol: 'raydium-cpmm', pool: POOL, fullRange: true, amount0: 1n })).rejects.toThrow(/no price range/)
    await expect(buildAddLiquidity(client, USER.address, { protocol: 'raydium-cpmm', pool: POOL, amount0: 1n, amount0Formatted: '1' })).rejects.toThrow(/not both/)
  })
})

describe('Raydium CLMM（构建）', () => {
  const CLMM_POOL = keypair(60).address
  const CV0 = keypair(61).address
  const CV1 = keypair(62).address

  function clmmSetup(tick: number) {
    const { chain, client } = setup()
    const data = new Uint8Array(1544)
    data.set(decodeAddress(NATIVE_MINT), 73)
    data.set(decodeAddress(USDC), 105)
    data.set(decodeAddress(CV0), 137)
    data.set(decodeAddress(CV1), 169)
    data[233] = 9
    data[234] = 6
    new DataView(data.buffer).setUint16(235, 10, true)
    const sqrt = raydiumSqrtPriceAtTick(tick)
    setU64(data, 253, sqrt & ((1n << 64n) - 1n))
    setU64(data, 261, sqrt >> 64n)
    new DataView(data.buffer).setInt32(269, tick, true)
    chain.accounts[CLMM_POOL] = { lamports: 10n ** 7n, owner: RAYDIUM_CLMM_PROGRAM_ID, data }
    return { chain, client }
  }

  it('新建仓位：tick 对齐、指令数据布局、新 NFT mint 要签名', async () => {
    // tick −19000 ≈ 价格 0.1496 USDC / lamport 换算后约 149.6 USDC / SOL
    const { client } = clmmSetup(-19000)
    const plan = await buildAddLiquidity(client, USER.address, { protocol: 'raydium-clmm', pool: CLMM_POOL, priceLower: 140, priceUpper: 160, amount0Formatted: '1' })
    expect(plan.tickLower! % 10 === 0 && plan.tickUpper! % 10 === 0).toBe(true)
    expect(plan.tickLower! < -19000 && plan.tickUpper! > -19000).toBe(true)
    expect(plan.priceLower!).toBeCloseTo(140, 0)
    expect(plan.signers).toHaveLength(1)
    const nft = plan.signers[0]?.address as string
    expect(plan.positionMint).toBe(nft)
    const ix = plan.steps[plan.steps.length - 1]?.instructions.find((x) => x.programId === RAYDIUM_CLMM_PROGRAM_ID)
    expect(ix?.keys[2]).toEqual({ pubkey: nft, isSigner: true, isWritable: true })
    expect(ix?.keys[3]?.pubkey).toBe(getAssociatedTokenAddress(USER.address, nft, TOKEN_2022_PROGRAM_ID))
    expect(ix?.keys[8]?.pubkey).toBe(findProgramAddress([new TextEncoder().encode('position'), decodeAddress(nft)], RAYDIUM_CLMM_PROGRAM_ID))
    const b = new Bytes(ix?.data as Uint8Array)
    expect([b.i32(8), b.i32(12)]).toEqual([plan.tickLower, plan.tickUpper])
    // tick 数组起点：tickSpacing × 60 的整数倍
    expect(b.i32(16) % 600 === 0).toBe(true)
    expect(b.u128(24).toString()).toBe(plan.liquidity)
    expect([b.u64(40), b.u64(48)].map(String)).toEqual([plan.amount0Max, plan.amount1Max])
    expect(ix?.data.length).toBe(8 + 16 + 16 + 16 + 3)
    // 给了 1 SOL：预计用掉的 SOL 不超过 1，上限按滑点上浮
    expect(BigInt(plan.amount0) <= SOL && BigInt(plan.amount0Max as string) > BigInt(plan.amount0)).toBe(true)
  })

  it('区间在当前价格之外：只能给需要的那种代币', async () => {
    const { client } = clmmSetup(-19000)
    await expect(buildAddLiquidity(client, USER.address, { protocol: 'raydium-clmm', pool: CLMM_POOL, priceLower: 100, priceUpper: 120, amount0Formatted: '1' })).rejects.toThrow(
      /above the range.*USDC|takes only/,
    )
    await expect(buildAddLiquidity(client, USER.address, { protocol: 'raydium-clmm', pool: CLMM_POOL, tickLower: -15, tickUpper: 10, amount0: 1n })).rejects.toThrow(/multiple of tickSpacing/)
  })
})
