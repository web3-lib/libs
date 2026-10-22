import { Interface } from 'ethers'

import type { CallOverrides } from '../aggregate.js'
import type { Call } from '../call.js'
import { evm, fmt, same, tokenInfo, type Ctx } from '../liquidity/common.js'
import { lpPositionsByIds, type LpConcentratedPosition, type LpProtocol } from '../lp.js'
import type { Provider, StaticCallItem, StaticCallResult } from '../provider.js'
import { withSignal } from '../util.js'
import { mapPool } from '../write/send.js'
import type { ClaimAmount, ClaimItem, FarmProtocol } from './types.js'

const masterChef = (chainId: number, address: string): FarmProtocol => ({
  id: 'pancakeswap-v3',
  name: 'PancakeSwap V3 Farm',
  kind: 'masterchef-v3',
  chainId,
  positionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
  masterChef: address,
})

/**
 * 内置的挖矿合约（2026-10 在链上逐个核对：合约有代码，MasterChefV3 的 CAKE / nonfungiblePositionManager / poolLength、
 * Voter 的 length / pools / gauges 能读，CLGauge 的 stakedValues / earned 能读）。
 * Uniswap V3 的激励（UniswapV3Staker）按 IncentiveKey 领取，key 不能从链上按用户列出，不在表里
 */
export const FARM_PROTOCOLS: readonly FarmProtocol[] = [
  masterChef(56, '0x556B9306565093C855AEA9AE92A594704c2Cd59e'),
  masterChef(1, '0x556B9306565093C855AEA9AE92A594704c2Cd59e'),
  masterChef(8453, '0xC6A2Db661D5a5690172d8eB0a7DEA2d3008665A3'),
  masterChef(42161, '0x5e09ACf80C0296740eC5d6F643005a4ef8DaA694'),
  {
    id: 'aerodrome-slipstream',
    name: 'Aerodrome Slipstream',
    kind: 'gauge',
    chainId: 8453,
    positionManager: '0x827922686190790b37229fd06084350E74485b72',
    voter: '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5',
  },
  {
    id: 'velodrome-slipstream',
    name: 'Velodrome Slipstream',
    kind: 'gauge',
    chainId: 10,
    positionManager: '0x416b433906b1B72FA758e166e239c43d68dC6F29',
    voter: '0x41C914ee0c7E1A5edCD0295623e6dC557B5aBf3C',
  },
]

export const masterChefInterface = new Interface([
  'function CAKE() view returns (address)',
  'function balanceOf(address user) view returns (uint256)',
  'function tokenOfOwnerByIndex(address user, uint256 index) view returns (uint256)',
  'function pendingCake(uint256 tokenId) view returns (uint256)',
  'function harvest(uint256 tokenId, address to) returns (uint256 reward)',
  'function collectTo((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params, address to) returns (uint256 amount0, uint256 amount1)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
])
export const gaugeInterface = new Interface(['function getReward(uint256 tokenId)'])

const voterAbi = ['function length() view returns (uint256)', 'function pools(uint256 index) view returns (address)', 'function gauges(address pool) view returns (address)']
const gaugeAbi = ['function stakedValues(address depositor) view returns (uint256[])', 'function earned(address account, uint256 tokenId) view returns (uint256)', 'function rewardToken() view returns (address)']

const CHUNK = 400
/** 每个 Voter 最多枚举多少个池子（Aerodrome 目前两千多个） */
const MAX_POOLS = 6000

/** harvest 预执行：每条一个 eth_call，分批并发（受限节点上一次几百个会被限流） */
const HARVEST_CHUNK = 25

const chunks = <T>(list: readonly T[]): T[][] => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK))

async function staticCallChunked(provider: Provider, items: readonly StaticCallItem[]): Promise<StaticCallResult<bigint>[]> {
  const parts = Array.from({ length: Math.ceil(items.length / HARVEST_CHUNK) }, (_, i) => items.slice(i * HARVEST_CHUNK, (i + 1) * HARVEST_CHUNK))
  return (await mapPool(parts, 2, (part) => provider.staticCallAll<bigint>(part))).flat()
}

