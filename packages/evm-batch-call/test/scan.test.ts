import type { Log } from 'ethers'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  MULTICALL3_ADDRESS,
  Provider,
  TRON_CHAIN_ID,
  clearTokenListCache,
  getOwnerTokens,
  getTransferScanState,
  keyValueScanStorage,
  memoryScanStorage,
  staticTokens,
  transferScan,
  type TransferScanStorage,
} from '../src/index.js'
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

/** 带 getLogs / getBlockNumber 的模拟节点：可设置区块范围上限、前几次请求限频、完全不支持 */
function chainWithLogs(options: { head?: number; logs?: MockLog[]; maxRange?: number; rangeMessage?: string; rateLimitFirst?: number; unsupported?: boolean } = {}) {
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
    async getBlockNumber() {
      return state.head
    },
    async getLogs(filter: { fromBlock: number; toBlock: number; topics: Array<string | null> }) {
      state.getLogs.push({ fromBlock: filter.fromBlock, toBlock: filter.toBlock })
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

const discover = (node: ReturnType<typeof chainWithLogs>, options = {}, chainId = 1) =>
  transferScan(options).discover({ chainId, owner: USER, fetch, provider: new Provider(chainId, node) })

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
    expect(state).toMatchObject({ cursor: 1000, blockRange: 25, tokens: [LISTED.toLowerCase()] })
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

  it('节点不支持 getLogs：缩到 1 个区块仍失败后暂停，之后的调用不再发请求', async () => {
    const node = chainWithLogs({ head: 1000, unsupported: true })
    const storage = memoryScanStorage()
    await discover(node, { storage, lookbackBlocks: 10, blockRange: 8, maxRequests: 10 })
    expect((await getTransferScanState(1, USER, storage))?.pausedUntil).toBeGreaterThan(Date.now())
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
    expect(JSON.parse(backing.values().next().value as string)).toMatchObject({ startBlock: 1000, cursor: 1005, tokens: [NEW_TOKEN.toLowerCase()] })
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
    const options = { chainId: 1, provider: node, source: staticTokens([LISTED]), scanTransfers: { storage }, includeNative: false }
    expect((await getOwnerTokens(USER, options)).map((t) => t.symbol)).toEqual(['LST'])
    node.state.head = 1008
    const list = await getOwnerTokens(USER, options)
    expect(list.map((t) => [t.symbol, t.source])).toEqual([
      ['LST', 'static'],
      ['NEW', 'transfers'],
    ])
  })
})
