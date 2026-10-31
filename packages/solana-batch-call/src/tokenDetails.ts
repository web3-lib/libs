// 代币详情（tokens）、NFT 元数据（nfts）、NFT 持有人（nftOwners）

import type { AccountInfo, TransferFeeInfo } from './layout.js'
import { getMetadataAddress, isAddress } from './address.js'
import type { RequestOptions, TokensOptions } from './client.js'
import { SOL_DECIMALS, TOKEN_2022_PROGRAM_ID } from './constants.js'
import { formatUnits, parseTokenAccount, parseTransferFeeConfig } from './layout.js'
import { RpcError } from './rpc.js'
import type { ReadContext } from './balances.js'
import type { QueryContext } from './accountReader.js'
import { getMeta, learnMeta, safeParseMetaplex, safeParseMint } from './tokenMeta.js'
import {
  DEFAULT_TOKEN_FIELDS,
  type FailureReason,
  type NftDetails,
  type NftOwner,
  type TokenDetails,
  type TokenField,
  type TokenStandard,
  type TransferFee,
  type TransferFeeConfig,
} from './types.js'

const TOKEN_STANDARDS: readonly TokenStandard[] = [
  'NonFungible',
  'FungibleAsset',
  'Fungible',
  'NonFungibleEdition',
  'ProgrammableNonFungible',
  'ProgrammableNonFungibleEdition',
]

export async function tokensOf<F extends TokenField>(rc: ReadContext, mints: readonly string[], options: TokensOptions<F>): Promise<TokenDetails<F>[]> {
  const fields = (options.fields ?? DEFAULT_TOKEN_FIELDS) as readonly F[]
  const wanted = new Set<TokenField>(fields)
  const scope = rc.scope
  const ctx: QueryContext = { signal: options.signal }
  const needsNames = wanted.has('name') || wanted.has('symbol') || wanted.has('uri')
  const addresses: string[] = []
  const plan = mints.map((mint) => {
    if (rc.nativeMints.has(mint) || !isAddress(mint)) {
      return { mint, mintIndex: -1, metadataIndex: -1 }
    }
    const meta = getMeta(scope, mint)
    // uri / supply / 权限 / 手续费不缓存，需要时总要读 mint；name / symbol 命中缓存时可以省掉元数据账户
    const cachedOnly =
      !wanted.has('uri') &&
      !wanted.has('supply') &&
      !wanted.has('mintAuthority') &&
      !wanted.has('freezeAuthority') &&
      !wanted.has('transferFee') &&
      (!wanted.has('decimals') || meta.decimals !== undefined) &&
      (!wanted.has('tokenProgram') || meta.tokenProgram !== undefined) &&
      (!wanted.has('name') || meta.name !== undefined) &&
      (!wanted.has('symbol') || meta.symbol !== undefined)
    if (cachedOnly) {
      return { mint, mintIndex: -1, metadataIndex: -1 }
    }
    const namesCached = (!wanted.has('name') || meta.name !== undefined) && (!wanted.has('symbol') || meta.symbol !== undefined) && !wanted.has('uri')
    return {
      mint,
      mintIndex: addresses.push(mint) - 1,
      metadataIndex: needsNames && !namesCached ? addresses.push(getMetadataAddress(mint)) - 1 : -1,
    }
  })
  const [accounts, epoch] = await Promise.all([
    addresses.length ? rc.reader.accounts(addresses, ctx) : Promise.resolve([] as (AccountInfo | null)[]),
    // 手续费按当前 epoch 选新 / 旧配置；和账户读取在同一个批量请求里
    wanted.has('transferFee') && addresses.length
      ? rc.reader.call<{ epoch: number | string }>(ctx, 'getEpochInfo', [{ commitment: rc.commitment }]).then((res) => BigInt(res.epoch))
      : Promise.resolve(null),
  ])

  return plan.map(({ mint, mintIndex, metadataIndex }) => {
    const native = rc.nativeMints.has(mint)
    const values: Record<TokenField, unknown> & { exists: boolean } = native
      ? { exists: true, name: 'Solana', symbol: 'SOL', uri: null, decimals: SOL_DECIMALS, supply: null, tokenProgram: null, mintAuthority: null, freezeAuthority: null, transferFee: null }
      : tokenValues(
          rc,
          mint,
          mintIndex === -1 ? null : (accounts[mintIndex] ?? null),
          metadataIndex === -1 ? null : (accounts[metadataIndex] ?? null),
          mintIndex !== -1,
          mintIndex !== -1 && metadataIndex !== -1,
          epoch,
        )
    const out: Record<string, unknown> = { address: mint, native }
    let missing: F | undefined
    for (const field of fields) {
      out[field] = values[field] ?? null
      // 权限为 null 表示没有权限、手续费为 null 表示没有手续费，都是有效值；主币没有 uri / supply / tokenProgram
      const nullable =
        field === 'mintAuthority' || field === 'freezeAuthority' || field === 'transferFee' || (native && (field === 'uri' || field === 'supply' || field === 'tokenProgram'))
      if (out[field] === null && !nullable) {
        missing ??= field
      }
    }
    if (wanted.has('supply')) {
      const supply = values.supply as string | null
      const decimals = values.decimals as number | null
      out.supplyFormatted = supply === null || decimals === null ? null : formatUnits(BigInt(supply), decimals)
    }
    const error: FailureReason | undefined = native
      ? undefined
      : !isAddress(mint)
        ? 'invalid-address'
        : !values.exists
          ? accounts[mintIndex]
            ? 'not-token'
            : 'not-found'
          : missing
            ? 'missing-field'
            : undefined
    out.success = error === undefined
    if (error) {
      out.error = error
      if (error === 'missing-field') {
        out.errorField = missing
      }
    }
    return out as TokenDetails<F>
  })
}

