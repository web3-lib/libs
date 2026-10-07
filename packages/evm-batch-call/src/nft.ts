import type { CallOverrides } from './aggregate.js'
import { asStringOrBytes32, type Call } from './call.js'
import { getCachedTokenMeta, setCachedTokenMeta } from './erc20.js'
import type { Provider } from './provider.js'
import { isTronChain } from './source.js'
import { toTronAddress } from './tron.js'

export const ERC721_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
] as const

export const ERC1155_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function uri(uint256 id) view returns (string)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
] as const

/** ERC165 接口 ID */
const ERC721_INTERFACE_ID = '0x80ac58cd'
const ERC1155_INTERFACE_ID = '0xd9b67a26'

export type NftStandard = 'ERC721' | 'ERC1155'

/** 某个集合里的一个 NFT */
export interface NftItem {
  contract: string
  tokenId: bigint | string | number
}

export interface NftOwner {
  contract: string
  /** 十进制字符串 */
  tokenId: string
  /** 持有人地址（Tron 链上为 T 开头的地址）；不存在 / 已销毁 / 非 ERC721 时为 null */
  owner: string | null
  success: boolean
}

export interface NftBalance {
  contract: string
  /** 持有数量（十进制字符串） */
  balance: string
  success: boolean
}

export interface Erc1155Balance {
  contract: string
  tokenId: string
  balance: string
  success: boolean
}

export interface NftTokenUri {
  contract: string
  tokenId: string
  /** ERC721 tokenURI 或 ERC1155 uri（已替换 {id}，配置了 ipfsGateway 时 ipfs:// 已转换）；读取失败为 null */
  uri: string | null
  success: boolean
}

export interface NftTokenUriOptions extends CallOverrides {
  /** 把 ipfs://xxx 转成 `${ipfsGateway}xxx`，如 'https://ipfs.io/ipfs/'。默认不转换 */
  ipfsGateway?: string
}

/** nftCollections() / getNftCollections() 可选的字段 */
export type NftCollectionField = 'standard' | 'name' | 'symbol' | 'totalSupply'

export const DEFAULT_NFT_COLLECTION_FIELDS = ['standard', 'name', 'symbol'] as const satisfies readonly NftCollectionField[]

export type DefaultNftCollectionField = (typeof DEFAULT_NFT_COLLECTION_FIELDS)[number]

interface NftCollectionFieldTypes {
  /** 通过 ERC165 supportsInterface 识别；都不支持时为 null */
  standard: NftStandard | null
  name: string | null
  symbol: string | null
  /** 十进制字符串；需要合约实现 totalSupply（ERC721Enumerable 等） */
  totalSupply: string | null
}

export type NftCollection<F extends NftCollectionField = DefaultNftCollectionField> = {
  address: string
  /** 请求的字段都读到时为 true */
  success: boolean
} & { [K in F]: NftCollectionFieldTypes[K] }

export interface NftCollectionsOptions<F extends NftCollectionField = DefaultNftCollectionField> extends CallOverrides {
  /** 要返回的字段，默认 ['standard', 'name', 'symbol'] */
  fields?: readonly F[]
}

function tokenIdString(tokenId: NftItem['tokenId']): string {
  return BigInt(tokenId).toString()
}

/** 把 tokenId 规范成 BigInt；非法 tokenId 返回 null（对应项失败，不影响整批） */
function parseTokenId(tokenId: NftItem['tokenId']): bigint | null {
  try {
    return BigInt(tokenId)
  } catch {
    return null
  }
}

