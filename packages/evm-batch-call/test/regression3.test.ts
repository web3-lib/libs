/** 第三轮 code review 发现的问题的回归测试 */
import { BrowserProvider, Interface } from 'ethers'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { clearChainIdCache, getBalances, MULTICALL3_ADDRESS, NATIVE_TOKEN, Provider, toTronAddress, TRON_CHAIN_ID, TronProvider } from '../src/index.js'
import { ERC721_ABI, nftOwners } from '../src/subpaths/nft.js'
import { resetMulticallCache } from '../src/aggregate.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { resetBalancesProviderCache, resolveProviderForTest } from '../src/shortcuts.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const TOKEN = '0x2000000000000000000000000000000000000002'
const USER = '0x4000000000000000000000000000000000000004'
const MAINNET_GENESIS = '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc'

function node(chainId?: bigint, balance = 5_000_000n) {
  const mock = createMockProvider({
    contracts: { [TOKEN]: fakeToken('BBB', 6, { [USER]: balance }) },
    multicallAddresses: [MULTICALL3_ADDRESS],
    balances: { [USER]: 100_000_000n },
  })
  return chainId === undefined ? mock : Object.assign(mock, { getNetwork: async () => ({ chainId }) })
}

/** 模拟钱包，eth_call 转给 mock 节点 */
function wallet(chainId: string) {
  const mock = node()
  const state = {
    chainId,
    chainIdRequests: 0,
    async request({ method, params }: { method: string; params?: any[] }) {
      if (method === 'eth_chainId') {
        state.chainIdRequests++
        return state.chainId
      }
      if (method === 'eth_call') return mock.call({ ...(params as any[])[0], blockTag: (params as any[])[1] })
      throw new Error(method)
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

describe('用户传入的 BrowserProvider', () => {
  it('钱包不在 chainId 上时报错，而不是返回另一条链的数据', async () => {
    const bp = new BrowserProvider(wallet('0x1')) // 用户自己创建，没有固定链
    await expect(new Provider(56, bp).balances(USER, [TOKEN])).rejects.toThrow(/chainId mismatch/)
  })

  it('[BrowserProvider, 公共节点]：钱包在别的链上时改用公共节点', async () => {
    const bp = new BrowserProvider(wallet('0x1')) // 钱包节点上余额是 5
    const multi = new Provider(56, [bp, node(56n, 7_000_000n)]) // 公共节点上余额是 7
    expect((await multi.balances(USER, [TOKEN]))[0]?.formatted).toBe('7')
  })

  it('BrowserProvider 的 chainId 识别不缓存：钱包切链后重新识别', async () => {
    const w = wallet('0x38')
    const bp = new BrowserProvider(w, 'any') // "any"：ethers 自己不拦切链
    expect((await getBalances(USER, [TOKEN], { chainId: 56, provider: bp }))[0]?.success).toBe(true)
    w.chainId = '0x1'
    await expect(getBalances(USER, [TOKEN], { chainId: 56, provider: bp })).rejects.toThrow(/chainId mismatch/)
  })
})

describe('链校验的开销', () => {
  it('识别一直失败时不会每次请求都重新识别', async () => {
    let attempts = 0
    const flaky = Object.assign(node(), {
      getNetwork: async () => {
        attempts++
        throw new Error('eth_chainId blocked')
      },
    })
    const multi = new Provider(56, flaky)
    for (let i = 0; i < 3; i++) {
      expect((await multi.balances(USER, [TOKEN]))[0]?.success).toBe(true) // 识别失败不拦截请求
    }
    expect(attempts).toBe(1)
  })

  it('Tron URL 节点的链校验走已配置的 TronProvider（带 apiKey），不再先试 EVM', async () => {
    const seen: Array<{ url: string; key: string | null }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, key: new Headers(init.headers).get('TRON-PRO-API-KEY') })
      const body = url.endsWith('/wallet/getblockbynum')
        ? { blockID: MAINNET_GENESIS }
        : { constant_result: [''], result: { result: true }, transaction: { ret: [{}] } }
      return new Response(JSON.stringify(body), { status: 200 })
    })
    try {
      await new Provider(TRON_CHAIN_ID.mainnet, ['https://tron-a.invalid', 'https://tron-b.invalid'], {
        tron: { apiKey: 'my-key' },
      }).staticCall({ contract: { address: TOKEN }, name: 'symbol', inputs: [], outputs: [], params: [] })
    } finally {
      vi.unstubAllGlobals()
    }
    const detection = seen.filter((r) => r.url.endsWith('/wallet/getblockbynum'))
    expect(detection).toHaveLength(1)
    expect(detection[0]?.key).toBe('my-key')
  })

  it('链校验与请求并行：慢一点的节点不会因为两段耗时叠加而超时', async () => {
    const slowNode = () => {
      const slow = Object.assign(node(), {
        getNetwork: () => new Promise<{ chainId: bigint }>((r) => setTimeout(() => r({ chainId: 56n }), 30)),
      })
      const realCall = slow.call
      slow.call = (tx) => new Promise((r) => setTimeout(() => r(realCall(tx)), 30))
      return slow
    }
    // 单节点超时 50ms：识别 30ms + 请求 30ms，串行 60ms 会超时，并行 30ms 不会（两个独立节点，互不共用识别缓存）
    const multi = new Provider(56, [slowNode(), slowNode()], { fallback: { timeout: 50 } })
    expect((await multi.balances(USER, [TOKEN]))[0]?.success).toBe(true)
  })

  it('内置公共节点不做链校验', () => {
    const multi = new Provider(56)
    const nodes = (multi.rpc as unknown as { nodes: unknown[] }).nodes
    expect(nodes.every((n) => !(n as { inner?: unknown }).inner)).toBe(true)
  })
})

