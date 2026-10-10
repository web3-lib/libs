import type { Log } from 'ethers'
import { beforeEach, describe, expect, it } from 'vitest'

import { FallbackRpc, MULTICALL3_ADDRESS, Provider, TRON_CHAIN_ID } from '../src/index.js'
import {
  clearTokenListCache,
  getOwnerTokens,
  getTransferScanState,
  keyValueScanStorage,
  memoryScanStorage,
  staticTokens,
  transferScan,
  type TransferScanOptions,
  type TransferScanStorage,
} from '../src/subpaths/owner.js'
import { resetMulticallCache } from '../src/aggregate.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { resetBalancesProviderCache } from '../src/shortcuts.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const USER = '0x4000000000000000000000000000000000000004'
const LISTED = '0x1000000000000000000000000000000000000001' // 代币列表里有
const NEW_TOKEN = '0x2000000000000000000000000000000000000002' // 列表里没有，只能靠扫描发现
const NFT = '0x7000000000000000000000000000000000000007'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const userTopic = `0x${USER.slice(2).toLowerCase().padStart(64, '0')}`

interface MockLog {
  block: number
  address: string
  topics: string[]
}

interface ChainOptions {
  head?: number
  logs?: MockLog[]
  maxRange?: number
  rangeMessage?: string
  rateLimitFirst?: number
  unsupported?: boolean
  /** 超时（没有 JSON-RPC 响应） */
  dead?: boolean
  /** 每次 getLogs 的耗时（毫秒） */
  delay?: number
}

/** 带 getLogs / getBlockNumber 的模拟节点：可设置区块范围上限、前几次请求限频、完全不支持；options 可在测试中途修改 */
function chainWithLogs(options: ChainOptions = {}) {
  const base = createMockProvider({
    contracts: {
      [LISTED]: fakeToken('LST', 18, { [USER]: 10n ** 18n }),
      [NEW_TOKEN]: fakeToken('NEW', 6, { [USER]: 3_000_000n }),
    },
    multicallAddresses: [MULTICALL3_ADDRESS],
    balances: { [USER]: 10n ** 18n },
  })
  const state = { head: options.head ?? 1000, getLogs: [] as Array<{ fromBlock: number; toBlock: number }>, rateLimited: options.rateLimitFirst ?? 0 }
  const node = Object.assign(base, {
    state,
    options,
    async getBlockNumber() {
      return state.head
    },
    async getLogs(filter: { fromBlock: number; toBlock: number; topics: Array<string | null> }) {
      state.getLogs.push({ fromBlock: filter.fromBlock, toBlock: filter.toBlock })
      if (options.delay) {
        await new Promise((resolve) => setTimeout(resolve, options.delay))
      }
      if (options.dead) {
        throw new Error('RPC request timed out after 10000ms')
      }
      if (options.unsupported) {
        throw Object.assign(new Error('could not coalesce error'), { error: { code: -32000, message: 'method not available' } })
      }
      if (state.rateLimited > 0) {
        state.rateLimited--
        throw Object.assign(new Error('could not coalesce error'), { error: { code: -32005, message: 'too many requests' } })
      }
      if (options.maxRange && filter.toBlock - filter.fromBlock + 1 > options.maxRange) {
        throw Object.assign(new Error('could not coalesce error'), { error: { code: -32000, message: options.rangeMessage ?? `log query range must not exceed ${options.maxRange} blocks` } })
      }
      return (options.logs ?? [])
        .filter((l) => l.block >= filter.fromBlock && l.block <= filter.toBlock && l.topics[0] === filter.topics[0] && l.topics[2] === filter.topics[2])
        .map((l) => ({ address: l.address, topics: l.topics })) as unknown as Log[] // 只用到 address / topics
    },
  })
  return node
}

const erc20Transfer = (block: number, address: string): MockLog => ({ block, address, topics: [TRANSFER, `0x${'9'.repeat(64)}`, userTopic] })
const nftTransfer = (block: number): MockLog => ({ block, address: NFT, topics: [TRANSFER, `0x${'9'.repeat(64)}`, userTopic, `0x${'0'.repeat(63)}1`] })

type Node = ReturnType<typeof chainWithLogs>

/** 测试默认 confirmations: 0（扫到最新区块），便于对照区块号 */
const discover = (node: Node | Node[] | Provider, options: TransferScanOptions = {}, chainId = 1) =>
  transferScan({ confirmations: 0, ...options }).discover({ chainId, owner: USER, fetch, provider: node instanceof Provider ? node : new Provider(chainId, node) })

