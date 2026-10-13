/**
 * LP 仓位：连真实节点核对计算结果，默认跳过：`LIVE=1 npx vitest run test/lp-live.test.ts`
 *
 * V3：从仓位合约里取最近的一批仓位 NFT，以仓位所有者的身份预执行 decreaseLiquidity（撤出全部流动性能拿到的数量）
 * 和 collect（能领取的手续费），与 lpPositions 算出来的逐位比对
 */
import { Contract, JsonRpcProvider } from 'ethers'
import { describe, expect, it } from 'vitest'

import { Provider, TRON_CHAIN_ID } from '../src/index.js'
import { LP_PROTOCOLS, lpPositions, type LpConcentratedPosition } from '../src/subpaths/lp.js'

const live = process.env.LIVE ? describe : describe.skip

const RPC: Record<number, string> = {
  1: process.env.ETH_RPC ?? 'https://ethereum-rpc.publicnode.com',
  56: process.env.BSC_RPC ?? 'https://bsc-dataseed.bnbchain.org',
  8453: process.env.BASE_RPC ?? 'https://mainnet.base.org',
}

const NPM_ABI = [
  'function totalSupply() view returns (uint256)',
  'function tokenByIndex(uint256 index) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)',
]
const MAX_UINT128 = 2n ** 128n - 1n

/** 最近铸造的、还有流动性的仓位的所有者（最多 count 个，去重） */
async function recentOwners(rpc: JsonRpcProvider, npmAddress: string, count: number): Promise<string[]> {
  const npm = new Contract(npmAddress, NPM_ABI, rpc)
  const total = (await npm.getFunction('totalSupply')()) as bigint
  const owners = new Set<string>()
  for (let i = total - 1n; i >= 0n && owners.size < count && i > total - 60n; i--) {
    const tokenId = (await npm.getFunction('tokenByIndex')(i)) as bigint
    const position = await npm.getFunction('positions')(tokenId)
    if ((position.liquidity as bigint) === 0n) {
      continue
    }
    owners.add(((await npm.getFunction('ownerOf')(tokenId)) as string).toLowerCase())
  }
  return [...owners]
}

async function checkV3(chainId: number, protocolId: string) {
  const rpc = new JsonRpcProvider(RPC[chainId], chainId, { staticNetwork: true })
  const protocol = LP_PROTOCOLS.find((p) => p.chainId === chainId && p.id === protocolId)
  if (!protocol?.positionManager) {
    throw new Error(`no ${protocolId} on ${chainId}`)
  }
  const multi = new Provider(chainId, rpc)
  const npm = new Contract(protocol.positionManager, NPM_ABI, rpc)
  const owners = await recentOwners(rpc, protocol.positionManager, 3)
  expect(owners.length).toBeGreaterThan(0)

  let checked = 0
  for (const owner of owners) {
    // 固定区块：链上状态在比对期间不变
    const blockTag = await rpc.getBlockNumber()
    const positions = (await lpPositions(multi, owner, { protocols: [protocolId], blockTag, maxPositions: 50 })) as LpConcentratedPosition[]
    for (const p of positions.slice(0, 5)) {
      const decrease = npm.getFunction('decreaseLiquidity')
      const collect = npm.getFunction('collect')
      const [amount0, amount1] = (await decrease.staticCall({ tokenId: p.tokenId, liquidity: p.liquidity, amount0Min: 0, amount1Min: 0, deadline: 2n ** 63n }, { from: owner, blockTag })) as [bigint, bigint]
      const [fees0, fees1] = (await collect.staticCall({ tokenId: p.tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }, { from: owner, blockTag })) as [bigint, bigint]
      expect({ tokenId: p.tokenId, amount0: p.amount0, amount1: p.amount1 }).toEqual({ tokenId: p.tokenId, amount0: amount0.toString(), amount1: amount1.toString() })
      // 手续费：仓位合约按每个仓位单独取整记账，池子按同一区间合并记账，实际能领的可能少几 wei（舍入零头）
      const close = (mine: string, chain: bigint) => BigInt(mine) >= chain && BigInt(mine) - chain <= 10n
      expect({ tokenId: p.tokenId, fees0: close(p.fees0, fees0), fees1: close(p.fees1, fees1) }).toEqual({ tokenId: p.tokenId, fees0: true, fees1: true })
      expect(p.token0.symbol).toBeTruthy()
      checked++
    }
  }
  expect(checked).toBeGreaterThan(0)
  return checked
}