/** ERC1155 uri 规范：{id} 替换为 64 位小写十六进制（不带 0x） */
function expandUri(uri: string, tokenId: bigint, gateway?: string): string {
  const expanded = uri.replace(/\{id\}/g, tokenId.toString(16).padStart(64, '0'))
  if (gateway && expanded.startsWith('ipfs://')) {
    return gateway + expanded.slice('ipfs://'.length).replace(/^ipfs\//, '')
  }
  return expanded
}

export async function nftOwners(provider: Provider, items: readonly NftItem[], overrides?: CallOverrides): Promise<NftOwner[]> {
  // Tron 上返回 T 开头的地址，方便与 tronWeb.defaultAddress.base58 等直接比较
  const tron = isTronChain(await provider.getChainId())
  const ids = items.map((item) => parseTokenId(item.tokenId))
  const calls = items.flatMap((item, i) => (ids[i] === null ? [] : [provider.contract(item.contract, ERC721_ABI as unknown as string[]).ownerOf(ids[i])]))
  const results = calls.length ? await provider.tryAll<string>(calls, overrides) : []
  let j = 0
  return items.map((item, i) => {
    const raw = ids[i] === null ? null : (results[j++] ?? null)
    const owner = raw !== null && tron ? toTronAddress(raw) : raw
    return { contract: item.contract, tokenId: ids[i] === null ? String(item.tokenId) : tokenIdString(item.tokenId), owner, success: owner !== null }
  })
}

export async function nftBalances(
  provider: Provider,
  owner: string,
  collections: readonly string[],
  overrides?: CallOverrides,
): Promise<NftBalance[]> {
  const calls = collections.map((contract) => provider.contract(contract, ERC721_ABI as unknown as string[]).balanceOf(owner))
  const results = calls.length ? await provider.tryAll<bigint>(calls, overrides) : []
  return collections.map((contract, i) => {
    const balance = results[i] ?? null
    return { contract, balance: balance === null ? '0' : balance.toString(), success: balance !== null }
  })
}

export async function erc1155Balances(
  provider: Provider,
  owner: string,
  items: readonly NftItem[],
  overrides?: CallOverrides,
): Promise<Erc1155Balance[]> {
  const ids = items.map((item) => parseTokenId(item.tokenId))
  const calls = items.flatMap((item, i) =>
    ids[i] === null ? [] : [provider.contract(item.contract, ERC1155_ABI as unknown as string[]).balanceOf(owner, ids[i])],
  )
  const results = calls.length ? await provider.tryAll<bigint>(calls, overrides) : []
  let j = 0
  return items.map((item, i) => {
    const balance = ids[i] === null ? null : (results[j++] ?? null)
    return {
      contract: item.contract,
      tokenId: ids[i] === null ? String(item.tokenId) : tokenIdString(item.tokenId),
      balance: balance === null ? '0' : balance.toString(),
      success: balance !== null,
    }
  })
}

export async function nftTokenUris(provider: Provider, items: readonly NftItem[], options: NftTokenUriOptions = {}): Promise<NftTokenUri[]> {
  const { ipfsGateway, ...overrides } = options
  const chainId = await provider.getChainId()
  const ids = items.map((item) => parseTokenId(item.tokenId))

  // 集合标准已知时只发对应的调用；未知时 tokenURI 和 uri 都发，并在同一批里用 ERC165 识别标准（每个集合一次）、缓存下来
  const calls: Call[] = []
  const detect = new Map<string, { erc721: number; erc1155: number }>()
  const plan = items.map((item, i) => {
    const id = ids[i]
    if (id === null || id === undefined) {
      return { tokenUri: -1, uri: -1 }
    }
    const standard = getCachedTokenMeta(chainId, item.contract).standard
    const key = item.contract.toLowerCase()
    if (standard === undefined && !detect.has(key)) {
      const nft = provider.contract(item.contract, ERC721_ABI as unknown as string[])
      detect.set(key, {
        erc721: calls.push(nft.supportsInterface(ERC721_INTERFACE_ID)) - 1,
        erc1155: calls.push(nft.supportsInterface(ERC1155_INTERFACE_ID)) - 1,
      })
    }
    const tokenUri =
      standard === 'ERC1155' ? -1 : calls.push(provider.contract(item.contract, ERC721_ABI as unknown as string[]).tokenURI(id)) - 1
    const uri = standard === 'ERC721' ? -1 : calls.push(provider.contract(item.contract, ERC1155_ABI as unknown as string[]).uri(id)) - 1
    return { tokenUri, uri }
  })
  const results = calls.length ? await provider.tryAll(calls, overrides) : []

  const detected = new Map<string, NftStandard | null>()
  for (const [key, index] of detect) {
    const is721 = (results[index.erc721] as boolean | null) ?? null
    const is1155 = (results[index.erc1155] as boolean | null) ?? null
    const standard: NftStandard | null = is721 ? 'ERC721' : is1155 ? 'ERC1155' : null
    detected.set(key, standard)
    // 两个调用都成功（返回 false）才缓存“不是 NFT”，失败可能只是暂时的
    if (standard !== null || (is721 !== null && is1155 !== null)) {
      setCachedTokenMeta(chainId, key, { standard })
    }
  }

  return items.map((item, i) => {
    const id = ids[i]
    const { tokenUri, uri } = plan[i] as { tokenUri: number; uri: number }
    const fromTokenUri = tokenUri === -1 ? null : ((results[tokenUri] as string | null) ?? null)
    const fromUri = uri === -1 ? null : ((results[uri] as string | null) ?? null)
    // 标准识别出来时以对应的方法为准；否则取成功的那个（空字符串也是有效结果，如尚未设置 baseURI）
    const standard = detected.get(item.contract.toLowerCase())
    const raw = standard === 'ERC1155' ? fromUri : standard === 'ERC721' ? fromTokenUri : (fromTokenUri ?? fromUri)
    return {
      contract: item.contract,
      tokenId: id === null || id === undefined ? String(item.tokenId) : id.toString(),
      uri: raw === null || id === null || id === undefined ? null : expandUri(raw, id, ipfsGateway),
      success: raw !== null,
    }
  })
}

export async function nftCollections<F extends NftCollectionField = DefaultNftCollectionField>(
  provider: Provider,
  collections: readonly string[],
  options: NftCollectionsOptions<F> = {},
): Promise<NftCollection<F>[]> {
  const { fields = DEFAULT_NFT_COLLECTION_FIELDS as unknown as readonly F[], ...overrides } = options
  const wanted = new Set<NftCollectionField>(fields)
  const chainId = await provider.getChainId()

  const calls: Call[] = []
  const plan = collections.map((address) => {
    const meta = getCachedTokenMeta(chainId, address)
    const nft = provider.contract(address, ERC721_ABI as unknown as string[])
    const index: Partial<Record<'erc721' | 'erc1155' | 'name' | 'symbol' | 'totalSupply', number>> = {}
    if (wanted.has('standard') && meta.standard === undefined) {
      index.erc721 = calls.push(nft.supportsInterface(ERC721_INTERFACE_ID)) - 1
      index.erc1155 = calls.push(nft.supportsInterface(ERC1155_INTERFACE_ID)) - 1
    }
    if (wanted.has('name') && meta.name === undefined) {
      index.name = calls.push(asStringOrBytes32(nft.name())) - 1
    }
    if (wanted.has('symbol') && meta.symbol === undefined) {
      index.symbol = calls.push(asStringOrBytes32(nft.symbol())) - 1
    }
    if (wanted.has('totalSupply')) {
      index.totalSupply = calls.push(nft.totalSupply()) - 1
    }
    return { address, meta, index }
  })
  const results = calls.length ? await provider.tryAll(calls, overrides) : []
  const read = <T>(i: number | undefined): T | null => (i === undefined ? null : ((results[i] as T | null) ?? null))

  return plan.map(({ address, meta, index }) => {
    let standard: NftStandard | null | undefined = meta.standard
    if (standard === undefined && index.erc721 !== undefined) {
      const is721 = read<boolean>(index.erc721)
      const is1155 = read<boolean>(index.erc1155)
      standard = is721 ? 'ERC721' : is1155 ? 'ERC1155' : null
      // 两个调用都成功（返回 false）才缓存“不是 NFT”，失败可能只是暂时的
      if (standard !== null || (is721 !== null && is1155 !== null)) {
        setCachedTokenMeta(chainId, address, { standard })
      }
    }
    const name = meta.name ?? read<string>(index.name)
    const symbol = meta.symbol ?? read<string>(index.symbol)
    const totalSupply = read<bigint>(index.totalSupply)
    setCachedTokenMeta(chainId, address, {
      ...(index.name !== undefined && name !== null ? { name } : {}),
      ...(index.symbol !== undefined && symbol !== null ? { symbol } : {}),
    })

    const values: Record<NftCollectionField, unknown> = {
      standard: standard ?? null,
      name,
      symbol,
      totalSupply: totalSupply === null ? null : totalSupply.toString(),
    }
    const out: Record<string, unknown> = { address }
    let success = true
    for (const field of fields) {
      out[field] = values[field]
      if (values[field] === null) {
        success = false
      }
    }
    out.success = success
    return out as NftCollection<F>
  })
}
