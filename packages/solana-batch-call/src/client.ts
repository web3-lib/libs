import { base64 } from '@scure/base'

import { getAssociatedTokenAddress, getMetadataAddress, isAddress } from './address.js'
import {
  NATIVE_MINT,
  SOL_DECIMALS,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  clusterOfGenesis,
  type Cluster,
} from './constants.js'
import { formatAmount, parseMetaplexMetadata, parseMint, parseTokenAccount, type AccountInfo, type MetaplexMetadata, type MintInfo } from './layout.js'
import { HttpError, RpcError, type RpcTransport } from './rpc.js'
import { NetworkMismatchError, resolveSource, type RpcSource, type SourceOptions } from './source.js'
import {
  DEFAULT_TOKEN_FIELDS,
  type Commitment,
  type DefaultTokenField,
  type NftDetails,
  type NftOwner,
  type OwnedToken,
  type SolBalance,
  type TokenBalance,
  type TokenDetails,
  type TokenField,
  type TokenStandard,
} from './types.js'

export interface ClientConfig extends SourceOptions {
  /** 网络。不传 provider 时用于选择内置节点（默认 mainnet）；传了 provider 时用于校验节点所在网络 */
  cluster?: Cluster
  /** 默认 'confirmed' */
  commitment?: Commitment
  /** 视为原生 SOL 的 mint，默认 [So111…112（Wrapped SOL）, 11111…1（System Program）] */
  nativeMints?: readonly string[]
}

export interface BalancesOptions {
  /** 同时返回 symbol（代币查一次后缓存，主币为 SOL）。默认 false */
  symbol?: boolean
  /**
   * 用 getTokenAccountsByOwner 扫描持有人的全部代币账户（含非 ATA 账户、同一代币的多个账户合计）。
   * 不传 mints 时总是扫描。注意：免费公共节点大多不支持这个方法，需要自己的节点。
   */
  scan?: boolean
}

export interface OwnerTokensOptions {
  /** 返回 name / symbol（代币查一次后缓存）。默认 true */
  metadata?: boolean
  /** 第一项返回 SOL。默认 true */
  includeNative?: boolean
  /** 包含余额为 0 的代币账户（如已清空但未关闭的 ATA）。默认 false */
  includeZero?: boolean
  /** 包含 NFT（精度 0 且数量 1）。默认 false */
  includeNfts?: boolean
}

export interface TokensOptions<F extends TokenField = DefaultTokenField> {
  /** 要返回的字段，默认 ['name', 'symbol', 'decimals'] */
  fields?: readonly F[]
}

const MAX_ACCOUNTS_PER_REQUEST = 100
/** 同时进行的 getMultipleAccounts 请求数上限 */
const MAX_PARALLEL_ACCOUNT_REQUESTS = 3
/** #fetchAccounts 里没能读到（节点问题）的账户 */
const FAILED = Symbol('failed')

/** 可以降级处理的错误：网络 / HTTP 错误、节点限制（限频、需要 Key 等）、节点不在期望的网络上；其他（参数错误、程序 bug）照常抛出 */
function isRecoverable(err: unknown): boolean {
  return err instanceof HttpError || (err instanceof RpcError && err.nodeFault) || err instanceof NetworkMismatchError
}

/** 按 mint 汇总后精度 0、数量 1 的持仓视为 NFT（ownerTokens 与 ownerNfts 共用） */
function isNftHolding(holding: Holding): boolean {
  return holding.decimals === 0 && holding.amount === 1n
}

const TOKEN_STANDARDS: readonly TokenStandard[] = [
  'NonFungible',
  'FungibleAsset',
  'Fungible',
  'NonFungibleEdition',
  'ProgrammableNonFungible',
  'ProgrammableNonFungibleEdition',
]

interface TokenMeta {
  decimals?: number
  tokenProgram?: string
  /** null：确认没有元数据 */
  name?: string | null
  symbol?: string | null
}

interface CachedMeta extends TokenMeta {
  /** name / symbol 的写入时间 */
  namesAt?: number
}