live('LP 仓位（V3）：与合约预执行的结果逐位一致', () => {
  it('BSC PancakeSwap V3', async () => {
    console.log('checked', await checkV3(56, 'pancakeswap-v3'))
  }, 120_000)

  it('BSC Uniswap V3', async () => {
    console.log('checked', await checkV3(56, 'uniswap-v3'))
  }, 120_000)

  it('Ethereum Uniswap V3', async () => {
    console.log('checked', await checkV3(1, 'uniswap-v3'))
  }, 120_000)

  it('Base Uniswap V3', async () => {
    console.log('checked', await checkV3(8453, 'uniswap-v3'))
  }, 120_000)
})

live('LP 仓位（V2）', () => {
  it('BSC：从最近的 Transfer 事件里找一个 WBNB-USDT LP 的持有人，按计价币之间的组合就能找到它的 LP', async () => {
    const rpc = new JsonRpcProvider(process.env.BSC_LOGS_RPC ?? 'https://bsc-rpc.publicnode.com', 56, { staticNetwork: true })
    const factory = new Contract('0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73', ['function getPair(address, address) view returns (address)'], rpc)
    const pair = (await factory.getFunction('getPair')('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', '0x55d398326f99059fF775485246999027B3197955')) as string
    const lp = new Contract(pair, ['function balanceOf(address) view returns (uint256)'], rpc)
    const latest = await rpc.getBlockNumber()
    let holder: string | null = null
    for (let from = latest - 3000; from < latest && !holder; from += 500) {
      const logs = await rpc.getLogs({ address: pair, fromBlock: from, toBlock: from + 499, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'] })
      for (const log of logs) {
        const to = `0x${(log.topics[2] as string).slice(26)}`
        if (((await lp.getFunction('balanceOf')(to)) as bigint) > 0n && to !== pair.toLowerCase()) {
          holder = to
          break
        }
      }
    }
    expect(holder).not.toBeNull()

    const multi = new Provider(56, rpc)
    const positions = await lpPositions(multi, holder as string, { versions: ['v2'], prices: true })
    const wbnbUsdt = positions.find((p) => p.pool === pair.toLowerCase())
    expect(wbnbUsdt?.version).toBe('v2')
    expect(wbnbUsdt?.protocol).toBe('pancakeswap-v2')
    expect([wbnbUsdt?.token0.symbol, wbnbUsdt?.token1.symbol].sort()).toEqual(['USDT', 'WBNB'])
    expect(Number(wbnbUsdt?.amount0Formatted)).toBeGreaterThan(0)
    expect(wbnbUsdt?.valueUsd).toBeGreaterThan(0)
    console.log(holder, positions.map((p) => `${p.protocol} ${p.token0.symbol}/${p.token1.symbol} ${p.amount0Formatted} + ${p.amount1Formatted} ≈ $${p.valueUsd?.toFixed(2)}`).join('\n'))
  }, 120_000)
})

live('LP 仓位（V4）', () => {
  const PM_ABI = [
    'function nextTokenId() view returns (uint256)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
    'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  ]

  async function checkV4(chainId: number, rpcUrl: string) {
    const rpc = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true })
    const protocol = LP_PROTOCOLS.find((p) => p.chainId === chainId && p.id === 'uniswap-v4')
    const pm = new Contract(protocol?.positionManager as string, PM_ABI, rpc)
    const next = (await pm.getFunction('nextTokenId')()) as bigint
    // 最近铸造的、还有流动性的仓位
    let tokenId: bigint | null = null
    let owner = ''
    for (let id = next - 1n; id > next - 40n; id--) {
      try {
        if (((await pm.getFunction('getPositionLiquidity')(id)) as bigint) > 0n) {
          tokenId = id
          owner = (await pm.getFunction('ownerOf')(id)) as string
          break
        }
      } catch {
        // 已销毁
      }
    }
    expect(tokenId).not.toBeNull()
    const multi = new Provider(chainId, rpc)
    const positions = (await lpPositions(multi, owner, { versions: ['v4'], v4: { tokenIds: [tokenId as bigint] } })) as LpConcentratedPosition[]
    const p = positions.find((x) => x.tokenId === (tokenId as bigint).toString())
    expect(p?.version).toBe('v4')
    // poolId：自己算的 keccak(PoolKey) 与仓位信息里存的 poolId（高 200 位）一致
    const [, info] = (await pm.getFunction('getPoolAndPositionInfo')(tokenId)) as [unknown, bigint]
    expect(BigInt(p?.pool as string) >> 56n).toBe(info >> 56n)
    // 仓位流动性与仓位合约一致（说明 StateView 里按 salt = tokenId 找到的是这个仓位）
    expect(p?.liquidity).toBe(((await pm.getFunction('getPositionLiquidity')(tokenId)) as bigint).toString())
    expect(p?.token0.symbol).toBeTruthy()
    console.log(chainId, p?.tokenId, `${p?.token0.symbol}/${p?.token1.symbol}`, p?.amount0Formatted, p?.amount1Formatted, 'fees', p?.fees0Formatted, p?.fees1Formatted, 'fee', p?.fee, 'inRange', p?.inRange)

    // 扫描：从最近 5000 个区块开始，能找到这个仓位
    const latest = await rpc.getBlockNumber()
    const scanned = (await lpPositions(multi, owner, { versions: ['v4'], v4: { scan: { fromBlock: latest - 5000, blockRange: 500, maxRequests: 20, timeBudget: 30_000 } } })) as LpConcentratedPosition[]
    console.log('scan found', scanned.map((x) => x.tokenId))
  }

  it('Base', async () => {
    await checkV4(8453, process.env.BASE_LOGS_RPC ?? 'https://base-rpc.publicnode.com')
  }, 120_000)

  it('BSC', async () => {
    await checkV4(56, process.env.BSC_LOGS_RPC ?? 'https://bsc-rpc.publicnode.com')
  }, 120_000)
})

live('LP 仓位（Tron SunSwap V3）', () => {
  it('与合约预执行的 decreaseLiquidity / collect 逐位一致；地址是 T 格式', async () => {
    const multi = new Provider(TRON_CHAIN_ID.mainnet)
    const npm = multi.contract('TLSWrv7eC1AZCXkRjpqMZUmvgd99cj7pPF', NPM_ABI)
    const total = (await npm.totalSupply()) as bigint
    let checked = 0
    for (let i = total - 1n; i > total - 40n && checked < 3; i--) {
      const id = (await npm.tokenByIndex(i)) as bigint
      const position = await npm.positions(id)
      if ((position.liquidity as bigint) === 0n) {
        continue
      }
      const owner = (await npm.ownerOf(id)) as string
      const list = (await lpPositions(multi, owner, { protocols: ['sunswap-v3'], maxPositions: 50 })) as LpConcentratedPosition[]
      const p = list.find((x) => x.tokenId === id.toString())
      expect(p).toBeDefined()
      const [amount0, amount1] = await npm.decreaseLiquidity.staticCall({ tokenId: id, liquidity: position.liquidity, amount0Min: 0, amount1Min: 0, deadline: 2n ** 40n }, { from: owner })
      const [fees0, fees1] = await npm.collect.staticCall({ tokenId: id, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }, { from: owner })
      expect([p?.amount0, p?.amount1]).toEqual([amount0.toString(), amount1.toString()])
      expect(BigInt(p?.fees0 as string) - fees0 <= 10n && BigInt(p?.fees1 as string) - fees1 <= 10n).toBe(true)
      expect(p?.pool.startsWith('T')).toBe(true)
      expect(p?.token0.address.startsWith('T')).toBe(true)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  }, 120_000)
})
