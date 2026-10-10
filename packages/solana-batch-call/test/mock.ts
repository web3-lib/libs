import { base64 } from '@scure/base'

import { GENESIS_HASHES, METADATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, decodeAddress, type RpcTransport } from '../src/index.js'

// ---- 账户数据构造 ----

class Writer {
  readonly bytes: number[] = []

  u8(v: number) {
    this.bytes.push(v & 0xff)
    return this
  }

  u16(v: number) {
    return this.u8(v).u8(v >> 8)
  }

  u32(v: number) {
    return this.u16(v & 0xffff).u16(v >>> 16)
  }

  u64(v: bigint) {
    for (let i = 0n; i < 8n; i++) this.u8(Number((v >> (8n * i)) & 0xffn))
    return this
  }

  pubkey(address: string) {
    this.bytes.push(...decodeAddress(address))
    return this
  }

  zeros(n: number) {
    for (let i = 0; i < n; i++) this.u8(0)
    return this
  }

  /** borsh string；pad 时按 Metaplex 的做法用 \0 补齐到固定长度 */
  string(value: string, pad?: number) {
    const encoded = [...new TextEncoder().encode(value)]
    while (pad !== undefined && encoded.length < pad) encoded.push(0)
    this.u32(encoded.length)
    this.bytes.push(...encoded)
    return this
  }

  done(): Uint8Array {
    return new Uint8Array(this.bytes)
  }
}

const ZERO = '11111111111111111111111111111111'

export interface MintOptions {
  decimals: number
  supply?: bigint
  mintAuthority?: string | null
  freezeAuthority?: string | null
  /** 写入 Token-2022 TokenMetadata 扩展 */
  metadata?: { name: string; symbol: string; uri: string }
  /** 写入 Token-2022 TransferFeeConfig 扩展 */
  transferFee?: { authority?: string; older: MockFee; newer: MockFee; withheld?: bigint }
}

export interface MockFee {
  epoch: bigint
  maximumFee: bigint
  basisPoints: number
}

export function mintData(options: MintOptions): Uint8Array {
  const w = new Writer()
  w.u32(options.mintAuthority ? 1 : 0).pubkey(options.mintAuthority ?? ZERO)
  w.u64(options.supply ?? 0n).u8(options.decimals).u8(1)
  w.u32(options.freezeAuthority ? 1 : 0).pubkey(options.freezeAuthority ?? ZERO)
  if (options.metadata || options.transferFee) {
    w.zeros(165 - 82).u8(1) // 补齐到 165 + 账户类型 Mint
    // 先放一个无关的扩展（MetadataPointer = 18），确认 TLV 遍历能跳过
    w.u16(18).u16(64).zeros(64)
  }
  if (options.transferFee) {
    const { authority, older, newer, withheld } = options.transferFee
    const ext = new Writer().pubkey(authority ?? ZERO).pubkey(ZERO).u64(withheld ?? 0n)
    for (const f of [older, newer]) ext.u64(f.epoch).u64(f.maximumFee).u16(f.basisPoints)
    w.u16(1).u16(ext.bytes.length)
    w.bytes.push(...ext.bytes)
  }
  if (options.metadata) {
    const ext = new Writer().pubkey(ZERO).pubkey(ZERO).string(options.metadata.name).string(options.metadata.symbol).string(options.metadata.uri).u32(0)
    w.u16(19).u16(ext.bytes.length)
    w.bytes.push(...ext.bytes)
  }
  return w.done()
}

export function tokenAccountData(mint: string, owner: string, amount: bigint): Uint8Array {
  return new Writer().pubkey(mint).pubkey(owner).u64(amount).zeros(165 - 72).done()
}

export interface MetaplexOptions {
  mint: string
  name: string
  symbol: string
  uri?: string
  updateAuthority?: string
  sellerFeeBasisPoints?: number
  creators?: Array<{ address: string; verified: boolean; share: number }>
  isMutable?: boolean
  tokenStandard?: number
  collection?: { address: string; verified: boolean }
  /** 只写到 creators，模拟老版本账户 */
  legacy?: boolean
}

export function metaplexData(o: MetaplexOptions): Uint8Array {
  const w = new Writer().u8(4).pubkey(o.updateAuthority ?? ZERO).pubkey(o.mint)
  w.string(o.name, 32).string(o.symbol, 10).string(o.uri ?? '', 200).u16(o.sellerFeeBasisPoints ?? 0)
  if (o.creators?.length) {
    w.u8(1).u32(o.creators.length)
    for (const c of o.creators) w.pubkey(c.address).u8(c.verified ? 1 : 0).u8(c.share)
  } else {
    w.u8(0)
  }
  if (o.legacy) {
    return w.done()
  }
  w.u8(0).u8(o.isMutable ? 1 : 0)
  w.u8(0) // editionNonce: None
  if (o.tokenStandard === undefined) w.u8(0)
  else w.u8(1).u8(o.tokenStandard)
  if (o.collection) w.u8(1).u8(o.collection.verified ? 1 : 0).pubkey(o.collection.address)
  else w.u8(0)
  return w.done()
}

// ---- 模拟节点 ----

export interface MockAccount {
  lamports?: bigint
  owner: string
  data?: Uint8Array
}

export interface MockNodeOptions {
  accounts?: Record<string, MockAccount>
  genesis?: string
  /** 某些方法直接报错，如模拟公共节点不支持索引方法 */
  errors?: Record<string, { code: number; message: string }>
  /** 节点当前的 slot（context.slot），默认 1；可以改 node.slot 模拟追上高度 */
  slot?: number
  /** getEpochInfo 返回的 epoch，默认 500 */
  epoch?: number
  /** 每个请求的延迟（毫秒） */
  delay?: number
}

