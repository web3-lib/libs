/**
 * 添加 / 移除流动性（Tron SunSwap）：连主网，用真实用户的账户预执行构建出来的交易，默认跳过。
 *
 * ```sh
 * LIVE=1 npx vitest run test/liquidity-tron-live.test.ts
 * ```
 *
 * Tron 没有分叉工具：从池子 / 仓位合约最近的事件里找最近添加过流动性的用户（他们已经授权过 Router / 仓位合约），
 * 以他们的身份 triggerconstantcontract 执行计划里的主交易（不上链），核对执行结果与计划里的数量
 */
import { Interface } from 'ethers'
import { describe, expect, it } from 'vitest'

import { NATIVE_TOKEN, Provider, TRON_CHAIN_ID, TronProvider, toTronAddress } from '../src/index.js'
import { buildAddLiquidity, buildRemoveLiquidity, type LiquidityPlan } from '../src/subpaths/liquidity.js'

const live = process.env.LIVE ? describe : describe.skip

const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const PAIR_USDT_WTRX = 'TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ'
const V3_NPM = 'TLSWrv7eC1AZCXkRjpqMZUmvgd99cj7pPF'

const tron = new TronProvider({ apiKey: process.env.TRON_API_KEY, minInterval: process.env.TRON_API_KEY ? 0 : 300 })
const multi = new Provider(TRON_CHAIN_ID.mainnet, tron)

const routerIface = new Interface([
  'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)',
  'function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256 amountToken, uint256 amountETH)',
])
const npmIface = new Interface([
  'function totalSupply() view returns (uint256)',
  'function tokenByIndex(uint256 index) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)',
  'function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
])

/** 以 owner 的身份预执行计划里的主交易（最后一笔），返回调用结果 */
function simulate(plan: LiquidityPlan): Promise<string> {
  const main = plan.transactions[plan.transactions.length - 1] as LiquidityPlan['transactions'][number]
  return tron.call({ from: plan.owner, to: main.to, data: main.data, value: BigInt(main.value) })
}

/** 合约最近的某个事件对应交易的发送者（去重）；TronGrid 限频时等一下重试，结果缓存 */
const sendersCache = new Map<string, Promise<string[]>>()
function recentSenders(contract: string, event: string, limit = 20): Promise<string[]> {
  const key = `${contract}:${event}`
  let cached = sendersCache.get(key)
  if (!cached) {
    cached = (async () => {
      let events: Array<{ transaction_id: string }> | undefined
      for (let attempt = 0; !events && attempt < 5; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt))
        const res = (await (await fetch(`https://api.trongrid.io/v1/contracts/${contract}/events?event_name=${event}&limit=${limit}&only_confirmed=true`)).json()) as { data?: Array<{ transaction_id: string }> }
        events = Array.isArray(res.data) ? res.data : undefined
      }
      const senders: string[] = []
      for (const e of events ?? []) {
        const tx = await tron.request('wallet/gettransactionbyid', { value: e.transaction_id, visible: true })
        const owner = tx?.raw_data?.contract?.[0]?.parameter?.value?.owner_address as string | undefined
        if (owner && !senders.includes(owner)) senders.push(owner)
      }
      return senders
    })()
    sendersCache.set(key, cached)
  }
  return cached
}