// 代币信息缓存（按 网络 + mint）：decimals / 所属程序不会变，永久缓存；
// name / symbol 来自可修改的元数据，缓存 1 小时。条目数有上限，超出时淘汰最早写入的
const NAME_TTL = 60 * 60 * 1000
const MAX_CACHED_TOKENS = 50_000
const tokenMetaCache = new Map<string, CachedMeta>()

let clientIds = 0

/** 测试用：清空代币信息缓存 */
export function resetTokenMetaCache(): void {
  tokenMetaCache.clear()
}

interface Holding {
  amount: bigint
  decimals: number
  program: string
  /** 代币账户数量 */
  accounts: number
}

interface ParsedTokenAccount {
  pubkey: string
  account: { owner: string; data: { parsed?: { info?: { mint?: string; owner?: string; tokenAmount?: { amount?: string; decimals?: number } } } } }
}

/**
 * Solana 批量读取客户端。
 *
 * ```ts
 * const sol = new SolanaClient()                                  // 内置公共节点（mainnet）
 * const sol = new SolanaClient('https://my-rpc.example')          // 自己的节点
 * const sol = new SolanaClient([connection, 'https://backup…'])   // web3.js Connection + 备用节点
 *
 * await sol.balances(owner, [NATIVE_MINT, USDC])
 * await sol.tokens([USDC, PYUSD], { fields: ['name', 'symbol', 'decimals', 'supply'] })
 * ```
 *
 * 同一 tick 内发起的 RPC 调用会合并成一个 JSON-RPC 批量请求；账户读取按 100 个一组用 getMultipleAccounts。
 */
export class SolanaClient {
  readonly transport: RpcTransport
  readonly #genesis: () => Promise<string>
  readonly #cluster: Cluster | undefined
  readonly #commitment: Commitment
  readonly #nativeMints: Set<string>
  readonly #scopeId: string

  constructor(provider?: RpcSource | readonly RpcSource[], config: ClientConfig = {}) {
    const resolved = resolveSource(provider, config.cluster ?? (provider === undefined ? 'mainnet' : undefined), config)
    this.transport = resolved.transport
    this.#genesis = resolved.genesis
    this.#cluster = config.cluster ?? (provider === undefined ? 'mainnet' : undefined)
    this.#commitment = config.commitment ?? 'confirmed'
    this.#nativeMints = new Set(config.nativeMints ?? [NATIVE_MINT, SYSTEM_PROGRAM_ID])
    // 网络已知时按网络共享缓存；未知（自定义节点且没指定 cluster）时缓存只在本客户端内使用，避免不同网络串数据
    this.#scopeId = this.#cluster ?? `client-${++clientIds}`
  }

  /** 节点所在网络（按创世区块哈希识别）；不是 mainnet / devnet / testnet 时为 null */
  async getCluster(): Promise<Cluster | null> {
    return this.#cluster ?? clusterOfGenesis(await this.#genesis())
  }

  /** 直接发 JSON-RPC 调用（同样参与自动合并与故障切换） */
  request<T = unknown>(method: string, params?: readonly unknown[]): Promise<T> {
    return this.transport.request<T>(method, params)
  }

  /**
   * 批量读取账户（getMultipleAccounts，按 100 个一组，去重），结果与 addresses 一一对应。
   * 账户不存在或地址非法时为 null。
   */
  async accounts(addresses: readonly string[]): Promise<(AccountInfo | null)[]> {
    const fetched = await this.#fetchAccounts(addresses, false)
    return addresses.map((address) => (fetched.get(address) as AccountInfo | null | undefined) ?? null)
  }