export function createMockNode(options: MockNodeOptions = {}) {
  const accounts = options.accounts ?? {}
  const calls: Array<{ method: string; params: readonly unknown[] }> = []

  // 超过 2^53 的 lamports 按 HttpRpc 解析后的样子给字符串（真实节点返回 JSON 大数，由 HttpRpc 按原文取值）
  const lamportsOf = (value: bigint) => (value > BigInt(Number.MAX_SAFE_INTEGER) ? value.toString() : Number(value))
  /** dataSlice 与真实节点一致：只返回指定范围的账户数据 */
  const raw = (address: string, slice?: { offset: number; length: number }) => {
    const a = accounts[address]
    if (!a) return null
    const data = a.data ?? new Uint8Array()
    const sliced = slice ? data.slice(slice.offset, slice.offset + slice.length) : data
    return { lamports: lamportsOf(a.lamports ?? 0n), owner: a.owner, data: [base64.encode(sliced), 'base64'], executable: false }
  }

  const parsedTokenAccounts = (owner: string, programId: string) =>
    Object.entries(accounts)
      .filter(([, a]) => a.owner === programId && a.data && a.data.length >= 165)
      .map(([pubkey, a]) => {
        const view = new DataView(a.data!.buffer, a.data!.byteOffset)
        const mint = encode(a.data!.slice(0, 32))
        const holder = encode(a.data!.slice(32, 64))
        const mintAccount = accounts[mint]
        const decimals = mintAccount?.data?.[44] ?? 0
        return { pubkey, holder, mint, amount: view.getBigUint64(64, true), decimals }
      })
      .filter((t) => t.holder === owner)
      .map((t) => ({
        pubkey: t.pubkey,
        account: { owner: programId, data: { parsed: { info: { mint: t.mint, owner: t.holder, tokenAmount: { amount: t.amount.toString(), decimals: t.decimals } } } } },
      }))

  const node: RpcTransport & { calls: typeof calls; accounts: typeof accounts; slot: number } = {
    calls,
    accounts,
    slot: options.slot ?? 1,
    async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      calls.push({ method, params })
      if (options.delay) {
        await new Promise((r) => setTimeout(r, options.delay))
      }
      const error = options.errors?.[method]
      if (error) {
        const { RpcError } = await import('../src/rpc.js')
        throw new RpcError(error.message, error.code)
      }
      const minContextSlot = (params[params.length - 1] as { minContextSlot?: number } | undefined)?.minContextSlot
      if (minContextSlot !== undefined && minContextSlot > node.slot) {
        const { RpcError } = await import('../src/rpc.js')
        throw new RpcError('Minimum context slot has not been reached', -32016, { contextSlot: node.slot })
      }
      switch (method) {
        case 'getEpochInfo':
          return { epoch: options.epoch ?? 500, slotIndex: 0, slotsInEpoch: 432000, absoluteSlot: node.slot } as T
        case 'getGenesisHash':
          return (options.genesis ?? GENESIS_HASHES.mainnet) as T
        case 'getMultipleAccounts':
          return {
            context: { slot: node.slot },
            value: (params[0] as string[]).map((address) => raw(address, (params[1] as { dataSlice?: { offset: number; length: number } } | undefined)?.dataSlice)),
          } as T
        case 'getBalance':
          return { context: { slot: node.slot }, value: lamportsOf(accounts[params[0] as string]?.lamports ?? 0n) } as T
        case 'getTokenAccountsByOwner': {
          const filter = params[1] as { programId?: string; mint?: string }
          if (filter.mint !== undefined) {
            // 与真实节点一致：mint 不存在 / 不是代币 mint 时报参数错误
            const mintAccount = accounts[filter.mint]
            if (!mintAccount || (mintAccount.owner !== TOKEN_PROGRAM_ID && mintAccount.owner !== TOKEN_2022_PROGRAM_ID)) {
              const { RpcError } = await import('../src/rpc.js')
              throw new RpcError(mintAccount ? 'Invalid param: not a Token mint' : 'Invalid param: could not find mint', -32602)
            }
            const value = parsedTokenAccounts(params[0] as string, mintAccount.owner).filter((t) => t.account.data.parsed.info.mint === filter.mint)
            return { context: { slot: node.slot }, value } as T
          }
          return { context: { slot: node.slot }, value: parsedTokenAccounts(params[0] as string, filter.programId as string) } as T
        }
        case 'getTokenLargestAccounts': {
          const mint = params[0] as string
          const mintAccount = accounts[mint]
          if (!mintAccount || (mintAccount.owner !== TOKEN_PROGRAM_ID && mintAccount.owner !== TOKEN_2022_PROGRAM_ID)) {
            const { RpcError } = await import('../src/rpc.js')
            throw new RpcError('Invalid param: not a Token mint', -32602)
          }
          const holders = Object.entries(accounts)
            .filter(([, a]) => (a.owner === TOKEN_PROGRAM_ID || a.owner === TOKEN_2022_PROGRAM_ID) && a.data && a.data.length >= 165 && encode(a.data.slice(0, 32)) === mint)
            .map(([address, a]) => ({ address, amount: new DataView(a.data!.buffer, a.data!.byteOffset).getBigUint64(64, true).toString() }))
          return { context: { slot: node.slot }, value: holders } as T
        }
        default:
          throw new Error(`mock: unsupported method ${method}`)
      }
    },
  }
  return node
}

function encode(bytes: Uint8Array): string {
  // 避免循环 import：测试里直接用 @scure/base
  return base58encode(bytes)
}

import { base58 } from '@scure/base'
const base58encode = (bytes: Uint8Array) => base58.encode(bytes)

export { METADATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID }
