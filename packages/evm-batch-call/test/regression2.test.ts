/** 第二轮 code review 发现的问题的回归测试 */
import { Interface } from 'ethers'
import { beforeEach, describe, expect, it } from 'vitest'

import { ERC721_ABI, MULTICALL3_ADDRESS, Provider, TRON_CHAIN_ID, clearChainIdCache, detectChainId, getBalances } from '../src/index.js'
import { multicall3Interface, resetMulticallCache } from '../src/aggregate.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { resetBalancesProviderCache, resolveProviderForTest } from '../src/shortcuts.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const TOKEN = '0x2000000000000000000000000000000000000002'
const NFT = '0x7000000000000000000000000000000000000007'
const USER = '0x4000000000000000000000000000000000000004'
const MAINNET_GENESIS = '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc'
const NILE_GENESIS = '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc'

function node(chainId?: bigint) {
  const mock = createMockProvider({
    contracts: { [TOKEN]: fakeToken('BBB', 6, { [USER]: 5_000_000n }) },
    multicallAddresses: [MULTICALL3_ADDRESS],
  })
  return chainId === undefined ? mock : Object.assign(mock, { getNetwork: async () => ({ chainId }) })
}

beforeEach(() => {
  clearChainIdCache()
  resetMulticallCache()
  resetDecimalsCache()
  resetBalancesProviderCache()
})

describe('chainId 识别失败可以重试', () => {
  it('第一次识别失败（如限流）后，同一个 Provider 下次调用重新识别', async () => {
    const mock = node()
    let fail = true
    const wallet = {
      async request({ method, params }: { method: string; params?: any[] }) {
        if (method === 'eth_chainId') {
          if (fail) throw new Error('rate limited')
          return '0x38'
        }
        if (method === 'eth_call') return mock.call({ ...(params as any[])[0], blockTag: (params as any[])[1] })
        throw new Error(method)
      },
      on() {},
    }
    const multi = new Provider(wallet)
    await expect(multi.balances(USER, [TOKEN])).rejects.toThrow('rate limited')
    fail = false
    expect((await multi.balances(USER, [TOKEN]))[0]?.formatted).toBe('5')
  })

  it('识别挂住时超时后从缓存删除，不会让后续调用一直等', async () => {
    let hang = true
    const wallet = {
      request: () => (hang ? new Promise<never>(() => {}) : Promise.resolve('0x1')),
      on() {},
    }
    await expect(detectChainId(wallet, 20)).rejects.toThrow(/timed out/)
    hang = false
    expect(await detectChainId(wallet, 20)).toBe(1)
  })
})

describe('不传 chainId 的混合节点', () => {
  it('后面的节点不在识别出的链上时报错，而不是返回另一条链的数据', async () => {
    const wallet = {
      async request({ method }: { method: string }) {
        if (method === 'eth_chainId') return '0x1'
        throw new Error('wallet locked')
      },
      on() {},
    }
    const bscNode = node(56n)
    const multi = new Provider([wallet, bscNode])
    expect(await multi.getChainId()).toBe(1)
    await expect(multi.balances(USER, [TOKEN])).rejects.toThrow(/chainId mismatch/)
    expect(bscNode.calls).toHaveLength(0)
  })

  it('链一致时正常使用后面的节点', async () => {
    const wallet = {
      async request({ method }: { method: string }) {
        if (method === 'eth_chainId') return '0x38'
        throw new Error('wallet locked')
      },
      on() {},
    }
    const multi = new Provider([wallet, node(56n)])
    expect((await multi.balances(USER, [TOKEN]))[0]?.formatted).toBe('5')
  })
})

