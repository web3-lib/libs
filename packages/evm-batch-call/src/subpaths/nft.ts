/**
 * NFT 查询（子路径 `@w3lib/evm-batch-call/nft`）：ERC721 / ERC1155 的集合信息、持有数量、持有人、元数据地址。
 * 不放在主入口，不用 NFT 功能时打包不会带上这部分代码。
 *
 * ```ts
 * import { Provider } from '@w3lib/evm-batch-call'
 * import { getNftOwners, nftOwners } from '@w3lib/evm-batch-call/nft'
 *
 * await getNftOwners([{ contract: BAYC, tokenId: 1 }], { chainId: 1 })   // 节点参数与 getBalances 相同
 * await nftOwners(multi, [{ contract: BAYC, tokenId: 1 }])              // 或传已创建的 Provider
 * ```
 */
import {
  erc1155Balances,
  nftBalances,
  nftCollections,
  nftOwners,
  nftTokenUris,
  type DefaultNftCollectionField,
  type Erc1155Balance,
  type NftBalance,
  type NftCollection,
  type NftCollectionField,
  type NftItem,
  type NftOwner,
  type NftTokenUri,
  type NftCollectionsOptions,
} from '../nft.js'
import { resolve, type ShortcutOptions, type ShortcutProviderOptions } from '../shortcuts.js'

export {
  DEFAULT_NFT_COLLECTION_FIELDS,
  ERC1155_ABI,
  ERC721_ABI,
  erc1155Balances,
  nftBalances,
  nftCollections,
  nftOwners,
  nftTokenUris,
  type DefaultNftCollectionField,
  type Erc1155Balance,
  type NftBalance,
  type NftCollection,
  type NftCollectionField,
  type NftCollectionsOptions,
  type NftItem,
  type NftOwner,
  type NftStandard,
  type NftTokenUri,
  type NftTokenUriOptions,
} from '../nft.js'

export interface GetNftCollectionsOptions<F extends NftCollectionField = DefaultNftCollectionField>
  extends NftCollectionsOptions<F>,
    ShortcutProviderOptions {}

/**
 * 批量查 NFT 集合信息，字段可选（默认 standard / name / symbol）。
 *
 * ```ts
 * await getNftCollections([BAYC, MAYC], { chainId: 1, fields: ['standard', 'name', 'totalSupply'] })
 * // [{ address: BAYC, standard: 'ERC721', name: 'BoredApeYachtClub', totalSupply: '10000', success: true }, ...]
 * ```
 */
export function getNftCollections<const F extends NftCollectionField = DefaultNftCollectionField>(
  collections: readonly string[],
  options: GetNftCollectionsOptions<F> = {},
): Promise<NftCollection<F>[]> {
  const { provider, overrides, own } = resolve(options, ['fields'])
  return nftCollections<F>(provider, collections, { ...overrides, fields: own.fields })
}

/** 批量查 ERC721 持有数量：`await getNftBalances(user, [BAYC, MAYC], { chainId: 1 })` */
export function getNftBalances(owner: string, collections: readonly string[], options: ShortcutOptions = {}): Promise<NftBalance[]> {
  const { provider, overrides } = resolve(options)
  return nftBalances(provider, owner, collections, overrides)
}

/** 批量查 ERC721 持有人：`await getNftOwners([{ contract: BAYC, tokenId: 1 }], { chainId: 1 })` */
export function getNftOwners(items: readonly NftItem[], options: ShortcutOptions = {}): Promise<NftOwner[]> {
  const { provider, overrides } = resolve(options)
  return nftOwners(provider, items, overrides)
}

export interface GetNftTokenUrisOptions extends ShortcutOptions {
  /** 把 ipfs://xxx 转成 `${ipfsGateway}xxx`，如 'https://ipfs.io/ipfs/' */
  ipfsGateway?: string
}

/**
 * 批量查 NFT 元数据地址（ERC721 tokenURI / ERC1155 uri 自动兼容）。
 *
 * ```ts
 * await getNftTokenUris([{ contract: BAYC, tokenId: 1 }], { chainId: 1, ipfsGateway: 'https://ipfs.io/ipfs/' })
 * // [{ contract: BAYC, tokenId: '1', uri: 'https://ipfs.io/ipfs/Qm…/1', success: true }]
 * ```
 */
export function getNftTokenUris(items: readonly NftItem[], options: GetNftTokenUrisOptions = {}): Promise<NftTokenUri[]> {
  const { provider, overrides, own } = resolve(options, ['ipfsGateway'])
  return nftTokenUris(provider, items, { ...overrides, ipfsGateway: own.ipfsGateway })
}

/** 批量查 ERC1155 余额：`await getErc1155Balances(user, [{ contract, tokenId: 1 }], { chainId: 137 })` */
export function getErc1155Balances(owner: string, items: readonly NftItem[], options: ShortcutOptions = {}): Promise<Erc1155Balance[]> {
  const { provider, overrides } = resolve(options)
  return erc1155Balances(provider, owner, items, overrides)
}