/** 分批 tryAll：一次 multicall 不塞太多调用 */
async function tryAllChunked<T>(provider: Provider, calls: readonly Call[], overrides: CallOverrides): Promise<(T | null)[]> {
  return (await Promise.all(chunks(calls).map((part) => provider.tryAll<T>(part, overrides)))).flat()
}

// Voter 枚举出的 gauge 列表（几乎不变）：按 Provider（即按链）+ Voter 缓存 1 小时，只缓存最新状态的结果。
// 共享的查询不带调用方的 signal / minBlock（否则第一个调用方取消会让其他等着的调用方一起失败），调用方各自按自己的 signal 取消等待
const gaugeCache = new WeakMap<Provider, Map<string, { at: number; gauges: Promise<string[]> }>>()
const GAUGE_TTL = 3_600_000

async function enumerateGauges(provider: Provider, voter: string, overrides: CallOverrides): Promise<string[]> {
  const v = provider.contract(voter, voterAbi)
  const length = Math.min(Number(await provider.call<bigint>(v.length(), overrides)), MAX_POOLS)
  const pools = await tryAllChunked<string>(provider, Array.from({ length }, (_, i) => v.pools(i)), overrides)
  const list = pools.filter((p): p is string => p !== null)
  const found = await tryAllChunked<string>(provider, list.map((p) => v.gauges(p)), overrides)
  return [...new Set(found.filter((g): g is string => g !== null && !/^0x0{40}$/.test(g)))]
}

function discoverGauges(provider: Provider, voter: string, overrides: CallOverrides): Promise<string[]> {
  if (overrides.blockTag !== undefined && overrides.blockTag !== 'latest') {
    return enumerateGauges(provider, voter, overrides) // 历史区块：不缓存
  }
  const cache = gaugeCache.get(provider) ?? new Map()
  gaugeCache.set(provider, cache)
  const key = voter.toLowerCase()
  const hit = cache.get(key)
  let gauges: Promise<string[]>
  if (hit && Date.now() - hit.at < GAUGE_TTL) {
    gauges = hit.gauges
  } else {
    gauges = enumerateGauges(provider, voter, {})
    const entry = { at: Date.now(), gauges }
    cache.set(key, entry)
    gauges.catch(() => {
      if (cache.get(key) === entry) cache.delete(key)
    })
  }
  return withSignal(overrides.signal, () => gauges)
}

type Source = { ctx: Ctx; owner: string; overrides: CallOverrides; maxPositions: number; lpProtocols: readonly LpProtocol[] }

const amountOf = (token: ClaimAmount['token'], value: bigint): ClaimAmount => ({ token, amount: value.toString(), formatted: fmt(value, token) })