describe('chainId 缓存不会过期失效的来源', () => {
  it('tronWeb 按 fullNode.host 缓存：TronLink 切网络后重新识别', async () => {
    const tronWeb = {
      fullNode: {
        host: 'https://api.trongrid.io',
        request: async () => ({ blockID: tronWeb.fullNode.host.includes('nile') ? NILE_GENESIS : MAINNET_GENESIS }),
      },
    }
    expect(await detectChainId(tronWeb)).toBe(TRON_CHAIN_ID.mainnet)
    tronWeb.fullNode.host = 'https://nile.trongrid.io'
    expect(await detectChainId(tronWeb)).toBe(TRON_CHAIN_ID.nile)
  })

  it('没有 on() 的 EIP-1193 钱包不缓存（无法感知切链）', async () => {
    let chain = '0x38'
    const wallet = { request: async () => chain }
    expect(await detectChainId(wallet)).toBe(56)
    chain = '0x1'
    expect(await detectChainId(wallet)).toBe(1)
  })
})

describe('其他', () => {
  it('chainId 字符串带空白（如从环境变量读入）仍按 chainId 处理', async () => {
    expect(await new Provider(' 56\n', node()).getChainId()).toBe(56)
  })

  it('Provider.create：等识别完成后返回，rpc 等同步属性可直接用', async () => {
    const wallet = { request: async () => '0x38', on() {} }
    const multi = await Provider.create(wallet)
    expect(multi.rpc).toBeTruthy()
  })

  it('Provider 缓存：值为 undefined 的配置项不影响复用；内容相同的配置复用；含函数的配置不复用', () => {
    const mock = node()
    const a = resolveProviderForTest({ chainId: 56, provider: mock })
    expect(resolveProviderForTest({ chainId: 56, provider: mock, nativeSymbol: undefined })).toBe(a)
    const withConfig = resolveProviderForTest({ chainId: 56, provider: mock, fallback: { timeout: 5000 } })
    expect(withConfig).not.toBe(a)
    expect(resolveProviderForTest({ chainId: 56, provider: mock, fallback: { timeout: 5000 } })).toBe(withConfig)
    const defaultFrom = () => undefined // 配置里的函数无法比较内容
    expect(resolveProviderForTest({ chainId: 56, provider: mock, tron: { defaultFrom } })).not.toBe(
      resolveProviderForTest({ chainId: 56, provider: mock, tron: { defaultFrom } }),
    )
  })
})

describe('nftTokenUris', () => {
  const erc721 = new Interface(ERC721_ABI as unknown as string[])
  function nftNode(tokenUri: string) {
    return createMockProvider({
      contracts: {
        [NFT]: (data) => {
          const tx = erc721.parseTransaction({ data })
          if (tx?.name === 'tokenURI') return { success: true, returnData: erc721.encodeFunctionResult('tokenURI', [tokenUri]) }
          if (tx?.name === 'supportsInterface') {
            return { success: true, returnData: erc721.encodeFunctionResult('supportsInterface', [tx.args[0] === '0x80ac58cd']) }
          }
          return { success: false, returnData: '0x' }
        },
      },
      multicallAddresses: [MULTICALL3_ADDRESS],
    })
  }

  it('空字符串的 tokenURI 是有效结果（如尚未设置 baseURI），不算失败', async () => {
    const multi = new Provider(1, nftNode(''))
    expect((await multi.nftTokenUris([{ contract: NFT, tokenId: 1 }]))[0]).toMatchObject({ uri: '', success: true })
  })

  it('第一次查询顺带识别并缓存标准，之后只发 tokenURI', async () => {
    const mock = nftNode('ipfs://Qm/1')
    const multi = new Provider(1, mock)
    await multi.nftTokenUris([{ contract: NFT, tokenId: 1 }, { contract: NFT, tokenId: 2 }])
    await multi.nftTokenUris([{ contract: NFT, tokenId: 1 }])
    const count = (i: number) => (multicall3Interface.parseTransaction({ data: String(mock.calls[i]?.data) })?.args[0] as unknown[]).length
    expect(count(0)).toBe(6) // 2 次 supportsInterface（每个集合一次）+ 2 × (tokenURI + uri)
    expect(count(1)).toBe(1)
  })
})
