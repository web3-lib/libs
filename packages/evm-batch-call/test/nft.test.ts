import { Interface } from 'ethers'
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest'

import { getAllowances, MAX_UINT256, MULTICALL3_ADDRESS, NATIVE_TOKEN, Provider } from '../src/index.js'
import {
  ERC1155_ABI,
  ERC721_ABI,
  getErc1155Balances,
  getNftBalances,
  getNftCollections,
  getNftOwners,
  getNftTokenUris,
  nftCollections,
  nftTokenUris,
} from '../src/subpaths/nft.js'
import { multicall3Interface, resetMulticallCache } from '../src/aggregate.js'
import { clearChainIdCache } from '../src/detect.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { resetBalancesProviderCache } from '../src/shortcuts.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const APE = '0x7000000000000000000000000000000000000007' // ERC721
const ITEMS = '0x8000000000000000000000000000000000000008' // ERC1155
const OLD = '0x9000000000000000000000000000000000000009' // 老 ERC721：没有 supportsInterface
const TOKEN = '0x1000000000000000000000000000000000000001'
const UNI = '0x1100000000000000000000000000000000000011'
const NO_CODE = '0x3000000000000000000000000000000000000003'
const USER = '0x4000000000000000000000000000000000000004'
const OTHER = '0x5000000000000000000000000000000000000005'
const ROUTER = '0x6000000000000000000000000000000000000006'

const erc721 = new Interface(ERC721_ABI as unknown as string[])
const erc1155 = new Interface(ERC1155_ABI as unknown as string[])
const erc20 = new Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
])

function handler(iface: Interface, impl: Record<string, (...args: any[]) => unknown[] | null>) {
  return (data: string) => {
    const tx = iface.parseTransaction({ data })
    const fn = tx && impl[tx.name]
    const out = fn ? fn(...tx.args) : null
    return out === null || !tx ? { success: false, returnData: '0x' } : { success: true, returnData: iface.encodeFunctionResult(tx.name, out) }
  }
}

function setup() {
  const mock = createMockProvider({
    contracts: {
      [APE]: handler(erc721, {
        name: () => ['Ape Club'],
        symbol: () => ['APE'],
        totalSupply: () => [10000n],
        balanceOf: (owner: string) => [owner.toLowerCase() === USER ? 3n : 0n],
        ownerOf: (id: bigint) => (id < 10000n ? [id === 1n ? USER : OTHER] : null), // 不存在的 tokenId revert
        tokenURI: (id: bigint) => [`ipfs://QmApe/${id}`],
        supportsInterface: (id: string) => [id === '0x80ac58cd'],
      }),
      [ITEMS]: handler(erc1155, {
        balanceOf: (_owner: string, id: bigint) => [id * 10n],
        uri: () => ['https://meta.example/{id}.json'],
        supportsInterface: (id: string) => [id === '0xd9b67a26'],
      }),
      [OLD]: handler(erc721, { name: () => ['Old Punks'], symbol: () => ['OLD'], ownerOf: () => [USER] }),
      [TOKEN]: (data, ctx) => {
        const tx = erc20.parseTransaction({ data })
        if (tx?.name === 'allowance') {
          const spender = String(tx.args[1]).toLowerCase()
          return { success: true, returnData: erc20.encodeFunctionResult('allowance', [spender === ROUTER ? 100n * 10n ** 18n : 0n]) }
        }
        return fakeToken('TKN', 18)(data, ctx)
      },
      [UNI]: handler(erc20, { allowance: () => [2n ** 96n - 1n], decimals: () => [18n] }),
    },
    multicallAddresses: [MULTICALL3_ADDRESS],
  })
  return { mock, multi: new Provider(1, mock) }
}

function subCalls(mock: ReturnType<typeof createMockProvider>, index: number): number {
  const parsed = multicall3Interface.parseTransaction({ data: String(mock.calls[index]?.data) })
  return (parsed?.args[0] as unknown[]).length
}

beforeEach(() => {
  clearChainIdCache()
  resetMulticallCache()
  resetDecimalsCache()
  resetBalancesProviderCache()
})

describe('allowances', () => {
  it('返回额度、换算值和是否无限授权，一次请求', async () => {
    const { mock, multi } = setup()
    const res = await multi.allowances(USER, ROUTER, [TOKEN, UNI, NATIVE_TOKEN])
    expect(res[0]).toEqual({
      token: TOKEN,
      spender: ROUTER,
      native: false,
      allowance: (100n * 10n ** 18n).toString(),
      decimals: 18,
      formatted: '100',
      unlimited: false,
      success: true,
    })
    // UNI / COMP 把 MaxUint256 截断成 uint96 最大值，也算无限授权
    expect(res[1]).toMatchObject({ unlimited: true, success: true })
    // 主币不需要授权
    expect(res[2]).toMatchObject({ native: true, allowance: MAX_UINT256.toString(), unlimited: true, success: true })
    expect(mock.calls).toHaveLength(1)
  })

  it('decimals 与 balances 共用缓存，第二次只查 allowance', async () => {
    const { mock, multi } = setup()
    await multi.allowances(USER, ROUTER, [TOKEN])
    expect(subCalls(mock, 0)).toBe(2)
    await multi.allowances(USER, OTHER, [TOKEN])
    expect(subCalls(mock, 1)).toBe(1)
  })

  it('非代币地址 success 为 false；getAllowances 节点参数与 getBalances 相同', async () => {
    const { mock } = setup()
    const res = await getAllowances(USER, ROUTER, [NO_CODE, TOKEN], { chainId: 1, provider: mock })
    expect(res.map((r) => r.success)).toEqual([false, true])
  })
})