function tokenValues(
  rc: ReadContext,
  mint: string,
  mintAccount: AccountInfo | null,
  metadataAccount: AccountInfo | null,
  fetchedMint: boolean,
  lookedForNames: boolean,
  epoch: bigint | null,
): Record<TokenField, unknown> & { exists: boolean } {
  const scope = rc.scope
  const meta = learnMeta(scope, mint, mintAccount, metadataAccount, lookedForNames)
  const info = mintAccount ? safeParseMint(mintAccount) : null
  const uri = info?.metadata?.uri ?? (metadataAccount ? (safeParseMetaplex(metadataAccount)?.uri ?? null) : null)
  const feeConfig = info && mintAccount?.owner === TOKEN_2022_PROGRAM_ID ? parseTransferFeeConfig(mintAccount.data) : null
  return {
    // 读了 mint 账户就以它为准（不存在则 false）；没读说明请求的字段全部命中缓存
    exists: fetchedMint ? info !== null : true,
    name: meta.name ?? null,
    symbol: meta.symbol ?? null,
    uri,
    decimals: meta.decimals ?? null,
    supply: info ? info.supply.toString() : null,
    tokenProgram: meta.tokenProgram ?? null,
    mintAuthority: info?.mintAuthority ?? null,
    freezeAuthority: info?.freezeAuthority ?? null,
    transferFee: feeConfig ? toTransferFeeConfig(feeConfig.older, feeConfig.newer, epoch) : null,
  }
}

function toTransferFee(fee: TransferFeeInfo): TransferFee {
  return { basisPoints: fee.basisPoints, maximumFee: fee.maximumFee.toString(), epoch: fee.epoch.toString() }
}

/** 当前生效的配置：epoch >= newer.epoch 用 newer，否则 older；不知道当前 epoch 时按 newer */
function toTransferFeeConfig(older: TransferFeeInfo, newer: TransferFeeInfo, epoch: bigint | null): TransferFeeConfig {
  const current = epoch === null || epoch >= newer.epoch ? newer : older
  return { ...toTransferFee(current), older: toTransferFee(older), newer: toTransferFee(newer) }
}