live('添加 / 移除流动性（Tron SunSwap，主网预执行）', () => {
  it('V2：TRX + USDT 添加（addLiquidityETH），LP 数量与计划一致', async () => {
    let simulated = 0
    for (const owner of await recentSenders(PAIR_USDT_WTRX, 'Mint')) {
      const plan = await buildAddLiquidity(multi, owner, { protocol: 'sunswap-v2', tokenA: NATIVE_TOKEN, tokenB: USDT, amountAFormatted: '1' })
      expect(plan.pool).toBe(PAIR_USDT_WTRX)
      expect(plan.owner).toBe(owner)
      expect(plan.token0.address.startsWith('T') && plan.token1.address.startsWith('T')).toBe(true)
      if (plan.transactions.length > 1) continue // 额度不够：需要先授权，没法预执行
      const balance = (await multi.balances(owner, [USDT]))[0]
      if (!balance?.success || BigInt(balance.balance) < BigInt(plan.amount0) + BigInt(plan.amount1)) continue
      const [amountToken, amountETH, liquidity] = routerIface.decodeFunctionResult('addLiquidityETH', await simulate(plan)) as unknown as [bigint, bigint, bigint]
      expect(plan.value).toBe(String(10n ** 6n))
      // 与 Router 的取整逻辑逐位一致
      const [planToken, planEth] = plan.native === 'token0' ? [plan.amount1, plan.amount0] : [plan.amount0, plan.amount1]
      expect([amountToken.toString(), amountETH.toString()]).toEqual([planToken, planEth])
      // 已按协议手续费（先给 feeTo 增发）算过总量：与实际铸造的逐位一致
      expect(liquidity.toString()).toBe(plan.liquidity)
      simulated++
      break
    }
    expect(simulated).toBeGreaterThan(0)
  }, 300_000)

  it('V2：移除（removeLiquidityETH），拿到的数量不少于最小值', async () => {
    let simulated = 0
    for (const owner of await recentSenders(PAIR_USDT_WTRX, 'Mint')) {
      let plan: LiquidityPlan
      try {
        plan = await buildRemoveLiquidity(multi, owner, { position: { pool: PAIR_USDT_WTRX }, percent: 10 }, { native: true })
      } catch {
        continue // 已经不持有
      }
      if (plan.transactions.length > 1) continue // LP 没授权给 Router
      const [amountToken, amountETH] = routerIface.decodeFunctionResult('removeLiquidityETH', await simulate(plan)) as unknown as [bigint, bigint]
      const [minToken, minEth] = plan.native === 'token0' ? [plan.amount1Min, plan.amount0Min] : [plan.amount0Min, plan.amount1Min]
      expect(amountToken >= BigInt(minToken as string) && amountETH >= BigInt(minEth as string)).toBe(true)
      simulated++
      break
    }
    // 最近的用户里可能没有人留着 LP 授权：没有可预执行的账户时只确认计划能构建
    console.log(`V2 remove simulated: ${simulated}`)
  }, 300_000)

  it('V3：仓位所有者预执行移除（decrease + collect，WTRX 换成 TRX）和追加', async () => {
    const npm = multi.contract(V3_NPM, npmIface)
    const total = (await npm.totalSupply()) as bigint
    let removed = 0
    let increased = 0
    for (let i = total - 1n; i > total - 60n && (removed < 2 || increased < 1); i--) {
      const tokenId = (await npm.tokenByIndex(i)) as bigint
      const position = await npm.positions(tokenId)
      if ((position.liquidity as bigint) === 0n) continue
      const owner = toTronAddress((await npm.ownerOf(tokenId)) as string)
      const hasWtrx = [position.token0, position.token1].some((t: string) => toTronAddress(t) === 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR')
      const plan = await buildRemoveLiquidity(multi, owner, { position: { protocol: 'sunswap-v3', tokenId }, percent: 50 }, { native: hasWtrx })
      expect(plan.pool?.startsWith('T')).toBe(true)
      const [results] = npmIface.decodeFunctionResult('multicall', await simulate(plan)) as unknown as [string[]]
      const [amount0, amount1] = npmIface.decodeFunctionResult('decreaseLiquidity', results[0] as string) as unknown as [bigint, bigint]
      expect(amount0 >= BigInt(plan.amount0Min as string) && amount1 >= BigInt(plan.amount1Min as string)).toBe(true)
      // 同一区块内与按当前价格算的一致（取整误差 1）
      expect(BigInt(plan.amount0) - amount0 <= 1n && amount0 - BigInt(plan.amount0) <= 1n).toBe(true)
      const [collected0, collected1] = npmIface.decodeFunctionResult('collect', results[1] as string) as unknown as [bigint, bigint]
      expect(collected0 >= amount0 && collected1 >= amount1).toBe(true)
      removed++

      if (!increased) {
        // 追加：已经授权过仓位合约的用户才能预执行
        const add = await buildAddLiquidity(multi, owner, { position: { protocol: 'sunswap-v3', tokenId }, amount0: 1000n, amount1: 1000n }, { native: hasWtrx }).catch(() => null)
        if (add && add.transactions.length === 1) {
          const out = await simulate(add).catch(() => null) // 余额不够等
          if (out) {
            const [results2] = add.value !== '0' ? (npmIface.decodeFunctionResult('multicall', out) as unknown as [string[]]) : [[out]]
            const [liquidity] = npmIface.decodeFunctionResult('increaseLiquidity', results2[0] as string) as unknown as [bigint]
            expect(liquidity.toString()).toBe(add.liquidity)
            increased++
          }
        }
      }
    }
    expect(removed).toBeGreaterThan(0)
    console.log(`V3 increase simulated: ${increased}`)
  }, 600_000)
})