  /**
   * getMultipleAccounts：去重、按 100 个一组，最多同时 3 组（避免大批量时触发节点限频）。
   * tolerant 为 true 时，某组因节点问题（网络、限频等）失败不抛错：该组标记为 FAILED，并且不再发后面的组（节点已经在限频了）。
   */
  async #fetchAccounts(addresses: readonly string[], tolerant: boolean): Promise<Map<string, AccountInfo | null | typeof FAILED>> {
    const unique = [...new Set(addresses.filter((a) => isAddress(a)))]
    const chunks: string[][] = []
    for (let i = 0; i < unique.length; i += MAX_ACCOUNTS_PER_REQUEST) {
      chunks.push(unique.slice(i, i + MAX_ACCOUNTS_PER_REQUEST))
    }
    const result = new Map<string, AccountInfo | null | typeof FAILED>()
    let aborted = false
    for (let i = 0; i < chunks.length; i += MAX_PARALLEL_ACCOUNT_REQUESTS) {
      const wave = chunks.slice(i, i + MAX_PARALLEL_ACCOUNT_REQUESTS)
      if (aborted) {
        wave.flat().forEach((address) => result.set(address, FAILED))
        continue
      }
      await Promise.all(
        wave.map(async (chunk) => {
          try {
            const res = await this.transport.request<{ value: Array<RawAccount | null> }>('getMultipleAccounts', [
              chunk,
              { encoding: 'base64', commitment: this.#commitment },
            ])
            chunk.forEach((address, j) => result.set(address, toAccountInfo(address, res?.value?.[j] ?? null)))
          } catch (err) {
            if (!tolerant || !isRecoverable(err)) {
              throw err
            }
            aborted = true
            chunk.forEach((address) => result.set(address, FAILED))
          }
        }),
      )
    }
    return result
  }

  /** 批量查多个地址的 SOL 余额（一次 getMultipleAccounts；账户不存在视为 0） */
  async solBalances(addresses: readonly string[]): Promise<SolBalance[]> {
    const accounts = await this.accounts(addresses)
    return addresses.map((address, i) => {
      if (!isAddress(address)) {
        return { address, balance: '0', formatted: '0', success: false }
      }
      const lamports = accounts[i]?.lamports ?? 0n
      return { address, balance: lamports.toString(), formatted: formatAmount(lamports, SOL_DECIMALS), success: true }
    })
  }

  /**
   * 批量查余额（主币 SOL + SPL Token + Token-2022），返回原始余额、decimals 和换算后的数值。
   *
   * - 传 mints：本地推导 ATA，与主币账户、mint 账户一起用 getMultipleAccounts 一次读完，免费节点也能用
   * - 不传 mints（或 scan: true）：用 getTokenAccountsByOwner 扫描全部代币账户，返回所有余额大于 0 的代币
   */
  async balances(owner: string, mints?: readonly string[], options: BalancesOptions = {}): Promise<TokenBalance[]> {
    if (!isAddress(owner)) {
      throw new Error(`Invalid owner address: ${owner}`)
    }
    if (mints === undefined || options.scan) {
      return this.#scanBalances(owner, mints, options.symbol ?? false)
    }
    return this.#ataBalances(owner, mints, options.symbol ?? false)
  }

  async #ataBalances(owner: string, mints: readonly string[], withSymbol: boolean): Promise<TokenBalance[]> {
    const scope = this.#scope()
    const addresses: string[] = []
    const plan = mints.map((mint) => {
      if (this.#nativeMints.has(mint)) {
        return { mint, native: true as const, owner: addresses.push(owner) - 1 }
      }
      if (!isAddress(mint)) {
        return { mint, native: false as const, invalid: true as const }
      }
      const meta = getMeta(scope, mint)
      const needMint = meta.decimals === undefined || meta.tokenProgram === undefined || (withSymbol && meta.symbol === undefined)
      const programs = meta.tokenProgram ? [meta.tokenProgram] : [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]
      return {
        mint,
        native: false as const,
        meta,
        mintIndex: needMint ? addresses.push(mint) - 1 : -1,
        metadataIndex: withSymbol && meta.symbol === undefined ? addresses.push(getMetadataAddress(mint)) - 1 : -1,
        atas: programs.map((program) => ({ program, index: addresses.push(getAssociatedTokenAddress(owner, mint, program)) - 1 })),
      }
    })
    const accounts = await this.accounts(addresses)