/** 批量查 NFT 元数据（Metaplex；Token-2022 NFT 取 TokenMetadata 扩展），一次 getMultipleAccounts */
export async function nftsOf(rc: ReadContext, mints: readonly string[], options: RequestOptions): Promise<NftDetails[]> {
  const scope = rc.scope
  const addresses: string[] = []
  const plan = mints.map((mint) =>
    isAddress(mint) ? { mint, metadataIndex: addresses.push(getMetadataAddress(mint)) - 1, mintIndex: addresses.push(mint) - 1 } : { mint, metadataIndex: -1, mintIndex: -1 },
  )
  const accounts = addresses.length ? await rc.reader.accounts(addresses, { signal: options.signal }) : []
  return plan.map(({ mint, metadataIndex, mintIndex }): NftDetails => {
    const metadataAccount = metadataIndex === -1 ? null : (accounts[metadataIndex] ?? null)
    const mintAccount = mintIndex === -1 ? null : (accounts[mintIndex] ?? null)
    learnMeta(scope, mint, mintAccount, metadataAccount, mintIndex !== -1)
    const metaplex = metadataAccount ? safeParseMetaplex(metadataAccount) : null
    const ext = mintAccount ? (safeParseMint(mintAccount)?.metadata ?? null) : null
    if (!metaplex && !ext) {
      const error: FailureReason = mintIndex === -1 ? 'invalid-address' : !mintAccount ? 'not-found' : !safeParseMint(mintAccount) ? 'not-token' : 'no-metadata'
      return { mint, name: null, symbol: null, uri: null, collection: null, creators: [], sellerFeeBasisPoints: null, tokenStandard: null, isMutable: null, updateAuthority: null, success: false, error }
    }
    return {
      mint,
      name: ext?.name ?? metaplex?.name ?? null,
      symbol: ext?.symbol ?? metaplex?.symbol ?? null,
      uri: ext?.uri ?? metaplex?.uri ?? null,
      collection: metaplex?.collection ?? null,
      creators: metaplex?.creators ?? [],
      sellerFeeBasisPoints: metaplex?.sellerFeeBasisPoints ?? null,
      tokenStandard: metaplex?.tokenStandard == null ? null : (TOKEN_STANDARDS[metaplex.tokenStandard] ?? null),
      isMutable: metaplex?.isMutable ?? null,
      updateAuthority: metaplex?.updateAuthority ?? null,
      success: true,
    }
  })
}

/**
 * 批量查 NFT 持有人：getTokenLargestAccounts（合并成一个批量请求）+ 一次 getMultipleAccounts。
 * 节点拒绝的 mint（不存在 / 不是代币）在同一次 getMultipleAccounts 里读 mint 账户区分原因
 */
export async function nftOwnersOf(rc: ReadContext, mints: readonly string[], options: RequestOptions): Promise<NftOwner[]> {
  const ctx: QueryContext = { signal: options.signal }
  const largest = await Promise.all(
    mints.map((mint): Promise<{ tokenAccount: string | null; rejected: boolean }> =>
      isAddress(mint)
        ? rc.reader.call<{ value: Array<{ address: string; amount: string }> }>(ctx, 'getTokenLargestAccounts', [mint, { commitment: rc.commitment }])
            .then((res) => ({ tokenAccount: res.value.find((a) => a.amount !== '0')?.address ?? null, rejected: false }))
            .catch((err: unknown) => {
              // mint 不存在 / 不是代币：该项失败；节点问题照常抛出
              if (err instanceof RpcError && !err.nodeFault) return { tokenAccount: null, rejected: true }
              throw err
            })
        : Promise.resolve({ tokenAccount: null, rejected: false }),
    ),
  )
  const toRead = largest.flatMap(({ tokenAccount, rejected }, i) => (tokenAccount ? [tokenAccount] : rejected ? [mints[i] as string] : []))
  const accounts = toRead.length ? await rc.reader.accounts(toRead, ctx) : []
  const byAddress = new Map(toRead.map((a, i) => [a, accounts[i] ?? null]))
  return mints.map((mint, i): NftOwner => {
    const { tokenAccount, rejected } = largest[i] ?? { tokenAccount: null, rejected: false }
    if (!isAddress(mint)) {
      return { mint, owner: null, tokenAccount: null, success: false, error: 'invalid-address' }
    }
    if (rejected) {
      return { mint, owner: null, tokenAccount: null, success: false, error: byAddress.get(mint) ? 'not-token' : 'not-found' }
    }
    const account = tokenAccount ? byAddress.get(tokenAccount) : null
    let owner: string | null = null
    if (account) {
      try {
        owner = parseTokenAccount(account.data).owner
      } catch {
        owner = null
      }
    }
    // 没有余额大于 0 的代币账户（供应量为 0 / 已销毁），或代币账户刚被关闭
    return owner ? { mint, owner, tokenAccount, success: true } : { mint, owner: null, tokenAccount: null, success: false, error: 'no-holder' }
  })
}