beforeEach(() => {
  clearTokenListCache()
  resetMulticallCache()
  resetDecimalsCache()
  resetBalancesProviderCache()
})

describe('transferScan', () => {
  it('第一次只记下当前区块，不扫描历史；之后从上次的位置往后扫', async () => {
    const node = chainWithLogs({ head: 1000, logs: [erc20Transfer(900, LISTED), erc20Transfer(1005, NEW_TOKEN)] })
    const storage = memoryScanStorage()
    expect(await discover(node, { storage })).toEqual([])
    expect(node.state.getLogs).toHaveLength(0)
    node.state.head = 1010
    expect(await discover(node, { storage })).toEqual([{ address: NEW_TOKEN.toLowerCase() }]) // 900 区块的转账在开始之前，不会发现
    expect(node.state.getLogs).toEqual([{ fromBlock: 1001, toBlock: 1010 }])
  })

  it('lookbackBlocks：第一次往回扫一段', async () => {
    const node = chainWithLogs({ head: 1000, logs: [erc20Transfer(950, LISTED)] })
    expect(await discover(node, { storage: memoryScanStorage(), lookbackBlocks: 100 })).toEqual([{ address: LISTED.toLowerCase() }])
  })

  it('只收集 ERC20 的 Transfer（3 个 topic），排除 ERC721（4 个 topic）', async () => {
    const node = chainWithLogs({ head: 1000, logs: [erc20Transfer(990, LISTED), nftTransfer(991)] })
    expect(await discover(node, { storage: memoryScanStorage(), lookbackBlocks: 50 })).toEqual([{ address: LISTED.toLowerCase() }])
  })

  it('节点有范围上限时按报错里的数字缩小并记住', async () => {
    const node = chainWithLogs({ head: 1000, maxRange: 25, logs: [erc20Transfer(960, LISTED)] })
    const storage = memoryScanStorage()
    await discover(node, { storage, lookbackBlocks: 100 })
    const state = await getTransferScanState(1, USER, storage)
    expect(state).toMatchObject({ cursor: 1000, blockRange: 25, rangeLimit: 25, tokens: [LISTED.toLowerCase()] })
    expect(node.state.getLogs.filter((r) => r.toBlock - r.fromBlock + 1 <= 25)).toHaveLength(4)
  })

  it('报错里没有数字时减半，直到能查', async () => {
    const node = chainWithLogs({ head: 1000, maxRange: 100, rangeMessage: 'block range is too wide' })
    const storage = memoryScanStorage()
    await discover(node, { storage, lookbackBlocks: 300, blockRange: 1000 })
    expect((await getTransferScanState(1, USER, storage))?.blockRange).toBeLessThanOrEqual(100)
  })

  it('限频等临时错误不缩小范围，退避后重试', async () => {
    const node = chainWithLogs({ head: 1000, rateLimitFirst: 2 })
    const storage = memoryScanStorage()
    await discover(node, { storage, lookbackBlocks: 100, blockRange: 50 })
    expect(await getTransferScanState(1, USER, storage)).toMatchObject({ cursor: 1000, blockRange: 50 })
  })

  it('每次调用的请求数有上限，落后很多时分多次追上', async () => {
    const node = chainWithLogs({ head: 1000 })
    const storage = memoryScanStorage()
    await discover(node, { storage, lookbackBlocks: 500, blockRange: 50, maxRequests: 3 })
    expect((await getTransferScanState(1, USER, storage))?.cursor).toBe(500 + 150)
    await discover(node, { storage, blockRange: 50, maxRequests: 3 })
    expect((await getTransferScanState(1, USER, storage))?.cursor).toBe(500 + 300)
  })

  it('节点不支持 getLogs：第一次报错就暂停（不逐步缩小范围），之后的调用不再发请求', async () => {
    const node = chainWithLogs({ head: 1000, unsupported: true })
    const storage = memoryScanStorage()
    await discover(node, { storage, lookbackBlocks: 500, blockRange: 1000, maxRequests: 20 })
    expect((await getTransferScanState(1, USER, storage))?.pausedUntil).toBeGreaterThan(Date.now())
    expect(node.state.getLogs).toHaveLength(1)
    const before = node.state.getLogs.length
    await discover(node, { storage })
    expect(node.state.getLogs.length).toBe(before)
  })

  it('keyValueScanStorage：基于 getItem / setItem（如 localStorage）保存进度', async () => {
    const backing = new Map<string, string>()
    const storage: TransferScanStorage = keyValueScanStorage({ getItem: (k) => backing.get(k) ?? null, setItem: (k, v) => void backing.set(k, v) })
    const node = chainWithLogs({ head: 1000, logs: [erc20Transfer(1003, NEW_TOKEN)] })
    await discover(node, { storage })
    node.state.head = 1005
    await discover(node, { storage })
    expect([...backing.keys()]).toEqual([`w3lib:transfer-scan:1:${USER.toLowerCase()}`])
    expect(JSON.parse(backing.values().next().value as string)).toMatchObject({ startBlock: 1001, cursor: 1005, tokens: [NEW_TOKEN.toLowerCase()] })
  })

  it('lookbackBlocks 往回扫 N 个区块：startBlock 就是第一个扫描的区块', async () => {
    const node = chainWithLogs({ head: 1000 })
    const storage = memoryScanStorage()
    await discover(node, { storage, lookbackBlocks: 100 })
    const state = await getTransferScanState(1, USER, storage)
    expect(node.state.getLogs[0]?.fromBlock).toBe(901)
    expect(state).toMatchObject({ startBlock: 901, cursor: 1000 })
  })

  it('confirmations：只扫到最新区块往前 N 个区块（默认 5），之后再补上', async () => {
    const node = chainWithLogs({ head: 1000, logs: [erc20Transfer(1008, NEW_TOKEN)] })
    const storage = memoryScanStorage()
    const scan = transferScan({ storage })
    const run = () => scan.discover({ chainId: 1, owner: USER, fetch, provider: new Provider(1, node) })
    await run()
    expect(await getTransferScanState(1, USER, storage)).toMatchObject({ startBlock: 996, cursor: 995 })
    node.state.head = 1010
    expect(await run()).toEqual([])
    expect(node.state.getLogs.at(-1)).toEqual({ fromBlock: 996, toBlock: 1005 })
    node.state.head = 1013
    expect(await run()).toEqual([{ address: NEW_TOKEN.toLowerCase() }])
  })

  it('有节点限频、有节点报范围超限时按范围超限处理（缩小范围），而不是当作临时错误原地重试', async () => {
    const limited = chainWithLogs({ head: 1000, rateLimitFirst: 1000 })
    const ranged = chainWithLogs({ head: 1000, maxRange: 100, rangeMessage: 'block range is too wide' })
    const storage = memoryScanStorage()
    await discover([limited, ranged], { storage, lookbackBlocks: 300, blockRange: 1000 })
    expect(await getTransferScanState(1, USER, storage)).toMatchObject({ cursor: 1000 })
  })

  it('在用的节点限频时退避重试，不因其他一直不能用的节点报范围超限而缩小范围（BSC 公共节点的实际情况）', async () => {
    const neverWorks = chainWithLogs({ head: 1000, maxRange: 1, rangeMessage: 'limit exceeded' })
    const good = chainWithLogs({ head: 1000 })
    const storage = memoryScanStorage()
    const rpc = new Provider(1, [neverWorks, good]) // 同一个 Provider 会记住上次成功的节点
    await discover(rpc, { storage, lookbackBlocks: 100, blockRange: 100 })
    good.state.rateLimited = 2
    good.state.head = neverWorks.state.head = 1100
    await discover(rpc, { storage, blockRange: 100 })
    expect(await getTransferScanState(1, USER, storage)).toMatchObject({ cursor: 1100, blockRange: 100 })
  })

  it('有节点超时、有节点报范围超限时同样缩小范围', async () => {
    const dead = chainWithLogs({ head: 1000, dead: true })
    const ranged = chainWithLogs({ head: 1000, maxRange: 100, rangeMessage: 'block range is too wide' })
    const storage = memoryScanStorage()
    await discover([dead, ranged], { storage, lookbackBlocks: 300, blockRange: 1000 })
    expect(await getTransferScanState(1, USER, storage)).toMatchObject({ cursor: 1000 })
  })

  it('所有节点都不开放 getLogs 时立即暂停', async () => {
    const a = chainWithLogs({ head: 1000, unsupported: true })
    const b = chainWithLogs({ head: 1000, unsupported: true })
    const storage = memoryScanStorage()
    await discover([a, b], { storage, lookbackBlocks: 500, blockRange: 1000 })
    expect((await getTransferScanState(1, USER, storage))?.pausedUntil).toBeGreaterThan(Date.now())
    expect(a.state.getLogs.length + b.state.getLogs.length).toBe(2)
  })

  it('之前成功过的范围后来不能用了（换了节点 / 节点调整了限制），仍会缩小', async () => {
    const node = chainWithLogs({ head: 1000 })
    const storage = memoryScanStorage()
    await discover(node, { storage, lookbackBlocks: 200, blockRange: 100 })
    node.options.maxRange = 40
    node.options.rangeMessage = 'block range is too wide'
    node.state.head = 1300
    await discover(node, { storage, blockRange: 100 })
    expect(await getTransferScanState(1, USER, storage)).toMatchObject({ cursor: 1300 })
  })

  it('范围缩小后，连续成功会逐步放大回去', async () => {
    const node = chainWithLogs({ head: 1000 })
    const storage = memoryScanStorage()
    storage.set(`1:${USER.toLowerCase()}`, { startBlock: 0, cursor: 0, tokens: [], blockRange: 1 })
    await discover(node, { storage, blockRange: 1000 })
    const state = await getTransferScanState(1, USER, storage)
    expect(state?.blockRange).toBeGreaterThan(100)
    expect(state?.cursor).toBe(1000)
  })

  it('记下的范围上限 1 天内有效，过期后重新尝试更大的范围', async () => {
    const node = chainWithLogs({ head: 10_000 })
    const storage = memoryScanStorage()
    const key = `1:${USER.toLowerCase()}`
    storage.set(key, { startBlock: 0, cursor: 0, tokens: [], blockRange: 25, rangeLimit: 25, rangeLimitAt: Date.now() })
    await discover(node, { storage, maxRequests: 5 })
    expect(Math.max(...node.state.getLogs.map((r) => r.toBlock - r.fromBlock + 1))).toBe(25)
    storage.set(key, { startBlock: 0, cursor: 0, tokens: [], blockRange: 25, rangeLimit: 25, rangeLimitAt: Date.now() - 25 * 3600_000 })
    await discover(node, { storage, maxRequests: 5 })
    expect((await getTransferScanState(1, USER, storage))?.rangeLimit).toBeUndefined()
    expect(Math.max(...node.state.getLogs.map((r) => r.toBlock - r.fromBlock + 1))).toBeGreaterThan(25)
  })

  it('每次调用有时间预算，超出后不再发新请求', async () => {
    const node = chainWithLogs({ head: 10_000, delay: 40 })
    const storage = memoryScanStorage()
    const started = Date.now()
    await discover(node, { storage, lookbackBlocks: 5000, blockRange: 100, timeBudget: 100 })
    expect(Date.now() - started).toBeLessThan(400)
    expect(node.state.getLogs.length).toBeLessThanOrEqual(3)
    expect((await getTransferScanState(1, USER, storage))?.cursor).toBe(5000 + node.state.getLogs.length * 100)
  })

  it('存储里的进度格式不对（旧版本 / 被改坏）或读取出错时丢弃，重新开始', async () => {
    const node = chainWithLogs({ head: 1000 })
    const bad: TransferScanStorage = { get: () => ({ cursor: 'x' }) as never, set: () => {} }
    await expect(discover(node, { storage: bad })).resolves.toEqual([])
    const throwing: TransferScanStorage = {
      get: () => {
        throw new Error('storage broken')
      },
      set: () => {
        throw new Error('storage broken')
      },
    }
    await expect(discover(node, { storage: throwing })).resolves.toEqual([])
    const backing = new Map([[`w3lib:transfer-scan:1:${USER.toLowerCase()}`, JSON.stringify({ startBlock: 1, cursor: 2, blockRange: 3, tokens: [1] })]])
    const kv = keyValueScanStorage({ getItem: (k) => backing.get(k) ?? null, setItem: (k, v) => void backing.set(k, v) })
    expect(await getTransferScanState(1, USER, kv)).toBeUndefined()
  })

  it('Tron 链返回 null（不支持）', async () => {
    const node = chainWithLogs()
    expect(await transferScan().discover({ chainId: TRON_CHAIN_ID.mainnet, owner: USER, fetch, provider: new Provider(1, node) })).toBeNull()
  })
})