/** MasterChefV3：用户质押的仓位。返回挖矿奖励（CAKE）和质押仓位未领取的手续费 */
export async function readMasterChef(source: Source, farm: FarmProtocol, wantFees: boolean, wantRewards: boolean): Promise<ClaimItem[]> {
  const { ctx, owner, overrides, maxPositions } = source
  const { provider } = ctx
  const mcAddress = evm(farm.masterChef as string)
  const mc = provider.contract(mcAddress, masterChefInterface)
  const count = Number(await provider.call<bigint>(mc.balanceOf(owner), overrides))
  if (!count) {
    return []
  }
  // 质押多的地址只看最近的 maxPositions 个（新质押的排在最后）
  const indexes = Array.from({ length: Math.min(count, maxPositions) }, (_, i) => count - Math.min(count, maxPositions) + i)
  const ids = (await tryAllChunked<bigint>(provider, indexes.map((i) => mc.tokenOfOwnerByIndex(owner, i)), overrides)).filter((id): id is bigint => id !== null)
  const items: ClaimItem[] = []
  if (wantRewards) {
    // pendingCake 不含奖励池自上次更新以来新增的部分（比实际领到的少，差额随时间变大）：
    // 以所有者的身份预执行 harvest 拿到合约真正会发的数量，预执行不了（钱包节点不支持 from 等）时退回 pendingCake
    const [pending, exact, cake] = await Promise.all([
      tryAllChunked<bigint>(provider, ids.map((id) => mc.pendingCake(id)), overrides),
      staticCallChunked(provider, ids.map((id) => ({ call: mc.harvest(id, owner), overrides: { ...overrides, from: owner } }))),
      provider.call<string>(mc.CAKE(), overrides),
    ])
    const [token] = await tokenInfo(ctx, [evm(cake)])
    ids.forEach((id, i) => {
      const run = exact[i]
      // 预执行失败（限流 / 节点不支持 …）时退回 pendingCake，数量可能偏少，标 approximate
      const value = run?.success ? BigInt(run.data) : (pending[i] ?? 0n)
      if (value > 0n && token) {
        items.push({
          id: `farm:${farm.id}:${id}`,
          kind: 'farm',
          protocol: farm.id,
          protocolName: farm.name,
          tokenId: id.toString(),
          pool: null,
          staked: true,
          target: mcAddress,
          amounts: [amountOf(token, value)],
          ...(run?.success ? {} : { approximate: true }),
        })
      }
    })
  }
  const lp = source.lpProtocols.find((p) => p.version === 'v3' && p.chainId === ctx.chainId && p.positionManager && same(p.positionManager, farm.positionManager))
  if (wantFees && lp && ids.length) {
    const positions = (await lpPositionsByIds(provider, ids.map((tokenId) => ({ protocol: lp, tokenId })), { ...overrides })) as LpConcentratedPosition[]
    for (const p of positions) {
      if (BigInt(p.fees0) + BigInt(p.fees1) > 0n) {
        items.push({
          id: `fees:${lp.id}:${p.tokenId}`,
          kind: 'fees',
          protocol: lp.id,
          protocolName: lp.name,
          version: 'v3',
          tokenId: p.tokenId,
          pool: p.pool,
          staked: true,
          target: mcAddress,
          amounts: [
            { token: p.token0, amount: p.fees0, formatted: p.fees0Formatted },
            { token: p.token1, amount: p.fees1, formatted: p.fees1Formatted },
          ],
        })
      }
    }
  }
  return items
}

/** Slipstream gauge：用户质押的仓位和待领取的奖励 */
export async function readGauges(source: Source, farm: FarmProtocol, gauges: readonly string[] | undefined): Promise<ClaimItem[]> {
  const { ctx, owner, overrides } = source
  const { provider } = ctx
  const list = gauges ? gauges.map(evm) : await discoverGauges(provider, evm(farm.voter as string), overrides)
  const staked = await tryAllChunked<bigint[]>(provider, list.map((g) => provider.contract(g, gaugeAbi).stakedValues(owner)), overrides)
  const pairs = list.flatMap((gauge, i) => (staked[i] ?? []).slice(0, source.maxPositions).map((tokenId) => ({ gauge, tokenId })))
  if (!pairs.length) {
    return []
  }
  const [earned, rewardTokens] = await Promise.all([
    tryAllChunked<bigint>(provider, pairs.map((x) => provider.contract(x.gauge, gaugeAbi).earned(owner, x.tokenId)), overrides),
    tryAllChunked<string>(provider, [...new Set(pairs.map((x) => x.gauge))].map((g) => provider.contract(g, gaugeAbi).rewardToken()), overrides),
  ])
  const gaugeList = [...new Set(pairs.map((x) => x.gauge))]
  const rewardOf = new Map(gaugeList.map((g, i) => [g, rewardTokens[i] ?? null]))
  const tokens = await tokenInfo(ctx, [...new Set([...rewardOf.values()].filter((t): t is string => t !== null).map(evm))])
  const infoOf = new Map(tokens.map((t) => [evm(t.address), t]))
  return pairs.flatMap(({ gauge, tokenId }, i): ClaimItem[] => {
    const value = earned[i] ?? 0n
    const reward = rewardOf.get(gauge)
    const token = reward ? infoOf.get(evm(reward)) : undefined
    return value > 0n && token
      ? [
          {
            id: `gauge:${farm.id}:${tokenId}`,
            kind: 'gauge',
            protocol: farm.id,
            protocolName: farm.name,
            tokenId: tokenId.toString(),
            pool: null,
            staked: true,
            target: gauge,
            amounts: [amountOf(token, value)],
          },
        ]
      : []
  })
}
