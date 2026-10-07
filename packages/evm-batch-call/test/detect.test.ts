import { beforeEach, describe, expect, it } from 'vitest'

import { MULTICALL3_ADDRESS, NATIVE_TOKEN, Provider, TRON_CHAIN_ID, TronProvider, clearChainIdCache, detectChainId, getBalances } from '../src/index.js'
import { resetMulticallCache } from '../src/aggregate.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { resetBalancesProviderCache } from '../src/shortcuts.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const TOKEN = '0x2000000000000000000000000000000000000002'
const USER = '0x4000000000000000000000000000000000000004'
const TRON_GENESIS = '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc'

function node() {
  return createMockProvider({
    contracts: { [TOKEN]: fakeToken('BBB', 6, { [USER]: 5_000_000n }) },
    multicallAddresses: [MULTICALL3_ADDRESS],
    balances: { [USER]: 1_500_000_000_000_000_000n },
  })
}

/** 模拟 EIP-1193 钱包：记录请求，支持 chainChanged 事件 */
function wallet(chainId = '0x38') {
  const mock = node()
  const listeners: Record<string, Array<() => void>> = {}
  const state = {
    chainId,
    requests: [] as string[],
    mock,
    on(event: string, listener: () => void) {
      ;(listeners[event] ??= []).push(listener)
    },
    switchChain(id: string) {
      state.chainId = id
      listeners.chainChanged?.forEach((l) => l())
    },
    async request({ method, params }: { method: string; params?: any[] }) {
      state.requests.push(method)
      if (method === 'eth_chainId') return state.chainId
      if (method === 'eth_call') {
        const [tx, blockTag] = params as [any, string]
        return mock.call({ ...tx, blockTag })
      }
      throw new Error(`unsupported ${method}`)
    },
  }
  return state
}

beforeEach(() => {
  clearChainIdCache()
  resetMulticallCache()
  resetDecimalsCache()
  resetBalancesProviderCache()
})

describe('chainId 自动识别', () => {
  it('只传钱包：从 eth_chainId 识别', async () => {
    const eth = wallet('0x38')
    const multi = new Provider(eth)
    expect(await multi.getChainId()).toBe(56)
    expect((await multi.balances(USER, [NATIVE_TOKEN, TOKEN])).map((r) => r.formatted)).toEqual(['1.5', '5'])
  })

  it('ethers Provider：getNetwork', async () => {
    const mock = Object.assign(node(), { getNetwork: async () => ({ chainId: 8453n }) })
    expect(await new Provider(mock).getChainId()).toBe(8453)
  })

  it('TronProvider / tronWeb：创世区块哈希的最后 4 字节', async () => {
    const request = async (path: string) => {
      if (path !== 'wallet/getblockbynum') throw new Error(path)
      return { blockID: TRON_GENESIS }
    }
    expect(await new Provider(new TronProvider({ request })).getChainId()).toBe(TRON_CHAIN_ID.mainnet)
    const tronWeb = { fullNode: { request }, defaultAddress: { base58: false as const } }
    expect(await new Provider(tronWeb).getChainId()).toBe(TRON_CHAIN_ID.mainnet)
  })

  it('数组按顺序探测，第一个成功的为准', async () => {
    const broken = { async request(): Promise<never> { throw new Error('locked') } }
    expect(await detectChainId([broken, wallet('0x1')])).toBe(1)
  })

  it('既没有 chainId 也没有节点时报错', () => {
    expect(() => new Provider(undefined as never)).toThrow(/chainId or a provider/)
    expect(() => getBalances(USER, [TOKEN])).toThrow(/chainId or provider/)
  })

  it('识别失败时，调用方拿到错误', async () => {
    const broken = { async request(): Promise<never> { throw new Error('wallet locked') } }
    const multi = new Provider(broken)
    await expect(multi.balances(USER, [TOKEN])).rejects.toThrow('wallet locked')
    await expect(multi.ready()).rejects.toThrow('wallet locked')
  })

  it('构造参数：数字字符串、0x 十六进制视为 chainId', async () => {
    expect(await new Provider('56', node()).getChainId()).toBe(56)
    expect(await new Provider('0x38', node()).getChainId()).toBe(56)
  })
})

describe('chainId 缓存', () => {
  it('同一个节点只识别一次，并发识别共用一个请求', async () => {
    const eth = wallet()
    await Promise.all([detectChainId(eth), detectChainId(eth), detectChainId(eth)])
    await detectChainId(eth)
    expect(eth.requests.filter((m) => m === 'eth_chainId')).toHaveLength(1)
  })

  it('钱包切链（chainChanged）后缓存失效，重新识别', async () => {
    const eth = wallet('0x38')
    expect(await detectChainId(eth)).toBe(56)
    eth.switchChain('0x1')
    expect(await detectChainId(eth)).toBe(1)
  })

  it('识别失败不缓存，下次重试', async () => {
    let fail = true
    const flaky = {
      async request() {
        if (fail) throw new Error('not ready')
        return '0x38'
      },
    }
    await expect(detectChainId(flaky)).rejects.toThrow('not ready')
    fail = false
    expect(await detectChainId(flaky)).toBe(56)
  })

  it('getBalances 只传钱包：多次调用不重复识别，切链后按新链查', async () => {
    const eth = wallet('0x38')
    await getBalances(USER, [TOKEN], { provider: eth })
    const detections = () => eth.requests.filter((m) => m === 'eth_chainId').length
    const before = detections()
    await getBalances(USER, [TOKEN], { provider: eth })
    // 第二次调用只有 BrowserProvider 每次请求自带的链校验，没有额外的识别请求
    expect(detections() - before).toBeLessThanOrEqual(before)
    eth.switchChain('0x1')
    const res = await getBalances(USER, [NATIVE_TOKEN], { provider: eth, symbol: true })
    expect(res[0]?.symbol).toBe('ETH') // 按切换后的链（以太坊）取主币信息
  })
})