    return plan.map((item): TokenBalance => {
      if (item.native) {
        const lamports = accounts[item.owner]?.lamports ?? 0n
        return withSymbolField(
          { token: item.mint, native: true, balance: lamports.toString(), decimals: SOL_DECIMALS, formatted: formatAmount(lamports, SOL_DECIMALS), tokenProgram: null, success: true },
          withSymbol,
          'SOL',
        )
      }
      if ('invalid' in item) {
        return withSymbolField({ token: item.mint, native: false, balance: '0', decimals: 0, formatted: '0', tokenProgram: null, success: false }, withSymbol, null)
      }
      const mintAccount = item.mintIndex === -1 ? null : (accounts[item.mintIndex] ?? null)
      const meta = this.#learn(
        scope,
        item.mint,
        mintAccount,
        item.metadataIndex === -1 ? null : (accounts[item.metadataIndex] ?? null),
        item.metadataIndex !== -1 && item.mintIndex !== -1,
      )
      // 代币账户由哪个程序持有就是哪个；mint 账户的 owner 也能确定程序
      let amount = 0n
      for (const ata of item.atas) {
        const account = accounts[ata.index]
        if (account && account.owner === ata.program) {
          try {
            amount = parseTokenAccount(account.data).amount
            if (meta.tokenProgram === undefined) {
              setMeta(scope, item.mint, { tokenProgram: ata.program })
              meta.tokenProgram = ata.program
            }
          } catch {
            // 不是代币账户
          }
        }
      }
      if (meta.decimals === undefined) {
        return withSymbolField({ token: item.mint, native: false, balance: '0', decimals: 0, formatted: '0', tokenProgram: meta.tokenProgram ?? null, success: false }, withSymbol, meta.symbol ?? null)
      }
      return withSymbolField(
        {
          token: item.mint,
          native: false,
          balance: amount.toString(),
          decimals: meta.decimals,
          formatted: formatAmount(amount, meta.decimals),
          tokenProgram: meta.tokenProgram ?? null,
          success: true,
        },
        withSymbol,
        meta.symbol ?? null,
      )
    })
  }

  /** 扫描持有人的 SOL 余额和全部代币账户（Token + Token-2022），同一代币的多个账户合计 */
  async #scanHoldings(owner: string): Promise<{ sol: bigint; held: Map<string, Holding> }> {
    const scope = this.#scope()
    const [lamports, ...programs] = await Promise.all([
      this.transport.request<{ value: number | string }>('getBalance', [owner, { commitment: this.#commitment }]),
      ...[TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
        this.transport.request<{ value: ParsedTokenAccount[] }>('getTokenAccountsByOwner', [
          owner,
          { programId },
          { encoding: 'jsonParsed', commitment: this.#commitment },
        ]),
      ),
    ])
    const held = new Map<string, Holding>()
    ;[TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].forEach((program, i) => {
      for (const entry of programs[i]?.value ?? []) {
        const info = entry.account?.data?.parsed?.info
        const mint = info?.mint
        const decimals = info?.tokenAmount?.decimals
        if (!mint || decimals === undefined) {
          continue
        }
        const prev = held.get(mint)
        const amount = BigInt(info?.tokenAmount?.amount ?? '0')
        held.set(mint, { amount: (prev?.amount ?? 0n) + amount, decimals, program, accounts: (prev?.accounts ?? 0) + 1 })
        setMeta(scope, mint, { decimals, tokenProgram: program })
      }
    })
    return { sol: BigInt(lamports.value), held }
  }

  /**
   * 列出持有人拥有的全部代币（SOL 在第一位），带 name / symbol，适合做资产列表。
   * 需要支持 getTokenAccountsByOwner 的节点（免费公共节点大多不支持）。
   *
   * - 默认不含 NFT（精度 0 且数量 1）和余额为 0 的代币账户（如已清空的 ATA），可用 includeNfts / includeZero 打开
   * - accounts 是该代币的代币账户数量；大于 1 时余额为所有账户的合计
   * - 顺序：SOL，然后 SPL Token 的代币，再然后 Token-2022 的代币（各自按节点返回的顺序；没有价格信息，不按价值排序）
   */
  async ownerTokens(owner: string, options: OwnerTokensOptions = {}): Promise<OwnedToken[]> {
    if (!isAddress(owner)) {
      throw new Error(`Invalid owner address: ${owner}`)
    }
    const { metadata = true, includeNative = true, includeZero = false, includeNfts = false } = options
    const scope = this.#scope()
    const { sol, held } = await this.#scanHoldings(owner)
    // Wrapped SOL 是独立的代币账户（需要 unwrap 才是 SOL），资产列表里单独列出（native: false）
    const tokens = [...held].filter(([, h]) => (includeZero || h.amount > 0n) && (includeNfts || !isNftHolding(h)))
    const failed = metadata ? await this.#loadMeta(scope, tokens.map(([mint]) => mint), true, true) : new Set<string>()

    const list: OwnedToken[] = tokens.map(([mint, h]) => {
      const item: OwnedToken = {
        token: mint,
        native: false,
        balance: h.amount.toString(),
        decimals: h.decimals,
        formatted: formatAmount(h.amount, h.decimals),
        tokenProgram: h.program,
        accounts: h.accounts,
        success: true,
      }
      if (!metadata) {
        return item
      }
      const meta = getMeta(scope, mint)
      const status = failed.has(mint) ? 'failed' : meta.name == null && meta.symbol == null ? 'missing' : 'ok'
      return { ...item, name: meta.name ?? null, symbol: meta.symbol ?? null, metadataStatus: status }
    })
    if (includeNative) {
      const sol_: OwnedToken = { token: NATIVE_MINT, native: true, balance: sol.toString(), decimals: SOL_DECIMALS, formatted: formatAmount(sol, SOL_DECIMALS), tokenProgram: null, accounts: 1, success: true }
      list.unshift(metadata ? { ...sol_, name: 'Solana', symbol: 'SOL', metadataStatus: 'ok' } : sol_)
    }
    return list
  }

  async #scanBalances(owner: string, mints: readonly string[] | undefined, withSymbol: boolean): Promise<TokenBalance[]> {
    const scope = this.#scope()
    const { sol, held } = await this.#scanHoldings(owner)

    // Wrapped SOL（So111…112）默认按原生 SOL 处理：余额列表里只有一项 SOL，不再列出 wSOL 代币账户
    const targets = mints ?? [NATIVE_MINT, ...[...held].filter(([mint, h]) => h.amount > 0n && !this.#nativeMints.has(mint)).map(([mint]) => mint)]
    // 没持有的代币（拿不到 decimals）和缺 symbol 的代币：只读 mint / 元数据账户补上，不需要 ATA
    await this.#loadMeta(
      scope,
      targets.filter((mint) => !this.#nativeMints.has(mint) && isAddress(mint)),
      withSymbol,
    )

    return targets.map((mint): TokenBalance => {
      if (this.#nativeMints.has(mint)) {
        return withSymbolField(
          { token: mint, native: true, balance: sol.toString(), decimals: SOL_DECIMALS, formatted: formatAmount(sol, SOL_DECIMALS), tokenProgram: null, success: true },
          withSymbol,
          'SOL',
        )
      }
      const h = held.get(mint)
      if (!h) {
        // 没持有：余额为 0；decimals 来自 mint 账户（mint 不存在时 success 为 false）
        const meta = getMeta(scope, mint)
        return withSymbolField(
          { token: mint, native: false, balance: '0', decimals: meta.decimals ?? 0, formatted: '0', tokenProgram: meta.tokenProgram ?? null, success: meta.decimals !== undefined },
          withSymbol,
          meta.symbol ?? null,
        )
      }
      return withSymbolField(
        { token: mint, native: false, balance: h.amount.toString(), decimals: h.decimals, formatted: formatAmount(h.amount, h.decimals), tokenProgram: h.program, success: true },
        withSymbol,
        getMeta(scope, mint).symbol ?? null,
      )
    })
  }

  /**
   * 补齐 decimals / 所属程序（以及需要时的 symbol / name）：只读缺的 mint 账户和元数据账户。
   * tolerant 为 true 时节点问题不抛错，返回没能读到的 mint（这些代币的信息保持未知，不写缓存）。
   */
  async #loadMeta(scope: string, mints: readonly string[], withSymbol: boolean, tolerant = false): Promise<Set<string>> {
    const plan = [...new Set(mints)].flatMap((mint) => {
      const meta = getMeta(scope, mint)
      const needSymbol = withSymbol && meta.symbol === undefined
      if (meta.decimals !== undefined && meta.tokenProgram !== undefined && !needSymbol) {
        return []
      }
      return [{ mint, metadata: needSymbol ? getMetadataAddress(mint) : null }]
    })
    const failed = new Set<string>()
    if (!plan.length) {
      return failed
    }
    const fetched = await this.#fetchAccounts(
      plan.flatMap(({ mint, metadata }) => (metadata ? [mint, metadata] : [mint])),
      tolerant,
    )
    for (const { mint, metadata } of plan) {
      const mintAccount = fetched.get(mint)
      const metadataAccount = metadata ? fetched.get(metadata) : null
      // mint 和元数据账户可能落在不同的请求里：任一个没读到都算失败，不能当成“没有元数据”缓存
      if (mintAccount === FAILED || metadataAccount === FAILED) {
        failed.add(mint)
        continue
      }
      this.#learn(scope, mint, mintAccount ?? null, metadataAccount ?? null, metadata !== null)
    }
    return failed
  }

  /**
   * 批量查代币详情（一次 getMultipleAccounts），可以选择返回哪些字段。
   * name / symbol / uri 优先取 Token-2022 TokenMetadata 扩展，其次 Metaplex 元数据。
   */
  async tokens<const F extends TokenField = DefaultTokenField>(mints: readonly string[], options: TokensOptions<F> = {}): Promise<TokenDetails<F>[]> {
    const fields = (options.fields ?? DEFAULT_TOKEN_FIELDS) as readonly F[]
    const wanted = new Set<TokenField>(fields)
    const scope = this.#scope()
    const needsNames = wanted.has('name') || wanted.has('symbol') || wanted.has('uri')
    const addresses: string[] = []
    const plan = mints.map((mint) => {
      if (this.#nativeMints.has(mint) || !isAddress(mint)) {
        return { mint, mintIndex: -1, metadataIndex: -1 }
      }
      const meta = getMeta(scope, mint)
      // uri / supply / 权限不缓存，需要时总要读 mint；name / symbol 命中缓存时可以省掉元数据账户
      const cachedOnly =
        !wanted.has('uri') &&
        !wanted.has('supply') &&
        !wanted.has('mintAuthority') &&
        !wanted.has('freezeAuthority') &&
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
    const accounts = addresses.length ? await this.accounts(addresses) : []

    return plan.map(({ mint, mintIndex, metadataIndex }) => {
      const native = this.#nativeMints.has(mint)
      const values: Record<TokenField, unknown> & { exists: boolean } = native
        ? { exists: true, name: 'Solana', symbol: 'SOL', uri: null, decimals: SOL_DECIMALS, supply: null, tokenProgram: null, mintAuthority: null, freezeAuthority: null }
        : this.#tokenValues(
            scope,
            mint,
            mintIndex === -1 ? null : (accounts[mintIndex] ?? null),
            metadataIndex === -1 ? null : (accounts[metadataIndex] ?? null),
            mintIndex !== -1,
            mintIndex !== -1 && metadataIndex !== -1,
          )
      const out: Record<string, unknown> = { address: mint, native }
      let success = values.exists
      for (const field of fields) {
        out[field] = values[field] ?? null
        // 权限为 null 表示没有权限，是有效值；主币没有 uri / supply / tokenProgram
        const nullable = field === 'mintAuthority' || field === 'freezeAuthority' || (native && (field === 'uri' || field === 'supply' || field === 'tokenProgram'))
        if (out[field] === null && !nullable) {
          success = false
        }
      }
      if (wanted.has('supply')) {
        const supply = values.supply as string | null
        const decimals = values.decimals as number | null
        out.supplyFormatted = supply === null || decimals === null ? null : formatAmount(BigInt(supply), decimals)
      }
      out.success = success
      return out as TokenDetails<F>
    })
  }

  #tokenValues(
    scope: string,
    mint: string,
    mintAccount: AccountInfo | null,
    metadataAccount: AccountInfo | null,
    fetchedMint: boolean,
    lookedForNames = false,
  ): Record<TokenField, unknown> & { exists: boolean } {
    const meta = this.#learn(scope, mint, mintAccount, metadataAccount, lookedForNames)
    const info = mintAccount ? safeParseMint(mintAccount) : null
    const uri = info?.metadata?.uri ?? (metadataAccount ? (safeParseMetaplex(metadataAccount)?.uri ?? null) : null)
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
    }
  }

  /** 批量查 NFT 元数据（Metaplex；Token-2022 NFT 取 TokenMetadata 扩展），一次 getMultipleAccounts */
  async nfts(mints: readonly string[]): Promise<NftDetails[]> {
    const scope = this.#scope()
    const addresses: string[] = []
    const plan = mints.map((mint) =>
      isAddress(mint) ? { mint, metadataIndex: addresses.push(getMetadataAddress(mint)) - 1, mintIndex: addresses.push(mint) - 1 } : { mint, metadataIndex: -1, mintIndex: -1 },
    )
    const accounts = addresses.length ? await this.accounts(addresses) : []
    return plan.map(({ mint, metadataIndex, mintIndex }): NftDetails => {
      const metadataAccount = metadataIndex === -1 ? null : (accounts[metadataIndex] ?? null)
      const mintAccount = mintIndex === -1 ? null : (accounts[mintIndex] ?? null)
      this.#learn(scope, mint, mintAccount, metadataAccount, mintIndex !== -1)
      const metaplex = metadataAccount ? safeParseMetaplex(metadataAccount) : null
      const ext = mintAccount ? (safeParseMint(mintAccount)?.metadata ?? null) : null
      if (!metaplex && !ext) {
        return { mint, name: null, symbol: null, uri: null, collection: null, creators: [], sellerFeeBasisPoints: null, tokenStandard: null, isMutable: null, updateAuthority: null, success: false }
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

  /** 批量查 NFT 持有人：getTokenLargestAccounts（合并成一个批量请求）+ 一次 getMultipleAccounts */
  async nftOwners(mints: readonly string[]): Promise<NftOwner[]> {
    const largest = await Promise.all(
      mints.map((mint) =>
        isAddress(mint)
          ? this.transport
              .request<{ value: Array<{ address: string; amount: string }> }>('getTokenLargestAccounts', [mint, { commitment: this.#commitment }])
              .then((res) => res.value.find((a) => a.amount !== '0')?.address ?? null)
              .catch((err: unknown) => {
                // mint 不存在 / 不是代币：该项失败；节点问题照常抛出
                if (err instanceof RpcError && !err.nodeFault) return null
                throw err
              })
          : Promise.resolve(null),
      ),
    )
    const tokenAccounts = largest.filter((a): a is string => a !== null)
    const accounts = tokenAccounts.length ? await this.accounts(tokenAccounts) : []
    const byAddress = new Map(tokenAccounts.map((a, i) => [a, accounts[i] ?? null]))
    return mints.map((mint, i) => {
      const tokenAccount = largest[i] ?? null
      const account = tokenAccount ? byAddress.get(tokenAccount) : null
      let owner: string | null = null
      if (account) {
        try {
          owner = parseTokenAccount(account.data).owner
        } catch {
          owner = null
        }
      }
      return { mint, owner, tokenAccount: owner ? tokenAccount : null, success: owner !== null }
    })
  }

  /** 查某地址持有的全部 NFT（扫描代币账户：数量 1、精度 0），再批量读元数据。需要支持 getTokenAccountsByOwner 的节点 */
  async ownerNfts(owner: string): Promise<NftDetails[]> {
    if (!isAddress(owner)) {
      throw new Error(`Invalid owner address: ${owner}`)
    }
    const { held } = await this.#scanHoldings(owner)
    const mints = [...held].filter(([, h]) => isNftHolding(h)).map(([mint]) => mint)
    return mints.length ? (await this.nfts(mints)).filter((nft) => nft.success) : []
  }

  #scope(): string {
    return this.#scopeId
  }

  /**
   * 从 mint 账户 / 元数据账户里学到的信息写入缓存，返回合并后的结果。
   * lookedForNames：本次同时读了 mint 和元数据账户，都没有 name / symbol 时记为“确认没有”（null），之后不再重查
   */
  #learn(scope: string, mint: string, mintAccount: AccountInfo | null, metadataAccount: AccountInfo | null, lookedForNames = false): TokenMeta {
    const update: TokenMeta = {}
    const info = mintAccount ? safeParseMint(mintAccount) : null
    if (info && mintAccount) {
      update.decimals = info.decimals
      update.tokenProgram = mintAccount.owner
      if (info.metadata) {
        update.name = info.metadata.name
        update.symbol = info.metadata.symbol
      }
    }
    if (metadataAccount && update.name === undefined) {
      const metaplex = safeParseMetaplex(metadataAccount)
      if (metaplex) {
        update.name = metaplex.name
        update.symbol = metaplex.symbol
      }
    }
    if (lookedForNames && info && update.name === undefined) {
      update.name = null
      update.symbol = null
    }
    setMeta(scope, mint, update)
    return getMeta(scope, mint)
  }
}

interface RawAccount {
  lamports: number | string
  owner: string
  data: [string, string] | string
  executable: boolean
}

function toAccountInfo(address: string, raw: RawAccount | null): AccountInfo | null {
  if (!raw) {
    return null
  }
  const encoded = Array.isArray(raw.data) ? raw.data[0] : raw.data
  return {
    address,
    lamports: BigInt(raw.lamports),
    owner: raw.owner,
    data: base64.decode(encoded),
    executable: raw.executable,
  }
}

function safeParseMint(account: AccountInfo): MintInfo | null {
  if (account.owner !== TOKEN_PROGRAM_ID && account.owner !== TOKEN_2022_PROGRAM_ID) {
    return null
  }
  try {
    return parseMint(account.data)
  } catch {
    return null
  }
}

function safeParseMetaplex(account: AccountInfo): MetaplexMetadata | null {
  try {
    return parseMetaplexMetadata(account.data)
  } catch {
    return null
  }
}

function getMeta(scope: string, mint: string): TokenMeta {
  const cached = tokenMetaCache.get(`${scope}:${mint}`)
  if (!cached) {
    return {}
  }
  const { namesAt, ...meta } = cached
  if (namesAt === undefined || Date.now() - namesAt > NAME_TTL) {
    delete meta.name
    delete meta.symbol
  }
  return meta
}

function setMeta(scope: string, mint: string, meta: TokenMeta): void {
  const defined: CachedMeta = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined))
  if (Object.keys(defined).length === 0) {
    return
  }
  if ('name' in defined || 'symbol' in defined) {
    defined.namesAt = Date.now()
  }
  const key = `${scope}:${mint}`
  const merged = { ...tokenMetaCache.get(key), ...defined }
  tokenMetaCache.delete(key) // 重新插入，保持“最近写入在后”的顺序
  tokenMetaCache.set(key, merged)
  if (tokenMetaCache.size > MAX_CACHED_TOKENS) {
    tokenMetaCache.delete(tokenMetaCache.keys().next().value as string)
  }
}

function withSymbolField(balance: TokenBalance, withSymbol: boolean, symbol: string | null): TokenBalance {
  return withSymbol ? { ...balance, symbol } : balance
}