describe('其他', () => {
  it('显式传给主币的 decimals 优先于内置配置', async () => {
    const multi = new Provider(999_999, node())
    const [res] = await multi.balances(USER, [{ address: NATIVE_TOKEN, decimals: 8 }])
    expect(res).toMatchObject({ native: true, decimals: 8, formatted: '1' })
  })

  it('chainId 为 null / 空字符串时按未传处理（自动识别）', async () => {
    const w = Object.assign(wallet('0x38'), { on() {} })
    const viaNull = resolveProviderForTest({ chainId: null as unknown as number, provider: w })
    expect(await viaNull.getChainId()).toBe(56)
    const viaEmpty = resolveProviderForTest({ chainId: '', provider: w })
    expect(await viaEmpty.getChainId()).toBe(56)
  })

  it('Tron 链上 nftOwners 返回 T 开头的地址', async () => {
    const erc721 = new Interface(ERC721_ABI as unknown as string[])
    const NFT = '0x7000000000000000000000000000000000000007'
    const mock = createMockProvider({
      contracts: {
        [NFT]: (data) => {
          const tx = erc721.parseTransaction({ data })
          return tx?.name === 'ownerOf'
            ? { success: true, returnData: erc721.encodeFunctionResult('ownerOf', [USER]) }
            : { success: false, returnData: '0x' }
        },
      },
      multicallAddresses: [MULTICALL3_ADDRESS],
    })
    const multi = new Provider(TRON_CHAIN_ID.mainnet, mock, { multicall: { address: MULTICALL3_ADDRESS } })
    const [owner] = await nftOwners(multi, [{ contract: NFT, tokenId: 1 }])
    expect(owner?.owner).toBe(toTronAddress(USER))
  })

  it('Provider 缓存有上限，超出时淘汰最早的', () => {
    const mock = node()
    const first = resolveProviderForTest({ chainId: 56, provider: 'https://rpc-0.example' })
    for (let i = 1; i <= 40; i++) {
      resolveProviderForTest({ chainId: 56, provider: `https://rpc-${i}.example` })
    }
    expect(resolveProviderForTest({ chainId: 56, provider: 'https://rpc-0.example' })).not.toBe(first)
    void mock
  })
})
