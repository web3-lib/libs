/**
 * 添加 / 移除流动性：在主网分叉上真实发交易核对，默认跳过。
 *
 * ```sh
 * anvil --fork-url https://mainnet.base.org --port 18545
 * FORK_RPC=http://127.0.0.1:18545 npx vitest run test/liquidity-fork.test.ts
 * ```
 *
 * 用一个随机钱包（anvil_setBalance 给 100 ETH），先换一些 USDC，再在 Uniswap V2 / V3 / V4、PancakeSwap V3 上
 * 新建仓位、追加、领取、移除，逐项核对链上结果与计划里的数量（流动性逐位一致，代币数量不少于最小值）
 */
import { Contract, JsonRpcProvider, Wallet } from 'ethers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { NATIVE_TOKEN, Provider } from '../src/index.js'
import { addLiquidity, buildAddLiquidity, buildRemoveLiquidity, collectFees, removeLiquidity } from '../src/subpaths/liquidity.js'
import { lpPositions, type LpConcentratedPosition, type LpV2Position } from '../src/subpaths/lp.js'

const fork = process.env.FORK_RPC ? describe : describe.skip

// 随机的新钱包（anvil 的默认测试账户在主网上被人设了 EIP-7702 委托，收到的 ETH 会被转走）
const KEY = Wallet.createRandom().privateKey
const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const SWAP_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481'
const UNI_V3_NPM = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1'
const V4_PM = '0x7c5f5a4bbd8fd63184577525326123b519429bdc'

const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address, uint256) returns (bool)']
const NPM = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]
const PM = ['function getPositionLiquidity(uint256 tokenId) view returns (uint128)', 'function ownerOf(uint256 tokenId) view returns (address)']