describe('NFT 集合信息', () => {
  it('通过 ERC165 识别标准，字段可选', async () => {
    const { multi } = setup()
    const res = await nftCollections(multi, [APE, ITEMS], { fields: ['standard', 'name', 'totalSupply'] })
    expect(res[0]).toEqual({ address: APE, standard: 'ERC721', name: 'Ape Club', totalSupply: '10000', success: true })
    expect(res[1]).toMatchObject({ standard: 'ERC1155', name: null, success: false }) // ERC1155 通常没有 name
    expectTypeOf(res[0]!.standard).toEqualTypeOf<'ERC721' | 'ERC1155' | null>()
  })

  it('没有 supportsInterface 的老合约 standard 为 null，其余字段正常', async () => {
    const { multi } = setup()
    const [old] = await nftCollections(multi, [OLD])
    expect(old).toMatchObject({ standard: null, name: 'Old Punks', symbol: 'OLD' })
  })

  it('标准 / name / symbol 缓存，第二次不再请求', async () => {
    const { mock, multi } = setup()
    await getNftCollections([APE], { chainId: 1, provider: mock })
    await getNftCollections([APE], { chainId: 1, provider: mock })
    expect(mock.calls).toHaveLength(1)
  })
})

describe('NFT 持有', () => {
  it('nftBalances：ERC721 持有数量', async () => {
    const { mock } = setup()
    const res = await getNftBalances(USER, [APE, NO_CODE], { chainId: 1, provider: mock })
    expect(res).toEqual([
      { contract: APE, balance: '3', success: true },
      { contract: NO_CODE, balance: '0', success: false },
    ])
  })

  it('nftOwners：混合多个集合；不存在的 tokenId、非法 tokenId 为 null', async () => {
    const { mock } = setup()
    const res = await getNftOwners(
      [
        { contract: APE, tokenId: 1 },
        { contract: APE, tokenId: '2' },
        { contract: APE, tokenId: 99999n },
        { contract: OLD, tokenId: 5 },
        { contract: APE, tokenId: 'not-a-number' },
      ],
      { chainId: 1, provider: mock },
    )
    expect(res.map((r) => [r.tokenId, r.owner])).toEqual([
      ['1', USER],
      ['2', OTHER],
      ['99999', null],
      ['5', USER],
      ['not-a-number', null],
    ])
    expect(mock.calls).toHaveLength(1)
  })

  it('erc1155Balances', async () => {
    const { mock } = setup()
    const res = await getErc1155Balances(USER, [{ contract: ITEMS, tokenId: 7 }], { chainId: 1, provider: mock })
    expect(res).toEqual([{ contract: ITEMS, tokenId: '7', balance: '70', success: true }])
  })
})

describe('NFT 元数据地址', () => {
  it('自动兼容 ERC721 tokenURI 与 ERC1155 uri，{id} 按规范替换，ipfs:// 可转网关', async () => {
    const { mock } = setup()
    const res = await getNftTokenUris(
      [
        { contract: APE, tokenId: 1 },
        { contract: ITEMS, tokenId: 255 },
        { contract: NO_CODE, tokenId: 1 },
      ],
      { chainId: 1, provider: mock, ipfsGateway: 'https://ipfs.io/ipfs/' },
    )
    expect(res.map((r) => r.uri)).toEqual([
      'https://ipfs.io/ipfs/QmApe/1',
      `https://meta.example/${'0'.repeat(62)}ff.json`,
      null,
    ])
    expect(res.map((r) => r.success)).toEqual([true, true, false])
  })

  it('不配 ipfsGateway 时保留 ipfs://', async () => {
    const { multi } = setup()
    expect((await nftTokenUris(multi, [{ contract: APE, tokenId: 3 }]))[0]?.uri).toBe('ipfs://QmApe/3')
  })

  it('已知集合标准时只发对应的调用', async () => {
    const { mock, multi } = setup()
    await nftCollections(multi, [APE], { fields: ['standard'] })
    await nftTokenUris(multi, [{ contract: APE, tokenId: 1 }])
    expect(subCalls(mock, 1)).toBe(1) // 只有 tokenURI，没有 uri
  })
})