describe('getOwnerTokens 的 scanTransfers 开关', () => {
  it('默认关闭：不发 getLogs', async () => {
    const node = chainWithLogs({ head: 1000 })
    await getOwnerTokens(USER, { chainId: 1, provider: node, source: staticTokens([LISTED]) })
    expect(node.state.getLogs).toHaveLength(0)
  })

  it('开启后合并列表与扫描发现的代币，结果标出来源', async () => {
    const node = chainWithLogs({ head: 1000, logs: [erc20Transfer(1004, NEW_TOKEN)] })
    const storage = memoryScanStorage()
    const options = { chainId: 1, provider: node, source: staticTokens([LISTED]), scanTransfers: { storage, confirmations: 0 }, includeNative: false }
    expect((await getOwnerTokens(USER, options)).map((t) => t.symbol)).toEqual(['LST'])
    node.state.head = 1008
    const list = await getOwnerTokens(USER, options)
    expect(list.map((t) => [t.symbol, t.source])).toEqual([
      ['LST', 'static'],
      ['NEW', 'transfers'],
    ])
  })
})

describe('FallbackRpc 的 getLogs / getBlockNumber', () => {
  const filter = { fromBlock: 1, toBlock: 1, topics: [TRANSFER] }

  it('getBlockNumber 优先问上次 getLogs 成功的节点，扫描的区块号和日志来自同一个节点', async () => {
    const ahead = chainWithLogs({ head: 2000, unsupported: true })
    const logsNode = chainWithLogs({ head: 1000 })
    const rpc = new FallbackRpc([ahead, logsNode])
    expect(await rpc.getBlockNumber()).toBe(2000)
    await rpc.getLogs(filter)
    expect(await rpc.getBlockNumber()).toBe(1000)
  })

  it('getBlockNumber 失败或节点不支持时不让节点进入冷却，不影响 call', async () => {
    const first = healthyNode()
    const second = chainWithLogs({ head: 1000 })
    const rpc = new FallbackRpc([first, second])
    expect(await rpc.getBlockNumber()).toBe(1000)
    await rpc.call({ to: LISTED, data: '0x95d89b41' })
    expect(first.calls).toHaveLength(1)
    expect(second.calls).toHaveLength(0)
  })

  it('上次成功的节点限频时直接抛出（不逐个试其他节点），连续 3 次后才换节点', async () => {
    const other = chainWithLogs()
    const good = chainWithLogs()
    const rpc = new FallbackRpc([other, good])
    other.options.unsupported = true
    await rpc.getLogs(filter)
    const before = other.state.getLogs.length
    good.state.rateLimited = 3
    await expect(rpc.getLogs(filter)).rejects.toMatchObject({ name: 'GetLogsError', errors: [expect.anything()] })
    await expect(rpc.getLogs(filter)).rejects.toThrow('too many requests')
    expect(other.state.getLogs.length).toBe(before)
    await expect(rpc.getLogs(filter)).rejects.toThrow('method not available') // 第 3 次：试了其他节点
    expect(other.state.getLogs.length).toBe(before + 1)
    await expect(rpc.getLogs(filter)).resolves.toEqual([]) // good 恢复后照常使用
  })

  it('getLogs 超时 / 连不上的节点排到后面；节点正常返回的错误（范围超限）不影响顺序', async () => {
    const dead = chainWithLogs({ dead: true })
    const ranged = chainWithLogs({ maxRange: 1, rangeMessage: 'block range is too wide' })
    const ok = chainWithLogs()
    const rpc = new FallbackRpc([dead, ranged, ok])
    await rpc.getLogs({ ...filter, toBlock: 5 })
    await expect(rpc.getLogs({ ...filter, toBlock: 6 })).resolves.toEqual([]) // 上次成功的 ok 排最前
    expect(dead.state.getLogs).toHaveLength(1)
    const rpc2 = new FallbackRpc([dead, ranged, ok])
    await rpc2.getLogs({ ...filter, toBlock: 5 }) // dead 超时 → 冷却；ranged 正常返回错误
    const deadBefore = dead.state.getLogs.length
    const rangedBefore = ranged.state.getLogs.length
    ok.options.unsupported = true
    await expect(rpc2.getLogs(filter)).resolves.toEqual([]) // ok 失败后 ranged 能查 1 个区块
    expect(ranged.state.getLogs.length).toBe(rangedBefore + 1)
    expect(dead.state.getLogs.length).toBe(deadBefore) // 冷却中的 dead 排在后面，没轮到
  })
})

/** 没有 getLogs / getBlockNumber 的普通节点，记录 call */
function healthyNode() {
  return createMockProvider({ contracts: { [LISTED]: fakeToken('LST', 18) }, multicallAddresses: [MULTICALL3_ADDRESS] })
}