fork('添加 / 移除流动性（Base 分叉）', () => {
  let rpc: JsonRpcProvider
  let multi: Provider
  let wallet: Wallet
  let owner: string
  let snapshot: string
  const send = { pollInterval: 100, slippage: 0.01 }

  const balance = async (token: string) => (token === NATIVE_TOKEN ? rpc.getBalance(owner) : ((await new Contract(token, ERC20, rpc).getFunction('balanceOf')(owner)) as bigint))

  beforeAll(async () => {
    rpc = new JsonRpcProvider(process.env.FORK_RPC, 8453, { staticNetwork: true })
    multi = new Provider(8453, rpc)
    wallet = new Wallet(KEY, rpc)
    owner = wallet.address
    // 测试结束后恢复分叉状态，重复运行结果一样
    snapshot = (await rpc.send('evm_snapshot', [])) as string
    await rpc.send('anvil_setBalance', [owner, `0x${(100n * 10n ** 18n).toString(16)}`])
    // 换 2000 美元左右的 USDC（V3 的 WETH / USDC 0.05% 池子）
    const router = new Contract(
      SWAP_ROUTER,
      ['function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256)'],
      wallet,
    )
    if ((await balance(USDC)) < 1000n * 10n ** 6n) {
      const tx = await router.getFunction('exactInputSingle')(
        { tokenIn: WETH, tokenOut: USDC, fee: 500, recipient: owner, amountIn: 10n ** 18n, amountOutMinimum: 0, sqrtPriceLimitX96: 0 },
        { value: 10n ** 18n },
      )
      await tx.wait()
    }
    expect(await balance(USDC)).toBeGreaterThan(1000n * 10n ** 6n)
  }, 60_000)

  afterAll(async () => {
    if (snapshot) {
      await rpc.send('evm_revert', [snapshot])
    }
  })

  it('V2：主币 + USDC 添加，再按比例移除', async () => {
    const plan = await buildAddLiquidity(multi, owner, { protocol: 'uniswap-v2', tokenA: NATIVE_TOKEN, tokenB: USDC, amountAFormatted: '0.05' }, send)
    expect(plan.native).toBe('token0') // WETH (0x42…) < USDC (0x83…)
    expect(plan.value).toBe(plan.amount0Max) // 附带 desired，Router 用掉 amount0、退回零头
    expect(plan.transactions.map((t) => t.kind)).toEqual(expect.arrayContaining(['add']))

    const result = await addLiquidity(multi, KEY, { protocol: 'uniswap-v2', tokenA: NATIVE_TOKEN, tokenB: USDC, amountAFormatted: '0.05' }, send)
    expect(result.status).toBe('confirmed')
    expect(result.results.every((r) => r.status === 'confirmed')).toBe(true)

    const [position] = (await lpPositions(multi, owner, { protocols: ['uniswap-v2'], tokens: [USDC] })) as LpV2Position[]
    expect(position).toBeTruthy()
    // 预计的 LP 数量（已按协议手续费先给 feeTo 增发的总量算）与实际铸造的逐位一致
    expect(position?.balance).toBe(result.plan.liquidity)

    const before = await balance(NATIVE_TOKEN)
    const removed = await removeLiquidity(multi, KEY, { position: position as LpV2Position, percent: 50 }, { ...send, native: true })
    expect(removed.status).toBe('confirmed')
    expect(removed.results.map((r) => r.kind)).toEqual(['approve', 'remove'])
    expect(removed.plan.native).toBe('token0')
    // 收到了主币（扣掉手续费后仍然增加）
    expect(await balance(NATIVE_TOKEN)).toBeGreaterThan(before)
    const [after] = (await lpPositions(multi, owner, { protocols: ['uniswap-v2'], tokens: [USDC] })) as LpV2Position[]
    expect(BigInt(after?.balance as string)).toBe(BigInt(position?.balance as string) - BigInt(removed.plan.liquidity))
  }, 120_000)

  it('V3：新建仓位（主币）→ 追加 USDC → 全部移除并销毁', async () => {
    const npm = new Contract(UNI_V3_NPM, NPM, rpc)
    // 当前价格附近 ±10%
    const quote = await buildAddLiquidity(multi, owner, { protocol: 'uniswap-v3', tokenA: NATIVE_TOKEN, tokenB: USDC, fee: 500, fullRange: true, amountAFormatted: '0.01' }, send)
    const price = quote.price as number // USDC / WETH
    const params = { protocol: 'uniswap-v3', tokenA: NATIVE_TOKEN, tokenB: USDC, fee: 500, priceLower: price * 0.9, priceUpper: price * 1.1, amountAFormatted: '0.05' }
    const minted = await addLiquidity(multi, KEY, params, send)
    expect(minted.status).toBe('confirmed')
    expect(minted.tokenId).toMatch(/^\d+$/)
    const tokenId = BigInt(minted.tokenId as string)
    const p1 = await npm.getFunction('positions')(tokenId)
    // 流动性逐位一致；区间按可用 tick 取整后包含当前价格
    expect(p1.liquidity).toBe(BigInt(minted.plan.liquidity))
    expect(Number(p1.tickLower)).toBe(minted.plan.tickLower)
    expect(Number(p1.tickUpper)).toBe(minted.plan.tickUpper)
    expect(minted.plan.tickLower as number).toBeLessThan(minted.plan.tick as number)

    // 追加：只给 USDC，另一边按价格算
    const increased = await addLiquidity(multi, KEY, { position: { protocol: 'uniswap-v3', tokenId }, amount1Formatted: '50' }, { ...send, native: true })
    expect(increased.status).toBe('confirmed')
    const p2 = await npm.getFunction('positions')(tokenId)
    expect(p2.liquidity - p1.liquidity).toBe(BigInt(increased.plan.liquidity))
    expect(increased.plan.native).toBe('token0')
    expect(increased.results[increased.results.length - 1]?.kind).toBe('add')

    // 用查询结果直接移除：全部移除、领取、换回主币、销毁 NFT
    const positions = (await lpPositions(multi, owner, { protocols: ['uniswap-v3'] })) as LpConcentratedPosition[]
    const position = positions.find((p) => p.tokenId === tokenId.toString()) as LpConcentratedPosition
    expect(position).toBeTruthy()
    const usdcBefore = await balance(USDC)
    const removed = await removeLiquidity(multi, KEY, { position, burn: true }, { ...send, native: true })
    expect(removed.status).toBe('confirmed')
    expect(removed.plan.liquidity).toBe(p2.liquidity.toString())
    expect((await balance(USDC)) - usdcBefore).toBeGreaterThanOrEqual(BigInt(removed.plan.amount1Min as string))
    await expect(npm.getFunction('ownerOf')(tokenId)).rejects.toThrow()
  }, 180_000)

  it('V3：PancakeSwap 新建仓位（代币对代币），部分移除，再领取手续费', async () => {
    // WETH / USDC 都用代币：先包装一点 WETH
    const weth = new Contract(WETH, ['function deposit() payable'], wallet)
    await (await weth.getFunction('deposit')({ value: 10n ** 17n })).wait()
    const minted = await addLiquidity(multi, KEY, { protocol: 'pancakeswap-v3', tokenA: USDC, tokenB: WETH, fee: 500, fullRange: true, amountAFormatted: '100' }, send)
    expect(minted.status).toBe('confirmed')
    // 两个代币都要授权给仓位合约
    expect(minted.results.filter((r) => r.kind === 'approve').length).toBeGreaterThanOrEqual(1)
    const tokenId = minted.tokenId as string
    const removed = await removeLiquidity(multi, KEY, { position: { protocol: 'pancakeswap-v3', tokenId }, percent: 25 }, send)
    expect(removed.status).toBe('confirmed')
    expect(BigInt(removed.plan.liquidity)).toBe(BigInt(minted.plan.liquidity) / 4n)
    // 刚建的仓位没有手续费：领取会报错（不发交易）
    await expect(collectFees(multi, KEY, { position: { protocol: 'pancakeswap-v3', tokenId } }, send)).rejects.toThrow(/no fees/)
  }, 180_000)

  it('V4：新建主币池子的仓位 → 追加 → 部分移除 → 全部移除并销毁', async () => {
    const pm = new Contract(V4_PM, PM, rpc)
    const quote = await buildAddLiquidity(multi, owner, { protocol: 'uniswap-v4', tokenA: NATIVE_TOKEN, tokenB: USDC, fee: 500, fullRange: true, amountAFormatted: '0.01' }, send)
    expect(quote.createPool).toBe(false)
    expect(quote.native).toBe('token0')
    const price = quote.price as number
    const minted = await addLiquidity(
      multi,
      KEY,
      { protocol: 'uniswap-v4', tokenA: USDC, tokenB: NATIVE_TOKEN, fee: 500, priceLower: 1 / (price * 1.2), priceUpper: 1 / (price * 0.8), amountAFormatted: '100' },
      send,
    )
    expect(minted.status).toBe('confirmed')
    // USDC：approve 给 Permit2，再在 Permit2 里授权
    expect(minted.results.map((r) => r.kind)).toEqual(['approve', 'permit2', 'add'])
    const tokenId = BigInt(minted.tokenId as string)
    expect(await pm.getFunction('getPositionLiquidity')(tokenId)).toBe(BigInt(minted.plan.liquidity))

    const increased = await addLiquidity(multi, KEY, { position: { positionManager: V4_PM, tokenId }, amount0Formatted: '0.01' }, send)
    expect(increased.status).toBe('confirmed')
    const total = BigInt(minted.plan.liquidity) + BigInt(increased.plan.liquidity)
    expect(await pm.getFunction('getPositionLiquidity')(tokenId)).toBe(total)

    const half = await removeLiquidity(multi, KEY, { position: { protocol: 'uniswap-v4', tokenId }, percent: 50 }, send)
    expect(half.status).toBe('confirmed')
    expect(await pm.getFunction('getPositionLiquidity')(tokenId)).toBe(total - BigInt(half.plan.liquidity))

    const ethBefore = await balance(NATIVE_TOKEN)
    const all = await removeLiquidity(multi, KEY, { position: { protocol: 'uniswap-v4', tokenId }, burn: true }, send)
    expect(all.status).toBe('confirmed')
    expect(await balance(NATIVE_TOKEN)).toBeGreaterThan(ethBefore)
    await expect(pm.getFunction('ownerOf')(tokenId)).rejects.toThrow()
  }, 180_000)

  it('移除别人的仓位：构建时就报错', async () => {
    const positions = (await lpPositions(multi, owner, { protocols: ['uniswap-v3'], includeClosed: true })) as LpConcentratedPosition[]
    const someone = '0x000000000000000000000000000000000000dEaD'
    if (positions[0]) {
      await expect(buildRemoveLiquidity(multi, someone, { position: positions[0] })).rejects.toThrow(/not the owner/)
    }
  })
})
